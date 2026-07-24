# Input system

A source-agnostic input seam: every physical modality (keyboard, gamepad, pointer/touch, later a
native console pad) merges into one canonical `Input` ECS resource per frame, and all game/UI logic
reads that resource — never `window`/`navigator` — so adding a platform is "one new source, nothing
downstream changes."

## What it is

Input flows through three layers that never talk to each other directly:

1. **Sources** (`input/*Source.ts`) — each owns one physical modality, attaches its own DOM
   listeners / polling, and each frame merges into a scratch `InputFrame`: axes/held flags are
   OR-merged (two sources can push the same axis), while the single **pointer** is authoritative
   (one pointer, written wholesale — see the pointer source). They are the *only* sanctioned place in
   the engine that touches `window`/`document`/`navigator`.
2. **`inputSystem`** (app-pipeline, `SYSTEM_PRIORITY.INPUT` = 50) — resets the scratch frame, calls
   `sampleAll` to let every source contribute, derives `pressed`/`released` edges by diffing against
   last frame (digital flags via `computeEdges`, the pointer down-edge via `computePointerEdge`), and
   copies the result into the `Input` singleton resource. Runs after `Time` (0) and before any GAME
   system (100).
3. **Consumers** — game/UI systems read `Input` through the accessors (`axis`/`held`/`pressed`/
   `released`/`lastInputDevice`; pointer/tap/drag via `pointerPressed`/`pointerDown`/`pointerReleased`/
   `pointerPos`/`pointerDrag`), never the DOM. The character-controller bridges copy actions onto
   `CharacterController2D/3D`; `uiFocusSystem` reads nav/confirm; a game's own system reads tap/drag
   (sling's aim, space-invader's cannon); UI text templates read device-appropriate prompt tokens.

The whole vocabulary + edge/deadzone math (`input/actions.ts`) is **pure data + pure functions** — no
DOM, no wall-clock, no RNG — so it is determinism-guard-safe and the headless harness sets the `Input`
resource by hand (`setAxis`/`setDigital`/`setPointer`) instead of faking a device. The sources and
`inputSystem` are registered in the **app pipeline only**, never headless, which is what keeps the
deterministic sim free of live DOM reads.

## Key files

- `runtime/input/actions.ts` — the vocabulary (`AXES`, `DIGITAL`, `InputDevice`, `PointerFrame`) + pure
  frame helpers (`makeAxes`/`makeFlags`/`makePointer`, `beginSample`, `computeEdges`,
  `computePointerEdge`, `clampAxes`, `applyDeadzone`).
- `runtime/traits/Input.ts` — the `Input` resource trait + read accessors (`axis`/`held`/`pressed`/
  `released`/`lastInputDevice`; pointer: `pointer`/`pointerDown`/`pointerPressed`/`pointerReleased`/
  `pointerPos`/`pointerDrag`) and harness setters (`setAxis`/`setDigital`/`setPointer`).
- `runtime/systems/inputSystem.ts` — the per-frame bridge: sample all sources → derive edges → write
  the singleton; also play-start edge suppression and the device-switch UI repaint.
- `runtime/input/inputSources.ts` — the `InputSource` interface + registry (`registerSource`/
  `sampleAll`/`attachAll`) and the app-scope `inputSourcesManager`. Also the **host input gate**
  (`setInputGate`/`isInputSuppressed`): a host may suppress ingestion wholesale, and every source's
  optional `reset()` runs on the closing edge so held state can't strand. It lives at the registry
  because all three sources need it and only the keyboard had any guard. A shipped game never
  installs one — see [editor-input.md](./editor-input.md).
- `runtime/input/keyboardSource.ts` — DOM keyboard modality: passive listeners, editing-guard,
  blur/visibility/play reset; maps held keys onto the action vocabulary.
- `runtime/input/gamepadSource.ts` — browser Gamepad API modality, split into a pure `sampleGamepadInto`
  mapper and a thin `navigator.getGamepads()` polling wrapper.
- `runtime/input/pointerSource.ts` — mouse/primary-touch modality: Pointer Events on `window` with
  `setPointerCapture`, reports the single active pointer as a `PointerFrame` (position + down + drag
  delta). Treats `pointercancel` as a clean release so an Android touch-reclaim can't strand a drag.
- `runtime/systems/characterInputSystem.ts` / `characterInput3DSystem.ts` — GAME-tier bridges copying
  `Input` actions onto `CharacterController2D`/`3D` move/jump fields.
