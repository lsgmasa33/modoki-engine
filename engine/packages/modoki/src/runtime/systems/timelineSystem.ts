/** timelineSystem — plays `.timeline.json` sequences via the `Director` trait.
 *
 *  Runs at ANIMATION-1 (149), immediately BEFORE animationSystem, so a keyframe-scrub
 *  Animation track writes `Animator.{clip,time}` and animationSystem samples that exact
 *  pose the SAME frame. `149 < TRANSFORM(200)` makes it sim-gated — inert while stopped/
 *  paused, matching the deterministic sim-delta playhead.
 *
 *  DETERMINISM: the playhead advances on `getSimDelta` (raw × timeScale, 0 when not
 *  running) and every discrete event (marker / audio cue / activation edge / sequence
 *  start-end / skeletal clip trigger) is edge-detected from stored `lastTime` vs `time` —
 *  a pure `prev < t <= cur` crossing (with an explicit loop-wrap branch). No wall-clock,
 *  no `Math.random`. Verifiable headless via the `@sequence`/`@marker` journal.
 *
 *  COLLECT-THEN-APPLY: the `Director` query only integrates each playhead and stages a
 *  per-director record; ALL side effects (entity.set, dispatchGameAction, cueClip, emit,
 *  bus, OnSequence) run AFTER the query — because those touch other entities / run their
 *  own queries, exactly as animationSystem and zoneTriggerCore do.
 *
 *  THREE SINKS per sequence event (start/marker/end), copying zoneTriggerCore.routeZone:
 *  the tick-stamped journal, the `timelineEvents` code bus, and the declarative `OnSequence`
 *  trait. */

import type { Entity, World } from 'koota';
import { Director } from '../traits/Director';
import { OnSequence } from '../traits/OnSequence';
import { Animator } from '../traits/Animator';
import { SkeletalAnimator } from '../traits/SkeletalAnimator';
import { EntityAttributes } from '../traits/EntityAttributes';
import { requestSkeletalSeek, clearSkeletalSeeks } from './skeletalSeek';
import { Paused } from '../traits/Paused';
import { getTime, getSimDelta } from './getTime';
import { emit, entityRef } from './journal';
import { dispatchGameAction } from '../ui/actionRegistry';
import { cueClip } from '../audio/audioCues';
import { timelineEvents } from '../managers/TimelineEvents';
import { getTimeline } from '../loaders/timelineCache';
import { getCachedPrefab } from '../loaders/meshTemplateCache';
import { spawnPrefabInstance } from '../loaders/loadSceneFile';
import { deleteEntity } from '../ecs/entityUtils';
import { getControlSpawn, setControlSpawn, hasControlSpawn, deleteControlSpawn, listControlSpawns } from './controlSpawnRegistry';
import { requestParticleControl, reflectParticleScrub, resetScrubParticleReflect, noteScrubParticleState, type ParticleControlAction } from './particleControlRegistry';
import { buildEntityIndex, resolveTrackTarget, applyClipAtTime, applyClipAtTimeBlended, type EntityIndex } from '../animation/sampleClip';
import { applyClipDeform } from './deform2DSystem';
import { beginDeform2DFrame } from './deform2DBuffers';
import { resolveClipByName } from '../animation/animClipBank';
import { getAnimationClip } from '../loaders/animationClipCache';
import type { TimelineDef, AnimationTrackDef, AnimationClipBlock, ControlTrackDef, ControlClipBlock } from '../timeline/types';

/** Scrub window (seconds) an IMPULSE particle control clip (no duration) is treated as "on" so a
 *  scrub onto it reveals the burst. Editor-preview affordance only — forward Play/preview fires the
 *  impulse as a one-shot edge, not a window. */
const PARTICLE_IMPULSE_SCRUB_S = 0.5;

/** Advance a playhead by `dt`, honoring loop/clamp against `duration`. (Local copy of
 *  animation/advanceClipTime semantics — kept here so the timeline owns its wrap policy.) */
function advance(time: number, dt: number, duration: number, loop: boolean): number {
  let t = time + dt;
  if (duration <= 0) return 0;
  if (loop) { t %= duration; if (t < 0) t += duration; return t; }
  return t < 0 ? 0 : t > duration ? duration : t;
}

/** Did the playhead cross tick `t` this frame, over (prev, cur]? `advanced` is the SIGNED
 *  per-frame delta (simDelta × speed). v1 is FORWARD-ONLY: a non-positive `advanced` (paused,
 *  speed 0, or reverse playback — deferred) crosses nothing, which also prevents the loop-wrap
 *  branch from misfiring every frame during reverse play. When a single frame advances a FULL
 *  lap or more on a looping timeline (`advanced >= duration` — reachable via a large `speed`,
 *  since MAX_DELTA caps simDelta but not speed), every tick is treated as crossed so no marker
 *  in a skipped lap is dropped. On the first frame (`justStarted`) the interval is closed at the
 *  left so a marker at the start fires; on a single loop wrap (cur < prev) the covered interval
 *  is (prev, duration] ∪ [0, cur]. */
function crossed(prev: number, cur: number, t: number, loop: boolean, duration: number, justStarted: boolean, advanced: number): boolean {
  if (advanced <= 0) return false;                       // forward-only (v1); 0 = no motion
  if (loop && advanced >= duration) return true;         // full lap(s) this frame → everything fires
  if (loop && cur < prev) return (t > prev && t <= duration) || (t >= 0 && t <= cur);
  if (justStarted) return t >= prev && t <= cur;
  return t > prev && t <= cur;
}

