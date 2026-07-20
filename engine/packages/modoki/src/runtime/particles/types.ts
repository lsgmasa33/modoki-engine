/**
 * Particle system data model — Modoki's own, library-agnostic effect definition.
 *
 * This is the source of truth that the Particle Editor authors, the `.particle.json`
 * asset stores, and a `ParticleEmitter` entity references. The runtime renders it via
 * an {@link IParticleBackend} implementation (currently CPU simulation + instanced
 * SpriteNodeMaterial billboards). Keeping the schema independent of any rendering/sim
 * backend means we can swap in a GPU-compute backend later without touching the schema,
 * the editor, or saved assets.
 *
 * Numbers that vary per particle use {@link MinMax} (uniform random between min/max).
 * Properties that animate over a particle's life use {@link Curve} (piecewise-linear in
 * v1; bezier control points can be layered on later) or {@link Gradient} (color/alpha).
 */

/** Upper bound on a single frame's simulation step (seconds), applied by BOTH
 *  the CPU and GPU backends at their per-frame `update()`. A long/hitching frame
 *  (tab refocus, GC pause) would otherwise integrate a huge step — particles
 *  teleport, colliders are tunneled. Clamping identically in both backends keeps
 *  an effect looking the same regardless of which one runs it. NOTE: the pure
 *  CPU `step(dt)` simulator is intentionally NOT clamped — tests drive it with
 *  arbitrary dt; the clamp lives one level up, in the backend. */
export const MAX_SIM_DT = 0.05;

/** Clamp a per-frame step to [0, MAX_SIM_DT]. Both backends call this so they
 *  apply an identical ceiling and reject negative dt the same way. */
export const clampSimDt = (dt: number): number => Math.min(Math.max(dt, 0), MAX_SIM_DT);

/** Fixed timestep both backends use when seeking/prewarming an effect to a target
 *  time. Shared so CPU and GPU advance in identical increments (no drift). */
export const PREWARM_STEP = 1 / 30;

/** Cap on sim steps per seek() — bounds worst-case scrub cost (≈20 s at
 *  PREWARM_STEP). Shared so both backends approximate-past-the-cap identically. */
export const SEEK_MAX_STEPS = 600;

/** Number of fixed PREWARM_STEP increments to advance from `fromTime` to `toTime`,
 *  clamped to [0, SEEK_MAX_STEPS]. Both backends' seek() call this so the forward-step
 *  count AND the past-the-cap approximation match exactly across CPU and GPU (F3) — the
 *  drift-prone arithmetic lives in one place. (A backward seek is handled by the caller
 *  rewinding to 0 first; a negative span here just clamps to 0 steps.) */
export const seekSteps = (fromTime: number, toTime: number): number =>
  Math.min(SEEK_MAX_STEPS, Math.max(0, Math.floor((toTime - fromTime) / PREWARM_STEP)));

export interface MinMax {
  min: number;
  max: number;
}

/** Linear-space RGB, each channel 0..1. */
export interface RGB {
  r: number;
  g: number;
  b: number;
}

/** A single value keyframe: `t` is normalized lifetime 0..1, `v` the value. */
export interface CurvePoint {
  t: number;
  v: number;
}

/**
 * Piecewise-linear curve over normalized lifetime (0..1). Sorted by `t`.
 * `scale` multiplies the sampled value (lets the editor keep points in 0..1 and scale).
 */
export interface Curve {
  points: CurvePoint[];
  scale?: number;
}

export interface ColorStop {
  t: number;
  color: RGB;
}

export interface AlphaStop {
  t: number;
  alpha: number;
}

/** Color + alpha gradient over normalized lifetime (0..1). Stops sorted by `t`. */
export interface Gradient {
  colorStops: ColorStop[];
  alphaStops: AlphaStop[];
}

export type EmitterShapeType = 'point' | 'cone' | 'sphere' | 'box' | 'circle' | 'cylinder' | 'polyline';

