/** Where a project's sub-game build writes — a THIRD build output next to `dist/` (normal web) and
 *  `ads/` (playable), so building a sub-game bundle never clobbers either.
 *
 *  An `.mjs` so the build SCRIPT can name the same folder the Vite config writes to:
 *  `build-subgame.mjs` stamps the finished dist (#906) and cannot import TS. `engine/plugins/subgameOutDir.ts`
 *  re-exports this, so there is one definition.
 *
 *  ⚠️ **A leaf module on purpose — keep it import-free beyond `node:path`.** See the re-exporting TS
 *  file for why: the publish route bundles this path into the Electron main process. */
import path from 'node:path';

export const SUBGAME_DIST_DIRNAME = 'subgame-dist';

export function subgameOutDir(projectRoot) {
  return path.join(projectRoot, SUBGAME_DIST_DIRNAME);
}