/** The index of the clip block active at time `t` on an animation track: the last block whose
 *  `start <= t`, still within its `duration` when one is authored (else it holds until the next). */
function activeClipIndexAt(track: AnimationTrackDef, t: number): number {
  let idx = -1;
  for (let k = 0; k < track.clips.length; k++) {
    const c = track.clips[k];
    if (c.start > t) break;
    if (c.duration !== undefined && t >= c.start + c.duration) continue;
    idx = k;
  }
  return idx;
}

/** The clip block active at time `t` (or null). */
function activeClipAt(track: AnimationTrackDef, t: number): AnimationClipBlock | null {
  const i = activeClipIndexAt(track, t);
  return i < 0 ? null : track.clips[i];
}

/** One clip's contribution to the pose at `t`: its name, local time, and blend weight. */
interface ClipWeight { clip: string; localT: number; weight: number; }

/** The clip(s) posing an animation track at `t`, WITH crossfade weights. When the playhead is in
 *  the blend window after the active block's `start` AND there's a previous block, returns the
 *  outgoing clip (still advancing, fading out) + the incoming (fading in); otherwise a single
 *  full-weight clip. Empty before the first block.
 *
 *  The blend WINDOW width comes from one of two authoring models (Phase D):
 *   - **Overlap region (Unity-style):** if the previous block's authored END extends past this
 *     block's `start`, drag-created OVERLAP is the intent — the overlap width IS the crossfade
 *     window (weight ramps 0→1 across exactly the overlap `[cur.start, prev.end]`).
 *   - **Per-clip fade (Phase B fallback):** no authored overlap → use `fade` (the incoming clip's
 *     `fadeDuration`), a smooth transition without having to overlap the blocks.
 *  A window of 0 never blends. Non-overlapping timelines are byte-identical to Phase B. */
function activeClipsAt(track: AnimationTrackDef, t: number, fade: number): ClipWeight[] {
  const i = activeClipIndexAt(track, t);
  if (i < 0) return [];
  const cur = track.clips[i];
  const since = t - cur.start;
  if (i > 0) {
    const prev = track.clips[i - 1];
    const prevEnd = prev.duration !== undefined ? prev.start + prev.duration : undefined;
    const overlap = prevEnd !== undefined ? prevEnd - cur.start : 0; // > 0 ⇒ authored overlap
    const window = overlap > 0 ? overlap : fade;                     // overlap wins over per-clip fade
    if (window > 0 && since < window) {
      const w = since / window; // incoming weight 0→1 across the window
      return [
        { clip: prev.clip, localT: Math.max(0, t - prev.start), weight: 1 - w }, // outgoing, still moving
        { clip: cur.clip, localT: Math.max(0, since), weight: w },
      ];
    }
  }
  return [{ clip: cur.clip, localT: Math.max(0, since), weight: 1 }];
}

/** Write a keyframe Animator to an exact scrub pose: set the active clip NAME, PRE-SET the
 *  runtimeOnly `activeClip` to the SAME name (this suppresses animationSystem's clip-switch
 *  `time=0` reset — the load-bearing anti-fight guard), the absolute local time, and
 *  `playing:false` so animationSystem samples at exactly this time instead of advancing. */
function scrubAnimator(entity: Entity, clipName: string, localT: number): void {
  const cur = entity.get(Animator) as Record<string, unknown> | undefined;
  if (!cur) return;
  entity.set(Animator, { ...cur, clip: clipName, activeClip: clipName, time: Math.max(0, localT), playing: false });
}

/** Apply the idempotent STATE of a timeline at absolute time `t`: keyframe-Animator scrub
 *  poses + activation-span visibility. Shared by the runtime system and (future) editor
 *  scrub-preview — NO edge events fire here (those are the system's job). Skeletal/sprite
 *  animators are NOT scrubbed (v1); their clip is triggered on the boundary by the system. */
export function applyTimelineState(world: World, rootId: number, def: TimelineDef, t: number, index?: EntityIndex): void {
  const idx = index ?? buildEntityIndex(world);
  for (const track of def.tracks) {
    if (track.muted) continue;
    const targetId = resolveTrackTarget(idx, rootId, track.target);
    if (targetId === null) continue;
    const entity = idx.byId.get(targetId) as unknown as Entity | undefined;
    if (!entity) continue;
    if (track.type === 'animation') {
      const clip = activeClipAt(track, t);
      if (clip && clip.scrub !== false && entity.has(Animator)) scrubAnimator(entity, clip.clip, t - clip.start);
    } else if (track.type === 'activation') {
      const desired = track.spans.some((s) => t >= s.start && t < s.end);
      const cur = entity.get(EntityAttributes) as Record<string, unknown> | undefined;
      if (cur && cur.isActive !== desired) entity.set(EntityAttributes, { ...cur, isActive: desired });
    }
  }
}

/** Resolve + pose a Director's timeline at an absolute time (editor scrub entry point). */
export function resolveTimelineAt(world: World, director: Entity, t: number, index?: EntityIndex): void {
  if (!director.isAlive() || !director.has(Director)) return;
  const d = director.get(Director) as { timeline: string } | undefined;
  if (!d?.timeline) return;
  const def = getTimeline(d.timeline);
  if (def) applyTimelineState(world, director.id(), def, t, index);
}

