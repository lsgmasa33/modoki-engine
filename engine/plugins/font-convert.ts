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
import type { FontImportSettings } from '../packages/modoki/src/runtime/loaders/fontSettings';
import { expandCharset } from '../packages/modoki/src/runtime/loaders/fontSettings';
import { getFontCacheDir, hashKey, atlasCachePath, metricsCachePath, fontCacheHit } from './font-cache';

const MSDF_MISSING_MSG =
  'msdf-atlas-gen not found. The packaged editor bundles it (resources/bin, via MODOKI_MSDF_ATLAS_GEN); ' +
  'in a dev checkout set MODOKI_MSDF_ATLAS_GEN to a binary path or install it — ' +
  (process.platform === 'win32'
    ? 'Windows: download msdf-atlas-gen-<ver>-win64.zip from https://github.com/Chlumsky/msdf-atlas-gen/releases and put msdf-atlas-gen.exe on PATH.'
    : 'macOS: `brew install msdf-atlas-gen`; https://github.com/Chlumsky/msdf-atlas-gen.');

let genCheck: { ok: boolean; cli: string } | null = null;

/** Resolve the msdf-atlas-gen binary: an explicit MODOKI_MSDF_ATLAS_GEN path (the
 *  packaged Electron editor can point this at a bundled binary) wins, else the
 *  bare `msdf-atlas-gen` name resolved via PATH (dev). */
function msdfAtlasGenBinary(): string {
  return process.env.MODOKI_MSDF_ATLAS_GEN || 'msdf-atlas-gen';
}

/** For tests — forget the cached CLI-availability probe. */
export function __resetMsdfCheck(): void { genCheck = null; }

/** Ensure `msdf-atlas-gen` is callable; returns the CLI path/name or throws with
 *  an install hint. Probed by invoking with no args (prints usage, exit 0). */
export function ensureMsdfAtlasGen(): string {
  const cli = msdfAtlasGenBinary();
  if (genCheck && genCheck.cli === cli) {
    if (!genCheck.ok) throw new Error(MSDF_MISSING_MSG);
    return genCheck.cli;
  }
  try {
    execFileSync(cli, [], { stdio: 'pipe' });
    genCheck = { ok: true, cli };
    return cli;
  } catch (e) {
    // Exit code is non-zero only when the binary is missing; usage-print with no
    // args exits 0, so an ENOENT (spawn failure) is the miss signal.
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      genCheck = { ok: false, cli };
      throw new Error(MSDF_MISSING_MSG);
    }
    // Any other error (e.g. non-zero exit) still means the binary ran → available.
    genCheck = { ok: true, cli };
    return cli;
  }
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

  if (fontCacheHit(cacheDir, sourceUrlPath, hash)) {
    return { hash, cached: true, ...readAtlasStats(metricsPath, atlasPath) };
  }

  const cli = ensureMsdfAtlasGen();
  fs.mkdirSync(path.dirname(atlasPath), { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-font-'));
  try {
    const charsetFilePath = path.join(tmpDir, 'charset.txt');
    fs.writeFileSync(charsetFilePath, buildCharsetFile(settings));
    // Emit to temp then move into the cache so a crash mid-encode never leaves a
    // half-written atlas that fontCacheHit would treat as complete.
    const tmpPng = path.join(tmpDir, 'atlas.png');
    const tmpJson = path.join(tmpDir, 'metrics.json');
    try {
      execFileSync(cli, buildAtlasGenArgs(settings, absSource, charsetFilePath, tmpPng, tmpJson), { stdio: 'pipe' });
    } catch (e) {
      const stderr = (e as { stderr?: Buffer }).stderr?.toString() ?? String(e);
      throw new Error(`msdf-atlas-gen failed for ${sourceUrlPath}: ${stderr}`);
    }
    fs.renameSync(tmpPng, atlasPath);
    fs.renameSync(tmpJson, metricsPath);
    return { hash, cached: false, ...readAtlasStats(metricsPath, atlasPath) };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
