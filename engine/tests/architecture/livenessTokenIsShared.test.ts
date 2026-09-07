/**
 * `runtime/core/liveness.ts` is the only epoch/generation liveness token in SCAN_DIRS (#573).
 *
 * ⚠️ **"in SCAN_DIRS", not "in the tree" (#830).** The original wording claimed the whole
 * repo while the check read three roots of six. Running this guard's own detector over the
 * rest returns real hits, pinned in KNOWN_OUTSIDE_SCAN_DIRS below — so the claim is now the
 * one the code actually verifies, and the gap is tracked instead of implied.
 *
 * Five ad-hoc conventions for "am I still the live session?" grew up independently here, and about
 * twenty tickets in ten days were one defect found twenty times. The owner's decision was one
 * pattern with five permitted tokens (docs/async-lifetime.md), and a shared helper for the two that
 * are literally the same machinery — a supersession epoch and a teardown generation. This guard
 * enforces the "shared" half: a sixth hand-rolled counter fails here, at authorship, on the clone
 * that wrote it.
 *
 * ── What counts as a liveness token, and why this is checkable without flow analysis ─────────────
 * Three shapes wear a counter, and only ONE is a liveness token. They separate syntactically:
 *
 *   epoch / generation   captured into a local, compared against THE COUNTER'S OWN current value
 *                        `const gen = generation;` … `if (gen !== generation) return;`   ← GUARDED
 *   identity             compared against a value held SOMEWHERE ELSE
 *                        `actionOwner.get(n) !== entry.activationId`                     ← allowed
 *   id generator         never compared at all, only incremented and read
 *                        `seq++` in the journal                                          ← allowed
 *
 * So the test is ONE PAIRED fact: a local is declared FROM the counter, and THAT local is then
 * compared against THAT counter. See `livenessPair` — the pairing is load-bearing, and asking the
 * two halves independently produced a real false positive.
 *
 * What this correctly leaves alone:
 *   - a retry counter (`attempts === MAX`) — compared, never captured into a local
 *   - a per-frame dirty check (`_prevEaCount = _eaCount`) — a bare assignment between two module
 *     counters, not a declaration; this is what keeps transformPropagationSystem out of the net
 *   - an entity id copied and compared against other values (`entityActions.newParentId`) — both
 *     halves true, never as a pair
 *
 * ── Three capture idioms, and the one this cannot see ────────────────────────────────────────────
 *   1. snapshot            `const gen = generation;`          — the teardown shape
 *   2. bump-and-capture    `const epoch = ++_loadEpoch;`      — the supersession shape
 *   3. capture-by-argument `runTick(generation)`, callee compares its parameter
 *
 * Idioms 1 and 2 are checked. **Idiom 3 is NOT detectable here** and is a known hole: it needs the
 * call graph, not a regex. It existed THREE times when this guard was written —
 * app/debug/schemaPusher.ts (`runTick(generation)`), SceneManager's `collectSceneResourceRefs`
 * parameter, and rendering/frameDriver.ts's rAF chain (`makeFrame(loopGen)` compared in
 * `runFrame`) — and all three now thread the `LivenessCheck` itself instead of a raw number.
 *
 * ⚠️ **The third was missed by the sweep that wrote this guard, and found only by review.** This
 * file asserts "the helper is the ONLY epoch in the tree" and passed for a while with a live
 * counterexample standing — one that two already-migrated modules cited BY NAME as their
 * precedent. Do not read a green here as "there are no hand-rolled epochs"; read it as "there are
 * none of the two SHAPES below". The difference is the whole of idiom 3.
 *
 * ── A SECOND hole: capture-by-accessor ───────────────────────────────────────────────────────────
 * `capturesOf` wants a declaration initialised directly FROM the counter. Route it through a
 * function and the pair never forms:
 *
 *     let _fooEpoch = 0;
 *     export function fooGeneration(): number { return _fooEpoch; }
 *     const mine = fooGeneration();        // no `= _fooEpoch;` to match
 *     if (fooGeneration() !== mine) return;
 *
 * ⚠️ This change itself made that idiom fashionable — `serialize.sceneLoadGeneration()` and
 * `PlayerPrefs.swapGeneration()` are both blessed public contracts of exactly this shape. Both are
 * legitimately backed by the helper, which is what makes a hand-rolled COPY of them plausible and
 * invisible. Also unmatched by `DECL`: an initialiser other than `0` (`let epoch = 1;`), and any
 * declaration not starting with `let`/`private` at line start — `export let`, a bare/`public`/
 * `static`/`#private` class field. SceneManager's happened to be `private`.
 *
 * So the rule that keeps it empty is a convention, not this guard: **to carry liveness across a call
 * boundary, pass the `LivenessCheck`, never the counter.** A raw number threaded through a parameter
 * is the one shape that can re-open this blind spot, and docs/async-lifetime.md says so. The census
 * below is the partial backstop, and that doc records the stronger statement-order check as the
 * deliberate next step if this class recurs.
 *
 * ⚠️ Comments MUST be stripped with the repo's `stripComments`, never a regex. A non-greedy
 * `/\*…\*\/` stripper over-matched while this guard was being designed and silently swallowed
 * hapticsService's capture AND its comparison — a MISS, the dangerous direction, not a false alarm.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { stripComments } from '@modoki/engine/testing';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
import { deriveUnscannedRoots, expectedLedgerRows } from '../helpers/unscannedRoots';

const REPO = path.resolve(__dirname, '../../..');

/** Everything that can hold engine state across a deferral. `engine/app` is included because three
 *  of the migrated sites lived there (ota, editor/setup, debug/bridge). */
