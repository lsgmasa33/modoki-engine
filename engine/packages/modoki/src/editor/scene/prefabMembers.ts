/** Member rows and moves: which rows an instance owns, where each member hangs, the prefab's own moves, and
 *  capturing/restoring an instance's member rows.
 *  Moved out of `prefab.ts` by the prefab.ts split (#1656 § Plan, step 5): a pure move. */

import { getCurrentWorld, indexEntityGuid } from '../../runtime/core/ecs/world';
import { applyGuidRemap } from '../../runtime/core/ecs/memberHome';
import { worldIdentityParents, frameRootDoc } from '../../runtime/core/ecs/identityParents';
import { memberRowKeysIn, memberRowsIn, memberRowsToWrite } from '../../runtime/core/ecs/memberRows';
import { getTraitByName, type TraitMeta } from '../../runtime/core/ecs/traitRegistry';
import { getAllEntities, readTraitData, writeTraitField, findEntity, type EntityInfo } from '../../runtime/core/ecs/entityUtils';
import { filterAuthoringVisible } from './authoringScope';
import { durableGuid, isOwnedRoot, isFrameStep, type MemberPi } from '../../runtime/core/assetRefRules';
import type { SceneMemberRow } from '../../runtime/loaders/loadSceneFile';
import { keptMemberOrphans, memberPathIndex } from '../../runtime/loaders/loadSceneFile';
import { levelDoc } from './prefabBase';
import { parseMemberToken, memberPathKey } from '../../runtime/core/templateRefs';
import { type PrefabFile } from './prefab';

// ── Instance-keyed scan cost (review F11 — measured, no index threaded) ──────
//  The instance-keyed helpers below (capture/apply overrides + structure,
//  collectInstanceRoots, localToEcsGuid, findChildNestedRoot, resolveInstance
//  context, setPrefabSource) each `getCurrentWorld().query(PrefabInstance)
//  .updateEach(...)` and filter to one `rootInstanceId`.
//
//  F11 proposed threading a `rootInstanceId → members` index through all of them.
//  Measured first, per the finding's own "measure first": koota's `query(Trait)`
//  is ARCHETYPE-based — it iterates only entities that CARRY `PrefabInstance`, NOT
//  the whole world. So each scan is O(live prefab-instance members), not
//  O(worldEntities) as the finding's wording implied; a 10k-entity scene with a
//  handful of small instances scans only those few dozen tagged members. The one
//  nested case (`findChildNestedRoot` inside `reapplyNestedInstanceOverrides`) is
//  O(nestingDepth × members), still bounded by tagged members. A full Apply/Refresh
//  chains ~5-8 such scans; at realistic instance-member counts that is sub-millisecond
//  and dwarfed by the teardown/respawn + render it triggers.
//  Verdict: the constant-factor win does not justify threading a mutable index
//  through 9 functions — extra surface area that the GUID-resolved-undo + dual
//  prefab-cache invariants would have to stay correct against. Revisit only if a
//  profile on a scene with MANY large instances shows these scans dominating an
//  interactive Apply. (Tag count, not world size, is the metric to watch.)
//
/** Which members of the instance rooted at `rootInstanceId` sit somewhere their own template does not put them: the one
 *  question the mark gate's Transform exemption asks (#1437). Built once per instance; ask it per member, with whether
 *  that member's Transform differs from its base (the root is judged only then, in its OWNER's frame).
 *
 *  ⚠️ This read `PrefabInstance.homeParent` until Phase 3 (#1468), and the gate is the reason that
 *  field was the riskiest thing in that phase to delete: a re-imported prefab whose base changed under an un-edited
 *  instance otherwise freezes spurious overrides and *"breaks the instance (mesh collapses)"*. Asking the same question
 *  of the DOCUMENT instead of a remembered guid is what made the field retirable — `memberRowParents` already computes
 *  exactly this for the save, base target (#1437 P3-b) included, so the gate and the capture cannot drift into two
 *  answers.
 *
 *  The domain is every ROW of the document, owned nested roots included (#1481): a member whose template parent is
 *  a nested row resolved no home in a members-only domain, so it read as moved and froze every Transform field
 *  that differed from a re-imported base. And the frame root itself is judged in its OWNER's frame, where its row
 *  is: a moved owned root's compensated pose is unmarked (`markCompensatedTransform`), and the gate dropped it. */
