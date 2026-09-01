/** Input source interface + registry (Part A3 of the input-and-ui-focus plan).
 *
 *  An `InputSource` owns one physical input modality (keyboard, pointer, gamepad,
 *  later a native console pad). It attaches its own listeners / polling on the
 *  session, and each frame merges its contribution into the shared `InputFrame`.
 *  The `inputSystem` (app pipeline) drives them: `attachAll` on session start,
 *  `sampleAll` every frame, `detachAll` on teardown.
 *
 *  Sources are the ONLY sanctioned place in the engine that reads `window` /
 *  `document` / `navigator.getGamepads` — the guardrail test enforces that the rest
 *  of the engine + game runtime trees go through the `Input` resource instead.
 *  Registered as an app-scope Manager (`inputSourcesManager`) so they attach/detach
 *  with the session and never load in the headless harness (keeping it deterministic). */

import type { ManagerDef } from '../core/managerTypes';
import type { InputFrame } from '../core/inputActions';
import { keyboardSource } from './keyboardSource';
import { gamepadSource } from './gamepadSource';
import { pointerSource } from './pointerSource';
import { touchControlSource } from './touchControlSource';
import { gestureSource } from './gestureSource';
import { registerInputPromptSources } from './inputPromptSources';

export interface InputSource {
  readonly name: string;
  /** Begin listening / polling. Idempotent — safe to call when already attached. */
  attach(): void;
  /** Stop listening and drop any latched state. Idempotent. */
  detach(): void;
  /** Merge this source's contribution into `out` (OR held flags, add axes, set
   *  `lastDevice` on activity). Never clears another source's contribution. */
  sample(out: InputFrame): void;
  /** Drop latched state WITHOUT detaching. Called when the input gate closes, so a key
   *  held at that moment can't keep driving the game. Optional; a stateless source
   *  (one that derives everything in `sample`) needs none. */
  reset?(): void;
}

// ── Host input gate ─────────────────────────────────────────────────────────
//
// The HOST decides when input should stop reaching the game; the runtime only provides
// the mechanism. Mirrors the injectable clock: mechanism here, policy outside.
//
// The editor uses it for focus scoping — while an editor panel other than the GameView
// owns the keyboard, WASD must not latch into the running game. That policy CANNOT live
// in a source: `keyboardSource` ships inside every game and must never know what a
// "panel" is.
//
// A shipped game never calls setInputGate, so the gate stays null and behaviour is
// unchanged. The headless harness never registers sources at all.
//
// Why here and not in keyboardSource: all three built-in sources leak, and only one has
// any guard. keyboardSource has `editing()`; pointerSource listens on window with NO
// guard (a pointerdown in the Hierarchy feeds the game during play); gamepadSource polls
// with NO guard (a controller drives the game while you type in the Inspector). One gate
// at the registry covers all three and anything a game registers later.

let inputGate: (() => boolean) | null = null;

/** Install the host's suppression predicate — return true to BLOCK input from reaching
 *  the game. Pass null to clear. */
export function setInputGate(fn: (() => boolean) | null): void {
  inputGate = fn;
}

/** Is input currently suppressed by the host? A throwing gate fails OPEN — a broken
 *  editor predicate must never make a game permanently uncontrollable. */
export function isInputSuppressed(): boolean {
  if (!inputGate) return false;
  try { return inputGate() === true; }
  catch { return false; }
}

const sources: InputSource[] = [];

/** Register an input source. De-duplicates by `name` (last wins) so a hot-reload or
 *  a game replacing a source doesn't stack duplicates. Attaches immediately if the
 *  registry is already attached. */
export function registerSource(source: InputSource): void {
  const idx = sources.findIndex((s) => s.name === source.name);
  if (idx >= 0) { sources[idx].detach(); sources[idx] = source; }
  else sources.push(source);
  if (attached) source.attach();
}

export function unregisterSource(name: string): void {
  brokenResets.delete(name);
  const idx = sources.findIndex((s) => s.name === name);
  if (idx >= 0) { sources[idx].detach(); sources.splice(idx, 1); }
}

export function getSources(): readonly InputSource[] { return sources; }

let attached = false;

export function attachAll(): void {
  if (attached) return;
  attached = true;
  for (const s of sources) s.attach();
}

export function detachAll(): void {
  if (!attached) return;
  attached = false;
  for (const s of sources) s.detach();
}

/** Merge every attached source into `out`, in registration order.
 *
 *  While the host gate is closed, sources are NOT sampled and every frame DRAINS them.
 *  The drop is load-bearing, not tidiness, and it answers two different problems:
 *
 *    - latched LEVEL state: hold W, click the Hierarchy, and without a reset `held` still
 *      contains 'w', so the character keeps walking until you physically release. Same
 *      class as the existing blur / play-start resets in keyboardSource.
 *    - QUEUED discrete events: a source's raw listeners are never detached by the gate —
 *      only `sample()` is skipped — so pointerSource's press/release FIFO keeps filling
 *      with every click made in an editor panel while the game is unfocused. Left alone,
 *      reopening replays that whole backlog into the game, one entry per frame.
 *
 *  ⚠️ DRAIN CONTINUOUSLY, NEVER ON THE REOPENING EDGE (#264). This used to reset on both
 *  edges — closing, then again on reopening to clear the backlog — and the reopening reset
 *  ate the very input that OPENED the gate. `PanelFocusHost` moves the keyboard scope on
 *  CAPTURE-phase pointerdown, before any panel handler and before pointerSource's own
 *  window listener enqueues the press. So a click into the Game panel flips the gate open
 *  and lands in the queue within the same tick, and the next frame — still carrying
 *  `wasSuppressed` from before — reset it away. Not just its pressed edge: `reset()` clears
 *  `activeId`, so the gesture's later move/up fall through pointerSource's
 *  `pointerId !== activeId` checks too, and a drag-to-aim died whole. The second click
 *  worked, which is what made it read as flaky rather than broken.
 *
 *  Draining every suppressed frame keeps the backlog property (nothing survives to replay)
 *  while leaving the reopened frame untouched, so a press that arrives AFTER the gate opens
 *  is delivered. It also removes the edge bookkeeping entirely — there is no `wasSuppressed`
 *  any more, and no way to get its two edges out of step.
 *
 *  This runs only while a host gate is installed AND closed — i.e. in the editor, with the
 *  sim playing and a non-game panel focused. A shipped game installs no gate and never
 *  reaches it. `reset()` must stay CHEAP for that reason: it is now per-frame, not per-edge. */
