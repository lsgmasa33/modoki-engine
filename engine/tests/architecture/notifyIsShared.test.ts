/**
 * Every loop in SCAN_DIRS that matches the fan-out SHAPE is accounted for in exactly one of two
 * buckets: migrated onto `runtime/core/notifyListeners.ts`, or on this file's `EXEMPT` list as a
 * shape the helper cannot express (#888, #953).
 *
 * The arrays below ARE the counts. No number is restated in prose, because every restated one went
 * stale: this header once said "41 ledger rows" while the ledger held 40 (#953).
 *
 * ⚠️ **History, because it explains the guard's shape.** When it landed (#888) this header claimed
 * "the helper is the only one", and that was false: the detector was scoped by variable NAME, the
 * real population was roughly three times the size the census reported, and the remainder had to
 * be pinned row by row in a `KNOWN_UNMIGRATED` ledger. #953 migrated or exempted every row and
 * deleted that ledger, so the strong claim is now the enforced one, subject to the blind spots
 * stated below.
 *
 * The loop was hand-rolled 23 times. Eight copies wrapped each listener in its own `try` and
 * argued the point in eight separately-worded comments; fifteen did not, and one of the fifteen
 * was `setCurrentWorld` — the engine's most consequential notification, with ~50 subscribers.
 *
 * What made that a defect rather than an inconsistency is the ORDER, which every one of the 23
 * shared: the publisher mutates its own state and THEN notifies. So an escaping listener error
 * leaves the mutation committed, permanently starves every subscriber behind the thrower in `Set`
 * iteration order (the loop is not resumable and nothing retries it), and unwinds into the
 * publisher's caller. For `setCurrentWorld` that caller was `SceneManager`, whose tail transfers
 * world ownership — so its `catch` released the live scene's resources and destroyed the world it
 * had just promoted.
 *
 * This guard enforces the "shared" half: a 24th hand-rolled loop fails here, at authorship, on the
 * clone that wrote it. Sibling of `abandonmentIsShared.test.ts` (#801) and
 * `livenessTokenIsShared.test.ts` (#573), built the same way for the same reason.
 *
 * ── What it detects, and why this is checkable without flow analysis ─────────────────────────────
 * A hand-rolled notification has ONE signature, and it is a PAIR:
 *
 *   1. a `for…of` over a set with a subscriber NAME       `for (const fn of listeners)`
 *   2. a body that CALLS the loop variable                 `fn(next, old)` / `l()`
 *
 * Asking (1) alone is far weaker and produces real false positives: this repo iterates plenty of
 * `Set`s to `.delete()`, `.add()` or read a field out of them. It is the element being CALLED that
 * makes the loop a notification. That mirrors the pair in both sibling guards, and for the same
 * reason — each of those found that asking their halves independently was the weaker check.
 *
 * ── Blind spots, stated rather than discovered later ─────────────────────────────────────────────
 * ⚠️ Read these before trusting a green. This says "no file matches the SHAPE below", which is
 * strictly weaker than "no file hand-rolls a notification loop".
 *
 *   - **Notification through a named function** — `for (const fn of listeners) dispatch(fn)` — needs
 *     the call graph, not a regex. Same hole both sibling guards carry.
 *   - **A `.map`/`for` over an ARRAY of callbacks built inline**, never stored in a named binding.
 *     Not seen in SCAN_DIRS, and matching it would need to distinguish a callback array from any
 *     other array of functions.
 *   - **`.forEach((cb, i) => cb())`** — a multi-parameter callback. `FOREACH_NOTIFY` requires a
 *     single parameter. No instance in SCAN_DIRS (scanned); stated because the single-parameter
 *     assumption is exactly the kind this guard has now been wrong about twice.
 *   - **Rows are `path :: identifier`, not line numbers.** While the `KNOWN_UNMIGRATED` ledger
 *     existed this was a real hole: one file could hold several identical rows (each event bus did,
 *     one per emitter), so migrating one of a same-named pair while adding a NEW loop with the same
 *     loop variable kept the equality green. With no in-scope ledger the expected set is empty and
 *     `subtractOnce` removes only ONE occurrence per EXEMPT row, so a second same-named loop in an
 *     exempt file now shows up as an offender. What remains: replacing an exempt loop with a
 *     different, plain fan-out of the SAME identifier in the same file passes. Line numbers would
 *     close that and churn on every unrelated edit above them; the trade was made knowingly.
 *
 * ⚠️ **Two blind spots this header used to claim are gone, because both were wrong — and finding
 * that out is what the close-out sweep was for.** The first version keyed on the house names
 * `listeners`/`subs`/`cbs` and declared the `.forEach` spelling absent from SCAN_DIRS. Both claims
 * were false on the tree they landed on, and between them they hid EIGHT members plus two teardown
 * fan-outs:
 *
 *   - underscore-prefixed sets the name list never saw — `_editorDirtyListeners` (`uiDirty`),
 *     `_versionListeners` (`storeHooks`), `_playListeners` + `_modeListeners` (`playState`),
 *     `_structureListeners` (`entityUtils`);
 *   - `.forEach` after all — `traitClipboard`, `gameRegistry`, and `spriteMaterialCache`'s waiter
 *     set (the `fontTexturePixi` shape, a second time);
 *   - and, once the name restriction went, two teardown fan-outs the notification framing had
 *     excluded by assumption: `inputPromptSources`'s disposers and `TimeManager.dispose`'s
 *     unsubscribes — the second of which aborted its own tail, leaving the manager half-disposed.
 *
 * The lesson is the one `docs/falsifiable-tests.md` keeps restating in other words: a detector
 * scoped by a NAMING CONVENTION is making a claim about how every author spells things, and this
 * repo does not spell them one way. The detector now keys on the SHAPE alone.
 *   - **Anywhere outside SCAN_DIRS.** A game's own listener set is its own business; the helper is
 *     engine code. The ledger test below runs this same detector over the unscanned roots so that
 *     population cannot grow silently.
 *
 * ⚠️ Comments MUST be stripped with the repo's shared reader, never a hand-rolled regex — the
 * helper's own docblock quotes `for (const fn of listeners)` while explaining what it replaced,
 * and this file's header does the same. On raw text both would register as offenders.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { stripCommentsAndStrings } from '@modoki/engine/testing';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
import { deriveUnscannedRoots, expectedLedgerRows } from '../helpers/unscannedRoots';

const REPO = path.resolve(__dirname, '../../..');

const SCAN_DIRS = [
  'engine/packages/modoki/src/runtime',
  'engine/packages/modoki/src/editor',
  'engine/app',
];

/** Hand-rolled fan-outs known to live OUTSIDE SCAN_DIRS: none, since #953 migrated the last four
 *  (`engine/electron/main.ts`, Court's reload-blocker disposers and cloud-sync resolvers,
 *  `games/llm-test`'s progress callbacks).
 *
 *  Kept as an explicit, EMPTY ledger rather than a bare `toEqual([])` so that a NEW instance
 *  appearing in `games/`, `demos/`, `engine/electron` or `engine/plugins` is a decision someone
 *  makes on purpose: migrate it, or write down why it stays. A game CAN reach the helper; it is a
 *  deep export (`@modoki/engine/runtime/core/notifyListeners`), as `games/sling` and `games/court`
 *  use it. `engine/electron` reaches it by relative path, as `main.ts` already imports engine
 *  source. */
