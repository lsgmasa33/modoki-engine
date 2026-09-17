/** Font conversion service (runs in Node — dev server + build).
 *
 *  Pipeline: msdf-atlas-gen reads the source `.ttf`/`.otf` and the resolved
 *  charset, and emits an mtsdf atlas PNG + a Chlumsky JSON metrics layout into the
 *  content cache (see font-cache.ts). Cache hits skip all work. msdf-atlas-gen is
 *  an external prerequisite — {@link ensureMsdfAtlasGen} surfaces a clear install
 *  hint when it's missing.
 *
 *  Atlas orientation: baked with `-yorigin top`, so `atlasBounds` are top-origin.
 *  The runtime uploads the atlas with `flipY=false` on Three (matching the repo's
 *  KTX2 convention) and native top-origin on Pixi, giving uniform top-origin UVs
 *  in the shared geometry builder.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import type { FontImportSettings } from '../packages/modoki/src/runtime/core/fontSettings';
import { expandCharset } from '../packages/modoki/src/runtime/core/fontSettings';
import { getFontCacheDir, hashKey, atlasCachePath, metricsCachePath, instanceCachePath, fontCacheHit } from './font-cache';
import { instanceFont, hasAxes } from './font-instance';
import { pinnedConversionCli } from './pinned-cli';
import { forgetDetection } from '../toolchain';

/** For tests — forget the cached msdf-atlas-gen detection. */
export function __resetMsdfCheck(): void { forgetDetection('msdf-atlas-gen'); }

/** The pinned `msdf-atlas-gen` (#1327) — the packaged editor's bundled copy, the provisioned one
 *  under the toolchain dir, or an explicit MODOKI_MSDF_ATLAS_GEN — or throws with an install hint.
 *  Never PATH: the atlas ships what this binary baked, and its cache key does not name the binary. */
export function ensureMsdfAtlasGen(): string {
  return pinnedConversionCli('msdf-atlas-gen');
}

/** Format the resolved charset as an msdf-atlas-gen charset file — a single
 *  double-quoted string of all characters, with `"` and `\` escaped. Pure. */
