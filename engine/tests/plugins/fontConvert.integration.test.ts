/** Font conversion INTEGRATION test — exercises the real msdf-atlas-gen CLI on a
 *  repo font, asserting the mtsdf atlas + Chlumsky metrics land in the content
 *  cache with the expected shape. Skipped when msdf-atlas-gen isn't installed (CI
 *  without the encoder), mirroring the texture/model integration tests. */

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { convertFont, ensureMsdfAtlasGen } from '../../plugins/font-convert';
import { getFontCacheDir, atlasCachePath, metricsCachePath, instanceCachePath } from '../../plugins/font-cache';
import { DEFAULT_FONT_SETTINGS } from '../../packages/modoki/src/runtime/core/fontSettings';

const FONT = path.resolve(
  __dirname,
  '../../packages/modoki/src/runtime/assets/fonts/Geologica/Geologica-VariableFont_CRSV,SHRP,slnt,wght.ttf',
);

let cliAvailable = false;
beforeAll(() => {
  try { ensureMsdfAtlasGen(); cliAvailable = true; } catch { cliAvailable = false; }
});

describe('convertFont (real msdf-atlas-gen)', () => {
  it('bakes an mtsdf atlas + Chlumsky metrics into the cache', async () => {
    if (!cliAvailable) { console.warn('[fontConvert.integration] msdf-atlas-gen missing — skipping'); return; }
    expect(fs.existsSync(FONT)).toBe(true);

    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-font-it-'));
    try {
      const sourceUrlPath = '/fonts/Geologica-VariableFont.ttf';
      const settings = { ...DEFAULT_FONT_SETTINGS, charset: 'ascii' as const };
      const result = await convertFont({ projectRoot, sourceUrlPath, absSource: FONT, settings });

      const cacheDir = getFontCacheDir(projectRoot);
      const atlas = atlasCachePath(cacheDir, sourceUrlPath, result.hash);
      const metrics = metricsCachePath(cacheDir, sourceUrlPath, result.hash);
      expect(fs.existsSync(atlas)).toBe(true);
      expect(fs.existsSync(metrics)).toBe(true);
      expect(result.cached).toBe(false);

      // Chlumsky JSON shape: mtsdf atlas + glyphs + metrics.
      const json = JSON.parse(fs.readFileSync(metrics, 'utf-8'));
      expect(json.atlas.type).toBe('mtsdf');
      expect(json.atlas.yOrigin).toBe('top');
      expect(json.atlas.distanceRange).toBe(settings.pxRange);
      expect(json.glyphs.length).toBeGreaterThan(90); // ~95 printable ASCII
      expect(result.atlasWidth).toBe(json.atlas.width);
      expect(result.glyphCount).toBe(json.glyphs.length);

      // A second run hits the cache (no re-encode).
      const again = await convertFont({ projectRoot, sourceUrlPath, absSource: FONT, settings });
      expect(again.cached).toBe(true);
      expect(again.hash).toBe(result.hash);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 30000);

  /** Bake `axes` and return the metrics JSON + the emitted instance path. */
  async function bake(projectRoot: string, axes?: Record<string, number>) {
    const sourceUrlPath = '/fonts/Geologica-VariableFont.ttf';
    const settings = { ...DEFAULT_FONT_SETTINGS, charset: 'ascii' as const, size: 64, ...(axes ? { variationAxes: axes } : {}) };
    const r = await convertFont({ projectRoot, sourceUrlPath, absSource: FONT, settings });
    const cacheDir = getFontCacheDir(projectRoot);
    return {
      result: r,
      metrics: JSON.parse(fs.readFileSync(metricsCachePath(cacheDir, sourceUrlPath, r.hash), 'utf-8')),
      instancePath: instanceCachePath(cacheDir, sourceUrlPath, r.hash),
    };
  }
  const advanceOfH = (m: { glyphs: Array<{ unicode: number; advance: number }> }) =>
    m.glyphs.find((g) => g.unicode === 72)!.advance;

  // THE end-to-end gate: an authored axis must reach the glyph OUTLINES. Verified by
  // PERTURBING the value and watching the bake follow — not by asserting a constant,
  // which would pass just as happily if axes were ignored entirely (exactly how
  // `-varfont` looks correct while doing nothing).
  it('an authored wght axis changes the baked glyph outlines', async () => {
    if (!cliAvailable) { console.warn('[fontConvert.integration] msdf-atlas-gen missing — skipping'); return; }
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-font-axis-'));
    try {
      const def = await bake(projectRoot);              // Geologica's default instance = Thin 100
      const bold = await bake(projectRoot, { wght: 700 });

      expect(advanceOfH(bold.metrics)).toBeGreaterThan(advanceOfH(def.metrics));
      // Different settings ⇒ different cache key ⇒ the two never collide.
      expect(bold.result.hash).not.toBe(def.result.hash);

      // Only the axis-bearing bake emits an instance variant, and it is a real font.
      expect(fs.existsSync(def.instancePath)).toBe(false);
      expect(def.result.instanced).toBeFalsy();
      expect(bold.result.instanced).toBe(true);
      expect(fs.statSync(bold.instancePath).size).toBeGreaterThan(1000);

      // Monotonic across the axis — a heavier pin is strictly wider, so the value is
      // being applied rather than merely toggling "some instance".
      const light = await bake(projectRoot, { wght: 200 });
      expect(advanceOfH(light.metrics)).toBeLessThan(advanceOfH(bold.metrics));
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 60000);

  it('re-uses the cache for an unchanged axis, and misses when it changes', async () => {
    if (!cliAvailable) { console.warn('[fontConvert.integration] msdf-atlas-gen missing — skipping'); return; }
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-font-axis-cache-'));
    try {
      expect((await bake(projectRoot, { wght: 700 })).result.cached).toBe(false);
      expect((await bake(projectRoot, { wght: 700 })).result.cached).toBe(true);
      // The allowlist in stableSettings must include the axes — otherwise this would
      // report a hit and silently serve the 700-weight atlas for a 300-weight request.
      expect((await bake(projectRoot, { wght: 300 })).result.cached).toBe(false);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 60000);
});