/** Editor scrub-preview: pose STATE (applyTimelineState — Animator fields + activation) AND
 *  additionally SAMPLE each animation clip to an exact frame, so a STOPPED SceneView shows the
 *  pose. The runtime relies on animationSystem / the skeletal mixer to sample, both sim-gated off
 *  while stopped — this fills that gap for the editor. No edge events fire (idempotent).
 *
 *  Two animator flavours, sampled two ways:
 *   - keyframe `Animator` (2D deform / scalar) → `applyClipAtTime` writes the exact pose here.
 *   - 3D `SkeletalAnimator` → its pose lives in a THREE mixer the render layer owns, so we can't
 *     sample it here; instead publish a SEEK request (`requestSkeletalSeek`) that
 *     `scene3DSync.syncSkinnedModels` consumes, posing the mixer to `action.time = localT`. Seeks
 *     are cleared + rebuilt every scrub so a scrub before the first clip (no active block) leaves
 *     the rig un-seeked. (Sprite/flipbook animators remain trigger-only — no arbitrary seek.) */
export function previewTimelineAt(world: World, rootId: number, def: TimelineDef, t: number, index?: EntityIndex, clearSeeks = true): void {
  const idx = index ?? buildEntityIndex(world);
  applyTimelineState(world, rootId, def, t, idx);
  // Clear the skeletal-seek registry before rebuilding this pose's seeks. A NESTED preview (a
  // sub-director posed within the same step) passes `clearSeeks:false` so it ACCUMULATES onto the
  // parent's seeks instead of wiping them — the caller (`previewTimelineStep`) clears once up front.
  if (clearSeeks) clearSkeletalSeeks(); // rebuilt below from the tracks active at this playhead
  // Fresh deform epoch so a scrubbed 2D-mesh clip previews cloth/cape deformation exactly as it
  // plays at runtime (a part not re-written this pass reads back as "no deform"). No-op for
  // scalar-only clips. Mirrors animationSystem.
  beginDeform2DFrame();
  for (const track of def.tracks) {
    if (track.muted || track.type !== 'animation') continue;
    const targetId = resolveTrackTarget(idx, rootId, track.target);
    if (targetId === null) continue;
    const entity = idx.byId.get(targetId) as unknown as Entity | undefined;
    if (!entity) continue;
    const active = activeClipAt(track, t);
    if (!active || active.scrub === false) continue;
    if (entity.has(Animator)) {
      const anim = entity.get(Animator) as { clips: string; clip?: string; fadeDuration?: number } | undefined;
      if (!anim) continue;
      // Crossfade duration = the incoming clip's per-clip fade (bank) or the animator default —
      // the SAME source animationSystem uses during Play.
      const bank = resolveClipByName(anim, active.clip);
      const fade = bank?.fadeDuration ?? anim.fadeDuration ?? 0;
      const parts = activeClipsAt(track, t, fade);
      const defOf = (name: string) => { const e = resolveClipByName(anim, name); return e ? getAnimationClip(e.ref) : null; };
      if (parts.length === 2) {
        const from = defOf(parts[0].clip), to = defOf(parts[1].clip);
        if (from && to) applyClipAtTimeBlended(world, targetId, { clip: from, time: parts[0].localT }, { clip: to, time: parts[1].localT }, parts[1].weight, idx);
        else if (to) applyClipAtTime(world, targetId, to, parts[1].localT, idx);
        if (to) applyClipDeform(world, targetId, to, parts[1].localT, idx); // incoming drives deform at full (matches animationSystem)
      } else if (parts.length === 1) {
        const d = defOf(parts[0].clip);
        if (d) { applyClipAtTime(world, targetId, d, parts[0].localT, idx); applyClipDeform(world, targetId, d, parts[0].localT, idx); }
      }
    } else if (entity.has(SkeletalAnimator)) {
      // 3D skeletal — the render layer seeks/blends the mixer to these exact times (Phase 5/B).
      const sa = entity.get(SkeletalAnimator) as { fadeDuration?: number } | undefined;
      const parts = activeClipsAt(track, t, sa?.fadeDuration ?? 0);
      requestSkeletalSeek(targetId, parts.map((p) => ({ clip: p.clip, time: p.localT, weight: p.weight })));
    }
  }
}

/** Editor SCRUB-time control STATE: reconcile control-track PREFAB presence to the playhead at `t`
 *  — spawn a prefab when `t` is inside its clip span and it isn't already present, despawn it when
 *  outside. Idempotent (works dragging BOTH directions), unlike `applyDirectorFrame`'s edge-based
 *  control (Play / forward-preview), so scrubbing shows the spark appear/disappear. Shares the
 *  `controlSpawnRegistry` keys with Play, so ▶ Preview reconciles cleanly over a scrub. Particle
 *  clips reflect an on/off window; SUB-DIRECTOR clips recursively POSE the child Director at its
 *  parent-synced time (so nested cutscenes scrub too). NO journal (scrub is silent state). Editor-
 *  only; a shipped game never calls it. `visited` guards A→…→A sub-director cycles (top call empty).
 *  Call `clearPreviewControls` on teardown (panel unmount) to destroy anything left spawned. */
