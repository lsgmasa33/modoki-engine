/** S4's seams for the #2009 shadow harness (`shadow.ts`; #2001, #2014; design § 6 S4, § 10.5): the real `InstanceStore`,
 *  the real capture `parse(captureInstanceEntry(live))`, and the ops whose writer calls the door. The harness compares
 *  them (I25) and checks that the store covers every live stored root.
 *
 *  S4 stages the ops S7 moves onto records by marking their records STALE (`instanceStore.ts`), and the door re-seeds a
 *  stale record from the capture before it next writes it. So `judge` skips a stale record (comparing it with the
 *  capture would compare the capture with itself, § 10.5, review L10), and `unrecorded` names the op that created a
 *  live root without the door.
 *
 *  A divergence is triaged against the RULES (#2014): a door gap is fixed in the door; an old-capture bug is translated
 *  out by `judge`, with its issue named, and counted (`s4Seen`), so a translation that stops being reached is visible:
 *  - rule 3 (hub refinement, § 10.4): deleting a member KEEPS the records on and under it; the old capture drops them;
 *  - hub ruling G2: a removed BASE component keeps its field records; the old capture drops them;
 *  - #1942 (open): the old capture writes only the non-default fields of a component on a template-added plain node;
 *  - KNOWN_OPEN #1829: the old capture writes a component the base lacks WHOLE, and a rotation as its whole group,
 *    where a file may state either partially.
 *  (`own` order is not a record either; the harness compares `own` as a set.)
 *  As the S2 oracle translates rulings B/D: the rule's side is applied, not pardoned, and the comparison stays exact
 *  everywhere else. */

import { getCurrentWorld, getTraitByName } from '@modoki/engine/runtime';
import { storedInstances, unrecordedBy } from '../../../packages/modoki/src/runtime/prefab/instanceStore';
import type { InstanceRecord, OverrideList, SceneTargetRecord } from '../../../packages/modoki/src/runtime/prefab/instanceRecord';
import { capturedRecordsOf, editorPrefabReader } from '../../../packages/modoki/src/editor/instance/instanceSync';
import { baseTrait } from '../../../packages/modoki/src/editor/instance/instanceEdits';
import { foldInstance } from '../../../packages/modoki/src/runtime/prefab/foldInstance';
import { soaSchema } from '../../../packages/modoki/src/runtime/core/ecs/traitSchema';
import { allStoredRoots, guidOfEntity, outermostStoredRoot } from '../../../packages/modoki/src/editor/instance/instanceKeys';
import type { ShadowSeams } from './shadow';
import { getCachedPrefabSync } from '../../../packages/modoki/src/editor/scene/prefabCache';
import { findEntityById } from '../../../packages/modoki/src/runtime/core/ecs/world';
import { unresolvedRefOf } from '../../../packages/modoki/src/runtime/core/unresolvedPrefabRef';
import type { OpKind } from './ops';

/** The fuzzer ops whose writer calls the door (the review's § Census rows). `paste` covers a cut's paste (a reparent).
 *  An instance copy (duplicate/paste of a subtree holding an instance) marks its records stale itself. */
export const DOOR_OPS: ReadonlySet<OpKind> = new Set<OpKind>(['editField', 'addComponent', 'removeComponent', 'addChild', 'delete', 'reparent', 'duplicate', 'paste', 'instantiate']);

/** What the translations reached, for the non-vacuity pins (the harness counts the comparisons and skips itself). */
export const s4Seen = { removedKept: 0, removedComponentKept: 0, known1942: 0, known1829: 0 };

type Bag = Record<string, unknown>;

