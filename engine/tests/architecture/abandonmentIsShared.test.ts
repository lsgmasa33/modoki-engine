/**
 * `runtime/core/abandonment.ts` is the only timeout-wrapping implementation in SCAN_DIRS (#801).
 *
 * `withTimeout` was hand-rolled SIX times: four named helpers (`canvas2DPool.ts`, `gpuClock.ts`,
 * `rampProbeRunner.ts`, `text/msdfGenerate.ts`) and two inline copies (`Scene3D.tsx`,
 * `app/debug/bridgeHelpers.ts`). Every copy was reject-only: it rejects the CALLER while the wrapped
 * operation keeps running underneath, because none of the operations involved accepts an
 * `AbortSignal` and there is nothing to cancel. So each caller had to decide what happens to the
 * abandoned operation — and half of them never asked the question:
 *
 *   #801  a late `Application.init()` brought up a live renderer nothing revalidated
 *   #817  a timed-out `generateAtlas` released the queue lock with the worker still inside it
 *   #818  a late worker init orphaned a Worker + wasm the dispose path could not reach
 *   #819  the capture latch was released while the readback still owned the pooled render target
 *   #820  a superseded bring-up assigned the renderer anyway, and had no bound at all
 *
 * ⚠️ `bridgeHelpers.ts` was found by THIS GUARD, not by the sweep that designed the family — that
 * sweep scanned `engine/packages/modoki/src` and the sixth copy lives in `engine/app`. It is one of
 * the three sites that were already correct; it migrates anyway, because a guard that exempts the
 * correct sites is not a guard.
 *
 * The shared helper makes the disposition a REQUIRED argument, so the question cannot be skipped.
 * This guard enforces the "shared" half: a fifth hand-rolled copy fails here, at authorship, on the
 * clone that wrote it. It is the sibling of `livenessTokenIsShared.test.ts` (#573) and is built the
 * same way, for the same reason.
 *
 * ── What it detects, and why this is checkable without flow analysis ─────────────────────────────
 * A hand-rolled timeout has ONE signature, and it is a PAIR:
 *
 *   1. a `new Promise` executor that names a reject parameter        `new Promise<T>((_, rej) => …`
 *   2. a `setTimeout` whose callback calls THAT identifier            `setTimeout(() => rej(…), ms)`
 *
 * Asking the two independently would be far weaker — plenty of legitimate code writes a `new Promise`
 * with a rejector, and plenty writes a `setTimeout`. It is the rejector being the thing the timer
 * calls that makes it a timeout. This mirrors `livenessPair` in the sibling guard, and for the same
 * reason: that guard's one real false positive came from asking its two halves separately.
 *
 * ── Blind spots, stated rather than discovered later ─────────────────────────────────────────────
 * ⚠️ Read these before trusting a green. This guard says "no file matches the SHAPE below", which is
 * a strictly weaker claim than "no file hand-rolls a timeout".
 *
 *   - **Rejection through a named function.** `setTimeout(onTimeout, ms)` where `onTimeout` closes
 *     over the rejector is undetectable here — it needs the call graph, not a regex. This is the
 *     same hole idiom 3 opens in the sibling guard, where it hid a live counterexample for a while.
 *   - **A RESOLVE-based soft timeout.** `setTimeout(() => resolve(fallback), ms)` races a promise
 *     against a default rather than a failure. It is a different pattern with different correctness
 *     questions, deliberately out of scope — do not widen this to catch it without deciding what the
 *     shared helper should do about it.
 *   - **`AbortSignal.timeout()` / any future real cancellation.** Not matched, and correctly so: the
 *     whole reason this helper exists is that our operations cannot be cancelled. A site that CAN
 *     cancel should cancel, and does not need the helper.
 *   - **A timeout built anywhere outside `SCAN_DIRS`** — games, tools, scripts, the Electron main
 *     process. Deliberate: the helper is engine runtime code and does not ship to those.
 *
 * ⚠️ Comments MUST be stripped with the repo's `stripComments`, never a regex — a doc comment
 * describing this exact pattern (this file's own header does) would otherwise register as an
 * offender, and a hand-rolled regex stripper has already caused a silent MISS in the sibling guard.
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

const REPO = path.resolve(__dirname, '../../..');

/** Same scope as the liveness guard: everything that can hold engine state across a deferral. */
/** ⚠️ **Roots this guard does NOT scan, and the hand-rolled instances known to sit there (#830).**
 *
 *  The docblock above calls `SCAN_DIRS` a deliberate exclusion — "the helper is engine runtime code
 *  and does not ship to those". That reason is real, but the CLAIM in the file's opening line was
 *  wider than the check: ``runtime/core/abandonment.ts` is the ONLY timeout-wrapping implementation in the tree (#801)`. Running this guard's OWN
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
  'engine/electron/main.ts :: rejects via reject',
  'engine/plugins/backend/deviceCdp.ts :: rejects via reject',
  'engine/plugins/backend/deviceConnection.ts :: rejects via reject',
];


const SCAN_DIRS = [
  'engine/packages/modoki/src/runtime',
  'engine/packages/modoki/src/editor',
  'engine/app',
];

/** The roots this guard does NOT scan — **DERIVED, not hand-written (#830 review).**
 *
 *  ⚠️ This was a hand-listed four (`plugins`, `electron`, `tools`, `toolchain`) under a test titled
 *  "the roots this guard does NOT scan", which is a universal claim — so the ledger below was
 *  vouching for a subset while reading as though it covered everything. Exactly the defect this
 *  whole change is about, in the fix for it.
 *
 *  Now: every top-level source root in the repo, minus the ones SCAN_DIRS already covers. A new
 *  root is in the remainder the day it is created, without anyone remembering. */
