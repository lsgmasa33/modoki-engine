/** `readScreenBands` — the AUTHORED band stack, read out of a world (#800).
 *
 *  The reader is the half that can fail silently: both shipping games author bands that are
 *  numerically IDENTICAL to their code fallbacks (deliberately — each extraction landed as a
 *  no-op), so a reader that ignored the scene entirely would leave every other test in both games
 *  green. The cases below therefore author values that are DISTINCT from the fallback they are
 *  given, which is the only shape that can tell "read" from "silently fell back".
 *
 *  Each case names the mutation it catches. */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorld } from 'koota';

import { readScreenBands } from '../../src/runtime/ui/readScreenBands';
import { ScreenBand } from '../../src/runtime/traits/ScreenBand';
import type { Band } from '../../src/runtime/core/screenBands';

type Role = 'hud' | 'crossword' | 'gap' | 'board';

const ACCEPT: readonly Role[] = ['hud', 'crossword', 'gap', 'board'];
/** Distinct from every authored value used below, so "returned the fallback" is always visible. */
const FALLBACK: readonly Band<Role>[] = [
  { role: 'hud', order: 0, minHeight: 999, flex: 0 },
  { role: 'crossword', order: 1, minHeight: 999, flex: 0 },
  { role: 'gap', order: 2, minHeight: 999, flex: 0 },
  { role: 'board', order: 3, minHeight: 999, flex: 0 },
];

let world: ReturnType<typeof createWorld>;

beforeEach(() => { world = createWorld(); });

function author(role: string, order: number, minHeight: number, flex: number): void {
  world.spawn(ScreenBand({ role, order, minHeight, flex }));
}

function authorFullStack(): void {
  author('hud', 0, 104, 0);
  author('crossword', 1, 0, 0.48);
  author('gap', 2, 125, 0);
  author('board', 3, 12, 0.52);
}

const read = (opts: Partial<Parameters<typeof readScreenBands<Role>>[1]> = {}) => readScreenBands<Role>(
  world,
  { accept: ACCEPT, require: ACCEPT, fallback: FALLBACK, ...opts },
);

describe('reads the scene rather than silently falling back', () => {
  it('returns the AUTHORED values, provably not the fallback', () => {
    // MUTATION: `return opts.fallback` unconditionally — every minHeight below becomes 999.
    authorFullStack();
    const bands = read();
    expect(bands.map((b) => b.role).sort()).toEqual(['board', 'crossword', 'gap', 'hud']);
    const byRole = Object.fromEntries(bands.map((b) => [b.role, b]));
    expect(byRole.hud.minHeight).toBe(104);
    expect(byRole.gap.minHeight).toBe(125);
    expect(byRole.crossword.flex).toBeCloseTo(0.48, 6);
    expect(byRole.board.flex).toBeCloseTo(0.52, 6);
  });

  it('an empty world takes the fallback, and does NOT warn', () => {
    // The no-scene case: a headless world or a scene predating the authoring surface. MUTATION:
    // warn here too — every such world would then print a warning nobody can act on.
    const warn = vi.fn();
    expect(read({ warn })).toEqual(FALLBACK);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a world whose bands carry only unknown roles is the no-scene case too', () => {
    // MUTATION: treat "some ScreenBand entities exist" as authored — the stack would be refused
    // WITH a warning instead of quietly using the fallback.
    const warn = vi.fn();
    author('nonsense', 0, 10, 0);
    expect(read({ warn })).toEqual(FALLBACK);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('the role vocabulary', () => {
  it('skips a role outside `accept` without disturbing an otherwise complete stack', () => {
    // MUTATION: delete the `accept.includes` check — the junk band joins the stack, consuming a
    // share of the flex total that nothing can ever look up.
    authorFullStack();
    author('typo-role', 9, 500, 5);
    const bands = read();
    expect(bands).toHaveLength(4);
    expect(bands.some((b) => (b.role as string) === 'typo-role')).toBe(false);
  });

  it('drops a duplicated role rather than paying it, and says so', () => {
    // MUTATION: let the duplicate through. It would take a share of `flexTotal`, shrinking every
    // real panel with nothing on screen to explain why.
    const warn = vi.fn();
    authorFullStack();
    author('crossword', 1, 0, 0.48);
    const bands = read({ warn });
    expect(bands).toHaveLength(4);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('same role');
  });
});

describe('`require` is not the same list as `accept`', () => {
  it('refuses the whole stack when a REQUIRED role is missing', () => {
    // MUTATION: return the partial stack instead of the fallback — the missing band lays out as a
    // silently zero-height area, which is the hardest version of this to diagnose.
    const warn = vi.fn();
    author('hud', 0, 104, 0);
    author('crossword', 1, 0, 0.48);
    expect(read({ warn })).toEqual(FALLBACK);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('missing');
  });

  it('accepts a stack missing a role that is accepted but NOT required', () => {
    // This is the case one shared list cannot express: wordweave requires only two of its five
    // roles. MUTATION: use `accept` as the requirement — this stack would be refused.
    const warn = vi.fn();
    author('crossword', 1, 0, 0.48);
    author('board', 3, 12, 0.52);
    const bands = read({ require: ['crossword', 'board'], warn });
    expect(bands).toHaveLength(2);
    expect(bands.map((b) => b.role).sort()).toEqual(['board', 'crossword']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('reports a duplicate AND a missing role in ONE message', () => {
    // MUTATION: warn on the first problem only. A caller latches this once per world, so the
    // second problem would never be named — pointing the reader at the wrong fix.
    const warn = vi.fn();
    author('crossword', 1, 0, 0.48);
    author('crossword', 1, 0, 0.48);
    read({ warn });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('same role');
    expect(warn.mock.calls[0][0]).toContain('missing');
  });

  it('never warns about a clean stack', () => {
    // The accept side of the warning — a guard that fires on healthy input trains its reader to
    // ignore it. MUTATION: warn unconditionally.
    const warn = vi.fn();
    authorFullStack();
    read({ warn });
    expect(warn).not.toHaveBeenCalled();
  });

  it('is safe with no `warn` supplied at all', () => {
    // MUTATION: call `opts.warn(...)` unguarded — a caller that does not pass one would throw on
    // exactly the malformed scene it was trying to report.
    author('crossword', 1, 0, 0.48);
    expect(() => read({ warn: undefined })).not.toThrow();
  });
});

describe('`order` is READ, never derived from the role vocabulary', () => {
  it('keeps an authored order that the role\'s position in `accept` would not produce', () => {
    // MUTATION: derive `order` from `opts.accept.indexOf(role)` — which is exactly what the deleted
    // `stampOrder` option did. `hud` is first in `accept`, so the authored 7 would collapse to 0.
    //
    // ⚠️ That option is GONE (#800 review): it had no caller once the owner ruled Court's order
    // authored, and a mechanism nothing fires is this repo's most common defect. It also loaded
    // `accept` with two meanings — vocabulary AND stacking sequence — so a game listing its roles
    // in any other order would have got a silently wrong stack from one boolean.
    authorFullStack();
    const byRole = Object.fromEntries(read().map((b) => [b.role, b]));
    expect(byRole.hud.order).toBe(0);
    expect(byRole.board.order).toBe(3);

    world = createWorld();
    author('hud', 7, 104, 0);
    author('crossword', 1, 0, 0.48);
    author('gap', 2, 125, 0);
    author('board', 3, 12, 0.52);
    expect(Object.fromEntries(read().map((b) => [b.role, b])).hud.order,
      'the authored 7 must survive, not be replaced by hud\'s index in `accept`').toBe(7);
  });
});