export function previewControlAt(world: World, rootId: number, def: TimelineDef, t: number, index?: EntityIndex, visited: Set<number> = new Set()): void {
  const idx = index ?? buildEntityIndex(world);
  for (const track of def.tracks) {
    if (track.type !== 'control') continue;
    const resolved = resolveTrackTarget(idx, rootId, track.target);
    const parentId = resolved ?? rootId;
    // Particle reflect (Phase 5): the target emitter is ON while the playhead is inside any particle
    // clip's window, OFF otherwise. A SPAN clip (has duration) is ON for its whole duration; an
    // IMPULSE clip (no duration) is a one-shot burst, shown for a short scrub window `PARTICLE_IMPULSE_SCRUB_S`
    // so scrubbing ONTO it still reveals the emit (a particle sim can't be seeked, so this just shows
    // the burst starting). reflect* is idempotent (fires only on an on/off transition) so a drag
    // within a window doesn't reset the burst every frame.
    if (resolved != null && resolved >= 0) {
      let hasParticleClip = false;
      let on = false;
      for (const clip of track.clips) {
        if (!clip.particle) continue;
        hasParticleClip = true;
        const end = clip.start + (clip.duration ?? PARTICLE_IMPULSE_SCRUB_S);
        if (!track.muted && t >= clip.start && t < end) on = true;
      }
      if (hasParticleClip) reflectParticleScrub(resolved, on);
    }
    for (let ci = 0; ci < track.clips.length; ci++) {
      const clip = track.clips[ci];
      if (!clip.prefab) continue; // only prefab clips have scrubbable presence
      const key = `${rootId}:${track.id}:${ci}`;
      const end = clip.duration !== undefined ? clip.start + clip.duration : Infinity;
      const inside = !track.muted && t >= clip.start && t < end;
      if (inside && !hasControlSpawn(key)) {
        const data = getCachedPrefab(clip.prefab) as { entities: { localId?: number; traits: Record<string, unknown> }[]; rootLocalId?: number; id?: string } | undefined;
        if (data) {
          // forceTransient: a scrub reconciler spawn is ALWAYS an editor-preview artifact — it can run
          // from the commit/undo pose while RunMode is still `stopped`, so tag it Transient regardless
          // of mode so the serializer never lets it leak into the authored scene (timeline review C1).
          const id = spawnPrefabInstance(world, data, { parentId, guidSeed: `scrub:${rootId}:${track.id}:${ci}`, rootTransform: clip.transform as Record<string, unknown> | undefined, forceTransient: true });
          if (id) setControlSpawn(key, id);
        }
      } else if (!inside && hasControlSpawn(key)) {
        controlDestroy(key);
      }
    }
    // Sub-director SCRUB (nested pose): while the playhead is inside a `subdirector` clip's span, pose
    // the child Director at its synced local time (parentT − clip.start). Idempotent + silent (no
    // edges) — the scrub twin of driveSubdirector. Skeletal seeks ACCUMULATE (clearSeeks:false) onto
    // the parent's, which the scrub caller cleared once. Child mutations revert with the session.
    if (resolved != null && resolved !== rootId && !visited.has(resolved)) {
      for (const clip of track.clips) {
        if (!clip.subdirector) continue;
        const child = idx.byId.get(resolved) as unknown as Entity | undefined;
        if (!child || !child.has(Director)) continue;
        const cd = child.get(Director) as { timeline?: string } | undefined;
        const childDef = cd?.timeline ? getTimeline(cd.timeline) : undefined;
        if (!childDef) continue;
        const clipEnd = clip.start + (clip.duration ?? childDef.duration);
        const nested = new Set(visited); nested.add(rootId); nested.add(resolved);
        if (track.muted || t < clip.start || t >= clipEnd) {
          // Outside the span → the child is INACTIVE. Don't just `continue`: reconcile the child's OWN
          // control tracks fully OFF (despawn its nested prefabs, particle emitters off) by reposing it
          // at a time before every clip — else a scrubbed-off nested cutscene leaves its sparks/emitters
          // lingering in the SceneView (review C4). Idempotent: a no-op when the child spawned nothing.
          previewControlAt(world, resolved, childDef, Number.NEGATIVE_INFINITY, idx, nested);
          continue;
        }
        const childT = Math.max(0, Math.min(childDef.duration, t - clip.start));
        previewTimelineAt(world, resolved, childDef, childT, idx, false); // accumulate onto parent's seeks
        previewControlAt(world, resolved, childDef, childT, idx, nested); // recurse: nested control tracks
        child.set(Director, { ...(cd as object), time: childT, lastTime: childT }); // read-back for inspection
      }
    }
  }
}

/** Destroy every control-track prefab instance still tracked and clear the registry — editor scrub
 *  teardown (panel unmount / asset switch) so a scrub-spawned prefab never lingers into the authored
 *  world or a save. (Scene swap already drops the map via `onWorldSwap`; this also destroys.) */
export function clearPreviewControls(): void {
  for (const [key, id] of listControlSpawns()) { deleteEntity(id); deleteControlSpawn(key); }
  resetScrubParticleReflect(); // drop scrub particle-span on/off memory on teardown
}

// ── Control track (prefab spawn/despawn) ──────────────────────────────────────────────────────

/** Destroy the instance tracked under `key` (if any) and forget it. No journal — the caller
 *  decides whether the edge is journaled (a clip-end despawn is; a loop re-spawn cleanup isn't). */
function controlDestroy(key: string): void {
  const id = getControlSpawn(key);
  if (id === undefined) return;
  deleteControlSpawn(key);
  deleteEntity(id);
}

/** Journal + destroy at a clip's END. `@control` fires on the edge regardless of whether anything
 *  was actually spawned (parity with the spawn edge), so it's a reliable headless verification
 *  trace even when the prefab wasn't loaded. */
