/**
 * Every loop in SCAN_DIRS that matches the fan-out SHAPE is accounted for in exactly one of three
 * buckets: migrated onto `runtime/core/notifyListeners.ts`, on this file's `KNOWN_UNMIGRATED`
 * ledger, or on its `EXEMPT` list as a shape the helper cannot express (#888).
 *
 * Measured at the time of writing: **36 call sites migrated, 41 ledger rows inside SCAN_DIRS,
 * 5 outside, 4 exempt** — ~85 instances of the shape in total.
 *
 * ⚠️ **That is deliberately weaker than "the helper is the only one", which is what this header
 * claimed when it landed, and it was false.** See § "What the close-out sweep found" below: the
 * detector was scoped by variable NAME, the real population is roughly three times the size the
 * census reported, and 41 rows are on the ledger rather than migrated.
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
 *   - **Ledger rows are `path :: identifier`, and six are extra copies of a row already present**
 *     (41 rows, 35 distinct: `activeRenderer.ts :: fn` ×2, `spriteMaterialCache.ts :: cb` ×2,
 *     `physicsEventBus.ts :: cb` ×3, `timelineEventBus.ts :: cb` ×3). So migrating ONE of a same-named pair while adding a NEW hand-rolled loop
 *     with the same loop variable in the same file keeps the equality green. Line numbers would
 *     close it and would churn on every unrelated edit above them; the trade was made knowingly.
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

/** Hand-rolled fan-outs known to live OUTSIDE SCAN_DIRS.
 *
 *  Kept as an explicit ledger rather than a bare `toEqual([])` so that a NEW instance appearing in
 *  `games/`, `demos/`, `engine/electron` or `engine/plugins` is a decision someone makes on
 *  purpose — migrate it, or write down why it stays.
 *
 *  None is this change's to migrate. `games/court/**` is `work-ai2`'s lane (CLAUDE.md
 *  § Clones: the Role column is a standing subject assignment, not a description), `games/llm-test`
 *  is a fixture, and `engine/tools/modoki-mcp` is the MCP server rather than engine runtime — the
 *  same reason `SCAN_DIRS` stops where it does. A game CAN reach the helper: it is a deep export
 *  (`@modoki/engine/runtime/core/notifyListeners`), which is how `games/sling`'s two stores
 *  migrated in this change. */
const KNOWN_OUTSIDE_SCAN_DIRS: readonly string[] = [
  // ⚠️ A REAL one, and the object-pattern widening is what surfaced it: a teardown fan-out over
  // pending promise rejectors, unguarded, that also skips `pendingRenderer.clear()` on the line
  // after it. Electron MAIN process — outside SCAN_DIRS because the helper is browser-side engine
  // code, though it has zero imports and `@modoki/engine/runtime/core/notifyListeners` is a deep
  // export, so migrating it is possible and just is not this change's call to make.
  'engine/electron/main.ts :: reject',
  'engine/tools/modoki-mcp/src/registerAll.ts :: register',
  'games/court/runtime/cloudSyncWiring.ts :: r (forEach)',
  'games/court/runtime/systems.ts :: dispose',
  'games/llm-test/runtime/services/CapacitorLLMService.ts :: cb',
];

/** ⚠️ **Hand-rolled fan-outs still INSIDE `SCAN_DIRS`, not yet migrated.**
 *
 *  36 call sites were migrated in #888. These 41 rows were found afterwards, by this guard's own close-out
 *  sweep, once the name-scoped detector was replaced with a shape-scoped one — see the header.
 *  They are pinned rather than migrated for two reasons, and neither is "they are fine":
 *
 *  - **Authorised scope.** The change was approved as "all 23 sites" against a census that turned
 *    out to be wrong by roughly 3x. Tripling a landed change inside a finishing pass is exactly
 *    the refactor `/close-out` § 1a says not to absorb.
 *  - **Two of these groups are not one decision.** The three event buses
 *    (`zoneEventBus` / `physicsEventBus` / `timelineEventBus`) are one factory shape each feeding
 *    singletons — #851 already says whoever fixes them should fix the FACTORY's contract once
 *    rather than three suites separately. And the `off` loops in the `.tsx` panels are React
 *    effect cleanups, whose severity and idiom differ from a publisher notifying subscribers.
 *
 *  What the pin buys: a FORTY-SECOND instance fails immediately instead of joining a silent
 *  population, which is the state that let this class reach ~85 sites unnoticed.
 *  ⚠️ It also goes red when one of these is legitimately MIGRATED — that is intended. Removing a
 *  row is a deliberate edit in the same commit as the migration.
 *
 *  Filed as #953 (family/one-entry-point); do not fix these one at a time. */
