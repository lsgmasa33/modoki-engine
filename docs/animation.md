# Animation

Modoki's animation stack: reusable keyframe clips that drive arbitrary trait fields, Three.js
skeletal playback for rigged GLBs (with hand-posable bones, per-mesh renderers, and a cross-model
clip library), and 2D sprite flipbooks. It follows Unity's vocabulary throughout — clip, Animator,
mixer, animset, retarget — but every "desired state" is a pure ECS trait and every live THREE object
lives in the render sync, never in the trait.

## What it is

Five loosely-coupled subsystems, split by what they drive:

- **Keyframe clips** (`Animator` + `.anim.json`) — a reusable asset of tangent-curve tracks that
  animate any trait field (Transform, colour, UI, enum, boolean) on the Animator's entity and its
  descendants, bound by relative name-path. This is the generic "animate a number over time" engine;
  it's evaluated by pure, headless-testable functions shared between playback and the editor scrub.
- **3D skeletal** (`SkinnedModel` + `SkeletalAnimator`) — a rigged GLB kept as a live SkinnedMesh
  hierarchy, cloned per entity, driven by a `THREE.AnimationMixer`. The trait is desired state; the
  render sync owns the mixer/actions and mirrors live playback back onto the trait for Percept.
- **Hand-posable bones** (`Bone` entities + `syncBones`) — ECS entities that bridge two-way into the
  cloned skeleton, so a bone is gizmo/inspector-editable when no clip drives it, and a keyframe
  `Animator` or a game LateUpdate can layer overrides on top of the mixer pose.
- **Rig accessories** — `SkinnedMeshRenderer` (per-mesh material/visibility on the shared clone),
  `BoneAttachment` (pin a prop to a bone socket), and `AnimationLibrary` (merge clips from *other*
  GLBs into this rig's mixer, optionally retargeted).
- **2D flipbook** (`SpriteAnimator` + `.spriteanim.json`) — plays named frame sequences by driving
  `Renderable2D.sprite`; once/loop/pingpong.

The load-bearing split, everywhere: **traits are pure data, the render sync owns the live THREE
objects.** `SkeletalAnimator`/`SkinnedModel`/`Bone`/`AnimationLibrary` never hold a mixer, action,
or `THREE.Bone` — those live in `RenderState.skinned` keyed by entity id, so the trait serializes
clean and hot-reloads.

## Key files

- `runtime/animation/types.ts` — the `.anim.json` data model: `Keyframe`, `AnimationTrack`,
  `AnimationClipDef`, tangent modes, `STEPPED`, `normalizeAnimationClip`.
- `runtime/animation/curveEval.ts` — pure curve math: `evalTrack` (weighted-bezier Hermite),
  `evalColorTrack`/`evalBooleanTrack`/`evalSteppedTrack`, `applyTangentMode`. No THREE, no ECS.
- `runtime/animation/sampleClip.ts` — `applyClipAtTime` (sample every track, name-path resolve,
  batch-write onto bound entities), `buildEntityIndex`, `advanceClipTime`. Shared by playback + scrub.
- `runtime/systems/animationSystem.ts` — the pipeline system that advances `Animator.time` and poses.
- `runtime/traits/{Animator,SkeletalAnimator,SkinnedModel,Bone,BoneAttachment,SkinnedMeshRenderer,AnimationLibrary,SpriteAnimator}.ts`
  — the eight data traits (each doc-commented with its exact field contract).
- `runtime/rendering/scene3DSync.ts` — the skeletal engine: `syncSkinnedModels`, `driveAnimator`,
  `mergeAnimationLibrary`, `syncBones`, `syncBoneAttachments`, `syncSkinnedMeshRenderers`.
- `runtime/systems/spriteAnimationSystem.ts` — the 2D flipbook driver.
- `runtime/loaders/{animationClipCache,animSetCache,spriteAnimCache}.ts` — the three lazy asset
  caches (`.anim.json` / `.animset.json` / `.spriteanim.json`), all the same fetch-once-retry shape.

## How it works

### Keyframe clips (`Animator` + `.anim.json`)

A `.anim.json` (`AnimationClipDef`) is `{ id, name, duration, frameRate, loop, tracks[] }`. Each
`AnimationTrack` binds by `{ path, trait, field, type, keys[] }`: `path` is a **relative name-path**
from the Animator's entity (`""` = the root itself, `"body/arm"` = descendants matched by
`EntityAttributes.name`), so a clip is reusable across prefab instances — the Unity AnimationClip +
Animator model. `type` is one of `number | color | boolean | enum`; values are always plain numbers
on disk (`color` = packed `0xRRGGBB`, `boolean` = 0|1, `enum` = the option index into the field's
static option list).