const KNOWN_OUTSIDE_SCAN_DIRS: readonly string[] = [];

// There is no in-SCAN_DIRS ledger any more. #888 migrated 36 sites and pinned the remaining ~40
// row by row as `KNOWN_UNMIGRATED`; #953 migrated or exempted every one, so inside SCAN_DIRS a
// fan-out-shaped loop is now either on the helper or on `EXEMPT` below, and nothing else is legal.

const UNSCANNED_ROOTS: readonly string[] = deriveUnscannedRoots(SCAN_DIRS);
const expectedOutsideRows = (): string[] =>
  expectedLedgerRows(KNOWN_OUTSIDE_SCAN_DIRS, UNSCANNED_ROOTS);

/** ⚠️ **The outside scan re-filters `UNSCANNED_ROOTS` against `SCAN_DIRS`, and the CAUSE that made
 *  that necessary is fixed — this is now defence in depth, not the load-bearing guard it was.**
 *
 *  The observation still stands: hand-rolling the loop back into `runtime/debug/widgetStore.ts` once
 *  made it appear in BOTH the in-SCAN_DIRS list and the "roots this guard does NOT scan" list, under
 *  a message telling the reader to go look in `games/`.
 *
 *  ⚠️ **Two claims this docblock used to make are RETRACTED (#1123 close-out, 2026-09-12).**
 *
 *  1. *"`deriveUnscannedRoots` … keeps the last directory it computed, so `engine/vite.config.ts`
 *     yields the root `engine`."* That was **#950, and #950 landed.** When the walk exhausts the
 *     helper now returns the FILE itself, and `helpers/unscannedRoots.ts` — which OWNS this fact,
 *     so read it there rather than trusting a second copy here — records the measurement: the
 *     "a returned root contains a scanDir" set is empty. This file was never updated, which is how
 *     the filter below came to read as covering a live hole.
 *  2. *"`abandonmentIsShared` and `livenessTokenIsShared` … are green only because neither currently
 *     has an offender inside its own SCAN_DIRS to be double-reported."* No longer true, and the
 *     evidence is direct: #1123 removed `abandonmentIsShared`'s file-level exempt skip, so
 *     `engine/packages/modoki/src/editor/createEditor.tsx :: reject` **is** an offender inside its
 *     own SCAN_DIRS — and that guard is green, with no double report. It is green because the
 *     derivation is right, not because it is unexercised.
 *
 *  The filter stays: it is four cheap call sites, it costs nothing, and it keeps this guard honest
 *  if the helper's exhaustion branch ever regresses. But it is no longer the thing standing between
 *  this guard and a double report. */
