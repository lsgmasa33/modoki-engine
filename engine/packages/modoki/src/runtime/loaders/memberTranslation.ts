/** Translating a SAVED member reference against the document its frame expands NOW (I4, #1771).
 *
 *  A `localId` means something only together with the document it was read from; across documents a
 *  node is named by its minted `nodeGuid`. Every reader that holds a saved member reference, a
 *  member-row key (a chain of `nodeGuid`s, one per frame), a localId captured against one version of a
 *  document, or a key part naming a member, has to answer the same question before it acts: *which row
 *  of the document this frame expands NOW does that reference name?* This module is the one answer.
 *  The load's fold (`foldMemberRowChannels`), R2's orphan test (`rowBackedTest`), a rebuild's carry
 *  (`translateLocalIds`, both the outer frame's and each nested capture's) and Apply's key grammar
 *  (`localIdOfRef`) all ask it here.
 *
 *  ⚠️ **The failure this exists to stop is asking the wrong document, not asking wrongly.** Each of
 *  the three copies it replaced translated correctly against the document it was HANDED, and each was
 *  handed a document the frame no longer expanded: the orphan test asked the whole template tree
 *  ("is this nodeGuid anywhere?", #1766), and a rebuild's nested capture was applied through the
 *  child document it was read from, after the row that produced it had been re-pointed at another
 *  prefab (#1767). So every function here takes the CURRENT document explicitly, and a frame whose
 *  document changed prefab gets no match (the nodeGuids differ) rather than a positional one.
 *
 *  Pure: no cache, no trait registry. `prefabOverrides.ts` imports it, and that module must stay free
 *  of anything that registers a trait at import time. */

import { isGuid } from '../core/assetRefRules';

/** What this module reads of a prefab document. */
export interface MemberDoc {
  entities?: ReadonlyArray<{ localId?: number; nodeGuid?: string; prefab?: string }>;
  rootLocalId?: number;
}
export type MemberDocReader = (prefabRef: string) => MemberDoc | null | undefined;

/** One row of a document, as a member reference resolves to it. `nested` is a reference row (it expands
 *  a child prefab) other than the document's own root. */
export interface MemberRowAt { localId: number; prefab?: string; nested: boolean }

/** `nodeGuid` → the row of `doc` carrying it. Only rows with a real identity (a guid) are indexed: a
 *  pre-v5 row has none, and a number is not a name. */
export function docRows(doc: MemberDoc | null | undefined): Map<string, MemberRowAt> {
  const out = new Map<string, MemberRowAt>();
  const rootLocalId = doc?.rootLocalId ?? 1;
  for (const pe of doc?.entities ?? []) {
    if (!pe.nodeGuid || !pe.localId || !isGuid(pe.nodeGuid)) continue;
    out.set(pe.nodeGuid, { localId: pe.localId, ...(pe.prefab ? { prefab: pe.prefab } : {}), nested: !!pe.prefab && pe.localId !== rootLocalId });
  }
  return out;
}

/** The localId member `ref` names in `doc`: a guid through its `nodeGuid`, a number taken at its word (the
 *  legacy spelling, and the only one a pre-v5 document has). Null when a guid names no row of `doc`. */
export function localIdOfMember(doc: MemberDoc, ref: string): number | null {
  if (isGuid(ref)) return docRows(doc).get(ref)?.localId ?? null;
  const n = Number(ref);
  return ref !== '' && Number.isInteger(n) ? n : null;
}

/** A member-row key's components, resolved FRAME BY FRAME against the documents those frames expand now.
 *
 *  `components` are the key's identity chain (`parseMemberRowKey`): every component but the last names a
 *  nested REFERENCE row of the frame above, whose prefab is the next frame's document; the last names the
 *  member in the innermost frame. The answer is that chain's localIds, one per frame, and the innermost
 *  row — or `null` when a component names no row of the document its frame expands (the chain no longer
 *  exists: an orphan), or `'unread'` when a document on the way is not cached, which is "cannot tell",
 *  never "gone".
 *
 *  ⚠️ Chained, not looked up: a component that is a node of SOME document in the template tree but not of
 *  the one its frame now expands names nothing (#1766). */
