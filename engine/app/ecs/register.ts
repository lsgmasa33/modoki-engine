/** Register all traits and name transforms. Call once per app LIFETIME — `teardownAll()` below
 *  ends that lifetime and re-arms this, so the pair is a cycle, not a one-shot (#534).
 *  Game-specific postprocessors are registered via GameDefinition.registerPostprocessors(). */

import projectConfig from 'virtual:modoki-project-config';
import { registerAllTraits } from './registerTraits';
import { setNameTransform } from '@modoki/engine/runtime';
import { getGameConfig, registerEngineActions, registerAudioControls, registerHapticControls, registerQualityControls, registerVideoControls, registerManager, unregisterManagers, timeManager, navigationManager, physics2DEventsManager, physics3DEventsManager, zone2DEventsManager, zone3DEventsManager, timelineEventsManager, inputSourcesManager, setPhysicsLayers, setTargetFPS, setRenderSettings, getEffectiveTargetFps, audioDispose, disposeAllAudioBuffers, disposeAudioContext, clearLateUpdates } from '@modoki/engine/runtime';

/** Whether the app-scoped registration above is currently live. NOT a once-only latch any more:
 *  `teardownAll()` clears it, which is the whole reason an app teardown is safe to wire at all
 *  (#534). #517's objection — tear `'Input'` down and nothing re-registers it, so input goes
 *  permanently dead — was a property of the latch, not of the teardown. */
let registered = false;

export function registerAll() {
  if (registered) return;
  registered = true;

  registerAllTraits();
  // Engine built-in lifecycle UIActions (reload / quit), available to every game.
  registerEngineActions();
  // Built-in audio control layer: audio.* UIActions (play/pause/stop/setClip/
  // toggleCrossfade/setBusVolume/playOneShot) + the mixer store hook so sliders'
  // inputBinding resolves bus volumes. Lets games control audio declaratively.
  registerAudioControls();
  registerHapticControls();
  // Built-in quality control layer: quality.set (the player's Auto/Low/Mid/High choice),
  // so a settings screen can drive render tier declaratively too.
  registerQualityControls();
  // Skipped entirely when video is excluded — the `video.*` actions would have nothing to
  // drive, and registering them would pull the subsystem back into the bundle.
  if (__MODOKI_MODULE_VIDEO__) registerVideoControls();
  // Engine-global Managers (game scope → survive scene swaps):
  //  - TimeManager: anchors + timeSince* read sources for UI bindings.
  //  - NavigationManager: history stack + engine.loadScene / engine.navigateBack
  //    + canGoBack read source.
  registerManager(timeManager);
  registerManager(navigationManager);
  // Physics2DEvents: scene-scoped collision/sensor bus (activates per scene; clears
  // its subscribers on swap). The producer is physics2DSystem; game code subscribes.
  registerManager(physics2DEventsManager);
  // Physics3DEvents: the 3D equivalent — scene-scoped 3D collision/sensor bus.
  registerManager(physics3DEventsManager);
  // Zone2DEvents / Zone3DEvents: scene-scoped Zone trigger buses (physics-free enter/exit over
  // ZoneOccupant containment). Producers are zone2DSystem / zone3DSystem; game code subscribes.
  registerManager(zone2DEventsManager);
  registerManager(zone3DEventsManager);
  // TimelineEvents: scene-scoped Director sequence bus (start/marker/end). The producer is
  // timelineSystem; game code subscribes via onSequenceStart/onMarker/onSequenceEnd.
  registerManager(timelineEventsManager);
  // Input sources (app scope): attaches every registered input source (keyboard now;
  // pointer/gamepad later). The inputSystem samples them into the Input resource each frame.
  registerManager(inputSourcesManager);

  // Project-defined 2D physics collision layers + matrix → runtime registry.
  setPhysicsLayers(projectConfig.physics);
  // Project renderer knobs (targetFps, three backend/AA/shadows/tone/exposure, pixi
  // backend/AA/resolution, web canvas sizing) → engine render-settings registry.
  setRenderSettings(projectConfig.rendering);
  // Project frame-rate cap → frame driver (0 = uncapped / display refresh).
  //
  // ⚠️ ORDER IS LOAD-BEARING, and it is the reverse of what it was: the cap is read back through
  // `getEffectiveTargetFps()`, which needs the authored value already in the registry. It also
  // must go through that accessor rather than `projectConfig.rendering.targetFps` directly, so a
  // tier can clamp it (#202) — no tier is resolved this early, so the two agree here and diverge
  // the moment one is (`applyActiveTierToRuntime` re-applies it then).
  setTargetFPS(getEffectiveTargetFps());

  // Use nameTransform from game config if provided
  const config = getGameConfig();
  if (config.nameTransform) {
    setNameTransform(config.nameTransform);
  }
}

