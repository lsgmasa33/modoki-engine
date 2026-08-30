import React, { Component, lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { Capacitor } from '@capacitor/core';
import { useWebCanvasSizing } from './useWebCanvasSizing';
import { useGameLoop, setGameConfig, sceneManager, ensureManifestLoaded, resolveSceneByName, assetUrl, appServices, clearAppServices, getCurrentWorld, PlayerPrefs, selectDefaultBackend, waitForScenePaint } from '@modoki/engine/runtime';
import { App as CapacitorApp } from '@capacitor/app';
import { DefaultGameUILayer } from './ui/DefaultGameUILayer';
import ErrorBoundary from './ui/components/ErrorBoundary';
import { EditorBootBoundary } from './ui/components/EditorBootBoundary';
import LoadingOverlay from './ui/components/LoadingOverlay';
import { dismissBootSplash, hasBootSplash, BOOT_SPLASH_TIMEOUT_MS } from './ui/bootSplash';
import { initWorldSync } from './ecs/init';
import { runPipeline } from './ecs/pipeline';
import { GAMES } from 'virtual:modoki-games';
import type { GameDefinition } from '@modoki/engine/runtime';
import { setActiveResetPhase } from './ui/components/ErrorBoundary';
import { audioDispose, audioResume } from '@modoki/engine/runtime';
import { VideoOverlay } from '@modoki/engine/runtime';
import { useKeyboardShift } from './hooks/useKeyboardShift';
import { onTierSwitchOverlay } from '@modoki/engine/runtime';
import { checkAppOtaUpdate, isPluginUnimplemented, subscribeOtaGate, type OtaGateState } from './ota';
import OtaRestartGate from './ui/components/OtaRestartGate';
import { loadStagedSubgames } from './subgameLoader';
import { findGame as findGameInRegistry } from './gameRegistry';
import './App.css';

// NOTE: the app shell no longer reaches into a specific game (it used to eagerly
// `registerManager(sceneSelectorNav)` from games/scene-selector). Under the
// one-project-per-game model the app core is game-agnostic — each game registers
// its own managers via its config/setup (the scene-selector registers
// `sceneSelectorNav` in its own config.ts). A shipped flat game never bundles
// another game's code.

// Lazy-load editor (dev tool, never in a shipped game/playable bundle). Present
// ONLY in editor + dev builds (__MODOKI_EDITOR__ true); a game/native/playable
// build has __MODOKI_EDITOR__ === false → GAME_ONLY true → the dynamic import
// below is dead-code-eliminated and the ~800 KB editor chunk never ships.
// (Previously gated on VITE_GAME_ONLY, which only the web-DEPLOY step set — so a
// plain `MODOKI_PROJECT=… npm run build` leaked the whole editor into the bundle.)
const GAME_ONLY = !__MODOKI_EDITOR__;
const EditorApp = GAME_ONLY ? null : lazy(() => import('./editor/setup').then(m => m.createGameEditor()));

// In-game debug menu (F12 / 3-finger tap). Present in the editor and in a game build
// that opts in via project.config.json `build.debugBuild`. The flag is a build-time
// constant so the dynamic import below is dead-code-eliminated and the whole
// debug-menu chunk never ships when off. See docs/debug-menu.md.
const DEBUG_MENU_ON = __MODOKI_EDITOR__ || __MODOKI_DEBUG_BUILD__;
const DebugMenu = DEBUG_MENU_ON
  ? lazy(() => import('@modoki/engine/runtime/debug').then(m => ({ default: m.DebugMenu })))
  : null;

// Renderer layers are flag-gated lazy imports so an excluded renderer's SDK
// (three.webgpu / pixi.js) is dead-code-eliminated (build.modules.render3d/2d).
// Imported from LEAF subpaths, not the '@modoki/engine/runtime/rendering' barrel,
// so each dynamic chunk pulls ONLY its own renderer (the barrel re-exports both).
const Scene3D = __MODOKI_MODULE_RENDER3D__
  ? lazy(() => import('@modoki/engine/runtime/rendering/Scene3D'))
  : null;
const Game = __MODOKI_MODULE_RENDER2D__
  ? lazy(() => import('@modoki/engine/runtime/rendering/Game'))
  : null;

/** Lightweight error boundary around custom game UI — falls back to default UIRenderer
 *  instead of resetting the entire game. The game keeps running underneath. */
class GameUIErrorBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[GameUIErrorBoundary] Custom game UI crashed, falling back to default:', error, info.componentStack);
  }
  render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}

function useHashRoute() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return hash;
}

