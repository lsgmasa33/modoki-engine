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
2. **Render**: a headless Chromium replays the take on the game route at a fixed dt. It advances
   one video frame, screenshots the composited page, and repeats. Then the pinned ffmpeg encodes
   the frames. Stopping a take in the editor opens a render dialog that runs it for you, with a
   progress card (#1488, § Rendering from the editor); `npm run record -- <take>` runs the same CLI
   from a terminal.

Neither the render's speed nor the screen it runs on affects the frames. The output is
`layout size × --scale` pixels. A take recorded at 540×960 renders to 1080×1920 at `--scale 2`.

## Key files

| File | Role |
|---|---|
| `engine/packages/modoki/src/editor/recorder/take.ts` | The take format (`Take`), its validator (`parseTake`), `frameCountFor`, and the replay's event cursor (`TakeCursor`). Has no dependencies, so the CLI loads it directly |
| `engine/packages/modoki/src/editor/recorder/takeRecorder.ts` | Record mode: `startTakeRecording` / `finishTakeRecording`, plus the pure pieces (`clientToLayout`, `TakeBuilder`, `snapshotPrefs`) |
| `engine/packages/modoki/src/editor/rendering/GameView.tsx` | The ● Record button beside Step (`gameView.toolbar.record`), and `REC ·` in the status readout |
| `engine/app/debug/captureDriver.ts` | The in-page replay driver, `window.__modokiCapture`: hold the loop, fixed-dt `step()`, and the settle gate |
| `engine/scripts/record-take.mjs` | The renderer CLI (`npm run record`): starts its own dev server, runs Playwright, writes frames, encodes, writes `render.json`. `--ndjson` / `--watch-stdin` are the editor job's protocol |
| `engine/packages/modoki/src/editor/recorder/renderOptions.ts` | The render options: legal values (the fps floor), the output size, the defaults' precedence, the CLI arguments. Read by the dialog, the backend job AND the CLI |
| `engine/packages/modoki/src/editor/recorder/renderFlow.ts` | Take saved → dialog → job → card, and re-attaching to a running job after a page reload |
| `engine/packages/modoki/src/editor/recorder/renderJobModel.ts` | What the progress card shows: stage, bar, ETA, the warnings from `render.json` |
| `engine/packages/modoki/src/editor/panels/RenderTakeDialog.tsx` | The options dialog and the progress card (drawing only) |
| `engine/plugins/backend/recordRenderJob.ts` | The backend's render job: spawns the CLI, folds its progress lines, cancels. Routes: `/api/record/render` (GET poll, POST start), `/api/record/render/cancel` |
| `engine/plugins/takeAssets.ts` | The asset fingerprint a take stores, and the render's check of which of the take's assets changed since (#1509). Loaded by the backend (`POST /api/record/fingerprint`) and by the CLI |
| `engine/packages/modoki/src/runtime/core/takeJournal.ts` | `TakeJournalTap`: the one rule both halves drain the journal by, so the replay check compares like with like |
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
- Asks the backend for a fingerprint of the project's assets (`POST /api/record/fingerprint`). It
  is awaited only when the take is written, so the hashing runs while you play. A failed request
  costs the render its assets check, not the take (§ Assets changed since the take).
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

**Output.** Each take renders into a folder named after the take. That folder sits next to the take by
default, or inside the folder `--out` names: `--out` is the PARENT, so one folder chosen once and
reused never has one take's render overwrite another's (#1488 review). It holds:
- `<take>.mp4`: H.264, CRF 16. With `--prores` it's `.mov` in ProRes 422 HQ instead. It is encoded
  as `<take>.rendering.mp4` and renamed into place only when the encode succeeds, so a failed or
  cancelled re-render of the same take leaves its previous video intact. A failed encode deletes
  its `.rendering` file. From the rename on, nothing cancels the run: a lost parent there must not
  delete a finished render (the second review round simulated it doing exactly that).
- `render.json`.
- `frames/`, but only with `--keep-frames`.

The take itself is **not** copied into the folder: it embeds the save, and this folder holds
deliverables that get shared.

`render.json` lists:
- the game's own journal events, plus `@audio`, `@cue`, `@scene-loaded` and `@scene-swapped`, each placed on the video frame whose step emitted it (collected after every step, since the journal is per world);
- the settle gate's give-ups (`unsettled`, with `stillGivenUp`), each also printed as a warning;
- page errors, including GameShell's warnings;
- `replay`: the replay check's verdict (§ The replay check);
- `assets`: which assets this take uses changed since it was recorded (§ Assets changed since the take).

**What it measured** (Court, 2026-09-24):
- A 47 s take recorded in the editor (a queen dragged to an illegal square, costing a heart) replayed with the same level restored from the save and the same gesture (673 px of travel). The same `court.place`, `court.heart.lost` and `court.illegal` events landed.
- Rendering took 184 s for 1,414 frames.
- After the review fixes, a second take (a bishop dropped on b3) replayed the same placement and heart loss at 1080×1920. It rendered 471 frames in 56 s, with 0.5 s of settling and nothing unsettled.
- The same take rendered twice gave identical journal and audio events. 81 of 90 frames were byte-identical, and the other 9 differed by at most 2/255 in at most 650 of about 2.07M pixels. That's GPU rasterisation noise, not the state diverging.

## Rendering from the editor (#1488)

**Stop → dialog → progress card → video.** Stopping a take, by ● Record or by the Game toolbar's ■
Stop, saves it and fires `onTakeSaved`, which opens the options dialog:
- **FPS**: default 30, and Render stays disabled below the floor (§ Gotchas).
- **Scale**, with the output size beside it (540×960 × 2 → 1080×1920).
- **Format**: H.264 `.mp4` or ProRes 422 HQ `.mov`.
- **Output folder**: the folder the take's own output folder goes in; empty means the take's folder.
- **Keep frames**.

**Not now** keeps the take, and `npm run record` can still render it later.

**Render** closes the dialog and shows a card in the editor's bottom-right corner. It is not modal, so
the editor stays usable while the render runs. It shows:
- the stage (dev server → booting → frames → encoding);
- `frame N / total`, the elapsed time, and an ETA from the current stage's rate;
- a Cancel button.

When the render finishes, the card shows Reveal in Finder (`/api/record/render/reveal`, which reveals
the finished job's own video by job id, so a folder outside the project works too; the generic
`/api/reveal-in-finder` refuses paths outside the project) and what needs attention in `render.json`:
the replay check, settle-gate give-ups (a `duringBoot` one called out), undispatched input and page
errors.

**Where the dialog's values come from** (`initialRenderOptions`), field by field:
1. What the owner last chose in this project's dialog (localStorage, `projectScopedKey`), if it is
   still legal. A stale field is dropped on its own; the other fields stay.
2. For Scale only: **Project Settings → Web → Gameplay Recorder → Video height**
   (`recording.outputHeight` in `project.config.json`). Scale is that height ÷ the take's layout
   height, so 1920 on a 540×960 take gives ×2.
3. The fallbacks: 30 fps, ×2, `.mp4`, the take's own folder, no frames.

**The render is a JOB the page polls, not a request-scoped stream.** The build routes use an SSE
stream whose disconnect is the cancel. That shape would turn any editor page reload into a silent
cancel, and editing game code force-reloads the page (editor-hmr.md). A render takes 3–4× the take's
length. So the backend keeps the job (`recordRenderJob.ts`), the card polls `GET /api/record/render`
every 500 ms, and a reloaded page picks a running job back up. Measured: a page reload mid-render
brought the card back at frame 65/435.

**Cancel closes the CLI's stdin. It is not a process-group kill.** Playwright launches Chromium
DETACHED, in a process group of its own (`detached: process.platform !== "win32"` in its launcher).
So a kill aimed at the CLI's group leaves 5 headless-shell processes running. The CLI tears down
what it started:
- With `--watch-stdin`, stdin EOF counts as a cancel, and so do SIGTERM and SIGINT.
- It closes the browser, stops its Vite, kills a running encode, and deletes its partial output: the
  take's folder when this run created it, otherwise `frames/` and the `.rendering` video.
- A cancelled re-render leaves the earlier video byte-for-byte intact. Measured by cancelling
  during encode: the md5 was unchanged, while encoding straight into the final name truncated the
  earlier video to 48 bytes.

When the backend dies, stdin closes and the pipes the CLI writes to lose their reader. The first cut
crashed there: `cancel`'s first log line raised EPIPE, unhandled, before any teardown ran, and it
left the partial folder behind (review of #1488 observed it). Now a stdout or stderr error is itself
a cancel, and output is dropped from then on. Vite is also stopped from the `exit` hook, as a
backstop for any exit that skips `cancel`. Measured by killing the parent mid-frames: all 8 render
processes were gone and the take's folder removed. With the error handlers removed, `frames/` was
left behind.

So the job is deliberately NOT registered with `buildStepShell`'s shutdown reaper: that reaper's
`exit` hook SIGKILLs the group, which would kill the CLI before it could close the browser. Only a
CLI that ignores the EOF for 10 s is killed outright. Closing stdin is also how Windows would cancel,
since it has no signals, but that has not been run on Windows.

Measured on Court: cancelling from each stage (Vite starting, booting, frames, encoding, SIGINT)
exited in under 140 ms with no descendant process left. A cancel from the card went to
"cancelled" in 467 ms, and all 8 render processes were gone.

**The CLI's progress protocol** (`--ndjson`): one JSON object per stdout line, and the human text
moves to stderr. The lines are:
- `start {total, size, video}`
- `server` and `boot`
- `frames {frame, total}`
- `encode {frame, total}` (from ffmpeg's `-progress`)
- then exactly one of `done {…summary}`, `error {message}` or `cancelled`

The job ignores a stage it doesn't know, so a newer CLI does not break an older editor.

**Not in the packaged editor.** It ships no Playwright Chromium and no repo scripts, so
`GET /api/record/render` answers `available: false` there. Stop still saves the take, and the dialog
shows the `npm run record` line instead of Render. Rendering there would need a hidden Electron window
driven over CDP, which is a redesign.

## The replay check

A take stores the game's own journal events from the Play press to Stop (`expectedEvents`). The
render compares them with the events its replay emitted (`compareTakeEvents`, reported as `replay`
in `render.json`). Both halves drain the journal through one `TakeJournalTap`:
- It is keyed on the journal's `cap`, not the tick.
- It keeps a cap PER WORLD, and drains every world seen this take on every drain, merged back into
  emission order. `SceneManager` emits `@scene-swapped` into the promoted world BEFORE it awaits the
  old world's manager disposal, which emits into the old world, possibly over several frames. One
  shared cap dropped whichever side was drained second, and review reproduced both orders.
- Only game events (no `@` prefix) are compared.

**Known, unverified limits.** The replay drops events from its boot steps, while the editor keeps
everything from the Play press on. A game that emits on its very first system tick could therefore
read as `diverged` (Court does not). The Vite-hosted backend (a browser editor on `npm run dev`)
loses its job table if Vite restarts mid-render; the Electron main-process backend does not.

The comparison was measured on a real Court take before its rule was chosen. Three things differ
between an editor take and its replay even when the replay does exactly what was played:
- **Async work interleaves by timing.** `court.iap.trusted-clock` is a network fetch, and it landed
  after `court.session.restored` in the editor and before it in the replay. So the check compares
  **per event type**: each type's events, in order, against the same type's. It never compares one
  global order.
- **Layout floats differ in the last digits.** The editor lays the game out inside a CSS-scaled div,
  so `court.relayout` measured 269.4687568551177 there and 269.46875 headless. Numbers therefore
  compare within an ABSOLUTE 0.01, so two integers match only when they are equal. A tolerance
  relative to the size was tried first, and review showed it calling 12345 vs 12346, and
  20260924 vs 20260925, equal: a different score or day key passing as the same replay.
- **Input measurement is quantised.** A gesture's `travelPx` (334 → 312) and `heldMs` (269 → 267)
  differ, because moves are coalesced per frame and dispatched at the video's rate. A pointer event's
  page `x`/`y` differs too.

So the verdict has two tiers:
- **`diverged`**: an event type happened a different number of times, such as a second heart lost or
  a missing placement. The replay went somewhere else.
- **`differs`**: every event happened the same number of times, but some payload fields differ. The
  fields are listed (`travelPx 334→312`), so the owner can tell input measurement from a different
  outcome, such as a different cell.

That Court take replayed as `differs`: the same placement on a2, the same heart lost, and only
`court.gesture`'s travel and hold plus a blocked pointer's coordinates differed. A take recorded
before #1488 has no `expectedEvents`, and its replay is `unchecked`.

## Assets changed since the take (#1509)

**A render uses the project's assets as they are NOW, not as they were when the take was played.
That is the owner's call (2026-09-24), and it is deliberate.** Re-rendering a take after an art
change is what the recorder is for, and much of a game's art (colour, size, position) is authored
in the scene itself. Storing the scene in the take would have frozen that art too. So a render
never refuses and never substitutes: it **reports**.

The cost is that an edit made between the take and the render can change the video without
anyone noticing. The replay check (above) catches an edit that changes what the game DOES, like a
moved button that makes a recorded tap miss. A purely visual edit emits the same events and
passes it. The assets check is what names that second kind.

How it works (`engine/plugins/takeAssets.ts`):
- **At the Play press** the take stores a fingerprint of every file under the project's
  `runtime/assets`: a 64-bit slice of each file's SHA-256, keyed by its path in that folder. Court's
  folder is about 1,400 files and 50 MB, and hashing it took about 0.3 s.
- **After the render** the CLI fingerprints the folder again and compares only the files this take
  used: the **GUID closure** of the scenes the render loaded (`takeSceneUrls`).
  - **Which scenes:** the scene the take booted, read before the frame loop, plus every
    `@scene-loaded` path and every `@scene-swapped` `to`. Two traps:
    - The page's current scene after the last frame is wherever the take *ended*. The first cut
      read that, so a sling take that won level 1 was checked against level 2 only.
    - A level change emits `@scene-swapped`, not `@scene-loaded`. The first cut listened for the
      wrong one, and a unit test that passed the URLs by hand could not see it (#1509 review).
  - **What each scene pulls in:** every JSON asset's GUID references, followed transitively (scene
    → prefab → material → texture), and each asset's `.meta.json` sidecar, because a texture's
    import settings change how it looks. A sidecar's sub-asset `guid`s (a sliced sprite's frames)
    resolve to the sheet beside it.
  - **It errs toward reporting too much.** The closure follows *every* GUID, so a level that names
    the next one (sling's `nextScene`) pulls that level in, whether or not the take got there. An
    edit to a scene nothing in the take references is not reported.
- **The verdict** is `render.json` → `assets`:
  - `unchanged`, with how many files it `checked`;
  - `changed`, listing `changed` (different bytes) and `added` (a file created since the take that
    the scenes now use);
  - `unchecked`, for a take recorded before #1509 or one whose fingerprint failed.

  A `changed` verdict is also printed by the CLI and shown on the progress card.
- **It never fails a render.** The check runs after every frame is captured and before the encode,
  so anything that goes wrong reads `unchecked` with the reason, including a malformed URL or a
  folder that cannot be listed. One file that cannot be read (the atomic writers rename
  `<file>.tmp` inside this folder; on Windows a scanner can hold a file) is fingerprinted as
  `unreadable` and left out of the comparison on either side. It is not dropped: a file missing
  from the take's fingerprint reads as new, and the first fix reported exactly that false `(new)`
  (#1509 review 2).
- **A project with no `runtime/assets` of its own gets no fingerprint.** An editor on a bare
  `npm run dev` has the repo root as its project. Fingerprinting that folder is an error rather
  than an empty map, which would have listed every asset the take uses as new. Its takes carry no
  fingerprint, and their renders read `unchecked`.

**Not covered:**
- game CODE, and `project.config.json`;
- the engine's own assets (`/modoki/assets`);
- an asset reached only through a GUID written in code. The build cannot see that one either
  (CLAUDE.md § Single source of truth, #53).

A file the scene still references but that no longer exists is not reported here: that is a
broken reference, and the scene load reports it.

## Gotchas

- ⚠️ **Capture mode is on while you PLAY the take, not only while it renders.** A game hides capture
  chrome in it, and hiding chrome can move the layout: Court's and Weaveling's banner strips give
  their height back to the board. If only the render hid it, every recorded position would be off
  by the strip. So what you play is exactly what gets rendered.

  The two phases differ in one respect only: engine debug surfaces (error toasts) stay up while you
  record, because you're watching, and hide while rendering (`getCaptureMode()`).
- **An odd output dimension is padded by a pixel.** H.264 in 4:2:0 needs even dimensions and ProRes
  4:2:2 an even width, so a 375×667 preset at ×1 failed to encode ("width not divisible by 2"). The
  CLI pads (`pad=ceil(iw/2)*2…`), and `outputSize` reports the padded size in the dialog.
- **A `--watch-stdin` render must stop reading stdin when it finishes.** The watch keeps the event
  loop alive, and the parent holds stdin open until the child exits. The first cut deadlocked there:
  the render finished and never exited. The CLI destroys stdin after `done` and flushes its last
  progress line before exiting (a macOS pipe's writes are async, so a bare `process.exit` can drop
  it).
- **The dialog subscribes on the HMR epoch.** A hot update re-instantiates `takeRecorder` and
  `renderFlow`, and Fast Refresh does not re-run a `[]` effect. After an edit to `take.ts`, Stop
  saved the take and opened nothing, because the new recorder's take-saved event had no subscriber.
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
  and that is where a replay can diverge. The replay check (above) catches it automatically.
  A scene saved between Stop and the render is used as it is now. The replay check catches that
  when it changes what the game emits, and the assets check names it either way (§ Assets changed
  since the take).
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
  - an MCP wrapper. It should start and poll the same backend job (`/api/record/render`), so the
    editor and agents share one render path; `routeCoverage.test.ts` lists those routes as an agent gap;
  - an end-to-end spec. The recorder needs an active game, and the e2e suite plays fixture scenes
    that belong to none (`[takeRecorder] not recording: no game is active`), so the dialog flow was
    verified against the live editor instead;
  - suppressing mid-take interstitials.

## Related

- [plans/ad-video-pipeline-plan.md](./plans/ad-video-pipeline-plan.md): the pipeline this is Phases 0–1 of, and why capture has to come from the compositor
- [verification-harness.md](./verification-harness.md): the manual clock, seeded RNG and event journal this builds on
- [video.md](./video.md): why video and audio are never frame-stepped
- [editor.md](./editor.md): the Game view