export function sampleAll(out: InputFrame): void {
  if (isInputSuppressed()) {
    for (const s of sources) drain(s);
    return;
  }
  for (const s of sources) s.sample(out);
}

/** Names already reported for a throwing `reset()`, so the warning is once per source, not
 *  once per frame. Cleared in `unregisterSource` so a re-registered (fixed) source can warn
 *  again. */
const brokenResets = new Set<string>();

/** Drain one source, FAILING OPEN like the gate predicate above.
 *
 *  Why this is guarded when `sample()` is not: making the drain continuous (#264) removed the
 *  natural throttle that used to bound a throwing `reset()`. Under the old edge-triggered
 *  shape a throw could not repeat — the next suppressed frame took the early return, ran
 *  clean, and `frameDriver` clears a callback's error count on any successful run. Per-frame,
 *  a throwing reset throws EVERY suppressed frame, and `frameDriver` auto-unregisters a
 *  callback after 10 consecutive errors (rendering/frameDriver.ts) — that callback being the
 *  whole `'ecs'` pipeline. So a game registering one buggy `InputSource` could kill physics,
 *  animation and transforms for the session by clicking into an editor panel and leaving it
 *  there for a sixth of a second. None of the three built-in sources can throw (all pure
 *  field/Set writes), so this is a guard for `registerSource`'s public contract, not for us.
 *
 *  Swallowed but NOT silent: a broken reset strands held state, which is exactly what this
 *  mechanism exists to prevent, so it is reported once per source rather than hidden.
 *  `sample()` is deliberately left unguarded — it is unchanged by #264 and has always run
 *  once per unsuppressed frame, so guarding it here would be a behaviour change smuggled in
 *  under a fix for something else. */
function drain(s: InputSource): void {
  try {
    s.reset?.();
  } catch (err) {
    if (!brokenResets.has(s.name)) {
      brokenResets.add(s.name);
      console.error(`[input] source "${s.name}" threw in reset() — its held state cannot be cleared while input is suppressed, so it may strand. Reported once.`, err);
    }
  }
}

// Built-in sources. All four are always registered and all four are inert until they see
// input — a controller connects, the pointer goes down, or a scene authors a `TouchControl`
// (with none authored, `touch-control` matches no element and contributes nothing).
registerSource(keyboardSource);
registerSource(gamepadSource);
registerSource(pointerSource);
registerSource(touchControlSource);
// Multi-touch pan/pinch/tap. Independent of pointerSource's primary-touch latch — see its header.
registerSource(gestureSource);

/** App-scope Manager: attaches all sources on register. Replaces the old
 *  keyboard-only `inputManagerDef`.
 *
 *  `dispose` is now REACHABLE but still does not run. `teardownAll()`
 *  (`engine/app/ecs/register.ts`) unregisters `'Input'` with the other seven
 *  Managers and re-arms the latch, so #517's objection — wire this and nothing
 *  re-registers the sources, leaving input permanently dead — no longer holds:
 *  that was a property of the LATCH, not of this manager. But the only thing
 *  that calls `teardownAll()` is `App`'s unmount, which in practice fires only
 *  during StrictMode's boot cycle, before anything is registered. So input
 *  sources remain app-lifetime in every real run (#534), and `'Input'` is still
 *  listed in `appManagerDisposeReachable.test.ts`'s allowlist.
 *
 *  What makes that safe is the pairing of `detachAll()` here with `attachAll()`
 *  in `init` — the source ARRAY is untouched, so re-attaching finds all five
 *  sources still registered.
 *
 *  ⚠️ `unregisterSource()` is a different matter and is deliberately NOT on any
 *  teardown path. The five built-ins above are registered as a MODULE-EVAL side
 *  effect, so unregistering one splices it out of an array nothing will refill:
 *  irreversible for the process, and strictly worse than dropping the manager.
 *  It stays public for sources a GAME registers and owns. */
// Disposer for the device-prompt read sources ({confirmPrompt} etc.), registered
// alongside the sources so device-appropriate UI prompts are available app-lifetime.
let disposePromptSources: (() => void) | null = null;

export const inputSourcesManager: ManagerDef = {
  name: 'Input',
  scope: 'app',
  init: () => {
    attachAll();
    disposePromptSources = registerInputPromptSources();
  },
  dispose: () => {
    detachAll();
    disposePromptSources?.();
    disposePromptSources = null;
  },
};