/** Resolve a game definition by ID — the project's baked game(s) plus any OTA Phase 4
 *  sub-game bundles loaded so far this session (gameRegistry.ts). */
function findGame(gameId: string): GameDefinition | undefined {
  return findGameInRegistry(gameId);
}

/** Keeps Scene3D/Game/UIRenderer mounted across game changes. On gameId change:
 *    1. Keep rendering the current (old) game.
 *    2. Preload the new game's loaders/systems/config + scene via sceneManager.
 *    3. SceneManager performs an atomic two-world swap once everything (including
 *       shader prewarm via the registerBeforeSwap hook in Scene3D) is ready.
 *    4. Hide the loading overlay.
 *
 *  Because the renderer layers stay mounted, there's no unmount/remount stutter
 *  and the user sees the previous scene animating smoothly until the swap.
 *
 *  NOTE: Scene3D captures GameConfig at mount only (Scene3D.tsx). Today both
 *  games' sceneSetup hooks are no-ops so this is safe. If a future game needs
 *  per-game sceneSetup, Scene3D will need a gameConfig subscription. */
/** Exported for `tests/app/gameShellLoadOnce.test.tsx` (#267) — the boot sequence's
 *  once-per-game contract is a React SCHEDULING property, so it can only be pinned by
 *  rendering the real component; there is no pure module to extract it into. */
