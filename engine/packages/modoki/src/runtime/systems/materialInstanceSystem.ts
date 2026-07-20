/** materialInstanceSystem — drives `MaterialInstance` parameter overrides into the
 *  entity's live materials each frame, for BOTH the 3D (Three) and 2D (PixiJS) layers.
 *  `evalSource` is the shared, renderer-neutral value core; only the APPLY differs.
 *
 *  3D (an entity with Three surfaces via the material broker):
 *   - `'uniform'` → written to every drawable object's `userData[target]`; the shader's
 *     uniform reads it per draw through `onObjectUpdate`. No clone, no recompile.
 *   - `'prop'` → a standard material property. `applyPropOverride` binds a per-entity CLONE
 *     of the shared material and writes the value onto it.
 *
 *  2D (an entity rendered through a `space:'2d'` material — a live Pixi Shader in the
 *  sprite2DMaterialBroker):
 *   - `'uniform'` → written into the entity's per-entity `matUniforms` UniformGroup for
 *     every live renderer (GameView + SceneView), the 2D twin of the broker's dual-surface
 *     reach. Only a declared scalar uniform is written (sources yield a number).
 *   - `'prop'` → NO-OP + one-time warn: PixiJS has no standard-material surface to clone.
 *
 *  Determinism: time is a session-relative accumulator advanced by `getSimDelta` /
 *  `getVisualDelta`, so it freezes on pause (delta 0) and respects `timeScale`. No
 *  wall-clock, no `Math.random` — passes the determinism guard. Both layers share the
 *  same `evalSource` + clock keys, so a 2D shader is as reproducible as a 3D one. */

import type { World, Entity } from 'koota';
import type * as THREE from 'three';
import { MaterialInstance, type MaterialParamOverride, type MaterialParamSource } from '../traits/MaterialInstance';
import { Renderable3D } from '../traits/Renderable3D';
import { Renderable3DPrimitive } from '../traits/Renderable3DPrimitive';
import { getSimDelta, getVisualDelta } from './getTime';
import { getEntityObjects } from '../rendering/materialBroker';
// 2D sprite materials are a render2d feature. Lazy-load the Pixi-backed broker
// behind the module flag so a 3D-only build (render2d off) DCEs it — and PixiJS
// with it. materialInstanceSystem runs in EVERY game's pipeline, so a static
// import here would pull pixi.js into a pure-3D bundle. `broker2D` is null when
// render2d is off, and briefly at startup until the dynamic import resolves; the
// 2D-material work then no-ops (the entity falls through to the 3D path), which is
// correct — 2D materials only matter once Scene2D (also async) is up.
type Broker2DModule = typeof import('../rendering/sprite2DMaterialBroker');
const NO_2D_SHADERS = [] as ReturnType<Broker2DModule['getEntity2DMaterialShaders']>;
let broker2D: Broker2DModule | null = null;
if (__MODOKI_MODULE_RENDER2D__) {
  void import('../rendering/sprite2DMaterialBroker').then((m) => { broker2D = m; });
}
import { applyPropOverride } from '../rendering/materialInstanceClones';
import { resolveMaterial } from '../loaders/meshTemplateCache';
import { getReadValue } from '../ui/readSourceRegistry';
import { sampleCurve } from '../particles/curves';
import { onWorldSwap } from '../ecs/world';

/** Default clock wrap (seconds). Well below the ~45000 s float32 cliff that froze the
 *  stripe scroll, yet long enough that the wrap seam is rare in an editor session. */
const DEFAULT_WRAP = 10000;

/** Session-relative clocks, one per (entity id, target). Advanced only while unpaused
 *  (delta is 0 on pause → frozen). Cleared on world swap so they don't carry across
 *  scene loads (mirrors stripeTimeSystem's resetStripeClock). */
const clocks = new Map<string, number>();

