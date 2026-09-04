# Audio Integration Plan

Status: **Phases 1–4 shipped** (`verify` green) — runtime audio subsystem +
editor authoring (Audio Inspector) + the ffmpeg converter + mix helpers + the
**declarative control layer** (engine-reconciled `AudioSource` + built-in `audio.*`
actions), plus a fully-declarative demo game (`games/audio-demo`) and a Unity-style
editor **Mute Audio** toggle, plus an **iOS `AVAudioSession` category**, tried and abandoned
(#548 — **closed won't-do**: device-tested, shown not to work, and the only remaining path is a
native audio backend the owner judged not worth the effort; its auto-ducking half was removed
after device testing, and the plugin itself was removed once the category was shown inert — see
below). Only the **native backend** (deferred by design) and a couple of small polish items
remain. Owner: solo.

## Decisions (settled)

- **Engine-native, on the Web Audio API — no library.** Not Howler: it owns its
  own loading/caching/state, which fights the GUID + scene-scoped refcounted
  resource pipeline, the deterministic/headless harness, and the 2D/3D split.
- **THREE-free.** Built on raw Web Audio nodes (not `THREE.Audio`): explicit
  per-bus `GainNode` routing and ECS-driven listener/panner positions are more
  direct, and the subsystem carries **zero Three dependency** — a pure-2D game
  that drops 3D rendering drops nothing here.
