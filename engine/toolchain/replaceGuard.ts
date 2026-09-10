/**
 * "Is it safe to REPLACE this directory?" — the pre-flight for the `rmSync(dest)` + `renameSync`
 * pair, shared by the provisioners that do it (#1006 close-out).
 *
 * ⚠️ **A sibling of `forceRemoveDir`'s guard, not a duplicate of it, and the difference is the
 * VERB.** That one REMOVES a tool directory on the user's instruction; these RESTORE one by
 * dropping a fresh extract on top. Same mechanism underneath (`rmSync` acts on the NAME — #883 —
 * so a junctioned destination is severed and its payload orphaned while everything reports
 * success), same policy (refuse: the payload is user-owned and irreplaceable), but a different
 * remedy sentence, which is why the two texts are not merged into one.
 *
 * It lives in its own module because `engine/toolchain/index.ts` already imports the provisioners
 * — putting it there would close an import cycle. Detection stays in `deleteBoundary.mjs`, which
 * reports and leaves the policy to the caller; this file IS one caller's policy, written once
 * rather than pasted into each provisioner.
 *
 * ⚠️ **Do NOT extend this to the neighbouring `staging`/`stage`/`tmpZip` removals.** Those delete
 * a directory the code itself just created, where a link can only appear if someone raced it in —
 * the exemption #1006 states for the ~38 sites its sweep cleared. Guarding them would be insurance
 * code inventing its own scenario.
 */
import { findDeleteBoundaries, describeBoundary } from '../scripts/deleteBoundary.mjs'

/** Throw unless a recursive delete of `dir` would do what it reports. No-op when `dir` is absent
 *  or self-contained — the accept side, and the half that matters: every real provision
 *  destination is self-contained, so a guard that refused them would break provisioning outright. */
export function refuseUnsafeReplace(dir: string): void {
  const boundaries = findDeleteBoundaries(dir)
  if (boundaries.length === 0) return
  throw new Error(
    `Refusing to replace ${dir} — it is not self-contained, so removing it would not do what it `
    + `reports:\n${boundaries.map((b) => '  ' + describeBoundary(b)).join('\n')}\n`
    + 'Remove the link itself (that deletes no payload), point the toolchain somewhere else, or '
    + 'unmount the volume — then retry.')
}