`Animator` holds a NAMED LIST of clips and plays one at a time:
`{ clips, clip, time, speed, playing, loop, activeClip }`. `clips` is a **JSON-string bank**
(`[{ name, clip: guid, speed?, loop?, fadeDuration? }]`, decoded by `animation/animClipBank.ts` —
the ONE decoder, shared by the play loop, the resource collector, and the tree-shaker, same pattern
as `AudioSource.clips`); `clip` is the **active clip NAME** (empty → first entry), so switching
tracks at runtime is `entity.set(Animator, { clip: 'walk' })` — mirroring `SkeletalAnimator` /
`SpriteAnimator`. `resolveActiveClip(anim)` maps the active name → its `.anim.json` GUID + per-clip
overrides; `activeClip` (runtimeOnly) mirrors what's actually playing. The active `clip` is a name,
NOT a fetchable ref, so the `.anim.json` GUIDs are collected from the `clips` bank explicitly in
`collectResourceRefsFromEntities` + the tree-shaker's `probeTraitRefs` (Animator has no entry in
`REF_FIELDS_BY_TRAIT`). Runtime switch API: the `engine.playClip` action (by name, guarded
by `animatorHasClip`). Per-clip `speed`/`loop` override the trait-level fallbacks.

`animationSystem` (runs at `SYSTEM_PRIORITY.ANIMATION`, before transform propagation, so posed local
transforms propagate the same frame) does two passes: it resolves the active clip, restarts `time` on
an active-name change (instant cut — only between two known names, so the initial bind keeps an
authored `time`), advances `anim.time` via `advanceClipTime` (loop-wrap or clamp against duration),
collects `{rootId, clip, t}`, then builds the entity index **once per frame** and calls
`applyClipAtTime` for each animator — so N animators cost `O(N + entities)`, not `O(N × entities)`.

**Crossfade (`fadeDuration`).** When the active `clip` changes and a `fadeDuration` applies (trait
default or the incoming clip's per-clip override; 0 = instant cut = the behavior above), the switch
captures the OUTGOING clip's name + playhead as the fade-from source (runtimeOnly `fadeFrom` /
`fadeFromTime` / `fadeElapsed`, advanced each frame — the outgoing clip keeps moving as it fades so
it blends mid-motion, not frozen). The blend weight ramps 0→1 over `fadeDuration`; while a fade is
active the pose comes from `applyClipAtTimeBlended` (in `sampleClip.ts`) instead of `applyClipAtTime`.
That path samples BOTH clips' RAW track values into a `PoseMap`, blends **per field by type** —
numbers lerp (Transform rotation `rx/ry/rz` use a shortest-arc angle lerp so ±180° wraps the short
way; there are no quaternion tracks, so coupled-axis nlerp is a deliberate non-goal), colors lerp
per-channel, stepped `boolean`/`enum` snap to the dominant side — then coerces + writes once. The
single-clip `applyClipAtTime` stays the allocation-free hot path; the blended path allocates but only
runs *during* a fade. Two documented limitations: a field only ONE clip animates is applied at full
strength (no captured bind pose to fade a mismatched track toward — harmless when both clips animate
the same fields), and **deform channels don't crossfade** (the incoming clip drives them at full).
A pause freezes the blend in place. The bone-layer re-pose (`scene3DSync.applyBoneAnimators`) mirrors
the same blend so a bone-targeting clip switch crossfades too.