/** ⚠️ **Roots this guard does NOT scan, and the hand-rolled instances known to sit there (#830).**
 *
 *  The docblock above calls `SCAN_DIRS` a deliberate exclusion — "the helper is engine runtime code
 *  and does not ship to those". That reason is real, but the CLAIM in the file's opening line was
 *  wider than the check: ``runtime/core/liveness.ts` is the ONLY epoch/generation liveness token in the tree (#573)`. Running this guard's OWN
 *  detector over the unscanned roots returns the entries below, so "in the tree" was never what was
 *  verified.
 *
 *  These are PINNED rather than migrated, deliberately. Moving them onto the shared helper changes
 *  behaviour in the Electron main process and in the device-connection path — code whose failure
 *  modes need a physical device to exercise — and whether engine runtime code SHOULD be imported
 *  there at all is a design question, not a refactor. Filed on #830.
 *
 *  What the pin buys: a FOURTH instance fails immediately instead of joining a silent population.
 *  ⚠️ It also goes red when one of these is legitimately FIXED — that is intended. Removing an
 *  entry should be a deliberate edit in the same commit as the migration, not something that
 *  quietly stops being true. */
const KNOWN_OUTSIDE_SCAN_DIRS: readonly string[] = [
  'engine/plugins/backend/deviceConnection.ts :: sessionGeneration',

  /* ── GAME code (#830 review). Surfaced once UNSCANNED_ROOTS stopped being a hand-listed four.
   * Not migrated for the same reason as the engine-side rows: `@modoki/engine/runtime/core/liveness`
   * IS importable from a game, so this is a DESIGN question (should game logic take an engine
   * runtime dependency for this?) rather than a refactor — and these are six gameplay paths that
   * cannot be exercised without playing them. Classified individually rather than as a block: */

  // REAL — the textbook #573 shape. `let payoutEpoch = 0` … `const epoch = payoutEpoch` …
  // `if (epoch !== payoutEpoch) return` around an await (`systems.ts:4754-4767`), and the file's
  // own comment already calls it a banner. Three separate counters in one file.
  'games/court/runtime/systems.ts :: payoutEpoch, bonusSpinEpoch, storeInFlightGen',
  // REAL — `private generation = 0` guarding `initLLM()`/`newGame()`; its own docblock (`:15`,
  // `:47`, `:91`) describes the abandoned-generation branch it exists for.
  'games/chess/runtime/ChessManager.ts :: generation',
  // REAL — same shape as chess, same subsystem.
  'games/llm-test/runtime/LLMManager.ts :: generation',
  // REAL — ad-hoc init/fullscreen-ad epochs in the shared app-services package.
  'games/court/packages/app-services/src/ads.ts :: initEpoch, fullscreenAdGen',
  'games/3d-test/packages/app-services/src/ads.ts :: initEpoch',
  // REAL — an IAP epoch guarding an awaited purchase flow.
  'games/wordweave/runtime/systems.ts :: iapEpoch',
  // ⚠️ FALSE POSITIVE, kept so the set is exact rather than silently filtered. `k` is a convex-hull
  // LOOP INDEX (`let k = hi.length - 1` at :493, `let k = 0` at :505) that happens to be
  // zero-initialised and compared, which is all the detector can see. Do NOT "migrate" it. If the
  // detector ever learns to tell a loop counter from a liveness token, this row goes with it.
  'games/sling/runtime/field/nav.ts :: k',
];


const SCAN_DIRS = [
  'engine/packages/modoki/src/runtime',
  'engine/packages/modoki/src/editor',
  'engine/app',
];

