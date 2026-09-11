/** #1064 — no hand-written copy of the viewport-unit vocabulary in engine source.
 *
 *  The UI length units used to be a TYPE with no runtime list, so every emitter that needed one wrote
 *  its own: two switch readers, a CSS-var table, the drag inverse, the `--ui-*` publisher, a relative
 *  set, 22 trait enums and a dropdown. A docblock told the next author which five to update when a
 *  unit was added — and it left out the publisher, the one copy every CSS reader silently depends on.
 *
 *  They now all derive from `runtime/traits/uiLength.ts` (`UI_LENGTH_UNITS`, `VIEWPORT_UNIT_AXIS`,
 *  `viewportUnitVar`). The compile-time half keeps THAT module total; this is the half that keeps
 *  everyone else reading it. Two spellings of a new copy are flagged anywhere else in engine source:
 *  - a quoted `'vw'`/`'vh'`/`'vmin'`/`'vmax'` — a `case 'vmin':`, an `['vw', 'vh', …]`, a string key;
 *  - a literal CSS var NAME, `--ui-vw`/`--ui-vh`/`--ui-vmin`/`--ui-vmax` — the spelling the two copies
 *    #1064 was actually filed about used: the old publisher's `'--ui-vw': …` keys and anchorCss's
 *    `{ vw: '--ui-vw', … }` table. #1064's close-out review restored both files verbatim and every
 *    test stayed green under the first pattern alone, so the second is not optional.
 *
 *  Measured when this landed: ZERO of either outside `uiLength.ts` (comments excluded), so there is
 *  no allowlist.
 *
 *  ⚠️ **What it deliberately does NOT reach**, so green is not read as more than it is:
 *  - `px` and `%` — they are ordinary CSS and appear legitimately everywhere (`'100%'`, `${n}px`);
 *    the viewport units are the part of the vocabulary with no other meaning in this codebase;
 *  - an unquoted object key (`{ vmin: 1 }`) — though a table keyed that way still holds values the
 *    var-name pattern sees — and a template-built name (`` `--ui-${u}` ``), which is exactly how the
 *    sanctioned readers spell it;
 *  - tests (they assert on unit strings by design) and `games/`/`demos/` (a game may resolve units
 *    itself — Court's `UNIT_PX` is a `Record<UILengthUnit, number>`, total by type);
 *  - comments, which are stripped: prose naming a unit is not a copy. */

import { describe, it, expect } from 'vitest';
import { readScannedSource } from '@modoki/engine/testing';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

/** A quoted viewport-unit literal: the same quote on both sides, nothing else inside. */
const VIEWPORT_UNIT_LITERAL = /(['"`])(vw|vh|vmin|vmax)\1/;
/** A literal viewport CSS var name — `viewportUnitVar` builds these; nothing else should spell one. */
const VIEWPORT_VAR_LITERAL = /--ui-(vw|vh|vmin|vmax)\b/;
const isCopy = (line: string) => VIEWPORT_UNIT_LITERAL.test(line) || VIEWPORT_VAR_LITERAL.test(line);

/** The one module allowed to spell them. */
const OWNER = 'engine/packages/modoki/src/runtime/traits/uiLength.ts';

describe('the viewport-unit literal pattern itself (#1064)', () => {
  it.each([
    "case 'vmin': return x;",
    "const VIEWPORT_UNITS = ['vw', 'vh', 'vmin', 'vmax'];",
    'options: ["px", "%", "vw"],',
    "const VP_VARS = { 'vmax': '--ui-vmax' };",
    'if (unit === `vh`) return h;',
    // The var-name spelling — the old publisher and anchorCss table, verbatim:
    "'--ui-vw': `${vw}px`,",
    "const VP_VARS: Record<string, string> = { vw: '--ui-vw', vh: '--ui-vh' };",
    'return `calc(${value} * var(--ui-vmin, 1vmin))`;',
  ])('flags %s', (line) => {
    expect(isCopy(line)).toBe(true);
  });

  it.each([
    'const a = `calc(${value} * var(${viewportUnitVar(unit)}, 1${unit}))`;',
    "style.width = '100vw';",
    "const k = 'vwide';",
    'const vmin = Math.min(w, h);',
    "if (unit === '%') return v;",
    'return `--ui-${unit}`;',
    "const name = '--ui-vwide';",
  ])('does not flag %s', (line) => {
    expect(isCopy(line)).toBe(false);
  });
});

describe('no copy of the viewport-unit vocabulary in engine source (#1064)', () => {
  const corpus = repoFiles({
    under: ['engine'],
    match: /\.(ts|tsx|mts|cts|js|mjs|cjs)$/,
    exclude: ['node_modules', 'dist', 'ios', 'android'],
    // Before the test-file filter below, so it is the whole engine tree; the post-filter floor is
    // asserted separately.
    floor: 1500,
  }).filter(({ rel }) => !/(^|\/)tests?\//.test(rel) && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(rel));

  it('scanned the engine source (sanity: not passing vacuously)', () => {
    expect(corpus.length).toBeGreaterThan(800);
    expect(corpus.some(({ rel }) => rel === OWNER), 'the owner module moved — repoint OWNER').toBe(true);
  });

  it('only runtime/traits/uiLength.ts spells a viewport unit as a string', () => {
    const copies: string[] = [];
    for (const { rel, abs } of corpus) {
      if (rel === OWNER) continue;
      const lines = readScannedSource(abs).code.split('\n');
      lines.forEach((line, i) => {
        if (isCopy(line)) copies.push(`${rel}:${i + 1}  ${line.trim()}`);
      });
    }
    expect(copies, 'derive from UI_LENGTH_UNITS / VIEWPORT_UNIT_AXIS / viewportUnitVar in runtime/traits/uiLength.ts '
      + 'instead of restating the units').toEqual([]);
  });
});
