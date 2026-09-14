/** Hierarchy inline rename: which entity a commit may write to (#868). The rename box is opened for
 *  a pinned entity (`core/ecs/entityPin.ts`); a commit writes only when it comes from that entity's
 *  row and the entity is still the one at that id in the current World — never onto whatever entity
 *  took a deleted row's index, or onto a rebuilt world's entity on the same index. */

import type { World } from 'koota';
import { livePinnedId, type EntityLookup, type EntityPin } from '../../runtime/core/ecs/entityPin';

/** The id to write the new name to, or null to drop the commit. */
export function renameCommitTarget(pin: EntityPin | null, rowId: number, lookup: EntityLookup, world: World): number | null {
  const live = livePinnedId(pin, lookup, world);
  return live !== null && live === rowId ? live : null;
}