- **The journal is NOT the audio transport — but audio does REPORT into it.**
  These are two directions and only one of them was ever forbidden. The journal is
  the verification/debug OUTPUT trace and can be disabled in shipped builds
  (`setJournalEnabled(false)`), so routing *playback* through it would silently mute
  the game; audio is therefore driven by **traits + a dedicated cue bus + direct
  service calls**. Observation runs the other way: `audioSystem` emits an **`@audio`**
  event for every voice lifecycle transition (#289), so audio is assertable from the
  same trace as `@zone`/`@sequence` — and if journaling is off, the game still sounds
  exactly the same, it is only unobservable. See "`@audio` — the assertion surface" below.
- **Native (`@capacitor-community/native-audio`) deferred** — a swappable backend
  behind the same service, only if device latency is measured as bad. All targets
  (web + iOS + Android) are WebView/browser, so Web Audio covers 100% today.
- **Format policy:** runtime is **format-agnostic** (hands whatever the manifest
  resolves to `decodeAudioData` / `<audio>`); the Phase 3 converter will **default
  to MP3** but not enforce it. See the codec table below.

## Codec support & conversion (informs Phase 3)

**iOS (WKWebView) is the gate; Android (Chromium) decodes ~everything.**

| Codec / container | Android | iOS |
|---|---|---|
| MP3 | ✅ | ✅ universal |
| AAC / .m4a (MP4) | ✅ | ✅ hardware-decoded |
| WAV / PCM · FLAC | ✅ | ✅ |
| Opus in Ogg | ✅ | ⚠️ iOS 18.4+ only |
| Opus in MP4 · Ogg Vorbis · WebM | ✅ | ❌ |

- **Cross-platform-safe (all iOS):** MP3, AAC/M4A, WAV, FLAC.
- **License:** AAC is **not** royalty-free (Via LA pool; ffmpeg AAC *encoding* is a
  patent grey area). License-free: **MP3** (patents expired 2017), FLAC, WAV,
  Opus/Vorbis. → **converter default = MP3** (license-free + universal).
- **Load Type** (Unity Decompress-On-Load / Streaming) forks the runtime path:
  `buffer` = `decodeAudioData` → PCM in the refcounted cache (short SFX); `stream`
  = `HTMLMediaElement` → `MediaElementAudioSourceNode` (long music, tiny memory).

---

## Phase 1 — Runtime audio ✅ SHIPPED

Commits `f617f99` (subsystem) + `e479b49` (review fixes). `npm run verify` green
(typecheck + lint + app + engine tests, determinism guard included).

**Architecture**
```
game logic / traits ─┐
AudioSource trait  ──┤─► audioSystem (SYSTEM_PRIORITY.AUDIO=250, app-pipeline only)
AudioListener trait ─┘        │
        audio cue bus ────────┤─► audioService ─► Web Audio graph
   (cueSound/cueClip; NOT the journal)   (4 bus gains → master → mute → destination)
```

- **Traits** — `AudioSource` (`clip` GUID, `bus` master/music/sfx/ui, `volume`,
  `pitch`, `loop`, `autoplay`, `playOnCue`, `spatial` + distance fields, runtime
  `playing`) and `AudioListener` (`enabled`, on the camera). Editor metadata
  registered in `registerTraits.ts` (`componentCategory: 'Audio'`).
- **`audioSystem`** — presentation tier (250, ≥ TRANSFORM so it runs while
  paused). App-pipeline only, never in `createTestWorld`, so headless stays
  deterministic. Reconciles sources, autoplay-once, drains cues, updates
  listener/panner from each entity's **local** Transform. No wall-clock/random. Also
  the sole emitter of **`@audio`** — it is the only layer that knows which ENTITY a
  voice belongs to, and it behaves identically headless and live (`audioService` is
  a backend that is fully no-op'd in record mode, so an event emitted there would be
  describing the mock rather than the game).
- **`audioService`** (`runtime/audio/`) — raw Web Audio graph, buffer + stream
  playback paths, global mute gain (`setAudioMuted`). Headless → **record mode**
  (`getAudioLog()`) so tests assert *what would play* with no journal dependency.
- **Cue bus** (`audioCues.ts`) — `cueSound(name)` / `cueClip(guid, opts)`,
  per-world queue drained each frame. The "emit an event, audio reacts" channel.
  A one-shot clip cue whose buffer isn't decoded YET is **retried for a bounded window**
  (`audioSystem` `pendingCues`, ~120 frames), not dropped — on iOS the eager decode
  completes only after the first-gesture resume, and the first shot's cue fires on that
  same gesture, so without the retry it would be silently lost.
- **`audio` is a first-class asset type end-to-end** — `BINARY_EXT_TYPE`,
  `AssetType`, `SceneResourceRef`, `REF_FIELDS_BY_TRAIT` (`AudioSource.clip`),
  `SCALAR_RESOURCE_TYPE_BY_FIELD`, `SceneManager.acquireResource` (preload buffer /
  own-only stream), and a scene-scoped refcounted `audioBufferCache` wired into
  `releaseAllForScene` + `disposeAllCachedResources`. `loadType` lives in the
  clip's `.meta.json` (read via `getAudioLoadType`, default `buffer`).
- **App wiring** — `App.tsx` calls `useAudioResumeRearm()`
  (`engine/app/useAudioResumeRearm.ts`), which keeps a persistent gesture listener
  (pointerdown/touchstart/keydown) and re-arms on foreground (`visibilitychange`,
  native `appStateChange`) to resume the context, disposing on teardown; a single
  first-gesture resume isn't enough because an iOS audio-session interruption
  (e.g. a Music.app takeover) can suspend the context long after it (#489). The
  old oscillator `services/audio.ts` is deleted.
  **Device-verified** (owner, iPhone 8 / iOS 16.7.16, 2026-09-01): play Music.app,
  stop it, foreground Court — audio returns with **no relaunch**. Re-test that way;
  no simulator or headless test reproduces an audio-session interruption, so this
  path's only real evidence is a phone.
- **Tests** — `tests/runtime/audioSystem.test.ts` (record mode: autoplay, cues,
  play-state gating, scene-swap teardown, Transform-less sources) + buffer-cache
  refcount tests.

> **Update:** spatialization now reads each entity's **world** position (below), not
> its local Transform — the panner/listener follow parented sources correctly.

**Adversarial review fixes** (multi-agent, 4 confirmed of 13): scene-swap audio
leak → `stopWorldAudio(old)` on `onWorldSwap`; streaming autoplay muted after
unlock → `resume()` retries paused media elements; non-spatial audio required a
Transform → Transform now optional.

## Shipped extras ✅

- **`games/audio-demo`** (`35ad1b8`, `3de0d91`) — a music player + SFX board:
  4 CC0 tracks (freePD loops) with a selector, Pause/Resume (music-bus mute) +
  Stop, and 4 SFX one-shot buttons. All CC0 MP3 (freePD + Kenney UI Audio). The
  player drives the low-level `audioPlay` API (traits are autoplay-only), with a
  carrier system at the AUDIO tier that hard-stops music whenever `!isSimRunning()`.
  Verified live in the Electron editor via MCP.
- **Editor "Mute Audio" toggle** (`40b99ae`) — a 🔊/🔇 button in the GameView
  transport toolbar (next to the collider overlay), backed by a dedicated mute
  `GainNode` in `audioService` (`setAudioMuted`/`isAudioMuted`) so it silences
  everything without touching bus/source volumes.

## Phase 2 — Editor authoring ✅ SHIPPED

Commit `25f3b2f`.

- **AudioSource Inspector** — auto-generated from the FieldHints (`componentCategory: 'Audio'`).
- **`AudioAssetView`** (`editor/panels/assetViews/AudioAssetView.tsx`, mirrors
  `TextureAssetView`) — a decoded **waveform** + a native `<audio controls>` for
  play/stop/scrub, a settings form (**loadType** buffer/stream, **format**,
  **bitrate**, **force-mono**, **normalize**, **trim-silence**), an **Apply →
  reimport** button, and post-conversion stats (ext/duration/channels/rate/size)
  read back from the `.meta.json` `audioCache`. Wired into the Inspector dispatch
  + `assetTypeFromPath`. Settings persist to the sidecar on change (like textures).
- **MCP** — *skipped by design.* `modoki_asset_schema` authors JSON documents
  (`.mat.json`/`.particle.json`); audio has no such doc — its settings live in the
  `.meta.json`, edited via the inspector/reimport. The agent-facing surface already
  exists: `modoki_list_assets` (type `audio`), `modoki_get_asset_meta` (the `audio`
  block), `modoki_reimport_asset` (convert).

## Phase 3 — Converter + mix ✅ SHIPPED

Commits `25f3b2f` + `633abcf` (review fixes).

- **Audio converter** — `plugins/audio-convert.ts` (ffmpeg) + `audio-cache.ts`
  (content cache) + `reimport-audio.ts` (handler), registered in `reimport-registry`
  via the dev scanner AND Electron main. Transcode (default **MP3**; AAC/Opus/WAV/
  FLAC selectable), mono downmix, `loudnorm`, trim silence. Content-hash-cached on
  source bytes + settings + `AUDIO_ENCODER_VERSION` — **`loadType` is excluded from
  the hash** (it forks the runtime path, not the bytes). Settings + `AudioCacheInfo`
  live in the `.meta.json` `audio`/`audioCache` blocks; `audioSettings.ts` is the
  shared source of truth (like `textureSettings.ts`).
- **Re-importing a clip evicts the decoded buffer — and for a long time it did not.**
  `invalidateAudio(ref)` accepts a **path as well as a guid**; it used to resolve every ref
  through the manifest, and `resolveRef` rejects an internal asset path, so its one caller
  (the Audio Inspector's Apply button, which passes the path) evicted nothing and the game
  kept playing the pre-conversion buffer until an editor restart. The batch/agent re-import
  paths did not call it at all. Both fixed in #304's close-out; the chain and the shared
  event behind it are in [editor.md](editor.md) § "The asset Inspector" (rule 3, the preview keyed on the PATH).

- **Pipeline parity with textures** — the scanner bakes the `audio` block (loadType
  always; format+ext once converted) into the manifest, serves the `~audio.<ext>`
  variant (dev on-demand self-heal in `staticAssets.ts` + build drop-source), and
  the runtime resolver (`servedAudioUrl`) targets it with a **prod-only** `?v=<hash>`
  cache-bust (`withCacheBust`). Buffer decode AND streaming both resolve through it,
  so a dropped-source prod build still loads. The strict conversion-fallback gate +
  dist-file verifier cover audio (an ffmpeg failure fails the build unless
  `MODOKI_ALLOW_ASSET_FALLBACK=1`, which then correctly ships + advertises source).
- **Mix helper** (`audioService.ts`) — handle `fade()` + `crossfade` (used by the
  trait-driven `crossfadeSec` clip swap in `audioSystem.ts`); AudioParam ramps (no
  wall-clock, determinism-guard-safe). Exported as `crossfadeAudio`. The broader mix
  API (bus fades, ducking, mix snapshots — `fadeBusVolume`/`duckBus`/`captureBusMix`/
  `restoreBusMix`) was **frozen** and removed: it had no consumer beyond its own test.
  `setBusVolume` (used by the demo's mixer sliders) stays.
  **Update (#548):** a scoped helper (`setAudioMusicDucked`, a dedicated duck node) briefly
  reintroduced part of this frozen space, then was removed again when device testing showed
  the ducking it powered does not work — see "iOS audio session" below. The freeze holds again
  for the whole API: no `fadeBusVolume`, no `duckBus`, no `captureBusMix`/`restoreBusMix`.
- **Tests** — `tests/plugins/audioConvert.test.ts` (ffmpeg flag vectors),
  `audioCache.test.ts` (hash stability, loadType-invariant), `tests/runtime/
  audioMix.test.ts` (settings resolve, format mappings, `setBusVolume` record-mode
  logging, converted-variant URL resolution).

## Phase 4 — Declarative control layer ✅ SHIPPED

Commits `3aaa870` + `c566e3a` (review fixes). Motivation: audio playback/control
should NOT be hand-driven in a game's `setup.ts` (that's asset management leaking
into game code). It's now engine-owned, so games author audio as **scene entities +
trait fields controlled by built-in actions** — and every game gets it for free.

- **`audioSystem` fully reconciles each `AudioSource`** from its trait fields (was
  autoplay-only): `autoplay` sets `playing` once; `playing` is the control input
  (true → start/resume, false → pause with the handle + position kept); a `clip`
  change swaps — **crossfading over `crossfadeSec`** (new trait field) or hard-cutting;
  `volume`/`pitch`/spatial position apply live. A hard **stop** is the imperative
  `stopEntityAudio` (backs `audio.stop`) — it does NOT clear the autoplay guard, so
  an in-Play Stop sticks instead of re-firing autoplay next frame.
- **`AudioHandle` grew `pause`/`resume`/`setPitch`/`stopAfter`.** `pause()` truly
  pauses a stream (mutes a buffer, which can't seek) and sets a `deliberatelyPaused`
  flag so the gesture-unlock `resumeMedia()` can't un-pause it. `stopAfter(sec)`
  schedules a stop on the **audio clock** (a silent `ConstantSourceNode` timer) —
  used to reap a crossfade tail reliably even during a time-stop (`timeScale 0`),
  where an engine-delta reaper would stall (`getVisualDelta` is 0). The `fadingOut`
  list now only force-stops tails on Stop/scene-swap + sweeps ended handles.
- **Built-in `audio.*` UIActions** (`runtime/actions/audioControls.ts`,
  `registerAudioControls()` wired in `app/ecs/register.ts` alongside
  `registerEngineActions`): `audio.play` / `pause` / `toggle` / `stop` / `setClip` /
  `toggleCrossfade` (flips `crossfadeSec` 0↔N) / `setBusVolume` / `playOneShot`.
  Entity-targeting actions mutate the binding's `target` `AudioSource` and
  `markUIDirty()` so highlight bindings (crossfade on/off) + the Inspector reflect
  the change that frame.
- **Mixer store hook** — a Zustand store exposing `audioMaster`/`audioMusic`/`audioSfx`/
  `audioUi` (0..100) + `…Pct` label strings via `addStoreHook`, because a slider's
  `inputBinding` reads `storeState` ONLY (not read-sources). Lets sliders resolve bus
  volumes with **no per-game store**; `audio.setBusVolume` updates the store + the bus.
- **`games/audio-demo` is now fully declarative** — a **Music `AudioSource` entity**
  in the Hierarchy (autoplay/loop), track buttons → `audio.setClip`, transport →
  `audio.toggle`/`audio.stop`, crossfade toggle → `audio.toggleCrossfade` with a
  `UIBinding` highlight watching `crossfadeSec`, sliders → `audio.setBusVolume`, SFX →
  `audio.playOneShot`. **`setup.ts` is empty no-ops; the per-game `mixStore` is
  deleted.** No game code, no `AudioDemoManager` — the logic went into the engine.
- **`AudioSource.playlist` WALKS that bank** (2026-08-28) — `'off'` (default, unchanged
  behaviour) | `'sequential'` | `'shuffle'`. Until this, nothing walked the bank at all: a
  source plays the ONE guid in `clip`, so a twelve-track bank shipped twelve tracks and played
  the first, and every game wanting background music wrote the same loop (games/court did,
  for half a day, before this replaced it).
  - ⚠️ **TWO triggers, and the second is not optional.** The cross-fade trigger fires BEFORE the
    clip ends — `remainingSec <= crossfadeSec` — because waiting for the end is too late: by then
    there is no live voice left to fade OUT, so there is nothing to cross-fade and the next clip
    starts at full volume against silence. So the AUTHORED crossfade decides both how long the
    blend is and when it starts, one number with no second knob to keep in step.
    But that is a WINDOW that must be observed on a frame, and it can be missed:
    - at the trait default **`crossfadeSec: 0` the window is the single instant
      `remaining === 0`**, which a 60 Hz tick essentially never samples;
    - even at 1.5 s, anything that stops rAF across a clip boundary — a phone backgrounding the
      app, a long asset hitch — steps straight over it.

    Missing it used to be **permanent**: the finished source set `playing = false`, the playlist
    block is gated on `playing`, and `autoplayed` already held the id so autoplay could not
    re-fire. One missed window ended the music for the session, with `playing: false` in the
    Inspector and no warning. So a clip that HAS ended now advances unconditionally — no
    threshold, no latch — and a non-playlist source still falls silent as it always did.
    Pinned by `audioPlaylistSystem.test.ts` at `crossfadeSec` 0 **and** 1.5.
  - Needed `AudioHandle.remainingSec()`: a media element has a real playhead (`currentTime`),
    a buffer node exposes none, so its position comes off the AUDIO clock — the same clock the
    fade ramps run on, so the two agree.
  - ⚠️ **A playlist source must not `loop`.** A looping clip never runs out, and
    `remainingSec()` returns `null` for one precisely so nothing mistakes it for a clip about
    to end. `audioSystem` warns ONCE when both are set, because the bank looks perfectly valid
    in the Inspector and nothing else would ever say why only clip one plays.
  - ⚠️ **`null` means "not knowable yet", never 0** — a stream reports it until metadata loads,
    and record mode has no audio clock. Read as 0 it swaps on the first frame of every clip.
  - ⚠️ **The in-flight latch clears on the remaining time climbing back, never on `clip`
    matching what was asked for.** The system writes that field itself, so it matches on the
    very next frame while the engine is still winding up the new voice and the handle still
    reports the OLD clip's remainder — below the threshold. Comparing the clip made the latch a
    no-op and the playlist tore through the bank in a handful of frames.
  - **`'shuffle'` still opens on the authored `clip`.** `buildOrder` rotates the shuffled order so
    the current clip is at the front — right for a hot reload, which must not restart the music —
    so a cold boot always begins with whatever the scene authored and only the ORDER AFTER it
    varies. Deliberate (the scene picks the opener), but it is not what "shuffle" implies; making
    the first track random too is a one-line change to `buildOrder`.
  - The shuffle is the ONE entry in the determinism guard's `ALLOW_RANDOM`. Cosmetic by
    construction — a playlist order reaches no game state, journal event or replay — and routing
    it through the seeded RNG would be actively WRONG: it would consume the stream gameplay
    draws from, so which track plays would change which level is generated.
  - `runtime/audio/playlist.ts` · `engine/tests/framework/audioPlaylist.test.ts`.
- **`ui.click` — a built-in button-click cue** (2026-08-28). `applyBindings` raises it once per
  bound `click`; a game opts in by authoring ONE `AudioSource` with `playOnCue: 'ui.click'`, and
  a game that authors none hears nothing.
  - ⚠️ It lives at the BINDING layer because **a game cannot see every button**. Court put its
    click on its own chrome dispatcher and the settings panel stayed silent — those rows open and
    close through plain `set` bindings authored in the scene, so no game code runs there at all.
    Any per-button fix is a list somebody maintains, and it goes stale on the first button added.
  - `runtime/ui/` may not import `runtime/audio/` (both L2), so it is **inverted by
    registration**: `registerAudioControls` installs it via `setUIClickCue`, the same shape as
    `setAudioWorldPositionResolver`. Unregistered → silent.
  - Only `'click'`: `change` fires continuously during a slider drag, `submit` is a keystroke.
- **An interactive control swallows its own click** (2026-08-28) — `range` and text `input` stop
  propagation, as the toggle branch always did. Without it a slider inside the canonical
  dismiss-on-backdrop panel closes that panel on every adjustment, which is exactly what Court's
  volume sliders did. `engine/tests/ui/uiInteractiveClickIsolation.test.tsx` pins it, with a plain
  `div` as the control that still DOES reach the backdrop.
- **Named clip bank on `AudioSource`** (`AudioSource.clips` — a **JSON-string**
  `[{"key","ref"}]`) — a source owns several playable sounds keyed by a **stable
  string** (Unity's "AudioSource + array of AudioClips indexed by name").
  `audio.setClip { key }` / `audio.playOneShot { key }` resolve the key against the
  **target's** bank, so UI holds a key, not a GUID. The resource collector parses the
  string and collects each `ref` (`loadSceneFile.ts`), so every banked clip **ships +
  survives an editor save** — replacing the fragile "clip GUID buried in
  `UIAction.params`" pattern the collector never scanned (a save regenerating
  `resources[]` silently dropped those clips).
  - **Why a JSON string, not an inline `{key,ref}[]` array**: a non-scalar trait
    field is a known bug source (opaque to serialize / prefab-diff / undo, must be
    deep-cloned at every boundary — see `traitScalarFields.test.ts`). A JSON-string
    SCALAR — exactly like `Collider2D.points` — sidesteps that whole class (copied
    verbatim everywhere), so `AudioSource` stays a plain SoA trait with no allowlist
    entry. Decoded via a single guarded helper `parseClipBank` (`runtime/audio/
    clipBank.ts`, `[]` on malformed, never throws), never `JSON.parse` inline.
  - Demo track/SFX buttons pass keys, with a dedicated **`SFXBank` `AudioSource`**
    (never persistently plays) owning the SFX. A custom **Inspector section**
    (`AudioSourceClips`) edits the bank as key + audio-ref rows (parse→edit→
    re-stringify). Tests: `clipBank.test.ts` (codec), `collectResourceRefs.test.ts`
    (refs parsed + collected), `audioDeclarative.test.ts` (key resolution).
  - Bonus fix found en route: `snapshotAddedTraits` (prefab.ts) used the curated
    `meta.fields` fallback for AoS traits, silently dropping non-scalar fields
    (`SkinnedMeshRenderer.materials`, `AnimationLibrary.animSets`) on user-**added**
    prefab children — now matches serialize's live-data-key fallback (regression test
    in `captureInstanceStructure.test.ts`).
- **Tests** — `tests/runtime/audioDeclarative.test.ts`: reconcile gating (playing
  vs autoplay), the Stop-sticks-on-autoplay regression, hard-cut + crossfade clip
  swaps, key-based bank resolution, and every built-in action (record mode).

## `@audio` — the assertion surface (#289)

Until this landed, audio was the **one subsystem a test or QA case could not assert
on**. There was no `@audio.*` event anywhere (`grep -rn "emit(" runtime/audio/*.ts`
returned nothing), so the pattern every other subsystem uses — assert on the journal
trace — was simply unavailable, and cases had to pivot to trait state plus the record
log. That log can prove a voice *started* and, until the fix below, nothing else.

**The event.** `audioSystem` emits `@audio` on every voice lifecycle transition:

| `phase` | when |
|---|---|
| `start` | a source began a clip, or a cue one-shot fired |
| `swap` | a playing source changed clip (carries `crossfadeSec` when crossfaded) |
| `pause` | `playing` went false — handle retained, position kept |
| `resume` | `playing` went true again on a paused handle |
| `stop` | handle torn down; `reason` names which path |
| `end` | a non-looping source finished on its own and was reaped |
| `dropped` | a one-shot cue given up on — `reason` is `decode-timeout` (aged out of `pendingCues`) or `retry-overflow` (arrived with the retry list already at `MAX_PENDING_CUES`). `warn` |
| `unresolved` | an entity source whose clip will not resolve. `warn` |

Payload: `{ phase, entity?, clip, bus, loop, spatial, crossfadeSec?, reason? }`.
`entity` is `entityRef` (the stable GUID, so a trace survives a scene hot-reload) and
is **omitted for a fire-and-forget cue one-shot**, which has no owning entity by
design — that absence is the signal, not a gap. `reason` distinguishes the four
teardown paths (`entity-stop` · `entity-gone` · `not-playing` · `world-teardown`),
which are otherwise indistinguishable from outside.

**`@audio` vs the Timeline's `@cue` — they are a PAIR, not a duplicate.** Timeline's
audio track (`timelineSystem.ts`'s `applyDirectorFrame`, `'audio'` case) calls `cueClip(...)`
and then emits `@cue`, which records that the Director *asked* for a sound at that beat.
`@audio` records whether a voice actually *started*. So a Timeline audio beat normally
produces `@cue` followed by `@audio {phase:'start'}` — and the diagnostic case is when the
first appears without the second, which is precisely "the cutscene called for a sound
and none played". Do not read the two events as double-counting one thing.

**A crossfade TAIL is a voice and is traced as one.** When a swap crossfades, the
outgoing handle moves to `fadingOut` and is reaped later (on its own audio-clock
`stopAfter`, or force-stopped at teardown). It stays audible throughout, so it emits
its own `end`/`stop` — `fadingOut` holds `{handle, clip}` rather than a bare handle
precisely so the tail's teardown can name the clip it belonged to. Omitting it left
`start`+`swap` and `stop`+`end` unbalanced by exactly one per crossfade, which is the
arithmetic a voice-count measurement depends on.

**`unresolved` exists because that retry is UNBOUNDED.** A cue that will not decode
ages out after `ONE_SHOT_RETRY_FRAMES` and emits `dropped`; an *entity source* whose
clip will not resolve is retried by `startOrSwap` every frame forever, with `playing`
left true. Without an event, that entity is indistinguishable in the trace from one
that never tried to play — which is exactly the broken-asset-ref case a QA case most
wants to catch. It is emitted **once per (entity, clip)**, re-arming when the clip
changes, because per-frame would be 60 events/sec.

⚠️ **`unresolved` and both `dropped` reasons are only reachable with a real decoder
present.** In record mode `hasAudioSupport()` is false, so `resolveSpec` never returns
null and these paths cannot fire — a headless test asserting on them needs the
`hasAudioSupport → true` mock in `tests/runtime/audioCueRetry.test.ts`, which is why
those cases live in that file rather than beside the rest of the `@audio` tests.

**Journal volume.** `@audio` is a Tier-1 (always-recorded) type, not gated behind
`setVerboseCapture` the way `@contact` is, because it fires on lifecycle
*transitions* rather than per frame — the same shape as `@zone`/`@collision`. The
caveat: a game that cues a sound every frame would emit ~60/s and wrap the 10,000-event
ring in **~167 s**, evicting other subsystems' events. Nothing in the repo does that
today; if something starts to, `@audio` is the candidate to move into `VERBOSE_TYPES`.

**Why `audioSystem` and not `audioService`.** The service is a Web Audio backend that
knows nothing about entities and is fully no-op'd in record mode; the system is where
playback intent is decided. Emitting from the backend would name no entity and, in the
headless harness (which has no AudioContext at all), would be describing the mock
rather than the game.

**Record-mode `stop()` is now real.** `RECORDING_HANDLE` used to be a shared singleton
with `ended: false` hardcoded and a no-op `stop()`. That broke observability twice:
the known half is that `getAudioLog()` could never prove a teardown, so any lifetime
assertion silently passed. The half nobody had noticed is that because *every*
headless source shared one object, `audioSystem`'s per-source reap check
(`if (src.handle.ended)`) was answered by a process-wide constant rather than by the
source it was asked about — two handles could not differ. It is now one
`RecordingHandle` per `play()`, flipping its own `ended` and logging `{op:'stop', clip}`.

**Known limit, deliberately not fixed:** record mode has no audio clock, so
`stopAfter()` cannot self-fire. A crossfade tail is reaped at `stopWorldAudio`
(teardown) instead of after `seconds`. Noted at the call site so a headless test does
not read the surviving tail as a leak.

## The sfx voice cap (owner policy, 2026-08-21)

The mixer used to be **uncapped**: every `cueSound`/`cueClip` minted an independent
`AudioBufferSourceNode` with no limit and no stealing policy. That was an accident
rather than a choice, and it had teeth — the graph has no `DynamicsCompressorNode`, so
stacked voices do not get louder, they **hard-clip**. The stacking shape that bites is
`cueSound(name)` fanning out to every matching `AudioSource`: identical clips started
on the same frame are phase-coherent and sum **linearly**, ~+20 dB at ten copies, not
by √N. Separately, every spatial voice builds an HRTF `PannerNode`, so a hundred
concurrent one-shots is a CPU problem before it is a loudness one.

**The policy, and the four decisions in it:**

| | |
|---|---|
| **Limit** | `AudioSettings.sfxVoiceLimit`, **default 4** |
| **Steal ramp** | `AudioSettings.sfxStealFadeSec`, **default 10 ms** (`0` = hard cut) |
| **Stealing** | **oldest first** — insertion order is age order, so the victim is `shift()`, not a search |
| **Scope** | fire-and-forget one-shots on the **`sfx` bus only** |
| **Exempt** | music · the `ui` bus · every entity-owned `AudioSource` |

**The number is AUTHORED, not a constant.** It lives on the `AudioSettings` resource
trait, live-editable in the Inspector, because its right value is only knowable after
hearing it — too low and a busy moment eats sounds the designer wanted, too high and
the mix clips. `AUDIO_SETTINGS_DEFAULT_LIMIT` is the trait's own default re-exported
for the no-`AudioSettings`-in-scene fallback, so there is exactly one copy of the
number. **`<= 0` means uncapped**, not "silence the sfx bus" — the escape hatch for a
game that would rather have the old behaviour than lose a shot.

**Why each exemption exists** — these are the policy, not omissions:

- **Music is never capped.** It is on its own bus and sustained by design.
- **Entity-owned `AudioSource` voices are never stolen, even on the `sfx` bus.** This
  is the one that is easy to get wrong: a looping campfire crackle is the OLDEST voice
  essentially forever, so naive oldest-first would kill it the instant four one-shots
  fired, permanently. The cap is for *disposable* sounds; an entity source is something
  the game deliberately keeps alive.
  ⚠️ **This exemption is STRUCTURAL, not a guard** — there is no `if (entity-owned) skip`
  to delete. `state.oneShots` is written in exactly one place (`playOneShot`), and the
  declarative path (`startOrSwap`) simply never touches it; the two are disjoint call
  paths. So the test covering it is a design-invariant check, not a guard-toggle check,
  and only a structural change — routing `startOrSwap` through `playOneShot` — could
  break it. Worth knowing before trusting a mutation run to have "proved" the exemption.
- **The `ui` bus is uncapped.** UI sounds are user-triggered and inherently low-rate; a
  click going silent because gameplay is busy reads as a broken button — worse than the
  stacking it would prevent. This one extends "keep the music" a level further than the
  owner's words did, so it was put back to them explicitly and **confirmed, 2026-08-21**.
  Unlike the limit it is STRUCTURAL, not an authored field: capping `ui` is a code change.
- **A NAMED cue fan-out is still capped.** `cueSound` plays each matching source as a
  fire-and-forget one-shot with no handle retained on the entity, so it counts like any
  other shot — and it is the single most likely way to blow the cap.

**A steal is a fade, not a hard cut — and its length is AUTHORED too**
(`AudioSettings.sfxStealFadeSec`, default 10 ms). A bare `stop()` is an instant
amplitude discontinuity — an audible click on *every* steal, which would have a cap
meant to protect the mix contributing its own artifact. 10 ms is below the threshold
where a fade reads as a fade, so the sound still stops abruptly to the ear; it just
stops cleanly. Scheduled on the AUDIO clock, so it completes under `timeScale: 0`.
**`0` is a legitimate authored value meaning hard cut**, and schedules no ramp at all
rather than a zero-length one. This started life as a code constant and was moved onto
the trait during close-out for exactly the reason `sfxVoiceLimit` is on it: it is a feel
value, and "one constant to revert if it feels wrong" is the definition of something the
owner should be able to reach without an engine change. **The 10 ms default is
owner-confirmed (2026-08-21)**, not an assumption left standing — the alternatives were
put to them as 0 (audibly clicky) and ~50-100 ms (an audible duck you would hear on every
steal at a limit of 4).

**Record mode logs the ramp** (`op: 'fade'`, carrying the target and `durationSec`).
Without it a steal and a crossfade are both invisible headlessly — the ramp *is* the
behaviour, and a no-op `fade()` cannot tell an authored 250 ms from the 10 ms default,
so a test asserting on the authored value would pass vacuously.

**A stolen voice emits `@audio {phase:'stolen', reason:'voice-cap'}`** — so the cap is
observable rather than a silent disappearance, which is exactly the failure mode a cap
introduces. A stolen shot still emits `start` first: it *did* play, it was cut short.

**`stolen` is that voice's TERMINAL event — it does not also emit `end`.** Every voice
emits exactly one of `stop` / `end` / `stolen`, so `start`+`swap` balances against
`stop`+`end`+`stolen` and a voice count never drifts. The ramping handle is still handed
to `fadingOut` (marked `silent`) rather than orphaned, because dropping the last
reference would remove teardown's ability to force-stop it mid-ramp — the whole reason
`fadingOut` exists — and in record mode, where `stopAfter` cannot fire, nothing would
ever call `stop()` on it. `reapTail` is the single place that decides whether a reaped
tail emits, deliberately shared across all three reap sites: record mode can only reach
one of them, so an inlined copy of that guard was untested and a mutation removing it
stayed green.

**The limit is FLOORED when read.** The Inspector's number box accepts a typed fraction
(`step: 1` only constrains the spinner), and `while (length >= 2.5)` settles at 3 — an
off-by-one effective cap that nothing would report. A voice count is an integer.

**Implementation note:** enforcing this required tracking one-shots at all. Before, the
handle from a one-shot `play()` was discarded outright, so nothing in the engine knew
how many were sounding. `AudioState.oneShots` now holds them oldest-first, swept each
frame by `handle.ended`. In record mode nothing ends on its own, which is what lets a
headless test drive the cap deterministically.

Covered by `packages/modoki/tests/runtime/audioJournal.test.ts`.

## iOS audio session (#548) — WON'T DO (owner, 2026-09-02)

**The problem.** iOS set no `AVAudioSession` category anywhere in this repo, so every Modoki game
inherited the platform default, `.soloAmbient` — which **deactivates** whatever another app (Apple
Music, a podcast) was playing the instant our own audio started. The owner asked for the opposite:
let other apps' audio keep playing alongside ours.

### The session category (plugin since removed)

`.ambient` + `.mixWithOthers` is the category that mixes instead of interrupting.
`engine/packages/capacitor-modoki-audio/` was a standalone Capacitor plugin (SPM, iOS-only, same
pattern as every other plugin in this doc) that set it: `load()` applied the default the instant
the app launched (before any playback), and `configure({category})` let the game override it.
**Every `AVAudioSession` call was do/catch-wrapped and degraded to the OS default rather than
trapping** — a failed category set must not crash the splash screen.

Two categories were exposed, both mixing with other apps: `'ambient'` (default) additionally
silenced our audio when the ring/silent switch was on — what a casual game normally wants —
`'playback'` kept playing through it, for a game whose music is the point. Authored as
`capacitor.audioSessionCategory` in `project.config.json` — a per-game knob, not a code constant,
because whether a game's music should survive Silent Mode is a design call, not an engine
invariant.

**The plugin, the config field, and all its wiring were removed** once the measurements below
showed the category has no observable effect (owner ruling, 2026-09-02 — see "RULING" below): the
package `engine/packages/capacitor-modoki-audio/`, `capacitor.audioSessionCategory` /
`AUDIO_SESSION_CATEGORIES` in `engine/project-config.ts`, its Project Settings field, and every
project's dependency on it. Nothing above is buildable from the current tree — it is recorded here
because the reasoning (and the dead end it documents) is the durable part.

Android has no equivalent and needs none — audio there is 100% WebView (Web Audio), there is
**zero** audio-focus code anywhere in this repo, and Chromium requests audio focus on our behalf
with no handle Modoki holds to duck or release.

### Ducking was removed — measured, not a design preference

#548 originally shipped a second half: auto-ducking the music bus (`setAudioMusicDucked`, a
dedicated `musicDuck` gain node between `buses.music` and `master`) driven by a policy hook
(`useAudioDucking`, `shouldDuckMusic`) reading `AVAudioSession.isOtherAudioPlaying` /
`secondaryAudioShouldBeSilencedHint`. **It was removed entirely (owner, 2026-09-01)** after device
testing showed it does not work:

- **WKWebView keeps its own `AVAudioSession`, separate from the app's** (WebKit bug 167788). A
  Modoki game's audio is Web Audio, so it lives in WebKit's session — which means our own audio
  reads back as "other audio" to the *app's* session, not as ours.
- Measured on **two devices**: iPhone 8 / iOS 16.7.16 (Court) and iPhone Air / iOS 26.6
  (audio-demo). On both, `isOtherAudioPlaying` **and** `secondaryAudioShouldBeSilencedHint`
  reported `true` with nothing else playing, on a fresh launch, and stayed `true` with the
  AudioContext suspended for 6 seconds — the OS was reporting our own (WebKit-owned) session back
  to us as "other audio."
- Consequence: enabling the duck silenced the game's **own** music at launch, permanently — the
  owner heard SFX and no music, with no other app playing anything.

There is no fix pending — the signal this half depended on cannot distinguish "another app is
playing" from "our own WKWebView audio session exists," so there is nothing left to build here
until/unless a different signal is found.

### Not a replacement for #489's re-arm

⚠️ Historical note, kept because the conclusion still holds: `.ambient` was *intended* to change
**whether** another app's audio takes over outright (it did not, see above), and either way it
never changed what happens on a phone call, a Siri invocation, or an alarm — those interrupt the
audio session under **any** category. `useAudioResumeRearm`
(`engine/app/useAudioResumeRearm.ts`) stays load-bearing for those; #548 and #489 are independent
mechanisms.

### Verification — HISTORICAL: what was measured, and why it stopped there

⚠️ **Not executable any more — the plugin and the config field it describes no longer exist.**
Kept because the measurement is the evidence behind the RULING above, not because anything here is
to be re-run.

No headless test or simulator reproduces a real `AVAudioSession` interruption, so the only evidence
was ever a phone. The acceptance test was: start Apple Music, then launch the game; Music should
keep playing with the game's audio alongside it. Measured on the **iPhone Air / iOS 26.6**:
launching the app **still stopped** Music.app's playback. Re-applying the category at runtime,
after WebKit's own session already existed, did not change it either (next section). That is what
closed the issue.

### RULING: won't do (owner, 2026-09-02)

Letting other apps' music keep playing **is not being pursued**. The estimate for the only path that
could work — moving audio out of the WebView into a native backend — is ~2-4 weeks: a custom plugin
on both platforms (`@capacitor-community/native-audio` covers none of buses, spatial, crossfade or
pitch), Android audio-focus handling that does not exist yet, GUID→on-disk asset plumbing, and TWO
backends maintained forever since web and the editor still need Web Audio. Weighed against a
nice-to-have for a puzzle game, the owner declined.

⚠️ **Do not reopen this by setting an `AVAudioSession` category.** Every app-side variant has been
tried and measured — see below. If it is ever revisited, start with the one-hour spike: build a game
with ALL audio disabled and launch it with Music.app playing. If Music survives, WebView audio is
what takes the session and a native backend would fix it; if Music dies anyway, the WebView's mere
presence takes it and a native backend buys nothing. That spike gates the whole feature and has not
been run.

### The obvious fix is TESTED and DEAD — it is not a timing problem (owner, 2026-09-02)

The natural theory was that WebKit establishes its own media session when playback begins and
overrides whatever we set at `load()`, so the category simply had to be applied LATER. That was
tested directly on Court, iPhone Air / iOS 26.6: with the game's audio already playing (so WebKit's
session definitely existed), `ModokiAudio.configure({category:'ambient'})` was re-applied at runtime
— it succeeded in 7ms and did not disturb our own playback. Then Music.app was started and the game
foregrounded. **Music.app still stopped.**

So re-applying after the fact does not win either, and this is NOT a matter of ordering. Nor is it a
"bug to work around": WKWebView owns its own audio session and does not take the app's category
(WebKit 167788), so **no `AVAudioSession` configuration from the app side can make WebView audio
mix** — which also means a third-party session plugin (e.g. Capawesome's) cannot help, since it does
the same thing this one does.

⚠️ **The only remaining path is architectural: move audio OUT of the WebView.** A native audio
backend (`@capacitor-community/native-audio`) puts playback in a session the category actually
governs. That backend is currently deferred by design — see this file's own note that "all targets
(web + iOS + Android) are WebView/browser, so Web Audio covers 100% today". #548 is the first
concrete reason to revisit that trade, and it is a large change, not a fix.

What is observed instead today, and must not be mistaken for a ducking regression: starting
Music.app suspends the game's `AudioContext` (the ordinary #489 interruption), the game goes silent,
and the next user gesture resumes it via `useAudioResumeRearm`. That is the re-arm working, not the
category failing to be set.

## Remaining

- **Native backend** — `@capacitor-community/native-audio` behind `audioService`,
  **deferred by design** — only if measured device latency demands it (all targets
  are WebView, so Web Audio covers 100% today).
- **World-space spatial** ✅ SHIPPED — spatial positions now read each entity's
  **world** position, so nested rigs are spatialized correctly. `audioSystem` exposes
  `setAudioWorldPositionResolver` and stays **THREE-free**: the app injects a resolver
  reading the `worldTransforms` cache (`app/ecs/pipeline.ts`), so the THREE dep that cache
  carries lives on the app side of the seam, not inside `audioSystem`. Falls back to the LOCAL Transform
  when no resolver is wired (standalone/2D). Covered by
  `tests/runtime/audioWorldPosition.test.ts`.
