/** #2001 S5 (#2028): the P1 seam (`ShadowSeams.project`, design § 3.5, § 10.1). After every op the runner projects every
 *  record from the STORE and compares the projection with the live instance: "the live entities are a projection of the
 *  list" made falsifiable. I25 already compares each record's list with the capture; P1 is the other half, that projecting
 *  the list gives the instance the user sees.
 *
 *  ── Into a SCRATCH world ──
 *  Reprojecting into the live world renumbered every member's ECS id, and the fuzzer's ops pick their targets in id order,
 *  so installing P1 moved every seed and every pinned repro off its path (`shadow.ts`' warning). The projection runs in a
 *  fresh koota world instead, never made current (a swap fires ~50 listeners on the live editor), through the load's own
 *  spawn and settle (`instantiatePrefabIntoWorld`, `settleEntryRows`: the pins, the derive and the moves are the settle's),
 *  and is compared, by guid, with the live subtree; one tree builder reads both worlds. The settle's guid-keyed kept stores
 *  are put back exactly as they were, the scratch entities' override marks (a global map keyed by entity) are cleared, a
 *  damaged-prefab note the scratch made alone is forgotten, and the world is destroyed.
 *
 *  ── One record ──
 *  - The unit is the OUTERMOST record (F6-U (i), § 3.2's rebuild row); a nested record (a reference node the scene added)
 *    is projected with its owner, its list read from the store too.
 *  - The record is written by S6's writer (`serializeInstanceRecord`), the present members' identity from the live keys
 *    (§ 2.7), and spawned as a v20 entry (the S5 note in § 10.1: `projectInstance(parse(entry), sceneVersion)`), its
 *    placement applied as a v20 load applies it.
 *  - Scene-owned content is not in the record (rule 7): the store links it, the live tree holds it. Its inline form is
 *    taken from the capture, as S6's adapter will take it from the live tree; a scene-added REFERENCE node in it carries
 *    its own record's list (and order) from the store, not the capture's.
 *  A record the shadow does not judge is not projected either, each reason counted: stale, an unresolved or trashed
 *  prefab (`s4Seams.judge`), or a trashed prefab's frame anywhere in the instance, which stays live until a reload (#1862).
 *
 *  ── Not compared, each counted ──
 *  - The top root's parent (the scratch has none; the placement's parent is the live one by construction).
 *  - `EntityAttributes.sourceScene`, the load's stamp on a base scene's entities (§ 10.4b: not the record's).
 *
 *  ── The root's placement marks ARE compared (S6, design § 10.7) ──
 *  A stored root's marks on its placement fields (name, sortOrder, editorFolder, sourceScene) follow the FORMAT at the
 *  load (`statedRootDefaults`): today's entry states `sortOrder` always and the name only when renamed, where v20 states
 *  the name always (U10b) and `sortOrder` as placement. Hub ruling (2026-10-02): a v20 root's marks are exactly what
 *  today's form of the same instance shows. So the projection, spawned as a v20 entry, must show the live root's marks,
 *  and a difference is a P1 failure like any other. */
