import React, { Component, lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { Capacitor } from '@capacitor/core';
import { useGameLoop, setGameConfig, sceneManager, ensureManifestLoaded, resolveSceneByName, assetUrl, appServices, clearAppServices, computeContainerBox, getRenderSettings, getCurrentWorld, PlayerPrefs, selectDefaultBackend } from '@modoki/engine/runtime';
import { App as CapacitorApp } from '@capacitor/app';
import { DefaultGameUILayer } from './ui/DefaultGameUILayer';
import ErrorBoundary from './ui/components/ErrorBoundary';
import LoadingOverlay from './ui/components/LoadingOverlay';
import { initWorldSync } from './ecs/init';
import { runPipeline } from './ecs/pipeline';
import { GAMES } from 'virtual:modoki-games';
import type { GameDefinition } from '@modoki/engine/runtime';
import { setActiveResetPhase } from './ui/components/ErrorBoundary';
import { audioDispose, audioResume } from '@modoki/engine/runtime';
import { useKeyboardShift } from './hooks/useKeyboardShift';
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
// debug-menu chunk never ships when off. See docs/debug-menu-plan.md.
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

/** Resolve a game definition by ID (one project = one game). */
function findGame(gameId: string): GameDefinition | undefined {
  return GAMES.find(g => g.id === gameId);
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
/** Tracks the letterbox container box for the shipped web build's `rendering.web`
 *  sizeMode. Recomputes on window resize. For `free`/`max` the box fills the viewport
 *  (`letterboxed:false`) so the wrapper keeps its default 100%×100% CSS. */
function useWebCanvasSizing() {
  const [box, setBox] = useState(() =>
    computeContainerBox(window.innerWidth, window.innerHeight, getRenderSettings().web));
  useEffect(() => {
    const apply = () =>
      setBox(computeContainerBox(window.innerWidth, window.innerHeight, getRenderSettings().web));
    apply(); // re-read after boot-time setRenderSettings injection
    window.addEventListener('resize', apply);
    return () => window.removeEventListener('resize', apply);
  }, []);
  return box;
}

const GameShell = React.memo(function GameShell({ gameId }: { gameId: string }) {
  useKeyboardShift();

  // configReady: config is set, renderers can mount (scene may not be loaded)
  // initialized: scene loaded + rendered, everything ready
  // transitioning: game-to-game swap in progress (overlay visible)
  const [configReady, setConfigReady] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transitioning, setTransitioning] = useState(false);
  const [GameUI, setGameUI] = useState<React.ComponentType | null>(null);
  const [disable3D, setDisable3D] = useState(false);
  const activeGameIdRef = useRef<string | null>(null);

  useEffect(() => {
    const def = findGame(gameId);
    if (!def) {
      setError(`Unknown game: "${gameId}"`);
      return;
    }
    if (activeGameIdRef.current === gameId) return; // no-op re-render

    let cancelled = false;
    const isFirstLoad = !initialized;

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
        await PlayerPrefs.init({ namespace: gameId, backend: selectDefaultBackend() });
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
        setDisable3D(!!config.disable3D);

        if (isFirstLoad) {
          // First-ever render: trait registry + font kickoff.
          initWorldSync();
        }

        // Mount renderers BEFORE scene load so their registerBeforeSwap hooks
        // (Scene3D shader prewarm, Scene2D sprite preload) are registered in
        // time. configReady gates the mount; the opaque LoadingOverlay covers
        // everything until the scene is fully loaded and rendered.
        if (!configReady) {
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
        const bootScenePath = overridePath ?? config.scenePath;
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

        // Wait for two render frames after the world swap so syncRenderables
        // populates meshes and the renderer paints them. Without this, the
        // overlay hides before meshes appear, exposing the empty sky background
        // for a few frames (race between swap and first populated render).
        await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
        if (cancelled) return;

        // OTA boot-watchdog confirm (docs/plans/mobile-ota-updates-plan.md, Phase 1):
        // THIS is the app's own "fully booted" signal (rendered a real frame of the
        // ACTUAL game, not just index.html loading) — the exact proof-of-boot the native
        // watchdog's two-boot-confirm design assumes. Best-effort and native-only: a
        // failure here must never block the game the player is already looking at, and
        // web has no OTA mechanism to confirm anything for (ModokiOtaWeb no-ops it
        // anyway, but skip the dynamic import entirely rather than pay for it on web).
        if (Capacitor.isNativePlatform()) {
          import('capacitor-modoki-ota')
            .then((m) => m.ModokiOta.confirmBoot({ name: 'shell' }))
            .catch((e) => console.warn('[GameShell] OTA confirmBoot failed (non-fatal):', e));
        }

        activeGameIdRef.current = gameId;
        setInitialized(true);
        setTransitioning(false);
      } catch (e) {
        if (!cancelled) {
          console.error('[GameShell] Failed to load game:', e);
          setError(String(e));
          setTransitioning(false);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [gameId, initialized, configReady]);

  // Shipped web build's screen sizing (rendering.web.sizeMode). `fixed` letterboxes
  // the game to its authored aspect; `free`/`max` fill the viewport (max clamps the
  // 3D drawing buffer in Scene3D instead). Editor viewports are unaffected — this is
  // the standalone game shell only.
  const sizeBox = useWebCanvasSizing();

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
          <LoadingOverlay visible={!initialized || transitioning} />
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
      <Suspense fallback={<div style={{ color: '#fff', padding: 20, background: '#1a1a2e', height: '100vh' }}>Loading editor...</div>}>
        <EditorApp />
      </Suspense>
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