export function instanceMovedMembers(rootInstanceId: number, prefab: PrefabFile): (entityId: number, transformDiffers: boolean) => boolean {
  // Built on the FIRST question, not up front: it walks the world's identity, and `gateOnMarks` asks only for a member
  // with an UNMARKED Transform diff — rare, whereas the Inspector recomputes on every dirty frame of a drag (close-out
  // review: 10 ms a frame at 5k entities when it was eager).
  let identity: ReturnType<typeof worldIdentityParents> | undefined;
  let movedMembers: ReturnType<typeof memberRowParents> | undefined;
  let rootMoved: boolean | undefined;
  // A member at the place its PREFAB moves it to (P3-b) is at its base: not moved, for this purpose.
  return (entityId, transformDiffers) => {
    identity ??= worldIdentityParents(getCurrentWorld());
    if (entityId === rootInstanceId) return (rootMoved ??= transformDiffers && ownedRootMoved(rootInstanceId, identity));
    const moved = movedMembers ??= memberRowParents(rootInstanceId, prefab, rowParentDomain(rootInstanceId,
      instanceRowDomain(rootInstanceId, prefab, identity)));
    return moved.has(entityId);
  };
}

/** Capture all per-localId overrides for every entity in a prefab instance.
 *  Returns `{}` if the root has no overrides anywhere. */
/** The guid of the parent the prefab moves (P3-b) place a live entity under, in the instance rooted at
 *  `rootInstanceId` — '' when none does, or its target names no member. `prefab` is that instance's document;
 *  an ENCLOSING instance's document can move the same member too, and the outermost one wins, as the loader
 *  applies it last. Without the enclosing ones a nested instance read the outer prefab's move as the
 *  instance's own, and every copy saved it (review F4). Memoised. */
/** The document instance root `root` was EXPANDED from — its frame record, else the cache (`levelDoc`, I3). A rebuild
 *  capturing after Apply reads the enclosing roots' documents through this: read against the new document the cache
 *  already holds, a member still at its old place looked moved back, and the capture cancelled the very move being
 *  applied. */
function expandedDocOf(root: number, piMeta: TraitMeta): PrefabFile | null {
  // Every expansion writes the record: `instantiatePrefab`, Create Prefab's tag, a reattach, the loader, a carry across
  // a world swap and an undo respawn. A root with none reads the cache, as everything did before records existed.
  return levelDoc(root, (readTraitData(root, piMeta)?.source as string) || '').doc;
}

/** The instance roots ENCLOSING an owned nested instance rooted at `rootInstanceId`, innermost first, each with
 *  the document it was expanded from — up to the stored root. Empty for a stored root. */
/** Every move the template states in the frame rooted at `root`, expanded from `doc`: the document's own `moved`, then
 *  what the template REFERENCE node that spawned the root adds on top (`AddedEntity.templateMoved`, #1543), which wins.
 *  `undefined` when there is none. The one answer to "which moves are the template's here", for every reader that
 *  subtracts them. */
export function frameMovesOf(root: number, doc: { moved?: Record<string, string> } | null | undefined): Record<string, string> | undefined {
  const handle = findEntity(root);
  const node = handle ? frameRootDoc(getCurrentWorld(), handle)?.nodeMoved : undefined;
  if (!node) return doc?.moved;
  return { ...doc?.moved, ...node };
}

export function enclosingFrames(rootInstanceId: number): { root: number; doc: PrefabFile | null }[] {
  const piMeta = getTraitByName('PrefabInstance');
  const eaMeta = getTraitByName('EntityAttributes');
  const out: { root: number; doc: PrefabFile | null }[] = [];
  if (!piMeta || !eaMeta) return out;
  const identity = worldIdentityParents(getCurrentWorld());
  for (let root = rootInstanceId, n = 0; root && n < 64; n++) {
    const pi = readTraitData(root, piMeta);
    if (!pi?.parentLocalId) break; // a stored root: nothing encloses it
    root = identity.ownerOf(root);
    if (root) out.push({ root, doc: expandedDocOf(root, piMeta) });
  }
  return out;
}

export function prefabMoveTargets(rootInstanceId: number, prefab: PrefabFile): (ecsId: number) => string {
  const eaMeta = getTraitByName('EntityAttributes');
  type Frame = { index: ReturnType<typeof memberPathIndex>; pathOf: Map<number, string>; moved: Record<string, string> };
  let frames: Frame[] | null = null;
  const frameChain = (): Frame[] => {
    const world = getCurrentWorld();
    return [{ root: rootInstanceId, doc: prefab }, ...enclosingFrames(rootInstanceId)]
      .map((f) => ({ root: f.root, moved: frameMovesOf(f.root, f.doc) }))
      .filter((f): f is { root: number; moved: Record<string, string> } => !!f.moved).map((f) => {
        const index = memberPathIndex(world, f.root);
        return { index, pathOf: new Map([...index].filter(([, e]) => e).map(([k, e]) => [e!.id(), k])), moved: f.moved };
      });
  };
  return (ecsId) => {
    if (!eaMeta) return '';
    frames ??= frameChain();
    let base = '';
    for (const f of frames) {
      const t = parseMemberToken(f.moved[f.pathOf.get(ecsId) ?? '\0'] ?? '');
      const target = t && !t.up ? f.index.get(memberPathKey(t.path)) : null;
      if (target) base = (target.get(eaMeta.trait) as { guid?: string }).guid ?? '';
    }
    return base;
  };
}

