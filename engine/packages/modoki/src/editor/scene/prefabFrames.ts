/** Frame state: what a rebuild of a frame would reach, whether a frame was built from other rows (stale), and the
 *  missing / stale / unexpanded refusals.
 *  Moved out of `prefab.ts` by the prefab.ts split (#1656 § Plan, step 5): a pure move. */

import { expandsToRoot } from '../../runtime/loaders/prefabRoot';
import { getCurrentWorld } from '../../runtime/core/ecs/world';
import { worldIdentityParents, identitySubtree, frameRootDoc } from '../../runtime/core/ecs/identityParents';
import { isPrefabEditRowGuid } from './prefabEditGuids';
import { memberRef, splitNestedKey } from './overrideKeyGrammar';
import { getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { getAllEntities, readTraitData, findEntity, subtreeIds } from '../../runtime/core/ecs/entityUtils';
import { collectTransientSubtreeIds } from './authoringScope';
import { isGuid, resolveRef } from '../../runtime/loaders/assetManifest';
import { durableGuid, isStoredRoot, isOwnedRoot, type MemberPi } from '../../runtime/core/assetRefRules';
import { unresolvedRefOf } from '../../runtime/core/unresolvedPrefabRef';
import { levelDoc, captureDoc } from './prefabBase';
import { type PrefabEntity, type PrefabFile } from './prefab';
import { getCachedPrefabSync, getPrefabSource, prefabCache } from './prefabCache';
import { foreignRow, type RowDoc, rowsMeanTheSame, unexpandedRowsOf } from './prefabMembers';

/** A frame {@link rebuildTeardown} KEEPS because its prefab cannot be expanded (#1862): `owned` for a template row's frame,
 *  otherwise a scene-added reference node (a stored root). `parentGuid` is where it hung, already `remap`ped. */
export type KeptFrame = { id: number; parentGuid: string; owned: boolean };

/** What {@link rebuildInstance} destroys for instance `rootInstanceId`, and which members of OTHER instances
 *  hanging inside it it parks instead (to be put back by `parentGuid`, already `remap`ped). Its own function so
 *  the rebase can ask what a rebuild WOULD reach before running one (#1493, {@link rebaseStaleInstances}). */
export function rebuildTeardown(
  rootInstanceId: number,
  remap: ReadonlyMap<string, string> = new Map(),
): { toDestroy: Set<number>; parked: { id: number; parentGuid: string }[]; kept: KeptFrame[] } {
  const PrefabInstanceMeta = getTraitByName('PrefabInstance');
  if (!PrefabInstanceMeta) return { toDestroy: new Set(), parked: [], kept: [] };
  // Recompute the teardown set LIVE: every member of this instance PLUS every
  // non-member descendant (added entities, nested instances, and their subtrees).
  // We deliberately do NOT trust `structure.consumedEcsIds` — that is a frozen
  // snapshot of the FIRST capture's added-entity ids. After the first rebuild those
  // ids are dead, and the additions re-spawned by applyStructureByRootInstance get
  // FRESH ids that aren't in the frozen set; reusing it would leak (and accumulate)
  // a duplicate added subtree on every undo/redo cycle of a revert (F5). Walking the
  // live subtree destroys whatever additions are currently live, regardless of when
  // they were spawned. (deleteEntities also cascades to children, but recomputing
  // here makes teardown correct without depending on that.)
  const members = new Set<number>();
  getCurrentWorld().query(PrefabInstanceMeta.trait).updateEach(([pi], entity) => {
    if ((pi as Record<string, unknown>).rootInstanceId === rootInstanceId) members.add(entity.id());
  });
  const childrenOf = new Map<number, number[]>();
  for (const e of getAllEntities()) {
    if (!childrenOf.has(e.parentId)) childrenOf.set(e.parentId, []);
    childrenOf.get(e.parentId)!.push(e.id);
  }
  // A member of ANOTHER instance moved in under one of ours (#1437) is not ours to destroy: its own instance
  // records the move, and nothing here would respawn it. It is parked at the scene root for the teardown and
  // put back under the same parent (by guid — our members keep theirs) once the rebuild has derived them.
  const parked: { id: number; parentGuid: string }[] = [];
  // By a walk of the world, not the guid index: rebuild's tests stub the world module by an explicit export list.
  const guidById = new Map(getAllEntities().map((e) => [e.id, e.guid ?? '']));
  // Where each entity's TEMPLATE puts it (`identityParents.ts`) — which of them were moved, and by whom owned.
  const identity = worldIdentityParents(getCurrentWorld());
  // …and a ROW of another frame hanging where that frame's document puts it: a nested or plain row under a nested
  // row (#1484). Unmoved, but not ours either — our re-expansion cannot respawn another document's row, so it was
  // torn down with nothing to bring it back. Parked, it keeps its members and its edits.
  const foreign = (id: number): boolean => foreignRow(id, rootInstanceId, identity);
  const toDestroy = new Set<number>();
  const isParked = (id: number) => parked.some((p) => p.id === id);
  // A nested frame whose OWN prefab the respawn cannot expand (#1862): its document is gone (a trash) or expands to no root,
  // so the respawn would record its row as unexpanded (#1790 ruling D) and spawn nothing in its place — the live members
  // would go with the teardown, and a gesture's own undo then refused on them. It is KEPT, as Unity keeps the objects of a
  // missing instance it merged before the asset went (`MergeStatus.NormalMerge` / `MergedAsMissingWithSceneBackup`), and
  // re-seated by {@link seatKeptFrames}. Asked of the SAME cache the respawn reads, so a merely cold key is kept too.
  // Both reference kinds: an OWNED root (a template row's frame), and a STORED root hanging under one of ours, a
  // scene-added reference node, which the respawn would make a placeholder of from the structure (`rebuildInstance`
  // then skips that respawn, and drops the kept frame when the structure no longer names it).
  const kept: KeptFrame[] = [];
  const isKept = (id: number) => kept.some((k) => k.id === id);
  const unexpandable = (id: number, owned: boolean): boolean => {
    const pi = readTraitData(id, PrefabInstanceMeta) as (MemberPi & { source?: unknown }) | null;
    if (!pi || !(owned ? isOwnedRoot(pi, id) : isStoredRoot(pi, id)) || typeof pi.source !== 'string' || !pi.source) return false;
    const doc = getCachedPrefabSync(pi.source);
    return !doc || !expandsToRoot(doc, getCachedPrefabSync);
  };
  // Take `from` and everything under it — except what is not ours to destroy, which is PARKED where it hangs. The
  // one walk every part of the teardown takes: the unpark and reverse-case walks below took whole subtrees without
  // this test, so a row of ANOTHER frame hanging under a member they took (a #1484 row under a member moved in
  // from a torn-down frame) was destroyed with nothing to respawn it (#1499).
  const take = (from: number[]): void => {
    const stack: number[] = [];
    for (const id of from) if (!toDestroy.has(id)) { toDestroy.add(id); stack.push(id); }
    while (stack.length) {
      const id = stack.pop()!;
      for (const c of childrenOf.get(id) ?? []) {
        if (toDestroy.has(c) || isParked(c) || isKept(c)) continue;
        if (!members.has(c) && guidById.get(id) && unexpandable(c, true)) {
          kept.push({ id: c, parentGuid: remap.get(guidById.get(id)!) ?? guidById.get(id)!, owned: true });
          continue;
        }
        // …and in a prefab-edit world, a ROW of the edited prefab hanging under one of ours (a nested or plain row
        // under a nested row, #1484): the edited document's own, which nothing this rebuild respawns — the capture
        // skips it for the same reason (`editRow`).
        const editRow = isPrefabEditRowGuid(guidById.get(c));
        if (!members.has(c) && (editRow || (readTraitData(c, PrefabInstanceMeta) && (identity.moved(c) || foreign(c)))) && guidById.get(id)) {
          parked.push({ id: c, parentGuid: remap.get(guidById.get(id)!) ?? guidById.get(id)! });
          continue;
        }
        // After the park: a stored root that is another frame's (moved in, foreign) is parked above, so only a node of
        // ours reaches here. Its own durable guid is what the structure names it by.
        if (!members.has(c) && guidById.get(id) && durableGuid(guidById.get(c)) && unexpandable(c, false)) {
          kept.push({ id: c, parentGuid: remap.get(guidById.get(id)!) ?? guidById.get(id)!, owned: false });
          continue;
        }
        toDestroy.add(c);
        stack.push(c);
      }
    }
  };
  take([...members]);
  // …unless its own instance is torn down here too (a user-added one nested in ours): that rebuild respawns
  // it, moved, from its own record. An OWNED nested root's instance is its owner, moved or not: an unmoved one
  // parked above belongs to a frame other than ours (#1484), and is ours to destroy only when that frame is.
  const frameOf = (id: number): number => {
    const pi = readTraitData(id, PrefabInstanceMeta);
    if (!pi) return 0;
    if (!isOwnedRoot(pi, id)) return (pi.rootInstanceId as number) || 0;
    return identity.ownerOf(id);
  };
  // ONE fixpoint with the reverse case below: a parked entity's frame can join the teardown only later — an owned
  // root parked at a lower index, or one the reverse case adds — and unparked in a single pass ahead of it, the
  // entity survived beside its own respawn, its link stripped by the teardown (#1493 close-out review 3).
  for (let grew = true; grew;) {
    grew = false;
    for (let i = parked.length - 1; i >= 0; i--) {
      const frame = frameOf(parked[i]!.id);
      if (frame !== rootInstanceId && !toDestroy.has(frame)) continue;
      // With its subtree, which the walk stopped at: a foreign-owned root parks with everything under it (#1484).
      const [{ id }] = parked.splice(i, 1);
      take([id]);
      grew = true;
    }
    // The reverse case: an entity of an instance torn down here that was moved OUT of this subtree — a member of
    // a nested instance, or an owned nested root of ours — is respawned, moved, by the rebuild; left alive it
    // would sit beside its own replacement. Fixpoint, since its own members may be further out still.
    for (const e of getAllEntities()) {
      if (toDestroy.has(e.id) || isParked(e.id) || isKept(e.id) || !e.traits.includes('PrefabInstance')) continue;
      const frame = frameOf(e.id);
      if (frame !== rootInstanceId && !toDestroy.has(frame)) continue;
      if (frame === e.id) continue; // a stored root is its own instance, and it is not ours
      take([e.id]);
      grew = true;
    }
  }
  return { toDestroy, parked, kept };
}

// ── A live frame built from another version of its document (#1483) ────────────────────────────────

/** A document's content, memoised by object — two copies of one file (the runtime's and the editor's, each
 *  parsed and migrated the same way) compare equal. */
const docText = new WeakMap<object, string>();

function sameDocument(a: object, b: object): boolean {
  if (a === b) return true;
  const text = (d: object) => { let t = docText.get(d); if (t === undefined) { t = JSON.stringify(d); docText.set(d, t); } return t; };
  return text(a) === text(b);
}

/** Every frame of instance `rootInstanceId` — its root and every nested frame its rebuild tears down — whose recorded
 *  document does not hold the same rows as the editor's cached copy of its source (#1483,
 *  {@link rowsMeanTheSame}). Every capture
 *  (overrides, structure, the override keys, Apply, Revert) diffs a member's `PrefabInstance.localId` against
 *  the cached copy, so in such a frame each member is compared with another member's row: false overrides,
 *  and Apply writes one member's value into another's row. A frame with no record of its own, or no cached
 *  copy, cannot be judged and is not reported. Only the row identity is compared, not the content: a
 *  template whose VALUES changed is captured on the right rows (the mark gate keeps the values honest), and
 *  refusing on content would block Apply over any byte difference between two copies of one file. */
export function framesBuiltFromOtherRows(
  rootInstanceId: number,
  /** `nestedOnly`: skip the instance's own frame. */
  opts: { nestedOnly?: boolean } = {},
): string[] {
  const pi = getTraitByName('PrefabInstance');
  if (!pi) return [];
  const world = getCurrentWorld();
  const all = getAllEntities();
  // A runtime frame (a pooled row, a timeline spawn) is not authoring input (docs/prefabs.md § Authoring
  // scope): no capture reads it, and nothing would ever rebuild it to clear a refusal.
  const runtimeIds = collectTransientSubtreeIds(all);
  // The frames the instance's rebuild tears down — what every capture of it now reaches — not its live subtree: a
  // frame it owns that was moved out of that subtree (#1437) is captured too, and a stale one there was captured
  // against the cache with nothing refusing it (#1499 close-out review: a Revert saved a member the cache gained as
  // REMOVED). A frame of another instance moved in is parked by the teardown, captured by nothing, and not judged.
  const inside = rebuildTeardown(rootInstanceId).toDestroy;
  const stale: string[] = [];
  for (const e of all) {
    const data = readTraitData(e.id, pi) as { rootInstanceId?: number; source?: string } | null;
    if (!data?.source || data.rootInstanceId !== e.id || !inside.has(e.id) || runtimeIds.has(e.id)) continue;
    if (opts.nestedOnly && e.id === rootInstanceId) continue;
    const handle = findEntity(e.id);
    const rec = handle ? frameRootDoc(world, handle) : undefined;
    const cached = prefabCache.get(data.source);
    if (!rec || rec.source !== data.source || !cached) continue;
    if (!rowsMeanTheSame(rec.doc as RowDoc, cached) && !stale.includes(data.source)) stale.push(data.source);
  }
  return stale;
}

/** The refusal Apply and Revert give an instance {@link framesBuiltFromOtherRows} reports. */
export function staleFramesRefusal(stale: string[]): string {
  return `this instance was built from a different version of ${stale.map((s) => `"${s}"`).join(', ')} than the ` +
    'editor now holds, so its members would be matched with the wrong rows of the prefab. Reload the scene ' +
    '(or the base scene holding it) and try again.';
}

/** Why Apply/Revert would refuse instance `rootInstanceId`, or null — for a caller that must say so itself
 *  (the Apply dialog's Revert, the agent op), since Revert's own `null` cannot carry a reason. */
export function staleInstanceRefusal(rootInstanceId: number): string | null {
  const stale = framesBuiltFromOtherRows(rootInstanceId);
  return stale.length ? staleFramesRefusal(stale) : null;
}

/** Why Apply and/or Revert cannot act on instance `rootInstanceId`, whose OWN prefab `source` does not load: a frame kept
 *  live after its prefab was trashed (#1862), a nested one or #1738's top-level one. Every surface says it in these words:
 *  `planApply`, {@link revertRefusal}, and the Apply dialog's and the agent op's own load checks, which stop before either
 *  and used to show only the bare guid ("Could not load prefab <guid>"). */
export function missingSourceRefusal(rootInstanceId: number, source: string, verb: 'apply' | 'revert' | 'apply or revert'): string {
  const tail = verb === 'revert' ? 'so there is nothing to revert it to. Restore the prefab to revert it'
    : verb === 'apply' ? 'so there is nothing to apply it to. Restore the prefab to apply to it'
      : 'so there is nothing to apply it to or revert it to. Restore the prefab first';
  return `${missingPrefabInstance(rootInstanceId, source)}, ${tail}, or Detach Prefab to keep it as plain entities.`;
}

/** `"QR" is an instance of "Q", a prefab that is missing (<ref>)`: how Revert and Apply name a live frame whose own prefab
 *  no longer loads (#1862's kept frame). Named by the document the frame was built from: a delete prunes the guid from the
 *  manifest, so no path is left to show. */
export function missingPrefabInstance(frameRoot: number, source: string): string {
  const name = getAllEntities().find((e) => e.id === frameRoot)?.name ?? 'this instance';
  const prefabName = levelDoc(frameRoot, source).doc?.name;
  return `"${name}" is an instance of ${prefabName ? `"${prefabName}", a prefab that is missing` : 'a prefab that is missing'} ` +
    `(${resolveRef(source) || source})`;
}

/** Each selected Apply key that reaches into a nested frame whose prefab does not load, with the reason it is not applied,
 *  worded by {@link missingPrefabInstance}. That is a frame kept live after its prefab was trashed (#1862): the key has no
 *  document to be written into or translated against, and Unity offers no Apply on a missing-asset instance. Walked row by
 *  row from `doc` through each reference row's prefab, read through the async read so a merely cold key is not taken for
 *  a missing one; the live frame is found level by level under the one before, so a prefab nested twice names the frame
 *  the key is about. A key whose chain names a row `doc` does not have is not this: it stays the stale-key report. */
export async function missingNestedFrameKeys(rootInstanceId: number, doc: PrefabFile, keys: Iterable<string>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const pi = getTraitByName('PrefabInstance');
  const idParents = worldIdentityParents(getCurrentWorld());
  /** The live frame row `row` expanded into, under frame `scope`. */
  const frameOf = (scope: number | undefined, row: PrefabEntity): number | undefined => {
    if (scope === undefined || !pi) return undefined;
    return identitySubtree(getCurrentWorld(), [scope], idParents).find((id) => {
      const d = readTraitData(id, pi) as { source?: string; rootInstanceId?: number; parentNodeGuid?: string; parentLocalId?: number } | null;
      if (!d || d.source !== row.prefab || d.rootInstanceId !== id || id === scope) return false;
      return d.parentNodeGuid ? d.parentNodeGuid === row.nodeGuid : d.parentLocalId === row.localId;
    });
  };
  for (const key of keys) {
    const nested = splitNestedKey(key);
    const moved = key.startsWith('~moved.') && key.includes(':') ? key.slice('~moved.'.length, key.indexOf(':')) : null;
    const chain = nested?.chain ?? moved;
    if (!chain) continue;
    let cur: PrefabFile = doc;
    let scope: number | undefined = rootInstanceId;
    for (const ref of chain.split('.')) {
      const row: PrefabEntity | undefined = cur.entities.find((e) => memberRef(cur, e.localId) === ref || String(e.localId) === ref);
      if (!row?.prefab) break;
      const src = row.prefab;
      scope = frameOf(scope, row);
      const child: PrefabFile | null = await getPrefabSource(src);
      if (child) { cur = child; continue; }
      out.set(key, scope !== undefined ? missingSourceRefusal(scope, src, 'apply')
        : `"${row.name}" is an instance of a prefab that is missing (${resolveRef(src) || src}), so there is nothing to apply it to. Restore the prefab to apply to it.`);
      break;
    }
  }
  return out;
}

export interface StaleFrame { root: number; source: string; from: PrefabFile; to: PrefabFile }

/** Every live frame root whose own record says it was expanded from a document other than the cached copy of its source. */
export function staleFrames(opts: { sources?: ReadonlySet<string> }): StaleFrame[] {
  const pi = getTraitByName('PrefabInstance');
  if (!pi) return [];
  const world = getCurrentWorld();
  const all = getAllEntities();
  const runtimeIds = collectTransientSubtreeIds(all);
  const stale: StaleFrame[] = [];
  world.query(pi.trait).updateEach(([data], entity) => {
    const d = data as { source?: string; rootInstanceId?: number };
    // Every frame root — stored or owned (#1493) — not only the stored ones.
    if (!d.source || d.rootInstanceId !== entity.id() || runtimeIds.has(entity.id())) return;
    if (opts.sources && !opts.sources.has(d.source)) return;
    const rec = frameRootDoc(world, entity);
    const cached = prefabCache.get(d.source);
    if (!rec || rec.source !== d.source || !cached || sameDocument(rec.doc, cached)) return;
    stale.push({ root: entity.id(), source: d.source, from: rec.doc as PrefabFile, to: cached });
  });
  return stale;
}

/** Is `rootId` still the SAME live, self-rooted prefab-instance root it was when the caller
 *  collected it — identified by `expectedGuid`, not by the id?
 *
 *  ⚠️ The guid is what makes this safe, and an id-only version is actively worse than no check
 *  at all (close-out review). koota recycles entity ids LIFO, and the caller's loop deletes a
 *  subtree and then spawns a replacement — so the freed id can be handed straight back to the
 *  NEW root. An id-only check would then report a destroyed instance as live, and the loop
 *  would rebuild the first instance a second time using the overrides and structure captured
 *  for a DIFFERENT one. Comparing the stable guid cannot confuse the two.
 *
 *  An empty expected guid means the caller had nothing stable to pin, so this degrades to the
 *  id check rather than refusing outright — every entity carries a guid since #1210, so that
 *  path is not expected to be reached. */
export function isLiveInstanceRoot(rootId: number, expectedGuid: string): boolean {
  const meta = getTraitByName('PrefabInstance');
  if (!meta) return false;
  const pi = readTraitData(rootId, meta);
  if (!pi || pi.rootInstanceId !== rootId) return false;
  if (!expectedGuid) return true;
  const eaMeta = getTraitByName('EntityAttributes');
  const guid = eaMeta ? (readTraitData(rootId, eaMeta)?.guid as string | undefined) : undefined;
  return guid === expectedGuid;
}

/** Collect root entity ids for every instance of a given source. Optionally
 *  exclude one root id. */
export function collectInstanceRoots(source: string, excludeRootId?: number): number[] {
  const PrefabInstanceMeta = getTraitByName('PrefabInstance');
  if (!PrefabInstanceMeta) return [];
  const rootIds: number[] = [];
  // ⚠️ A Transient instance is a RUNTIME artifact — a UIEntries pooled row, a timeline scrub or
  // control-track spawn — and an authoring fan-out must not reach it (#1301). Rebuilding one is
  // wrong twice over: `rebuildInstance` does not carry `Transient` forward, so the rebuilt root
  // becomes serializable and the next save writes a preview artifact into the authored scene; and
  // the pool owns those rows, so tearing them down under it is not ours to do. A STOPPED editor
  // really does hold pooled instance roots that match this query's `source` + `rootInstanceId`
  // filter exactly — measured in docs/prefabs.md § Authoring scope.
  const runtimeIds = collectTransientSubtreeIds(getAllEntities());
  getCurrentWorld().query(PrefabInstanceMeta.trait).updateEach(([pi], entity) => {
    const piData = pi as Record<string, unknown>;
    if (piData.source !== source) return;
    if (piData.rootInstanceId !== entity.id()) return;
    if (excludeRootId !== undefined && entity.id() === excludeRootId) return;
    if (runtimeIds.has(entity.id())) return;
    rootIds.push(entity.id());
  });
  return rootIds;
}

/** The placeholders for missing prefabs (#1699) in the live subtree of `rootId`, the root included: what Create Prefab
 *  (the human path and the agent op) refuses over, since it writes the whole live tree. Apply asks the identity subtree
 *  of each node it promotes instead (`planApply`). */
export function missingPrefabPlaceholders(rootId: number): { id: number; name: string; guid: string }[] {
  const all = getAllEntities();
  const byId = new Map(all.map((e) => [e.id, e] as const));
  return subtreeIds(all, rootId)
    .filter((id) => !!unresolvedRefOf(findEntity(id)))
    .map((id) => ({ id, name: byId.get(id)?.name ?? '', guid: byId.get(id)?.guid ?? '' }));
}

/** The nested frames a live instance in the subtree of `rootId` could not expand — a reference row of its document whose
 *  prefab does not load, or loads and expands to no root (#1768) — named for a refusal. What Create Prefab refuses over
 *  (#1790, owner ruling D): Unity will not save an instance holding a missing prefab instance into a prefab asset. A
 *  missing prefab the TREE references directly is a placeholder, and `missingPrefabPlaceholders` names it.
 *  ⚠️ Asked AFTER the caller's nested warm (`preloadNestedPrefabsForSubtree`): read over a merely cold cache it names a
 *  readable prefab as missing — the trap #1738's first member recorded. */
export function unexpandedNestedRows(rootId: number): { instance: string; row: string; prefab: string }[] {
  const piMeta = getTraitByName('PrefabInstance');
  if (!piMeta) return [];
  const all = getAllEntities();
  const byId = new Map(all.map((e) => [e.id, e] as const));
  const out: { instance: string; row: string; prefab: string }[] = [];
  for (const id of subtreeIds(all, rootId)) {
    const pi = readTraitData(id, piMeta) as { source?: string; rootInstanceId?: number } | null;
    if (!pi?.source || pi.rootInstanceId !== id) continue;
    const doc = captureDoc(id, pi.source);
    // A row the frame never expanded is missing from the tree however the cache reads NOW (#1812).
    const skipped = doc ? unexpandedRowsOf(id, doc) : undefined;
    for (const row of doc?.entities ?? []) {
      if (!row.prefab) continue;
      const child = getCachedPrefabSync(row.prefab);
      if (!skipped?.has(row.localId) && child && expandsToRoot(child, getCachedPrefabSync)) continue;
      out.push({ instance: byId.get(id)?.name ?? '', row: row.name ?? '', prefab: resolveRef(row.prefab) ?? row.prefab });
    }
  }
  return out;
}

/** The refusal Create Prefab gives a tree holding an unexpandable nested frame, or null — ONE wording for the human path
 *  and the agent op. */
export function unexpandedNestedRefusal(rootId: number): string | null {
  const hit = unexpandedNestedRows(rootId)[0];
  if (!hit) return null;
  return `"${hit.row}" in "${hit.instance}" is a nested prefab that could not be loaded (${hit.prefab}), so the instance cannot be written into a template until it resolves`;
}

/** The refusal Create Prefab gives a tree holding an instance frame built from other rows than the editor's cached copy of
 *  its prefab (#1815, I3), or null — ONE wording for the human path and the agent op. The capture reads the cache first
 *  (`captureDoc`), so such a frame's members would be matched with the wrong rows, and a row only the OLD document had
 *  came back as a template-added node. Apply and Revert ask the same predicate of their instance
 *  ({@link framesBuiltFromOtherRows}); this asks it of every instance root in the subtree of `rootId`, the root included.
 *  Refused rather than rebased, as they do: a rebase would rebuild the tree the human selected under them.
 *  ⚠️ Asked AFTER the caller's nested warm, like {@link unexpandedNestedRefusal}: a frame with no cached copy cannot be
 *  judged, and is not reported. */
export function staleFramesInTreeRefusal(rootId: number): string | null {
  const piMeta = getTraitByName('PrefabInstance');
  if (!piMeta) return null;
  const stale: string[] = [];
  for (const id of subtreeIds(getAllEntities(), rootId)) {
    const pi = readTraitData(id, piMeta) as { source?: string; rootInstanceId?: number } | null;
    if (!pi?.source || pi.rootInstanceId !== id) continue;
    for (const s of framesBuiltFromOtherRows(id)) if (!stale.includes(s)) stale.push(s);
  }
  if (!stale.length) return null;
  return `a prefab instance in the selection was built from a different version of ${stale.map((s) => `"${(isGuid(s) ? resolveRef(s) : undefined) ?? s}"`).join(', ')} ` +
    'than the editor now holds, so its members would be matched with the wrong rows of that prefab';
}
