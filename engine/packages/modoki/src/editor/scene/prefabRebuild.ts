/** Rebuild, refresh and rebase: re-expanding an instance from its template while carrying its overrides and nested
 *  frames across, refreshing every instance of a changed prefab, and rebasing stale frames.
 *  Moved out of `prefab.ts` by the prefab.ts split (#1656 § Plan, step 5): a pure move. */

import { expandsToRoot } from '../../runtime/loaders/prefabRoot';
import { getCurrentWorld, findEntityByGuid } from '../../runtime/core/ecs/world';
import { relinkDetachedMembers } from '../../runtime/core/ecs/memberHome';
import { worldIdentityParents, noteNodeMoves, frameRootDoc, noteFrameRootDoc } from '../../runtime/core/ecs/identityParents';
import { memberRowKeysIn, memberRowsIn, rowWritingRoot } from '../../runtime/core/ecs/memberRows';
import { diffFrameAdded } from './nodeRowDiff';
import { getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { beginWorldBoundOperation } from '../undo/undoManager';
import { getAllEntities, deleteEntities, readTraitData, writeTraitField, findEntity, type EntityInfo } from '../../runtime/core/ecs/entityUtils';
import { collectSubtreeIds } from '../../runtime/core/ecs/subtreeCollect';
import { Transient } from '../../runtime/core/traits/Transient';
import { newGuid, resolveRef } from '../../runtime/loaders/assetManifest';
import { durableGuid, nodeRowKey, remapGuidValues, memberPathSteps } from '../../runtime/core/assetRefRules';
import { memberPathLookup } from '../../runtime/core/templateRefs';
import { frameRespell } from '../../runtime/loaders/frameRespell';
import { templateKeyOf, setTemplateKey } from '../../runtime/core/templateIdentity';
import type { AddedEntity, SceneMemberRow } from '../../runtime/loaders/loadSceneFile';
import { keptMemberOrphans, setKeptMemberOrphans, rowBackedTest, mergeNestedOverridePaths, deriveMemberGuidsAfterPins, memberPathIndex, queuePrefabMoves, collectReferenceNodeRows } from '../../runtime/loaders/loadSceneFile';
import { translateLocalIds, docRows } from '../../runtime/loaders/memberTranslation';
import { foldMemberRowChannels, mergeTraitRemovals } from '../../runtime/loaders/prefabOverrides';
import { frameForward, chainLayer, layerAddedTraits, levelDoc, keptLegacyForward, settleKeptLegacy } from './prefabBase';
import { collectTree, localToEcsGuid, type PrefabFile } from './prefab';
import {
  getCachedPrefabSync, prefabCache, preloadNestedPrefabs, preloadNestedPrefabsForSubtree, recoverTemplateKey,
  setPrefabSource,
} from './prefabCache';
import { baseTokenResolver } from './prefabTokens';
import { applyOverridesByRootInstance, captureInstanceOverrides } from './prefabInstanceOverrides';
import {
  captureInstanceMembers, enclosingFrames, frameMovesOf, liveRowLocalIds, memberTransforms, restoreInstanceMembers,
} from './prefabMembers';
import {
  captureInstanceStructure, captureNestedChannels, chainNodesAsPlaced, reanchoredKeys, type InstanceStructure, keepsTemplateRows, writerFormOf,
  type KeptNodeReplace, liveTemplateKeys, moveChannelsOntoRows, nodeDiffDeps, resolveAddedNodeTokens,
  subtractChainOverrides, subtractChainStructure,
} from './prefabCapture';
import { subtractFieldOverrides } from './prefabChain';
import {
  collectInstanceRoots, framesBuiltFromOtherRows, isLiveInstanceRoot, type KeptFrame, rebuildTeardown, type StaleFrame,
  staleFrames,
} from './prefabFrames';
import { applyStructureByRootInstance, instantiatePrefab, spawnAddedUnder } from './prefabInstantiate';

/** `rows` with every scene node in them carrying the template key of the live entity it is — marker, else recovered,
 *  else minted once here — so `templateRowOf` can write it after that entity is gone. The guid stays: the settle's live
 *  replay respawns the node by it. */
function keySceneNodes(rows: Record<string, SceneMemberRow>): Record<string, SceneMemberRow> {
  const keyed = (nodes: AddedEntity[] | undefined): AddedEntity[] | undefined => nodes?.map((n) => {
    const live = n.guid ? localToEcsGuid(n.guid) : 0;
    const key = n.key || (live ? templateKeyOf(findEntity(live)) || recoverTemplateKey(live) : '') || newGuid();
    const out: AddedEntity = { ...n, key, children: keyed(n.children) ?? [] };
    if (n.added) out.added = keyed(n.added);
    if (n.members) out.members = keySceneNodes(n.members);
    return out;
  });
  return Object.fromEntries(Object.entries(rows).map(([k, r]) => [k, {
    ...r, ...(r.own ? { own: keyed(r.own) } : {}), ...(r.added ? { added: keyed(r.added) } : {}),
  }]));
}

/** A live per-copy customization on a NESTED instance, captured before an outer
 *  rebuild so it can be re-applied after re-expansion. `chain` is the sequence of
 *  `parentLocalId`s from the outer root down to this nested root — a stable
 *  address that survives the id churn (the prefab structure is deterministic). */
export interface NestedInstanceCapture {
  chain: number[];
  /** Each link of `chain` by identity: the row's `nodeGuid` in the frame above (`parentNodeGuid`), '' for a pre-v5 row.
   *  The re-apply finds each link in the document that frame expands NOW (#1771 close-out review F3): a link read by
   *  its number named whatever row inherited it once an outer row was re-pointed at another prefab. */
  chainGuids: string[];
  source: string;
  /** The document every localId below was read against: the frame's own record when captured (I3). The re-apply
   *  translates from it to the document the frame at `chain` expands AFTER the rebuild, which can be a new version of
   *  `source` or, when the template re-pointed that row at another prefab, a different prefab altogether (#1767). */
  doc: PrefabFile;
  overrides: Record<number, Record<string, Record<string, unknown>>>;
  structure: InstanceStructure;
  /** Template-authored added nodes the scene EDITED: the fresh expansion spawns each one again, so the
   *  re-apply deletes that copy before it spawns the captured one (#1386). `key` is empty for a legacy
   *  node matched by its file guid. */
  replace: KeptNodeReplace[];
  /** v17 node rows (#1516): the scene's edits to template-added nodes, node by node. The fresh expansion spawns the
   *  NEW template's node and the re-apply patches only these fields onto it — so a template change to anything the
   *  scene did not edit reaches it, as a reload's does. A node the scene deleted is `removed`, and is deleted again. */
  nodeRows?: Map<string, SceneMemberRow>;
}

/** Capture every NESTED prefab instance inside the live subtree under
 *  `outerRootId` (each captured against its OWN child prefab). Without this an
 *  outer rebuild re-expands nested rows straight from the file, discarding any
 *  per-copy override the user made on a specific nested child (design risk R3).
 *
 *  Each capture is the live instance MINUS what the prefab chain of `baseline` already applies to it
 *  (#1386, #1401) — `baseline` being the outer document the live tree was expanded FROM (a refresh's
 *  old file). The fresh expansion re-produces that part itself, so restating it is wrong both ways: an
 *  `added` node is not idempotent and spawned twice, and a restated row value froze the OLD value over
 *  a refreshed one. What remains is the scene's own edit, which is the only thing the re-apply owes. */
function captureNestedInstanceOverrides(outerRootId: number, baseline: PrefabFile): NestedInstanceCapture[] {
  const PrefabInstanceMeta = getTraitByName('PrefabInstance');
  if (!PrefabInstanceMeta) return [];

  const all = getAllEntities();
  const byId = new Map<number, EntityInfo>();
  const childrenOf = new Map<number, number[]>();
  for (const e of all) {
    byId.set(e.id, e);
    if (!childrenOf.has(e.parentId)) childrenOf.set(e.parentId, []);
    childrenOf.get(e.parentId)!.push(e.id);
  }
  const piOf = (id: number) => readTraitData(id, PrefabInstanceMeta) as Record<string, unknown> | null;
  const rootOf = (id: number) => (piOf(id)?.rootInstanceId as number) ?? 0;
  const isNestedRoot = (id: number) => {
    const pi = piOf(id);
    return !!pi && pi.rootInstanceId === id && id !== outerRootId;
  };
  // parentLocalId path from the outer root down to nested root `n` — or null when the climb does not
  // REACH the outer root (#1383). It stops early at a plain node (an `added[]` node has no
  // PrefabInstance, so `rootOf` answers 0), and the partial chain it held addressed a DIFFERENT
  // instance from the outer root: a stamped instance under a plain node wrote its overrides onto the
  // real row's expansion. Such an instance is not a row expansion of this outer at all — the outer
  // structure capture carries it whole, as a reference node under that plain node.
  const identity = worldIdentityParents(getCurrentWorld());
  const chainOf = (n: number): { chain: number[]; guids: string[] } | null => {
    const chain: number[] = [];
    const guids: string[] = [];
    let cur = n, guard = 0;
    while (cur && cur !== outerRootId && guard++ < 64) {
      const pi = piOf(cur);
      if (!pi) break;
      chain.unshift((pi.parentLocalId as number) || 0);
      guids.unshift(pi.parentLocalId ? (pi.parentNodeGuid as string) || '' : '');
      // Climb to the parent instance's root by IDENTITY: a nested root moved out of its frame (#1437) is still
      // that frame's row, and a chain read from its live parent addressed a different instance. An OWNED root
      // climbs to its owner — its template parent can be another nested ROOT (a nested row under a nested row),
      // whose own frame is not the one holding the row.
      cur = pi.parentLocalId ? identity.ownerOf(cur) : rootOf(identity.parentOf(cur));
    }
    return cur === outerRootId ? { chain, guids } : null;
  };

  // The chain's member tokens resolved to the live guids they name (`baseTokenResolver`: the nested
  // root's own frame, `^` climbing to the instance whose row expanded it). The loader applies every
  // value an instance receives — its row's, and whatever an outer layer forwarded — in THAT frame.
  // The live capture holds guids, so an unresolved token never compared equal: a token-bearing row
  // value or node read as a scene edit and froze the old template (#1386 review) — `resolveAddedNodeTokens`.

  const captures: NestedInstanceCapture[] = [];
  // What the layers ENCLOSING the outer root forward into its expansion (#1737). The rebuild expands under that state
  // (`rebuildInstance`), so a nested frame's statements from it come back with the expansion, and the capture subtracts
  // them with the chain's own: restated, a node that layer adds came back twice, and a value it sets pinned the frame
  // against a later template edit. Folded against `baseline`, the document the live tree was built from.
  const outerSource = (piOf(outerRootId)?.source as string) || '';
  const enclosing = frameForward(outerRootId, baseline) ?? undefined;
  // Every nested frame the rebuild's TEARDOWN destroys — asked of the teardown itself, not of the live subtree
  // (#1499). A frame owned here but moved out of that subtree (#1437) is destroyed by the teardown's reverse case
  // and re-expanded at its row; walking live children never reached it, so its edits were lost. Shallowest first,
  // the order the live walk gave: a frame is re-applied before the frames inside it.
  const torn = [...rebuildTeardown(outerRootId).toDestroy]
    .map((id) => ({ id, at: isNestedRoot(id) ? chainOf(id) : null }))
    .filter((t): t is { id: number; at: { chain: number[]; guids: string[] } } => !!t.at)
    .map(({ id, at }) => ({ id, chain: at.chain, chainGuids: at.guids }))
    .sort((a, b) => a.chain.length - b.chain.length);
  for (const { id, chain, chainGuids } of torn) {
    // Only instances reached through a chain of ROW expansions. A `0` in the chain is a user-added
    // (reference-node) instance, and everything under one is carried BY that node: the outer capture's
    // `structure.added` holds it with its own overrides, structure and nested channels (#1369), and
    // `rebuildInstance`'s `applyStructureByRootInstance` re-spawns it whole. Re-applying it here a
    // second time duplicated every subtree it had added — a rebuild turned one Bolt into two.
    if (!chain.includes(0)) {
      const source = piOf(id)!.source as string;
      const childPrefab = levelDoc(id, source).doc; // its own record, as the chain below is read (I3)
      if (childPrefab) {
        const resolve = baseTokenResolver(id);
        const chainLayerHere = chainLayer(outerRootId, outerSource, chain, baseline, enclosing);
        const chainStructure = chainLayerHere.structure;
        const full = captureInstanceStructure(id, childPrefab, { layerTraits: layerAddedTraits(chainLayerHere, childPrefab) });
        // The template's nodes node by node (v17, #1516), as the save states them; a member whose list cannot be
        // stated that way keeps the #1386 whole-node replace below. Placed as the loader places them, without the
        // ones under a member that is not live (`chainNodesAsPlaced`).
        const resolvedAdded = resolveAddedNodeTokens(resolve, chainStructure.added) ?? [];
        const chainAdded = chainNodesAsPlaced(resolvedAdded, childPrefab, liveRowLocalIds(id, childPrefab));
        const keys = chainAdded.length ? liveTemplateKeys(full.added, true) : new Map<string, string>();
        const nodes = diffFrameAdded(full.added, chainAdded, nodeDiffDeps(keys), reanchoredKeys(resolvedAdded, childPrefab));
        // A kept ORPHAN row (fork 2) is not merged in here: `settleKeptOrphans` replays every kept row the new template
        // backs again, in whatever frame, after this re-apply (#1535).
        const inWhole = (n: AddedEntity) => nodes.whole.has(n.parentLocalId);
        // A re-anchored template node in a whole list is the LIST's now, as the save writes it (#1872, the diff's
        // `pinnedOver` — asked there once, not re-derived here: a copy of its condition drifted from it in the
        // duplicate-key branch). So the live node is not subtracted as the template's — it is respawned from the capture,
        // edited or not — and a removed row (applied after, below) deletes the fresh template copy. Subtracted, an
        // unedited one was left to that copy and the row deleted it: the node was lost.
        const pinnedOver = (n: AddedEntity) => !!n.key && nodes.pinnedOver.has(n.key);
        const { structure, replace } = subtractChainStructure(
          { ...full, added: full.added.filter(inWhole) }, { ...chainStructure, added: chainAdded.filter((n) => inWhole(n) && !pinnedOver(n)) }, keys);
        const own = [...nodes.own].flatMap(([lid, list]) => list.map((n) => ({ ...n, parentLocalId: lid })));
        // What the re-apply RESPAWNS takes its reference nodes in the save's rows form (`inRespawnForm`, #1826); `full`
        // above stays in the form the comparison against the chain's nodes reads.
        let rowsForm: AddedEntity[] | undefined;
        const rowsCapture = () => (rowsForm ??= captureInstanceStructure(id, childPrefab, { rows: true, layerTraits: layerAddedTraits(chainLayerHere, childPrefab) }).added);
        const respawned = inRespawnForm([...structure.added, ...own], rowsCapture);
        // …and a node row's `own` (the scene's nodes under a template node it matched), which `applyNodeRowsLive` spawns:
        // the third channel the re-apply respawns from (the close-out re-review's F1).
        const nodeRows = new Map([...nodes.nodeRows].map(([k, r]) => [k, r.own?.length ? { ...r, own: inRespawnForm(r.own, rowsCapture) } : r] as const));
        captures.push({
          chain,
          chainGuids,
          source,
          doc: childPrefab,
          overrides: subtractChainOverrides(
            captureInstanceOverrides(id, childPrefab), resolve(chainLayerHere.overrides) as Record<number, Record<string, Record<string, unknown>>>, childPrefab, memberTransforms(id)),
          structure: { ...structure, added: respawned },
          replace,
          ...(nodeRows.size || nodes.pinnedOver.size
            ? { nodeRows: new Map([...nodeRows, ...[...nodes.pinnedOver].map((k) => [k, { removed: true }] as const)]) } : {}),
        });
      }
    }
  }
  return captures;
}

/** `nodes` in the form the SAVE writes them — `writerFormOf` over `rowsCapture()`, the same live frame captured with
 *  `{ rows: true }` — keeping where `nodes` places them. The capture runs only when `nodes` holds a reference node at any
 *  depth: every other node is the same in both forms.
 *
 *  Why (#1826): a rebuild respawns a reference node through the loader's one spawner, and its LEGACY channels fold wrongly
 *  against a template MEMBER ROW (a v6 row's `members`) there. A `nestedStructure` slot owns its frame, so the fold skips
 *  the inner layers' rows, member values included: a pasted O copy's M lost O's `y = 8` live and got it back on reload
 *  (seed 6068). And a `nestedOverrides` value merges into the fold's lower layer, UNDER every layer's rows, so O's row beat
 *  the scene's own edit of that M and the next save wrote the template's value — for a scene-added node and for one a
 *  template adds alike. As rows the node is the outermost layer, as the file states it: the respawn is the load of what
 *  the save writes. Only what is RESPAWNED is swapped: the comparisons against the chain's nodes read the legacy form (in
 *  rows a template reference node compared as edited, and was restated on every save), and so does Apply's promotion of
 *  a node into a template (in rows its members' edits were dropped — the close-out review's F1). */
function inRespawnForm(nodes: AddedEntity[], rowsCapture: () => AddedEntity[]): AddedEntity[] {
  const holdsRef = (list: readonly AddedEntity[] | undefined): boolean => (list ?? []).some((n) => !!n.prefab || holdsRef(n.children));
  return holdsRef(nodes) ? writerFormOf(rowsCapture(), { keepPlacement: true })(nodes) : nodes;
}

/** {@link captureInstanceStructure} for a capture a rebuild RESPAWNS from (`rebuildInstance`'s `structure`: a Revert, an
 *  undo's side, a refresh): its reference nodes in the save's rows form ({@link inRespawnForm}, #1826). A capture that is
 *  read instead — compared, listed, promoted — takes `captureInstanceStructure` itself. */
export function captureStructureForRespawn(rootInstanceId: number, prefab: PrefabFile): InstanceStructure {
  const s = captureInstanceStructure(rootInstanceId, prefab);
  return { ...s, added: inRespawnForm(s.added, () => captureInstanceStructure(rootInstanceId, prefab, { rows: true }).added) };
}

/** Re-apply nested-instance captures onto a freshly rebuilt outer instance,
 *  re-locating each nested root by walking its `parentLocalId` chain from the new
 *  outer root (ids changed, the chain didn't). */
function reapplyNestedInstanceOverrides(newOuterRootId: number, captures: NestedInstanceCapture[]): void {
  if (!captures.length) return;
  const PrefabInstanceMeta = getTraitByName('PrefabInstance');
  if (!PrefabInstanceMeta) return;

  // The nested instance root produced by row `parentLocalId` of `parentRoot`: the owned root with that stamp
  // whose OWNER is `parentRoot` (`identityParents.ts`). It read "its live parent is a member of parentRoot"
  // before #1468 Phase 6's close-out, which no nested row under a nested row can satisfy — its root hangs under
  // the other nested ROOT — so an edit inside one was dropped by every rebuild.
  const identity = worldIdentityParents(getCurrentWorld());
  const findChildNestedRoot = (parentRoot: number, parentLocalId: number): number => {
    let found = 0;
    getCurrentWorld().query(PrefabInstanceMeta.trait).updateEach(([pi], entity) => {
      if (found) return;
      const p = pi as Record<string, unknown>;
      const id = entity.id();
      if (p.rootInstanceId !== id) return;                            // must be an instance root
      if (((p.parentLocalId as number) || 0) !== parentLocalId) return;
      if (identity.ownerOf(id) === parentRoot) found = id;
    });
    return found;
  };
  // The fresh copies of `replace`'s nodes under nested root `root`: added nodes directly under a member.
  const freshCopies = (root: number, replace: NestedInstanceCapture['replace']): number[] => {
    const keys = new Set(replace.map((r) => r.key).filter(Boolean));
    const guids = new Set(replace.filter((r) => !r.key && r.guid).map((r) => r.guid));
    const rootOf = (id: number) => (readTraitData(id, PrefabInstanceMeta)?.rootInstanceId as number) ?? 0;
    const all = getAllEntities();
    const members = new Set(all.filter((e) => rootOf(e.id) === root).map((e) => e.id));
    return all
      .filter((e) => members.has(e.parentId) && !members.has(e.id))
      .filter((e) => keys.has(templateKeyOf(findEntity(e.id))) || guids.has(e.guid ?? ''))
      .map((e) => e.id);
  };

  // The row a link names in the document frame `root` expands NOW — by its nodeGuid where it has one, since a number
  // names whatever row inherited it. 0 when that document no longer holds the row: the capture then applies nowhere,
  // as a reload applies the scene's row nowhere (R2 keeps it).
  const linkIn = (root: number, lid: number, guid: string): number => {
    if (!guid) return lid;
    const src = (readTraitData(root, PrefabInstanceMeta)?.source as string) || '';
    const doc = levelDoc(root, src).doc ?? getCachedPrefabSync(src);
    const row = doc ? docRows(doc).get(guid) : undefined;
    return row?.nested ? row.localId : 0;
  };
  for (const cap of captures) {
    let cur = newOuterRootId;
    for (let i = 0; i < cap.chain.length && cur; i++) {
      const lid = linkIn(cur, cap.chain[i]!, cap.chainGuids[i] ?? '');
      cur = lid ? findChildNestedRoot(cur, lid) : 0;
    }
    if (!cur || cur === newOuterRootId) continue;
    // The capture is keyed in the localIds of the document it was READ against; the frame now at its row expands
    // whatever that row expands NOW (I4, #1767). A template row that kept its nodeGuid while its prefab changed puts
    // another prefab here, and the old numbers named the new prefab's members one for one. Translated by nodeGuid, as
    // a reload translates the scene's rows: an edit to a member the new document does not have is dropped (R2 keeps
    // its row), and across two prefabs a number is never matched by position. ⚠️ One difference from a reload stays, and
    // it is the rebuild's standing rule, not this translation's: a scene-ADDED node under a dropped member is
    // re-anchored to the frame root (`translateCarried` → `applyStructureCore`), where a reload keeps it in the orphan row.
    const nowSource = (readTraitData(cur, PrefabInstanceMeta)?.source as string) || cap.source;
    const childPrefab = levelDoc(cur, nowSource).doc ?? getCachedPrefabSync(nowSource);
    if (!childPrefab) continue;
    let { overrides, structure } = cap;
    const lid = translateLocalIds(cap.doc, childPrefab, { acrossPrefabs: nowSource !== cap.source });
    if (lid) ({ overrides, structure } = translateCarried(lid, overrides, structure));
    if (cap.replace.length) deleteEntities(freshCopies(cur, cap.replace));
    applyOverridesByRootInstance(cur, overrides);
    applyStructureByRootInstance(cur, childPrefab, structure);
    // A row whose node the new template no longer adds applies nowhere here; `settleKeptOrphans` keeps it (fork 2).
    if (cap.nodeRows) applyNodeRowsLive(cur, cap.nodeRows);
    // The respawned node's key marker comes back with every other torn-down node's, by guid (`rebuildInstance`, #1567).
  }
}

/** Every nested frame of instance `rootInstanceId`, as a rebuild would capture it now (#1741): the state an undo hands
 *  back to {@link rebuildInstance} (`nested`) when the live frames will show another side by the time it runs. Measured
 *  against the document the instance was expanded from (I3), which `rebuildInstanceFromCapture` translates it out of. */
export function captureNestedFrames(rootInstanceId: number, source: string, fallback: PrefabFile): NestedInstanceCapture[] {
  return captureNestedInstanceOverrides(rootInstanceId, levelDoc(rootInstanceId, source).doc ?? fallback);
}

/** Patch v17 node rows (#1516) onto the template-added nodes of the live frame rooted at `frameRoot` — the live-world
 *  twin of the loader's `applyNodeRows`, for a rebuild whose fresh expansion just spawned the NEW template's nodes.
 *  A node is found by its template key among the entities hanging below the frame's members, through plain nodes
 *  (not into another instance). Field edits merge over the fresh values, a trait the row adds is added, a `true`
 *  trait removal removes it, `removed` deletes the node, and `own` spawns the scene's children under it. Returns the
 *  keys whose node the new template no longer adds: the caller keeps those rows as orphans (fork 2). */
function applyNodeRowsLive(frameRoot: number, rows: ReadonlyMap<string, SceneMemberRow>): Set<string> {
  const missed = new Set<string>();
  const piMeta = getTraitByName('PrefabInstance');
  if (!piMeta) return missed;
  const rootOf = (id: number) => (readTraitData(id, piMeta)?.rootInstanceId as number) || 0;
  const all = getAllEntities();
  const childrenOf = new Map<number, number[]>();
  for (const e of all) { const list = childrenOf.get(e.parentId); if (list) list.push(e.id); else childrenOf.set(e.parentId, [e.id]); }
  const byKey = new Map<string, number>();
  const walk = (id: number) => {
    for (const c of childrenOf.get(id) ?? []) {
      const key = templateKeyOf(findEntity(c));
      if (readTraitData(c, piMeta)) {
        // A member, or another instance — not walked into. A template REFERENCE node's root is one, and is still
        // this frame's node: its row can delete it (re-review R3b — missed, a Refresh brought it back).
        if (key && !byKey.has(key)) byKey.set(key, c);
        continue;
      }
      if (key && !byKey.has(key)) byKey.set(key, c);
      walk(c);
    }
  };
  for (const e of all) if (e.id === frameRoot || rootOf(e.id) === frameRoot) walk(e.id);
  const gone: number[] = [];
  for (const [key, row] of rows) {
    const id = byKey.get(key);
    const entity = id ? findEntity(id) : undefined;
    if (!id || !entity) { missed.add(key); continue; }
    if (row.removed === true) { gone.push(id); continue; }
    for (const [t, fields] of Object.entries(row.traits ?? {})) {
      const meta = getTraitByName(t);
      if (!meta || !fields || typeof fields !== 'object') continue;
      // Spread over the current value: a field-schema trait's `set` already updates only the fields given, but an
      // AoS one's replaces the whole value.
      if (entity.has(meta.trait)) entity.set(meta.trait, { ...(entity.get(meta.trait) as Record<string, unknown>), ...fields });
      else entity.add(meta.trait(fields));
    }
    for (const [t, v] of Object.entries(row.traitRemovals ?? {})) {
      const meta = getTraitByName(t);
      if (v === true && meta && entity.has(meta.trait)) entity.remove(meta.trait);
    }
    if (row.own?.length) spawnAddedUnder(id, row.own);
  }
  if (gone.length) deleteEntities(gone);
  return missed;
}

/** The member rows a SAVE would write for the stored instance root `root` (a top-level instance, or a user-added
 *  reference node) — the serializer's own capture, run synchronously over caches the caller has warmed. */
function savedMemberRows(root: number, source: string): Record<string, SceneMemberRow> {
  const prefab = levelDoc(root, source).doc;
  if (!prefab) return {};
  const s = captureInstanceStructure(root, prefab, { rows: true });
  const channels = captureNestedChannels(root, source, s.ownedNested, { rows: true });
  return moveChannelsOntoRows(root, prefab, source, {
    overrides: captureInstanceOverrides(root, prefab), added: s.added, removed: s.removed, removedTraits: s.removedTraits,
    nestedOverrides: channels.nestedOverrides, nestedStructure: channels.nestedStructure,
  }, captureInstanceMembers(root, prefab), channels.frames).members;
}

/** The frame a row key addresses: the key minus its last component ('' = the row-writing root's own frame). */
const rowFrameKey = (key: string): string => key.slice(0, Math.max(0, key.lastIndexOf('/')));

/** The kept-orphan store (R2, `keptMemberOrphans`) across a rebuild, left exactly as a RELOAD of the same scene would
 *  leave it (#1535). A Refresh — and an Apply, a Revert, and the undo of each — is the other route a template change
 *  reaches an open scene by, and it kept this store only half: a row's guid, and the node rows of a frame it
 *  captured. So a template that dropped a member and brought it back through a Refresh lost the scene's edit to it,
 *  at any depth, while the file still held it; and a Refresh that DROPPED a member threw its row away, where a reload
 *  keeps it for the template edit to be undone.
 *
 *  Two halves, around the teardown. Called BEFORE it, this reads what a save would write for every frame the teardown
 *  destroys — against `baseline`, the document the live tree was built from, since the cache already holds the new
 *  one (read against that, a row node of the old template reads as `removed` or as the scene's own). Rows of frames
 *  the teardown does not reach are left alone: they may be built from yet another version. The returned settle runs
 *  after the re-apply, and asks the loader's own orphan test (`rowBackedTest`) of the NEW template:
 *  - a live row it no longer backs is KEPT — its member is gone, and a template that brings it back brings the
 *    scene's edit back with it (fork 2);
 *  - a kept row it backs again is REPLAYED onto its target (`replayRowsLive`) and leaves the store: the live world
 *    states it now, and left in, a save would re-emit it over a later live edit;
 *  - every other kept row stays — and so does a backed one whose target is not live, which only its own frame's
 *    rebuild can bring back (that rebuild's settle replays it).
 *
 *  ⚠️ `torn` is load-bearing. Frames outside this teardown may be built from ANOTHER version of the document the
 *  cache is swapped to: two rows of one prefab refreshed in turn, the second capture reads the first — already
 *  rebuilt — against the old document, sees a node the new template no longer adds as `removed` by the scene, and
 *  would keep that as an orphan, which a later restore of the node then replays as a deletion. (A dropped MEMBER is
 *  shielded anyway: the first rebuild already kept its row, and a kept row wins.) */
function captureRowsForSettle(
  rootInstanceId: number, baseline: PrefabFile, prefab: PrefabFile, toDestroy: ReadonlySet<number>, remap: ReadonlyMap<string, string>,
): (newRootId: number, pinned?: Set<number>) => void {
  const piMeta = getTraitByName('PrefabInstance');
  const eaMeta = getTraitByName('EntityAttributes');
  const rowRoot = rowWritingRoot(rootInstanceId);
  const rowRootGuid = eaMeta && rowRoot ? durableGuid((readTraitData(rowRoot, eaMeta) as { guid?: string } | null)?.guid) : '';
  const rowSource = piMeta && rowRoot ? ((readTraitData(rowRoot, piMeta)?.source as string) || '') : '';
  if (!rowRootGuid || !rowSource || !getCachedPrefabSync(rowSource)) return () => {};
  // A rebuild onto the SAME document with nothing kept — a Revert, an undo's direct rebuild — can neither drop a row
  // nor bring one back, so it skips the save capture (review F6). Only that case: judged any other way, "can a row
  // become unbacked" is a second copy of `rowBackedTest`, and the first one (`declaresAll`) missed a nested row's
  // prefab ref and lost an edit (re-review).
  if (prefab === baseline && !Object.keys(keptMemberOrphans(rowRootGuid) ?? {}).length) return () => {};
  const frameIds = new Map<string, number>([['', rowRoot]]);
  for (const [id, key] of memberRowKeysIn(rowRoot)) frameIds.set(key, id);
  const torn = (key: string) => toDestroy.has(frameIds.get(rowFrameKey(key)) ?? 0);
  // The rows keyed by a nested ROOT: their nodes hang at that instance's root, and die with it when the template drops
  // its row — nothing re-homes them (`unhomed` below). Read now, while the ids are the torn-down tree's.
  const frameRootKeys = new Set([...frameIds].filter(([key, id]) => key && piMeta && (readTraitData(id, piMeta)?.rootInstanceId as number) === id).map(([key]) => key));
  // Every level is read from its frame record — the document the torn frames were built from, while the cache already
  // holds the new one — as a save reads it (#1685).
  let rows = savedMemberRows(rowRoot, rowSource);
  // In the prefab-edit world the rows kept here go back into the TEMPLATE (`captureRowChannels` → `templateRowOf`), which
  // needs each node's key: read now, while the node is still live (#1541/#1542 close-out review).
  if (keepsTemplateRows(rowRoot, rowRootGuid)) rows = keySceneNodes(rows);
  const before = remapGuidValues(Object.fromEntries(Object.entries(rows).filter(([k]) => torn(k))), remap) as Record<string, SceneMemberRow>;
  // The row-writing root is the rebuilt root itself, respawned as `newRootId`, or a stored root ENCLOSING it, which
  // the teardown does not reach and whose id therefore stands.
  return (newRootId, pinned) => {
    const root = rowRoot === rootInstanceId ? newRootId : rowRoot;
    if (!findEntity(root)) return;
    const { backed } = rowBackedTest(rowSource, getCachedPrefabSync);
    const kept = keptMemberOrphans(rowRootGuid) ?? {};
    const next: Record<string, SceneMemberRow> = {};
    const replay: Record<string, SceneMemberRow> = {};
    // A kept row's `added`/`own` nodes the re-apply RE-HOMED (an addition whose anchor the template dropped moves to
    // the instance root, `applyStructureCore`) are live elsewhere now, and saved there: kept here too, a restore of the
    // member spawned them a second time, with the same guid (review F1). Only the ones nothing live carries stay.
    // A node with a RUNTIME guid is captured with none, so no guid can say it is live (#1568): the re-apply's own rule
    // does — a node added under a member the template dropped is re-anchored to its frame's root, so if that frame is
    // live, so is the node. Two rows are not re-homed: a NODE row's nodes went with their template node, and a nested
    // ROOT's with its instance (close-out review).
    const liveGuids = new Set(getAllEntities().map((e) => e.guid).filter((g): g is string => !!g));
    const liveFrames = new Set(['', ...memberRowKeysIn(root).values()]);
    const unhomed = (key: string, row: SceneMemberRow): SceneMemberRow => {
      const out: SceneMemberRow = { ...row };
      const rehomed = !nodeRowKey(key.slice(key.lastIndexOf('/') + 1)) && !frameRootKeys.has(key) && liveFrames.has(rowFrameKey(key));
      for (const ch of ['added', 'own'] as const) {
        const nodes = row[ch];
        if (!nodes) continue;
        const left = nodes.filter((n) => !liveGuids.has(n.guid) && !(rehomed && !n.guid));
        if (left.length === nodes.length) continue;
        if (left.length) out[ch] = left;
        else delete out[ch];
      }
      return out;
    };
    for (const [k, row] of Object.entries(before)) if (!(k in kept) && !backed(k)) next[k] = unhomed(k, row);
    for (const [k, row] of Object.entries(kept)) (backed(k) ? replay : next)[k] = row;
    for (const k of replayRowsLive(root, replay, pinned)) next[k] = replay[k]!;
    setKeptMemberOrphans(rowRootGuid, next);
  };
}

/** Apply scene rows `rows` (keyed from the row-writing root `rowRoot`) to the live members and frames they name — the
 *  live twin of the loader applying a row it matched, in the loader's order: member rows through the loader's own
 *  fold (`foldMemberRowChannels`), frame by frame from the outside in, then node rows (`applyNodeRowsLive`), then
 *  the rows' guids and moves, which the caller's member restore and derive complete. Returns the keys applied
 *  nowhere: a target that is not live, or a node the template does not add. */
function replayRowsLive(rowRoot: number, rows: Record<string, SceneMemberRow>, pinned?: Set<number>): Set<string> {
  const unapplied = new Set<string>();
  const piMeta = getTraitByName('PrefabInstance');
  if (!piMeta || !Object.keys(rows).length) return unapplied;
  const at = new Map<string, { id: number; frameRoot: number }>();
  for (const [id, r] of memberRowsIn(rowRoot)) if (r.key) at.set(r.key, { id, frameRoot: r.frameRoot });
  const frameOf = (fk: string) => (fk ? at.get(fk)?.id ?? 0 : rowRoot);
  const docOf = (id: number) => getCachedPrefabSync((readTraitData(id, piMeta)?.source as string) || '');
  const isFrameRoot = (id: number) => (readTraitData(id, piMeta)?.rootInstanceId as number) === id;
  const frames = new Map<number, { depth: number; rows: Record<string, SceneMemberRow>; replaced: number[]; forwarded: [number, SceneMemberRow][]; restored: [number, PrefabFile, string[]][] }>();
  const nodeRows = new Map<number, Map<string, { key: string; row: SceneMemberRow }>>();
  const applied: Record<string, SceneMemberRow> = {};
  for (const [key, row] of Object.entries(rows)) {
    const fk = rowFrameKey(key);
    const component = key.slice(fk.length + 1);
    const nodeKey = nodeRowKey(component);
    if (nodeKey) {
      const f = frameOf(fk);
      if (!f) { unapplied.add(key); continue; }
      if (!nodeRows.has(f)) nodeRows.set(f, new Map());
      nodeRows.get(f)!.set(nodeKey, { key, row });
      continue;
    }
    const hit = at.get(key);
    if (!hit) { unapplied.add(key); continue; }
    const frame = frames.get(hit.frameRoot) ?? { depth: fk.split('/').length, rows: {}, replaced: [], forwarded: [], restored: [] };
    frames.set(hit.frameRoot, frame);
    frame.rows[`/${component}`] = row;
    // A v16 `added` REPLACES what the chain puts under the member: the fresh expansion's template nodes go first.
    if (Array.isArray(row.added)) frame.replaced.push(hit.id);
    // A row naming an owned nested ROOT: its `removed` is this frame's; the rest lands at that frame's root.
    if (isFrameRoot(hit.id)) frame.forwarded.push([hit.id, row]);
    // A trait the row keeps that the CHAIN removed: the fresh expansion never spawned it, and the fold below, over an
    // empty lower layer, has no chain removal to take it out of — so it is added back from the target's template row
    // (review F2/F3). A `false` statement names it; a v16 `removedTraits` list is the whole set, so every authored
    // trait it leaves out is one. An owned nested root's template row is its child document's root.
    const targetDoc = isFrameRoot(hit.id) ? docOf(hit.id) : docOf(hit.frameRoot);
    const statements = row.traitRemovals ?? {};
    const lid = (readTraitData(hit.id, piMeta)?.localId as number) || 0;
    const authored = Object.keys(targetDoc?.entities.find((e) => e.localId === lid)?.traits ?? {});
    const desired = Array.isArray(row.removedTraits) ? new Set(mergeTraitRemovals(row.removedTraits, statements)) : null;
    const restore = desired ? authored.filter((t) => !desired.has(t)) : Object.keys(statements).filter((t) => statements[t] === false);
    if (restore.length && targetDoc) frame.restored.push([hit.id, targetDoc, restore]);
    applied[key] = row;
  }
  const children = (id: number) => getAllEntities().filter((e) => e.parentId === id).map((e) => e.id);
  for (const [frameRoot, f] of [...frames].sort((a, b) => a[1].depth - b[1].depth)) {
    const doc = docOf(frameRoot);
    if (!doc || !findEntity(frameRoot)) continue;
    const fresh = f.replaced.flatMap(children).filter((c) => !!templateKeyOf(findEntity(c)));
    if (fresh.length) deleteEntities(fresh);
    for (const [id, targetDoc, names] of f.restored) {
      const lid = (readTraitData(id, piMeta)?.localId as number) || 0;
      const authored = targetDoc.entities.find((e) => e.localId === lid)?.traits ?? {};
      const entity = findEntity(id);
      for (const name of names) {
        const meta = getTraitByName(name);
        const data = authored[name];
        if (!entity || !meta || entity.has(meta.trait) || data === undefined) continue;
        entity.add(data === true || meta.category === 'tag' ? meta.trait : meta.trait(data as Record<string, unknown>));
      }
    }
    const folded = foldMemberRowChannels(doc, f.rows, {});
    if (folded.overrides) applyOverridesByRootInstance(frameRoot, folded.overrides);
    applyStructureByRootInstance(frameRoot, doc, { added: folded.added, removed: folded.removed, removedTraits: folded.removedTraits });
    for (const [nested, row] of f.forwarded) {
      const childDoc = findEntity(nested) ? docOf(nested) : null; // gone when the row's own `removed` took it
      if (!childDoc) continue;
      const inner = foldMemberRowChannels(childDoc, undefined, {}, row);
      if (inner.overrides) applyOverridesByRootInstance(nested, inner.overrides);
      applyStructureByRootInstance(nested, childDoc, { added: inner.added, removed: inner.removed, removedTraits: inner.removedTraits });
    }
  }
  for (const [frameRoot, byNode] of nodeRows) {
    if (!findEntity(frameRoot)) { for (const { key } of byNode.values()) unapplied.add(key); continue; }
    const missed = applyNodeRowsLive(frameRoot, new Map([...byNode].map(([k, v]) => [k, v.row])));
    for (const k of missed) unapplied.add(byNode.get(k)!.key);
  }
  // Moves drain with the caller's derive, by guid, exactly as the loader's rows do; guids go back first.
  restoreInstanceMembers(rowRoot, applied, pinned);
  const moves = Object.fromEntries(Object.entries(applied).filter(([, r]) => r.parent).map(([k, r]) => [k, { parent: r.parent }]));
  const rowDoc = docOf(rowRoot);
  if (rowDoc && Object.keys(moves).length) applyStructureByRootInstance(rowRoot, rowDoc, { members: moves });
  return unapplied;
}

/** The document a SAVE measures the top-level instance `rootId` (of `source`) against (#1685, I3): the one it was
 *  EXPANDED from — its frame record — never a cache that has moved on. Measured against a newer template, every row the
 *  instance was never built with read as REMOVED by the scene, and the save deleted the template's new members for good.
 *  The save cannot refuse or rebase (the world is what it is), so it captures right.
 *
 *  Nothing it writes needs translating onto `current`: every member edit goes on a member ROW, keyed by `nodeGuid`
 *  (the save's guid pass gives each member a durable guid first), and what stays in the localId channels is the root's
 *  own edits (the root's localId never renumbers) and a pre-v5 member's (no `nodeGuid`, so no translation could move it
 *  either — `translateLocalIds` keeps its number). */
export function savedFrameDoc(rootId: number, source: string, current: PrefabFile): PrefabFile {
  return levelDoc(rootId, source).doc ?? current;
}

/** {@link translateLocalIds} applied to everything a rebuild carries by localId. */
function translateCarried<S extends { added?: AddedEntity[]; removed?: number[]; removedTraits?: Record<number, string[]>; moved?: Record<number, string> }>(
  lid: (n: number) => number,
  overrides: Record<number, Record<string, Record<string, unknown>>>,
  structure: S,
): { overrides: typeof overrides; structure: S } {
  const keys = <V,>(m: Record<number, V> | undefined): Record<number, V> | undefined => {
    if (!m) return m;
    const out: Record<number, V> = {};
    for (const [k, v] of Object.entries(m)) { const n = lid(Number(k)); if (n) out[n] = v; }
    return out;
  };
  return {
    overrides: keys(overrides)!,
    structure: {
      ...structure,
      removed: structure.removed?.map(lid).filter((n) => n > 0),
      removedTraits: keys(structure.removedTraits),
      // An anchor the template dropped reads as 0 — "merely absent", which `applyStructureCore`
      // re-anchors to the root with a warning, rather than an anchor some other member now holds.
      added: structure.added?.map((n) => ({ ...n, parentLocalId: lid(n.parentLocalId) })),
      ...(structure.moved ? { moved: keys(structure.moved) } : {}),
    },
  };
}

/** The template key marker of every entity in `ids` that carries one, by durable guid (old → new through `remap`). A key
 *  is identity, the same kind as the guid and `Transient`, and a rebuild's scene-form capture carries the guid alone
 *  (#1567). The marker only: a node that reached a rebuild without one lost it earlier, and the loader's heal and
 *  every other carrier (#1426, #1427, #1430) stamp it back where it can be recovered at all. */
function templateKeysByGuid(ids: Iterable<number>, remap: ReadonlyMap<string, string>): Map<string, string> {
  const eaMeta = getTraitByName('EntityAttributes');
  const out = new Map<string, string>();
  if (!eaMeta) return out;
  for (const id of ids) {
    const key = templateKeyOf(findEntity(id));
    const guid = key ? durableGuid((readTraitData(id, eaMeta) as { guid?: string } | null)?.guid) : '';
    if (guid) out.set(remap.get(guid) ?? guid, key);
  }
  return out;
}

/** Put each key {@link templateKeysByGuid} read back on the live entity now holding that guid, where the respawn left it
 *  unmarked. Only fills a missing marker: a node the NEW template spawned carries its own. */
function restoreTemplateKeys(keys: ReadonlyMap<string, string>): void {
  for (const [guid, key] of keys) {
    const entity = findEntityByGuid(guid);
    if (entity && !templateKeyOf(entity)) setTemplateKey(entity, key);
  }
}

/** Tear down a single live prefab instance and re-instantiate it cleanly from
 *  `prefab`, re-applying the given per-field `overrides` and `structure` on top.
 *  Preserves the instance root's scene parent. Returns the NEW instance root ecs
 *  id (ids change across a rebuild). Shared by refresh (the prefab file was
 *  edited) and revert (per-instance reset toward the prefab base).
 *
 *  The teardown set is recomputed LIVE each call — all members plus their
 *  non-member descendants — so kept additions in `structure.added` are re-spawned
 *  rather than duplicated, and re-spawned additions from a PRIOR rebuild are torn
 *  down too instead of accumulating (the frozen `structure.consumedEcsIds` is NOT
 *  used for teardown; see F5). Live per-copy overrides on NESTED children are
 *  captured before teardown and re-applied after, so an outer rebuild doesn't reset
 *  them to the nested prefab base (design risk R3). */
export function rebuildInstance(
  rootInstanceId: number,
  source: string,
  prefab: PrefabFile,
  overrides: Record<number, Record<string, Record<string, unknown>>>,
  structure: { added?: AddedEntity[]; removed?: number[]; removedTraits?: Record<number, string[]>; consumedEcsIds?: Set<number>; nestedMoves?: InstanceStructure['nestedMoves']; templateKeys?: InstanceStructure['templateKeys'] },
  /** The document the LIVE tree was expanded from, when it is not `prefab` — a refresh's old file. The
   *  nested re-apply subtracts what that document's chain applies (#1386, #1401). */
  baseline: PrefabFile = prefab,
  /** Old → new member guid, when the rebuild changes member paths (#1437): a move's target and a parked
   *  member's parent are looked up by guid AFTER the rebuild, so they are translated first. */
  remap: ReadonlyMap<string, string> = new Map(),
  /** The state of every nested frame, in place of the LIVE capture (#1741): an undo rebuilding an instance to one side of
   *  a step whose live nested frames already show the other side. Captured by {@link captureNestedFrames}, in `baseline`'s
   *  numbering, and re-applied exactly as a live capture is — each link found by identity, each capture translated from
   *  the document it was read against (I4). */
  nested?: readonly NestedInstanceCapture[],
): number {
  const PrefabInstanceMeta = getTraitByName('PrefabInstance');
  if (!PrefabInstanceMeta) return rootInstanceId;
  // A document with no root to expand would tear the instance down and spawn nothing in its place (#1768): the live
  // instance stays, as a failed fetch leaves it.
  if (!expandsToRoot(prefab, getCachedPrefabSync)) {
    console.warn(`[Prefab] rebuild of ${source} skipped: the prefab expands to no root`);
    return rootInstanceId;
  }
  if (remap.size) structure = remapGuidValues(structure, remap) as typeof structure;
  // A localId means something only together with the document it was read from (#1468 Phase 4). What
  // the caller captured is in `baseline`'s numbering, and the respawn below is in `prefab`'s; a template
  // re-save that renumbered them would otherwise hand every edit to whichever member inherited the
  // number. Today's callers (Apply and its undo) are additive and never renumber, so this is the
  // function honouring its own contract — it accepts a baseline other than the document it rebuilds.
  const lidOf = translateLocalIds(baseline, prefab);
  if (lidOf) ({ overrides, structure } = translateCarried(lidOf, overrides, structure));

  // Preserve the instance root's scene placement (its parent is not a member, so
  // it survives the teardown). instantiatePrefab defaults to parentId 0, which
  // would detach a nested instance or any non-root-parented instance.
  const eaMeta = getTraitByName('EntityAttributes');
  const oldRootEa = eaMeta ? readTraitData(rootInstanceId, eaMeta) : null;
  const parentId = (oldRootEa?.parentId as number) ?? 0;

  // The member identity this instance is carrying, read off the live tree before the teardown
  // destroys it (v16, #1468 — see `restoreInstanceMembers`, which puts it back).
  // ⚠️ NO document, and therefore no `parent`: a rebuild re-applies the moves from the STRUCTURE it
  // is handed, which is the REDUCED one on a revert. Carrying `parent` here instead would re-assert
  // the move the revert just took away — measured, as the revert test going red.
  const carriedMembers = captureInstanceMembers(rootInstanceId);
  // Snapshot live per-copy overrides on nested children BEFORE the teardown
  // (they get cascade-destroyed with the outer members and re-expanded fresh).
  // The documents stay out of the remap: they hold no instance guid, and a copy of each per rebuild is waste.
  const rawCaptures = nested ?? captureNestedInstanceOverrides(rootInstanceId, baseline);
  const nestedCaptures = (remapGuidValues(rawCaptures.map(({ doc: _doc, ...cap }) => cap), remap) as Omit<NestedInstanceCapture, 'doc'>[])
    .map((cap, i) => ({ ...cap, doc: rawCaptures[i]!.doc }));
  // Only a chain's FIRST link is a row of `baseline`. ⚠️ The re-apply does NOT address by this number where the link has
  // a nodeGuid: `linkIn` finds every link by identity in the document its frame expands now (#1771). What still reads
  // the translated number is the `nestedMoves` match below (`cap.chain.join('.')`) and an unkeyed (pre-v5) link.
  // (`nestedMoves` keys carry the same first link, and only a Revert — same document on both sides — hands them in.)
  if (lidOf) for (const cap of nestedCaptures) if (cap.chain.length) cap.chain = [lidOf(cap.chain[0]!), ...cap.chain.slice(1)];
  const nm = structure.nestedMoves;
  if (nm) {
    const at = (key: string) => {
      const [chain, lid] = key.slice('~moved.'.length).split(':');
      const cap = nestedCaptures.find((c) => c.chain.join('.') === chain);
      return cap ? { cap, lid: Number(lid) } : null;
    };
    for (const key of nm.drop ?? []) {
      const hit = at(key);
      if (hit) hit.cap.structure = { ...hit.cap.structure, moved: Object.fromEntries(Object.entries(hit.cap.structure.moved ?? {}).filter(([l]) => Number(l) !== hit.lid)) };
    }
    for (const [key, guid] of Object.entries(nm.set ?? {})) {
      const hit = at(key);
      if (hit) hit.cap.structure = { ...hit.cap.structure, moved: { ...hit.cap.structure.moved, [hit.lid]: guid } };
    }
  }

  // Transience is a property of the IDENTITY, not of the id — the same reasoning that carries the
  // durable guid across the respawn below. Read before the teardown, re-applied after (#1301).
  // Belt-and-braces since `collectInstanceRoots` no longer hands a runtime instance to the refresh
  // fan-out; it stands because a rebuild must not be able to make an unserializable entity
  // serializable, whatever route reaches it.
  const wasTransient = !!findEntity(rootInstanceId)?.has(Transient);
  // An OWNED nested root's row stamp is identity too: `instantiatePrefab` spawns the new root
  // unstamped, so a later move out read it as a STORED root, kept it linked, and the save
  // re-anchored its members (a ref to one dangled); the #1355 presence check also went lenient.
  const oldParentLocalId = (readTraitData(rootInstanceId, PrefabInstanceMeta)?.parentLocalId as number) || 0;
  // ⚠️ …and its IDENTITY twin (`parentNodeGuid`, #1468), which this restored only as a number. A
  // nested root's `memberNodeId` IS its `parentNodeGuid`, so a respawn that got the number back and
  // not the guid lost its identity in the outer frame: every member row inside it went unkeyed
  // across a rebuild, the stored rows dangled and its members re-derived. (When this was found,
  // `memberNodeId` still fell back to the child document's `nodeGuid`, so the keys CHANGED instead;
  // the Phase 3 close-out removed that fallback. Either way the restore below is what keeps them.)
  const oldParentNodeGuid = (readTraitData(rootInstanceId, PrefabInstanceMeta)?.parentNodeGuid as string) || '';
  // …and the THIRD identity field of an owned root: the owner link a move writes (`linkOwnerBeforeMove`). Without
  // it the respawn's owner was read off where it hangs, which names the right frame only while that is a member of
  // its own owner; moved under the OUTER frame, it read as user-added, and the save unlinked it from its row (#1499).
  const oldOwnerGuid = (readTraitData(rootInstanceId, PrefabInstanceMeta)?.ownerGuid as string) || '';
  // …and, for a template REFERENCE node's root, the moves the node states in its frame (#1543): the respawn records a
  // fresh frame with none, and no spawner runs for this root, so the next save lost them (close-out review).
  const oldRoot = findEntity(rootInstanceId);
  const nodeMoved = oldRoot ? frameRootDoc(getCurrentWorld(), oldRoot)?.nodeMoved : undefined;
  // What the layers ENCLOSING this root forward into its expansion, as a load hands it (#1737): an owned nested root's
  // chain, a template reference node's channels. Read before the teardown, which the climb needs live. Every nested frame
  // the expansion brings in then gets its whole layer, whether a capture reaches it or not (one the Revert restores, one
  // the new template gains, one a re-pointed row now expands), and the nested capture subtracts the same state. Null for
  // a stored root nothing encloses, which expands as the plain top call it always was.
  const forward = frameForward(rootInstanceId, prefab);
  // …and what the scene's own legacy channels say about frames the stored root above never had (#1780), outermost.
  const legacy = keptLegacyForward(rootInstanceId);

  const { toDestroy, parked, kept } = rebuildTeardown(rootInstanceId, remap);
  // Every torn-down node's template key, by guid: the capture carries the guid alone, and only a key-derived guid could
  // be recovered afterwards — a node the user dropped (v4 guid), or one the re-apply re-homed, came back unkeyed, and
  // the next template save minted it a new key (#1567).
  const carriedKeys = templateKeysByGuid(toDestroy, remap);
  // …and the capture's, for a node this teardown does not hold: a Revert's undo brings back the node the Revert removed.
  for (const [guid, key] of Object.entries(structure.templateKeys ?? {})) if (!carriedKeys.has(guid)) carriedKeys.set(remap.get(guid) ?? guid, key);
  // The kept-orphan store (R2) is left as a reload would leave it (#1535): read what a save would write for what the
  // teardown destroys, BEFORE it does, and settle the store once the re-apply has run.
  const settleKeptOrphans = captureRowsForSettle(rootInstanceId, baseline, prefab, toDestroy, remap);
  for (const p of [...parked, ...kept]) if (eaMeta) writeTraitField(p.id, eaMeta, 'parentId', 0);
  // What the delete's frame ending detaches INSIDE a kept frame is put straight back (close-out review): a kept root that
  // was ever moved carries an `ownerGuid` link naming the root torn down here, so `promoteOwnedRoots` promoted it to a
  // stored root (its row link cleared, its members renamed) and `seatKeptFrames` then found no owner and dropped it.
  const keptSubtree = new Set(kept.length ? collectSubtreeIds(getAllEntities().map((e) => [e.id, e.parentId] as const), kept.map((k) => k.id)) : []);
  const keptGuids = new Set(getAllEntities().filter((e) => keptSubtree.has(e.id) && e.guid).map((e) => e.guid!));
  const detached = deleteEntities([...toDestroy]);
  if (kept.length) relinkDetachedMembers(detached.filter((d) => keptGuids.has(d.guid)));

  // A kept scene-added reference node IS that node's live expansion: its respawn from the structure (a placeholder, the
  // prefab being missing) is skipped, wherever the structure states it, this root's or a nested frame's. One the
  // structure no longer names (a Revert of its add) goes, as the teardown would have taken it.
  const keptNodes = new Map(kept.filter((k) => !k.owned).map((k) => {
    const g = durableGuid((eaMeta ? readTraitData(k.id, eaMeta) : null)?.guid as string);
    return [remap.get(g) ?? g, k] as const;
  }));
  const namedNodes = new Set<string>();
  if (keptNodes.size) {
    structure = { ...structure, added: withoutKeptNodes(structure.added, keptNodes, namedNodes) };
    for (const cap of nestedCaptures) cap.structure = { ...cap.structure, added: withoutKeptNodes(cap.structure.added, keptNodes, namedNodes) ?? [] };
  }
  const beforeSpawn = new Set(getAllEntities().map((e) => e.id));
  // Still a TOP call: its own token scope, resolved by the derive below once the member guids are restored, and the
  // forwarded state applied at its NESTED rows only. The root's own members take their layer from `overrides`/`structure`.
  const forwardedOverrides = legacy?.nestedOverrides ? mergeNestedOverridePaths(forward?.nestedOverrides, legacy.nestedOverrides) : forward?.nestedOverrides;
  // The kept structure slots and values are the OUTERMOST layer (layers run innermost first), as a load makes the entry's —
  // its values folded at that depth too (#1877 S4, `StructureLayer.values`).
  const forwardedLayers = legacy?.nestedStructure || legacy?.nestedOverrides
    ? [...(forward?.layers ?? []), { slots: legacy.nestedStructure, valuePaths: legacy.nestedOverrides }]
    : forward?.layers;
  const newRootId = forward || legacy
    ? instantiatePrefab(prefab, parentId, new Set(forward?.stack ?? []), forwardedOverrides, forwardedLayers)
    : instantiatePrefab(prefab, parentId);
  // Preserve the instance root's stable guid across the teardown+respawn so refs
  // into the instance (UI bindings, guid-based undo) survive the rebuild — the
  // re-instantiated root would otherwise mint a fresh guid. Same identity, so
  // carrying the guid is correct (not a duplicate).
  // Durable only (#1210): a runtime guid belonged to the destroyed root's address row, so copying it
  // would leave the new root answering to nothing; the respawn's own runtime guid stands instead.
  if (eaMeta && durableGuid(oldRootEa?.guid as string)) writeTraitField(newRootId, eaMeta, 'guid', oldRootEa!.guid as string);
  if (wasTransient) findEntity(newRootId)?.add(Transient);
  setPrefabSource(newRootId, prefab);
  if (oldParentLocalId) writeTraitField(newRootId, PrefabInstanceMeta, 'parentLocalId', oldParentLocalId);
  if (oldParentNodeGuid) writeTraitField(newRootId, PrefabInstanceMeta, 'parentNodeGuid', oldParentNodeGuid);
  if (oldOwnerGuid) writeTraitField(newRootId, PrefabInstanceMeta, 'ownerGuid', oldOwnerGuid);
  if (nodeMoved) {
    // Queued after the new document's own moves (`instantiatePrefab`), as the spawners queue them, so they win.
    queuePrefabMoves(getCurrentWorld(), newRootId, nodeMoved, '[Prefab]');
    const newRoot = findEntity(newRootId);
    if (newRoot) noteNodeMoves(getCurrentWorld(), newRoot, source, prefab, nodeMoved);
  }
  applyOverridesByRootInstance(newRootId, overrides);
  applyStructureByRootInstance(newRootId, prefab, structure);
  reapplyNestedInstanceOverrides(newRootId, nestedCaptures);
  // Before the member restore and the derive below: a replayed row's guid and move go through them like any other.
  // Every guid this rebuild PINS — a kept row replayed here, the carried members and reference-node rows below — so the
  // derive can drop one that collides with a derivation, exactly as the load does (#1777).
  const pinned = new Set<number>();
  settleKeptOrphans(newRootId, pinned);
  if (legacy) settleKeptLegacy(legacy);
  // A rebuilt OWNED nested instance re-expands from its own document only: the moves the prefabs around it make
  // of its members are queued again, or an apply or revert on it undid them in every instance (#1437 review).
  // Only for members THIS rebuild respawned: any other member is where the scene's own moves left it, and a
  // base move replayed on it would record its current parent as its home (third-review F1).
  if (oldParentLocalId) {
    const respawned = new Set(getAllEntities().map((e) => e.id).filter((id) => !beforeSpawn.has(id)));
    for (const f of enclosingFrames(newRootId)) {
      const moved = frameMovesOf(f.root, f.doc);
      if (!moved) continue;
      const index = memberPathIndex(getCurrentWorld(), f.root);
      const respell = frameRespell(getCurrentWorld(), f.root);
      const mine = Object.fromEntries(Object.entries(moved).filter(([key]) => {
        // Through the lookup, so a key written before #1809 (a keyed node's path through its anchor) still names it.
        const member = memberPathLookup((k) => index.get(k), memberPathSteps(key), respell);
        return !!member && respawned.has(member.id());
      }));
      if (Object.keys(mine).length) queuePrefabMoves(getCurrentWorld(), f.root, mine, '[Prefab]');
    }
  }
  // Put the identity the instance was carrying back FIRST, refs and all — the same order the loader
  // uses (`applyStoredMemberRows` before `deriveInstanceMemberGuids`), and since Phase 3 it has to be.
  // ⚠️ A queued move names its target BY GUID and drains at the end of the derive below, so a target
  // whose stored guid had not been restored yet was simply "gone" and the member stayed at its row:
  // a move inside a SECOND instance vanished whenever an Apply rebuilt them all. Restoring after the
  // derive was right while every member's guid was derived — there was nothing to restore that the
  // derive had not just computed — and it stopped being right the moment identity was stored.
  restoreInstanceMembers(newRootId, carriedMembers, pinned);
  // …and the rows of every user-added REFERENCE node the re-apply respawned inside it (#1482), in the
  // same place and for the same reason. A reference node is its own row-writing root, so the carry
  // above never reaches its members, and they re-derived: a stored guid that differed from the
  // derivation was lost, and with it anything naming that member — an outer row's `parent` included,
  // so the move silently dropped on the next save. The loader pins these rows from the node itself
  // (`collectReferenceNodeRows`), and the node's capture carries them here the same way.
  const referenceRows = collectReferenceNodeRows(structure.added);
  for (const cap of nestedCaptures) collectReferenceNodeRows(cap.structure.added, referenceRows);
  for (const [refGuid, rows] of referenceRows) {
    const refRoot = findEntityByGuid(refGuid);
    if (refRoot) restoreInstanceMembers(refRoot.id(), rows, pinned);
  }
  // Each torn-down node's key marker, once every guid is back (the re-apply's, the settle's, the member restore's): unkeyed,
  // the next Refresh's settle gate (`keepsTemplateRows`) read a dropped reference node as no template node (#1567).
  restoreTemplateKeys(carriedKeys);
  // The respawned members and template-keyed added nodes are guid-less until derived (#1387). Only
  // fills empty guids, so the root's carried guid above and every restored scene guid stand — except a restored guid
  // that a derivation under the NEW template also produces: that pin yields, as the load's does (#1777).
  deriveMemberGuidsAfterPins(getCurrentWorld(), pinned);
  // Scene OWNERSHIP is identity too (#1431): every respawn — members, nested expansions, the restored
  // added nodes — comes back unstamped, i.e. primary-owned, so a BASE scene's instance left the base
  // file on the next Save All and vanished from every other level using that base. Read off the old
  // ROOT, not derived from the parent: a base instance usually sits at the scene root, with no parent
  // to inherit from. The WHOLE subtree takes it, because that is where a save already puts every
  // node under a base instance (the primary save drops a subtree with a base ancestor). A primary
  // instance's '' is already what the respawn wrote, so only a base stamp is carried. Carrying it does
  // not WRITE the base — the edit routes mark it dirty (`RevertResult.affectedScenes`, apply's undo).
  const sourceScene = (oldRootEa?.sourceScene as string) || '';
  if (eaMeta && sourceScene) {
    const links = getAllEntities().map((e) => [e.id, e.parentId] as const);
    // …and every member moved OUT of the subtree (#1437): it is the instance's, wherever it hangs, and so is
    // what hangs under it. Found through its template parent (`identityParents.ts`), to a fixpoint.
    const stamped = new Set(collectSubtreeIds(links, [newRootId]));
    const rebuilt = worldIdentityParents(getCurrentWorld());
    for (let grew = true; grew;) {
      grew = false;
      for (const e of getAllEntities()) {
        if (stamped.has(e.id) || !rebuilt.moved(e.id) || !stamped.has(rebuilt.parentOf(e.id))) continue;
        for (const id of collectSubtreeIds(links, [e.id])) stamped.add(id);
        grew = true;
      }
    }
    for (const id of stamped) writeTraitField(id, eaMeta, 'sourceScene', sourceScene);
  }
  // After the ownership stamp: a member of ANOTHER instance put back under ours keeps its own scene.
  const after = parked.length ? worldIdentityParents(getCurrentWorld()) : null;
  for (const p of parked) {
    // Its parent gone from the rebuilt instance (the prefab lost that row), it goes back to its template parent —
    // still inside its own instance — rather than being left at the scene root, which is out of every instance.
    const live = new Map(getAllEntities().filter((e) => e.guid).map((e) => [e.guid!, e.id]));
    const back = live.get(p.parentGuid);
    const templateParent = after!.parentOf(p.id);
    const to = back ?? (templateParent && templateParent !== p.id ? templateParent : undefined);
    if (eaMeta && to) writeTraitField(p.id, eaMeta, 'parentId', to);
    if (!to) console.warn(`[Prefab] rebuild: the parent ${p.parentGuid} of a member moved in here is gone, and so is its template parent; it stays at the scene root`);
  }
  seatKeptFrames(kept, newRootId, new Set([...keptNodes].filter(([g]) => !namedNodes.has(g)).map(([, k]) => k.id)));
  return newRootId;
}

/** `added` without the reference nodes {@link rebuildInstance} keeps live (by guid), noting in `found` each one it took
 *  out. At ANY depth, through every channel a node can hang in — the walk `collectReferenceNodeRows` makes: a plain
 *  node's `children`, a reference node's own `added` (legacy form) and `nestedStructure[*].added`, and its member rows'
 *  `added`/`own` (the rows form a respawn capture is in). Walking `children` alone missed a kept node inside another
 *  reference node: it was respawned as a placeholder beside the kept frame, which was then dropped as unnamed, and the
 *  gesture's undo could not bring it back (#1877 L4). */
function withoutKeptNodes(added: AddedEntity[] | undefined, keep: ReadonlyMap<string, unknown>, found: Set<string>): AddedEntity[] | undefined {
  if (!added) return added;
  const out: AddedEntity[] = [];
  for (const n of added) {
    if (n.prefab && n.guid && keep.has(n.guid)) { found.add(n.guid); continue; }
    out.push(withoutKeptNodesInside(n, keep, found));
  }
  return out;
}

function withoutKeptNodesInside(n: AddedEntity, keep: ReadonlyMap<string, unknown>, found: Set<string>): AddedEntity {
  let node = n;
  if (n.children?.length) node = { ...node, children: withoutKeptNodes(n.children, keep, found)! };
  if (n.added?.length) node = { ...node, added: withoutKeptNodes(n.added, keep, found) };
  if (n.nestedStructure) {
    node = { ...node, nestedStructure: Object.fromEntries(Object.entries(n.nestedStructure).map(([k, delta]) =>
      [k, delta?.added ? { ...delta, added: withoutKeptNodes(delta.added, keep, found) } : delta])) };
  }
  if (n.members) {
    node = { ...node, members: Object.fromEntries(Object.entries(n.members).map(([k, row]) => {
      const r = row as SceneMemberRow & { added?: AddedEntity[]; own?: AddedEntity[] };
      return [k, {
        ...r,
        ...(Array.isArray(r.added) ? { added: withoutKeptNodes(r.added, keep, found) } : {}),
        ...(Array.isArray(r.own) ? { own: withoutKeptNodes(r.own, keep, found) } : {}),
      }];
    })) };
  }
  return node;
}

/** Put back the nested frames {@link rebuildTeardown} KEPT because their prefab could not be expanded (#1862), once the
 *  respawn has restored every member guid: each under the parent it hung from, by guid. The respawn recorded its row as
 *  unexpanded (#1790 ruling D) and spawned nothing there, so the kept frame IS that row's expansion now, and the row comes
 *  off the owner's `unexpanded` list — the frame record says what is live, and a save captures the kept frame from its own
 *  record (I18), as it did before the rebuild. A frame whose row the new document no longer leaves unexpanded — the row is
 *  gone (the template dropped it, a layer removed it) or was expanded after all — goes, as the teardown would have taken it:
 *  keeping it would stand it beside its replacement or outside every row. */
function seatKeptFrames(kept: readonly KeptFrame[], newRootId: number, unnamed: ReadonlySet<number>): void {
  if (!kept.length) return;
  const eaMeta = getTraitByName('EntityAttributes');
  const piMeta = getTraitByName('PrefabInstance');
  if (!eaMeta || !piMeta) return;
  const world = getCurrentWorld();
  const live = new Map(getAllEntities().filter((e) => e.guid).map((e) => [e.guid!, e.id]));
  const drop: number[] = [...unnamed];
  for (const k of kept) {
    if (unnamed.has(k.id)) continue;
    // A scene-added node whose anchor the new template dropped hangs from the root, as its respawn would have (the structure
    // re-anchors such a node to the root with a warning, `applyStructureCore`).
    const to = live.get(k.parentGuid) ?? (k.owned ? undefined : newRootId);
    if (to) writeTraitField(k.id, eaMeta, 'parentId', to);
    else drop.push(k.id);
  }
  // After every re-seat: ownership is read off where a root hangs.
  const identity = worldIdentityParents(world);
  for (const k of kept) {
    if (drop.includes(k.id) || !k.owned) continue;
    const pi = readTraitData(k.id, piMeta) as { parentLocalId?: number; parentNodeGuid?: string; source?: string } | null;
    const owner = identity.ownerOf(k.id);
    const ownerEntity = owner ? findEntity(owner) : undefined;
    const rec = ownerEntity ? frameRootDoc(world, ownerEntity) : undefined;
    // By the row's identity when the frame carries one: the respawned document can number its rows differently from the
    // one the frame was built in, and falling back to the old NUMBER there claimed another unexpanded row (close-out
    // review). The number only for a frame with no identity (pre-v5). Either way the row must expand this frame's prefab.
    const rows = (rec?.doc as PrefabFile | undefined)?.entities ?? [];
    const row = pi?.parentNodeGuid ? rows.find((r) => r.nodeGuid === pi.parentNodeGuid) : rows.find((r) => r.localId === pi?.parentLocalId);
    // Resolved paths compared only when there IS one: a kept frame's prefab is missing, so in the dev editor its guid was
    // pruned, and two unresolvable refs read as `undefined === undefined` (close-out review 2).
    const at = pi?.source ? resolveRef(pi.source) : undefined;
    const lid = row && row.prefab && (row.prefab === pi?.source || (at !== undefined && resolveRef(row.prefab) === at)) ? row.localId : 0;
    if (!rec || !lid || !rec.unexpanded?.includes(lid)) { drop.push(k.id); continue; }
    noteFrameRootDoc(world, ownerEntity!, { ...rec, unexpanded: rec.unexpanded.filter((n) => n !== lid) });
    if (pi?.parentLocalId !== lid) writeTraitField(k.id, piMeta, 'parentLocalId', lid);
  }
  if (drop.length) deleteEntities(drop);
}

/** Rebuild instance `rootInstanceId` to `overrides`/`structure` — a state captured against `capturedFrom`, an earlier
 *  copy of its document — onto the editor's CURRENT copy of `source` (#1665). What a Revert's undo and redo put back:
 *  the template can have changed since the Revert (a prefab-edit save, an Apply from another instance), and a rebuild
 *  from `capturedFrom` undid that change on this one instance — a member the template gained since then vanished, and
 *  the next save wrote it as REMOVED by this instance.
 *
 *  ⚠️ Not `rebuildInstance(…, now, …, baseline = capturedFrom)`: `baseline` is two things at once there — the numbering
 *  of what is carried, and the document the LIVE tree was expanded from, whose chain the nested capture subtracts. Here
 *  they differ (the live tree was rebased since), so each is given its own: the carried state is translated into the
 *  live frame's recorded document, which is then the baseline — the rule `refreshInstances` follows. The base itself
 *  is still computed only where `rebuildInstance` computes it (`captureNestedInstanceOverrides`); this picks the
 *  document, never the subtraction. `nestedMoves` keys are matched after the rebuild's own translation, so they go
 *  straight to the target's numbering.
 *
 *  Returns null, rebuilding nothing, when a frame nested in the instance is stale — the refusal `refreshInstances` gives
 *  (#1493): the nested capture would read it against the cached child rows. */
export function rebuildInstanceFromCapture(
  rootInstanceId: number,
  source: string,
  capturedFrom: PrefabFile,
  overrides: Record<number, Record<string, Record<string, unknown>>>,
  structure: Parameters<typeof rebuildInstance>[4],
  /** Its nested frames as captured with it ({@link captureNestedFrames}), in place of the live ones (#1741). Each chain's
   *  first link is a row of `capturedFrom` and goes to `live` with the rest; each capture's own members are translated
   *  by the re-apply, from the document it holds. */
  nested?: readonly NestedInstanceCapture[],
): number | null {
  if (framesBuiltFromOtherRows(rootInstanceId, { nestedOnly: true }).length) return null;
  const now = prefabCache.get(source) ?? capturedFrom;
  const handle = findEntity(rootInstanceId);
  const rec = handle ? frameRootDoc(getCurrentWorld(), handle) : undefined;
  const live = rec && rec.source === source ? rec.doc as PrefabFile : now;
  const toLive = translateLocalIds(capturedFrom, live);
  if (toLive) ({ overrides, structure } = translateCarried(toLive, overrides, structure));
  if (toLive && nested) nested = nested.map((c) => (c.chain.length ? { ...c, chain: [toLive(c.chain[0]!), ...c.chain.slice(1)] } : c));
  const toNow = translateLocalIds(capturedFrom, now);
  if (toNow && structure.nestedMoves) structure = { ...structure, nestedMoves: translateNestedMoveKeys(structure.nestedMoves, toNow) };
  return rebuildInstance(rootInstanceId, source, now, overrides, structure, live, new Map(), nested);
}

/** `nestedMoves` keys (`~moved.<chain>:<lid>`) with their chain's FIRST link — a row of the outer document — put through
 *  `lid`; the rest are rows of child documents. A key whose row the target dropped is dropped. */
function translateNestedMoveKeys(nm: NonNullable<InstanceStructure['nestedMoves']>, lid: (n: number) => number): NonNullable<InstanceStructure['nestedMoves']> {
  const key = (k: string): string | null => {
    const [chain = '', member = ''] = k.slice('~moved.'.length).split(':');
    const [first, ...rest] = chain.split('.');
    const to = lid(Number(first));
    return to ? `~moved.${[to, ...rest].join('.')}:${member}` : null;
  };
  return {
    ...(nm.drop ? { drop: nm.drop.map(key).filter((k): k is string => k !== null) } : {}),
    ...(nm.set ? { set: Object.fromEntries(Object.entries(nm.set).flatMap(([k, g]) => { const t = key(k); return t ? [[t, g]] : []; })) } : {}),
  };
}

/** Tear down each instance in `rootIds`, re-instantiate from `newPrefab`, and
 *  re-apply each instance's per-field overrides (computed against `oldPrefab`).
 *  This preserves deliberate user customizations on every instance. */
export function refreshInstances(
  source: string,
  rootIds: number[],
  oldPrefab: PrefabFile,
  newPrefab: PrefabFile,
  /** Old → new member guid (#1437): what the rebuild consumes by guid follows it. */
  remap: ReadonlyMap<string, string> = new Map(),
  /** The instance(s) an Apply copied `fields` (`localId.Trait.field`, `oldPrefab`'s numbering) FROM (#1469):
   *  they are subtracted from its capture, or their marks would carry them over as overrides. Several for a U14 Apply
   *  that wrote nested frames' own edits into their prefab (#1693). */
  appliedFrom?: { rootId: number; fields: ReadonlySet<string> } | readonly { rootId: number; fields: ReadonlySet<string> }[],
): number {
  if (rootIds.length === 0) return 0;

  // Pinned BEFORE the loop, because the loop is what invalidates ids: each rebuild deletes a
  // subtree and spawns a replacement, and a freed id can come straight back.
  const eaMetaForGuid = getTraitByName('EntityAttributes');
  const guidOf = new Map<number, string>();
  for (const id of rootIds) {
    guidOf.set(id, eaMetaForGuid ? ((readTraitData(id, eaMetaForGuid)?.guid as string) || '') : '');
  }
  // DEEPEST FIRST (close-out review 2). An instance the author dropped inside another instance of the same
  // source is captured by the outer rebuild through `captureNestedRef`, which reads the CACHED document; the
  // inner one is only expanded from that document once its own refresh has run. Outer first, the capture read
  // the not-yet-refreshed inner against the new rows and saved a node the apply had just promoted as REMOVED.
  const parentOf = new Map(getAllEntities().map((e) => [e.id, e.parentId]));
  const depth = (id: number) => { let n = 0; for (let at = parentOf.get(id) ?? 0; at && n < 10_000; at = parentOf.get(at) ?? 0) n++; return n; };
  rootIds = [...rootIds].sort((a, b) => depth(b) - depth(a));

  let refreshed = 0;
  for (const oldRootId of rootIds) {
    // ⚠️ A root can be DEAD by the time the loop reaches it, and `rebuildInstance` does not
    // no-op on one: it reads `parentId` as 0, finds no members, deletes nothing, and then
    // `instantiatePrefab(prefab, 0)` spawns a DUPLICATE instance at the scene root. The shape
    // is `collectInstanceRoots(S)` returning both an instance of S and a second instance of S
    // the author dropped INSIDE it, where the outer teardown destroys the inner root first.
    //
    // ⚠️ TRACED, NOT DRIVEN. Found by reading, in the #1295 review. I could not build a
    // fixture that fires it — with an inner instance nested under an outer one, the refresh
    // loop reached both while still alive ("Refreshed 2 instance(s)"), so the ordering the
    // hazard needs did not occur. Kept because it costs one map lookup and the failure it
    // prevents is a silently duplicated subtree; do NOT read it as a covered case.
    //
    // ⚠️ Checked by GUID, not id — an id-only check is worse than none here. See
    // `isLiveInstanceRoot`.
    if (!isLiveInstanceRoot(oldRootId, guidOf.get(oldRootId) ?? '')) continue;
    // Capture this instance's per-field overrides AND structural diffs against
    // the OLD prefab, then tear down + re-instantiate from the NEW prefab and
    // re-apply them. Structure must be captured before the teardown inside
    // rebuildInstance (it walks the live non-member descendants).
    //
    // ⚠️ Each root is captured against the document IT was expanded from, when it has a record of its own
    // (#1483) — `oldPrefab` is only what the caller's cache held, and a root carried flat across a reload may
    // be older. A root holding a stale NESTED frame is skipped: the nested capture reads the cached child
    // document, so rebuilding it would move that frame's edits onto the wrong rows, silently and for good (it
    // also clears the record the refusal reads). Left alone, it stays refused until a reload's
    // `rebaseStaleInstances` rebuilds that nested frame by itself, from its own record (#1493).
    // Judged against the CACHE, because that is what the nested capture reads (`captureNestedRef`). A P
    // instance the author dropped inside another P instance is current by now: the loop runs deepest first.
    if (framesBuiltFromOtherRows(oldRootId, { nestedOnly: true }).length) {
      console.warn(`[Prefab] not refreshing an instance of "${source}": a prefab nested in it has changed since it was built — reload its scene to update it`);
      continue;
    }
    refreshed++;
    const handle = findEntity(oldRootId);
    const rec = handle ? frameRootDoc(getCurrentWorld(), handle) : undefined;
    const baseline = rec && rec.source === source ? rec.doc as PrefabFile : oldPrefab;
    let captured = captureInstanceOverrides(oldRootId, baseline);
    const from = (Array.isArray(appliedFrom) ? appliedFrom : appliedFrom ? [appliedFrom] : []).find((a) => a.rootId === oldRootId);
    if (from) {
      // Every applied field leaves the source (#1469, U15): U13 reverted the enclosing overrides that could shadow one.
      captured = subtractFieldOverrides(captured, from.fields);
    }
    const capturedStructure = captureStructureForRespawn(oldRootId, baseline);
    rebuildInstance(oldRootId, source, newPrefab, captured, capturedStructure, baseline, remap);
  }

  // Reports what was REBUILT, not what was listed. The two differ exactly when a root died
  // under another root's teardown, so this line is the only place that case becomes visible.
  console.log(`[Prefab] Refreshed ${refreshed} instance(s) of "${source}"`);
  return refreshed;
}

/** Rebuild every live instance FRAME — a stored root, or an owned nested root (#1493) — whose own record says
 *  it was expanded from a document other than the editor's cached copy of its source (#1483). A root carried
 *  FLAT across a hot reload — a kept base scene's, or a `Persistent` one's — never sees the prefab change that
 *  caused the reload, and neither does any frame nested inside it; everything else was just re-expanded from
 *  disk, compares equal, and is left alone. This is the refresh an Apply gives every instance, run from the
 *  document each frame was really expanded from. Returns how many were rebuilt.
 *
 *  A nested frame is rebuilt BY ITSELF, as the Apply fan-out already rebuilds a nested root of the source it
 *  applied: its own capture reads its own record, where an outer rebuild's nested capture would read the cached
 *  child document and move that frame's edits onto the wrong rows. Inner frames first — by what each teardown
 *  destroys, not by live depth (#1499) — so an outer rebuild (of a frame that is stale itself, or of a P instance the
 *  author dropped inside another) only ever captures nested frames that are current. If the world is replaced
 *  while the nested prefabs load, nothing is rebuilt — the ids were collected in the world that is gone, and
 *  the new world's load recorded its own documents. */
export async function rebaseStaleInstances(
  /** Only frames of these refs (a prefab write rebuilds what IT changed, not every other prefab's stale frames). */
  opts: { sources?: ReadonlySet<string> } = {},
): Promise<number> {
  const world = getCurrentWorld();
  const stale = staleFrames(opts);
  for (const s of stale) {
    await preloadNestedPrefabs(s.to);
    await preloadNestedPrefabsForSubtree(s.root);
  }
  if (getCurrentWorld() !== world) return 0;
  return rebuildStaleFrames(stale);
}

/** {@link rebaseStaleInstances} with no wait when it needs none (#1820): a frame re-linked or respawned from a record — a
 *  Paste of a copy taken before its template changed, Create Prefab's undo — is brought onto the current template
 *  before the caller's step returns, when every prefab its rebuild reads is already cached (as it is right after an
 *  in-session Apply, Replace or prefab-edit save). An async step is a window a world switch can land in (#1833), so the
 *  async rebase runs only when a prefab has to be fetched, and it holds the world until it lands. True when it found a
 *  stale frame to rebuild (Create Prefab's undo remembers it: its redo cannot re-link a tree the rebase changed). */
export function rebaseStaleInstancesSoon(opts: { sources?: ReadonlySet<string> } = {}): boolean {
  const stale = staleFrames(opts);
  if (!stale.length) return false;
  const cached = (src: string) => prefabCache.has(src);
  const docCached = (doc: PrefabFile, seen = new Set<string>()): boolean => doc.entities.every((e) => {
    if (!e.prefab || seen.has(e.prefab)) return true;
    seen.add(e.prefab);
    const child = prefabCache.get(e.prefab);
    return !!child && docCached(child, seen);
  });
  const pi = getTraitByName('PrefabInstance')!;
  const subtreeCached = (root: number) => collectTree(root, getAllEntities())
    .every((e) => !e.traits.includes('PrefabInstance') || cached(readTraitData(e.id, pi)?.source as string));
  if (stale.every((s) => docCached(s.to) && subtreeCached(s.root))) { rebuildStaleFrames(stale); return true; }
  const release = beginWorldBoundOperation();
  void rebaseStaleInstances(opts)
    .catch((e) => console.error('[Prefab] rebasing a re-linked instance onto its current prefab failed:', e))
    .finally(release);
  return true;
}

/** Rebuild `stale` onto the documents it names, every nested prefab those read already cached. */
export function rebuildStaleFrames(stale: StaleFrame[]): number {
  const pi = getTraitByName('PrefabInstance')!;
  const world = getCurrentWorld();
  // ORDER: a frame is rebuilt only once no other stale frame is left in what its teardown destroys (#1499). Its
  // nested capture reads every frame in that set against the CACHED rows, so a stale one captured there had its
  // edits moved onto other members (a row the cache gained read as removed). Deepest-first by live depth got this
  // right only while every frame hung inside its owner's subtree; a frame moved out of it (#1437) can sit
  // shallower than the frame that owns it.
  //
  // RE-CHECK: an entry is rebuilt only while its id is still a root of the same source holding the very document
  // collected — so a frame some earlier rebuild respawned (current now), or an id freed by one and handed straight
  // back to a respawn, is left alone. (Rebuilt under a recycled id, another source's frame was rebuilt as this one:
  // #1493 review 2.) ⚠️ TRACED, NOT DRIVEN: the order above never lets a rebuild destroy an entry still pending, so
  // no fixture reaches this, and deleting it leaves every test green. It stays because the order is the only other
  // thing standing between a damaged tree and a frame rebuilt as the wrong prefab, and it costs one lookup.
  const pending = [...stale];
  const liveRoot = (s: (typeof pending)[number]): number => {
    const e = findEntity(s.root);
    if (!e) return 0;
    const d = readTraitData(e.id(), pi) as { source?: string; rootInstanceId?: number } | null;
    return d?.source === s.source && d.rootInstanceId === e.id() && frameRootDoc(world, e)?.doc === s.from ? e.id() : 0;
  };
  let rebuilt = 0;
  while (pending.length) {
    const roots = pending.map(liveRoot);
    for (let i = pending.length - 1; i >= 0; i--) if (!roots[i]) { pending.splice(i, 1); roots.splice(i, 1); }
    if (!pending.length) break;
    const next = roots.findIndex((r, i) => {
      const torn = rebuildTeardown(r).toDestroy;
      return roots.every((o, j) => j === i || !torn.has(o));
    });
    // Two frames cannot each destroy the other, so `next` is found; if a damaged tree ever says otherwise, take the
    // first — `refreshInstances` still refuses a frame whose teardown holds a stale one.
    const at = Math.max(next, 0);
    const [s] = pending.splice(at, 1);
    rebuilt += refreshInstances(s!.source, [roots[at]!], s!.from, s!.to);
  }
  return rebuilt;
}

/** Re-derive every BASE scene's live instance of `source` from `fromPrefab` to `toPrefab` — the
 *  refresh a prefab save runs, restricted to base-owned roots (#1431). For an undo/redo that swaps
 *  the prefab back and restores only the PRIMARY: a base loaded with it is CARRIED live, so its
 *  instances would stay built from the prefab being undone, and a dirty base would then be saved
 *  against the restored one (a member the apply removed reads as a `removed` nobody authored).
 *  `exceptGuid` names an instance the caller rebuilds itself. */
export function refreshBaseInstances(source: string, fromPrefab: PrefabFile, toPrefab: PrefabFile, exceptGuid = ''): void {
  const eaMeta = getTraitByName('EntityAttributes');
  if (!eaMeta) return;
  const roots = collectInstanceRoots(source).filter((id) => {
    const ea = readTraitData(id, eaMeta);
    return !!ea?.sourceScene && !(exceptGuid && ea.guid === exceptGuid);
  });
  refreshInstances(source, roots, fromPrefab, toPrefab);
}
