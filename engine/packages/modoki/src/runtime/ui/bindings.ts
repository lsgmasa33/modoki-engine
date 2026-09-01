/** UIAction bindings — the unified event→response model for interactive UI.
 *
 *  A UIAction holds a flat list of bindings. Each binding fires on one `event`
 *  (click / change / submit) and does one of two `kind`s of work:
 *
 *   - `set`  — a declarative property write: set `property` of `component` on the
 *              `target` entity to `value`. Subsumes the old show/hide pair
 *              (opening a panel is `UIElement.isVisible = true`). Engine-applied,
 *              no game code.
 *   - `call` — dispatch a named action (system logic or an engine built-in like
 *              `engine.loadScene`). `target` becomes ctx.target; `params` are the
 *              action's typed arguments.
 *
 *  The `$value` token (in a set's `value` or any `params` entry) is replaced at
 *  dispatch with the triggering event's value — e.g. a range slider's `change`
 *  event can write its live number straight into a field with zero game code.
 *
 *  Inert unless the game is running (mirrors dispatchUIAction): in the editor's
 *  Stopped/Paused states an event must not mutate the scene. Writes that happen
 *  while playing are reverted by Stop (snapshot/revert) and Cmd+S is blocked in
 *  play, so runtime state never reaches disk. */

import { getCurrentWorld, findEntityByGuid, onWorldSwap } from '../core/ecs/world';
import { getTraitByName } from '../core/ecs/traitRegistry';
import { markUIDirty } from './uiTreeStore';
import { isSimRunning } from '../core/playState';
import { dispatchUIAction, type UIActionPayload } from '../core/actionRegistry';
import { rawNow } from '../core/clock';
import { getActiveUIBusySources } from '../core/uiBusySources';
import {
  UISettings, UI_SETTINGS_DEFAULT_INPUT_LOCK_MIN_MS, UI_SETTINGS_DEFAULT_INPUT_LOCK_MAX_MS,
} from '../traits/UISettings';

// UIActionEvent/UIActionKind/UIActionBinding are the UIAction trait's own schema — defined in
// traits/UIAction.ts and re-exported here (not the reverse) so every existing import of these
// three names, from this file or the runtime barrel, keeps working unchanged.
import type { UIActionEvent, UIActionKind, UIActionBinding } from '../traits/UIAction';
export type { UIActionEvent, UIActionKind, UIActionBinding };

/** The `$value` token resolves to the triggering event's value at dispatch. */
export const VALUE_TOKEN = '$value';

function resolve(v: unknown, eventValue: UIActionPayload | undefined): unknown {
  return v === VALUE_TOKEN ? eventValue : v;
}

export interface ApplyBindingsOptions {
  /** GUID of the element's own entity — resolves bindings whose target is empty. */
  selfGuid?: string;
  /** The triggering event's value (slider number, input string) — feeds '$value'
   *  and is passed as ctx.payload to 'call' handlers. */
  eventValue?: UIActionPayload;
  /** This event stream is CONTINUOUS, not a discrete activation — a range slider's 'change'
   *  firing repeatedly while the pointer moves, or a controlled text input's 'change' firing
   *  once per keystroke. Neither takes nor respects the global input lock (#466): blocking a
   *  slider drag would freeze it mid-drag, and blocking a keystroke stream would DROP
   *  characters (the write IS what produces the field's value, so a swallowed keystroke is
   *  lost, not merely delayed). */
  continuous?: boolean;
}

// ── Global input lock (#466) ─────────────────────────────────────────────────────
//
// A single global lock, not per-button: the owner's explicit override of the issue's own
// proposal, which asked for a per-button window so a fast tap on a DIFFERENT button still
// fires. Here it does NOT — every discrete activation (click / submit / a toggle's change)
// takes and respects the SAME lock, so a double tap anywhere while one action is still
// settling is swallowed, not just a repeat on the same button.
//
// The primary gate is the action COMPLETING (every promise a 'call' binding's handler
// returned has settled), not a timer — `inputLockMinMs` is only a floor under that, for the
// common synchronous case where completion is instant. Both knobs are authored on the
// `UISettings` resource trait, not code constants (CLAUDE.md's authored-values rule): the
// right value is a feel call, not a fixed constant.
//
// A THIRD gate (#530): a game can register a busy PREDICATE (`core/uiBusySources.ts`) instead of
// making every handler return a promise — the completion gate above is a silent opt-in (a
// non-thenable return is simply ignored), and a game whose `call` handlers are all synchronous
// wrappers (Court's `() => fireTap(target)`) gets nothing from it. `isInputLockActive` consults
// both.