const KNOWN_UNMIGRATED: readonly string[] = [
  // ⚠️ These two were invisible until the detector learned to read a DESTRUCTURED binding, and
  // both carry their own hand-rolled isolation — copies nine and ten of the convention. They are
  // ledgered rather than migrated because each wants something `notifyListeners` does not have:
  // `lateUpdate` names the failing system in its report (`system "${key}" threw`), which
  // `report(label, err)` cannot express — it receives no per-entry handle. That one is a real
  // contract question for #953.
  //
  // ⚠️ `fireSceneCallbacks` is the WEAKER of the two, and saying so is the point: its pattern
  // filter is NOT a blocker, because `notifyListeners` takes an `Iterable`, so the caller can
  // filter and map to callbacks itself. What actually stops it here is only that its report is a
  // `console.warn` with its own wording. An earlier version of this comment claimed the filter
  // needed a contract change; it does not, and #953's designer should not be handed a parameter
  // nobody needs.
  'engine/packages/modoki/src/runtime/core/lateUpdate.ts :: fn',
  'engine/packages/modoki/src/runtime/scene/SceneManager.ts :: cb',
  'engine/app/ota.ts :: l (forEach)',
  'engine/app/subgameLoader.ts :: l (forEach)',
  'engine/packages/modoki/src/editor/EditorApp.tsx :: off',
  'engine/packages/modoki/src/editor/animation/poseClip.ts :: cb',
  'engine/packages/modoki/src/editor/createEditor.tsx :: l',
  'engine/packages/modoki/src/editor/panels/AnimationEditor.tsx :: off',
  'engine/packages/modoki/src/editor/panels/Hierarchy.tsx :: off',
  'engine/packages/modoki/src/editor/panels/SceneView.tsx :: off',
  'engine/packages/modoki/src/editor/panels/SkinCanvas.tsx :: off',
  'engine/packages/modoki/src/editor/panels/SpriteEditor.tsx :: off',
  'engine/packages/modoki/src/editor/panels/TimelineEditor.tsx :: off',
  'engine/packages/modoki/src/editor/undo/compositeAction.ts :: step',
  'engine/packages/modoki/src/editor/undo/undoManager.ts :: l',
  'engine/packages/modoki/src/runtime/audio/audioService.ts :: fn',
  'engine/packages/modoki/src/runtime/core/activeRenderer.ts :: fn',
  'engine/packages/modoki/src/runtime/core/activeRenderer.ts :: fn',
  'engine/packages/modoki/src/runtime/core/renderDirty.ts :: fn',
  'engine/packages/modoki/src/runtime/loaders/assetManifest.ts :: fn',
  'engine/packages/modoki/src/runtime/loaders/meshTemplateCache.ts :: fn',
  'engine/packages/modoki/src/runtime/loaders/spriteMaterialCache.ts :: cb',
  'engine/packages/modoki/src/runtime/loaders/spriteMaterialCache.ts :: cb',
  'engine/packages/modoki/src/runtime/physics/physicsEventBus.ts :: cb',
  'engine/packages/modoki/src/runtime/physics/physicsEventBus.ts :: cb',
  'engine/packages/modoki/src/runtime/physics/physicsEventBus.ts :: cb',
  'engine/packages/modoki/src/runtime/rendering/derivedMaterials.ts :: dispose',
  'engine/packages/modoki/src/runtime/rendering/frameDriver.ts :: fn',
  'engine/packages/modoki/src/runtime/rendering/interactionHandles.ts :: p',
  'engine/packages/modoki/src/runtime/rendering/renderSettings.ts :: cb',
  'engine/packages/modoki/src/runtime/rendering/resizeBus.ts :: cb',
  'engine/packages/modoki/src/runtime/rendering/text/dynamicFontProvider.ts :: fn',
  'engine/packages/modoki/src/runtime/rendering/text/fontProvider.ts :: fn',
  'engine/packages/modoki/src/runtime/rendering/tierCalibration.ts :: fn',
  'engine/packages/modoki/src/runtime/scene/SceneManager.ts :: hook',
  'engine/packages/modoki/src/runtime/timeline/timelineEventBus.ts :: cb',
  'engine/packages/modoki/src/runtime/timeline/timelineEventBus.ts :: cb',
  'engine/packages/modoki/src/runtime/timeline/timelineEventBus.ts :: cb',
  'engine/packages/modoki/src/runtime/video/VideoEvents.ts :: fn',
  'engine/packages/modoki/src/runtime/zones/zoneEventBus.ts :: cb',
];