/** The roots this guard does NOT scan, and the ledger rows whose root this checkout actually has.
 *
 *  Both are DERIVED, from the ONE definition of what a "root" is — see
 *  `tests/helpers/unscannedRoots.ts` for why they must not be transcribed apart. In short: the
 *  complement is computed from disk while the ledger is absolute, and the public snapshot ships no
 *  `games/`, so an unfiltered exact-set assertion goes red there over content that was never
 *  supposed to be present. Filtering the EXPECTATION by the same root list the SCAN used lets the
 *  two disagree about tokens only. It is NOT a skip: `engine/plugins` is in the snapshot, so a
 *  fresh ad-hoc epoch in shipped engine code still fails the public gate. */
const UNSCANNED_ROOTS: readonly string[] = deriveUnscannedRoots(SCAN_DIRS);

const expectedOutsideRows = (): string[] =>
  expectedLedgerRows(KNOWN_OUTSIDE_SCAN_DIRS, UNSCANNED_ROOTS);

/** The helper itself implements the token, so its own counters are the one legitimate instance. */
const HELPER = path.join(REPO, 'engine/packages/modoki/src/runtime/core/liveness.ts');

/** Every `.ts`/`.tsx` production source file under `SCAN_DIRS`, via the shared corpus producer
 *  (#799/#771/#805 Phase 4). Floored well under the 851 measured today. */
function listSourceFiles(roots: readonly string[] = SCAN_DIRS): string[] {
  return repoFiles({
    under: roots.map((rel) => path.join(REPO, rel)),
    match: (rel: string) => /\.tsx?$/.test(rel) && !path.posix.basename(rel).includes('.test.'),
    exclude: ['node_modules', 'dist'],
    floor: 0,   // callers assert their own non-vacuity; SCAN_DIRS measured >600 when written
  }).map(({ abs }) => abs);
}

/** Zero-initialised numeric counters: module/closure `let x = 0;` and class field `private x = 0;`.
 *  Both forms matter — SceneManager's was a private field, every loader cache's was a module let. */
const DECL = /^\s*(?:let|private(?:\s+readonly)?)\s+(\w+)\s*(?::\s*number\s*)?=\s*0\s*;/gm;

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Locals captured FROM this counter, by any of the two detectable idioms. Returns their names. */
function capturesOf(src: string, name: string): string[] {
  const n = esc(name);
  const re = new RegExp(
    `(?:const|let)\\s+(\\w+)\\s*(?::\\s*number\\s*)?=\\s*(?:\\+\\+\\s*)?(?:this\\.)?${n}\\s*(?:\\+\\+)?\\s*;`,
    'g',
  );
  return [...src.matchAll(re)].map((m) => m[1]);
}

/**
 * The two facts must be about the SAME PAIR, not merely both true somewhere in the file.
 *
 * Asking "is it captured anywhere?" and "is it compared anywhere?" independently is not enough, and
 * this was caught by a real false positive rather than by reasoning: `editor/undo/entityActions.ts`
 * has `let newParentId = 0`, copies it (`const savedNewParentId = newParentId`) and compares it
 * (`newParentId !== 0`, `oldParentId !== newParentId`) — two true facts about an entity id, and not
 * a liveness token at all. A real token compares the CAPTURED LOCAL against the counter it came
 * from: `const gen = generation;` … `if (gen !== generation)`. That pairing is the signature.
 */
function livenessPair(src: string, name: string): boolean {
  const n = esc(name);
  return capturesOf(src, name).some((local) => {
    const l = esc(local);
    return new RegExp(`\\b${l}\\s*(?:!==|===)\\s*(?:this\\.)?${n}\\b`).test(src)
      || new RegExp(`\\b(?:this\\.)?${n}\\s*(?:!==|===)\\s*${l}\\b`).test(src);
  });
}

interface Scanned { file: string; counters: string[]; offenders: string[] }

function scan(roots: readonly string[] = SCAN_DIRS): Scanned[] {
  const results: Scanned[] = [];
  for (const file of listSourceFiles(roots)) {
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    const counters = [...src.matchAll(DECL)].map((m) => m[1]);
    const offenders = file === HELPER
      ? []
      : [...new Set(counters)].filter((n) => livenessPair(src, n));
    results.push({ file: path.relative(REPO, file), counters, offenders });
  }
  return results;
}

