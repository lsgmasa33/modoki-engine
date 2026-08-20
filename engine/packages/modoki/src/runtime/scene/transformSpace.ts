/** LOCAL ↔ WORLD conversion for authoring a `Transform`, over the SCENE FILE's entity list.
 *
 *  WHY THIS EXISTS. `Transform` is the LOCAL transform — only rendering composes the parent
 *  chain (see `docs/architecture.md` "World Transforms"). But an agent READS world coordinates
 *  (`get_scene_state {world:1}` is what answers "where is this?") and then naturally writes them
 *  back. Measured 2026-07-30 on a parented entity: asking `set_transform` for the entity's OWN
 *  CURRENT world position moved it by exactly the parent offset, and reported success. The read
 *  and the write were in different spaces and nothing said so.
 *
 *  So authoring gained an explicit `space`, and this module is the conversion — for the FILE
 *  path. The LIVE path has the same capability already: `worldToLocal3D` /
 *  `getParentWorldMatrix3D` in `runtime/core/ecs/worldTransform.ts`, which physics uses to write
 *  a stepped world pose back into a parented body's local Transform. Same contract, two sources
 *  for the parent chain (a JSON array here, a koota query there).
 *
 *  Pure and headless — it takes the entity list, walks `EntityAttributes.parentId`, and composes.
 *
 *  KNOWN LIMIT (inherent, not a bug): a NON-UNIFORMLY-SCALED parent applied to a ROTATED child
 *  produces a sheared world matrix, and `Matrix4.decompose` cannot reduce shear back to clean
 *  TRS. That combination does not round-trip exactly. It affects the human SceneView gizmo
 *  identically (`editor/scene/gizmoTransform.ts` documents the same caveat) — it is a property of
 *  representing transforms as TRS, not of this code.
 */

import * as THREE from 'three';
import type { MutableEntity } from './sceneMutate';
import { decomposeTrs } from '../core/ecs/decomposeTrs';

/** The nine `Transform` fields. */
export interface TRS {
  x: number; y: number; z: number;
  rx: number; ry: number; rz: number;
  sx: number; sy: number; sz: number;
}

export const IDENTITY_TRS: TRS = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 };

/** Depth cap, matching `worldTransform.ts` — a `parentId` cycle in a hand-edited scene must not
 *  hang the dev server. */
const MAX_DEPTH = 64;

const _m = new THREE.Matrix4();
const _acc = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _euler = new THREE.Euler();

/** An ancestor's LOCAL transform as the file actually stores it.
 *
 *  A PREFAB-INSTANCE ancestor keeps its Transform in `overrides[localId]`, NOT in `traits`
 *  (independent review, 2026-07-30). `serialize.ts` writes only `PrefabInstance` for a captured
 *  instance root, so reading `traits.Transform` alone treated every such ancestor as IDENTITY and
 *  a `space:'world'` write under it was off by the instance's entire placement — reported ok:true.
 *  Measured on real data: `games/sling` Base.json's `Fish Zone L` sits at (-9.5,-1.7,-2) scale 3
 *  via `overrides["1"].Transform`, so a marker parented to it and placed at that world point
 *  landed at (-38,-6.8,-8). 25 instances across games/ and demos/ carry a non-zero override
 *  Transform.
 *
 *  `sceneMutate.ts`'s `traitWriteContainer` has encoded this rule all along for WRITES; this is the
 *  read side of the same rule, kept deliberately parallel to it.
 *
 *  Still a known gap, and a narrower one: an instance with NO override Transform inherits its
 *  placement from the prefab FILE, which this module cannot read (it is handed a scene, not a
 *  loader). Such an ancestor is still treated as identity. Left explicit rather than silently
 *  half-fixed — it needs prefab resolution, which is a bigger change than this conversion. */
function instanceOverrideTraits(e: MutableEntity): Record<string, unknown> | undefined {
  const pi = e.traits?.PrefabInstance;
  const localId = e.prefab && pi && typeof pi === 'object' ? (pi as { localId?: number }).localId : undefined;
  if (localId == null) return undefined;
  const ov = e.overrides?.[localId];
  return ov && typeof ov === 'object' ? (ov as Record<string, unknown>) : undefined;
}

function trsOf(e: MutableEntity | undefined): TRS {
  const t = (e ? instanceOverrideTraits(e)?.Transform : undefined) ?? e?.traits?.Transform;
  if (!t || typeof t !== 'object') return IDENTITY_TRS;
  const r = t as Record<string, unknown>;
  const n = (k: string, d: number) => (typeof r[k] === 'number' ? (r[k] as number) : d);
  return {
    x: n('x', 0), y: n('y', 0), z: n('z', 0),
    rx: n('rx', 0), ry: n('ry', 0), rz: n('rz', 0),
    sx: n('sx', 1), sy: n('sy', 1), sz: n('sz', 1),
  };
}

