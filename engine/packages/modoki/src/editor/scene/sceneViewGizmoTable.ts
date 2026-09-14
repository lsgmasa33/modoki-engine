/** SceneView's per-entity gizmos — the icon or volume that makes an otherwise invisible entity
 *  clickable and draggable in the viewport — and the ONE place that decides who owns a gizmo slot.
 *
 *  ## Why a table and not an id-keyed map (#1206)
 *
 *  Seven loops (camera, environment, light, particle, CameraFrame box, Zone3D volume, empty marker)
 *  share one slot per entity index. They used to share a `Map<number, Object3D>` plus seven
 *  last-frame id sets and a separate owner-stamp map (#1197), and each loop decided "is this row
 *  mine?" from the INDEX — the row was present, or the id was in its own set last frame. koota hands
 *  a destroyed entity's index to the next spawn, so a destroy and a cross-kind respawn in one frame
 *  defeated all of it. Measured live on `games/3d-test` (2026-09-14): a dead Environment's and a dead
 *  Light's icon stayed drawn after a Camera took the index; an empty marker's loop adopted the shared
 *  camera pivot and left the Camera's scale on it for the life of the scene; and a Camera+Light entity
 *  cast the pivot to a Mesh and threw inside the frame callback every frame (the driver logged
 *  `threw (1/10)`: it unregisters a callback after ten consecutive throws, and the entity was deleted
 *  after six, so the unregistration itself was not observed).
 *
 *  So a row carries its KIND and, through `EntityTable`, the generation of the entity it was built
 *  for. A loop claims or keeps rows for the entities it visits; one sweep per pass disposes every row
 *  nobody kept, whatever took its index since.
 *
 *  ## Two kinds on one live entity
 *
 *  One slot, so one gizmo shows. `GIZMO_RANK` picks it (owner, 2026-09-14): it keeps the gizmo that
 *  used to be standing at the end of a frame for every pairing that rendered correctly, so a
 *  toggled-on CameraFrame box or a Zone3D volume still shows over a camera icon.
 *
 *  A lower-ranked claim yields to a higher-ranked row — unless that row's own loop has ALREADY run
 *  this pass and did not keep it, which means it is on its way out (a CameraFrame box toggled off
 *  this frame). Without that exception the empty marker could not take over until the next pass, and
 *  on a render-on-demand viewport there may not be one. Loops therefore have to run in
 *  `GIZMO_LOOP_ORDER`; a claim that arrives out of order reports itself once.
 *
 *  ## Disposal
 *
 *  A released row is removed from the scene and its material disposed — never an object named
 *  `shared` (the camera pivot, reused by every Camera across world swaps), and never its geometry,
 *  which is a `GIZMO_SHAPES.*` instance shared by every gizmo of that shape. The exception is a
 *  Zone3D capsule, whose radius and length are independent, so SceneView builds one per zone and tags
 *  it `userData.zoneCapSig`: nothing else owns that geometry. */

import type * as THREE from 'three';
import type { Entity } from 'koota';
import { EntityTable, type PackedEntity } from '../../runtime/core/ecs/entityTable';

export type GizmoKind = 'camera' | 'environment' | 'light' | 'particle' | 'frameBox' | 'zone' | 'empty';

/** The order SceneView's gizmo loops run in each pass. */
export const GIZMO_LOOP_ORDER: readonly GizmoKind[] = ['camera', 'environment', 'light', 'particle', 'frameBox', 'zone', 'empty'];

/** Lowest to highest: which gizmo shows when one entity qualifies for two. */
export const GIZMO_RANK: readonly GizmoKind[] = ['empty', 'particle', 'light', 'environment', 'camera', 'frameBox', 'zone'];

interface GizmoRow {
  readonly kind: GizmoKind;
  readonly object: THREE.Object3D;
  /** The pass this row was last claimed or kept in. */
  pass: number;
}

export interface SceneViewGizmoTableOptions {
  scene: THREE.Scene;
  /** Objects that outlive every row holding them — added once and never removed or disposed. */
  shared?: ReadonlySet<THREE.Object3D>;
  /** Called once when a loop claims out of `GIZMO_LOOP_ORDER`. Defaults to `console.warn`. */
  onOrderViolation?: (message: string) => void;
}

export class SceneViewGizmoTable {
  private readonly scene: THREE.Scene;
  private readonly shared: ReadonlySet<THREE.Object3D>;
  private readonly onOrderViolation: (message: string) => void;
  // Owner-cleared: SceneView calls `clear()` from its `onWorldSwap` handler and from its teardown.
  private readonly table: EntityTable<GizmoRow>;
  private pass = 0;
  private lastLoop: GizmoKind | undefined;
  private orderReported = false;