let lockHeld = false;
let lockAcquiredAt = 0;
let lockPendingCount = 0;
let lockPendingNames: string[] = [];
// Bumped by every acquireLock()/releaseLock() — a stale promise from an EARLIER lock (one that
// force-released via the max-ms valve, or was reset by a world swap) must not decrement the
// pending count of whichever lock is current when it finally settles. Without this, an old
// promise settling after a NEW activation has acquired its own lock silently releases that new
// lock early, while its own async handler is still in flight — the exact double-fire this
// feature exists to prevent. See trackLockPromise and its regression test.
let lockGen = 0;

// The start of the busy window currently being credited toward the valve, or `null` when
// nothing is busy right now. `null`, not `0` — the manual test clock legitimately starts at 0,
// so `0` cannot double as "unset" without colliding with a real timestamp. Its OWN safety valve,
// separate from `lockAcquiredAt`/the authored window above: busy can begin from something that was never
// itself a UI activation (Court's sign-in flow starts from a menu button, not a chrome tap), so
// there may be no held lock at all to hang this off. See `isInputLockActive` for the valve logic.
//
// ⚠️ This is NOT "when the predicates first went continuously true" — `isInputLockActive` is only
// ever called from a UI activation, so it can only credit busy time it actually OBSERVED. A busy
// period that starts and ends with no activation in between (a background sync, a restored
// StoreKit transaction) would leave credited time stale from an EARLIER episode; if a later,
// unrelated episode inherited it, the valve would force-release immediately — and silently, if
// `busyWarned` also survived. `busyLastObserved` below closes that gap: only the delta BETWEEN
// two observations is credited, and only when it is under `BUSY_OBSERVATION_GAP_MS`; a longer
// gap is evidence of nothing and starts a fresh episode.
// Cost of this, accepted deliberately: the valve needs observations spaced closer together than
// `BUSY_OBSERVATION_GAP_MS` to accumulate. Below that cadence the rescue is merely DELAYED; a
// user retrying consistently SLOWER than it restarts the window every time and is denied the
// rescue outright — stated plainly because the comment here used to claim "delayed, never
// denied", which is false above that cadence. Accepted because a >10s tap cadence is not
// someone hammering a stuck button. The alternative —
// crediting the unobserved gap anyway — silently force-released an unrelated, later operation,
// which is the bug this replaced.
// How long a gap between two observations we still believe busy was continuous across, and so
// still CREDIT toward the valve.
//
// ⚠️ THIS IS A HEURISTIC WITH A KNOWN AMBIGUOUS BAND, not a correct answer, because
// `isInputLockActive` only samples at a discrete activation. One tap N seconds after the last
// is INDISTINGUISHABLE between "still stalled, the user retried" (must credit, or the valve
// never rescues) and "the old episode ended and an unrelated one began" (must not credit, or
// the new one is force-released unprotected — the #530 defect). No threshold separates them;
// the existing genuine-stall test retries every 3.3s expecting rescue, and a 5s idle between
// episodes expects protection. Biased toward CREDITING deliberately: bricked input is the
// severe failure, an unprotected new episode the milder one. The real fix is to observe the
// busy predicates on a frame cadence instead of only at activations, which makes continuity
// OBSERVED rather than inferred and retires this constant — tracked as #551.
// Deliberately NOT the authored `inputLockMaxMs`. The two were the same number until #543, and
// once the valve started reading the authored ceiling (rather than an un-updatable module
// cache), a game could author the valve into NEVER FIRING: with `inputLockMaxMs: 500` and a
// user tapping every 800ms, every observation restarted the window (`800 > 500`), so
// `busyElapsed` never grew past the ceiling — input stayed blocked for the whole stall and the
// warning never printed, because `busyWarned` is reset on the same line that would have let it
// fire. This is mechanism, not feel, so it is a code constant (CLAUDE.md's single-source
// table), and 10000 is the value this threshold effectively HAD before #543, when the busy
// valve read a cache still holding UI_SETTINGS_DEFAULT_INPUT_LOCK_MAX_MS.
const BUSY_OBSERVATION_GAP_MS = 10_000;

