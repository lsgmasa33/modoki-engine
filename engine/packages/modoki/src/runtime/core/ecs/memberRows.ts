/** Where a prefab instance's members live in the scene's MEMBER ROW key space (scene v16, #1468).
 *
 *  A member's guid used to be re-derived on every load from where the member happened to sit, so any
 *  structural change to the template silently re-pointed or dropped every stored reference to it.
 *  v16 stores the guid instead, in a row addressed by the member's MINTED identity — and this module
 *  is the ONE place that says which live entity owns which key.
 *
 *  ⚠️ **It is deliberately used in BOTH directions**: the editor's save reads it to write the rows,
 *  and the loader reads it to put the stored guids back. That is not tidiness — `deriveInstanceMemberGuids`'
 *  own docblock records that its ancestor walk is MIRRORED twice and says "change all three", and a
 *  save/load pair that disagreed about a key would store identity under a name nothing looks up. One
 *  function, two callers, no mirror to keep in step.
 *
 *  ⚠️ **The key is an IDENTITY chain, not a path.** One component per instance FRAME, flat within a
 *  frame (#1468 design record D1), so a member re-parented inside its instance — or a template row moved
 *  under a different parent — keeps its key. The PATH spelling (`.`-joined steps, `|`-joined frames)
 *  still exists and still derives the fallback guid; the two are R1's storage key and matching key
 *  and must not be collapsed.
 *
 *  ### What gets no row, and why — this list is a CLAIM, and `memberRowKeys.test.ts` tests each line
 *
 *  1. **The instance root.** It IS the scene entry, and its guid is stored there already
 *     (`SceneEntityEntry.guid`).
 *  2. **A user-added nested instance (a STORED root) and everything under it.** Its guid is stored on
 *     its own `added[]` reference node and it ANCHORS its members rather than deriving through them
 *     (#1349) — so it is its own walk, not a member of this one. ⚠️ Achieved by the frame chain, not
 *     by a separate check: a stored root's own frame root is ITSELF, which reaches nothing, so
 *     `frameChain` returns null for it and for its members. There was an explicit `isStoredRoot`
 *     line here and mutation showed deleting it changed nothing.
 *  3. **An added node itself** — it has no `PrefabInstance` at all. A node with its own guid needs no
 *     row, and a TEMPLATE-keyed node must never be pinned (#1426/#1430/#1438) because its guid is
 *     derived per instance from a key that is already minted and position-independent. A nested
 *     instance hanging under one is a STORED root and is excluded by 2, as is its expansion.
 *     ⚠️ But a MEMBER of this instance that merely SITS under an added node keeps its row — its
 *     frame is decided by identity, not by where it hangs. An ECS-descent version of this walk got
 *     that wrong and dropped such a member's identity on the first save after the move.
 *     (Scene v17's NODE rows, `<frame>/a+<key>` (#1516), are not an exception: they hold a template
 *     node's EDITS, never its guid, and are computed by the writer's diff, not by this walk.)
 *  4. **A member of a pre-v5 template**, which minted no `nodeGuid`. Its component is '' and it
 *     derives exactly as it always did (R3) — and so does every member below a nested root whose
 *     OUTER document is pre-v5, since that root has no identity in the outer frame (`memberNodeId`).
 *  5. **A member of a DIFFERENT instance**, wherever it physically sits — R8, see `memberRowKeysIn`.
 */

import type { Entity, World } from 'koota';
import { getCurrentWorld, findEntityById } from './world';
import { getTraitByName } from './traitRegistry';
import { durableGuid, formatMemberRowKey, isOwnedRoot, isStoredRoot, memberNodeId, type MemberPi } from '../assetRefRules';
import { worldIdentityParents } from './identityParents';

type RowPi = (NonNullable<MemberPi> & { nodeGuid?: string; parentNodeGuid?: string }) | null;

/** Every live member of the instance rooted at `rootEcsId`, mapped to its member row key.
 *
 *  A member whose key cannot be formed is ABSENT from the result rather than present with '', so a
 *  caller cannot accidentally write a row under an empty name — the exclusions above are expressed as
 *  "no entry", one way, in one place.
 *
 *  ⚠️ **The frame chain follows IDENTITY, not the ECS tree — and that is R8.** A member's frame is
 *  the instance it BELONGS to (`PrefabInstance.rootInstanceId`), wherever it has been dragged to.
 *  Reading the frame off the ECS parent chain instead was the first cut, and it breaks D1(a)'s whole
 *  promise in two directions:
 *
 *  - a member of THIS instance moved beside its frame — under a member of a nested instance, which
 *    `planMoveUnlinks` keeps LINKED (#1437) — would be re-keyed into the nested frame, so its stored
 *    identity dangles and it silently re-derives. "A move re-keys nothing" is the point of the flat key;
 *  - a member of ANOTHER instance dragged into this subtree would be keyed as one of ours, which is
 *    the illegal state #1468 design record D1's third accepted cost warns about: path-addressing could not express
 *    "member of X living outside X", and identity-addressing can. Here it is rejected by
 *    construction — its frame chain never reaches `rootEcsId`, so it gets no key.
 *
 *  The normal move path cannot even produce the second one (an unpack REMOVES `PrefabInstance`, so
 *  the entity is an added node here), but this is the save path and the encoding no longer enforces
 *  the invariant — which is exactly why R8 says a check has to exist rather than be relied upon. */