/** This instance's MEMBER ROWS as the scene stores them (v16, #1468): each live member's minted
 *  identity → the guid it currently carries. The point of the whole plan — a member's guid stops
 *  being re-derived from where it happens to sit and becomes something the file states.
 *
 *  `memberRowKeysIn` decides which members are keyed and under what, in ONE spelling shared with the
 *  loader that reads the rows back; its docblock carries the four exclusions and why each one is not
 *  a row. This function only turns those keys into rows.
 *
 *  Emitted in KEY order, not tree order. A key is stable across everything this plan exists to
 *  survive, so the block does not churn when a template row moves or is renumbered; tree order would
 *  reorder the whole map on any of those. Unreadable to a human either way — that is what `name` is
 *  for.
 *
 *  ⚠️ A member with no DURABLE guid gets no row. `durableGuid` excludes a runtime guid (#1210),
 *  which is a per-session handle and not an identity to write down; and an unaddressable member
 *  (no anchored ancestor) has '' and nothing to store. Both keep deriving — the same answer they give
 *  today. */
/** Put the member identity an instance HAD back onto the tree a REBUILD has just re-expanded
 *  (Refresh, Revert, and every other `rebuildInstance` caller — v16, #1468).
 *
 *  A rebuild destroys the members and expands fresh ones, which then take DERIVED guids: the
 *  loader's stored rows live in the scene file, not in the live world, so without this a Refresh
 *  silently replaces every pinned identity with a derived one and the next save writes the
 *  derived values over the rows. That is precisely the failure the #1468 design record's root cause describes — an artist re-imports, members
 *  renumber, and identity is lost — arriving through the gesture meant to pick the change up.
 *
 *  The rows come from `captureInstanceMembers` on the LIVE tree before the teardown, because the live
 *  guids ARE the pinned values (the load put them there). So this is a carry, not a re-read of the
 *  file, and it works the same whether the instance was loaded from disk or created this session.
 *
 *  `applyGuidRemap` rather than a hand-rolled write, because it is the SAME primitive the two
 *  sibling mechanisms use (`stampDerivedMemberGuids`, `promoteOwnedRoots`) and it is less code than
 *  writing, re-indexing and remapping refs by hand.
 *
 *  ⚠️ **Not falsifiable by the suite, and stated rather than implied.** Mutating it to a bare write
 *  leaves every test green, twice over: `findEntityByGuid` SELF-HEALS on a miss (one rescan, then
 *  retry), so the missing re-index costs speed and not correctness; and nothing this rebuild does
 *  holds a reference to the transient derived guid for the ref-remap to repair. What a bare write
 *  would really cost is `peekEntityByGuid`, which never rescans by design — a guid written without
 *  indexing is invisible to a caller running inside a structure change. No such caller is on this
 *  path today, which is exactly why this note exists instead of a test that cannot fail. */
export function restoreInstanceMembers(rootEcsId: number, rows: Record<string, SceneMemberRow>, pinned?: Set<number>): void {
  const eaMeta = getTraitByName('EntityAttributes');
  if (!eaMeta || !Object.keys(rows).length) return;
  const remap = new Map<string, string>();
  for (const [ecsId, key] of memberRowKeysIn(rootEcsId)) {
    const want = durableGuid(rows[key]?.guid);
    if (!want) continue;
    const had = durableGuid((readTraitData(ecsId, eaMeta) as { guid?: string } | null)?.guid);
    if (had === want) continue;
    // A member with no guid at all is written directly — `applyGuidRemap` keys on the OLD value, and
    // '' would match every guid-less entity in the world — and INDEXED here, because
    // `writeTraitField` does not and the lookups later in this rebuild would not find it.
    if (!had) {
      writeTraitField(ecsId, eaMeta, 'guid', want);
      const e = findEntity(ecsId);
      if (e) indexEntityGuid(e);
    } else remap.set(had, want);
    pinned?.add(ecsId); // the derive after it drops a pin that collides with a derivation (#1777)
  }
  applyGuidRemap(remap);
}