let busyAccumulatedMs = 0;
// The last time `isInputLockActive()` observed the busy set non-empty, or `null` when the last
// observation (or world start) saw nothing busy. Each observation credits the delta since this
// one — see `busyAccumulatedMs` above.
let busyLastObserved: number | null = null;
// Guards the warning below to fire ONCE per stall, not on every activation while a source stays
// stuck — mirrors `releaseLock()` clearing `lockPendingNames` so the other valve's warning can't
// repeat either, just without an actual release to hang the reset off (the source is still busy).
let busyWarned = false;

// Reset on world/scene swap — a lock held by the previous world's action must not carry over
// and brick the next one. Top-level, matching UINode.tsx:109 / uiValues.ts:56 / focusManager
// precedent (registered once at module load, not lazily). Routed through releaseLock() (not a
// duplicate set of field writes) so the swap reset and every other release path bump lockGen
// identically and can never drift apart.
onWorldSwap(() => {
  releaseLock();
  busyAccumulatedMs = 0; // a busy source registered by the outgoing world's manager must not
  // carry credited stall time into the next world's first activation
  busyLastObserved = null;
  busyWarned = false;
});

/** Is the lock currently blocking a new discrete activation? A CHECK, not a passive read: an
 *  expired lock (past `inputLockMaxMs`) is force-released here rather than by a `setTimeout`,
 *  so nothing depends on a timer firing — the safety valve is just "an old lock reads as free,
 *  and warns" the next time anyone asks.
 *
 *  The max-ms valve is for a HUNG HANDLER, so it must only be consulted when something is
 *  actually pending — checked BEFORE the pending gate, it fired on an ordinary idle lock with
 *  nothing outstanding (a plain synchronous 'set'/'call' left the lock sitting held past
 *  `inputLockMaxMs` with `lockPendingCount === 0`, and the very next tap — however much later —
 *  hit the valve and warned about a handler that never existed). An idle lock is freed silently
 *  by the floor branch below instead.
 *
 *  Takes the authored window as a parameter rather than reading module state — see
 *  `readLockWindow` below for why the two knobs are no longer cached at all. */
function isInputLockActive(lockWindow: { minMs: number; maxMs: number }): boolean {
  // The busy-source gate (#530) goes FIRST, before `lockHeld` — a busy predicate can start
  // outside any UI activation at all (Court's sign-in begins from `beginSignIn`, not from a
  // chrome tap that took the lock), and the 300ms floor below may already have expired while the
  // underlying work continues. So this must block even an otherwise-idle lock.
  //
  // ⚠️ It carries its OWN safety valve, mirroring `lockWindow.maxMs` below — a naive
  // `if (busyNames.length) return true` would let a predicate stuck true (a real Court case: the
  // account side can legitimately sit in 'working' for up to its own 60s watchdog) brick ALL UI
  // input FOREVER, reintroducing exactly the failure `inputLockMaxMs` exists to prevent. Track
  // when busy first became true; once it has been continuously true past `lockWindow.maxMs`, stop
  // blocking and warn naming the stuck source(s), same wording family as the lock's own valve.
  const busyNames = getActiveUIBusySources();
  if (busyNames.length > 0) {
    const now = rawNow();
    // ACCUMULATE observed-adjacent time; never measure from a single start timestamp. Using one
    // `busySince` forced a choice between two bugs, and both were shipped and caught here:
    // with the gap threshold at the AUTHORED ceiling, a user retrying slower than it restarted
    // the window every time and the valve became unreachable; with the threshold at a flat 10s,
    // a stale timestamp from an EARLIER finished episode was credited to a new unrelated one,
    // force-releasing it on its first observation — the exact #530 defect the gap logic exists
    // to prevent. Crediting only the deltas short enough to vouch for avoids both: a long gap
    // contributes NOTHING (nobody watched it) and starts a fresh episode, while a normal retry
    // cadence still accumulates toward the ceiling instead of resetting.
    const delta = busyLastObserved === null ? 0 : now - busyLastObserved;
    if (delta > BUSY_OBSERVATION_GAP_MS) {
      busyAccumulatedMs = 0; // unobservable gap — treat as a new episode, credit none of it
      busyWarned = false;
    } else {
      busyAccumulatedMs += delta;
    }
    busyLastObserved = now;
    if (busyAccumulatedMs > lockWindow.maxMs) {
      if (!busyWarned) {
        busyWarned = true;
        console.warn(
          `[UI input lock] busy-source valve force-released after ${lockWindow.maxMs}ms — stuck busy: `
          + busyNames.join(', '),
        );
      }
      // Do not reset the accumulator here: the source(s) are still reporting busy, and resetting
      // would re-arm a fresh window on the very next check instead of recognizing this as the
      // SAME ongoing stall. It resets only once nothing is busy, below.
    } else {
      return true;
    }
  } else {
    busyAccumulatedMs = 0; // nothing busy right now — a later busy period starts its own window
    busyLastObserved = null;
    busyWarned = false;
  }

  if (!lockHeld) return false;
  const elapsed = rawNow() - lockAcquiredAt;
  if (lockPendingCount > 0) {
    if (elapsed > lockWindow.maxMs) {
      console.warn(
        `[UI input lock] force-released after ${lockWindow.maxMs}ms — a handler never settled: `
        + `${lockPendingNames.length ? lockPendingNames.join(', ') : '(no call binding — a stuck set?)'}`,
      );
      releaseLock();
      return false;
    }
    return true; // an async 'call' handler hasn't settled yet, and still within the max-ms valve
  }
  if (elapsed < lockWindow.minMs) return true; // floor not elapsed yet
  releaseLock(); // both gates satisfied — free it now rather than waiting to be asked again
  return false;
}

