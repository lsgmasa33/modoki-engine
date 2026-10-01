/** Capturing a live instance as template-relative data: structure, nested channels, the reference node, template rows,
 *  and subtracting what the enclosing chain already states.
 *  Moved out of `prefab.ts` by the prefab.ts split (#1656 § Plan, step 5): a pure move. */

import { rowAt } from '../../runtime/core/prefabRowAt';
import { getOverrideMarkSet } from '../../runtime/loaders/overrideMarks';
import { expandsToRoot } from '../../runtime/loaders/prefabRoot';
import { placedAnchor, translateLocalIds, translateCarried } from '../../runtime/loaders/memberTranslation';
import { getCurrentWorld, findEntityByGuid } from '../../runtime/core/ecs/world';
import { worldIdentityParents, frameRootDoc } from '../../runtime/core/ecs/identityParents';
import { memberRowKeysIn, memberRowsToWrite, rowWritingRoot } from '../../runtime/core/ecs/memberRows';
import { isPrefabEditRowGuid, PREFAB_EDIT_ROOT_GUID } from './prefabEditGuids';
import { diffFrameAdded, type FrameAddedDiff, type NodeDiffDeps } from './nodeRowDiff';
import { getAllTraits, getTraitByName, type TraitMeta } from '../../runtime/core/ecs/traitRegistry';
import { getAllEntities, readTraitData, findEntity, type EntityInfo } from '../../runtime/core/ecs/entityUtils';
import { filterAuthoringVisible } from './authoringScope';
import { collectSubtreeIds } from '../../runtime/core/ecs/subtreeCollect';
import { newGuid, isGuid } from '../../runtime/loaders/assetManifest';
import { durableGuid, nodeRowComponent, isMemberDerivation, memberPathSteps, isStoredRoot, appliedMoves, keyedMoves } from '../../runtime/core/assetRefRules';
import { templateKeyOf, setTemplateKey } from '../../runtime/core/templateIdentity';
import { templateKeysOf } from '../../runtime/loaders/templateKeyRecovery';
import { frameRespell } from '../../runtime/loaders/frameRespell';
import { writtenTraitKeys } from './traitDefault';
import type { AddedEntity, NestedOverridePaths, NestedStructurePaths, InstanceStructureData, SceneMemberRow } from '../../runtime/loaders/loadSceneFile';
import { asAddedNode, nodePlacement } from '../../runtime/loaders/unresolvedPrefabRefs';
import { unresolvedRefOf } from '../../runtime/core/unresolvedPrefabRef';
import { keptUnusedRows, keptMemberOrphans, keptLegacyChannels, mergeOverrideMaps, nestedPathKey, memberPathIndex, nodeChannels, mapNodeChannels } from '../../runtime/loaders/loadSceneFile';
import { type OverrideMap, foldStructureLayers } from '../../runtime/loaders/prefabOverrides';
import { nodeForward, chainLayer, layerAddedTraits, levelDoc, captureDoc, withKeptLegacy, withKeptLocalRecords, withKeptUnused, frameBase, type ForwardState, type LayerStructure } from './prefabBase';
import { parseMemberToken, memberToken, memberPathKey, memberPathLookup, type MemberStep } from '../../runtime/core/templateRefs';
import { childrenBySibling, localToEcsGuid, type PrefabFile } from './prefab';
import { getCachedPrefabSync, recoverTemplateKey } from './prefabCache';
import {
  bakingKeptState, baseTokenResolver, templateStatementOf, templateTokenizer, tokenizeRowMembers,
} from './prefabTokens';
import { captureInstanceOverrides, withOverridesFolded } from './prefabInstanceOverrides';
import {
  captureInstanceMembers, foreignRow, frameMovesOf, instanceRowDomain, liveRowLocalIds, memberRowParents,
  rowParentDomain, unexpandedRowsOf,
} from './prefabMembers';

/** One nested-instance row `planPrefabRows` decided on: the reference capture plus the row's own
 *  nested channels (#1381). */
export interface PlannedNestedRow {
  ref: InstanceReference;
  /** The baseline each `nestedStructure` path is compared against once tokenized (#1352). */
  structureBaselines: Map<string, InstanceStructureData>;
  childPrefab: PrefabFile;
  nestedOverrides?: NestedOverridePaths;
  /** The frames `members` cannot state member by member, whole — each compared once tokenized. */
  nestedStructure?: NestedStructurePaths;
  /** The row's member rows (prefab v6, #1533), in template form but not yet tokenized. */
  members?: Record<string, SceneMemberRow>;
  /** Path key → the live nested root it addresses, from the capture — what places a row in its frame. */
  frames: ReadonlyMap<string, { root: number; path: number[] }>;
  /** Row key → the live frame root of a row reaching into a template reference node (#1914 R3b), which `frames` cannot
   *  place. */
  rowFrames?: ReadonlyMap<string, number>;
}

/** A prefab ROW's nested channels, read from the live instance it will re-expand (`rootEcs`, of prefab `source`):
 *  each nested frame's structure split per member and per node onto `members` where it can be (#1533), whole in
 *  `nestedStructure` where it cannot, plus the kept orphan rows (R2) going back out. The ONE writer of a row's
 *  channels, shared by a prefab-edit save / Create Prefab (`planPrefabRows`) and Apply's promotion of a reference
 *  node — the second writer that still restated the whole frame, and so pinned it, after the first was fixed.
 *
 *  `deferCompare` hands the slot's no-op compare to the caller (`baselinesOut`), for a writer that tokenizes first.
 *  `readOnly`: a comparison's capture — keys are read, never minted (`StructureCaptureOpts.readOnly`). */
export function captureRowChannels(rootEcs: number, source: string, childPrefab: PrefabFile, ref: InstanceReference, deferCompare: boolean, readOnly = false) {
  const structureBaselines = new Map<string, InstanceStructureData>();
  const channels = captureNestedChannels(rootEcs, source, ref.ownedNested, { omitUnchanged: true, template: true, readOnly, ...(deferCompare ? { baselinesOut: structureBaselines } : {}) });
  const rowed = moveChannelsOntoRows(rootEcs, childPrefab, source, { nestedStructure: channels.nestedStructure }, {}, channels.frames, { template: true });
  // R2 for this carrier: a row the load found no template node for was KEPT (`applyStoredMemberRows`, under the root's
  // guid) and goes back out, as the scene writer puts its own back (`captureInstanceMembers`) — dropped, an inner
  // template that restores the node would not get the edit back.
  // ⚠️ ONLY where the kept rows were read from this very TEMPLATE (`keepsTemplateRows`). Under a scene root (Create
  // Prefab over a scene instance, Apply's promotion of a reference node) they are SCENE rows — member guids, scene-guid
  // nodes — and written into a template they would give every instance one guid (#1293, close-out re-review).
  const eaMeta = getTraitByName('EntityAttributes');
  const rootGuid = eaMeta ? durableGuid((readTraitData(rootEcs, eaMeta) as { guid?: string } | null)?.guid) : '';
  const members: Record<string, SceneMemberRow> = { ...rowed.members };
  // …and a Create Prefab's BAKE (#1790, owner ruling D): the tree it swallows is a scene's, and what R2 kept for its roots
  // is Unity's "unused overrides", which travel with the instance into the new asset. `templateRowOf` takes the scene
  // identity out, so #1293 holds; the identity stays in the scene (`settleSwallowedKeptState`).
  const ownRows = keepsTemplateRows(rootEcs, rootGuid) || bakingKeptState;
  const kept = ownRows ? keptMemberOrphans(rootGuid) ?? {} : {};
  for (const [key, row] of Object.entries(kept)) {
    if (members[key]) continue;
    const t = templateRowOf(row);
    if (t) members[key] = t;
  }
  // …and the unused part of each live member's row (#1914 R4): an override or removal the member's template does not take.
  // Statements only, no identity, so a bake carries it as it is.
  if (ownRows) Object.assign(members, withKeptUnused(members, rootGuid, rootEcs));
  // …and its LEGACY path-keyed channels no live frame reaches (#1738 member 3, #1780): a pre-v5 template's row states a
  // nested frame's edits there, with no `nodeGuid` for a member row to carry them. Under the same guard, for the same
  // reason: under a scene root they are the scene's.
  const ownLegacy = { nestedOverrides: channels.nestedOverrides, nestedStructure: rowed.channels.nestedStructure };
  // A BAKE's legacy channels are the scene's: their structure goes through the template converter as the rows go through
  // `templateRowOf` — a node's guid out, a `moved` (a scene guid by value) dropped — or every instance stamps one guid
  // (#1293; #1790 close-out review F4).
  const baked = bakingKeptState && !keepsTemplateRows(rootEcs, rootGuid) ? keptLegacyChannels(rootGuid) : undefined;
  const legacy = baked
    ? {
      nestedOverrides: baked.nestedOverrides ? { ...baked.nestedOverrides, ...ownLegacy.nestedOverrides } : ownLegacy.nestedOverrides,
      nestedStructure: baked.nestedStructure ? { ...toTemplateStructure(baked.nestedStructure), ...ownLegacy.nestedStructure } : ownLegacy.nestedStructure,
    }
    : withKeptLegacy(ownLegacy, ownRows ? rootGuid : '');
  return {
    channels: { ...channels, nestedOverrides: legacy.nestedOverrides }, structureBaselines,
    nestedStructure: legacy.nestedStructure,
    members: Object.keys(members).length ? members : undefined,
    ...(rowed.rowFrames ? { rowFrames: rowed.rowFrames } : {}),
  };
}

/** A kept row as a TEMPLATE writes it: no member identity (`guid`, `name`), no scene move (`parent`), and each SCENE
 *  node in it (one carrying a guid) as a template node; undefined when nothing is left. Two sources fill the store: the
 *  load keeps a template's own rows, already in this form, and a Refresh's settle keeps what a SCENE save would write
 *  (`savedMemberRows`), which has to stay in that form for the settle's own live replay to put each member's guid
 *  back. So the conversion is here, at the re-emit, and touches only the scene parts: a template node passes through
 *  whole, its own `members` included. Re-emitted unconverted, a member a Refresh dropped came back out of the next
 *  prefab-edit save carrying its edit-world guid (#1293; found by the #1541/#1542 close-out review, older than both).
 *  A scene node needs its `key` already (`keySceneNodes`, read while it was live), or `toTemplateNodes` mints a new one
 *  on every save. A scene reference node keeps its own rows, each converted the same way. */
function templateRowOf(row: SceneMemberRow): SceneMemberRow | undefined {
  const { guid: _guid, name: _name, parent: _parent, ...rest } = row;
  const out: SceneMemberRow = { ...rest };
  // A node is a scene node when anything in its subtree holds a guid: a node whose own guid is a runtime one is
  // written `guid: ''` by the scene capture, and its durable child would otherwise pass through (close-out re-review).
  const holdsGuid = (n: AddedEntity): boolean => !!n.guid || [...(n.children ?? []), ...(n.added ?? [])].some(holdsGuid);
  const node = (n: AddedEntity): AddedEntity => {
    if (!holdsGuid(n)) return n;
    const t = toTemplateNodes([n])![0]!;
    // A scene REFERENCE node's own rows are keyed as a template's are (member identity paths); only their identity goes.
    const rows = n.prefab && n.members ? templateRowsOf(n.members) : undefined;
    return rows ? { ...t, members: rows } : t;
  };
  if (rest.own) out.own = rest.own.map(node);
  if (rest.added) out.added = rest.added.map(node);
  return Object.keys(out).length ? out : undefined;
}

/** {@link templateRowOf} over a row set, leaving out the rows nothing is left of. */
function templateRowsOf(rows: Record<string, SceneMemberRow>): Record<string, SceneMemberRow> | undefined {
  const out: Record<string, SceneMemberRow> = {};
  for (const [k, r] of Object.entries(rows)) { const t = templateRowOf(r); if (t) out[k] = t; }
  return Object.keys(out).length ? out : undefined;
}

/** Were the rows kept for the root `rootEcs` (guid `rootGuid`) read from the template being written? — the #1293 gate on
 *  R2's re-emit. Two carriers qualify, both only inside the prefab-edit world:
 *  - a prefab ROW (`isPrefabEditRow`): spawned as a scene entry under its row sentinel, whose rows the load read off
 *    that entry, or dropped in this session, whose rows only a Refresh's settle kept (#1568);
 *  - a TEMPLATE reference node that such a row's own statements declare (#1542): it stores no guid and derives one,
 *    and the load kept its rows under that (`keepTemplateNodeOrphans`). Its root carries a template key and sits
 *    below a row. A scene never holds one — a scene-form reference node stores a guid (#1438) — so the row ancestor
 *    is what separates the two. */
export function keepsTemplateRows(rootEcs: number, rootGuid: string): boolean {
  if (isPrefabEditRow(rootEcs, rootGuid)) return true;
  // The marker, or the key recovered from the root's derived guid: a rebuild respawns the node without its marker, and a
  // second Refresh before any save read it as no template node at all (#1541/#1542 close-out re-review).
  if (!rootGuid || !(templateKeyOf(findEntity(rootEcs)) || recoverTemplateKey(rootEcs))) return false;
  const eaMeta = getTraitByName('EntityAttributes');
  if (!eaMeta) return false;
  const seen = new Set<number>();
  for (let id = rootEcs; id && !seen.has(id);) {
    seen.add(id);
    const ea = readTraitData(id, eaMeta) as { guid?: string; parentId?: number } | null;
    if (id !== rootEcs && isPrefabEditRow(id, ea?.guid)) return true;
    id = ea?.parentId ?? 0;
  }
  return false;
}

/** Is `id` (guid `guid`) a ROW of the prefab being edited — one the prefab-edit save writes as a row of its own? A row
 *  the edit world was built with carries its sentinel guid. One the user dropped in during this session does not, until
 *  the prefab is saved and reopened, and read by its guid alone it kept no orphan rows for the rest of the session
 *  (#1568). So it is also recognised by where it sits, by the save's own row rule (`planPrefabRows`: an instance root
 *  that no enclosing instance consumed): a self-rooted instance root whose ancestors, up to the edit world's root, are
 *  all plain entities. Nothing in a scene sits under that root. */
function isPrefabEditRow(id: number, guid: string | undefined): boolean {
  if (isPrefabEditRowGuid(guid)) return true;
  const eaMeta = getTraitByName('EntityAttributes');
  const piMeta = getTraitByName('PrefabInstance');
  if (!eaMeta || !piMeta || (readTraitData(id, piMeta)?.rootInstanceId as number | undefined) !== id) return false;
  const seen = new Set<number>([id]);
  for (let p = (readTraitData(id, eaMeta) as { parentId?: number } | null)?.parentId ?? 0; p && !seen.has(p);) {
    seen.add(p);
    const ea = readTraitData(p, eaMeta) as { guid?: string; parentId?: number } | null;
    if (ea?.guid === PREFAB_EDIT_ROOT_GUID) return true;
    if (readTraitData(p, piMeta)) return false;
    p = ea?.parentId ?? 0;
  }
  return false;
}

/** The template write of a row's captured channels (`captureRowChannels` with `deferCompare`): every payload
 *  rewritten into member tokens in the frame it applies in (#1352) — the row's own in its live root's frame
 *  (`rowRoot`), a nested path's in the instance that path addresses — and THEN #1381's no-op rule, since a live
 *  bag holds guids where the file holds tokens and an earlier compare always differed. Shared by a prefab ROW
 *  (`serializePrefab`, over the written tree's tokenizer) and a template REFERENCE node (over its own frame's,
 *  `finishTemplateReferenceNode`), so the two carriers cannot disagree about what counts as unchanged (#1538). */
export function finishRowChannels(
  tokens: ReturnType<typeof templateTokenizer>,
  rowRoot: number,
  row: Pick<PlannedNestedRow, 'ref' | 'structureBaselines' | 'nestedOverrides' | 'nestedStructure' | 'members' | 'frames' | 'rowFrames'>,
) {
  const frameOf = (pathKey: string) => tokens.frameAt(rowRoot, pathKey) || rowRoot;
  let nestedStructure: NestedStructurePaths | undefined;
  for (const [k, delta] of Object.entries(row.nestedStructure ?? {})) {
    const t = { ...delta, added: tokens.added(delta.added, frameOf(k)) ?? [] };
    const baseline = row.structureBaselines.get(k);
    if (baseline && sameStructure(t, baseline)) continue; // #1381's no-op rule, over tokenized content
    (nestedStructure ??= {})[k] = t;
  }
  const nestedOverrides = row.nestedOverrides
    ? Object.fromEntries(Object.entries(row.nestedOverrides).map(([k, v]) => [k, tokens.value(v, frameOf(k))])) as NestedOverridePaths
    : undefined;
  const members = row.members ? tokenizeRowMembers(row.members, row.frames, rowRoot, frameOf, tokens, row.rowFrames) : undefined;
  return {
    overrides: tokens.value(row.ref.overrides, rowRoot) as typeof row.ref.overrides,
    added: tokens.added(row.ref.added, rowRoot),
    nestedOverrides, nestedStructure, members,
  };
}

/** The template keys a token written into a document may step through (#1352): the ones `written` declares itself, and
 *  every key of each prefab it nests (rows, reference nodes, at any depth), transitively, plus `sources` and what they
 *  nest. NOT every cached document: the OLD copy of the file being saved is cached while it saves (prefab-edit puts it
 *  there and replaces it only after the write), so a key the old file declared in a slot this write drops stayed
 *  "declared", and the token through it named nothing on reload (#1538 close-out re-review). */
