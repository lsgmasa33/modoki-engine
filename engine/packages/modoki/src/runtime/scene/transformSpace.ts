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
import type { LocalFit2D } from '../core/ecs/localFit2D';

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
  return chainOf(fileHierarchy(entities), entity);
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

/** An entry's WORLD pose: its own local transform under its whole parent chain. */
export function worldTrsOf(entities: MutableEntity[], entity: MutableEntity): TRS {
  return localToWorldTrs(trsOf(entity), parentWorldTrs(entities, entity));
}

/** The Transform an entry STORES — an instance root's in its overrides, anything else's in its traits — or undefined
 *  when it stores none. `trsOf` reads the same place and substitutes identity for a missing one, which is right for an
 *  ancestor chain but not for a writer deciding whether there is a pose to keep. */
export function storedTransformOf(entity: MutableEntity): Record<string, unknown> | undefined {
  const t = instanceOverrideTraits(entity)?.Transform ?? (entity.prefab ? undefined : entity.traits?.Transform);
  return t && typeof t === 'object' ? (t as Record<string, unknown>) : undefined;
}

/** Is this entry's LOCAL pose only partly in this file? A prefab instance root whose override Transform does not store
 *  all nine fields takes the rest from a template the file does not hold; `trsOf` reads identity there, which is right
 *  only by luck. A plain entry's omitted field IS its default (the serializer omits exactly those). */
export function isTemplatePlaced(e: MutableEntity): boolean {
  if (!e.prefab) return false;
  const t = instanceOverrideTraits(e)?.Transform as Record<string, unknown> | undefined;
  return !t || !TRS_KEYS.every((k) => typeof t[k] === 'number');
}

/** A parent hierarchy a reparent walks: the scene FILE's entries ({@link fileHierarchy}), or the LIVE world read on demand
 *  (`liveHierarchy` in `editor/undo/entityActions.ts`). `places` says whether a node holds its children in its frame —
 *  one with no Transform does not, and `transformPropagationSystem` puts its children at the root (world = local), so a
 *  chain ends there and such a new parent is the root (#1848 close-out: composing past it moved the mover by its
 *  ancestors' offset). `unreadable` names a node whose local pose the source cannot read in full — the file has two: an
 *  instance root placed partly by its template, and a Frame2D fitted to its canvas. `fitOf` is a node's `Frame2D` fit,
 *  folded into its local exactly as `transformPropagationSystem` folds it (#1952) — only the live world knows one, since
 *  a fit depends on the screen. */
export interface PoseHierarchy<N> {
  parentOf(node: N): N | null;
  places(node: N): boolean;
  trsOf(node: N): TRS;
  unreadable?(node: N): boolean;
  fitOf?(node: N): LocalFit2D | undefined;
}

/** The scene file's entries as a {@link PoseHierarchy}: parent refs of either form, an instance root's pose from its
 *  overrides, and `isTemplatePlaced` or {@link isFitted2D} as the unreadable test. A plain entry with no `traits.Transform`
 *  loads with none, so it places nothing. An instance entry is read as placing: live it places only when its template
 *  root has a Transform, which this file cannot see (docs/scene-loading.md § "A reparent keeps the world pose"). */
export function fileHierarchy(entities: MutableEntity[]): PoseHierarchy<MutableEntity> {
  // Index by EVERY addressable key (numeric id AND guid), because a parent ref is a GUID in current files and a number in
  // legacy ones — a map keyed on `e.id` alone could never match the common case, which is exactly how this returned "no
  // parent" for every real entity. A missing parent reads as the root: a dangling `parentId` is not treated as an error
  // (`mutate_scene` already warns about those separately, and a conversion is not the place to fail the whole op).
  const byKey = new Map<string | number, MutableEntity>();
  for (const e of entities) for (const k of keysOf(e)) if (!byKey.has(k)) byKey.set(k, e);
  const parentOf = (e: MutableEntity) => { const ref = parentRefOf(e); return (ref && byKey.get(ref)) || null; };
  return {
    parentOf,
    places: (e) => !!e.prefab || !!e.traits?.Transform,
    trsOf,
    unreadable: (e) => isTemplatePlaced(e) || isFitted2D(e, parentOf(e)),
  };
}

