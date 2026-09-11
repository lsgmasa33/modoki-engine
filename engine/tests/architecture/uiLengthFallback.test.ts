/** #840 — no hand-written UNIT FALLBACK for a UI length in any script under engine/, games/ or demos/.
 *
 *  A `UIElement`/`UIAnchor` length is a number plus a unit, and a scene/prefab save strips a unit equal
 *  to its default — so an absent unit is the ordinary on-disk shape, and what it MEANS is per field:
 *  `%` for `width`/`height`/`padding*`/`margin*`, `px` for `gap`, `min*`/`max*`, `minTapSize`,
 *  `fontSize`, `letterSpacing` and every `UIAnchor` offset. Every reader that wrote its own fallback
 *  (a `|| 'px'` or a `?? '%'` after the unit) was therefore right for some fields and wrong for the
 *  rest — 36 such literals across 8 files when this landed, two of them Court guards computing a `%`
 *  padding as pixels.
 *
 *  The table that holds the defaults is `runtime/traits/uiLength.ts`, and the traits take their schema
 *  defaults FROM it. Engine code reads a pair through `readUILength` / `readUIAnchorLength`; game code
 *  through the public `traitFieldOrDefault`. Neither needs a literal fallback, so this guard bans the
 *  shape outright rather than keeping an allowlist of "fallbacks that happen to be right" — a copy is
 *  exactly what the next reader of a different field reuses.
 *
 *  ⚠️ **Why the pattern does not look at the left-hand side.** The first version required it to be a
 *  name ending in `unit`. A mutation check wrote `(bag[key] as string | undefined) ?? 'px'` and it
 *  walked straight past — and dropping the requirement found one more live instance the first census
 *  had missed: the Inspector's generic unit read, `(data[unitKey] as string) || 'px'`. A `??`/`||`
 *  whose right side is a bare length unit is a unit fallback whatever it is attached to; the repo has
 *  no other use of that shape.
 *
 *  ⚠️ **What it still CANNOT see**, so a green run is not read as more than it is:
 *  - the ternary form (`typeof unit === 'string' && unit ? unit : '%'`) and a `switch` `default:` arm;
 *  - a fallback through a named constant or a helper (`unit ?? PX`, `unit ?? defaultUnit()`);
 *  - reading a length's NUMBER and ignoring its unit altogether, which is the defect's other half and
 *    which no grep can see (Court's `tapZoneClearance` read `minTapSize` that way).
 *
 *  Comments are scanned too, deliberately: a comment quoting the old fallback is the copy a reader
 *  pastes. Describe one in words. */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
import { PROJECT_ROOT_DIRS } from '../../scripts/projectRoots.mjs';

/** `??` or `||`, then a quoted bare length unit — whatever is on the left. */
const UNIT_FALLBACK = /(\?\?|\|\|)\s*['"`](px|%|vw|vh|vmin|vmax)['"`]/;

/** This file quotes the shape in its own fixtures below. */
const SELF = 'engine/tests/architecture/uiLengthFallback.test.ts';

describe('the unit-fallback pattern itself (#840)', () => {
  it.each([
    "widthUnit: ui.widthUnit || 'px',",
    "const unit = sizeUnit ?? '%';",
    "const cUnit = c.unit ?? 'px';",
    'topUnit: anc.topUnit||"vh"',
    'switch (unit ?? `vmin`) {',
    // The two shapes the first version of this guard could not see:
    "const unit = (data[unitKey] as string) || 'px';",
    "const unit = (bag[`${field}Unit`] as string | undefined) ?? 'px';",
    "const u = ui.widthUnit; return u || 'vw';",
  ])('flags %s', (line) => {
    expect(UNIT_FALLBACK.test(line)).toBe(true);
  });

  it.each([
    'scale: ui.scale ?? 1,',
    'marginTop: ui.marginTop || 0,',
    "if (unit === 'px') return v;",
    "widthUnit: readUILength(ui, 'width').unit,",
    'fontSize: ui.fontSize || 16,',
    "const g = gapUnit === '%' ? a : b;",
    "traitFieldOrDefault<string>(UIElement, bag, 'paddingLeftUnit')",
    "const label = name ?? 'px-wide';",
  ])('does not flag %s', (line) => {
    expect(UNIT_FALLBACK.test(line)).toBe(false);
  });
});

describe('no hand-written UI length unit fallback in the repo (#840)', () => {
  // Tracked AND untracked-but-not-ignored: a fallback written a minute ago is exactly the one worth
  // catching before it is committed. `games`/`demos` come from the one authored list of project roots.
  const corpus = repoFiles({
    under: ['engine', ...PROJECT_ROOT_DIRS],
    // Scripts of every flavour, not only TypeScript: engine/scripts, engine/tools and engine/plugins are .mjs/.js.
    match: /\.(ts|tsx|mts|cts|js|mjs|cjs)$/,
    exclude: ['node_modules', 'dist', 'ios', 'android'],
    floor: 500,
  });

  it('enumerates the real corpus — including the files this family was found in', () => {
    const rels = new Set(corpus.map((f) => f.rel));
    expect(rels.has('engine/packages/modoki/src/runtime/ui/uiTreeStore.ts'), 'the largest former offender').toBe(true);
    expect(rels.has('engine/packages/modoki/src/editor/panels/Inspector.tsx'), 'the one only the wider pattern found').toBe(true);
    expect(rels.has('engine/packages/modoki/src/runtime/traits/uiLength.ts'), 'the table itself is scanned too').toBe(true);
    expect(rels.has(SELF), 'the self-exclusion below must be excluding something real').toBe(true);
  });

  it('finds no unit fallback literal outside this file', () => {
    const hits: string[] = [];
    for (const { rel, abs } of corpus) {
      if (rel === SELF) continue;
      const lines = fs.readFileSync(abs, 'utf8').split('\n');
      lines.forEach((line, i) => { if (UNIT_FALLBACK.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim()}`); });
    }
    expect(hits, 'read the pair through readUILength/readUIAnchorLength (engine) or traitFieldOrDefault (games) — see runtime/traits/uiLength.ts').toEqual([]);
  });
});