export function declaredTemplateKeys(written: Parameters<typeof templateKeysOf>[0], sources: readonly string[] = []): Set<string> {
  const keys = new Set<string>(templateKeysOf(written));
  const seen = new Set<string>();
  const visitDoc = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const doc = getCachedPrefabSync(id);
    if (!doc) return;
    for (const k of templateKeysOf(doc)) keys.add(k);
    visit(doc.entities);
  };
  // A nested row (`localId`) or a reference node (`parentLocalId`) names a prefab; a trait's own `prefab` field does not.
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) { for (const x of v) visit(x); return; }
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    if (typeof o.prefab === 'string' && (typeof o.localId === 'number' || typeof o.parentLocalId === 'number')) visitDoc(o.prefab);
    for (const [k, x] of Object.entries(o)) if (k !== 'traits' && k !== 'overrides' && k !== 'nestedOverrides') visit(x);
  };
  visit(written.entities);
  for (const s of sources) visitDoc(s);
  return keys;
}

/** A TEMPLATE reference node (an `added` node carrying `prefab`, written into a prefab file) — the third carrier of a
 *  prefab's nested channels, written as the other two are (#1538). It used to keep the scene's rule — restate every
 *  non-empty frame whole, no member rows, payload untokenized — so an untouched save pinned the inner prefab's own
 *  statements into the outer file, and a member ref inside it kept the edit world's live guid, naming nothing in any
 *  instance. Now: the row writer (`captureRowChannels`: frames per member, omitted when unchanged), tokenized in the
 *  node's OWN frame (the loaders open a token scope at its top call), climbing out of it only for a ref no frame inside
 *  can name (#1541, `templateTokenizer`'s `ownFrame`), then the shared finish. Its kept orphan rows go back out inside the prefab-edit world (#1542), under the guid its root derives:
 *  the load keeps them there (`keepTemplateNodeOrphans`), and `keepsTemplateRows` gates the re-emit.
 *
 *  `readOnly` (a comparison, not a write): read each node's template key, never mint or stamp one. */
function finishTemplateReferenceNode(
  ecsId: number, source: string, childPrefab: PrefabFile, readOnly: boolean,
): { ref: InstanceReference; consumedEcsIds: Set<number>; chainName?: string; channels: Pick<AddedEntity, 'overrides' | 'added' | 'removed' | 'removedTraits' | 'moved' | 'templateMoved' | 'nestedOverrides' | 'nestedStructure' | 'members'> } {
  // The node's key before anything reads it: `keepsTemplateRows` and the climb out of the node (`templateFrameClimber`)
  // both ask it, and a Refresh respawns the node from a scene-form capture that carries none. The caller stamps it
  // anyway (`addedNodeIdentity`); after the capture was too late (#1541/#1542 close-out review).
  if (!readOnly) addedNodeIdentity(ecsId, true);
  const ref = captureInstanceReference(ecsId, source, childPrefab, { template: true, readOnly });
  const rc = captureRowChannels(ecsId, source, childPrefab, ref, true, readOnly);
  const tokens = templateTokenizer(ecsId, filterAuthoringVisible(getAllEntities()), new Map(), new Map(), true);
  const fin = finishRowChannels(tokens, ecsId, {
    ref, structureBaselines: rc.structureBaselines, nestedOverrides: rc.channels.nestedOverrides,
    nestedStructure: rc.nestedStructure, members: rc.members, frames: rc.channels.frames, rowFrames: rc.rowFrames,
  });
  // The node's own statement, when a template states it (#1804, #1781's writer twin): the capture above measured every frame
  // against the bare documents, so a component the statement adds came out whole with every schema default, and a no-edit
  // save rewrote the statement. Measured over the base the statement SEEDS instead — the subtraction the comparison uses.
  // A write only: a comparison's capture (`readOnly`) is asked against a chain node of its own (`sameAddedNode`).
  const chainNode = readOnly ? null : templateStatementOf(ecsId);
  if (chainNode) {
    const d = seededNodeDelta(ecsId, source, childPrefab, chainNode);
    fin.overrides = keepNodeStated(fin.overrides, d.root, d.rootLayer, chainLayer(ecsId, source, [], childPrefab).overrides) ?? {};
    if (fin.nestedOverrides) {
      const nested: NestedOverridePaths = {};
      for (const [key, map] of Object.entries(fin.nestedOverrides)) {
        const steps = memberPathSteps(key);
        // A nested path key is row localIds; one that is not is left as the capture wrote it.
        if (!steps.every((st): st is number => typeof st === 'number')) { nested[key] = map; continue; }
        const path = steps as number[];
        const kept = keepNodeStated(map, d.nested[key], chainLayer(ecsId, source, path, childPrefab, d.seed).overrides, chainLayer(ecsId, source, path, childPrefab).overrides);
        if (kept) nested[key] = kept;
      }
      fin.nestedOverrides = Object.keys(nested).length ? nested : undefined;
    }
  }
  // A token may name a keyed node only if some file declares that key (`serializePrefab`'s rule): what this node WRITES
  // — after the no-op drop, not the capture: a key minted for a node in a slot the drop omitted is declared nowhere,
  // and a token through it names nothing on reload (#1538 close-out review) — or the node's prefab and what it nests.
  const declared = declaredTemplateKeys({ entities: [{ added: fin.added, nestedStructure: fin.nestedStructure, members: fin.members }] }, [source]);
  const undeclared = <T,>(v: T): T => (v === undefined ? v : tokens.undeclaredKeys(v, declared) as T);
  // A move inside the node, in its own frame (#1543): the template capture records none (a move's value is a live
  // guid), its member rows carry no `parent` (#1293), and the legacy `moved` is localId-keyed. Named by the index the
  // loader resolves them through (`memberPathIndex`), so writer and reader cannot disagree about a path.
  const index = memberPathIndex(getCurrentWorld(), ecsId);
  const pathById = new Map<number, MemberStep[]>();
  for (const [key, e] of index) if (e) pathById.set(e.id(), memberPathSteps(key));
  const links = getAllEntities().map((e) => [e.id, e.parentId] as const);
  const inNode = new Set(collectSubtreeIds(links, [ecsId]));
  const subtree = filterAuthoringVisible(getAllEntities()).filter((e) => inNode.has(e.id));
  // …and the node's legacy KEYED moves, which no load applied and so no capture sees, put back as the statement held them
  // (#1883 ruling C).
  const captured = templateMoves(ecsId, subtree, new Map(), (id) => pathById.get(id), new Map(), true);
  // A comparison's capture (`readOnly`) reads the statement too, or it would never equal the chain node it is compared to.
  const keptKeyed = keyedMoves((chainNode ?? templateStatementOf(ecsId))?.templateMoved);
  const templateMoved = keptKeyed ? { ...keptKeyed, ...captured } : captured;
  return {
    ref,
    // A reference node's `name` is not applied on spawn (its root takes the child's root row name), so the live root's
    // name is not the node's: the statement's is kept (#1804), and a node no template states yet takes the live one.
    ...(chainNode?.name ? { chainName: chainNode.name } : {}),
    // What the node's expansion re-creates: the nested interiors' added subtrees AND every owned nested instance, at
    // any depth — the row writer's skip (#1382). Left out, `planPrefabRows` took MID's own INNER, inside a template
    // reference node, for a free-standing nested instance and wrote it again as a row at the prefab root (#1538
    // close-out re-review). The scene form needs no twin: the scene writer skips owned nested instances itself.
    consumedEcsIds: new Set([...rc.channels.consumedEcsIds, ...rc.channels.ownedMemberEcsIds]),
    channels: {
      overrides: undeclared(fin.overrides), added: undeclared(fin.added), removed: ref.removed, removedTraits: ref.removedTraits,
      moved: ref.moved, nestedOverrides: undeclared(fin.nestedOverrides), nestedStructure: undeclared(fin.nestedStructure),
      ...(fin.members ? { members: undeclared(fin.members) } : {}),
      ...(templateMoved ? { templateMoved } : {}),
    },
  };
}

/** The written prefab's own `moved` (#1437 P3-c): every member of a nested instance in the tree that sits
 *  under a parent other than the one the written prefab would give it WITHOUT this map — its row parent,
 *  or where one of its nested prefabs' own moves puts it (the outermost such prefab's). "Moved back" to its
 *  row included. Member and parent are named by path in the written frame (`pathOf`). A written ROW needs
 *  none: it is written under its live parent. `undefined` when there is nothing to write.
 *
 *  `nodeFrame`: the root is a template REFERENCE node's (`templateMoved`, #1543), whose frame is itself an instance —
 *  its own prefab's moves are a base like any nested one's, and only what the node itself states is left out. */
export function templateMoves(
  rootEcsId: number, tree: EntityInfo[], ecsToLocal: Map<number, number>, pathOf: (id: number) => MemberStep[] | undefined,
  rowParent: Map<number, number>, nodeFrame = false,
): Record<string, string> | undefined {
  const piMeta = getTraitByName('PrefabInstance');
  if (!piMeta) return undefined;
  const byId = new Map(tree.map((e) => [e.id, e]));
  const identity = worldIdentityParents(getCurrentWorld());
  const piOf = (id: number) => readTraitData(id, piMeta) as { rootInstanceId?: number; source?: string } | null;
  // The base each nested prefab's own moves give, the INNERMOST first so the outermost — which the loader
  // applies last — overwrites.
  const frames = tree
    .filter((e) => (nodeFrame || e.id !== rootEcsId) && piOf(e.id)?.rootInstanceId === e.id)
    .map((e) => {
      const doc = getCachedPrefabSync(piOf(e.id)!.source ?? '');
      // The frame being written states its own moves: never its own base.
      return { id: e.id, moved: e.id === rootEcsId ? appliedMoves(doc?.moved) : frameMovesOf(e.id, doc), depth: pathOf(e.id)?.length ?? Infinity };
    })
    .sort((a, b) => b.depth - a.depth);
  const base = new Map<number, number>();
  for (const f of frames) {
    if (!f.moved) continue;
    const index = memberPathIndex(getCurrentWorld(), f.id);
    const respell = frameRespell(getCurrentWorld(), f.id);
    for (const [key, token] of Object.entries(f.moved)) {
      const t = parseMemberToken(token);
      const member = memberPathLookup((k) => index.get(k), memberPathSteps(key), respell);
      const target = t && !t.up ? memberPathLookup((k) => index.get(k), t.path, respell) : null;
      if (member && target) base.set(member.id(), target.id());
    }
  }
  const out: Record<string, string> = {};
  // A written row whose live parent is no row: written under its row parent, and moved from there.
  for (const e of tree) {
    const row = rowParent.get(e.id);
    if (e.id === rootEcsId || row === undefined || row === e.parentId) continue;
    const member = pathOf(e.id);
    const parent = pathOf(e.parentId);
    if (member && parent) out[memberPathKey(member)] = memberToken(0, parent);
  }
  const candidates = new Set([...base.keys(), ...tree.filter((e) => identity.moved(e.id)).map((e) => e.id)]);
  for (const id of candidates) {
    const e = byId.get(id);
    if (!e || ecsToLocal.has(id)) continue;
    const at = base.get(id) ?? identity.parentOf(id);
    if (e.parentId === at) continue;
    const member = pathOf(id);
    const parent = pathOf(e.parentId);
    if (member && parent) out[memberPathKey(member)] = memberToken(0, parent);
  }
  return Object.keys(out).length ? out : undefined;
}

// ── Structural Overrides (added/removed entities, removed traits) ──────

/** Result of comparing an instance's live tree against its prefab. `added` and
 *  `removed`/`removedTraits` are the structural diffs; `consumedEcsIds` are the
 *  live ECS ids folded into `added` (serialize skips them, as it skips members). */
export interface InstanceStructure {
  added: AddedEntity[];
  removed: number[];
  removedTraits: Record<number, string[]>;
  /** Members moved to another parent inside the instance (#1437): row localId → live parent guid. */
  moved: Record<number, string>;
  /** The subset of {@link moved} NO member row will carry — a member of a pre-v5 template (no key),
   *  or a keyed one with no durable guid (`memberRowsToWrite`). What a writer puts in the legacy
   *  `moved` map (#1468 Phase 3 close-out): a row is the only other place a move can go, and every
   *  prefab the released editor wrote is pre-v5, so dropping these lost the move on reload. */
  unrowed?: Record<number, string>;
  consumedEcsIds: Set<number>;
  /** ecsId → the nested-prefab ROW localId it is the expansion of, for the nested instances
   *  directly under this instance's members. This is the AUTHORITATIVE owned/independent split
   *  (#1354): `serializeScene` must route by this rather than re-testing `PrefabInstance.
   *  parentLocalId` itself, or the two disagree and an instance is written by neither — see the
   *  ⚠️ note on the partition in `captureInstanceStructure`. */
  ownedNested: Map<number, number>;
  /** For a REBUILD only (#1437, owner's B): moves inside owned nested instances to drop from, or set on, what
   *  the rebuild captures of them — keyed `~moved.<chain>:<lid>` (`nestedFrameMoves`). A revert drops the
   *  ones it reverts; its undo sets them back. */
  nestedMoves?: { drop?: string[]; set?: Record<string, string> };
  /** In memory only, never written: the template key of each keyed node in `added`, by its guid (#1567). A scene-form
   *  node carries its guid alone, and a rebuild that respawns one it did NOT tear down (a Revert's undo brings back the
   *  node the Revert removed) has no live marker to read it from. */
  templateKeys?: Record<string, string>;
}

/** The ONE compaction an added node's trait bag goes through (#1381 close-out): schema-default fields
 *  dropped, a runtime guid dropped, the live `parentId` dropped (#1377). Shared by the live capture
 *  (`snapshotAddedTraits`) and by `sameStructure`, which runs a FILE-authored bag through it so a
 *  legacy full bag compares equal to the compacted capture of the entity it spawns. Idempotent. */
function compactAddedTraitData(meta: TraitMeta, data: Record<string, unknown>): Record<string, unknown> {
  const schema = (meta.trait as { schema?: Record<string, unknown> }).schema;
  const soa = !!schema && typeof schema === 'object';
  const copy: Record<string, unknown> = {};
  // `writtenTraitKeys` (traitDefault.ts) is the SAME rule serialize.ts writes a top-level entity
  // with, and the one the committed-scene guard checks (#1412). Sharing it also closed a real gap:
  // this loop claimed to mirror serialize.ts but never skipped `runtimeOnly` fields.
  for (const key of writtenTraitKeys(soa ? schema! : null, data, meta.fields)) {
    // Skip a field still holding its schema default — the rule serialize.ts applies to a
    // top-level entity, which `snapshotAddedTraits`' note has always CLAIMED this mirrors and did not.
    //
    // Safe because an added child has NO prefab base to diff against: it is a whole new entity,
    // and `spawnNode` (loadSceneFile.ts) rebuilds it with `meta.trait(d)`, so koota refills
    // every absent key from the same schema this compared against. Round-trip identical.
    //
    // NOT the same thing as a member OVERRIDE, and the distinction is load-bearing:
    // `captureInstanceOverrides` diffs against the PREFAB's value, so overriding a prefab's
    // non-default back to the schema default is still written. Nothing here touches that path.
    //
    // Safe through PROMOTION too (`insertAddedSubtree` folds an added child into the prefab as
    // a member): `getOverrideValues` already reads an absent base field as the schema default
    // — see its own ⚠️ note — because prefab files already omit fields. So a compacted child
    // promoted into a prefab does not make every instance report a spurious override.
    //
    // Two exclusions carried over verbatim from serialize.ts. AoS traits (function schema) have
    // no per-key schema to compare against and stay FULL — that is the fidelity case
    // `snapshotAddedTraits`' note exists for (AudioSource.clips, SkinnedMeshRenderer.materials,
    // AnimationLibrary.animSets; the bone-map-lost-on-save bug). And an `entityId` field is
    // never skipped: a default entity reference is a meaningful value, not an absence.
    copy[key] = data[key];
  }
  // A runtime guid (#1210) is not a durable address — capture it as unguided, exactly as a
  // guid-less entity was: never an `added[].guid`, a `+added.<guid>` key, OR the copied trait's
  // own `guid` (the loop above already copied it, and the loader keeps a non-empty one).
  if (meta.name === 'EntityAttributes') {
    if (!durableGuid(data.guid as string)) delete copy.guid;
    // A LIVE ecs id (#1377) — recycled across sessions, so persisting it is save churn and a
    // `parentId` that reads as authoritative to the next reader. Nothing reads it back: an added
    // node is anchored by `parentLocalId` / its place in `children`, and both consumers
    // (`spawnNode` in loadSceneFile.ts, promotion's `insertAddedSubtree`) overwrite it. Explicit
    // because it is an `entityId` field, which the compaction loop above never skips.
    delete copy.parentId;
  }
  return copy;
}

/** Snapshot every trait on a live entity (full schema fidelity, like serialize),
 *  excluding PrefabInstance. Returns the trait bag + the entity's stable guid. */
function snapshotAddedTraits(ecsId: number): { bag: Record<string, Record<string, unknown> | boolean>; guid: string } {
  const bag: Record<string, Record<string, unknown> | boolean> = {};
  let guid = '';
  const entity = findEntity(ecsId);
  if (!entity) return { bag, guid };
  for (const meta of getAllTraits()) {
    if (meta.name === 'PrefabInstance') continue;
    if (!entity.has(meta.trait)) continue;
    if (meta.category === 'tag') { bag[meta.name] = true; continue; }
    const data = entity.get(meta.trait) as Record<string, unknown>;
    // Mirror serialize.ts EXACTLY: prefer the koota schema keys, else fall back to
    // the LIVE DATA keys (not the curated meta.fields). AoS traits (callback form,
    // e.g. UIAction, AudioSource, SkinnedMeshRenderer) expose a *function* schema and
    // carry non-scalar fields absent from meta.fields (AudioSource.clips,
    // SkinnedMeshRenderer.materials, AnimationLibrary.animSets) — using meta.fields
    // here would silently drop them on a user-ADDED prefab child, breaking the
    // "survives a save" guarantee. data-key fallback keeps full fidelity.
    const copy = compactAddedTraitData(meta, data);
    if (meta.name === 'EntityAttributes') guid = durableGuid(data.guid as string);
    bag[meta.name] = copy;
  }
  return { bag, guid };
}