/** Where each member of `rootInstanceId`'s instance tree sits when that is NOT where its own frame's
 *  TEMPLATE puts it — the guid that goes into `SceneMemberRow.parent` (Phase 3, #1468). Members that
 *  sit where their template says are absent, so the common case writes nothing.
 *
 *  ## ⚠️ Why a DIFF and not simply "the live parent, always"
 *
 *  Always-writing would be far simpler here — no document to consult, no frame to resolve — and it
 *  is WRONG, for the case #1468 design record R4 calls the most common template edit there is. A template that
 *  re-parents a member from A to B must move it in every instance that has not moved it itself. A
 *  stored `parent: <A's guid>` would pin the member under A for ever and silently defeat the edit;
 *  an absent `parent` lets it follow the template, which is what "the instance did not override
 *  this" has to mean. `parent` is an override, and an override is a diff.
 *
 *  ## What "where its template puts it" is
 *
 *  Per FRAME, because a member of an owned nested instance is placed by the CHILD document:
 *  `memberRowsIn` hands back the frame root and the member's localId in THAT frame's document, so
 *  the row's `EntityAttributes.parentId` names its template parent in the same localId space. A
 *  member the PREFAB ITSELF moves (#1437 P3-b) is at its base where the prefab put it, not where
 *  its row hangs — `prefabMoveTargets` answers that, and it is asked first for exactly that reason.
 *
 *  ⚠️ A frame whose document is not cached yields NO answer for its members, and they are then left
 *  alone rather than recorded as moved. Writing a `parent` for a member whose template position is
 *  unknown would turn a cache miss into a stored override nobody made. */
export function memberRowParents(
  rootInstanceId: number,
  prefab: PrefabFile,
  /** The members to ask about, as ecsId → their localId in THIS document, when that is not the same
   *  question as "which members have a row here".
   *
   *  ⚠️ The two domains genuinely differ, and the difference is a FRAME. `memberRowsIn` follows
   *  IDENTITY, so an owned nested root dragged OUT of this instance into the one around it belongs
   *  to that outer frame and is absent here — correct for a row key, wrong for the capture, whose
   *  job is exactly to record that it left. `captureInstanceStructure` therefore passes its own
   *  `localToEcs` + `ownedByEcs`, which is every row this DOCUMENT declares, wherever it has been
   *  dragged to. */
  domain?: Map<number, number>,
): Map<number, string> {
  const out = new Map<number, string>();
  const piMeta = getTraitByName('PrefabInstance');
  const eaMeta = getTraitByName('EntityAttributes');
  if (!piMeta || !eaMeta) return out;
  const rows: Map<number, { frameRoot: number; rowLocalId: number }> = domain
    ? new Map([...domain].map(([ecsId, rowLocalId]) => [ecsId, { frameRoot: rootInstanceId, rowLocalId }]))
    : memberRowsIn(rootInstanceId);
  const guidOf = (id: number): string => durableGuid(readTraitData(id, eaMeta)?.guid as string | undefined);
  const liveParentGuid = (id: number): string => guidOf((readTraitData(id, eaMeta)?.parentId as number) || 0);

  // (frame, localId in that frame) → the live entity, inverted from the ONE walk rather than
  // rebuilt: a second index of "which entity is row L of frame F" is the mirror this module already
  // has three of.
  const atRowLocal = new Map<string, number>();
  for (const [id, at] of rows) atRowLocal.set(`${at.frameRoot}:${at.rowLocalId}`, id);
  // With an explicit domain the caller's own map is the index, and it already covers every row of
  // this document — including the ones `memberRowsIn` puts in another frame.
  if (domain) for (const [ecsId, rowLocalId] of domain) atRowLocal.set(`${rootInstanceId}:${rowLocalId}`, ecsId);

  const docOf = new Map<number, PrefabFile | null>();
  const parentLocalOf = new Map<number, Map<number, number>>();
  const moveBaseOf = new Map<number, (ecsId: number) => string>();
  const frame = (root: number): { doc: PrefabFile | null; parentLocal: Map<number, number>; base: (ecsId: number) => string } => {
    if (!docOf.has(root)) {
      const doc = root === rootInstanceId
        ? prefab
        : expandedDocOf(root, piMeta);
      docOf.set(root, doc);
      const byLocal = new Map<number, number>();
      for (const pe of doc?.entities ?? []) {
        const ea = pe.traits['EntityAttributes'];
        byLocal.set(pe.localId, ea && typeof ea !== 'boolean' ? ((ea.parentId as number) || 0) : 0);
      }
      parentLocalOf.set(root, byLocal);
      moveBaseOf.set(root, doc ? prefabMoveTargets(root, doc) : () => '');
    }
    return { doc: docOf.get(root) ?? null, parentLocal: parentLocalOf.get(root)!, base: moveBaseOf.get(root)! };
  };

  for (const [ecsId, at] of rows) {
    const live = liveParentGuid(ecsId);
    if (!live) continue;                                    // no parent, or one with no durable guid
    const f = frame(at.frameRoot);
    if (!f.doc) continue;                                   // template unknown — say nothing
    const base = f.base(ecsId);
    let home = base;
    if (!home) {
      const parentLocal = f.parentLocal.get(at.rowLocalId);
      if (parentLocal === undefined) continue;            // not a row of this document — say nothing
      // The frame's own root holds the document's `rootLocalId`, and a row directly under it names
      // that number; 0 is the root's own parent and never a member's.
      if (!parentLocal || parentLocal === (f.doc.rootLocalId ?? 1)) home = guidOf(at.frameRoot);
      else {
        const p = atRowLocal.get(`${at.frameRoot}:${parentLocal}`) ?? 0;
        // ⚠️ A row parent that is GONE from this instance — REMOVED by it, or UNPACKED so it is no
        // longer a member — leaves '' and the member counts as moved, because there is no template
        // position left for it to be sitting at. This is the case the deleted `PrefabInstance.homeSteps` existed
        // for: with identity derived, a vanished home had to be replaced by the steps it used to
        // contribute, or the member's path changed and so did its guid. With identity stored there
        // is no path to preserve, so the answer is simply "wherever it is now is an override".
        if (!p) home = '';
        else if (!(home = guidOf(p))) continue;           // present but not addressable — say nothing
      }
    }
    if (live !== home) out.set(ecsId, live);
  }
  return out;
}

