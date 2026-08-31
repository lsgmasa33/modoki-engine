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

let lockHeld = false;
let lockAcquiredAt = 0;
let lockMinMs = UI_SETTINGS_DEFAULT_INPUT_LOCK_MIN_MS;
let lockMaxMs = UI_SETTINGS_DEFAULT_INPUT_LOCK_MAX_MS;
let lockPendingCount = 0;
let lockPendingNames: string[] = [];
// Bumped by every acquireLock()/releaseLock() — a stale promise from an EARLIER lock (one that
// force-released via the max-ms valve, or was reset by a world swap) must not decrement the
// pending count of whichever lock is current when it finally settles. Without this, an old
// promise settling after a NEW activation has acquired its own lock silently releases that new
// lock early, while its own async handler is still in flight — the exact double-fire this
// feature exists to prevent. See trackLockPromise and its regression test.
let lockGen = 0;

// Reset on world/scene swap — a lock held by the previous world's action must not carry over
// and brick the next one. Top-level, matching UINode.tsx:109 / uiValues.ts:56 / focusManager
// precedent (registered once at module load, not lazily). Routed through releaseLock() (not a
// duplicate set of field writes) so the swap reset and every other release path bump lockGen
// identically and can never drift apart.
onWorldSwap(() => {
  releaseLock();
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
 *  by the floor branch below instead. */
function isInputLockActive(): boolean {
  if (!lockHeld) return false;
  const elapsed = rawNow() - lockAcquiredAt;
  if (lockPendingCount > 0) {
    if (elapsed > lockMaxMs) {
      console.warn(
        `[UI input lock] force-released after ${lockMaxMs}ms — a handler never settled: `
        + `${lockPendingNames.length ? lockPendingNames.join(', ') : '(no call binding — a stuck set?)'}`,
      );
      releaseLock();
      return false;
    }
    return true; // an async 'call' handler hasn't settled yet, and still within the max-ms valve
  }
  if (elapsed < lockMinMs) return true; // floor not elapsed yet
  releaseLock(); // both gates satisfied — free it now rather than waiting to be asked again
  return false;
}

function releaseLock(): void {
  lockHeld = false;
  lockPendingCount = 0;
  lockPendingNames = [];
  lockGen += 1;
}

function acquireLock(minMs: number, maxMs: number): void {
  lockHeld = true;
  lockAcquiredAt = rawNow();
  lockMinMs = minMs;
  lockMaxMs = maxMs;
  lockPendingCount = 0;
  lockPendingNames = [];
  lockGen += 1;
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
    // the doubled sound was the original bug report's own proof the action ran twice.
    if (isInputLockActive()) return;
    const settings = world.queryFirst(UISettings)?.get(UISettings);
    const minMs = settings?.inputLockMinMs ?? UI_SETTINGS_DEFAULT_INPUT_LOCK_MIN_MS;
    const maxMs = settings?.inputLockMaxMs ?? UI_SETTINGS_DEFAULT_INPUT_LOCK_MAX_MS;
    // Defend against an authored inversion (min > max) — the Inspector can't express a
    // cross-field constraint, so `inputLockMinMs: 1000, inputLockMaxMs: 100` is legal input.
    // Left unclamped, the valve's max-ms window would sit BELOW the floor, so a lock with
    // nothing pending could never even reach a pending check. Clamp the ceiling up to the floor
    // instead of clamping the floor down, so the floor — the value the owner is more likely
    // tuning for feel — always wins. (The valve no longer fires on an idle lock at all —
    // `isInputLockActive` only consults `lockMaxMs` when `lockPendingCount > 0` — so this clamp
    // is just keeping `maxMs >= minMs` sane, not suppressing a per-activation warning.)
    acquireLock(minMs, Math.max(minMs, maxMs));
  }

  // Only 'click': 'change' fires continuously while a slider is dragged, and 'submit' is a
  // keystroke, so neither is a press to acknowledge.
  if (event === 'click') clickCue?.();
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
