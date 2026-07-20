/**
 * Loads + caches `.particle.json` effect definitions, resolving GUID/path refs through
 * the shared asset manifest (same pattern as meshTemplateCache). Returns the parsed
 * definition synchronously once cached; the first call kicks off an async fetch and
 * returns null until it resolves (the per-frame sync simply retries next frame).
 */

import { resolveRef, isGuid, registerAsset } from './assetManifest';
import { assetUrl } from './assetUrl';
import { ASSET_FETCH_INIT } from './assetFetch';
import { defaultParticleEffect, type ParticleEffectDef, type CollisionConfig } from '../particles/types';

const cache = new Map<string, ParticleEffectDef>();
const loading = new Map<string, Promise<void>>();
const failed = new Set<string>();

// Bumped on clearParticleCache() to invalidate in-flight fetches (mirrors
// meshTemplateCache's cacheGeneration). A fetch that resolves after a scene
// swap must not repopulate the cache or re-register a stale guid→path mapping.
let generation = 0;

/** Migrate a legacy collision config (infinite horizontal plane at `planeY`, no `shape`)
 *  to the explicit `plane` collider so old assets upgrade on their next save. */
function migrateCollision(c?: CollisionConfig): CollisionConfig | undefined {
  if (!c || c.shape) return c; // already in the new (shape-tagged) format, or absent
  const { planeY, ...rest } = c;
  return { ...rest, shape: 'plane', planeNormal: [0, 1, 0], planePoint: [0, planeY ?? 0, 0] };
}

/** Hard ceiling on pool size — guards against a corrupt/huge maxParticles allocating
 *  an absurd Float32Array. The GPU backend handles 100k+; 1M is a generous safety cap. */
const HARD_MAX_PARTICLES = 1_000_000;

const finiteOr = (n: unknown, fallback: number): number =>
  typeof n === 'number' && Number.isFinite(n) ? n : fallback;

/** Coerce a {min,max} pair to finite numbers and swap if inverted — `randRange`
 *  with min>max yields values BELOW min, and NaN poisons the sim buffers. */
function clampMinMax(mm: { min: number; max: number } | undefined, fb: { min: number; max: number }) {
  let min = finiteOr(mm?.min, fb.min);
  let max = finiteOr(mm?.max, fb.max);
  if (min > max) { const t = min; min = max; max = t; }
  return { min, max };
}

/** Fill any missing required sub-objects so partial/older JSON still loads safely,
 *  then clamp authoring invariants (min≤max, positive pool, ≥1 tiles, finite numbers)
 *  so a hand-edited/corrupt def can't produce NaN buffers or throw at sim construction (F4).
 *  Shared with the Particle Editor so loaded + edited defs are normalized identically. */
export function normalizeParticleDef(json: Partial<ParticleEffectDef>): ParticleEffectDef {
  const d = defaultParticleEffect();
  const out: ParticleEffectDef = {
    ...d,
    ...json,
    emission: { ...d.emission, ...(json.emission ?? {}) },
    shape: { ...d.shape, ...(json.shape ?? {}) },
    render: { ...d.render, ...(json.render ?? {}) },
    collision: migrateCollision(json.collision),
    version: 1,
  };

  // ── clamp invariants ──
  out.maxParticles = Math.min(HARD_MAX_PARTICLES, Math.max(1, Math.floor(finiteOr(out.maxParticles, d.maxParticles))));
  const dur = finiteOr(out.duration, d.duration);
  out.duration = dur > 0 ? dur : d.duration; // looping with duration<=0 never completes a cycle
  out.startLifetime = clampMinMax(out.startLifetime, d.startLifetime);
  out.startSpeed = clampMinMax(out.startSpeed, d.startSpeed);
  out.startSize = clampMinMax(out.startSize, d.startSize);
  if (out.startRotation) out.startRotation = clampMinMax(out.startRotation, d.startRotation ?? { min: 0, max: 0 });
  if (out.rotationSpeed) out.rotationSpeed = clampMinMax(out.rotationSpeed, d.rotationSpeed ?? { min: 0, max: 0 });
  if (out.render.tilesX !== undefined) out.render.tilesX = Math.max(1, Math.floor(finiteOr(out.render.tilesX, 1)));
  if (out.render.tilesY !== undefined) out.render.tilesY = Math.max(1, Math.floor(finiteOr(out.render.tilesY, 1)));

  // gravity: migrate the legacy scalar (downward -Y magnitude) to an explicit acceleration vector
  // [0,-g,0], and sanitize the vector form to finite numbers. Axis-neutral: both backends apply the
  // vector as-is (resolveGravity in simSpec.ts), so old 3D effects are unchanged and re-save in the
  // new form; 2D authors [0,+G,0] to fall (PixiJS +Y is down) with no render-side Y flip.
  if (Array.isArray(out.gravity)) {
    out.gravity = [finiteOr(out.gravity[0], 0), finiteOr(out.gravity[1], 0), finiteOr(out.gravity[2], 0)];
  } else if (typeof out.gravity === 'number' && Number.isFinite(out.gravity)) {
    out.gravity = [0, -out.gravity, 0];
  } else {
    out.gravity = [0, 0, 0];
  }

  // polyline points: keep only finite [x,y] pairs so resolveShape's arc-length math stays finite
  // (the sampler tolerates <2 points by degrading to a point, but NaNs would poison segment lengths).
  if (out.shape.type === 'polyline' && Array.isArray(out.shape.points)) {
    out.shape.points = out.shape.points
      .filter((p): p is [number, number] =>
        Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]))
      .map((p) => [p[0], p[1]] as [number, number]);
  }
  // `space` is an editor-only hint; drop an out-of-range value rather than persist garbage.
  if (out.space !== undefined && out.space !== '2d' && out.space !== '3d') delete out.space;

  return out;
}

