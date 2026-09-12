/**
 * `testing/authoredTextBudget` — the resolver's own edges, on synthetic scenes (#1119).
 *
 * The shipping behaviour is covered by the games that use it
 * (`games/wordweave/tests/authoredLabelBudget.test.ts`). What CANNOT be covered there is the set of
 * malformed and degenerate inputs no real scene contains — which is exactly where a resolver that
 * returns a confident wrong number does the most damage, because every caller reads a non-`null`
 * answer as authoritative.
 *
 * ⚠️ **The cycle cases are the reason this file exists.** An earlier cut of the resolver relied on
 * a depth cap alone and its comment claimed *"returning `null` beats hanging the test run"*. It did
 * the opposite: the parent chain was walked TWICE per level, so the cost was `2^depth`, and a
 * two-entity `parentId` cycle at the shipped cap of 64 ran past two minutes before being killed. A
 * scene that acquired a parent cycle — a bad reparent, a hand-edited JSON, a merge artifact — would
 * have HUNG `npm run verify` forever instead of failing it, on precisely the input the cap was
 * written for. Found by close-out review, 2026-09-12.
 */

import { describe, expect, it } from 'vitest';
import {
  indexScene, resolveBoxWidthPx, resolveContentWidthPx, measureTextFitInOwnBox,
  type AuthoredEntity, type BudgetContext, type Viewport,
} from '../../packages/modoki/tests/helpers/authoredTextBudget';

const VP: Viewport = { name: 'test', w: 375, h: 667 };

/** A scene entity, in the shape `indexScene` reads. */
const ent = (
  name: string, ui: Record<string, unknown>, parentId?: string,
): AuthoredEntity => ({
  traits: {
    EntityAttributes: { name, guid: `g-${name}`, ...(parentId ? { parentId } : {}) },
    UIElement: ui,
  },
});

/**
 * ⚠️ **No wall-clock assertions in here, deliberately.** Two `Date.now() - started < 1000` bounds
 * lived in these cases and could not fail on any single regression (deleting `seen` costs ~65
 * lookups, i.e. ~0 ms; reverting linearity alone stops a cycle at depth 2) — and if BOTH regressed
 * they would HANG rather than fail, which is the exact shape the 16-level rewrite below removed as
 * perverse. They were also load-sensitive. Cost is asserted by counting parent lookups instead.
 */
