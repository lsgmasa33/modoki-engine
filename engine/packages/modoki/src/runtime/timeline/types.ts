/**
 * Timeline / sequencer data model — the on-disk `.timeline.json` asset format.
 *
 * A timeline orchestrates EXISTING engine subsystems (animation, actions, audio,
 * activation) on a shared time axis; it does not reimplement them. Like an
 * `AnimationClipDef`, it is a REUSABLE, binding-free asset: every track targets an
 * entity by a relative name-path from the entity that carries the `Director` trait
 * (the "root") — "" is the root, "body/arm" is the descendant reached by matching
 * child `EntityAttributes.name`. So one cutscene plays against any subtree whose
 * child names match (Unity Timeline's asset/PlayableDirector split).
 *
 * The playing INSTANCE state (playhead time, speed, loop, playing) lives on the
 * `Director` trait, never in the asset — same as `Animator` vs `.anim.json`.
 *
 * v1 track kinds (each drives a subsystem the timeline does NOT own):
 *   - `animation`   → the target's animator (Animator/SpriteAnimator/SkeletalAnimator),
 *                     selected by clip NAME. A keyframe `Animator` is scrubbed to an
 *                     exact sample; skeletal/sprite are start-and-let-the-mixer-run.
 *   - `signal`      → a zero-duration marker that `dispatchGameAction`s at its tick.
 *   - `audio`       → cues a sound (`cueClip`) at its tick.
 *   - `activation`  → toggles the target's `EntityAttributes.isActive` for a span.
 *   - `control`     → instantiates a PREFAB at a clip's `start` (parented under the track target)
 *                     and destroys it at the clip's `end` — Unity's Control Track, prefab flavour.
 *                     A spawned prefab can carry a `ParticleEmitter`, so this covers "spawn an
 *                     effect on a beat". (Particle-system restart + nested sub-directors deferred.)
 */

export type TrackKind = 'animation' | 'signal' | 'audio' | 'activation' | 'control';

/** Shared fields on every track. `target` = relative name-path from the Director root. */
export interface TrackBase {
  /** Stable id (authoring/undo identity). */
  id: string;
  name: string;
  /** Relative name-path from the Director root. "" = the root itself. */
  target: string;
  /** When true the track is skipped at playback (authoring toggle). */
  muted?: boolean;
}

/** One clip block on an animation track. `clip` is a NAME in the target animator's
 *  bank (Animator.clips / SkeletalAnimator / SpriteAnimator). `scrub` (default true)
 *  drives a keyframe `Animator` to an exact per-frame sample; it is ignored for
 *  skeletal/sprite animators, which are triggered once at `start` and left to run. */
export interface AnimationClipBlock {
  start: number;
  /** Optional visual length (authoring/UI). Playback keys off `start` boundaries. */
  duration?: number;
  clip: string;
  scrub?: boolean;
}
export interface AnimationTrackDef extends TrackBase {
  type: 'animation';
  clips: AnimationClipBlock[];
}

/** A zero-duration signal — dispatches `action` (a UIAction name) at tick `t`. */
export interface SignalMarker {
  t: number;
  action: string;
  /** Extra params forwarded into the dispatched action's `ctx.params`. */
  params?: Record<string, unknown>;
}
export interface SignalTrackDef extends TrackBase {
  type: 'signal';
  markers: SignalMarker[];
}

/** A one-shot audio cue fired at tick `t`. `clip` is an audio GUID (or a bank key). */
export interface AudioCueBlock {
  t: number;
  clip: string;
  bus?: string;
  volume?: number;
  pitch?: number;
}
export interface AudioTrackDef extends TrackBase {
  type: 'audio';
  cues: AudioCueBlock[];
}

/** A span during which the target entity is active. `isActive=true` within
 *  [start, end), restored to its authored value outside every span. */
export interface ActivationSpan {
  start: number;
  end: number;
}
export interface ActivationTrackDef extends TrackBase {
  type: 'activation';
  spans: ActivationSpan[];
}

