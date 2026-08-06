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
- `runtime/input/inputSystem.ts` — the per-frame bridge: sample all sources → derive edges → write
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
- `runtime/core/pointerBlockers.ts` — the pointer-block-root registry (`registerPointerBlocker`/
  `isPointerBlocked`), consulted by `pointerSource.ts` at ingestion. Lives in `core/` (L0), not
  `input/` or `ui/` (both L2), because both need to reach it and there is no `ui → input` zone edge.
- `runtime/input/pointerRecorder.ts` — the **input watch** (#134): a bounded, agent-readable record
  of what the pointer actually did. Separate capture-phase listeners on `window`, attached only
  while a watch window is open, so it sees a press regardless of what any layer downstream does
  with it — blocked, `stopPropagation`'d, or a second finger `pointerSource` deliberately ignores.
  See "The input watch" below.
- `runtime/input/characterInputSystem.ts` / `characterInput3DSystem.ts` — GAME-tier bridges copying
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

**Pointer-block roots (a DOM overlay claiming pointer exclusivity).** The pointer source binds to
`window`, so a DOM overlay drawn as a sibling of the game canvas (the engine `UIRenderer`, the F12
debug menu panel, a game's own hand-built chrome — e.g. `games/court`'s rules dialog) does NOT, by
itself, stop the game from also seeing the same tap underneath. `registerPointerBlocker(el)`
(`core/pointerBlockers.ts`, exported from `@modoki/engine/runtime`) fixes this: it registers `el` as
a block root, and `onPointerDown`/`onWheel` consult `isPointerBlocked(e.target)` BEFORE latching a
gesture or accumulating wheel delta — never inside `sample()`, which would corrupt the down/up FIFO's
alternation invariant (see the source file's own banner). Because a blocked pointer never latches
`activeId`, its whole gesture (later `pointermove`/`pointerup`, even off the registered root, e.g. a
drag that started on a DOM button then left it) stays invisible for free, with no per-pointer claim
state to leak — an EARLIER design keyed a claim by `pointerId` and had to defend against a leaked
claim permanently deafening the game to that pointer; this design has no claim to leak in the first
place, since the block decision is recomputed from the live DOM at every event. `UIRenderer` registers
its own root automatically, but ONLY in runtime mode (`!onSelectEntity`) — the editor mounts the same
UI tree a second time inside SceneView's authoring preview, where a click manipulates gizmos/
selection, not the running game, and must never claim its pointer. A game's own DOM chrome (like
`rulesDialog.ts`) registers/unregisters manually around its own mount/unmount.

⚠️ **PASSTHROUGH SURFACES — a block root alone over-blocks, and it killed all 2D input for a day.**
`UIRenderer` registers its WHOLE UI root, but that root is not "chrome": it is a LAYER holding chrome
AND, for every 2D game in this repo, the game's own render surface. The standard scene shape puts
`Canvas2D` on a `UIElement`, so the game's `<canvas>` is a DESCENDANT of the UI root — and judging by
containment alone classified every press on the game's own board as a press on chrome. `onPointerDown`
returned before latching, so ALL pointer input to the game was dead: measured across 19 scenes in 10
projects, including both published demos. **The block direction worked; nothing asserted the pass
direction**, which is how a one-directional guard ships — it passes by blocking everything.

`registerPointerPassthrough(el)` marks a surface as the game's own, exempt even inside a block root.
`canvas2DPool` registers each slot's canvas automatically, so games need no opt-in. Resolution is
**nearest-ancestor**: the registration closer to the event target decides, so chrome deliberately
registered inside a passthrough surface still blocks.

**Register the `<canvas>` ELEMENT, never a wrapper around it.** This is the entire safety argument for
"if UI picks the click, it must not reach the canvas/2D Pixi layer or 3D": a UI element can never be a
DOM descendant of a `<canvas>` (fallback content is not rendered or hit-tested), so a press on a UI
button over the canvas still has `target = button` — inside the block root, outside the passthrough
surface — and is blocked exactly as before. Register the canvas's PARENT instead and every UI element
inside it starts leaking presses into the game, which is the original bug this system exists to
prevent. Pinned by `pointerBlockers.test.ts` (both directions, plus the wrapper failure mode) and by
`pointerBlockRootsIntegration.test.ts`, which fires a real `pointerdown` on a canvas inside a real
rendered `UIRenderer` and asserts the game's `Input` DOES see it.

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

## Pointer lead — drawing where the finger is about to be

A dragged object trails the finger on a touch device, and **it is not the frame budget**. Measured
on an A23 (2026-08-06, Court): during a real drag the frame time was a median of **16.7 ms with
exactly one frame over 25 ms out of 226** — a clean 60 fps — the ECS pipeline already runs `INPUT`
(50) before `GAME` (100) before the 2D render, and `onPointerMove` queues nothing that could
accumulate. Three plausible causes, all dead.

**The decisive measurement was a control.** A bare DOM `<div>` moved directly in the pointer
handler — no ECS, no canvas, the shortest path a browser offers — lagged by the *same* amount. So
the latency is the platform's touch → event → render → composite pipeline, roughly **83 ms, five
frames at 60 Hz**, and there is no frame left in engine code to reclaim. The owner then confirmed
it on an iPhone 8 and an iPhone Air too, so it is not Android-specific. Chrome's own
`getPredictedEvents()` reaches exactly **one** frame ahead (16.6 ms measured) and cannot close it.

The only remaining lever is to draw where the finger is *heading*:

| Piece | Where | What it does |
|---|---|---|
| `PointerFrame.vx/vy` | `core/inputActions.ts` | Pointer velocity, CSS px/ms |
| velocity estimate | `input/pointerSource.ts` | Newest sample PAIR, EMA-smoothed; zeroed on press, release and reset |
| `PointerFrame.t` | `core/inputActions.ts` | The sample's timestamp — how stale the position already is |
| `input/oneEuroFilter.ts` | — | The adaptive filter + `POINTER_FILTER_DEFAULTS` |
| `setPointerFilterParams` | `input/pointerSource.ts` | Retune `minCutoff`/`beta` live |
| `pointerPredictedPos(world, leadMs?)` | `traits/Input.ts` | `pos + velocity × lead` |
| `POINTER_LEAD_MS_DEFAULT` · `setPointerLeadMs` | `traits/Input.ts` | The engine-wide lead — **0, i.e. off by default** |
| `setPointerLeadGate` · `pointerLeadGateFactor` | `traits/Input.ts` | The speed gate — no lead below `minSpeed`, full above `fullSpeed` |
| Debug menu → **Input** | `runtime/debug/tabs/InputTab.tsx` | Measure a device: two rings (raw vs extrapolated) + a lead slider |

⚠️ **The predicted point is RENDERING-only.** It is a guess about the future, so a hit-test that
reads it resolves a tap, a drop cell or a drag threshold at a position the finger never occupied —
on a fast flick that is a whole cell, and it would only ever appear on quick strokes, which is how
it would ship. `pointerPos` stays the truth. Court keeps the two in separate fields for exactly
this reason (`press.dragX/Y` vs `press.predX/Y`, `dragPoint()` vs `dragRenderPoint()`), and
`games/court/tests/dragFx.test.ts` pins it: the picture leads by a cell while the drop still lands
under the finger.

### ⚠️ Extrapolate to a TIME, not by an OFFSET

The obvious implementation — `lastEventPos + velocity × lead` — is **a known-wrong shape**, and it
is what made the iPhone Air jitter. Input and display are asynchronous, so the newest event's age
at render time varies by up to a full input interval every frame; adding a fixed offset to a
position of *varying staleness* writes that phase noise straight into the pixels. Casiez et al.,
[*Modeling and Reducing Spatial Jitter caused by Asynchronous Input and Output Rates*](https://gery.casiez.net/async),
describe it and prescribe the fix — resample to a fixed point in **absolute time** — and Chrome on
Android has shipped that by default since 2023.

So `pointerPredictedPos` advances by `(now − sampleTime) + lead`. The age term cancels the phase
noise; the lead term is the actual latency compensation. At 60 Hz the age varies by ~16 ms against
a long true latency and the error was tolerable; at 120 Hz it varies by ~8 ms against a much
shorter one, which is why the *fast* device was the one that trembled.

A lead of **0 is fully off** — not even the age term applies. Disabling a feature must return
exactly the previous behaviour, or "off" becomes a third mode nobody asked for.

### The lead is SPEED-GATED

The two failure modes sit at opposite ends of the speed range. Near-stationary, the latency is
imperceptible and any extrapolation error is a visible tremor on a hard-edged object. Moving fast,
the error is swamped by the movement and the latency is all you notice. **One fixed lead has to
serve both and serves neither** — the same shape of problem the 1€ filter solves for smoothing,
one level up.

So the lead fades in between two speeds (`POINTER_LEAD_GATE_DEFAULTS`, live in the debug tab):

| Knob | Meaning |
|---|---|
| `minSpeed` | below this, **no lead at all** — sits above the stationary noise floor |
| `fullSpeed` | at or above this, the whole authored lead |

⚠️ **A ramp, not a threshold.** A hard on/off jumps the drawn position by `speed × lead` at the
crossing — about 7 px at 0.2 px/ms and a 33 ms lead — trading a tremor for a *snap*, which is worse
because it correlates with the gesture rather than with noise. `pointerLeadGateFactor` is a
smoothstep, so it has a zero derivative at both ends and the lead fades in with no discontinuity in
position **or** velocity.

The **age** term is deliberately *not* gated: it corrects a staleness that is known rather than
guessed, and it is multiplied by the same near-zero velocity, so it is self-limiting.

### The velocity is 1€-filtered, not EMA-smoothed

A fixed smoothing constant must choose between two opposite requirements — heavy smoothing kills
jitter but lags a fast movement; light smoothing tracks fast movement but leaves a slow one
trembling. **Every fixed constant is wrong somewhere**, and this one was wrong twice on the *same*
device: the A23 wanted an 83 ms lead one day and trembled at 33 ms the next. Once the position is
advanced *between* samples, a velocity ERROR becomes a per-sample sawtooth — which is what "jitter"
turned out to mean here.

So both the smoothed position and the velocity come from the **1€ filter** (Casiez, Roussel & Vogel,
CHI 2012 — the same author as the resampling work), whose cutoff rises with speed:
`cutoff = minCutoff + beta × |velocity|`. Nearly still → heavy smoothing → jitter dies. Moving fast
→ light smoothing → no lag where you would notice it. Two parameters, tuned **in this order**
because they are close to independent:

1. **`minCutoff`** (Hz) — LOWER it until a *stationary* finger stops trembling.
2. **`beta`** — RAISE it until a *fast* drag stops lagging.

Both are live in debug menu → **Input**, alongside the lead. Defaults are the paper's conservative
starting point (`minCutoff` 1, `beta` 0), not a measurement — `beta: 0` deliberately errs toward
lag, because lag is the symptom you can see and therefore tune away, whereas starting aggressive
hides the jitter the filter exists to remove.

⚠️ **Smooth the VELOCITY; extrapolate from the RAW position.** Filtering the base position and
extrapolating from *that* subtracts the filter's lag from the lead — and at conservative settings
it exceeds the lead, so switching prediction ON draws the object **behind** the finger. Measured
during close-out: a 12-sample drag predicted x=372 against a true x=440. A feature whose on-state
is worse than its off-state is a defect, not a tuning problem. Position noise is ~1 px; velocity
noise times an 80 ms lead was the ~10 px tremor — only the second is worth filtering.

⚠️ **Estimate velocity from the NEWEST pair, never a window average.** A window centred *N* ms in
the past yields a velocity that is itself stale, so a requested lead of *L* advances the position
by only *(L − N)*. Measured: a 5-sample window turned a requested 50 ms into roughly 17 ms of real
lead — which reads as "prediction barely helps" and sends you hunting for the missing latency
somewhere else entirely. The debug tab's rings run the same 1€ pipeline as `pointerSource` on
purpose; a tuner that models the runtime differently is measuring the wrong thing.

### ⚠️ There is no engine-wide number — the default is 0

The obvious move is to ship 83 ms for everyone. **It is wrong, and measurably so.** Both of these
were felt live, same build, same estimator:

| Device | Verdict |
|---|---|
| Galaxy A23, 60 Hz | ~83 ms — the drag only stops trailing the finger with it |
| iPhone Air, 120 Hz | **0 — any lead visibly JITTERS** |

The reason is arithmetic, not taste. A two-point velocity divides by the sample gap, so at 120 Hz
(~8.3 ms) one pixel of pointer noise becomes ~0.12 px/ms of velocity error, which an 83 ms lead
multiplies into **~10 px of jitter**. At 60 Hz the gap is double, the noise term halves, and the
device actually has latency worth cancelling. Same code, opposite outcome. A default of 83 would
have shipped jitter to every fast device in order to fix a slow one.

### ⚠️ The verdict: OFF — and it took four rounds to earn that answer honestly

Prediction is **off by default** and Court declines it. Read this before re-proposing it, because
three of the four rounds produced a *wrong* answer that looked like a real one:

| Round | What was judged | Why the verdict was not trustworthy |
|---|---|---|
| 1 | "83 ms feels right" | Velocity came from a 66 ms window average, so the real lead was ~17 ms |
| 2 | "even 33 jitters, off is best" | Extrapolated from the 1€-**smoothed** position — the picture drew ~68 px **behind** the finger. The ON state was worse than OFF *by construction* |
| 3 | "33 is better; gate it by velocity" | Correct base at last, but the gate floor (0.05) sat *under* the estimator's own noise (measured median 0.065 while holding still), so the gate flickered 0↔0.6 and the ungated age term leaked ~2.5 px of varying offset |
| 4 | **"no jittering now, much better — but off is the best"** | Correct implementation, fair test. **This is the verdict.** |

The trade is latency for extrapolation error, and on Court's content the error loses: a chess piece
is a hard-edged, high-contrast object on a still board, so any tremor reads instantly, while a few
frames of lag on a deliberate placement gesture does not.

That is a judgement about **this content on these devices** — a game with softer art, a continuous
drag, or a lower-frequency object may well trade the other way. Which is why the mechanism, the
tuner and `POINTER_LEAD_MS_ANDROID_60HZ` are kept rather than deleted: the next question costs a
minute instead of a day.

**The transferable lesson is the method, not the answer.** Every round's verdict was only as good
as the implementation under it, and each defect was found by *measuring the running device* — a DOM
control ring, a frame-time histogram, a per-frame recording of the predicted-vs-raw offset — never
by reasoning about the code. Round 3's defects in particular were invisible to inspection and
obvious in one 454-sample trace.

**Do not re-enable it from reasoning.** Every number guessed from the hardware in this
investigation was wrong: Android-only (it was not), scale-with-refresh-rate (it did not), 83 ms
(the A23 later trembled at 33). Measure, or leave it off.

**Adoption is also per-renderer.** The engine cannot know which entity is "the thing under the
finger", so a game opts in by drawing at `pointerPredictedPos`. What the engine supplies is the
mechanism, the measured constant, and the debug tab — so the next device gets a real number in a
minute instead of a guess about the hardware, which is how both numbers above were nearly wrong.

## The input watch — evidence for a gesture that did nothing

The journal answers *"what did the game do"*. It cannot answer *"what did the player's finger do"*,
and those become different questions the moment a gesture fails: a press that resolves to nothing
emits nothing — no event, no commit, no coordinates. So the failure mode with the least evidence is
the one players report most often ("I tried to drag it and nothing happened"). `pointerRecorder.ts`
is the instrument for that class; the agent-facing tool over it is documented in
[debug-tools-mcp.md](./debug-tools-mcp.md).

Per press it records the down/up points, **travel distance and move-sample count**, hold duration,
which pointer-block root swallowed it (if any), and what it resolved to. Travel and sample count are
not padding: on the Galaxy A23 bug that produced this, *64 move samples over 1216 ms* is what killed
the competing "the device dropped pointer samples so the drag never passed the slop threshold"
hypothesis, and the measured 27.6 px miss is what showed the fix about to ship — a 1.2x grab
forgiveness giving 27.31 px — would have failed by 0.3 px and looked like a different bug.

Two properties are load-bearing:

- **Gated, and genuinely free when closed.** No listener is even attached until a window opens, and
  nothing is captured retroactively — same contract as the journal's `@contact` Tier-2 gating. Raw
  pointer traffic is high-frequency; an always-armed recorder would cost every shipped game a
  listener it never reads.
- **On DEVICE it is the only blocked-press evidence there is.** `input.pointer.blocked`
  (`pointerSource.ts`) is emitted under `import.meta.env.DEV` only, so in a debugBuild running on
  a phone — the surface where touch targets are actually missed — that event does not exist. The
  gating is deliberate and stays: a blocked press is *common* (every tap on chrome is one), and
  un-gating it would let blocked presses dominate the 10,000-event journal ring. The watch is the
  device answer instead, because it is gated on a window nobody opens by accident, and it records
  the blocking root's identity, which the event never carried.
- **"Could not look" is never reported as "nothing is there."** `resolved` is a three-way answer —
  deliberately the same three-way [`screenPick.pickAt`](../engine/packages/modoki/src/runtime/core/screenPick.ts)
  already makes. Something was hit (`by:'game'|'ui'|'pick'`), an authority looked and found nothing
  (`by:'none'`, naming who), or **nobody could look** (`by:'unknown'`, with the reason). Collapsing
  the last two would answer the one question the tool exists for with a confident lie.

### A canvas game must publish its own hit-test

The engine cannot hit-test a canvas game. No game surface registers a pick provider (that is
deliberate — see `screenPick.ts`'s header: selection policy is game code), so a game whose targets
live in its own `hitTest` records `by:'unknown'` for every press until it opts in:

```ts
import { noteInputResolution } from '@modoki/engine/runtime';

press.target = hitTest(x, y);
noteInputResolution(press.target && { kind: press.target.kind, id: cellName(...) });
// …and at release, for the drop target:
noteInputResolution(dropTarget && { kind: dropTarget.kind, id: … }, 'drop');
```

- **Call it from the hit-test itself**, not from a second implementation that agrees today — the
  same rule `screenPick` states for pick providers.
- **Passing `null` is meaningful**: "my hit-test ran and found nothing" is a different, far more
  useful answer than staying silent.
- **It is a no-op when no window is open**, so it stays unguarded at the call site.
- **`phase` is explicit, not inferred from timing.** A game hit-tests from a SYSTEM, a frame or more
  after the DOM event — a quick tap is finished and recorded before the game ever looks at it. So
  presses are claimed in gesture order from a FIFO and a `'drop'` note names the gesture whose press
  was claimed last. Inferring the phase from "which press is in flight" mis-assigns under exactly
  the rapid input a missed-gesture investigation involves.

Worked example: `games/court/runtime/systems.ts` (`noteHit`), with the wiring pinned by
`games/court/tests/inputWatch.test.ts` — a suite that exists because nothing else in Court would
notice if those three calls were deleted.

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
- **A new DOM overlay over the game must register a pointer-block root, or it leaks.** Anything drawn
  as a sibling of the game canvas (a game's own hand-built modal/HUD, not routed through `UIElement`)
  needs `registerPointerBlocker(rootEl)` around its own mount/unmount, or a tap on it will ALSO
  register as a tap on the game underneath — the "phantom paint" / stray-placement symptom is nasty to
  diagnose because it reads as a layering bug, not an input one. `UIElement`/`UIRenderer`-based UI
  gets this for free. The registration must happen synchronously inside the DOM event's own dispatch
  (e.g. a mount-time callback ref) — a claim decided asynchronously (a `useEffect`, a `setState`) is
  too late for the `pointerdown` that already started ingesting.

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