/** A parent reference as the file ACTUALLY stores it.
 *
 *  `EntityAttributes.parentId` is a **GUID string** in every current scene file; the numeric form
 *  is legacy. The first cut of this module accepted only the number, so `parentWorldTrs` returned
 *  null for every parented entity and `space:'world'` degraded to writing the caller's WORLD
 *  coordinates verbatim into the LOCAL fields — a silent false success on the file path, while the
 *  live path (which resolves through the running world) was correct.
 *
 *  It survived review because the unit fixtures were written with NUMERIC parentIds: the tests
 *  encoded the author's assumption rather than the on-disk format, so they proved the conversion
 *  against data that does not occur. `parentKeyOf` in `sceneMutate.ts` — the module this one
 *  supports — has handled both forms all along and says so in a comment. */
function parentRefOf(e: MutableEntity | undefined): string | number | 0 {
  const ea = e?.traits?.EntityAttributes;
  if (!ea || typeof ea !== 'object') return 0;
  const p = (ea as { parentId?: unknown }).parentId;
  if (typeof p === 'string' && p) return p;   // guid (current)
  if (typeof p === 'number') return p;        // numeric file id (legacy)
  return 0;
}

/** The keys an entity can be addressed BY, so a parent ref of either form resolves. */
function keysOf(e: MutableEntity): Array<string | number> {
  const ea = (e.traits?.EntityAttributes ?? {}) as { guid?: unknown };
  const out: Array<string | number> = [e.id];
  if (typeof ea.guid === 'string' && ea.guid) out.push(ea.guid);
  if (typeof e.guid === 'string' && e.guid) out.push(e.guid); // prefab-instance node identity
  return out;
}

function matrixOf(t: TRS, out: THREE.Matrix4): THREE.Matrix4 {
  _pos.set(t.x, t.y, t.z);
  _quat.setFromEuler(_euler.set(t.rx, t.ry, t.rz)); // XYZ, matching transformPropagationSystem
  _scale.set(t.sx, t.sy, t.sz);
  return out.compose(_pos, _quat, _scale);
}

/** A world matrix as a TRS — the ONE decomposition both authoring paths use.
 *
 *  Exported (owner decision, 2026-07-31) so the LIVE path in `agentEditorOps` decomposes
 *  identically to this file's `parentWorldTrs` and to the gizmo, Euler order included. Two
 *  hand-rolled decompositions would be free to drift in exactly the way that made the live and
 *  file answers differ in the first place. */
export function matrixToTrs(m: THREE.Matrix4): TRS {
  return decompose(m);
}

function decompose(m: THREE.Matrix4): TRS {
  decomposeTrs(m, _pos, _quat, _scale); // singular-safe — see #258
  _euler.setFromQuaternion(_quat);
  return {
    x: _pos.x, y: _pos.y, z: _pos.z,
    rx: _euler.x, ry: _euler.y, rz: _euler.z,
    sx: _scale.x, sy: _scale.y, sz: _scale.z,
  };
}

/** The chain of ancestors of `entity`, root-first. Stops at a missing parent (a dangling
 *  `parentId` is treated as root rather than throwing — `mutate_scene` already warns about
 *  those separately, and a conversion is not the place to fail the whole op). */
function ancestors(entities: MutableEntity[], entity: MutableEntity): MutableEntity[] {
  // Index by EVERY addressable key (numeric id AND guid), because a parent ref is a GUID in
  // current files and a number in legacy ones — a map keyed on `e.id` alone could never match the
  // common case, which is exactly how this returned "no parent" for every real entity.
  const byKey = new Map<string | number, MutableEntity>();
  for (const e of entities) for (const k of keysOf(e)) if (!byKey.has(k)) byKey.set(k, e);
  const chain: MutableEntity[] = [];
  const seen = new Set<MutableEntity>([entity]);
  let ref = parentRefOf(entity);
  for (let depth = 0; ref && depth < MAX_DEPTH; depth++) {
    const p = byKey.get(ref);
    if (!p || seen.has(p)) break; // missing parent, or a cycle
    seen.add(p);
    chain.unshift(p);
    ref = parentRefOf(p);
  }
  return chain;
}

/** `entity`'s PARENT's world transform, or null when it is at the root (world == local).
 *  Null means "root": world == local, so a conversion is a no-op. */
export function parentWorldTrs(entities: MutableEntity[], entity: MutableEntity): TRS | null {
  const chain = ancestors(entities, entity);
  if (!chain.length) return null;
  _acc.identity();
  for (const a of chain) _acc.multiply(matrixOf(trsOf(a), _m));
  return decompose(_acc);
}