/** The record's list with the rules' side applied where the old capture cannot write it (see the header). */
function translated(rec: InstanceRecord): OverrideList {
  const underRemoved = removedDescendants(rec);
  let folded: ReadonlyMap<string, unknown> | undefined;
  const rows = new Map<string, SceneTargetRecord>();
  for (const [k, r0] of rec.list.rows) {
    const { guid: _g, name: _n, ...r } = r0;
    // Rule 3 (hub refinement, § 10.4): a deleted member keeps the records on and under it; the old capture drops them.
    if (underRemoved(k)) { if (Object.keys(r).length) s4Seen.removedKept++; continue; }
    if (r.removed === true) { if (Object.keys(r).length > 1) s4Seen.removedKept++; rows.set(k, { ...r0, removed: true, traits: undefined, traitRemovals: undefined } as SceneTargetRecord); continue; }
    const row: SceneTargetRecord = { ...r0 };
    // KNOWN_OPEN #1829 (recorded, not fixed): a component the base LACKS, stated partially (a file-direct agent write, a
    // hand edit), is folded with the schema default in each field it omits, and the old capture writes it WHOLE. Filled
    // here with those defaults — what the fold gives, so the live state is unchanged — and counted.
    if (row.traits) row.traits = withAddedFilled(rec, k, row.traits as Bag, (folded ??= foldInstance(editorPrefabReader, rec).nodes)) as typeof row.traits;
    // …and the same mechanism on a rotation: a file stating ONE axis (a file-direct `setTrait`), where rotation is one
    // record (#1880 F5) and the old save writes the group. The missing axes are filled with what the fold gives.
    if (row.traits) row.traits = withRotationGroup(row.traits as Bag, (folded ??= foldInstance(editorPrefabReader, rec).nodes).get(k)) as typeof row.traits;
    // #1942 (OPEN, parked): the old capture writes only the NON-DEFAULT fields of a component on a template-added plain
    // node (`nodeRowDiff.ts`), where the door records every field the gesture set (§ 2.5). The list is right; the
    // capture is the bug. Default-valued fields on an `a+` row are left out of both sides (the capture still writes one
    // when it moves with a group, as a rotation axis does), and counted on the record's.
    if (/\/a\+[^/]+$/.test(k) && row.traits) row.traits = withoutDefaults(row.traits as Bag) as typeof row.traits;
    // Hub ruling G2 (2026-10-02): a removed BASE component keeps its field records beside the removal; the old capture
    // drops them.
    if (row.traitRemovals && row.traits) {
      const t2 = { ...row.traits };
      for (const [t, on] of Object.entries(row.traitRemovals)) if (on === true && t in t2) { delete t2[t]; s4Seen.removedComponentKept++; }
      row.traits = Object.keys(t2).length ? t2 : undefined;
    }
    rows.set(k, row);
  }
  return { rows };
}

/** Whether a row lies UNDER a member the record removes (strictly). Member keys are flat within a frame (§ 2.1), so
 *  this asks the tree, not the key: the record folded with its removals cleared gives every node's parent, and a node
 *  is under a removed member when one is among its ancestors. A frame opened inside keys its rows under its own key. */
function removedDescendants(rec: InstanceRecord): (k: string) => boolean {
  const removed = new Set([...rec.list.rows].filter(([, r]) => r.removed === true).map(([k]) => k));
  if (!removed.size) return () => false;
  const probe = structuredClone(rec);
  for (const r of probe.list.rows.values()) delete r.removed;
  const nodes = foldInstance(editorPrefabReader, probe).nodes;
  const parentOf = (k: string) => { const p = nodes.get(k)?.parent; return p && 'key' in p ? p.key : undefined; };
  const under = new Set<string>();
  for (const k of nodes.keys()) for (let a = parentOf(k), n = 0; a !== undefined && n < 1024; a = parentOf(a), n++) if (removed.has(a)) { under.add(k); break; }
  const tops = [...removed, ...under];
  return (k) => under.has(k) || tops.some((u) => k.startsWith(`${u}/`));
}

function withRotationGroup(traits: Bag, node: unknown): Bag {
  const bag = traits.Transform;
  const axes = ['rx', 'ry', 'rz'];
  if (!bag || bag === true || typeof bag !== 'object' || !axes.some((a) => a in (bag as Bag)) || axes.every((a) => a in (bag as Bag))) return traits;
  const folded = ((node as { traits?: Record<string, unknown> } | undefined)?.traits?.Transform ?? {}) as Bag;
  const filled: Bag = { ...(bag as Bag) };
  // What the fold gives, or the schema default where nothing states the axis (the fold leaves those to the schema).
  const schema = soaSchema(getTraitByName('Transform')!) ?? {};
  const dflt = (a: string) => (typeof schema[a] === 'function' ? (schema[a] as () => unknown)() : schema[a]);
  for (const a of axes) if (!(a in filled)) { filled[a] = a in folded ? folded[a] : dflt(a); s4Seen.known1829++; }
  return { ...traits, Transform: filled };
}

