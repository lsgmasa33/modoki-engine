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
import { createWorld, universe } from 'koota';

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

beforeEach(() => {
  // ⚠️ koota caps a process at 16 worlds and this file builds one per test, so the ids have to be
  // released or the suite fails on world 17 with `Too many worlds created` — a failure that looks
  // like a logic error in whichever test happens to be 17th. The same reset guards
  // `postFXTraitScan.test.ts` and `prewarmShaders.test.ts`. Added when #1089 took this file past
  // the ceiling; before that it sat at 15 and passed by one.
  universe.reset();
  world = createWorld();
});

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
    // ⚠️ These two do NOT discriminate, and are kept only as a sanity check on the fixture: the
    // full stack authors hud=0 and board=3, which are exactly `accept.indexOf(role)` — so they
    // pass under both hypotheses. The authored 7 below is the whole discriminator.
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

describe('a band with NO ROLE PICKED is reported, not silently skipped (#1089)', () => {
  it('names an unconfigured band alongside a stack that is otherwise fine', () => {
    // MUTATION: fold `''` back into the out-of-vocabulary skip. `ScreenBand.role` defaults to `''`,
    // so "dropped a band in the Inspector and never chose what it is" is a reachable authoring
    // state — and one `require` structurally CANNOT catch, because no declared role went missing.
    const warn = vi.fn();
    authorFullStack();
    author('', 9, 500, 5);
    const bands = read({ warn });
    expect(bands).toHaveLength(4);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('no role set');
  });

  it('counts them, so two unnamed bands do not read as one', () => {
    // MUTATION: report a boolean instead of a count — "a band has no role" when four of them do
    // sends the reader looking for one mistake.
    const warn = vi.fn();
    authorFullStack();
    author('', 9, 500, 5);
    author('', 10, 500, 5);
    read({ warn });
    expect(warn.mock.calls[0][0]).toContain('2 ScreenBand entities have no role set');
  });

  it('still says NOTHING about a role that is merely out of vocabulary', () => {
    // The accept side, and the whole narrowing this design turns on: a game may carry a decorative
    // band this reader is not meant to know about, and `skips a role outside the vocabulary` above
    // authors exactly one. MUTATION: report every skipped role — that case would start warning.
    const warn = vi.fn();
    authorFullStack();
    author('typo-role', 9, 500, 5);
    read({ warn });
    expect(warn).not.toHaveBeenCalled();
  });

  it('reports bands that ALL lack a role instead of reading it as the no-scene case', () => {
    // MUTATION: keep the bare `seen.size === 0` early return. Authoring two bands and naming
    // neither is the OPPOSITE of an empty world, and it would fall back in silence.
    const warn = vi.fn();
    author('', 0, 100, 0);
    author('', 1, 100, 0);
    expect(read({ warn })).toEqual(FALLBACK);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('no role set');
  });

  it('leaves an EMPTY world silent', () => {
    // Deliberately overlaps the empty-world case above, because it is the accept side of the case
    // right before it and a reader of this block needs it adjacent: the genuine no-scene path must
    // stay quiet or every headless test world warns. MUTATION: warn whenever the fallback is used.
    const warn = vi.fn();
    expect(read({ warn })).toEqual(FALLBACK);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('`requireOrder` — a stacking dependency the GAME declares (#1089)', () => {
  /** `board` authored ABOVE `crossword`, which is the arrangement that silently disables #1080. */
  function authorBoardAboveCrossword(): void {
    author('hud', 0, 104, 0);
    author('board', 1, 12, 0.52);
    author('crossword', 2, 0, 0.48);
    author('gap', 3, 125, 0);
  }

  it('reports a broken order, and still returns the authored bands', () => {
    // MUTATION: drop the check. `giveBoardSlackToCrossword` returns its input when `board` is
    // stacked above `crossword`, so the board's unused panel height stops reaching the crossword
    // and the whole of #1080 switches off with nothing on screen to explain it.
    const warn = vi.fn();
    authorBoardAboveCrossword();
    const bands = read({ warn, requireOrder: ['crossword', 'board'] });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('out of order');
    expect(warn.mock.calls[0][0]).toContain('crossword must be ordered above board');
    // Reported, NOT refused: only a missing required role falls back. MUTATION: return the
    // fallback here too — every authored value would be discarded over an ordering nit.
    expect(bands).toHaveLength(4);
    expect(bands).not.toEqual(FALLBACK);
  });

  it('does not report an order nobody asked it to check', () => {
    // The accept side, and the discriminating one: the SAME stack as above, with no `requireOrder`.
    // MUTATION: check adjacent pairs of `accept` instead — `accept` is a vocabulary, not a
    // sequence, which is the second meaning the deleted `stampOrder` option was killed for.
    const warn = vi.fn();
    authorBoardAboveCrossword();
    read({ warn });
    expect(warn).not.toHaveBeenCalled();
  });

  it('never warns when the authored order satisfies the dependency', () => {
    // MUTATION: invert the comparison. A guard that fires on healthy input trains its reader to
    // ignore it.
    const warn = vi.fn();
    authorFullStack();
    read({ warn, requireOrder: ['crossword', 'board'] });
    expect(warn).not.toHaveBeenCalled();
  });

  it("stays quiet about a pair whose role is MISSING — that is `require`'s to name", () => {
    // MUTATION: check a pair with only one side present. The stack would be reported as BOTH out of
    // order and missing, pointing the reader at the wrong fix on the one message they get.
    const warn = vi.fn();
    author('hud', 0, 104, 0);
    author('crossword', 2, 0, 0.48);
    author('gap', 3, 125, 0);
    read({ warn, require: ['crossword', 'board'], requireOrder: ['crossword', 'board'] });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('missing');
    expect(warn.mock.calls[0][0]).not.toContain('out of order');
  });

  it('treats an ORDER TIE as broken, because a tie does not determine the stack', () => {
    // MUTATION: `>=` to `>`. Review found this unguarded — the mutant passed all 21 tests, and it
    // is the one comparison the design turns on. `solveBands` sorts by `order` and the trait
    // documents ties as UNSPECIFIED, so on equal orders the relative position falls out of world
    // query order (entity spawn order) — which decides whether #1080's slack transfer fires at all.
    // A tie is already a broken dependency, not a satisfied one.
    const warn = vi.fn();
    author('hud', 0, 104, 0);
    author('crossword', 5, 0, 0.48);
    author('board', 5, 12, 0.52);
    author('gap', 6, 125, 0);
    read({ warn, requireOrder: ['crossword', 'board'] });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('crossword must be ordered above board');
  });

  it('checks EVERY declared pair, not just consecutive ones', () => {
    // MUTATION: walk consecutive pairs only. With the middle role absent, the outermost dependency
    // would never be compared and an inverted stack would report nothing.
    const warn = vi.fn();
    author('hud', 9, 104, 0);
    author('board', 1, 12, 0.52);
    read({
      warn,
      require: ['hud', 'board'],
      requireOrder: ['hud', 'crossword', 'board'],
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('hud must be ordered above board');
  });

  it('NAMES the duplicated roles rather than reporting that some role was duplicated', () => {
    // MUTATION: report a boolean. "two ScreenBand entities claim the same role" printed verbatim
    // when two DIFFERENT roles were each duplicated, sending the reader after one mistake.
    const warn = vi.fn();
    authorFullStack();
    author('crossword', 1, 0, 0.48);
    author('gap', 2, 125, 0);
    read({ warn });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('crossword');
    expect(warn.mock.calls[0][0]).toContain('gap');
  });

  it('reports a duplicate, an unnamed band, a broken order and a missing role in ONE message', () => {
    // MUTATION: warn on the first problem only. The caller latches this once per world, so every
    // problem after the first would never be named. Extends the two-problem case above to all four.
    const warn = vi.fn();
    author('hud', 0, 104, 0);
    author('board', 1, 12, 0.52);
    author('crossword', 2, 0, 0.48);
    author('crossword', 3, 0, 0.48);
    author('', 4, 500, 5);
    const message = (() => {
      read({ warn, require: ['crossword', 'board', 'gap'], requireOrder: ['crossword', 'board'] });
      return warn.mock.calls[0][0] as string;
    })();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(message).toContain('same role');
    expect(message).toContain('no role set');
    expect(message).toContain('out of order');
    expect(message).toContain('missing');
  });
});
