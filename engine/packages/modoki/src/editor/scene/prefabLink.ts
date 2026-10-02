/** The instance link: tagging a tree as an instance (Create Prefab), untagging, and Detach / Reattach.
 *  Moved out of `prefab.ts` by the prefab.ts split (#1656 § Plan, step 5): a pure move. */

import { keptStateOf, restoreKeptState } from '../../runtime/core/ecs/keptOrphanRows';
import { getCurrentWorld } from '../../runtime/core/ecs/world';
import { templateKeyOf, setTemplateKey, TemplateAddedKey } from '../../runtime/core/templateIdentity';
import { templateKeysOf } from '../../runtime/loaders/templateKeyRecovery';
import { endFrames, stampDerivedMemberGuids, applyGuidRemap, reloadDerivedGuids, identityTree, type DetachedMember } from '../../runtime/core/ecs/memberHome';
import { identitySubtree, noteFrameDoc, frameRootDoc, noteFrameRootDoc } from '../../runtime/core/ecs/identityParents';
import { getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { getAllEntities, markStructureDirty, readTraitData, findEntity } from '../../runtime/core/ecs/entityUtils';
import { getGuidForPath, isGuid, resolveRef, lastKnownPathOf } from '../../runtime/loaders/assetManifest';
import { UndoRefusedError } from '../undo/undoFailure';
import { durableGuid, isStoredRoot, type MemberPi } from '../../runtime/core/assetRefRules';
import { entityRef, type EntityRef } from '../undo/entityRef';
import { clearOverrideMarks, restoreOverrideMarks, unmarkOverride, getStoredOverrideMarks } from '../../runtime/loaders/overrideMarks';
import { captureMarks, restoreMarks, recordDetachedMarks, relinkDetachedMembersMarked, recordsOffBase, type MarkCapture } from '../undo/overrideMarkWrites';
import { authoringEntitiesFor, collectTree, type PrefabFile } from './prefab';
import { settleSwallowedKeptState } from './prefabTokens';
import { rebaseStaleInstances } from './prefabRebuild';
import { planMatchesFile, planMismatch, planPrefabRows } from './prefabSerialize';
import { unkeyedNodes, stripCreatedKeys, stripKeysNow } from './capturedKeys';
import { staleAround } from '../../runtime/prefab/instanceStore';

// ── File I/O ────────────────────────────────────────────

/** The `PrefabInstance.source` a tag or an untag of prefab `source` reads and writes (GUID-only): the DOCUMENT's own id
 *  when the caller holds the file, else the manifest's guid for the path, else the given ref (a manifest that cannot
 *  resolve it yet). The document first (#1807): the manifest follows a move only at its next push, debounced, so right
 *  after a rename's undo a lookup by path answered nothing — and Create Prefab's undo then untagged by a raw path no
 *  entity carries, leaving the tree linked to the prefab it had just trashed (a Missing Prefab on the next load). */
function instanceSourceRef(source: string, doc?: Pick<PrefabFile, 'id'> | null): string {
  if (doc?.id && isGuid(doc.id)) return doc.id;
  return isGuid(source) ? source : (getGuidForPath(source) ?? source);
}

/** Tag every entity in the tree rooted at `rootEcsId` with a PrefabInstance
 *  trait pointing to `source`. localIds match the prefab's localId scheme
 *  (BFS order, root = 1) so per-localId overrides round-trip correctly.
 *
 *  ⚠️ The numbering comes from `planPrefabRows` — the SAME function `serializePrefab` uses to
 *  decide rows (#1278). It used to be re-derived here by counting the live tree, which the
 *  serializer does not do: a nested instance collapses to one reference row and its members are
 *  dropped, so the two disagreed for every member ordered after it and the next save paired each
 *  live entity with the wrong row. **Do not re-derive this — call the planner.**
 *
 *  A nested row is NOT retagged onto `source`: a reload leaves it linked to its own child
 *  prefab and stamps only `parentLocalId` (the outer row that produced it — see
 *  `instantiatePrefabIntoWorld`). This mirrors that, so the live world after Create Prefab
 *  equals the world after a save + reload, and its members are left alone entirely.
 *
 *  ⚠️ PASS `writtenPrefab` whenever you have it. One planner does NOT mean one answer: the
 *  caller serializes, then `await`s a file write — on a Replace that await includes the
 *  `confirmReplace` DIALOG, an unbounded wait during which MCP ops and the file-watcher's scene
 *  reload keep running. The plan computed here is therefore a SECOND read of mutable world +
 *  prefab-cache state. If it disagrees with the file, tagging writes localIds addressing rows
 *  that do not exist, and such an entity is then written to neither the scene entry nor the
 *  overrides — it is simply gone on the next load. So the plan is checked against the file and a
 *  mismatch REFUSES to tag: an untagged entity round-trips as an `added` node, which is the
 *  degradation that loses nothing. */
function tagEntityTreeAsInstanceUnmarked(rootEcsId: number, source: string, writtenPrefab?: PrefabFile): Map<string, string> {
  return tagTree(rootEcsId, source, writtenPrefab).guidRemap;
}

/** What a tag wrote, per ecs id: `link` — the entity's link replaced by a row of the new prefab (and, on a frame root,
 *  its frame's record with it); `stamp` — a nested row's root, which keeps its own link and record and had only its
 *  owning-row fields written. An entity absent here was not written at all. Create Prefab's undo restores exactly
 *  these ({@link tagCreatedPrefab}). */
type TagWrites = Map<number, 'link' | 'stamp'>;

/** {@link tagEntityTreeAsInstance}, reporting what it wrote. `refuseQuietly`: a plan that no longer matches the file is
 *  returned as `refused` for the caller to refuse its step with, instead of logged. */
function tagTree(
  rootEcsId: number, source: string, writtenPrefab?: PrefabFile,
  /** `onLinked`: called once every row is tagged, before the rest (the frame note, the guid stamp) can throw. */
  opts?: { refuseQuietly?: boolean; onLinked?: () => void },
): { guidRemap: Map<string, string>; writes: TagWrites; refused?: string } {
  const writes: TagWrites = new Map();
  const PrefabInstanceMeta = getTraitByName('PrefabInstance');
  if (!PrefabInstanceMeta) return { guidRemap: new Map(), writes };

  // PrefabInstance.source is GUID-only — a raw path bakes a literal into the scene JSON on save and trips resolveRef's
  // hard rejection on load. The written file's own id first (#1807), then the manifest (`instanceSourceRef`).
  const ref = instanceSourceRef(source, writtenPrefab);

  // Mirror serializePrefab's localId assignment (BFS, root = 1) — including WHICH entities it
  // selects, which is why both go through `authoringEntitiesFor`. A tree containing a runtime
  // subtree the file does not have fails `planMatchesFile` below and refuses to tag at all.
  const { entities: allEntities } = authoringEntitiesFor(rootEcsId, getAllEntities());
  const tree = collectTree(rootEcsId, allEntities);

  /** The identity the file just written gave this row (#1468). Without `writtenPrefab` there is
   *  nothing to read it from, so the live tree is left with '' and picks its identity up at the next
   *  load instead — the same degradation `planMatchesFile` already accepts for the plan check, and
   *  both production callers (`assetOps`, `agentEditorOps`) do pass the file. */
  const rowNodeGuids = new Map<number, string>(
    (writtenPrefab?.entities ?? []).map((pe) => [pe.localId, pe.nodeGuid ?? '']),
  );
  const nodeGuidAt = (localId: number): string => rowNodeGuids.get(localId) ?? '';

  /** ⚠️ `piData` must name EVERY field of PrefabInstance. koota's generated setter is a partial
   *  merge (`if ('k' in value) store.k[i] = value.k`), so an omitted field keeps its old value —
   *  and this used to be masked by Create Prefab stripping the trait first. A surviving
   *  `parentLocalId` makes serialize classify the row as an OWNED nested instance of the prefab
   *  it used to belong to (`serialize.ts`: `IdentityParents.frameOf` finds an owner), which writes no
   *  scene entry for it at all and loses the new link on the next reload. */
  const applyTag = (ecsId: number, localId: number) => {
    const entity = findEntity(ecsId);
    if (!entity) return;
    // ⚠️ `ownerGuid` is CLEARED, not omitted — see the partial-merge warning above. Tagging captures the
    //  tree AS IT STANDS, so every member is at its row in the new prefab and none of them is "moved"
    //  relative to it; a link left from the PREVIOUS prefab would name a frame this tree no longer
    //  belongs to. (The home fields it replaced were cleared here for the same reason, #1461 close-out F1.)
    const piData = { source: ref, localId, nodeGuid: nodeGuidAt(localId), rootInstanceId: rootEcsId, parentLocalId: 0, parentNodeGuid: '', ownerGuid: '' };
    if (entity.has(PrefabInstanceMeta.trait)) entity.set(PrefabInstanceMeta.trait, piData);
    else entity.add(PrefabInstanceMeta.trait(piData));
  };

  // The same decision procedure the serializer used — but a SECOND read of the world, so it is
  // checked against the file before anything is written. (`planPrefabRows` only returns null for
  // a cycle, which needs `existingId`; this call passes none, so that cannot fire here.)
  const plan = planPrefabRows(tree, rootEcsId)!;
  if (writtenPrefab && opts?.refuseQuietly) {
    const refused = planMismatch(plan, writtenPrefab);
    if (refused) return { guidRemap: new Map(), writes, refused };
  } else if (writtenPrefab && !planMatchesFile(plan, writtenPrefab, source)) return { guidRemap: new Map(), writes };
  // The numbering is the FILE's, row for row (#1759): a Replace keeps the replaced document's localIds, which the
  // positional plan above cannot reproduce. Without the file there is only the positional plan, which is right only
  // for a first create — said out loud, since a Replace tagged that way addresses rows the file numbered otherwise.
  if (!writtenPrefab) console.warn(`[Prefab] tagging "${source}" without the file just written — numbering its rows by position, which matches only a first Create Prefab, never a Replace`);
  const localIdOf = new Map(plan.flatTree.map((info, i) => [info.id, writtenPrefab ? writtenPrefab.entities[i]!.localId : plan.ecsToLocal.get(info.id)!]));
  for (const info of plan.flatTree) {
    const localId = localIdOf.get(info.id)!;
    const nested = plan.nestedRefs.get(info.id);
    if (nested) {
      // Nested reference row — keep its link to its OWN prefab and stamp only which outer row
      // produced it, exactly as instantiatePrefabIntoWorld does on reload. Its members are not
      // rows of this prefab and are left untouched.
      const entity = findEntity(info.id);
      if (entity?.has(PrefabInstanceMeta.trait)) {
        entity.set(PrefabInstanceMeta.trait, {
          ...(entity.get(PrefabInstanceMeta.trait) as Record<string, unknown>),
          parentLocalId: localId, parentNodeGuid: nodeGuidAt(localId), ownerGuid: '', // at its row: nothing to link
        });
        writes.set(info.id, 'stamp');
      }
      continue;
    }
    applyTag(info.id, localId);
    writes.set(info.id, 'link');
  }
  opts?.onLinked?.();
  // What these members' localIds now MEAN — the document just written — so every identity walk reads their
  // template parents from it before any reload has expanded it (`identityParents.ts`, #1468 Phase 6).
  if (writtenPrefab) noteFrameDoc(getCurrentWorld(), ref, writtenPrefab, findEntity(rootEcsId) ?? undefined);
  // The tags above make these entities MEMBERS, whose identity the reload derives from the anchor and
  // the path — but they still hold the random guids they had as plain entities, and the file written
  // alongside says `guid: ''` on every row. Give them that identity now, or everything written before
  // the first save+reload that names a member by guid names one that will never exist again (#1461).
  // Returned so Create Prefab's undo can reverse it; the callers mint the root's guid before tagging,
  // which is what gives this an anchor to derive from.
  const guidRemap = stampDerivedMemberGuids(rootEcsId);
  markStructureDirty();
  return { guidRemap, writes };
}

/** Undo of the member rename {@link tagEntityTreeAsInstance} returned (#1461): the map reversed and
 *  applied, so every member is addressable by the guid it had before Create Prefab, refs included.
 *
 *  Run it BEFORE `reattachPrefabInstance`: Create Prefab snapshots the tree's prior links one line ahead
 *  of the tag, and that snapshot addresses each member by the guid it held then, so reattaching first
 *  would be asked to resolve guids that are not live yet. Untag is by ecs id and does not care.
 *  The order is PINNED — `packages/modoki/tests/editor/createPrefabUndo.test.ts` asserts the undo
 *  sequence as `['unstamp', 'untag', 'reattach']` on both the create and the replace branch. */
export function unstampMemberGuids(remap: ReadonlyMap<string, string>): void {
  if (!remap.size) return;
  applyGuidRemap(new Map([...remap].map(([from, to]) => [to, from])));
}

/** After Create Prefab's undo has put the tree's prior links back: a member the create's stamp did NOT rename takes the
 *  guid a load of the undone scene derives, every ref with it (#1908). The reversed rename ({@link unstampMemberGuids})
 *  puts back what the stamp renamed, exactly as it was, and those are left alone (`restored`, the stamp's `from` side).
 *  What it cannot reach is a node born AFTER the create: a prefab-edit save that added it to a swallowed instance's
 *  template derived it under the created frame, which the undo just removed, and it kept that guid, so a reload or a
 *  rebuild derived another and every ref to it dangled (hunt seed 7035). Each STORED root of the tree anchors its own
 *  members again; the walk is the forward stamp's (`reloadDerivedGuids`: a rowed member is pinned, not derived). */
export function rederiveUntaggedTree(rootEcsId: number, restored: ReadonlyMap<string, string>): void {
  const piMeta = getTraitByName('PrefabInstance');
  const eaMeta = getTraitByName('EntityAttributes');
  if (!piMeta || !eaMeta) return;
  const world = getCurrentWorld();
  const guidOf = (id: number) => (readTraitData(id, eaMeta) as { guid?: string } | null)?.guid ?? '';
  const remap = new Map<string, string>();
  const tree = identityTree(world);
  for (const info of collectTree(rootEcsId, getAllEntities())) {
    const pi = readTraitData(info.id, piMeta) as MemberPi | null;
    const anchor = pi && isStoredRoot(pi, info.id) ? durableGuid(guidOf(info.id)) : '';
    if (!anchor) continue;
    for (const [e, next] of reloadDerivedGuids(world, info.id, anchor, tree)) {
      const old = guidOf(e.id());
      if (old && old !== next && !restored.has(old)) remap.set(old, next);
    }
  }
  applyGuidRemap(remap, world);
}

/** Inverse of tagEntityTreeAsInstance — strip the PrefabInstance trait off the entities that
 *  belong to `source` in the tree rooted at `rootEcsId`. Used for undo when a newly-created
 *  prefab is reverted.
 *
 *  ⚠️ `source` is REQUIRED (#1272). It used to be optional, and the optional path stripped EVERY
 *  link in the subtree — including a held nested instance's link to its OWN child prefab, which
 *  tagging deliberately never touched. An optional parameter whose default is the old broken
 *  behaviour is the scar #1278 left; it does not get made twice. Undo then depends on `reattachPrefabInstance` putting that link
 *  back from the GUID-keyed snapshot — and after a Play→Stop the nested instance's guid has been
 *  re-minted (it is owned-nested now, so `serialize.ts` writes no scene entry for it and
 *  `deriveInstanceMemberGuids` derives a fresh guid from the new root on load). The ref misses,
 *  reattach skips it silently, and the instance is left plain with its link to Q gone for good.
 *
 *  Scoping by source removes the need to resolve anything across the reload: after a reload this
 *  prefab's own rows carry `source === this prefab` and a held nested instance carries its own
 *  child prefab's guid, so "what this Create Prefab added" is answerable from the live data
 *  rather than from an identity that did not survive.
 *
 *  A nested root that this prefab OWNED also loses its `parentLocalId` — the row that owned it is
 *  being removed, so it goes back to being a free-standing instance. One nested deeper (owned by
 *  the child prefab, not by this one) keeps its stamp, because its owner is untouched.
 *
 *  ⚠️ That test — "was my nearest linked ancestor stripped?" — is a PROXY for the real question,
 *  "did this tagging write my `parentLocalId`?", whose answer is `plan.nestedRefs`. It is wrong in
 *  two shapes, both left standing on #1272: a nested instance held inside ANOTHER held instance
 *  keeps the stamp this Create Prefab wrote (its ancestor was not stripped), and one owned by an
 *  OUTER prefab is zeroed rather than returned to that prefab's row id. Both need the pre-create
 *  value, which only the snapshot has — and reattach cannot reach it once the guid re-derives. */
function untagEntityTreeAsInstanceUnmarked(rootEcsId: number, source: string, doc?: Pick<PrefabFile, 'id'> | null): void {
  const PrefabInstanceMeta = getTraitByName('PrefabInstance');
  if (!PrefabInstanceMeta) return;

  // PrefabInstance.source is GUID-only: the document's own id when the caller holds it (#1807), as the tag reads it.
  const ref = instanceSourceRef(source, doc);

  const allEntities = getAllEntities();
  const tree = collectTree(rootEcsId, allEntities);
  const sourceOf = new Map<number, string | undefined>();
  const removed = new Set<number>();

  for (const info of tree) {
    const entity = findEntity(info.id);
    if (!entity?.has(PrefabInstanceMeta.trait)) continue;
    const pi = entity.get(PrefabInstanceMeta.trait) as Record<string, unknown>;
    sourceOf.set(info.id, pi.source as string | undefined);
    if (pi.source !== ref) continue; // a nested instance's OWN link — not ours
    removed.add(info.id);
  }
  // (A member moved away from one of these keeps its path with nothing recorded: the document still has the
  // rows, `identityParents.ts`.)
  for (const id of removed) findEntity(id)?.remove(PrefabInstanceMeta.trait);

  // A kept nested root whose owning row we just removed is no longer owned by anything.
  {
    const parentOf = new Map(tree.map((i) => [i.id, i.parentId]));
    for (const info of tree) {
      if (removed.has(info.id) || !sourceOf.has(info.id)) continue;
      // The nearest ancestor that carries a link decides who owned this one.
      let cur = parentOf.get(info.id) ?? 0;
      while (cur && !sourceOf.has(cur)) cur = parentOf.get(cur) ?? 0;
      if (!cur || !removed.has(cur)) continue; // owned by a child prefab, or by nothing — leave it
      const entity = findEntity(info.id);
      if (!entity?.has(PrefabInstanceMeta.trait)) continue;
      entity.set(PrefabInstanceMeta.trait, {
        ...(entity.get(PrefabInstanceMeta.trait) as Record<string, unknown>), parentLocalId: 0, parentNodeGuid: '',
      });
    }
  }
  // ⚠️ A scoped strip that matched NOTHING, on a tree that does carry links, means undo left the
  // whole subtree tagged as an instance of a prefab it has just deleted. Silent is exactly what
  // this function was changed to stop being (#1272 review F5).
  if (!removed.size && sourceOf.size) {
    console.error(`[Prefab] untagEntityTreeAsInstance: nothing in this subtree is tagged as "${source}", though ${sourceOf.size} entit${sourceOf.size === 1 ? 'y carries' : 'ies carry'} some other prefab link — the tree was left tagged.`);
  }
  markStructureDirty();
}

/** A captured PrefabInstance trait, used to undo a detach. `ref`/`rootRef` are what reattach resolves
 *  through; `id` is the capture-time ECS id, kept for diagnostics only. `frame`, on a frame ROOT: the record of
 *  the document it was expanded from (`frameRootDoc`) — a reload in between leaves the tree plain and
 *  unrecorded, and without the record put back nothing could tell the restored frame is older than the cache.
 *  `marks`: the entity's override marks, for the same reason (#1794): the reload has nothing to mark a plain tree
 *  from, and the save keeps only marked fields, so relinked without them the instance's overrides were not saved. */
export interface DetachedInstanceTrait { id: number; ref: EntityRef; rootRef: EntityRef; data: Record<string, unknown>; frame?: NonNullable<ReturnType<typeof frameRootDoc>>; marks: MarkCapture; }

/** What a detach undoes: the links it stripped off the tree, the members OUTSIDE the tree it promoted or unlinked
 *  because their frame ended with it (#1453), and the template keys it stripped (#1874) — each by the node's guid, as
 *  the links are. */
/** `keys`: each template-keyed node the detach unkeyed, with its RECORD (#1914 R3a: a template's plain node records its own
 *  edits, as a member does, and the undo that makes it the template's node again must make them its own again — after a
 *  reload in between, the plain node it became holds none). */
export interface DetachSnapshot { links: DetachedInstanceTrait[]; orphans: DetachedMember[]; keys?: { ref: EntityRef; key: string; marks?: MarkCapture }[]; }

/** Detach a prefab instance — strip the `PrefabInstance` trait off the instance
 *  root and EVERY descendant in its identity subtree (nested instances included), turning
 *  the live tree into ordinary, unlinked entities. Mirrors Unity's "Unpack
 *  Prefab Completely". The entities, their transforms, and their other traits are
 *  untouched — only the prefab link is severed, so later edits to the source
 *  prefab no longer propagate here and the tree serializes as plain entities.
 *  Returns a snapshot of the removed traits so the action can be undone.
 *
 *  ⚠️ The snapshot is keyed by GUID (`entityRef`), NOT by ECS id (#1264 close-out review). Detach itself
 *  is id-stable, but that was never enough: OTHER undo entries run between a detach and its undo — a
 *  delete + undo respawns a subtree, and koota recycles ids last-freed-first, so two siblings came back
 *  with each other's ids and reattach cross-wired their localIds with no error. `rootInstanceId` is an
 *  ECS id too, so it is re-derived from `rootRef` at reattach. `entityRef` mints a guid for a member that
 *  has none.
 *
 *  ⚠️ LIMIT — a guid only helps while the entity KEEPS it. A detach leaves plain entities whose guids
 *  are saved, so Hierarchy/agent Detach undo survives Play→Stop. **Create Prefab's snapshot does
 *  not**: a held nested instance ends up INSIDE the new prefab, and `serialize.ts` writes no scene
 *  entry for an owned nested instance (`IdentityParents.frameOf` finds an owner) — only a `nestedOverrides`
 *  delta against the outer row. Its guid never reaches disk, so `deriveInstanceMemberGuids` re-mints
 *  it from the new root on reload and these refs miss.
 *
 *  That is still true, and #1272 fixed the CONSEQUENCE rather than the identity:
 *  `untagEntityTreeAsInstance` takes the prefab's source and strips only its own rows, so undo never
 *  destroys the nested link and never needs the snapshot to resolve it. `reattachPrefabInstance`
 *  returns the count it could not resolve instead of swallowing it. Do NOT re-key this snapshot on
 *  a localId path to "fix" the miss — the address it would need is the one #1278 had to make a
 *  single source of truth, and undo no longer depends on it.
 *
 *  `opts.strip: false` snapshots WITHOUT removing the traits — for a caller that is about to
 *  overwrite the links itself and only wants the undo record (#1278). Create Prefab is one:
 *  stripping first used to leave a held nested instance's members plain, because the tagging
 *  that followed deliberately does not retag them. Detach proper keeps the default.
 *
 *  A member MOVED out of the tree (#1437) is not in `collectTree`, but its frame ends with the strip all
 *  the same. The strip runs `endFrames` first, as a delete does: an owned nested root moved out becomes a
 *  standalone instance, and anything else is unlinked where it stands. Left linked to a frame that no
 *  longer exists, it was written nowhere and vanished on reload (#1453). Those go in `orphans`. */
function detachPrefabInstanceUnmarked(rootEcsId: number, opts?: { strip?: boolean }): DetachSnapshot {
  const PrefabInstanceMeta = getTraitByName('PrefabInstance');
  if (!PrefabInstanceMeta) return { links: [], orphans: [] };
  const strip = opts?.strip !== false;
  // What a Detach ends is the instance's IDENTITY subtree (I6, #1691): a member of ANOTHER frame dragged under it
  // (#1437) is that frame's, and stripping it unlinked it from an instance nothing detached. The walk only answers
  // which entities; that every nested frame among them is stripped too is this function's policy (Unpack Completely,
  // U17), not the walk's. A snapshot-only caller keeps the live tree: it is about to overwrite every link in it.
  const live = collectTree(rootEcsId, getAllEntities());
  const own = strip ? new Set(identitySubtree(getCurrentWorld(), [rootEcsId])) : null;
  const tree = own ? live.filter((e) => own.has(e.id)) : live;
  const snapshot: DetachedInstanceTrait[] = [];
  for (const info of tree) {
    const entity = findEntity(info.id);
    if (!entity || !entity.has(PrefabInstanceMeta.trait)) continue;
    const pi = entity.get(PrefabInstanceMeta.trait) as Record<string, unknown>;
    // Every field (`parentLocalId` among them: it addresses a NESTED instance's per-instance overrides, and a snapshot
    // that dropped it reattached a nested instance as top-level (0) on undo, #1264 close-out). A named subset dropped
    // any field added to the trait later; `DetachedMember` and reparent's snapshot spread it too.
    const frame = pi.rootInstanceId === info.id ? frameRootDoc(getCurrentWorld(), entity) : undefined;
    snapshot.push({
      ...(frame ? { frame } : {}),
      id: info.id, ref: entityRef(info.id), rootRef: entityRef(pi.rootInstanceId as number),
      data: { ...pi }, marks: captureMarks(info.id),
    });
  }
  let orphans: DetachedMember[] = [];
  const keys: { ref: EntityRef; key: string; marks?: MarkCapture }[] = [];
  if (strip) {
    orphans = recordDetachedMarks(endFrames(new Set(snapshot.map((s) => s.id)))); // BEFORE the strip: the owner walk reads these links
    for (const s of snapshot) findEntity(s.id)?.remove(PrefabInstanceMeta.trait);
    // …and every TEMPLATE KEY in the tree (#1874): the key is template identity too, on a node the template added — a plain
    // one carries no link, so the strip above never visits it. Left on, the unpacked node read as its template's node
    // wherever it went: moved under another instance of that prefab it was refused a move as supplied by the prefab, and
    // an edit of that instance's own node saved both nodes on one guid. Unity: an unpacked object refers to no prefab.
    // Its guid stays (Unity keeps references across an unpack), and nothing recovers the key from it: recovery anchors only
    // at a prefab instance (`templateKeyRecovery.ts`), and the roots it derived from are plain now (measured,
    // prefabDetachTemplateKeys.test.ts). The target is an instance root: `detachRefusal` refuses any other, which both
    // surfaces ask first (a plain target stripped its own key and unpacked the instances under it, the close-out review).
    for (const info of tree) {
      const e = findEntity(info.id);
      const key = templateKeyOf(e);
      if (!e || !key) continue;
      keys.push({ ref: entityRef(info.id), key, marks: captureMarks(info.id) });
      e.remove(TemplateAddedKey);
    }
  }
  if (snapshot.length) markStructureDirty();
  return { links: snapshot, orphans, ...(keys.length ? { keys } : {}) };
}

/** Inverse of detachPrefabInstance — re-add the captured PrefabInstance traits
 *  (undo of a detach), and relink the members outside the tree it promoted or unlinked (#1453). */
function reattachPrefabInstanceUnmarked(
  detached: DetachSnapshot,
  /** The subtree undo is restoring. Given, an unresolved ref is only counted as LOST once the link
   *  is confirmed absent from the world. Omit it and every unresolved ref counts, which is right
   *  for a caller that stripped the whole tree (Detach). */
  opts?: { rootEcsId?: number },
): number {
  const PrefabInstanceMeta = getTraitByName('PrefabInstance');
  const { links: snapshot, orphans, keys = [] } = detached;
  if (!PrefabInstanceMeta || (!snapshot.length && !orphans.length)) return 0;
  // The template keys the detach stripped (#1874), before the links: a rebase after this reads a node's key to know it for
  // the template's. One whose node no longer resolves counts with the links below.
  let missedKeys = 0;
  for (const { ref, key, marks } of keys) {
    const live = ref.resolve();
    const entity = live == null ? undefined : findEntity(live);
    if (!entity) { missedKeys++; continue; }
    setTemplateKey(entity, key);
    if (marks) restoreMarks(entity.id(), marks);
  }
  // Orphans first: relinking reverses a promotion's member rename, and the refs below resolve by guid.
  relinkDetachedMembersMarked(orphans);
  const unresolvedEntries: DetachedInstanceTrait[] = [];
  for (const entry of snapshot) {
    const live = entry.ref.resolve();
    const entity = live == null ? undefined : findEntity(live);
    if (!entity) { unresolvedEntries.push(entry); continue; }
    // A root that no longer resolves is not relinked (#1827, I19): the snapshot's `rootInstanceId` is a raw id from the
    // world the Detach ran in, and after a swap it names whatever entity holds that id now. Counted as unresolved, and
    // asked of the world below, as a member miss is. (Detach's undo refuses a miss before it gets here,
    // `requireDetachedLinks`; Create Prefab's undo tolerates one, #1272.)
    const root = entry.rootRef.resolve();
    if (root == null) { unresolvedEntries.push(entry); continue; }
    const restored = { ...entry.data, rootInstanceId: root };
    if (entity.has(PrefabInstanceMeta.trait)) entity.set(PrefabInstanceMeta.trait, restored);
    else entity.add(PrefabInstanceMeta.trait(restored));
    // Its marks with its links, before any rebase reads them through the save's gate (#1794).
    restoreMarks(entity.id(), entry.marks);
    // The frame's record goes back with its links (#1665 close-out): the restored localIds index the document the
    // snapshot recorded, so any other record is wrong for them — none after a plain reload, another prefab's after a
    // retag, or the SAME prefab's newer document after Create Prefab's Replace (re-review: kept, it read v1 links
    // against v2 rows and refused Apply/Revert on the instance).
    if (entry.frame && restored.rootInstanceId === entity.id()) noteFrameRootDoc(getCurrentWorld(), entity, entry.frame);
  }
  markStructureDirty();
  if (!unresolvedEntries.length) return missedKeys;

  // ⚠️ AN UNRESOLVED REF IS NOT A LOST LINK, and counting it as one made this report fire on
  // the very flow the #1272 fix makes work. The snapshot is taken with `strip: false`, so it also
  // holds the entities the scoped untag deliberately KEEPS — a held nested instance, whose guid the
  // reload re-mints. Its ref misses every time, and nothing needed doing to it. Counting refs
  // announced "2 links could not be put back" over a completely correct undo, which is worse than
  // the silence it replaced: it sends the next reader hunting a phantom.
  //
  // So the question is asked of the WORLD, not of the snapshot: is this link actually absent now?
  // (Limit: two sibling instances of the same prefab at the same localId are indistinguishable
  // here, so a genuine loss can be masked by a surviving twin. That under-reports rather than
  // crying wolf, which is the side to err on for something a human reads.)
  if (opts?.rootEcsId == null) return unresolvedEntries.length + missedKeys;
  const present = new Set<string>();
  for (const info of collectTree(opts.rootEcsId, getAllEntities())) {
    const e = findEntity(info.id);
    if (!e?.has(PrefabInstanceMeta.trait)) continue;
    const pi = e.get(PrefabInstanceMeta.trait) as Record<string, unknown>;
    present.add(`${pi.source}|${pi.localId}|${pi.parentLocalId ?? 0}`);
  }
  return unresolvedEntries.filter(({ data: d }) => !present.has(`${d.source}|${d.localId}|${d.parentLocalId ?? 0}`)).length + missedKeys;
}

/** Asked BEFORE a link change puts `detached`'s links back (#1880 W5, I19): refused — an `UndoRefusedError`, with
 *  nothing changed — when a link would be LOST: the entity it goes on, or its root, no longer resolves, and the prefab it
 *  names is gone (trashed since). Nothing can hold that link again. Create Prefab's undo used to change the tree anyway
 *  and count the miss afterwards (`reportUnrestoredLinks`, #1272's tolerance), so it half-applied (seed 1012, #1881: a
 *  prefab nested in the tree trashed, then the undo — "2 prefab links … could not be put back"). An unresolved link
 *  whose prefab still EXISTS is #1272's own case — a held nested frame whose guid a reload re-derived keeps its link on
 *  the entity that holds it now — and is not refused. Unity refuses an undo before it changes anything, and brings no
 *  deleted asset back. Detach's undo asks the stricter {@link requireDetachedLinks}-style question first (every entity
 *  live and plain), since a detach stripped every link it will put back. `what` names the step. */
export async function requireLinks(detached: DetachSnapshot, what: string): Promise<void> {
  const unresolved = new Map<string, number>();
  for (const l of detached.links) {
    if (l.ref.resolve() != null && l.rootRef.resolve() != null) continue;
    const source = l.data.source as string | undefined;
    if (source) unresolved.set(source, (unresolved.get(source) ?? 0) + 1);
  }
  for (const [source, n] of unresolved) {
    // Imported when asked (a link to a gone prefab is rare): the step's module reaches the whole scene graph.
    const { prefabFileGone } = await import('./prefabCommit');
    if (!(await prefabFileGone(source))) continue;
    // A trash prunes the manifest, so the path it lived at is asked of the manifest's memory.
    const path = isGuid(source) ? (resolveRef(source) || lastKnownPathOf(source) || source) : source;
    const file = path.split('/').pop() ?? path;
    throw new UndoRefusedError(
      `${what} was not undone: ${n} of the prefab link${n === 1 ? '' : 's'} it puts back name${n === 1 ? 's' : ''} ${path}, which was deleted since, so nothing was changed.`,
      `${file} was deleted since — nothing was undone`,
    );
  }
}

/** Detach's undo: put the links back ({@link reattachPrefabInstance}), then bring the instance onto the editor's current
 *  copy of its prefab. The links name the document the instance was built from BEFORE the detach, and the template can
 *  change while it is detached — in practice across a world reload (a prefab-edit save and Exit, an external write),
 *  which also leaves the tree plain and unrecorded. Left so, the next save captured a member the template had gained
 *  as REMOVED by this instance (#1665's sibling, observed). The reattach puts each frame's record back from the
 *  snapshot, so the rebase sees it. Returns the unresolved count, as the reattach. */
async function reattachDetachedInstanceUnmarked(detached: DetachSnapshot): Promise<number> {
  const unresolved = reattachPrefabInstance(detached);
  await rebaseStaleInstances();
  return unresolved;
}

/** Create Prefab's tag (#1790, owner ruling D), for both callers: `tagEntityTreeAsInstance`, then the scene half of the
 *  bake. Returns the tag's rename and the undo of everything else it did to the scene (run BEFORE the rename is reversed),
 *  plus what the step's undo and redo read — each taken from what the tag WROTE and the document it wrote, never from a
 *  record of the tree or a re-plan of it (#1830):
 *
 *  - `priorLinks`: the links the tag OVERWROTE, for the undo to put back — nothing else. A nested row's root had only
 *    its owning-row fields written, so its link goes back without its frame's record: that frame keeps whatever it was
 *    expanded from since. Put back, the create-time record claimed a nested frame a prefab-edit save had since rebased
 *    was still on the old document, and the undo's rebase respawned the new child beside itself (I7). A frame the tag
 *    RELINKED gets its record back, which is what a Replace's root needs (#1665 re-review). A nested frame's members are
 *    not written at all, so they are not in it: asked to relink a member a later save deleted, the undo reported a loss.
 *  - `keys`: the template key of each template-added node, by the guid it had before the stamp, for the keys the written
 *    document declares. A redo passes them back (`redo.keys`), and they are put on the tree before it is planned again:
 *    a node whose marker a respawn dropped (an undone Duplicate, redone) was minted a fresh key by that plan, so its
 *    derived guid no longer matched the file and everything naming it missed.
 *  - `refused`, on a redo only: the tree no longer plans to the written rows (a Detach's undo rebased it onto a newer
 *    template, say). The caller refuses the step; nothing was written. Without it the tag logged, left the tree unlinked,
 *    and the step reported success.
 *
 *  It also clears the override marks on every entity it links, and its undo puts them back: the tree is written as it
 *  stands, so nothing in it overrides the document just written from it (Unity: a prefab made from an unpacked object
 *  has no overrides). The entities it does not write — a nested frame's members, a stamped nested root, a plain node a
 *  layer added — lose each record the new document's rows now carry (`clearCarriedRecords`, #1932). A Detach leaves its marks on the plain tree until a reload, and linked with them they were saved
 *  as overrides equal to the template's values, which pinned them against every later edit of the prefab.
 *
 *  And its undo takes off every template key the create put on (#1884): a node that had none before it (`unkeyed`) and
 *  has one now. The CAPTURE stamps them, not this tag — `serializePrefab` writes a scene-added node under a nested
 *  instance as that row's added node, and keys it (`addedNodeIdentity`) — so the caller passes the tree's unkeyed nodes
 *  as they were before its serialize; a redo's are taken here, before its seat. Left on, the node was plain again with
 *  a key the save drops, so live and reloaded disagreed, and a later capture read the stale key as the node's identity.
 *  A node keyed before the create (a nested instance's own template-added node) keeps its key. A redo that refuses takes
 *  its seat back off the same way. Unity: undoing Create Prefab leaves an object with no prefab identity on it. */
function tagCreatedPrefabUnmarked(
  rootEcsId: number, source: string, writtenPrefab: PrefabFile,
  opts?: {
    keys?: ReadonlyMap<string, string>; unkeyed?: ReadonlySet<number>;
    /** Called the moment `tagTree` has linked the tree — after its tag loop, before its guid stamp (#1884 close-out
     *  reviews): from here the keys are the file's, so a throw in the rest of the tag is not a create that landed nothing
     *  (Create's `keep()`). Not called when the tag refuses or the tree no longer plans to the file. */
    onLinked?: () => void;
  },
): { guidRemap: Map<string, string>; undoKept: () => void; priorLinks: DetachSnapshot; keys: Map<string, string>; refused?: string } {
  const redo = opts?.keys;
  const unkeyed = opts?.unkeyed ?? unkeyedNodes(rootEcsId);
  if (redo) seatTemplateKeys(rootEcsId, redo);
  const piMeta = getTraitByName('PrefabInstance');
  const before = piMeta ? (readTraitData(rootEcsId, piMeta) as { source?: string } | null)?.source : undefined;
  // Taken without stripping (#1278), before the tag, then kept to what the tag wrote (`writes`).
  const snapshot = detachPrefabInstance(rootEcsId, { strip: false });
  const { guidRemap, writes, refused } = tagTree(rootEcsId, source, writtenPrefab, { refuseQuietly: !!redo, onLinked: opts?.onLinked });
  if (refused) {
    stripKeysNow(unkeyed);
    return { guidRemap, undoKept: () => {}, priorLinks: { links: [], orphans: [] }, keys: new Map(), refused };
  }
  const priorLinks: DetachSnapshot = {
    links: snapshot.links.filter((l) => writes.has(l.id)).map(({ frame, ...l }) => (writes.get(l.id) === 'link' && frame ? { ...l, frame } : l)),
    orphans: snapshot.orphans,
  };
  const undoMarks = clearLinkedMarks(rootEcsId, writes, [...unkeyed].filter((id) => templateKeyOf(findEntity(id))));
  const undoUnpack = dropUnpackedRootKeptState(rootEcsId, before, writtenPrefab);
  const undoSettle = settleSwallowedKeptState(rootEcsId);
  const undoKeys = stripCreatedKeys(unkeyed);
  return {
    guidRemap, undoKept: () => { undoSettle(); undoUnpack(); undoMarks(); undoKeys(); }, priorLinks,
    keys: writtenKeys(rootEcsId, guidRemap, writtenPrefab),
  };
}

/** Clear the override marks of every entity the tag linked, and return their undo. Addressed by the guid each holds AFTER
 *  the stamp, which is the one it holds when the undo runs: `undoKept` runs before the rename is reversed. The marks
 *  alone, not `restoreMarks`: that one also brings the unmarked fields onto the template (#1800), and neither half of
 *  the tag changes a value.
 *
 *  A STAMPED nested reference root, and a node the create KEYED (a scene-added node under a nested instance, which the
 *  capture wrote as that row's added node: `keyed`), lose the sibling order here: the new template states the node's
 *  place now, so a reload reads no record of it. Their other records, and every nested member's, are then taken by
 *  `clearCarriedRecords` where the new document gives their value (#1932 R4-L1 finding 1). A scene-added reference node's root records that order
 *  always (F7, #1914 R6), so every one carried the mark into the copy (hunt seed 3297); a reorder made before the create
 *  did the same before F7. */
function clearLinkedMarks(rootEcsId: number, writes: TagWrites, keyed: readonly number[]): () => void {
  const held = [...writes].filter(([, w]) => w === 'link').map(([id]) => ({ id, marks: captureMarks(id).keys }))
    .filter((h) => h.marks.length).map(({ id, marks }) => ({ ref: entityRef(id), marks }));
  const handle = (ref: EntityRef) => { const id = ref.resolve(); return id == null ? null : findEntity(id); };
  const ordered = [...new Set([...[...writes].filter(([, w]) => w === 'stamp').map(([id]) => id), ...keyed])]
    .filter((id) => { const e = findEntity(id); return !!e && !!getStoredOverrideMarks(e)?.has('EntityAttributes.sortOrder'); })
    .map((id) => entityRef(id));
  for (const h of held) { const e = handle(h.ref); if (e) clearOverrideMarks(e); }
  for (const ref of ordered) { const e = handle(ref); if (e) unmarkOverride(e, 'EntityAttributes', 'sortOrder'); }
  const undoCarried = clearCarriedRecords(rootEcsId, writes);
  return () => {
    undoCarried();
    for (const h of held) { const e = handle(h.ref); if (e) { clearOverrideMarks(e); restoreOverrideMarks(e, h.marks); } }
    for (const ref of ordered) { const e = handle(ref); if (e) restoreOverrideMarks(e, ['EntityAttributes.sortOrder']); }
  };
}

/** The records the NEW document now carries, off every entity of the tree the tag did not relink — a nested frame's
 *  members, a stamped nested root, a plain node a layer added (#1932, R4-L1 finding 1) — and their undo. The capture
 *  wrote each of those records into the new document's rows, so what the scene instance stated is now its prefab's
 *  statement, and Unity's connected instance starts with an EMPTY modification list (`SaveAsPrefabAssetAndConnect`, which
 *  the outermost instance owns). Left on, the scene restated every one of them on save, and a later edit of the new
 *  prefab's nested copy never reached the instance (#1914 R3 removed the save's depth ≥ 2 subtraction, which had dropped
 *  them as equal to the row, and gave Create nothing in its place).
 *
 *  Per record: one whose live value still DIFFERS from the base the new document gives (`recordsOffBase`) did not reach a
 *  row, so it stays the scene's — kept, never dropped. An entity whose base cannot be read keeps every record. The undo
 *  puts each entity's STORED set back exactly. */
function clearCarriedRecords(rootEcsId: number, writes: TagWrites): () => void {
  const changed: { ref: EntityRef; marks: string[] }[] = [];
  for (const info of collectTree(rootEcsId, getAllEntities())) {
    if (info.id === rootEcsId || writes.get(info.id) === 'link') continue;
    const e = findEntity(info.id);
    const marks = e ? [...(getStoredOverrideMarks(e) ?? [])] : [];
    if (!e || !marks.length) continue;
    const off = recordsOffBase(info.id);
    if (!off || marks.every((k) => off.has(k))) continue;
    changed.push({ ref: entityRef(info.id), marks });
    clearOverrideMarks(e);
    restoreOverrideMarks(e, marks.filter((k) => off.has(k)));
  }
  return () => {
    for (const c of changed) { const id = c.ref.resolve(); const e = id == null ? null : findEntity(id); if (e) { clearOverrideMarks(e); restoreOverrideMarks(e, c.marks); } }
  };
}

/** The template key on each node of the tagged tree that the written document declares, by the node's guid BEFORE the
 *  stamp — the guid it holds again once the undo reverses the rename, and so the one a redo finds it by. */
function writtenKeys(rootEcsId: number, guidRemap: ReadonlyMap<string, string>, written: PrefabFile): Map<string, string> {
  const declared = new Set(templateKeysOf(written));
  const eaMeta = getTraitByName('EntityAttributes');
  const out = new Map<string, string>();
  if (!eaMeta || !declared.size) return out;
  const was = new Map([...guidRemap].map(([from, to]) => [to, from]));
  for (const info of collectTree(rootEcsId, getAllEntities())) {
    const key = templateKeyOf(findEntity(info.id));
    if (!key || !declared.has(key)) continue;
    const guid = durableGuid((readTraitData(info.id, eaMeta) as { guid?: string } | null)?.guid);
    if (guid) out.set(was.get(guid) ?? guid, key);
  }
  return out;
}

/** Put recorded template keys back on the nodes of the tree that hold those guids (a redo, before its plan reads them).
 *  Only inside the tree: a node that left it since is no row of the document, and a key on a scene-authored node makes
 *  the derive pass treat it as template-added (#1538). A redo that then refuses takes them off again, as the create's
 *  undo does (#1884, `tagCreatedPrefab`). */
function seatTemplateKeys(rootEcsId: number, keys: ReadonlyMap<string, string>): void {
  for (const info of collectTree(rootEcsId, getAllEntities())) {
    const key = info.guid ? keys.get(info.guid) : undefined;
    const e = key ? findEntity(info.id) : undefined;
    if (e && templateKeyOf(e) !== key) setTemplateKey(e, key!);
  }
}

/** Create Prefab from an instance ROOT unpacks it (#1814, hub ruling under "prefab behaviour copies Unity"): the root was an
 *  instance of another prefab and is now the root of an original, so what R2 kept for its OWN old frame — orphan member
 *  rows, legacy channels, all in the old prefab's identity space — names nothing the new prefab has, and never can. Unity
 *  drops an unpacked instance's unused overrides; so does this. Not owner ruling D (#1790), which bakes the unused overrides
 *  of the roots the new instance SWALLOWS: those stay nested. Run after the tag and before the settle, which then moves the
 *  swallowed roots' identity rows onto a clean root. Left alone: a root that was no instance (`before` empty), a Replace of
 *  the root's OWN prefab (still an instance of the same document — nothing was unpacked, and Unity keeps a connected
 *  instance's unused overrides), and a tag that refused (the root is still linked to the old prefab). By document id
 *  (`instanceSourceRef`, #1807), not a path through the manifest. Returns the undo. */
function dropUnpackedRootKeptState(rootId: number, before: string | undefined, writtenPrefab: PrefabFile): () => void {
  const piMeta = getTraitByName('PrefabInstance');
  const eaMeta = getTraitByName('EntityAttributes');
  if (!before || !piMeta || !eaMeta) return () => {};
  const now = (readTraitData(rootId, piMeta) as { source?: string } | null)?.source;
  const written = instanceSourceRef('', writtenPrefab);
  if (!now || instanceSourceRef(now) !== written || instanceSourceRef(before) === written) return () => {};
  const rootGuid = durableGuid((readTraitData(rootId, eaMeta) as { guid?: string } | null)?.guid);
  const kept = rootGuid ? keptStateOf(rootGuid) : undefined;
  if (!kept) return () => {};
  restoreKeptState(rootGuid, {});
  return () => restoreKeptState(rootGuid, kept);
}

// #2001 S4 (#2014): these ops do not maintain the instance list yet (S7 moves them onto records), so each marks the
// store stale once it finishes — wrapped here, at the export, so no return path can skip it (`instanceStore.ts`).
export const detachPrefabInstance = staleAround('detach', detachPrefabInstanceUnmarked);
export const reattachPrefabInstance = staleAround('detach', reattachPrefabInstanceUnmarked);
export const reattachDetachedInstance = staleAround('detach', reattachDetachedInstanceUnmarked);
export const tagCreatedPrefab = staleAround('createPrefab', tagCreatedPrefabUnmarked);
export const tagEntityTreeAsInstance = staleAround('createPrefab', tagEntityTreeAsInstanceUnmarked);
export const untagEntityTreeAsInstance = staleAround('createPrefab', untagEntityTreeAsInstanceUnmarked);