function controlDespawn(world: World, director: Entity, key: string): void {
  emit('@control', { director: entityRef(director), phase: 'despawn' }, world);
  controlDestroy(key);
}

/** Spawn a control clip's prefab under `parentId` and track it under `key`. Journals `@control`
 *  regardless (like an audio cue), so headless tests assert the edge without a loadable prefab;
 *  a not-yet-loaded prefab is a no-op spawn. A re-spawn (loop) destroys the prior instance first
 *  (no despawn journal for that internal cleanup).
 *
 *  `guidSeed` is a DETERMINISTIC seed (built from the Director's stable guid + track/clip index, not
 *  a runtime entity id) so the spawned instance's root guid replays byte-identically — control
 *  spawns fire on the deterministic sim playhead, so a random guid would corrupt the event journal. */
function controlSpawn(world: World, director: Entity, key: string, prefabRef: string, parentId: number, guidSeed: string, rootTransform?: ControlClipBlock['transform']): void {
  if (hasControlSpawn(key)) controlDestroy(key);
  emit('@control', { director: entityRef(director), prefab: prefabRef, phase: 'spawn' }, world);
  const data = getCachedPrefab(prefabRef) as { entities: { localId?: number; traits: Record<string, unknown> }[]; rootLocalId?: number; id?: string } | undefined;
  if (!data) return; // not loaded — journaled but nothing to spawn
  // The clip's optional per-field transform overrides the spawned root's LOCAL pose (relative to the
  // parent target) — one prefab can spawn at different places/rotations/scales per clip.
  const id = spawnPrefabInstance(world, data, { parentId, guidSeed, rootTransform: rootTransform as Record<string, unknown> | undefined });
  if (id) setControlSpawn(key, id);
}

/** Journal + request a particle action on a control clip's edge (Phase E). Journals `@control`
 *  regardless (parity with spawn/despawn — a reliable headless trace even with no renderer), then
 *  writes the restart/pause request for `targetId` that `syncParticles` drains in the render layer.
 *  `targetId < 0` means the track target didn't resolve — still journals the edge, no request. */
function controlParticle(world: World, director: Entity, targetId: number, action: ParticleControlAction): void {
  emit('@control', { director: entityRef(director), phase: action === 'restart' ? 'particle' : 'particle-pause' }, world);
  if (targetId >= 0) {
    requestParticleControl(targetId, action);
    // Keep the scrub-reflect memory in sync with what forward preview just did to this emitter, so a
    // scrub taking over after a paused preview sees the true on/off and can pause a still-running emitter
    // (review C8). 'restart' → ON, 'pause' → OFF.
    noteScrubParticleState(targetId, action === 'restart');
  }
}

// ── Sub-directors (Phase F — nested timelines) ────────────────────────────────────────────────

const _warnedSubCycle = new Set<number>();

/** Memoized "does this timeline have ANY sub-director control clip?" A `.timeline.json` is immutable
 *  once loaded (a re-import replaces the def object), so a WeakMap keyed on the def is a stable,
 *  self-evicting cache. Lets the per-frame slaving scan skip the O(tracks×clips) walk for the common
 *  case (no nested timelines) — a plain O(1) lookup instead (review C9). */
const _hasSubdir = new WeakMap<TimelineDef, boolean>();
function timelineHasSubdirector(def: TimelineDef): boolean {
  const memo = _hasSubdir.get(def);
  if (memo !== undefined) return memo;
  let has = false;
  for (const track of def.tracks) {
    if (track.type !== 'control' || track.muted) continue;
    if (track.clips.some((c) => c.subdirector)) { has = true; break; }
  }
  _hasSubdir.set(def, has);
  return has;
}

const _EMPTY_SLAVED: ReadonlySet<number> = new Set();

/** The set of child Director entity ids that are SLAVED — i.e. a non-muted `subdirector` control clip
 *  in some parent Director's timeline targets them. A slaved child must NOT self-advance in the normal
 *  query pass; its parent drives its frame synced to the clip (single authority, no double-fire). Scans
 *  ALL directors (not only playing ones): a parent-controlled child freezes when its parent isn't
 *  advancing, which is the correct "the parent owns me" semantics and avoids any double-run.
 *
 *  A MUTED subdirector track does NOT slave its child (review, muted-track consistency): muting the
 *  track means the parent stops driving it, so the child runs on its own clock instead of freezing
 *  (frozen was the old inconsistent behaviour — slaved here yet skipped by `applyDirectorFrame`'s
 *  muted guard, so it neither self-advanced nor was driven). Returns a shared empty set (no alloc)
 *  when no timeline nests, the common case. */
function collectSlavedDirectors(world: World, index: EntityIndex): ReadonlySet<number> {
  let slaved: Set<number> | undefined;
  world.query(Director).updateEach(([dir], entity) => {
    const def = getTimeline((dir as { timeline: string }).timeline);
    if (!def || !timelineHasSubdirector(def)) return; // O(1) skip for non-nesting timelines
    for (const track of def.tracks) {
      if (track.type !== 'control' || track.muted) continue; // muted → don't slave (child stays free)
      for (const clip of track.clips) {
        if (!clip.subdirector) continue;
        const childId = resolveTrackTarget(index, entity.id(), track.target);
        if (childId !== null && childId !== entity.id()) (slaved ??= new Set()).add(childId);
      }
    }
  });
  return slaved ?? _EMPTY_SLAVED;
}