**Switching clips at runtime (one API for all three animators).** `Animator`, `SpriteAnimator`, and
`SkeletalAnimator` all model "the active clip is a NAME", so a single engine action drives whichever
the entity carries: **`engine.playClip`** (`runtime/ui/engineActions.ts`) — the unified twin of
`engine.toggleAnimator`. It takes a `clip` NAME param and, per present trait, resets `time` + sets
`playing` (keyframe/sprite, guarded by `animatorHasClip`/`spriteAnimHasClip`) or writes the name for
the mixer to crossfade (skeletal — validated at the render layer, no synchronous guard). Bind it to a
button, dispatch it from game code, or call the **`modoki_play_clip`** MCP tool. This is distinct from
`modoki_anim_set_clip`, which edits a clip's DATA (the `.anim.json`), not which clip is active.
The switchable NAMES are discoverable without opening the asset via `switchableClipNames`
(`animation/switchableClips.ts`), surfaced as a `clipNames` field on the animator traits in
`get_scene_state` (Percept).

The three animators deliberately keep **different storage** for their clip lists — unified only at
the *switch API*, not the storage layer. `Animator` holds its list **inline** as the JSON `clips`
bank (keyframe clip lists are light and entity-local, so an inline scalar keeps them
serialize/undo/prefab-safe with no extra asset). `SpriteAnimator`/`SkeletalAnimator` reference a
**shared asset** (`.spriteanim.json` / `.animset.json` over a GLB), because sprite sheets and rig
clips are heavier and meant to be authored once and reused across entities. Harmonizing storage
(e.g. an inline-bank Animator onto a shared `.anim-set.json`) is a much larger migration and a
deliberate non-goal.

`applyClipAtTime` (in `sampleClip.ts`) resolves each track's target by name-path, evaluates the
value via `evalTrackValue`, and **batches field writes per (entity, trait)** so a Transform animated
on `px`/`py`/`pz` reads-and-writes once, not three spread-copies. It dirties the UI tree
(`markUIDirty`) when it touches a UI trait — otherwise a UI clip plays in ECS but never repaints
(the DOM only rebuilds on the dirty flag).

Curve evaluation (`curveEval.ts`) mirrors Unity's `AnimationCurve`: constant clamp outside the key
range, weighted cubic-bezier Hermite between keys using each key's out/in tangents + weights, and a
**STEPPED** (`+Infinity`) out-tangent holds the left value until the next key. `evalSegment` solves
the time→parameter map with Newton + a real bisection fallback (bracketed, can't diverge to the
wrong root) and clamps the tangent-weight *sum* to keep `x(u)` monotonic. `applyTangentMode`
implements the right-click tangent menu (auto/linear/constant/free) and records the mode on the key.

### 3D skeletal (`SkinnedModel` + `SkeletalAnimator`)

`SkinnedModel { model, isVisible }` references the **raw GLB** (not a baked `.mesh.json`) and keeps
the whole scene graph — bones, `Skeleton`, bind matrices, the GLB's `AnimationClip`s — intact. It's
loaded + scene-scope-refcounted through `riggedModelCache`. `SkeletalAnimator` is the desired
playback state: `{ animSet, clip, playing, speed, loop, fadeDuration }` plus runtime-read-back
mirror fields (`activeClip`, `time`, `normalizedTime`, `weight`, `effectivePaused` — see Percept
below).

`syncSkinnedModels` (once per frame, per 3D viewport) is the engine:

1. **Clone per entity** — `SkeletonUtils.clone(prototype)` gives each instance its own pose +
   Skeleton, added to the scene; a `THREE.AnimationMixer` is built on the clone and one
   `AnimationAction` per GLB clip cached in `entry.actions`. All this lives in a `SkinnedEntry` in
   `RenderState.skinned`, never in the trait.
