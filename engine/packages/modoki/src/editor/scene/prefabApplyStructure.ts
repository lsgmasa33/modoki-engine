/** Apply's structural writes into a template: inserting an added subtree, promoting reference moves, and carrying
 *  promoted guids.
 *  Moved out of `prefab.ts` by the prefab.ts split (#1656 § Plan, step 5): a pure move. */

import { getCurrentWorld } from '../../runtime/core/ecs/world';
import { remapWorldGuidRefs, applyGuidRemap, identityTree, type IdentityTree } from '../../runtime/core/ecs/memberHome';
import { worldIdentityParents, identitySubtree, linkOwnerBeforeMove } from '../../runtime/core/ecs/identityParents';
import { memberRowKeysIn, memberRowsIn, memberRowsToWrite, rowWritingRoot } from '../../runtime/core/ecs/memberRows';
import { REF_FIELDS_BY_TRAIT } from '../../runtime/loaders/sceneValidation';
import { getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { getAllEntities, deleteEntities, markStructureDirty, readTraitData, writeTraitField } from '../../runtime/core/ecs/entityUtils';
import { newGuid } from '../../runtime/loaders/assetManifest';
import { durableGuid, memberStepId, memberPathSteps, isStoredRoot, isOwnedRoot, type MemberPi } from '../../runtime/core/assetRefRules';
import { PREFAB_FORMAT_VERSION } from '../../runtime/core/version';
import type { AddedEntity, NestedStructurePaths, SceneMemberRow } from '../../runtime/loaders/loadSceneFile';
import { memberPathIndex } from '../../runtime/loaders/loadSceneFile';
import { type TemplateValueWriter } from './prefabTemplateValue';
import { memberToken, memberPathKey, type MemberStep } from '../../runtime/core/templateRefs';
import { guidForEntityId, isTemplateExcludedField, localToEcsGuid, type PrefabFile } from './prefab';
import { getCachedPrefabSync } from './prefabCache';
import { withKeptStateBake } from './prefabTokens';
import { captureInstanceReference, captureRowChannels, toTemplateNodes, toTemplateStructure } from './prefabCapture';

/** Insert an added subtree into `prefab` with fresh localIds (continuing the BFS
 *  counter). The subtree root's parentId(localId) is set to `parentLocalId`;
 *  nested children point at their freshly-minted parent localId. guid is cleared
 *  (a prefab is a template). `nextId` is a mutable counter shared across calls. */
export function insertAddedSubtree(
  prefab: PrefabFile,
  node: AddedEntity,
  parentLocalId: number,
  nextId: { v: number },
  /** Filled with each promoted node's live guid → the row it became, for a move into it (#1437). */
  rows?: Map<string, number>,
  /** Filled with each promoted REFERENCE node's live guid → the nested row it became (#1660). */
  refRows?: Map<string, number>,
  /** The written frame's template-value writer (#1659): each promoted node's path is registered with it here, and
   *  every row this inserts is listed in `promoted` for the pass that tokenizes them once every node has a path. */
  tokens?: {
    writer: TemplateValueWriter; pathOfRow: (lid: number) => MemberStep[] | undefined; rowPaths: Map<number, MemberStep[]>;
    promoted: { row: PrefabFile['entities'][number]; at: number }[];
    /** A dry run (#1736): the re-capture below reads each node's template key and never stamps one on the live world. */
    readOnly?: boolean;
  },
): void {
  const myLocalId = nextId.v++;
  const parentPath = tokens?.pathOfRow(parentLocalId);
  const myPath = parentPath ? [...parentPath, myLocalId] : undefined;
  // Recorded before the children: a promoted node's promoted children hang under THIS row.
  if (myPath) tokens!.rowPaths.set(myLocalId, myPath);

  // Reference node (a user-added nested instance) → write a nested-instance ROW,
  // mirroring serializePrefab. Its members come from the child prefab; its diffs
  // ride in the row's overrides/structure. The file becomes v2.
  if (node.prefab) {
    // The row's nested frames are stated as a prefab-edit save states them (#1533) — per member, an unchanged frame
    // omitted — re-captured from the live instance: the node itself was captured in SCENE form, every frame whole,
    // and copied onto the row it pinned what the inner prefabs put there (MID's added node, beside a Leaf the scene
    // deleted, stopped following MID). Its `added` comes from the same template capture, so a reference node nested
    // in it is written by the template writer too (#1538) rather than converted from its scene form. At EVERY depth:
    // a reference node under a promoted plain node's `children` reaches this branch through the recursion below.
    const liveEcs = node.guid ? localToEcsGuid(node.guid) : 0;
    const liveChild = liveEcs ? getCachedPrefabSync(node.prefab) : null;
    let recaptured: { added?: AddedEntity[]; nestedStructure?: NestedStructurePaths; members?: Record<string, SceneMemberRow> } | undefined;
    if (liveChild) {
      const ref = captureInstanceReference(liveEcs, node.prefab, liveChild, { template: true, readOnly: tokens?.readOnly });
      // The node is a SCENE root, and what R2 kept for it (orphan member rows, legacy channels no frame reaches) is Unity's
      // unused overrides, which travel into the template with it: baked as Create Prefab bakes them (#1802, owner ruling D).
      // Their identity stays in the scene: `settleSwallowedKeptState`, after the Apply's refresh.
      const rc = withKeptStateBake(true, () => captureRowChannels(liveEcs, node.prefab!, liveChild, ref, false, !!tokens?.readOnly));
      recaptured = { added: ref.added, nestedStructure: rc.nestedStructure, members: rc.members };
    }
    const refRow: PrefabFile['entities'][number] = {
      localId: myLocalId,
      // A row that did not exist a moment ago: Apply promoted an added node into the template, so it
      // is a genuinely NEW node and mints (#1468). Nothing in the instance it came from held a
      // template identity for it — that is what "added" means.
      nodeGuid: newGuid(),
      name: node.name,
      traits: { EntityAttributes: { name: node.name, parentId: parentLocalId, guid: '' } },
      prefab: node.prefab,
      overrides: node.overrides,
      // The node was captured in SCENE form (live guids); a prefab row is a template (#1387).
      added: recaptured ? recaptured.added : toTemplateNodes(node.added),
      removed: node.removed,
      removedTraits: node.removedTraits,
      // Both nested channels travel with the node (#1381): the node was the outermost layer for its
      // own nested rows, and once promoted the ROW is — so its slot becomes the row's.
      nestedOverrides: node.nestedOverrides,
      nestedStructure: recaptured ? recaptured.nestedStructure : toTemplateStructure(node.nestedStructure),
      ...(recaptured?.members ? { members: recaptured.members } : {}),
    };
    prefab.entities.push(refRow);
    if (prefab.version < PREFAB_FORMAT_VERSION) prefab.version = PREFAB_FORMAT_VERSION;
    if (node.guid) refRows?.set(node.guid, myLocalId);
    if (tokens) {
      if (node.guid && myPath) tokens.writer.promote(node.guid, myPath);
      // Its overrides are values in its OWN frame (the loader applies a row's values there, #1352).
      tokens.promoted.push({ row: refRow, at: liveEcs });
    }
    return;
  }

  const traits: Record<string, Record<string, unknown> | boolean> = {};
  for (const [name, data] of Object.entries(node.traits)) {
    if (name === 'PrefabInstance') continue;
    if (data === true) { traits[name] = true; continue; }
    // RE-EXPAND to the full schema on the way INTO a prefab. A scene's `added` bag is COMPACTED
    // (a field at its schema default is omitted — see snapshotAddedTraits), but a prefab FILE is
    // deliberately written FULL by serializePrefab, and the reason is a real consumer rather than
    // taste: Court's `layoutFromPrefabDoc` reads prefab fields BY NAME and its `num()` helper
    // returns null for a missing one, so the caller silently falls back to code constants. An
    // authored value that merely HAPPENS to equal its default would read as "not authored".
    //
    // Promotion is the one place the two conventions meet, so it is the one place that has to
    // convert. Without this, a child promoted out of an instance would land compacted beside
    // members written full — the same prefab file in two shapes, and only the promoted rows
    // misread. (Before compaction existed this was consistent by accident, which is exactly how a
    // change like that introduces a bug two subsystems away.)
    const meta = getTraitByName(name);
    const schema = (meta?.trait as { schema?: Record<string, unknown> } | undefined)?.schema;
    const bag: Record<string, unknown> = schema && typeof schema === 'object'
      ? { ...schema, ...(data as Record<string, unknown>) }   // AoS (function schema) stays as-is
      : { ...(data as Record<string, unknown>) };
    // Then the same two subtractions serializePrefab applies, or promotion would smuggle in what
    // a template must not carry: runtime read-back / scene-only fields, and BLANK asset refs
    // (`authoredAssetRefs.test.ts` fails the build on those, #53).
    if (meta) {
      for (const key of Object.keys(bag)) if (isTemplateExcludedField(meta, key)) delete bag[key];
      for (const field of REF_FIELDS_BY_TRAIT[name] ?? []) if (bag[field] === '') delete bag[field];
    }
    traits[name] = bag;
  }
  let ea = traits['EntityAttributes'];
  if (!ea || ea === true) { ea = {}; traits['EntityAttributes'] = ea; }
  (ea as Record<string, unknown>).parentId = parentLocalId;
  (ea as Record<string, unknown>).guid = '';
  const plainRow = { localId: myLocalId, nodeGuid: newGuid(), name: node.name, traits };
  prefab.entities.push(plainRow);
  // A PLAIN row only: a reference node's row is a nested instance, whose children are another frame.
  if (node.guid) rows?.set(node.guid, myLocalId);
  if (tokens) {
    if (node.guid && myPath) tokens.writer.promote(node.guid, myPath);
    tokens.promoted.push({ row: plainRow, at: tokens.writer.root });
  }
  for (const child of node.children) insertAddedSubtree(prefab, child, myLocalId, nextId, rows, refRows, tokens);
}

/** A live entity a promotion's delete must NOT take, and where it hung: a member of a frame outside the promoted nodes
 *  that was dragged under one of them (#1682). */
interface PromotionSurvivor { id: number; guid: string; parentGuid: string }

/** Delete the live entities of the promoted `+added` nodes `roots` before the refresh re-expands their rows — their
 *  IDENTITY subtree (`identitySubtree`, I6), not the live one (#1682):
 *  - a member of a frame OUTSIDE them dragged under one of them is not theirs: the delete took it, and the refresh's
 *    capture (against the old document) saved it as REMOVED. It is parked at the scene root instead, where the capture
 *    reads it as moved and keeps its pose as values, and {@link rehangPromotionSurvivors} puts it back.
 *  - a member of a frame INSIDE them dragged out of them is theirs, at any depth: the refresh re-expands it, and a
 *    live delete left the original beside its twin. (Only a top-level reference node's own frames were consulted
 *    before — `membersLivingOutside`.)
 *  Returns the survivors, read before anything is deleted. */
export function deletePromotedNodes(roots: readonly number[]): PromotionSurvivor[] {
  if (!roots.length) return [];
  const eaMeta = getTraitByName('EntityAttributes');
  const world = getCurrentWorld();
  const doomed = new Set(identitySubtree(world, roots));
  const all = getAllEntities();
  const guidOf = new Map(all.map((e) => [e.id, e.guid ?? '']));
  const survivors: PromotionSurvivor[] = [];
  for (const e of all) {
    if (doomed.has(e.id) || !doomed.has(e.parentId)) continue;
    survivors.push({ id: e.id, guid: guidOf.get(e.id) ?? '', parentGuid: guidOf.get(e.parentId) ?? '' });
    if (eaMeta) writeTraitField(e.id, eaMeta, 'parentId', 0);
  }
  if (survivors.length) markStructureDirty();
  deleteEntities([...doomed]);
  return survivors;
}

/** Hang each {@link PromotionSurvivor} back under the node it was dragged under — now the member the promotion made of
 *  it, found by the guid the carry gave back, or the one the refs followed to (`follow`, old → derived). A survivor the
 *  refresh rebuilt is found by its guid; one whose parent is gone for good stays where the refresh put it, which is
 *  inside its own instance (its template parent), never the scene root it was parked at. Already there — its move was
 *  applied with the addition, so the template now puts it there — it is left alone. */
export function rehangPromotionSurvivors(survivors: readonly PromotionSurvivor[], follow: ReadonlyMap<string, string>): void {
  const eaMeta = getTraitByName('EntityAttributes');
  if (!survivors.length || !eaMeta) return;
  const live = new Map(getAllEntities().filter((e) => e.guid).map((e) => [e.guid!, e]));
  const identity = worldIdentityParents(getCurrentWorld());
  let moved = false;
  for (const s of survivors) {
    const self = s.guid ? live.get(s.guid) : undefined;
    if (!self) continue;
    const to = live.get(follow.get(s.parentGuid) ?? s.parentGuid)?.id ?? (self.parentId ? 0 : identity.parentOf(self.id));
    if (!to || to === self.id || to === self.parentId) continue;
    linkOwnerBeforeMove(getCurrentWorld(), self.id);
    writeTraitField(self.id, eaMeta, 'parentId', to);
    moved = true;
  }
  if (moved) markStructureDirty();
}

/** Rows of `prefab` whose member lives under another parent: the instance's own moves (`instanceMoved`, keyed by
 *  row) and the prefab's own moves of a ROW (a member path of rows only, ending in that row). */
export function movedRowsOf(prefab: PrefabFile, instanceMoved: Record<number, string>): Set<number> {
  const out = new Set(Object.keys(instanceMoved).map(Number));
  const rows = new Map(prefab.entities.map((e) => [e.localId, e]));
  for (const key of Object.keys(prefab.moved ?? {})) {
    // Every step before the last a plain row: the path stays in this prefab's frame, and ends at a row.
    const steps = memberPathSteps(key);
    const last = steps[steps.length - 1];
    // Rows only: a `'+key'` step is a template-added node, not a row, and disqualifies the path — as
    // its `NaN` did before the shared parse (#1468 Phase 1).
    if (typeof last === 'number' && rows.has(last)
      && steps.slice(0, -1).every((st) => typeof st === 'number' && rows.has(st) && !rows.get(st)!.prefab)) out.add(last);
  }
  return out;
}

/** A user-added nested instance's own moves (#1437 P3-c), carried into the prefab it is being promoted into
 *  (as row `rowLid`): each becomes an entry of the prefab's own `moved`, the member addressed through the new
 *  row, its new parent in the promoted instance or in the prefab's frame (`instancePaths`, live guid → path).
 *  Read from the LIVE reference instance, which still stands. A move naming anything else is reported.
 *  A pre-v5 move is read in the FRAME its localId belongs to, including a move inside one of the node's
 *  own nested rows (#1480). */
export function promoteReferenceMoves(
  prefab: PrefabFile, node: AddedEntity, rowLid: number, localToEcs: Map<number, number>, instancePaths: Map<string, MemberStep[]>,
  /** A dry run (#1736): the same carry, said nowhere. */
  quiet = false,
): void {
  const refRoot = localToEcsGuid(node.guid);
  const eaMeta = getTraitByName('EntityAttributes');
  // Nothing to carry unless one of the three sources below holds something — decided here, once, so the
  // caller does not keep a second copy of the list (it did, and it missed the nested maps).
  const anyNested = Object.values(node.nestedStructure ?? {}).some((d) => d?.moved && Object.keys(d.moved).length);
  if (!refRoot || !eaMeta || !(node.members || node.moved || anyNested)) return;
  const parentGuid = localToEcs.get(node.parentLocalId) ? guidForEntityId(localToEcs.get(node.parentLocalId)!) : '';
  const rowPath = [...(instancePaths.get(parentGuid) ?? []), rowLid];
  const inRef = new Map<string, MemberStep[]>();
  const byKey = memberPathIndex(getCurrentWorld(), refRoot);
  for (const [k, e] of byKey) {
    const g = e ? (e.get(eaMeta.trait) as { guid?: string }).guid : '';
    if (g) inRef.set(g, memberPathSteps(k));
  }
  // Two sources since Phase 3 (#1468): the MEMBER ROWS, whose key names the member directly, and the
  // legacy `moved` maps for the moves no row carries (a pre-v5 template) — the node's own, and each of
  // its nested rows' (`nestedStructure[path].moved`, #1480), whose localIds have to be re-found.
  const moves = new Map<number, string>();
  for (const [ecsId, key] of memberRowKeysIn(refRoot)) {
    const target = node.members?.[key]?.parent;
    if (target) moves.set(ecsId, target);
  }
  // A legacy localId means something only in its FRAME: the node's own for `node.moved`, and for a nested
  // path the owned root that path walks to. `memberRowsIn` is the one walk that knows every member's
  // (frame, localId in that frame) — the pair `moved` was keyed by — so both are looked up through it.
  // ⚠️ `node.moved` was a `find()` over the whole instance matching an owned root's `parentLocalId` at
  // ANY depth, so a deeper frame's root at the same number could take the move (#1480 part 2 — traced,
  // not triggered: spawn order found the right one first in both fixtures built). The nested maps were
  // not read at all, and a pre-v5 move inside a nested row was lost (#1480 part 1).
  const atRow = new Map<string, number>();
  for (const [id, at] of memberRowsIn(refRoot)) atRow.set(`${at.frameRoot}:${at.rowLocalId}`, id);
  const frameAtPath = (pathKey: string): number => {
    let cur = refRoot;
    for (const step of memberPathSteps(pathKey)) {
      if (typeof step !== 'number' || !(cur = atRow.get(`${cur}:${step}`) ?? 0)) return 0;
    }
    return cur;
  };
  const legacy: [number, Record<number, string> | undefined][] = [
    [refRoot, node.moved],
    ...Object.entries(node.nestedStructure ?? {}).map(([path, delta]): [number, Record<number, string> | undefined] => [frameAtPath(path), delta?.moved]),
  ];
  for (const [frame, moved] of legacy) {
    if (!frame) continue;
    for (const [lidStr, target] of Object.entries(moved ?? {})) {
      const member = atRow.get(`${frame}:${Number(lidStr)}`);
      if (member && !moves.has(member)) moves.set(member, target);
    }
  }
  for (const [ecsId, target] of moves) {
    const memberPath = inRef.get(guidForEntityId(ecsId));
    const targetPath = inRef.has(target) ? [...rowPath, ...inRef.get(target)!] : instancePaths.get(target);
    if (!memberPath || !targetPath) {
      if (!quiet) console.warn(`[Prefab] a move inside the promoted instance "${node.name}" names something outside this prefab; it was not carried`);
      continue;
    }
    prefab.moved = { ...prefab.moved, [memberPathKey([...rowPath, ...memberPath])]: memberToken(0, targetPath) };
  }
}

/** A promotion's live entities, by where the refresh re-expands them (#1660): a plain node by the row it became
 *  (row localId → its guid), and a reference node's whole expansion by the nested row it became and the path of
 *  each entity inside it (row localId → path key → guid). */
interface PromotedGuids { plain: Map<number, string>; refs: Map<number, Map<string, string>> }

/** `memberPathIndex` below `rootEcsId`, continued into every STORED root under it — an instance the author dropped
 *  inside a promoted reference node — where the index itself stops, with that frame's keys after the root's own
 *  (`<root key>|<key>`). Both sides of a promotion are read through it: before, such a root is a stored instance
 *  and each node added inside the reference node is plain; after, both are template nodes of the row's `added`.
 *  The step is the same on both sides, because the promotion's template write stamps the key it gives each node
 *  on the live entity (`addedNodeIdentity`) before Apply deletes it. A key two entities share names neither. */
function promotionPathIndex(world: ReturnType<typeof getCurrentWorld>, rootEcsId: number, tree: IdentityTree): ReturnType<typeof memberPathIndex> {
  const piMeta = getTraitByName('PrefabInstance');
  const out: ReturnType<typeof memberPathIndex> = new Map();
  const walk = (root: number, prefix: string, depth: number): void => {
    for (const [key, e] of memberPathIndex(world, root, tree)) {
      if (!key && prefix) continue; // a stored root, already recorded by the frame above it
      const at = prefix ? `${prefix}|${key}` : key;
      out.set(at, out.has(at) ? null : e);
      const pi = e && piMeta && e.has(piMeta.trait) ? (e.get(piMeta.trait) as MemberPi) : null;
      if (key && e && depth < 64 && isStoredRoot(pi, e.id())) walk(e.id(), at, depth + 1);
    }
  };
  walk(rootEcsId, '', 0);
  return out;
}

/** {@link PromotedGuids} for the rows `insertAddedSubtree` just wrote, read from the live entities BEFORE Apply
 *  deletes them. */
export function snapshotPromotedGuids(plain: ReadonlyMap<string, number>, refs: ReadonlyMap<string, number>): PromotedGuids {
  const out: PromotedGuids = { plain: new Map(), refs: new Map() };
  for (const [guid, lid] of plain) out.plain.set(lid, guid);
  const eaMeta = getTraitByName('EntityAttributes');
  if (!refs.size || !eaMeta) return out;
  const world = getCurrentWorld();
  const tree = identityTree(world);
  for (const [guid, lid] of refs) {
    const ecs = localToEcsGuid(guid);
    if (!ecs) continue;
    const byPath = new Map<string, string>();
    for (const [key, e] of promotionPathIndex(world, ecs, tree)) {
      if (!e) continue;
      const g = e.has(eaMeta.trait) ? (e.get(eaMeta.trait) as { guid?: string }).guid : '';
      if (g) byPath.set(key, g);
    }
    out.refs.set(lid, byPath);
  }
  return out;
}

/** Give each entity a promotion re-expanded the identity its live original had (#1660).
 *
 *  Promotion deletes the added node and lets the refresh expand the new row in its place, and an expanded member
 *  DERIVES its guid from the instance's anchor and its path. So without this every ref naming the added node — a UI
 *  nav link, a UIAction target, a joint, from this scene or from another file — named nothing after the Apply, and
 *  `applyToPrefabWithUndo` then saved the scene that way.
 *
 *  Each re-expanded entity is paired with its original (a plain row by its localId in this instance's frame; a
 *  nested row's expansion by path below the nested root, as `memberPathIndex` spells it) and then:
 *  - **a member the save writes a ROW for takes the old guid back** (scene v16): the row states it, so the reload
 *    pins it, and a ref anywhere — another file included — keeps resolving. The same rule `stampDerivedMemberGuids`
 *    and `promoteOwnedRoots` apply the other way round: where a row states the guid, identity does not move.
 *  - **anything else keeps its derived guid, and the live refs follow it** — a template-keyed node or a member of a
 *    pre-v5 document, which no row can pin. A ref in another file to one of those still dangles; nothing short of a
 *    row can hold that identity, and the reload would re-derive whatever this wrote live. */
export function carryPromotedGuids(rootGuid: string, promoted: PromotedGuids): Map<string, string> {
  const none = new Map<string, string>();
  if (!promoted.plain.size && !promoted.refs.size) return none;
  const piMeta = getTraitByName('PrefabInstance');
  const root = rootGuid ? localToEcsGuid(rootGuid) : 0;
  if (!piMeta || !root) return none;
  const world = getCurrentWorld();
  const tree = identityTree(world);
  const all = getAllEntities();
  const piOf = new Map(all.map((e) => [e.id, readTraitData(e.id, piMeta) as (MemberPi & { localId?: number }) | null]));
  const inFrame = (id: number) => id === root || piOf.get(id)?.rootInstanceId === root;
  const pairs: [old: string, id: number][] = [];
  for (const e of all) {
    const pi = piOf.get(e.id);
    if (!pi || e.id === root) continue;
    if (pi.rootInstanceId === root) {
      const old = pi.localId !== undefined ? promoted.plain.get(pi.localId) : undefined;
      if (old) pairs.push([old, e.id]);
    } else if (isOwnedRoot(pi, e.id) && inFrame(tree.parents.parentOf(e.id))) {
      const old = promoted.refs.get(memberStepId(pi)); // an owned root's step is the row it expanded from
      if (!old) continue;
      for (const [key, ent] of promotionPathIndex(world, e.id, tree)) {
        const g = old.get(key);
        if (g && ent) pairs.push([g, ent.id()]);
      }
    }
  }
  const writer = rowWritingRoot(root);
  const rowed = writer ? memberRowsToWrite(writer) : new Map<number, string>();
  const carry = new Map<string, string>(); // derived → old: the member takes its identity back
  const follow = new Map<string, string>(); // old → derived: the refs move to the member
  // Never guess. An original two entities answer to, or an entity two originals answer to, is left as the refresh
  // made it: a guid carried onto the wrong one is worse than a derived one, and carried onto both is two entities
  // with one guid. Nor is a guid taken from an entity still holding it: two entities would share it. Apply's delete takes
  // the promoted nodes' identity subtree (#1682), so no original survives beside its twin through Apply; the clause is
  // the backstop for a caller that deletes less.
  const claims = new Map<string | number, number>();
  for (const [old, id] of pairs) for (const k of [old, id]) claims.set(k, (claims.get(k) ?? 0) + 1);
  for (const [old, id] of pairs) {
    if (claims.get(old)! > 1 || claims.get(id)! > 1 || localToEcsGuid(old)) continue;
    const now = guidForEntityId(id);
    if (!now || now === old) continue;
    if (rowed.has(id) && durableGuid(old)) carry.set(now, old);
    else follow.set(old, now);
  }
  applyGuidRemap(carry);
  remapWorldGuidRefs(follow);
  return follow;
}

/** {@link carryPromotedGuids}, exported for the guard that it never guesses — a pairing that is not unique cannot
 *  be built through Apply, so its test drives the step directly. */
export const carryPromotedGuidsForTest = carryPromotedGuids;
