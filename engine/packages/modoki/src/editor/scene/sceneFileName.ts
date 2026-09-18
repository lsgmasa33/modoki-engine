/** What a NEW scene file is called — one answer for every place that names one (#1413).
 *
 *  The manifest classifies a scene by its `.scene.json` suffix (#54; `JSON_ASSET_SUFFIX_TYPE`). Create
 *  Scene, Save Scene As and the agent's `save_all { path }` each spelled the suffix `'.json'`
 *  instead, so they wrote `<name>.json` — a file that only reads as a scene through the LEGACY
 *  `/scenes/`-directory fallback, and is not a scene at all anywhere else. The suffix is derived
 *  from the classifier's own table here, so it cannot drift from what the manifest recognises. */

import { JSON_ASSET_SUFFIX_TYPE } from '../../runtime/loaders/assetTypeClassifier';

export const SCENE_EXT: string = (() => {
  const row = JSON_ASSET_SUFFIX_TYPE.find(([, type]) => type === 'scene');
  if (!row) throw new Error('assetTypeClassifier has no scene suffix');
  return row[0];
})();

/** The path a caller most likely meant: its name with the scene suffix in place of whatever JSON
 *  suffix it carried (`foo.json` → `foo.scene.json`, `foo.prefab.json` → `foo.scene.json`). */
export function correctedScenePath(path: string): string {
  // Case-insensitive, so `Foo.Scene.JSON` suggests `Foo.scene.json` rather than appending a second
  // suffix. (The classifier itself is case-sensitive, which is why that name is refused at all.)
  const lower = path.toLowerCase();
  const known = JSON_ASSET_SUFFIX_TYPE.find(([suffix]) => lower.endsWith(suffix));
  const suffix = known ? known[0] : lower.endsWith('.json') ? '.json' : '';
  return path.slice(0, path.length - suffix.length) + SCENE_EXT;
}

/** Whether an EXPLICIT save path may receive a scene. A `.scene.json` path always may. So may the
 *  scene that is already open, and a file the manifest already types `scene` — a legacy
 *  `/scenes/*.json` must stay re-savable under its own name. Anything else is refused by the
 *  caller (owner ruling 2026-09-18: refuse and name the corrected path, never rename silently). */
export function isAcceptableScenePath(path: string, ctx: { currentPath: string | null; existingType: string | undefined }): boolean {
  return path.endsWith(SCENE_EXT) || path === ctx.currentPath || ctx.existingType === 'scene';
}
