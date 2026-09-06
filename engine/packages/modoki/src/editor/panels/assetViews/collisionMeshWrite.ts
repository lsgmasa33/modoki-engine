/** `ModelAssetView`'s "Generate Collision Mesh" write+register sequence, extracted so it is
 *  unit-testable without mounting the component (CLAUDE.md § Panels: editor `.tsx` carries no
 *  tests, `.ts` does).
 *
 *  #784 phase C2b item 5: `registerAsset` used to run BEFORE either file was written, and the
 *  `.mesh.json` write's response was discarded entirely (unlike the sibling GLB write one line
 *  above it, which was already checked). That is exactly #311's mechanism on a second call site —
 *  a GUID can end up pointing at a path with no file behind it, and the dangling ref resolves for
 *  the rest of the session and only surfaces on a later scene load or the next editor launch, far
 *  from this call. Each `registerAsset` below now runs ONLY after its own write is confirmed. */

import { MESH_FORMAT_VERSION } from '../../../runtime/traits';

export interface CollisionMeshWriteResult {
  ok: boolean;
}

export interface CollisionMeshWriteDeps {
  /** POST a file write, returning at least `{ ok, status }` (matches `backendFetch`'s Response). */
  post: (path: string, content: string, encoding?: string) => Promise<{ ok: boolean; status: number }>;
  registerAsset: (id: string, path: string, type: 'model' | 'mesh') => void;
}

export interface CollisionMeshWriteInput {
  glbPath: string;
  glbBase64: string;
  meshJsonPath: string;
  meshName: string;
  modelGuid: string;
  meshGuid: string;
}

/** Write the collision GLB + its `.mesh.json`, registering each GUID only once its own write has
 *  landed. Throws (never a falsy return) on either write failing, mirroring the sibling GLB check
 *  this function replaces.
 *
 *  `writeMeta` is a caller-supplied step run between the two writes (after the GLB guid is
 *  registered, before the `.mesh.json` write) — deliberately NOT threaded through
 *  `CollisionMeshWriteDeps` as a generic `(path, meta)` function: `engine/tests/editor/
 *  metaMergeNotClobber.test.ts` statically resolves every `.meta.json` write's payload object
 *  literal from the SOURCE FILE it scans (`ModelAssetView.tsx`), and a payload passed through an
 *  indirection here would resolve to nothing for that guard (docs/format-versioning.md § 4's
 *  "anchor" trap, applied to a sibling guard: don't move a literal out from under a guard that
 *  reads source text). Keeping the object literal written at the ORIGINAL call site and merely
 *  sequencing it from here satisfies both. */
export async function writeCollisionMeshAssets(
  input: CollisionMeshWriteInput,
  deps: CollisionMeshWriteDeps,
  writeMeta: () => Promise<unknown>,
): Promise<void> {
  const { glbPath, glbBase64, meshJsonPath, meshName, modelGuid, meshGuid } = input;

  const glbRes = await deps.post(glbPath, glbBase64, 'base64');
  if (!glbRes.ok) throw new Error(`write GLB failed (${glbRes.status})`);
  deps.registerAsset(modelGuid, glbPath, 'model');

  await writeMeta();

  const meshAsset = { id: meshGuid, version: MESH_FORMAT_VERSION, model: modelGuid, mesh: meshName, postprocessor: 'none', material: '' };
  const meshRes = await deps.post(meshJsonPath, JSON.stringify(meshAsset, null, 2));
  if (!meshRes.ok) throw new Error(`write .mesh.json failed (${meshRes.status})`);
  deps.registerAsset(meshGuid, meshJsonPath, 'mesh');
}
