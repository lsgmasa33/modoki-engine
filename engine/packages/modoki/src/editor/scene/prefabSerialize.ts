/** Serializing a live tree into a prefab document: row planning, localId numbering, Replace's rows, and the rigged
 *  re-import merge.
 *  Moved out of `prefab.ts` by the prefab.ts split (#1656 § Plan, step 5): a pure move. */

import { expandedPrefabRefs } from '../../runtime/loaders/prefabNesting';
import { getCurrentWorld } from '../../runtime/core/ecs/world';
import { worldIdentityParents } from '../../runtime/core/ecs/identityParents';
import { hasDocKey, putOwn } from '../../runtime/core/docKeys';
import { collectUnknownFields, mergeUnknownFields } from '../../runtime/core/formatVersion';
import { REF_FIELDS_BY_TRAIT } from '../../runtime/loaders/sceneValidation';
import { getAllTraits, getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { getAllEntities, readTraitData, readTraitDataFull, type EntityInfo } from '../../runtime/core/ecs/entityUtils';
import { runtimeExcludedMessage } from './authoringScope';
import { newGuid, getGuidForPath, isGuid } from '../../runtime/loaders/assetManifest';
import { mapStringValues } from '../../runtime/core/assetRefRules';
import { PREFAB_FORMAT_VERSION } from '../../runtime/core/version';
import { localIdCounter, advanceLocalIdCounter } from '../../runtime/core/localIdCounter';
import { assertNoRuntimeGuids } from './runtimeGuidTripwire';
import { captureDoc } from './prefabBase';
import {
  authoringEntitiesFor, collectTree, isTemplateExcludedField, type PrefabEntity, type PrefabFile,
} from './prefab';
import { wouldCreateCycle } from './prefabCache';
import {
  type NodeExits, templateTokenizer, withKeptStateBake, withNodeExits, withRewritingPrefab,
} from './prefabTokens';
import {
  captureInstanceReference, captureRowChannels, declaredTemplateKeys, finishRowChannels, type PlannedNestedRow,
  templateMoves,
} from './prefabCapture';

export function planPrefabRows(
  tree: EntityInfo[],
  selectedEntityId: number,
  existingId?: string,
  preserveLocalIds?: Map<number, number>,
  /** New members are numbered above this too (prefab-edit: the highest localId the session has opened or written). */
  localIdFloor = 0,
): { nestedRefs: Map<number, PlannedNestedRow>; flatTree: EntityInfo[]; ecsToLocal: Map<number, number> } | null {
  const piMeta = getTraitByName('PrefabInstance');

  // ── Find nested-instance roots and the members they consume ──
  const nestedRefs = new Map<number, PlannedNestedRow>();
  const skip = new Set<number>(); // ecs ids excluded from the flat tree
  if (piMeta) {
    for (const e of tree) {
      if (e.id === selectedEntityId) continue; // never collapse the selection root
      // Already folded into another nested instance as a reference `added` node
      // (a user-added instance nested inside another) — don't ALSO emit a row.
      if (skip.has(e.id)) continue;
      if (!e.traits.includes('PrefabInstance')) continue;
      const pi = readTraitData(e.id, piMeta);
      if (!pi || pi.rootInstanceId !== e.id) continue; // not a self-rooted instance root
      const source = pi.source as string;
      // Cycle guard: refuse to write a nested ref that would make this prefab
      // transitively contain itself (A → B → A). Saves the user from a file that
      // can only ever partially expand (the instantiate-time guard would bail).
      if (existingId && wouldCreateCycle(existingId, source)) {
        console.error(`[Prefab] refusing to save — nesting "${source}" inside "${existingId}" creates a cycle`);
        return null;
      }
      const childPrefab = captureDoc(e.id, source);
      if (!childPrefab) {
        console.warn(`[Prefab] nested prefab "${source}" not cached; flattening instead of referencing`);
        continue;
      }
      // TEMPLATE form: this is written into a prefab file (#1387).
      const ref = captureInstanceReference(e.id, source, childPrefab, { template: true });
      // The row is the OUTERMOST layer for its own nested rows within this file, so it carries their
      // edits itself — the same writer a scene entry and a reference node use (#1381). Captured from
      // the live expansion rather than passed through from the file, or an edit made in the prefab
      // editor inside a nested row would be overwritten by the value it replaced.
      // Each frame's structure per member and per node where it can be (#1533) — the scene writer's own split, so
      // an edit to one thing in a nested frame does not restate, and pin, what the inner prefabs put there. A frame
      // it cannot state that way stays whole in `nestedStructure`, compared by the no-op rule once tokenized.
      const { channels, structureBaselines, nestedStructure, members } = captureRowChannels(e.id, source, childPrefab, ref, true);
      nestedRefs.set(e.id, {
        ref, childPrefab, structureBaselines, nestedOverrides: channels.nestedOverrides,
        nestedStructure, ...(members ? { members } : {}), frames: channels.frames,
      });
      // Exclude the nested instance's members (except the root, which becomes a
      // reference row) and any added subtrees it folded in.
      for (const m of ref.memberEcsIds) if (m !== e.id) skip.add(m);
      for (const c of ref.consumedEcsIds) skip.add(c);
      // …and every OWNED nested instance inside it, at any depth (#1382): the row re-expands them from
      // its own prefab. Given a row of their own they were written twice — once implicitly, once at
      // the prefab root — and the tagger then re-stamped the owned root onto that second row.
      for (const m of channels.ownedMemberEcsIds) skip.add(m);
      for (const c of channels.consumedEcsIds) skip.add(c);
    }
  }

  // Assign localIds over the surviving tree. Without a preserve map this is the original
  // positional numbering (1-based, root = 1) — the create-a-prefab-from-an-entity path, where
  // there is no prior numbering to honour. With one (a prefab-edit RE-save) every member keeps
  // the id it already had, so a scene's localId-keyed overrides keep pointing at the same
  // member; only genuinely new members are allocated, above the highest preserved id.
  const flatTree = tree.filter((e) => !skip.has(e.id));
  const ecsToLocal = new Map<number, number>();
  if (preserveLocalIds) {
    let next = localIdFloor;
    for (const e of flatTree) next = Math.max(next, preserveLocalIds.get(e.id) ?? 0);
    for (const e of flatTree) {
      const kept = preserveLocalIds.get(e.id);
      ecsToLocal.set(e.id, kept ?? ++next);
    }
  } else {
    flatTree.forEach((e, i) => ecsToLocal.set(e.id, i + 1));
  }
  return { nestedRefs, flatTree, ecsToLocal };
}

/** Does a freshly-computed plan still describe the prefab that was WRITTEN? The two are computed
 *  either side of an `await` (see `tagEntityTreeAsInstance`), so this is the tripwire for the
 *  world or the prefab cache having moved underneath. Compares row count and, positionally,
 *  which rows are nested references — enough to catch a member appearing or vanishing and a
 *  nested child becoming cacheable mid-flight (which flips it from flattened to a reference row
 *  and shifts every localId after it). */
export function planMatchesFile(
  plan: { flatTree: EntityInfo[]; nestedRefs: Map<number, unknown> },
  written: PrefabFile,
  source: string,
): boolean {
  const why = planMismatch(plan, written);
  if (why) console.error(`[Prefab] not tagging "${source}" — the live tree no longer matches the prefab just written (${why}). The entities were left untagged rather than pointed at rows that may not exist.`);
  return !why;
}

/** Why a freshly-computed plan no longer describes the prefab that was written, or null ({@link planMatchesFile}'s
 *  question, unlogged: for a caller that refuses with the reason itself). */
export function planMismatch(plan: { flatTree: EntityInfo[]; nestedRefs: Map<number, unknown> }, written: PrefabFile): string | null {
  if (plan.flatTree.length !== written.entities.length) {
    return `${plan.flatTree.length} rows now vs ${written.entities.length} written`;
  }
  const record = writtenRows.get(written.entities);
  for (let i = 0; i < plan.flatTree.length; i++) {
    const e = plan.flatTree[i]!;
    const row = written.entities[i]!;
    if (plan.nestedRefs.has(e.id) !== !!row.prefab) {
      return `row ${i + 1} changed between a nested reference and a plain member`;
    }
    // The tag reads each entity's localId from the row at its position (#1759), so a tree that changed under the write
    // (a delete and an add keep the count) hands one entity another's row. The recorded plan says which entity each row
    // was written from. Not the NAME (close-out review F5): a rename during the write reorders nothing, and refusing it
    // left a correctly numbered tree unlinked.
    const was = e.guid ? record?.get(e.guid) : undefined;
    if (was !== undefined && was !== row.localId) return `"${e.name ?? ''}" was written at localId ${was}, but sits where row ${row.localId} was written`;
  }
  return null;
}

/** The node guid every written row keeps (#1468) — CARRIED where a genuine correspondence to the
 *  document being overwritten exists, MINTED where none does.
 *
 *  THREE carriers, because the re-save paths hold identity in different places:
 *
 *  - `preserved` (ecsId → node guid) — prefab-EDIT, which loads a document into a scratch world of
 *    PLAIN entities and re-serializes it. There is no live prefab link to read, so its baseline
 *    document is the only thing that knows; `savePrefabEdit` builds the map beside `preserveLocalIds`.
 *  - the live `PrefabInstance.nodeGuid` — every other re-save. A member of an instance of THIS prefab
 *    was expanded from the row it is about to be written back into, so its identity is this
 *    document's to keep. ⚠️ Gated on `pi.source === existingId` deliberately: a member of some OTHER
 *    prefab's instance carries an identity in THAT document's frame, and copying it here would make
 *    two documents name one node.
 *  - the live `PrefabInstance.parentNodeGuid` — a NESTED REFERENCE ROW, whose own `nodeGuid` answers
 *    the wrong question (it is the root's identity in the CHILD document, and the row's identity
 *    belongs to THIS one). ⚠️ **Its gate is asked of the TREE, not of the row**, because a nested
 *    root's `source` names the child prefab and so can never equal `existingId`: the selection root
 *    must itself be an instance of `existingId`. `planPrefabRows` has already dropped every DEEPER
 *    nested root from `flatTree` (`channels.ownedMemberEcsIds`), so what survives is a direct row of
 *    this document; a user-ADDED nested instance has `parentLocalId` 0 and therefore no
 *    `parentNodeGuid`, which is why it correctly mints instead.
 *
 *  Everything else mints. That is the honest answer, not a fallback: Create-Prefab-Replace over an
 *  unrelated tree, an agent `create` over an existing path and a fresh model import have no
 *  correspondence to the old rows at all. Minting makes every stored key naming an old row DANGLE,
 *  which a reader can detect — where today's positional renumbering silently REPOINTS them at whichever
 *  node inherited the number.
 *
 *  ⚠️ **ONE class does not carry, and "everything else mints" must not be read as covering it.**
 *
 *  1. **An instance whose `source` is a PATH rather than a GUID.** `tagEntityTreeAsInstance` and
 *     `setPrefabSource` both fall back to the raw path when the manifest cannot resolve it, while
 *     `existingId` is always a GUID — so the gate misses and every row re-mints. Narrow, and it
 *     resolves itself once the manifest indexes the asset. It bites the TREE gate above as well as
 *     the per-member one, so a path-sourced instance loses its nested rows' identity too.
 *
 *  ⚠️ **The nested reference row USED to be the second class, and Phase 2B closed it** (#1468). It is
 *  recorded here because the shape of the hole is worth keeping: the field that would have fixed it
 *  existed as a NUMBER (`parentLocalId`) the whole time, and the reason it was left open for a phase
 *  was that an identity twin of it had no reader until the scene stored member rows — a field nothing
 *  reads being its own defect class (CLAUDE.md: *an unwired field is a lie with a tooltip*). Until
 *  then prefab-EDIT carried nested rows and nothing else did, so one document kept nested identity
 *  under Cmd+S and lost it through every other `existingId` path.
 *
 *  ⚠️ Minting happens HERE, on the write, and nowhere else. A reader that minted would hand two
 *  readers of one file two different identities for one node, and any key written against the loser
 *  dangles at the next load. A v4 document therefore stays unmigrated until something saves it
 *  (#1468 design record: files migrate on next save). */
function nodeGuidsFor(
  flatTree: EntityInfo[],
  existingId: string | undefined,
  preserved: Map<number, string> | undefined,
  selectedEntityId: number,
  nestedRowIds: ReadonlySet<number>,
  /** The document this write REPLACES (#1686), when it is a Replace: Create Prefab over an existing file, or the
   *  agent `create` op over an existing path. Never a prefab-edit save, whose rows are named by `preserved`. */
  replacing?: ReplacedRows,
): ((ecsId: number) => string) & { carried: ReadonlyMap<number, string> } {
  const piMeta = getTraitByName('PrefabInstance');
  const carried = new Map<number, string>();
  const claimed = new Map<string, number>();
  // A Replace's root IS the replaced document's root (#1837, hub ruling reading 1, Unity: the root always maps to the
  // root, whatever its name — only children match by name, U22). So it takes the old root row's nodeGuid, as
  // `replaceNumbering` gives it the old root's localId, and localId 1 stays bound to the one node (I4). Ahead of the live
  // identity and the name match: a selection that is a MEMBER of an instance of the target carries that member's
  // nodeGuid, and a new root named like no row would mint — either re-binds the root's localId to another node.
  const rootLid = replacing?.rootLocalId ?? 1;
  const rootGuid = replacing?.entities?.find((r) => r.localId === rootLid)?.nodeGuid;
  if (rootGuid && isGuid(rootGuid)) { claimed.set(rootGuid, selectedEntityId); carried.set(selectedEntityId, rootGuid); }
  const take = (ecsId: number, guid: string): void => {
    // The root, bound above: its own live nodeGuid (a member's, when the selection is one) must not re-bind it.
    if (carried.has(ecsId)) return;
    const other = claimed.get(guid);
    if (other !== undefined) {
      // Two live entities claiming one template node — a duplicated member whose copy kept the
      // link. Only one row can BE that node, so the later one is minted a fresh identity. Said out
      // loud rather than resolved quietly: silently picking a winner is how a duplicate ends up
      // sharing a stored key with its original, which is the failure this field exists to prevent.
      // ⚠️ The row NAMES, not the ECS ids (close-out review R7). Runtime ids are reassigned on every
      // reload (CLAUDE.md § Debug Tools), and the one shape that reaches this branch is a damaged
      // DOCUMENT — so the reader needs something they can find in the file they have to repair.
      const nameOf = (id: number) => flatTree.find((e) => e.id === id)?.name ?? `ecs:${id}`;
      console.warn(`[Prefab] two rows claim node guid ${guid} ("${nameOf(other)}" and "${nameOf(ecsId)}") — the document names one node twice; minting a fresh identity for the second`);
      return;
    }
    claimed.set(guid, ecsId);
    carried.set(ecsId, guid);
  };
  // Is this live tree an instance of the document being overwritten? Asked ONCE, of the selection
  // root, because it is the only place a nested row's frame can be read from (see the docblock).
  const rootPi = piMeta && existingId ? readTraitData(selectedEntityId, piMeta) as { source?: string } | null : null;
  const treeIsInstanceOfTarget = !!rootPi && rootPi.source === existingId;
  for (const e of flatTree) {
    const fromEdit = preserved?.get(e.id);
    if (fromEdit) { take(e.id, fromEdit); continue; }
    if (!piMeta || !existingId) continue;
    const pi = readTraitData(e.id, piMeta) as { source?: string; nodeGuid?: string; parentNodeGuid?: string } | null;
    if (nestedRowIds.has(e.id)) {
      if (treeIsInstanceOfTarget && pi?.parentNodeGuid) take(e.id, pi.parentNodeGuid);
      continue;
    }
    if (pi?.source === existingId && pi.nodeGuid) take(e.id, pi.nodeGuid);
  }
  // A Replace then matches BY NAME what no live identity answered for (#1686, Unity parity U22): "Unity tries to
  // preserve references to the prefab and the individual parts… it matches the names of GameObjects between the new
  // prefab and the existing prefab" (Manual, CreatingPrefabs). Unity's match ignores the hierarchy and says a duplicate
  // name makes it "unpredictable"; here a duplicate name — on either side — matches nothing and mints, because a guess
  // hands one node's stored edits to another. A nested row matches only a nested row of the same child prefab, and a
  // plain node only a plain row. The live `nodeGuid` above wins wherever it exists: it is the exact correspondence.
  // A REBUILD (`serializeRebuildOver`, #1782) matches by hierarchy PATH instead — the names from the root down — as
  // Unity's model importer keeps a node's identity across a reimport by its path: two same-named nodes under different
  // parents both keep theirs. The same rule on either side: a path that is not unique matches nothing and mints.
  if (replacing?.entities?.length) {
    const kindOf = (e: EntityInfo): string => (nestedRowIds.has(e.id)
      ? `ref:${(piMeta ? (readTraitData(e.id, piMeta) as { source?: string } | null)?.source : '') ?? ''}` : 'plain');
    const byPath = replacing.match === 'path';
    const liveById = new Map(flatTree.map((e) => [e.id, e] as const));
    const livePath = (e: EntityInfo): string => {
      const names: string[] = [];
      for (let at: EntityInfo | undefined = e; at && at.id !== selectedEntityId; at = liveById.get(at.parentId)) names.unshift(at.name ?? '');
      return names.join('\0');
    };
    const rowByLocal = new Map(replacing.entities.map((r) => [r.localId, r] as const));
    const rowPath = (r: ReplacedRow): string => {
      const names: string[] = [];
      const seen = new Set<number>();
      for (let at: ReplacedRow | undefined = r; at && at.localId !== rootLid && !seen.has(at.localId ?? 0); at = rowByLocal.get(at.traits?.EntityAttributes?.parentId)) {
        seen.add(at.localId ?? 0);
        names.unshift(at.name ?? '');
      }
      return names.join('\0');
    };
    const count = <T,>(xs: Iterable<T>, key: (x: T) => string) => {
      const n = new Map<string, number>();
      for (const x of xs) n.set(key(x), (n.get(key(x)) ?? 0) + 1);
      return n;
    };
    const liveKey = (e: EntityInfo) => `${kindOf(e)}\0${byPath ? livePath(e) : e.name ?? ''}`;
    const rowKey = (r: ReplacedRow) => `${r.prefab ? `ref:${r.prefab}` : 'plain'}\0${byPath ? rowPath(r) : r.name ?? ''}`;
    const liveNames = count(flatTree, liveKey);
    const rowNames = count(replacing.entities, rowKey);
    const rowByKey = new Map(replacing.entities.map((r) => [rowKey(r), r]));
    for (const e of flatTree) {
      if (carried.has(e.id) || !e.name) continue;
      const k = liveKey(e);
      const r = rowByKey.get(k);
      if (!r?.nodeGuid || liveNames.get(k) !== 1 || rowNames.get(k) !== 1 || claimed.has(r.nodeGuid)) continue;
      take(e.id, r.nodeGuid);
    }
  }
  return Object.assign((ecsId: number) => carried.get(ecsId) ?? newGuid(), { carried: carried as ReadonlyMap<number, string> });
}

export function serializePrefab(
  selectedEntityId: number,
  existingId?: string,
  opts?: Parameters<typeof serializePrefabBody>[2],
): PrefabFile | null {
  return withRewritingPrefab(existingId, () =>
    withKeptStateBake(!!opts?.bakeKeptState, () => serializePrefabBody(selectedEntityId, existingId, opts)));
}

function serializePrefabBody(
  selectedEntityId: number,
  existingId?: string,
  opts?: {
    /** A Create Prefab of a SCENE tree (the human path and the agent `create`, #1790, owner ruling D): what R2 kept for
     *  each root it swallows — orphan member rows, unreached legacy channels — goes into the template, as Unity's unused
     *  overrides travel with the instance. Its identity stays in the scene: {@link tagCreatedPrefab}. */
    bakeKeptState?: boolean;
    /** ecsId → the localId that entity ALREADY had in the prefab being re-saved.
     *
     *  Only prefab-edit can supply this, and only prefab-edit needs it: localIds are the
     *  address space a SCENE's `overrides` / `removed` / `removedTraits` are keyed in, so
     *  renumbering them on a re-save silently repoints or drops every override on every
     *  instance. Positional numbering does renumber — a prefab whose members were authored
     *  with a gap (a deleted sibling) compacts on the next save (measured on sling's
     *  FieldCorner: `drip` 4 → 2). Members with no entry here (the user added them during
     *  the edit) are allocated ABOVE every preserved id, never into a freed gap. */
    preserveLocalIds?: Map<number, number>;
    /** ecsId → the node guid that entity's row ALREADY had in the prefab being re-saved (#1468).
     *
     *  The prefab-EDIT twin of `preserveLocalIds`, and needed for the same reason and by the same
     *  single caller: the edit world holds the document as PLAIN entities with no prefab link, so
     *  nothing live remembers which row each one is. Without it every node in an edited prefab would
     *  be re-minted on every save — identity that changes on each Cmd+S is worse than none.
     *  Rows with no entry here are minted (a member the user added during the edit; a row of a
     *  pre-v5 document, which has no identity to keep). */
    preserveNodeGuids?: Map<number, string>;
    /** Keep this as the prefab's `name` instead of taking the ROOT ENTITY's name.
     *
     *  The two are independent: the asset is named by its file, the root entity by the
     *  author. Defaulting to the root's name silently renames the asset on any re-save —
     *  measured on sling, where "Cover Enemy" and "Green Enemy" both became "Enemy"
     *  because that is what their root entity is called. */
    name?: string;
    /** Called when the walk dropped runtime entities (pooled rows, preview spawns) from the
     *  selection — with how many. The exclusion itself is not optional; this is only how a caller
     *  SURFACES it (a toast, an MCP response field). `serializePrefab` always logs it too. */
    onRuntimeExcluded?: (count: number) => void;
    /** localId → the row parent that member had in the prefab being RE-saved (prefab-edit). A row whose live
     *  parent is no row — the prefab's own move put it under a nested member (#1437) — is written back under
     *  it, with the move kept in `moved`, instead of losing its parent. */
    rowParents?: Map<number, number>;
    /** The document this write REPLACES, read before the write destroys it — a Replace (Create Prefab over an
     *  existing file, the agent `create` over an existing path). A node no live identity names takes the `nodeGuid`
     *  of the one row sharing its name (#1686, `nodeGuidsFor`). */
    replacing?: ReplacedRows;
    /** Told, once the document is built, the localId each live entity of the tree was written at — for a caller that
     *  must name the same rows on its next save (prefab-edit, #1662). */
    onRows?: (ecsToLocal: ReadonlyMap<number, number>) => void;
    /** With `preserveLocalIds`: a new member is numbered above this as well as above every preserved id — prefab-edit's
     *  highest localId the session has opened or written, so a number freed by a delete is never handed to a new member
     *  while the deleted one can still come back by undo (#1662; Unity never reuses a fileID either). */
    localIdFloor?: number;
    /** ecsId → the reference row a placeholder stands for, whose prefab the load could not expand (#1699, prefab-edit
     *  only). The row is written as given (its prefab, edits and traits), numbered, identified, named and parented like
     *  any other: the edit world holds nothing of that frame for a capture to find. */
    unresolvedRows?: ReadonlyMap<number, PrefabEntity>;
  },
): PrefabFile | null {
  const rawEntities = getAllEntities();
  // #1306: a live runtime artifact under the selection is NOT authoring input — a UIEntries pooled
  // row or a timeline scrub spawn would otherwise be written into the new file as an ordinary
  // authored member (measured: `["Ship","Flame","PooledRow"]`). The pool runs while the sim is
  // STOPPED (priority 270 > TRANSFORM), so this is the everyday case, not a Play-mode one.
  //
  // ⚠️ Unless the SELECTION ROOT is itself Transient: pointing Create Prefab straight at generated
  // content is a deliberate "bake this" and must produce the thing the user selected, not an empty
  // file. The exclusion is about what rides along UNASKED.
  const { entities: allEntities, excluded: excludedCount } = authoringEntitiesFor(selectedEntityId, rawEntities);
  if (excludedCount > 0) {
    // Reported, never silent (owner, 2026-09-17): a prefab that quietly lost members is the
    // surprise that gets filed as a bug weeks later. The console line is by construction here;
    // `onRuntimeExcluded` is how an interactive caller raises it to a toast or an MCP response.
    console.warn(`[Prefab] ${runtimeExcludedMessage(excludedCount)}`);
    opts?.onRuntimeExcluded?.(excludedCount);
  }
  const tree = collectTree(selectedEntityId, allEntities);
  if (tree.length === 0) return null;

  const exits: NodeExits = { root: selectedEntityId, markers: new Map(), origins: new Map() };
  const plan = withNodeExits(exits, () => planPrefabRows(tree, selectedEntityId, existingId, opts?.preserveLocalIds, opts?.localIdFloor));
  if (!plan) return null; // cycle — planPrefabRows already reported it
  const { nestedRefs, flatTree, ecsToLocal } = plan;

  const allTraits = getAllTraits();
  const prefabEntities: PrefabEntity[] = [];
  const nestedRowIds = new Set(nestedRefs.keys());
  const nodeGuidOf = nodeGuidsFor(flatTree, existingId, opts?.preserveNodeGuids, selectedEntityId, nestedRowIds, opts?.replacing);
  // A Replace keeps the numbering of every row it carries identity for (#1759): `planPrefabRows` numbered by position.
  if (opts?.replacing && !opts.preserveLocalIds) {
    const kept = replaceNumbering(flatTree, selectedEntityId, nodeGuidOf.carried, opts.replacing);
    if (kept) { ecsToLocal.clear(); for (const [id, lid] of kept) ecsToLocal.set(id, lid); }
  }
  const rowParent = rowParentsFor(selectedEntityId, flatTree, allEntities, ecsToLocal, opts?.rowParents, nestedRowIds);
  // A ref from one member of the written tree to another becomes a member TOKEN (#1352): the file is a
  // template, and the live guid it held names the SOURCE entity in every instance.
  const tokens = templateTokenizer(selectedEntityId, allEntities, ecsToLocal, rowParent);
  tokens.adoptOrigins(exits.origins);

  for (const entityInfo of flatTree) {
    const localId = ecsToLocal.get(entityInfo.id)!;

    // Nested-instance root → reference row (child prefab + captured diffs). Only
    // EntityAttributes (name + remapped parentId) is written inline; the child's
    // own traits come from the child file, edits ride in `overrides`.
    const unresolvedRow = opts?.unresolvedRows?.get(entityInfo.id);
    if (unresolvedRow) {
      const parentLocal = ecsToLocal.get(rowParent.get(entityInfo.id) ?? 0) || 0;
      const ea = unresolvedRow.traits.EntityAttributes;
      prefabEntities.push({
        ...unresolvedRow,
        localId,
        nodeGuid: nodeGuidOf(entityInfo.id),
        name: entityInfo.name,
        traits: { ...unresolvedRow.traits, EntityAttributes: { ...(ea && ea !== true ? ea : {}), name: entityInfo.name, parentId: parentLocal, guid: '' } },
      });
      continue;
    }

    const nested = nestedRefs.get(entityInfo.id);
    if (nested) {
      const parentLocal = ecsToLocal.get(rowParent.get(entityInfo.id) ?? 0) || 0;
      const fin = finishRowChannels(tokens, entityInfo.id, nested);
      prefabEntities.push({
        localId,
        nodeGuid: nodeGuidOf(entityInfo.id),
        name: entityInfo.name,
        traits: { EntityAttributes: { name: entityInfo.name, parentId: parentLocal, guid: '' } },
        prefab: nested.ref.source,
        overrides: fin.overrides,
        added: fin.added,
        removed: nested.ref.removed,
        removedTraits: nested.ref.removedTraits,
        nestedOverrides: fin.nestedOverrides,
        nestedStructure: fin.nestedStructure,
        ...(fin.members ? { members: fin.members } : {}),
      });
      continue;
    }

    const entry: PrefabEntity = { localId, nodeGuid: nodeGuidOf(entityInfo.id), name: entityInfo.name, traits: {} };

    // Read each trait's data
    for (const meta of allTraits) {
      if (!entityInfo.traits.includes(meta.name)) continue;
      // Skip PrefabInstance trait — don't nest prefab metadata
      if (meta.name === 'PrefabInstance') continue;

      if (meta.category === 'tag') {
        entry.traits[meta.name] = true;
        continue;
      }

      // O(1) direct read — was a full-world query.updateEach per trait (O(n²) over
      // the scene). Read what the trait PERSISTS (its koota schema), the same rule
      // the override paths use: AoS traits need it for their non-scalar fields
      // (AnimationLibrary's animSets/boneMaps), and SoA traits need it for a schema
      // field a custom Inspector section owns — Animator.clips/clip, which the old
      // curated read dropped, so Create Prefab produced a template with an EMPTY
      // clip bank. See runtime/core/ecs/traitSchema.ts.
      const traitData = readTraitDataFull(entityInfo.id, meta);

      if (traitData) {
        // Drop what a TEMPLATE must not carry: runtime read-back (Time.elapsed,
        // RigidBody.isSleeping, SkeletalAnimator.activeClip/time/weight — otherwise
        // creating a prefab from an animating entity bakes a nondeterministic frame
        // in) and scene-only organizational fields.
        for (const key of Object.keys(traitData)) {
          if (isTemplateExcludedField(meta, key)) delete (traitData as Record<string, unknown>)[key];
        }
        // ⚠️ Drop BLANK asset refs. `readTraitDataFull` writes every schema field, so a
        // `Renderable2D` with no material serialized `material: ""` — a blank ref, which
        // `tests/assets/authoredAssetRefs.test.ts` correctly fails (#53: an unset ref is invisible
        // to every other test — neither dangling nor a literal path — and surfaces only in a
        // production build).
        //
        // This USED to be a manual cleanup after `modoki_prefab create`. That is untenable now that
        // prefabs are hand-tuned in the editor: every Cmd+S in prefab-edit re-adds them, so a human
        // repositioning a badge turns `npm run verify` red and has to know to go and strip eight
        // keys out of the JSON. Measured: one save of Court's tray-badge prefab reintroduced 8.
        //
        // Dropping the key is a semantic NO-OP — the loader rebuilds each trait with
        // `meta.trait(partialData)` and koota fills every absent field from the same schema, so ''
        // and absent load identically. Deliberately narrow: only `''`, and only on fields the ref
        // registry already names, rather than omitting every default-valued field the way SCENES do.
        // Full omission would also drop an authored number that happens to equal its default, and
        // at least one consumer reads prefab fields BY NAME and treats a missing one as "no layout"
        // (Court's layoutFromPrefabDoc → a silent fallback to code constants).
        for (const field of REF_FIELDS_BY_TRAIT[meta.name] ?? []) {
          if ((traitData as Record<string, unknown>)[field] === '') delete (traitData as Record<string, unknown>)[field];
        }
        // Remap parentId from ECS IDs to localIds (parentId is in EntityAttributes).
        // Clear `guid` — prefab files are templates; per-instance identity lives on
        // the live entity, not in the prefab definition. Otherwise every instance
        // of the prefab would start with the same (stale) guid.
        if (meta.name === 'EntityAttributes') {
          if (traitData['parentId'] !== undefined) {
            (traitData as Record<string, unknown>)['parentId'] = ecsToLocal.get(rowParent.get(entityInfo.id) ?? 0) || 0;
          }
          (traitData as Record<string, unknown>)['guid'] = '';
        }
        entry.traits[meta.name] = tokens.value(traitData, tokens.root) as typeof traitData;
      }
    }

    prefabEntities.push(entry);
  }

  // Rewrite asset path refs in trait data to GUIDs where the manifest knows them.
  // After the one-shot migration this is a no-op (already GUIDs).
  for (const pe of prefabEntities) {
    for (const [traitName, fields] of Object.entries(PREFAB_REF_FIELDS)) {
      const data = pe.traits[traitName];
      if (!data || typeof data === 'boolean') continue;
      const obj = data as Record<string, unknown>;
      for (const field of fields) {
        const v = obj[field];
        if (typeof v !== 'string' || !v || isGuid(v)) continue;
        const g = getGuidForPath(v);
        if (g) obj[field] = g;
      }
    }
  }

  // A template reference node's refs to the written root's own members, marked while the rows were planned (#1541).
  if (exits.markers.size) {
    const finish = (v: unknown): unknown => mapStringValues(v, (s) => {
      const m = exits.markers.get(s);
      return m ? tokens.nameAtRoot(m.guid, m.up) ?? m.guid : s;
    });
    for (const pe of prefabEntities) {
      for (const field of ['added', 'nestedStructure', 'members'] as const) {
        if (pe[field]) (pe as unknown as Record<string, unknown>)[field] = finish(pe[field]);
      }
    }
  }

  // A token may name a keyed node only if some file declares that key: this one, or a prefab it nests.
  const declared = declaredTemplateKeys({ entities: prefabEntities } as PrefabFile);
  for (const pe of prefabEntities) {
    pe.traits = tokens.undeclaredKeys(pe.traits, declared) as typeof pe.traits;
    for (const field of ['overrides', 'added', 'nestedOverrides', 'nestedStructure', 'members'] as const) {
      if (pe[field]) (pe as unknown as Record<string, unknown>)[field] = tokens.undeclaredKeys(pe[field], declared);
    }
  }

  const moved = templateMoves(selectedEntityId, tree, ecsToLocal, tokens.pathOf, rowParent);

  // I16 over the WHOLE document (#1817): `planPrefabRows` asks only of a self-rooted instance root, and an instance the
  // plan folds into a nested row (under one of its members, or under a node a layer added) is written as a reference
  // node in that row's `members[..].own` / `added`, where its check never looked. A prefab-edit save and Create Prefab's
  // Replace then wrote a file containing itself, which every later load overflowed the stack on.
  const cyclic = existingId ? expandedPrefabRefs(prefabEntities).find((ref) => wouldCreateCycle(existingId, ref)) : undefined;
  if (cyclic) {
    console.error(`[Prefab] refusing to save — nesting "${cyclic}" inside "${existingId}" creates a cycle`);
    return null;
  }

  const file: PrefabFile = {
    id: existingId ?? newGuid(),
    // The format version this serializer writes, unconditionally — see PREFAB_FORMAT_VERSION
    // for why this must not be derived from `nestedRefs` (#379).
    version: PREFAB_FORMAT_VERSION,
    name: opts?.name ?? tree[0].name,
    // The root's ASSIGNED id, not a hardcoded 1 — with a preserve map it keeps whatever the
    // file already used, and every `parentId: <root>` in the entity rows is remapped through
    // the same table, so the two can't disagree.
    rootLocalId: ecsToLocal.get(selectedEntityId) ?? 1,
    nextLocalId: 0, // stated just below, in this key position
    entities: prefabEntities,
    ...(moved ? { moved } : {}),
  };
  // The high-water mark (#1774): above every row written, and never below the document this write replaces or lands
  // over — prefab-edit's session floor, a Replace's document, a rebuild's prior file. `commitPrefabWrites` holds the same
  // line against the file on disk; stating it here keeps the bytes a caller records before the commit the bytes written.
  advanceLocalIdCounter(file, opts?.replacing, opts?.preserveLocalIds && opts.localIdFloor ? opts.localIdFloor + 1 : 0);
  assertNoRuntimeGuids(file, 'a serialized prefab');
  opts?.onRows?.(ecsToLocal);
  writtenRows.set(file.entities, new Map(flatTree.filter((e) => e.guid).map((e) => [e.guid!, ecsToLocal.get(e.id)!])));
  return file;
}

/** The localIds a Replace writes (#1759, owner option 1, Unity's fileIDs): a row the write carries identity for (its
 *  live `nodeGuid`, else U22's unique name — `nodeGuidsFor`) keeps the localId that node had in the document being
 *  replaced; the selection root keeps the old root's; every other row is numbered ABOVE the old document's highest
 *  localId, never into a number the old document used.
 *
 *  Positional numbering (`planPrefabRows`) handed a surviving member's number to whichever node landed in its slot. The
 *  derived member guid is a hash of the localId path, so that node took the survivor's guid; `dropCollidingPins` then
 *  made the survivor's pin yield, and every cross-instance ref shifted one member along — and the next save persisted it.
 *
 *  Null (keep the positional plan) when the old document carries no identity at all: a pre-v5 document's numbers are
 *  the only identity it has, and a Replace of the same tree numbers it exactly as it was. */
function replaceNumbering(
  flatTree: readonly EntityInfo[],
  selectedEntityId: number,
  carried: ReadonlyMap<number, string>,
  replacing: ReplacedRows,
): Map<number, number> | null {
  const rows = replacing.entities ?? [];
  const oldLocal = new Map<string, number>();
  for (const r of rows) if (r.nodeGuid && isGuid(r.nodeGuid) && r.localId) oldLocal.set(r.nodeGuid, r.localId);
  if (!oldLocal.size) return null;
  const rootLid = replacing.rootLocalId ?? 1;
  // Above the replaced document's high-water mark, not just its rows: a number an EARLIER write freed at the top is
  // below the mark and above every row (#1774).
  let next = Math.max(rootLid, localIdCounter(replacing) - 1);
  const out = new Map<number, number>([[selectedEntityId, rootLid]]);
  const used = new Set<number>([rootLid]);
  for (const e of flatTree) {
    if (out.has(e.id)) continue;
    const g = carried.get(e.id);
    const lid = g ? oldLocal.get(g) : undefined;
    if (lid && !used.has(lid)) { out.set(e.id, lid); used.add(lid); }
  }
  for (const e of flatTree) if (!out.has(e.id)) out.set(e.id, ++next);
  return out;
}

/** The plan each serialized file was written from, by the live entity's durable guid (#1759): which entity went to
 *  which localId. `tagEntityTreeAsInstance` reads its numbering from the FILE — the plan's record, and the only one a
 *  Replace's kept numbering can be read back from — and checks with this that the entity at each position is still the
 *  one written there. By guid, not ecs id: Create Prefab's redo re-tags after an undo that may have reloaded the world.
 *  Keyed by the ROWS array, not the file object: Create Prefab tags a `{ ...draft, id }` copy, which shares it (close-out
 *  review F1 — keyed by the object, the check never ran on the human path). */
const writtenRows = new WeakMap<ReadonlyArray<PrefabEntity>, ReadonlyMap<string, number>>();

/** Each written row's row parent: its live parent when that is a row (the ordinary case, a re-parent in the
 *  editor included). A row whose live parent is NOT one — it sits under a member of a nested instance, where
 *  a prefab's own move put it (#1437) — keeps the row it derives from: its template parent when it is linked
 *  (`identityParents.ts`), else the prefab-edit `hints` (localId → parent localId), else its nearest row
 *  ancestor. */
function rowParentsFor(
  rootEcsId: number, flatTree: EntityInfo[], all: EntityInfo[], ecsToLocal: Map<number, number>, hints?: Map<number, number>,
  /** The rows that are nested instances: never a row parent to fall back on — a row hung under one would share
   *  a path with that prefab's own row of the same localId. */
  nestedRows: ReadonlySet<number> = new Set(),
): Map<number, number> {
  const byId = new Map(all.map((e) => [e.id, e]));
  const identityOf = worldIdentityParents(getCurrentWorld());
  const ecsOfLocal = new Map([...ecsToLocal].map(([ecs, lid]) => [lid, ecs]));
  const out = new Map<number, number>();
  for (const e of flatTree) {
    if (e.id === rootEcsId || ecsToLocal.has(e.parentId)) { out.set(e.id, e.parentId); continue; }
    const identity = identityOf.parentOf(e.id);
    // Never a row inside its own live subtree now: that would write a parent cycle (identity parent or hint).
    const underSelf = (id: number | undefined): boolean => {
      for (let a = id, n = 0; a && n < 10_000; a = byId.get(a)?.parentId, n++) if (a === e.id) return true;
      return false;
    };
    let hinted = hints ? ecsOfLocal.get(hints.get(ecsToLocal.get(e.id)!) ?? -1) : undefined;
    if (underSelf(hinted)) hinted = undefined;
    let up = e.parentId;
    for (let n = 0; up && !(ecsToLocal.has(up) && !nestedRows.has(up)) && n < 10_000; n++) up = byId.get(up)?.parentId ?? 0;
    out.set(e.id, ecsToLocal.has(identity) && !underSelf(identity) ? identity : hinted ?? (up || rootEcsId));
  }
  // Choices made row by row can still close a loop across several rows (a moved row's template parent now under another
  // moved row). Any row on a loop falls back to its nearest live row ancestor; the live tree has none, so
  // repeating until nothing loops ends.
  const liveRowAncestor = (id: number): number => {
    let up = byId.get(id)?.parentId ?? 0;
    for (let n = 0; up && !(ecsToLocal.has(up) && !nestedRows.has(up)) && n < 10_000; n++) up = byId.get(up)?.parentId ?? 0;
    return up || rootEcsId;
  };
  for (let changed = true, pass = 0; changed && pass < 1_000; pass++) {
    changed = false;
    for (const e of flatTree) {
      if (e.id === rootEcsId) continue;
      const seen = new Set<number>([e.id]);
      for (let p = out.get(e.id); p !== undefined && p !== rootEcsId; p = out.get(p)) {
        if (seen.has(p)) {
          if (p === e.id && out.get(e.id) !== liveRowAncestor(e.id)) { out.set(e.id, liveRowAncestor(e.id)); changed = true; }
          break;
        }
        seen.add(p);
      }
    }
  }
  return out;
}

// ── Rigged re-import merge (P7b-2b) ──────────────────────

/** Stable identity of a prefab entity for the rigged re-import merge. The skeleton
 *  (model root / mesh nodes / bones) is regenerated from the GLB on every import;
 *  matching by a STABLE identity instead of positional localId lets the merge keep a
 *  bone's localId across re-imports, so a user-added child's `parentId` stays valid.
 *  Returns null for a user-added entity (no skeleton identity → preserved wholesale). */
function riggedEntityIdentity(pe: PrefabEntity, rootLocalId: number): string | null {
  if (pe.localId === rootLocalId) return 'root';
  const smr = pe.traits['SkinnedMeshRenderer'];
  if (smr && typeof smr === 'object') return `mesh:${(smr as Record<string, unknown>).node ?? ''}`;
  const bone = pe.traits['Bone'];
  if (bone && typeof bone === 'object') return `bone:${(bone as Record<string, unknown>).name ?? ''}`;
  return null;
}

/** Remap an entity's `EntityAttributes.parentId` through a localId remap (clones the
 *  EntityAttributes object so the source isn't mutated). */
function remapPrefabParent(
  traits: Record<string, Record<string, unknown> | boolean>,
  remap: Map<number, number>,
): Record<string, Record<string, unknown> | boolean> {
  const ea = traits['EntityAttributes'];
  if (ea && typeof ea === 'object') {
    const p = (ea as Record<string, unknown>).parentId;
    if (typeof p === 'number' && p !== 0 && remap.has(p)) {
      traits['EntityAttributes'] = { ...(ea as Record<string, unknown>), parentId: remap.get(p)! };
    }
  }
  return traits;
}

/** Merge a freshly-imported rigged prefab with the user's existing on-disk prefab
 *  (P7b-2b). The skeleton — root, mesh nodes, bones, their bind-pose transforms, and
 *  the import-emitted traits — comes from `fresh` (a re-import refreshes the rig from
 *  source). Everything the USER added survives: extra entities (a sword hung on a
 *  bone, an Animator child) AND extra traits on a skeleton entity (a BoneAttachment,
 *  an Animator). Bones are matched by NAME, so a bone keeps its localId across
 *  re-imports and a child's `parentId` stays pointed at it. A user child whose parent
 *  bone/mesh was REMOVED from the rig is re-anchored to the model root.
 *
 *  Policy (intentional, documented): for a matched skeleton entity, `fresh` traits
 *  win (re-import is authoritative over the rig); only traits the import doesn't emit
 *  are carried over from `existing`. User-added ENTITIES are preserved verbatim. */
export function mergeRiggedPrefab(fresh: PrefabFile, existing: PrefabFile): PrefabFile {
  const existingByIdentity = new Map<string, PrefabEntity>();
  for (const pe of existing.entities) {
    const idy = riggedEntityIdentity(pe, existing.rootLocalId);
    if (idy) existingByIdentity.set(idy, pe);
  }
  const userEntities = existing.entities.filter(
    (pe) => riggedEntityIdentity(pe, existing.rootLocalId) === null,
  );

  // Allocator for brand-new fresh skeleton entities (a bone added to the rig) — above
  // every id used by either side so it can't collide with a preserved localId, and above the existing document's
  // high-water mark, so a bone an EARLIER re-import dropped never lends its number to a new one (#1774).
  let nextId = localIdCounter(existing);
  for (const pe of fresh.entities) nextId = Math.max(nextId, pe.localId + 1);

  // fresh localId → merged localId (matched skeleton → existing id; new → allocation).
  const freshRemap = new Map<number, number>();
  for (const pe of fresh.entities) {
    const idy = riggedEntityIdentity(pe, fresh.rootLocalId);
    const match = idy ? existingByIdentity.get(idy) : undefined;
    freshRemap.set(pe.localId, match ? match.localId : nextId++);
  }

  const mergedSkeleton: PrefabEntity[] = fresh.entities.map((pe) => {
    const traits = remapPrefabParent({ ...pe.traits }, freshRemap);
    const idy = riggedEntityIdentity(pe, fresh.rootLocalId);
    const match = idy ? existingByIdentity.get(idy) : undefined;
    if (match) {
      // Preserve user-added traits the import doesn't emit (Animator, BoneAttachment…).
      for (const [tname, tdata] of Object.entries(match.traits)) {
        // ⚠️ `hasDocKey`/`putOwn` (#986). `tname` is a trait name from the EXISTING prefab JSON and
        // `traits` is a spread of the fresh one, so a trait named after an Object.prototype member
        // read as already-present and the user's preserved trait was DROPPED on re-import — a
        // silent data loss, which is what this loop exists to prevent.
        if (!hasDocKey(traits, tname)) putOwn(traits, tname, tdata);
      }
    }
    // The matched row keeps the EXISTING document's node identity (#1468 design record: the node guid, part 2). A minted id
    // cannot survive a document regenerated from a GLB that has never heard of it, so the merge's
    // content match — `riggedEntityIdentity`, already here for `localId` — is what carries it. A rig
    // node the re-import ADDED keeps the guid `serializePrefab` just minted for it.
    // ⚠️ This does not survive a DCC rename, and nothing can: a rename destroys the only
    // correspondence the GLB offers. The bounded outcome is one orphaned row, not a re-pointed one.
    return { ...pe, localId: freshRemap.get(pe.localId)!, ...(match?.nodeGuid ? { nodeGuid: match.nodeGuid } : {}), traits };
  });

  // Valid parent localIds after merge (skeleton + preserved user entities).
  const validParents = new Set<number>(mergedSkeleton.map((e) => e.localId));
  for (const pe of userEntities) validParents.add(pe.localId);

  const mergedUser: PrefabEntity[] = userEntities.map((pe) => {
    const ea = pe.traits['EntityAttributes'];
    if (ea && typeof ea === 'object') {
      const parentId = (ea as Record<string, unknown>).parentId as number | undefined;
      if (parentId !== undefined && parentId !== 0 && !validParents.has(parentId)) {
        // Parent (a bone/mesh node) removed by the re-import → re-anchor to root.
        return { ...pe, traits: { ...pe.traits, EntityAttributes: { ...(ea as Record<string, unknown>), parentId: fresh.rootLocalId } } };
      }
    }
    return pe;
  });

  // Everything this build owns, named ONCE so the carry-through below cannot disagree with it.
  // ⚠️ `satisfies`, not a bare `Record<string, unknown>` (close-out review F8). This used to be a
  // five-field object literal checked against `PrefabFile`; widening it to a bare record to feed
  // `Object.keys` silently gave up that check, so a renamed or dropped field would compile.
  const known = {
    id: fresh.id ?? existing.id,
    // The merge output is written by THIS serializer, so it carries this serializer's version
    // rather than the older of the two inputs' (#379) — but never DOWNGRADES. `existing` is
    // whatever is on disk, which the `1 | 2 | 3` type does not actually constrain: re-importing
    // a rigged model over a file from an OLDER serializer would otherwise stamp it with that
    // older number and invite a later migration to re-migrate a document already at the newer
    // shape.
    // v3 arrived in #762/#762-follow-up (UIAnchor.zIndex removed, folded into UIElement.zIndex)
    // and it is safe to preserve-the-higher-number here: v3 only DROPS a trait field, it does
    // not change the entity shape (see the v1/v2/v3 note on PREFAB_FORMAT_VERSION above), and
    // every load path (getPrefabSource/fetchPrefab, the placement's readPrefabFile) runs
    // migrateUIAnchorZIndexStructured unconditionally on every entity regardless of the stamped
    // version. So a v2-labelled-as-v3 merge here is never actually read as v2 semantics — the
    // migration re-applies (idempotently) the next time anything loads it. A hypothetical v4
    // that changes SHAPE (not just drops a field) would not get this same free pass and would
    // need its own decision here.
    // `preservedVersion()` (runtime/core/formatVersion.ts) is the shared form of this exact
    // rule, but routing prefab through it needs a verdict computed first — that's #784 phase
    // C3, not this change.
    version: Math.max(PREFAB_FORMAT_VERSION, existing.version),
    name: fresh.name,
    rootLocalId: fresh.rootLocalId,
    // Computed here, so the existing document's mark is not carried through as an unknown field (#1774).
    nextLocalId: 0,
    entities: [...mergedSkeleton, ...mergedUser],
  } satisfies Partial<PrefabFile> & Record<string, unknown>;
  advanceLocalIdCounter(known, existing, nextId);
  // Every OTHER top-level field of the on-disk document rides through untouched (#1468). Until this
  // change the return above WAS the whole function — a five-field object literal — so a rigged
  // re-import discarded every field it did not itself compute. `moved` is one of them, and `moved`
  // is what v4 ADDED, so this was live data loss at the version the repo already ships. The comment
  // above anticipated the shape — "a hypothetical v4 that changes SHAPE would not get this same free
  // pass" — without noticing that v4 was already that version.
  //
  // ⚠️ The carried list is DERIVED from what was just written, not transcribed. A hand-kept list of
  // "fields we know" is a claim that goes wrong in both directions: it drops a field added above it
  // and it silently claims one that was removed. `Object.keys` cannot disagree with the literal.
  //
  // ⚠️ This is `collectUnknownFields` read as "fields this WRITER does not compute", one notch wider
  // than its own docblock's "fields this BUILD does not know". Sound here, and the reason is the
  // version rule that docblock asks for: the output is stamped `max(CURRENT, existing.version)`, so
  // every field carried out of `existing` is claimed at a version at least as high as the one that
  // wrote it. Nothing is conditional on a version the output does not claim.
  //
  // Carrying `moved` VERBATIM is correct, not merely convenient: its keys and tokens are member
  // paths in this prefab's own frame, and the merge hands a *new* localId only to a skeleton entity
  // the re-import ADDED (`nextId++`, above every id either side uses). A matched entity keeps the
  // EXISTING id and a user entity is untouched, so no id an existing entry can name is reassigned to
  // a different node. An entry naming a bone the re-import DELETED is deliberately left in place:
  // `drainAfterDerive` already tolerates it ("nothing to move", plus a warn for a target that names
  // no member), which is louder and more accurate than dropping it here where nothing would report.
  //
  // `fresh` contributes nothing — it is this importer's own output, from a GLB tree with no nested
  // instances, so it has neither unknown fields nor a `moved` map.
  return mergeUnknownFields(known, collectUnknownFields(existing, Object.keys(known))) as unknown as PrefabFile;
}

/** The rows a Replace matches identity against (#1686): each row's name, `nodeGuid` and nested `prefab`, and the
 *  numbering a matched row keeps (#1759: its `localId`, and the document's `rootLocalId`). */
type ReplacedRow = { name?: string; nodeGuid?: string; prefab?: string; localId?: number; traits?: { EntityAttributes?: { parentId?: number } } };

export type ReplacedRows = {
  entities?: ReadonlyArray<ReplacedRow>;
  rootLocalId?: number;
  /** The replaced document's high-water mark (#1774): a new row is numbered above it. */
  nextLocalId?: number;
  /** How a node with no live identity is matched to a row: by its NAME (a Replace, Unity's U22) or by its hierarchy PATH
   *  (a rebuild of a fresh tree — Import Model, the skin-rig update — as Unity's model importer does, #1782). */
  match?: 'name' | 'path';
};

/** {@link ReplacedRows} from a replaced prefab's raw bytes — undefined for bytes that are not a prefab document. Read
 *  raw, unmigrated: a document too old to carry `nodeGuid` has nothing to carry anyway. */
export function parsedPrefabRows(text: string | null): ReplacedRows | undefined {
  if (!text) return undefined;
  try {
    const doc = JSON.parse(text) as { entities?: unknown; rootLocalId?: unknown; nextLocalId?: unknown };
    if (!Array.isArray(doc?.entities)) return undefined;
    return {
      entities: doc.entities as ReplacedRows['entities'],
      ...(typeof doc.rootLocalId === 'number' ? { rootLocalId: doc.rootLocalId } : {}),
      ...(typeof doc.nextLocalId === 'number' ? { nextLocalId: doc.nextLocalId } : {}),
    };
  } catch { return undefined; }
}

/** A REBUILD of an existing prefab from a freshly spawned tree — Import Model over an existing prefab, the 2D skin-rig update
 *  in place (#1782) — serialized as a Replace of the bytes the writer read (`previousContent`): a node whose hierarchy
 *  PATH matches one row keeps that row's `localId` and `nodeGuid` (#1759 option 1: Unity's model importer keeps identity
 *  across a reimport by path), and a new node is numbered above the old document's high-water mark (#1774). Both used to
 *  number rows 1..n with fresh nodeGuids, so each new row derived the member guid the old row at its POSITION had, and a
 *  scene's ref to an old member retargeted onto whatever node now sat at that number. A pre-v5 document (no nodeGuids)
 *  keeps the positional plan (`replaceNumbering`); no document at all (a first import) is an ordinary create. */
export function serializeRebuildOver(rootId: number, existingId: string | undefined, previousContent: string | null | undefined): PrefabFile | null {
  const rows = parsedPrefabRows(previousContent ? previousContent.replace(/^\uFEFF/, '') : null);
  return serializePrefab(rootId, existingId, rows ? { replacing: { ...rows, match: 'path' } } : {});
}

const PREFAB_REF_FIELDS: Record<string, string[]> = {
  Renderable3D: ['mesh', 'material'],
  Renderable3DPrimitive: ['material'],
  Renderable2D: ['sprite'],
  UIElement: ['imageSrc'],
  ModelSource: ['glbPath'],
  PrefabInstance: ['source'],
  Environment: ['hdrPath'],
  ParticleEmitter: ['effect'],
};
