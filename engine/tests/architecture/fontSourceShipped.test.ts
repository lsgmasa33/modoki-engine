/** A baked font ships its SOURCE file only when something needs it.
 *
 *  The asset manifest entry for a font is its source path (`…/Arimo-VariableFont_wght.ttf`),
 *  and `fontLoader.loadAllFonts` FontFace-loads exactly that IF the manifest's `font` block
 *  says `sourceShipped !== false`. There are THREE consumers, and the third was missed:
 *    1. BAKED canvas text (`Text2D.font`, a GUID) renders from the atlas alone — no source.
 *    2. DOM/PixiJS text (`UIElement.fontFamily`, a CSS family NAME) goes through the
 *       browser's FontFace API and needs the RAW variable source (CSS `font-weight`
 *       instances it natively, so a pinned instance is not a substitute).
 *    3. DYNAMIC canvas text generates glyphs at runtime and needs real OUTLINES too —
 *       the pinned `~instance.ttf` when `variationAxes` is authored, else the source.
 *  Shipping the source unconditionally wastes ~300KB/font on a baked canvas-only game
 *  (Court's case: 2 `Text2D` refs, zero `fontFamily` usage); never shipping it 404s at boot
 *  ("[FontLoader] N/N fonts failed to load") for a DOM-using one, or kills text entirely
 *  for a dynamic one.
 *
 *  So the shaker ships the source iff the static asset-tree-shaker's font-family walk
 *  (`result.domFontFiles`, from `resolveFontsByFamily`) found a scene/prefab naming this
 *  font's family — unless a per-font `shipSource:'always'|'never'` override says otherwise.
 *
 *  This is a source guard, not a build test: the emission lives inside the shaker's closure
 *  in vite-asset-scanner.ts and is not unit-reachable. It is deliberately narrow — it catches
 *  the two regressions that matter (shipping unconditionally again, or dropping on a bake
 *  FAILURE where the source is the only way the font renders at all), and would not catch a
 *  subtler break in the copy itself. */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../plugins/vite-asset-scanner.ts'),
  'utf8',
);

/** The SUCCESS half of the baked-font branch: after the atlas/metrics copies, before the
 *  bookkeeping — i.e. strictly inside `try`, excluding the `catch`.
 *
 *  Scoping matters more than it looks. A window that merely *starts* at the convertFont call
 *  also swallows the catch block, which legitimately calls `shipSource()` unconditionally on a
 *  bake FAILURE — so a naive `toContain('shipSource()')` over the whole try/catch would pass
 *  even if the SUCCESS path's call were deleted entirely, or (the opposite regression) even if
 *  it were made unconditional again. Verified by mutation: see the mutation-check notes in the
 *  hand-off report for this change. */
function bakedFontSuccessPath(): string {
  const start = SRC.indexOf('fontVariantCount++;');
  const end = SRC.indexOf('convertedFonts.set(');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return SRC.slice(start, end);
}

/** The bake-FAILURE catch block: from `convertedFonts.set(` (the success path's last
 *  statement) up to the loop's closing brace, marked by the atlas-count log line that
 *  follows the whole `for` loop. */
function bakedFontCatchPath(): string {
  const start = SRC.indexOf('convertedFonts.set(');
  const end = SRC.indexOf('if (fontVariantCount) console.log(');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return SRC.slice(start, end);
}

