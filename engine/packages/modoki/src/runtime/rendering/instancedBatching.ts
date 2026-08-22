/** Collapse repeated (geometry, material) draws into `THREE.InstancedMesh` (#154 P4b).
 *
 *  ── WHY ──────────────────────────────────────────────────────────────────────────────────
 *  Measured on a Huawei Y6 2019 (PowerVR Rogue GE8300, WebGL2), `games/sling`: an 84 ms frame
 *  of which `cpuMs` is 62.7 and `restMs` only 17.7 — the GPU finishes early and WAITS — with
 *  `frame/render3d-0/submit` at 25 ms across **237 draw calls resolving to 49 geometries**.
 *  CPU-bound on draw SUBMISSION, not on triangles: a draw call costs about the same whether it
 *  draws 200 triangles or 20,000, which is why LOD/decimation (the intuitive fix) would not have
 *  touched it. Sling's field is PAINTED — the level brush spawns a prefab per cell — so the same
 *  kit mesh is drawn 102 and 73 times at different transforms.
 *
 *  ── WHAT MAKES A BATCH KEY, AND WHY IT IS NOT THE AUTHORED GUID ───────────────────────────
 *  `InstancedMesh` shares ONE material across every instance. So the key must be the RESOLVED
 *  geometry+material identity actually bound to the object, never `Renderable3D.material`: two
 *  entities can share that GUID and still resolve to different materials via a per-entity Tint,
 *  a MaterialInstance clone, or a #136 light-mask variant. Merging those would silently relight
 *  or recolour entities — a renderer that is faster and WRONG, which is the worst outcome
 *  available here. Keying off `geometry.uuid|material.uuid` makes that class impossible by
 *  construction: whatever forked the material also forks the key.
 *
 *  Measured on sling before this was written (Phase 1, on-device): 208 renderables resolve to
 *  **11 groups**, 201 of them in the top four, every group `mask:1 | vis:true`. So on that
 *  content nothing forks — but the key is written for the content that does.
 *
 *  ── WHAT IS DELIBERATELY EXCLUDED ─────────────────────────────────────────────────────────
 *  - `THREE.LOD` objects — an LOD picks a child by distance PER OBJECT, which is the opposite of
 *    one instanced draw. Batching them would freeze every instance at one level.
 *  - Anything that is not a plain `THREE.Mesh` (groups, skinned meshes, sprites, text).
 *  - Groups below `MIN_INSTANCES`: an InstancedMesh has its own per-frame matrix upload, so
 *    below a handful of members it is a pessimisation, not a win.
 *
 *  ── WHY DYNAMIC IS FINE (the plan said static-only; the arithmetic disagreed) ──────────────
 *  The plan's Phase 2 scoped this to static renderables, reasoning that moving entities "trade
 *  CPU for CPU". They do not, at this scale: re-writing 200 instance matrices is 200x16 floats
 *  (~12.8 KB) per frame, against 200 driver draw calls it removes. So membership, not motion,
 *  decides a rebuild — and a moving instance costs a matrix write it was already paying inside
 *  `applyTransform`. Kept honest by `MIN_INSTANCES`.
 */

import * as THREE from 'three';
import { onWorldSwap } from '../core/ecs/world';

/** Below this, one InstancedMesh costs more than the draw calls it saves. */
export const MIN_INSTANCES = 6;

export interface BatchGroupStat {
  key: string;
  instances: number;
}

export interface BatchStats {
  /** Objects eligible to be considered (plain meshes, no LOD). */
  considered: number;
  /** Objects actually drawn through an InstancedMesh. */
  batched: number;
  /** InstancedMesh draws replacing them. */
  groups: number;
  /** Draw calls removed = batched - groups. Reported so the win is readable in one number. */
  drawCallsSaved: number;
  /** Why an object was NOT batched, by reason — the field that saves an hour of guessing. */
  skipped: Record<string, number>;
  /** For the `lod` exclusion: how many LOD objects are sitting at each level right now.
   *
   *  Not idle curiosity — it is the whole question for content like sling's, where 204 of 208
   *  renderables are LOD-wrapped kit meshes and the exclusion therefore removes 98% of the
   *  candidates. If every LOD sits at ONE level continuously (a top-down field with a near-fixed
   *  camera), the distance machinery is buying nothing while blocking the batch, and instancing
   *  the selected level is exact. If levels are mixed and churning, it is not. `renderer.calls`
   *  cannot answer that; this can. */
  lodLevels: Record<string, number>;
  top: BatchGroupStat[];
}

