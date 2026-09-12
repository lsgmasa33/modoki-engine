/**
 * Real glyph advances, read out of a shipped `.ttf` — so a width budget measures THE STRING rather
 * than a calibrated average of a charset (#1119).
 *
 * ## Why this exists at all
 *
 * Two guards in this repo estimate a rendered width as `chars * fontSize * EM_PER_CHAR`, and both
 * carry long comments about keeping that constant honest: `games/wordweave/tests/corpus.test.ts`
 * § #1080 records a font swap (Arimo -> Klee One, #914) halving its headroom, and a correction
 * noting that **a flat charset average reverses the sign** — Klee One is 0.963x Arimo on uppercase
 * but 1.079x on digits and 1.260x on slash/space, so averaging the alphabet hid the characters the
 * HUD is actually dense in.
 *
 * A per-character mean is the wrong instrument whenever the strings are not drawn from the
 * distribution it was calibrated on. Measured here on Klee One:
 *
 * | string set | em/char |
 * |---|---|
 * | the HUD's `LEVEL 100100/100 WORDS100/100 EXTRA` mix | 0.585 |
 * | mixed-case UI labels (`Beginner`, `Vibration`, `Levels`, …) | **0.511** |
 * | the single word `Medium` | 0.607 |
 * | the single word `Vibration` | 0.470 |
 *
 * So a budget for mixed-case labels that inherited the HUD's 0.586 would over-estimate by ~15% and
 * refuse renames that fit; one that took the mixed-case mean would under-estimate `Medium` by 19%
 * and pass one that does not. **Summing the real advances removes the calibration question**, and
 * with it the "re-measure after a font swap" maintenance note — a font swap changes the answer
 * automatically, because the answer is read from the font.
 *
 * ⚠️ **This is an UPPER BOUND, and the direction is deliberate.** It sums `hmtx` advances and
 * applies no kerning (`GPOS`), which in practice pulls glyphs together — so a real render is at or
 * under this width. For a guard that refuses too-long strings, over-estimating is the safe error.
 *
 * ⚠️ **It models a single line with no shaping.** No ligatures, no bidi, no combining marks, no
 * `font-feature-settings`. Every string it is pointed at in this repo is Latin UI text. Point it at
 * Japanese or Arabic and it will return a number that means nothing.
 *
 * ⚠️ **A VARIABLE font is read at its DEFAULT instance.** `hmtx` carries the default master's
 * advances; an `HVAR` table can shift them for another point on the weight axis, and this reader
 * ignores `HVAR` entirely. Engine-bundled Arimo is variable, and its default instance is what
 * `corpus.test.ts` measured — so the cross-check holds — but a caller that renders a variable font
 * at a non-default weight is getting the default's widths. Both faces of Klee One are static.
 *
 * ⚠️ **`hmtx`/`unitsPerEm` IS the table the browser's advances come from**, which is what makes a
 * headless read a valid stand-in for a Chromium measurement. Cross-checked against figures
 * `corpus.test.ts` measured independently, and both halves are ASSERTED so the parser cannot rot
 * silently — **each against a different font, deliberately**:
 *
 * | pinned in | font | what it covers |
 * |---|---|---|
 * | `engine/tests/assets/fontMetrics.test.ts` | Arimo (engine-bundled) | 2048 upem, VARIABLE, `numberOfHMetrics == numGlyphs` |
 * | `games/wordweave/tests/authoredLabelBudget.test.ts` | Klee One (game-owned) | 1000 upem, static, `numberOfHMetrics` (243) **<** `numGlyphs` (245) |
 *
 * ⚠️ **Neither font alone is enough, which is why there are two.** The engine test cannot read a
 * game's font without coupling the engine suite to a game, and Arimo never exercises the
 * monospaced-tail clamp in `advanceOf` below (its metrics cover every glyph) — that path fires only
 * on Klee One, which is the font the shipping budget actually measures.
 */