describe('a parentId CYCLE terminates instead of hanging (#1119 close-out)', () => {
  /** Two entities whose parents are each other, both with a definite px width. */
  const pxCycle = () => indexScene([
    ent('A', { width: 100, widthUnit: 'px' }, 'g-B'),
    ent('B', { width: 100, widthUnit: 'px' }, 'g-A'),
  ]);

  it('resolves a px width, and survives the cycle it DOES walk', () => {
    const idx = pxCycle();
    // ⚠️ The cycle IS entered — `boxWidthOf` resolves `containing` before `boxWidthFrom` looks at
    // the unit, so the walk runs even for a px width that will not use the answer. (An earlier
    // version of this case was NAMED "without walking the cycle at all", which is what CI output
    // and `vitest -t` carry, so the name went on asserting the falsehood after the comment was
    // fixed.) `seen` is what saves it; the COST is asserted by the counting case below, not here.
    expect(resolveBoxWidthPx(idx.byName.get('A')!, idx, VP)).toBe(100);
    expect(resolveContentWidthPx(idx.byName.get('A')!, idx, VP)).toBe(100);
  });

  it('returns null for a % width whose containing block is inside the cycle', () => {
    const idx = indexScene([
      ent('P', { width: 50, widthUnit: '%' }, 'g-Q'),
      ent('Q', { width: 50, widthUnit: '%' }, 'g-P'),
    ]);
    expect(resolveBoxWidthPx(idx.byName.get('P')!, idx, VP)).toBeNull();
    expect(resolveContentWidthPx(idx.byName.get('P')!, idx, VP)).toBeNull();
  });

  it('returns null for a self-parented entity', () => {
    const idx = indexScene([ent('S', { width: 50, widthUnit: '%' }, 'g-S')]);
    expect(resolveBoxWidthPx(idx.byName.get('S')!, idx, VP)).toBeNull();
  });

  /**
   * ⚠️ **This is the case that actually pins `seen`, and without it that guard has ZERO coverage.**
   * Close-out review measured it: delete the `seen.has(parent)` line and every other case in this
   * file still passes, because once the walk is linear the depth cap alone terminates. The two
   * halves of the fix are individually redundant against a pass/fail assertion — only the COST
   * separates them. So assert the cost: a two-entity cycle must resolve in a couple of parent
   * lookups, not the ~65 the cap would allow.
   *
   * It pins the `MAX_DEPTH` docblock's "linear, not exponential" claim as a measurement rather
   * than prose, which is the other thing prose could not do.
   */
  it('walks a cycle a BOUNDED number of times, not MAX_DEPTH times', () => {
    const a = ent('A', { width: 100, widthUnit: 'px' }, 'g-B');
    const b = ent('B', { width: 100, widthUnit: 'px' }, 'g-A');
    const base = indexScene([a, b]);
    let lookups = 0;
    const counting = {
      ...base,
      byGuid: {
        get: (k: string) => { lookups++; return base.byGuid.get(k); },
        has: (k: string) => base.byGuid.has(k),
      } as unknown as typeof base.byGuid,
    };
    resolveContentWidthPx(a, counting, VP);
    // With `seen`: the parent is looked up, recognised as already on the path, and the walk stops.
    // Without it: the walk runs to MAX_DEPTH (65+ lookups).
    expect(lookups, `a cyclic chain cost ${lookups} parent lookups — the seen-set guard is not `
      + 'stopping it, and only the depth cap is').toBeLessThan(8);
  });

  it('walks an acyclic chain ONCE per level, not twice', () => {
    const chain: AuthoredEntity[] = [ent('C0', { width: 200, widthUnit: 'px' })];
    for (let i = 1; i <= 10; i++) chain.push(ent(`C${i}`, { width: 100 }, `g-C${i - 1}`));
    const base = indexScene(chain);
    let lookups = 0;
    const counting = {
      ...base,
      byGuid: {
        get: (k: string) => { lookups++; return base.byGuid.get(k); },
        has: (k: string) => base.byGuid.has(k),
      } as unknown as typeof base.byGuid,
    };
    resolveContentWidthPx(base.byName.get('C10')!, counting, VP);
    // Ten levels, resolved once each. The pre-fix walk resolved each level's containing width
    // twice, which is 2^depth, not 2*depth.
    expect(lookups, `a 10-level chain cost ${lookups} parent lookups; linear is ~10`)
      .toBeLessThanOrEqual(12);
  });

  /**
   * ⚠️ **16 levels, and the depth is chosen deliberately — a DEEPER chain here makes a linearity
   * regression HANG instead of fail.** The first version used 40, and reverting the linearity fix
   * (while keeping `seen`) made this case run past 90 s rather than go red: `2^40` lookups. A
   * regression that converts a failure into a hang is the exact shape the `MAX_DEPTH` docblock was
   * rewritten to eliminate, so reproducing it in the test that guards it would be perverse. At 16,
   * a regressed walk costs ~65k lookups — instant, and caught by the counting cases above.
   */
  it('still resolves a deep but acyclic chain', () => {
    const chain: AuthoredEntity[] = [ent('L0', { width: 100, widthUnit: 'px' })];
    for (let i = 1; i < 16; i++) chain.push(ent(`L${i}`, { width: 100 }, `g-L${i - 1}`));
    const idx = indexScene(chain);
    expect(resolveBoxWidthPx(idx.byName.get('L15')!, idx, VP)).toBeCloseTo(100, 6);
  });
});

describe('the resolver says "cannot tell" rather than guessing', () => {
  /**
   * ⚠️ **A ROW parent, because in a COLUMN a widthless child is not content-sized — it stretches.**
   * The first version of this case used a column and asserted `null`; it failed, correctly, and the
   * expectation was the thing that was wrong. That is the whole distinction the stretch rule in
   * `boxWidthFrom` exists to make, so asserting it here the wrong way round would have been a test
   * defending the bug it was meant to exclude.
   */
  it('returns null for a genuinely content-sized width (a row child)', () => {
    const idx = indexScene([
      ent('Row', { width: 100, flexDirection: 'row' }),
      ent('Auto', {}, 'g-Row'),
    ]);
    expect(resolveBoxWidthPx(idx.byName.get('Auto')!, idx, VP)).toBeNull();
  });

  it('returns null for a % width off a DANGLING parentId, but resolves a px one', () => {
    const pct = indexScene([ent('Orphan', { width: 50, widthUnit: '%' }, 'g-nobody')]);
    expect(resolveBoxWidthPx(pct.byName.get('Orphan')!, pct, VP)).toBeNull();
    // A px width does not consult the containing block, so a dangling parent is irrelevant to it.
    const px = indexScene([ent('OrphanPx', { width: 100, widthUnit: 'px' }, 'g-nobody')]);
    expect(resolveBoxWidthPx(px.byName.get('OrphanPx')!, px, VP)).toBe(100);
  });

  it('treats a root as resolving against the viewport', () => {
    const idx = indexScene([ent('Root', { width: 100 })]);
    expect(resolveBoxWidthPx(idx.byName.get('Root')!, idx, VP)).toBe(375);
  });
});

