# Audio Integration Plan

Status: **Phases 1–4 shipped** (`verify` green) — runtime audio subsystem +
editor authoring (Audio Inspector) + the ffmpeg converter + mix helpers + the
**declarative control layer** (engine-reconciled `AudioSource` + built-in `audio.*`
actions), plus a fully-declarative demo game (`games/audio-demo`) and a Unity-style
editor **Mute Audio** toggle. Only the **native backend** (deferred by design) and
a couple of small polish items remain. Owner: solo.

## Decisions (settled)

- **Engine-native, on the Web Audio API — no library.** Not Howler: it owns its
  own loading/caching/state, which fights the GUID + scene-scoped refcounted
  resource pipeline, the deterministic/headless harness, and the 2D/3D split.
- **THREE-free.** Built on raw Web Audio nodes (not `THREE.Audio`): explicit
  per-bus `GainNode` routing and ECS-driven listener/panner positions are more
  direct, and the subsystem carries **zero Three dependency** — a pure-2D game
  that drops 3D rendering drops nothing here.
- **The journal is NOT the audio transport.** The journal is the
  verification/debug OUTPUT trace and can be disabled in shipped builds
  (`setJournalEnabled(false)`), so depending on it would silently mute the game.
  Audio is driven by **traits + a dedicated cue bus + direct service calls**.
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
  listener/panner from each entity's **local** Transform. No wall-clock/random.
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
- **App wiring** — `App.tsx` resumes the context on first user gesture and
  disposes on teardown. The old oscillator `services/audio.ts` is deleted.
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
  Reintroduce a specific helper when a game actually needs it. `setBusVolume` (used by
  the demo's mixer sliders) stays.
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
- **Built-in `audio.*` UIActions** (`runtime/audio/audioControls.ts`,
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

## Remaining

- **Native backend** — `@capacitor-community/native-audio` behind `audioService`,
  **deferred by design** — only if measured device latency demands it (all targets
  are WebView, so Web Audio covers 100% today).
- **Editor gesture-unlock (small)** — the game shell (`App.tsx`) resumes the
  AudioContext on first gesture, but `EditorApp` does not, so a context suspended
  mid-session stays silent until an editor relaunch. Add `audioResume()` on first
  gesture in the editor shell.
- **World-space spatial** ✅ SHIPPED — spatial positions now read each entity's
  **world** position, so nested rigs are spatialized correctly. `audioSystem` exposes
  `setAudioWorldPositionResolver` and stays **THREE-free**: the app injects a resolver
  reading the Three-computed `worldTransforms` cache (`app/ecs/pipeline.ts`), so the
  Three dep lives on the app side, not in the engine. Falls back to the LOCAL Transform
  when no resolver is wired (standalone/2D). Covered by
  `tests/runtime/audioWorldPosition.test.ts`.