export function captureInstanceMembers(rootInstanceId: number, prefab?: PrefabFile): Record<string, SceneMemberRow> {
  const eaMeta = getTraitByName('EntityAttributes');
  const out: Record<string, SceneMemberRow> = {};
  if (!eaMeta) return out;
  // `memberRowsToWrite` is the shared predicate — keyed AND holding a durable guid to state. The two
  // stampers skip a member on the strength of a row existing for it, so "a row exists" has exactly
  // one spelling and this is a consumer of it rather than a second copy of the durability rule.
  const keyed = [...memberRowsToWrite(rootInstanceId)].sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  // ⚠️ Without the template there is no `parent`, and that is a CARRY, not a save: `rebuildInstance`
  // reads the rows off the live tree purely to put them back on the re-expanded one, and the moves
  // it must survive ride in the structure it re-applies. A save always has the document.
  const parents = prefab ? memberRowParents(rootInstanceId, prefab) : new Map<number, string>();
  for (const [ecsId, key] of keyed) {
    const ea = readTraitData(ecsId, eaMeta) as { guid?: string; name?: string } | null;
    const guid = durableGuid(ea?.guid);
    if (!guid) continue; // unreachable through `memberRowsToWrite`; kept so `guid` is a string here
    const parent = parents.get(ecsId);
    out[key] = { guid, ...(ea?.name ? { name: ea.name } : {}), ...(parent ? { parent } : {}) };
  }
  // R2 — rows the load could not match to any node the template still declares are written back
  // rather than dropped, so an undone template edit (or a re-import that matches again) restores
  // the scene's identity for that member. A live member always wins the key, so a row that comes
  // back stops being an orphan on the next load without anything here noticing.
  const rootGuid = durableGuid((readTraitData(rootInstanceId, eaMeta) as { guid?: string } | null)?.guid);
  for (const [key, row] of Object.entries(rootGuid ? keptMemberOrphans(rootGuid) ?? {} : {})) {
    if (!out[key]) out[key] = row;
  }
  return out;
}

/** The world-wide half of {@link instanceRowDomain}, built ONCE per identity resolver: every instance's members,
 *  every owned nested root by its owner, and each entity under its identity parent. A save builds the resolver once
 *  per structure version (`openIdentityScope`), so this makes each instance's domain cost its own size rather than
 *  the world's — built per call it was two full-world passes per instance, and a 1200-entity save measured 70%
 *  slower (#1484 close-out review). Outside a scope every resolver is fresh, and so is this. */
type WorldRowIndex = {
  members: Map<number, Map<number, number>>;
  ownedBy: Map<number, Array<[number, number]>>;
  identityChildrenOf: Map<number, EntityInfo[]>;
};

const worldRowIndexMemo = new WeakMap<object, WorldRowIndex>();

