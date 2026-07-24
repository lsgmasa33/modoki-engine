/** Texture conversion service (runs in Node — dev server + build).
 *
 *  Pipeline: sharp downscales the source to the max-size cap with a Lanczos3
 *  filter, then each derived variant is encoded — KTX2 (UASTC/ETC1S/native-ASTC,
 *  with baked mipmaps) via the KTX-Software `toktx` CLI, and WebP/PNG via sharp.
 *  Outputs land in the content cache (see texture-cache.ts). Cache hits skip all
 *  work. KTX-Software is an external prerequisite — {@link ensureKtxCli} surfaces
 *  a clear install hint when it's missing.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  variantsToEmit, resolveTextureType, resolveWebpQuality, resolveUastcLevel, resolveUastcRdoLambda,
  type TextureImportSettings, type TextureType, type TextureVariant,
} from '../packages/modoki/src/runtime/loaders/textureSettings';
import { getCacheDir, hashKey, cachePathFor, cacheHit } from './texture-cache';
import { nativeDynamicImport } from './native-dynamic-import';

const KTX_MISSING_MSG =
  'KTX-Software CLI (toktx) not found. Set MODOKI_TOKTX to the binary path, or install toktx — ' +
  (process.platform === 'win32'
    ? 'download the Windows release from https://github.com/KhronosGroup/KTX-Software/releases and put toktx.exe (with ktx.dll) on PATH.'
    : process.platform === 'darwin'
      ? 'install the macOS package from https://github.com/KhronosGroup/KTX-Software/releases (toktx + ktx land in /usr/local/bin).'
      : 'install the Linux package from https://github.com/KhronosGroup/KTX-Software/releases (or your distro package).');

let ktxCheck: { ok: boolean; cli: string } | null = null;

/** Resolve the toktx binary: an explicit MODOKI_TOKTX path (the packaged Electron
 *  editor points this at the bundled binary — ELECTRON_PLAN Phase 3) wins, else
 *  the bare `toktx` name resolved via PATH (dev). */
function toktxBinary(): string {
  return process.env.MODOKI_TOKTX || 'toktx';
}

/** For tests — forget the cached CLI-availability probe. */
export function __resetKtxCheck(): void { ktxCheck = null; }

/** Ensure `toktx` is callable; returns the CLI path/name or throws with an install hint. */
export function ensureKtxCli(): string {
  const cli = toktxBinary();
  // The cache keys on availability, not the resolved name; a changed MODOKI_TOKTX
  // across calls in one process is not expected. Re-probe if the name changed.
  if (ktxCheck && ktxCheck.cli === cli) {
    if (!ktxCheck.ok) throw new Error(KTX_MISSING_MSG);
    return ktxCheck.cli;
  }
  try {
    execFileSync(cli, ['--version'], { stdio: 'pipe' });
    ktxCheck = { ok: true, cli };
    return cli;
  } catch {
    ktxCheck = { ok: false, cli };
    throw new Error(KTX_MISSING_MSG);
  }
}

type KtxVariant = Extract<TextureVariant, 'uastc' | 'etc1s' | 'astc'>;

/** Build the `toktx` argument vector for a KTX2 variant. Pure — unit tested.
 *  Note toktx arg order is `[options] <outfile> <infile>`. */
export function buildToktxArgs(
  variant: KtxVariant,
  settings: TextureImportSettings,
  inPath: string,
  outPath: string,
): string[] {
  const args = ['--t2'];
  if (settings.mipmaps) args.push('--genmipmap', '--filter', 'lanczos4');
  args.push('--assign_oetf', settings.colorspace === 'linear' ? 'linear' : 'srgb');
  if (variant === 'uastc') {
    args.push('--uastc', String(resolveUastcLevel(settings.uastcLevel)));
    const rdo = resolveUastcRdoLambda(settings.uastcRdoLambda);
    if (rdo > 0) args.push('--uastc_rdo_l', String(rdo)); // 0 ⇒ RDO off (omit the flag)
    args.push('--zcmp', '18');
  } else if (variant === 'etc1s') {
    args.push('--bcmp', '--clevel', '4', '--qlevel', '128');
  } else {
    args.push('--encode', 'astc', '--astc_blk_d', '4x4', '--astc_quality', 'thorough');
  }
  args.push(outPath, inPath);
  return args;
}

