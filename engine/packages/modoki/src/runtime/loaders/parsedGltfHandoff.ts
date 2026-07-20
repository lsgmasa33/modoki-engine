/** Single-use parsed-GLB handoff — the editor importer's "I already parsed this,
 *  don't parse it again" channel (F4).
 *
 *  `importModel` runs `inspectGLBRig`, which does a FULL `GLTFLoader` parse purely
 *  to detect skinning / measure the bind-pose bbox / list clips. Both downstream
 *  loaders — the static `meshTemplateCache.loadModelTemplates` and the rigged
 *  `riggedModelCache.fetchRiggedModel` — then parsed the SAME bytes a SECOND time.
 *  This module lets the importer hand its already-parsed scene to whichever loader
 *  runs next, eliminating that second parse.
 *
 *  Contract — deliberately narrow so it can't perturb the runtime:
 *   - **Opt-in.** ONLY the editor importer calls `offerParsedGltf`. The runtime
 *     scene-load path never offers, so `takeParsedGltf` returns undefined there and
 *     the loaders parse exactly as before — zero runtime behavior change.
 *   - **Single-use.** `takeParsedGltf(path)` removes the entry; a handoff is
 *     consumed at most once, by the first loader to ask for that path.
 *   - **Caller-owned cleanup.** Whoever offers MUST, after invoking the consumer,
 *     call `disposePendingGltf(path)` to dispose any handoff the consumer didn't
 *     take (e.g. the loader short-circuited on an in-flight/cached entry). In the
 *     normal flow the consumer already took it, so this is a no-op.
 *   - **Keyed by the exact GLB path** the importer parsed (and passes to the
 *     loader). At import time that path resolves to the raw GLB for BOTH the
 *     inspection parse and the loader, so the handed-off scene is byte-equivalent
 *     to what the loader would have fetched.
 *
 *  A leaf module (depends only on THREE) so both caches and the editor importer can
 *  use it without a circular import — mirrors `modelGlbUrl`'s placement. */

import * as THREE from 'three';

export interface OfferedGltf {
  /** The parsed GLB scene graph. The consumer takes ownership and runs its own
   *  keep/dispose lifecycle over it, exactly as it would a fresh parse. */
  scene: THREE.Group;
  /** Animation clips (skinned GLBs). The static loader ignores these; the rigged
   *  loader shares them across clones' mixers. */
  animations: THREE.AnimationClip[];
}

/** Dispose every geometry / material / texture in a parsed scene that no one took
 *  ownership of. Mirrors the texture-walking dispose used by the caches so a
 *  handoff that's never consumed doesn't leak GPU memory. */
function disposeGltfScene(scene: THREE.Object3D): void {
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) {
      if (!mat) continue;
      for (const key of Object.keys(mat)) {
        const val = (mat as unknown as Record<string, unknown>)[key];
        if (val && (val as THREE.Texture).isTexture) (val as THREE.Texture).dispose();
      }
      mat.dispose();
    }
  });
  if (typeof (scene as { clear?: () => void }).clear === 'function') (scene as { clear: () => void }).clear();
}

const pending = new Map<string, OfferedGltf>();

/** Offer an already-parsed GLB for `path` to the next loader. If a prior offer for
 *  the same path was never taken, it's disposed first so we never leak the earlier
 *  parse. */
export function offerParsedGltf(path: string, gltf: OfferedGltf): void {
  const prev = pending.get(path);
  if (prev && prev !== gltf) disposeGltfScene(prev.scene);
  pending.set(path, gltf);
}

/** Take (and remove) the pending parse for `path`, transferring ownership to the
 *  caller. Returns undefined when nothing was offered — the normal runtime case. */
export function takeParsedGltf(path: string): OfferedGltf | undefined {
  const g = pending.get(path);
  if (g) pending.delete(path);
  return g;
}

/** Dispose + drop any handoff still pending for `path`. No-op when it was already
 *  taken (the normal flow) — the offerer calls this defensively after the consumer
 *  runs, so a loader that short-circuited (cached / in-flight) can't strand a parse. */
export function disposePendingGltf(path: string): void {
  const g = pending.get(path);
  if (!g) return;
  pending.delete(path);
  disposeGltfScene(g.scene);
}

/** True when a handoff is pending for `path` (test/diagnostic aid). */
export function hasPendingGltf(path: string): boolean {
  return pending.has(path);
}

/** Dispose every pending handoff (full teardown / world reset). Bounds the leak of
 *  any offer that was never consumed. */
export function clearParsedGltfHandoff(): void {
  for (const g of pending.values()) disposeGltfScene(g.scene);
  pending.clear();
}