function withAddedFilled(rec: InstanceRecord, key: string, traits: Bag, folded: ReadonlyMap<string, unknown>): Bag {
  const out: Bag = { ...traits };
  // Only a node the fold HAS: `baseTrait` is undefined for a key the fold does not reach as well, and that is no added
  // component (a member of a frame the reader cannot give, a row an Apply moved).
  if (!folded.has(key)) return out;
  for (const [t, bag] of Object.entries(traits)) {
    if (!bag || bag === true || typeof bag !== 'object' || baseTrait(rec, key, t) !== undefined) continue;
    const meta = getTraitByName(t);
    const schema = meta ? soaSchema(meta) : null;
    if (!schema) continue;
    const filled: Bag = { ...(bag as Bag) };
    for (const f of Object.keys(schema)) if (!(f in filled)) { filled[f] = typeof schema[f] === 'function' ? (schema[f] as () => unknown)() : schema[f]; s4Seen.known1829++; }
    out[t] = filled;
  }
  return out;
}

function withoutDefaults(traits: Bag, count = true): Bag {
  const out: Bag = {};
  for (const [t, bag] of Object.entries(traits)) {
    const meta = getTraitByName(t);
    const schema = meta ? soaSchema(meta) : null;
    if (!schema || !bag || bag === true || typeof bag !== 'object') { out[t] = bag; continue; }
    const kept: Bag = {};
    for (const [f, v] of Object.entries(bag as Bag)) {
      const d = typeof schema[f] === 'function' ? (schema[f] as () => unknown)() : schema[f];
      if (JSON.stringify(v) === JSON.stringify(d)) { if (count) s4Seen.known1942++; continue; }
      kept[f] = v;
    }
    out[t] = kept;
  }
  return out;
}

/** The live stored root whose guid is `rootGuid`, or undefined. */
function liveRootOf(rootGuid: string): number | undefined {
  return allStoredRoots().find((id) => guidOfEntity(id) === rootGuid);
}

export const s4Seams: ShadowSeams = {
  records: () => [...storedInstances(getCurrentWorld()).values()].map((s) => s.record),
  captureList(rootGuid) {
    // A live root: the capture of its outermost tree. A root that is not live can still be one the save keeps (a kept
    // orphan's own reference node, held where its anchor went: the capture states it, and the re-seed records it), so it
    // is looked for in every tree's capture. Stated by none: null, a record of nothing.
    const id = liveRootOf(rootGuid);
    const tops = id !== undefined ? [outermostStoredRoot(id) || id] : allStoredRoots().filter((r) => outermostStoredRoot(r) === r);
    let cap: InstanceRecord | undefined;
    for (const top of tops) if ((cap = capturedRecordsOf(top)?.find((r) => r.rootGuid === rootGuid))) break;
    if (!cap) return null;
    const list: OverrideList = { rows: new Map([...cap.list.rows].map(([k, r]) => [k, { ...r }])) };
    for (const [k, r] of list.rows) if (/\/a\+[^/]+$/.test(k) && r.traits) r.traits = withoutDefaults(r.traits as Bag, false) as typeof r.traits;
    return list;
  },
  doors: DOOR_OPS,
  judge(rec) {
    const st = storedInstances(getCurrentWorld()).get(rec.rootGuid);
    if (st?.stale) return { skip: `stale (${st.stale})` };
    // A prefab the reader cannot give (a placeholder's): both sides hold the capture's legacy channels verbatim (format
    // rule: a record that cannot be named is held), so the door's rows cannot be compared with them.
    if (!('doc' in editorPrefabReader(rec.source))) return { skip: 'its prefab is unresolved' };
    // A prefab trashed in this world (its frame kept live, #1862), this instance's or its outermost instance's: the
    // runtime cache still names it, but the save writes the tree from its frame record, which the capture does not state
    // (`capturedEntryOf`).
    if (!getCachedPrefabSync(rec.source)) return { skip: 'its prefab is trashed (the save keeps its frame, #1862)' };
    const id = liveRootOf(rec.rootGuid);
    const top = id !== undefined ? outermostStoredRoot(id) || id : undefined;
    const topEnt = top !== undefined ? findEntityById(top) : undefined;
    const topSource = topEnt && !unresolvedRefOf(topEnt as never) ? (topEnt.get(getTraitByName('PrefabInstance')!.trait) as { source?: string } | undefined)?.source : undefined;
    if (topSource && !getCachedPrefabSync(topSource)) return { skip: 'its outermost instance\'s prefab is trashed (the save keeps that frame, #1862)' };
    return translated(rec);
  },
  unrecorded: (rootGuid) => unrecordedBy(getCurrentWorld(), rootGuid),
};