function worldRowIndex(identity: ReturnType<typeof worldIdentityParents>): WorldRowIndex {
  const hit = worldRowIndexMemo.get(identity);
  if (hit) return hit;
  const piMeta = getTraitByName('PrefabInstance')!;
  const members = new Map<number, Map<number, number>>();
  getCurrentWorld().query(piMeta.trait).updateEach(([pi], entity) => {
    const d = pi as Record<string, unknown>;
    const root = d.rootInstanceId as number;
    const localId = d.localId as number;
    if (!root || !localId) return;
    let m = members.get(root);
    if (!m) members.set(root, (m = new Map()));
    m.set(localId, entity.id());
  });
  const ownedBy = new Map<number, Array<[number, number]>>();
  const identityChildrenOf = new Map<number, EntityInfo[]>();
  for (const e of filterAuthoringVisible(getAllEntities())) {
    const linked = e.traits.includes('PrefabInstance');
    const parent = (linked && identity.parentOf(e.id)) || e.parentId;
    if (!identityChildrenOf.has(parent)) identityChildrenOf.set(parent, []);
    identityChildrenOf.get(parent)!.push(e);
    const pi = linked ? readTraitData(e.id, piMeta) as MemberPi : null;
    if (!isOwnedRoot(pi, e.id)) continue;
    const owner = identity.ownerOf(e.id);
    if (!ownedBy.has(owner)) ownedBy.set(owner, []);
    ownedBy.get(owner)!.push([e.id, pi!.parentLocalId!]);
  }
  const index = { members, ownedBy, identityChildrenOf };
  worldRowIndexMemo.set(identity, index);
  return index;
}

/** Which live entity is each ROW of `prefab` in `rootInstanceId`'s instance: its MEMBERS (by `localId`), and
 *  the nested roots it OWNS (by the row that expanded them — the claim partition below). ⚠️ The ONE spelling of
 *  this domain (#1484, #1481). Every capture that asks "which entity is row L" must ask it here: a domain built
 *  from members alone cannot see a row whose parent is a nested ROW, and three captures once each read that as
 *  something else — a deleted nested row under a nested row as present (#1484), and a member under a nested row,
 *  or a moved owned root, as moved or not moved against the Transform mark-gate (#1481). */
export function instanceRowDomain(
  rootInstanceId: number,
  prefab: PrefabFile,
  identity: ReturnType<typeof worldIdentityParents>,
): { localToEcs: Map<number, number>; ecsToLocal: Map<number, number>; ownedByEcs: Map<number, number>; claimedRows: Set<number>; rowEcs: (localId: number) => number | undefined } {
  const PrefabInstanceMeta = getTraitByName('PrefabInstance')!;
  const index = worldRowIndex(identity);
  // Members of THIS instance: localId ↔ ecsId.
  const localToEcs = new Map(index.members.get(rootInstanceId) ?? []);
  const ecsToLocal = new Map([...localToEcs].map(([lid, ecs]) => [ecs, lid] as [number, number]));
  // ⚠️ This is a PARTITION over the rows, not a per-node test (#1354). A nested prefab row expands
  // to EXACTLY ONE instance, so each row is claimed at most once and every other instance at that
  // anchor is independent ('userAdded'). The old code answered per node against a `Set` of
  // "<member>:<source>" keys, which any number of nodes could match: a duplicated nested root and a
  // user-added instance under a member that already owned a row of that prefab both came back
  // 'owned', both serialized into the one row's `nestedOverrides`, and the later one won — the other
  // was silently lost on reload. Claiming per row is what makes that unrepresentable, and it is also
  // what makes the row path a sound key for the scene-side structure slot (#1358).
  //
  // Owned nested rows declared by THIS prefab, grouped by anchor member + source. A prefab may nest
  // the SAME source twice under one member, so each key holds a LIST of row localIds.
  const rowsByAnchor = new Map<string, number[]>();
  for (const pe of prefab.entities) {
    if (!pe.prefab) continue;
    const ea = pe.traits['EntityAttributes'];
    const memberLocal = ea && typeof ea !== 'boolean' ? ((ea.parentId as number) || 0) : 0;
    const key = `${memberLocal}:${pe.prefab}`;
    const rows = rowsByAnchor.get(key);
    if (rows) rows.push(pe.localId);
    else rowsByAnchor.set(key, [pe.localId]);
  }
  // Every self-rooted prefab instance hanging DIRECTLY under a member of this instance — the only
  // place a row of this prefab can expand. Sorted by ecsId so the assignment below is deterministic
  // rather than dependent on world-query order.
  // A nested root MOVED inside this instance is looked for under its TEMPLATE parent, where its row is (#1437).
  const { identityChildrenOf } = index;
  const nestedCandidates: { ecsId: number; key: string; stamp: number }[] = [];
  // The anchors a row of this prefab can expand under: every member, and — for a nested row under a nested row
  // (#1468 Phase 6 close-out) — every nested root this instance OWNS, standing for the row that expanded it.
  // A candidate is taken only when this instance owns it — under ANY anchor. The two frames that meet at a nested
  // root each hang rows under it, and when the two documents nest the same prefab at the same localId (#1484's known
  // limit, whose guids the frame step keeps apart) either root matches the other's row by anchor, stamp and source.
  // Taken by the wrong instance, a row reads present while its own root is gone, and deleting it was never saved.
  // An owned root whose owner resolves to nothing (#1383's partial chain) stays a candidate, as it always was.
  const anchors: Array<[number, number]> = [...ecsToLocal].map(([ecs, lid]) => [ecs, lid]);
  for (const [ecs, stamp] of index.ownedBy.get(rootInstanceId) ?? []) anchors.push([ecs, stamp]);
  for (const [memberEcs, memberLocal] of anchors) {
    for (const child of identityChildrenOf.get(memberEcs) || []) {
      if (!child.traits.includes('PrefabInstance')) continue;
      const pi = readTraitData(child.id, PrefabInstanceMeta);
      if (!pi || pi.rootInstanceId !== child.id) continue;
      const owner = isOwnedRoot(pi as MemberPi, child.id) ? identity.ownerOf(child.id) : rootInstanceId;
      if (owner !== rootInstanceId && owner !== 0) continue;
      // Its template parent is a row this instance removed: that row is still the one it anchors at.
      const steps = identity.of(child.id).extra.filter((s) => !isFrameStep(s));
      nestedCandidates.push({
        ecsId: child.id,
        key: `${steps.length ? steps[steps.length - 1] : memberLocal}:${(pi.source as string) || ''}`,
        stamp: (pi.parentLocalId as number) || 0,
      });
    }
  }
  nestedCandidates.sort((a, b) => a.ecsId - b.ecsId);
  /** ecsId → the row localId it is the expansion of. Absent ⇒ independent. */
  const ownedByEcs = new Map<number, number>();
  const claimedRows = new Set<number>();
  // The one claim pass — an exact stamp claims its own row, first by ecsId when two carry the same
  // one. The stamp is what every row expansion writes (see below), so it is the whole signal.
  //
  // A stamp naming a row that is NOT at this candidate's anchor is not honoured — the row it names
  // expands under a different member, so this instance cannot be that row's expansion.
  // ⚠️ This is a consistency property, NOT a repaired symptom, and the distinction is worth keeping
  // straight: the stamp is written at load from the row itself, and `reparentEntity` UNPACKS an owned
  // nested root rather than relocating it stamped, so I could not reach a foreign-anchor stamp from
  // the editor. It stays because `nestedRowPresent` now reads this same map: honouring such a stamp
  // would report a row as present while nothing sits under its actual parent member, suppressing a
  // legitimate `removed`.
  for (const c of nestedCandidates) {
    if (!c.stamp || claimedRows.has(c.stamp)) continue;
    if (!rowsByAnchor.get(c.key)?.includes(c.stamp)) continue;
    claimedRows.add(c.stamp);
    ownedByEcs.set(c.ecsId, c.stamp);
  }
  const ecsOfRow = new Map([...ownedByEcs].map(([ecs, lid]) => [lid, ecs]));
  return { localToEcs, ecsToLocal, ownedByEcs, claimedRows, rowEcs: (lid) => localToEcs.get(lid) ?? ecsOfRow.get(lid) };
}

