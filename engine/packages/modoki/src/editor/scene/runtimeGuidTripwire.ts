/** Tripwire (#1210): a runtime guid must never reach a file or storage that outlives the process.
 *
 *  `spawnEntity` gives every entity spawned with an empty `EntityAttributes.guid` a RUNTIME guid
 *  (`isRuntimeGuid`), an address valid only until its world is swapped out. The fill-if-empty
 *  sites (`serializeScene`'s pre-pass, `ensureGuid`, `spawnPrefabInstance`, …) read it through
 *  `durableGuid` and re-mint, so this should never fire. It exists so a site that was MISSED fails
 *  loudly instead of silently persisting an address the next session's spawn counter reuses for a
 *  different entity.
 *
 *  `console.error` in the editor — a thrown save would lose the user's work — but a THROW under
 *  vitest, so a test that reaches it cannot pass by accident. It scans every string, object keys
 *  included, because an authored string field (a UIAction target, a timeline binding, an
 *  `+added.<guid>` key) can carry one as easily as `EntityAttributes.guid` can. */

import { findRuntimeGuids } from '../../runtime/core/assetRefRules';

export function assertNoRuntimeGuids(value: unknown, what: string): void {
  const hits = findRuntimeGuids(value);
  if (hits.length === 0) return;
  const shown = hits.slice(0, 5).map((h) => `${h.path} = ${h.guid}`).join('\n  ');
  const msg = `[runtime guid] ${hits.length} runtime guid(s) in ${what} about to be persisted — a runtime guid is `
    + `valid only until reload and must be re-minted first (#1210):\n  ${shown}`;
  if ((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.VITEST) {
    throw new Error(msg);
  }
  console.error(msg);
}