export const GameShell = React.memo(function GameShell({ gameId }: { gameId: string }) {
  useKeyboardShift();

  // The engine applies a quality-tier promotion mid-play when no scene boundary arrives to hide the
  // shader recompile in (#227) — a single-scene game never reaches one. It publishes copy here so
  // the player sees an explained pause rather than a freeze. Subscribed once for the app's life;
  // the initial read covers a switch that started before this effect ran.
  useEffect(() => onTierSwitchOverlay(setTierSwitchMessage), []);

  // configReady: config is set, renderers can mount (scene may not be loaded)
  // initialized: scene loaded + rendered, everything ready
  // transitioning: game-to-game swap in progress (overlay visible)
  const [configReady, setConfigReady] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transitioning, setTransitioning] = useState(false);
  const [GameUI, setGameUI] = useState<React.ComponentType | null>(null);
  const [disable3D, setDisable3D] = useState(false);
  const [otaGate, setOtaGate] = useState<OtaGateState | null>(null);
  /** Copy for the tier-switch overlay, or null when no tier switch is being applied (#227). The
   *  engine publishes it (`onTierSwitchOverlay`); this is its ONE reader. */
  const [tierSwitchMessage, setTierSwitchMessage] = useState<string | null>(null);
  const activeGameIdRef = useRef<string | null>(null);
  /**
   * Mirrors of `configReady` / `initialized` for the LOAD EFFECT to read (#267).
   *
   * ⚠️ THE EFFECT BELOW SETS BOTH OF THOSE STATE VALUES MID-BODY, so reading the state
   * itself would put them in its dependency array — and an effect that depends on state it
   * writes re-runs itself. It did: `setConfigReady(true)` (still ~100 lines from the end)
   * flipped a dependency while `activeGameIdRef` was still null, so the re-entrancy guard at
   * the top could not bail, and the whole sequence — `registerSystems`, `registerAppServices`,
   * `attribution.init()`, `PlayerPrefs.init`, `loadScene` — ran a SECOND time for the same
   * game. Measured on an iPhone 8, 2026-08-19: two ATT consent prompts in one launch
   * (`requestTrackingAuthorization` at 21:49:33.175 and 21:49:35.364).
   *
   * So the dependency array of that effect is `[gameId]` and must stay that way. The contract
   * that buys — every `GameDefinition` hook is called ONCE per game load, so a hook may hold a
   * side effect that must not repeat — is documented in
   * `docs/architecture.md` § "The boot effect runs EXACTLY ONCE per `gameId`", and pinned by
   * `tests/app/gameShellLoadOnce.test.tsx`.
   */
  const configReadyRef = useRef(false);
  const initializedRef = useRef(false);
  /** Whether this shell started the no-3D tier-calibration loop, so a game swap knows to stop it.
   *  A ref rather than state: it is read inside the load effect and must never re-run it. */
  const no3DTierLoopRef = useRef(false);

  useEffect(() => subscribeOtaGate((gate) => {
    // An OTA gate must be SEEN. The boot splash outranks every boot surface by z-index, so a
    // download that starts before the game is ready would otherwise show a still launch image for
    // however long the download takes — indistinguishable from a hang, on exactly the slow
    // connection where it lasts longest.
    if (gate) dismissBootSplash();
    setOtaGate(gate);
  }), []);

  // ⚠️ The boot splash outranks EVERY other surface by z-index, so any path that ends with the
  // user looking at the app has to take it down — otherwise a real, explained failure is a static
  // launch image forever. Three nets, because the success path alone is not enough:
  //
  //  1. any `error` state (the unknown-gameId early return below never reaches the try/catch,
  //     and `gameId` comes from the URL hash — a stale bookmark or a deep link reaches it);
  //  2. a hard TIMEOUT, which is the only thing that covers a render-time throw caught by
  //     `<ErrorBoundary>` (its fallback renders inside this component, i.e. UNDER the splash) and
  //     a boot that simply never completes — the two rAFs the load path awaits do not fire in a
  //     backgrounded tab;
  //  3. the success and OTA paths, below.
  useEffect(() => { if (error) dismissBootSplash(); }, [error]);

  // Hand the NATIVE splash over to the web boot splash as soon as the latter is on screen, rather
  // than holding it until the game is ready.
  //
  // ⚠️ This is what makes the authored splash visible on Android at all. From API 31 the platform
  // draws its OWN splash — an icon on a solid colour — and ignores the generated drawables
  // entirely (measured on an S22, API 34); a full-bleed image is not expressible there, by
  // platform design. So the art has to come from the web layer, and it cannot if the native
  // splash covers the web view until the game has already painted.
  //
  // Phase 3b held it until fully-booted so nobody saw an unstyled white web view. That reason is
  // gone: the web view's FIRST PAINT is now the boot splash, the same artwork. The hold therefore
  // stays in place for any project that has no boot splash to hand over to — which is the
  // `hasBootSplash()` condition, not a nicety.
  useEffect(() => {
    if (!Capacitor.isNativePlatform() || !hasBootSplash()) return;
    import('@capacitor/splash-screen')
      .then((m) => m.SplashScreen.hide())
      .catch((e) => {
        if (isPluginUnimplemented(e)) console.log('[GameShell] no SplashScreen plugin — early hide skipped');
        else console.warn('[GameShell] early SplashScreen.hide failed (non-fatal):', e);
      });
  }, []);
  useEffect(() => {
    const t = window.setTimeout(dismissBootSplash, BOOT_SPLASH_TIMEOUT_MS);
    return () => window.clearTimeout(t);
  }, []);

  useEffect(() => {
    const def = findGame(gameId);
    if (!def) {
      setError(`Unknown game: "${gameId}"`);
      return;
    }
    if (activeGameIdRef.current === gameId) {
      // Already the loaded game, so there is no transition in progress — and saying so is
      // load-bearing, not tidiness. A→B→A while B is still in flight cancels B's run before
      // it can reach either `setTransitioning(false)` below, and lands here, where the old
      // early return left `transitioning` stuck TRUE for the rest of the session: the
      // opaque LoadingOverlay covers a game that is running perfectly well underneath.
      setTransitioning(false);
      return; // no-op re-render
    }

    // A previous game's failure must not outlive it. `error` gates the whole render tree
    // (`if (error) return <error page>`) and had no path back to null anywhere in this file,
    // so an unknown gameId — or one game failing to load — left the error screen up even
    // after a later game loaded successfully behind it. React bails out of the re-render
    // when the value is already null, so this costs nothing on the ordinary path.
    setError(null);

    let cancelled = false;
    /** Cancel token for the awaits that park on something OTHER than a promise this body owns —
     *  today the render-readiness wait (#334), which would otherwise hold its 5 s timer alive
     *  after a game change. `cancelled` still guards every resumption point; this makes the
     *  waiter itself let go rather than merely being ignored when it lands. */
    const abortBoot = new AbortController();
    const isFirstLoad = !initializedRef.current;

    // Show overlay for game-to-game transitions. For first load, the opaque
    // overlay renders on top of the (empty) renderers — same visual as before.
    if (!isFirstLoad) setTransitioning(true);

    (async () => {
      try {
        // Tear down previous game's systems before registering the new game's.
        // Without this, projection systems from prior games keep running and
        // operating on the wrong world state.
        const prevGameId = activeGameIdRef.current;
        if (prevGameId && prevGameId !== gameId) {
          const prevDef = findGame(prevGameId);
          if (prevDef?.unregisterSystems) await prevDef.unregisterSystems();
          clearAppServices(); // drop the previous game's services before the next registers
          // ⚠️ AND THE 2D TIER-CALIBRATION LOOP, which the no-3D boot path below registers on the
          // frame driver (#203). It was exported with a teardown and never given one: swapping a
          // 2D game for a 3D one skipped the branch that starts it, so nothing stopped it, and
          // `Scene3D` then ticked `tickTierCalibration` alongside it every frame for the rest of
          // the session. Stopped unconditionally here and restarted below only if the NEW game
          // needs it, so the pair is symmetric rather than conditional at both ends — a
          // conditional teardown is what produced the leak.
          if (no3DTierLoopRef.current) {
            const { stopTierCalibrationForNo3DProject } =
              await import('@modoki/engine/runtime/rendering/tierBoot');
            stopTierCalibrationForNo3DProject();
            no3DTierLoopRef.current = false;
          }
        }
        if (cancelled) return;
        if (def.registerPostprocessors) await def.registerPostprocessors();
        if (cancelled) return;
        if (def.registerSystems) await def.registerSystems();
        if (cancelled) return;
        // Register this game's app-services (analytics/crashlytics/ads/attribution),
        // then drive native init (ads/attribution are no-ops off-device). The
        // service code + SDK deps live in the GAME's package, not the engine.
        // OMITTED in a playable ad build: an ad creative ships no native SDKs, must not
        // fire the game's own analytics/attribution, and pulling the service package in
        // only bloats the single-file bundle.
        if (!__MODOKI_PLAYABLE__ && def.registerAppServices) await def.registerAppServices();
        if (cancelled) return;
        if (Capacitor.isNativePlatform()) {
          void appServices().attribution?.init();
          void appServices().ads?.init();
        }
        // Hydrate this game's persistent prefs before scene load, so systems that
        // read saved progress at spawn see it. Namespaced by gameId; ungated by
        // platform (web + editor persist to localStorage, device to Preferences).
        //
        // ⚠️ ORDERING IS LOAD-BEARING FOR THE QUALITY TIER TOO (#121 P3d). The renderer resolves
        // its tier at bring-up and reads the PLAYER's saved choice through `playerTierStore`,
        // which reads this cache SYNCHRONOUSLY. `setConfigReady(true)` below is what mounts
        // Scene3D, so this await must stay ahead of it — move it after and a player's chosen tier
        // silently reads as null on every launch, falling back to the project setting with no
        // error anywhere.
        const prefsInit = await PlayerPrefs.init({ namespace: gameId, backend: selectDefaultBackend() });
        if (prefsInit.discardedPending.length > 0) {
          console.error(
            `[App] PlayerPrefs.init() discarded pending write(s) while swapping from ` +
              `"${prevGameId || '(none)'}" to "${gameId}": ${prefsInit.discardedPending.join(', ')}`,
          );
        }
        if (cancelled) return;
        if (def.resetPhase) setActiveResetPhase(def.resetPhase);

        // Resolve custom UI component (supports lazy and eager)
        if (def.UIComponent) {
          // React.lazy components are functions with $$typeof — just use them directly
          setGameUI(() => def.UIComponent!);
        } else {
          setGameUI(null);
        }

        const config = await def.loadConfig();
        if (cancelled) return;

        setGameConfig(config);
        const no3D = !!config.disable3D || !Scene3D;
        setDisable3D(!!config.disable3D);

        if (isFirstLoad) {
          // First-ever render: trait registry + font kickoff.
          initWorldSync();
        }
        // ⭐ A PROJECT WITH NO 3D SURFACE RESOLVES ITS QUALITY TIER HERE (#203).
        //
        // A 3D project resolves inside `makeWebGPURenderer`, and must: `antialias` is a renderer
        // CONSTRUCTOR option, so a tier decided after the first drawing buffer exists cannot apply
        // it. A project that never builds a renderer therefore never reached that call at all —
        // `getActiveQualityTier()` stayed null for the process lifetime, `getActiveTierOverrides()`
        // returned UNCLAMPED, and every field in the `rendering.three.tiers` config chess,
        // audio-demo and space-invader were seeded with did nothing. This is the missing door.
        //
        // ⚠️ `!Scene3D` as well as `config.disable3D` — they are DIFFERENT projects and the second
        // is the one a `disable3D` check misses. `space-invader` sets `build.modules.render3d:
        // false`, which makes `Scene3D` null at build time while `disable3D` stays unset, so a
        // condition on the config flag alone would leave the playable-ad project — the one with the
        // tightest performance budget here — exactly as unclassified as before.
        //
        // ⚠️ AWAITED, and ahead of `setConfigReady`. The 2D backing-buffer scale comes from the
        // resolved tier and `setConfigReady(true)` is what mounts the renderers; resolving after it
        // would size the first buffers unclamped and pop when the tier landed. Same ordering
        // argument as the `PlayerPrefs.init` above, which is awaited here for the sibling reason
        // (the player's saved tier choice is read synchronously out of that cache).
        //
        // ⚠️⚠️ **AND IT MUST COME AFTER `initWorldSync()`, WHICH IS WHERE THE PROJECT'S RENDER
        // SETTINGS ARE INJECTED** (`ecs/register.ts` → `setRenderSettings(projectConfig.rendering)`).
        // It sat one block earlier for its first hour and was silently WRONG on device: with the
        // settings still at their defaults, `three.tiers` is empty, the resolver's "one config ⇒
        // nothing to choose between" gate fires, and the project publishes `{tier: 'high', source:
        // 'single-config'}` — i.e. UNCLAMPED — before its two authored configs exist. Sticky, too:
        // `resolveActiveTier` early-outs on an existing tier, so the correct resolution can never
        // happen afterwards. Measured on a Galaxy A23 running `games/space-invader`: not one probe
        // line across a wiped launch, because the tier had already been decided from an empty
        // config. Pinned by `tierBoot.test.ts` ("resolving before the project's tiers are loaded").
        //
        // ⭐ **AND A 3D PROJECT RESOLVES HERE TOO NOW (#212, 2026-08-14).** It used to resolve
        // ONLY inside `makeWebGPURenderer`, which was fine while every tier knob was read by the
        // renderer itself — and stopped being fine the moment a tier knob was read by the ASSET
        // path. `textureMaxSize` is consulted when a scene's textures resolve, and scene load
        // races renderer creation, so the cap arrived too late to choose a variant. Measured on a
        // Galaxy A23 pinned `low`: cap 512 in force, `sizes:[512]` in the manifest, 21 `@512`
        // files in the APK, and 0 of 21 textures fetched the capped URL. Silent, because the
        // uncapped URL is the correct fallback for "no cap".
        const { resolveTierForNo3DProject, resolveTierBeforeSceneLoad } =
          await import('@modoki/engine/runtime/rendering/tierBoot');
        if (no3D) {
          await resolveTierForNo3DProject();
          no3DTierLoopRef.current = true;
        } else {
          // The 3D shape (`shade`, not `fill`), and no calibration loop — `Scene3D` owns that one.
          await resolveTierBeforeSceneLoad();
        }
        if (cancelled) return;


        // Mount renderers BEFORE scene load so their registerBeforeSwap hooks
        // (Scene3D shader prewarm, Scene2D sprite preload) are registered in
        // time. configReady gates the mount; the opaque LoadingOverlay covers
        // everything until the scene is fully loaded and rendered.
        if (!configReadyRef.current) {
          configReadyRef.current = true;
          setConfigReady(true);
          // Yield to React so Scene3D/Game/UIRenderer mount and their useEffects
          // run (registering beforeSwap hooks). Two rAFs to cover PixiJS
          // Application async init. If hooks aren't registered in time, the
          // existing async fallbacks (makeSprite, syncRenderables) handle it.
          await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
          if (cancelled) return;
        }

        // The asset manifest (guid → path map) MUST be populated before the
        // scene loads, or every GUID ref resolves to undefined (missing meshes,
        // black materials). Memoized + shared with the font loader, so this is
        // a no-op await once initWorldSync's fetch has settled.
        await ensureManifestLoaded(config.assetManifest || '/assets.manifest.json');
        if (cancelled) return;

        // SceneManager is cancel-and-replace, so back-to-back calls here are
        // safe — any in-flight previous load is aborted inside loadScene().
        // Pass the gameId so game-scoped managers swap with the game (this is the
        // production game-switch chokepoint; in-game scene swaps go through
        // NavigationManager without a gameId and keep the active game).
        // Public web shell honors a `?scene=` query param so each scene of a
        // demo has its own shareable URL (e.g. /3d-test/?scene=skinned-test).
        // Resolved against the already-loaded manifest by GUID or filename; if it
        // doesn't match a shipped scene we fall back to the game's boot scene.
        const requestedScene = new URLSearchParams(window.location.search).get('scene');
        // resolveSceneByName returns the base-relative manifest path; assetUrl adds
        // the deploy sub-path prefix so the fetch resolves under /<id>/ (idempotent,
        // matching how config.scenePath's `?url` import is already base-prefixed).
        const resolved = requestedScene ? resolveSceneByName(requestedScene) : undefined;
        const overridePath = resolved ? assetUrl(resolved) : undefined;
        if (requestedScene && !overridePath) {
          console.warn(`[GameShell] ?scene="${requestedScene}" did not match a shipped scene; using default.`);
        }
        // OTA update check (docs/ota-updates.md, Phase 3a/3b) — deliberately BEFORE
        // scene load: a game's onSceneReady only fires after the scene has already
        // rendered, too late for the blocking gate below to have anywhere to block
        // from. A routine (non-mandatory) update, an error, or nothing to do all
        // resolve `true` and boot proceeds normally in the background.
        // `false` means a MANDATORY update just finished staging — stop here and
        // defer to the OtaRestartGate UI (subscribed via `otaGate` above) for the
        // rest of this app launch; never load the scene this session (no
        // mid-session hot-swap — see the plan's Phase 3 decision).
        const otaShouldProceed = await checkAppOtaUpdate();
        if (cancelled) return;
        if (!otaShouldProceed) return;

        // OTA Phase 4 — a sub-game's config.scenePath is a root-relative build-output
        // literal baked against ITS OWN origin (config.assetBaseUrl, set by
        // subgameLoader.ts), not the shell's — prefix it here or the fetch 404s
        // against the shell's webroot instead of the staged bundle. Unset (baked
        // shell game) is a no-op. See config.ts's assetBaseUrl doc.
        const defaultScenePath = config.assetBaseUrl && config.scenePath?.startsWith('/')
          ? config.assetBaseUrl + config.scenePath
          : config.scenePath;
        const bootScenePath = overridePath ?? defaultScenePath;
        if (bootScenePath) {
          await sceneManager.loadScene(bootScenePath, { gameId });
        }
        if (cancelled) return;

        // Game warm-up: instantiate runtime-generated content (not in the scene's
        // resources manifest) BEFORE the overlay hides, so it doesn't pop in a few frames
        // after the game appears (e.g. sling's field, generated by rebuildField). Best-
        // effort — a failure logs and boot continues (the per-frame system still fills in).
        if (def.onSceneReady) {
          try { await def.onSceneReady(getCurrentWorld()); }
          catch (e) { console.warn('[GameShell] onSceneReady failed:', e); }
          if (cancelled) return;
        }

        // ⭐ WAIT FOR THE RENDERER TO ACTUALLY PAINT THIS SCENE (#334).
        //
        // This used to be the two-rAF wait alone, with a comment naming the very failure it then
        // shipped: two frames is a HEURISTIC, and `liveCompileGate` holds `Scene3D`'s submit for
        // as long as the post-swap live compile takes — 300 ms to 1 s on a mid-tier Android, i.e.
        // tens of frames. So the overlay hid, and the game's permanent HUD (title text, D-pad)
        // appeared over a flat dark canvas with nothing 3D drawn. Measured on a Galaxy A23 cold-
        // booting `demos/forest-camp`. The owner's verdict on seeing it: render NOTHING rather
        // than a half state.
        //
        // `waitForScenePaint` resolves on the first frame `Scene3D` actually SUBMITS after the
        // swap, so the hold and the overlay are finally the same decision. It resolves instantly
        // when that frame already landed (the ordinary trivial-compile case — no added delay), and
        // it is bounded by its own 5 s ceiling, mirroring the render-level hold's, so a renderer
        // that never draws cannot leave the overlay up forever.
        //
        // ⚠️ GATED ON `no3D` — the same condition that decides whether `Scene3D` is rendered at
        // all (`config.disable3D || !Scene3D`). A project with no 3D surface has nothing to arm or
        // mark the signal, so awaiting it there would buy a 5 s stall on every boot. And on
        // `bootScenePath`, because no scene load means no world swap means nothing armed.
        if (!no3D && bootScenePath) {
          const paint = await waitForScenePaint({ signal: abortBoot.signal });
          if (paint === 'timeout') {
            console.warn('[GameShell] renderer did not paint the loaded scene before the readiness ceiling — revealing the game anyway');
          }
          if (cancelled) return;
        }
        // …and THEN two render frames, as before: `syncRenderables` must place whatever
        // `onSceneReady` just spawned (content generated at runtime is not in the scene at swap
        // time, so the paint above cannot have included it), and the submitted frame has to reach
        // the swapchain. Kept as well as the wait above, not replaced by it — they cover different
        // halves of "there is something under the overlay".
        await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
        if (cancelled) return;

        // OTA boot-watchdog confirm (docs/ota-updates.md):
        // THIS is the app's own "fully booted" signal (rendered a real frame of the
        // ACTUAL game, not just index.html loading) — the exact proof-of-boot the native
        // watchdog's two-boot-confirm design assumes. Best-effort and native-only: a
        // failure here must never block the game the player is already looking at, and
        // web has no OTA mechanism to confirm anything for (ModokiOtaWeb no-ops it
        // anyway, but skip the dynamic import entirely rather than pay for it on web).
        if (Capacitor.isNativePlatform()) {
          import('capacitor-modoki-ota')
            .then((m) => m.ModokiOta.confirmBoot({ name: 'shell' }))
            .catch((e) => {
              // A project without the OTA native plugin rejects this on EVERY launch, so a warn
              // here files a Crashlytics issue per session for a non-event. A real confirmBoot
              // failure still warns — on a project that ships OTA it is what the rollback
              // watchdog keys on. See `isPluginUnimplemented`.
              if (isPluginUnimplemented(e)) console.log('[GameShell] no OTA plugin on this platform — confirmBoot skipped');
              else console.warn('[GameShell] OTA confirmBoot failed (non-fatal):', e);
            });
        }

        // Dismiss the native splash on this SAME "fully booted" signal (Phase 3b) —
        // previously nothing called this, so the splash dismissed on Capacitor's own
        // fixed ~3s timer regardless of actual load time (a plugin with no native impl
        // yet, or launchAutoHide left at its Capacitor default of true, makes this a
        // harmless no-op — see capacitor.config.json's plugins.SplashScreen). Only on
        // a FIRST load: a game-to-game switch mid-session has no splash left to hide.
        if (Capacitor.isNativePlatform() && isFirstLoad) {
          import('@capacitor/splash-screen')
            .then((m) => m.SplashScreen.hide())
            .catch((e) => {
              // Same shape as the OTA catch above. Not observed firing — SplashScreen ships in
              // every project today — but a project that drops it would warn every launch.
              if (isPluginUnimplemented(e)) console.log('[GameShell] no SplashScreen plugin — hide skipped');
              else console.warn('[GameShell] SplashScreen.hide failed (non-fatal):', e);
            });
        }

        // The WEB boot splash, on the same "fully booted" signal as the native one above — the two
        // are the same artwork, so the handoff is one continuous image rather than a cut to dark
        // navy. A no-op wherever no boot splash was injected (dev, editor, playable, or a project
        // that has authored no splash).
        dismissBootSplash();

        activeGameIdRef.current = gameId;
        initializedRef.current = true;
        setInitialized(true);
        setTransitioning(false);
      } catch (e) {
        if (!cancelled) {
          console.error('[GameShell] Failed to load game:', e);
          // Take the splash down so the error is SEEN: it outranks every boot surface by z-index,
          // so leaving it up turns an explained failure into an apparent hang.
          dismissBootSplash();
          setError(String(e));
          setTransitioning(false);
        }
      }
    })();

    return () => { cancelled = true; abortBoot.abort(); };
    // ⚠️ `[gameId]` ONLY — see the `configReadyRef`/`initializedRef` note above (#267). This
    // effect writes `configReady` and `initialized`; listing either here makes it re-run
    // itself and double-drive every registration in the body.
  }, [gameId]);

  // Shipped web build's screen sizing (rendering.web.sizeMode). `fixed` letterboxes
  // the game to its authored aspect; `free`/`max` fill the viewport (max clamps the
  // 3D drawing buffer in Scene3D instead). Editor viewports are unaffected — this is
  // the standalone game shell only.
  const sizeBox = useWebCanvasSizing(configReady);

  if (error) {
    return (
      <div style={{ color: '#ff6b6b', padding: 40, background: '#0a0a1a', minHeight: '100vh' }}>
        <p>{error}</p>
        <a href="#/" style={{ color: '#6b9fff' }}>Back to game selector</a>
      </div>
    );
  }

  if (!configReady) {
    return <div style={{ color: '#888', padding: 40, background: '#0a0a1a', minHeight: '100vh' }}>Loading...</div>;
  }

  return (
    <div
      className="app-container"
      style={sizeBox.letterboxed ? { display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#000' } : undefined}
    >
      <ErrorBoundary>
        <div
          className="game-wrapper"
          style={sizeBox.letterboxed ? { width: sizeBox.cssWidth, height: sizeBox.cssHeight, flex: '0 0 auto' } : undefined}
        >
          {Scene3D && !disable3D && <Suspense fallback={null}><Scene3D /></Suspense>}
          {Game && <Suspense fallback={null}><Game /></Suspense>}
          {GameUI ? (
            <GameUIErrorBoundary fallback={<DefaultGameUILayer />}>
              <Suspense fallback={null}><GameUI /></Suspense>
            </GameUIErrorBoundary>
          ) : (
            <DefaultGameUILayer />
          )}
          {/* Cutscene layer — above the game + UI, below the loading/OTA gates (a
              download prompt must still win over a movie). Renders nothing unless a
              presentation-mode clip is playing. */}
          {__MODOKI_MODULE_VIDEO__ && <VideoOverlay />}
          <LoadingOverlay
            visible={!initialized || transitioning || tierSwitchMessage != null}
            // A tier switch must PAINT before the main thread blocks on the recompile, so it skips
            // the anti-flash delay. Boot and game swaps keep it.
            immediate={tierSwitchMessage != null}
            label={tierSwitchMessage ?? undefined}
            progress={otaGate?.phase === 'downloading' ? {
              fraction: otaGate.progress && otaGate.progress.bytesTotal > 0 ? otaGate.progress.bytesDone / otaGate.progress.bytesTotal : null,
              label: 'Downloading update…',
            } : null}
          />
          {otaGate?.phase === 'ready-to-restart' && <OtaRestartGate version={otaGate.version} />}
          {DebugMenu && <Suspense fallback={null}><DebugMenu /></Suspense>}
        </div>
      </ErrorBoundary>
    </div>
  );
});

function App() {
  const hash = useHashRoute();

  // Run ECS pipeline every frame (needed by both game and editor for Scene3D rendering)
  useGameLoop(runPipeline);

  // Cleanup native SDK listeners + audio context on unmount (prevents
  // accumulation on HMR and error-boundary recovery).
  useEffect(() => {
    return () => { appServices().ads?.cleanup(); audioDispose(); };
  }, []);

  // OTA Phase 4 (docs/ota-subgame-modules.md) — discover + load any sub-game
  // bundles already staged on this device, additively in the BACKGROUND. Deliberately
  // NOT part of GameShell's per-gameId boot effect (which resolves `findGame(gameId)`
  // synchronously at the top of its work, before any await) — this runs once, here, so
  // the existing boot path for every baked game stays behaviorally unchanged regardless
  // of whether/when this settles. A sub-game becomes selectable via `findGame` only once
  // this finishes; a future in-session game-switch is the intended consumer, not the
  // FIRST gameId this app launch resolves (that's always a baked game today).
  useEffect(() => {
    void loadStagedSubgames();
  }, []);

  // Make pending PlayerPrefs writes durable when the app is backgrounded/hidden —
  // debounced writes would otherwise be lost to an OS kill. Native fires
  // appStateChange; web fires visibilitychange/pagehide. (atomic ≠ durable; this
  // closes the durability gap the store documents.)
  useEffect(() => {
    const flush = () => { void PlayerPrefs.flush(); };
    const onVisibility = () => { if (document.visibilityState === 'hidden') flush(); };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    let appListener: { remove: () => void } | undefined;
    let cancelled = false; // cleanup may run before the async addListener resolves
    if (Capacitor.isNativePlatform()) {
      void CapacitorApp.addListener('appStateChange', ({ isActive }) => {
        if (!isActive) flush();
      }).then((h) => { if (cancelled) h.remove(); else appListener = h; });
    }
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
      appListener?.remove();
      flush(); // final flush on teardown (HMR / error-boundary recovery)
    };
  }, []);

  // Unlock the AudioContext on the first user gesture (mobile/WebView autoplay
  // policy suspends it until then). One-shot: the listeners remove themselves.
  useEffect(() => {
    const unlock = () => {
      audioResume();
      for (const evt of ['pointerdown', 'touchstart', 'keydown']) {
        window.removeEventListener(evt, unlock);
      }
    };
    for (const evt of ['pointerdown', 'touchstart', 'keydown']) {
      window.addEventListener(evt, unlock, { once: false });
    }
    return () => {
      for (const evt of ['pointerdown', 'touchstart', 'keydown']) {
        window.removeEventListener(evt, unlock);
      }
    };
  }, []);

  // Editor route (omitted from game-only builds)
  if (!GAME_ONLY && hash === '#/editor' && EditorApp) {
    return (
      <EditorBootBoundary>
        <Suspense fallback={<div style={{ color: '#fff', padding: 20, background: '#1a1a2e', height: '100vh' }}>Loading editor...</div>}>
          <EditorApp />
        </Suspense>
      </EditorBootBoundary>
    );
  }

  // Game route: #/game/<id> — pick gameId from hash. GameShell stays mounted
  // across gameId changes so the previous scene keeps rendering during preload.
  const gameMatch = hash.match(/^#\/game\/(.+)$/);
  // One project = one game: route hash wins, else the lone game in the set.
  const gameId = gameMatch ? gameMatch[1] : (GAMES[0]?.id || '');
  return <GameShell gameId={gameId} />;
}

export default App;