export interface EmitterShape {
  type: EmitterShapeType;
  /** sphere / circle / cone / cylinder base (outer) radius. With `radiusStart`/`radiusEnd`
   *  unset, this is the outer radius and the inner radius is 0 (solid) — or `radius` itself
   *  when `fromShell` is true (a thin surface). */
  radius?: number;
  /**
   * Annular emission: particles spawn in the band between `radiusStart` (inner) and
   * `radiusEnd` (outer) for cone/sphere/circle/cylinder, with uniform area/volume density
   * (`r = sqrt(mix(in², out², u))` for discs, `cbrt` for the sphere volume). When unset they
   * fall back to the legacy `radius`/`fromShell` pair: `outer = radiusEnd ?? radius ?? 1`,
   * `inner = radiusStart ?? (fromShell ? outer : 0)`. So `{radius:R}` is a solid disc/ball and
   * `{radius:R, fromShell:true}` is a thin shell — both reproduced exactly.
   */
  radiusStart?: number;
  radiusEnd?: number;
  /** cone half-angle, degrees */
  angle?: number;
  /** box half-extents [x,y,z] */
  size?: [number, number, number];
  /**
   * Hollow box emission: particles spawn in the frame between an inner box (`sizeStart`,
   * half-extents) and an outer box (`sizeEnd`, half-extents). When `sizeStart` is unset the
   * box is a solid volume filled uniformly from `sizeEnd ?? size`. Half-extents, matching
   * `size`.
   */
  sizeStart?: [number, number, number];
  sizeEnd?: [number, number, number];
  /** cylinder: axis direction the length runs along (need not be unit length — normalized at
   *  runtime). Default `(0,1,0)`. */
  axis?: [number, number, number];
  /** cylinder: full length along `axis`. Default `1`. */
  length?: number;
  /** emit from the shell/surface only (vs the full volume) — legacy shorthand for
   *  `radiusStart === radiusEnd`. Superseded by `radiusStart`/`radiusEnd`. */
  fromShell?: boolean;
  /**
   * polyline (2D): emit along a connected chain of line segments in the emitter's local XY
   * plane. Each entry is a point `[x, y]`; particles spawn uniformly by **arc length** across
   * all segments (a long segment gets proportionally more particles). Needs ≥2 points; with
   * fewer it degrades to a point emitter at the first point (or the origin if empty). Ignored
   * by non-`polyline` shapes. Use it to emit along a blade edge, a ground line, or a UI border.
   */
  points?: [number, number][];
}

/**
 * Sprite blend. `normal`/`additive` are honored by both the 2D (PixiJS) and 3D (Three.js)
 * backends; `multiply`/`screen` are 2D-VFX modes — the 3D billboard backend maps them to
 * `normal` (it only special-cases additive), while the Pixi backend maps all four to the
 * matching `BLEND_MODES`.
 */
export type BlendMode = 'normal' | 'additive' | 'multiply' | 'screen';

/** Built-in geometry used when {@link RenderConfig.mode} is `'mesh'`. */
export type MeshPrimitive = 'box' | 'sphere' | 'cone' | 'tetra' | 'torus';

/**
 * Sprite-sheet playback over a particle's normalized lifetime (0..1):
 * - `once` — single forward pass, frame 0 → last, then holds the last frame (default).
 * - `loop` — cycle forward repeatedly ({@link RenderConfig.spriteCycles} times over the life).
 * - `pingpong` — forward then backward (flip-flop), repeating for `spriteCycles` cycles.
 */
export type SpriteMode = 'once' | 'loop' | 'pingpong';

export interface EmissionBurst {
  /** seconds into the system duration */
  time: number;
  count: number;
}

/** Continuous external force on every particle. */
export interface ForceField {
  /** 'directional' = constant wind along (x,y,z); 'point' = attract(+)/repel(−) toward (x,y,z). */
  type: 'directional' | 'point';
  x: number;
  y: number;
  z: number;
  strength: number;
}

/** Collider geometry particles can interact with. */
export type ColliderShape = 'plane' | 'sphere' | 'box' | 'cylinder';