import fs from 'node:fs';

export interface TextWidth {
  /** Summed advance width, in em (multiply by the CSS `font-size` for px). */
  readonly em: number;
  /** Characters with no glyph in this font, in order, duplicates kept. A space is never reported:
   *  it legitimately maps to glyph 0 in some subsets while still advancing. */
  readonly missing: readonly string[];
}

export interface FontMetrics {
  readonly unitsPerEm: number;
  /** Advance width of `text`, in em. See the file header for what this does and does not model. */
  widthEm(text: string): TextWidth;
}

/**
 * Parse the advance-width tables out of a TrueType/OpenType file.
 *
 * Only the four tables a width needs are read — `head` (unitsPerEm), `hhea` (numberOfHMetrics),
 * `hmtx` (the advances) and `cmap` (character -> glyph). Outlines, kerning and layout are ignored.
 *
 * ⚠️ **A `.ttc` collection and a WOFF/WOFF2 wrapper are NOT supported** — pass the plain `.ttf`/
 * `.otf` the project ships. A wrapper is compressed, so this would read its header as a table
 * directory and throw rather than silently return nonsense.
 */
export function readFontMetrics(path: string): FontMetrics {
  const b = fs.readFileSync(path);
  if (b.length < 12) throw new Error(`${path}: too short to be a font`);
  const u16 = (o: number): number => b.readUInt16BE(o);
  const u32 = (o: number): number => b.readUInt32BE(o);

  const tag = b.toString('ascii', 0, 4);
  // 0x00010000 ('\0\0\0') is TrueType; 'OTTO' is CFF-flavoured OpenType — both carry hmtx.
  if (tag !== 'OTTO' && u32(0) !== 0x00010000 && tag !== 'true') {
    throw new Error(`${path}: not a sfnt font (tag ${JSON.stringify(tag)}). A .ttc collection or a `
      + 'WOFF/WOFF2 wrapper is not supported — point this at the plain .ttf/.otf.');
  }

  const tables = new Map<string, { off: number; len: number }>();
  const numTables = u16(4);
  for (let i = 0; i < numTables; i++) {
    const o = 12 + i * 16;
    tables.set(b.toString('ascii', o, o + 4), { off: u32(o + 8), len: u32(o + 12) });
  }
  const head = tables.get('head'), hhea = tables.get('hhea');
  const hmtx = tables.get('hmtx'), cmap = tables.get('cmap');
  if (!head || !hhea || !hmtx || !cmap) {
    throw new Error(`${path}: missing one of head/hhea/hmtx/cmap`);
  }

  const unitsPerEm = u16(head.off + 18);
  if (!unitsPerEm) throw new Error(`${path}: unitsPerEm is 0`);
  const numberOfHMetrics = u16(hhea.off + 34);
  if (!numberOfHMetrics) throw new Error(`${path}: numberOfHMetrics is 0`);

  // Pick the best character map: a full-Unicode format 12 beats a BMP format 4, and either beats a
  // non-Windows subtable. Anything else is ignored rather than guessed at.
  let best: { sub: number; fmt: number; score: number } | null = null;
  const nSub = u16(cmap.off + 2);
  for (let i = 0; i < nSub; i++) {
    const rec = cmap.off + 4 + i * 8;
    const pid = u16(rec), eid = u16(rec + 2), sub = cmap.off + u32(rec + 4);
    const fmt = u16(sub);
    const score = (pid === 3 && eid === 10 && fmt === 12) ? 3
      : (pid === 3 && eid === 1 && fmt === 4) ? 2
        : (fmt === 4 || fmt === 12) ? 1 : 0;
    if (score > 0 && (!best || score > best.score)) best = { sub, fmt, score };
  }
  if (!best) throw new Error(`${path}: no format 4 or format 12 cmap subtable`);
  const chosen = best;

  const glyphFor = (cp: number): number => {
    if (chosen.fmt === 4) {
      const segX2 = u16(chosen.sub + 6);
      const endO = chosen.sub + 14;
      const startO = endO + segX2 + 2;         // +2 skips the reservedPad
      const deltaO = startO + segX2;
      const rangeO = deltaO + segX2;
      for (let s = 0; s < segX2 / 2; s++) {
        if (cp > u16(endO + s * 2)) continue;
        const start = u16(startO + s * 2);
        if (cp < start) return 0;
        const ro = u16(rangeO + s * 2);
        if (ro === 0) return (cp + b.readInt16BE(deltaO + s * 2)) & 0xffff;
        const gi = u16(rangeO + s * 2 + ro + (cp - start) * 2);
        return gi === 0 ? 0 : (gi + b.readInt16BE(deltaO + s * 2)) & 0xffff;
      }
      return 0;
    }
    const nGroups = u32(chosen.sub + 12);
    for (let g = 0; g < nGroups; g++) {
      const o = chosen.sub + 16 + g * 12;
      if (cp >= u32(o) && cp <= u32(o + 4)) return u32(o + 8) + (cp - u32(o));
    }
    return 0;
  };

  // Past `numberOfHMetrics` the advance is monospaced at the last entry's — the sfnt spec's own
  // compression for trailing glyphs of equal width, not a fallback.
  const advanceOf = (gid: number): number => u16(hmtx.off + Math.min(gid, numberOfHMetrics - 1) * 4);

  return {
    unitsPerEm,
    widthEm(text: string): TextWidth {
      let sum = 0;
      const missing: string[] = [];
      // Iterate by code POINT, so an astral character is one lookup rather than two surrogates.
      for (const ch of text) {
        const gid = glyphFor(ch.codePointAt(0)!);
        if (gid === 0 && ch !== ' ') missing.push(ch);
        sum += advanceOf(gid);
      }
      return { em: sum / unitsPerEm, missing };
    },
  };
}

