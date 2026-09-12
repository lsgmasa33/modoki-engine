/** `solveBands` — the shared vertical band solver (#800).
 *
 *  Extracted from two independent, arithmetically identical copies (wordweave's `runtime/screen.ts`
 *  #773, court's `runtime/layout.ts` #791). Both games keep a `tests/screenBands.test.ts` of their
 *  own proving their SCENE is read rather than their fallback silently returned; this file covers
 *  the arithmetic itself, which neither game's suite can isolate.
 *
 *  ⚠️ Every case below names the mutation it is meant to catch, because that is the only thing that
 *  makes it a test rather than a restatement — the shipped band values in both games are numerically
 *  identical to their fallbacks, which is exactly how a solver bug hides. */

import { describe, expect, it } from 'vitest';

import { solveBands, type Band } from '../../src/runtime/core/screenBands';

type Role = 'top' | 'mid' | 'bottom';

const band = (role: Role, order: number, minHeight: number, flex: number): Band<Role> =>
  ({ role, order, minHeight, flex });

describe('solveBands — floors first, then flex', () => {
  it('pays every minHeight before sharing anything out', () => {
    // MUTATION: drop the `floorOf(b) +` term (pay flex only) — `top` and `bottom` collapse to 0.
    const solved = solveBands(
      [band('top', 0, 100, 0), band('mid', 1, 0, 1), band('bottom', 2, 50, 0)],
      { designH: 1000, reserve: 0 },
    );
    expect(solved.byRole.top?.h).toBeCloseTo(100, 6);
    expect(solved.byRole.bottom?.h).toBeCloseTo(50, 6);
    // Everything left over goes to the only flexed band.
    expect(solved.byRole.mid?.h).toBeCloseTo(850, 6);
  });

  it('splits the leftover in proportion to flex, not equally', () => {
    // MUTATION: divide the leftover by the band COUNT instead of weighting it — both become 400.
    const solved = solveBands(
      [band('top', 0, 0, 3), band('mid', 1, 0, 1)],
      { designH: 800, reserve: 0 },
    );
    expect(solved.byRole.top?.h).toBeCloseTo(600, 6);
    expect(solved.byRole.mid?.h).toBeCloseTo(200, 6);
  });

  it('stacks by ORDER, not by array position', () => {
    // MUTATION: delete the `.sort(...)` — the y offsets follow the (deliberately scrambled) input.
    const solved = solveBands(
      [band('bottom', 2, 100, 0), band('top', 0, 100, 0), band('mid', 1, 100, 0)],
      { designH: 1000, reserve: 0 },
    );
    expect(solved.byRole.top?.y).toBeCloseTo(0, 6);
    expect(solved.byRole.mid?.y).toBeCloseTo(100, 6);
    expect(solved.byRole.bottom?.y).toBeCloseTo(200, 6);
    expect(solved.bands.map((b) => b.role)).toEqual(['top', 'mid', 'bottom']);
  });

  it('a band starts where the previous one ends', () => {
    // MUTATION: reset `y` per band (or accumulate the floor rather than the solved height) — the
    // flexed band's successor then overlaps it.
    const solved = solveBands(
      [band('top', 0, 40, 0), band('mid', 1, 0, 1), band('bottom', 2, 60, 0)],
      { designH: 500, reserve: 0 },
    );
    const [a, b, c] = solved.bands;
    expect(a.y + a.h).toBeCloseTo(b.y, 6);
    expect(b.y + b.h).toBeCloseTo(c.y, 6);
    expect(c.y + c.h).toBeCloseTo(500, 6);
  });
});