/** Stable per-entity base for a prop override whose entity has NO material GUID but DOES carry a
 *  baked per-slot material ARRAY (a multi-material mesh). Cached the first time we see it and reused
 *  forever — re-reading `mesh.material` after we bind a clone to it would make the base look like it
 *  changed and thrash the clone. Cleared on world swap. (A SINGLE default material is NOT cached
 *  here — it's unsupported; see resolvePropBase.) */
const _defaultBaseCache = new Map<number, THREE.Material[]>();

/** Entity ids already warned about an unsupported prop base (dev only) — one warning per entity. */
const _noBaseWarned = new Set<number>();

/** Entity ids already warned about a `prop` override on a 2D material (dev only). */
const _prop2DWarned = new Set<number>();

/** Entity ids already warned about driving a non-scalar (vec/color) 2D uniform (dev only). */
const _vec2DWarned = new Set<number>();

/** Entity ids already warned about a kind:'texture' override on a 3D material (dev only). */
const _tex3DWarned = new Set<number>();

onWorldSwap(() => { clocks.clear(); _defaultBaseCache.clear(); _noBaseWarned.clear(); _prop2DWarned.clear(); _vec2DWarned.clear(); _tex3DWarned.clear(); });

/** Test/teardown hook — reset all accumulators. */
export function resetMaterialInstanceClocks(): void {
  clocks.clear();
  _defaultBaseCache.clear();
  _noBaseWarned.clear();
  _prop2DWarned.clear();
  _vec2DWarned.clear();
  _tex3DWarned.clear();
}

function evalTimeSource(key: string, src: Extract<MaterialParamSource, { type: 'time' }>, sim: number, vis: number): number {
  const wrap = src.wrap ?? DEFAULT_WRAP;
  const delta = src.base === 'sim' ? sim : vis;
  const next = ((clocks.get(key) ?? 0) + delta) % wrap;
  clocks.set(key, next);
  return next * (src.speed ?? 1);
}

/** Coerce a read-source value to a number (booleans → 0/1), else the fallback. */
function toNumber(v: unknown, fallback: number): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : fallback;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function evalSourceValue(src: MaterialParamSource, key: string, sim: number, vis: number): number {
  switch (src.type) {
    case 'constant': return src.value;
    case 'time': return evalTimeSource(key, src, sim, vis);
    case 'store': {
      // `default` is the LITERAL fallback when the reading is absent/non-numeric — NOT scaled
      // (scale multiplies only a real reading). A NON-FINITE number (NaN/Infinity) is not a real
      // reading either, so it too returns the literal default — otherwise it would slip past the
      // `typeof === 'number'` arm and get scaled, contradicting the "default not scaled" contract.
      const raw = getReadValue(src.key);
      const realReading =
        (typeof raw === 'number' && Number.isFinite(raw)) ||
        typeof raw === 'boolean' ||
        (typeof raw !== 'number' && typeof raw !== 'boolean' && Number.isFinite(Number(raw)));
      if (!realReading) return src.default ?? 0;
      return toNumber(raw, src.default ?? 0) * (src.scale ?? 1);
    }
    case 'curve': {
      // Malformed curve (hand-authored JSON with no driver / no points) must DEGRADE, not crash
      // the frame — mirror the top-level malformed-entry guard. The driver is a non-curve source
      // sampled at a distinct clock key so its time accumulator can't alias a sibling override's.
      if (!src.driver?.type || !Array.isArray(src.points)) return 0;
      const t = evalSourceValue(src.driver, `${key}:drv`, sim, vis);
      return sampleCurve({ points: src.points, scale: src.scale }, t);
    }
    default: return 0;
  }
}

function evalSource(override: MaterialParamOverride, key: string, sim: number, vis: number): number {
  // A `'texture'` override carries no source (static per-instance ref, resolved by the
  // renderer, not driven here) — callers already skip it via the `!override.source` guard,
  // but degrade to 0 rather than crash if one slips through.
  return override.source ? evalSourceValue(override.source, key, sim, vis) : 0;
}