/** Which document a structural capture is written INTO. */
export interface StructureCaptureOpts {
  /** TEMPLATE form (#1387): the capture is written into a prefab file, so an added node carries its
   *  template `key` and `guid: ''` — never the live guid, which every instance of the prefab would
   *  then spawn with. Default (scene form): the live durable guid, as a scene-authored node carries. */
  template?: boolean;
  /** SCENE FILE form (#1468 Phase 4): a reference node's edits go onto its member rows (`moveChannelsOntoRows`). Set by
   *  the scene writer (and so by a rebuild, which loads what it writes, #1880 F6). Every other capture is read, and its
   *  readers take the localId channels — the comparisons against the chain's nodes (in rows a template reference node
   *  compared as edited) and Apply's promotion into a template. */
  rows?: boolean;
  /** With `template`: a COMPARISON's capture, not a write (#1538) — a node's key is read off its marker or recovered,
   *  never minted and never stamped onto the live entity. A key stamped on a scene-authored node would make the
   *  derive pass treat it as template-added. A node with no key to read gets `''`, which matches no chain node. */
  readOnly?: boolean;
  /** Per member localId, the traits the layers ENCLOSING the frame add to it (`layerAddedTraits`, #1676). A removal
   *  is measured against the document's row AND these: without them a component only an enclosing row added was never
   *  captured as removed, so the save, a Refresh and a prefab-edit save all brought it back. */
  layerTraits?: Record<number, string[]>;
  /** A caller's edit of chosen frames' statements, by frame root ecs id (#1880 F6): applied where the capture makes each
   *  frame's statement — a reference node's (`captureInstanceReference`), an owned nested frame's (`captureNestedChannels`).
   *  A rebuild of a scene entry to a state the live tree does not show (a Revert's reduced set, an Apply's subtraction) is
   *  then still stated by the save's one writer. Only the scene writer's rows form sets it. */
  frameEdits?: ReadonlyMap<number, FrameEdit>;
  /** Members (by ecs id) whose move a Revert takes back: the row a writer states for each carries no `parent`. */
  dropParents?: ReadonlySet<number>;
  /** A REBUILD's capture (#1880 F6e): a reference node is stated against the document it was expanded from (its frame
   *  record), as an owned frame always is (`levelDoc`), and its localId channels are translated into the cache's
   *  numbering — the numbering the load expands it in. The save's capture reads the cache first (`captureDoc`), so a
   *  stale node was stated against rows it was not built from: the old rebuild refused it, or rebuilt it first. */
  againstRecords?: boolean;
}

/** An edit of ONE frame's statement ({@link StructureCaptureOpts.frameEdits}): each a transform of what the capture read. */
export interface FrameEdit {
  overrides?: (captured: Record<number, Record<string, Record<string, unknown>>>) => Record<number, Record<string, Record<string, unknown>>>;
  structure?: (captured: InstanceStructure) => InstanceStructure;
}

/** `members` (the rows a writer states for `rootId`) without the `parent` of each member in `drop`. */
export function withoutRowParents(rootId: number, members: Record<string, SceneMemberRow>, drop: ReadonlySet<number> | undefined): Record<string, SceneMemberRow> {
  if (!drop?.size) return members;
  const out = { ...members };
  for (const [ecsId, key] of memberRowKeysIn(rootId)) {
    const row = out[key];
    if (!drop.has(ecsId) || !row?.parent) continue;
    const { parent: _taken, ...rest } = row;
    out[key] = rest;
  }
  return out;
}

/** An added node's identity in the document being written: the live durable guid (scene form), or
 *  the template key (template form). The key comes off the live marker; failing that it is RECOVERED
 *  from the node's derived guid (`recoverTemplateKey`); only a node that never came from a template
 *  gets a fresh one. Stamped either way, so the next template write of the same live entity writes the
 *  same key rather than churning it. */
function addedNodeIdentity(ecsId: number, template: boolean | undefined, readOnly = false): { guid: string; key?: string } {
  if (!template) {
    const eaMeta = getTraitByName('EntityAttributes');
    return { guid: eaMeta ? durableGuid(readTraitData(ecsId, eaMeta)?.guid as string) : '' }; // #1210
  }
  const entity = findEntity(ecsId);
  let key = templateKeyOf(entity);
  if (!key && readOnly) return { guid: '', key: recoverTemplateKey(ecsId) };
  if (!key) {
    key = recoverTemplateKey(ecsId) || newGuid();
    setTemplateKey(entity, key);
  }
  return { guid: '', key };
}

/** Compute the structural diff between a live prefab instance and its source:
 *  child entities the instance added, prefab members it deleted, and prefab
 *  components it removed from surviving members. (Added components are already
 *  captured as added-trait overrides by captureInstanceOverrides.) */
export function captureInstanceStructure(rootInstanceId: number, prefab: PrefabFile, opts: StructureCaptureOpts = {}): InstanceStructure {
  const empty: InstanceStructure = { added: [], removed: [], removedTraits: {}, moved: {}, consumedEcsIds: new Set(), ownedNested: new Map() };
  const PrefabInstanceMeta = getTraitByName('PrefabInstance');
  if (!PrefabInstanceMeta) return empty;

  // Exclude Transient spawns (scrub/preview/play control-track prefabs, UIEntries pooled rows) AND
  // their subtree, so the structural-diff walk below never classifies one as a `userAdded` child and
  // bakes it into the instance's `added` overrides (review H2). Without this, a control-track prefab
  // spawned under an authored prefab-instance member would round-trip to disk via the
  // structural-capture pass, bypassing the top-level serialize filter. Shared with `serializeScene`,
  // `serializePrefab` and `collectInstanceRoots` — see `collectTransientSubtreeIds` for why the four
  // of them must answer this the same way (#1301/#1306).
  const allEntities = filterAuthoringVisible(getAllEntities());
  const byId = new Map<number, EntityInfo>();
  for (const e of allEntities) byId.set(e.id, e);
  const childrenOf = childrenBySibling(allEntities);

  // Where each entity's TEMPLATE puts it (`identityParents.ts`) — asked for moves below.
  const identity = worldIdentityParents(getCurrentWorld());
  const { localToEcs, ecsToLocal, ownedByEcs, claimedRows, rowEcs } = instanceRowDomain(rootInstanceId, prefab, identity);
  if (localToEcs.size === 0) return empty;

  const isMember = (ecsId: number) => ecsToLocal.has(ecsId);
  // A member of ANOTHER instance moved in here (#1437): its own instance records the move, so capturing it
  // as an added child too would spawn it twice.
  const movedIn = (ecsId: number) => !isMember(ecsId) && identity.moved(ecsId);
  // …and a ROW of another frame hanging here where that frame's document puts it: a nested row, or a plain row,
  // under a nested row (#1468 Phase 6 close-out, #1484). Its own frame's prefab expands it; captured here too it
  // came back twice on reload.
  const foreign = (ecsId: number): boolean => foreignRow(ecsId, rootInstanceId, identity);
  // …and in a prefab-edit world, a ROW of the edited prefab that its own move placed under one of ours: it is
  // written as that prefab's row, not captured as something added here.
  const editRow = (ecsId: number) => isPrefabEditRowGuid(byId.get(ecsId)?.guid);
  // Classify a non-member child that is a self-rooted prefab instance (a NESTED
  // instance hanging under one of our members):
  //  - 'owned'     — it expanded from THIS prefab's own definition (its
  //                  PrefabInstance.parentLocalId is set). It round-trips via the
  //                  prefab row / nestedOverrides; capturing it as `added` here
  //                  would double-count it (re-spawn members on the expanded child).
  //  - 'userAdded' — the user dragged it in (parentLocalId 0 — it did NOT come from
  //                  the prefab definition). Captured as a reference `added` node so
  //                  it round-trips under its EXACT parent member rather than being
  //                  dropped / re-anchored to scene root.
  //  - 'none'      — not a nested-instance root (an ordinary added entity).
  // ⚠️ There is NO pass for an UNSTAMPED instance, and there must not be (#1367). Every path that
  // expands a row stamps it — the loader (`instantiatePrefabIntoWorld`), the editor's
  // `instantiatePrefab`, and Create Prefab's tag — so a live unstamped instance is never a row's own
  // expansion: it is one the user dragged in, a duplicate (`copySnapshot`'s `promote` link), or
  // an unlinked root. A second pass once let such an instance claim a free row; it took a user-added
  // instance to BE a deleted row's expansion, so a no-op save dropped the user's addition AND
  // resurrected the row. A root guid cannot discriminate either: a nested root's derived guid is
  // itself computed from this stamp (`memberStepId`). Pinned by the stamp-invariant test.
  const nestedRootKind = (ecsId: number): 'owned' | 'userAdded' | 'none' => {
    const info = byId.get(ecsId);
    if (!info?.traits.includes('PrefabInstance')) return 'none';
    const pi = readTraitData(ecsId, PrefabInstanceMeta);
    if (!pi || pi.rootInstanceId !== ecsId) return 'none';
    // A nested root deeper than a member (under a plain added node) is never a candidate above, so
    // it cannot be a row of THIS prefab — 'userAdded' captures it instead of dropping it.
    return ownedByEcs.has(ecsId) ? 'owned' : 'userAdded';
  };

  // ── removed entities (prefab members with no live counterpart), top-most only ──
  const prefabParent = new Map<number, number>();
  const prefabTraitsByLocal = new Map<number, string[]>();
  for (const pe of prefab.entities) {
    const ea = pe.traits['EntityAttributes'];
    const parent = ea && typeof ea !== 'boolean' ? ((ea.parentId as number) || 0) : 0;
    prefabParent.set(pe.localId, parent);
    prefabTraitsByLocal.set(pe.localId, Object.keys(pe.traits));
  }
  // A nested-prefab row (`pe.prefab`) expands into its OWN foreign-instance root, which is never a
  // direct member of THIS instance, so `localToEcs` cannot answer for it. Reading its absence from
  // there falsely stripped the nested instance on every re-serialize (the bug that detached the
  // spaceship's engine flames to scene root), so the row is looked for where it expands. Skipping
  // nested rows outright instead meant an owned nested instance that was deleted, or moved out,
  // re-expanded on reload beside its moved copy — two entities per guid (#1355).
  //
  // Present ⇔ CLAIMED — the same assignment `nestedRootKind` reads, so "is this row still here" and
  // "is this instance that row" cannot disagree. Strict on purpose, and only sound together with the
  // strict partition above (#1367): an unstamped instance is independent there, so it is captured as
  // an `added[]` reference node, and the row it might have been is written to `removed[]` here.
  // Leniency for an unstamped instance at the anchor (#1354's F4) kept the row alive beside that
  // reference node — the resurrected half of #1367. Still present: a row whose prefab is not cached
  // (it expanded to nothing, which is not a removal), one whose parent member is gone (its own
  // removal covers it), and one with no localId (unaddressable by `removed[]`).
  // The parent is looked up as a ROW, not as a member (#1484): under a nested row it is that row's owned root, and a
  // member-only lookup read every nested row under a nested row as "parent gone", so deleting one was never saved.
  // Whether the row was EXPANDED is asked of the frame, not the cache (#1812, I3): the frame record lists the rows its
  // expansion could not expand. A cache that holds the child NOW — restored mid-session, re-warmed, or stale after an
  // Assets delete (#1805) — says nothing about that, and read as "expanded" it wrote a frame that never had the row as
  // the scene's removal of it, lost for good once saved. A frame whose record answers nothing falls back to the cache.
  const unexpanded = unexpandedRowsOf(rootInstanceId, prefab);
  const nestedRowPresent = (pe: PrefabFile['entities'][number]): boolean => {
    const parentLocal = prefabParent.get(pe.localId) ?? 0;
    const parentMember = rowEcs(parentLocal);
    if (!pe.localId || !parentMember) return true;
    if (unexpanded) return unexpanded.has(pe.localId) || claimedRows.has(pe.localId);
    // A child that loads but expands to no root expanded to nothing too (#1768): not a removal either.
    const child = getCachedPrefabSync(pe.prefab!);
    if (!child || !expandsToRoot(child, getCachedPrefabSync)) return true;
    return claimedRows.has(pe.localId);
  };
  const removedSet = new Set<number>();
  for (const pe of prefab.entities) {
    if (pe.prefab ? !nestedRowPresent(pe) : !localToEcs.has(pe.localId)) removedSet.add(pe.localId);
  }
  // Only the TOP-MOST removal is stored (U6, I2): a row goes with a removed ancestor row. Not the parent alone (#1765): a
  // nested row under a removed nested row reads as present above (its parent member is gone, so its own removal is
  // covered) without being LIVE, and a plain row under it then passed a parent-only test as top-most — a spurious
  // `removed` that kept the row deleted after the template moved it out from under the removed one. So the climb passes
  // through such a row, and stops at one that is really live: a member the scene moved out from under a removed row
  // carries its subtree with it, and a removal inside that subtree is its own (#1730's case).
  const liveRow = (lid: number): boolean => localToEcs.has(lid) || claimedRows.has(lid);
  const underRemoved = (lid: number): boolean => {
    const seen = new Set<number>([lid]);
    for (let p = prefabParent.get(lid) ?? 0; p && !seen.has(p); p = prefabParent.get(p) ?? 0) {
      if (removedSet.has(p)) return true;
      if (liveRow(p)) return false;
      seen.add(p);
    }
    return false;
  };
  const removed: number[] = [];
  for (const lid of removedSet) if (!underRemoved(lid)) removed.push(lid);
  removed.sort((a, b) => a - b);

  // ── removed components on surviving members ──
  const removedTraits: Record<number, string[]> = {};
  for (const [localId, ecsId] of localToEcs) {
    const info = byId.get(ecsId);
    if (!info) continue;
    const own = prefabTraitsByLocal.get(localId) || [];
    const layer = opts.layerTraits?.[localId]?.filter((n) => !own.includes(n)) ?? [];
    const gone = [...own, ...layer].filter((n) => n !== 'PrefabInstance' && !info.traits.includes(n));
    if (gone.length) removedTraits[localId] = gone;
  }

  // ── moved members: linked, but under a parent other than their row's (#1437) ──
  // ⚠️ Phase 3 (#1468) made this a DIFF AGAINST THE TEMPLATE, computed by `memberRowParents`, where
  // it used to be read off `PrefabInstance.homeParent` — the guid a member remembered at the moment
  // it was dragged. That field existed only because a member's identity was derived from where it
  // sat, so a move had to be un-done before every identity walk; with identity stored, "has this
  // member moved" is answerable from the document and the live parent alone, and nothing has to be
  // remembered. Same answer, one less thing that can go stale. (Phase 6 then retired the fields'
  // other two roles the same way — `identityParents.ts` — and deleted them.)
  //
  // A TEMPLATE capture (a prefab written from a live tree) still records none: its values would be
  // live scene guids, which name nothing in the prefab's own space — nor, in another instance,
  // anything of that instance.
  //
  // ⚠️ This map is a VIEW of the moves, and the file writes only part of it: a member with a row
  // carries its move as `parent`, and only `unrowed` — the moves no row will carry — goes to the
  // legacy `moved` map. What consumes the whole map is the rebuild transport and Apply to Prefab /
  // Revert — in-memory, against this one document, where a localId is a sound address (#1468 Phase 4
  // kept it: only the seams where a localId crosses to ANOTHER document were changed).
  const moved: Record<number, string> = {};
  const rowParents = opts.template
    ? new Map<number, string>()
    : memberRowParents(rootInstanceId, prefab, rowParentDomain(rootInstanceId, { localToEcs, ownedByEcs }));
  // Asked of the root whose save WRITES the rows, not of this one: a nested capture's own key space
  // can name a member the writer's cannot (`rowWritingRoot`).
  const rowed = opts.template ? new Map<number, string>() : memberRowsToWrite(rowWritingRoot(rootInstanceId));
  const unrowed: Record<number, string> = {};
  const noteMove = (ecsId: number, rowLocal: number): void => {
    const to = rowParents.get(ecsId);
    if (!to) return;
    moved[rowLocal] = to;
    if (!rowed.has(ecsId)) unrowed[rowLocal] = to;
  };
  for (const [localId, ecsId] of localToEcs) if (ecsId !== rootInstanceId) noteMove(ecsId, localId);
  for (const [ecsId, rowLocal] of ownedByEcs) noteMove(ecsId, rowLocal);

  // ── added entities: non-member descendants of each member ──
  const consumedEcsIds = new Set<number>();

  // A user-added nested instance → reference node (its source + per-instance diffs).
  // Recursion is via captureInstanceReference → captureInstanceStructure, which
  // captures any user-added instances nested deeper inside it.
  const captureNestedRef = (ecsId: number, parentLocalId: number): AddedEntity | null => {
    const pi = readTraitData(ecsId, PrefabInstanceMeta);
    const source = pi?.source as string | undefined;
    if (!source) return null;
    const recorded = opts.againstRecords ? levelDoc(ecsId, source) : null;
    const childPrefab = recorded?.fromRecord ? recorded.doc : captureDoc(ecsId, source);
    if (!childPrefab) {
      console.warn(`[Prefab] user-added nested instance "${source}" not cached; exact placement not captured`);
      return null;
    }
    // Written into a prefab TEMPLATE: the row writer's rules, tokenized in the node's own frame (#1538).
    if (opts.template) {
      const t = finishTemplateReferenceNode(ecsId, source, childPrefab, !!opts.readOnly);
      for (const m of t.ref.memberEcsIds) consumedEcsIds.add(m);
      for (const c of t.ref.consumedEcsIds) consumedEcsIds.add(c);
      for (const c of t.consumedEcsIds) consumedEcsIds.add(c);
      return {
        parentLocalId, ...addedNodeIdentity(ecsId, true, opts.readOnly), name: t.chainName ?? (byId.get(ecsId)?.name || ''), traits: {}, children: [],
        prefab: source, ...t.channels,
      };
    }
    // The node is its own root: no layer of the frame it hangs in states anything about its members, so that frame's
    // `layerTraits` are not its own. Handed down, a member of the node whose localId matched a member the enclosing layer
    // adds a component to was captured as having REMOVED it — a record nobody made, which #1914 R4 then keeps as unused.
    const ref = captureInstanceReference(ecsId, source, childPrefab, { ...opts, layerTraits: undefined });
    for (const m of ref.memberEcsIds) consumedEcsIds.add(m);
    for (const c of ref.consumedEcsIds) consumedEcsIds.add(c);
    // The node is the OUTERMOST layer for its own nested rows, so it carries their scene edits itself
    // — the same two channels a top-level entry carries (#1369). Without them an edit inside a row
    // expansion of a DRAGGED-IN prefab was captured by nothing and came back on reload.
    const captured = captureNestedChannels(ecsId, source, ref.ownedNested, { template: opts.template, rows: opts.rows, frameEdits: opts.frameEdits, againstRecords: opts.againstRecords });
    for (const c of captured.consumedEcsIds) consumedEcsIds.add(c);
    // A SCENE node is a stored root: what the load kept of its legacy channels goes back out with it (#1780). A template
    // capture of one writes its scene statements nowhere (I8).
    const nodeGuid = opts.template ? '' : durableGuid((readTraitData(ecsId, getTraitByName('EntityAttributes')!) as { guid?: string } | null)?.guid);
    const channels = withKeptLegacy(captured, nodeGuid);
    // A template reference node's own moves ride the scene form unchanged: they are the template's statement, and the
    // moves captured above are measured against them (`prefabMoveTargets`), so a respawn without them lost the move (#1543).
    const handle = findEntity(ecsId);
    const templateMoved = handle ? frameRootDoc(getCurrentWorld(), handle)?.nodeMoved : undefined;
    const node = {
      parentLocalId, ...addedNodeIdentity(ecsId, opts.template, opts.readOnly), name: byId.get(ecsId)?.name || '', traits: {}, children: [],
      prefab: source,
      overrides: ref.overrides, added: ref.added, removed: ref.removed, removedTraits: ref.removedTraits, moved: ref.moved,
      ...(templateMoved ? { templateMoved } : {}),
      nestedOverrides: channels.nestedOverrides, nestedStructure: channels.nestedStructure,
    };
    // A reference node IS an instance, so it carries its members' identity like any other (v16,
    // #1468) — and since Phase 4 the edits its rows can key. A TEMPLATE node took its own branch above:
    // it carries template-form rows (keyed by node guid, no member guid), never these, which would hand
    // every instance one guid (#1293).
    if (!opts.rows) {
      const members = captureInstanceMembers(ecsId, childPrefab);
      return { ...node, ...(Object.keys(members).length ? { members } : {}) };
    }
    const moved = moveChannelsOntoRows(ecsId, childPrefab, source, node, captureInstanceMembers(ecsId, childPrefab), channels.frames, { againstRecords: opts.againstRecords, frameEdits: opts.frameEdits });
    const nonEmpty = <T,>(v: T | undefined): T | undefined =>
      v === undefined || (Array.isArray(v) ? v.length : Object.keys(v as object).length) ? v : undefined;
    // Stated against its record: what is left by localId goes into the numbering the load expands it in.
    const cached = recorded?.fromRecord ? getCachedPrefabSync(source) : null;
    const lid = cached && cached !== childPrefab ? translateLocalIds(childPrefab, cached) : null;
    const ch = lid ? (() => {
      const t = translateCarried(lid, moved.channels.overrides ?? {}, { added: moved.channels.added, removed: moved.channels.removed, removedTraits: moved.channels.removedTraits });
      return { ...moved.channels, overrides: t.overrides, added: t.structure.added, removed: t.structure.removed, removedTraits: t.structure.removedTraits };
    })() : moved.channels;
    // A scene node states its root's LIVE sibling position and active flag in its own traits for the placeholder its next
    // load spawns if the prefab is gone by then (`spawnUnresolvedReference` seats them): every one when the prefab no
    // longer resolves (trashed mid-session, its frame kept, #1862; #1897, owner ruling A), and each one a ROOT OVERRIDE
    // states while it does (#1901: a prefab deleted outside the editor, then a cold load). A node placeholder reads only
    // its traits (it has no `PrefabInstance.localId` to find a root override by), while a resolving node ignores them, so
    // the override still applies once the prefab returns (`nodePlacement`). The override is read in the live document's
    // numbering, the one `pi.localId` is in (`moved`, before `translateLocalIds`).
    // Every live source is fetched before the save captures, so an empty cache here is a prefab that does not resolve.
    const placement = nodePlacement(
      !!getCachedPrefabSync(source),
      (moved.channels.overrides as Record<number, Record<string, Record<string, unknown>>> | undefined)?.[pi?.localId as number]?.EntityAttributes,
      readTraitData(ecsId, getTraitByName('EntityAttributes')!) as Record<string, unknown> | undefined,
    );
    return {
      ...node,
      ...(Object.keys(placement).length ? { traits: { EntityAttributes: placement } } : {}),
      ...(lid && node.moved ? { moved: translateCarried(lid, {}, { moved: node.moved }).structure.moved } : {}),
      overrides: nonEmpty(ch.overrides), added: nonEmpty(ch.added),
      removed: nonEmpty(ch.removed), removedTraits: nonEmpty(ch.removedTraits),
      nestedOverrides: nonEmpty(moved.channels.nestedOverrides), nestedStructure: nonEmpty(moved.channels.nestedStructure),
      ...(Object.keys(moved.members).length || keptUnusedRows(nodeGuid) ? { members: withKeptUnused(withoutRowParents(ecsId, moved.members, opts.dropParents), nodeGuid, ecsId) } : {}),
    };
  };

  // Capture one non-member child as an AddedEntity (plain subtree OR nested-instance
  // reference), or null if it should be skipped (owned nested instance).
  const captureChild = (childEcsId: number, parentLocalId: number): AddedEntity | null => {
    // A placeholder for a reference the load could not expand writes back the node it carries (#1699), whether or not
    // the prefab resolves by now: until an expansion replaces it, the placeholder is all the world holds of it. Found
    // by its marker, since it carries no `PrefabInstance`.
    // ⚠️ Scene form only. A TEMPLATE capture would write the record's scene guids into a template (I8), so it is left
    // out, and the two template writers refuse a tree holding one up front (Create Prefab; Apply of its key).
    const unresolved = unresolvedRefOf(findEntity(childEcsId));
    if (unresolved) {
      if (opts.template) return null;
      consumedEcsIds.add(childEcsId);
      // Its live order and flag go with it (#1901), whichever route put it here: a node's traits are the one place its
      // reload reads them from.
      const live = readTraitData(childEcsId, getTraitByName('EntityAttributes')!) as { sortOrder?: number; isActive?: boolean } | null;
      return asAddedNode(unresolved.kind, unresolved.record, unresolved.source, {
        name: byId.get(childEcsId)?.name || '', parentLocalId, identity: addedNodeIdentity(childEcsId, false, opts.readOnly),
        order: { sortOrder: live?.sortOrder ?? 0, isActive: live?.isActive ?? true },
      }) as unknown as AddedEntity;
    }
    const kind = nestedRootKind(childEcsId);
    if (kind === 'owned') return null;                  // round-trips via the prefab/nestedOverrides
    if (kind === 'userAdded') return captureNestedRef(childEcsId, parentLocalId);
    return snapshotSubtree(childEcsId, parentLocalId);
  };

  function snapshotSubtree(ecsId: number, parentLocalId: number): AddedEntity {
    consumedEcsIds.add(ecsId);
    const { bag, guid } = snapshotAddedTraits(ecsId);
    // The bag's own copy of the guid goes with the node's: a template node's identity is its key.
    const ea = bag['EntityAttributes'];
    if (opts.template && ea && ea !== true) delete ea.guid;
    const children: AddedEntity[] = [];
    for (const child of childrenOf.get(ecsId) || []) {
      if (isMember(child.id) || movedIn(child.id) || foreign(child.id) || editRow(child.id)) continue;
      const node = captureChild(child.id, 0); // child of a plain added node → tree-shape parent
      if (node) children.push(node);
    }
    // Scene form keeps the snapshot's own guid; template form takes the key (#1387).
    const identity = opts.template ? addedNodeIdentity(ecsId, true, opts.readOnly) : { guid };
    return { parentLocalId, ...identity, name: byId.get(ecsId)?.name || '', traits: bag, children };
  }

  const added: AddedEntity[] = [];
  // By localId: the member map is built in query order too (#1796). The scene writer splits `added` per member row
  // (`moveChannelsOntoRows`), but a prefab file's nested REFERENCE row writes the whole list (`serializePrefab`), and Apply
  // All numbers its promoted rows in this order. TRACED by the close-out review, not driven: the fuzzer has no prefab-edit
  // save → reopen → save identity check, so no test can make this line fail today.
  for (const [ecsId, localId] of [...ecsToLocal].sort((a, b) => a[1] - b[1])) {
    for (const child of childrenOf.get(ecsId) || []) {
      if (isMember(child.id) || movedIn(child.id) || foreign(child.id) || editRow(child.id)) continue;
      const node = captureChild(child.id, localId);
      if (node) added.push(node);
    }
  }

  // Scene form: each captured node's key rides beside its guid, for a rebuild that respawns it (`rebuildFromEntry`).
  const keyed = opts.template ? new Map<string, string>() : liveTemplateKeys(added, true, true);
  return {
    added, removed, removedTraits, moved, unrowed, consumedEcsIds, ownedNested: ownedByEcs,
    ...(keyed.size ? { templateKeys: Object.fromEntries(keyed) } : {}),
  };
}