const UNSCANNED_ROOTS: readonly string[] = (() => {
  const covered = (rel: string) => SCAN_DIRS.some((d) => rel === d || rel.startsWith(`${d}/`));
  const roots = new Set<string>();
  for (const { rel } of repoFiles({ match: /\.tsx?$/, exclude: ['node_modules', 'dist'], floor: 500 })) {
    const parts = rel.split('/');
    // Depth 2 for the multi-project roots (games/<id>, demos/<id>, engine/<area>), depth 1 for a
    // flat one like `site/`. Both are compared against SCAN_DIRS' own repo-relative prefixes.
    const root = parts.length > 2 ? parts.slice(0, 2).join('/') : parts[0];
    if (!covered(root) && !SCAN_DIRS.some((d) => d.startsWith(`${root}/`))) roots.add(root);
  }
  return [...roots].sort();
})();

/** The helper itself IS the implementation — its own timer is the one legitimate instance. */
const HELPER = path.join(REPO, 'engine/packages/modoki/src/runtime/core/abandonment.ts');

/** The corpus, from the shared git-backed enumerator (#771/#799/#805) rather than a hand-rolled
 *  `readdirSync` walk — main landed that convention and a guard for it while this file was being
 *  written, and this was its 32nd offender. `floor` also subsumes the census this guard used to
 *  hand-roll: `repoFiles` throws when the match count drops below it, so a scan that collapses
 *  fails loudly instead of going quietly green. */