describe('the shared liveness token is the only epoch/generation implementation (#573)', () => {
  it('SCAN_DIRS itself is non-vacuous (the floor moved onto the callers)', () => {
    expect(listSourceFiles().length, 'the SCAN_DIRS corpus collapsed — every check below would '
      + 'pass having read nothing').toBeGreaterThan(600);
  });

  it('the roots this guard does NOT scan hold exactly the KNOWN ad-hoc tokens (#830)', () => {
    // The guard's OWN detector, pointed at the roots it does not police, so this cannot drift
    // from what the real check would say.
    const outside = scan(UNSCANNED_ROOTS)
      .filter((r) => r.offenders.length)
      .map((r) => `${r.file} :: ${r.offenders.join(', ')}`)
      .sort();
    expect(listSourceFiles(UNSCANNED_ROOTS).length, 'the unscanned-roots corpus is empty — this '
      + 'assertion would pass having examined nothing').toBeGreaterThan(50);
    expect(outside, 'The set of ad-hoc liveness tokens OUTSIDE SCAN_DIRS changed. A new one means '
      + '#573\'s family has a fresh instance in a root this guard does not police. One '
      + 'DISAPPEARING is good news: drop its ledger entry in the same commit.')
      .toEqual(expectedOutsideRows());
  });

  it('no file hand-rolls a counter that is captured across a deferral and compared', () => {
    const offenders = scan()
      .filter((r) => r.offenders.length > 0)
      .map((r) => `${r.file} :: ${r.offenders.join(', ')}`);

    expect(
      offenders,
      offenders.length === 0 ? '' : [
        'These counters are captured into a local and compared against their own current value —',
        'that is the epoch/generation liveness token, and it has ONE implementation:',
        '  import { createTeardownToken } from "<...>/runtime/core/liveness";      // bumps on invalidate',
        '  import { createSupersessionToken } from "<...>/runtime/core/liveness";  // bumps on start',
        'Pick by which event should win, not by which reads nicer. See docs/async-lifetime.md.',
        'If this is NOT a liveness token (an identity check, or a plain id generator), it should not',
        'be both captured and compared — say so in the review rather than widening this guard.',
      ].join('\n'),
    ).toEqual([]);
  });

  // CENSUS — the backstop this guard's sibling (appManagerDisposeReachable) exists to model: a
  // scanner that stops recognising its target does not know it missed anything, it just goes green.
  // A FLOOR, deliberately not an exact count: six clones move this tree constantly, and a guard
  // that freezes a measurement goes red on whoever merges rather than whoever wrote it. This only
  // has to catch the scan collapsing — a moved directory, a reformat, a broken regex.
  it('the declaration scan still sees the counter population it is supposed to police', () => {
    const results = scan();
    const total = results.reduce((n, r) => n + r.counters.length, 0);
    expect(results.length).toBeGreaterThan(500); // files reached at all
    expect(total).toBeGreaterThan(100); // 289 when written
  });

  // The detector is unit-tested against fixtures because NARROWING it is otherwise invisible:
  // deleting the `++` branch from capturesOf() would stop catching every supersession epoch in the
  // tree and no test above would notice — the scan would simply return fewer offenders and pass.
  // The census cannot see it either; it counts declarations, not detections.
  describe('the detector itself', () => {
    const cases: [string, string, string, boolean][] = [
      ['snapshot idiom', 'let generation = 0;\nconst gen = generation;\nif (gen !== generation) return;', 'generation', true],
      ['bump-and-capture, prefix', 'let ep = 0;\nconst mine = ++ep;\nif (mine !== ep) return;', 'ep', true],
      ['bump-and-capture, postfix', 'let ep = 0;\nconst mine = ep++;\nif (mine !== ep) return;', 'ep', true],
      ['instance field via this.', 'private g = 0;\nconst entered = this.g;\nif (this.g !== entered) return;', 'g', true],
      ['comparison written the other way round', 'let g = 0;\nconst c = g;\nif (g === c) return;', 'g', true],
      ['retry counter — compared against a constant, never captured', 'let attempts = 0;\nif (attempts === MAX) return;', 'attempts', false],
      ['dirty check — bare assignment, not a declaration', 'let n = 0;\nlet prev = 0;\nprev = n;\nif (n !== prev) x();', 'n', false],
      ['captured and compared, but never as a pair', 'let pid = 0;\nconst saved = pid;\nif (pid !== 0) x();\nuse(saved);', 'pid', false],
      ['id generator — never compared', 'let seq = 0;\nconst id = seq++;\nemit(id);', 'seq', false],
    ];
    for (const [label, src, counter, expected] of cases) {
      it(`${expected ? 'flags' : 'ignores'}: ${label}`, () => {
        expect(livenessPair(src, counter)).toBe(expected);
      });
    }
  });

  it('the helper itself is exempt, and is genuinely the shape it exempts', () => {
    // If liveness.ts ever stops being captured-and-compared, the exemption is masking a helper that
    // no longer implements the token — and every call site would be trusting a no-op.
    const src = stripComments(fs.readFileSync(HELPER, 'utf8'));
    const counters = [...new Set([...src.matchAll(DECL)].map((m) => m[1]))];
    const live = counters.filter((n) => livenessPair(src, n));
    expect(live.length).toBeGreaterThan(0);
  });
});
