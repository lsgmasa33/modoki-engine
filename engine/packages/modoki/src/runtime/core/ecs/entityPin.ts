/** entityPin — remember WHICH entity a piece of UI state is about, not just its id (#868).
 *
 *  UI state that outlives a frame — an open dialog's subject, the row being renamed, a collapsed or
 *  selected tree node — is naturally held as `entity.id()`. That is koota's recycled index: delete
 *  the entity and the next spawn can take the same id, and the state silently moves onto the
 *  newcomer (a rename commits onto it, a dialog applies to it). A pin records the packed entity and
 *  the World it lives in, and resolves back to the id only while that same entity, in that same
 *  World, is what `lookup` finds there.
 *
 *  Why the World as well as the packed value: koota reuses a destroyed world's id, so two scene swaps
 *  later an entity in a brand-new world can carry the pinned PACKED value exactly (measured:
 *  create next → destroy old → create the one after). The World OBJECT is never reused. The 8-bit
 *  generation can also wrap within one world after 256 reuses of an index; a pin is short-lived UI
 *  state, so that is accepted here (unlike a long-lived map — see `loaders/overrideMarks.ts`). */

import type { Entity, World } from 'koota';

export interface EntityPin {
  readonly id: number;
  /** `entity.valueOf()` when pinned — generation included. */
  readonly packed: number;
  readonly world: World;
}

export type EntityLookup = (id: number) => Entity | null | undefined;

/** Pin the entity currently at `id` in `world`, or null when nothing lives there. `lookup` must
 *  resolve ids in `world`. */
export function pinEntityAt(id: number, lookup: EntityLookup, world: World): EntityPin | null {
  const entity = lookup(id);
  return entity ? { id, packed: entity.valueOf(), world } : null;
}

/** The pinned id while that same entity is what `lookup` finds there in the same World; null once it
 *  is gone, when another entity now holds the index, or when `world` is a different World. */
export function livePinnedId(pin: EntityPin | null, lookup: EntityLookup, world: World): number | null {
  if (!pin || pin.world !== world) return null;
  return lookup(pin.id)?.valueOf() === pin.packed ? pin.id : null;
}
