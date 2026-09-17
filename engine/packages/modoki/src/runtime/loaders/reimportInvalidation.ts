/** THE per-kind cache eviction for a freshly re-baked asset — one table, every entry point.
 *
 *  Two callers drive a re-import and both land here: the Assets panel's batch loop
 *  (`editor/panels/assetViews/reimport.ts`) and the agent/MCP/curl path
 *  (`app/debug/agentBridge.ts`'s `invalidate-assets` op, which `/api/reimport` calls through
 *  `requestBrowser`). They used to carry a hand-maintained copy of this mapping each, with a
 *  comment in each telling the other to stay in step.
 *
 *  ⚠️ **They did not stay in step, and that was #1366.** Evicting a re-imported GLB takes TWO
 *  calls — `invalidateModel` for the static mesh templates and `invalidateRiggedModel` for the
 *  skinned prototype — and only `editor/scene/modelImport.ts` (the drag-a-file-in importer) ever
 *  made both. Through either table above, a re-imported SKINNED GLB kept its pre-import skeleton,
 *  bind pose and clip set for the rest of the session.
 *
 *  MEASURED on `games/alien-animal` (66 MB rigged GLB, `modoki_reimport_asset`, stopped editor)
 *  before the fix: across the re-import the live clones' mesh and skeleton uuids both CHANGED —
 *  `attachInvalidationListener` evicted them and `syncSceneRenderables3D` rebuilt them — while the
 *  SkinnedMesh geometry kept its uuid and a property stamped onto it before the re-import. The
 *  clones were faithfully rebuilt FROM THE STALE PROTOTYPE. That is the nasty shape: the viewport
 *  visibly re-seats the mesh, so the re-import looks like it worked while serving pre-import bytes.
 *
 *  ⚠️ **Do NOT "simplify" this by calling `invalidateRiggedModel` from inside `invalidateModel`.**
 *  That is the obvious move and it is wrong: `invalidateModel` doubles as the dispose half of a
 *  refcounted RELEASE (`releaseModelByPath`, and the two post-await guards in `acquireModel` /
 *  `acquireMesh`), where it runs because the last OWNER let go. `riggedModelCache` tracks its own
 *  owners separately, so disposing prototypes from there would drop one a different scene still
 *  holds — the cross-scene sharing the refcount exists for. Re-import and release are different
 *  events that happen to share a function; only the re-import one belongs here. */

import { invalidateModel, invalidateEnvironment } from './meshTemplateCache';
import { invalidateRiggedModel } from './riggedModelCache';
import { invalidateTexture } from './textureResolver';
import { invalidateAudio } from './audioBufferCache';

/** The asset kinds a re-import can evict. `font` is deliberately absent — it refreshes through
 *  the manifest-hash channel (`onFontInvalidated`) — and atlas/video hold no engine-side cache.
 *  `app/debug/agentBridge.ts` pins this against the MCP surface's own tuple
 *  (`tools/shared/invalidateAssets.ts`) with a `satisfies`, so the two cannot drift apart. */
export type ReimportableAssetKind = 'model' | 'texture' | 'audio' | 'environment';

/** Evict both caches a GLB can occupy, in the order `invalidateRiggedModel`'s contract requires.
 *
 *  `invalidateModel` FIRST: it emits `onModelInvalidated` synchronously, which is what makes
 *  `scene3DSync`'s `attachInvalidationListener` drop the live skinned clones — and
 *  `invalidateRiggedModel` disposes the prototype those clones were sharing, so it must not run
 *  while they still reference it. Its own docstring states that precondition.
 *
 *  Safe on a static GLB: `invalidateRiggedModel` is idempotent and a cache miss is a no-op. */
export function invalidateModelAndRig(modelPath: string): void {
  invalidateModel(modelPath);
  invalidateRiggedModel(modelPath);
}

/** Asset kind → the eviction a successful re-bake of that kind owes. Both re-import entry points
 *  read this; neither keeps its own copy. */
export const REIMPORT_INVALIDATORS: Record<ReimportableAssetKind, (path: string) => void> = {
  model: invalidateModelAndRig,
  texture: invalidateTexture,
  audio: invalidateAudio,
  environment: invalidateEnvironment,
};
