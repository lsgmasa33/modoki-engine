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

// Debug bridge
// Native: always init (Capacitor plugin handles TCP server + UDP beacon, no tree-shaking issue)
// Web: only in dev mode or with VITE_DEBUG_BRIDGE=1 (WebSocket fallback)
// The `!__MODOKI_PLAYABLE__` build-constant guard lets Rollup DCE this whole branch (and the
// `./debug/bridge` import it drags in) out of a playable ad — otherwise the runtime
// `Capacitor.isNativePlatform()` check can't be constant-folded, so the bridge JS gets inlined
// into the single-file creative as dead weight against the byte cap.
if (!__MODOKI_PLAYABLE__ && (Capacitor.isNativePlatform() || import.meta.env.DEV || import.meta.env.VITE_DEBUG_BRIDGE)) {
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