/** May the runtime fit this entry to its canvas (#1952)? A `Frame2D` directly under a `Canvas2D`, the only place
 *  `rendering/frame2D.ts` fits one. The fit depends on what part of the canvas is on screen, which a file cannot know, so
 *  a reparent across one cannot keep the world pose here — inventing a fit (the reference rect, say) would be right only
 *  on the one screen shape that happens to match. A prefab-instance PARENT may be a canvas through its template, which
 *  this file cannot read, so it counts as one. KNOWN GAP: a Frame2D only an instance's TEMPLATE carries (not its
 *  overrides) is not seen; no prefab in the repo carries one (2026-10-02). */
export function isFitted2D(e: MutableEntity, parent: MutableEntity | null): boolean {
  if (!e.traits?.Frame2D && !instanceOverrideTraits(e)?.Frame2D) return false;
  return !!parent && (!!parent.traits?.Canvas2D || !!parent.prefab);
}

/** The entry whose fit decides `entity`'s world pose and that the file cannot know (#1952): `entity` itself or an
 *  ancestor placing it, being a Frame2D fitted to its canvas ({@link isFitted2D}). Null when no fit takes part. */
export function fittedOnChain(entities: MutableEntity[], entity: MutableEntity): MutableEntity | null {
  const h = fileHierarchy(entities);
  return [entity, ...chainOf(h, entity)].find((e) => isFitted2D(e, h.parentOf(e))) ?? null;
}

/** `node`'s ancestors that place it, root-first. Stops at a missing parent, one that places nothing (`places`), a cycle,
 *  or the depth cap. */
function chainOf<N>(h: PoseHierarchy<N>, node: N): N[] {
  const chain: N[] = [];
  const seen = new Set<N>([node]);
  for (let p = h.parentOf(node), depth = 0; p != null && h.places(p) && !seen.has(p) && depth < MAX_DEPTH; p = h.parentOf(p), depth++) {
    seen.add(p);
    chain.unshift(p);
  }
  return chain;
}

/** What a reparent of `entity` under `newParent` (null = the root) actually depends on (#1847): the two parent chains
 *  BELOW their shared prefix, each node with its `fitOf` fit folded in (#1952: a Frame2D host on either suffix, so a
 *  drag into or out of a fitted subtree keeps the pose as drawn). The MOVER's own fit is deliberately not compensated:
 *  a Frame2D is re-fitted by its new parent, its authored box kept, which is what the trait is for. new local = inv(to) · from · local, because the shared part cancels (exactly for suffixes
 *  without shear: each suffix is decomposed to one TRS, as `parentWorldTrs` decomposes a whole chain) — so a node on it
 *  whose pose the source cannot read (`unreadable`) does not matter, and one on either suffix does (`unknown`). */
export function reparentSuffixes<N>(h: PoseHierarchy<N>, entity: N, newParent: N | null):
  { from: TRS | null; to: TRS | null; unknown?: N } {
  const oldChain = chainOf(h, entity);                                          // root-first, ends at the old parent
  const newChain = newParent != null && h.places(newParent) ? [...chainOf(h, newParent), newParent] : [];
  let k = 0;
  while (k < oldChain.length && k < newChain.length && oldChain[k] === newChain[k]) k++;
  const unknown = h.unreadable ? [...oldChain.slice(k), ...newChain.slice(k)].find((n) => h.unreadable!(n)) : undefined;
  return { from: composeChain(h, oldChain.slice(k)), to: composeChain(h, newChain.slice(k)), ...(unknown !== undefined ? { unknown } : {}) };
}

/** `node`'s local pose with its `fitOf` fit folded in FIELD BY FIELD, as transformPropagationSystem folds it (#1952). A
 *  fit matrix before the local agrees only when its scale commutes with the host's rotation: a turned `stretch` host's
 *  child landed 30 px off. */
export function fittedLocalTrs(t: TRS, fit: LocalFit2D | undefined): TRS {
  return fit ? { ...t, x: fit.x + fit.kx * t.x, y: fit.y + fit.ky * t.y, sx: fit.kx * t.sx, sy: fit.ky * t.sy } : t;
}