export function buildCharsetFile(settings: FontImportSettings): string {
  const chars = expandCharset(settings);
  const escaped = chars.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/** Build the msdf-atlas-gen argument vector. Pure — unit tested. */
export function buildAtlasGenArgs(
  settings: FontImportSettings,
  fontPath: string,
  charsetFile: string,
  outPng: string,
  outJson: string,
): string[] {
  return [
    // Plain `-font`, ALWAYS — `fontPath` is already the axis-pinned instance when the
    // font has `variationAxes`. Do NOT "simplify" this into `-varfont <src>?wght=N`:
    // that flag is a SILENT NO-OP in our msdf-atlas-gen build (accepted, exit 0, no
    // warning, byte-identical atlas — measured). Guarded in fontConvert.test.ts.
    '-font', fontPath,
    '-charset', charsetFile,
    '-type', settings.fieldType,
    '-format', 'png',
    '-imageout', outPng,
    '-json', outJson,
    '-size', String(settings.size),
    '-pxrange', String(settings.pxRange),
    // Empty border around each glyph so the distance field fully decays to 0 INSIDE
    // the glyph's quad. Without it the field is cut at the tight cell edge and any
    // effect that reaches past the glyph (glow, drop shadow, an aggressive weight)
    // clips to a hard rectangle + bleeds from the neighbor via bilinear filtering.
    // Sized to the pxRange so it also gives the shadow offset room.
    '-pxpadding', String(settings.pxRange),
    '-yorigin', 'top',
    // Full distance-based error correction. The `auto-*` modes deliberately SKIP
    // errors that affect edges/corners (to keep corners crisp), which leaves the
    // median-clash nicks at sharp concave corners (e.g. the M/W inner vertices, the
    // g counter). `distance-full` evaluates exact distances and corrects errors
    // even at corners — killing those nicks — at a slight, acceptable corner-
    // softening cost for a UI/label font.
    '-errorcorrection', 'distance-full',
    '-potr', // power-of-two rectangle: minimal GPU-friendly atlas that fits
  ];
}

export interface FontConvertOptions {
  projectRoot: string;
  /** Source URL path, e.g. /games/text-demo/assets/fonts/Inter.ttf */
  sourceUrlPath: string;
  /** Absolute filesystem path to the source font. */
  absSource: string;
  settings: FontImportSettings;
}

export interface FontConvertResult {
  hash: string;
  atlasWidth?: number;
  atlasHeight?: number;
  glyphCount?: number;
  /** Atlas PNG byte size. */
  bytes?: number;
  cached: boolean;
  /** True when `variationAxes` was set, so an `~instance.ttf` variant exists. The
   *  dynamic runtime generator must fetch THAT rather than the raw source. */
  instanced?: boolean;
}

function readAtlasStats(metricsPath: string, atlasPath: string): Pick<FontConvertResult, 'atlasWidth' | 'atlasHeight' | 'glyphCount' | 'bytes'> {
  let atlasWidth: number | undefined;
  let atlasHeight: number | undefined;
  let glyphCount: number | undefined;
  try {
    const json = JSON.parse(fs.readFileSync(metricsPath, 'utf-8'));
    atlasWidth = json?.atlas?.width;
    atlasHeight = json?.atlas?.height;
    glyphCount = Array.isArray(json?.glyphs) ? json.glyphs.length : undefined;
  } catch { /* leave undefined */ }
  let bytes: number | undefined;
  try { bytes = fs.statSync(atlasPath).size; } catch { /* leave undefined */ }
  return { atlasWidth, atlasHeight, glyphCount, bytes };
}

/** Convert one source font into its mtsdf atlas + metrics, writing them into the
 *  content cache. Returns the hash + atlas stats to persist in the meta. */
export async function convertFont(opts: FontConvertOptions): Promise<FontConvertResult> {
  const { projectRoot, sourceUrlPath, absSource, settings } = opts;
  const srcBytes = fs.readFileSync(absSource);
  const hash = hashKey(srcBytes, settings);
  const cacheDir = getFontCacheDir(projectRoot);
  const atlasPath = atlasCachePath(cacheDir, sourceUrlPath, hash);
  const metricsPath = metricsCachePath(cacheDir, sourceUrlPath, hash);

  if (fontCacheHit(cacheDir, sourceUrlPath, hash, settings)) {
    return { hash, cached: true, instanced: hasAxes(settings.variationAxes), ...readAtlasStats(metricsPath, atlasPath) };
  }

  const cli = ensureMsdfAtlasGen();
  fs.mkdirSync(path.dirname(atlasPath), { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-font-'));
  try {
    // Axis instancing FIRST — the bake and the runtime generator both consume the
    // instanced file, because neither can pin an axis itself (see font-instance.ts).
    // No axes ⇒ bake straight from the source and emit no instance variant.
    let bakeSource = absSource;
    const instanced = hasAxes(settings.variationAxes);
    if (instanced) {
      const tmpTtf = path.join(tmpDir, 'instance.ttf');
      fs.writeFileSync(tmpTtf, await instanceFont(srcBytes, settings.variationAxes!));
      bakeSource = tmpTtf;
    }

    const charsetFilePath = path.join(tmpDir, 'charset.txt');
    fs.writeFileSync(charsetFilePath, buildCharsetFile(settings));
    // Emit to temp then move into the cache so a crash mid-encode never leaves a
    // half-written atlas that fontCacheHit would treat as complete.
    const tmpPng = path.join(tmpDir, 'atlas.png');
    const tmpJson = path.join(tmpDir, 'metrics.json');
    try {
      execFileSync(cli, buildAtlasGenArgs(settings, bakeSource, charsetFilePath, tmpPng, tmpJson), { stdio: 'pipe' });
    } catch (e) {
      const stderr = (e as { stderr?: Buffer }).stderr?.toString() ?? String(e);
      throw new Error(`msdf-atlas-gen failed for ${sourceUrlPath}: ${stderr}`, { cause: e });
    }
    fs.renameSync(tmpPng, atlasPath);
    fs.renameSync(tmpJson, metricsPath);
    // Publish the instance LAST: fontCacheHit requires it when axes are set, so a crash
    // before this point leaves an incomplete entry that re-converts rather than one that
    // reads as complete with a missing variant.
    if (instanced) fs.renameSync(path.join(tmpDir, 'instance.ttf'), instanceCachePath(cacheDir, sourceUrlPath, hash));
    return { hash, cached: false, instanced, ...readAtlasStats(metricsPath, atlasPath) };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