import { getCurrentWorld, getTraitByName, getAllTraits } from '@modoki/engine/runtime';
import { createWorld, type Entity, type World } from 'koota';
import { storedInstances } from '../../../packages/modoki/src/runtime/prefab/instanceStore';
import type { InstanceRecord, ParsedInstance, SceneOwnedNode } from '../../../packages/modoki/src/runtime/prefab/instanceRecord';
import { capturedEntryOf, captureFormVersionOf, editorPrefabReader } from '../../../packages/modoki/src/editor/instance/instanceSync';
import { allStoredRoots, guidOfEntity, outermostStoredRoot } from '../../../packages/modoki/src/editor/instance/instanceKeys';
import { getCachedPrefabSync } from '../../../packages/modoki/src/editor/scene/prefabCache';
import { withFrameRecords } from '../../../packages/modoki/src/editor/scene/prefabRebuild';
import type { ExpansionReader } from '../../../packages/modoki/src/runtime/loaders/loadSceneFile';
import type { InstanceEntry } from '../../../packages/modoki/src/editor/scene/instanceEntry';
import { serializeInstanceRecord } from '../../../packages/modoki/src/runtime/prefab/serializeInstanceRecord';
import { parseInstanceRecord } from '../../../packages/modoki/src/runtime/prefab/parseInstanceRecord';
import { recordsOf } from '../../../packages/modoki/src/runtime/prefab/instanceLoad';
import { INSTANCE_MODEL_SCENE_VERSION } from '../../../packages/modoki/src/runtime/core/version';
import { openIdentityScope, closeIdentityScope } from '../../../packages/modoki/src/runtime/core/ecs/identityParents';
import { s4Seams } from './s4Seams';
import { findEntityById } from '../../../packages/modoki/src/runtime/core/ecs/world';
import { clearOverrideMarks, getOverrideMarkSet } from '../../../packages/modoki/src/runtime/loaders/overrideMarks';
import { instantiatePrefabIntoWorld, settleEntryRows, entryRowsOf } from '../../../packages/modoki/src/runtime/loaders/loadSceneFile';
import { identityOf } from '../../../packages/modoki/src/editor/instance/instanceReproject';
import { keptStateOf, restoreKeptState } from '../../../packages/modoki/src/runtime/core/ecs/keptOrphanRows';
import { damagedPrefabReason, forgetDamagedPrefab } from '../../../packages/modoki/src/runtime/core/damagedPrefabs';
import { rowPlaceholderOf, unresolvedRefOf } from '../../../packages/modoki/src/runtime/core/unresolvedPrefabRef';
import { REF_FIELDS_BY_TRAIT } from '../../../packages/modoki/src/runtime/loaders/sceneValidation';
import { templateKeyOf } from '../../../packages/modoki/src/runtime/core/templateIdentity';

/** What P1 reprojected, and what it left as it was and why. */
export const s5Seen = { projected: 0, nestedWithOwner: 0 };


/** `rec` written as a v20 entry. `parsed`: the capture's parse of the same instance, for its scene-owned content;
 *  `byGuid`: every capture parse of the tree, for a reference node inside that content. */
function written(rec: InstanceRecord, rootId: number | undefined, parsed: ParsedInstance, byGuid: ReadonlyMap<string, ParsedInstance>): ReturnType<typeof serializeInstanceRecord>['entry'] {
  const inline = (node: SceneOwnedNode): SceneOwnedNode => {
    const children = Array.isArray(node.children) ? (node.children as SceneOwnedNode[]).map(inline) : node.children;
    if (typeof node.prefab !== 'string' || !node.prefab || typeof node.guid !== 'string') return { ...node, children } as SceneOwnedNode;
    const st = storedInstances(getCurrentWorld()).get(node.guid);
    const inner = byGuid.get(node.guid);
    if (!st || st.stale || !inner) return { ...node, children } as SceneOwnedNode;
    s5Seen.nestedWithOwner++;
    const liveId = allStoredRoots().find((id) => guidOfEntity(id) === node.guid);
    const entry = written(st.record, liveId, inner, byGuid) as Record<string, unknown>;
    // The row channels the old form stated the node's list in, replaced by its record's written rows.
    const { overrides: _o, added: _a, removed: _r, removedTraits: _rt, moved: _m, templateMoved: _tm, nestedOverrides: _no, nestedStructure: _ns, members: _mb, ...kept } = node as unknown as Record<string, unknown>;
    const rows = Object.fromEntries(Object.entries(entry).filter(([k]) => !['name', 'traits', 'prefab', 'guid'].includes(k)));
    // The node's order is its record's placement (the old form stated it in the `overrides` replaced above). A node has
    // no entry `traits.EntityAttributes` the parser reads it from (that is the entry's v20 home), so it goes where the
    // parser reads a node's order first: its "/" row (`parseInstanceRecord`'s placement). Its parent is the anchor that
    // links it; its name is the template root's (a node's own name is not one, #2028).
    const members = { ...(rows.members as Record<string, Record<string, unknown>> | undefined) };
    const rootRow = { ...members['/'] };
    const rootTraits = { ...(rootRow.traits as Record<string, unknown> | undefined) };
    rootTraits.EntityAttributes = { ...(rootTraits.EntityAttributes as Record<string, unknown> | undefined), sortOrder: st.record.placement.sortOrder };
    members['/'] = { ...rootRow, traits: rootTraits };
    return { ...kept, children, ...rows, members } as unknown as SceneOwnedNode;
  };
  return serializeInstanceRecord(rec, {
    identity: rootId !== undefined ? identityOf(rootId) : new Map(),
    sceneOwned: (g) => { const n = parsed.ownContent.get(g); return n ? inline(n) : undefined; },
  }).entry;
}

