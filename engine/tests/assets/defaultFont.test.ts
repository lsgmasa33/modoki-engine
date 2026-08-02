/** The engine ships ONE blessed MSDF text font — Arimo, `DEFAULT_FONT_GUID` — so a game can render
 *  `Text2D` without copying a font into its own assets (Court shipped a byte-identical 500 KB
 *  duplicate until #52).
 *
 *  It is the only font in the engine with a `.meta.json`, and that is deliberate: GUID healing
 *  SKIPS fonts (see the `type === 'font'` continue in vite-asset-scanner), because fonts are
 *  normally referenced by CSS family name and minting sidecars for every bundled family would be
 *  churn. The flip side is that nothing MAINTAINS this sidecar either — so the two ways it can rot
 *  are both silent, and both are asserted here:
 *    · the GUID drifting from the const games import (a dangling ref → no text at all in a build)
 *    · the `font` block going missing (the manifest emits no font block → the runtime treats it as
 *      a plain CSS font, and `fontAtlasLoader` finds no atlas to load) */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { DEFAULT_FONT_GUID } from '../../packages/modoki/src/runtime/assets/builtinAssets';

const ASSET_DIR = path.resolve(__dirname, '../../packages/modoki/src/runtime/assets');
const FONT = path.join(ASSET_DIR, 'fonts/Arimo/Arimo-VariableFont_wght.ttf');
const META = `${FONT}.meta.json`;

describe('the engine default font', () => {
  it('the .ttf the sidecar describes is actually there', () => {
    expect(fs.existsSync(FONT), `${FONT} is missing — DEFAULT_FONT_GUID resolves to nothing`).toBe(true);
  });

  it('sidecar GUID matches the runtime DEFAULT_FONT_GUID const (no drift)', () => {
    const meta = JSON.parse(fs.readFileSync(META, 'utf8'));
    expect(meta.id).toBe(DEFAULT_FONT_GUID);
    expect(meta.version).toBe(2);
  });

  it('carries the `font` import block that makes it BAKE rather than ship as a CSS font', () => {
    const meta = JSON.parse(fs.readFileSync(META, 'utf8'));
    expect(meta.font, 'no `font` block — the build would ship the raw .ttf and no MTSDF atlas').toBeTruthy();
    expect(meta.font.mode).toBe('baked');
    expect(meta.font.fieldType).toBe('mtsdf');
  });

  it('is the ONLY engine font with a sidecar — the others stay CSS-family-referenced', () => {
    // Not a style rule: a second sidecar means a second guid-bearing engine font, and the healing
    // skip that keeps the ~5 bundled families churn-free would no longer describe the tree.
    const dir = path.join(ASSET_DIR, 'fonts');
    const found: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.meta.json')) found.push(path.relative(dir, p));
      }
    };
    walk(dir);
    expect(found).toEqual([path.relative(dir, META)]);
  });
});