- `runtime/input/inputPrompts.ts` / `inputPromptSources.ts` — the pure `promptFor(device, action)`
  lookup table + its wiring into the UI read-source registry (`{confirmPrompt}` etc.).

## How it works

**The vocabulary (`actions.ts`).** Four analog `AXES` (`moveX`/`moveY` locomotion, `lookX`/`lookY`
camera/aim), each −1…+1; ten `DIGITAL` actions (`confirm`, `cancel`, `menu`, `pause`, `jump`, `aim`,
and `navUp/Down/Left/Right`). `aim` is a generic aim/ADS toggle — keyboard maps it to F, gamepad to
the left trigger — for a game to wire up itself (e.g. `demos/forest-camp`'s shooting-mode toggle);
it carries no built-in behavior of its own. An `InputFrame` carries `axes` + three flag maps (`held`, `pressed`,
`released`) + `lastDevice`. `held` is the *level* each source ORs into; `pressed`/`released` are the
*edges* the inputSystem derives — a gamepad button and a keyboard key produce identical edges because
edge derivation is centralized, source-agnostic.

**The per-frame loop (`inputSystem`).** Each frame: `beginSample(frame)` zeros axes + held (leaving
edges to be recomputed); `frame.lastDevice` is copied from the current singleton so it's **sticky**
across frames (only a source with activity overwrites it); `sampleAll(frame)` lets every attached
source merge in; `clampAxes` normalizes axes back to ∓1 (two sources can push the same axis past unit
range); `computeEdges(frame, prevHeld)` diffs held-now vs held-last to fill `pressed`/`released` and
updates `prevHeld` in place; finally the frame is copied field-by-field into the `Input` singleton.

**Edges are derived once, centrally.** Sources are pure held-reporters — they never latch an edge. This
is a deliberate departure from the old `inputManager`, which latched the jump edge inside its keydown
handler. `computeEdges` produces `pressed = now && !was`, `released = !now && was`.

**Sources + registry.** An `InputSource` is `{ name, attach(), detach(), sample(out) }`. The registry
de-dupes by `name` (last wins, so a hot-reload or a game swapping a source doesn't stack duplicates);
`attachAll`/`detachAll` are guarded by an `attached` flag. Keyboard + gamepad are always registered
(both inert until they see input / a controller connects). The `inputSourcesManager` is an **app-scope
Manager** — it `attachAll`s on init and `detachAll`s on dispose, and also registers the prompt read
sources — so sources live app-lifetime and never load headless.

**Keyboard source.** PASSIVE `window` listeners (no `preventDefault`, so it never steals editor keys).
An `editing()` guard ignores keys while an `INPUT`/`TEXTAREA`/`SELECT`/contentEditable is focused. It
tracks only which keys are *held* (a `Set<string>`); `sample()` maps them: A/D + ←/→ → `moveX`, W/S +
↑/↓ → `moveY` (forward/up = +1), the same arrows → `nav*` held flags, Space → `jump`+`confirm`, Enter
→ `confirm`, Esc → `cancel`+`menu`, P → `pause`, F → `aim`; `lastDevice='keyboard'` only when a key was active.
`onBlur`/visibility-hidden and a play-start `onPlayStateChange` all `reset()` the held set so a stale
key can't leak into the first play frame.

**Gamepad source.** Split for testability: the pure `sampleGamepadInto(pad, out, deadzone=0.2)` maps a
W3C "standard gamepad" snapshot (`{axes, buttons}`) into the frame — left stick → `move*`, right stick
→ `look*` (both deadzoned; Y negated because browser +Y is down while our frame is forward=+1), D-pad →
`nav*` edges **plus** discrete `move*` (so a d-pad-only game still moves), A → `confirm`+`jump`, B →
`cancel`, left trigger → `aim`, Start → `menu`+`pause`; returns whether the pad showed activity. The `gamepadSource` wrapper
polls `navigator.getGamepads()`, first connected pad wins (single-player), and tracks a `connected`
count via `gamepadconnected`/`disconnected` events — seeding it from the *current* pad list on
`attach()` because a known controller does not re-emit `gamepadconnected` on a detach→attach (HMR, a
source swap), which would otherwise gate a live pad off forever.

**Pointer source (tap/drag).** Tracks the single active pointer — the mouse, or the *primary* touch of
a multi-touch gesture (the first `pointerId` down owns the gesture; later pointers are ignored until it
lifts, so a second finger can't hijack an in-progress drag). It reports a `PointerFrame` on
`out.pointer`: `x`/`y` (viewport CSS px, raw `clientX/clientY`), `down` (level), and `dragX`/`dragY`
(delta from where the current press started — 0 while up). Unlike axes/held it is **not OR-merged**
(one pointer, authoritative), so `beginSample` leaves it alone and only the down-**edge**
(`pressed`/`released`) is derived centrally by `inputSystem` (`computePointerEdge`) — same
"sources are pure level-reporters" discipline as keyboard/gamepad. It `setPointerCapture`s on press so
moves keep flowing outside the origin element, and treats `pointercancel` **identically to a release**
(down=false → a clean `released` edge) so a browser-reclaimed touch never strands `down=true`. A game
reads it via the accessors (`pointerPressed`/`pointerDown`/`pointerReleased`/`pointerPos`/`pointerDrag`)
and maps the coordinates to world space itself (raycast / its own projection). Worked examples:
`games/sling` (drag-to-aim slingshot) and `games/space-invader` (absolute finger-follow + release-to-fire).

**Presentation-invariant input (zoom).** Page/UI zoom — the editor's webContents zoom, a browser
Cmd+, an OS zoom — rescales the CSS coordinate system: at zoom factor `f` the viewport holds `1/f` as
many CSS px, so the SAME physical drag spans fewer `clientX` px. That must not change how a game
FEELS. The contract (`runtime/input/presentationScale.ts`): input is presented as if the presentation
were 1:1. **Positions stay raw** (`pointerPos` = viewport CSS px) — they are ratio-matched to
`getBoundingClientRect`, so raycast/hit-testing off them is already zoom-invariant (the `f` cancels).
**Magnitudes are normalized** — `pointerDrag` multiplies the raw delta by the presentation scale to
recover zoom-0-equivalent px, so a game's `dragPx × k` feel constant (e.g. sling's `pullPerPx`) doesn't
drift under zoom. Detection: `window.devicePixelRatio` tracks page zoom exactly (`dpr = displayScale ×
f`), read live so zoom changes auto-track; `baseDpr` defaults to the load-time dpr (right for a shipped
game at 100%) and the editor calibrates it authoritatively via `calibratePresentationScale(f)` (main
pushes `webContents.getZoomFactor()` on mount + each change, since a persisted zoom is restored before
the game mounts). A real in-game CAMERA/world zoom is NOT undone here — it changes framing through the
world projection (raycast), the correct channel for it.

**Character-controller bridges.** GAME-tier systems, so they tick only while the sim plays and run
after the INPUT-tier `inputSystem` wrote this frame's edges. `characterInputSystem` sets `cc.moveX =
axis('moveX')` and latches `cc.jump` on `pressed('jump') || pressed('navUp')` (in 2D there's no forward
axis, so up doubles as jump). `characterInput3DSystem` sets `cc.moveX`, `cc.moveZ = -axis('moveY')`
(forward key reports `moveY=+1` but moves along −Z), and `cc.jump` on `pressed('jump')` (W is forward
here, not jump). Because both read plain trait data, they are deterministic and **harness-safe** — a
test spawns `Input`, sets fields, steps, and asserts on `moveX`/`jump`.

**Device-appropriate prompts.** `promptFor(device, action)` is a pure lookup table: gamepad `confirm`
→ `'A'`, keyboard → `'Enter'`, pointer → `'Click'`, native → `'Tap'`, etc. A missing (device, action)
degrades to the keyboard label, then the Capitalized action name; `device === 'none'` yields `''`.
`inputPromptSources.registerInputPromptSources()` (called from the manager) registers UI read-source
tokens — `{inputDevice}` and `{confirmPrompt}`/`{cancelPrompt}`/`{menuPrompt}`/`{pausePrompt}`/
`{jumpPrompt}`/`{aimPrompt}` — each **pulled at resolve time** from the live `Input` resource via `peekCurrentWorld`
(never lazily allocates a world; returns `''` with no world/Input yet). So an authored `UIElement.text`
like `"Press {confirmPrompt} to start"` (with `UIBinding.textBinding` set) reads correctly per device.

**Design decisions worth knowing.** Input mapping is *config, not a resource* — the button→action
tables are plain read-only consts (a rebindable table is a later phase). Sources ADD their axis
contributions and OR their held flags, which is why `clampAxes` exists. The `Input` resource is spawned
automatically by `SceneManager` for every scene (like `Time`) — it's runtime-only, never authored into
a scene file, and intentionally not an editor-inspectable trait.

## Gotchas

- **Read the resource, never the DOM.** Game/UI/gameplay code must go through the `Input` accessors;
  the input-source guard (`inputSourceGuard.test.ts`) enforces that only the source files touch
  `window`/`navigator`. Reaching for `window.addEventListener('keydown', …)` — or, in a game runtime,
  `addEventListener('pointer…'/'mouse…'/'touch…')` — defeats the whole seam and will trip the guard;
  read tap/drag from the pointer accessors instead.
- **Touch needs `touch-action: none` on the game canvas.** The pointer source can only see a drag the
  browser lets it keep — on Android/iOS a touch over a scrollable/zoomable element is reclaimed for a
  scroll/pinch gesture, which fires `pointercancel` mid-drag (bands flash then vanish; the aim aborts).
  `App.css` sets `touch-action: none` on the render canvases themselves (`.game-wrapper canvas,
  .game-canvas-wrapper canvas` — `touch-action` is not inherited and the canvas is the hit-test
  target) (+ `overscroll-behavior: none` on the body) so the game owns every touch over its canvas. The source's cancel-as-release handling is the
  belt to that suspenders — it keeps a stray cancel from hanging the gesture, but the CSS is what
  prevents the cancel in the first place.
- **Play-start phantom-press suppression.** `inputSystem` sets `suppressEdgesNextFrame` on every
  transition into `playing` and, on that first frame, seeds `prevHeld` from what's currently held — so
  an action already down at Play (a held gamepad face button, or a key the source was tracking) reports
  as *held* but produces **no rising edge**, i.e. no phantom `confirm`/`jump`. This is source-agnostic;
  it replaced an older keyboard-only `prevHeld` clear that left gamepad buttons firing a phantom edge.
- **Sub-frame taps produce no edge.** Because edges are derived by diffing frame-to-frame held state, a
  press+release that both land *between* two sim frames (< ~16ms at 60fps) is never latched. Unreachable
  by physical tapping — only a synthetic keydown+keyup burst hits it — and it's the accepted cost of
  making every source a pure held-reporter.
- **Prompts don't repaint themselves.** UI read sources are pull-only, so a device switch wouldn't
  re-resolve `{confirmPrompt}` on its own. `inputSystem` tracks the last-repainted device and calls
  `markUIDirty()` on a change — that's the only thing that makes the label flip the instant a controller
  is touched. Miss this and prompts render stale.
- **Gamepad `connected` must be seeded on attach.** A controller already known to the page does *not*
  re-emit `gamepadconnected` after a detach→attach (HMR, source swap). Relying on events alone leaves a
  live pad gated off (`connected === 0`) forever — `attach()` recounts from `getGamepads()` for exactly
  this reason.
- **The `editing()` guard is asymmetric (keydown only).** Keys are ignored on keydown while a text
  field is focused, but keyup still removes from the held set unconditionally — correct, since a key
  released after focus leaves must still clear. Don't "fix" the keyup to also gate on `editing()`.
- **`lastDevice` is sticky, `pressed`/`released` are momentary.** `lastDevice` persists until another
  source shows activity; the edge flags are true for exactly one frame. Consuming an edge means reading
  it the frame it fires (the character bridges latch `cc.jump` immediately for the controller to
  consume when grounded).
- **Y sign conventions differ by layer.** The frame is forward/up = +1; the browser gamepad is +Y down
  (negated in the mapper); 3D locomotion is −Z forward (negated in `characterInput3DSystem`). Keep the
  negations where they are.

## Related

- [editor-input.md](./editor-input.md) — the editor's own keyboard layer, and the `setInputGate`
  seam it installs on the source registry to stop a focused editor panel from feeding the running
  game (runtime = mechanism, editor = policy; a shipped game never installs a gate).
- [managers-and-systems.md](./managers-and-systems.md) — the Manager lifecycle (`inputSourcesManager`
  is an app-scope Manager) and `SYSTEM_PRIORITY` tiers.
- [ui-system.md](./ui-system.md) — the read-source registry + `UIBinding.textBinding` that the prompt
  tokens plug into, and `uiFocusSystem` (another `Input` consumer).
- [verification-harness.md](./verification-harness.md) — the deterministic headless loop and the
  determinism guard that forbids DOM/`Math.random` reads outside the sources; how to set `Input` by
  hand in tests.
- [engine-concepts.md](./engine-concepts.md) — resource traits, accessors, and the system/pipeline
  vocabulary.