/** One P1 comparison: the live instance subtree and the record's projection, as trees keyed by guid (`treeOf`). */
export type P1Projection = { live: Record<string, unknown>; projected: Record<string, unknown> } | { skip: string };

/** `world`'s entities `ids` as {@link worldTree} states them (parent and root ids as guids, marks, the placeholder and
 *  template-key reads), from the world given rather than the current one. */
function treeOf(world: World, ids: readonly number[]): Record<string, unknown> {
  const byId = new Map<number, Entity>();
  for (const e of world.entities as Iterable<Entity>) byId.set(e.id(), e);
  const ea = getTraitByName('EntityAttributes')!.trait;
  const guidOf = (id: number) => { const e = byId.get(id); return (e?.has(ea) ? (e.get(ea) as { guid?: string }).guid : '') || `<no guid #${id}>`; };
  const out: Record<string, unknown> = {};
  for (const id of ids) {
    const e = byId.get(id)!;
    const traits: Record<string, unknown> = {};
    const has: string[] = [];
    for (const meta of getAllTraits()) {
      if (!e.has(meta.trait)) continue;
      has.push(meta.name);
      if (meta.category === 'tag') { traits[meta.name] = {}; continue; }
      const data = e.get(meta.trait) as Record<string, unknown>;
      const d: Record<string, unknown> = {};
      for (const k of Object.keys(meta.fields)) d[k] = data[k];
      if (meta.name === 'EntityAttributes') { d.parentId = d.parentId ? guidOf(d.parentId as number) : 0; delete d.sourceScene; }
      if (meta.name === 'PrefabInstance') { d.rootInstanceId = d.rootInstanceId ? guidOf(d.rootInstanceId as number) : 0; delete d.ownerGuid; }
      traits[meta.name] = d;
    }
    const blankRef = (m: string) => { const [t, f] = m.split('.'); return !!REF_FIELDS_BY_TRAIT[t]?.includes(f) && (traits[t] as Record<string, unknown> | undefined)?.[f] === ''; };
    const marks = has.includes('PrefabInstance')
      ? [...(getOverrideMarkSet(e as never) ?? [])].filter((m) => has.includes(m.split('.')[0]) && !blankRef(m)).sort() : [];
    const rowPh = rowPlaceholderOf(e as never);
    const unresolved = unresolvedRefOf(e as never) ?? rowPh;
    const templateKey = templateKeyOf(e as never);
    const key = guidOf(id);
    out[out[key] ? `${key}#dup` : key] = { traits, marks, ...(templateKey ? { templateKey } : {}), ...(unresolved ? { unresolved: unresolved.source } : {}), ...(rowPh ? { row: true } : {}) };
  }
  return out;
}

/** `rootId` and every entity under it in `world`. */
function subtreeIds(world: World, rootId: number): number[] {
  const ea = getTraitByName('EntityAttributes')!.trait;
  const kids = new Map<number, number[]>();
  for (const e of world.entities as Iterable<Entity>) {
    const p = e.has(ea) ? (e.get(ea) as { parentId?: number }).parentId ?? 0 : 0;
    if (p) kids.set(p, [...(kids.get(p) ?? []), e.id()]);
  }
  const out: number[] = [];
  for (const stack = [rootId]; stack.length;) { const id = stack.pop()!; out.push(id); stack.push(...(kids.get(id) ?? [])); }
  return out;
}

/** The comparison's normalization (see the header), on both trees: `top` is the root's guid. */
function normalized(tree: Record<string, unknown>, top: string): Record<string, unknown> {
  const out = structuredClone(tree) as Record<string, { traits: Record<string, Record<string, unknown>>; marks: string[] }>;
  const root = out[top];
  if (root?.traits.EntityAttributes) root.traits.EntityAttributes.parentId = '(placement parent)';
  return out;
}

