// OTA Phase 4 — must be the FIRST import so globalThis.__MODOKI_SHARED__ exists before
// anything else (including App.tsx's sub-game loading) can ask for it. See
// docs/ota-subgame-modules.md.
import './sharedRegistry'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { Capacitor } from '@capacitor/core'
import { setJournalEnabled, setDebugMenuEnabled, setDebugHandlesEnabled, readPerfProfile, setProfilerEnabled } from '@modoki/engine/runtime'

// Debug build — event-journal recording gate. ON in the editor (dev + the packaged
// Electron editor, __MODOKI_EDITOR__) and in a game build that opts in via
// project.config.json `build.debugBuild`; OFF in a normal shipped game build so
// `emit()` adds no per-event allocation on hot paths (physics contacts, etc.).
// (Deferred: a debug|profile|release mode enum — see docs/percept-plan.md.)
setJournalEnabled(__MODOKI_EDITOR__ || __MODOKI_DEBUG_BUILD__)

// In-game debug menu — ON in the editor (dev + packaged Electron editor) and in a
// game build that opts in via project.config.json `build.debugBuild`. The App.tsx
// lazy import is gated on the same OR, so a release build with the flag off
// tree-shakes the whole debug-menu chunk out. See docs/debug-menu-plan.md.
setDebugMenuEnabled(__MODOKI_EDITOR__ || __MODOKI_DEBUG_BUILD__)

// Live-inspection handles (`window.__3d` — camera/scene/renderer) — same gate again. Without
// them an on-device rendering experiment costs a full build+install+launch (~3 min) instead of
// one `device_eval`; a release build with the flag off publishes nothing. Deliberately its own
// switch rather than riding the journal's, so a game can drop journal cost without going blind.
setDebugHandlesEnabled(__MODOKI_EDITOR__ || __MODOKI_DEBUG_BUILD__)

// Profiler reachable on a DEVICE build. `readPerfProfile()` already separates main-thread
// engine work (`cpuMs`) from everything else (`restMs` = GPU + present + idle), and names the
// worst marker spans — but nothing published it outside the editor, so on-device the only
// available signal was total frame time. That is how a 54 ms frame could be argued to be CPU-
// or GPU-bound with equal confidence and no evidence either way.
// Read `vsyncBound` before calling `restMs` GPU time: idle-waiting and GPU-busy are the same
// number when a frame finishes early (#138 — GPU timestamp queries are the real fix). Well
// over budget, as here, that ambiguity does not arise.
if (__MODOKI_EDITOR__ || __MODOKI_DEBUG_BUILD__) {
  setProfilerEnabled(true)
  ;(window as unknown as Record<string, unknown>).__perf = readPerfProfile
}

// OTA Phase 4 — "Games" debug-menu tab, letting a player jump to a dynamically-loaded
// sub-game (gameRegistry.ts). Not editor-only: it needs to work in a shipped debug
// build on a real device, where loadStagedSubgames() actually discovers sub-games.
// Side-effect import registers the tab; gated so a release build never bundles it.
if (__MODOKI_EDITOR__ || __MODOKI_DEBUG_BUILD__) {
  import('./debug/GamesTab');
}

// Native SDK init (Adjust/AppLovin) is no longer wired here — it moved into the
// game's app-service package, registered via GameDefinition.registerAppServices()
// and driven (native-only) from App.tsx's game bootstrap. See
// @modoki/engine/runtime appServices + docs/modoki-package-manager.md.

// Debug bridge — the native TCP + UDP beacon / web-WS server behind every device_* MCP tool
// (device_eval runs ARBITRARY JS on the device through it). Gating, tightest-first:
//   • Dev / VITE_DEBUG_BRIDGE=1 — always on (the local dev loop + the WebSocket fallback).
//   • Shipped native game — ONLY when the project opts in via build.debugBuild
//     (__MODOKI_DEBUG_BUILD__). Previously this was ungated on native, so a RELEASE
//     build shipped the eval-capable server; now the default (flag off) constant-folds the
//     native branch to false and Rollup DCEs the whole `./debug/bridge` import — a release
//     build has no server to connect to. Turn it on per-game in Project Settings → Developer
//     (or set build.debugBuild:true) for on-device debugging.
// The `!__MODOKI_PLAYABLE__` build-constant guard additionally DCEs the branch out of a
// playable ad (the runtime isNativePlatform() check alone can't be constant-folded, so the
// bridge JS would otherwise inline into the single-file creative against the byte cap).
if (!__MODOKI_PLAYABLE__ && (import.meta.env.DEV || import.meta.env.VITE_DEBUG_BRIDGE || (__MODOKI_DEBUG_BUILD__ && Capacitor.isNativePlatform()))) {
  import('@modoki/engine/runtime').then(({ useGameStore }) => {
    (window as unknown as Record<string, unknown>).__gameStore = useGameStore;
  });
  // OTA Phase 4 debug hook — inspect the runtime game registry (baked + dynamically
  // loaded sub-games) via device_eval, same gating as __gameStore above. Returns plain
  // {id,name} pairs (GameDefinition itself carries functions device_eval can't marshal).
  import('./gameRegistry').then(({ getGames }) => {
    (window as unknown as Record<string, unknown>).__modokiGames = {
      list: () => getGames().map((g) => ({ id: g.id, name: g.name })),
    };
  });
  import('./debug/bridge').then(({ initDebugBridge }) => initDebugBridge());
}

// Agent bridge: scene hot-reload + curl-able state/validation/mutation endpoints.
// Editor-scoped, NOT dev-scoped (ELECTRON_PLAN Phase 1): present wherever the
// editor is, including the packaged Electron editor. Stripped from the shipped
// game build (where __MODOKI_EDITOR__ is false). The HMR-socket transport inside
// is still guarded by import.meta.hot until Phase 2 swaps it for IPC.
if (__MODOKI_EDITOR__) {
  import('./debug/agentBridge').then(({ initAgentBridge }) => initAgentBridge());
  // HMR staleness/recovery + the game-code reload. ACTIVE in the packaged editor too —
  // it runs a real Vite dev server, so import.meta.hot is defined there (see the module
  // header). Inert only where there is no hot context at all.
  import('./debug/hmrStaleness').then(({ initHmrStaleness }) => initHmrStaleness());
  // Editor-only Watch debug-menu tab — reuses the editor-side watch observer
  // (app/debug/watch.ts), which is stripped from shipped game builds. Side-effect
  // import registers the tab; gated here so a shipped game never bundles it.
  import('./debug/WatchTab');
}

// Playable ad build (VITE_PLAYABLE): gate on the MRAID container being ready+viewable,
// then mount the CTA/install overlay over the game. The dynamic import + the whole
// MRAID/overlay tree DCE out of every normal build (__MODOKI_PLAYABLE__ === false).
if (__MODOKI_PLAYABLE__) {
  import('./playable/bootPlayable').then(({ bootPlayable }) => bootPlayable(__MODOKI_PLAYABLE_CLICK_URL__));
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
