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
 *   - **A `.forEach` whose callback is not written inline** — `subs.forEach(dispatch)`, or a
 *     callback bound first and passed by name. Only an arrow or function expression is read; the
 *     multi-parameter and non-first-statement spellings are read since #1241.
 *   - **Rows are `path :: identifier`, not line numbers.** While the `KNOWN_UNMIGRATED` ledger
 *     existed this was a real hole: one file could hold several identical rows (each event bus did,
 *     one per emitter), so migrating one of a same-named pair while adding a NEW loop with the same
 *     loop variable kept the equality green. With no in-scope ledger the expected set is empty and
 *     each EXEMPT row SPENDS one occurrence (`assertExemptionLedger`), so a second same-named loop in an
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
import path from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';
import { callsTo, declarationOf, findNodes, parseSource, unwrapValue, ts } from '@modoki/engine/testing/sourceAst';
import { assertExemptionLedger } from '@modoki/engine/testing/exemptionLedger';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
import { deriveUnscannedRoots } from '../helpers/unscannedRoots';
import { hasInternalGames } from '../helpers/repoLayout';

const REPO = path.resolve(__dirname, '../../..');

const SCAN_DIRS = [
  'engine/packages/modoki/src/runtime',
  'engine/packages/modoki/src/editor',
  'engine/app',
];

/* ⚠️ **No `KNOWN_OUTSIDE_SCAN_DIRS` ledger (#1140).** It was EMPTY since #953 migrated the last four
 *  outside SCAN_DIRS (`engine/electron/main.ts`, Court's reload-blocker disposers and cloud-sync
 *  resolvers, `games/llm-test`'s progress callbacks), kept so a new instance there would be a
 *  decision. The shared ledger below makes it one without an empty list: a fan-out in `games/`,
 *  `demos/`, `engine/electron` or `engine/plugins` is unexcused, so it migrates or argues its way into
 *  EXEMPT. A game CAN reach the helper — it is a deep export
 *  (`@modoki/engine/runtime/core/notifyListeners`), as `games/sling` and `games/court` use it;
 *  `engine/electron` reaches it by relative path, as `main.ts` already imports engine source. */

// There is no in-SCAN_DIRS ledger any more. #888 migrated 36 sites and pinned the remaining ~40
// row by row as `KNOWN_UNMIGRATED`; #953 migrated or exempted every one, so inside SCAN_DIRS a
// fan-out-shaped loop is now either on the helper or on `EXEMPT` below, and nothing else is legal.

const UNSCANNED_ROOTS: readonly string[] = deriveUnscannedRoots(SCAN_DIRS);

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
 *  - `runtime/core/screenBounds.ts` `collectScreenBounds` — a COLLECT query, `interactionHandles`'
 *    shape: each provider RETURNS bounds, spread into the result, inside its own skip-on-throw `try`.
 *  - `editor/panels/assetEditorBindings.ts` — `PARKED_MOVE_REPAIRS`, a fixed table of repairers
 *    each RETURNING the notes it produced. Not a subscriber set at all.
 *
 *  Both were invisible to the text detector until #1241: the element is called inside a spread
 *  (`...p(set)`), and the regex refused a call preceded by `.` so as not to read `entity.id()`.
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
 *  - `engine/packages/modoki/src/runtime/core/adLifecycle.ts` `init` — the ad SDK's native listeners,
 *    `await`ed one at a time and published only once EVERY registration succeeded (Court #458's
 *    duplicate-revenue-listener fix). A failure unwinds the ones already made; isolating each would
 *    publish a half-registered set.
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
  'engine/packages/modoki/src/runtime/core/screenBounds.ts :: p': 'query',
  'engine/packages/modoki/src/editor/panels/assetEditorBindings.ts :: repair': 'query',
  'engine/plugins/load-project-config.ts :: read': 'query',
  'games/wordweave/runtime/stem.ts :: coValidate': 'query',
  'engine/packages/modoki/src/runtime/scene/SceneManager.ts :: hook': 'async-sequential',
  'engine/packages/modoki/src/editor/undo/compositeAction.ts :: step': 'async-sequential',
  'engine/tools/modoki-mcp/src/registerAll.ts :: register': 'registration',
  'engine/packages/modoki/src/runtime/core/adLifecycle.ts :: register': 'registration',
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