function scannedFiles(roots: readonly string[] = SCAN_DIRS): Array<{ rel: string; abs: string }> {
  return repoFiles({
    under: [...roots],
    match: (rel) => /\.tsx?$/.test(rel) && !rel.includes('.test.'),
    exclude: ['node_modules', 'dist'],
    floor: 0,   // callers assert their own non-vacuity; SCAN_DIRS measured 862 when written
  });
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Reject parameters of two-argument `new Promise` executors — the population being policed.
 *  Handles a type argument (`new Promise<never>(…)`) and either arrow-parameter spelling. */
const REJECTORS =
  /new\s+Promise\s*(?:<[^>()]*>)?\s*\(\s*(?:async\s*)?(?:function\s*)?\(\s*[\w$]+\s*,\s*([\w$]+)\s*\)\s*(?:=>|\{)/g;

/** The PAIR: a timer whose callback calls this file's own rejector.
 *
 *  ⚠️ The body window is a bounded `[\s\S]{0,2000}?`, NOT `[^;{}]*`. The first version of this
 *  guard used the latter, which required the rejection to be the timer's FIRST token — so any
 *  two-statement body was invisible: cleanup-then-reject, guard-clause-then-reject, and
 *  `abandonment.ts`'s OWN body (`timedOut = true; reject(...)`), which is the single most likely
 *  shape of a future copy-paste. It shipped green while matching almost nothing, with two real
 *  hand-rolled timeouts sitting inside its own SCAN_DIRS.
 *
 *  ⚠️ And the window must be LARGE, which is not obvious: `stripComments` preserves source offsets
 *  rather than deleting text, so a heavily-commented timer body still spans its original width. At
 *  400 the real `createEditor.tsx` body — 70 characters of actual code — did not match. Sizing this
 *  against stripped CODE length is the mistake; size it against the source span. The negative
 *  fixtures below are what keep a window this wide from pairing across unrelated code. */
function timerRejects(src: string, rejector: string): boolean {
  const r = esc(rejector);
  return new RegExp(`setTimeout\\(\\s*(?:async\\s*)?\\(\\s*\\)\\s*=>[\\s\\S]{0,2000}?\\b${r}\\s*\\(`).test(src);
}

/** The ONE exemption, and it is a pattern this helper CANNOT EXPRESS — not a site that is merely
 *  already correct (those migrate; see the file header).
 *
 *  `createEditor`'s boot race is multi-way (`ready` against up to three timers) and its timers are
 *  CONDITIONAL — `if (suppressed()) return;`, `if (hasViewportBegun()) return;` — a timer that may
 *  decline to reject and leave the race running. `withTimeout(p, ms, …)` takes one promise and
 *  always rejects at `ms`; "reject unless suppressed" cannot be spelled in it, and widening the
 *  primitive to take a predicate would weaken the one thing it is for.
 *
 *  It is also not the family's defect. What it abandons is the editor's own renderer bring-up,
 *  which holds nothing the caller must reclaim: the renderer registers itself through
 *  `setActiveRenderer` whenever it arrives, and all three timers are cleared in a `finally`.
 *
 *  ⚠️ Exactly ONE entry, asserted below. A second is a signal that either the primitive needs a
 *  conditional variant or the exemption is being used to dodge a migration. Decide that
 *  deliberately; do not append to this list. */
const EXEMPT = ['engine/packages/modoki/src/editor/createEditor.tsx'];

interface Scanned { file: string; rejectors: string[]; offenders: string[] }

function scan(roots: readonly string[] = SCAN_DIRS): Scanned[] {
  const results: Scanned[] = [];
  for (const { rel, abs } of scannedFiles(roots)) {
    // The shared reader (#812), not a private `readFileSync` + strip: it picks the stripper from
    // the extension and REFUSES rather than guessing, which is the fail-open default that guard
    // exists to remove. ⚠️ It preserves source OFFSETS — see `timerRejects`'s window.
    const src = readScannedSource(abs).code;
    const rejectors = [...src.matchAll(REJECTORS)].map((m) => m[1]);
    const offenders = abs === HELPER || EXEMPT.includes(rel)
      ? []
      : [...new Set(rejectors)].filter((r) => timerRejects(src, r));
    results.push({ file: rel, rejectors, offenders });
  }
  return results;
}

describe('the shared abandonment helper is the only timeout implementation (#801)', () => {
  it('SCAN_DIRS itself is non-vacuous (the floor moved onto the callers)', () => {
    expect(scannedFiles().length, 'the SCAN_DIRS corpus collapsed — every check below would pass '
      + 'having read nothing').toBeGreaterThan(500);
  });

  it('the roots this guard does NOT scan hold exactly the KNOWN hand-rolled timeouts (#830)', () => {
    // Runs the guard's OWN detector over the unscanned roots, so this cannot drift from what the
    // real check would say. A FOURTH instance fails here instead of joining a silent population.
    const outside = scan(UNSCANNED_ROOTS)
      .filter((r) => r.offenders.length)
      .map((r) => `${r.file} :: rejects via ${r.offenders.join(', ')}`)
      .sort();
    expect(scannedFiles(UNSCANNED_ROOTS).length, 'the unscanned-roots corpus is empty — this '
      + 'assertion would pass having examined nothing').toBeGreaterThan(50);
    expect(outside, 'The set of hand-rolled timeouts OUTSIDE SCAN_DIRS changed. A new one means '
      + 'the family (#801) has a fresh instance in a root this guard does not police — decide '
      + 'deliberately whether it migrates onto the shared helper or joins the ledger with a '
      + 'reason. One DISAPPEARING is good news: drop its ledger entry in the same commit.')
      .toEqual([...KNOWN_OUTSIDE_SCAN_DIRS].sort());
  });

  it('no file hand-rolls a promise timeout', () => {
    const offenders = scan()
      .filter((r) => r.offenders.length > 0)
      .map((r) => `${r.file} :: rejects via ${r.offenders.join(', ')}`);

    expect(
      offenders,
      offenders.length === 0 ? '' : [
        'These files build their own timeout by rejecting from a setTimeout. There is ONE',
        'implementation, and it exists because a timeout REJECTS THE CALLER without CANCELLING the',
        'operation underneath — which none of our operations supports:',
        '',
        '  import { withTimeout } from "<...>/runtime/core/abandonment";',
        '  await withTimeout(p, ms, "what", { discard: "why the late value owns nothing" });',
        '',
        'The fourth argument is required on purpose: say what happens to the operation that is',
        'STILL RUNNING when the timeout fires. `adopt` / `discard` take a written justification;',
        '`onSettled` releases or disposes what it still holds. Three of the five original copies',
        'never asked that question, which is #801, #817 and #819.',
        '',
        'If this is NOT a timeout (a soft resolve-with-fallback, or a real AbortSignal), it should',
        'not reject from a timer — say so in review rather than widening this guard.',
      ].join('\n'),
    ).toEqual([]);
  });

  // CENSUS — the backstop, modelled on the sibling guard's. A scanner that stops recognising its
  // target does not know it missed anything; it just goes green. A FLOOR, deliberately not an exact
  // count: six clones move this tree constantly, and a guard that freezes a MEASUREMENT goes red on
  // whoever merges rather than on whoever wrote it. This only has to catch the scan collapsing — a
  // moved directory, a reformat, a broken regex.
  //
  // ⚠️ It counts TIMERS, not rejectors, and that choice is load-bearing. The obvious census — how
  // many two-arg `new Promise` executors the scan sees — is the population this guard SHRINKS:
  // there were 11 before this change and migrating the six copies removes six of them. A floor set
  // against the pre-migration number would have gone red on the very commit that fixed the family.
  // `setTimeout` is the detector's other half and is stable under the migration (72 calls across 53
  // files when written), so it catches the scan collapsing without moving when the guard succeeds.
  it('the scan still reaches the timer population it polices', () => {
    // The FILE floor now lives in `repoFiles({ floor })`, which throws on its own. What that
    // cannot see is the detector's other half going blind, so this counts timer-bearing files.
    // Deliberately a floor, not an exact count: six clones move this tree constantly, and a guard
    // that freezes a MEASUREMENT goes red on whoever merges rather than on whoever wrote it.
    const withTimers = scan().filter((r) => /setTimeout\s*\(/.test(
      readScannedSource(path.join(REPO, r.file)).code,
    )).length;
    expect(withTimers).toBeGreaterThan(20); // 53 when written
  });

  // The exemption is load-bearing in both directions: it must stay a single entry, and the file it
  // names must still trip the detector. An exemption for a file that no longer matches is dead
  // weight that silently grants cover to whatever gets written there next.
  it('the one exemption is still exactly one, and still needed', () => {
    expect(EXEMPT).toHaveLength(1);
    const src = readScannedSource(path.join(REPO, EXEMPT[0])).code;
    const rejectors = [...src.matchAll(new RegExp(REJECTORS.source, 'g'))].map((m) => m[1]);
    expect(
      rejectors.some((r) => timerRejects(src, r)),
      `${EXEMPT[0]} no longer hand-rolls a timeout — delete the exemption rather than leaving it`,
    ).toBe(true);
  });

  // The detector is unit-tested against fixtures because NARROWING it is otherwise invisible:
  // dropping the `<[^>()]*>` branch from REJECTORS would stop matching `new Promise<never>(…)` —
  // which is rampProbeRunner's and Scene3D's exact spelling — and the scan above would simply
  // return fewer offenders and pass. The census cannot see it either: it counts rejectors, and
  // that same edit would reduce the count without dropping it under the floor.
  describe('the detector itself', () => {
    const positives: Array<[string, string]> = [
      ['canvas2DPool / msdfGenerate shape (named params, block body)',
        'new Promise<T>((resolve, reject) => { const t = setTimeout(() => reject(new Error("x")), ms); });'],
      ['rampProbeRunner shape (typed, underscore param, assignment in body)',
        'Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("x")), ms); })]);'],
      ['Scene3D inline shape (expression body, abbreviated rejector)',
        'const w = (p, ms) => Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("x")), ms))]);'],
      ['block-bodied timer callback',
        'new Promise((res, bad) => { setTimeout(() => { bad(new Error("x")); }, 10); });'],
      // Every one of these was MISSED by the first version of this guard (`[^;{}]*` required the
      // rejection to be the timer's first token). The first is abandonment.ts's own body — the
      // most likely shape of a future copy-paste, and the one a guard must not be blind to.
      ['flag-then-reject — the helper\'s OWN body shape',
        'new Promise<never>((_, reject) => { timer = setTimeout(() => { timedOut = true; reject(new Error("x")); }, ms); });'],
      ['cleanup-then-reject',
        'new Promise((res, reject) => { setTimeout(() => { this.pending.clear(); reject(new Error("x")); }, ms); });'],
      ['guard-clause-then-reject',
        'new Promise<never>((_, reject) => { id = setTimeout(() => { if (suppressed()) return; reject(new Error("x")); }, ms); });'],
      ['function executor rather than an arrow',
        'new Promise(function (resolve, reject) { setTimeout(() => { reject(new Error("x")); }, ms); });'],
      ['async executor',
        'new Promise(async (resolve, reject) => { setTimeout(() => { reject(new Error("x")); }, ms); });'],
    ];
    for (const [name, src] of positives) {
      it(`detects: ${name}`, () => {
        const rejectors = [...src.matchAll(new RegExp(REJECTORS.source, 'g'))].map((m) => m[1]);
        expect(rejectors.length, 'the rejector must be found at all').toBeGreaterThan(0);
        expect(rejectors.some((r) => timerRejects(src, r))).toBe(true);
      });
    }

    const negatives: Array<[string, string]> = [
      ['a promise with a rejector but no timer',
        'new Promise((resolve, reject) => { if (bad) reject(new Error("x")); else resolve(1); });'],
      ['a timer that does not reject',
        'new Promise((resolve, reject) => { setTimeout(() => resolve(1), ms); });'],
      ['a soft resolve-with-fallback timeout — deliberately out of scope',
        'new Promise((resolve, reject) => { setTimeout(() => resolve(fallback), ms); });'],
      ['a bare delay with no promise executor at all',
        'setTimeout(() => reject(new Error("x")), ms);'],
    ];
    for (const [name, src] of negatives) {
      it(`does not flag: ${name}`, () => {
        const rejectors = [...src.matchAll(new RegExp(REJECTORS.source, 'g'))].map((m) => m[1]);
        expect(rejectors.some((r) => timerRejects(src, r))).toBe(false);
      });
    }
  });
});
