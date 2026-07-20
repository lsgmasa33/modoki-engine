/** Font conversion INTEGRATION test — exercises the real msdf-atlas-gen CLI on a
 *  repo font, asserting the mtsdf atlas + Chlumsky metrics land in the content
 *  cache with the expected shape. Skipped when msdf-atlas-gen isn't installed (CI
 *  without the encoder), mirroring the texture/model integration tests. */

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { convertFont, ensureMsdfAtlasGen } from '../../plugins/font-convert';
import { getFontCacheDir, atlasCachePath, metricsCachePath } from '../../plugins/font-cache';
import { DEFAULT_FONT_SETTINGS } from '../../packages/modoki/src/runtime/loaders/fontSettings';

const FONT = path.resolve(
  __dirname,
  '../../packages/modoki/src/runtime/assets/fonts/Geologica/static/Geologica-Light.ttf',
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
      const sourceUrlPath = '/fonts/Geologica-Light.ttf';
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
});