export interface ConvertOptions {
  projectRoot: string;
  /** Source URL path, e.g. /games/3d-test/assets/textures/rock.png */
  sourceUrlPath: string;
  /** Absolute filesystem path to the source image. */
  absSource: string;
  settings: TextureImportSettings;
  /** The texture's authored type — decides whether a WebP browser sibling is emitted
   *  (2d/ui) alongside the GPU variant. Inferred from the format when omitted (legacy
   *  textures: `ktx2-*` ⇒ 3d ⇒ no sibling). */
  textureType?: TextureType;
}

export interface ConvertResult {
  hash: string;
  variants: TextureVariant[];
  cached: boolean;
  /** Post-conversion stats (persisted to meta, shown in the Texture Inspector). */
  width: number;
  height: number;
  /** ORIGINAL source pixel dims (pre-resize/mult-4-snap). A 2D texture's auto
   *  whole-image sprite carves from the SOURCE file, so its rect must be these —
   *  the converted `width`/`height` can round UP past the source and overflow a
   *  `sharp.extract`. */
  srcWidth: number;
  srcHeight: number;
  mipLevels: number;
  variantBytes: Partial<Record<TextureVariant, number>>;
}

const KTX2_VARIANTS: readonly TextureVariant[] = ['uastc', 'etc1s', 'astc'];

/** Read pixelWidth / pixelHeight / levelCount from a KTX2 file header (all
 *  little-endian). The 12-byte identifier is followed by the header; pixelWidth
 *  sits at byte 20, pixelHeight at 24, levelCount at 40. Returns null if the file
 *  is missing or not a valid KTX2. */
function readKtx2Dims(file: string): { width: number; height: number; levels: number } | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(44);
    if (fs.readSync(fd, buf, 0, 44, 0) < 44) return null;
    // KTX2 identifier begins 0xAB 'K' 'T' 'X'.
    if (buf[0] !== 0xab || buf[1] !== 0x4b || buf[2] !== 0x54 || buf[3] !== 0x58) return null;
    return { width: buf.readUInt32LE(20), height: buf.readUInt32LE(24), levels: buf.readUInt32LE(40) || 1 };
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** Collect on-disk sizes + authoritative dimensions for the produced variants.
 *  Works for both fresh and cached conversions since it only reads the files. */
function gatherStats(
  cacheDir: string, sourceUrlPath: string, hash: string, variants: TextureVariant[],
  fallbackW: number, fallbackH: number, fallbackLevels: number,
): Pick<ConvertResult, 'width' | 'height' | 'mipLevels' | 'variantBytes'> {
  const variantBytes: Partial<Record<TextureVariant, number>> = {};
  let dims: { width: number; height: number; levels: number } | null = null;
  for (const v of variants) {
    const p = cachePathFor(cacheDir, sourceUrlPath, hash, v);
    if (!fs.existsSync(p)) continue;
    variantBytes[v] = fs.statSync(p).size;
    if (!dims && KTX2_VARIANTS.includes(v)) dims = readKtx2Dims(p);
  }
  return {
    width: dims?.width ?? fallbackW,
    height: dims?.height ?? fallbackH,
    mipLevels: dims?.levels ?? fallbackLevels,
    variantBytes,
  };
}

/** Convert one source texture into its derived variants, writing them into the
 *  content cache. Returns the hash + variant list to persist in the meta. */
