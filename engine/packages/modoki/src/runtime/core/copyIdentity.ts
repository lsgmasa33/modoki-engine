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
 *  - **A node the prefab TEMPLATE added keeps its template key and derives through it** (#1430). It
 *    has no `PrefabInstance`, so the rule above minted it a random guid, and the copy dropped its
 *    `TemplateAddedKey`: a member token into it was dead after save + reload, since neither the load
 *    heal nor `recoverTemplateKey` can find a key behind a random guid. It steps as `'+' + key`,
 *    exactly as `deriveInstanceMemberGuids` derives a guid-less keyed node, and its descendants derive
 *    THROUGH it — except a keyed reference-node root, a stored root whose members anchor on it.
 *    Only BELOW an instance root the save STORES, inside the copy — the copy root itself, or any
 *    such root under it (a plain group holding an instance) — and one that is not itself keyed: a
 *    keyed reference-node root is a node of the OUTER template, which also writes the keys of its
 *    payload (#1369). A key belongs to the frame of its nearest unkeyed stored root, and every such
 *    root below the copy root is copied whole, so every key under it names a node of its own frame. Above any stored root — a member copy (which the editor
 *    strips to plain added nodes), a copy of an owned nested root (an independent instance of the
 *    inner prefab, #1354, which the outer template's keys do not describe), a copy of the keyed node
 *    itself — a key would name a node no frame holds, or give two siblings one step: there the node
 *    is an ordinary anchor, and `keyed` leaves it out so the caller drops the key.
 *  See docs/scene-loading.md § "Guid uniqueness is a PER-FILE rule, not a repo-wide one" (the subtree duplicate bullet). */

import { deriveMemberGuid, entityStep, isStoredRoot } from './assetRefRules';
import { resolveIdentityParents, type IdentityNode, type IdentityPi, type TemplateDocReader } from './ecs/identityParents';

export interface CopyGuidPlan<N> {
  /** The new guid for each node of the tree. */
  guidOf: Map<N, string>;
  /** Old guid → new guid, for every node that had a non-empty guid. Never contains `''`. */
  remap: Map<string, string>;
  /** The template-added nodes whose copy KEEPS its template key. Any other node's key is dropped. */
  keyed: Set<N>;
}

type Pi = { localId?: number; parentLocalId?: number; rootInstanceId?: number } | null;

/** Plan the copy's guids. `dataOf(node, 'EntityAttributes' | 'PrefabInstance')` returns that trait's
 *  data on the node, or null when it has none; `keyOf(node)` its template key (`TemplateAddedKey`),
 *  or `''`. `readDoc` reads the prefab documents the copied members' frames were expanded from, which is
 *  where a moved member's template parent comes from (`identityParents.ts`); without it every member is
 *  walked from where it hangs. */
export function planCopyGuids<N>(
  root: N,
  childrenOf: (node: N) => readonly N[],
  dataOf: (node: N, trait: 'EntityAttributes' | 'PrefabInstance') => Record<string, unknown> | null,
  idOf: (node: N) => number,
  mint: () => string,
  keyOf: (node: N) => string,
  readDoc?: TemplateDocReader,
): CopyGuidPlan<N> {
  const guidOf = new Map<N, string>();
  const remap = new Map<string, string>();
  const keyed = new Set<N>();
  // Walk the copy in IDENTITY order: a member moved inside its instance hangs under its TEMPLATE parent,
  // which is where a reload derives it from (#1437; read from the document since #1468 Phase 6).
  const liveOrder: N[] = [];
  const liveParent = new Map<N, N>();
  const collect = (node: N): void => {
    liveOrder.push(node);
    for (const child of childrenOf(node)) { liveParent.set(child, node); collect(child); }
  };
  collect(root);
  const byId = new Map<number, N>();
  const nodes: IdentityNode[] = [];
  for (const node of liveOrder) {
    const guid = dataOf(node, 'EntityAttributes')?.guid;
    const lp = liveParent.get(node);
    byId.set(idOf(node), node);
    nodes.push({ id: idOf(node), parentId: lp === undefined ? 0 : idOf(lp), guid: typeof guid === 'string' ? guid : '', pi: dataOf(node, 'PrefabInstance') as IdentityPi });
  }
  const parents = resolveIdentityParents(nodes, readDoc ?? (() => undefined));
  const identityChildren = new Map<N, N[]>();
  for (const node of liveOrder) {
    if (node === root) continue;
    const at = byId.get(parents.parentOf(idOf(node)));
    const parent = at && at !== node ? at : liveParent.get(node)!;
    const list = identityChildren.get(parent);
    if (list) list.push(node);
    else identityChildren.set(parent, [node]);
  }
  const visited = new Set<N>();
  // `inInstance`: some ancestor within the copy (or the node itself) is an instance root the
  // serializer STORES and that is not itself template-added — not an owned nested root, which is
  // copied as an independent instance (#1354), and not a keyed REFERENCE node, which belongs to the
  // outer template: the keys that template writes into its payload are the outer frame's (#1369).
  const visit = (node: N, ctx: { anchor: string; path: (number | string)[]; inInstance: boolean } | null): void => {
    if (visited.has(node)) return;
    visited.add(node);
    const ea = dataOf(node, 'EntityAttributes');
    const pi = dataOf(node, 'PrefabInstance') as Pi;
    const oldGuid = typeof ea?.guid === 'string' ? ea.guid : '';
    const key = ctx?.inInstance ? keyOf(node) : '';
    const storedRoot = isStoredRoot(pi, idOf(node));
    const inInstance = (storedRoot && !keyOf(node)) || !!ctx?.inInstance;
    const path = ctx && [...ctx.path, ...parents.of(idOf(node)).extra, entityStep(pi, key)];
    const derived = !!ctx && (!!key || (!!pi && !storedRoot));
    const guid = derived ? deriveMemberGuid(ctx!.anchor, path!) : mint();
    guidOf.set(node, guid);
    if (key) keyed.add(node);
    if (oldGuid) remap.set(oldGuid, guid);
    const next = derived && !storedRoot ? { anchor: ctx!.anchor, path: path!, inInstance } : { anchor: guid, path: [], inInstance };
    for (const child of identityChildren.get(node) ?? []) visit(child, next);
  };
  visit(root, null);
  // A node whose identity chain loops never hangs off the root; it keeps its live place.
  for (const node of liveOrder) if (!visited.has(node)) visit(node, null);
  return { guidOf, remap, keyed };
}