/** Drive the track target's nested `Director` synced to a `subdirector` clip (Phase F). The child's
 *  local time = parentTime − clip.start, clamped to the child timeline's duration, playing across
 *  `[start, start + (duration ?? childDuration)]`. Runs the child's `applyDirectorFrame` with the
 *  SAME pose/skeletalTrigger opts (so nested Play triggers skeletal + fires signals/audio/activation),
 *  attributing the child's `@marker`/`@sequence` events to the child. `visited` guards A→…→A cycles;
 *  nesting depth is natural (a slaved child that is itself a parent recurses through here). */
function driveSubdirector(
  world: World, p: Pending, index: EntityIndex,
  opts: ApplyOpts, track: ControlTrackDef, clip: ControlClipBlock, visited: Set<number>, driven: Set<number>,
): void {
  const childId = resolveTrackTarget(index, p.rootId, track.target);
  if (childId === null) return;
  // A director can't be its own sub-director (target "" / itself): recursing would rewind its own
  // playhead via the read-back below. Guard both self and any A→…→A chain already on the stack.
  if (childId === p.rootId || visited.has(childId)) {
    if (!_warnedSubCycle.has(childId)) { _warnedSubCycle.add(childId); console.warn(`[timeline] sub-director cycle/self-reference at entity ${childId} — skipping to avoid infinite recursion`); }
    return;
  }
  const child = index.byId.get(childId) as unknown as Entity | undefined;
  if (!child || !child.has(Director)) return;
  const cd = child.get(Director) as { timeline: string } | undefined;
  const childDef = cd?.timeline ? getTimeline(cd.timeline) : undefined;
  if (!childDef) return;

  const cDur = childDef.duration;
  const clipEnd = clip.start + (clip.duration ?? cDur);
  const atStart = crossed(p.prev, p.cur, clip.start, p.loop, p.duration, p.justStarted, p.advanced);
  const atEnd = crossed(p.prev, p.cur, clipEnd, p.loop, p.duration, p.justStarted, p.advanced);
  const inSpan = p.cur >= clip.start && p.cur < clipEnd;
  if (!inSpan && !atStart && !atEnd) return; // outside the clip → child frozen (slaved: never self-runs)

  if (driven.has(childId)) return; // already driven this frame via another edge (diamond / two clips
  driven.add(childId);             // targeting the same child) — run once, no double sinks (review C3)

  const clampT = (x: number) => Math.max(0, Math.min(cDur, x));
  const childCur = clampT(p.cur - clip.start);
  const childPrev = clampT(p.prev - clip.start);
  // The child's END fires EXACTLY once, on the frame it reaches its effective play-end in child-local
  // time — `min(cDur, clip span)`. A clip LONGER than the child ends at cDur (child finishes early,
  // then held); a clip SHORTER truncates the child at the clip span. Folding both into one edge fixes
  // the double-fire where `atEnd || (childCur>=cDur...)` fired twice for a clip longer than the child
  // (once at cDur, again when the parent later crossed clipEnd) — review C2.
  const childEndLocal = clip.duration !== undefined ? Math.min(cDur, clip.duration) : cDur;
  const cp: Pending = {
    entity: child, rootId: childId, def: childDef, prev: childPrev, cur: childCur, loop: false,
    duration: cDur, justStarted: atStart, justEnded: childCur >= childEndLocal && childPrev < childEndLocal,
    advanced: childCur - childPrev,
  };
  const nested = new Set(visited); nested.add(p.rootId); nested.add(childId);
  applyDirectorFrame(world, cp, index, opts, nested, driven);

  // Read-back the child's synced playhead so Percept/inspection shows the nested time.
  child.set(Director, { ...(child.get(Director) as object), time: childCur, lastTime: childPrev, started: !cp.justEnded });
}

/** Fire the declarative `OnSequence` action for a start/end phase. Pipeline-safe. */
function fireOnSequence(director: Entity, phase: 'start' | 'end'): void {
  if (!director.isAlive() || !director.has(OnSequence)) return;
  const r = director.get(OnSequence) as { onStart: string; onEnd: string };
  const name = phase === 'start' ? r.onStart : r.onEnd;
  if (!name) return;
  dispatchGameAction(name, { target: director, params: { self: director, phase } });
}

/** Route ONE sequence start/end to all three sinks (journal + code bus + OnSequence). */
function routeSequence(world: World, director: Entity, phase: 'start' | 'end'): void {
  emit('@sequence', { director: entityRef(director), phase }, world);
  if (phase === 'start') timelineEvents.__emitStart(world, director);
  else timelineEvents.__emitEnd(world, director);
  fireOnSequence(director, phase);
}

interface Pending {
  entity: Entity;
  rootId: number;
  def: TimelineDef;
  prev: number;
  cur: number;
  loop: boolean;
  duration: number;
  justStarted: boolean;
  justEnded: boolean;
  advanced: number;
}

/** The two knobs that differ between the callers of `applyDirectorFrame`, plus a `poseFor` factory
 *  (parameterized by root/def/time so a parent frame can pose ITS OWN root and, recursively, a
 *  sub-director's root — the fixed single-root `pose()` couldn't). */