/** world = parentWorld · local. */
export function localToWorldTrs(local: TRS, parent: TRS | null): TRS {
  if (!parent) return { ...local };
  const p = matrixOf(parent, new THREE.Matrix4());
  const l = matrixOf(local, new THREE.Matrix4());
  return decompose(p.multiply(l));
}

/** local = parentWorld⁻¹ · world — the inverse of {@link localToWorldTrs}. */
export function worldToLocalTrs(world: TRS, parent: TRS | null): TRS {
  if (!parent) return { ...world };
  const pInv = matrixOf(parent, new THREE.Matrix4()).invert();
  const w = matrixOf(world, new THREE.Matrix4());
  return decompose(pInv.multiply(w));
}

/** Which axes of a parent TRS are COLLAPSED (zero scale), or null when it is invertible.
 *
 *  A zero-scaled ancestor maps every descendant onto its own origin, so a world-space placement
 *  under it has NO solution — and both paths used to answer one anyway (owner decision,
 *  2026-07-31; independent review, 2026-07-30). There were two independent wrong answers, and
 *  only ONE of them has since been fixed:
 *   - the DECOMPOSE lie is gone (#258). three.js's `Matrix4.decompose` still substitutes scale
 *     (1,1,1) with an identity quaternion on its `det === 0` branch, but this file no longer asks
 *     it to — `matrixToTrs` goes through `decomposeTrs`, so a collapsed parent now reads back
 *     honestly as scale 0 with its rotation intact.
 *   - the INVERSION is still unsolvable, and always will be: `worldToLocalTrs` inverts the
 *     parent's matrix, and a singular matrix inverts to the zero matrix. No decomposition can
 *     rescue that — the information is gone from the matrix, not from the decomposition.
 *  So this refusal is NOT obsolete now that the decompose half reads true. It is the only thing
 *  standing between a caller and a confidently wrong local transform.
 *
 *  Returned as the offending axis names so the refusal can say WHICH, rather than "unrepresentable".
 *  `1e-9`, not `=== 0`: a scale that has been through a decompose round-trip can carry float dust,
 *  and a parent scaled 1e-12 is collapsed for every practical purpose. */
export function collapsedParentAxes(parent: TRS | null): ('x' | 'y' | 'z')[] | null {
  if (!parent) return null;
  const bad: ('x' | 'y' | 'z')[] = [];
  if (Math.abs(parent.sx) < 1e-9) bad.push('x');
  if (Math.abs(parent.sy) < 1e-9) bad.push('y');
  if (Math.abs(parent.sz) < 1e-9) bad.push('z');
  return bad.length ? bad : null;
}

/** The TRS keys a world→local write must actually persist, given the keys the caller named.
 *
 *  GROUP-WISE, not key-wise (owner decision, 2026-07-31; independent review, 2026-07-30). Both
 *  paths used to write back only the exact keys the caller named, which silently DROPPED the rest
 *  of the answer: under a rotated parent a world X maps onto local x, y AND z together, so a
 *  `{space:'world', x:10}` write kept `x` and discarded the `y`/`z` the conversion had just
 *  computed — leaving the entity where it was (or somewhere wrong) while the route answered
 *  `{ok:true, changed:1}`. The request was satisfiable; the filter threw the solution away.
 *
 *  Expanding by GROUP rather than writing all nine keys is the other half: a position request must
 *  not rewrite rotation/scale, because those come back through a decompose round-trip and would
 *  land float noise on axes the caller never mentioned. Position, rotation and scale are each
 *  internally coupled by the parent's rotation, and mutually independent for this purpose.
 *
 *  Shared by the live and file conversions so the two cannot answer differently. */
const TRS_GROUPS: readonly (readonly (keyof TRS)[])[] = [
  ['x', 'y', 'z'],
  ['rx', 'ry', 'rz'],
  ['sx', 'sy', 'sz'],
];

export function persistedTrsKeys(fields: Record<string, unknown>): (keyof TRS)[] {
  const out: (keyof TRS)[] = [];
  for (const group of TRS_GROUPS) {
    if (group.some((k) => typeof fields[k] === 'number')) out.push(...group);
  }
  return out;
}

/** Merge only the fields the caller actually supplied over a base TRS.
 *
 *  A partial write must convert as a WHOLE POSE, not field-by-field: with a rotated parent, a
 *  world X depends on the child's world Y and Z too, so converting `{x}` alone against a base of
 *  zeros would silently move the other axes. Callers therefore build the full world pose from the
 *  entity's CURRENT world transform, overlay the supplied fields, and convert that. */
export function mergeTrs(base: TRS, fields: Record<string, unknown>): TRS {
  const out = { ...base };
  for (const k of Object.keys(out) as (keyof TRS)[]) {
    const v = fields[k];
    if (typeof v === 'number') out[k] = v;
  }
  return out;
}