export function memberRowKeysIn(rootEcsId: number, world: World = getCurrentWorld()): Map<number, string> {
  const out = new Map<number, string>();
  for (const [id, row] of memberRowsIn(rootEcsId, world)) if (row.key) out.set(id, row.key);
  return out;
}

/** What is known about a live member of some instance tree, beyond its row key.
 *
 *  `frameRoot` is the root of the instance FRAME the member belongs to — its own instance, or for an
 *  owned nested root the instance of the row it hangs under. `rowLocalId` is its localId IN THAT
 *  FRAME's document, which for an owned nested root is `parentLocalId` (the OUTER row that produced
 *  it) and not `localId` (which names the inner root in the CHILD document). That pair is exactly
 *  what `moved` was keyed by before Phase 3 collapsed it onto the row, and it is what lets a caller
 *  ask the frame's own template where the member belongs.
 *
 *  ⚠️ **`key` is `''` for a member that HAS no row** — exclusion 4, a pre-v5 template that minted no
 *  identity. Frame membership and row-keying are different questions and this type keeps them
 *  apart: `memberRowParents` needs the first and not the second, because "has this member moved"
 *  is answered by the document and the live parent, with no minted identity anywhere in it. Folding
 *  the two made every move on a pre-v5 template silently uncapturable, which is the whole #1437
 *  suite going red at once. */
export type MemberRowAt = { key: string; frameRoot: number; rowLocalId: number };

/** Every live member of the instance tree rooted at `rootEcsId` — the ONE walk, so a caller that
 *  needs to reach a member's TEMPLATE position does not re-derive which document and which row that
 *  is. {@link memberRowKeysIn} is this, narrowed to the members that HAVE a key. */
export function memberRowsIn(rootEcsId: number, world: World = getCurrentWorld()): Map<number, MemberRowAt> {
  const out = new Map<number, MemberRowAt>();
  const piMeta = getTraitByName('PrefabInstance');
  const eaMeta = getTraitByName('EntityAttributes');
  if (!piMeta || !eaMeta || !rootEcsId) return out;

  const piById = new Map<number, RowPi>();
  const members: number[] = [];
  for (const e of world.entities as Iterable<Entity>) {
    const id = e.id();
    if (!e.has(piMeta.trait)) { piById.set(id, null); continue; }
    piById.set(id, e.get(piMeta.trait) as RowPi);
    members.push(id);
  }

  /** The instance an entity BELONGS to: its own `rootInstanceId`, except an OWNED nested root, which
   *  belongs to the instance whose row expanded it — its owner (`identityParents.ts`), so a root moved
   *  inside its outermost instance still belongs where its template puts it. The spelling
   *  `planMoveUnlinks` uses; 0 when there is none. */
  const parents = worldIdentityParents(world);
  const frameRootOf = (id: number): number => {
    const pi = piById.get(id);
    if (!pi) return 0;
    if (isStoredRoot(pi, id)) return id;
    if (!isOwnedRoot(pi, id)) return pi.rootInstanceId ?? 0;
    return parents.ownerOf(id);
  };

  /** The identity chain of the frames ABOVE `id`, or null when it does not reach `rootEcsId` — which
   *  is every entity belonging to some other instance. Memoised, with `null` seeded on entry so a
   *  frame cycle in a damaged world resolves to "unreachable" instead of recursing.
   *
   *  ⚠️ REACHABILITY and KEYABILITY are answered separately, and the split is load-bearing. A frame
   *  whose own identity component is missing (a pre-v5 nested row) still CONTAINS its members — they
   *  are part of this instance tree and their moves are capturable — it just cannot name them, so
   *  the chain comes back with an empty component and `formatMemberRowKey` refuses the key. Folding
   *  "I cannot name you" into "you are not mine" is what made every pre-v5 move uncapturable. */
  const chains = new Map<number, string[] | null>();
  const frameChain = (id: number): string[] | null => {
    if (id === rootEcsId) return [];
    const memo = chains.get(id);
    if (memo !== undefined) return memo;
    chains.set(id, null);
    const root = frameRootOf(id);
    if (!root || root === id) return null;              // no frame, or a stored root that is not ours
    let chain: string[] | null;
    if (root === rootEcsId) chain = [];
    else {
      const above = frameChain(root);
      chain = above && [...above, memberNodeId(piById.get(root))];
    }
    chains.set(id, chain);
    return chain;
  };

  for (const id of members) {
    if (id === rootEcsId) continue;                      // exclusion 1: the root IS the scene entry
    const chain = frameChain(id);
    // Covers R8 (it belongs to some other instance) AND exclusion 2: a stored root's own frame root
    // is ITSELF, which reaches nothing, so `frameChain` returns null for it and for its members
    // without a separate `isStoredRoot` line. There WAS one here; mutation showed deleting it
    // changed nothing, because this is the mechanism that actually does it.
    if (!chain) continue;
    const pi = piById.get(id)!;
    // '' when any component is missing — exclusion 4, and `formatMemberRowKey` is the one place that
    // decides it, so no caller has to re-spell "a pre-v5 member has no row".
    const key = formatMemberRowKey([...chain, memberNodeId(pi)]);
    out.set(id, { key, frameRoot: frameRootOf(id), rowLocalId: (isOwnedRoot(pi, id) ? pi.parentLocalId : pi.localId) ?? 0 });
  }
  return out;
}

