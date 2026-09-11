/** Where a project's sub-game build writes — a THIRD build output next to `dist/` (normal web) and
 *  `ads/` (playable), so building a sub-game bundle never clobbers either.
 *
 *  ⚠️ **A leaf module on purpose — keep it import-free beyond `node:path`.** `subgameBuild.ts`
 *  re-exports these, but importing THAT file drags in `app/sharedRegistryKeys.ts`, whose shared-key
 *  list carries the literal `'@modoki/engine/runtime'`. `vite-asset-scanner.ts` is bundled into the
 *  Electron main process, and #837's publish route needs this path there: through `subgameBuild.ts`
 *  the string landed in `main.cjs`, which `mainBundleExternals.test.ts` (#1035) rightly refuses. */

import path from 'node:path';

export const SUBGAME_DIST_DIRNAME = 'subgame-dist';

export function subgameOutDir(projectRoot: string): string {
  return path.join(projectRoot, SUBGAME_DIST_DIRNAME);
}
