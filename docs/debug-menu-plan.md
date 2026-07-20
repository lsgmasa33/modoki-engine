# In-Game Debug Menu — Plan & Tracker

> Living plan. Status checkboxes updated as phases land.

## Context
Modoki has a rich AI-perception layer (**Percept**: FPS counter, event Journal, Watch
time-series, `timeScale`, the UIAction registry, `gameStore`) but **no human-facing
in-game debug UI**. QA/playtesters on a real device can't see FPS/memory, fire cheats,
or inspect the ECS world without the full editor — which is deliberately tree-shaken out
of game builds.

This feature adds a **runtime-only, extensible debug menu** that ships in game builds
(gated behind a project-config flag), toggled by **F12** or a **3-finger tap** on device.
Each game can register its own tabs and cheat buttons.

### Decisions
- **Ship scope:** shipped, flag-gated (`build.enableDebugMenu`) + always-on in dev.
- **Charts:** hand-rolled `<canvas>` sparkline — **zero new dependencies** (no chart.js).
- **Delivery:** everything below, in **phases** (each independently committable/testable).

### Hard constraint — why we can't reuse the editor panels
The editor Hierarchy/Inspector (`engine/packages/modoki/src/editor/panels/`) are quarantined
from game builds via the `GAME_ONLY` / `__MODOKI_EDITOR__` lazy-import boundary
(`engine/app/App.tsx`). Importing them in-game would drag the entire editor (undo, FlexLayout,
editor backend, prefab editing) back into the shipped bundle. **We build a lightweight runtime
inspector instead**, reading the world through the same `runtime/` primitives the panels use —
`getAllEntities`, `buildEntityTree`, `readTraitData`, `getAllTraits` (`runtime/ecs/entityUtils`,
`traitRegistry`) — which are already in every game bundle.

## Architecture
New shipped-safe module **`engine/packages/modoki/src/runtime/debug/`** (imports **only** from
`runtime/`). Exported through `runtime/index.ts`.

- **`debugMenuRegistry.ts`** — the extensibility seam.
  - `registerDebugTab({ id, title, order?, Component })` — full custom React tab.
  - `registerDebugCommand({ tab, label, run, order? })` — one-off button (grouped into a tab;
    default tab `'Cheats'`).
  - `getDebugTabs()`, `getDebugCommands(tab)`, `unregisterDebugTab(id)` (game-switch teardown,
    called from `GameDefinition.unregisterSystems`).
  - `isDebugMenuEnabled()` — reads a module-level `_enabled` flag set once by `setDebugMenuEnabled()`,
    which `app/main.tsx` calls as `setDebugMenuEnabled(__MODOKI_EDITOR__ || __MODOKI_ENABLE_DEBUG_MENU__)`
    (the `enableDebugMenu` config flag is baked into `__MODOKI_ENABLE_DEBUG_MENU__` at build time).
- **`Sparkline.tsx`** — ~60-line `<canvas>` ring-buffer line chart (stream + min/max autoscale +
  last-value label). No deps.
- **`DebugMenu.tsx`** — fixed-position overlay (modeled on `LoadingOverlay`), tab bar + active-tab
  body, close button, drag-to-move header. Built-in + registered tabs sorted by `order`. High
  `z-index`; `pointer-events` only on the panel.
- **`tabs/`** — built-in tabs, each self-registering at module load.

## Toggle layer (`engine/app/App.tsx` + `DebugMenu.tsx`)
`App.tsx` (`GameShell`, always shipped) just mounts `<DebugMenu>` inside `.game-wrapper`, gated by
`isDebugMenuEnabled()`. The toggle logic is **self-contained in `DebugMenu.tsx`**: a `useEffect`
owns a `useState(open)` toggled by:
- **keydown F12** — `preventDefault()` (suppress browser devtools); ignored when the local
  `isEditingText()` guard is true (active element is INPUT/TEXTAREA/SELECT/contentEditable).
- **touchstart with `e.touches.length === 3`** — the on-device gesture (built from scratch; no
  existing multi-touch layer), debounced to fire once per gesture.