/** The inverse of `registerAll()` — end the app-scoped lifetime and re-arm it (#534).
 *
 *  Before this existed, every teardown half written for app-lifetime state was unreachable BY
 *  CONSTRUCTION: nothing unmounts the app, and `registered` was a once-only latch, so anything
 *  that tore an app-scoped mechanism down left nothing to bring it back. That is why #517
 *  declined to wire `unregisterManager('Input')` and documented the trap instead. The re-arm at
 *  the bottom of this function is what retires that objection — teardown and re-register are one
 *  cycle, and calling this without a `registerAll()` after it is the caller's bug, not this
 *  function's.
 *
 *  ⚠️ THE TRIGGER IS NOT YET EFFECTIVE — measured, #534 close-out. The only production caller is
 *  `App`'s unmount cleanup (App.tsx), the only thing that unmounts `App` is React StrictMode's
 *  synchronous mount → unmount → remount, and BOTH `registerAll()` call sites (`ecs/init.ts` via
 *  GameShell's boot effect, `editor/setup.ts` via a React.lazy factory) sit downstream of awaits.
 *  So this always runs with `registered === false` and returns immediately. Instrumented in
 *  `tests/app/appTeardownStrictMode.test.tsx`, which pins that as the current reality. The function
 *  below is correct and re-arms correctly; what is missing is a trigger that fires AFTER
 *  registration — candidates are #516's A→B→A game swap and an error boundary raised above
 *  `GameShell`. Until then `disposeAudioContext` and friends still do not run.
 *
 *  What it deliberately does NOT undo: the built-in UIAction layers (`registerEngineActions` and
 *  friends). Re-running them is harmless, but NOT for the reason it looks — `registerAudioControls`
 *  is not a pure name → function map write: it also calls `addStoreHook(useAudioMixSelector)` and
 *  `setUIClickCue(...)`. What makes it safe is its OWN once-only latch (`audioControls.ts`), which
 *  no-ops the re-run; `engineActions` carries one too. `haptic`/`quality`/`video` carry none and
 *  need none — they only write action-registry entries, which are keyed and idempotent. ⚠️ If a
 *  refactor ever drops the `audioControls` latch, every teardown/re-register cycle appends another
 *  store hook. Traits are genuinely the simple case: `registerTrait` evicts by name.
 *
 *  Two of #534's six stay unwired on purpose, each for a reason worth keeping:
 *    - `unregisterSource` — the five built-in sources are registered as a MODULE-EVAL side effect
 *      (`inputSources.ts`), so unregistering one splices it out of an array nothing will refill:
 *      irreversible, and strictly worse than dropping the manager. `inputSourcesManager.dispose`
 *      only `detachAll()`s, which `attachAll()` undoes — that is the reversible teardown, and it
 *      is the one this reaches.
 *    - `unregisterLateUpdate` — a symmetric public extension point for games (IK / look-at /
 *      recoil), not a teardown half; `registerLateUpdate` has no production callers either. The
 *      app-scoped sweep is `clearLateUpdates()` below. */
export function teardownAll() {
  if (!registered) return;

  // Managers first, and they carry the most: each `dispose` unsubscribes the listeners its
  // `init` installed and drops the manager's own UIActions, so TimeManager's three read sources
  // and NavigationManager's `engine.loadScene` / `engine.navigateBack` go with them.
  //
  // ⚠️ The names are STRING LITERALS INLINE AT THIS CALL, not a named const and not
  // `.map(m => m.name)`. `engine/tests/architecture/appManagerDisposeReachable.test.ts` proves
  // this wiring by scanning source text for `unregisterManagers?(` followed by the name, and it
  // distrusts identifiers on purpose — several buses share the generic binding name `manager`,
  // so trusting an ident would let one file's call "prove" three managers wired. Hoisting these
  // into a `const` and passing it reads tidier and is INVISIBLE to that guard: measured, the
  // guard reported all three app-scoped managers unreachable with exactly that shape. A
  // drift-proof-looking refactor here silently un-proves the wiring, which is why the parity
  // check in `register.test.ts` compares this list against what `registerAll` actually registers.
  unregisterManagers([
    'engine.time',
    'engine.navigation',
    'Physics2DEvents',
    'Physics3DEvents',
    'Zone2DEvents',
    'Zone3DEvents',
    'TimelineEvents',
    'Input',
  ]);

  // Audio, and THE ORDER IS LOAD-BEARING. `audioService`'s node graph caches GainNodes hanging
  // off the shared context, and the buffer cache holds AudioBuffers that context decoded. Close
  // the context first and both survive pointing at a dead one — which `graphOrNull()` cannot
  // detect, since it only rebuilds when `graph` is null. Service, then buffers, then the context.
  audioDispose();
  disposeAllAudioBuffers();
  disposeAudioContext();

  // Game-registered LateUpdate systems close over the outgoing world; the game's own setup
  // re-registers them.
  clearLateUpdates();

  // The re-arm. Everything above is a one-way kill without it.
  registered = false;
}
