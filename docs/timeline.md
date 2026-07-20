# Timeline / Cutscene Sequencer

A Unity-Timeline-style sequencer: a reusable **`.timeline.json` asset** (tracks + clips on a
time axis) played by a **`Director` trait** on an entity. The timeline *orchestrates existing
engine subsystems* (animation, actions, audio, activation) on a shared, deterministic clock — it
does not reimplement them.

Status: **shipped** — runtime + asset + headless tests (Phase 1), the editor Timeline panel
(Phase 2), the [`timeline-demo`](../games/timeline-demo/CLAUDE.md) worked-example game (Phase 3),
the panel's selected-item value inspector (Phase 4), **frame-accurate skeletal seek-scrub** (Phase 5
— scrubbing poses a 3D `SkeletalAnimator` rig at the exact clip time while stopped), and **full ▶
Preview** (Phase 6 — a forward playthrough that fires audio + signals + `OnSequence` with the sim
otherwise stopped, snapshotting/reverting the authored world), scrub **clip crossfade** (Phase B),
a **Control track** (Phase C — prefab spawn/despawn; Phase E — particle-system restart; Phase F —
nested sub-directors), and **Unity-style overlap-region blending** (Phase D — overlapping two clip
blocks crossfades over the overlap width) are all landed. Nested sub-directors drive in real **Play** AND
editor **▶ Preview** (and pose within their span on manual scrub). Deferred to v2: honoring the overlap
window during real **Play** (currently the overlap crossfade is a scrub/preview refinement; Play keyframe
hard-cuts and Play skeletal crossfades over its own `fadeDuration`).

## The asset/binding split (why cutscenes are reusable)

Like Unity's *Timeline Asset* + *PlayableDirector*, the data and the binding are separate:

- **`.timeline.json`** holds tracks with **no scene references** — each track targets an entity by
  a **relative name-path from the Director root** (`""` = the root, `"body/arm"` = the descendant
  reached by matching child `EntityAttributes.name`). This is the exact binding model an
  `.anim.json` clip uses, so one cutscene plays against any subtree whose child names match.
- **`Director`** (`runtime/traits/Director.ts`) binds the asset to an entity and holds the *playing
  instance* state: `{ timeline: GUID, time, speed, playing, loop }` (+ runtime read-back
  `lastTime`/`started`). Nothing instance-specific lives in the asset — same as `Animator` vs `.anim.json`.

## Data model

`runtime/timeline/types.ts` — `TimelineDef { id, name, duration, frameRate, tracks[] }`, plus
`normalizeTimeline()` (fills defaults, sorts entries by time, drops malformed) and
`defaultTimeline()`. Five track kinds, each `{ id, name, target, muted?, type }` + a per-type body:

| Track | Body | Drives (existing subsystem) |
|---|---|---|
| `animation` | `clips: [{ start, duration?, clip, scrub? }]` — `clip` is a NAME in the target animator's bank | the target's `Animator` (scrub) / `SpriteAnimator` / `SkeletalAnimator` (trigger). Scrub crossfade over an authored clip **overlap** (Phase D) or the per-clip `fadeDuration` (Phase B) — see below |
| `signal` | `markers: [{ t, action, params? }]` — `action` is a UIAction name | `dispatchGameAction` (pipeline-safe) |
| `audio` | `cues: [{ t, clip, bus?, volume?, pitch? }]` — `clip` is an audio GUID | the audio cue bus (`cueClip`) |
| `activation` | `spans: [{ start, end }]` | the target's `EntityAttributes.isActive` |
| `control` | `clips:` a `prefab` GUID, **or** `particle:true`, **or** `subdirector:true` | **prefab**: instantiate under the track target at `start`, destroy at `start + duration`. **particle** (Phase E): RESTART the track target's `ParticleEmitter` at `start`, pause at `start + duration`. **sub-director** (Phase F): drive the track target's own `Director`/nested timeline synced to the clip (Play + ▶ Preview). Unity's Control Track. |

