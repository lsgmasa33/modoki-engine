/** Undo entry for "instantiate a prefab into the scene".
 *
 *  Shared by the Hierarchy drop-handler and the Assets-panel instantiate path so
 *  the two cannot drift. The Assets copy previously closed over a `const` root id
 *  while its `redo` spawned a fresh instance into a new local id — so after
 *  undo→redo→undo the second undo deleted the dead original and ORPHANED the
 *  redo-spawned instance (prefab F3). Keeping the live instance id in a single
 *  mutable slot here makes that impossible: undo always tears down whatever is
 *  currently live, redo re-instantiates and updates the slot.
 *
 *  Redo RESTORES THE ORIGINAL IDENTITY, it does not just re-spawn. The ordinary instantiate mints a fresh root guid, so
 *  an undo+redo used to hand the user a visually identical subtree under a brand-new identity (measured: guid 45cd77c4…
 *  became b0b3c186… on redo, QA-ASSET-0018), silently orphaning every reference minted against it in between. So the
 *  redo hands the respawn the root guid it recorded, and the respawn mints THAT before the members derive.
 *
 *  ⚠️ The ROOT guid is the instance's whole identity. Every member's guid derives from it and its template path
 *  (`deriveMemberGuid`), and a fresh instantiate stores no member guid of its own. So the members come back by the same
 *  derivation a reload runs, on whatever the template holds now. The redo used to stamp each captured member guid back
 *  by `name#siblingIndex` instead, over members the respawn had ALREADY derived from a throwaway root guid: a sibling
 *  added between the undo and the redo (an outside edit adding a row whose name sorts first) shifted every index under
 *  it, no path matched, and only the root got its guid back. Every member kept a guid derived from the throwaway root, so
 *  refs to them dangled and a reload changed them all (#1880 T4, hunt seed 1044). */
import type { UndoAction } from './undoManager';
import { entityRef, type EntityRef } from './entityRef';
import { reportUndoFailure, UndoRefusedError } from './undoFailure';
import { StalePrefabRead } from '../scene/stalePrefabRead';
import { PrefabEditRefusalError } from '../scene/prefabEditRefusalError';
import { resolveAffectedScenes } from '../scene/sceneDirty';
import { readTraitData } from '../../runtime/core/ecs/entityUtils';
import { getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { durableGuid } from '../../runtime/core/assetRefRules';

/** The durable guid `rootId` carries, or undefined (#1210: a runtime guid belongs to the world it was minted in). */
function rootGuidOf(rootId: number): string | undefined {
  const eaMeta = getTraitByName('EntityAttributes');
  return eaMeta ? durableGuid(readTraitData(rootId, eaMeta)?.guid as string) || undefined : undefined;
}

export function makePrefabInstantiateAction(opts: {
  label: string;
  /** Entity id from the initial (pre-`pushAction`) instantiation. */
  initialId: number;
  /** Re-instantiate the prefab; return the new root id, or `null` if it could
   *  not be spawned (e.g. the prefab file was deleted between undo and redo) — in
   *  which case the live id is left unchanged, matching the original
   *  early-return behavior (nothing new exists to track). `rootGuid` is the root guid to mint instead of a fresh one
   *  (`instantiatePrefabInstance`'s `rootGuid`): the members derive from it. */
  respawn: (rootGuid: string | undefined) => Promise<number | null>;
  /** Tear down the live instance. Safe to call with a stale id (no-op). */
  remove: (id: number) => void;
}): UndoAction {
  // Track the live instance by a guid-based ref (not a raw id) so undo still
  // tears down the right entity after a world rebuild (Play→Stop). The instance
  // root carries a stable guid from instantiation (prefab.ts mints one).
  let currentRef: EntityRef = entityRef(opts.initialId);
  // Recorded at action-creation time, and re-read after every redo: a redo that could not take it (another live entity
  // holds it) keeps the guid the respawn minted, and the next undo→redo restores that one.
  let rootGuid = rootGuidOf(opts.initialId);
  return {
    label: opts.label,
    // The scene the new instance belongs to: a base, when it was dropped under a base entity (#1429).
    affectedScenes: resolveAffectedScenes([opts.initialId]),
    // By guid only (#1827, I19): the raw id it used to fall back to names, after a world swap, whatever entity holds
    // that id now, and the undo deleted it. A root that is gone, or has become a placeholder, refuses.
    undo: () => { opts.remove(currentRef.require()); },
    redo: async () => {
      // A respawn REFUSED because the prefab was written while it was read (#1752): nothing was spawned, and the step is
      // DROPPED with its notice (`UndoRefusedError`, #1664's contract) rather than left on the redo stack. The file it
      // would re-read is the newer one now, so a retry is the user placing it again — and a redo that silently placed
      // a DIFFERENT version than the one undone would be a re-target. The undo below it is unaffected: the next Cmd+Z
      // undoes the step before this one, as it would after any dropped entry.
      let id: number | null;
      try {
        id = await opts.respawn(rootGuid);
      } catch (e) {
        // A prefab-edit refusal (#1817, #1836) is a refusal too: the redo would place what the edit world cannot save.
        if (e instanceof StalePrefabRead || e instanceof PrefabEditRefusalError) throw new UndoRefusedError(e.message, e.message);
        throw e;
      }
      // Leaving the live id unchanged is the deliberate contract (see `respawn`
      // above) and stays that way — but the SILENCE was not deliberate (#308).
      // The documented cause is that the prefab file was deleted between the undo
      // and the redo, so redo reported success while no instance came back and
      // nothing said why. No toast: the entry is on the redo stack, which means
      // the user pressed Cmd+Shift+Z and is looking, and the file being gone is
      // not something they can fix from here.
      if (id == null) {
        reportUndoFailure({
          direction: 'Redo', label: opts.label,
          detail: 'the prefab could not be instantiated — its file was most likely deleted since the undo. No instance was created.',
        });
        return;
      }
      rootGuid = rootGuidOf(id);
      currentRef = entityRef(id);
    },
  };
}
