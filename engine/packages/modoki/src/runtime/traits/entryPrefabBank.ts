/** The `UIEntries.prefabs` bank — the authored `[{ name, prefab: <guid> }]` list, as a PURE parse.
 *
 *  Extracted from `UIEntries.ts` so `loaders/sceneValidation.ts` can read the bank without
 *  importing a trait module. `UIEntries.ts` calls `trait({...})` at import time, and
 *  sceneValidation is deliberately dependency-light so the same file runs in the browser's load
 *  path and in the Vite dev server's Node process (see its module docs). Pulling a side-effectful
 *  trait registration into a validator buys nothing and is the kind of edge that surfaces later,
 *  in test isolation, rather than at the import that caused it.
 *
 *  ONE producer. Real importers: `loaders/loadSceneFile.ts` and `runtime/ui/entriesSystem.ts` read
 *  it through `UIEntries.ts`'s re-export below, so existing callers are unchanged; `loaders/
 *  sceneValidation.ts` imports it directly, for the reason above. The build tree-shaker
 *  (`plugins/asset-tree-shaker.ts`) is NOT one of them — it parses the bank INLINE, on purpose,
 *  because it is a build plugin and must not import engine source (see its own comment at
 *  `asset-tree-shaker.ts:566`).
 *  A second hand-rolled parse next to the validator is exactly the drift this repo keeps paying for.
 */

/** One entry KIND: the name game code uses, paired with the prefab GUID the scene authors.
 *
 *  ⚠️ The GUID lives in the SCENE, never in code — a GUID written in game code is a ref the build
 *  cannot see (#53), so the asset is dropped from a production build and it fails only once
 *  shipped, because dev serves everything off disk. */
export interface UIEntryPrefab {
  name: string;
  /** Prefab asset GUID. Surfaced to the resource collector (`loadSceneFile.ts`) and the build
   *  tree-shaker (`plugins/asset-tree-shaker.ts`) explicitly, because `REF_FIELDS_BY_TRAIT` is
   *  scalar-only and a JSON-string bank cannot live in it — the same shape as `Animator.clips`
   *  and `AudioSource.clips`. Both of those readers exist and work; the one that did NOT read the
   *  bank was the scene VALIDATOR, which is what `entryKindUses` below is for. */
  prefab: string;
}

/** Parse the `prefabs` JSON bank. Never throws: authored JSON is not trusted input, and a
 *  half-written bank must not take the whole scene down with it. Malformed entries are dropped
 *  rather than guessed at.
 *
 *  ⚠️ That silent drop is why a validator arm over this bank earns its keep: an entry whose
 *  `prefab` is a typo'd GUID, or whose shape is wrong, vanishes here without a word and surfaces
 *  only as a pool that never spawns. */
export function parseEntryPrefabs(json: string): UIEntryPrefab[] {
  if (!json) return [];
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  const out: UIEntryPrefab[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { name, prefab } = item as { name?: unknown; prefab?: unknown };
    if (typeof name !== 'string' || !name) continue;
    if (typeof prefab !== 'string' || !prefab) continue;
    out.push({ name, prefab });
  }
  return out;
}