describe('baked fonts ship their source file only when something needs it', () => {
  it('calls shipSource() conditionally on the SUCCESS path, not unconditionally', () => {
    // Both derived files are still emitted...
    const branch = SRC.slice(SRC.indexOf('const conv = await convertFont('), SRC.indexOf('convertedFonts.set('));
    expect(branch).toContain('FONT_ATLAS_SUFFIX');
    expect(branch).toContain('FONT_METRICS_SUFFIX');
    // ...and the source ships IFF something needs it — a guarded call, not a bare one.
    // A bare `toContain('shipSource()')` would also match the catch block's unconditional
    // call (see bakedFontCatchPath below), so it must anchor to the guard itself. Assert
    // there is exactly ONE `shipSource()` call in this window and it is the guarded one —
    // catches both "guard deleted, call left bare" and "guard added but call duplicated".
    const successPath = bakedFontSuccessPath();
    const calls = successPath.match(/shipSource\(\)/g) ?? [];
    expect(calls.length).toBe(1);
    expect(successPath).toContain('if (shipTtf) shipSource();');
  });

  it('decides shipTtf from domFontFiles (DOM usage) or an explicit override, never unconditionally', () => {
    const successPath = bakedFontSuccessPath();
    expect(successPath).toContain("result.domFontFiles.has(virtualPath.normalize('NFC'))");
    expect(successPath).toContain("settings.shipSource === 'always'");
    expect(successPath).toContain("settings.shipSource !== 'never'");
  });

  /** A DYNAMIC font generates glyphs at runtime from real OUTLINES, so it needs a font
   *  file on disk even with zero DOM usage — the atlas alone is not enough for it (that
   *  is only true of a baked font).
   *
   *  This half was missing: `shipTtf` keyed solely on DOM usage, so a dynamic font
   *  referenced only by `Text2D.font` (a GUID) had its source DROPPED from the build and
   *  `fontAtlasLoader`'s unconditional source fetch 404'd at boot — no text, in production
   *  only. Dev never showed it, serving everything off disk. Which file it needs depends
   *  on axes: the pinned `~instance.ttf` when `variationAxes` is authored (the generator
   *  cannot apply axes itself), else the source.
   */
  it('ships outlines for a DYNAMIC font even with no DOM usage', () => {
    const successPath = bakedFontSuccessPath();
    expect(successPath).toContain("settings.mode === 'dynamic'");
    // The instance replaces the source when axes are pinned; otherwise the source stands in.
    expect(successPath).toContain('const shipInstance = genWants && !!conv.instanced;');
    expect(successPath).toContain('const shipTtf = domWants || (genWants && !shipInstance);');
    expect(successPath).toContain('FONT_INSTANCE_SUFFIX');
  });

  it('keeps the DOM decision independent of the dynamic one', () => {
    // A DOM consumer needs the RAW variable source (CSS font-weight instances it
    // natively), so `instanced` must never be treated as a substitute for it.
    const successPath = bakedFontSuccessPath();
    expect(successPath).toContain('const domWants =');
    expect(successPath).toMatch(/const shipTtf = domWants \|\|/);
  });

  it('verifies a dynamic font\'s outlines exist in dist, not just its atlas', () => {
    // The strict build gate checked only atlas+metrics for a font entry, which is exactly
    // why the dropped-source bug could reach a shipped build without failing anything.
    const gate = SRC.slice(SRC.indexOf("checkFile(entry.path + FONT_ATLAS_SUFFIX, 'font atlas');"));
    expect(gate.slice(0, 900)).toContain("entry.font.mode === 'dynamic'");
    expect(gate.slice(0, 900)).toContain('FONT_INSTANCE_SUFFIX');
  });

  it('still calls shipSource() unconditionally on a bake FAILURE', () => {
    // A failed bake means no atlas — the source is the ONLY way the font renders at all,
    // so the catch path must ship it regardless of the shipTtf decision.
    const catchPath = bakedFontCatchPath();
    expect(catchPath).toContain('} catch (e) {');
    expect(catchPath).toContain('shipSource();');
  });

  it('still ships a plain CSS-family font verbatim', () => {
    expect(SRC).toContain('if (!hasFont) { shipSource(); continue; }');
  });

  // If someone re-optimises the payload, the comment block is the first thing they read —
  // it has to name the consumer that breaks, or the source looks like dead weight.
  it('records WHY the source ships conditionally, so the payload cost is not re-cut blindly', () => {
    const branch = SRC.slice(Math.max(0, SRC.indexOf('Bake each kept font')), SRC.indexOf('const convertedFonts'));
    expect(branch).toContain('FontFace');
    expect(branch).toContain('loadAllFonts');
  });
});