Authorable via MCP `modoki_create_asset`/`modoki_write_asset` (schema registered in
`runtime/assets/assetSchemas.ts`). **Never hand-write asset paths** — audio-cue clips and control
prefabs are GUIDs. A spawned control prefab can *also* carry a `ParticleEmitter`, so "spawn an effect
on a beat" and "re-trigger an emitter already in the scene" are both covered; nested sub-directors
compose reusable sub-cutscenes (all three control kinds are landed — see Playback below).

## Playback — `timelineSystem` (`runtime/systems/timelineSystem.ts`)

Registered at `SYSTEM_PRIORITY.ANIMATION - 1 = 149`, one tick **before** `animationSystem` (150).
Advances every `Director` playhead, then applies each track. **Collect-then-apply**: the
`query(Director)` only integrates playheads; all `entity.set` / `dispatchGameAction` / `cueClip` /
`emit` run *after* the query (those touch other entities / run their own queries — the same
discipline as `animationSystem` and `zoneTriggerCore`).

### Determinism (headless-verifiable)

The playhead advances on **`getSimDelta`** (raw × `timeScale`, `0` when the sim isn't running), so
it's gated off automatically when stopped/paused (`149 < TRANSFORM(200)`) and is byte-reproducible
under `stepSimulation`. Every discrete event (marker / cue / activation edge / start / end / skeletal
trigger / control spawn+despawn) is edge-detected from stored `lastTime` vs `time` by a pure
`crossed()` test — no wall-clock, no `Math.random`. Control spawn/despawn journal `@control` on the
edge regardless of whether the prefab was loaded, so it's a reliable headless trace. Assert on the
`@sequence` / `@marker` / `@cue` / `@control` journal, not pixels.

`crossed()` is **forward-only in v1**: a non-positive per-frame advance (paused, `speed 0`, or reverse
playback — deferred) crosses nothing. A single frame that advances a **full lap or more** on a looping
timeline (`speed × simDelta ≥ duration` — reachable via a large `speed`, since `MAX_DELTA = 1/30` caps
`simDelta` but not `speed`) treats every tick as crossed, so no marker in a skipped lap is silently dropped.

**A director frozen at its start has NOT started.** PASS 1 skips a not-yet-started Director whose first
frame doesn't advance (`advanced <= 0` — a global `timeScale = 0` time-stop, `speed 0`, or reverse), so
`started` and `justStarted` aren't consumed. The sequence-start fan-out and every `t = 0` edge then fire
**together on the first *advancing* frame** — never dropped. (Consuming `justStarted` on a frozen frame
would have discarded the `t = 0` markers permanently, since `crossed` needs `advanced > 0`.) This matches
the engine's "not running → no events" rule; a mid-playback pause (`started` already true) just holds.

### The animation-track anti-fight guard (load-bearing)

`animationSystem` **samples** an `Animator` clip at `Animator.time` every frame *regardless of
`playing`*, and only advances `time` when `playing` is true. So for a **keyframe `Animator`**, the
timeline writes `{ clip, activeClip, time, playing:false }` — a frame-accurate scrub. The subtlety:
`animationSystem.ts` resets `time = 0` on a clip-*name* change; writing the runtime `activeClip` field
to the SAME name pre-empts that reset, so the scrub value survives a mid-cutscene clip switch. Because
`timelineSystem` runs at 149 and `animationSystem` at 150, the timeline sets the trait and the animation
system samples it the same frame.

**During PLAY, skeletal (`SkeletalAnimator`) and sprite (`SpriteAnimator`) are triggered, not
scrubbed** — the timeline dispatches `engine.playClip` once as a clip block's `start` boundary is
crossed, then lets the mixer run (start-and-run is correct for forward playback; there's no per-frame
seek cost). `applyTimelineState(world, rootId, def, t)` is the idempotent "pose at absolute time" entry
point (keyframe scrub + activation), shared with the editor scrub-preview via
`resolveTimelineAt(world, director, t)`.

**During editor SCRUB, 3D skeletal IS posed to the exact time** (Phase 5). A `SkeletalAnimator`'s pose
lives in a `THREE.AnimationMixer` the render layer owns — the runtime scrub path can't sample it like a
keyframe `Animator`. So `previewTimelineAt` publishes a **seek request** per skeletal target through
`runtime/systems/skeletalSeek.ts` (a plain module singleton mirroring `skeletalPreview`); the render
sync (`scene3DSync.syncSkinnedModels`) consumes it with `blendSkeletal`, which sets each requested
clip's action to its time+weight (one clip = a seek at weight 1; two = a **crossfade** — Phase B) and
bakes the pose with `mixer.update(0)`
(dt 0 = seek, not advance). `previewTimelineAt` clears + rebuilds the seek set each scrub, so it always
reflects the current playhead; `syncSkinnedModels` clears everything when real Play resumes, and the
`SceneView` unmount drops it. `syncBones`' read-back gate is widened for seeks so a rig with `Bone`
entities reads the seeked pose back into its bone Transforms instead of write-back clobbering it to
bind. Sprite/flipbook animators remain trigger-only (no arbitrary-time seek). Shipped games never call
`requestSkeletalSeek`, so this collapses to the frozen-while-stopped default there.

**Particle control (Phase E) uses the same render-bridge pattern.** A `particle` control clip can't
touch the emitter's live `IParticleBackend` handle from the deterministic pipeline, so
`timelineSystem` writes a restart/pause request through `runtime/systems/particleControlRegistry.ts`
(a module singleton like `skeletalSeek`, keyed by the target's entity id, cleared on world swap); both
`particleSync` (3D) and `particleSync2D` drain it per emitter and call `backend.restart(handle)` /
`backend.pause(handle)` before that frame's update. The deterministic edge is still the journaled
`@control` event (`phase: 'particle' | 'particle-pause'`) — the registry carries only the visual
effect, so headless tests assert on the journal exactly as for prefab spawn/despawn.

**Sub-directors (Phase F) nest one timeline inside another.** A `subdirector:true` control clip binds
the control track's target — an entity carrying its OWN `Director` — and drives it SYNCED to the clip:
the child's local time = parentTime − `clip.start`, playing across `[start, start + (duration ??
childDuration)]`. So the child's markers / audio / activation / `@sequence` fire at the correct GLOBAL
ticks and compose reusable sub-cutscenes. Three mechanisms make it deterministic and single-authority:

- **Slaving** — a pre-scan at the top of `timelineSystem` marks every subdirector target so it is
  skipped in the self-advance PASS 1 (it never runs on its own clock — the parent owns it). Scanning is
  memoized per `TimelineDef` (`timelineHasSubdirector`) so a timeline with no nesting pays only an O(1)
  probe. A **muted** subdirector track does NOT slave its child: muting means the parent stops driving
  it, so the child runs on its own clock rather than freezing.
- **Cycle guard** — the parent's `applyDirectorFrame` recursively runs the child's frame with the same
  pose/trigger opts, guarded by a per-chain `visited` set against self-reference and A→…→A cycles.
- **Drive-once** — a *frame-global* `driven` set (distinct from `visited`) ensures a child reached by
  two edges in one frame (a diamond `A→B→D` & `A→C→D`, or two clips targeting the same child) runs
  **exactly once**, so its markers / `@sequence` / journal never double-fire.

The child's sequence-**END fires once**, on the frame it reaches its effective play-end `min(childDuration,
clip span)`: a clip authored *longer* than the child ends at the child's own duration then holds it there;
a clip *shorter* truncates the child at the clip end (and its markers beyond the truncation never fire).

Sub-directors drive in **real Play AND editor ▶ Preview** (`driveSubdirectors` is set in both call sites) —
the child's skeletal seek accumulates onto the parent's rather than clobbering it (`previewTimelineStep`
clears the seek set once up front, then each nested pose accumulates via `clearSeeks:false`). Manual
**scrub** also poses a nested child within its clip span and reconciles the child's control tracks OFF when
the playhead leaves the span — see the editor panel below.

## Three sinks per sequence event

Mirrors the Zone stack (`zoneTriggerCore.routeZone`): each start/marker/end fans to

1. **Journal** — `emit('@sequence'|'@marker'|'@cue', …, world)` (the tick-stamped verification trace).
2. **Code bus** — `timelineEvents` (`runtime/managers/TimelineEvents.ts`): world-scoped
   `onSequenceStart` / `onMarker` / `onSequenceEnd`, registered as a scene-scoped Manager (clears
   subscribers on scene swap).
3. **Declarative `OnSequence` trait** — `{ onStart, onEnd }` (UIAction names) on the Director entity;
   fired via pipeline-safe `dispatchGameAction`. Per-marker reactions are the signal track's own actions.

## Resource wiring

`Director.timeline` is a scalar GUID ref registered across all the usual touch-points
(`SceneResourceRef` union + `SCALAR_RESOURCE_TYPE_BY_FIELD` in `loadSceneFile.ts`,
`REF_FIELDS_BY_TRAIT` in `sceneValidation.ts`, `assetTypeClassifier.ts`, `acquireResource` in
`SceneManager.ts`, the `AssetType` union). The timeline JSON's **inner audio-cue GUIDs** (audio tracks) and **prefab GUIDs** (control tracks) are
invisible to the entity collector, so `SceneManager.loadScene` walks each timeline (`loadTimelineNow` +
`collectTimelineAudioRefs` / `collectTimelineControlRefs`) and acquires them scene-scoped — audio by
resolved PATH, prefabs by GUID (the two resource kinds differ by convention: `acquirePrefab` resolves
the GUID itself). The build tree-shaker has a matching `processTimeline` follower so a cue-only SFX /
control-only prefab survives the prod tree-shake.
(Animation-track clips are NAMES resolved via the target `Animator` bank, so they're already owned.)
The lazy def cache is `runtime/loaders/timelineCache.ts` (`getTimeline`, cleared on scene swap).

## Editor panel

A dockable, retargeting **Timeline panel** (`editor/panels/TimelineEditor.tsx`, mirroring the
Animation editor: coalesced-commit → global undo, debounced validated save) edits `.timeline.json`
against the selected Director. It reuses the Animation editor's timeline substrate verbatim
(`timelineMath` / `useTimelineDrag` / `useTimelineViewport` / `TimelinePlayhead`). Left: the track
lane list (`TrackLaneList` — kind badge/target/mute/remove, add-track picker). Right: the track body
(`ClipTrackView` — clip bars + span bars + marker/cue diamonds; drag to retime, wheel-zoom,
right-drag pan). Dragging the playhead calls `previewTimelineAt` (pose) + `previewControlAt`
(control-track presence), so the bound subtree poses live while stopped: keyframe `Animator` clips AND
3D `SkeletalAnimator` rigs (seek-scrub, above), plus activation visibility and control-track prefab
presence (a prefab appears/disappears as the playhead enters/leaves its clip span) — **manual scrub
stays pose-only and silent** (no game side effects). Scrubbing a control track also poses nested
sub-directors within their clip span and reconciles a nested child's control tracks OFF when the
playhead leaves the span (so a scrubbed-off sub-cutscene doesn't leave its prefabs/emitters lingering).
Every scrub-spawned control prefab is tagged **`Transient` regardless of run mode** (`previewControlAt`
passes `forceTransient`), so the serializer always drops it — a scrub reconciler runs even from a
`stopped`-mode commit/undo pose, and an untagged spawn would otherwise leak into the authored scene.

**▶ Preview is a real forward playthrough** (Phase 6): it also fires the edge-triggered effects —
**audio cues, signal markers (camera/text/…), and `OnSequence`** — so you can see AND hear the
cutscene without entering Play. The loop calls `previewTimelineStep` (pose + forward edge-fire over
`(prevT,curT]`). Because the engine gates those effects on `getPlayState()==='playing'`, preview
opens exactly two gates via a flag (`runtime/systems/timelinePreview.ts`, `setTimelinePreviewActive`):
`dispatchGameAction` (signals/OnSequence) and `audioSystem` (cues). Play stays `'stopped'`, so
`runPipeline` still skips the whole simulation tier — the rest of the sim (physics/input/gameplay)
never runs. A signal action can mutate anything (a `cameraMove` moves the camera, `showText` sets a
label), so preview **snapshots the authored world at ▶ and reverts it** (`serializeScene` →
`SceneManager.loadScene({preloaded})`, mirroring editor Play/Stop — `editor/scene/timelinePreview.ts`)
when you **⏮/scrub, close/switch the panel, or press global Play**; Pause holds the mutated frame
(session kept, audio+dispatch gates closed). The revert reloads the world (new entity ids), so the
panel re-resolves the Director root after restore. Nothing preview mutates ever reaches disk.

**Item inspector** (`timeline/ItemInspector.tsx`, pure helpers in `timeline/itemEdit.ts`): click a
clip/marker/cue/span to edit its **values** — animation clip name/start/duration/scrub, signal
`t`/action/params (JSON), audio `t`/clip/bus/volume/pitch, activation start/end. Value pickers avoid
the raw-GUID/typo trap: the audio cue clip is a **dropdown of the project's audio assets** and the
signal action **autocompletes registered `UIAction` names**. Clearing an **optional** numeric field
(clip/control `duration`, cue `volume`/`pitch`, a spawn-transform component) unsets it — round-tripping
to `undefined` (the prefab/engine default) rather than a semantically different `0`; required fields
(`start`/`t`/`end`) still clear to `0`. Add/remove items use the **same
conventions as the Animation editor**: double-click an empty lane to add, double-click an item (or
press **Delete**/**Backspace** with it selected) to remove — with the dock's `+ item @ playhead`
button and per-item Delete as discoverable alternates. Edits flow through the same coalesced-undo
commit as the rest of the panel. (The `modoki_timeline_set` / `modoki_timeline_add_clip` MCP ops
remain the agent-facing path to the same edits.)

## Clip crossfade — two authoring models (Phase B + D)

On scrub/preview, `activeClipsAt` (in `timelineSystem.ts`) blends the outgoing + incoming clip across
a **blend window** whose width comes from whichever model the author used:

- **Overlap region (Phase D, Unity-style):** drag the incoming block so it starts *before* the
  outgoing block's authored end — the overlap `[cur.start, prev.end]` **is** the crossfade window;
  weight ramps 0→1 across exactly that overlap. Wins over the per-clip fade when present.
- **Per-clip `fadeDuration` (Phase B fallback):** no authored overlap → blend over the incoming
  clip's `fadeDuration` (the `Animator` bank entry or `SkeletalAnimator.fadeDuration`) — the same
  value `animationSystem`/`driveAnimator` use during Play, so a stopped scrub matches Play.

Both drive the keyframe `Animator` (`applyClipAtTimeBlended`) and the 3D `SkeletalAnimator` seek
(`blendSkeletal`, weights sum to ~1). Non-overlapping timelines are byte-identical to Phase B.

## Deferred to v2

- **Overlap window during real Play.** The overlap-region blend above is a **scrub/preview**
  refinement (it lives in `activeClipsAt`, which only the preview path calls). During real Play,
  keyframe blocks still **hard-cut** (`applyTimelineState` poses a single clip) and skeletal still
  crossfades over its own `fadeDuration` (the mixer, via `engine.playClip`) — honoring the authored
  overlap there needs the timeline to thread a per-transition crossfade into `animationSystem` /
  `driveAnimator`, which is a separate change.
- **Reverse playback** (`speed < 0`) — v1 is forward-only.
- **Sub-frame marker precision** — edges land on the tick that crosses them.
- **Activation semantics note:** during playback an activation track OWNS its target's `isActive`
  (active within a span, inactive outside — Unity's Activation Track model). A v2 refinement could
  restore the entity's authored value outside every span instead of forcing `false`.
