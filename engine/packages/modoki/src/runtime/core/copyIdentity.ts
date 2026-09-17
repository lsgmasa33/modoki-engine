/** The identities a COPY of an entity subtree gets — shared by every live duplicate: the editor's
 *  duplicate/paste (`regenerateSnapshotGuids`) and the runtime `duplicate-entity` op the device runs
 *  (`engine/app/debug/liveLifecycle.ts`). Pure: the caller hands in its own tree shape.
 *
 *  Two rules, and a copy that follows only the first silently drives the SOURCE (#1338):
 *  - **Every entity gets a new guid**, and `remap` maps each old guid to it, so the caller can carry
 *    every reference held INSIDE the copy (`remapGuidValues`). A ref to anything outside the
 *    subtree is not in `remap` and stays put.
 *  - **A prefab MEMBER gets the guid a reload will derive**, not a random one. The copy is saved,
 *    and on reload `deriveInstanceMemberGuids` derives every member from the nearest ancestor whose
 *    guid the SAVE stored — so a random live value would be replaced and take every carried ref with
 *    it. Which guids a save stores is decided by STRUCTURE, not by the live value, so that is how a
 *    node is classified here: a `PrefabInstance` entity is DERIVED unless it is an instance root the
 *    serializer stores (`rootInstanceId` is itself and it did not expand from a prefab row, i.e.
 *    `parentLocalId` is 0). Members and owned nested roots are derived; a top-level or user-added
 *    instance root, and every plain entity, is an ANCHOR that gets `mint()`. The copy's root is
 *    always an anchor. (Classifying by "the live guid equals its derivation" was wrong in both
 *    directions once a save had stored a derived guid — #1338 review.)
 *  See docs/scene-loading.md § "Guid uniqueness is a PER-FILE rule, not a repo-wide one" (the subtree duplicate bullet). */

import { deriveMemberGuid, memberStepId } from './assetRefRules';

export interface CopyGuidPlan<N> {
  /** The new guid for each node of the tree. */
  guidOf: Map<N, string>;
  /** Old guid → new guid, for every node that had a non-empty guid. Never contains `''`. */
  remap: Map<string, string>;
}

/** Plan the copy's guids. `dataOf(node, 'EntityAttributes' | 'PrefabInstance')` returns that trait's
 *  data on the node, or null when it has none. */
export function planCopyGuids<N>(
  root: N,
  childrenOf: (node: N) => readonly N[],
  dataOf: (node: N, trait: 'EntityAttributes' | 'PrefabInstance') => Record<string, unknown> | null,
  idOf: (node: N) => number,
  mint: () => string,
): CopyGuidPlan<N> {
  const guidOf = new Map<N, string>();
  const remap = new Map<string, string>();
  const visit = (node: N, ctx: { anchor: string; path: number[] } | null): void => {
    const ea = dataOf(node, 'EntityAttributes');
    const pi = dataOf(node, 'PrefabInstance') as { localId?: number; parentLocalId?: number; rootInstanceId?: number } | null;
    const oldGuid = typeof ea?.guid === 'string' ? ea.guid : '';
    const storedRoot = !!pi && pi.rootInstanceId === idOf(node) && !pi.parentLocalId;
    const path = ctx && [...ctx.path, memberStepId(pi)];
    const derived = !!ctx && !!pi && !storedRoot;
    const guid = derived ? deriveMemberGuid(ctx!.anchor, path!) : mint();
    guidOf.set(node, guid);
    if (oldGuid) remap.set(oldGuid, guid);
    const next = derived ? { anchor: ctx!.anchor, path: path! } : { anchor: guid, path: [] };
    for (const child of childrenOf(node)) visit(child, next);
  };
  visit(root, null);
  return { guidOf, remap };
}