  constructor(opts: SceneViewGizmoTableOptions) {
    this.scene = opts.scene;
    this.shared = opts.shared ?? new Set();
    this.onOrderViolation = opts.onOrderViolation ?? ((m) => console.warn(m));
    this.table = new EntityTable<GizmoRow>({
      label: 'SceneView gizmos',
      dispose: (row) => this.release(row.object),
      worldSwap: 'owner-clears',
    });
  }

  get size(): number { return this.table.size; }

  /** Open a pass. Every row not claimed or kept before `endPass` is released. */
  beginPass(): void {
    this.pass++;
    this.lastLoop = undefined;
    this.table.beginPass();
  }

  endPass(): void {
    this.table.endPass();
  }

  /** The gizmo `kind`'s loop draws for `entity` this pass: the existing one when it is still this
   *  entity's, of this kind, and (when `fits` is given) still the right shape; otherwise a new one
   *  from `create`, added to the scene, replacing (and releasing) whatever held the slot. Returns
   *  `undefined` — draw nothing — when a higher-ranked gizmo holds the slot for this entity, or when
   *  `entity` is dead. */
  claim(entity: Entity, kind: GizmoKind, create: () => THREE.Object3D, fits?: (object: THREE.Object3D) => boolean): THREE.Object3D | undefined {
    this.enterLoop(kind);
    if (!entity.isAlive()) return undefined;
    const row = this.table.get(entity);
    if (row) {
      if (row.kind === kind) {
        if (!fits || fits(row.object)) {
          row.pass = this.pass;
          this.table.touch(entity);
          return row.object;
        }
      } else if (this.yieldsTo(kind, row)) {
        return undefined;
      }
    }
    const object = create();
    if (object.parent !== this.scene) this.scene.add(object);
    this.table.set(entity, { kind, object, pass: this.pass });
    return object;
  }

  /** Keep `entity`'s `kind` gizmo alive this pass without drawing it — for a loop that leaves a
   *  deactivated entity selectable. A row of another kind, or another entity's, is left alone. */
  keep(entity: Entity, kind: GizmoKind): void {
    this.enterLoop(kind);
    const row = this.table.get(entity);
    if (!row || row.kind !== kind) return;
    row.pass = this.pass;
    this.table.touch(entity);
  }

  /** The gizmo last drawn at index `id` — NOT generation-checked. For an id-only reader that treats
   *  it as "what is on screen there" (focus, the transform-gizmo target), never as whose it is. */
  peekId(id: number): THREE.Object3D | undefined {
    return this.table.peekId(id)?.object;
  }

  kindAt(id: number): GizmoKind | undefined {
    return this.table.peekId(id)?.kind;
  }

  /** Every gizmo with the packed entity it was built for — dead owners included, so a picker or a
   *  bounds provider can refuse one before the next sweep (#1197). */
  *owned(): IterableIterator<[number, THREE.Object3D, PackedEntity]> {
    for (const [id, row, owner] of this.table.owned()) yield [id, row.object, owner];
  }

  *[Symbol.iterator](): IterableIterator<[number, THREE.Object3D, GizmoKind]> {
    for (const [id, row] of this.table) yield [id, row.object, row.kind];
  }

  /** Release every gizmo (a world swap, or the panel's teardown). */
  clear(): void {
    this.lastLoop = undefined;
    this.table.clear();
  }

  /** A `claimant` yields to a different kind's row when that row outranks it, unless the row's own
   *  loop has already run this pass and did not keep it. */
  private yieldsTo(claimant: GizmoKind, row: GizmoRow): boolean {
    if (GIZMO_RANK.indexOf(row.kind) < GIZMO_RANK.indexOf(claimant)) return false;
    const rowLoopStillToRun = GIZMO_LOOP_ORDER.indexOf(row.kind) > GIZMO_LOOP_ORDER.indexOf(claimant);
    return row.pass === this.pass || rowLoopStillToRun;
  }

  private enterLoop(kind: GizmoKind): void {
    const last = this.lastLoop;
    if (last !== undefined && GIZMO_LOOP_ORDER.indexOf(kind) < GIZMO_LOOP_ORDER.indexOf(last) && !this.orderReported) {
      this.orderReported = true;
      this.onOrderViolation(`[SceneViewGizmoTable] the '${kind}' loop ran after the '${last}' loop — rank ties between them resolve wrongly until the loops run in GIZMO_LOOP_ORDER`);
    }
    this.lastLoop = kind;
  }

  private release(object: THREE.Object3D): void {
    if (this.shared.has(object)) return;
    this.scene.remove(object);
    const material = (object as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(material)) for (const m of material) m.dispose();
    else material?.dispose();
    if ((object.userData as { zoneCapSig?: string }).zoneCapSig) (object as THREE.Mesh).geometry?.dispose();
  }
}
