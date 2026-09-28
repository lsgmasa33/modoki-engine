/** The identities a COPY of an entity subtree gets — shared by every live duplicate: the editor's
 *  duplicate/paste (`copySnapshot`) and the runtime `duplicate-entity` op the device runs
 *  (`engine/app/debug/liveLifecycle.ts`). Pure: the caller hands in its own tree shape.
 *
 *  **Which nodes stay prefab-linked** is decided per node, by the frame the node is a row of ({@link CopyLink}, #1756),
 *  and every rule below reads that decision: only a node that stays a member derives its guid.
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
 *    `parentLocalId` is 0). Members and owned nested roots the copy KEEPS are derived; a top-level or user-added
 *    instance root, a promoted root, a stripped member, and every plain entity, is an ANCHOR that gets `mint()`. The copy's root is
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
  /** What the copy does with each `PrefabInstance` node's link (#1756) — absent for a node with none. */
  links: Map<N, CopyLink>;
}

/** A copied node's prefab link, decided by the frame it is a ROW of (`IdentityParents.frameOf`, I6), never by the copy's
 *  root: a copy is a new instance of exactly the frames whose roots it holds.
 *  - `keep`: a stored root, or a member / owned nested root whose frame is in the copy. It stays linked, re-pointed at
 *    the copy's root, and its guid derives as a reload derives it.
 *  - `promote`: an OWNED nested root whose owner is not CONFIRMED in the copy — its owner link names a node outside it,
 *    or the owner's document has no row that expanded it. It becomes an independent instance of its own prefab (#1354's
 *    ruling, at any depth, #1756): its row stamp is cleared, and it anchors its members.
 *  - `strip`: a member whose frame root is not in the copy. It becomes a plain added node with a fresh guid, as a member
 *    leaving its instance does. Kept linked, it was a second claimant of its row: the save wrote the COPY's row and the
 *    original was lost on reload (#1756). */
export type CopyLink = 'keep' | 'promote' | 'strip';

type Pi = { source?: string; localId?: number; parentLocalId?: number; parentNodeGuid?: string; rootInstanceId?: number; ownerGuid?: string } | null;

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
  // The resolver sees the snapshot alone, so a frame outside the copy answers 0 or an id no node has — and for an OWNED
  // root it can answer with a frame inside the copy that does not own it. Its owner link names a node outside, which the
  // resolver cannot see and so ignores; and with no document confirming any candidate, the owner read off where the root
  // hangs is a guess (`ownerByPlace`'s first candidate). Kept linked on either, the copy was a second claimant of the
  // OUTER frame's row, and the save wrote the copy's member row over the original's (#1756 close-out review). So an owned
  // root stays linked only when its owner is CONFIRMED in the copy: its link, when it has one, names a copied node, and
  // the owner's document has the row that expanded it. Anything less is promoted, as a root whose owner stays behind is.
  const guidsInCopy = new Set(nodes.map((n) => n.guid).filter(Boolean));
  const ownerConfirmed = (id: number, pi: NonNullable<Pi>): boolean => {
    if (pi.ownerGuid && !guidsInCopy.has(pi.ownerGuid)) return false;
    const owner = parents.ownerOf(id);
    const ownerNode = byId.get(owner);
    if (!owner || ownerNode === undefined) return false;
    const source = (dataOf(ownerNode, 'PrefabInstance') as Pi)?.source;
    const doc = source && readDoc ? readDoc(source, owner) : undefined;
    if (!doc) return true; // no document to ask: where it hangs is every walk's answer, and this one's too
    const row = doc.entities?.find((e) => e.localId === pi.parentLocalId);
    return !!row && row.prefab === pi.source && (!row.nodeGuid || !pi.parentNodeGuid || row.nodeGuid === pi.parentNodeGuid);
  };
  const links = new Map<N, CopyLink>();
  for (const node of liveOrder) {
    const pi = dataOf(node, 'PrefabInstance') as Pi;
    if (!pi) continue;
    const id = idOf(node);
    if (isStoredRoot(pi, id)) links.set(node, 'keep');
    else if (pi.rootInstanceId === id) links.set(node, ownerConfirmed(id, pi) ? 'keep' : 'promote');
    else links.set(node, pi.rootInstanceId && byId.has(pi.rootInstanceId) ? 'keep' : 'strip');
  }
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
    // Derived only while it stays a member of a frame in the copy: a promoted root anchors, a stripped member is plain.
    const derived = !!ctx && (!!key || (links.get(node) === 'keep' && !storedRoot));
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
  return { guidOf, remap, keyed, links };
}