function releaseLock(): void {
  lockHeld = false;
  lockPendingCount = 0;
  lockPendingNames = [];
  lockGen += 1;
}

// Takes no window: since #543 nothing caches the authored knobs, so the acquire has nothing to
// snapshot — `isInputLockActive` reads them fresh each time. See `readLockWindow`.
function acquireLock(): void {
  lockHeld = true;
  lockAcquiredAt = rawNow();
  lockPendingCount = 0;
  lockPendingNames = [];
  lockGen += 1;
}

/** Read and clamp the authored lock window from `UISettings` — the SINGLE place either knob is
 *  read. Previously `acquireLock` snapshotted these into module-level `lockMinMs`/`lockMaxMs`, but
 *  the busy-source valve in `isInputLockActive` consults the window BEFORE any activation ever
 *  calls `acquireLock` (a busy predicate can go true with no preceding tap), so that cache ran on
 *  the module default for the whole first busy episode of a session, and on the PREVIOUS world's
 *  value for the first episode after a world swap (#543). Reading fresh at evaluation time instead
 *  of caching removes the staleness entirely — the cost is one extra `queryFirst` per discrete
 *  activation, same as the one this replaces. */
function readLockWindow(world: ReturnType<typeof getCurrentWorld>): { minMs: number; maxMs: number } {
  const settings = world.queryFirst(UISettings)?.get(UISettings);
  const minMs = settings?.inputLockMinMs ?? UI_SETTINGS_DEFAULT_INPUT_LOCK_MIN_MS;
  const maxMs = settings?.inputLockMaxMs ?? UI_SETTINGS_DEFAULT_INPUT_LOCK_MAX_MS;
  // Defend against an authored inversion (min > max) — the Inspector can't express a
  // cross-field constraint, so `inputLockMinMs: 1000, inputLockMaxMs: 100` is legal input.
  // Left unclamped, the valve's max-ms window would sit BELOW the floor, so a lock with
  // nothing pending could never even reach a pending check. Clamp the ceiling up to the floor
  // instead of clamping the floor down, so the floor — the value the owner is more likely
  // tuning for feel — always wins. (The valve no longer fires on an idle lock at all —
  // `isInputLockActive` only consults `maxMs` when `lockPendingCount > 0` — so this clamp
  // is just keeping `maxMs >= minMs` sane, not suppressing a per-activation warning.)
  return { minMs, maxMs: Math.max(minMs, maxMs) };
}