/**
 * A solid collider particles interact with (kill on contact or bounce off). Three shapes:
 * - `plane` — a half-space defined by a surface normal + a point on the plane (the plane
 *   equation `n·(p − point) = 0`). Particles live on the +normal side; crossing to the
 *   back (`n·(p − point) < 0`) is a hit. The default normal `(0,1,0)` + point `(0,0,0)`
 *   reproduces the legacy infinite ground plane (and a saved `planeY` maps to point Y).
 * - `sphere` — a solid ball at `center` with `radius`; particles bounce off the outside.
 * - `box` — a solid axis-aligned box at `center` with full `width`/`height`/`depth`;
 *   particles exit through the face of least penetration.
 * - `cylinder` — a solid cylinder at `center` running along `axis`, with cross-section
 *   `radius` and full length `height`. Solid particles exit through the nearest surface
 *   (curved wall or an end cap, whichever is closer).
 *
 * Each shape can be inverted into a `container` (see `invert`). Both backends share the same
 * geometry math (`collide()` in colliders.ts ↔ the TSL kernel), so the look matches on CPU
 * or GPU.
 */
export interface CollisionConfig {
  mode: 'none' | 'kill' | 'bounce';
  /** velocity retained on bounce (0..1) */
  bounce: number;
  /** collider geometry (default `'plane'`) */
  shape?: ColliderShape;
  /**
   * Flip which region is solid. `false` (default) = a **solid** collider: particles are
   * kept *out* of it (killed/bounced when they enter — inside a sphere/box, behind a plane).
   * `true` = a **container**: particles are kept *in* it (killed/bounced when they leave —
   * outside a sphere/box, in front of a plane). Use a container sphere/box to trap an
   * effect within a volume (e.g. confine a galaxy to its disk, cull strays that drift out).
   */
  invert?: boolean;
  /** plane: surface normal (need not be unit length — normalized at runtime). Default `(0,1,0)`. */
  planeNormal?: [number, number, number];
  /** plane: a point lying on the plane. Default `(0,0,0)`. */
  planePoint?: [number, number, number];
  /** sphere/box/cylinder: center position. Default `(0,0,0)`. */
  center?: [number, number, number];
  /** sphere/cylinder: radius. Default `1`. */
  radius?: number;
  /** box: full width (X extent). Default `1`. */
  width?: number;
  /** box: full height (Y extent). cylinder: full length along `axis`. Default `1`. */
  height?: number;
  /** box: full depth (Z extent). Default `1`. */
  depth?: number;
  /** cylinder: axis direction the length runs along (normalized at runtime). Default `(0,1,0)`. */
  axis?: [number, number, number];
  /** @deprecated legacy infinite horizontal-plane height. Loaded assets migrate this to a
   *  `plane` collider with normal `(0,1,0)` and point `(0, planeY, 0)`. Authoring uses
   *  `planePoint` instead. */
  planeY?: number;
}

/** Curl-ish turbulence applied as acceleration. */
export interface NoiseConfig {
  strength: number;
  frequency: number;
  /** how fast the noise field scrolls over time */
  scrollSpeed?: number;
}

/** Motion trail drawn behind each particle from its recent position history. */
export interface TrailConfig {
  enabled: boolean;
  /** history points retained per particle (>= 2); more = longer trail */
  segments: number;
}

/**
 * A nested effect spawned in response to a parent particle's lifecycle event.
 * On each matching event the parent fires a burst of `count` child particles at
 * the event position (in the parent's local space — the child rides the parent
 * emitter transform). The child's own continuous emission is ignored; it is
 * driven purely by these triggered bursts. Nesting is depth-1 (a child effect's
 * own sub-emitters are not honored, preventing runaway recursion).
 */
export interface SubEmitter {
  /** when on the parent particle's life to fire: at spawn (`birth`) or death (`death`) */
  trigger: 'birth' | 'death';
  /** ref (GUID or path) to the child `.particle.json` effect */
  effect: string;
  /** particles emitted per trigger (default 8) */
  count?: number;
  /** 0..1 chance the burst fires for any given parent particle (default 1) */
  probability?: number;
  /** fraction of the parent particle's velocity passed to children (default 0) */
  inheritVelocity?: number;
}