describe('the CSS rules the resolver has to model exactly', () => {
  it('lets minWidth win over a smaller maxWidth, as CSS does', () => {
    const idx = indexScene([ent('Clamped', {
      width: 100, widthUnit: 'px', maxWidth: 50, minWidth: 200,
    })]);
    expect(resolveBoxWidthPx(idx.byName.get('Clamped')!, idx, VP)).toBe(200);
  });

  it('caps a width at maxWidth', () => {
    const idx = indexScene([ent('Capped', { width: 100, maxWidth: 200 })]);
    // 100% of 375 = 375, capped at 200.
    expect(resolveBoxWidthPx(idx.byName.get('Capped')!, idx, VP)).toBe(200);
  });

  it('subtracts padding and BOTH borders from the content box', () => {
    const idx = indexScene([ent('Box', {
      width: 200, widthUnit: 'px',
      paddingLeft: 10, paddingLeftUnit: 'px', paddingRight: 15, paddingRightUnit: 'px',
      borderWidth: 2,
    })]);
    expect(resolveContentWidthPx(idx.byName.get('Box')!, idx, VP)).toBe(200 - 10 - 15 - 4);
  });

  /**
   * ⚠️ A `%` padding resolves against the CONTAINING BLOCK's width, never the element's own —
   * `uiLength.ts` records two Court guards shipping that backwards.
   */
  it('resolves a % padding against the parent, not against itself', () => {
    const idx = indexScene([
      ent('Parent', { width: 300, widthUnit: 'px' }),
      // 10% padding each side: 10% of the PARENT's 300 = 30, not 10% of its own 100.
      ent('Child', { width: 100, widthUnit: 'px', paddingLeft: 10, paddingRight: 10 }, 'g-Parent'),
    ]);
    expect(resolveContentWidthPx(idx.byName.get('Child')!, idx, VP)).toBe(100 - 60);
  });

  it('never returns a negative content width', () => {
    const idx = indexScene([ent('Tiny', {
      width: 10, widthUnit: 'px', paddingLeft: 50, paddingLeftUnit: 'px',
    })]);
    expect(resolveContentWidthPx(idx.byName.get('Tiny')!, idx, VP)).toBe(0);
  });

  /**
   * A child of a COLUMN with `alignItems: stretch` (the engine default) fills its parent's content
   * width even with no authored width — `width: 0` is auto, and auto is not content-sized on the
   * CROSS axis. Reading it as content-sized made wordweave's three Settings rows unbudgetable.
   */
  it('stretches a widthless child across a column parent', () => {
    const idx = indexScene([
      ent('Col', { width: 200, widthUnit: 'px' }),
      ent('Kid', {}, 'g-Col'),
    ]);
    expect(resolveBoxWidthPx(idx.byName.get('Kid')!, idx, VP)).toBe(200);
  });

  it('does NOT stretch it across a ROW parent — there it is content-sized', () => {
    const idx = indexScene([
      ent('Row', { width: 200, widthUnit: 'px', flexDirection: 'row' }),
      ent('Kid', {}, 'g-Row'),
    ]);
    expect(resolveBoxWidthPx(idx.byName.get('Kid')!, idx, VP)).toBeNull();
  });

  it('does NOT stretch it when the parent overrides alignItems', () => {
    const idx = indexScene([
      ent('Col', { width: 200, widthUnit: 'px', alignItems: 'center' }),
      ent('Kid', {}, 'g-Col'),
    ]);
    expect(resolveBoxWidthPx(idx.byName.get('Kid')!, idx, VP)).toBeNull();
  });
});

describe('indexScene', () => {
  it('keeps the FIRST entity of a duplicated name, so it agrees with other guards', () => {
    const idx = indexScene([
      ent('Dup', { width: 111, widthUnit: 'px' }),
      { traits: { EntityAttributes: { name: 'Dup', guid: 'g-Dup2' }, UIElement: { width: 222, widthUnit: 'px' } } },
    ]);
    expect(resolveBoxWidthPx(idx.byName.get('Dup')!, idx, VP)).toBe(111);
  });

  it('indexes children by their parent guid', () => {
    const idx = indexScene([ent('P', { width: 100 }), ent('C1', {}, 'g-P'), ent('C2', {}, 'g-P')]);
    expect(idx.childrenOf.get('g-P')).toHaveLength(2);
  });
});