describe('solveBands — the reserve is NOT a band', () => {
  it('comes out of the height before any band is paid', () => {
    // MUTATION: subtract `reserve` AFTER the floors are paid (or treat it as a band with a floor) —
    // the rigid bands would start losing height to it.
    const solved = solveBands(
      [band('top', 0, 100, 0), band('mid', 1, 0, 1)],
      { designH: 1000, reserve: 150 },
    );
    expect(solved.byRole.top?.h, 'a rigid band must not pay for the reserve').toBeCloseTo(100, 6);
    expect(solved.byRole.mid?.h).toBeCloseTo(750, 6);
  });

  it('the flexed band absorbs the reserve 1:1, and the rigid ones do not move', () => {
    // The whole POINT of the band model: which area absorbs a per-device reserve is an authored
    // decision. MUTATION: spread the reserve across every band pro rata.
    const stack = [band('top', 0, 100, 0), band('mid', 1, 0, 1), band('bottom', 2, 80, 0)];
    const none = solveBands(stack, { designH: 1000, reserve: 0 });
    const some = solveBands(stack, { designH: 1000, reserve: 175 });
    expect(some.byRole.top?.h).toBeCloseTo(none.byRole.top!.h, 6);
    expect(some.byRole.bottom?.h).toBeCloseTo(none.byRole.bottom!.h, 6);
    expect(none.byRole.mid!.h - some.byRole.mid!.h).toBeCloseTo(175, 6);
  });
});

describe('solveBands — the clamps', () => {
  it('floors exceeding the budget collapse the flex to zero rather than going negative', () => {
    // MUTATION: remove the `Math.max(0, available - floors)` clamp — `leftover` goes negative and
    // the flexed band is handed a NEGATIVE height.
    const solved = solveBands(
      [band('top', 0, 700, 0), band('mid', 1, 0, 1), band('bottom', 2, 700, 0)],
      { designH: 1000, reserve: 0 },
    );
    expect(solved.byRole.mid?.h).toBeCloseTo(0, 6);
    expect(solved.byRole.top?.h).toBeCloseTo(700, 6);
  });

  it('a reserve larger than the design height leaves nothing to share, not a negative', () => {
    // MUTATION: remove the `Math.max(0, designH - reserve)` clamp.
    const solved = solveBands([band('mid', 0, 0, 1)], { designH: 400, reserve: 900 });
    expect(solved.byRole.mid?.h).toBeCloseTo(0, 6);
  });

  it('a negative authored minHeight or flex is clamped, not allowed to steal height', () => {
    // MUTATION: drop either `Math.max(0, ...)` in `floorOf`/`weightOf`. A negative floor would
    // ADD height to the leftover pool; a negative weight would hand a band a negative share.
    const solved = solveBands(
      [band('top', 0, -100, 0), band('mid', 1, 0, 1)],
      { designH: 600, reserve: 0 },
    );
    expect(solved.byRole.top?.h).toBeCloseTo(0, 6);
    expect(solved.byRole.mid?.h, 'the leftover must be 600, not 700').toBeCloseTo(600, 6);
  });

  it('with no flex anywhere, the leftover is simply unallocated', () => {
    // MUTATION: divide by `flexTotal` unguarded — every height becomes NaN.
    const solved = solveBands(
      [band('top', 0, 100, 0), band('mid', 1, 200, 0)],
      { designH: 1000, reserve: 0 },
    );
    expect(solved.byRole.top?.h).toBeCloseTo(100, 6);
    expect(solved.byRole.mid?.h).toBeCloseTo(200, 6);
    expect(Number.isNaN(solved.byRole.mid!.h)).toBe(false);
  });
});

describe('solveBands — byRole', () => {
  it('omits a role nothing authored rather than inventing a zero-height rect', () => {
    // MUTATION: pre-fill `byRole` with zero rects for every known role. A caller that lays out
    // against a silent zero is exactly what the absent entry is there to prevent.
    const solved = solveBands([band('top', 0, 10, 0)], { designH: 100, reserve: 0 });
    expect(solved.byRole.top).toBeDefined();
    expect(solved.byRole.mid, 'an unauthored role must be ABSENT, not zero-height').toBeUndefined();
  });

  it('keeps the FIRST of a duplicated role', () => {
    // MUTATION: let the later one overwrite. (The reader drops duplicates before they reach here;
    // this pins the direct-caller behaviour the reader's own comment relies on.)
    const solved = solveBands(
      [band('top', 0, 10, 0), band('top', 1, 999, 0)],
      { designH: 1000, reserve: 0 },
    );
    expect(solved.byRole.top?.h).toBeCloseTo(10, 6);
    expect(solved.bands, 'both still occupy space — which is why the reader refuses them')
      .toHaveLength(2);
  });
});