## Working conventions (apply to EVERY phase)
- **Ultracode where it makes sense.** Use the `Workflow` multi-agent tool for broad/parallel
  slices (P2's inspector field-editors, P4's independent tabs, every phase's review pass). Do
  small single-spot work (registry, toggle wiring, config flag) inline.
- **Tests at the END of every phase** — each phase ships its own **unit** tests (pure logic:
  registry, gating, sparkline math, inspector read/write helpers) **and** **integration** tests
  (DOM-level via `@testing-library`/jsdom under `engine/tests/ui/`: render `DebugMenu` with a
  test world, toggle open, switch tabs, assert live data). Not "done" until green in `npm run verify`.
- **Code + architecture review at the END of every phase** (ultracode when broad): correctness +
  two invariants — (a) **no `editor/` imports leak into the runtime bundle**, (b) the debug module
  imports **only** from `runtime/`. Fix findings before committing.

## Phases
Each phase is a standalone commit on `work-ai`, ending with: tests green → review → commit.

### Phase 0 — Plan committed
- [x] This doc (`docs/debug-menu-plan.md`) + `CLAUDE.md` docs-list entry.

### Phase 1 — Foundation + Stats tab (on-device-testable skeleton) — ✅ DONE
- [x] `runtime/debug/`: `debugMenuRegistry.ts`, `Sparkline.tsx`, `DebugMenu.tsx`, `tabs/StatsTab.tsx`,
      `index.ts` (subpath). Pure registry re-exported via `runtime/index.ts`; UI behind the
      `@modoki/engine/runtime/debug` subpath.
- [x] Config flag `build.enableDebugMenu` in `engine/project-config.ts` → `__MODOKI_ENABLE_DEBUG_MENU__`
      define in `vite.config.ts` → `setDebugMenuEnabled` in `app/main.tsx` + flag-gated lazy import in `App.tsx`.
- [x] **Stats tab**: FPS sparkline (`getCurrentFPS()`), memory sparkline (`performance.memory`, labeled
      Chromium-only), GPU stats (`renderer.info` draw calls/triangles/geometries/textures/programs) +
      **active backend name (WebGL vs WebGPU)** from the Three renderer, entity count.
- [x] Toggle wiring in `App.tsx` — F12 + 3-finger tap (self-contained in `DebugMenu`; input-source-guard
      allowlisted).
- [x] Unit + integration tests (`tests/ui/debugMenuRegistry.test.tsx`, `debugMenu.test.tsx`,
      `sparkline.test.tsx`) + review (caught + fixed: sparkline stable-ref redraw bug, pointer-capture,
      dead memo dep, hex parsing). `npm run verify` green.
- Also mounted in the **editor GameView** (`editor/rendering/GameView.tsx`) with `anchor="container"`, so
  it overlays (and scales with) the device preview the same way it appears on a device — not floating over
  the editor chrome. `DebugMenu` gained an `anchor: 'viewport' | 'container'` prop (fixed vs absolute).
- **Live-verified** in the Electron editor (F12 toggles cleanly, no devtools clash; FPS/heap charts paint;
  RENDERER=WebGPU; draw calls/geometries/textures/entities all real).
- Follow-ups deferred: **WebGPU `renderer.info.render.triangles` reads 0** (draw calls/geometries populate;
  triangles is a WebGPU-path quirk to chase in Phase 5); Pixi 2D backend name (only Three shown);
  consolidate the pre-existing per-game `games/3d-test/runtime/ui/DebugMenu.tsx` (Cmd+Shift+D) into this
  engine-level menu (Phase 5).

### Phase 2 — World inspector tab — ✅ DONE
- [x] `tabs/WorldTab.tsx` — lightweight **Hierarchy** (`buildEntityTree`, collapsible, scrollable) +
      **Inspector** (traits via `getTraitByName`, fields via `readTraitData`) over `runtime/ecs/entityUtils`.
      Editable primitive fields (number/bool/string/enum/**color**) via `writeTraitField`. Tree reacts to
      `getStructureVersion`/`onStructureDirty`; live values refresh on a 250ms interval. Read-only for
      `readOnly`/`runtimeOnly`/entityRef/bindings. **No `editor/` imports.**
- [x] Unit + integration tests (`tests/ui/debugWorldTab.test.tsx`: tree render, collapse, selection,
      field readout, number-field write round-trip, color number↔hex conversion) + review.
- [x] Review caught + fixed a **HIGH** bug: color fields store numbers (`0xrrggbb`), so the picker both
      mis-displayed white and wrote a *string* into a numeric SoA field (live-world corruption) —
      fixed with `colorToHex`/`hexToColorNumber`, preserving the field's existing type.
- [x] **Live-verified** in the Electron editor GameView: World tab shows the real 136-entity hierarchy
      (matches the editor Hierarchy), selecting "Water" shows `EntityAttributes` (name/isActive/sortOrder/
      parentId/layer/guid) + Transform, with correct per-type editors.
- Follow-ups: number field can't be transiently cleared (250ms tick snaps it back — minor UX); `InspectorPane`
  calls `getAllEntities()` every 250ms while open (fine for a panel, keep off any per-frame path).

### Phase 3 — Percept tabs — ✅ DONE
- [x] **Time** (`tabs/TimeTab.tsx`, runtime): `timeScale` slider + presets + Pause/Resume (uses
      `timeScale`, NOT playState — playState is the editor's snapshot-owned control), live
      frame/elapsed/delta/state readout. Controls force an immediate re-render.
- [x] **Journal** (`tabs/JournalTab.tsx`, runtime): tick-stamped event stream (`journalEvents`),
      type filter, Clear; disabled-hint when `!isJournalEnabled()`.
- [x] **Store** (`tabs/StoreTab.tsx`, runtime, **read-only** per decision): read-source registry values
      (`getReadValue`/`getReadSourceNames`) — the runtime-safe store surface; a game can register its
      own editable store tab.
- [x] **Watch** (`engine/app/debug/WatchTab.tsx`, **editor-only** per decision): numeric-series charts
      reusing `app/debug/watch.ts` + the runtime `Sparkline`. Registered via a `__MODOKI_EDITOR__`-gated
      side-effect import in `main.tsx` — never bundled in a shipped game.
- [x] Unit + integration tests (`tests/ui/debugPerceptTabs.test.tsx`, `debugWatchTab.test.tsx`) + review.
- [x] Review: no High/Medium. Fixed `Sparkline` `Math.max(...data)` spread → reduce (call-stack safety on
      large Watch series). Also fixed immediate-feedback UX bugs in Time (Pause↔Resume label) + Journal (Clear).
- [x] **Live-verified**: Time tab (slider/presets/pause + readouts) in the Electron editor; all 6 tabs
      (Stats/World/Time/Watch/Journal/Store) present in the tab bar.

### Phase 4 — Cheats + Device + Console — ✅ DONE (Render toggles deferred)
- [x] **Cheats** (`tabs/CheatsTab.tsx`): auto-lists UIActions (`getUIActionNames`/`getUIActionParams`
      → `dispatchUIAction`, wrapped so a required-param action can't throw uncaught) + game
      `registerDebugCommand` buttons; inert-hint when the sim isn't running.
- [x] **Console** (`tabs/ConsoleTab.tsx` + `consoleCapture.ts`): ring buffer wrapping `console.*`
      (forwards to original), level filter, Clear. Re-entrancy-guarded; version-snapshot for
      useSyncExternalStore.
- [x] **Device** (`tabs/DeviceTab.tsx`): platform/viewport/screen/DPR/cores/memory/safe-area
      (dep-free — no `@capacitor/core`; reads `window.Capacitor` global). Refreshes on rotation.
- [x] Unit + integration tests (`tests/ui/debugToolsTabs.test.tsx`) + review (fixed: Cheats action
      dispatch not wrapped, Device safe-area stale on rotation, consoleCapture re-entrancy).
- [x] **Live-verified**: Cheats tab auto-listed the engine's UIActions (audio.*, engine.loadScene)
      with param hints in the Electron editor.
- **Render toggles DEFERRED**: only the 2D-collider toggle exists (and pulls Scene2D/Pixi into the
  debug chunk); wireframe + UI-bounds need new rendering plumbing. Follow-up.
- **UX note surfaced**: with 9 tabs the 300px panel overflows horizontally → drove the Phase-4.5
  redesign (fullscreen modal + spawnable floating stat widgets).

### Phase 4.5 — Redesign: fullscreen modal + spawnable floating stat widgets — ✅ DONE
Correction from the user: the debug menu should be a **fullscreen modal**, and FPS/Memory/GPU
should be **separate, half-transparent, draggable floating widgets** you spawn from buttons and
watch WHILE PLAYING (the modal blocks the game).
- [x] `DebugMenu` rewritten: an overlay that renders the always-mounted `FloatingWidgetLayer` +
      a **fullscreen modal with a left tab sidebar** (also fixes the 9-tab horizontal overflow).
- [x] Floating widgets: `widgetStore.ts` (registry + open-state), `FloatingWidget.tsx` (half-
      transparent, draggable, `backdrop-blur`), `FloatingWidgetLayer.tsx`, `widgets/{Fps,Memory,Gpu}Widget.tsx`.
      Shared `perfSources.ts`, `useSampled.ts`, `useDraggable.ts`. Widgets persist when the modal closes.
- [x] `StatsTab` → a **launcher** (spawn buttons ●/○ per widget + a static snapshot).
- [x] Tests (`tests/ui/debugWidgets.test.tsx`; updated `debugMenu`/`sparkline`) + review (fixed:
      `useDraggable` pointer-cancel gap).
- [x] **Live-verified**: fullscreen modal + all 9 sidebar tabs; spawned FPS/Memory/GPU widgets float
      half-transparent over the *playing* game and update live.
- [x] **Fixed the "draw calls keep climbing — leak?" report**: NOT a leak (entities/geometries/
      textures were flat). Two-part root cause + fix (web-researched; three.js `Info` docs + issue #32031):
      (1) Three's WebGPU `Info` keeps `render.calls` as a LIFETIME cumulative counter; the per-frame count
      is `render.drawCalls` (WebGL only has `calls`, reset per frame) → `readRenderer` now prefers `drawCalls`.
      (2) The renderer resets `info` at the START of every `render()`, so with the NPR composer's multi-pass
      rendering `drawCalls` read ~0 → added `drawCallProbe.ts`: a once-per-frame `info.reset()` (with
      `info.autoReset=false`) registered just before the 3D render, so per-frame draw calls/triangles
      accumulate across all passes. **Live-verified: a stable ~157 draw calls for the playing island** (was
      climbing into the thousands). Nothing else reads `renderer.info`, so flipping autoReset is safe.
      Single-renderer (shipped game) is exact; the editor's 2nd on-demand renderer makes it best-effort.
      `—` remains the fallback when a backend still doesn't report. Regression test: `tests/ui/debugPerfSources.test.tsx`.

### Phase 4.6 — Error toaster — ✅ DONE
- [x] `ErrorToaster.tsx` — slides in a half-transparent red toast on every `console.error`, stacked
      (cap 4), auto-dismisses after 3s, click-to-dismiss. Fed by the debug console-capture (so it catches
      all console.errors); mounted in the debug overlay next to the widgets, so it surfaces errors
      **while playing**. Skips errors that predate mount. Runtime-safe (setTimeout, no wall-clock).
- [x] Tests (`tests/ui/debugErrorToaster.test.tsx`: show/auto-dismiss-3s/click-dismiss/ignore-predating)
      + **live-verified** in the browser game route (stacked toasts sliding in over the running island).

### Phase 5 — Docs + sample + final polish — ✅ DONE
- [x] `docs/debug-menu.md` — the feature doc: toggle gestures, the gating chain
      (`build.enableDebugMenu` → `__MODOKI_ENABLE_DEBUG_MENU__` → `setDebugMenuEnabled` → lazy
      import), architecture invariants (runtime-only, pure registry vs UI subpath, editor-only
      Watch), all built-in tabs/widgets/toaster, and the full extensibility API
      (`registerDebugCommand`/`registerDebugTab`/`registerStatWidget`) with examples. Added to the
      `CLAUDE.md` docs list.
- [x] Sample cheat in `games/3d-test/runtime/setup.ts` (`registerGameCheats` — three GamePhase
      jump buttons under the built-in Cheats tab, gated on `isDebugMenuEnabled()`).
- [x] Final full-feature review + `npm run verify`.

## Critical files
- **New:** `engine/packages/modoki/src/runtime/debug/{debugMenuRegistry,Sparkline,DebugMenu}.tsx`
  + `tabs/*`; exported via `runtime/index.ts`.
- **Edit:** `engine/app/App.tsx` (mount + toggle), `engine/project-config.ts` (`enableDebugMenu`),
  `engine/plugins/load-project-config.ts` + `engine/vite.config.ts` (flag passthrough),
  `games/3d-test/runtime/setup.ts` (sample, P5), `CLAUDE.md` + `docs/` (docs).
- **Reuse (no new abstractions):** `getCurrentFPS` (`frameDriver.ts`), `getAllEntities`/
  `buildEntityTree`/`readTraitData`/`getAllTraits` (`runtime/ecs/entityUtils`, `traitRegistry`),
  `getCurrentWorld`, UIAction registry (`runtime/ui/actionRegistry.ts`), journal
  (`runtime/systems/journal.ts`), Watch (`engine/app/debug/watch.ts` — expose a runtime-safe
  reader for shipped use), `keyboardSource.editing()` (`runtime/input/keyboardSource.ts`), the
  active Three renderer accessor (`runtime/loaders/textureResolver.ts`).

## Verification (per phase)
- **Dev/editor:** launch this clone's editor (`MODOKI_BACKEND_PORT=5180
  engine/scripts/launch-editor.sh games/3d-test`), open Game view, press **F12** → overlay
  appears; drive with the `modoki` MCP (`modoki_press_key`, `modoki_tap` tabs), confirm the FPS
  chart animates via `modoki_capture_viewport`.
- **On-device:** build `games/3d-test` with `enableDebugMenu:true`, deploy, 3-finger-tap → overlay;
  confirm FPS reads and a cheat fires.
- **Bundle boundary:** confirm the built game chunk pulls in **no** `editor/panels` code.
- **Gate:** `npm run verify` before each push.