const insideScanDirs = (rel: string): boolean =>
  SCAN_DIRS.some((d) => rel === d || rel.startsWith(`${d}/`));

/** ⚠️ **Loops the helper CANNOT express — permanently exempt, not "not done yet".**
 *
 *  The distinction matters: a ledger row is a todo, an exemption is an argued decision, and
 *  migrating one of these would be a REGRESSION rather than a cleanup. Every row carries one of
 *  three KINDS, and the kind is the argument:
 *
 *  - **`query`** reads a value back out of each callback, which `notifyListeners` — whose whole
 *    contract is "call them all, return nothing" — has no way to do.
 *  - **`async-sequential`** AWAITS each callback before starting the next, so order and completion
 *    are part of the contract. The helper is synchronous.
 *  - **`registration`** must STOP on the first failure. Isolating it would leave a half-registered
 *    system that reports success.
 *
 *  ── query ──
 *
 *  - `runtime/core/screenPick.ts` `pickAt` — a FIRST-MATCH query. It `break`s on the first
 *    provider that answers and returns that answer; a helper that always calls everyone would
 *    change the result, not just the error handling.
 *  - `runtime/rendering/hitRegions.ts` `collectHitRegions` — a COLLECT query, and its own docblock
 *    argues the exact point: the `try` wraps the WHOLE per-provider body on purpose, because
 *    guarding only `fn()` catches a provider that throws and misses one that returns malformed
 *    DATA. `notifyListeners` can only isolate the call, so migrating it would narrow a guard whose
 *    width is documented and deliberate.
 *  - `runtime/rendering/interactionHandles.ts` `collectHandles` — a COLLECT query of the same
 *    shape: each provider RETURNS its handles, which are then filtered and de-duplicated. It also
 *    reports a throwing provider once per provider (`warnedThrowers`) so a per-frame
 *    `modoki_handles` poll cannot flood the console; the helper would report on every call.
 *
 *  - `engine/plugins/load-project-config.ts` — `for (const [filename, read] of [[…, readRawProjectConfig],
 *    […, readRawProjectUserConfig]] as const)`. An inline two-element array of READERS whose return
 *    value is used; the header lists this shape as one the guard does not mean to match, and it is
 *    ledgered here rather than left in `KNOWN_OUTSIDE_SCAN_DIRS`, where its row falsely implied an
 *    unmigrated fan-out in engine code.
 *
 *  ⚠️ **A row here is `path :: identifier`, NOT a path — and that distinction is load-bearing.**
 *  It was file-scoped for one commit, and review measured what that cost: `hitRegions.ts` hosts the
 *  exempt collect query AND a genuinely migrated publisher (`setHitRegionOverlayVisible` →
 *  `notifyListeners(listeners, 'hitRegions', [])`), so un-migrating that publisher back to a
 *  hand-rolled loop — the exact regression this guard exists to catch — passed SILENTLY. Skipping a
 *  file to excuse one loop in it blinds the guard to every other loop in the same file.
 *
 *  - `games/wordweave/runtime/stem.ts` — `for (const [base, coValidate] of candidatesFor(…))`, a
 *    first-match query: it `continue`s on a falsy `coValidate(base)` and `break`s on the first
 *    accepted candidate. Same shape as `pickAt`. Surfaced only once the detector learned object and
 *    nested patterns, which is also how it found `engine/electron/main.ts`'s rejector loop.
 *
 *  ── async-sequential ──
 *  - `runtime/scene/SceneManager.ts` `fireBeforeSwapHooks` — beforeSwap hooks (shader prewarm),
 *    `await`ed one at a time against the STAGING world before the atomic swap. Each is already
 *    isolated with its own `try` + `console.warn`; what the helper cannot do is wait for it.
 *  - `editor/undo/compositeAction.ts` `runSequential` — a batch's undo/redo sub-steps, `await`ed
 *    strictly in order. Failures are COLLECTED and rethrown as one `AggregateError`, so `undo()`
 *    still rejects visibly; a helper that reports and swallows would make a failed undo look done.
 *
 *  ── registration ──
 *  - `engine/tools/modoki-mcp/src/registerAll.ts` `registerAllTools` — the fixed list of tool
 *    GROUPS registered at server start. A throw there is a programming error in a group and must
 *    stop the server loudly: isolating it would start a server with a whole group of tools silently
 *    absent, and a missing tool reads as "not offered", never as broken.
 *
 *  ⚠️ Each row is asserted to still BE DETECTED below — an exemption whose loop was deleted or
 *  migrated goes red rather than lingering as a licence. That re-detection is skipped for a row
 *  whose FILE is absent from the checkout (the public snapshot ships no `games/`); see the ⚠️ on
 *  that test. ⚠️ **A new KIND is a decision, not an append**: it means either the helper needs a
 *  sibling or an exemption is being used to dodge a migration. The two `async-sequential` rows
 *  have DIFFERENT error policies (warn-and-continue vs collect-and-rethrow), so they do not justify
 *  an async helper; a third row sharing one of those policies would. */