/** The base material(s) a prop override clones from. Supported bases:
 *   - **Explicit `.mat.json`** (Renderable3D / Renderable3DPrimitive `material` GUID): resolved via
 *     `resolveMaterial` every frame like Tint, so an async load + a mid-scene ref swap converge.
 *     `undefined` while it's still loading (skip this frame, retry next).
 *   - **Baked multi-material mesh** (no GUID, `mesh.material` is an ARRAY): the entity's OWN per-slot
 *     array, cached the first time it's seen as a STABLE reference (re-reading after we bind a clone
 *     would thrash it).
 *  A SINGLE default material with no GUID is intentionally UNSUPPORTED: a default-material
 *  primitive's material is recreated on canvas resize and owned per render-surface, so cloning it
 *  would leak a material+texture on every resize. Give the entity an explicit `.mat.json` (or drive
 *  `rend.color` / a custom uniform) instead — warned once, then `undefined` (skip). */
function resolvePropBase(entity: Entity, meshes: THREE.Mesh[], id: number): THREE.Material | THREE.Material[] | undefined {
  const guid = (entity.has(Renderable3D) ? entity.get(Renderable3D)!.material : '')
    || (entity.has(Renderable3DPrimitive) ? entity.get(Renderable3DPrimitive)!.material : '');
  if (guid) {
    _defaultBaseCache.delete(id); // switched from a baked array to an explicit material
    return resolveMaterial(guid) ?? undefined;
  }
  const cached = _defaultBaseCache.get(id);
  if (cached) return cached;
  const mat = meshes[0]?.material as THREE.Material | THREE.Material[] | undefined;
  if (!mat) return undefined; // no mesh yet
  if (Array.isArray(mat)) { _defaultBaseCache.set(id, mat); return mat; }
  // Single default material, no GUID → unsupported (leak-prone on resize); warn once, skip.
  if (import.meta.env?.DEV && !_noBaseWarned.has(id)) {
    _noBaseWarned.add(id);
    console.warn(`[MaterialInstance] entity ${id} has a 'prop' override but no resolvable material GUID (default-material primitive or non-mesh). Prop overrides need an explicit .mat.json material — a single default material is recreated on resize and can't be safely cloned; skipped.`);
  }
  return undefined;
}

/** Apply overrides into an entity's live 2D-material Shader(s). `uniform` overrides write
 *  the (scalar) value into each Shader's `matUniforms` group for the named target (only if
 *  the shader declares it AND it's a SCALAR — see below); `prop` is unsupported in 2D —
 *  no-op + one-time warn. `shaders` is loosely typed to avoid a runtime pixi import here. */
function applyOverrides2D(
  shaders: { resources?: { matUniforms?: { uniforms?: Record<string, unknown> } } }[],
  overrides: MaterialParamOverride[], id: number, sim: number, vis: number,
): void {
  let changed = false;
  for (let i = 0; i < overrides.length; i++) {
    const override = overrides[i];
    if (!override?.source?.type) continue;
    const value = evalSource(override, `${id}:${i}:${override.target}`, sim, vis);
    if (override.kind === 'prop') {
      if (import.meta.env?.DEV && !_prop2DWarned.has(id)) {
        _prop2DWarned.add(id);
        console.warn(`[MaterialInstance] entity ${id}: 'prop' overrides aren't supported on a 2D material (PixiJS has no standard-material surface to clone) — use kind:'uniform' to drive the shader's uniforms; skipped.`);
      }
      continue;
    }
    for (const sh of shaders) {
      const uniforms = sh.resources?.matUniforms?.uniforms;
      // Only write a uniform the shader actually declares (a stray target would add a dead
      // key). Undeclared → skip silently (the shader may declare it on another entity).
      if (!uniforms || !(override.target in uniforms)) continue;
      // A source yields a NUMBER, so only a SCALAR (f32) uniform can be driven. A vec/color
      // uniform holds a Float32Array; overwriting it with a number would NaN the whole
      // vector on the next GPU sync (WebGPU) or throw (WebGL). Skip + warn once instead.
      if (typeof uniforms[override.target] !== 'number') {
        if (import.meta.env?.DEV && !_vec2DWarned.has(id)) {
          _vec2DWarned.add(id);
          console.warn(`[MaterialInstance] entity ${id}: uniform '${override.target}' is a vec/color (non-scalar) — MaterialInstance sources drive a single number, so only scalar (float) uniforms can be driven; skipped.`);
        }
        continue;
      }
      // Write only on an ACTUAL change, and flag the entity dirty so the 2D render pass
      // redraws its canvas THIS frame. A static value (stopped clock, constant curve) leaves
      // the uniform untouched and unflagged → the material pass skips the GPU redraw.
      if (uniforms[override.target] !== value) { uniforms[override.target] = value; changed = true; }
    }
  }
  if (changed) broker2D?.markEntity2DMaterialDirty(id);
}