/**
 * `measureTextFitInOwnBox` reports a box only when the AUTHORED width is the used one.
 *
 * ⚠️ **Pinned here rather than in a game suite, because a game suite cannot see it.** The
 * wordweave guard's skip-set assertion looks sensitive and is not: none of its box cases is a
 * column child with a non-zero grow/shrink, so deleting the row-direction check below left that
 * suite fully green. The axis distinction is only observable on inputs no real scene contains —
 * which is what this file is for.
 */
describe('the own-box budget refuses a width flex can resize', () => {
  /** 1 em per character, so `requiredPx` is trivially predictable. */
  const FONT = {
    unitsPerEm: 1000,
    widthEm: (t: string) => ({ em: [...t].length, missing: [] as string[] }),
  };
  const ctxFor = (entities: readonly AuthoredEntity[]): BudgetContext => ({
    idx: indexScene(entities), font: FONT, textOf: () => undefined,
  });

  it('reports the box for a definite width in a ROW (grow 0, shrink 0)', () => {
    const row = ent('Row', { width: 300, widthUnit: 'px', flexDirection: 'row' });
    const kid = ent('Kid', {
      width: 88, widthUnit: 'px', flexGrow: 0, flexShrink: 0, fontSize: 10,
    }, 'g-Row');
    const ctx = ctxFor([row, kid]);
    const fit = measureTextFitInOwnBox(kid, 'ab', ctx, VP);
    expect(fit).not.toBeNull();
    expect(fit!.availablePx).toBe(88);
    expect(fit!.requiredPx).toBe(20);          // 2 chars x 1 em x 10 px
  });

  it('refuses it when the item can GROW on the row main axis', () => {
    const row = ent('Row', { width: 300, widthUnit: 'px', flexDirection: 'row' });
    const kid = ent('Kid', { width: 88, widthUnit: 'px', flexGrow: 1, fontSize: 10 }, 'g-Row');
    expect(measureTextFitInOwnBox(kid, 'ab', ctxFor([row, kid]), VP)).toBeNull();
  });

  it('refuses it when the item can SHRINK on the row main axis', () => {
    const row = ent('Row', { width: 300, widthUnit: 'px', flexDirection: 'row' });
    // `flexShrink` defaults to 1, so authoring nothing is the shrinkable case — and it is the
    // COMMON one, which is why the guard must not treat an absent field as "cannot move".
    const kid = ent('Kid', { width: 88, widthUnit: 'px', fontSize: 10 }, 'g-Row');
    expect(measureTextFitInOwnBox(kid, 'ab', ctxFor([row, kid]), VP)).toBeNull();
  });

  /**
   * ⚠️ **The axis check, and the only case that pins it.** In a COLUMN, width is the CROSS axis —
   * `flexGrow`/`flexShrink` act on height and cannot touch the authored width, so the box is
   * knowable even for a growable item. Dropping the `flexDirection === 'row'` test would skip this
   * label and silently stop budgeting it.
   */
  it('still reports the box for a GROWABLE item in a COLUMN, where width is the cross axis', () => {
    const col = ent('Col', { width: 300, widthUnit: 'px' });
    const kid = ent('Kid', {
      width: 88, widthUnit: 'px', flexGrow: 1, flexShrink: 1, fontSize: 10,
    }, 'g-Col');
    const fit = measureTextFitInOwnBox(kid, 'ab', ctxFor([col, kid]), VP);
    expect(fit, 'width is the CROSS axis in a column — flex cannot resize it').not.toBeNull();
    expect(fit!.availablePx).toBe(88);
  });

  it('subtracts the element own padding from the box the text gets', () => {
    const col = ent('Col', { width: 300, widthUnit: 'px' });
    const kid = ent('Kid', {
      width: 88, widthUnit: 'px', flexShrink: 0,
      paddingLeft: 10, paddingLeftUnit: 'px', paddingRight: 10, paddingRightUnit: 'px', fontSize: 10,
    }, 'g-Col');
    expect(measureTextFitInOwnBox(kid, 'ab', ctxFor([col, kid]), VP)!.availablePx).toBe(68);
  });
});