// ── Scene-level nested channels (moved from serialize.ts for #1369, so captureNestedRef can reach them) ──

/** Capture a nested instance's SCENE-specific override delta: its full per-localId
 *  override (vs the child prefab base) minus the fields the parent prefab's own
 *  nested row already overrides. So the scene stores only what it uniquely changed
 *  on this nested instance — the row's own overrides (e.g. the flames' mirrored
 *  positions) stay owned by the parent prefab and aren't redundantly baked in. */
export function captureNestedSceneDelta(
  nestedRootId: number,
  childPrefab: PrefabFile,
  rowOverrides: Record<number, Record<string, Record<string, unknown>>> | undefined,
): Record<number, Record<string, Record<string, unknown>>> {
  // The member's RECORD, over the template under the chain (#1914 R3c): what the chain gives — a value, a component, a
  // tag — is the instance's base, so only what the scene recorded is written, whatever it equals (F1), and nothing has to
  // come off by value afterwards. The chain's member tokens are resolved first, as the rebuild resolves them (#1386), so
  // an unchanged ref is the base the live side holds.
  const resolved = rowOverrides
    ? baseTokenResolver(nestedRootId)(rowOverrides) as Record<number, Record<string, Record<string, unknown>>>
    : undefined;
  const all = captureInstanceOverrides(nestedRootId, childPrefab, withOverridesFolded(childPrefab, resolved));
  for (const [lidStr, traits] of Object.entries(all)) {
    const lid = Number(lidStr);
    // A nested instance's member guids are regenerated from the prefab chain each
    // load — never scene-authored — so drop them; otherwise the serialize guid
    // pre-pass makes every nested member look "overridden".
    if (traits.EntityAttributes) delete (traits.EntityAttributes as Record<string, unknown>).guid;
    for (const [traitName, fields] of Object.entries(traits)) {
      // An added or recorded TAG is captured as `{Tag: {}}`, and is exempt from the empty-trait drop, which took every
      // one and lost a tag added to a nested instance's member on save (#1491's sibling).
      if (getTraitByName(traitName)?.category === 'tag') continue;
      if (Object.keys(fields).length === 0) delete traits[traitName];
    }
    if (Object.keys(traits).length === 0) delete all[lid];
  }
  return all;
}

/** Do two structural deltas state the same interior? (the row writer's `omitUnchanged` test, #1381)
 *
 *  Compared by a canonical form, because the two sides are the same CONTENT written by different
 *  hands: absent and empty lists are one statement; `removed` and `added` are sets (the capture
 *  writes `added` in anchor order, a hand-authored file in any order); and a file-authored trait bag
 *  is run through the capture's own compaction (`compactAddedTraitData`), so a legacy FULL bag
 *  matches the compacted capture of the entity it spawns. Anything still different writes the path,
 *  which is the safe direction.
 *
 *  Node IDENTITY (`key`, `guid`) is compared only when both sides key every node (#1387). A file written
 *  before keys existed has none — a guid-less node, or one carrying the durable guid #1387 is about —
 *  while the capture writes a key and `guid: ''` for each live node. That file's untouched interior is
 *  still unchanged content, and pinning it into the OUTER row on a no-op save is the #1381 defect over
 *  again. It migrates when its OWN prefab is re-saved, which writes the keys there. */
function sameStructure(
  a: { added?: AddedEntity[]; removed?: number[]; removedTraits?: Record<number, string[]>; moved?: Record<number, string> },
  b: { added?: AddedEntity[]; removed?: number[]; removedTraits?: Record<number, string[]>; moved?: Record<number, string> },
): boolean {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) out[k] = canon((v as Record<string, unknown>)[k]);
      return out;
    }
    return v;
  };
  // Sorted BY their JSON but kept as values: nesting the JSON strings themselves re-escaped every level's
  // quotes inside its parent's, so the text doubled per level of `children` (measured 1.4 s at 22 deep,
  // out of memory at 24 — #1352 close-out).
  const asSet = (items: unknown[]): unknown[] => items
    .map((x) => [JSON.stringify(x), x] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([, x]) => x);
  const withoutBagGuid = (traits: Record<string, unknown>): Record<string, unknown> => {
    const ea = traits['EntityAttributes'];
    if (!ea || typeof ea !== 'object' || !('guid' in ea)) return traits;
    const { guid: _drop, ...rest } = ea as Record<string, unknown>;
    return { ...traits, EntityAttributes: rest };
  };
  const allKeyed = (nodes: AddedEntity[] | undefined): boolean =>
    (nodes ?? []).every((n) => !!n.key && allKeyed(n.children) && allKeyed(n.added));
  const withKeys = allKeyed(a.added) && allKeyed(b.added);
  const node = (n: AddedEntity): unknown => {
    const traits: Record<string, unknown> = {};
    for (const [name, data] of Object.entries(n.traits ?? {})) {
      const meta = getTraitByName(name);
      traits[name] = data === true || !meta ? data : compactAddedTraitData(meta, data as Record<string, unknown>);
    }
    const { key, guid, ...rest } = n;
    return canon({
      ...rest, ...(withKeys ? { key, guid } : {}), traits: withKeys ? traits : withoutBagGuid(traits),
      children: asSet((n.children ?? []).map(node)),
      ...(n.added ? { added: asSet(n.added.map(node)) } : {}),
    });
  };
  const norm = (d: typeof a) => JSON.stringify(canon({
    added: asSet((d.added ?? []).map(node)),
    removed: [...(d.removed ?? [])].sort((x, y) => x - y),
    removedTraits: Object.fromEntries(Object.entries(d.removedTraits ?? {})
      .filter(([, names]) => names.length).map(([k, names]) => [k, [...names].sort()])),
    moved: d.moved ?? {},
  }));
  return norm(a) === norm(b);
}

/** Does this structural delta state nothing at all? */
function emptyStructure(
  v: { added?: AddedEntity[]; removed?: number[]; removedTraits?: Record<number, string[]>; moved?: Record<number, string> },
): boolean {
  return !v.added?.length && !v.removed?.length && !Object.keys(v.removedTraits ?? {}).length && !Object.keys(v.moved ?? {}).length;
}

/** The SCENE-level nested channels of one instance — `nestedOverrides` and `nestedStructure`, both
 *  path-keyed from `source` — captured by walking its owned nested instances top-down (#1369).
 *
 *  ONE walk for every instance that owns a scene-side slot: a top-level instance (`serializeScene`)
 *  and a user-added nested instance written as a reference node (`captureNestedRef`). Each is the
 *  outermost layer for everything under it. The walk used to live in `serializeScene` only, resolving
 *  each owned nested instance UP to a top-level root, so a chain passing through a reference node
 *  resolved to nothing and every edit beneath it was dropped on save — value and structure alike.
 *
 *  `ownedNested` is `captureInstanceStructure(root).ownedNested` — the row partition — and each level
 *  descends through that level's own partition, so "which instance is row N's expansion" is answered
 *  by exactly one rule at every depth. Paths are written in sorted order so the saved key order does
 *  not depend on ECS ids. All prefabs along the paths must be cached (`serializeScene` preloads them). */
