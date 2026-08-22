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
- **New projects: ON.** The scaffolder template sets `"debugBuild": true`, so a freshly
  created project is agent-reachable and profilable without a config hunt — and must be
  turned OFF before it ships. The loader default is still `false`, so a config that omits
  the key (one hand-written, or copied from elsewhere) is off. Every project under
  `games/` and `demos/` sets it `true` today; none of them ship (#239).
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
| **Device** | Platform / viewport / screen / DPR / cores / memory / safe-area (refreshes on rotation), plus the **Backing resolution** A/B, the **`Re-run probe (idle)`** button, and the **Faults** crash probes below. The safe-area row reports the insets the LAYOUT is using, not a bare `env()` — in an editor device preview that is the simulated inset, because the probe reads `var(--ui-sa-*, env(…))` from inside the preview's cascade. Both halves are needed: the same expression probed off `document.body` still reads 0. |

### Faults — the deliberate native crash probes (Device tab, #278)

The bottom section of the Device tab raises a **real native fault on purpose**, so the crash
pipeline can be proven against the shapes JavaScript cannot reach.

| Button | Android | iOS |
|---|---|---|
| **Native crash** | `SIGSEGV` (`Process.sendSignal(myPid(), 11)`) | bad-pointer deref → `EXC_BAD_ACCESS` |
| **ANR (block main thread)** | blocks the real main looper 15 s | — |
| **Uncaught Java exception** | `RuntimeException` on the UI thread | — |

Why native at all: #275 proved the JS half end to end and could not reach any of this. Android's
WebView renderer is a **separate sandboxed process**, so blocking the JS thread raises no ANR
(measured at 8002 ms — nothing reported). A signal crash and an uncaught Java exception each take a
different route into the crash reporter than `globalErrors.ts` can produce. Three pipelines; proving
one says nothing about the other two.

Things that will otherwise cost you a wrong verdict:

- ⚠️ **Raising an ANR and REPORTING one are two different things, and each has its own step.**
  The system raises an ANR on an INPUT/broadcast timeout, not on idle blocking, so you must **tap
  the screen** during the block. The report then exists only if the process **dies** of it — so
  choose **“Close app”** in the system dialog rather than waiting it out. Measured on an S22
  (2026-08-20): a 15 s block that ended on its own produced a system-confirmed ANR
  (`ANR in Window{…}. Reason: Input dispatching timed out … Waited 10011ms for MotionEvent`), no
  `ApplicationExitInfo` record, and **no report at all**. Pressing “Close app” produced
  `reason=6 (ANR)` and a report Crashlytics uploaded on the next launch. The default block is 45 s
  so the dialog stays up long enough to press; pressing it kills the process, so the rest costs
  nothing.
- ⚠️ **A native crash uploads on the NEXT LAUNCH**, not at the moment it happens. Relaunch the app
  before deciding a report is missing.
- ⚠️ **Android REPORTING of a signal crash needs `firebase-crashlytics-ndk`** on the classpath —
  the Java handler never sees a signal. Court has it as of #279; a project that does not will raise
  a real SIGSEGV and produce only an `ApplicationExitInfo reason=5` row with no stack. Triggering
  and reporting are separate questions, and the button only answers the first.
- **iOS has no ANR** and is not given a fake one. The watchdog (`0x8badf00d`) fires on launch/suspend
  transitions, not on a steady-state foreground hang, and Crashlytics does not report hangs at all —
  MetricKit's `MXHangDiagnostic` is that oracle, a different subsystem. `anr`/`uncaught` are
  **rejected with that reason** rather than approximated.
- Each button is a **two-tap arm**, never a `confirm()` — a native modal blocks the whole renderer,
  which would freeze the very thing an ANR probe is about to measure.

**Verified on hardware, per shape** — Galaxy S22 (SM-S901U1, Android 14), Court `com.apiary.court`,
2026-08-20. Each was driven through these buttons, not through the plugin directly:

| Shape | System evidence | Reported |
|---|---|---|
| Uncaught Java exception | `FATAL EXCEPTION: main … java.lang.RuntimeException: [modoki] deliberate fault probe`, `ApplicationExitInfo reason=4 (APP CRASH(EXCEPTION))` | yes — `Handling uncaught exception … from thread main` |
| ANR | `ANR in Window{…}. Reason: Input dispatching timed out … Waited 10011ms for MotionEvent`; after “Close app”, `reason=6 (ANR)` with a trace | yes, **only after “Close app”** — `collect_anrs: true` proven for the first time |
| Native crash | `Fatal signal 11 (SIGSEGV) … in tid`, tombstone naming `GameDebugPlugin.lambda$triggerFault$5`, `reason=5 (APP CRASH(NATIVE)) status=11` | a report was enqueued for that session — from the `ApplicationExitInfo` record, **not** from an NDK handler |

The native-crash row was initially weaker than it looks: without `firebase-crashlytics-ndk` on the
classpath the Java handler never sees a signal, so what reached Crashlytics was the
`ApplicationExitInfo` record Crashlytics reconstructs on the next launch — a row with no stack.
Court gained the artifact in the #279 close-out, and the same probe on the same device then
produced a genuine native report. The difference is visible in logcat, which is the cheap way to
tell the two apart on any project:

| | without the NDK artifact | with it |
|---|---|---|
| handler | — | `Crashlytics native component now available` |
| capture | `convertApplicationExitInfo` (reconstructed after the fact) | `Minidump file exists` |
| report | `Finalizing report for session …` | `Finalizing **native** report for session …` |

Symbol upload for the app's OWN `.so` files (`nativeSymbolUploadEnabled`) is deliberately NOT
turned on: Court ships no native code of its own, so there is nothing unstripped to upload, and a
crash inside libc/libart is symbolicated by neither setting. The artifact is what makes the crash
REPORTED; symbol upload would only sharpen a stack we do not have.

**Gating.** Two independent gates, both keyed on `build.debugBuild`: the JS half is a side-effect
import in `main.tsx` behind `__MODOKI_EDITOR__ || __MODOKI_DEBUG_BUILD__`, and the native half
refuses unless the flag reached the native project — Android's manifest meta-data
`com.modokiengine.gamedebug.DEBUG_BUILD`, iOS's Info.plist `ModokiDebugBuild` key, both written by
`healNativeConfig`. A release build carries no reachable way to kill itself.

**Wiring.** The engine owns only the seam: `runtime/core/faultProvider.ts` is a provider slot,
because `@modoki/engine` does not depend on `capacitor-game-debug` (the app shell does). The
implementation is installed by `engine/app/debug/nativeFaults.ts`. Off-device nothing provides it
and the section says so, rather than offering buttons that resolve cheerfully and do nothing.

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