2. **`driveAnimator`** — resolves the desired clip (`a.clip || entry.firstClip`; warns once and
   falls back if the name isn't in the rig), crossfades on a clip change (`crossFadeFrom` with the
   incoming clip's fade), and each frame sets `paused`/`timeScale`/loop/`clampWhenFinished`. Per-clip
   params (speed/loop/fade) come from the entity's `animSet`; the trait's own fields are **per-entity
   overrides** — a field left at its trait default inherits the animset's per-clip value, a
   non-default value wins (`resolveAnimSetParams` returns engine defaults with no animset, so the
   formula collapses to "trait field always wins" in the legacy case).
3. **Advance** — every live mixer advances by `mixerAdvanceDelta`: playing → engine *visual* delta
   (smoothed cadence × `timeScale`, so skeletal respects pause/slow-mo/time-stop); stopped/paused →
   frozen (dt 0), **except** while the Animation editor previews (`skeletalPreviewDelta`). No
   wall-clock read — "not playing → no animation" — which is why `scene3DSync` left the determinism
   wall-clock allowlist.

A `SkinnedModel` with **no** `SkeletalAnimator` autoplays its first clip on a loop.

**Percept read-back:** after advancing, `syncSkinnedModels` mirrors each rig's live mixer state onto
its `SkeletalAnimator`'s `runtimeOnly` fields (`activeClip`, `time`, `normalizedTime` = phase 0..1,
`weight`, `effectivePaused`) so `get_scene_state` reports what's *actually* playing, not just the
desired state. It also emits `@anim-start`/`@anim-loop`/`@anim-finish` journal events — but only from
the **primary** surface (`emitLifecycle`), because the editor runs two viewports on one world and the
journal is per-world.

### Hand-posable bones (`Bone` + `syncBones`)

A `Bone { name }` entity *is* a node of a `SkinnedModel`'s skeleton — a (transitive) child of the
model-root entity, whose `Transform` is the bone's local transform. It's resolved to its rig by
walking up `parentId` to the nearest ancestor with a `SkinnedModel`; `name` selects the `THREE.Bone`.

`syncBones` runs each frame after `syncSkinnedModels`, as a four-step bridge:

1. **read-back + baseline** — capture every bone's posed transform as the baseline (in the entity's
   own pos/euler/scale representation). For a **clip-driven bone while Playing**, copy that baseline
   into the entity `Transform` (so children under the bone follow, and a LateUpdate can layer).