interface ApplyOpts {
  /** Pose the given director root at time `t`: Play → `applyTimelineState`; preview → `previewTimelineAt`. */
  poseFor: (rootId: number, def: TimelineDef, t: number) => void;
  /** Play fires `engine.playClip` at a skeletal block start; preview seeks in `poseFor` (so skip). */
  skeletalTrigger: boolean;
  /** Drive `subdirector` control clips (nest child timelines). Set in BOTH real Play and editor ▶
   *  preview — the nested child's skeletal seek accumulates onto the parent's (preview clears the seek
   *  set once up front, then each nested pose passes `clearSeeks:false`). */
  driveSubdirectors: boolean;
}

/** Apply ONE director's frame: sequence start → pose → edge-triggered per-track events →
 *  sequence end. Shared by the runtime `timelineSystem` (real Play) and the editor
 *  `previewTimelineStep` (panel ▶ preview), so both fan out signals/audio/OnSequence identically.
 *
 *  The caller-specific behaviour lives in `opts` (`ApplyOpts`): `poseFor` (Play vs preview posing),
 *  `skeletalTrigger` (trigger vs seek), and `driveSubdirectors` (nest child timelines — Play + preview).
 *  `visited` carries the sub-director chain's Director ids to guard A→…→A cycles (top call = empty).
 *  `driven` is the FRAME-GLOBAL set of child ids already driven this frame (shared across ALL top-level
 *  directors in a pass), so a child reached by two edges — a diamond, or two clips targeting it — runs
 *  at most once per frame (review C3); distinct from the per-chain `visited`. */
function applyDirectorFrame(world: World, p: Pending, index: EntityIndex, opts: ApplyOpts, visited: Set<number>, driven: Set<number>): void {
  if (p.justStarted) routeSequence(world, p.entity, 'start');
  opts.poseFor(p.rootId, p.def, p.cur);
  for (const track of p.def.tracks) {
    if (track.muted) continue;
    switch (track.type) {
      case 'signal':
        for (const m of track.markers) {
          if (crossed(p.prev, p.cur, m.t, p.loop, p.duration, p.justStarted, p.advanced)) {
            dispatchGameAction(m.action, { target: p.entity, params: { self: p.entity, ...(m.params ?? {}) } });
            emit('@marker', { director: entityRef(p.entity), action: m.action, t: m.t }, world);
            timelineEvents.__emitMarker(world, p.entity, m.action, m.t);
          }
        }
        break;
      case 'audio':
        for (const c of track.cues) {
          if (crossed(p.prev, p.cur, c.t, p.loop, p.duration, p.justStarted, p.advanced)) {
            cueClip(c.clip, { bus: c.bus as 'master' | 'music' | 'sfx' | 'ui' | undefined, volume: c.volume, pitch: c.pitch }, world);
            emit('@cue', { director: entityRef(p.entity), clip: c.clip, t: c.t }, world);
          }
        }
        break;
      case 'animation': {
        // Keyframe Animators are posed by pose(); skeletal/sprite are triggered here (Play) or
        // seeked by pose() (preview → skeletalTrigger false, skip).
        if (!opts.skeletalTrigger) break;
        const targetId = resolveTrackTarget(index, p.rootId, track.target);
        if (targetId === null) break;
        const entity = index.byId.get(targetId) as unknown as Entity | undefined;
        if (!entity || entity.has(Animator)) break;
        for (const clip of track.clips) {
          if (crossed(p.prev, p.cur, clip.start, p.loop, p.duration, p.justStarted, p.advanced)) {
            dispatchGameAction('engine.playClip', { target: entity, params: { clip: clip.clip } });
          }
        }
        break;
      }
      case 'control': {
        // Three clip kinds (all fire in Play AND ▶ preview — a preview spawn is reverted by the
        // snapshot reload; subdirector nests via driveSubdirectors, set in both):
        //   prefab      → spawn at start UNDER the track target (Director root when ""), destroy at end.
        //   particle    → RESTART the track target's ParticleEmitter at start, pause it at end.
        //   subdirector → drive the track target's nested Director synced across the clip span.
        const resolvedTarget = resolveTrackTarget(index, p.rootId, track.target);
        const parentId = resolvedTarget ?? p.rootId;
        // Registry key uses the runtime rootId (world-local, cleared on swap); the guid seed uses the
        // Director's STABLE ref (guid) so a control-spawned instance's guid is replay-deterministic.
        const dirRef = entityRef(p.entity);
        for (let ci = 0; ci < track.clips.length; ci++) {
          const clip = track.clips[ci];
          if (clip.subdirector) {
            if (opts.driveSubdirectors) driveSubdirector(world, p, index, opts, track, clip, visited, driven);
            continue;
          }
          const key = `${p.rootId}:${track.id}:${ci}`;
          const atStart = crossed(p.prev, p.cur, clip.start, p.loop, p.duration, p.justStarted, p.advanced);
          const atEnd = clip.duration !== undefined && crossed(p.prev, p.cur, clip.start + clip.duration, p.loop, p.duration, p.justStarted, p.advanced);
          if (clip.particle) {
            if (atStart) controlParticle(world, p.entity, resolvedTarget ?? -1, 'restart');
            if (atEnd) controlParticle(world, p.entity, resolvedTarget ?? -1, 'pause');
          } else {
            if (atStart) controlSpawn(world, p.entity, key, clip.prefab ?? '', parentId, `control:${dirRef}:${track.id}:${ci}`, clip.transform);
            if (atEnd) controlDespawn(world, p.entity, key);
          }
        }
        break;
      }
      case 'activation':
        break; // handled by pose()
    }
  }
  if (p.justEnded) routeSequence(world, p.entity, 'end');
}