/** One clip on a control track — one of three kinds, discriminated by which field is set:
 *   - **prefab spawn** (`prefab` = a GUID): instantiate at `start`, destroy the instance at
 *     `start + duration` (or leave it if `duration` is omitted). Spawned UNDER the track target
 *     (the Director root when target is "").
 *   - **particle restart** (`particle: true`): RESTART the track target's `ParticleEmitter` at
 *     `start` (re-emit from t=0), and pause it at `start + duration` if a duration is set. Acts ON
 *     the track target (needs an entity carrying a `ParticleEmitter`).
 *   - **sub-director** (`subdirector: true`): drive the track target's own `Director` (a nested
 *     `.timeline.json`) SYNCED to this clip — its local time = parentTime − `start`, playing across
 *     `[start, start + (duration ?? childDuration)]`. Composes reusable sub-cutscenes; runtime-Play
 *     only (see `timelineSystem`). Acts ON the track target (needs an entity carrying a `Director`).
 *  The three are mutually exclusive; `normalizeTrack` drops a clip that is none. */
export interface ControlClipBlock {
  start: number;
  duration?: number;
  prefab?: string;
  particle?: boolean;
  subdirector?: boolean;
  /** PREFAB kind only — a per-field LOCAL Transform override for the spawned instance root (under
   *  the track target). Only the fields present override the prefab's authored root; omit for the
   *  prefab's own pose. Lets one prefab spawn at different places/rotations/scales per clip. */
  transform?: Partial<Record<'x' | 'y' | 'z' | 'rx' | 'ry' | 'rz' | 'sx' | 'sy' | 'sz', number>>;
}
export interface ControlTrackDef extends TrackBase {
  type: 'control';
  clips: ControlClipBlock[];
}

export type TrackDef = AnimationTrackDef | SignalTrackDef | AudioTrackDef | ActivationTrackDef | ControlTrackDef;

export interface TimelineDef {
  /** Stable GUID — mirrors the `.meta.json` sidecar id. */
  id: string;
  name: string;
  /** Total length in seconds; the Director playhead clamps/loops against this. */
  duration: number;
  /** Authoring sample rate, used for frame snapping in the editor. */
  frameRate: number;
  tracks: TrackDef[];
}

/** A fresh empty timeline (5 seconds, 30 fps). */
export function defaultTimeline(id: string, name = 'New Timeline'): TimelineDef {
  return { id, name, duration: 5, frameRate: 30, tracks: [] };
}

function num(x: unknown, fallback: number): number {
  return typeof x === 'number' && Number.isFinite(x) ? x : fallback;
}
function str(x: unknown, fallback = ''): string {
  return typeof x === 'string' ? x : fallback;
}

const TRS_FIELDS = ['x', 'y', 'z', 'rx', 'ry', 'rz', 'sx', 'sy', 'sz'] as const;
/** Sanitize a control-clip prefab transform override: keep only finite numeric TRS fields; return
 *  undefined when nothing valid remains (so an empty/absent override is simply omitted). */
function normalizeControlTransform(t: unknown): ControlClipBlock['transform'] | undefined {
  if (!t || typeof t !== 'object') return undefined;
  const src = t as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const k of TRS_FIELDS) {
    if (typeof src[k] === 'number' && Number.isFinite(src[k])) out[k] = src[k] as number;
  }
  return Object.keys(out).length ? out : undefined;
}

/** The audio-cue clip refs (GUIDs) a timeline references — the ONLY transitively-owned
 *  assets a timeline has no other owner for (animation clips resolve via the target
 *  Animator's bank). SceneManager resolves these to paths and acquires them scene-scoped
 *  so the buffers preload and survive the prod tree-shake. */
export function collectTimelineAudioRefs(def: TimelineDef): string[] {
  const out: string[] = [];
  for (const track of def.tracks) {
    if (track.type === 'audio') for (const c of track.cues) if (c.clip) out.push(c.clip);
  }
  return out;
}

/** The prefab refs (GUIDs) a timeline's control tracks reference — acquired scene-scoped like
 *  audio cues, so the prefab JSON + its transitive deps preload and survive the prod tree-shake. */
export function collectTimelineControlRefs(def: TimelineDef): string[] {
  const out: string[] = [];
  for (const track of def.tracks) {
    if (track.type === 'control') for (const c of track.clips) if (c.prefab) out.push(c.prefab);
  }
  return out;
}

/** Normalize one track by kind: fill defaults, drop malformed entries, sort by time.
 *  An unknown/invalid `type` yields null (dropped by the caller). */