/** Every identifier a binding brings into scope, read off the binding NODE (#1241).
 *
 *  ⚠️ **Not restricted to a bare identifier, which is the trap version 2 fell into.** Having just
 *  replaced a NAME-scoped claim, it replaced it with a BINDING-FORM-scoped one:
 *  `for (const [key, fn] of registry) fn(...)` — the standard spelling for a keyed subscriber
 *  registry — matched nothing. That hid `runtime/core/lateUpdate.ts` and `SceneManager`'s
 *  `fireSceneCallbacks`, both of which carry their own hand-rolled isolation, i.e. copies nine and
 *  ten of the convention the helper exists to absorb. Found by review, not by this guard.
 *
 *  Every shape is the parser's: a plain identifier; array patterns with holes (`[, e]`), defaults
 *  (`[a = noop]` binds `a`, not `noop`) and rest; object patterns (`{ a: b }` binds `b`); nesting
 *  either way. The text version before #1241 was a regex over the binding's text that had to
 *  over-collect to be safe; a name that is not bound is now simply not returned. */
function boundIdentifiers(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name];
  return name.elements.flatMap((e) => (ts.isOmittedExpression(e) ? [] : boundIdentifiers(e.name)));
}

/** Half 2: `body` CALLS the binding `id` declares — `fn(…)`, `fn?.(…)`, `(fn as F)(…)`.
 *
 *  ⚠️ **By symbol, not by name (#1241).** The body is the loop's or callback's own NODE, so a `}`
 *  inside a string cannot end it early (measured before the literal blanking existed:
 *  `for (const fn of listeners) { log('}'); fn(); }` read FALSE) and a single-statement body cannot
 *  run on to the next `;`. And the callee has to RESOLVE to this binding: a nested function's own
 *  `fn` parameter called inside the loop is not the loop's element. A method call (`entity.id()`)
 *  is not a call of `id` at all — its callee is a property access, not the identifier. */
function callsBinding(body: ts.Node, id: ts.Identifier): boolean {
  return findNodes(body, ts.isCallExpression).some((c) => {
    const callee = unwrapValue(c.expression);
    return ts.isIdentifier(callee) && callee.text === id.text && declarationOf(callee) === id.parent;
  });
}

interface Scanned { file: string; offenders: string[] }

/** `path :: identifier` rows, sorted — the one shape the ledgers and `EXEMPT` are all written in,
 *  so a row can be compared against any of them without a second spelling of the join. */
function rowsFrom(scanned: Scanned[]): string[] {
  return scanned.flatMap((r) => r.offenders.map((o) => `${r.file} :: ${o}`)).sort();
}

/** The offenders in ONE parsed source: both halves of the detector, exactly as `scan` runs them. A
 *  function of its own so the positive controls below exercise the SAME code `scan` does. A control
 *  that re-implements the match is not a control, and the #953 phase-3/4 review measured that:
 *  disabling the forEach branch in here left the string-regex check green.
 *
 *  Half 1 is a `for…of` over ANY iterable, binding one or more element names — deliberately NOT
 *  restricted to sets named `listeners`/`subs`/`cbs` (see the header). The discrimination is Half 2's
 *  job: `for (const id of pending) clearTimeout(id)` binds an element and does not CALL it.
 *
 *  The `.forEach` spelling is the same pair: a callback PARAMETER that the callback calls —
 *  `set.forEach((cb) => cb())`, a `function (cb) {…}`, a `(fn, key) => fn()` over a Map, or a call
 *  that is not the body's first statement. The regex before #1241 saw only the first of those. */