/** One thing a batch draws. `obj` is what gets HIDDEN and supplies the world matrix — for a plain
 *  mesh that is the mesh itself, for an LOD it is the WRAPPER (hiding the selected child would
 *  just make three draw the next one). `geo`/`mat` come from whichever mesh is actually drawn. */
interface Candidate {
  obj: THREE.Object3D;
  geo: THREE.BufferGeometry;
  mat: THREE.Material;
  /** Child-relative offset for an LOD level whose mesh is not at the wrapper's origin. Null when
   *  the drawn mesh IS the object, which is the common case and skips a matrix multiply. */
  offset: THREE.Matrix4 | null;
}

interface Group {
  mesh: THREE.InstancedMesh;
  /** Membership signature — a rebuild is needed only when this changes, not when things move.
   *  An LOD crossing a level boundary changes its geometry, hence its bucket, hence the
   *  membership of BOTH buckets — so level changes are picked up without being tracked. */
  signature: string;
  members: Candidate[];
}

const groups = new Map<string, Group>();

/** Objects whose `visible=false` WE set, because a batch is drawing them.
 *
 *  ⚠️ Without this the whole thing works for exactly ONE frame: the pass hides its members, and
 *  the next pass sees `visible === false` and skips them as author-hidden, so every batch
 *  collapses and rebuilds forever. Caught by `lifecycle > rebuilds when membership changes`.
 *  A WeakSet so a disposed mesh is not kept alive by the bookkeeping. */
const hiddenByBatch = new WeakSet<THREE.Object3D>();
const IDENTITY = new THREE.Matrix4();
const _tmp = new THREE.Matrix4();
/** The "nothing batched" reading, SHARED rather than rebuilt.
 *
 *  `clearInstancedBatches` runs on the else branch of every sync — i.e. every frame, on every
 *  surface, for as long as `BATCH_DRAW_CALLS` stays false, which is always today. Allocating a
 *  fresh stats object (plus two maps and an array) there put four allocations per frame per
 *  surface into the render loop of every game, to report a result that never changes. Frozen so a
 *  consumer cannot make the shared instance lie. */
const EMPTY_STATS: BatchStats = Object.freeze({
  considered: 0, batched: 0, groups: 0, drawCallsSaved: 0,
  skipped: Object.freeze({}) as Record<string, number>,
  lodLevels: Object.freeze({}) as Record<string, number>,
  top: Object.freeze([]) as unknown as BatchGroupStat[],
});

let lastStats: BatchStats = EMPTY_STATS;

/** The most recent batching result — surfaced through `readRenderer`'s neighbours so the effect
 *  is readable without an eval. `calls` alone cannot say WHY it changed. */
export function getBatchStats(): BatchStats {
  return lastStats;
}

function disposeGroup(g: Group): void {
  // Removed from ITS OWN parent, never from a scene passed in by the caller: with one module-global
  // `groups` map and more than one scene, a caller's scene and the group's scene can differ, and
  // `otherScene.remove(mesh)` is a silent no-op. That left the InstancedMesh drawing in its real
  // scene with its members un-hidden again — every batched mesh rendered TWICE.
  g.mesh.removeFromParent();
  g.mesh.dispose();
  // Restore the individual meshes — the batch borrowed their visibility, it does not own it.
  for (const c of g.members) { if (hiddenByBatch.delete(c.obj)) c.obj.visible = true; }
}

