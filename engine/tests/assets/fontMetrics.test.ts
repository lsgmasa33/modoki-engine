/**
 * `testing/fontMetrics` reads real glyph advances out of a shipped font (#1119) — and this is what
 * stops it rotting silently.
 *
 * ⚠️ **The load-bearing case is the CROSS-CHECK against an independently derived figure.** Every
 * other assertion here would survive a parser that returned plausible-looking nonsense: a
 * structural test proves the code runs, not that the numbers mean anything.
 * `games/wordweave/tests/corpus.test.ts` § "#1080" carries a table of em-per-char figures measured
 * for the HUD's own strings — derived separately, by a different reader, and cross-checked there
 * against a live Chromium measurement. If this parser reproduces those to four decimal places it is
 * reading the same `hmtx`/`unitsPerEm` table the browser lays text out from, which is the entire
 * claim `fontMetrics.ts`'s header makes.
 *
 * ⚠️ **Arimo, not Klee One, and deliberately.** The strings and expectations below are Arimo's row
 * of that table, because Arimo is the ENGINE's own bundled font — an engine test reaching into
 * `games/wordweave/runtime/assets/` would couple the engine suite to a game, which
 * `gamePortability.test.ts` exists to prevent in the other direction. Klee One's half of the same
 * cross-check lives in wordweave's own suite.
 */

import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFontMetrics, widestOf } from '../../packages/modoki/tests/helpers/fontMetrics';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARIMO = join(
  HERE, '../../packages/modoki/src/runtime/assets/fonts/Arimo/Arimo-VariableFont_wght.ttf',
);

describe('fontMetrics reproduces independently measured advances (#1119)', () => {
  const font = readFontMetrics(ARIMO);

  it('reads Arimo as a 2048-unit em, and normalises against it', () => {
    // ⚠️ Worth pinning because it is NOT the common case in this repo: Klee One, the font the
    // wordweave budget actually measures, is 1000. The cross-check below passing at 2048 is what
    // shows the em normalisation is real rather than a 1000-unit coincidence.
    expect(font.unitsPerEm).toBe(2048);
  });

  /**
   * The two HUD strings and Arimo's measured em-per-char, from `corpus.test.ts` § "#1080".
   *
   * ⚠️ **These are WEIGHTED figures over real strings, never a flat charset average.** That file
   * records an earlier note getting the sign of a font comparison backwards by averaging the
   * alphabet: uppercase, digits and punctuation move in opposite directions, and the HUD is dense
   * in the ones a plain mean hides. Re-deriving these by any other weighting will not match.
   */
  it.each([
    ['LEVEL 3030/30 WORDS12/12 EXTRA', 0.5744],
    ['LEVEL 100100/100 WORDS100/100 EXTRA', 0.5718],
  ])('%s measures at the em-per-char corpus.test.ts recorded', (text, expected) => {
    const { em, missing } = font.widthEm(text);
    expect(missing, 'Arimo should cover every character in a HUD string').toEqual([]);
    expect(em / text.length).toBeCloseTo(expected, 4);
  });

  /**
   * ⚠️ **A missing glyph is NOT free, and the first version of this case was titled as though it
   * were** ("…and does not count them as width"), which licensed exactly the wrong belief. The
   * cmap returns glyph 0 — `.notdef` — and `.notdef` has a real advance: measured, Arimo goes
   * 1.3340 em for `AB` to 2.0840 em for `A<U+10FFFF>B` (+0.75 em), and Klee One 1.34 to 2.34 (+1.0).
   *
   * Harmless downstream only because every consumer asserts `missingGlyphs` is empty BEFORE it
   * trusts the width — so the contract is "the list tells you the number is meaningless", not "the
   * number is unaffected".
   */
  it('reports characters the font has no glyph for, and charges .notdef for them', () => {
    // U+10FFFF is the last valid code point and is unassigned — no font carries it.
    const probe = font.widthEm(`A\u{10FFFF}B`);
    expect(probe.missing).toEqual(['\u{10FFFF}']);
    expect(probe.em, 'a missing glyph must NOT be silently 0-wide — it is .notdef, which advances')
      .toBeGreaterThan(font.widthEm('AB').em);
  });

  it('measures a space, which maps to a real advance rather than a missing glyph', () => {
    expect(font.widthEm(' ').em).toBeGreaterThan(0);
    expect(font.widthEm(' ').missing).toEqual([]);
  });

  it('is additive over concatenation, since it applies no kerning', () => {
    const a = font.widthEm('AV').em;
    const b = font.widthEm('A').em + font.widthEm('V').em;
    // `AV` is the classic kerning pair — an implementation that started applying GPOS would make
    // these diverge, and the file header's "upper bound" claim would stop holding.
    expect(a).toBeCloseTo(b, 10);
  });

  it('rejects a file that is not an sfnt rather than returning nonsense', () => {
    expect(() => readFontMetrics(join(HERE, 'fontMetrics.test.ts'))).toThrow();
  });
});

describe('widestOf', () => {
  const font = readFontMetrics(ARIMO);

  it('takes the widest measurement across the faces it is given', () => {
    const narrow = { unitsPerEm: 1000, widthEm: () => ({ em: 1, missing: [] }) };
    const wide = { unitsPerEm: 1000, widthEm: () => ({ em: 9, missing: [] }) };
    expect(widestOf([narrow, wide]).widthEm('x').em).toBe(9);
    expect(widestOf([wide, narrow]).widthEm('x').em).toBe(9);
  });

  it('is a no-op on a single face', () => {
    expect(widestOf([font]).widthEm('Hello').em).toBeCloseTo(font.widthEm('Hello').em, 10);
  });

  it('refuses an empty face list rather than reporting a zero width', () => {
    expect(() => widestOf([])).toThrow();
  });

  it('refuses faces that disagree on unitsPerEm — they are not one family', () => {
    const a = { unitsPerEm: 1000, widthEm: () => ({ em: 1, missing: [] }) };
    const b = { unitsPerEm: 2048, widthEm: () => ({ em: 1, missing: [] }) };
    expect(() => widestOf([a, b])).toThrow(/unitsPerEm/);
  });

  it('unions the missing-glyph lists instead of reporting only the widest face\'s', () => {
    // The WIDER face covers the character; the narrower one does not. Reporting only the widest
    // face's list would call it present, and the caller may well render in the narrow face.
    const wideCovers = { unitsPerEm: 1000, widthEm: () => ({ em: 9, missing: [] as string[] }) };
    const narrowLacks = { unitsPerEm: 1000, widthEm: () => ({ em: 1, missing: ['z'] }) };
    const m = widestOf([wideCovers, narrowLacks]).widthEm('z');
    expect(m.em).toBe(9);
    expect(m.missing).toEqual(['z']);
  });
});