function offendersIn(code: string, label: string): string[] {
  const sf = parseSource(code, label);
  const loops = findNodes(sf, ts.isForOfStatement).flatMap((loop) => {
    const init = loop.initializer;
    if (!ts.isVariableDeclarationList(init)) return [];
    return init.declarations.flatMap((d) => boundIdentifiers(d.name))
      .filter((id) => callsBinding(loop.statement, id)).map((id) => id.text);
  });
  const forEachs = callsTo(sf, 'forEach').flatMap((call) => {
    const cb = call.arguments[0] && unwrapValue(call.arguments[0]);
    if (!ts.isPropertyAccessExpression(call.expression) || !cb || !(ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) return [];
    return cb.parameters.flatMap((p) => boundIdentifiers(p.name))
      .filter((id) => callsBinding(cb.body, id)).map((id) => `${id.text} (forEach)`);
  });
  return [...loops, ...forEachs];
}

function scan(roots: readonly string[] = SCAN_DIRS, dropOverlap = false): Scanned[] {
  const results: Scanned[] = [];
  for (const { rel, abs } of scannedFiles(roots)) {
    if (dropOverlap && insideScanDirs(rel)) continue;   // see `insideScanDirs`
    // ONE parse per file, of the comment-blanked text: a string is a node, so literals no longer need
    // blanking — `stripCommentsAndStrings` did that only so a brace count could not read them (#1241).
    results.push({ file: rel, offenders: abs === HELPER ? [] : offendersIn(readScannedSource(abs).code, rel) });
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
    const hits = offendersIn(readScannedSource(HELPER).code, 'notifyListeners.ts');
    expect(hits.length, 'the detector no longer fires on the helper\'s own loop — it has stopped '
      + 'detecting anything, and every other assertion in this file is now vacuous').toBe(1);

    // The forEach half needs its own control: it shares no code with the loop half, so a green
    // file proves nothing about it. This fixture is the exact spelling found in `traitClipboard`,
    // `gameRegistry` and `spriteMaterialCache` — all three invisible to the first version.
    expect(offendersIn('listeners.forEach((l) => l());', 'fixture.ts')).toEqual(['l (forEach)']);
    expect(offendersIn('rows.forEach((r) => render(r));', 'fixture.ts')).toEqual([]);
  });

  it('the detector `scan` runs fires on BOTH spellings — a positive control through the real path', () => {
    // Measured in #953's phase-3/4 review: with the forEach branch inside `scan` disabled, every
    // control above stayed green, and only ledger rows that happened to use `.forEach` went red.
    // #953 migrated the last of those, so without this control the forEach half could stop firing
    // and the whole guard would still pass.
    const fixture = [
      'for (const fn of listeners) { fn(); }',
      'subs.forEach((cb) => cb(1));',
      'rows.forEach((r) => render(r));',
      'for (const id of ids) { clearTimeout(id); }',
    ].join('\n');
    expect(offendersIn(fixture, 'fixture.ts')).toEqual(['fn', 'cb (forEach)']);

    // And through the TSX parse, with JSX around the loop: the panels' effect-cleanup shape.
    const tsx = [
      'export function Panel() {',
      '  useEffect(() => { return () => { for (const off of offs) off(); }; }, []);',
      '  return <div className="row">{items.map((i) => <span key={i}>{i}</span>)}</div>;',
      '}',
    ].join('\n');
    expect(offendersIn(tsx, 'fixture.tsx')).toEqual(['off']);
  });

  it('no hand-rolled fan-out inside SCAN_DIRS or the unscanned roots beyond EXEMPT — and every row still earns itself', () => {
    // ⚠️ **One ledger since #1140, replacing three hand-rolled halves**: a `subtractOnce` over the
    // SCAN_DIRS rows, a "still detected" re-scan for staleness, and a second `subtractOnce` over the
    // unscanned roots compared for exact equality with an (empty) KNOWN_OUTSIDE_SCAN_DIRS. Spending
    // EXEMPT against the union of the two scans states every direction at once: a new loop is unexcused
    // (inside or out), and a migrated/deleted one leaves its row blessing more than exists.
    // `path :: identifier` rows still collide within a file — the header's blind spot — and the
    // count is what keeps that narrow (`hitRegions.ts :: fn` binds twice; see `subtractOnce`'s
    // history in git).
    // ⚠️ Absent by LAYOUT, not by existence (#1140 close-out review): `fs.existsSync` would also drop a
    // row whose file was RENAMED or deleted in a root this checkout ships, silencing the very
    // staleness the ledger is for. Only `games/` is absent from the public snapshot.
    const missing = EXEMPT_ROWS.filter((row) => !hasInternalGames() && row.startsWith('games/'));
    // ⚠️ A row whose FILE is not in this checkout cannot be detected, and that is not stale — it is
    // the public snapshot, which ships no `games/` (`games/wordweave/runtime/stem.ts`). But a row
    // INSIDE SCAN_DIRS is present in any checkout that runs this guard at all, so its absence is a
    // broken corpus and must fail rather than be filtered away.
    expect(missing.filter((row) => insideScanDirs(row.split(' :: ')[0]!)),
      'an EXEMPT row INSIDE SCAN_DIRS names a file this checkout does not have — the corpus is '
      + 'broken, and dropping the row would leave this test checking nothing').toEqual([]);
    const rowBudget = (rows: readonly string[]) => [...new Set(rows)].map((row) => ({
      item: row, count: rows.filter((r) => r === row).length,
    }));
    assertExemptionLedger({
      label: 'EXEMPT in notifyIsShared',
      population: [...rowsFrom(scan()), ...rowsFrom(scan(UNSCANNED_ROOTS, true))].map((row) => ({ item: row, site: row })),
      exempt: [
        ...rowBudget(EXEMPT_ROWS.filter((r) => !missing.includes(r))).map((e) => ({ ...e, reason: `exempt: ${EXEMPT[e.item]}` })),
      ],
      floor: 1,
      fix: 'A callback fan-out was hand-rolled instead of going through '
        + '`runtime/core/notifyListeners.ts`. That is #888: the publisher mutates its state before '
        + 'it fans out, so one throwing callback commits the mutation, starves every callback '
        + 'behind it, and aborts the publisher\'s own tail. Call `notifyListeners(set, label, args)`; '
        + 'pass a `report` only if the publisher cannot reach `console.error` safely or must name the '
        + 'failing entry. If the loop genuinely cannot be expressed that way, argue it into EXEMPT '
        + 'with its kind. A row blessing more than exists is good news: drop it in the same commit.',
    });
  });

  it('a `}` inside a string literal does not truncate the loop body', () => {
    // Measured before `blankLiterals` existed: this exact body reported FALSE, so a hand-rolled
    // fan-out whose body happened to contain a brace in a string was invisible. The body is a node
    // now; the case stays because it is the hazard a text reader of this shape fails.
    expect(offendersIn('for (const fn of listeners) { log(\'}\'); fn(); }', 'fixture.ts')).toEqual(['fn']);
    expect(offendersIn('for (const fn of listeners) { fn(); }', 'fixture.ts')).toEqual(['fn']);
    expect(offendersIn('for (const fn of listeners) { other(); }', 'fixture.ts')).toEqual([]);
  });

  it('reads every destructuring shape — object, nested, holes, defaults, rest', () => {
    // The rows marked "was" were measured on earlier versions: `{ fn }` matched nothing at all (and it
    // is idiomatic — this very file uses `for (const { rel, abs } of …)`), and `[a, [b, fn]]` could not
    // match because an old `\[([^\]]*)\]` stopped at the first `]`. Both hid a fan-out silently.
    const cases: Array<[string, string[], string[]]> = [
      ['for (const { fn } of listeners) { fn(); }', ['fn'], ['fn']],               // was: no match
      ['for (const [key, { fn }] of x) { fn(); }', ['key', 'fn'], ['fn']],         // was: MISS
      ['for (const [a, [b, fn]] of x) { fn(); }', ['a', 'b', 'fn'], ['fn']],       // was: no match
      ['for (const { a: fn } of x) { fn(); }', ['fn'], ['fn']],
      ['for (const [a = noop] of x) { a(); }', ['a'], ['a']],
      ['for (const [a = noop] of x) { noop(); }', ['a'], []],                       // a default is not bound
      ['for (const [, e] of x) { e(); }', ['e'], ['e']],
      ['for (const [a, ...rest] of x) { a(); }', ['a', 'rest'], ['a']],
    ];
    for (const [src, bound, called] of cases) {
      const loop = findNodes(parseSource(src, 'fixture.ts'), ts.isForOfStatement)[0]!;
      const decl = (loop.initializer as ts.VariableDeclarationList).declarations[0]!;
      expect(boundIdentifiers(decl.name).map((id) => id.text), src).toEqual(bound);
      expect(offendersIn(src, 'fixture.ts'), src).toEqual(called);
    }
  });

  it('an iterable containing parentheses does not truncate the header', () => {
    // `Object.entries(x)` is the shape that broke the naive header match.
    expect(offendersIn('for (const [k, fn] of Object.entries(reg)) { fn(); }', 'fixture.ts')).toEqual(['fn']);
  });

  it('reads a DESTRUCTURED binding — the keyed-registry spelling', () => {
    // The blind spot that hid `lateUpdate` and `fireSceneCallbacks` from version 2 of this guard.
    expect(offendersIn('for (const [key, fn] of registry) { fn(world); }', 'fixture.ts')).toEqual(['fn']);
    // …and the key being unused must not by itself make it a hit.
    expect(offendersIn('for (const [key, row] of registry) { render(row, key); }', 'fixture.ts')).toEqual([]);
  });

  it('asks whether the LOOP\'S binding is called, not a same-named one (#1241)', () => {
    // A nested function's own `fn` parameter shadows the loop element; calling it is not a fan-out.
    expect(offendersIn('for (const fn of listeners) { wrap((fn) => fn()); }', 'fixture.ts')).toEqual([]);
    // A method named like the element is not a call of it.
    expect(offendersIn('for (const id of ids) { entity.id(); }', 'fixture.ts')).toEqual([]);
    // A single-statement body ends where the statement does, not at the next `;` in the file.
    expect(offendersIn('for (const fn of listeners) other(fn)\nfn();', 'fixture.ts')).toEqual([]);
    // Optional call and a cast still call it.
    expect(offendersIn('for (const fn of listeners) { fn?.(); }', 'fixture.ts')).toEqual(['fn']);
    expect(offendersIn('for (const fn of listeners) { (fn as F)(); }', 'fixture.ts')).toEqual(['fn']);
  });

  it('reads the forEach spellings the single-parameter regex could not (#1241)', () => {
    expect(offendersIn('subs.forEach(function (cb) { cb(); });', 'fixture.ts')).toEqual(['cb (forEach)']);
    // A parameter other than the first — the element `(cb, i)` spelling's mirror.
    expect(offendersIn('pairs.forEach((key, fn) => fn(key));', 'fixture.ts')).toEqual(['fn (forEach)']);
    expect(offendersIn('subs.forEach((cb) => { log(); cb(); });', 'fixture.ts')).toEqual(['cb (forEach)']);
    expect(offendersIn('subs.forEach(({ fn }) => fn());', 'fixture.ts')).toEqual(['fn (forEach)']);
    // A forEach that is not a method call, and a callback that only passes its element on.
    expect(offendersIn('forEach((cb) => cb());\nrows.forEach((r) => use(r));', 'fixture.ts')).toEqual([]);
  });

  it('the roots this guard does NOT scan are really scanned — the ledger above is not vacuous there', () => {
    expect(scannedFiles(UNSCANNED_ROOTS).filter(({ rel }) => !insideScanDirs(rel)).length,
      'the unscanned-roots corpus is empty — the outside half of the ledger would pass having examined nothing')
      .toBeGreaterThan(50);
  });
});