/** Drop THIS scene's batches and un-hide their members. Called on teardown and whenever batching
 *  is disabled, so turning it off can never leave a scene half-hidden.
 *
 *  ⚠️ SCENE-SCOPED, because `groups` is module-global while scenes are not. The editor runs the
 *  Game panel (batching ON is the only place it ships) and the SceneView (batching always OFF —
 *  it picks by raycasting the meshes a batch hides) against ONE module instance, so an unfiltered
 *  clear would let the SceneView's sync dispose the Game panel's batches every frame and the game
 *  rebuild them every frame — a dispose/rebuild loop, i.e. pipeline churn, from a function whose
 *  job is cleanup. Filter by parent so each caller only ever clears what it owns. */
export function clearInstancedBatches(scene: THREE.Scene): void {
  // `groups.size === 0` is the COMMON case — see EMPTY_STATS. Skip the spread copy as well as the
  // object literal, so the always-taken path costs one map read.
  if (groups.size > 0) {
    for (const [key, g] of [...groups]) {
      const parent = g.mesh.parent;
      // A PARENTLESS group is an orphan — its scene was torn down or cleared without going through
      // here, so nobody else can ever reclaim it. Skipping it (which scoping by `parent === scene`
      // alone did) strands its members hidden forever and leaks the InstancedMesh plus strong refs
      // to every member. Only a group living in ANOTHER scene is off limits.
      if (parent !== scene && parent !== null) continue;
      disposeGroup(g);
      groups.delete(key);
    }
  }
  lastStats = EMPTY_STATS;
}

/** Drop EVERY batch, whatever scene it belongs to — the world itself is going away, so there is no
 *  other scene left to protect. Registered below on `onWorldSwap`, which is the idiom every sibling
 *  module-level cache in this directory already uses (`flameMeshSync`'s lathe cache,
 *  `blobShadowSync`'s quad, `scene3DSync`'s tint clones). Without it, a world swap with batching ON
 *  left the previous scene's groups in the map: the retire pass only ever looks at the scene it was
 *  handed, and the old scene is never handed to anything again. */
export function clearAllInstancedBatches(): void {
  for (const g of groups.values()) disposeGroup(g);
  groups.clear();
  lastStats = EMPTY_STATS;
}
onWorldSwap(clearAllInstancedBatches);

/** Group the given objects and draw each qualifying group through one InstancedMesh.
 *
 *  Call AFTER the per-entity sync has settled geometry, material and world transform — this
 *  reads what that produced and never decides any of it. */