/** Whether `id` — a non-member hanging somewhere in `rootInstanceId`'s tree — is a ROW of another frame sitting where
 *  that frame's document puts it: an owned nested root another instance owns, or a member of another instance. A
 *  nested row under a nested row, and a plain row under one, hang under the INNER instance's root (#1484), where
 *  its own capture read them as something it had added and its rebuild tore them down with nothing to respawn
 *  them. A MOVED entity is the other half of "not ours" (`identity.moved`), asked by the callers beside this. */
export function foreignRow(id: number, rootInstanceId: number, identity: ReturnType<typeof worldIdentityParents>): boolean {
  const piMeta = getTraitByName('PrefabInstance');
  const pi = piMeta ? readTraitData(id, piMeta) as MemberPi : null;
  if (!pi?.rootInstanceId) return false;
  if (isOwnedRoot(pi, id)) {
    const owner = identity.ownerOf(id);
    // A stamp with no frame behind it (#1383's partial chain) belongs to nobody else: it stays what it was.
    return owner !== 0 && owner !== rootInstanceId;
  }
  return pi.rootInstanceId !== id && pi.rootInstanceId !== rootInstanceId;
}

/** {@link instanceRowDomain} in the shape `memberRowParents` asks it: ecsId → row localId, for every row but the
 *  frame root's own (which sits where its OWNER's frame puts it — {@link ownedRootMoved}). */
export function rowParentDomain(rootInstanceId: number, d: Pick<ReturnType<typeof instanceRowDomain>, 'localToEcs' | 'ownedByEcs'>): Map<number, number> {
  return new Map<number, number>([
    ...[...d.localToEcs].filter(([, ecsId]) => ecsId !== rootInstanceId).map(([lid, ecsId]) => [ecsId, lid] as [number, number]),
    ...d.ownedByEcs,
  ]);
}

