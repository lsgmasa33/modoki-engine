/** Per-entity material clones for MaterialInstance *standard-property* overrides
 *  (color/opacity/roughness/…). Unlike custom-uniform overrides — which need no clone
 *  (the shader reads per-object `userData` via `onObjectUpdate`) — a standard prop is a
 *  per-instance material field, so driving it per entity requires a private clone of the
 *  SHARED cached material (mutating the shared one would change every entity that
 *  references the .mat.json and corrupt the cache-owned instance).
 *
 *  Lifecycle mirrors the Tint clones (`scene3DSync.tintedMaterial`): the clone is created
 *  lazily, shared across BOTH render surfaces (the meshes come from the broker), and freed
 *  only on world swap — the scene is the unit of memory management. `syncMaterial` skips its
 *  per-frame "reset to base" for these entities (its `isInstanced` guard), so the clone
 *  isn't fought each frame.
 *
 *  Scope: single-material AND multi-material (array) meshes, scalar/color props, plus the
 *  `map*` Vector2 sub-props (offset/repeat) which clone the base texture per instance. The base
 *  must come from an explicit `.mat.json` GUID or a baked material array — a single default
 *  material (recreated on resize) is not a valid base; the caller (`resolvePropBase`) skips it.
 *
 *  LIMITATION: a standard prop only affects a material that READS it. Standard PBR/unlit
 *  materials honour `.color`/`.opacity`/`.roughness`/… ; a custom-shader material whose
 *  `fragmentNode` hardcodes the output (e.g. `nprFragmentOutput(vec4(rgb, 1.0))`, as the
 *  space-console holo/matcap/stripes shaders do) IGNORES them — drive such a shader via a
 *  custom UNIFORM override instead. */

import * as THREE from 'three';
import { onWorldSwap } from '../ecs/world';

/** entity id → its owned clone + the base material the clone was derived from. The base
 *  is the RESOLVED shared material (from the entity's material GUID, re-resolved each frame
 *  by the caller — like Tint), NOT read off `mesh.material`. That is what makes this correct
 *  across the two editor surfaces and across an async `.mat.json` load: there is exactly one
 *  base per entity, so we never dispose a clone that another mesh in the same pass still uses. */
/** clone/base are a single Material OR a per-slot array (multi-material meshes). */
type MatOrArray = THREE.Material | THREE.Material[];
const clones = new Map<number, { clone: MatOrArray; base: MatOrArray }>();

/** Dispose a material (or each slot), plus any per-instance texture the map-driver cloned for it. */
function disposeOne(x: THREE.Material): void {
  const t = x as THREE.Material & { map?: THREE.Texture | null; userData: Record<string, unknown> };
  if (t.userData?._miOwnsMap && t.map) t.map.dispose();
  x.dispose();
}
const disposeMat = (m: MatOrArray | undefined): void => {
  if (Array.isArray(m)) { for (const x of m) disposeOne(x); }
  else if (m) disposeOne(m);
};

function disposeAll(): void {
  for (const { clone } of clones.values()) disposeMat(clone);
  clones.clear();
}

// Freed at the world-swap boundary (like Tint clones) — NOT on a single panel unmount,
// since the clone is shared across every mounted surface for this world.
onWorldSwap(disposeAll);

/** Test/teardown hook — dispose every clone and clear the registry. */
export function resetMaterialInstanceClones(): void {
  disposeAll();
}

/** Bind entity `id`'s meshes to a per-entity CLONE of its resolved `base` material and write
 *  `target = value` on that clone. `base` is resolved by the CALLER — a single material (from the
 *  entity's `.mat.json` GUID) OR a per-slot ARRAY (a baked multi-material mesh); either way it must
 *  be a STABLE reference (the caller caches it), so the
 *  `!==` guard rebuilds only on a genuine base change and never thrashes. `meshes` are all the
 *  entity's drawables across every surface — one clone is shared by all. For a prop that touches a
 *  material array, the value is written to EVERY slot. Idempotent once bound. */
