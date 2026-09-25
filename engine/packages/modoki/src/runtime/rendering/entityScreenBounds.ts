/** What a 3D bounds provider MEASURES — the shared body behind BOTH of them: the editor's
 *  SceneView (`surface: 'scene-view'`) and the runtime Scene3D (`'game-3d'`).
 *
 *  Extracted from SceneView's render effect so the decisions in it are unit-testable (the same
 *  move `sceneViewMath.ts` and `pickSelection.ts` made from that file), then lifted here out of
 *  `editor/` so the runtime can share it — `runtime/**` must never import `editor/**`. Sharing
 *  is the point: the two providers answer the same question about different cameras, and the
 *  ONE thing that keeps going wrong is one of them measuring fewer entity kinds than the
 *  surface renders. Scene3D measured only `ecsObjects`, so a skinned character in the GAME view
 *  had no bounds at all and `modoki_tap{entity, surface:'game-3d'}` refused it.
 *
 *  THE INVARIANT THIS MODULE EXISTS TO HOLD (QA-CTX-0006 / QA-SVIEW-0004):
 *  **what is measured must equal what a click can select.** `pickEntityAtViewportPoint` — the
 *  same gather a real pointer-down runs — considers ecsObjects, skinned roots, billboards, SDF
 *  text meshes AND the icon gizmos that stand in for Camera/Light/Environment entities. The
 *  bounds provider covered only the first two, so a human could click a light's icon and select
 *  it while `modoki_tap{entity}` and `get_layout_bounds` both answered "has no screen bounds":
 *  genuinely on screen, genuinely selectable, and un-addressable by name — against the "aim by
 *  NAME, never by pixels" contract, which assumes anything on screen is bounds-addressable.
 *
 *  Two consequences of that invariant are easy to get wrong, and both are what the tests pin:
 *   - an ICON gizmo reports NO `worldAABB`. That field is documented as the entity's true
 *     geometric extent; a Light has none, so the icon's box would be a confident wrong answer.
 *   - a child excluded from PICKING must be excluded from BOUNDS. The camera gizmo's frustum
 *     lines already had a no-op `raycast`, but `Box3.setFromObject` walks them anyway — which
 *     measured the camera at 5613x1981 px, a rect no click inside it selects the camera in.
 *     `userData.noBounds` prunes such a subtree; the flag is set beside the raycast override.
 *
 *  Pure: core `three` math + plain numbers, no DOM, no renderer, no closure capture. */

import * as THREE from 'three';
import { projectAABBToScreen, type BoundsSurface, type EntityScreenBounds, type ViewportRect } from '../core/screenBounds';
import { isPackedAlive } from '../core/ecs/entityTable';
import type { RenderState } from './scene3DSync';

/** One measurable entry: its entity id, the object to measure, and the packed entity
 *  (`entity.valueOf()`) the renderer last reconciled it for — `undefined` when nothing stamped one. */
export type OwnedBoundsEntry = readonly [id: number, object: THREE.Object3D, owner: number | undefined];

/** The live object maps a provider measures, in the order it measures them. Iterables rather
 *  than Maps so a test can pass plain arrays of entries.
 *
 *  EVERY entry carries its OWNER (#1197). The maps are keyed by entity id and swept only on the
 *  renderer's next pass, and koota hands a destroyed entity's index to the next spawn — so between
 *  a destroy + same-index spawn and that pass, an id-only provider reported the DEAD entity's rect
 *  for the newcomer's id, and an entity aim tapped where the dead entity had been. Measured live on
 *  `games/3d-test` (2026-09-14): both `scene-view` and `game-3d` returned the destroyed mesh's rect
 *  for the respawned id inside one task; `uiFocusSystem` reads bounds inside the ECS tick, before
 *  that frame's render sync, which is the same window with no agent involved. A source without an
 *  owner would be silently wrong in exactly that window, so the type does not allow one. */
export interface EntityBoundsSources {
  ecsObjects: Iterable<OwnedBoundsEntry>;
  /** Skinned meshes (SkinnedMeshRenderer): the cloned hierarchy's `root`. */
  skinned: Iterable<OwnedBoundsEntry>;
  billboards: Iterable<OwnedBoundsEntry>;
  textMeshes: Iterable<OwnedBoundsEntry>;
  /** Icon gizmos (Camera / Light / Environment / empty) — measured, but not geometric.
   *  Editor-only; the runtime surface passes none. */
  gizmos?: Iterable<OwnedBoundsEntry>;
}

/** Whether an entry's owner stamp names an entity that is still alive. `undefined` — nothing stamped
 *  the entry — is not alive: unknown must not read as live. Shared by the bounds provider and the
 *  SceneView picker, which gather from the same id-keyed maps and have the same window (#1197). */
export function isLiveOwner(owner: number | undefined): boolean {
  return owner !== undefined && isPackedAlive(owner);
}