/**
 * The WIDEST of several faces of one family, as a single `FontMetrics`.
 *
 * ⚠️ **Why a guard should budget against this rather than resolve `fontWeight` to a face.** Mapping
 * an authored `fontWeight` onto a shipped file is the renderer's job and depends on what the
 * `@font-face` set actually contains; a test that re-implements it grows a second copy of a rule it
 * does not own. Taking the widest face is a bound that holds whatever the renderer picks, and it
 * costs almost nothing when the faces are close: measured on Klee One, 93 of 95 printable-ASCII
 * glyphs are byte-identical between Regular and SemiBold, and the widest difference is 3.9% on `F`.
 */
export function widestOf(faces: readonly FontMetrics[]): FontMetrics {
  if (faces.length === 0) throw new Error('widestOf needs at least one face');
  const unitsPerEm = faces[0]!.unitsPerEm;
  // ⚠️ Refused rather than silently preferred: a differing em would make the faces' `widthEm`
  // results incomparable, and `em` is already normalised, so a mismatch means the caller has
  // handed us two unrelated families rather than two weights of one.
  for (const f of faces) {
    if (f.unitsPerEm !== unitsPerEm) {
      throw new Error(`widestOf: faces disagree on unitsPerEm (${unitsPerEm} vs ${f.unitsPerEm}) `
        + '— these are not two weights of one family');
    }
  }
  return {
    unitsPerEm,
    widthEm(text: string): TextWidth {
      let bestEm = -Infinity;
      // ⚠️ The UNION, not the widest face's list. Reporting only the widest face's `missing` would
      // call a character present when one face has no glyph for it — and the caller's next move is
      // usually to render in whichever face its `fontWeight` selects, which may be that one.
      const missing = new Set<string>();
      for (const f of faces) {
        const w = f.widthEm(text);
        if (w.em > bestEm) bestEm = w.em;
        for (const ch of w.missing) missing.add(ch);
      }
      return { em: bestEm, missing: [...missing] };
    },
  };
}
