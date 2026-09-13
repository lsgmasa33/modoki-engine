/** Take a project's cross-process build claim for a one-shot CLI script, or exit 1 naming why (#1160).
 *
 *  For a script whose whole job writes the project (`vendor-plugins.mjs`, `generate-icons.mjs`,
 *  `ota-embed-manifest.mjs`, the two smoke scripts): there is nothing useful to do on a refusal
 *  but stop, so this does not return one. `build-web.mjs` hand-rolls the same shape and predates
 *  this helper; `add-native-targets.mjs` and `bootstrap-game-deps.mjs` do not fit it, because a
 *  refusal there skips one project of several rather than ending the run.
 *
 *  A script SPAWNED by a claimed parent (the editor's `/api/build` step list, or `build-web.mjs`
 *  running `generate-icons.mjs`) inherits the parent's token on `MODOKI_BUILD_CLAIM_TOKEN` and gets a
 *  pass-through grant from `acquireBuildClaim`, so the same call is correct in both situations.
 *
 *  Never waits: a scripted run must not hang behind an interactive editor. `acquireBuildClaim` can
 *  THROW (an uncreatable `~/.modoki`, a lock wedged past its deadline); that exits the same way a
 *  refusal does, rather than as a raw stack trace. Release is the returned handle's `release()`;
 *  the store's own `exit` hook covers every `process.exit` path that skips it. */
import { acquireBuildClaim } from './buildClaimsStore.mjs';

/** @param {string} projectRoot  @param {string} label  shown to whoever is refused
 *  @param {string} tag  the script's log prefix, without brackets
 *  @returns {{ release: () => void }} */
export function claimProjectOrExit(projectRoot, label, tag) {
  let claimed;
  try {
    claimed = acquireBuildClaim(projectRoot, label, { kind: 'cli' });
  } catch (e) {
    console.error(`[${tag}] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  if (!claimed.ok) {
    console.error(`[${tag}] ${claimed.message}`);
    process.exit(1);
  }
  return claimed;
}