export function materialInstanceSystem(world: World): void {
  const sim = getSimDelta(world);
  const vis = getVisualDelta(world);
  // Rebuild the 2D-material uniform-dirty set from scratch each frame: clear here (before any
  // write), then applyOverrides2D re-marks only entities whose value actually changed. The 2D
  // render pass reads it later this frame to gate its redraw.
  broker2D?.clearEntity2DMaterialDirty();
  world.query(MaterialInstance).updateEach(([mi]: [{ overrides: MaterialParamOverride[] }], entity: Entity) => {
    const overrides = mi.overrides;
    if (!overrides || overrides.length === 0) return;
    const id = entity.id();

    // 2D custom-material entities: drive the per-entity Pixi Shader's uniforms. Checked
    // first — a material-bound Renderable2D has no 3D broker presence, so this is exclusive.
    const shaders2d = broker2D ? broker2D.getEntity2DMaterialShaders(id) : NO_2D_SHADERS;
    if (shaders2d.length > 0) { applyOverrides2D(shaders2d, overrides, id, sim, vis); return; }

    const objects = getEntityObjects(world, id);
    if (objects.length === 0) return; // no 3D presence on any surface yet
    // Resolve the prop base lazily — only when a prop override is actually present, and only once.
    let base: THREE.Material | THREE.Material[] | undefined;
    let baseResolved = false;
    for (let i = 0; i < overrides.length; i++) {
      const override = overrides[i];
      // A kind:'texture' override (per-instance extra-sampler swap) is 2D-only — on a 3D
      // material there's no equivalent (a 3D shader's texture param bakes into the material at
      // build; a per-entity swap would need a clone, like kind:'prop'). Warn once so the
      // silent no-op is discoverable, then skip.
      if (override?.kind === 'texture') {
        if (import.meta.env?.DEV && !_tex3DWarned.has(id)) {
          _tex3DWarned.add(id);
          console.warn(`[MaterialInstance] entity ${id}: kind:'texture' overrides are only supported on a 2D custom material (space:'2d' shader); this entity's material is 3D — skipped.`);
        }
        continue;
      }
      if (!override?.source?.type) continue; // malformed entry → skip it (don't crash the frame)
      // Clock key includes the override INDEX so a curve driver's ':drv' suffix can never alias
      // a sibling override's clock (even for an adversarial target name containing ':drv').
      const value = evalSource(override, `${id}:${i}:${override.target}`, sim, vis);
      if (override.kind === 'prop') {
        if (!baseResolved) { base = resolvePropBase(entity, objects as THREE.Mesh[], id); baseResolved = true; }
        // base is undefined for a `.mat.json` GUID still async-loading (skip this frame, retry
        // next) OR an unsupported single-default material (warned once inside resolvePropBase).
        if (base) applyPropOverride(id, objects as THREE.Mesh[], base, override.target, value);
      } else {
        // Default (incl. omitted kind) → uniform: written to userData; the shader's uniform
        // reads it per-draw via onObjectUpdate. Matches hasPropOverride (kind === 'prop').
        for (const obj of objects) obj.userData[override.target] = value;
      }
    }
  });
}