/** Whether an OWNED nested root sits somewhere its owner's template does not put it (#1481). Its row is its
 *  OWNER's, so the question is asked of the owner's frame, with the owner's full row domain; a stored root, or
 *  one whose owner's document is not cached, answers false — say nothing rather than invent a move. */
function ownedRootMoved(rootInstanceId: number, identity: ReturnType<typeof worldIdentityParents>): boolean {
  const piMeta = getTraitByName('PrefabInstance');
  if (!piMeta || !isOwnedRoot(readTraitData(rootInstanceId, piMeta) as MemberPi, rootInstanceId)) return false;
  const owner = identity.ownerOf(rootInstanceId);
  const doc = owner ? expandedDocOf(owner, piMeta) : null;
  if (!doc) return false;
  const domain = instanceRowDomain(owner, doc, identity);
  return memberRowParents(owner, doc, rowParentDomain(owner, domain)).has(rootInstanceId);
}

/** What the frame record of `rootId` says about its expansion of `doc` (#1812): the nested rows it could not expand and no
 *  layer removed (`FrameRootRecord.unexpanded`). Undefined when the record answers nothing: no record, a record of
 *  another document, or one no expansion wrote (a carry keeps the field; a Create Prefab tag writes none). */
export function unexpandedRowsOf(rootId: number, doc: PrefabFile): ReadonlySet<number> | undefined {
  const entity = rootId ? findEntity(rootId) : undefined;
  const rec = entity ? frameRootDoc(getCurrentWorld(), entity) : undefined;
  // The same ROWS, not the same object (close-out review): the runtime cache and the editor's hold separate copies of
  // one file (every editor write stores a clone in the runtime's), and the record keeps the loader's — an identity test
  // answered nothing after any prefab write and reload, and Revert and Apply's key list still read the row as removed.
  if (!rec?.unexpanded || !(rec.doc === doc || rowsMeanTheSame(rec.doc as RowDoc, doc as RowDoc))) return undefined;
  return new Set(rec.unexpanded);
}

/** The live Transform of each member of the instance rooted at `rootInstanceId` (the root included), by localId. */
export function memberTransforms(rootInstanceId: number): (lid: number) => Record<string, unknown> | undefined {
  let byLid: Map<number, Record<string, unknown>> | undefined;
  return (lid) => {
    if (!byLid) {
      byLid = new Map();
      const piMeta = getTraitByName('PrefabInstance');
      const tfMeta = getTraitByName('Transform');
      if (piMeta && tfMeta) {
        getCurrentWorld().query(piMeta.trait).updateEach(([pi], entity) => {
          const d = pi as { rootInstanceId?: number; localId?: number };
          if (d.rootInstanceId !== rootInstanceId || !d.localId) return;
          const tf = readTraitData(entity.id(), tfMeta);
          if (tf) byLid!.set(d.localId, tf);
        });
      }
    }
    return byLid.get(lid);
  };
}

export type RowDoc = { entities?: readonly { localId: number; nodeGuid?: string }[] };

/** Do `built` (the document a live frame was expanded from) and `cached` hold the SAME rows — the same
 *  localIds, each naming the same member (`nodeGuid`, where both carry one)? Both directions matter: the
 *  override capture reads each live member's localId in `cached`, and the structure capture reads every row
 *  of `cached` with no live member as one this instance REMOVED — so a row `cached` gained is a false removal
 *  on the next save or Revert (close-out review 2; an earlier version let a gained row through). A row
 *  without a `nodeGuid` on either side (a pre-v5 document, or one the next save minted) cannot be told apart
 *  by identity and is compared by localId alone. */
export function rowsMeanTheSame(built: RowDoc, cached: RowDoc): boolean {
  const b = built.entities ?? [];
  const c = cached.entities ?? [];
  if (b.length !== c.length) return false;
  const at = new Map(c.map((e) => [e.localId, e.nodeGuid]));
  return b.every((e) => at.has(e.localId) && (!e.nodeGuid || !at.get(e.localId) || at.get(e.localId) === e.nodeGuid));
}

/** The localIds of `doc`'s rows that are LIVE in the frame rooted at `frameRoot` — its members and the nested roots
 *  it owns ({@link instanceRowDomain}), the frame root included. */
export function liveRowLocalIds(frameRoot: number, doc: PrefabFile): Set<number> {
  const domain = instanceRowDomain(frameRoot, doc, worldIdentityParents(getCurrentWorld()));
  const out = new Set<number>(domain.localToEcs.keys());
  for (const lid of domain.ownedByEcs.values()) out.add(lid);
  out.add(doc.rootLocalId ?? 1);
  return out;
}