function normalizeTrack(tr: Partial<TrackDef> & { type?: string }): TrackDef | null {
  const base = { id: str(tr.id), name: str((tr as TrackBase).name, 'Track'), target: str((tr as TrackBase).target), muted: (tr as TrackBase).muted === true };
  switch (tr.type) {
    case 'animation': {
      const clips = Array.isArray((tr as AnimationTrackDef).clips) ? (tr as AnimationTrackDef).clips : [];
      return {
        ...base, type: 'animation',
        clips: clips
          .filter((c) => c && typeof c.clip === 'string' && c.clip.length > 0)
          .map((c) => ({ start: num(c.start, 0), duration: c.duration === undefined ? undefined : num(c.duration, 0), clip: c.clip, scrub: c.scrub !== false }))
          .sort((a, b) => a.start - b.start),
      };
    }
    case 'signal': {
      const markers = Array.isArray((tr as SignalTrackDef).markers) ? (tr as SignalTrackDef).markers : [];
      return {
        ...base, type: 'signal',
        markers: markers
          .filter((m) => m && typeof m.action === 'string' && m.action.length > 0)
          .map((m) => ({ t: num(m.t, 0), action: m.action, params: m.params && typeof m.params === 'object' ? m.params : undefined }))
          .sort((a, b) => a.t - b.t),
      };
    }
    case 'audio': {
      const cues = Array.isArray((tr as AudioTrackDef).cues) ? (tr as AudioTrackDef).cues : [];
      return {
        ...base, type: 'audio',
        cues: cues
          .filter((c) => c && typeof c.clip === 'string' && c.clip.length > 0)
          .map((c) => ({ t: num(c.t, 0), clip: c.clip, bus: c.bus, volume: c.volume === undefined ? undefined : num(c.volume, 1), pitch: c.pitch === undefined ? undefined : num(c.pitch, 1) }))
          .sort((a, b) => a.t - b.t),
      };
    }
    case 'activation': {
      const spans = Array.isArray((tr as ActivationTrackDef).spans) ? (tr as ActivationTrackDef).spans : [];
      return {
        ...base, type: 'activation',
        spans: spans
          .filter((s) => s && (typeof s.start === 'number' || typeof s.end === 'number'))
          .map((s) => ({ start: num(s.start, 0), end: num(s.end, 0) }))
          .filter((s) => s.end > s.start)
          .sort((a, b) => a.start - b.start),
      };
    }
    case 'control': {
      const clips = Array.isArray((tr as ControlTrackDef).clips) ? (tr as ControlTrackDef).clips : [];
      return {
        ...base, type: 'control',
        clips: clips
          // Keep a clip that is a prefab spawn (non-empty prefab GUID), a particle restart
          // (particle:true), OR a sub-director (subdirector:true) — drop anything that is none.
          .filter((c) => c && ((typeof c.prefab === 'string' && c.prefab.length > 0) || c.particle === true || c.subdirector === true))
          .map((c) => {
            const start = num(c.start, 0);
            const duration = c.duration === undefined ? undefined : num(c.duration, 0);
            const hasPrefab = typeof c.prefab === 'string' && c.prefab.length > 0;
            // Precedence when over-specified: prefab > particle > subdirector (deterministic).
            if (hasPrefab) {
              const transform = normalizeControlTransform(c.transform);
              return transform ? { start, duration, prefab: c.prefab, transform } : { start, duration, prefab: c.prefab };
            }
            if (c.particle === true) return { start, duration, particle: true };
            return { start, duration, subdirector: true };
          })
          .sort((a, b) => a.start - b.start),
      };
    }
    default:
      return null;
  }
}

/** Fill any missing fields so partial/older JSON loads safely, and normalize every
 *  track (sort entries by time, drop malformed). Mirrors `normalizeAnimationClip`. */
export function normalizeTimeline(json: Partial<TimelineDef>): TimelineDef {
  return {
    id: str(json.id),
    name: str(json.name, 'Timeline'),
    duration: Math.max(0, num(json.duration, 5)),
    frameRate: (() => { const f = num(json.frameRate, 30); return f > 0 ? f : 30; })(),
    tracks: Array.isArray(json.tracks)
      ? json.tracks.map((tr) => normalizeTrack(tr as Partial<TrackDef> & { type?: string })).filter((t): t is TrackDef => t !== null)
      : [],
  };
}