export interface RenderConfig {
  blend: BlendMode;
  /** `'billboard'` (default) = camera-facing textured quads; `'mesh'` = instanced 3D primitives */
  mode?: 'billboard' | 'mesh';
  /**
   * Billboard width/height ratio (default 1 = square). Values < 1 make a tall quad,
   * > 1 a wide one. `startSize` controls the height; width = height × aspect. Use this
   * to match a non-square sprite-sheet cell (e.g. a tall lightning bolt at aspect 0.5)
   * so the texture renders without distortion or wasted transparent padding.
   */
  aspect?: number;
  /**
   * Billboard pivot. `'center'` (default) anchors the sprite at the particle position.
   * `'bottom'` anchors the bottom edge there, so the sprite grows upward from its base
   * — keeps a ground strike's impact planted (no apparent scaling around the middle)
   * and lets you place the emitter on the ground plane.
   */
  anchor?: 'center' | 'bottom';
  /**
   * Constant `[x, y]` offset of the sprite from its anchor, in units of `startSize`
   * (so it scales with the particle). Applied in billboard space after the anchor:
   * +x right, +y up. Use it to fine-tune where the art sits — e.g. nudge a bolt down
   * so its in-texture impact point (not the cell edge) lands exactly on the ground.
   */
  offset?: [number, number];
  /** mesh mode: which built-in primitive to instance (default `'box'`) */
  meshPrimitive?: MeshPrimitive;
  /** mesh mode: shade with scene lighting (true) or render flat/unlit (false, default) */
  meshLit?: boolean;
  /** optional sprite-sheet/texture asset ref; when empty a soft round particle is used */
  texture?: string;
  /** sprite-sheet grid columns (default 1) — frame advances over particle lifetime */
  tilesX?: number;
  /** sprite-sheet grid rows (default 1) */
  tilesY?: number;
  /** how the sprite-sheet plays over the particle lifetime (default `'once'`) */
  spriteMode?: SpriteMode;
  /** loop/pingpong: full animation cycles over the particle lifetime (default 1) */
  spriteCycles?: number;
  /** randomize each particle's starting frame for visual variety (default false) */
  spriteRandomStart?: boolean;
  /** depth-based soft fade near opaque geometry (Phase 3) */
  softParticles?: boolean;
  /** draw-order hint relative to other transparent objects. In 2D this is the sprite's
   *  `zIndex` within its Canvas2D — use it to place particles above or below other 2D content. */
  renderOrder?: number;
  /**
   * 2D: rotate each sprite to face its direction of travel (`atan2(vy, vx)`), with
   * `startRotation` / `rotationOverLife` / `rotationSpeed` applied as an additive offset on top
   * (so art that "points up" can be corrected once). Off by default. Ignored by the 3D billboard
   * backend, which is always camera-facing. Central to 2D VFX: streaking sparks, tumbling debris,
   * arrows, slashes.
   */
  alignToVelocity?: boolean;
}

/**
 * A complete particle effect definition (the `.particle.json` payload).
 *
 * v1 covers the core authoring surface (emission, shape, start values, gravity,
 * size/color/opacity over life). Advanced behaviors (forces, collision, trails,
 * sub-emitters, sprite-sheet animation) extend this in Phase 3 — additively, so old
 * assets keep loading.
 */
export interface ParticleEffectDef {
  version: 1;
  /** Stable asset GUID, stored in-file (same convention as mesh/material/prefab/scene
   *  `id`). Lets scenes + sub-emitters reference this effect by GUID so the reference
   *  survives the file being moved/renamed. Assigned on first save if absent. */
  id?: string;
  name?: string;

  /**
   * Editor-only authoring hint: which preview canvas the Particle Editor shows for this asset
   * (`'2d'` = PixiJS, `'3d'` = Three.js) and which property sections it exposes. It does **NOT**
   * affect runtime rendering — a live emitter renders in 2D iff it has a `Canvas2D` ancestor
   * (the same rule as `Renderable2D`), and in 3D otherwise. Default `'3d'`. Stamped `'2d'` when a
   * particle is created under a Canvas2D node.
   */
  space?: '2d' | '3d';