export function applyInstancedBatching(
  scene: THREE.Scene,
  objects: Iterable<THREE.Object3D>,
): BatchStats {
  const buckets = new Map<string, Candidate[]>();
  const skipped: Record<string, number> = {};
  const lodLevels: Record<string, number> = {};
  const skip = (reason: string) => { skipped[reason] = (skipped[reason] ?? 0) + 1; };
  let considered = 0;

  for (const obj of objects) {
    // Author-hidden is a real exclusion; batch-hidden is OUR doing and must not exclude.
    if (!obj.visible && !hiddenByBatch.has(obj)) { skip('invisible'); continue; }
    let mesh: THREE.Mesh;
    let offset: THREE.Matrix4 | null = null;
    if ((obj as THREE.LOD).isLOD) {
      // PER-LEVEL BATCHING. An LOD picks its child by distance, so batching the wrapper is
      // meaningless — but batching everything currently AT a given level is exact, because three
      // has already made that choice for us. `lod.update(camera)` runs during projection, so the
      // level here is the one actually drawn last frame, not a guess from distance.
      //
      // Measured on sling (Y6): 183 tiles at L0, 21 at L1, byte-identical across samples — a
      // top-down field with a near-fixed camera. Excluding LODs outright (the first version of
      // this module) skipped 204 of 208 candidates and batched NOTHING.
      const lod = obj as THREE.LOD & { getCurrentLevel?: () => number; levels: { object: THREE.Object3D }[] };
      let level = 0;
      try { if (typeof lod.getCurrentLevel === 'function') level = lod.getCurrentLevel(); } catch { /* level 0 */ }
      lodLevels[`L${level}`] = (lodLevels[`L${level}`] ?? 0) + 1;
      const child = lod.levels?.[level]?.object as THREE.Mesh | undefined;
      if (!child || !child.isMesh) { skip('lod-level-not-a-mesh'); continue; }
      mesh = child;
      // The child usually sits at the wrapper's origin; compose only when it does not, so the
      // common case costs nothing.
      if (!child.matrix.equals(IDENTITY)) offset = child.matrix;
    } else {
      mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) { skip('not-a-mesh'); continue; }
      if ((mesh as unknown as { isInstancedMesh?: boolean }).isInstancedMesh) continue; // ours
    }
    if (Array.isArray(mesh.material)) { skip('multi-material'); continue; }
    const geo = mesh.geometry;
    const mat = mesh.material as THREE.Material;
    if (!geo || !mat) { skip('no-geometry-or-material'); continue; }
    considered++;
    // THE KEY: resolved identity. A Tint clone, a MaterialInstance clone and a light-mask
    // variant are all DIFFERENT material objects, so each lands in its own bucket without this
    // code needing to know they exist.
    const key = `${geo.uuid}|${mat.uuid}`;
    let list = buckets.get(key);
    if (!list) { list = []; buckets.set(key, list); }
    list.push({ obj, geo, mat, offset });
  }

  const seen = new Set<string>();
  let batched = 0;
  const top: BatchGroupStat[] = [];

  for (const [key, members] of buckets) {
    if (members.length < MIN_INSTANCES) { skip('below-threshold'); continue; }
    seen.add(key);
    const signature = `${members.length}:${members[0].obj.id}:${members[members.length - 1].obj.id}`;
    let g = groups.get(key);
    if (g && g.signature !== signature) { disposeGroup(g); groups.delete(key); g = undefined; }
    if (!g) {
      const src = members[0];
      const inst = new THREE.InstancedMesh(src.geo, src.mat, members.length);
      inst.castShadow = src.obj.castShadow;
      inst.receiveShadow = src.obj.receiveShadow;
      // The members' own world matrices are absolute, so the batch must not add its own.
      inst.matrixAutoUpdate = false;
      inst.frustumCulled = false;   // per-instance culling is not a thing; the group is one draw
      inst.layers.mask = src.obj.layers.mask;
      scene.add(inst);
      g = { mesh: inst, signature, members };
      groups.set(key, g);
    } else {
      g.members = members;
    }
    // Matrices every frame: cheap (16 floats each) next to the draw calls removed, and it makes
    // motion a non-issue rather than a special case.
    for (let i = 0; i < members.length; i++) {
      const c = members[i];
      c.obj.updateWorldMatrix(true, false);
      if (c.offset) {
        _tmp.multiplyMatrices(c.obj.matrixWorld, c.offset);
        g.mesh.setMatrixAt(i, _tmp);
      } else {
        g.mesh.setMatrixAt(i, c.obj.matrixWorld);
      }
      // Hide the OBJECT (for an LOD, the wrapper) — hiding the selected child would just make
      // three fall through to drawing another level.
      c.obj.visible = false; hiddenByBatch.add(c.obj);
    }
    g.mesh.count = members.length;
    g.mesh.instanceMatrix.needsUpdate = true;
    batched += members.length;
    top.push({ key: key.slice(0, 8), instances: members.length });
  }

  // Retire batches whose group no longer qualifies — restoring their members' visibility.
  // SCOPED to this scene: a group belonging to another scene was not a candidate for this call, so
  // "not seen" says nothing about whether it still qualifies. Unscoped, a second scene's pass
  // retired the first's batches on sight — and did it while passing the WRONG scene to the dispose,
  // so the batch stayed in its real scene and drew alongside the members it had just un-hidden.
  for (const [key, g] of [...groups]) {
    const parent = g.mesh.parent;
    if (!seen.has(key) && (parent === scene || parent === null)) { disposeGroup(g); groups.delete(key); }
  }

  top.sort((a, b) => b.instances - a.instances);
  lastStats = {
    // THIS scene's groups (`seen`), not the module-wide map — with several scenes the map counts
    // batches this call never looked at, which would make `drawCallsSaved` subtract them too.
    considered, batched, groups: seen.size,
    drawCallsSaved: Math.max(0, batched - seen.size),
    skipped, lodLevels, top: top.slice(0, 8),
  };
  return lastStats;
}