/** The sources for one 3D surface, read from its `RenderState` — shared by Scene3D and SceneView so
 *  the two cannot feed different entity kinds, or one of them forget an owner. */
export function boundsSourcesOf(
  state: Pick<RenderState, 'ecsObjects' | 'ecsOwners' | 'skinned' | 'billboards' | 'textMeshes'>,
  gizmos?: Iterable<OwnedBoundsEntry>,
): EntityBoundsSources {
  return {
    ecsObjects: withOwners(state.ecsObjects, state.ecsOwners),
    skinned: (function* () { for (const [id, entry, owner] of state.skinned.owned()) yield [id, entry.root, owner] as const; })(),
    billboards: groupsOf(state.billboards),
    textMeshes: groupsOf(state.textMeshes),
    ...(gizmos ? { gizmos } : {}),
  };
}

function* withOwners(objects: ReadonlyMap<number, THREE.Object3D>, owners: ReadonlyMap<number, number>): Generator<OwnedBoundsEntry> {
  for (const [id, obj] of objects) yield [id, obj, owners.get(id)];
}

function* groupsOf(entries: ReadonlyMap<number, { group: THREE.Object3D; owner: number }>): Generator<OwnedBoundsEntry> {
  for (const [id, entry] of entries) yield [id, entry.group, entry.owner];
}

const _box = new THREE.Box3();
const _childBox = new THREE.Box3();
const _size = new THREE.Vector3();
const _center = new THREE.Vector3();

/** World-space AABB of everything under `obj` that a raycast could actually hit, pruning any
 *  subtree flagged `userData.noBounds`. Unlike `Box3.setFromObject`, which walks every child
 *  regardless. `box` is emptied first and returned for chaining. */
export function expandPickableBounds(box: THREE.Box3, obj: THREE.Object3D, reset = true): THREE.Box3 {
  if (reset) box.makeEmpty();
  if ((obj.userData as { noBounds?: boolean } | undefined)?.noBounds) return box; // prunes the subtree
  const geom = (obj as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
  if (geom) {
    if (!geom.boundingBox) geom.computeBoundingBox();
    if (geom.boundingBox) box.union(_childBox.copy(geom.boundingBox).applyMatrix4(obj.matrixWorld));
  }
  for (const child of obj.children) expandPickableBounds(box, child, false);
  return box;
}

/** Project every measurable entity on one surface to a screen rect.
 *
 *  `ids`, when given, limits the work to those entity ids. An id present in more than one map
 *  is measured ONCE, by the first map that carries it — the maps are not disjoint in principle
 *  and a duplicate rect for one id on one surface is exactly the ambiguity `surface` exists to
 *  remove. A billboard / text mesh that is not `visible` is not measurable: it cannot be
 *  clicked either, which is the invariant. An entry whose owner is missing or no longer alive is not measured at all: it is a dead
 *  entity's object awaiting the next sweep, and its id may already name someone else (#1197). It
 *  does not claim the id either, so a live entry for the same id in a later map still counts. */
export function computeEntityScreenBounds(
  sources: EntityBoundsSources,
  camera: THREE.Camera,
  vp: ViewportRect,
  surface: BoundsSurface,
  ids?: Set<number>,
): EntityScreenBounds[] {
  const out: EntityScreenBounds[] = [];
  const seen = new Set<number>();
  const drawRect = { x: vp.left, y: vp.top, w: vp.width, h: vp.height };

  const project = ([id, obj, owner]: OwnedBoundsEntry, geometric: boolean): void => {
    if (ids && !ids.has(id)) return;
    if (seen.has(id)) return;
    if (!isLiveOwner(owner)) return;
    seen.add(id);
    obj.updateWorldMatrix(true, true);
    if (geometric) _box.setFromObject(obj);
    else expandPickableBounds(_box, obj);
    const { screen, onScreen } = projectAABBToScreen(_box, camera, vp);
    let worldAABB: EntityScreenBounds['worldAABB'];
    if (geometric && !_box.isEmpty()) {
      _box.getSize(_size); _box.getCenter(_center);
      worldAABB = { size: [_size.x, _size.y, _size.z], center: [_center.x, _center.y, _center.z] };
    }
    out.push({ id, layer: '3d', surface, screen, onScreen, drawRect, ...(worldAABB ? { worldAABB } : {}) });
  };

  for (const e of sources.ecsObjects) project(e, true);
  // Skinned roots carry the cloned hierarchy; `setFromObject` uses the bind-pose bounds.
  for (const e of sources.skinned) project(e, true);
  // A billboard / text group that is not `visible` cannot be clicked either — the invariant.
  for (const e of sources.billboards) if (e[1].visible) project(e, true);
  for (const e of sources.textMeshes) if (e[1].visible) project(e, true);
  for (const e of sources.gizmos ?? []) project(e, false);
  return out;
}