/** The root whose SAVE writes the member rows of the frame rooted at `rootEcsId`: the STORED root
 *  (a top-level instance, or a user-added reference node) its ownership chain reaches. Rows are keyed
 *  from THAT root, so "does this member get a row" asked relative to a nested root answers a
 *  different question — the member can be keyable there and not from the writer, when a frame between
 *  them has no identity (close-out review, #1468 Phase 3). 0 when the chain breaks: nothing writes. */
export function rowWritingRoot(rootEcsId: number, world: World = getCurrentWorld()): number {
  const piMeta = getTraitByName('PrefabInstance');
  const eaMeta = getTraitByName('EntityAttributes');
  if (!piMeta || !eaMeta || !rootEcsId) return 0;
  // One pass over the world, and the owner read the way `memberRowsIn` reads it (`worldIdentityParents`),
  // with no per-id helper the editor's tests mock by explicit export list.
  const parents = worldIdentityParents(world);
  const piById = new Map<number, RowPi>();
  for (const e of world.entities as Iterable<Entity>) {
    piById.set(e.id(), e.has(piMeta.trait) ? (e.get(piMeta.trait) as RowPi) : null);
  }
  const seen = new Set<number>();
  for (let r = rootEcsId; r && !seen.has(r);) {
    seen.add(r);
    const pi = piById.get(r) ?? null;
    if (!isOwnedRoot(pi, r)) return isStoredRoot(pi, r) ? r : 0;
    // Its owner, exactly as `memberRowsIn`'s `frameRootOf` reads it.
    r = parents.ownerOf(r);
  }
  return 0;
}

/** The members the next SAVE will write a row for: {@link memberRowKeysIn}'s keyed set, narrowed to
 *  the ones that carry a DURABLE guid to state (#1210 — a runtime guid is a per-session handle, not
 *  an identity to write down; and an unaddressable member has none at all).
 *
 *  ⚠️ **This, not `memberRowKeysIn`, is what "a row covers this member" means** — and the difference
 *  is load-bearing for the two stampers, which skip a member on the premise *"a stored row states
 *  its guid"*. Keyed-but-not-storable would be skipped by them and then written by nobody, which
 *  reopens #1461's window for exactly the members neither mechanism covers (found by the Phase 2B
 *  close-out review). `memberRowKeysIn` cannot itself require durability: the LOAD side uses it to
 *  find the members to PIN, and at that moment every member's guid is still empty. */
export function memberRowsToWrite(rootEcsId: number, world: World = getCurrentWorld()): Map<number, string> {
  const eaMeta = getTraitByName('EntityAttributes');
  const out = new Map<number, string>();
  if (!eaMeta) return out;
  // One entity lookup per KEYED member, through the index, rather than a second full scan on top of
  // `memberRowKeysIn`'s — which also means `rootEcsId` 0 costs nothing instead of a whole-world walk
  // to return empty. `promoteOwnedRoots` calls this once per promoted root.
  for (const [id, key] of memberRowKeysIn(rootEcsId, world)) {
    const e = findEntityById(id, world) as { has(t: unknown): boolean; get(t: unknown): unknown } | undefined;
    if (!e?.has(eaMeta.trait)) continue;
    if (durableGuid((e.get(eaMeta.trait) as { guid?: string }).guid)) out.set(id, key);
  }
  return out;
}
