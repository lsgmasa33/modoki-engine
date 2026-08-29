/** Which asset kinds the Inspector's asset view renders something for. Anything NOT listed
 *  here falls through to "No actions for <type> assets".
 *
 *  Lives beside the views rather than inline in `Inspector.tsx` so a guard test can import it
 *  without mounting a panel. Must stay in step with the per-type branches in `Inspector.tsx`;
 *  `assetInspectorCoverage.test.ts` pins it against `ASSET_TYPES` in both directions.
 *
 *  Why that guard exists (three measured drifts, none caught by a test):
 *  docs/editor.md § "The asset Inspector — three rules that have each failed repeatedly". */
import type { AssetType } from '../../../runtime/loaders/assetManifest';

export const ASSET_TYPES_WITH_ACTIONS: readonly AssetType[] = [
  'model', 'prefab', 'texture', 'sprite', 'atlas', 'mesh', 'material', 'shader', 'particle',
  'animation', 'rig2d', 'spriteanim', 'scene', 'animset', 'audio', 'video', 'timeline',
  'environment', 'font',
];