type ExemptKind = 'query' | 'async-sequential' | 'registration';
const EXEMPT: Readonly<Record<string, ExemptKind>> = {
  'engine/packages/modoki/src/runtime/core/screenPick.ts :: fn': 'query',
  'engine/packages/modoki/src/runtime/rendering/hitRegions.ts :: fn': 'query',
  'engine/packages/modoki/src/runtime/rendering/interactionHandles.ts :: p': 'query',
  'engine/plugins/load-project-config.ts :: read': 'query',
  'games/wordweave/runtime/stem.ts :: coValidate': 'query',
  'engine/packages/modoki/src/runtime/scene/SceneManager.ts :: hook': 'async-sequential',
  'engine/packages/modoki/src/editor/undo/compositeAction.ts :: step': 'async-sequential',
  'engine/tools/modoki-mcp/src/registerAll.ts :: register': 'registration',
};
const EXEMPT_ROWS: readonly string[] = Object.keys(EXEMPT);

/** The helper IS the implementation — its own loop is the one legitimate instance. */
const HELPER = path.join(REPO, 'engine/packages/modoki/src/runtime/core/notifyListeners.ts');

function scannedFiles(roots: readonly string[] = SCAN_DIRS): Array<{ rel: string; abs: string }> {
  return repoFiles({
    under: [...roots],
    match: (rel) => /\.tsx?$/.test(rel) && !rel.includes('.test.'),
    exclude: ['node_modules', 'dist'],
    floor: 0,   // each caller asserts its own non-vacuity below
  });
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Half 1: a `for…of` over ANY iterable, binding one or more element names.
 *
 *  ⚠️ Deliberately NOT restricted to sets named `listeners`/`subs`/`cbs` — see the header. The
 *  discrimination is entirely Half 2's job: `for (const id of pending) clearTimeout(id)` and
 *  `for (const k of kids) visit(k)` bind an element and do not CALL it, so they do not match.
 *
 *  ⚠️ **And not restricted to a bare identifier either, which is the trap version 2 fell into.**
 *  Having just replaced a NAME-scoped claim, it replaced it with a BINDING-FORM-scoped one:
 *  `for (const [key, fn] of registry) fn(...)` — the standard spelling for a keyed subscriber
 *  registry — matched nothing. That hid `runtime/core/lateUpdate.ts` and `SceneManager`'s
 *  `fireSceneCallbacks`, both of which carry their own hand-rolled isolation, i.e. copies nine and
 *  ten of the convention the helper exists to absorb. Found by review, not by this guard.
 *  A destructured binding contributes EVERY name it binds; Half 2 asks whether any of them is
 *  called. */
const SUBSCRIBER_LOOPS = /for\s*\(\s*const\s+([\w$]+|[[{][^;]*?)\s+of\s+/g;

/** Every identifier a binding brings into scope.
 *
 *  ⚠️ **Deliberately OVER-collects rather than risking a miss.** The two failure directions are not
 *  symmetric here: an extra name can only produce a hit that a human then reads and dismisses,
 *  while a missing name is a fan-out nobody ever sees — which is the failure this guard has now
 *  shipped twice (once scoped by variable NAME, once by BINDING FORM).
 *
 *  Handles, all measured: a plain identifier; array patterns including holes (`[, e]`), defaults
 *  (`[a = noop]` binds `a`, not `noop`) and rest (`[a, ...rest]`); object patterns (`{ fn }`, and
 *  `{ a: b }` binds `b`, not `a`); and nesting in either direction (`[a, { fn }]`,
 *  `[a, [b, fn]]`) — the last of which the previous `\[([^\]]*)\]` could not even match, because
 *  it stopped at the first `]`. `for (const { fn } of …)` is idiomatic in this repo (this very file
 *  uses `for (const { rel, abs } of …)`), so that gap was the one most likely to bite. */
function boundNames(binding: string): string[] {
  const noDefaults = binding.replace(/=\s*[^,\]}]+/g, '');   // `[a = noop]` binds a
  const noKeys = noDefaults.replace(/([\w$]+)\s*:/g, '');     // `{ a: b }` binds b
  return [...noKeys.matchAll(/[\w$]+/g)].map((mm) => mm[0]!);
}

/** The offset just past the `)` that closes this loop's header.
 *
 *  Needed because Half 1 now ends at ` of `, not at `)` — the iterable expression can itself
 *  contain parentheses (`for (const [k, v] of Object.entries(x))`), so the close has to be found by
 *  counting rather than by matching `[^)]+\)`, which is what the old form did and what stopped it
 *  from ever seeing a nested pattern. */
function headerEnd(src: string, from: number): number {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') { depth--; if (depth === 0) return i + 1; }
  }
  return from;
}

/** The `.forEach` spelling of the same thing: `set.forEach((cb) => cb())`. The callback's own
 *  parameter must be the thing invoked, which is what separates it from any other forEach. */
const FOREACH_NOTIFY =
  /\.forEach\s*\(\s*(?:async\s*)?\(?\s*([\w$]+)\s*\)?\s*=>\s*(?:\{\s*)?([\w$]+)\s*\(/g;

/** Half 2: the loop's element is CALLED **inside the loop's own body**.
 *
 *  ⚠️ The body is delimited properly — braces matched, or up to the `;` of a single-statement
 *  loop — NOT a fixed character window. A window was the first version and it was unusable once
 *  Half 1 stopped filtering by name: `for (const id of ids)` paired with an unrelated `entity.id()`
 *  600 characters later, and the guard reported a dozen files that contain no fan-out at all.
 *  The stripper blanks in place rather than deleting, so offsets are the source's own and this
 *  scan is safe to run on them.
 *
 *  The leading `(^|[^\w$.])` is what rejects a METHOD call: `entity.id()` must not count as the
 *  loop variable `id` being invoked. */
/** String and template literals must be blanked before `bodyCallsElement` counts braces, or a `}`
 *  that is DATA closes the loop body early and the fan-out inside it goes unseen. Measured:
 *  `for (const fn of listeners) { log('}'); fn(); }` reported FALSE without this.
 *
 *  ⚠️ **This is `stripCommentsAndStrings`, the repo's shared parser-driven stripper, and reaching
 *  for a private regex here would be a real defect rather than a shortcut.** An earlier version of
 *  this file hand-rolled one — the thirteenth, which `sourceScanner.ts`'s own header rule 1
 *  forbids by name — and it reproduced the exact bug that header records: a lone backtick in JSX
 *  text pairs with the next template's backtick and blanks every line between, `fn();` included.
 *  Measured on the shipped version before the swap: 353 of 880 scanned files had real code blanked
 *  (mostly `${…}` interpolation contents), and `' '.repeat()` over a multi-line template destroyed
 *  the line count that `assertScanIsSane` exists to check. The parser build yields the identical
 *  ledger rows and additionally closes the regex-literal hole the hand-rolled one had to
 *  declare as a blind spot. */
function bodyCallsElement(src: string, from: number, element: string): boolean {
  let i = from;
  while (i < src.length && /\s/.test(src[i]!)) i++;
  let body: string;
  if (src[i] === '{') {
    let depth = 0; let j = i;
    for (; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') { depth--; if (depth === 0) { j++; break; } }
    }
    body = src.slice(i, j);
  } else {
    const end = src.indexOf(';', i);
    body = src.slice(i, end < 0 ? i + 200 : end + 1);
  }
  return new RegExp(`(^|[^\\w$.])${esc(element)}\\s*\\(`).test(body);
}

interface Scanned { file: string; offenders: string[] }

/** `path :: identifier` rows, sorted — the one shape the ledgers and `EXEMPT` are all written in,
 *  so a row can be compared against any of them without a second spelling of the join. */
function rowsFrom(scanned: Scanned[]): string[] {
  return scanned.flatMap((r) => r.offenders.map((o) => `${r.file} :: ${o}`)).sort();
}

/** Remove ONE occurrence per exemption, not every row that matches it.
 *
 *  ⚠️ **A `filter` here is a hole, and it was measured as one.** `hitRegions.ts` contains both the
 *  exempt collect query and a migrated publisher, and BOTH bind `fn` — so the rows are identical
 *  strings and `filter` deleted the publisher's too. Un-migrating that publisher back to a
 *  hand-rolled loop, which is precisely what this guard is for, stayed green. Subtracting one
 *  occurrence leaves the second `hitRegions.ts :: fn` standing, and it goes red.
 *
 *  This is the same `path :: identifier` limitation the header's blind-spot list states; with no
 *  in-scope ledger left, subtracting ONE occurrence is what keeps it narrow. */
function subtractOnce(rows: string[], exemptions: readonly string[]): string[] {
  const budget = new Map<string, number>();
  for (const e of exemptions) budget.set(e, (budget.get(e) ?? 0) + 1);
  const out: string[] = [];
  for (const r of rows) {
    const left = budget.get(r) ?? 0;
    if (left > 0) { budget.set(r, left - 1); continue; }
    out.push(r);
  }
  return out;
}

/** The offenders in ONE comment-and-string-stripped source: both halves of the detector, exactly as
 *  `scan` runs them. A function of its own so the positive control below exercises the SAME code
 *  `scan` does. A control that re-implements the match is not a control, and the #953 phase-3/4
 *  review measured that: disabling the forEach branch in here left the string-regex check green. */
function offendersIn(src: string): string[] {
  const offenders: string[] = [];
  for (const m of src.matchAll(SUBSCRIBER_LOOPS)) {
    const body = headerEnd(src, m.index!);
    for (const name of boundNames(m[1]!)) {
      if (bodyCallsElement(src, body, name)) offenders.push(name);
    }
  }
  for (const m of src.matchAll(FOREACH_NOTIFY)) {
    if (m[1] === m[2]) offenders.push(`${m[1]!} (forEach)`);
  }
  return offenders;
}

function scan(roots: readonly string[] = SCAN_DIRS, dropOverlap = false): Scanned[] {
  const results: Scanned[] = [];
  for (const { rel, abs } of scannedFiles(roots)) {
    if (dropOverlap && insideScanDirs(rel)) continue;   // see `insideScanDirs`
    // ONE parse per file. `stripCommentsAndStrings` blanks comments AND string/template literals
    // in a single pass (it calls `stripComments` itself), so this replaces the `readScannedSource`
    // call that used to sit here — and doing it per LOOP-MATCH instead of per file timed the suite
    // out at 20s, which is how this ended up hoisted rather than tucked inside the predicate.
    const src = stripCommentsAndStrings(fs.readFileSync(abs, 'utf8'), rel);
    results.push({ file: rel, offenders: abs === HELPER ? [] : offendersIn(src) });
  }
  return results;
}

describe('every fan-out-shaped loop is migrated or exempt (#888, #953)', () => {
  it('SCAN_DIRS itself is non-vacuous (the floor moved onto the callers)', () => {
    expect(scannedFiles().length, 'the SCAN_DIRS corpus collapsed — every check below would pass '
      + 'having read nothing').toBeGreaterThan(500);
    // Its own floor, because the total cannot see it: measured in #953's phase-5/7 review, narrowing
    // the file filter to `.ts` left every check green (the `.ts` files clear the 500 floor alone)
    // while every `.tsx` file — the editor panels, where seven fan-outs lived — dropped out.
    expect(scannedFiles().filter(({ rel }) => rel.endsWith('.tsx')).length,
      'no .tsx file is being scanned — every editor panel is invisible to this guard').toBeGreaterThan(50);
  });

  it('detects the positive case at all — the helper itself would match but for the exemption', () => {
    // Without this, a regex that silently stopped matching would make the whole file green while
    // testing nothing. The helper carries the ONE legitimate hand-rolled loop, so it is the
    // natural positive control: exempt in `scan`, but the detector must still fire on it.
    const src = stripCommentsAndStrings(fs.readFileSync(HELPER, 'utf8'), 'notifyListeners.ts');
    const hits = [...src.matchAll(SUBSCRIBER_LOOPS)]
      .filter((m) => boundNames(m[1]!).some((n) => bodyCallsElement(src, headerEnd(src, m.index!), n)));
    expect(hits.length, 'the detector no longer fires on the helper\'s own loop — it has stopped '
      + 'detecting anything, and every other assertion in this file is now vacuous').toBe(1);

    // The forEach half needs its own control: it shares no code with the loop half, so a green
    // file proves nothing about it. This fixture is the exact spelling found in `traitClipboard`,
    // `gameRegistry` and `spriteMaterialCache` — all three invisible to the first version.
    const positive = 'listeners.forEach((l) => l());';
    const negative = 'rows.forEach((r) => render(r));';
    expect([...positive.matchAll(FOREACH_NOTIFY)].filter((m) => m[1] === m[2]).length).toBe(1);
    expect([...negative.matchAll(FOREACH_NOTIFY)].filter((m) => m[1] === m[2]).length).toBe(0);
  });

  it('the detector `scan` runs fires on BOTH spellings — a positive control through the real path', () => {
    // Measured in #953's phase-3/4 review: with the forEach branch inside `scan` disabled, every
    // control above stayed green, and only ledger rows that happened to use `.forEach` went red.
    // #953 migrated the last of those, so without this control the forEach half could stop firing
    // and the whole guard would still pass.
    const fixture = stripCommentsAndStrings([
      'for (const fn of listeners) { fn(); }',
      'subs.forEach((cb) => cb(1));',
      'rows.forEach((r) => render(r));',
      'for (const id of ids) { clearTimeout(id); }',
    ].join('\n'), 'fixture.ts');
    expect(offendersIn(fixture)).toEqual(['fn', 'cb (forEach)']);

    // And through the TSX parse, with JSX around the loop: the panels' effect-cleanup shape.
    const tsx = stripCommentsAndStrings([
      'export function Panel() {',
      '  useEffect(() => { return () => { for (const off of offs) off(); }; }, []);',
      '  return <div className="row">{items.map((i) => <span key={i}>{i}</span>)}</div>;',
      '}',
    ].join('\n'), 'fixture.tsx');
    expect(offendersIn(tsx)).toEqual(['off']);
  });

  it('SCAN_DIRS holds no hand-rolled fan-out outside EXEMPT', () => {
    const offenders = subtractOnce(rowsFrom(scan()), EXEMPT_ROWS);
    expect(offenders, 'A callback fan-out was hand-rolled instead of going through '
      + '`runtime/core/notifyListeners.ts`. That is #888: the publisher mutates its state before '
      + 'it fans out, so one throwing callback commits the mutation, starves every callback '
      + 'behind it, and aborts the publisher\'s own tail. Call `notifyListeners(set, label, args)`; '
      + 'pass a `report` only if the publisher cannot reach `console.error` safely or must name the '
      + 'failing entry. If the loop genuinely cannot be expressed that way, argue it into EXEMPT '
      + 'with its kind.')
      .toEqual([]);
  });

  it('every EXEMPT row is still DETECTED — an exemption cannot go stale into a licence', () => {
    // The literal-vs-literal version of this test only pinned the constant: an exemption whose loop
    // had been deleted or migrated stayed green and kept excusing whatever replaced it. This asks
    // the DETECTOR instead, so the exemption has to keep earning itself.
    const detected = new Set([
      ...rowsFrom(scan()),
      ...rowsFrom(scan(UNSCANNED_ROOTS, true)),
    ]);
    // ⚠️ **A row whose FILE is not in this checkout cannot be re-detected, and that is not a stale
    // exemption** — it is the public engine snapshot, which ships `engine build docs` and no
    // `games/`, so `games/wordweave/runtime/stem.ts` is absent by design. Exactly the #830 class
    // `expectedLedgerRows` exists for, and it went red here at `verify:publish` on the hub merge —
    // the only place these guards run inside the snapshot. That helper cannot be reused as-is:
    // most EXEMPT rows sit INSIDE `SCAN_DIRS`, where it throws on purpose.
    const missing = EXEMPT_ROWS.filter((row) => !fs.existsSync(path.join(REPO, row.split(' :: ')[0]!)));
    // The floor that stops the filter draining the loop into a no-op: an EXEMPT row inside
    // SCAN_DIRS is present in ANY checkout that runs this guard at all — the non-vacuity
    // assertion above already vouches for that corpus — so its absence is a broken checkout
    // rather than a legitimate subset, and must fail rather than be filtered away.
    expect(missing.filter((row) => insideScanDirs(row.split(' :: ')[0]!)),
      'an EXEMPT row INSIDE SCAN_DIRS names a file this checkout does not have — the corpus is '
      + 'broken, and dropping the row would leave this test checking nothing').toEqual([]);
    for (const row of EXEMPT_ROWS.filter((r) => !missing.includes(r))) {
      expect(detected.has(row), `EXEMPT row "${row}" is no longer detected — the loop it excuses is `
        + 'gone or migrated, so the row is now a blanket licence for whatever takes its place. '
        + 'Delete it.').toBe(true);
    }
  });

  it('a `}` inside a string literal does not truncate the loop body', () => {
    // Measured before `blankLiterals` existed: this exact body reported FALSE, so a hand-rolled
    // fan-out whose body happened to contain a brace in a string was invisible.
    const withBrace = 'for (const fn of listeners) { log(\'}\'); fn(); }';
    const plain = 'for (const fn of listeners) { fn(); }';
    const negative = 'for (const fn of listeners) { other(); }';
    for (const [src, expected] of [[withBrace, true], [plain, true], [negative, false]] as const) {
      const stripped = stripCommentsAndStrings(src, 'fixture.ts');
      const m = [...src.matchAll(SUBSCRIBER_LOOPS)][0]!;
      expect(bodyCallsElement(stripped, headerEnd(src, m.index!), 'fn'), src).toBe(expected);
    }
  });

  it('reads every destructuring shape — object, nested, holes, defaults, rest', () => {
    // The three rows marked MISS here were measured on the previous version and are what the
    // object-pattern widening bought: `{ fn }` matched nothing at all (and it is idiomatic — this
    // very file uses `for (const { rel, abs } of …)`), and `[a, [b, fn]]` could not match because
    // the old `\[([^\]]*)\]` stopped at the first `]`. Both would have hidden a fan-out silently,
    // which is the failure this guard has now shipped twice.
    const cases: Array<[string, string[]]> = [
      ['for (const { fn } of listeners) { fn(); }', ['fn']],                      // was: no match
      ['for (const [key, { fn }] of x) { fn(); }', ['key', 'fn']],                // was: MISS
      ['for (const [a, [b, fn]] of x) { fn(); }', ['a', 'b', 'fn']],              // was: no match
      ['for (const { a: fn } of x) { fn(); }', ['fn']],
      ['for (const [a = noop] of x) { a(); }', ['a']],
      ['for (const [, e] of x) { e(); }', ['e']],
      ['for (const [a, ...rest] of x) { a(); }', ['a', 'rest']],
    ];
    for (const [src, expected] of cases) {
      const m = [...src.matchAll(SUBSCRIBER_LOOPS)][0];
      expect(m, `Half 1 does not match: ${src}`).toBeDefined();
      expect(boundNames(m![1]!), src).toEqual(expected);
      expect(boundNames(m![1]!).some((n) => bodyCallsElement(src, headerEnd(src, m!.index!), n)), src)
        .toBe(true);
    }
  });

  it('an iterable containing parentheses does not truncate the header', () => {
    // Half 1 now ends at ` of `, so the loop body starts after a COUNTED `)` rather than the first
    // one. `Object.entries(x)` is the shape that breaks the naive version.
    const src = 'for (const [k, fn] of Object.entries(reg)) { fn(); }';
    const m = [...src.matchAll(SUBSCRIBER_LOOPS)][0]!;
    expect(bodyCallsElement(src, headerEnd(src, m.index!), 'fn')).toBe(true);
  });

  it('reads a DESTRUCTURED binding — the keyed-registry spelling', () => {
    // The blind spot that hid `lateUpdate` and `fireSceneCallbacks` from version 2 of this guard.
    const keyed = 'for (const [key, fn] of registry) { fn(world); }';
    const m = [...keyed.matchAll(SUBSCRIBER_LOOPS)][0];
    expect(m, 'Half 1 no longer matches a destructured binding').toBeDefined();
    expect(boundNames(m![1]!)).toEqual(['key', 'fn']);
    expect(boundNames(m![1]!).some((n) => bodyCallsElement(keyed, headerEnd(keyed, m!.index!), n)))
      .toBe(true);
    // …and the key being unused must not by itself make it a hit.
    const notAFanout = 'for (const [key, row] of registry) { render(row, key); }';
    const m2 = [...notAFanout.matchAll(SUBSCRIBER_LOOPS)][0]!;
    expect(boundNames(m2[1]!).some((n) => bodyCallsElement(notAFanout, headerEnd(notAFanout, m2.index!), n)))
      .toBe(false);
  });

  it('the roots this guard does NOT scan hold exactly the KNOWN fan-outs', () => {
    // The guard's OWN detector over the unscanned roots, so this cannot drift from what the real
    // check would say. A first instance out there fails here rather than joining a silent
    // population.
    const outside = subtractOnce(rowsFrom(scan(UNSCANNED_ROOTS, true)), EXEMPT_ROWS);
    expect(scannedFiles(UNSCANNED_ROOTS).filter(({ rel }) => !insideScanDirs(rel)).length,
      'the unscanned-roots corpus is empty — this assertion would pass having examined nothing')
      .toBeGreaterThan(50);
    expect(outside, 'The set of hand-rolled notification loops OUTSIDE SCAN_DIRS changed. Decide '
      + 'deliberately whether the new one migrates onto the shared helper or joins the ledger '
      + 'with a reason. One DISAPPEARING is good news: drop its ledger entry in the same commit.')
      .toEqual(expectedOutsideRows());
  });
});