export function captureNestedChannels(
  top: number,
  source: string,
  ownedNested: ReadonlyMap<number, number>,
  opts: {
    /** The PREFAB-ROW writer's rule (#1381): also omit a path whose live interior EQUALS what the
     *  prefab chain already applies. A scene keeps the restate-when-non-empty rule below; a row must
     *  not, or a no-op prefab-edit save pins the inner prefab's own authored structure into the outer
     *  file and a later edit to the inner prefab stops reaching any instance of the outer one.
     *  Sound for a row, where #1358 found it unsound for a scene, because both sides are now the same
     *  document: file-authored `added` nodes are written by this same compacting capture, and the
     *  live `parentId` that made them differ is no longer captured (#1377). A mismatch still writes,
     *  which is the conservative direction. */
    omitUnchanged?: boolean;
    /** Capture each interior in TEMPLATE form (`StructureCaptureOpts`) — set by a prefab-file writer. */
    template?: boolean;
    /** Capture each interior in SCENE FILE form (`StructureCaptureOpts.rows`) — set by the scene writer. */
    rows?: boolean;
    /** `StructureCaptureOpts.readOnly`, for each interior. */
    readOnly?: boolean;
    /** With `omitUnchanged`: DEFER the omission — keep every path, and record the baseline it would
     *  have been compared against. `serializePrefab` compares after rewriting refs into member tokens
     *  (#1352): a live bag holds guids where the file holds tokens, so an early compare always differed
     *  and pinned the interior. */
    baselinesOut?: Map<string, InstanceStructureData>;
    /** What a layer ENCLOSING `top` forwards into it, subtracted from every frame's values with the chain (`chainLayer`'s
     *  seed) — a comparison asking whether a live reference node states only what a CHAIN node states (#1781). */
    seed?: ForwardState;
    /** `StructureCaptureOpts.frameEdits`: an owned frame's own delta and structure are edited here, and the reference
     *  nodes inside each interior through its structure capture. */
    frameEdits?: ReadonlyMap<number, FrameEdit>;
    /** `StructureCaptureOpts.againstRecords`, handed on to each frame's structure capture. */
    againstRecords?: boolean;
  } = {},
): {
  nestedOverrides?: NestedOverridePaths; nestedStructure?: NestedStructurePaths; consumedEcsIds: Set<number>;
  /** Every live entity the owned nested instances ARE, at every depth — each root and its members.
   *  A flat writer skips these, since the owner's row re-expands them (#1382). */
  ownedMemberEcsIds: Set<number>;
  /** Path key → the live nested root that path addresses (and the path itself, as the walk built it),
   *  for every path this walk could capture — what `moveChannelsOntoRows` needs to turn a path-keyed
   *  entry into member rows (#1468 Phase 4). */
  frames: Map<string, { root: number; path: number[] }>;
} {
  const frames = new Map<string, { root: number; path: number[] }>();
  const consumedEcsIds = new Set<number>();
  const ownedMemberEcsIds = new Set<number>();
  const PrefabInstanceMeta = getTraitByName('PrefabInstance');
  if (!PrefabInstanceMeta) return { consumedEcsIds, ownedMemberEcsIds, frames };
  let membersByRoot: Map<number, number[]> | undefined;
  const membersOf = (rootId: number): number[] => {
    if (!membersByRoot) {
      const byRoot = new Map<number, number[]>();
      getCurrentWorld().query(PrefabInstanceMeta.trait).updateEach(([pi], entity) => {
        const r = (pi as Record<string, unknown>).rootInstanceId as number;
        if (!r) return;
        const list = byRoot.get(r);
        if (list) list.push(entity.id());
        else byRoot.set(r, [entity.id()]);
      });
      membersByRoot = byRoot;
    }
    return membersByRoot.get(rootId) ?? [];
  };
  const overrides = new Map<string, Record<number, Record<string, Record<string, unknown>>>>();
  const structures = new Map<string, NestedStructurePaths[string]>();
  const order: number[][] = [];
  const walk = (owned: ReadonlyMap<number, number>, path: number[]) => {
    for (const [ecsId, rowLocalId] of owned) {
      const childSource = readTraitData(ecsId, PrefabInstanceMeta)?.source as string | undefined;
      const childPrefab = childSource ? levelDoc(ecsId, childSource).doc : undefined;
      ownedMemberEcsIds.add(ecsId);
      for (const m of membersOf(ecsId)) ownedMemberEcsIds.add(m);
      if (!childPrefab) {
        // The instance still re-expands from its owner's row (that row names ITS prefab, not this
        // one), so it stays skipped — but its interior cannot be captured, so skip that too rather
        // than let an added child fall out as a root row (#1381 review). Dropped with a warning, the
        // `captureNestedRef` precedent; every caller warms the cache first (#1295).
        const all = getAllEntities();
        const lost = collectSubtreeIds(all.map((e) => [e.id, e.parentId] as const), [ecsId]);
        for (const id of lost) ownedMemberEcsIds.add(id);
        // Count only what the USER added: an entity with no PrefabInstance, or a user-added (unstamped)
        // instance root. Members of the uncached prefab's own nested rows re-expand from it, and a
        // Transient spawn is never authored (review of the first cut: both inflated the count).
        const authored = new Set(filterAuthoringVisible(all).map((e) => e.id));
        const extra = lost.filter((id) => {
          if (id === ecsId || !authored.has(id)) return false;
          const pi = readTraitData(id, PrefabInstanceMeta);
          return !pi || isStoredRoot(pi, id);
        });
        if (extra.length) console.warn(`[Prefab] nested prefab "${childSource}" not cached; ${extra.length} entit${extra.length === 1 ? 'y' : 'ies'} added inside it not captured`);
        continue;
      }
      const at = [...path, rowLocalId];
      const key = nestedPathKey(at);
      frames.set(key, { root: ecsId, path: at });
      order.push(at);
      // Subtract what the whole prefab chain applies to this instance (not just the immediate row)
      // so a deep scene edit stores only its own delta.
      const chain = chainLayer(top, source, at, undefined, opts.seed);
      const edit = opts.frameEdits?.get(ecsId);
      const liveDelta = captureNestedSceneDelta(ecsId, childPrefab, chain.overrides);
      const delta = edit?.overrides ? edit.overrides(liveDelta) : liveDelta;
      const layerTraits = layerAddedTraits(chain, childPrefab);
      if (Object.keys(delta).length > 0) overrides.set(key, delta);
      // The STRUCTURAL interior (#1358). Skipped ONLY when the live interior and the prefab chain's
      // own are both empty — the common case, and the one that must stay absent so a member added to
      // the inner prefab later still reaches an untouched instance. Otherwise all three lists are
      // written VERBATIM, empty arrays included, because once the scene addresses a path it OWNS the
      // interior: comparing against the file-authored baseline field by field was wrong twice over
      // (the two documents are not comparable — the live side is compacted by `snapshotAddedTraits` —
      // and dropping an empty list made "the row's own list no longer applies" unrepresentable, so
      // deleting the last member of a row-authored `added` came back on reload).
      const liveStructure = captureInstanceStructure(ecsId, childPrefab, { template: opts.template, rows: opts.rows, readOnly: opts.readOnly, layerTraits, frameEdits: opts.frameEdits, againstRecords: opts.againstRecords });
      for (const id of liveStructure.consumedEcsIds) consumedEcsIds.add(id);
      const structure = edit?.structure ? edit.structure(liveStructure) : liveStructure;
      const live = {
        added: structure.added, removed: structure.removed, removedTraits: structure.removedTraits,
        ...(Object.keys(structure.unrowed ?? {}).length ? { moved: structure.unrowed } : {}),
      };
      const baseline = chain.structure;
      const unchanged = emptyStructure(live) && emptyStructure(baseline);
      if (opts.omitUnchanged && opts.baselinesOut) {
        if (!unchanged) { structures.set(key, live); opts.baselinesOut.set(key, baseline); }
      } else if (!unchanged && !(opts.omitUnchanged && sameStructure(live, baseline))) structures.set(key, live);
      walk(liveStructure.ownedNested, at);
    }
  };
  walk(ownedNested, []);
  order.sort((a, b) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
    return a.length - b.length;
  });
  const nestedOverrides: NestedOverridePaths = {};
  const nestedStructure: NestedStructurePaths = {};
  for (const at of order) {
    const key = nestedPathKey(at);
    const o = overrides.get(key);
    if (o) nestedOverrides[key] = o;
    const st = structures.get(key);
    if (st) nestedStructure[key] = st;
  }
  return {
    nestedOverrides: Object.keys(nestedOverrides).length ? nestedOverrides : undefined,
    nestedStructure: Object.keys(nestedStructure).length ? nestedStructure : undefined,
    consumedEcsIds,
    ownedMemberEcsIds,
    frames,
  };
}

/** The localId-keyed channels of one instance, as a scene writer holds them before writing. */
export interface InstanceChannels {
  overrides?: Record<number, Record<string, Record<string, unknown>>>;
  added?: AddedEntity[];
  removed?: number[];
  removedTraits?: Record<number, string[]>;
  nestedOverrides?: NestedOverridePaths;
  nestedStructure?: NestedStructurePaths;
}

/** Move every edit a MEMBER ROW can carry off the localId-keyed channels and onto the row (#1468
 *  Phase 4) — the write half of `foldMemberRowChannels`, and the reason a scene's edits now survive a
 *  template renumber: the row is addressed by the member's minted identity, the channel by a position.
 *
 *  `rootId` is the instance whose SAVE writes `members` (a top-level instance, or a user-added reference
 *  node), `prefab` its document, `ch` the channels captured for it and `nestedFrames` the path → live
 *  nested root map `captureNestedChannels` returns. Neither input is mutated.
 *
 *  **What stays in the legacy channel, and why each one must:**
 *  - **the instance ROOT's own edits** — the root has no row, it IS the entry (#1468 design record,
 *    Finding A); its localId is the document's root and never renumbers;
 *  - **a member no row can key** — a pre-v5 template's member (no `nodeGuid`, which is every prefab the
 *    released editor wrote), or a live member with no durable guid (`memberRowsToWrite`'s rule, which
 *    the two stampers also rely on);
 *  - **a nested frame's STRUCTURE, whole, unless every member it touches is keyable** — the legacy
 *    `nestedStructure[path]` REPLACES the frame's lists, so half of it on rows and half in the channel
 *    would be one statement in two places with nothing to say which half is authoritative.
 *
 *  A nested frame's structure moves as PER-MEMBER statements of the live state, for every member whose
 *  live statement DIFFERS from the prefab chain's baseline (#1511): the explicit `removed: false`,
 *  `removedTraits: []` and `added: []` are what carry the legacy slot's "the prefab's list no longer
 *  applies" (see `foldMemberRowChannels`), and a member the scene did not change gets no statement, so a
 *  later template change to it still reaches the scene. Writing every member the chain touched restated
 *  the chain's own lists on a no-op save and pinned them. A REMOVED member has no live entity, so its row
 *  is keyed from the frame's key and the member's `nodeGuid` in the frame's document, and carries no guid.
 *
 *  Since v17 (#1516) the template's added nodes are stated NODE by node (`frameAddedDiff`: an edited node's
 *  differing fields on its own row, a deleted one `removed`, the scene's own nodes `own`) and removed traits
 *  TRAIT by trait (`traitRemovals`), because `added` and `removedTraits` are one statement per member that
 *  replaces the chain's, and pinned every untouched node or name beside the scene's edit. `added` is written
 *  only for a list that cannot be stated node by node. */
export function moveChannelsOntoRows(
  rootId: number,
  prefab: PrefabFile,
  source: string,
  ch: InstanceChannels,
  members: Record<string, SceneMemberRow>,
  nestedFrames: ReadonlyMap<string, { root: number; path: number[] }> = new Map(),
  opts: {
    /** Writing a prefab ROW's rows (#1533) rather than a scene's: every keyed member may carry a row (a
     *  template states no guid, so the scene's durable-guid gate has nothing to protect), and nodes are
     *  written in TEMPLATE form — keyed, no live guid — from `ch`'s template capture. */
    template?: boolean;
    /** `StructureCaptureOpts.againstRecords` and `frameEdits`: each frame's added nodes are compared with the chain's as the
     *  rebuild states them ({@link frameAddedDiff}) — a template reference node's statement is made there. */
    againstRecords?: boolean;
    frameEdits?: ReadonlyMap<number, FrameEdit>;
    /** What a layer ENCLOSING `rootId` forwards into it (`chainLayer`'s seed): the chain node a template reference node
     *  was spawned from ({@link referenceNodeRows}, #1914 R3b). Every frame's base is read through it. */
    seed?: ForwardState;
    /** State `rootId`'s OWN frame as a nested frame is stated (#1914 R3b): its structure against `base` (the chain node's
     *  statement at the node's root), node by node, and its root's row under {@link NODE_ROOT}. `live` is the frame's
     *  capture. Set by {@link referenceNodeRows}, whose rows reach into a template reference node. */
    asNode?: { live: InstanceStructure; base: LayerStructure };
  } = {},
): { channels: InstanceChannels; members: Record<string, SceneMemberRow>; nodeUnstated?: boolean; rowFrames?: Map<string, number> } {
  const piMeta = getTraitByName('PrefabInstance');
  if (!piMeta) return { channels: ch, members };
  const keyOf = memberRowKeysIn(rootId);
  // Rows reaching into a reference node carry statements only, never a member's identity: every keyed member may carry one.
  const rowed = opts.template || opts.asNode ? keyOf : memberRowsToWrite(rootId);
  const out: Record<string, SceneMemberRow> = { ...members };
  const row = (key: string): SceneMemberRow => (out[key] = { ...(out[key] ?? {}) });

  // localId → live ecs, per frame root, from one query.
  const byFrame = new Map<number, Map<number, number>>();
  getCurrentWorld().query(piMeta.trait).updateEach(([pi], entity) => {
    const d = pi as { rootInstanceId?: number; localId?: number };
    if (!d.rootInstanceId || !d.localId) return;
    let m = byFrame.get(d.rootInstanceId);
    if (!m) byFrame.set(d.rootInstanceId, (m = new Map()));
    m.set(d.localId, entity.id());
  });

  /** The row key for member `lid` of the frame rooted at `frameRoot` (document `doc`, frame key
   *  `frameKey` — '' for the top frame), or '' when no row may carry it. `live` asks for a member that
   *  must exist (an override, a removed trait, an anchor); a removed member need not. */
  const keyFor = (frameRoot: number, doc: PrefabFile, frameKey: string, lid: number, live: boolean): string => {
    if (lid === (doc.rootLocalId ?? 1)) {
      // The frame's own root: the top frame's has no row (a reference node's has, `asNode`); a nested one's row is the
      // FRAME's key.
      if (frameRoot === rootId) return opts.asNode ? NODE_ROOT : '';
      return rowed.has(frameRoot) ? frameKey : '';
    }
    const ecs = byFrame.get(frameRoot)?.get(lid);
    if (ecs) return rowed.get(ecs) ?? '';
    if (live) return '';
    const g = rowAt(doc, lid)?.nodeGuid;
    return g && isGuid(g) && (frameRoot === rootId || frameKey) ? `${frameKey}/${g}` : '';
  };

  // ── The top frame: per member, per channel. ──
  const legacy: InstanceChannels = { ...ch };
  if (ch.overrides) {
    const keep: typeof ch.overrides = {};
    for (const [lidStr, traits] of Object.entries(ch.overrides)) {
      const key = keyFor(rootId, prefab, '', Number(lidStr), true);
      if (key) row(key).traits = traits;
      else keep[Number(lidStr)] = traits;
    }
    legacy.overrides = Object.keys(keep).length ? keep : undefined;
  }
  if (ch.removedTraits) {
    const keep: Record<number, string[]> = {};
    for (const [lidStr, names] of Object.entries(ch.removedTraits)) {
      const key = keyFor(rootId, prefab, '', Number(lidStr), true);
      if (key) row(key).removedTraits = names;
      else keep[Number(lidStr)] = names;
    }
    legacy.removedTraits = Object.keys(keep).length ? keep : undefined;
  }
  if (ch.removed) {
    const keep: number[] = [];
    for (const lid of ch.removed) {
      const key = keyFor(rootId, prefab, '', lid, false);
      if (key) row(key).removed = true;
      else keep.push(lid);
    }
    legacy.removed = keep.length ? keep : undefined;
  }
  if (ch.added) {
    const keep: AddedEntity[] = [];
    for (const node of ch.added) {
      const key = keyFor(rootId, prefab, '', node.parentLocalId, true);
      if (key) (row(key).added ??= []).push({ ...node, parentLocalId: 0 });
      else keep.push(node);
    }
    legacy.added = keep.length ? keep : undefined;
  }

  // ── Nested frames. ──
  const frameOf = (path: string): { root: number; doc: PrefabFile; key: string; steps: number[] } | null => {
    const at = nestedFrames.get(path);
    const src = at ? (readTraitData(at.root, piMeta)?.source as string | undefined) : undefined;
    const doc = at && src ? levelDoc(at.root, src).doc : null;
    const key = at ? keyOf.get(at.root) ?? '' : '';
    return at && doc && key ? { root: at.root, doc, key, steps: at.path } : null;
  };
  if (ch.nestedOverrides) {
    const keep: NestedOverridePaths = {};
    for (const [path, byLocal] of Object.entries(ch.nestedOverrides)) {
      const f = frameOf(path);
      const rest: Record<number, Record<string, Record<string, unknown>>> = {};
      for (const [lidStr, traits] of Object.entries(byLocal)) {
        const key = f ? keyFor(f.root, f.doc, f.key, Number(lidStr), true) : '';
        if (key) row(key).traits = traits;
        else rest[Number(lidStr)] = traits;
      }
      if (Object.keys(rest).length) keep[path] = rest;
    }
    legacy.nestedOverrides = Object.keys(keep).length ? keep : undefined;
  }
  /** State one frame's structure on rows: what DIFFERS from `base` (the chain's lists there), member by member and node by
   *  node. False when a statement has no row to go on, so the caller keeps the frame's legacy slot. */
  // The frame each row reaching into a template reference node applies in (its live root, or a nested root inside it):
  // its key names nothing the outer frames do, so a template writer's tokens find it here (`tokenizeRowMembers`).
  const rowFrames = new Map<string, number>();
  const stateFrame = (f: { root: number; doc: PrefabFile; key: string; steps: number[] }, live: InstanceStructureData, base: LayerStructure): boolean => {
    const liveRemoved = new Set(live.removed ?? []);
    const baseRemoved = new Set(base.removed ?? []);
    const touched = new Map<number, { removed: boolean; traits: Record<string, boolean> | null; added: boolean; own: boolean }>();
    const touch = (lid: number): { removed: boolean; traits: Record<string, boolean> | null; added: boolean; own: boolean } => {
      let t = touched.get(lid);
      if (!t) touched.set(lid, (t = { removed: false, traits: null, added: false, own: false }));
      return t;
    };
    // Only what DIFFERS from the chain (#1511): an absent field falls back to it (`foldMemberRowChannels`), so a
    // statement equal to the chain's only pins it — a later template change to that member never reached the scene.
    // Which of the frame's rows are live. `removed` lists only the TOP-most member the scene deleted, and a member
    // below it is gone too: a statement about one is unkeyable, and the frame fell back to the whole legacy slot
    // — the #1516 pin again (close-out review F4, and R1 for the `removed` channel itself).
    const liveLids = liveRowLocalIds(f.root, f.doc);
    for (const lid of new Set([...(live.removed ?? []), ...(base.removed ?? [])])) {
      if (!liveLids.has(lid) && !liveRemoved.has(lid)) continue; // went with a deleted member above it
      if (liveRemoved.has(lid) !== baseRemoved.has(lid)) touch(lid).removed = true;
    }
    // Removed traits per TRAIT (v17, #1516): `removedTraits` states the whole list and replaced the chain's, so a
    // scene removing one more trait pinned every name the chain removed beside it.
    for (const lid of new Set([...Object.keys(live.removedTraits ?? {}), ...Object.keys(base.removedTraits ?? {})].map(Number))) {
      if (!liveLids.has(lid)) continue; // the member is gone, and its traits with it
      const statements = traitRemovalStatements(live.removedTraits?.[lid], base.removedTraits?.[lid]);
      if (statements) touch(lid).traits = statements;
    }
    // Added nodes per NODE (v17, #1516): see `diffFrameAdded`. A member's list is restated whole (`added`) only
    // where it cannot be stated node by node.
    const diffNodes = (notAddressable?: ReadonlySet<string>) => frameAddedDiff(
      f.root, f.doc, base.added, live.added, liveLids, { againstRecords: opts.againstRecords, frameEdits: opts.frameEdits },
      { addressable: true, notAddressable },
    );
    let nodes = diffNodes();
    // An EDITED template reference node is stated by the rows reaching into it (#1914 R3b, the hub's end state B), so its
    // siblings and every part of it the scene did not change stay the template's. One that cannot be stated that way
    // falls back to its anchor's whole list, as every edited reference node did before B.
    const intoRefs = new Map<string, NodeRows>();
    const unstated = new Set<string>();
    for (const [k, r] of nodes.refs) {
      const rows = referenceNodeRows(r.live, r.chain, { template: opts.template, againstRecords: opts.againstRecords, frameEdits: opts.frameEdits });
      if (rows) intoRefs.set(k, rows); else unstated.add(k);
    }
    if (unstated.size) nodes = diffNodes(unstated);
    for (const lid of nodes.whole) touch(lid).added = true;
    for (const lid of nodes.own.keys()) if (!nodes.whole.has(lid)) touch(lid).own = true;
    if (!touched.size && !nodes.nodeRows.size && !intoRefs.size) return true;
    const keys = new Map<number, string>();
    for (const lid of touched.keys()) {
      const k = keyFor(f.root, f.doc, f.key, lid, !liveRemoved.has(lid));
      if (!k) break;
      keys.set(lid, k);
    }
    if (keys.size !== touched.size) return false;
    const writerForm = opts.template ? templateFormOf(live.added) : writerFormOf(live.added);
    // A scene-form whole list names each template copy by its key, so the load takes the values the copy does not state
    // from the chain node it replaces (#1914 R1, `pairWithBase`): the copy states its recorded values only.
    const listAdded = opts.template ? live.added ?? [] : stampTemplateKeys(live.added ?? []);
    for (const [lid, t] of touched) {
      const r = row(keys.get(lid)!);
      if (t.removed) r.removed = liveRemoved.has(lid);
      if (t.traits) r.traitRemovals = t.traits;
      if (t.added) r.added = listAdded.filter((n) => n.parentLocalId === lid).map((n) => ({ ...n, parentLocalId: 0 }));
      if (t.own) r.own = writerForm(nodes.own.get(lid)!);
    }
    for (const [nodeKey, nr] of nodes.nodeRows) {
      const k = `${f.key}/${nodeRowComponent(nodeKey)}`;
      out[k] = nr.own ? { ...nr, own: writerForm(nr.own) } : nr;
    }
    for (const [nodeKey, rows] of intoRefs) {
      if (!nodes.refs.has(nodeKey)) continue; // fell back with its anchor
      for (const [k, r] of Object.entries(rows.rows)) {
        const key = `${f.key}/${nodeRowComponent(nodeKey)}${k}`;
        out[key] = r;
        rowFrames.set(key, rows.frames.get(k)!);
      }
    }
    // A re-anchored template node a whole list pins (#1872): the list's copy carries the node's key (in scene form too,
    // since #1914 R1), and a row naming it would remove that copy too (the #1872 re-review): the load's fold replaces a
    // node the list names by key (`foldMemberRowChannels`). But only a node the list HOLDS is named by it: one this edit
    // deleted is in no list, so its removal is stated by the row in either form (third review).
    const listed = new Set(listAdded.map((n) => n.key).filter((k): k is string => !!k));
    for (const nodeKey of nodes.pinnedOver) {
      if (!listed.has(nodeKey)) out[`${f.key}/${nodeRowComponent(nodeKey)}`] = { removed: true };
    }
    return true;
  };
  if (ch.nestedStructure) {
    const keep: NestedStructurePaths = {};
    for (const [path, live] of Object.entries(ch.nestedStructure)) {
      const f = frameOf(path);
      // A move no row can carry (`unrowed`) means this frame already has a member no row can key.
      if (!f || Object.keys(live.moved ?? {}).length) { keep[path] = live; continue; }
      if (!stateFrame(f, live, chainLayer(rootId, source, f.steps, undefined, opts.seed).structure)) keep[path] = live;
    }
    legacy.nestedStructure = Object.keys(keep).length ? keep : undefined;
  }
  // A reference node's own frame (#1914 R3b): as a nested frame, against the chain node's lists at its root.
  const nodeUnstated = !!opts.asNode && !stateFrame({ root: rootId, doc: prefab, key: '', steps: [] }, opts.asNode.live, opts.asNode.base);

  const sorted: Record<string, SceneMemberRow> = {};
  for (const k of Object.keys(out).sort()) sorted[k] = out[k]!;
  return { channels: legacy, members: sorted, ...(nodeUnstated ? { nodeUnstated } : {}), ...(rowFrames.size ? { rowFrames } : {}) };
}

