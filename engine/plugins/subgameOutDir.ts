/** Where a project's sub-game build writes — a THIRD build output next to `dist/` (normal web) and
 *  `ads/` (playable), so building a sub-game bundle never clobbers either.
 *
 *  The definition lives in `engine/scripts/subgameOutDir.mjs` (#906: `build-subgame.mjs` needs the
 *  same folder and cannot import TS); this re-exports it so plugin code keeps its import path.
 *
 *  ⚠️ **A leaf module on purpose — keep it import-free beyond that leaf.** `subgameBuild.ts`
 *  re-exports these, but importing THAT file drags in `app/sharedRegistryKeys.ts`, whose shared-key
 *  list carries the literal `'@modoki/engine/runtime'`. `vite-asset-scanner.ts` is bundled into the
 *  Electron main process, and #837's publish route needs this path there: through `subgameBuild.ts`
 *  the string landed in `main.cjs`, which `mainBundleExternals.test.ts` (#1035) rightly refuses. */

export { SUBGAME_DIST_DIRNAME, subgameOutDir } from '../scripts/subgameOutDir.mjs';