/** P1's projection of one record (see the header): undefined for a nested record (projected with its owner). */
export async function projectFromStore(rec: InstanceRecord): Promise<P1Projection | undefined> {
  const top = allStoredRoots().find((id) => guidOfEntity(id) === rec.rootGuid);
  if (top === undefined) return { skip: 'no live root' };
  if ((outermostStoredRoot(top) || top) !== top) return undefined;
  const judged = s4Seams.judge!(rec);
  if ('skip' in judged) return { skip: judged.skip };
  const source = rec.source;
  const prefab = getCachedPrefabSync(source)!;
  let entry: InstanceEntry;
  openIdentityScope();
  try {
    const captured = capturedEntryOf(top);
    if (!captured) return { skip: 'no capture' };
    const held = new Set<string>();
    const ea = getTraitByName('EntityAttributes')!.trait;
    for (const e of getCurrentWorld().entities) { const g = (e.get(ea) as { guid?: string } | undefined)?.guid; if (g) held.add(g); }
    const opts = { held: (g: string) => held.has(g), sceneVersion: captureFormVersionOf(top) };
    const all = recordsOf(parseInstanceRecord(captured, editorPrefabReader, opts), editorPrefabReader, opts);
    entry = written(rec, top, all[0], new Map(all.map((p) => [p.record.rootGuid, p]))) as unknown as InstanceEntry;
  } finally {
    closeIdentityScope();
  }
  const live = getCurrentWorld();
  const liveIds = subtreeIds(live, top);
  // A frame of a prefab trashed in this world stays live until a reload (#1862's keep), which no projection reproduces:
  // the projection, like the reload, shows its placeholder (ruling B/D). `judge` skips the top and outermost frames' own.
  const piMeta = getTraitByName('PrefabInstance')!;
  const trashed = liveIds.some((id) => {
    const src = (findEntityById(id, live)?.get(piMeta.trait) as { source?: string } | undefined)?.source;
    return !!src && !getCachedPrefabSync(src);
  });
  if (trashed) return { skip: 'a nested frame of a trashed prefab is kept live (#1862)' };
  const liveTree = treeOf(live, liveIds);
  // What the settle writes is keyed by guid (`keptOrphanRows.ts`), and every key is an entity's it settles.
  const kept = new Map(Object.keys(liveTree).map((g) => [g, keptStateOf(g)]));
  const asked = new Set<string>();
  const base = withFrameRecords(getCachedPrefabSync as ExpansionReader, top);
  const read = Object.assign((g: string) => { asked.add(g); return base(g); }, base) as ExpansionReader;
  const damaged = new Map<string, boolean>();
  const scratch = createWorld();
  let projected: Record<string, unknown> = {};
  try {
    const e = structuredClone(entry);
    const root = instantiatePrefabIntoWorld(scratch, prefab, 0, undefined, source, e.overrides,
      { added: e.added, removed: e.removed, removedTraits: e.removedTraits, moved: e.moved, members: e.members },
      undefined, e.nestedOverrides, e.nestedStructure, { read, rootGuid: rec.rootGuid, sceneVersion: INSTANCE_MODEL_SCENE_VERSION });
    for (const g of asked) damaged.set(g, damagedPrefabReason(g) !== undefined);
    if (root) {
      settleEntryRows(scratch, [entryRowsOf(root, source, e)], { pinned: new Set(), read, fromSceneVersion: INSTANCE_MODEL_SCENE_VERSION });
      // The record's placement, which a v20 load applies from the entry's own `EntityAttributes`.
      const r = findEntityById(root, scratch)!;
      const eaMeta = getTraitByName('EntityAttributes')!;
      r.set(eaMeta.trait, { ...(r.get(eaMeta.trait) as Record<string, unknown>), sortOrder: rec.placement.sortOrder, editorFolder: rec.placement.editorFolder ?? '' });
      projected = treeOf(scratch, subtreeIds(scratch, root));
    }
  } finally {
    for (const e of scratch.entities as Iterable<Entity>) clearOverrideMarks(e as never);
    for (const g of new Set([...kept.keys(), ...Object.keys(projected)])) restoreKeptState(g, kept.get(g) ?? {});
    for (const g of asked) if (!damaged.get(g) && damagedPrefabReason(g) !== undefined) forgetDamagedPrefab(g);
    scratch.destroy();
  }
  s5Seen.projected++;
  return { live: normalized(liveTree, rec.rootGuid), projected: normalized(projected, rec.rootGuid) };
}