/** Rows reaching into a template reference node, keyed from the node, and the live root of the frame each applies in. */
interface NodeRows { rows: Record<string, SceneMemberRow>; frames: Map<string, number> }

/** The live root of the frame row `key` (of instance `root`'s key space, `keyOf`) applies in — `tokenizeRowMembers`'
 *  rule: a nested ROOT's row lands at that root, any other row in the frame its key less the last component names. */
export function rowFrameRoot(key: string, root: number, keyOf: ReadonlyMap<number, string>, frames: ReadonlyMap<string, { root: number }>): number {
  const byKey = new Map<string, number>();
  for (const { root: r } of frames.values()) { const k = keyOf.get(r); if (k) byKey.set(k, r); }
  return byKey.get(key) ?? byKey.get(key.slice(0, key.lastIndexOf('/'))) ?? root;
}

/** The key a reference node's ROOT row takes in {@link moveChannelsOntoRows}' `asNode` mode: not a row key (every one
 *  starts with `/`), so the caller can put it where the node's own node row goes. */
const NODE_ROOT = '.';

/** The rows a layer writes INTO template reference node `live` (a scene-form capture of it), stated over `chain`, the
 *  template node it was spawned from (#1914 R3b, the hub's end state B): keyed from the node — `''` for its root's row,
 *  `/<member>…` for its interior, `/a+<key>` for a node its chain adds — and each holding only what the scene recorded
 *  or changed, as a nested frame's rows do. Null when they cannot all be stated so (a statement no row can carry), and
 *  the caller falls back to restating the anchor's whole list.
 *
 *  The node's frame is measured against what its chain node states at its root (its localId channels with its member rows
 *  folded over them, as `frameBase` folds a template node's layer) and each nested frame against the chain seeded with
 *  that node (`chainLayer`'s seed, `nodeForward`) — the base the load gives it under the scene's rows, which the
 *  load folds after the node's own channels (`OVER_ROWS`). */
function referenceNodeRows(
  live: AddedEntity, chain: AddedEntity,
  opts: { template?: boolean; againstRecords?: boolean; frameEdits?: ReadonlyMap<number, FrameEdit> },
): NodeRows | null {
  const ecs = live.guid ? localToEcsGuid(live.guid) : 0;
  const source = live.prefab;
  const doc = ecs && source ? captureDoc(ecs, source) : null;
  if (!ecs || !source || !doc) return null;
  const lower = { overrides: chain.overrides, added: chain.added, removed: chain.removed, removedTraits: chain.removedTraits };
  const at = chain.members ? foldStructureLayers(doc, [{ rows: chain.members }], 0, lower).channels : lower;
  const seed = nodeForward(chain, doc);
  const structure = captureInstanceStructure(ecs, doc, { rows: true, readOnly: true, layerTraits: layerAddedTraits({ overrides: at.overrides ?? {} }, doc), againstRecords: opts.againstRecords, frameEdits: opts.frameEdits });
  // A move inside the node is the scene's identity statement, which these rows have no place for.
  if (Object.keys(structure.moved ?? {}).length || Object.keys(structure.unrowed ?? {}).length) return null;
  // The caller's edit of the node's frame (a Revert's reverted keys, #1880 F6), as `captureInstanceReference` makes it.
  const edit = opts.frameEdits?.get(ecs)?.overrides;
  const liveValues = captureNestedSceneDelta(ecs, doc, at.overrides);
  const values = edit ? edit(liveValues) : liveValues;
  const nested = captureNestedChannels(ecs, source, structure.ownedNested, { rows: true, readOnly: true, seed, againstRecords: opts.againstRecords, frameEdits: opts.frameEdits });
  const ch: InstanceChannels = {
    ...(Object.keys(values).length ? { overrides: values } : {}),
    nestedOverrides: nested.nestedOverrides, nestedStructure: nested.nestedStructure,
  };
  const r = moveChannelsOntoRows(ecs, doc, source, ch, {}, nested.frames, {
    seed, template: opts.template, againstRecords: opts.againstRecords, frameEdits: opts.frameEdits,
    asNode: { live: structure, base: { added: at.added ?? [], removed: at.removed ?? [], removedTraits: at.removedTraits ?? {} } },
  });
  const left = r.channels;
  if (r.nodeUnstated || left.overrides || left.removedTraits || left.removed || left.added || left.nestedOverrides || left.nestedStructure) return null;
  const rows: Record<string, SceneMemberRow> = {};
  const keyOf = memberRowKeysIn(ecs);
  const frames = new Map<string, number>();
  for (const [k, row] of Object.entries(r.members)) {
    const key = k === NODE_ROOT ? '' : k;
    rows[key] = row;
    frames.set(key, r.rowFrames?.get(k) ?? rowFrameRoot(key, ecs, keyOf, nested.frames));
  }
  return { rows, frames };
}

/** A nested instance captured as a reference: its source + per-instance diffs,
 *  plus the live ECS ids that belong to it (so a serializer can exclude them
 *  from a flat write). Shared by serializeScene + serializePrefab. */
export interface InstanceReference {
  source: string;
  overrides?: Record<number, Record<string, Record<string, unknown>>>;
  added?: AddedEntity[];
  removed?: number[];
  removedTraits?: Record<number, string[]>;
  /** The moves no member row carries ({@link InstanceStructure.unrowed}) — the legacy map. */
  moved?: Record<number, string>;
  /** All live members of this instance (PrefabInstance.rootInstanceId === root). */
  memberEcsIds: Set<number>;
  /** Added subtrees folded into `added` (their live ids — also skip on write). */
  consumedEcsIds: Set<number>;
  /** The row partition: owned nested root ecsId → the row it expands (see `captureNestedChannels`). */
  ownedNested: Map<number, number>;
}

/** Capture an instance as a reference for serialization: overrides + structural
 *  diffs against `prefab`, plus its member/consumed ECS ids. Returns `undefined`
 *  collections when empty so the written JSON stays minimal. */
export function captureInstanceReference(
  rootInstanceId: number,
  source: string,
  prefab: PrefabFile,
  opts: StructureCaptureOpts = {},
): InstanceReference {
  const edit = opts.frameEdits?.get(rootInstanceId);
  const liveOverrides = captureInstanceOverrides(rootInstanceId, prefab);
  const overrides = edit?.overrides ? edit.overrides(liveOverrides) : liveOverrides;
  const liveStructure = captureInstanceStructure(rootInstanceId, prefab, opts);
  const edited = edit?.structure ? edit.structure(liveStructure) : liveStructure;
  // The records the load kept as UNUSED for this root (#1914 R4), as the scene entry writer puts its own back: a scene
  // node's always, a template one's only where they were read from the template being written (`keepsTemplateRows`, the
  // #1293 gate R2's rows go through) or a bake carries them into it.
  const eaMeta = getTraitByName('EntityAttributes');
  const rootGuid = eaMeta ? durableGuid((readTraitData(rootInstanceId, eaMeta) as { guid?: string } | null)?.guid) : '';
  const keptFrom = !opts.template || keepsTemplateRows(rootInstanceId, rootGuid) || bakingKeptState ? rootGuid : '';
  const local = withKeptLocalRecords({ overrides, removedTraits: edited.removedTraits, removed: edited.removed, moved: edited.unrowed }, keptFrom, rootInstanceId, !!opts.template);
  const structure = { ...edited, removedTraits: local.removedTraits ?? {}, removed: local.removed ?? [], unrowed: local.moved };
  const memberEcsIds = new Set<number>();
  const PrefabInstanceMeta = getTraitByName('PrefabInstance');
  if (PrefabInstanceMeta) {
    getCurrentWorld().query(PrefabInstanceMeta.trait).updateEach(([pi], entity) => {
      if ((pi as Record<string, unknown>).rootInstanceId === rootInstanceId) memberEcsIds.add(entity.id());
    });
  }
  return {
    source,
    overrides: local.overrides && Object.keys(local.overrides).length ? local.overrides : undefined,
    added: structure.added.length ? structure.added : undefined,
    removed: structure.removed.length ? structure.removed : undefined,
    removedTraits: Object.keys(structure.removedTraits).length ? structure.removedTraits : undefined,
    moved: Object.keys(structure.unrowed ?? {}).length ? structure.unrowed : undefined,
    memberEcsIds,
    consumedEcsIds: liveStructure.consumedEcsIds,
    ownedNested: liveStructure.ownedNested,
  };
}

/** Scene-form added nodes rewritten into TEMPLATE form (#1387), recursively through `children`, a
 *  reference node's `added` and its `nestedStructure`: `guid` cleared (the bag's copy too), `members`
 *  dropped, and a `key` given — the live entity's own marker when it still has one, else a fresh one.
 *  Promotion is where a scene capture becomes a prefab row, so it is where the two forms meet.
 *
 *  ⚠️ **Every per-instance identity the scene form carries has to be dropped HERE, and the spread
 *  below does not do it for you.** `{ ...n }` passes through anything new on `AddedEntity`, so a field
 *  added to the scene form arrives in the template silently. Two were riding through, both found by
 *  the Phase 2B close-out reviews:
 *
 *  - **`members`** (scene v16, #1468) — a reference node's member rows are live scene guids, and a
 *    template carrying them hands every instance of that prefab the same ones (#1293).
 *  - **`moved`** — `Record<localId, live-parent GUID>`. `captureInstanceStructure`'s `noteMove` already
 *    refuses to write one into a template (*"its values would be live scene guids, which name
 *    nothing in the prefab's own space — nor, in another instance, anything of that instance"*), and
 *    this converter was the way one got in anyway. `promoteReferenceMoves` rescues the TOP promoted
 *    node's moves and `insertAddedSubtree` omits the field from the row it writes, so a reference
 *    node reached through `added`, `children` or a `nestedStructure` slot was the gap.
 *
 *  If you add a field to `AddedEntity`, decide here whether it is per-instance.
 *
 *  `declared`: the keys the document these nodes are PROMOTED into already declares. A promoted node is scene-added, so
 *  it is not one of that document's nodes, and a live marker naming one of those keys is stale (a Detach left the markers
 *  on the unpacked nodes until #1874; move one into another instance of the same prefab and Apply it there): carried, it
 *  was a second node with that key, and a keyed node's guid is its frame plus its key (#1809), so the two shared one.
 *  Such a node mints. A marker the document does not declare is the node's own identity (a deeper template's key) and
 *  is kept, as #1387 does so a re-save does not re-key. Every key written is added to `declared`, so two nodes of one
 *  promotion carrying the same marker (two detached copies of one template) do not both write it (close-out review). */
export function toTemplateNodes(nodes: AddedEntity[] | undefined, declared?: Set<string>): AddedEntity[] | undefined {
  if (!nodes) return nodes;
  return nodes.map((n) => {
    const live = n.guid ? localToEcsGuid(n.guid) : 0;
    const marker = live ? templateKeyOf(findEntity(live)) : '';
    const key = n.key || (marker && !declared?.has(marker) ? marker : '') || newGuid();
    declared?.add(key);
    const traits = { ...n.traits };
    const ea = traits['EntityAttributes'];
    if (ea && ea !== true && 'guid' in ea) { const { guid: _drop, ...rest } = ea; traits['EntityAttributes'] = rest; }
    const { members: _rows, moved: _moves, ...scene } = n;
    const out: AddedEntity = { ...scene, guid: '', key, traits, children: toTemplateNodes(n.children, declared) ?? [] };
    if (n.added) out.added = toTemplateNodes(n.added, declared);
    if (n.nestedStructure) out.nestedStructure = toTemplateStructure(n.nestedStructure, declared);
    return out;
  });
}

