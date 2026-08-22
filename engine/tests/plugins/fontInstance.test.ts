/** Variable-font instancing — the harfbuzz-subset WASM glue.
 *
 *  No external CLI needed (unlike the msdf-atlas-gen tests): harfbuzzjs ships the wasm
 *  as an npm dependency, which is the whole reason this route was chosen over the native
 *  `hb-subset` binary. So these run everywhere, including CI and Windows.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { instanceFont, readFontAxes, hasAxes } from '../../plugins/font-instance';

const FONTS = path.resolve(__dirname, '../../packages/modoki/src/runtime/assets/fonts');
const GEOLOGICA = path.join(FONTS, 'Geologica/Geologica-VariableFont_CRSV,SHRP,slnt,wght.ttf');
const ARIMO = path.join(FONTS, 'Arimo/Arimo-VariableFont_wght.ttf');

const read = (p: string) => new Uint8Array(fs.readFileSync(p));

describe('readFontAxes', () => {
  it('reports every axis with its real range', () => {
    const axes = readFontAxes(read(GEOLOGICA));
    expect(axes.map((a) => a.tag).sort()).toEqual(['CRSV', 'SHRP', 'slnt', 'wght']);
    const wght = axes.find((a) => a.tag === 'wght')!;
    expect(wght).toMatchObject({ min: 100, max: 900 });
  });

  // The bug this whole feature exists for, pinned as a fact: a Google variable font's
  // DEFAULT instance is frequently the axis MINIMUM, not Regular 400. Unpinned, Geologica
  // renders Thin — which is what made it look unusable, and what got misread as a
  // baked-vs-dynamic difference. If this ever changes, the sidecar defaults in §7 of
  // docs/fonts.md should be revisited.
  it('shows Geologica defaults to Thin 100, not Regular 400', () => {
    expect(readFontAxes(read(GEOLOGICA)).find((a) => a.tag === 'wght')!.def).toBe(100);
  });

  it('reports Arimo as a 400..700 wght font defaulting to 400', () => {
    expect(readFontAxes(read(ARIMO))).toEqual([{ tag: 'wght', min: 400, def: 400, max: 700 }]);
  });

  it('returns [] for a non-variable font rather than throwing', async () => {
    const staticFont = await instanceFont(read(ARIMO), { wght: 700 });
    expect(readFontAxes(staticFont)).toEqual([]);
  });
});

describe('hasAxes', () => {
  it('treats absent and empty as "no axes" alike', () => {
    expect(hasAxes(undefined)).toBe(false);
    expect(hasAxes({})).toBe(false);
    expect(hasAxes({ wght: 700 })).toBe(true);
  });
});

describe('instanceFont', () => {
  it('returns the source untouched when no axes are pinned', async () => {
    const src = read(ARIMO);
    expect(await instanceFont(src, {})).toBe(src);
  });

  it('pins an axis, producing a static instance', async () => {
    const src = read(GEOLOGICA);
    const out = await instanceFont(src, { wght: 700 });
    expect(out.byteLength).toBeGreaterThan(0);
    expect(Buffer.compare(Buffer.from(out), Buffer.from(src))).not.toBe(0);
    // fvar is gone ⇒ a true static instance, not a variable font carrying a default.
    expect(readFontAxes(out)).toEqual([]);
  });

  it('pins several axes at once', async () => {
    const out = await instanceFont(read(GEOLOGICA), { wght: 600, SHRP: 40, CRSV: 1 });
    expect(readFontAxes(out)).toEqual([]);
    expect(out.byteLength).toBeGreaterThan(0);
  });

  // Naming one axis of a four-axis font must still yield a STATIC instance: the unnamed
  // axes are pinned to their own defaults rather than left variable, so nothing
  // downstream has to guess which instance it is holding.
  it('pins the unnamed axes to their defaults too', async () => {
    const out = await instanceFont(read(GEOLOGICA), { wght: 700 });
    expect(readFontAxes(out)).toEqual([]);
    // Equivalent to spelling every axis out at its default.
    const explicit = await instanceFont(read(GEOLOGICA), { wght: 700, CRSV: 0, SHRP: 0, slnt: 0 });
    expect(Buffer.compare(Buffer.from(out), Buffer.from(explicit))).toBe(0);
  });

  it('is deterministic — the same axes give byte-identical output', async () => {
    const src = read(GEOLOGICA);
    const a = await instanceFont(src, { wght: 700 });
    const b = await instanceFont(src, { wght: 700 });
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0);
  });

  it('produces DIFFERENT bytes per weight (an axis value is not cosmetic)', async () => {
    const src = read(GEOLOGICA);
    const light = await instanceFont(src, { wght: 200 });
    const heavy = await instanceFont(src, { wght: 800 });
    expect(Buffer.compare(Buffer.from(light), Buffer.from(heavy))).not.toBe(0);
  });

  // THE load-bearing property, and the reason this beats `msdf-atlas-gen -varfont`:
  // a bad axis FAILS instead of silently yielding the default instance. `-varfont`
  // accepts anything, exits 0, and bakes a byte-identical default-instance atlas — a
  // feature that looks wired and moves nothing on screen.
  it('throws (naming the real axes) when an axis is absent from the font', async () => {
    await expect(instanceFont(read(ARIMO), { SHRP: 40 })).rejects.toThrow(
      /axis "SHRP" is not in this font.*wght \(400\.\.700, default 400\)/s,
    );
  });

  it('throws when the font is not variable at all', async () => {
    const staticFont = await instanceFont(read(ARIMO), { wght: 700 });
    await expect(instanceFont(staticFont, { wght: 500 })).rejects.toThrow(/no fvar table/);
  });

  it('rejects a malformed axis tag', async () => {
    await expect(instanceFont(read(ARIMO), { wg: 700 })).rejects.toThrow(/4 characters/);
  });

  it('retains the full charset — it instances, it does not subset', async () => {
    // A baked font's .ttf ships only for DOM consumers (UIElement.fontFamily), which need
    // every glyph, not the atlas's charset. Latin-1 'ÿ' is outside ASCII, so its survival
    // proves keep-everything rather than a charset-trimmed output.
    const out = await instanceFont(read(ARIMO), { wght: 700 });
    const src = read(ARIMO);
    expect(countCmapCodepoints(out)).toBe(countCmapCodepoints(src));
  });
});

/** SOURCE GUARD — this module is loaded in BOTH module systems and the wasm lookup must
 *  survive both.
 *
 *  `createRequire(import.meta.url)` works in the Vite/vite-node ESM graph and throws in the
 *  Electron backend bundle, which is CJS and leaves `import.meta.url` **undefined**:
 *  "The argument 'filename' must be a file URL object, file URL string, or absolute path
 *  string. Received undefined". It cost a live debugging round — font instancing worked in
 *  dev right up until `editorBackendRouter` imported this module, which pulled it into the
 *  CJS bundle and broke every bake. The packaged editor would have hit it with no import
 *  at all.
 *
 *  This is a SOURCE guard because the test runner is ESM: no test in this suite can
 *  actually enter the failing context, so the only thing that catches a regression is
 *  reading the code. Keep the `requireBase()` fallback chain. */
