# In-Game Debug Menu

An **extensible, human-facing debug menu** that ships inside game builds (behind a
project-config flag) and is always on in the editor. It gives QA, playtesters, and the
developer an on-device way to watch performance, inspect the live ECS world, drive Percept
(Journal/Time/Store), fire cheats, and read the console — none of which the tree-shaken-out
editor is available for in a shipped game.

## Toggle

- **F12** (keyboard) — suppressed when a text field is focused (so typing an F12 in an input
  doesn't open it).
- **3-finger tap** (touch) — the on-device gesture, latch-debounced to fire once per gesture.

The menu is a **fullscreen modal**. Tabs live behind the **☰ button** in its header (a
dropdown, not a persistent sidebar — on a phone a fixed tab column ate a third of the width,
and the tabs that matter most on device are exactly the list-heavy ones); the header shows the
active tab's title. **Escape** backs out one level — dropdown first, then the modal. The
FPS/Memory/GPU stat displays are **separate floating widgets** you spawn from the Stats tab;
they stay on screen while the modal is closed, so you can watch performance *while playing*.

### Tab layout — the body does NOT scroll

The modal body is a fixed-height flex column with `overflow: hidden`; **scrolling is the tab's
job**. That's what lets a list fill the dialog instead of sitting in a fixed-height box with dead
space under it. Use the helpers from `@modoki/engine/runtime/debug` (`runtime/debug/tabLayout.ts`)
rather than a `maxHeight` magic number:

| Helper | Use it when |
|---|---|
| `fillRootStyle(gap?)` | The tab has ONE growing region (a list/tree). Put `fillRegionStyle` on that region; headers/filter rows stay pinned and the region takes the leftover height and scrolls itself. |
| `scrollRootStyle(gap?)` | The tab is a stack of short sections with no natural growing region (Stats, Time, Device, Cheats) — the root scrolls when it overflows. |
| `fillRegionStyle` | The one region inside a `fillRootStyle` tab that absorbs leftover height. |

Both roots set `minHeight: 0`: a flex child's default `min-height: auto` refuses to shrink below
its content, which silently defeats the inner `overflow: auto`. (`WorldTab` is the two-region
case — tree and inspector split the body 45/55 and scroll independently.)

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
[debug-tools-mcp.md](./debug-tools-mcp.md) "Percept".

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
| **Device** | Platform / viewport / screen / DPR / cores / memory / safe-area (refreshes on rotation), plus the **Backing resolution** A/B and the **`Re-run probe (idle)`** button below. |

### Backing resolution — the live `pixelRatioCap` A/B (Device tab)

Flips `rendering.pixi.pixelRatioCap` (2D) and `rendering.three.pixelRatioCap` (3D) **at runtime**
— `1` / `2` / `3` / `Off`, where `Off` sends `0`, the engine's existing uncapped sentinel (see
[rendering.md](rendering.md)). Below the buttons it prints each canvas's REAL drawing buffer
(`canvas.width×height`) next to its CSS box, split into 2D (Pixi, under `[data-canvas2d-mount]`)
and 3D (everything else) and numbered when a surface appears more than once.

**Why it exists.** The caps are baked into the build's config, so comparing 2× against 3× used to
mean an edit plus a rebuild per flip — which is not an A/B at all, since you end up comparing
against memory rather than back-to-back. It matters only where a cap actually binds, i.e. a
DPR-3 phone: at DPR ≤ 2 a cap of 2 is arithmetically a no-op, so on a typical desktop the
buttons correctly do nothing visible.

**Why the buffer readout is the point, not decoration.** Sharpness is exactly the kind of claim
that is easy to imagine a difference in. The printed buffer says whether the flip landed *before*
anyone judges pixels — if the numbers don't move, the comparison is two identical frames and any
verdict is imaginary.

Measured on an iPhone Air (DPR 3, `space-invader`, 2D canvas CSS 420×810) — the buffer tracks the
cap exactly, `Off` equals raw DPR, and the **CSS box never moves** (the clamp rides the buffer, not
the CSS size — the #38 failure):

| 2D cap | 1 | 2 (default) | 3 | Off |
|---|---|---|---|---|
| buffer | 420×810 | 840×1620 | 1260×2430 | 1260×2430 |

Mechanism: `rendering/resizeBus.ts` (`onForceResize` / `forceResizeAllSurfaces`). Both
`Canvas2DMount.measure()` and `Scene3D`'s `ResizeObserver` already re-read `getRenderSettings()`
on every run, so a live settings change only needs those handlers re-invoked — nothing caches or
diffs, and the bus stays a dumb listener registry. Changes are runtime-only: nothing is persisted,
so a relaunch returns to the project's configured caps.

### `Re-run probe (idle)` — measuring the ramp probe away from boot (Device tab)

Runs the boot ramp probe again, on demand, and prints its reading in the **same** `describeProbe`
format as the boot line — so a boot log and an in-game log can be read side by side in one logcat
capture. It **writes no verdict and publishes no tier**: `runProbeForDiagnostics` deliberately
skips `probeVerdictStore` (whose stored median an idle reading would otherwise skew, asymmetrically)
and never calls `publishActiveTier`, so tapping it cannot change what is on screen. It refuses
while a boot probe is still in flight rather than measuring its contention, and it runs the 2D or
3D probe shape according to whether a 3D canvas is mounted, so the reading is comparable to that
device's boot reading rather than to the other axis.

**Why it exists.** `runCpuRamp` measures *available* CPU, and until this button there was no way to
ask what the same device reads when it is not booting — `resolveProbeClass` is private and the
verdict store early-outs on `final`, so a settled device never probes again however often it is
launched. The A/B it was built for is written up in
[rendering.md](rendering.md) § "Quality tiers" ("The CPU axis — boot vs in-game"); the headline is
that the boot reading is not depressed by contention as assumed, and on a Galaxy A23 it reads
**2× higher** than the same device reads while the game is running.

Drive it over adb with no lease: `adb shell input keyevent 142` (F12) opens the menu, then tap
through ☰ → Device. Each run logs `[rampProbe] DIAGNOSTIC (idle) …` to the console.

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
