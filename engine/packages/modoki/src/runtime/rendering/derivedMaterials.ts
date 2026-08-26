/** derivedMaterials — the ONE convention for "this material is a clone of that one", and the
 *  retirement queue for clones (#318).
 *
 *  THREE render paths in this engine bind a `base.clone()` to a mesh instead of the shared
 *  cached material: tint clones (`scene3DSync.tintedMaterial`), per-entity MaterialInstance
 *  prop clones (`materialInstanceClones`), and light-mask variants (`lightMaskVariants`). A
 *  `THREE.Material.clone()` copies texture REFERENCES, so every one of those clones samples the
 *  base's textures without owning them.
 *
 *  WHY THIS EXISTS: `sweepRetiredMaterials` frees a retired base once no MESH binds it, and none
 *  of those three caches is reachable by a `scene.traverse` — the clone is what the mesh binds,
 *  the base is only in a module Map or in `userData`. So a base whose sole remaining holders were
 *  clones was swept and freed, and `disposeMaterial` released its shared textures out from under
 *  the live clones. The `__derivedBase` stamp is what makes those holders visible: the sweep
 *  walks the chain up from every bound material, so a base held only through a clone counts as
 *  bound.
 *
 *  It is a STAMP, not a registry, on purpose. A registry keyed by clone would have to be kept in
 *  step with three independent caches' eviction paths, and the entry that goes stale is exactly
 *  the one that lets a live material be freed. The stamp travels with the material and cannot
 *  drift from it.
 *
 *  ⚠️ A clone must NEVER be freed through `disposeRetiredMaterial` / `disposeMaterial`: those
 *  walk the material's texture slots and `releaseTexture3D` each one, which for a clone means
 *  releasing the BASE's refs a second time. Hence the separate retirement set here, whose freeing
 *  step is a caller-supplied `dispose` that touches only what the clone genuinely owns. */

import * as THREE from 'three';
import { onWorldSwap } from '../core/ecs/world';

/** `userData` key holding the material this one was cloned from.
 *
 *  Deliberately NOT the same key as `lightMaskVariants`' own `__lightMaskBase`, which serves a
 *  different question: that one means "re-derive a variant from THIS", and a tint clone must
 *  answer it with ITSELF (a light-mask variant of a tinted mesh has to keep the tint). This key
 *  means only "my textures belong to that", which is true one link at a time all the way up. */
const DERIVED_BASE_KEY = '__derivedBase';

/** Depth cap for the chain walk. A chain is at most base → tint/instance clone → light-mask
 *  variant today, so 8 is generous; it exists so a cycle (a clone stamped with itself through
 *  some future path) degrades to a bounded walk rather than hanging the sweep. */
const MAX_DERIVED_DEPTH = 8;

/** Record that `clone` shares `base`'s texture references. Call it at the CLONE SITE — the same
 *  discipline `registerRenderSurface` needed (#315/#317): a stamp written anywhere else is a
 *  stamp some future fourth clone site will forget. Returns `clone` for chaining. */
export function markDerived<T extends THREE.Material>(clone: T, base: THREE.Material): T {
  if (clone === base) return clone; // never stamp a material with itself
  clone.userData = { ...clone.userData, [DERIVED_BASE_KEY]: base };
  return clone;
}

/** Clone `material` for binding to a live mesh: stamped, and WITHOUT `userData`'s JSON round-trip.
 *
 *  **Use this instead of a bare `material.clone()` anywhere the source could be a material this
 *  engine already derived** — which, on a live mesh, is almost everywhere. `Material.copy()`
 *  deep-copies `userData` with `JSON.parse(JSON.stringify(...))`, and two separate things go wrong
 *  when the source is a light-mask variant (#325, and #318's prewarm before it):
 *
 *    1. **It serialises a whole material graph.** `lightMaskVariants` parks the BASE MATERIAL
 *       OBJECT in `userData.__lightMaskBase`, so the round-trip drags `Material.toJSON` →
 *       `Texture.toJSON` → image serialisation behind it. A compressed texture cannot be
 *       serialised at all and logs `THREE.Texture: Unable to serialize Texture.` per clone; an
 *       uncompressed one becomes a data URL. `demos/postfx-demo` produced 18 such warnings the
 *       first time a naive clone shipped on the prewarm path.
 *    2. **It drops the properties that make a variant DISTINCT.** `Material.copy()` copies only
 *       the fields it knows about, so a variant's `lightsNode` and `customProgramCacheKey` — the
 *       two own properties `getMaskedMaterial` sets — do not survive. The clone then hashes to the
 *       BASE's pipeline key, which is precisely the collision that made masked objects render
 *       black in #136. Silent: the picture is merely lit by the wrong lights.
 *
 *  So: suppress `userData` across the clone itself, then carry over every own property the fresh
 *  clone does not already have. `userData` is one of the properties `getMaterialCacheKey()`
 *  explicitly SKIPS, so leaving the clone's own `userData` minimal is free — a caller that needs
 *  something in there (`inheritMaskBase`) writes it deliberately, after.
 *
 *  Keys matching `is[A-Z]`/`_` are skipped: those are three's type brands and private fields, and
 *  copying a brand onto a clone of a different class is how a material starts lying about what it
 *  is. */