  /** loop period in seconds */
  duration: number;
  looping: boolean;
  /** pre-simulate one duration so the effect starts "full" */
  prewarm?: boolean;
  /** hard cap on simultaneously-alive particles (sizes the instance buffer) */
  maxParticles: number;
  /** true = particles persist in world space after emission; false = follow the emitter */
  worldSpace: boolean;
  /**
   * Simulation backend. `'cpu'` (default) = deterministic JS sim, full feature set.
   * `'gpu'` = TSL compute shader for very high counts (100k+). The GPU backend only
   * implements continuous full-pool emission, so a GPU effect must also set
   * `emission.fillPool`. It supports forces, single-plane collision and mesh-primitive
   * rendering, but NOT trails or sub-emitters. An effect that isn't GPU-eligible (no
   * `fillPool`, uses trails/sub-emitters, or no WebGPU compute backend) transparently
   * falls back to the CPU sim — which honors `fillPool` identically, so the look matches.
   */
  simulation?: 'cpu' | 'gpu';

  emission: {
    rateOverTime: number;
    bursts?: EmissionBurst[];
    /**
     * Continuous full-pool emission: keep every slot alive at all times (ages are
     * staggered at start so deaths spread over time), ignoring `rateOverTime` and
     * `bursts`. Effective rate ≈ maxParticles ÷ lifetime. Both backends honor this
     * identically — it is the only emission model the GPU compute backend implements,
     * so an effect must set `fillPool` to be eligible for `simulation: 'gpu'`. Ideal
     * for dense ambient fields (galaxies, starfields, drifting dust/motes).
     */
    fillPool?: boolean;
  };
  shape: EmitterShape;

  // ---- per-particle spawn values ----
  startLifetime: MinMax; // seconds
  startSpeed: MinMax;
  startSize: MinMax;
  startRotation?: MinMax; // degrees
  rotationSpeed?: MinMax; // degrees / second (constant spin)
  startColor: RGB; // multiplied by colorOverLife gradient
  startOpacity?: number; // 0..1, default 1

  /**
   * Constant acceleration, world units / s². Two forms (see `resolveGravity` in simSpec.ts):
   * a **scalar `g`** = a downward pull of magnitude `g` along `-Y` (legacy 3D authoring, maps to
   * `(0,-g,0)`); or an explicit **`[x,y,z]` vector** applied as-is (axis-neutral). 2D effects use the
   * vector form — `[0,+G,0]` falls toward screen-down (PixiJS +Y) with no Y flip, `[0,-G,0]` rises.
   * `normalizeParticleDef` migrates a loaded scalar to `[0,-g,0]` so old assets re-save in vector form.
   */
  gravity: number | [number, number, number];
  /** linear velocity damping per second (0 = none) */
  drag?: number;
  /** turbulence/curl noise acceleration */
  noise?: NoiseConfig;
  /** external force fields (wind, attractors/repellers) */
  forces?: ForceField[];
  /** collision against a solid plane / sphere / box / cylinder collider */
  collision?: CollisionConfig;
  /** motion trail drawn from each particle's recent position history */
  trail?: TrailConfig;
  /** nested effects spawned on parent-particle birth/death (depth-1) */
  subEmitters?: SubEmitter[];

  // ---- over-life modifiers ----
  sizeOverLife?: Curve; // multiplier on startSize
  colorOverLife?: Gradient; // multiplies startColor; alpha multiplies startOpacity
  opacityOverLife?: Curve; // multiplier on startOpacity (if no gradient alpha)
  rotationOverLife?: Curve; // degrees/sec spin (Phase 3 expands)

  render: RenderConfig;
}

/** Opaque per-emitter runtime instance owned by a backend. */
export interface ParticleHandle {
  readonly id: number;
}

/**
 * Renderer-agnostic core of a pluggable particle runtime — everything a backend does
 * EXCEPT handing back its concrete render object. The CPU sim, the GPU-compute backend
 * (both Three.js), and the PixiJS 2D backend all implement this shared contract, so the
 * editor preview + the ECS sync layers drive effects identically regardless of which
 * renderer is behind it. The one thing that differs per renderer — the scene object to
 * mount — is added by the renderer-specific sub-interface ({@link IParticleBackend} returns
 * a THREE `Object3D`; the 2D backend returns a PixiJS `Container`).
 */