/** Register a 'call' binding's returned value against the held lock IF it's a thenable, so
 *  release waits for it too — a runtime duck-type check, not the static `UIActionHandler`
 *  return type (`unknown`, so a plain value-returning one-liner like `() => count++` stays
 *  legal and is simply ignored here). Same idiom as `managerRegistry.ts`'s `activate()`
 *  — genuinely: both settle paths are handled via `.then(onFulfilled, onRejected)`, not
 *  `.finally()`, because `.finally()` RE-THROWS into its own derived promise, which nobody
 *  awaits — a rejecting handler would then log an *extra* unhandled-rejection on top of the
 *  handler's own. `.then` with both arguments swallows it, same as `activate()`.
 *  No-op for any non-thenable return (the common synchronous handler). */
function trackLockPromise(result: unknown, actionName: string): void {
  if (!result || typeof (result as Promise<unknown>).then !== 'function') return;
  lockPendingCount += 1;
  lockPendingNames.push(actionName);
  // Captured at registration: if this promise outlives ITS lock (force-released by the max-ms
  // valve, or cleared by a world swap) and settles after a NEW lock has been acquired, the
  // generation will have moved on and this decrement must be a no-op — it belongs to a lock
  // that is already gone, not to whichever lock happens to be current.
  const gen = lockGen;
  const settle = () => {
    if (gen !== lockGen) return;
    lockPendingCount = Math.max(0, lockPendingCount - 1);
    // Prune this action's name too — not just the count — so the max-ms valve's warning
    // (#1's primary diagnostic now) names only what's STILL pending. splice the first matching
    // occurrence rather than filtering all of them: two rows can legitimately share an action
    // name, and each needs its own decrement/prune pair to balance.
    const idx = lockPendingNames.indexOf(actionName);
    if (idx !== -1) lockPendingNames.splice(idx, 1);
  };
  const onSettled = (isRejection: boolean) => (err: unknown) => {
    // The lock must not become an error black hole: `.then(settle, settle)` alone silently
    // swallows every rejecting 'call' handler (this used to surface as an Uncaught (in promise) —
    // now nothing prints at all), so log it here before decrementing.
    if (isRejection) {
      // A superseded scene load rejects with AbortError as part of normal operation (a fast
      // double-navigation cancels the first `engine.loadScene`) — that is expected, not a bug,
      // and logging it would be noise on every quick nav. Every other rejection is real.
      const isAbort = (err as { name?: string } | undefined)?.name === 'AbortError';
      if (!isAbort) console.warn(`[UI input lock] '${actionName}' handler rejected:`, err);
    }
    settle();
  };
  Promise.resolve(result).then(onSettled(false), onSettled(true));
}

/** Resolve only the requested guids to entities via the maintained guid→entity
 *  index — O(1) per target. Replaces the old early-break world scan; matters for a
 *  range slider firing `change` continuously during a drag (F6). */
function resolveGuids(world: ReturnType<typeof getCurrentWorld>, needed: Set<string>): Map<string, any> {
  const out = new Map<string, any>();
  if (needed.size === 0) return out;
  for (const guid of needed) {
    const entity = findEntityByGuid(guid, world);
    if (entity) out.set(guid, entity);
  }
  return out;
}

/** The button-click sound, INVERTED rather than imported.
 *
 *  `runtime/ui/` is L2 and may not reach `runtime/audio/`, another L2 subsystem, so the audio side
 *  registers itself here instead (`registerAudioControls` → `setUIClickCue`) — the same
 *  dependency-inversion the layer guard asks for, and the same shape as
 *  `setAudioWorldPositionResolver`. Unregistered → silent, which is what a headless test or a
 *  game that never wires audio should be.
 *
 *  ⚠️ It lives at the BINDING layer, not in a game, because a game cannot see every button. Court
 *  put its click on its own chrome dispatcher and the settings panel stayed silent — those rows
 *  open and close through plain `set` bindings authored in the scene, so no game code runs there
 *  at all. Any per-button fix is a list somebody has to maintain, and it goes stale on the first
 *  button added; this is the one place every button provably passes through. */
let clickCue: (() => void) | null = null;

/** Install (or clear, with `null`) the click sound. Called by `registerAudioControls`. */
export function setUIClickCue(fn: (() => void) | null): void { clickCue = fn; }

/** Run every binding registered for `event`.
 *
 *  ⚠️ EVENT-HANDLER ONLY (F10): call this from a DOM event handler, never from a
 *  system tick / projection. `kind:'call'` routes through `dispatchUIAction`, which
 *  THROWS in dev on an unregistered action — fine out of a React handler (React
 *  isolates it) but it would abort the frame if invoked inside the pipeline. */