export async function convertTexture(opts: ConvertOptions): Promise<ConvertResult> {
  const { projectRoot, sourceUrlPath, absSource, settings } = opts;
  const textureType = opts.textureType ?? resolveTextureType({ texture: settings });
  const srcBytes = fs.readFileSync(absSource);
  const hash = hashKey(srcBytes, settings);
  const cacheDir = getCacheDir(projectRoot);
  const variants = variantsToEmit(settings.format, textureType);

  const sharp = ((await nativeDynamicImport('sharp')) as typeof import('sharp')).default;

  // Compute target dimensions: scale to fit the max-size cap (never upscale)
  // preserving aspect, then snap each axis to a multiple of 4. Block-compressed
  // formats (ASTC/UASTC/ETC) REQUIRE multiple-of-4 dimensions — odd sizes render
  // black/garbage on many mobile GPUs (and KTX2Loader warns about it). Harmless
  // for WebP/PNG. The tiny aspect change from snapping is negligible for UV maps.
  // Done up front (cheap header read) so stats are available even on a cache hit.
  const meta = await sharp(srcBytes).metadata();
  const srcW = meta.width ?? settings.maxSize;
  const srcH = meta.height ?? settings.maxSize;
  const scale = Math.min(settings.maxSize / srcW, settings.maxSize / srcH, 1);
  const m4 = (n: number) => Math.max(4, Math.round(n / 4) * 4);
  const tw = m4(srcW * scale);
  const th = m4(srcH * scale);
  const hasKtx = variants.some((v) => KTX2_VARIANTS.includes(v));
  const fallbackLevels = hasKtx && settings.mipmaps ? Math.floor(Math.log2(Math.max(tw, th))) + 1 : 1;
  const stats = () => gatherStats(cacheDir, sourceUrlPath, hash, variants, tw, th, fallbackLevels);

  if (cacheHit(cacheDir, sourceUrlPath, hash, settings.format, textureType)) {
    return { hash, variants, cached: true, srcWidth: srcW, srcHeight: srcH, ...stats() };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-tex-'));
  try {
    // Downscale and normalize to PNG so the KTX encoder reads a known format.
    // Orientation is baked HERE (not at runtime) so it survives block compression:
    // `.flip()` = vertical flip; the per-channel `.linear` inverts green (tangent-
    // space Y) for normal maps. Both feed every variant (KTX2/WebP/PNG) equally.
    let pipeline = sharp(srcBytes).resize(tw, th, { fit: 'fill', kernel: 'lanczos3' });
    if (settings.flipY) pipeline = pipeline.flip();
    if (settings.flipGreen) {
      const ch = meta.channels ?? 3;
      // output = a*in + b, per channel → green becomes 255 - green.
      const a = ch >= 4 ? [1, -1, 1, 1] : [1, -1, 1];
      const b = ch >= 4 ? [0, 255, 0, 0] : [0, 255, 0];
      pipeline = pipeline.linear(a, b);
    }
    const resized = await pipeline.png().toBuffer();

    fs.mkdirSync(path.dirname(cachePathFor(cacheDir, sourceUrlPath, hash, variants[0])), { recursive: true });

    for (const v of variants) {
      const outPath = cachePathFor(cacheDir, sourceUrlPath, hash, v);
      // Encode to a sibling temp, then atomically rename into place. An interrupted
      // or failed encode (especially the external toktx process being killed
      // mid-write) must NEVER leave a partial/0-byte file at the REAL cache path —
      // cacheHit would then treat that poison as a hit and the texture would fail to
      // load forever with a cryptic `{}` error (never self-healing on reimport).
      const tmpOut = `${outPath}.tmp-${process.pid}`;
      try {
        if (v === 'webp') {
          await sharp(resized).webp({ quality: resolveWebpQuality(settings.webpQuality), effort: 4 }).toFile(tmpOut);
        } else if (v === 'png') {
          fs.writeFileSync(tmpOut, resized);
        } else {
          const tmpPng = path.join(tmpDir, 'in.png');
          fs.writeFileSync(tmpPng, resized);
          const cli = ensureKtxCli();
          try {
            execFileSync(cli, buildToktxArgs(v as KtxVariant, settings, tmpPng, tmpOut), { stdio: 'pipe' });
          } catch (e) {
            const stderr = (e as { stderr?: Buffer }).stderr?.toString() ?? String(e);
            throw new Error(`toktx failed for ${sourceUrlPath} (${v}): ${stderr}`);
          }
        }
        fs.renameSync(tmpOut, outPath); // atomic within the cache dir
      } catch (e) {
        try { fs.rmSync(tmpOut, { force: true }); } catch { /* nothing to clean */ }
        throw e;
      }
    }
    return { hash, variants, cached: false, srcWidth: srcW, srcHeight: srcH, ...stats() };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
