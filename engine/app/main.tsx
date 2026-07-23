import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { Capacitor } from '@capacitor/core'
import { setJournalEnabled, setDebugMenuEnabled } from '@modoki/engine/runtime'

// Percept — event-journal recording gate. ON in the editor (dev + the packaged
// Electron editor, __MODOKI_EDITOR__) and in a game build that opts in via
// project.config.json `build.enableJournal`; OFF in a normal shipped game build so
// `emit()` adds no per-event allocation on hot paths (physics contacts, etc.).
// (Deferred: a debug|profile|release mode enum — see docs/percept-plan.md.)
setJournalEnabled(__MODOKI_EDITOR__ || __MODOKI_ENABLE_JOURNAL__)

// In-game debug menu — ON in the editor (dev + packaged Electron editor) and in a
// game build that opts in via project.config.json `build.enableDebugMenu`. The
// App.tsx lazy import is gated on the same OR, so a release build with the flag off
// tree-shakes the whole debug-menu chunk out. See docs/debug-menu-plan.md.
setDebugMenuEnabled(__MODOKI_EDITOR__ || __MODOKI_ENABLE_DEBUG_MENU__)

// Native SDK init (Adjust/AppLovin) is no longer wired here — it moved into the
// game's app-service package, registered via GameDefinition.registerAppServices()
// and driven (native-only) from App.tsx's game bootstrap. See
// @modoki/engine/runtime appServices + docs/modoki-package-manager.md.

// Debug bridge — the native TCP + UDP beacon / web-WS server behind every device_* MCP tool
// (device_eval runs ARBITRARY JS on the device through it). Gating, tightest-first:
//   • Dev / VITE_DEBUG_BRIDGE=1 — always on (the local dev loop + the WebSocket fallback).
//   • Shipped native game — ONLY when the project opts in via build.debugBridge
//     (__MODOKI_ENABLE_DEBUG_BRIDGE__). Previously this was ungated on native, so a RELEASE
//     build shipped the eval-capable server; now the default (flag off) constant-folds the
//     native branch to false and Rollup DCEs the whole `./debug/bridge` import — a release
//     build has no server to connect to. Turn it on per-game in Project Settings → Engine
//     (or set build.debugBridge:true) for on-device debugging.
// The `!__MODOKI_PLAYABLE__` build-constant guard additionally DCEs the branch out of a
// playable ad (the runtime isNativePlatform() check alone can't be constant-folded, so the
// bridge JS would otherwise inline into the single-file creative against the byte cap).
if (!__MODOKI_PLAYABLE__ && (import.meta.env.DEV || import.meta.env.VITE_DEBUG_BRIDGE || (__MODOKI_ENABLE_DEBUG_BRIDGE__ && Capacitor.isNativePlatform()))) {
  import('@modoki/engine/runtime').then(({ useGameStore }) => {
    (window as unknown as Record<string, unknown>).__gameStore = useGameStore;
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