export function applyBindings(
  bindings: UIActionBinding[] | undefined,
  event: UIActionEvent,
  opts: ApplyBindingsOptions = {},
): void {
  if (!bindings?.length || !isSimRunning()) return;

  const { selfGuid, eventValue, continuous } = opts;

  // Pass 1: collect the distinct target guids of the rows matching this event —
  // inline, no `.filter` allocation. Most UIs target `selfGuid` → a 1-element set.
  const needed = new Set<string>();
  let anyRow = false;
  for (const b of bindings) {
    if (!b || (b.event || 'click') !== event) continue;
    anyRow = true;
    const guid = b.target || selfGuid;
    if (guid) needed.add(guid);
  }
  if (!anyRow) return;

  const world = getCurrentWorld();

  // A discrete activation (click / submit / a toggle's change) takes and respects the global
  // input lock; a continuous stream (a range slider's drag `change`) does neither (#466).
  const isDiscrete = !continuous;
  if (isDiscrete) {
    // Swallow the WHOLE event, before the click cue, so a blocked second tap makes no sound —
    // the doubled sound was the original bug report's own proof the action ran twice. Read the
    // authored window ONCE here — both the busy-valve check and the acquire below share it,
    // rather than each re-querying `UISettings` (#543).
    // Named `lockWindow`, not `window`: a bare `window` here would shadow the DOM global
    // inside `applyBindings`, and this is DOM-adjacent code.
    const lockWindow = readLockWindow(world);
    if (isInputLockActive(lockWindow)) return;
    acquireLock();
  }

  // Shared with the input lock above (#528) rather than testing the event name: the old
  // `event === 'click'` test silenced every UIToggle, whose activation fires 'change', not
  // 'click'. A slider drag and a per-keystroke text 'change' pass `continuous: true` and stay
  // silent through `isDiscrete` same as the lock. `submit` IS discrete but is exempted here on
  // purpose (owner, 2026-09-01) — Enter in a text field follows typing, and a tap sound would
  // read as a keyboard click, not a button press. Don't "unify" it away.
  if (isDiscrete && event !== 'submit') clickCue?.();
  // Resolve only the needed guids (early-break scan), shared by 'set' + 'call'.
  const byGuid = resolveGuids(world, needed);

  let touchedUI = false;
  // Pass 2: apply each matching row.
  for (const b of bindings) {
    if (!b || (b.event || 'click') !== event) continue;
    if (b.kind === 'call') {
      if (!b.action) continue;
      const params = b.params
        ? Object.fromEntries(Object.entries(b.params).map(([k, v]) => [k, resolve(v, eventValue)]))
        : undefined;
      // ctx.payload is the live event value, falling back to an authored single
      // `payload` param — the schema-less convention (one freeform value).
      const payload = eventValue !== undefined ? eventValue : (params?.payload as UIActionPayload | undefined);
      const guid = b.target || selfGuid;
      // Reuse the guid→entity map we already built — skip dispatchUIAction's scan.
      const result = dispatchUIAction(b.action, { payload, params, targetGuid: guid, target: guid ? byGuid.get(guid) : undefined });
      // Hold the lock open until an async handler settles — the core of the owner's design
      // (the action COMPLETING is the real gate, `inputLockMinMs` is only a floor under it).
      if (isDiscrete) trackLockPromise(result, b.action);
      continue;
    }
    // kind: 'set'
    if (!b.component || !b.property) continue;
    const guid = b.target || selfGuid;
    if (!guid) continue;
    const entity = byGuid.get(guid);
    if (!entity) continue;
    const meta = getTraitByName(b.component);
    if (!meta || !entity.has(meta.trait)) continue;
    const value = resolve(b.value, eventValue);
    const current = entity.get(meta.trait) as Record<string, unknown>;
    if (current[b.property] === value) continue;
    entity.set(meta.trait, { ...current, [b.property]: value });
    // Any successful set can feed a UIBinding active-highlight (which reads an
    // arbitrary trait on a target entity — e.g. SkeletalAnimator.clip), not just
    // direct UIElement writes, so rebuild the projection on any change.
    touchedUI = true;
  }

  if (touchedUI) markUIDirty(); // rebuild the UI projection so the renderer re-reads
}