describe('wasm resolution survives CJS as well as ESM', () => {
  const SRC = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../plugins/font-instance.ts'),
    'utf8',
  );
  /** Comments stripped: the module DOCUMENTS the bad call as the trap to avoid, so a
   *  naive scan over the whole file matches its own warning and fails green code. */
  const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  it('never passes import.meta.url straight to createRequire', () => {
    expect(CODE).not.toMatch(/createRequire\(\s*import\.meta\.url\s*\)/);
    // …and the guard is not vacuous: the call it is scoping IS still there.
    expect(CODE).toMatch(/createRequire\(/);
  });

  it('falls back to __dirname and cwd when import.meta.url is absent', () => {
    expect(CODE).toContain('function requireBase()');
    expect(CODE).toContain('__dirname');
    expect(CODE).toContain('process.cwd()');
    // The fallbacks must be FILE paths — createRequire rejects a bare directory.
    expect(CODE).toMatch(/path\.join\(__dirname, '[^']+'\)/);
  });
});

/** Count the codepoints a font's cmap maps, via its format-4 subtable segment ranges.
 *  Enough to prove no glyph coverage was dropped. */
function countCmapCodepoints(bytes: Uint8Array): number {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const numTables = b.readUInt16BE(4);
  let cmap = 0;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (b.toString('latin1', rec, rec + 4) === 'cmap') { cmap = b.readUInt32BE(rec + 8); break; }
  }
  if (!cmap) return 0;
  const nSub = b.readUInt16BE(cmap + 2);
  for (let i = 0; i < nSub; i++) {
    const off = cmap + b.readUInt32BE(cmap + 4 + i * 8 + 4);
    if (b.readUInt16BE(off) !== 4) continue; // format 4 only
    const segX2 = b.readUInt16BE(off + 6);
    const endBase = off + 14;
    const startBase = endBase + segX2 + 2;
    let total = 0;
    for (let s = 0; s < segX2 / 2; s++) {
      const end = b.readUInt16BE(endBase + s * 2);
      const start = b.readUInt16BE(startBase + s * 2);
      if (end >= start && end !== 0xffff) total += end - start + 1;
    }
    return total;
  }
  return 0;
}
