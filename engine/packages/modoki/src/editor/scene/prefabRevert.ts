/** Revert: taking an instance's selected overrides back to its template.
 *  Moved out of `prefab.ts` by the prefab.ts split (#1656 § Plan, step 5): a pure move. */

import { getCurrentWorld } from '../../runtime/core/ecs/world';
import { worldIdentityParents } from '../../runtime/core/ecs/identityParents';
import { toLocalIdKeys, splitNestedKey } from './overrideKeyGrammar';
import { hasDocKey } from '../../runtime/core/docKeys';
import { getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { isOwnedRoot, type MemberPi } from '../../runtime/core/assetRefRules';
import { resolveAffectedScenes } from './sceneDirty';
import { type PrefabFile, resolveInstanceContext } from './prefab';
import {
  getCachedPrefabSync, getPrefabSource, preloadNestedPrefabs,
} from './prefabCache';
import { baseTokenResolver } from './prefabTokens';
import { captureInstanceOverrides } from './prefabInstanceOverrides';
import { captureInstanceStructure, type InstanceStructure, resolveAddedNodeTokens } from './prefabCapture';
import {
  enclosingLayer, enclosingRowOverrides, layerAuthoredStructureKeys, nestedFrameMoves, subtractFieldOverrides,
} from './prefabChain';
import {
  framesBuiltFromOtherRows, missingSourceRefusal, staleFramesRefusal, staleInstanceRefusal,
} from './prefabFrames';
import { isOutermostEntry, captureEntrySide, rebuildEntrySide, preloadRebuildEntry, keptEnclosingSource, type EntrySide } from './prefabRebuild';
import { getAllEntities, readTraitData, findEntity } from '../../runtime/core/ecs/entityUtils';
import { unmarkOverride } from '../../runtime/loaders/overrideMarks';
import { staleAround } from '../../runtime/prefab/instanceStore';

/** Why a Revert of instance `rootInstanceId` would refuse, or null: {@link staleInstanceRefusal}, or its OWN prefab does
 *  not load (#1862). That is a live frame kept across a rebuild after its prefab was trashed, a nested one or #1738's
 *  top-level one: the base a Revert goes back to is gone, so there is nothing to revert TO. Unity's shape: it refuses the
 *  write it cannot represent and names the way out ("recover the missing … Prefab" or "unpack",
 *  `PrefabStage.PromptIfMissingVariantParentForVariant`, `PrefabUtility.SaveAsPrefabAssetArgumentCheck`). Asked through
 *  the async read, never the bare cache, so a merely cold key is not refused. The one question every Revert caller asks
 *  (the dialog, the agent op), because Revert's own `null` cannot carry a reason. */
export async function revertRefusal(rootInstanceId: number): Promise<string | null> {
  const stale = staleInstanceRefusal(rootInstanceId);
  if (stale) return stale;
  const ctx = resolveInstanceContext(rootInstanceId);
  if (!ctx) return null;
  if (!await getPrefabSource(ctx.source)) return missingSourceRefusal(ctx.rootInstanceId, ctx.source, 'revert');
  await preloadRebuildEntry(rootInstanceId); // warmed, so a merely cold prefab is not read as a trashed one
  return keptFrameRefusal(rootInstanceId);
}

/** The refusal a Revert of `rootInstanceId` gives when it lies inside a frame its entry's rebuild keeps live
 *  ({@link keptEnclosingSource}: that frame's prefab trashed, with no one record to expand it from), or null. The rebuild
 *  would leave the instance as it is, so the Revert would change nothing while reporting that it did (#1880 F7d close-out
 *  review 1). */
function keptFrameRefusal(rootInstanceId: number): string | null {
  const source = keptEnclosingSource(rootInstanceId);
  return source ? `Revert refused: this instance lies inside an instance of "${source}", whose prefab cannot be read — restore that prefab, or reload the scene, and Revert again` : null;
}

/** What the layers enclosing instance `rootInstanceId` state about the members a Revert of `-removed.<lid>` brings back
 *  (#1730): each reverted member and its template subtree in `prefab` — the field bags and components the rows set, the
 *  components and members they remove, the nodes they add under them. The rebuild re-expands the frame from its template
 *  alone and carries the layer only through what it captures live, and a member the scene DELETED had nothing live to
 *  capture: it came back as the bare template's, and the next save wrote the difference as the instance's own
 *  (`traitRemovals` of a component the row adds). Null when nothing encloses the instance or nothing is restored. */
function layerForRestoredMembers(
  rootInstanceId: number,
  prefab: PrefabFile,
  restored: readonly number[],
): {
  overrides: Record<number, Record<string, Record<string, unknown>>>;
  structure: Pick<InstanceStructure, 'added' | 'removed' | 'removedTraits'>;
} | null {
  if (!restored.length) return null;
  const layer = enclosingLayer(rootInstanceId);
  if (!layer) return null;
  const children = new Map<number, number[]>();
  for (const e of prefab.entities) {
    const parent = ((e.traits.EntityAttributes as { parentId?: number } | undefined)?.parentId) ?? 0;
    if (parent && e.localId !== prefab.rootLocalId) (children.get(parent) ?? children.set(parent, []).get(parent)!).push(e.localId);
  }
  // ⚠️ Only what the Revert actually brings BACK: a subtree member still live (moved out of the deleted member before
  // it went) is rebuilt from its own capture, which already carries the layer — seeded again, a node the layer adds
  // under it came back twice, and the save wrote the copy as the scene's own (close-out review). A plain member is one
  // of this frame's by `rootInstanceId`; an owned nested ROOT (a reference row's expansion) is its own root, and is
  // this frame's row `parentLocalId` when this frame owns it (second close-out review).
  const live = new Set<number>();
  const piMeta = getTraitByName('PrefabInstance');
  if (piMeta) {
    const identity = worldIdentityParents(getCurrentWorld());
    getCurrentWorld().query(piMeta.trait).updateEach(([pi], entity) => {
      const d = pi as MemberPi & { localId?: number; parentLocalId?: number };
      const id = entity.id();
      if (id === rootInstanceId) return;
      if (isOwnedRoot(d, id)) {
        if (identity.ownerOf(id) === rootInstanceId) live.add(d.parentLocalId as number);
      } else if (d.rootInstanceId === rootInstanceId && d.localId) live.add(d.localId);
    });
  }
  // A subtree member the scene removed on its OWN key (moved out, then deleted) is seeded too, and harmlessly: the
  // structure pass skips an addition anchored on a member it removes (`applyStructureCore`), and a field bag for an
  // absent member applies to nothing. No guard for it — one was tried and could be driven by no test.
  const lids = new Set<number>();
  for (const stack = [...restored]; stack.length;) {
    const lid = stack.pop()!;
    if (lids.has(lid)) continue;
    if (!live.has(lid)) lids.add(lid);
    stack.push(...(children.get(lid) ?? []));
  }
  const resolve = baseTokenResolver(rootInstanceId);
  const rows = resolve(layer.overrides) as Record<number, Record<string, Record<string, unknown>>>;
  const overrides: Record<number, Record<string, Record<string, unknown>>> = {};
  for (const lid of lids) {
    for (const [trait, bag] of Object.entries(rows[lid] ?? {})) {
      if (bag && typeof bag === 'object') (overrides[lid] ??= {})[trait] = { ...bag };
    }
  }
  const { structure: st } = layer;
  const removedTraits: Record<number, string[]> = {};
  for (const lid of lids) if (st.removedTraits[lid]?.length) removedTraits[lid] = [...st.removedTraits[lid]!];
  return {
    overrides,
    structure: {
      added: resolveAddedNodeTokens(resolve, st.added.filter((n) => lids.has(n.parentLocalId))) ?? [],
      removed: st.removed.filter((lid) => lids.has(lid)),
      removedTraits,
    },
  };
}

/** Return a copy of `full` structure with the selected structural keys removed.
 *  Dropping an `+added` node stops it being re-spawned (its live ids are still in
 *  `consumedEcsIds`, so they are destroyed); dropping a `-removed`/`-trait` entry
 *  lets the fresh instantiation keep that prefab member/component. */
function subtractRevertedStructure(
  full: InstanceStructure,
  selectedKeys: Set<string>,
): InstanceStructure {
  const revertedAdded = new Set<string>();
  const revertedRemoved = new Set<number>();
  const revertedRemovedTraits = new Map<number, Set<string>>();
  const revertedMoved = new Set<number>();
  for (const key of selectedKeys) {
    if (key.startsWith('~moved.')) {
      revertedMoved.add(Number(key.slice('~moved.'.length)));
    } else if (key.startsWith('+added.')) {
      revertedAdded.add(key.slice('+added.'.length));
    } else if (key.startsWith('-removed.')) {
      revertedRemoved.add(Number(key.slice('-removed.'.length)));
    } else if (key.startsWith('-trait.')) {
      const [, lidStr, traitName] = key.split('.');
      const lid = Number(lidStr);
      if (!revertedRemovedTraits.has(lid)) revertedRemovedTraits.set(lid, new Set());
      revertedRemovedTraits.get(lid)!.add(traitName);
    }
  }

  const added = full.added.filter((n) => !revertedAdded.has(n.guid));
  const removed = full.removed.filter((lid) => !revertedRemoved.has(lid));
  const removedTraits: Record<number, string[]> = {};
  for (const [lidStr, names] of Object.entries(full.removedTraits)) {
    const lid = Number(lidStr);
    const drop = revertedRemovedTraits.get(lid);
    const kept = drop ? names.filter((n) => !drop.has(n)) : names;
    if (kept.length) removedTraits[lid] = kept;
  }
  // Every added live entity (reverted or kept) is in consumedEcsIds and gets torn
  // down; kept ones are re-spawned from `added`. So consumedEcsIds is unchanged.
  // `ownedNested` likewise: reverting an add or a removal does not change WHICH instance is a
  // given nested row's own expansion.
  // A reverted move re-expands the member at its row parent (#1437).
  const moved = Object.fromEntries(Object.entries(full.moved).filter(([lid]) => !revertedMoved.has(Number(lid))));
  return { added, removed, removedTraits, moved, consumedEcsIds: full.consumedEcsIds, ownedNested: full.ownedNested };
}

/** Everything the dialog needs to wire undo/redo for a revert. The instance is
 *  rebuilt from the prefab with `reducedOverrides`/`reducedStructure` applied;
 *  undo rebuilds with the `full*` (pre-revert) state, redo with the reduced. */
export interface RevertResult {
  newRootId: number;
  source: string;
  prefab: PrefabFile;
  fullOverrides: Record<number, Record<string, Record<string, unknown>>>;
  fullStructure: InstanceStructure;
  reducedOverrides: Record<number, Record<string, Record<string, unknown>>>;
  reducedStructure: InstanceStructure;
  /** Both sides as the instance's outermost entry states them (#1880 F6d, F6-U — `captureEntrySide`): the Revert, its undo
   *  and its redo rebuild that entry by loading these. The four fields above are what the Revert takes out of the frame's
   *  own statement to get the reduced side; nothing rebuilds from them. */
  fullSide: EntrySide;
  reducedSide: EntrySide;
  /** The reverted field keys, in their localId form: the redo takes their records off again ({@link unrecordReverted}). */
  reverted: string[];
  /** The BASE scene(s) that own the instance — pass as the undo action's `affectedScenes`. A base's
   *  file is written by Save All only when it is dirty, and nothing else marks it: without this a
   *  revert on a base's instance reads saved and is lost on reload (#1431). [] for a primary one. */
  affectedScenes: string[];
}

/** A Revert REMOVES the record of each reverted field (#1914, docs/prefabs.md § I2; Unity: Revert is one of the three acts
 *  that take a record off). The rebuild's statement of a frame that states its fields whole — a template's reference
 *  node — puts the enclosing layer's value back as a statement (#1506), which the load records like any other; taken
 *  off here, so the field reads as the layer's again, and a later change to that layer reaches it. `keys` are
 *  `<localId>.<Trait>.<field>` of the frame rooted at `frameId`. */
export function unrecordReverted(frameId: number, keys: readonly string[]): void {
  const piMeta = getTraitByName('PrefabInstance');
  if (!piMeta || !keys.length) return;
  const byLid = new Map<number, [string, string][]>();
  for (const k of keys) {
    const [lid, trait, field] = k.split('.');
    if (trait && field !== undefined) byLid.set(Number(lid), [...(byLid.get(Number(lid)) ?? []), [trait, field]]);
  }
  for (const e of getAllEntities()) {
    const pi = readTraitData(e.id, piMeta) as { rootInstanceId?: number; localId?: number } | null;
    const fields = pi?.rootInstanceId === frameId ? byLid.get(pi.localId ?? 0) : undefined;
    const ent = fields && findEntity(e.id);
    if (ent) for (const [trait, field] of fields!) unmarkOverride(ent, trait, field);
  }
}

/** Revert selected overrides on a SINGLE prefab instance back to the prefab base
 *  (the inverse of applyToPrefabSelective, but scoped to this instance only —
 *  the prefab file is never touched). Implemented as a teardown + clean
 *  re-instantiation with only the NON-reverted overrides/structure re-applied, so
 *  every diff category (field, added/removed trait, added/removed entity) reverts
 *  uniformly. Returns the new instance root + the state needed for undo, or null
 *  if the entity is not an instance / the prefab can't be loaded. */
async function revertOverridesSelectiveUnmarked(
  rootInstanceId: number,
  selectedKeys: Set<string>,
): Promise<RevertResult | null> {
  const ctx = resolveInstanceContext(rootInstanceId);
  if (!ctx) {
    console.warn('[Prefab] Selected entity is not a prefab instance');
    return null;
  }
  const { source } = ctx;
  if (selectedKeys.size === 0) {
    console.log('[Prefab] Nothing selected; aborting revert.');
    return null;
  }

  const prefab = await getPrefabSource(source);
  if (!prefab) {
    console.warn(`[Prefab] Cannot revert: source prefab not in cache: ${source}`);
    return null;
  }
  // The same refusal as Apply's (#1483): the capture below would match members with other members' rows.
  const staleFrames = framesBuiltFromOtherRows(rootInstanceId);
  if (staleFrames.length) {
    console.error(`[Prefab] cannot revert: ${staleFramesRefusal(staleFrames)}`);
    return null;
  }
  // Nested children must be cached for the synchronous re-instantiation.
  await preloadNestedPrefabs(prefab);
  // The file walk above misses a USER-ADDED nested instance (not a row of `prefab`) (#1284), and the rebuild loads the
  // whole scene entry the instance sits in, every frame of it (#1880 F7a).
  await preloadRebuildEntry(rootInstanceId);
  // The keys in their localId form against this document (#1468 Phase 4) — see the same step in
  // `applyToPrefabSelective`. A key naming a member the document no longer has reverts nothing.
  selectedKeys = toLocalIdKeys(selectedKeys, prefab, getCachedPrefabSync).keys;
  // A nested instance's own edit (U14's chain-qualified key) is reverted on the nested instance itself, not here.
  for (const k of [...selectedKeys]) {
    if (splitNestedKey(k)) { selectedKeys.delete(k); console.warn(`[Prefab] not reverting ${k}: revert it on the nested instance it belongs to`); }
  }
  if (selectedKeys.size === 0) return null;

  // Capture the instance's current state against the prefab, then subtract the
  // reverted keys to get the state to re-apply after the rebuild.
  const fullOverrides = captureInstanceOverrides(rootInstanceId, prefab);
  let fullStructure = captureInstanceStructure(rootInstanceId, prefab);
  // Reverted, an outer row's removal came back and its added node was DELETED — neither is what the instance shows
  // with no override of its own (#1492's ruling, #1506 close-out review).
  for (const key of layerAuthoredStructureKeys(rootInstanceId, prefab, fullStructure)) {
    if (selectedKeys.delete(key)) console.warn(`[Prefab] not reverting ${key}: the prefab enclosing this instance authors it`);
  }
  const reducedOverrides = subtractFieldOverrides(fullOverrides, selectedKeys);
  // A reverted field goes back to what the instance resolves to WITHOUT it: on a nested instance, the enclosing row's
  // value where one sets it (#1492), not the template's. The rebuild re-expands from the template alone and carries
  // the row's values only as captured (marked) overrides, so the one reverted here is put back from the row.
  const enclosing = enclosingRowOverrides(rootInstanceId);
  for (const key of enclosing ? selectedKeys : []) {
    // A reverted member removal brings back the WHOLE of what the layer says of it: below, with the structure.
    if (key.startsWith('-removed.')) continue;
    // A reverted removal of a component the ROW adds (#1676, #1693): the row's component comes back, as the row states it —
    // the rebuild re-expands from the template alone, which never had it.
    if (key.startsWith('-trait.')) {
      const [, lidStr, t] = key.split('.');
      const bag = enclosing![Number(lidStr)]?.[t!];
      if (bag && typeof bag === 'object') ((reducedOverrides[Number(lidStr)] ??= {})[t!] = { ...bag });
      continue;
    }
    const [lid, trait, field] = key.split('.');
    const row = enclosing![Number(lid)]?.[trait!];
    if (!row || typeof row !== 'object' || !hasDocKey(row, field!)) continue;
    ((reducedOverrides[Number(lid)] ??= {})[trait!] ??= {})[field!] = row[field!];
  }
  let reducedStructure = subtractRevertedStructure(fullStructure, selectedKeys);
  // A reverted member removal (#1730): the member comes back as the enclosing rows state it — fields, components and
  // structure, for it and its template subtree — not as the bare template's. In `reduced*`, so the redo replays it.
  const restoredLayer = layerForRestoredMembers(
    rootInstanceId, prefab, [...selectedKeys].filter((k) => k.startsWith('-removed.')).map((k) => Number(k.slice('-removed.'.length))),
  );
  if (restoredLayer) {
    for (const [lid, bags] of Object.entries(restoredLayer.overrides)) {
      const into = (reducedOverrides[Number(lid)] ??= {});
      for (const [trait, bag] of Object.entries(bags)) into[trait] = { ...bag, ...into[trait] };
    }
    const { added, removed, removedTraits } = restoredLayer.structure;
    const traits = { ...reducedStructure.removedTraits };
    for (const [lid, names] of Object.entries(removedTraits)) traits[Number(lid)] = [...new Set([...(traits[Number(lid)] ?? []), ...names])];
    reducedStructure = {
      ...reducedStructure,
      added: [...reducedStructure.added, ...added],
      removed: [...new Set([...reducedStructure.removed, ...removed])],
      removedTraits: traits,
    };
  }
  // Moves inside nested instances live in what the rebuild captures of THEM (owner's B): dropped for the revert,
  // set back for its undo, which rebuilds from `fullStructure`.
  const revertedNested = nestedFrameMoves(rootInstanceId).filter((m) => selectedKeys.has(m.key));
  if (revertedNested.length) {
    reducedStructure = { ...reducedStructure, nestedMoves: { drop: revertedNested.map((m) => m.key) } };
    fullStructure = { ...fullStructure, nestedMoves: { set: Object.fromEntries(revertedNested.map((m) => [m.key, m.parentGuid])) } };
  }

  // The instance is rebuilt by loading its outermost scene entry (#1880 F6d, F6-U): the reduced side is the save's statement
  // with what the Revert takes out taken out of this frame's — the fields, the structure, and a reverted move's `parent`
  // (a move is a member row's `parent` in the rows form, at this frame and inside frames nested in it alike). A nested
  // frame's fields are its DELTA over the layers enclosing it (`captureNestedChannels`), so taking a key out of it puts
  // back what those layers state (#1492), and a reverted removal comes back as they state it (#1730) — the load applies
  // them, as a reload does.
  const kept = keptFrameRefusal(rootInstanceId);
  if (kept) { console.warn(`[Prefab] ${kept}`); return null; }
  const fullSide = captureEntrySide(rootInstanceId);
  if (fullSide) {
    const piMeta = getTraitByName('PrefabInstance');
    const eaMeta = getTraitByName('EntityAttributes');
    const movedLids = new Set([...selectedKeys].filter((k) => /^~moved\.\d+$/.test(k)).map((k) => Number(k.slice('~moved.'.length))));
    const dropParents = new Set(revertedNested.map((m) => m.memberEcs));
    if (movedLids.size && piMeta) {
      for (const e of getAllEntities()) {
        const pi = readTraitData(e.id, piMeta) as { rootInstanceId?: number; localId?: number } | null;
        if (pi?.rootInstanceId === rootInstanceId && e.id !== rootInstanceId && movedLids.has(pi.localId ?? 0)) dropParents.add(e.id);
      }
    }
    // An OWNED frame states a delta over its layers; every other (the entry's root, a reference node) states its fields
    // whole, and a template node's reverted field is the node's (#1506) — `reducedOverrides` holds exactly that.
    const pi = piMeta ? readTraitData(rootInstanceId, piMeta) as MemberPi | null : null;
    const owned = !isOutermostEntry(rootInstanceId) && !!pi && isOwnedRoot(pi, rootInstanceId);
    const reducedSide = captureEntrySide(rootInstanceId, {
      frames: new Map([[rootInstanceId, {
        overrides: owned ? (o: Record<number, Record<string, Record<string, unknown>>>) => subtractFieldOverrides(o, selectedKeys) : () => reducedOverrides,
        structure: (s: InstanceStructure) => ({
          ...s, ...subtractRevertedStructure(s, selectedKeys),
          ...(s.unrowed ? { unrowed: Object.fromEntries(Object.entries(s.unrowed).filter(([lid]) => !movedLids.has(Number(lid)))) } : {}),
        }),
      }]]),
      dropParents,
    })!;
    const guid = eaMeta ? ((readTraitData(rootInstanceId, eaMeta) as { guid?: string } | null)?.guid ?? '') : '';
    const newRootId = rebuildEntrySide(reducedSide, guid);
    const reverted = [...selectedKeys].filter((k) => /^\d+\./.test(k));
    unrecordReverted(newRootId, reverted);
    return {
      newRootId, source, prefab, fullOverrides, fullStructure, reducedOverrides, reducedStructure, fullSide, reducedSide, reverted,
      affectedScenes: resolveAffectedScenes([newRootId]),
    };
  }
  // No scene entry to state it by (`captureEntrySide`: no document to load it from), so nothing to rebuild it as.
  console.warn(`[Prefab] Revert of an instance of "${source}" not done: no scene entry holding it could be read — reload its scene`);
  return null;
}

// #2001 S4 (#2014): these ops do not maintain the instance list yet (S7 moves them onto records), so each marks the
// store stale once it finishes — wrapped here, at the export, so no return path can skip it (`instanceStore.ts`).
export const revertOverridesSelective = staleAround('revert', revertOverridesSelectiveUnmarked);