export function resolveMemberChain(
  rootDoc: MemberDoc | null | undefined,
  components: readonly string[],
  read: MemberDocReader,
  rowsOf: (doc: MemberDoc) => Map<string, MemberRowAt> = docRows,
): { localIds: number[]; row: MemberRowAt } | null | 'unread' {
  if (!rootDoc?.entities) return 'unread';
  if (!components.length) return null;
  const localIds: number[] = [];
  let doc: MemberDoc = rootDoc;
  for (let i = 0; i < components.length; i++) {
    const row = rowsOf(doc).get(components[i]!);
    if (!row) return null;
    localIds.push(row.localId);
    if (i === components.length - 1) return { localIds, row };
    if (!row.nested || !row.prefab) return null; // an inner frame is only ever a reference row's expansion
    const next = read(row.prefab);
    if (!next?.entities) return 'unread';
    doc = next;
  }
  return null;
}

/** Old localId → new localId for every row two documents share, matched by `nodeGuid` — or null when nothing
 *  moves, which is every case where `from` and `to` are the same document or neither carries identity.
 *
 *  `from` is the document a carried edit was READ against, `to` the one the frame expands now; they may be two
 *  versions of one prefab (a re-save, a Replace) or two different prefabs (a template row re-pointed at another
 *  prefab while keeping its own nodeGuid, #1767 — pass `acrossPrefabs`). In the second case a member edit carries only
 *  where the two documents share a nodeGuid, as a reload's does; everything else is DROPPED, and the root carries (its
 *  row edits land on whatever root the row expands, as the loader's forwarded root row does).
 *
 *  A row `to` no longer has maps to 0, which no member holds: an edit to a member the template dropped is dropped,
 *  never handed to whichever member inherited its number. A keyed `from` row keeps its number where `to` holds that
 *  number UNKEYED (a pre-v5 copy, a `git checkout` of an older file), as `rowsMeanTheSame` matches it — mapping it to
 *  0 dropped every carried edit on it (#1665 close-out review). A `from` row with no `nodeGuid` keeps its number. */
export function translateLocalIds(
  from: MemberDoc,
  to: MemberDoc,
  /** `from` and `to` are two DIFFERENT prefabs (#1767): nothing is matched by number, so an unkeyed row on either side
   *  maps to 0 (close-out review F4 — the pre-v5 fallback below matched a keyed row onto an unkeyed row of another
   *  prefab by its number, the positional bug over again). */
  opts: { acrossPrefabs?: boolean } = {},
): ((lid: number) => number) | null {
  if (from === to) return null;
  const toByGuid = new Map<string, number>();
  const toUnkeyed = new Set<number>();
  for (const pe of to.entities ?? []) {
    if (!pe.localId) continue;
    if (pe.nodeGuid && isGuid(pe.nodeGuid)) toByGuid.set(pe.nodeGuid, pe.localId);
    else toUnkeyed.add(pe.localId);
  }
  const fromRoot = from.rootLocalId ?? 1;
  const map = new Map<number, number>([[fromRoot, to.rootLocalId ?? 1]]);
  for (const pe of from.entities ?? []) {
    if (!pe.localId || pe.localId === fromRoot) continue;
    const keyed = !!pe.nodeGuid && isGuid(pe.nodeGuid);
    if (opts.acrossPrefabs) { map.set(pe.localId, keyed ? (toByGuid.get(pe.nodeGuid!) ?? 0) : 0); continue; }
    // An unkeyed `from` row is not mapped at all, so it keeps its number: with no identity there is no other answer.
    if (!keyed) continue;
    map.set(pe.localId, toByGuid.get(pe.nodeGuid!) ?? (toUnkeyed.has(pe.localId) ? pe.localId : 0));
  }
  if ([...map].every(([a, b]) => a === b)) return null;
  return (lid) => map.get(lid) ?? lid;
}

/** Where a template-added node sits in the frame that expands `doc` NOW: under its anchor row while `doc` still has
 *  it, else at the frame root, where the load and a rebuild re-anchor a node whose anchor the prefab deleted
 *  (`applyStructureCore`, `loadSceneFile`'s spawn) rather than dropping it (#1872). The one answer for every reader
 *  that matches a node by its anchor: the save's diff (`chainNodesAsPlaced`, which states a node where it is placed)
 *  and the load's fold (`foldMemberRowChannels`, where a member row's whole `added` list replaces the nodes at its
 *  anchor). The two disagreed once: the save pinned a re-anchored node in the root's whole list, the fold replaced
 *  only the nodes whose OWN anchor was the root, and the template's copy spawned beside the pinned one on one guid.
 *
 *  Answers about the document, not the live frame: whether the anchor is LIVE (the scene removed that member) is the
 *  spawn's own question, asked where it spawns. */
export function placedAnchor(doc: MemberDoc, parentLocalId: number): number {
  return (doc.entities ?? []).some((e) => e.localId === parentLocalId) ? parentLocalId : (doc.rootLocalId ?? 1);
}
