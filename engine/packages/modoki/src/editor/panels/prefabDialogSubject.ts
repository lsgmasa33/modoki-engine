/** Which prefab instance the Apply/Revert Prefab dialog acts on — decided here, not in the `.tsx`.
 *
 *  The dialog is opened with an instance root's runtime id and confirmed later. That id is koota's
 *  RECYCLED index (#868): if the root is deleted meanwhile (an agent, an undo, a Play/Stop rebuild)
 *  and another entity takes the index, the bare id would apply or revert THAT entity's overrides,
 *  and the checked selection — keyed by the original prefab's localIds — would land on the wrong
 *  prefab. So the dialog pins the entity it was opened for (`core/ecs/entityPin.ts`). Once that
 *  entity is gone the dialog closes with a notice; it does not retarget (owner decision on #868). */

import type { World } from 'koota';
import { livePinnedId, type EntityLookup, type EntityPin } from '../../runtime/core/ecs/entityPin';

export type PrefabDialogMode = 'apply' | 'revert';

export function subjectGoneNotice(mode: PrefabDialogMode): string {
  return mode === 'apply'
    ? 'The prefab instance this dialog was opened for no longer exists, so nothing was applied.'
    : 'The prefab instance this dialog was opened for no longer exists, so nothing was reverted.';
}

/** Run `act` on the dialog's subject if it is still the entity the dialog was opened for; otherwise
 *  call `onGone` with the notice and do not act. Resolves to whether `act` ran. */
export async function runOnPinnedSubject(opts: {
  subject: EntityPin | null;
  lookup: EntityLookup;
  world: World;
  mode: PrefabDialogMode;
  act: (rootInstanceId: number) => void | Promise<void>;
  onGone: (notice: string) => void;
}): Promise<boolean> {
  const id = livePinnedId(opts.subject, opts.lookup, opts.world);
  if (id === null) { opts.onGone(subjectGoneNotice(opts.mode)); return false; }
  await opts.act(id);
  return true;
}