const UNSCANNED_ROOTS: readonly string[] = deriveUnscannedRoots(SCAN_DIRS);
const expectedOutsideRows = (): string[] =>
  expectedLedgerRows(KNOWN_OUTSIDE_SCAN_DIRS, UNSCANNED_ROOTS);

/** ⚠️ **`UNSCANNED_ROOTS` OVERLAPS `SCAN_DIRS`, so the outside scan must re-filter.** Not a
 *  hypothesis — measured while mutation-checking this file: hand-rolling the loop back into
 *  `runtime/debug/widgetStore.ts` made it appear in BOTH the in-SCAN_DIRS list and the "roots this
 *  guard does NOT scan" list, under a message telling the reader to go look in `games/`.
 *
 *  Cause: `deriveUnscannedRoots` descends until no scanDir reaches deeper, but when it runs out of
 *  path segments it keeps the last directory it computed. `engine/vite.config.ts` therefore yields
 *  the root `engine` — which contains all three SCAN_DIRS — so the complement re-scans everything
 *  the guard already policed.
 *
 *  The same helper backs `abandonmentIsShared` and `livenessTokenIsShared`, which are green only
 *  because neither currently has an offender inside its own SCAN_DIRS to be double-reported. Left
 *  as a filter HERE rather than a fix THERE on purpose: reshaping a shared helper would move both
 *  siblings' root lists and their ledgers with them, which is a change those guards' owners should
 *  make deliberately. Filed separately. */
const insideScanDirs = (rel: string): boolean =>
  SCAN_DIRS.some((d) => rel === d || rel.startsWith(`${d}/`));

/** ⚠️ **Loops the helper CANNOT express — permanently exempt, not "not done yet".**
 *
 *  The distinction matters: a ledger row is a todo, an exemption is an argued decision, and
 *  migrating one of these would be a REGRESSION rather than a cleanup. Both are QUERIES, not
 *  fan-outs: they read a value back out of each callback, which `notifyListeners` — whose whole
 *  contract is "call them all, return nothing" — has no way to do.
 *
 *  - `runtime/core/screenPick.ts` `pickAt` — a FIRST-MATCH query. It `break`s on the first
 *    provider that answers and returns that answer; a helper that always calls everyone would
 *    change the result, not just the error handling.
 *  - `runtime/rendering/hitRegions.ts` `collectHitRegions` — a COLLECT query, and its own docblock
 *    argues the exact point: the `try` wraps the WHOLE per-provider body on purpose, because
 *    guarding only `fn()` catches a provider that throws and misses one that returns malformed
 *    DATA. `notifyListeners` can only isolate the call, so migrating it would narrow a guard whose
 *    width is documented and deliberate.
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
 *    nested patterns, which is also how it found a REAL one in `engine/electron/main.ts`.
 *
 *  ⚠️ Exactly these four, and each is asserted to still BE DETECTED below — an exemption whose
 *  loop was deleted or migrated goes red rather than lingering as a licence. That re-detection is
 *  skipped for a row whose FILE is absent from the checkout (the public snapshot ships no
 *  `games/`); see the ⚠️ on that test. A fourth is a signal
 *  that either the helper needs a query-shaped sibling or the exemption is being used to dodge a
 *  migration; decide that deliberately, do not append. */
const EXEMPT: readonly string[] = [
  'engine/packages/modoki/src/runtime/core/screenPick.ts :: fn',
  'engine/packages/modoki/src/runtime/rendering/hitRegions.ts :: fn',
  'engine/plugins/load-project-config.ts :: read',
  'games/wordweave/runtime/stem.ts :: coValidate',
];

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
 *  40 ledger rows and additionally closes the regex-literal hole the hand-rolled one had to
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
 *  This is the same duplicate-row limitation the header states for `KNOWN_UNMIGRATED` — there it is
 *  a narrow accepted risk, here it was live. */
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

