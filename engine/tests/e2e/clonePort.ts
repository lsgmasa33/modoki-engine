/** The e2e dev-server port, derived per clone (#20).
 *
 *  Several clones share one machine and used to share ONE hardcoded Playwright port, so
 *  only one of them could run e2e at a time. The derivation itself lives in
 *  `engine/scripts/clonePort.mjs` — the single implementation, shared with the packaged
 *  harnesses (#69) — and this module only pins the e2e-specific block. A second copy of
 *  the hash would drift from it.
 */
export { clonePortOffset } from '../../scripts/clonePort.mjs';
import { clonePort as derive, DEFAULT_SLOTS } from '../../scripts/clonePort.mjs';

/** Dedicated high-port block: ports land in `BASE_E2E_PORT .. +PORT_SLOTS-1`. It is well
 *  clear of the editor's own ports, which is the point — e2e must never touch a live
 *  editor, since these specs load scenes and POST /api/write-file. */
export const BASE_E2E_PORT = 38173;
export const PORT_SLOTS = DEFAULT_SLOTS;

/** The e2e dev-server port for a clone rooted at `repoRoot`. */
export function clonePort(repoRoot: string): number {
  return derive(repoRoot, BASE_E2E_PORT, PORT_SLOTS);
}