export interface IParticleBackendCore {
  /** Instantiate an effect; returns a handle owning the backend's render object. */
  create(def: ParticleEffectDef): ParticleHandle;
  /** Advance simulation by `dt` seconds (the backend tracks its own elapsed time). */
  update(handle: ParticleHandle, dt: number): void;
  /** Set the emitter's world matrix (position/rotation/scale of the emitter origin).
   *  Column-major (THREE.Matrix4); the 2D backend reads translation/rotation/scale off it. */
  setTransform(handle: ParticleHandle, matrix: import('three').Matrix4): void;
  /** Hot-swap the effect definition (editor live edits) without losing the handle. */
  setDef(handle: ParticleHandle, def: ParticleEffectDef): void;
  play(handle: ParticleHandle): void;
  pause(handle: ParticleHandle): void;
  /** Runtime multiplier on each new particle's launch speed (1 = authored).
   *  Lengthens/shortens the plume and trails over ~one particle lifetime —
   *  e.g. an engine flame throttling up on acceleration. Optional: a backend
   *  may treat it as a no-op. */
  setSpeedScale?(handle: ParticleHandle, scale: number): void;
  restart(handle: ParticleHandle): void;
  /** Jump to `seconds` into the effect (recompute via stepped simulation). */
  seek(handle: ParticleHandle, seconds: number): void;
  /** Release GPU/CPU resources for this handle. */
  dispose(handle: ParticleHandle): void;
}

/**
 * The Three.js particle backend contract. The CPU/TSL backend implements this today; a
 * GPU-compute backend implements the same contract for 100k+ counts. Adds the THREE render
 * object to the renderer-agnostic {@link IParticleBackendCore}.
 */
export interface IParticleBackend extends IParticleBackendCore {
  /** The renderable to add to the THREE scene for this handle. */
  getObject3D(handle: ParticleHandle): import('three').Object3D;
}

/**
 * Sprite-sheet frame index for normalized lifetime `t` (0..1) over a `tiles`-cell sheet
 * (frame 0 = top-left). Pure scalar math; the GPU backend mirrors this exactly as a TSL
 * node (`spriteFrameNode` in billboardTsl.ts) — keep the two in lockstep.
 *
 * - `once`: clamps to the last frame after one pass.
 * - `loop`: `floor(t·tiles·cycles) mod tiles`.
 * - `pingpong`: triangle wave over `2·tiles−2` virtual frames per cycle (forward then back),
 *   expressed branchlessly as `(tiles−1) − |vf − (tiles−1)|` so JS and TSL stay identical.
 *
 * `offset` (0..tiles−1) shifts the start frame for per-particle variety (random start).
 */
export function spriteFrameIndex(
  t: number, tiles: number, mode: SpriteMode = 'once', cycles = 1, offset = 0,
): number {
  if (tiles <= 1) return 0;
  const c = Math.max(1, cycles);
  // Normalized phase → a monotonic integer frame "step" (`once` ignores cycles),
  // then map the step to a concrete frame index. The mapping is shared with the
  // time/fps-driven flipbook playback (`spriteAnimationSystem`) via spriteIndexFromStep
  // so particles and 2D sprite animation stay in exact lockstep.
  const framesPerCycle = mode === 'pingpong' ? 2 * tiles - 2 : tiles;
  const step = mode === 'once'
    ? Math.floor(t * tiles)
    : Math.floor(t * framesPerCycle * c);
  return spriteIndexFromStep(step, tiles, mode, offset);
}

/**
 * Maps a monotonic integer frame counter (`step`) to a concrete frame index for the
 * given play mode. The discrete core shared by `spriteFrameIndex` (which derives
 * `step` from a normalized phase × cycles) and fps-driven flipbook playback
 * (`spriteAnimationSystem`, where `step = floor(time·fps)`).
 *
 * - `once`: clamps to the last frame.
 * - `loop`: wraps (`step mod tiles`).
 * - `pingpong`: triangle wave over `2·tiles−2` virtual frames per cycle (forward then back),
 *   `(tiles−1) − |vf − (tiles−1)|`.
 *
 * `offset` (0..tiles−1) shifts the start frame.
 */