/** Resolve a `.particle.json` ref to its parsed definition, or null if not yet loaded. */
export function getParticleEffect(ref: string): ParticleEffectDef | null {
  if (!ref) return null;
  // Use the path-tolerant key helper (not raw resolveRef) — the live particle
  // editor preview passes a file path, which resolveRef would reject loudly.
  const path = particleCacheKey(ref);
  if (!path) return null;
  const hit = cache.get(path);
  if (hit) return hit;
  if (failed.has(path)) return null;
  if (!loading.has(path)) {
    const gen = generation; // capture to detect a cache clear during the async load
    const p = fetch(assetUrl(path), ASSET_FETCH_INIT)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.json();
      })
      .then((json) => {
        // A scene swap (clearParticleCache) happened mid-flight: drop the result
        // so we don't repopulate a stale path or re-register an old guid→path.
        if (gen !== generation) return;
        // An editor live-preview edit (setParticleEffect) landed while we were
        // fetching: it already seeded the cache, so don't clobber it with disk.
        if (cache.has(path)) return;
        // Self-register guid → path (same pattern as meshTemplateCache) so a
        // later ref to this effect by guid resolves even if it wasn't in the
        // pre-loaded manifest (e.g. a freshly created effect in the editor).
        const id = (json as Partial<ParticleEffectDef>)?.id;
        if (id && isGuid(id)) registerAsset(id, path, 'particle');
        cache.set(path, normalizeParticleDef(json as Partial<ParticleEffectDef>));
      })
      .catch((e) => {
        if (gen === generation) failed.add(path);
        console.warn(`[particleCache] failed to load ${path}:`, e);
      })
      .finally(() => loading.delete(path));
    loading.set(path, p);
  }
  return null;
}

/** Resolve an editor cache key. The cache is keyed by the resolved path; the
 *  editor seeds/invalidates by the asset's actual file *path* (its cache key /
 *  file location, not a stored reference), so a path is accepted directly here.
 *  A GUID resolves through the manifest. Unlike `resolveRef` (the GUID-only
 *  resolver for stored references), this internal helper does not reject paths. */
function particleCacheKey(refOrPath: string): string | undefined {
  if (!refOrPath) return undefined;
  return isGuid(refOrPath) ? resolveRef(refOrPath) : refOrPath;
}

/** Directly seed/override a cached effect by path or GUID (editor live-preview + post-save). */
export function setParticleEffect(refOrPath: string, def: ParticleEffectDef): void {
  const path = particleCacheKey(refOrPath);
  if (!path) return;
  cache.set(path, normalizeParticleDef(def));
  failed.delete(path);
}

/** Drop a cached effect so the next access re-fetches (e.g. after an external edit). */
export function invalidateParticleEffect(refOrPath: string): void {
  const path = particleCacheKey(refOrPath);
  if (!path) return;
  cache.delete(path);
  failed.delete(path);
  loading.delete(path);
}

/** Drop ALL cached effect defs (e.g. on scene swap / full resource disposal).
 *  Bumps the generation so any in-flight fetch discards its result instead of
 *  repopulating the cache. Particle defs are plain data — nothing to GPU-dispose. */
export function clearParticleCache(): void {
  generation++;
  cache.clear();
  loading.clear();
  failed.clear();
}
