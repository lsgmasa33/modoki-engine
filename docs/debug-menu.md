# In-Game Debug Menu

An **extensible, human-facing debug menu** that ships inside game builds (behind a
project-config flag) and is always on in the editor. It gives QA, playtesters, and the
developer an on-device way to watch performance, inspect the live ECS world, drive Percept
(Journal/Time/Store), fire cheats, and read the console — none of which the tree-shaken-out
editor is available for in a shipped game.

> Design history + phase tracker: `docs/debug-menu-plan.md`. This doc is the reference for
> **using and extending** the menu.

## Toggle

- **F12** (keyboard) — suppressed when a text field is focused (so typing an F12 in an input
  doesn't open it).
- **3-finger tap** (touch) — the on-device gesture, latch-debounced to fire once per gesture.

The menu is a **fullscreen modal** with a left tab sidebar. The FPS/Memory/GPU stat displays
are **separate floating widgets** you spawn from the Stats tab; they stay on screen while the
modal is closed, so you can watch performance *while playing*.

## Gating — how it ships (and how it's kept out)

The whole UI is opt-in per build:

```
project.config.json  build.debugBuild: true
      → engine/vite.config.ts  define __MODOKI_DEBUG_BUILD__
      → engine/app/main.tsx     setDebugMenuEnabled(__MODOKI_EDITOR__ || __MODOKI_DEBUG_BUILD__)
      → engine/app/App.tsx      flag-gated lazy import of @modoki/engine/runtime/debug
```

`build.debugBuild` is one flag shared with the event journal and the debug bridge (Project
Settings → Developer → "Debug build") — there's no independent debug-menu-only toggle; see
[percept-plan.md](./percept-plan.md) Decision D and [debug-tools-mcp.md](./debug-tools-mcp.md).

- **Editor / dev:** always enabled (`__MODOKI_EDITOR__`).
- **Shipped game:** enabled only when the project sets `build.debugBuild: true`. When off,
  `App.tsx` never lazy-imports the `@modoki/engine/runtime/debug` chunk, so the entire menu (tabs,
  widgets, console capture, toaster) **tree-shakes out** of the bundle. Toggle it in the editor via
  **Project Settings → General → Developer → "Debug build"** (rebuild to apply), or edit
  `build.debugBuild` in `project.config.json` directly.
- `isDebugMenuEnabled()` (from `@modoki/engine/runtime`) reflects the same gate — games check it
  before registering debug-only tabs/cheats so nothing is registered in a release build.

The menu is mounted in two places, both driven by the same `DebugMenu` component:
- `engine/app/App.tsx` — the shipped game shell, `anchor="viewport"` (fixed / fullscreen).
- `engine/packages/modoki/src/editor/rendering/GameView.tsx` — `anchor="container"`, so in the
  editor it overlays and scales with the device preview exactly as it appears on a device.

## Architecture invariants

The menu is a **runtime-only** module — `engine/packages/modoki/src/runtime/debug/`. It imports
**only** from `runtime/` + React; it must never import from `editor/` (that would drag the whole
editor back into shipped game builds and break the tree-shaking boundary). Two consequences:

- The **pure registry** (`debugMenuRegistry.ts` — only a `type React` import) is re-exported from
  the main `@modoki/engine/runtime` index, so a game registers tabs/commands cheaply without
  pulling any UI.
- The **UI** (DebugMenu + tabs + widgets) lives behind the `@modoki/engine/runtime/debug`
  subpath, lazy-imported behind the build flag.
- The one editor-only tab, **Watch**, lives in `engine/app/debug/WatchTab.tsx` (only `app/` may
  import `app/debug/watch.ts`) and self-registers via a `__MODOKI_EDITOR__`-gated side-effect
  import in `main.tsx` — never bundled into a shipped game.

Being under `runtime/**`, the module obeys the determinism guard: **no `Date.now` / `performance.now`
/ `Math.random`** (`setInterval` / `setTimeout` are fine). The F12 key listener is allowlisted in
the input-source guard.

## Built-in tabs

| Tab | What it shows |
|-----|---------------|
| **Stats** | Launcher for the floating FPS / Memory / GPU widgets + a static snapshot (FPS, renderer backend, draw calls, entity count). |
| **World** | Runtime hierarchy (`buildEntityTree`) + inspector — editable primitive trait fields (number/bool/string/enum/color) via `writeTraitField`. Read-only for refs/bindings. |
| **Time** | `timeScale` slider + presets + Pause/Resume + live frame/elapsed/delta readout. |
| **Watch** | *(editor-only)* numeric time-series charts reusing the Watch layer. |
| **Journal** | Tick-stamped `emit` events with a type filter + Clear. Hint when journaling is disabled. |
| **Store** | Read-only read-source registry values. |
| **Prefs** | `PlayerPrefs` viewer — the engine-owned per-key JSON store (per-game namespace). |
| **Cheats** | Auto-listed UIActions (`getUIActionNames` → `dispatchUIAction`) **plus** game `registerDebugCommand` buttons. |
| **Console** | Ring-buffer view of captured `console.*` with a level filter + Clear. |
| **Device** | Platform / viewport / screen / DPR / cores / memory / safe-area (refreshes on rotation). |

### Floating stat widgets

`FPS`, `Memory`, `GPU` are half-transparent, draggable floating windows spawned from the Stats
launcher and persisted (open-state + position) in `widgetStore.ts`. They keep updating while the
modal is closed.

- **Memory** is Chromium-only (`performance.memory`) — empty on iOS WKWebView.
- **GPU** shows the **rendering backend name (WebGL vs WebGPU)** plus per-frame draw calls /
  triangles. On backends that don't report a stat it shows `—`. (Per-frame draw calls are made
  accurate under multi-pass NPR rendering by `drawCallProbe.ts`, which does one `renderer.info.reset()`
  per frame with `autoReset=false`.)

