/**
 * Measure real, rendered 2D text from GAME code (#1038).
 *
 * ⚠️ **The engine has always measured text; game code just could not reach it.** `Scene2D` calls
 * `layoutText` on every text rebuild and caches the result on the slot, but `layoutText` needs a
 * `LayoutFont`, and the only way to get one — `getLoadedFont(guid)` — is not re-exported from
 * `runtime/index.ts`. So a game that needed a width had no option but to guess, and wordweave duly
 * grew a `currentWordAdvanceRatio` knob whose own tooltip conceded it was "a knob, not a fact —
 * nothing measures text at runtime". That sentence was true of the public API and false of the
 * engine, and the 17% error it carried is what #1038 measured.
 *
 * ⚠️ **This exists rather than exporting `getLoadedFont`, because the raw seam has a trap.** A
 * glyph that is not in the atlas yet measures at `FALLBACK_ADVANCE_EM` (0.5 em) instead of its real
 * advance — silently, with a plausible number out the other end. Court hit exactly this and left a
 * scar about it in `dialogAnchorAndReserve.test.ts`. `ensureGlyphs` has to run first, and putting
 * that inside the one helper is the difference between an API and a footgun.
 *
 * The options mirror `Text2D`'s own fields so a caller measuring an entity's text can pass what the
 * entity carries and get the width the renderer will actually draw.
 *
 * ⚠️ **It lives in `loaders/` (L3) rather than beside `layoutText` in `rendering/text/` (L2), and
 * the layer guard is what put it here.** Composing a font LOOKUP with a layout utility is L3 work
 * by definition — an L2 subsystem may not reach into loaders. The alternative was adding this file
 * to `L3_RECLASSIFIED_FILES` in `engine/eslint.config.js` beside `Scene2D.tsx`, but that list is
 * an owner reclassification per `docs/architecture-layers.md` § Settled decisions, not something a
 * change may grant itself to keep a file where it was first written.
 */

import { layoutText, type TextLayout } from '../rendering/text/layoutText';
import { getLoadedFont } from './fontAtlasLoader';
import { textCodepoints } from '../rendering/text/textCodepoints';

export interface MeasureText2DOptions {
  /** Font size in the same space the caller's text is drawn in (design px, for a `Text2D`). */
  fontSize: number;
  /** Wrap width; 0 or omitted means no wrapping — the usual case when measuring to FIT. */
  maxWidth?: number;
  align?: 'left' | 'center' | 'right';
  lineSpacing?: number;
  letterSpacing?: number;
}

/**
 * The layout `Scene2D` would produce for this text in this font, or `null` when the font has not
 * finished loading.
 *
 * ⚠️ **`null` is a real state, not an error, and callers must handle it rather than defaulting to
 * 0.** Fonts load asynchronously, so the first frames of a scene genuinely have no metrics — a
 * caller that reads `null` as "zero width" will size something to nothing for those frames. Treat
 * it as "cannot measure yet" and fall back to whatever the caller did before.
 */
export function measureText2D(
  fontGuid: string,
  text: string,
  opts: MeasureText2DOptions,
): TextLayout | null {
  if (!fontGuid || text === '') return null;
  const font = getLoadedFont(fontGuid);
  if (!font) return null;
  // ⚠️ Load-bearing: without this a glyph missing from the atlas measures at the 0.5 em fallback
  // rather than its real advance, which is the exact class of silent wrongness this helper exists
  // to remove.
  font.ensureGlyphs(textCodepoints(text));
  return layoutText(font, text, {
    fontSize: opts.fontSize,
    maxWidth: opts.maxWidth,
    align: opts.align,
    lineSpacing: opts.lineSpacing,
    letterSpacing: opts.letterSpacing,
  });
}
