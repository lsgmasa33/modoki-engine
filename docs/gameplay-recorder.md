# Gameplay recorder

Play a take in the editor's Game view, then render it offline to a correctly-sized video, frame by
frame at a fixed timestep, as many times as you like (#1479).

## What it is

Screen-recording gameplay for an ad is slow, and the result can't be reused. The phone's panel is
the wrong size, the ad banner is in the way, frames drop, and an art change means re-shooting. The
recorder splits the job in two:

1. **Record** (in the editor): you play normally. The recorder saves a **take**: the starting
   state (the save data, the RNG seed, the wall clock, time zone, locale and safe area) plus every
   pointer transition, stamped in **sim seconds** and in the game root's **layout pixels**.
2. **Render** (`npm run record -- <take>`): a headless Chromium replays the take on the game route
   at a fixed dt. It advances one video frame, screenshots the composited page, and repeats. Then
   the pinned ffmpeg encodes the frames.

Neither the render's speed nor the screen it runs on affects the frames. The output is
`layout size × --scale` pixels. A take recorded at 540×960 renders to 1080×1920 at `--scale 2`.

## Key files

| File | Role |
|---|---|
| `engine/packages/modoki/src/editor/recorder/take.ts` | The take format (`Take`), its validator (`parseTake`), `frameCountFor`, and the replay's event cursor (`TakeCursor`). Has no dependencies, so the CLI loads it directly |
| `engine/packages/modoki/src/editor/recorder/takeRecorder.ts` | Record mode: `startTakeRecording` / `finishTakeRecording`, plus the pure pieces (`clientToLayout`, `TakeBuilder`, `snapshotPrefs`) |
| `engine/packages/modoki/src/editor/rendering/GameView.tsx` | The ● Record button beside Step (`gameView.toolbar.record`), and `REC ·` in the status readout |
| `engine/app/debug/captureDriver.ts` | The in-page replay driver, `window.__modokiCapture`: hold the loop, fixed-dt `step()`, and the settle gate |
| `engine/scripts/record-take.mjs` | The renderer CLI (`npm run record`): starts its own dev server, runs Playwright, writes frames, encodes, writes `render.json` |
| `engine/packages/modoki/src/runtime/rendering/frameDriver.ts` | `setFrameLoopHeld`: the rAF chain keeps firing but runs nothing, and `stepOneFrame` drives it |
| `engine/packages/modoki/src/runtime/core/rng.ts` | `pinFreshWorldSeed`: seeds a world before it exists |
| `engine/packages/modoki/src/runtime/core/captureMode.ts` | `isCaptureMode()`: games hide capture chrome with it. Court's and Weaveling's `adBannerShown` both read it |

## How it works

**The take clock.** Both halves call the same function after every frame, `takeClockDelta(sample)`
(`runtime/core/takeClock.ts`), and sum the result, counted from the take's first timed frame. What it
is, and why:
- **Summed, not a world's `Time.elapsed`.** Every scene load spawns a fresh `Time` into the new
  world, so `elapsed` restarts at 0 on a level change mid-take, and a take stamped from it runs
  backwards there.
- **Unscaled.** A video frame is 1/fps of *real* time, so slow-mo plays slowly in the video rather
  than shortening the take. A time-stop doesn't stamp every tap with one instant.
- **Zero for a frame that didn't advance:** paused, or held by the loading hold.
- **Zero for a frame that *started* with a scene load in flight (#1486).** The halves experience
  a load differently. The editor keeps ticking the old world through the async load at display
  rate, for however long that machine takes, while the replay's settle gate waits it out without
  stepping. Counting the editor's frames put every event after a mid-take load early in the replay
  by the editor's load time. So a load costs nothing on either clock. `SceneManager` answers "in
  flight" through the `sceneLoadInFlight` provider slot from `getNext()`, the same state the
  settle gate waits on.
  - **Sampled at the frame's START** (`isNextSceneLoading()`), then passed to
    `takeClockDelta()` after it. The editor samples from a frame callback at
    `Number.MIN_SAFE_INTEGER`, and the replay samples just before `stepOneFrame`.
  - **Why the start:** the frame that *starts* a load (a game system calling `loadScene`, which
    marks it in flight before its first await) is a timed frame on both halves, so it counts one
    dt. The first cut sampled after the frame, and that step added zero. `record-take` renders a
    fixed `frameCountFor` frames on the promise that N timed steps are N dt, so every take with a
    load lost its last dt of input, including the closing `up`. Review reproduced it.
  - **The settle gate looks again after its last macrotask.** That macrotask exists so a `.then`
    from finished work runs before the frame, but it can also *start* work. A continuation calling
    `loadScene` there went unseen, and the step's frame began mid-load. Review reproduced it: the
    step added zero, and `unsettled` stayed empty.
  - **The result:** a timed replay step adds zero only when the gate went ahead past a load it gave
    up on. The first give-up shows up in `unsettled`. The report's `undispatchedEvents` shows the
    input it cost.
  - **Known limit: the give-up latch counts kinds, not identities.** While any other stuck work
    keeps the latch set, a second load is "covered" by the first give-up. It is not waited out and
    not re-reported, and every step through it adds zero.
  - **The price is deliberate:** the video cuts from the old scene to the new one, and taps made in
    the editor *during* a load all replay together, at the take time the load began at.
    Reproducing the editor's load duration instead would reproduce machine noise, and it would need
    a format bump and a held swap.
  - **Not the same gap:** the settle gate's other waits (fetches, images, fonts, 2D init). For
    those, the replay still steps every frame, just later in real time, so events land at the same
    take time.

**Recording.** Pressing ● while stopped does the following:
- Refuses if the scene has unsaved changes, because the replay loads the scene from disk.
- Flushes PlayerPrefs, then snapshots every stored key of the editor's namespace (`<game>@editor`) as its **raw** stored string.
- Picks a seed, pins it for fresh worlds, and enters capture mode `'recording'`.
- Presses Play. The `onPlayStateChange` listener fires synchronously inside `setPlayState`, before the first play frame. It seeds the world and starts the take clock.

A Play that declines (a scene swap in flight) or throws disarms the recorder. Otherwise the next
ordinary Play would become the take, carrying this press's save, clock and scene.

Window capture-phase pointer listeners then record transitions over the runtime UI root
(`[data-modoki-ui-root="runtime"]`, the same element in the editor and on the game page).
Pressing ● again, or Stop, writes `<project>/recordings/<game>-<YYYYMMDD-HHMMSS>.take.json` through
`/api/write-file`. That folder is gitignored: a take embeds the save it was played from.

**Rendering.** The CLI:
1. Refuses `--fps` below 30 (see Gotchas).
2. Starts Vite for the project on a free port. With `--url` it reuses a running server instead.
3. Launches headless Chromium with `--enable-gpu`, with the viewport set to the take's layout size, `deviceScaleFactor` set to `--scale`, and the take's time zone and locale.
4. Before any app script runs, writes the save back under the game's **runtime** namespace (the prefix comes from `prefsKey.ts`, the key format's one owner) and sets the `--ui-sa-*` safe-area variables.
5. Pins `Date` to the take's epoch.
6. Opens `/?capture=1&dt=…&seed=…&scene=<file name>#/game/<id>`. It uses the game's own route, not `#/`, which boots whichever game the server lists first.

`initCaptureDriver` sees `capture=1` at boot. It holds the frame loop, installs the manual clock,
pins the seed and enters capture mode `'rendering'`.

The CLI boots with `bootStep()` until the game is on screen: the scene is loaded and the loading
hold has let go. `bootStep` settles, then steps *only if* the game is still not on screen, with no
await between that check and the step. The check has to be synchronous with the step. GameShell
releases the hold from a raw `requestAnimationFrame` wait, which keeps firing while the frame loop is
held, so the release can land during the settle. The CLI then asserts the take clock is still 0, and
the next step is the take's first timed frame, as the Play press is in the editor. The driver re-seeds the world on that frame, because systems that draw while the hold
is up would otherwise shift the stream by however many held frames this machine happened to take.
The CLI then checks the booted scene is the take's scene and fails if not, because an unknown
`?scene=` silently boots the default. Then, for each video frame:
1. Dispatch the events due by now on the take clock, mapped into this page's root rect, as trusted CDP mouse input.
2. `step(1)`: settle, sample `isNextSceneLoading()`, advance exactly one dt, run every frame callback once, add `takeClockDelta(sample)`, and drain the journal. The journal is deduped on its process-global `cap` sequence, not the tick: an event emitted *between* steps, such as a DOM click's UI action, carries the previous frame's tick. The old world is drained once more at a swap.
3. Move `Date` on to the take clock.
4. Screenshot.

The frames span `[0, duration]` inclusive (`frameCountFor`), so the last one dispatches an event
stamped at the very end. The closing `up` of a take stopped mid-gesture is stamped there.

**The settle gate.** A fixed-dt replay stops the *sim* clock, not the page. A Pixi Application
init, a texture fetch or a font load still completes in real time. So before each step the driver
waits, in real time, until nothing a frame could depend on is still in flight:
- `Canvas2DPool.pendingInits()`
- `fetch` calls in flight, counted from the start of the capture
- incomplete `<img>`s
- `document.fonts`
- a scene load in flight (`sceneManager.getNext()`), so a mid-take load costs zero take time on every render, matching the editor, whose clock stops for a load too (see the take clock above)

Sim time doesn't move while it waits, so slow content arrives "instantly" on the video's clock.

After 20 s the step goes ahead anyway. The give-up is recorded in `unsettled`, together with what
was pending: one entry per give-up, not per frame, because every frame from that one on may lack the
content. A give-up **during boot** is recorded too, marked `duringBoot`, since it means the whole
video may lack it. `stillGivenUp` lists what the gate had given up on when the render ended.

The gate gives up on stuck work **once**. A Pixi init that rejected stays
uninitialised forever, and without the latch every later step would wait the full timeout again (a
1,400-frame take would take about 8 hours).

The latch compares counts per kind. A stuck set that shrinks stays given up, while a new kind, or
more of one, blocks again. Counts are not identities, though:
- a stuck fetch that finishes just as a new one starts reads as the same "1 fetch";
- a latched `fonts` is never awaited again.

The gate also has blind spots: a fetch made inside a worker, and an `Image` that isn't in the
document.

**Output.** The output folder, next to the take by default or wherever `--out` points, holds:
- `<name>.mp4`: H.264, CRF 16. With `--prores` it's `.mov` in ProRes 422 HQ instead.
- `render.json`.
- `frames/`, but only with `--keep-frames`.

The take itself is **not** copied into the folder: it embeds the save, and this folder holds
deliverables that get shared.

`render.json` lists:
- the game's own journal events, plus `@audio`, `@cue`, `@scene-loaded` and `@scene-swapped`, each placed on the video frame whose step emitted it (collected after every step, since the journal is per world);
- the settle gate's give-ups (`unsettled`, with `stillGivenUp`), each also printed as a warning;
- page errors, including GameShell's warnings.

**What it measured** (Court, 2026-09-24):
- A 47 s take recorded in the editor (a queen dragged to an illegal square, costing a heart) replayed with the same level restored from the save and the same gesture (673 px of travel). The same `court.place`, `court.heart.lost` and `court.illegal` events landed.
- Rendering took 184 s for 1,414 frames.
- After the review fixes, a second take (a bishop dropped on b3) replayed the same placement and heart loss at 1080×1920. It rendered 471 frames in 56 s, with 0.5 s of settling and nothing unsettled.
- The same take rendered twice gave identical journal and audio events. 81 of 90 frames were byte-identical, and the other 9 differed by at most 2/255 in at most 650 of about 2.07M pixels. That's GPU rasterisation noise, not the state diverging.

## Gotchas

- ⚠️ **Capture mode is on while you PLAY the take, not only while it renders.** A game hides capture
  chrome in it, and hiding chrome can move the layout: Court's and Weaveling's banner strips give
  their height back to the board. If only the render hid it, every recorded position would be off
  by the strip. So what you play is exactly what gets rendered.

  The two phases differ in one respect only: engine debug surfaces (error toasts) stay up while you
  record, because you're watching, and hide while rendering (`getCaptureMode()`).
- ⚠️ **`--fps` has a floor of 30.** `timeSystem` clamps every frame's delta to 1/30 s. At 24 fps each
  step would advance the sim by only 1/30 s, so the video would play at 0.8x and never reach the last
  fifth of the take.
- ⚠️ **The replay must lay out at the take's size.** Positions are layout pixels, so a different
  size is a different layout. The CLI warns when the game root it finds doesn't match
  `take.viewport`. The output resolution is `--scale`, never a different viewport. Record at the
  aspect ratio you want to ship.
- **A take names its scene by FILE name** (`main.scene.json`). `resolveSceneByName` strips only
  `.json`, so the bare `main` never resolved. Court's replays looked right anyway only because its
  default scene *is* `main`.
- **The preview used to be 2 px short.** The GameView's device div had a `1px` border under the
  app's global `box-sizing: border-box`, so a 540×960 preset laid the game out at 538×958. It's
  an `outline` now.
- **An editor take and its replay start from different places.** The editor presses Play on a
  live world, while the replay boots a page. Everything the game reads at start is carried over:
  the save, the seed, the wall clock and the time zone. Anything else a game reads at boot is not,
  and that is where a replay can diverge. The render report's `gameEvents` against the editor's
  journal is how to check.
- **Pointer timing is quantised to the video's frame rate.** Events are dispatched between steps,
  so a gesture's `heldMs` can differ by up to a frame (Court: 384 ms live, 400 ms replayed at
  30 fps). A game that reads gesture speed from `e.timeStamp` sees the replay's timing, not the
  live one.
- **WebGPU has no adapter in headless Chromium on a Mac.** The engine falls back to WebGL, which is
  fine for 2D. A 3D game that needs WebGPU-only features will not render them yet.
- **`--url` pointed at a running editor's dev server is shared with that editor.** The dev server
  broadcasts bridge requests to every tab. Leave `--url` off and the CLI uses its own server.
- **Not yet:**
  - audio (`render.json` already places every `@audio` event on a frame; mixing is phase 2);
  - an MCP wrapper;
  - suppressing mid-take interstitials.

## Related

- [plans/ad-video-pipeline-plan.md](./plans/ad-video-pipeline-plan.md): the pipeline this is Phases 0–1 of, and why capture has to come from the compositor
- [verification-harness.md](./verification-harness.md): the manual clock, seeded RNG and event journal this builds on
- [video.md](./video.md): why video and audio are never frame-stepped
- [editor.md](./editor.md): the Game view