/** {@link toTemplateNodes}, exported for the guard that asserts a TEMPLATE carries no per-instance
 *  identity. Exported rather than made public because the function is an internal step of promotion
 *  and the test is about the invariant, not about the API. */
export const toTemplateNodesForTest = toTemplateNodes;

export function toTemplateStructure(paths: NestedStructurePaths | undefined, declared?: Set<string>): NestedStructurePaths | undefined {
  if (!paths) return paths;
  const out: NestedStructurePaths = {};
  // `moved` never enters a template: its values are live scene guids (the rule `toTemplateNodes` states).
  for (const [k, { moved: _moves, ...v }] of Object.entries(paths)) out[k] = v.added ? { ...v, added: toTemplateNodes(v.added, declared) } : v;
  return out;
}


/** `node` as a chain node states it, for comparing a live capture with the chain's own node. A REFERENCE node loses
 *  what a live capture adds that is identity, not an edit:
 *  - a member row's `guid`, unless a LIVE member holds it and does not derive it from the node's root. That one is an
 *    identity no reload reproduces — an earlier save stored it, or a Refresh kept it live, before the template
 *    re-parented the member — so it stays, and the node reads as edited and keeps it. Dropped, the node compared equal,
 *    the save left it to the template, and the member re-derived a new guid under every scene ref into it (close-out
 *    review). An ORPHAN row's guid (`keptMemberOrphans`: the template dropped the member) names nothing live, and
 *    keeping it pinned the node on every save, so it goes;
 *  - a member row's `name` (a row holding nothing else goes; a `parent`, a move, stays);
 *  - its own `name`, which no spawn applies (the root is named by the child prefab), so that goes from both sides;
 *  - its own `traits` and `children`, which no spawn reads either (`applyStructureCore` hands a reference node to
 *    `spawnNestedInstance` before its trait loop, and the one spawner, `spawnReferenceNode`, never walks its children; the root's pose rides in
 *    `overrides`). The live capture always writes them empty, so a template node that carried either (hand- or
 *    agent-written) never equalled it and was restated on every save, whole list and siblings with it (#1536).
 *  A `nestedStructure` slot's absent list is written as empty, which is how the loader reads it (`structDirect`).
 *  A template node's member rows are template-form (#1538: no guid), so without this every template reference node read
 *  as EDITED against a scene-form capture's: the rebuild respawned it from the capture, and the save restated it
 *  (#1511). Either way a template change to the node never reached the instance. A template node written by the
 *  template writer also differs from a scene-form capture in its slots and tokens, which `sameAddedNode` asks
 *  separately. Plain nodes pass through; their `children` and a reference node's `added` are walked. */
function withoutLiveIdentity(node: AddedEntity): AddedEntity {
  const walk = (list: AddedEntity[] | undefined) => list?.map(withoutLiveIdentity);
  if (!node.prefab) return { ...node, children: walk(node.children) ?? [] };
  const { name: _name, members, traits: _traits, children: _children, ...rest } = node as AddedEntity & { members?: Record<string, Record<string, unknown>> };
  const rows: Record<string, Record<string, unknown>> = {};
  if (members && Object.keys(members).length) {
    const stored = storedMemberGuids(node.guid);
    for (const [k, row] of Object.entries(members)) {
      const { guid, name: _n, ...edit } = row;
      if (typeof guid === 'string' && stored.has(guid)) edit.guid = guid;
      if (Object.keys(edit).length) rows[k] = edit;
    }
  }
  const slots = node.nestedStructure && Object.fromEntries(Object.entries(node.nestedStructure).map(([path, st]) =>
    [path, { ...st, added: st.added ?? [], removed: st.removed ?? [], removedTraits: st.removedTraits ?? {}, moved: st.moved ?? {} }]));
  return {
    ...rest, traits: {} as AddedEntity['traits'], children: [] as AddedEntity[], ...(node.added ? { added: walk(node.added) } : {}),
    ...(slots ? { nestedStructure: slots } : {}),
    ...(Object.keys(rows).length ? { members: rows } : {}),
  } as AddedEntity;
}

/** Whether live node `n` (a scene-form capture) states what only this INSTANCE states — a member guid the scene stored, a
 *  member it moved — which the template form has no place for, and neither do rows reaching into a reference node (#1914
 *  R3b). Asked of the scene-form side, which is where those live: on the node's member rows, its `moved`, and a nested
 *  slot's `moved` (a move no row can carry: a pre-v5 member, #1538 close-out review), at every depth. */
function holdsInstanceIdentity(
  n: AddedEntity,
  /** Count only a member row holding a STORED guid (`withoutLiveIdentity` keeps no other), not one holding edits: the
   *  rows reaching into a reference node state edits themselves (#1914 R3b). The comparison counts every row left. */
  guidsOnly = false,
): boolean {
  const recur = (m: AddedEntity) => holdsInstanceIdentity(m, guidsOnly);
  if (n.prefab) {
    const rows = Object.values(withoutLiveIdentity(n).members ?? {});
    if (guidsOnly ? rows.some((row) => typeof (row as { guid?: unknown }).guid === 'string') : rows.length) return true;
    if (Object.keys(n.moved ?? {}).length) return true;
    for (const st of Object.values(n.nestedStructure ?? {})) {
      if (Object.keys(st.moved ?? {}).length || (st.added ?? []).some(recur)) return true;
    }
  }
  return (n.children ?? []).some(recur) || (n.added ?? []).some(recur);
}

/** Does LIVE added node `live` (a plain capture, scene form) state what CHAIN node `chain` states? The one test both
 *  the rebuild (`subtractChainStructure`) and the writers' node diff (`nodeDiffDeps.sameReference`) ask.
 *
 *  First in scene form, as it always was. A chain node holding a TEMPLATE reference node (keyed, from a prefab file)
 *  is then asked again against the live node written as a template would write it: each reference node inside it
 *  re-captured by the template writer (`finishTemplateReferenceNode`, read-only). That writer omits an unchanged
 *  frame, states frames per member and holds tokens where the live side holds guids (#1538), so the scene-form
 *  capture — every non-empty frame whole, guids — never equalled the file, and every reference node a template
 *  authored read as EDITED: re-pinned by the next scene save and respawned by every rebuild. Either form matching is
 *  unchanged, so a file written before the template writer still compares as it did. */
function sameAddedNode(live: AddedEntity, chain: AddedEntity): boolean {
  const asSet = (n: AddedEntity) => ({ added: [withoutLiveIdentity(n)] });
  if (sameStructure(asSet(live), asSet(chain))) return true;
  const holdsTemplateRef = (n: AddedEntity): boolean => (!!n.prefab && !!n.key) || (n.children ?? []).some(holdsTemplateRef);
  const templateForm = (n: AddedEntity) => holdsTemplateRef(chain) && !holdsInstanceIdentity(live) && sameStructure(asSet(n === live ? liveAsTemplateRefs(live) : n), asSet(chain));
  if (templateForm(live)) return true;
  // #1781: a reference node's VALUES are compared by subtraction, not by spelling. The live capture measures the node's
  // frames against the bare documents, so a component the chain node's own statement ADDS comes out whole, schema
  // defaults included, and never equalled the sparse statement: the scene save pinned the node and a Refresh respawned
  // it from the live capture, so a template change to it never reached the instance. So: re-capture the live node over
  // the base SEEDED with the chain node's statement (`sameNodeValues`) and, when nothing is left, compare the rest.
  if (!live.prefab || live.prefab !== chain.prefab || !sameNodeValues(live, chain)) return false;
  const lv = withoutNodeValues(live);
  const cv = withoutNodeValues(chain);
  return sameStructure(asSet(lv), asSet(cv))
    || (holdsTemplateRef(chain) && !holdsInstanceIdentity(live) && sameStructure(asSet(withoutNodeValues(liveAsTemplateRefs(live))), asSet(cv)));
}

/** Does the live reference node `live` state no VALUE beyond what chain node `chain` states (#1781)? Every frame of its
 *  live instance is captured over the base the chain node's statement SEEDS (`nodeForward` → `chainLayer`), so the #1386
 *  rule applies over the whole layer: a field equal to the layer, or a default the layer's added component leaves
 *  unauthored, is the layer's (the loader builds it `meta.trait(authored)`). The seed comes from the CHAIN node, never
 *  the live root's record: on a Refresh the chain node is the new template's. Its root frame is measured against the
 *  node's `overrides` with its member rows folded in (the seed's fold at the empty path).
 *  ⚠️ Like the rebuild's own subtraction, it walks live fields: a statement a live field no longer shows is caught only
 *  through its override mark. */
function sameNodeValues(live: AddedEntity, chain: AddedEntity): boolean {
  const ecs = live.guid ? localToEcsGuid(live.guid) : 0;
  const doc = ecs ? captureDoc(ecs, live.prefab!) : null;
  if (!ecs || !doc) return false;
  const d = seededNodeDelta(ecs, live.prefab!, doc, chain);
  return !Object.keys(d.root).length && !Object.keys(d.nested).length && !d.removals;
}

/** What the live reference node `ecs` (an instance of `source`, expanded from `doc`) states beyond chain node `chain`'s
 *  statement (#1781): each frame captured over the base the statement SEEDS (`nodeForward` → `chainLayer`), so the #1386
 *  rule applies over the whole layer. `root`: the root frame's values, over the node's `overrides` with its member rows
 *  folded in (`rootLayer`, the seed's fold at the empty path); `nested`: each nested frame's, path-keyed; `removals`: the
 *  live node removed a component the statement adds, which no live field shows — the removed-components pass sees it only
 *  over the layer that adds it (`layerTraits`, #1676), so it is measured over the seeded layer and over the bare one, and a
 *  removal only the seeded capture finds is the node's own (#1790 close-out review F2). The ONE subtraction the comparison
 *  (`sameNodeValues`) and the template writer (`finishTemplateReferenceNode`, #1804) share. */
function seededNodeDelta(ecs: number, source: string, doc: PrefabFile, chain: AddedEntity): {
  seed: ForwardState; rootLayer: OverrideMap; root: OverrideMap; nested: NestedOverridePaths; removals: boolean;
} {
  const seed = nodeForward(chain, doc);
  const rootLayer = mergeOverrideMaps(chainLayer(ecs, source, [], doc, seed).overrides, chain.overrides ?? {});
  const root = captureNestedSceneDelta(ecs, doc, rootLayer);
  const bareRoot = captureInstanceStructure(ecs, doc, { readOnly: true });
  const seeded = captureNestedChannels(ecs, source, bareRoot.ownedNested, { readOnly: true, seed });
  const seededRoot = captureInstanceStructure(ecs, doc, { readOnly: true, layerTraits: layerAddedTraits({ overrides: rootLayer }, doc) });
  let removals = moreRemovals(seededRoot.removedTraits, bareRoot.removedTraits);
  if (!removals) {
    const bare = captureNestedChannels(ecs, source, bareRoot.ownedNested, { readOnly: true });
    removals = Object.entries(seeded.nestedStructure ?? {}).some(([path, st]) => moreRemovals(st.removedTraits, bare.nestedStructure?.[path]?.removedTraits));
  }
  return { seed, rootLayer, root, nested: seeded.nestedOverrides ?? {}, removals };
}

/** A template reference node's value channel as its writer states it over the node's own statement (#1804): of each field
 *  the capture measured against the BARE documents, only one the live node changed over the seeded base (`changed`,
 *  {@link seededNodeDelta}) or one the node's own layer states (`seeded`, where it differs from the layer without the node,
 *  `bare`). A component the statement adds was captured whole, every schema default with it, and the default is the
 *  layer's (#1386's rule): written, it rewrote the sparse statement on every no-edit save. A component the node removed is
 *  simply not in the capture. Values stay the capture's, tokenized as the writer tokenized them. */