/** A root-first chain composed to one TRS, each node's fit folded in; null for an empty chain. */
function composeChain<N>(h: PoseHierarchy<N>, chain: N[]): TRS | null {
  if (!chain.length) return null;
  _acc.identity();
  for (const a of chain) _acc.multiply(matrixOf(fittedLocalTrs(h.trsOf(a), h.fitOf?.(a)), _m));
  return decompose(_acc);
}

/** The frame `node`'s local pose lives in, before its own fit: its whole parent chain composed, each ancestor's fit
 *  folded in. Null at the root. With a live hierarchy whose `fitOf` is `frame2DFitNow` this is what the NEXT pass will
 *  compose, so a world write in the same op list as a reparent or a Frame2D edit lands where it was asked to (#2047). */
export function parentChainTrs<N>(h: PoseHierarchy<N>, node: N): TRS | null {
  return composeChain(h, chainOf(h, node));
}

/** The MINIMAL local write that keeps a reparented entity's world pose — the one owner every reparent route computes with
 *  (#1848): the live reparent, the live scene move, and the file route. `from`/`to` are the old and new parent chains
 *  below their shared prefix ({@link reparentSuffixes}); `local` is the entity's own LOCAL transform — never a cached world
 *  pose, which misses a parent created, or a mover edited, since the last propagation pass.
 *
 *  Only what the move changes is written, as Unity keeps `localRotation` and `localScale` when the linear part is unchanged
 *  (docs/scene-loading.md § "A reparent keeps the world pose"). The position group when it moves. The rotation and scale groups only when the
 *  LINEAR part changes (`sameRotationScale`) — a decomposition picks its own Euler angles and mirror axis, so writing all
 *  nine re-spelled an untouched `{sy:-1}` as `{sx:-1, rz:-π}` and a backwards yaw as `{rx:-π, ry:…, rz:-π}` on every move.
 *  A pure turn keeps the authored scale, mirror sign included (`rotationKeepingScale`), with a fresh XYZ spelling of the
 *  new rotation (the hub's D1: Unity's runtime value is a quaternion). `positionOnly` compensates the position alone, for
 *  a pose whose rotation and scale the caller cannot write (a template-placed instance root in the file).
 *
 *  `null` write: nothing moves (the suffixes compose to the same matrix). `collapsed`: the new suffix has ZERO scale on
 *  those axes, so no local transform keeps the pose, and the caller refuses the move. */
export function reparentWrite(local: TRS, from: TRS | null, to: TRS | null, opts?: { positionOnly?: boolean }):
  { write: Partial<TRS> | null } | { collapsed: ('x' | 'y' | 'z')[] } {
  if (sameTrsMatrix(from, to)) return { write: null };
  const collapsed = collapsedParentAxes(to);
  if (collapsed) return { collapsed };
  const next = worldToLocalTrs(localToWorldTrs(local, from), to);
  const write: Partial<TRS> = {};
  if (TRS_GROUPS[0]!.some((k) => Math.abs(next[k] - local[k]) > 1e-9)) for (const k of TRS_GROUPS[0]!) write[k] = next[k];
  if (!opts?.positionOnly && !sameRotationScale(next, local)) {
    // A pure turn writes only the rotation; the scale group is written only when the linear part changed scale or shear
    // too (then the decomposition's spelling is all there is).
    const turned = rotationKeepingScale(next, local);
    if (turned) Object.assign(write, turned);
    else for (const k of [...TRS_GROUPS[1]!, ...TRS_GROUPS[2]!]) write[k] = next[k];
  }
  return { write: Object.keys(write).length ? write : null };
}

/** Do two poses compose to the same matrix (null = identity)? Unlike comparing fields, this sees `{sy:-1}` and
 *  `{sx:-1, rz:π}` as the same pose — the ambiguity a compose/decompose round trip introduces. */
