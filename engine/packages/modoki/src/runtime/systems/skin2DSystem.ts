/** skin2DSystem — CPU linear-blend skinning for `SkinnedSprite2D` entities (the 2D
 *  analogue of the 3D `syncBones`). Registered at `SYSTEM_PRIORITY.TRANSFORM + 1`
 *  (201) so it runs even when the sim is Stopped/Paused — dragging a `Bone2D` in the
 *  editor deforms the mesh live (hand-posing), exactly like the 3D bone bridge.
 *
 *  Per `SkinnedSprite2D` entity, each frame:
 *   1. Resolve the rig (`getRig2D`) — skip the frame if it's still loading.
 *   2. Collect the entity's descendant `Bone2D` entities (nearest-ancestor match)
 *      and compose each bone's ROOT-LOCAL matrix from the chain of LOCAL Transforms
 *      (self-contained: does NOT depend on world transform propagation).
 *   3. `skinMatrix[b] = rootLocalNow[b] · invBind[b]` (identity at bind pose; a
 *      missing live bone falls back to identity so its verts sit at bind).
 *   4. Linear-blend-skin each vertex into the entity's `skin2DBuffers` entry.
 *
 *  Deterministic (no wall-clock / RNG). The per-vertex work is gated behind a cheap
 *  per-bone skinning-matrix comparison, so an idle rig re-skins nothing and never
 *  bumps its deform version (Scene2D then skips the GPU re-upload). */

import type { World } from 'koota';
import { Transform, SkinnedSprite2D, Bone2D, EntityAttributes } from '../traits';
import { getRig2D, type ParsedRig2D } from '../loaders/rig2dCache';
import { resolveSprite } from '../rendering/renderUtils';
import { isGuid } from '../loaders/assetRefRules';
import { identity2D, compose2D, mul2D, removeScale2D, skinVertex2D, type Mat2D } from '../skinning/rig2dMath';
import {
  getSkin2DBuffer, putSkin2DBuffer, bumpSkin2DVersion, deleteSkin2DBuffer, type Skin2DBuffer,
} from './skin2DBuffers';
import { getDeform2D, getDeform2DVersion } from './deform2DBuffers';

interface BoneRec { name: string; local: Mat2D }

// Per-entity build tracking so a rig swap / mesh-topology change rebuilds the buffer,
// and a cheap pose cache so an unchanged pose skips the per-vertex re-skin.
const lastRigKeyByEntity = new Map<number, string>();
const lastSkinMatsByEntity = new Map<number, Mat2D[]>();
// Last-seen deform version per entity, so per-vertex mesh flutter re-skins even when
// the bone pose is unchanged (deform moves verts without moving bones).
const lastDeformVerByEntity = new Map<number, number>();
// The parsed-rig OBJECT last seen per entity. setRig2D/invalidate replaces the cached
// object, so an identity change means the rig DATA changed (re-tessellate / re-weight in
// the Skin editor) → force a rebuild + reskin even if the bone pose is unchanged.
const lastRigObjByEntity = new Map<number, ParsedRig2D>();
// True when the last build left a GUID sprite unresolved (its asset wasn't in the
// manifest yet — the cold-scene-load race: skin2DSystem runs before the atlas/texture
// registers). Forces a rebuild each frame until it resolves, so the mesh isn't stuck
// textureless (url '') behind the idle fast-path until a manual reload.
const lastBuildUnresolvedByEntity = new Map<number, boolean>();
const trackedRootIds = new Set<number>();

// Per-frame scratch, reused across frames so an idle rig doesn't re-allocate a Map over
// EVERY entity in the world (parentOf), a per-Bone2D Map, and a cycle-guard Set per bone
// each frame just to reach the idle fast-path. Fully cleared + refilled at the top of every
// run, so behavior is identical to fresh allocation (single-threaded; one invocation at a time).
const _parentOf = new Map<number, number>();
const _boneById = new Map<number, BoneRec>();
const _seen = new Set<number>();

function matsEqual(a: readonly Mat2D[] | undefined, b: readonly Mat2D[]): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x.a !== y.a || x.b !== y.b || x.c !== y.c || x.d !== y.d || x.e !== y.e || x.f !== y.f) return false;
  }
  return true;
}

/** Nearest ancestor of `id` that carries `SkinnedSprite2D`, or null. Starts from the
 *  PARENT (a root is not its own bone owner). Cycle-guarded. */