export function spriteIndexFromStep(
  step: number, tiles: number, mode: SpriteMode = 'once', offset = 0,
): number {
  if (tiles <= 1) return 0;
  let frame: number;
  if (mode === 'loop') {
    frame = ((step % tiles) + tiles) % tiles;
  } else if (mode === 'pingpong') {
    const period = 2 * tiles - 2; // forward 0..N-1 then back N-2..1
    const vf = ((step % period) + period) % period;
    frame = (tiles - 1) - Math.abs(vf - (tiles - 1));
  } else {
    frame = Math.min(tiles - 1, Math.max(0, step)); // once
  }
  return offset ? (frame + offset) % tiles : frame;
}

/**
 * Signature of the render fields that require a backend rebuild (mesh/material/buffers)
 * when changed — shared by both backends' `setDef` so they agree on what's "structural".
 * Backend-specific extras (trails/sub-emitters on CPU; force/collision presence on GPU)
 * are compared separately by each backend on top of this.
 */
export function renderStructuralKey(def: ParticleEffectDef): string {
  const r = def.render;
  return [
    def.maxParticles,
    r.blend,
    r.mode ?? 'billboard',
    r.aspect ?? 1,
    r.anchor ?? 'center',
    r.offset?.[0] ?? 0,
    r.offset?.[1] ?? 0,
    r.meshPrimitive ?? 'box',
    r.meshLit ?? false,
    r.tilesX ?? 1,
    r.tilesY ?? 1,
    r.softParticles ?? false,
  ].join('|');
}

/** Max force fields the GPU compute kernel unrolls. Effects with more must run on
 *  the CPU sim (which has no cap) — otherwise forces past this index are silently
 *  ignored on GPU, a GPU↔CPU divergence. Single source of truth for both the kernel
 *  (gpuComputeBackend) and the router's eligibility check (gpuDefSupported). */
export const MAX_GPU_FORCES = 8;

/** Whether a def's FEATURES are supported by the GPU compute backend — renderer
 *  availability aside (the router adds the WebGPU-backend check). Pure + import-free
 *  so it's unit-testable. The GPU sim only implements continuous full-pool emission,
 *  doesn't do trails/sub-emitters (need history/atomic plumbing), and unrolls at most
 *  MAX_GPU_FORCES force fields. */
export function gpuDefSupported(def: ParticleEffectDef): boolean {
  if (!def.emission.fillPool) return false;
  if (def.trail?.enabled) return false;
  if (def.subEmitters?.length) return false;
  if ((def.forces?.length ?? 0) > MAX_GPU_FORCES) return false; // F11: >8 forces → CPU
  // polyline is a 2D-only spawn shape: the GPU kernel maps it to `point` (arc-length line
  // positions + the emit `axis` aren't implemented there), so a polyline effect must run on the
  // CPU sim — otherwise its positions AND (post-2c) its axis diverge from CPU. Route it to CPU.
  if (def.shape.type === 'polyline') return false;
  return true;
}

/** A sensible default effect (a small upward spray) — used when creating new assets. */
export function defaultParticleEffect(): ParticleEffectDef {
  return {
    version: 1,
    name: 'New Effect',
    duration: 5,
    looping: true,
    maxParticles: 1000,
    worldSpace: false,
    emission: { rateOverTime: 50 },
    shape: { type: 'cone', angle: 20, radius: 0.3 },
    startLifetime: { min: 1.5, max: 2.5 },
    startSpeed: { min: 3, max: 5 },
    startSize: { min: 0.3, max: 0.6 },
    startColor: { r: 1, g: 0.6, b: 0.2 },
    startOpacity: 1,
    gravity: [0, -2, 0], // (0,-g,0): a small downward pull (canonical vector form; scalar still accepted)
    sizeOverLife: { points: [{ t: 0, v: 1 }, { t: 1, v: 0 }] },
    opacityOverLife: { points: [{ t: 0, v: 1 }, { t: 0.8, v: 1 }, { t: 1, v: 0 }] },
    render: { blend: 'additive' },
  };
}