2. **layer** (Play only) — `applyBoneAnimators` re-poses any bone-targeting keyframe `Animator` *on
   top of* the mixer pose (Unity's override-layer / avatar-mask shape), then game LateUpdate systems
   run on top of that.
3. **write-back** — copy a bone's `Transform` back into the `THREE.Bone` **only if it diverged from
   its baseline** (a per-bone dirty gate). Untouched clip-driven bones are byte-equal → skipped, so
   the mixer pose renders verbatim; a gizmo/Animator/LateUpdate/hand-pose edit shifts a component
   past the noise floor → written.
4. **re-propagate** — re-run transform propagation and re-place any renderable parented under a moved
   bone, so a sword in a hand tracks *this* frame, not one late.

So the `THREE.Bone` is the source of truth until something moves the entity `Transform` off baseline,
then the `Transform` wins. A no-clip rig (SkinnedModel + Bone entities, no animation) has no
read-back → the entity Transform *is* the pose and always writes back → dragging a bone deforms the
mesh and sticks. Read-back never runs while Stopped, so the authored bind pose serializes clean.

### Rig accessories

- **`SkinnedMeshRenderer { node, materials, visible }`** — a child entity of the rig root that
  configures **one mesh node** of the shared clone (it adds no THREE objects of its own — the
  skeleton stays a single instance). `node` is the GLB mesh-node name; `materials` maps original
  material-slot NAME → a `.mat.json` guid (a node reuses a few materials across many primitives — the
  148-primitive eyes collapse to 2 slots). `syncSkinnedMeshRenderers` resolves the root via
  `parentId` and applies overrides + visibility, restoring the baked material when a slot is cleared.
  A rig root with **no** renderer children renders the GLB's baked materials (back-compat); the
  import pipeline expands a GLB into root + renderer entities as a generated prefab.
- **`BoneAttachment { target, bone }`** — an Unreal-style socket. Put it on a normal
  Renderable3D+Transform entity; `syncBoneAttachments` finds `bone` in `target`'s animated skeleton
  and drives the entity to the bone's world position+rotation, seating the prop via its own
  Transform (position = world-unit offset rotated into the bone's orientation, rotation composes,
  **scale is the prop's own** — never inherited from the rig, so a prop stays its authored size on a
  heavily-scaled model). Cheap: `O(attachments)`, not `O(bones)` — the bones stay plain THREE
  objects, never ECS entities.
- **`AnimationLibrary { animSets, retarget, boneMaps }`** — extra skeletal clips a rig can play that
  live in *other* GLBs (Unity's shared clip library / Animator Override). Put it on the rig root next
  to `SkeletalAnimator`. `mergeAnimationLibrary` builds the mixer's actions as **own clips ∪ library
  clips, own clips winning on a name conflict**: each `.animset.json`'s `source` GLB is loaded via
  `riggedModelCache` and its clips bound into this rig's mixer by track/bone name (cheap + correct
  for a shared skeleton). `retarget:true` (or a non-empty `boneMaps` entry) runs each clip through
  `SkeletonUtils.retargetClip` first — for a source rig with a different bind pose/proportions, or
  differently-named bones (`boneMaps[animSetRef] = { targetBone: sourceBone }`) — which is what makes
  a foreign clip pack (e.g. Mixamo) play on your own rig. Merge is lazy + idempotent (a source whose
  GLB hasn't loaded is retried next frame; once merged it's recorded in `entry.libraryMerged`).

Note `effectiveLibrary`: the `SkeletalAnimator`'s **own** `animSet` is appended to the library's
animSets, so assigning an animSet to the animator brings its `source` GLB's clips into a bare rig,
not only per-clip params.

### 2D flipbook (`SpriteAnimator` + `.spriteanim.json`)

`SpriteAnimator { clipSet, clip, time, playing }` goes on the same entity as a `Renderable2D`. The
clips live in a reusable `.spriteanim.json` holding **multiple named** `SpriteClip`s
(`{ frames: sprite-slice-guid[], fps, mode, cycles }`, `mode` ∈ once|loop|pingpong, `cycles` 0 =
infinite). The trait plays one at a time, chosen by `clip` (empty → first).

`spriteAnimationSystem` (at `SYSTEM_PRIORITY.ANIMATION`, advancing on the **visual** delta, skipped
per-entity when `Paused`) computes `step = floor(time·fps)`, maps it to a frame via the shared
`spriteIndexFromStep` math (the same loop/pingpong logic the GPU particle sprite-sheets use), and
writes `Renderable2D.sprite` to that slice GUID. Scene2D's per-entity `spriteRef` change-detection
rebuilds the framed texture. The frame is (re)applied every tick *before* advancing, so frame 0 shows
at time 0 and an externally-set `time` (scrubbing) resolves correctly even while paused.
`characterAnimationSystem` sits on top of this: it maps a 2D platformer's controller state
(idle/walk/jump) to clip names and flips facing via `Renderable2D.flipX`.

### The three asset caches

`animationClipCache` (`.anim.json`), `animSetCache` (`.animset.json`), and `spriteAnimCache`
(`.spriteanim.json`) are all the same shape: first access kicks off a lazy `fetch`, returns
null/undefined until it resolves (the per-frame driver simply retries next frame), resolves GUIDs
through the asset manifest, and lets the editor seed/invalidate by path for live preview. A **failed**
fetch is remembered and NOT retried at runtime — only `invalidate`/`clear` resets it. All three are
plain DATA (nothing to GPU-dispose); `clear*Cache` bumps a generation so an in-flight load from a
swapped-away scene is dropped.

## Gotchas

- **STEPPED (`+Infinity`) doesn't survive JSON** — `JSON.stringify(Infinity) === "null"`, so a saved
  stepped key would reload as linear. The persistent marker is `tangentMode:'constant'`;
  `normalizeAnimationClip` reconstructs `outTangent = STEPPED` from it on load. If you build a clip in
  code, set the mode, not just the raw tangent.
- **A missing/NaN tangent means *flat* (0), a genuine `+Infinity` means *hold*** — `normTangent`
  keeps the two distinct. Legacy/partial keys with an absent `outTangent` must read as 0, or
  `evalTrack` (which treats non-finite as STEPPED) and `evalSegment` (which reads 0) would disagree.
- **Animating a UI trait needs the dirty flag** — `applyClipAtTime` calls `markUIDirty()` when it
  writes a UI trait; a bare `entity.set` on a UI field won't repaint on its own.
- **`SkeletalAnimator.speed/loop/fadeDuration` are OVERRIDES, and "equals the trait default" is the
  sentinel for "inherit the animset value."** `ANIMSET_DEFAULTS` in `animSetCache` MUST stay equal to
  the trait defaults (`speed:1, loop:true, fadeDuration:0`) — that equality *is* the inherit switch.
  Change one without the other and every entity silently stops inheriting animset params.
- **`SkinnedMeshRenderer.materials` slot keys are material NAMES, not indices** — a node reuses a few
  materials across many primitives, so the override map keys on the material's `.name`. A slot left
  unset keeps the baked GLB material; clearing an override restores the exact baked element.
- **The bone bridge bakes a wrapper prefix for ROOT bones only** — a Blender/FBX export puts a
  non-bone "Armature" (Z-up→Y-up rotation + 100× scale) above the skeleton. A root bone's entity
  `Transform` lives in **clone-root** space, so read/write-back multiply by `boneWrapperPrefix.fwd`
  / `.inv`; child bones use parent-local TRS directly. Without this a root bone collapses ~100× small
  at the origin every frame.
- **Write-back is per-bone dirty-gated, not global** — the old `playing && hasClip` echo round-tripped
  the mixer pose through compose→decompose every frame, dropping the shear a wrapper-baked non-uniform
  scale produces → visible jitter on a fast clip. Now an untouched clip-driven bone is skipped
  (mixer pose verbatim) and only bones a layer actually moved write back; touching one bone never
  drags its clip-driven siblings through the lossy echo.
- **`retargetClip` silently drops scale (and non-hip position) tracks** — it resamples only
  position(hip)+quaternion per bone. `carryOverScaleTracks` re-attaches the source clip's `.scale`
  tracks (renamed via the inverted bone map) so a scale-only shrink/stretch clip still animates on a
  retargeted rig. It also emits skeleton-relative track names (`.bones[Name].prop`) that only bind to
  a SkinnedMesh; the merge rewrites them to node-name form (`Name.prop`) because the mixer drives the
  clone's root Group.
- **`get_scene_state` shows the desired clip until you read the runtime fields** — `SkeletalAnimator.clip`
  is the *request*; `activeClip`/`normalizedTime`/`weight` are the mirrored live mixer state. A
  bare-rig sourcing clips from an `AnimationLibrary` has an empty action set for the first frames
  (GLB lazy-loading), which is why `driveAnimator` suppresses its "clip not found" warning until the
  rig actually has clips.
- **A failed asset fetch is not retried** — a typo'd/500'd `.anim.json`/`.animset.json`/`.spriteanim.json`
  is remembered in `failed` and stays broken until an invalidate/clear (or scene swap). It won't
  self-heal by waiting.

## Related

- [2d-skinning.md](./2d-skinning.md) — **2D sprite skinning** (bones deforming a mesh:
  `SkinnedSprite2D`, `Rig2DPart`, deform tracks, the `Billboard3D`/`FlatSprite3D` 2.5D bridge). The
  `deformTracks` on `AnimationClipDef` and `applyClipDeform` belong to that doc, not this one.
- [rendering.md](./rendering.md) — the 3 render layers, `scene3DSync`, the WebGPU renderer.
- [engine-concepts.md](./engine-concepts.md) — trait/system/projection vocabulary; the
  "traits are data, the sync owns the live objects" split.
- [prefabs.md](./prefabs.md) — how the import pipeline expands a rigged GLB into root +
  `SkinnedMeshRenderer` entities as a generated prefab.
- `CLAUDE.md` — "Time, Determinism & the Verification Harness" (why skeletal keys off play state and
  the visual delta, never the wall clock) and the Percept/`modoki_watch` tools for tuning motion feel.