export function applyPropOverride(id: number, meshes: THREE.Mesh[], base: MatOrArray, target: string, value: number): void {
  let entry = clones.get(id);
  let old: MatOrArray | undefined;
  if (!entry || entry.base !== base) {
    // New entity, or the resolved base changed (material ref swap / async load landed).
    old = entry?.clone;
    entry = { clone: Array.isArray(base) ? base.map((m) => m.clone()) : base.clone(), base };
    clones.set(id, entry);
  }
  for (const mesh of meshes) {
    if (mesh.material !== entry.clone) mesh.material = entry.clone as THREE.Material | THREE.Material[];
  }
  if (Array.isArray(entry.clone)) { for (const c of entry.clone) applyProp(c, target, value); }
  else applyProp(entry.clone, target, value);
  // Dispose the superseded clone AFTER every mesh has been rebound, so nothing renders a
  // disposed material even momentarily.
  if (old) disposeMat(old);
}

/** Write one standard material property from a numeric driver value. Color-typed props
 *  (`color`/`emissive`) take the value as a packed hex; the `map*` props drive one axis of
 *  the texture's offset/repeat Vector2 (UV scroll / tiling); everything else is a scalar. */
function applyProp(material: THREE.Material, target: string, value: number): void {
  const m = material as THREE.Material & {
    color?: THREE.Color; emissive?: THREE.Color; roughness?: number; metalness?: number;
    emissiveIntensity?: number; opacity: number; transparent: boolean;
    map?: THREE.Texture | null;
  } & Record<string, unknown>;
  switch (target) {
    case 'opacity': {
      m.opacity = value;
      const transparent = value < 1; // enable blending when translucent
      if (transparent !== m.transparent) {
        m.transparent = transparent;
        // A `transparent` flip changes blending/depth state baked into the compiled
        // program, so the material must recompile. Guarded by the `!==` so this fires
        // once on the transition, NOT every frame (which would thrash the pipeline).
        m.needsUpdate = true;
      }
      break;
    }
    case 'color': m.color?.setHex(value); break;
    case 'emissive': m.emissive?.setHex(value); break;
    case 'roughness': m.roughness = value; break;
    case 'metalness': m.metalness = value; break;
    case 'emissiveIntensity': m.emissiveIntensity = value; break;
    // Texture UV drivers — one axis of the base-map's offset (scroll) or repeat (tiling).
    // The texture's matrix auto-updates from offset/repeat, so no needsUpdate is needed. A
    // material with no `.map` warns once (like an unknown target) rather than throwing.
    case 'mapOffsetX': { const t = ownMap(m); if (t) t.offset.x = value; else warnUnknown(target); break; }
    case 'mapOffsetY': { const t = ownMap(m); if (t) t.offset.y = value; else warnUnknown(target); break; }
    case 'mapRepeatX': { const t = ownMap(m); if (t) t.repeat.x = value; else warnUnknown(target); break; }
    case 'mapRepeatY': { const t = ownMap(m); if (t) t.repeat.y = value; else warnUnknown(target); break; }
    default:
      // No open-ended fallback: an arbitrary authored `target` must NOT be allowed to write
      // internal THREE.Material numeric fields (id/version/blending/side/…). Only the
      // allowlisted props above are driveable; anything else warns once and is a no-op.
      warnUnknown(target);
      break;
  }
}

/** Return the material's base map, ensuring it's a PER-MATERIAL clone so offset/repeat are
 *  per-instance — `material.clone()` shares `.map` by reference, so a naive write would mutate the
 *  SHARED texture (and every entity using it). Clones once (sharing the GPU image, cheap), flagged
 *  on userData so `disposeOne` frees it with the material. Null if the material has no base map. */
function ownMap(m: THREE.Material & { map?: THREE.Texture | null } & Record<string, unknown>): THREE.Texture | null {
  if (!m.map) return null;
  if (!m.userData._miOwnsMap) {
    m.map = m.map.clone();
    m.userData._miOwnsMap = true;
  }
  return m.map;
}

const _unknownWarned = new Set<string>();
/** Warn once per unsupported/unapplicable prop target (e.g. a `map*` target on a material with
 *  no base texture), then no-op — never write an arbitrary field. */
function warnUnknown(target: string): void {
  if (_unknownWarned.has(target)) return;
  _unknownWarned.add(target);
  console.warn(`[MaterialInstance] prop target "${target}" is unsupported or not applicable (no base map?) — ignored. Supported: color, emissive, opacity, roughness, metalness, emissiveIntensity, mapOffsetX/Y, mapRepeatX/Y.`);
}