function scan(roots: readonly string[] = SCAN_DIRS, dropOverlap = false): Scanned[] {
  const results: Scanned[] = [];
  for (const { rel, abs } of scannedFiles(roots)) {
    if (dropOverlap && insideScanDirs(rel)) continue;   // see `insideScanDirs`
    // ONE parse per file. `stripCommentsAndStrings` blanks comments AND string/template literals
    // in a single pass (it calls `stripComments` itself), so this replaces the `readScannedSource`
    // call that used to sit here — and doing it per LOOP-MATCH instead of per file timed the suite
    // out at 20s, which is how this ended up hoisted rather than tucked inside the predicate.
    const src = stripCommentsAndStrings(fs.readFileSync(abs, 'utf8'), rel);
    const offenders: string[] = [];
    if (abs !== HELPER) {
      for (const m of src.matchAll(SUBSCRIBER_LOOPS)) {
        const body = headerEnd(src, m.index!);
        for (const name of boundNames(m[1]!)) {
          if (bodyCallsElement(src, body, name)) offenders.push(name);
        }
      }
      for (const m of src.matchAll(FOREACH_NOTIFY)) {
        if (m[1] === m[2]) offenders.push(`${m[1]!} (forEach)`);
      }
    }
    results.push({ file: rel, offenders });
  }
  return results;
}

describe('every fan-out-shaped loop is migrated, ledgered, or exempt (#888)', () => {
  it('SCAN_DIRS itself is non-vacuous (the floor moved onto the callers)', () => {
    expect(scannedFiles().length, 'the SCAN_DIRS corpus collapsed — every check below would pass '
      + 'having read nothing').toBeGreaterThan(500);
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

  it('SCAN_DIRS holds exactly the fan-outs on the ledger — no more', () => {
    const offenders = subtractOnce(rowsFrom(scan()), EXEMPT);
    expect(offenders, 'A callback fan-out was hand-rolled instead of going through '
      + '`runtime/core/notifyListeners.ts`. That is #888: the publisher mutates its state before '
      + 'it fans out, so one throwing callback commits the mutation, starves every callback '
      + 'behind it, and aborts the publisher\'s own tail. Call `notifyListeners(set, label, args)`; '
      + 'pass a `report` only if this publisher cannot reach `console.error` safely. '
      + 'If instead a row DISAPPEARED because you migrated it: good — delete its ledger row in the '
      + 'same commit.')
      .toEqual([...KNOWN_UNMIGRATED].sort());
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
    // two EXEMPT rows sit INSIDE `SCAN_DIRS`, where it throws on purpose.
    const missing = EXEMPT.filter((row) => !fs.existsSync(path.join(REPO, row.split(' :: ')[0]!)));
    // The floor that stops the filter draining the loop into a no-op: an EXEMPT row inside
    // SCAN_DIRS is present in ANY checkout that runs this guard at all — the non-vacuity
    // assertion above already vouches for that corpus — so its absence is a broken checkout
    // rather than a legitimate subset, and must fail rather than be filtered away.
    expect(missing.filter((row) => insideScanDirs(row.split(' :: ')[0]!)),
      'an EXEMPT row INSIDE SCAN_DIRS names a file this checkout does not have — the corpus is '
      + 'broken, and dropping the row would leave this test checking nothing').toEqual([]);
    for (const row of EXEMPT.filter((r) => !missing.includes(r))) {
      expect(detected.has(row), `EXEMPT row "${row}" is no longer detected — the loop it excuses is `
        + 'gone or migrated, so the row is now a blanket licence for whatever takes its place. '
        + 'Delete it.').toBe(true);
    }
    expect(EXEMPT.length, 'a fifth exemption is a decision, not an append — see the docblock')
      .toBe(4);
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

  it('the ledger is not silently emptying — it is the population, not a formality', () => {
    // A ledger that drains to nothing because the DETECTOR broke reads exactly like a ledger that
    // drained because someone did the work. This floor separates them: it fails long before the
    // list is empty, and the last few migrations are expected to edit it deliberately.
    expect(KNOWN_UNMIGRATED.length, 'the unmigrated ledger has collapsed — check the detector '
      + 'still fires before believing the work was done').toBeGreaterThan(20);
  });

  it('the roots this guard does NOT scan hold exactly the KNOWN fan-outs', () => {
    // The guard's OWN detector over the unscanned roots, so this cannot drift from what the real
    // check would say. A first instance out there fails here rather than joining a silent
    // population.
    const outside = subtractOnce(rowsFrom(scan(UNSCANNED_ROOTS, true)), EXEMPT);
    expect(scannedFiles(UNSCANNED_ROOTS).filter(({ rel }) => !insideScanDirs(rel)).length,
      'the unscanned-roots corpus is empty — this assertion would pass having examined nothing')
      .toBeGreaterThan(50);
    expect(outside, 'The set of hand-rolled notification loops OUTSIDE SCAN_DIRS changed. Decide '
      + 'deliberately whether the new one migrates onto the shared helper or joins the ledger '
      + 'with a reason. One DISAPPEARING is good news: drop its ledger entry in the same commit.')
      .toEqual(expectedOutsideRows());
  });
});
