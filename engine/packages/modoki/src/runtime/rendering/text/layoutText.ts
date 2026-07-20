/** Pure text layout — turns a string + a synchronous glyph source into positioned
 *  textured quads. No renderer, DOM, or async: fully headless-testable and the
 *  single source of truth both the 2D (Pixi) and 3D (Three) paths feed geometry
 *  from. Output is in **px, Y-down, block-local** space (origin = top-left of the
 *  text box); the per-backend geometry builder flips Y for the 3D world. UVs are
 *  0..1, top-origin (matching {@link GlyphAtlas} `atlasBounds`).
 */

import type { Glyph, FontMetrics, AtlasInfo } from './glyphAtlas';

/** The synchronous view of a font that layout needs. A baked provider has every
 *  glyph; a dynamic provider returns the baked glyph or `undefined` on a miss (and
 *  separately queues generation + a relayout), so layout must tolerate misses. */
export interface LayoutFont {
  metrics: FontMetrics;
  atlas: AtlasInfo;
  getGlyph(cp: number): Glyph | undefined;
  /** Kerning adjustment between an ordered pair, in em (0 if none). */
  kerning(a: number, b: number): number;
}

export type TextAlign = 'left' | 'center' | 'right';

export interface LayoutOptions {
  /** Px per em. */
  fontSize: number;
  /** Wrap width in px (word-wrap). 0/undefined ⇒ no wrapping. */
  maxWidth?: number;
  /** Horizontal alignment within the text box. */
  align?: TextAlign;
  /** Multiplier on the font's line height (default 1). */
  lineSpacing?: number;
  /** Extra px added to each glyph's advance (tracking). */
  letterSpacing?: number;
}

export interface TextQuad {
  unicode: number;
  /** Px, Y-down, block-local (top-left origin). */
  x0: number; y0: number; x1: number; y1: number;
  /** 0..1 UV, top-origin (relative to the glyph's OWN atlas page). */
  u0: number; v0: number; u1: number; v1: number;
  /** Atlas page the glyph lives on (0 for baked / the first dynamic page). The
   *  geometry builder groups quads by this so each page renders against its texture. */
  page: number;
  /** Optional per-glyph colour MULTIPLIER [r,g,b,a] in 0..1 (from a colour animation
   *  effect — rainbow/fade). Absent ⇒ white (1,1,1,1) = no tint, no fade. Applied by
   *  the shader on top of the style colour. */
  color?: readonly [number, number, number, number];
}

export interface TextLayout {
  quads: TextQuad[];
  /** Box width in px (max line width, or `maxWidth` when wrapping). */
  width: number;
  /** Box height in px (line count × line step). */
  height: number;
  lines: number;
}

/** Advance of a missing glyph, in em — keeps text from collapsing when a glyph
 *  isn't in the atlas yet (dynamic miss) or at all (baked miss). */
const FALLBACK_ADVANCE_EM = 0.5;

function advanceEm(font: LayoutFont, cp: number): number {
  const g = font.getGlyph(cp);
  return g ? g.advance : FALLBACK_ADVANCE_EM;
}

/** Width in px of a run of codepoints with internal kerning + letter spacing. */
function measureRun(font: LayoutFont, cps: number[], fs: number, letter: number): number {
  let w = 0;
  for (let i = 0; i < cps.length; i++) {
    if (i > 0) w += font.kerning(cps[i - 1], cps[i]) * fs;
    w += advanceEm(font, cps[i]) * fs + letter;
  }
  return w;
}

export function layoutText(font: LayoutFont, text: string, opts: LayoutOptions): TextLayout {
  const fs = opts.fontSize;
  const lineSpacing = opts.lineSpacing ?? 1;
  const letter = opts.letterSpacing ?? 0;
  const maxW = opts.maxWidth && opts.maxWidth > 0 ? opts.maxWidth : Infinity;
  const align: TextAlign = opts.align ?? 'left';
  const lineStep = font.metrics.lineHeight * fs * lineSpacing;
  // ascender is negative in the Y-down convention → distance from box top to the
  // first baseline is its magnitude.
  const ascentPx = -font.metrics.ascender * fs;
  const spaceW = advanceEm(font, 0x20) * fs + letter;

  // 1. Break into visual lines (hard '\n' breaks, then greedy word wrap).
  const visualLines: number[][] = [];
  for (const hard of text.split('\n')) {
    const words = hard.split(' ');
    let cur: number[] = [];
    let curW = 0;
    let curHasContent = false;
    for (const word of words) {
      const wordCps = [...word].map((c) => c.codePointAt(0) ?? 0);
      const wordW = measureRun(font, wordCps, fs, letter);
      const gap = curHasContent ? spaceW : 0;
      if (curHasContent && curW + gap + wordW > maxW) {
        visualLines.push(cur);
        cur = []; curW = 0; curHasContent = false;
      }
      if (curHasContent) { cur.push(0x20); curW += spaceW; }
      cur.push(...wordCps);
      curW += wordW;
      curHasContent = true;
    }
    visualLines.push(cur); // keep blank lines too
  }

  // 2. Lay out each visual line exactly (kerning across the whole final line),
  //    collecting glyph origins + the line's advance width.
  interface Placed { cp: number; x: number }
  const perLine: { placed: Placed[]; width: number }[] = visualLines.map((cps) => {
    const placed: Placed[] = [];
    let pen = 0;
    for (let i = 0; i < cps.length; i++) {
      if (i > 0) pen += font.kerning(cps[i - 1], cps[i]) * fs;
      placed.push({ cp: cps[i], x: pen });
      pen += advanceEm(font, cps[i]) * fs + letter;
    }
    return { placed, width: pen };
  });

  const maxLineWidth = perLine.reduce((m, l) => Math.max(m, l.width), 0);
  const boxWidth = maxW === Infinity ? maxLineWidth : maxW;

  // 3. Emit quads, applying vertical baseline + horizontal alignment.
  const quads: TextQuad[] = [];
  const { width: aw, height: ah } = font.atlas;
  perLine.forEach((line, li) => {
    const baselineY = ascentPx + li * lineStep;
    const alignOffset =
      align === 'center' ? (boxWidth - line.width) / 2
        : align === 'right' ? boxWidth - line.width
          : 0;
    for (const { cp, x } of line.placed) {
      const g = font.getGlyph(cp);
      if (!g || !g.plane || !g.atlas) continue; // whitespace / not-yet-generated
      const ox = x + alignOffset;
      quads.push({
        unicode: cp,
        x0: ox + g.plane.left * fs,
        x1: ox + g.plane.right * fs,
        y0: baselineY + g.plane.top * fs,
        y1: baselineY + g.plane.bottom * fs,
        u0: g.atlas.left / aw,
        u1: g.atlas.right / aw,
        v0: g.atlas.top / ah,
        v1: g.atlas.bottom / ah,
        page: g.page ?? 0,
      });
    }
  });

  return { quads, width: boxWidth, height: perLine.length * lineStep, lines: perLine.length };
}