export function sameTrsMatrix(a: TRS | null, b: TRS | null): boolean {
  const ma = matrixOf(a ?? IDENTITY_TRS, new THREE.Matrix4()).elements;
  const mb = matrixOf(b ?? IDENTITY_TRS, new THREE.Matrix4()).elements;
  return ma.every((v, i) => Math.abs(v - mb[i]!) <= 1e-9);
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
const TRS_KEYS: readonly (keyof TRS)[] = ['x', 'y', 'z', 'rx', 'ry', 'rz', 'sx', 'sy', 'sz'];
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

const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
/** Whether two Euler triples (XYZ) are the SAME orientation. Euler components are coupled, so a pose that
 *  went through a matrix decomposition comes back in another spelling of one rotation — `ry: π` returns as
 *  `(-π, ~0, -π)` — and a per-component compare reads two equal orientations as three different fields. */
export function sameOrientation(a: Pick<TRS, 'rx' | 'ry' | 'rz'>, b: Pick<TRS, 'rx' | 'ry' | 'rz'>): boolean {
  _qa.setFromEuler(_euler.set(a.rx, a.ry, a.rz));
  _qb.setFromEuler(_euler.set(b.rx, b.ry, b.rz));
  return 1 - Math.abs(_qa.dot(_qb)) <= 1e-9;
}

const _ma = new THREE.Matrix4();
const _mb = new THREE.Matrix4();
const _sa = new THREE.Vector3();
const _sb = new THREE.Vector3();
const _zero = new THREE.Vector3();
/** The rotation that, with `scale`'s own (authored) scale, composes `pose`'s linear part — or null when no proper
 *  rotation does (the linear part really changed scale or shear). A reparent that turns a mirrored entity keeps its
 *  authored mirror this way: `{sy:-1}` stays `sy:-1` with a new rotation, where a decomposition would move the mirror
 *  to `sx` and add π (#1847 close-out, fourth review). */
export function rotationKeepingScale(pose: TRS, scale: Pick<TRS, 'sx' | 'sy' | 'sz'>): Pick<TRS, 'rx' | 'ry' | 'rz'> | null {
  if (!scale.sx || !scale.sy || !scale.sz) return null;
  _ma.compose(_zero, _qa.setFromEuler(_euler.set(pose.rx, pose.ry, pose.rz)), _sa.set(pose.sx, pose.sy, pose.sz));
  _ma.multiply(_mb.makeScale(1 / scale.sx, 1 / scale.sy, 1 / scale.sz));
  // `pose` is a TRS, so its linear part is R·D and R·D·diag(1/s) = R·diag(D/s): the columns are orthogonal by
  // construction, and only their LENGTHS (a scale change) and the SIGN (a mirror moved between axes) can disqualify it.
  const e = _ma.elements;
  const unit = (i: number) => Math.abs(e[i * 4]! ** 2 + e[i * 4 + 1]! ** 2 + e[i * 4 + 2]! ** 2 - 1) <= 1e-6;
  if (![0, 1, 2].every(unit)) return null;
  if (_ma.determinant() <= 0) return null;
  _euler.setFromRotationMatrix(_ma, 'XYZ');
  return { rx: _euler.x, ry: _euler.y, rz: _euler.z };
}

/** Whether two poses have the SAME rotation-and-scale — the linear part of the transform, compared as one matrix.
 *  Rotation and a NEGATIVE scale are coupled as well: a decomposition puts a mirror's sign on whichever axis it
 *  likes, so `sz: -1` comes back as `sx: -1` turned π about y. Per field, or rotation apart from scale, those read
 *  as different poses. */
export function sameRotationScale(
  a: Pick<TRS, 'rx' | 'ry' | 'rz' | 'sx' | 'sy' | 'sz'>, b: Pick<TRS, 'rx' | 'ry' | 'rz' | 'sx' | 'sy' | 'sz'>,
): boolean {
  _ma.compose(_zero, _qa.setFromEuler(_euler.set(a.rx, a.ry, a.rz)), _sa.set(a.sx, a.sy, a.sz));
  _mb.compose(_zero, _qb.setFromEuler(_euler.set(b.rx, b.ry, b.rz)), _sb.set(b.sx, b.sy, b.sz));
  // Each COLUMN at its own scale: one tolerance sized by the largest axis hid a real change on the others
  // (`sx: 10000` swallowed an `rx: 0.005` tilt).
  const sa = [a.sx, a.sy, a.sz], sb = [b.sx, b.sy, b.sz];
  return _ma.elements.every((v, i) => {
    const col = Math.floor(i / 4);
    if (col > 2) return true;
    return Math.abs(v - _mb.elements[i]!) <= 1e-6 * Math.max(1, Math.abs(sa[col]!), Math.abs(sb[col]!));
  });
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