### Error toaster

`ErrorToaster.tsx` slides in a half-transparent red toast on every `console.error` (fed by the
console capture), stacked (cap 4), auto-dismissing after 3s, click-to-dismiss. It's mounted in the
overlay next to the widgets, so errors surface **while playing**. Errors that predate mount are
skipped.

## Extending it

Everything below is imported from `@modoki/engine/runtime` (the pure registry — no UI cost). Do it
from your game's `setup.ts` (`registerSystems`), guarded by `isDebugMenuEnabled()`.

### A cheat button — `registerDebugCommand`

The lightweight form: a labelled button grouped into a tab (default `'Cheats'`).

```ts
import { getCurrentWorld, isDebugMenuEnabled, registerDebugCommand } from '@modoki/engine/runtime';
import { GamePhase } from './traits/GamePhase';

if (isDebugMenuEnabled()) {
  registerDebugCommand({
    label: 'Go to Result',
    order: 2,                 // sort within the tab (default 100)
    // tab: 'Cheats',         // optional — omit for the built-in Cheats tab
    run: () =>
      getCurrentWorld().query(GamePhase).updateEach(([gp]) => {
        gp.phase = 'result';
      }),
  });
}
```

A `run` that throws is caught and logged by the menu (which also surfaces via the toaster), so a
buggy cheat can't take down the overlay. See the working reference in
`games/3d-test/runtime/setup.ts` (`registerGameCheats` — three phase-jump buttons).

### A full custom tab — `registerDebugTab`

For a game-specific panel, register a React component as a tab:

```ts
import { registerDebugTab, unregisterDebugTab } from '@modoki/engine/runtime';

registerDebugTab({
  id: 'my-game',           // stable id (used for de-dup + teardown)
  title: 'My Game',
  order: 80,               // built-ins occupy 0..70
  Component: MyGameDebugTab, // receives no props — read ECS/stores internally
});
```

Tear it down on game switch from `GameDefinition.unregisterSystems`:

```ts
unregisterDebugTab('my-game');
```

The `Component` may import the shared `Sparkline` (`@modoki/engine/runtime/debug`) for charts —
but a tab registered from the pure runtime path keeps the game's eager bundle clean; only the lazy
debug chunk pulls the UI.

### A custom floating stat widget — `registerStatWidget`

To add your own spawnable floating widget (like FPS/Memory/GPU):

```ts
import { registerStatWidget } from '@modoki/engine/runtime/debug';

registerStatWidget({
  id: 'net',
  title: 'Net',
  order: 30,
  defaultPos: { x: 16, y: 256 },
  Component: NetWidget,
});
```

## Registry API reference

From `@modoki/engine/runtime` (pure — safe to import from game code):

- `registerDebugTab(def)` / `unregisterDebugTab(id)` — full custom tabs.
- `registerDebugCommand(def)` / `unregisterDebugCommand(def)` — one-off buttons.
- `isDebugMenuEnabled()` — the build gate (guard your registration with it).
- `setDebugMenuEnabled(bool)` — set by the app bootstrap; games don't call this.

From `@modoki/engine/runtime/debug` (the UI subpath):

- `DebugMenu` — the overlay component (mounted by the app/editor, not by games).
- `Sparkline` — the dep-free `<canvas>` line chart.
- `registerStatWidget(def)` / `toggleWidget(id)` / `isWidgetOpen(id)` — floating widgets.

## Verifying

- **Editor:** launch this clone's editor (`MODOKI_BACKEND_PORT=5180
  engine/scripts/launch-editor.sh games/3d-test`), open Game view, press **F12** → the modal
  appears. Drive it with the `modoki` MCP (`modoki_press_key`, `modoki_tap`), confirm the FPS
  widget animates via `modoki_capture_viewport`.
- **On-device:** build with `build.debugBuild: true`, deploy, 3-finger-tap → the modal; a
  cheat fires and FPS reads.
- **Bundle boundary:** confirm the built game chunk pulls in **no** `editor/panels` code when the
  flag is off.