function keepNodeStated(captured: OverrideMap | undefined, changed: OverrideMap | undefined, seeded: OverrideMap, bare: OverrideMap): OverrideMap | undefined {
  if (!captured) return captured;
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const out: OverrideMap = {};
  for (const [lidKey, traits] of Object.entries(captured)) {
    const lid = Number(lidKey);
    for (const [trait, fields] of Object.entries(traits)) {
      const ch = changed?.[lid]?.[trait];
      const st = seeded[lid]?.[trait];
      const bt = bare[lid]?.[trait];
      const stated = (f: string) => !!st && f in st && !(bt && f in bt && same(st[f], bt[f]));
      const kept: Record<string, unknown> = {};
      for (const [f, v] of Object.entries(fields)) if ((ch && f in ch) || stated(f)) kept[f] = v;
      // A component the node's statement ADDS stays, fields or none: `{UIFocusable: {}}` adds it at its defaults, and a
      // capture holding only defaults kept no field of it (close-out review). A tag the node changed stays too.
      if (Object.keys(kept).length || (st && !bt) || (!Object.keys(fields).length && ch)) (out[lid] ??= {})[trait] = kept;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/** Does `seeded` list a removed component per localId that `bare` does not? */
function moreRemovals(seeded: Record<number, string[]> | undefined, bare: Record<number, string[]> | undefined): boolean {
  return Object.entries(seeded ?? {}).some(([lid, names]) => names.some((n) => !(bare?.[Number(lid)] ?? []).includes(n)));
}

/** `node` without the channels {@link sameNodeValues} answers for: its `overrides`, `nestedOverrides` and each member row's
 *  `traits` (a row left with nothing else goes). */
function withoutNodeValues(node: AddedEntity): AddedEntity {
  const { overrides: _o, nestedOverrides: _n, members, ...rest } = node as AddedEntity & { members?: Record<string, Record<string, unknown>> };
  const rows: Record<string, Record<string, unknown>> = {};
  for (const [k, row] of Object.entries(members ?? {})) {
    const { traits: _t, ...other } = row;
    if (Object.keys(other).length) rows[k] = other;
  }
  return { ...rest, ...(Object.keys(rows).length ? { members: rows } : {}) } as AddedEntity;
}

/** `node` with every REFERENCE node in it (itself, or under a plain node's `children`) replaced by the template
 *  writer's read-only capture of the live instance it names — its identity left as the live capture's, so the
 *  comparison matches content, as `sameStructure` does for a scene-form side. A node whose instance is not live, or
 *  whose prefab is not cached, stays as it is (and so still differs, the safe direction). */
function liveAsTemplateRefs(node: AddedEntity): AddedEntity {
  if (!node.prefab) return { ...node, children: (node.children ?? []).map(liveAsTemplateRefs) };
  const ecs = node.guid ? localToEcsGuid(node.guid) : 0;
  const child = ecs ? getCachedPrefabSync(node.prefab) : null;
  if (!child) return node;
  const { channels } = finishTemplateReferenceNode(ecs, node.prefab, child, true);
  return { parentLocalId: node.parentLocalId, guid: node.guid, name: node.name, traits: {}, children: [], prefab: node.prefab, ...channels };
}

/** The guids the members of the live instance rooted at guid `rootGuid` hold that are NOT what they derive from it
 *  (`stampDerivedMemberGuids`' computation) — the ones a member row states that a reload would not reproduce. */
function storedMemberGuids(rootGuid: string): Set<string> {
  const out = new Set<string>();
  const anchor = durableGuid(rootGuid);
  const root = anchor ? findEntityByGuid(anchor) : undefined;
  const eaMeta = getTraitByName('EntityAttributes');
  if (!root || !eaMeta) return out;
  // A Missing Prefab placeholder has no members: what it carries is its record's rows (#1699), each guid stored by the
  // same rule. Read from the world, none was, so the record equalled the template node and the save dropped it (#1914 R4).
  const unresolved = unresolvedRefOf(root);
  if (unresolved?.kind === 'node') {
    for (const [key, row] of Object.entries((unresolved.record.members ?? {}) as Record<string, { guid?: unknown } | null>)) {
      const guid = row?.guid;
      if (key && typeof guid === 'string' && guid && !isMemberDerivation(guid, anchor, memberPathSteps(key))) out.add(guid);
    }
    return out;
  }
  for (const [key, e] of memberPathIndex(getCurrentWorld(), root.id())) {
    if (!key || !e) continue;
    const guid = (e.get(eaMeta.trait) as { guid?: string } | undefined)?.guid;
    // A salted derivation is one a reload reproduces too (#1882): not stored.
    if (guid && !isMemberDerivation(guid, anchor, memberPathSteps(key))) out.add(guid);
  }
  return out;
}

/** A chain node the rebuild keeps EDITED: its fresh copy gives way to the live one, found by template key or, for a
 *  legacy node, by its durable guid. */
export type KeptNodeReplace = { key: string; guid: string };

/** The structural half of the subtraction. `removed`/`removedTraits` lose what the chain lists. An
 *  `added` node the chain authored is recognised by its TEMPLATE KEY (a guid is derived per instance
 *  since #1387; a legacy key-less file node by the durable guid it carried): unchanged, it is dropped,
 *  since the fresh expansion spawns it and a refresh's edit to it must reach this instance; EDITED, it
 *  is kept and listed in `replace`, so the fresh copy gives way to it rather than sitting beside it.
 *
 *  ⚠️ A template node the scene DELETED still comes back HERE: with no live node there is nothing to
 *  match. Since v17 (#1516) the rebuild only uses this for a member whose list cannot be stated node by
 *  node; everywhere else `diffFrameAdded` states the deletion and `applyNodeRowsLive` honours it. */
export function subtractChainStructure(
  full: InstanceStructure,
  chain: { added?: AddedEntity[]; removed?: number[]; removedTraits?: Record<number, string[]>; moved?: Record<number, string> },
  keysByGuid: Map<string, string>,
): { structure: InstanceStructure; replace: KeptNodeReplace[] } {
  const byKey = new Map<string, AddedEntity>();
  const byGuid = new Map<string, AddedEntity>();
  for (const n of chain.added ?? []) {
    if (n.key) byKey.set(n.key, n);
    else if (durableGuid(n.guid)) byGuid.set(n.guid, n);
  }
  // #1779: a chain node with NEITHER — hand- or agent-written; no editor writer emits one — matched nothing, so its live
  // copy was re-applied as the scene's own over the fresh expansion's, and every rebuild spawned it twice. A live node
  // with no template key now pairs with an unused chain node of that kind with the same name that it EQUALS
  // (`sameAddedNode`, as any chain node is compared: children included), and is dropped: the fresh copy is it. Nothing derived from the pairing is stamped or saved, so no scene statement can be keyed on it and re-target
  // when the template changes. ⚠️ An EDITED one is not paired: it has no identity to find its fresh copy by, and three
  // attempts to find it after the spawn (id order, the chain node's content) each deleted an untouched sibling's copy
  // (close-out reviews). So it keeps its edit with the fresh copy beside it, as before (#1810).
  // Each chain node absorbs ONE live copy, the one its fresh expansion replaces: a scene node written with `guid: ''` is
  // captured guid-less too, and one equal to the template's was dropped with it — gone for good once saved (close-out
  // re-review). A scene duplicate holds a durable guid and equals none.
  const unkeyedChain = (chain.added ?? []).filter((n) => !n.key && !durableGuid(n.guid) && n.name);
  const usedUnkeyed = new Set<AddedEntity>();
  const sameUnkeyed = (node: AddedEntity): boolean => {
    if (node.guid && keysByGuid.get(node.guid)) return false;
    const base = unkeyedChain.find((c) => !usedUnkeyed.has(c) && c.name === node.name && sameAddedNode(node, c));
    if (base) usedUnkeyed.add(base);
    return !!base;
  };
  const added: AddedEntity[] = [];
  const replace: KeptNodeReplace[] = [];
  for (const node of full.added) {
    const key = node.guid ? keysByGuid.get(node.guid) : undefined;
    const base = (key ? byKey.get(key) : undefined) ?? (node.guid ? byGuid.get(node.guid) : undefined);
    if (!base) { if (!sameUnkeyed(node)) added.push(node); continue; }
    if (sameAddedNode(node, base)) continue;
    added.push(node);
    replace.push({ key: base.key ? key! : '', guid: node.guid });
  }
  const chainRemoved = new Set(chain.removed ?? []);
  const removedTraits: Record<number, string[]> = {};
  for (const [lid, names] of Object.entries(full.removedTraits)) {
    const chainNames = new Set(chain.removedTraits?.[Number(lid)] ?? []);
    const own = names.filter((n) => !chainNames.has(n));
    if (own.length) removedTraits[Number(lid)] = own;
  }
  return {
    structure: { ...full, added, removed: full.removed.filter((l) => !chainRemoved.has(l)), removedTraits },
    replace,
  };
}

/** guid → template key of each captured `added` node (and, `deep`, of each node in their `children`): the live
 *  marker, else the key its derived guid recovers (Play→Stop, an undo respawn). Read only — nothing is minted or
 *  stamped, unlike a template-form capture. `intoReferences`: also every node a reference node carries (its `added`,
 *  its slots' and its rows' nodes) — for a rebuild that respawns the whole node (#1567 close-out re-review). */
export function liveTemplateKeys(nodes: readonly AddedEntity[], deep = false, intoReferences = false): Map<string, string> {
  const out = new Map<string, string>();
  const memo = new Map<number, string>();
  const walk = (list: readonly AddedEntity[]) => {
    for (const n of list) {
      const e = n.guid ? findEntityByGuid(n.guid) : undefined;
      const key = e ? (templateKeyOf(e as Parameters<typeof templateKeyOf>[0]) || recoverTemplateKey(e.id(), memo)) : '';
      if (key) out.set(n.guid, key);
      // The flags choose which nodes the walk ENTERS, never which channels (#1880 F3b, `nodeChannels`): `deep` a plain
      // (template) node, whose children carry keys too and which v17 node rows address (#1516); `intoReferences` a
      // reference node.
      if (n.prefab ? intoReferences : deep) for (const list of nodeChannels(n)) walk(list);
    }
  };
  walk(nodes);
  return out;
}

/** Scene-form `nodes` with the template key each live copy holds (`liveTemplateKeys`), at every depth and inside
 *  reference nodes (#1914 R1): a whole list the scene writes names its template copies, so the load pairs each with the
 *  chain node it replaces (`pairWithBase`). A node the scene added itself holds no key and gets none. */
function stampTemplateKeys(nodes: readonly AddedEntity[]): AddedEntity[] {
  const keys = liveTemplateKeys(nodes, true, true);
  if (!keys.size) return nodes as AddedEntity[];
  const stamp = (list: AddedEntity[]): AddedEntity[] => list.map((n) => {
    const node = mapNodeChannels(n, stamp);
    const key = n.guid ? keys.get(n.guid) : undefined;
    const keyed = key && !node.key ? { ...node, key } : node;
    return keyed.key ? withBaseRemovals(keyed) : keyed;
  });
  return stamp(nodes as AddedEntity[]);
}

/** Keyed scene-form reference copy `n`, restated against the BASE the load gives it (#1914 R1, `pairWithBase`) for the
 *  components only that base adds — a chain node's statement adding one its document lacks. The copy's own channels
 *  were captured against its document, where such a component is an added one and comes out whole, pinned, and recorded
 *  by the next load; a removal of one was stated by omitting the base's values, which now come back. So for each:
 *  - still live → only its RECORDED fields, as for any other component (the rest are the base's, unrecorded);
 *  - gone → a removal: the root's in the copy's `removedTraits`, a member's in its row's `traitRemovals`. Both apply
 *    after the values, so they win.
 *  A member with no row is left as it is. */
function withBaseRemovals(n: AddedEntity): AddedEntity {
  const piMeta = getTraitByName('PrefabInstance');
  if (!n.prefab || !n.guid || !piMeta) return n;
  const rowOf = new Map<string, string>();
  for (const [k, r] of Object.entries(n.members ?? {})) {
    const g = (r as SceneMemberRow | null)?.guid;
    if (g) rowOf.set(g, k);
  }
  const bases = new Map<number, ReturnType<typeof frameBase>>();
  let { members, removedTraits, overrides } = n;
  for (const guid of [n.guid, ...rowOf.keys()]) {
    const e = findEntityByGuid(guid);
    const pi = e ? readTraitData(e.id(), piMeta) as { rootInstanceId?: number; localId?: number } | null : null;
    const frame = pi?.rootInstanceId;
    if (!e || !pi?.localId || !frame) continue;
    if (!bases.has(frame)) bases.set(frame, frameBase(frame));
    const fb = bases.get(frame);
    const given = fb?.layer?.overrides[pi.localId];
    if (!given) continue;
    const own = fb.doc ? rowAt(fb.doc, pi.localId)?.traits : undefined;
    const baseAdded = Object.keys(given).filter((t) => own?.[t] === undefined && !!getTraitByName(t));
    if (!baseAdded.length) continue;
    const gone = baseAdded.filter((t) => !e.has(getTraitByName(t)!.trait));
    const marks = getOverrideMarkSet(e as Parameters<typeof getOverrideMarkSet>[0]);
    // The copy's statement of each live one, cut to its recorded fields.
    const cut = (bag: Record<string, Record<string, unknown>> | undefined) => {
      if (!bag) return bag;
      let out = bag;
      for (const t of baseAdded) {
        const fields = bag[t];
        if (!fields || typeof fields !== 'object' || gone.includes(t)) continue;
        const kept = Object.fromEntries(Object.entries(fields).filter(([f]) => marks?.has(`${t}.${f}`)));
        out = { ...out };
        if (Object.keys(kept).length) out[t] = kept;
        else delete out[t];
      }
      return out === bag ? bag : out;
    };
    if (guid === n.guid) {
      const at = overrides?.[pi.localId];
      const next = cut(at as Record<string, Record<string, unknown>> | undefined);
      if (next !== at) {
        overrides = { ...overrides };
        if (next && Object.keys(next).length) overrides[pi.localId] = next;
        else delete overrides[pi.localId];
      }
      if (gone.length) removedTraits = { ...removedTraits, [pi.localId]: [...new Set([...(removedTraits?.[pi.localId] ?? []), ...gone])] };
    } else {
      const k = rowOf.get(guid)!;
      const row = members![k] as SceneMemberRow;
      const traits = cut(row.traits as Record<string, Record<string, unknown>> | undefined);
      if (traits === row.traits && !gone.length) continue;
      const next: SceneMemberRow = { ...row };
      if (traits && Object.keys(traits).length) next.traits = traits;
      else delete next.traits;
      if (gone.length) next.traitRemovals = { ...row.traitRemovals, ...Object.fromEntries(gone.map((t) => [t, true])) };
      members = { ...members, [k]: next };
    }
  }
  if (members === n.members && removedTraits === n.removedTraits && overrides === n.overrides) return n;
  const out: AddedEntity = { ...n, members, removedTraits, overrides };
  if (!overrides || !Object.keys(overrides).length) delete out.overrides;
  return out;
}

/** For the scene writer (#1511, #1516): how nested frame `frameRoot`'s (document `doc`) live `added` nodes differ
 *  from the ones the prefab chain adds there (`chainAdded`, the frame's baseline) — node by node, field by field
 *  (`diffFrameAdded`). `liveAdded` is the writer's own capture, read only to skip a frame with nothing on either
 *  side; `skip` holds the members the scene removed, whose chain nodes go with them and need no statement.
 *
 *  Asked the way the rebuild asks it (`subtractChainStructure`): the live capture in plain scene form, so a
 *  reference node carries the same localId channels a template node does, matched to a chain node by template key,
 *  with the chain's member tokens resolved to the guids the live side holds. */
function frameAddedDiff(
  frameRoot: number, doc: PrefabFile, chainAdded: AddedEntity[] | undefined, liveAdded: AddedEntity[] | undefined, liveLids: ReadonlySet<number>,
  /** A rebuild's comparison (`StructureCaptureOpts`): a reference node captured against its own record, so a stale
   *  template node reads as the chain's node rather than as one the scene edited; and the caller's edits of frames. */
  rebuild: { againstRecords?: boolean; frameEdits?: ReadonlyMap<number, FrameEdit> } = {},
  /** Whether an edited reference node may be stated by rows reaching into it (#1914 R3b, `diffFrameAdded`'s `refs`) — the
   *  scene form only — and the template keys the caller found it cannot state that way after all. */
  refs: { addressable?: boolean; notAddressable?: ReadonlySet<string> } = {},
): FrameAddedDiff {
  const resolved = resolveAddedNodeTokens(baseTokenResolver(frameRoot), chainAdded) ?? [];
  const chain = chainNodesAsPlaced(resolved, doc, liveLids);
  if (!chain.length && !liveAdded?.length) return { nodeRows: new Map(), own: new Map(), whole: new Set(), refs: new Map(), pinnedOver: new Set() };
  // …with the caller's edit of THIS frame made in it, as the writer made it in `liveAdded` (#1880 F6 close-out review F1):
  // read live alone, a Revert's reverted node was stated again and the load spawned it back.
  const live = captureInstanceStructure(frameRoot, doc, rebuild);
  const edit = rebuild.frameEdits?.get(frameRoot)?.structure;
  const full = edit ? edit(live) : live;
  const deps = nodeDiffDeps(liveTemplateKeys(full.added, true));
  if (refs.addressable) deps.addressable = (l, c) => !refs.notAddressable?.has(c.key ?? '') && !holdsInstanceIdentity(l, true);
  return diffFrameAdded(full.added, chain, deps, reanchoredKeys(resolved, doc));
}

/** The live-world answers `diffFrameAdded` asks for, shared by the save (`frameAddedDiff`) and the writers' node diff
 *  so they cannot disagree about what counts as an edit (a rebuild loads what the save states, #1880 F7d). `keys` maps a
 *  captured node's guid to its template key ({@link liveTemplateKeys}, deep). */
export function nodeDiffDeps(keys: ReadonlyMap<string, string>): NodeDiffDeps {
  return {
    keyOf: (n) => keys.get(n.guid) ?? '',
    defaultOf: (t, field) => {
      const d = (getTraitByName(t)?.trait as { schema?: Record<string, unknown> } | undefined)?.schema?.[field];
      return typeof d === 'function' ? (d as () => unknown)() : d;
    },
    sameReference: sameAddedNode,
    // The live node's own record (#1914 R3a): what the save writes of a template node's fields, and all it writes.
    recordedOf: (n) => {
      const e = n.guid ? findEntity(localToEcsGuid(n.guid)) : undefined;
      return new Set(e ? getOverrideMarkSet(e) ?? [] : []);
    },
  };
}

/** The chain's nodes where the LOADER puts them in frame document `doc` (#1516, close-out review F3/F4): a node whose
 *  anchor row the document no longer has is re-anchored to the root, as `applyStructureCore` re-anchors it — else
 *  the diff looks for it under the missing anchor and reads the loader's re-anchor as the scene's re-parent — and a
 *  node whose anchor is not live (the scene deleted that member, or one above it) is left out: it went with its
 *  member, and needs no statement. Placed by `placedAnchor` (#1872); a whole list pinned over a re-anchored node states
 *  that it covers it ({@link reanchoredKeys}, `diffFrameAdded`'s `pinnedOver`), since the load's fold replaces only what
 *  the template anchors there. */
export function chainNodesAsPlaced(chain: readonly AddedEntity[], doc: PrefabFile, liveLids: ReadonlySet<number>): AddedEntity[] {
  return chain
    .map((n) => { const at = placedAnchor(doc, n.parentLocalId); return at === n.parentLocalId ? n : { ...n, parentLocalId: at }; })
    .filter((n) => liveLids.has(n.parentLocalId));
}

/** The keys of the chain's nodes the load RE-ANCHORS in frame document `doc` — their anchor row is gone, so
 *  `placedAnchor` puts them at the root. `diffFrameAdded` reports such a node as `pinnedOver` when a whole list pins it,
 *  since the load's fold replaces only the nodes the template anchors at the list's own member (#1872). */
export function reanchoredKeys(chain: readonly AddedEntity[], doc: PrefabFile): Set<string> {
  const out = new Set<string>();
  for (const n of chain) if (n.key && placedAnchor(doc, n.parentLocalId) !== n.parentLocalId) out.add(n.key);
  return out;
}

/** v17 per-trait removal statements (#1516): `true` for a trait the scene removes that the chain does not, `false`
 *  for one the chain removes that the scene put back. Null when the two lists name the same traits. */
function traitRemovalStatements(live: string[] | undefined, chain: string[] | undefined): Record<string, boolean> | null {
  const l = new Set(live ?? []);
  const c = new Set(chain ?? []);
  const out: Record<string, boolean> = {};
  for (const t of l) if (!c.has(t)) out[t] = true;
  for (const t of c) if (!l.has(t)) out[t] = false;
  return Object.keys(out).length ? out : null;
}

/** Maps plain-capture nodes (what `frameAddedDiff` matched) to the WRITER's capture of the same entity, found by
 *  guid anywhere in `writer`'s trees — the form a scene row stores (a reference node carries its member rows there,
 *  which the plain capture does not). `parentLocalId` is written as 0: a row names the anchor. */
export function writerFormOf(writer: readonly AddedEntity[] | undefined): (nodes: readonly AddedEntity[]) => AddedEntity[] {
  const byGuid = new Map<string, AddedEntity>();
  const index = (list: readonly AddedEntity[] | undefined) => {
    for (const n of list ?? []) { if (n.guid) byGuid.set(n.guid, n); index(n.children); }
  };
  index(writer);
  return (nodes) => nodes.map((n) => ({ ...(byGuid.get(n.guid) ?? n), parentLocalId: 0 }));
}

/** {@link writerFormOf} for a prefab ROW's rows (#1533): the TEMPLATE capture of the same entity, found by the template
 *  key the capture stamped on it (`addedNodeIdentity`) — a template node has no guid to find it by. A node the capture
 *  did not reach (none known) is converted as promotion converts one (`toTemplateNodes`). */
function templateFormOf(template: readonly AddedEntity[] | undefined): (nodes: readonly AddedEntity[]) => AddedEntity[] {
  const byKey = new Map<string, AddedEntity>();
  const index = (list: readonly AddedEntity[] | undefined) => {
    for (const n of list ?? []) { if (n.key) byKey.set(n.key, n); index(n.children); }
  };
  index(template);
  return (nodes) => nodes.map((n) => {
    const live = n.guid ? localToEcsGuid(n.guid) : 0;
    // The marker, else the key its guid recovers: a comparison's read-only capture recovers a lost key without
    // stamping it, so the marker alone would miss the node and mint a key no chain node has (#1538 close-out review).
    const key = live ? templateKeyOf(findEntity(live)) || recoverTemplateKey(live) : '';
    const found = key ? byKey.get(key) : undefined;
    return { ...(found ?? toTemplateNodes([n])![0]!), parentLocalId: 0 };
  });
}

/** `nodes` with their member tokens resolved by `resolve` (`baseTokenResolver`), for comparing with a live capture,
 *  which holds guids. A REFERENCE node's payload is in its own instance's frame, so it is left whole, as
 *  `rebaseAddedTokens` leaves it (#1386 review). */
export function resolveAddedNodeTokens(resolve: (v: unknown) => unknown, nodes: AddedEntity[] | undefined): AddedEntity[] | undefined {
  return nodes?.map((n) => (n.prefab ? n : {
    ...n, traits: resolve(n.traits) as AddedEntity['traits'], children: resolveAddedNodeTokens(resolve, n.children) ?? [],
  }));
}