/** Editor forward-preview step: advance the panel's playhead from `prevT` to `curT` and apply the
 *  same fan-out `timelineSystem` does — poses (keyframe + skeletal seek + activation) AND
 *  edge-fires signals/audio/OnSequence over `(prevT, curT]`. The panel gates the audio + dispatch
 *  side effects via `setTimelinePreviewActive` and snapshots/restores the world around the session.
 *  Forward-only, non-looping. `justStarted` fires the sequence-start + any t=0 marker on the first
 *  step from the beginning; `justEnded` fires the sequence-end on the step that reaches `duration`. */
export function previewTimelineStep(
  world: World, rootId: number, def: TimelineDef, prevT: number, curT: number,
  flags?: { justStarted?: boolean; justEnded?: boolean }, index?: EntityIndex,
): void {
  const idx = index ?? buildEntityIndex(world);
  // NOTE: the scrub-reflect memory is NOT wiped here — `controlParticle` keeps it in sync with each
  // forward edge instead (noteScrubParticleState), so a scrub taking over after a paused preview sees
  // the emitter's true on/off and can pause a still-running one (review C8). Teardown/world-swap still
  // reset it via clearPreviewControls / onWorldSwap.
  clearSkeletalSeeks(); // clear ONCE per step; the parent + any nested sub-director poses ACCUMULATE onto it (clearSeeks:false below)
  const entity = idx.byId.get(rootId) as unknown as Entity | undefined;
  if (!entity) { previewTimelineAt(world, rootId, def, curT, idx); return; }
  const p: Pending = {
    entity, rootId, def, prev: prevT, cur: curT, loop: false, duration: def.duration,
    justStarted: !!flags?.justStarted, justEnded: !!flags?.justEnded, advanced: curT - prevT,
  };
  applyDirectorFrame(world, p, idx, {
    skeletalTrigger: false,
    driveSubdirectors: true, // ▶ preview NESTS: drive sub-director clips so nested timelines play (the
    // child's skeletal seek accumulates onto the parent's via poseFor's clearSeeks:false + the
    // clear-once above). Child mutations (Director.time read-back, spawns) revert with the session.
    poseFor: (rid, d, t) => previewTimelineAt(world, rid, d, t, idx, false),
  }, new Set(), new Set());
}

export function timelineSystem(world: World): void {
  const time = getTime(world);
  if (!time) return;
  const simDelta = getSimDelta(world); // 0 when the sim isn't running → system is inert

  // Cheap existence check so timeline-less games skip the index build + slaving scan entirely.
  let anyDirector = false;
  world.query(Director).updateEach(() => { anyDirector = true; });
  if (!anyDirector) return;

  // Shared name-path index (once) + the SLAVED-child set (Phase F): a child driven by a parent's
  // subdirector clip must not self-advance here — its parent runs its frame in PASS 2.
  const index = buildEntityIndex(world);
  const slaved = collectSlavedDirectors(world, index);

  // PASS 1 — collect. Integrate each NON-slaved playhead + stage a record; never emit/dispatch/
  // set-on-other-entities inside the query.
  const pending: Pending[] = [];
  world.query(Director).updateEach(([dir], entity) => {
    if (entity.has(Paused)) return;
    if (slaved.has(entity.id())) return; // parent-driven sub-director — skip self-advance (Phase F)
    if (!dir.playing) return;
    const def = getTimeline(dir.timeline);
    if (!def) return; // lazy — retry next frame

    const duration = def.duration;
    const loop = dir.loop;
    const prev = dir.time;
    const advanced = simDelta * dir.speed;
    // A director frozen at its start (global timeScale=0 time-stop, or speed=0) has NOT started: don't
    // consume `justStarted`/set `started` on a non-advancing first frame, else the sequence-start +
    // every t=0 edge (markers/cues fire via the justStarted left-closed interval, which needs advanced>0
    // in `crossed`) would be permanently dropped when playback later resumes. Deferring the whole
    // evaluation to the first ADVANCING frame fires start + the t=0 edges together, once — matching the
    // engine's "not running → no events" rule (review C6). A mid-playback pause (started already true)
    // is unaffected: it just holds, advancing nothing.
    if (advanced <= 0 && !dir.started) return;
    const justStarted = !dir.started;
    const cur = advance(prev, advanced, duration, loop);
    // Non-looping end: prev was below duration and we've now clamped to it. Clamp keeps cur at
    // duration on subsequent frames, so prev < duration is false then → fires exactly once.
    const justEnded = !loop && prev < duration && cur >= duration;

    dir.lastTime = prev;
    dir.time = cur;
    dir.started = true;

    pending.push({ entity, rootId: entity.id(), def, prev, cur, loop, duration, justStarted, justEnded, advanced });
  });

  if (pending.length === 0) return;

  // PASS 2 — apply. Real Play poses via applyTimelineState (animationSystem/mixer sample the rest),
  // triggers skeletal clips at their boundaries, and drives sub-directors (nested timelines). `driven`
  // is shared across ALL top-level directors this frame so a child reached by two parents' subdirector
  // clips (a diamond / shared child) runs exactly once (review C3).
  const driven = new Set<number>();
  for (const p of pending) {
    applyDirectorFrame(world, p, index, {
      skeletalTrigger: true,
      driveSubdirectors: true,
      poseFor: (rid, d, t) => applyTimelineState(world, rid, d, t, index),
    }, new Set(), driven);
  }
}