export function cloneDerived<T extends THREE.Material>(material: T, base: THREE.Material): T {
  const savedUserData = material.userData;
  let clone: T;
  material.userData = {};
  // Stamped HERE, on the clone line, for the same reason every other site stamps on its own line:
  // `materialCloneStamp.test.ts` reads the LINE, and a stamp applied elsewhere is one a future
  // caller can forget. Restored in `finally` so a throwing clone cannot strand the source's
  // userData empty — which would silently unstamp a variant's base.
  try { clone = markDerived(material.clone() as T, base); } finally { material.userData = savedUserData; }
  const src = material as unknown as Record<string, unknown>;
  const dst = clone as unknown as Record<string, unknown>;
  for (const key of Object.keys(src)) {
    if (/^(is[A-Z]|_)/.test(key)) continue;
    if (Object.prototype.hasOwnProperty.call(dst, key)) continue;
    dst[key] = src[key];
  }
  return clone;
}

/** The material `m` was cloned from, or `undefined` when `m` is not a derived clone. */
export function derivedBaseOf(m: THREE.Material): THREE.Material | undefined {
  const b = (m.userData as Record<string, unknown> | undefined)?.[DERIVED_BASE_KEY];
  return (b as THREE.Material | undefined) ?? undefined;
}

/** Add `m` and every material it derives from, transitively, to `out`.
 *
 *  This is the sweep's "what is still held" question. A tint clone bound to a mesh keeps its
 *  base alive; a light-mask variant OF that tint clone keeps both alive. */
export function collectDerivedChain(m: THREE.Material, out: Set<THREE.Material>): void {
  let cur: THREE.Material | undefined = m;
  for (let depth = 0; cur && depth < MAX_DERIVED_DEPTH; depth++) {
    if (out.has(cur)) return; // already walked this tail
    out.add(cur);
    cur = derivedBaseOf(cur);
  }
}

/** Clones evicted from their cache while a live mesh may still bind them.
 *
 *  Same shape and same reason as `retiredMaterials` for bases: the cache that owned the clone
 *  cannot know whether a mesh is drawing it right now, and disposing on the spot is the #317
 *  use-after-free one level out. The value is the owner's dispose step — for a tint clone that is
 *  a bare `dispose()`, for a MaterialInstance clone it also frees the per-instance map the clone
 *  owns outright, and for a light-mask variant it drops the module's `owned` entry too. */
const retiredDerived = new Map<THREE.Material, () => void>();

/** Queue `clone` for freeing once the sweep establishes that nothing binds it. Idempotent: a
 *  second retire of the same clone keeps the FIRST dispose step, so an owner cannot lose its
 *  cleanup to a later, less specific one. */
export function retireDerivedMaterial(clone: THREE.Material, dispose: () => void): void {
  if (!retiredDerived.has(clone)) retiredDerived.set(clone, dispose);
}

/** The retired-clone set, for `scene3DSync`'s sweep. Empty in the common case — the sweep checks
 *  `.size` before doing any per-surface work. */
export function retiredDerivedMaterials(): ReadonlySet<THREE.Material> {
  return new Set(retiredDerived.keys());
}

/** How many clones are queued. The allocation-free form of the above, for the sweep's guard. */
export function retiredDerivedCount(): number {
  return retiredDerived.size;
}

/** Free one retired clone once the sweep has established that nothing binds it. */
export function disposeRetiredDerivedMaterial(clone: THREE.Material): void {
  const dispose = retiredDerived.get(clone);
  if (!dispose) return; // not retired (or already freed)
  retiredDerived.delete(clone);
  dispose();
}

/** Drain the queue unconditionally. The world-swap boundary tears every surface down together,
 *  so nothing can still be binding a retiree — and leaving them queued would strand them: the
 *  sweep only runs from `syncSceneRenderables3D`, which a swapped-away surface no longer calls. */
function disposeAllRetiredDerived(): void {
  const pending = [...retiredDerived.values()];
  retiredDerived.clear();
  for (const dispose of pending) dispose();
}

onWorldSwap(disposeAllRetiredDerived);

/** Test/teardown hook — drain the retirement queue. */
export function resetDerivedMaterials(): void {
  disposeAllRetiredDerived();
}