function nearestSkinnedRoot(id: number, parentOf: Map<number, number>, rootSet: Set<number>): number | null {
  let cur = parentOf.get(id) ?? 0;
  for (let guard = 0; cur && guard < 4096; guard++) {
    if (rootSet.has(cur)) return cur;
    cur = parentOf.get(cur) ?? 0;
  }
  return null;
}

export function skin2DSystem(world: World) {
  // Collect skinned roots.
  const roots: Array<{ id: number; rig: string }> = [];
  world.query(Transform, SkinnedSprite2D).updateEach(([, ss]: [unknown, { rig: string }], entity: { id(): number }) => {
    roots.push({ id: entity.id(), rig: ss.rig });
  });

  // Clean up buffers for entities that are no longer skinned roots.
  if (roots.length === 0) {
    if (trackedRootIds.size) {
      for (const id of trackedRootIds) { deleteSkin2DBuffer(id); lastRigKeyByEntity.delete(id); lastSkinMatsByEntity.delete(id); lastRigObjByEntity.delete(id); lastDeformVerByEntity.delete(id); lastBuildUnresolvedByEntity.delete(id); }
      trackedRootIds.clear();
    }
    return;
  }
  const rootSet = new Set(roots.map((r) => r.id));

  // parentId map (numeric at runtime) for every entity — reused scratch.
  const parentOf = _parentOf; parentOf.clear();
  world.query(EntityAttributes).updateEach(([attr]: [{ parentId: number }], entity: { id(): number }) => {
    parentOf.set(entity.id(), attr.parentId || 0);
  });

  // Live Bone2D entities: name + composed LOCAL matrix — reused scratch.
  const boneById = _boneById; boneById.clear();
  world.query(Transform, Bone2D).updateEach(
    ([tf, b]: [{ x: number; y: number; rz: number; sx: number; sy: number }, { name: string }], entity: { id(): number }) => {
      boneById.set(entity.id(), { name: b.name, local: compose2D(tf.x, tf.y, tf.rz, tf.sx, tf.sy) });
    },
  );

  // Group bones under their nearest skinned root.
  const bonesByRoot = new Map<number, Map<number, BoneRec>>();
  for (const [bid, rec] of boneById) {
    const r = nearestSkinnedRoot(bid, parentOf, rootSet);
    if (r == null) continue;
    let g = bonesByRoot.get(r);
    if (!g) { g = new Map(); bonesByRoot.set(r, g); }
    g.set(bid, rec);
  }

  const activeRootIds = new Set<number>();

  for (const { id, rig } of roots) {
    const parsed = getRig2D(rig);
    if (!parsed || parsed.vertCount === 0) continue;
    activeRootIds.add(id);
    trackedRootIds.add(id);

    const group = bonesByRoot.get(id);

    // Bones flagged `noScale` (Spine transform mode) ignore their PARENT's scale at pose
    // time — so an animated breathing-scale on an ancestor doesn't cascade to them.
    const noScaleNames = new Set<string>();
    for (const b of parsed.bones) if (b.noScale) noScaleNames.add(b.name);

    // rootLocalNow per bone entity: memoized product of LOCAL matrices up to (but not
    // through) the root — so it's in rig-origin/texture space, matching the bind pose.
    const nowById = new Map<number, Mat2D>();
    const computeNow = (bid: number, seen: Set<number>): Mat2D => {
      const cached = nowById.get(bid);
      if (cached) return cached;
      const rec = group!.get(bid)!;
      const p = parentOf.get(bid) ?? 0;
      let m: Mat2D;
      if (group!.has(p) && !seen.has(p)) {
        seen.add(bid);
        // A noScale bone composes against its parent with the parent's scale stripped.
        const parentNow = computeNow(p, seen);
        m = mul2D(noScaleNames.has(rec.name) ? removeScale2D(parentNow) : parentNow, rec.local);
      } else {
        m = rec.local;
      }
      nowById.set(bid, m);
      return m;
    };
    const nowByName = new Map<string, Mat2D>();
    if (group) {
      // Reuse one cycle-guard Set (cleared per traversal) instead of one per bone.
      for (const bid of group.keys()) { _seen.clear(); computeNow(bid, _seen); }
      for (const [bid, rec] of group) nowByName.set(rec.name, nowById.get(bid)!);
    }

    // skinMatrix[b] = rootLocalNow[b] · invBind[b] — identity where there's no live bone.
    const skinMats: Mat2D[] = parsed.invBind.map((ib, i) => {
      const now = nowByName.get(parsed.bones[i].name);
      return now ? mul2D(now, ib) : identity2D();
    });

    // The rig DATA changed (re-tessellate / re-weight → setRig2D reseeds the cache with a
    // new parsed object) → rebuild the buffer + force a reskin even if the pose is unchanged.
    const rigChanged = lastRigObjByEntity.get(id) !== parsed;

    // (Re)build the buffer on first sight, rig swap, part-count/topology change, or rig-data change.
    let buf: Skin2DBuffer | undefined = getSkin2DBuffer(id);
    const needBuild = !buf || lastRigKeyByEntity.get(id) !== rig || rigChanged
      || buf.parts.length !== parsed.parts.length
      || buf.parts.some((pb, i) => pb.positions.length !== parsed.parts[i].vertCount * 2)
      // A prior build resolved a GUID sprite to nothing (asset not registered yet) —
      // retry until it appears, else the rig stays textureless behind the idle skip.
      || lastBuildUnresolvedByEntity.get(id);
    if (needBuild) {
      let unresolved = false;
      buf = putSkin2DBuffer(id, {
        parts: parsed.parts.map((part) => {
          const resolved = resolveSprite(part.sprite);
          // A GUID sprite that didn't resolve means its asset (texture/atlas page) isn't
          // in the manifest yet — flag it so the next frame rebuilds and picks it up.
          if (isGuid(part.sprite) && !resolved?.url) unresolved = true;
          // A sliced sprite carries a source-px frame + the sheet dims it was authored against;
          // normalize to a resolution-independent sub-rect the renderer remaps the 0..1 UVs into.
          const f = resolved?.frame;
          const uvRect = f && resolved?.sheetW && resolved?.sheetH
            ? { u0: f.x / resolved.sheetW, v0: f.y / resolved.sheetH, uw: f.w / resolved.sheetW, vh: f.h / resolved.sheetH }
            : undefined;
          return {
            positions: new Float32Array(part.verts), // start at bind pose
            uvs: new Float32Array(part.uvs),
            indices: new Uint32Array(part.tris),
            url: resolved?.url ?? '',
            sprite: part.sprite, // editor Canvas2D preview resolves a browser-decodable source from this
            uvRect, order: part.order, name: part.name, visible: part.visible,
          };
        }),
      });
      lastRigKeyByEntity.set(id, rig);
      lastRigObjByEntity.set(id, parsed);
      lastBuildUnresolvedByEntity.set(id, unresolved);
    }

    // Per-vertex deform version — changes when a deform timeline moves the mesh even
    // if the bone pose is identical, so it participates in the idle-skip decision.
    const deformVer = getDeform2DVersion(id);

    // Idle fast-path: unchanged pose AND deform AND already built → nothing to re-skin.
    if (!needBuild && deformVer === (lastDeformVerByEntity.get(id) ?? 0) && matsEqual(lastSkinMatsByEntity.get(id), skinMats)) continue;

    // Re-skin every part's vertices into its buffer, then bump the deform version once.
    // A deform timeline (Spine cloth/cape) offsets each BIND vertex before skinning, so
    // the mesh flutters on top of the bone motion (offsets are in bind/texture space).
    for (let pi = 0; pi < parsed.parts.length; pi++) {
      const part = parsed.parts[pi], pos = buf!.parts[pi].positions;
      const deform = getDeform2D(id, part.name);
      for (let v = 0; v < part.vertCount; v++) {
        const o = v * 2;
        const bx = deform ? part.verts[o] + deform[o] : part.verts[o];
        const by = deform ? part.verts[o + 1] + deform[o + 1] : part.verts[o + 1];
        skinVertex2D(bx, by, part.skinIndices, part.skinWeights, v * 4, skinMats, pos, o);
      }
    }
    bumpSkin2DVersion(buf!);
    lastSkinMatsByEntity.set(id, skinMats);
    lastDeformVerByEntity.set(id, deformVer);
  }

  // Drop buffers for roots that vanished this frame.
  for (const id of trackedRootIds) {
    if (!activeRootIds.has(id)) {
      deleteSkin2DBuffer(id);
      lastRigKeyByEntity.delete(id);
      lastSkinMatsByEntity.delete(id);
      lastRigObjByEntity.delete(id);
      lastDeformVerByEntity.delete(id);
      lastBuildUnresolvedByEntity.delete(id);
    }
  }
  trackedRootIds.clear();
  for (const id of activeRootIds) trackedRootIds.add(id);
}
