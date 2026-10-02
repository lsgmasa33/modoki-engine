/** The #2007 oracle's comparison, shared by the corpus run (`foldInstanceOracle.test.ts`) and the fuzzer's saved scenes
 *  (`foldInstanceOracleFuzz.test.ts`): read an instance's LIVE tree by the keys the fold uses, and list every way it and
 *  `foldInstance(parse(entry))` disagree — nodes, parents, components, fields, placeholders, anchors, and the unused
 *  records against what today's load keeps for the save (`keptMemberOrphans`/`keptLegacyChannels`/`keptUnusedRows`).
 *
 *  A divergence is triaged against the rules, never forced. Where a rule CHANGES what the user sees, the change is
 *  applied to today's tree before the comparison (`translate`), as the rule states it, and the comparison stays exact. */

import type { Entity } from 'koota';
import { getCurrentWorld, getTraitByName } from '@modoki/engine/runtime';
import { getAllTraits } from '../../packages/modoki/src/runtime/core/ecs/traitRegistry';
import { keptMemberOrphans, keptLegacyChannels, keptUnusedRows, type SceneEntityEntry } from '../../packages/modoki/src/runtime/loaders/loadSceneFile';
import { memberRowKeysIn } from '../../packages/modoki/src/runtime/core/ecs/memberRows';
import { templateKeyOf } from '../../packages/modoki/src/runtime/core/templateIdentity';
import { unresolvedRefOf } from '../../packages/modoki/src/runtime/core/unresolvedPrefabRef';
import { foldInstance } from '../../packages/modoki/src/runtime/prefab/foldInstance';
import { parseInstanceRecord, preV5NodeGuid, type ParseOptions } from '../../packages/modoki/src/runtime/prefab/parseInstanceRecord';
import type { PrefabReader, FoldedInstance, UnusedRecord, InstanceRecord } from '../../packages/modoki/src/runtime/prefab/instanceRecord';

type LiveNode = { key: string; parent: { key: string } | { guid: string } | null; traits: Record<string, Record<string, unknown> | true> };
export type Live = { nodes: Map<string, LiveNode>; anchors: Map<string, string[]>; placeholders: Set<string> };

const SKIP_TRAITS = new Set(['PrefabInstance', 'UnresolvedPrefabRef']);

/** The live tree of the instance rooted at `rootId`, by the fold's keys. */
export function liveTree(rootId: number): Live {
  const world = getCurrentWorld();
  const ea = getTraitByName('EntityAttributes')!.trait;
  const pi = getTraitByName('PrefabInstance')!.trait;
  const byId = new Map<number, Entity>();
  for (const e of world.entities as Iterable<Entity>) byId.set(e.id(), e);
  const parentOf = (id: number) => ((byId.get(id)?.get(ea) as { parentId?: number } | undefined)?.parentId ?? 0);
  const memberKeys = memberRowKeysIn(rootId, world);
  const under = (id: number): boolean => { for (let p = parentOf(id), n = 0; p && n < 512; p = parentOf(p), n++) if (p === rootId) return true; return false; };
  const keyOf = new Map<number, string>([[rootId, '/']]);
  for (const [id, k] of memberKeys) keyOf.set(id, k);
  /** A TEMPLATE-ADDED reference node: a node a template added that is itself a prefab instance (its own root). */
  const isTemplateRef = (id: number): boolean =>
    !!templateKeyOf(byId.get(id) as never) && (byId.get(id)?.get(pi) as { rootInstanceId?: number } | undefined)?.rootInstanceId === id;
  /** A member's FRAME key: an owned nested root, or a template-added reference node, opens its own frame; any other
   *  member sits in its key's parent frame. */
  const frameOfMember = (id: number): string => {
    if (id === rootId) return '';
    const k = keyOf.get(id)!;
    const p = byId.get(id)!.get(pi) as { parentLocalId?: number } | undefined;
    return p?.parentLocalId || isTemplateRef(id) ? k : k.slice(0, k.lastIndexOf('/'));
  };
  const templateKeyed = (id: number): string | undefined => {
    const tk = templateKeyOf(byId.get(id) as never);
    if (!tk) return undefined;
    for (let p = parentOf(id); p; p = parentOf(p)) {
      if (keyOf.has(p) && (!templateKeyOf(byId.get(p) as never) || isTemplateRef(p))) return `${frameOfMember(p)}/a+${tk}`;
      // An instance's entity not keyed (yet) on the way up: another STORED instance's — a reference node the scene added
      // under a member, whose template-added node is its own (#2009: the fuzzer's agent instantiate put a second
      // `Extra` on this instance's key) — or a template-added reference node not reached yet, retried below.
      if (!keyOf.has(p) && byId.get(p)?.has(pi)) return undefined;
    }
    return undefined;
  };
  const candidates = [...byId.keys()].filter((id) => id === rootId || memberKeys.has(id) || under(id));
  // To a fixpoint: a template-added reference node, once keyed, keys its own members under it (#2009: createPrefab of an
  // instance holding a scene-added reference node, or an instantiate in prefab edit mode, makes one), and those can
  // anchor further template-added nodes.
  for (let grew = true; grew;) {
    grew = false;
    for (const id of candidates) {
      if (keyOf.has(id)) continue;
      const k = templateKeyed(id);
      if (!k) continue;
      keyOf.set(id, k);
      grew = true;
      if (isTemplateRef(id)) for (const [m, mk] of memberRowKeysIn(id, world)) if (m !== id && !keyOf.has(m)) keyOf.set(m, `${k}${mk}`);
    }
  }
  const out: Live = { nodes: new Map(), anchors: new Map(), placeholders: new Set() };
  for (const id of candidates) {
    const e = byId.get(id)!;
    const key = keyOf.get(id);
    if (!key) {
      // Another instance's member (a stored root's expansion) is its own walk; a scene-owned node is an anchor entry
      // when it hangs directly under a keyed node.
      // A scene-added reference node (a STORED root: its own instance) hangs at its anchor like any own node; any other
      // entity with `PrefabInstance` here is a member of some other instance.
      const p = e.get(pi) as { rootInstanceId?: number } | undefined;
      if (p && p.rootInstanceId !== id) continue;
      const pk = keyOf.get(parentOf(id));
      if (pk) out.anchors.set(pk, [...(out.anchors.get(pk) ?? []), (e.get(ea) as { guid: string }).guid]);
      continue;
    }
    if (unresolvedRefOf(e as never)) out.placeholders.add(key);
    const traits: LiveNode['traits'] = {};
    for (const meta of getAllTraits()) {
      if (SKIP_TRAITS.has(meta.name) || !e.has(meta.trait)) continue;
      const d = e.get(meta.trait);
      traits[meta.name] = d && typeof d === 'object' ? { ...(d as Record<string, unknown>) } : true;
    }
    const pid = parentOf(id);
    const parent = id === rootId ? null : keyOf.has(pid) ? { key: keyOf.get(pid)! } : { guid: (byId.get(pid)?.get(ea) as { guid?: string } | undefined)?.guid ?? `#${pid}` };
    out.nodes.set(key, { key, parent, traits });
  }
  return out;
}

const close = (a: unknown, b: unknown): boolean => {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a as object), kb = Object.keys(b as object);
    return ka.length === kb.length && ka.every((k) => close((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return a === b;
};
const show = (v: unknown) => JSON.stringify(v)?.slice(0, 160);
const IGNORED_FIELDS: Record<string, Set<string>> = { EntityAttributes: new Set(['guid', 'parentId']) };

/** What the comparisons reached, for the non-vacuity pins. */
export const seen = { ruledB: 0, ruledD: 0, instances: 0, nodes: 0, fields: 0, templateAdded: 0, nested: 0, anchors: 0, placeholders: 0, unused: 0 };

/** Every way the fold and the live tree disagree, one line each. */
export function diverge(fold: FoldedInstance, live: Live): string[] {
  const out: string[] = [];
  seen.instances++;
  seen.nodes += fold.nodes.size;
  seen.templateAdded += [...fold.nodes.keys()].filter((k) => k.includes('/a+')).length;
  seen.nested += [...fold.nodes.values()].filter((n) => n.frame.rootKey !== '/').length;
  seen.anchors += [...fold.anchors.values()].reduce((a, l) => a + l.length, 0);
  seen.placeholders += fold.placeholders.size;
  seen.unused += fold.unused.length;
  for (const k of fold.nodes.keys()) if (!live.nodes.has(k)) out.push(`fold-only node ${k}`);
  for (const k of live.nodes.keys()) if (!fold.nodes.has(k) && !live.placeholders.has(k)) out.push(`live-only node ${k}`);
  for (const [k, f] of fold.nodes) {
    const l = live.nodes.get(k);
    if (!l) continue;
    if (!close(f.parent, l.parent)) out.push(`parent ${k}: fold ${show(f.parent)} live ${show(l.parent)}`);
    const fNames = Object.keys(f.traits).filter((n) => !SKIP_TRAITS.has(n) && getTraitByName(n));
    const lNames = Object.keys(l.traits);
    for (const n of fNames) if (!lNames.includes(n)) out.push(`fold-only component ${k} ${n}`);
    for (const n of lNames) if (!fNames.includes(n)) out.push(`live-only component ${k} ${n}`);
    for (const n of fNames) {
      const fv = f.traits[n], lv = l.traits[n];
      if (fv === true || lv === true || !lv) continue;
      for (const [field, v] of Object.entries(fv)) {
        if (IGNORED_FIELDS[n]?.has(field)) continue;
        seen.fields++;
        if (!close(v, lv[field])) out.push(`field ${k} ${n}.${field}: fold ${show(v)} live ${show(lv[field])}`);
      }
    }
  }
  for (const k of fold.placeholders.keys()) if (!live.placeholders.has(k)) out.push(`fold-only placeholder ${k}`);
  for (const k of live.placeholders) if (!fold.placeholders.has(k)) out.push(`live-only placeholder ${k}`);
  for (const k of new Set([...fold.anchors.keys(), ...live.anchors.keys()])) {
    const f = (fold.anchors.get(k) ?? []).map((r) => r.guid).sort(), l = (live.anchors.get(k) ?? []).sort();
    if (!close(f, l)) out.push(`anchors ${k}: fold ${show(f)} live ${show(l)}`);
  }
  return out;
}

type Bag = Record<string, unknown>;
const leavesOfTraits = (traits: unknown, out: string[]) => {
  for (const [t, d] of Object.entries((traits ?? {}) as Bag)) {
    if (d && typeof d === 'object' && Object.keys(d).length) for (const f of Object.keys(d)) out.push(`${t}.${f}`);
    else out.push(`${t}.*`);
  }
};
/** A legacy channel set's statements, one leaf each, in the fold's leaf vocabulary. */
const legacyLeaves = (c: Bag | undefined, out: string[]) => {
  if (!c) return;
  for (const byLid of Object.values((c.overrides ?? {}) as Bag)) leavesOfTraits(byLid, out);
  for (const byRow of Object.values((c.nestedOverrides ?? {}) as Bag)) for (const byLid of Object.values(byRow as Bag)) leavesOfTraits(byLid, out);
  for (const names of Object.values((c.removedTraits ?? {}) as Bag)) for (const n of names as string[]) out.push(`-${n}`);
  for (const _ of (c.removed ?? []) as unknown[]) out.push('removed');
  for (const _ of Object.keys((c.moved ?? {}) as Bag)) out.push('parent');
  for (const s of Object.values((c.nestedStructure ?? {}) as Bag)) legacyLeaves(s as Bag, out);
  for (const _ of (c.added ?? []) as unknown[]) out.push('own');
  for (const _ of (c.malformed ?? []) as unknown[]) out.push('legacy');
};
const rowLeaves = (rows: Record<string, Bag> | undefined, out: string[], skip: (key: string, leaf: string) => boolean = () => false) => {
  for (const [key, r] of Object.entries(rows ?? {})) {
    const leaves: string[] = [];
    leavesOfTraits(r.traits, leaves);
    for (const n of (r.removedTraits ?? []) as string[]) leaves.push(`-${n}`);
    for (const n of Object.keys((r.traitRemovals ?? {}) as Bag)) leaves.push(`-${n}`);
    if (r.removed !== undefined) leaves.push('removed');
    if (r.parent) leaves.push('parent');
    for (const _ of [...((r.added ?? []) as unknown[]), ...((r.own ?? []) as unknown[])]) leaves.push('own');
    for (const leaf of leaves) if (!skip(key, leaf)) out.push(leaf);
  }
};
const unusedLeaf = (u: UnusedRecord): string => {
  const p = u.part;
  switch (p.kind) {
    case 'field': return `${p.trait}.${p.field}`;
    case 'trait': return `${p.trait}.*`;
    case 'traitRemoval': return `-${p.trait}`;
    default: return p.kind;
  }
};

/** The fold's unused records against what today's load keeps for the save, as two leaf multisets.
 *  - A record `unresolved` under a placeholder is kept by that placeholder's verbatim record, so it is not compared — on
 *    EITHER side: under a placeholder only the rules put there (`checkInstance`'s translation B: today expands a copy),
 *    today keeps the same records as unused rows or applies them to the copy, at a granularity a leaf multiset cannot
 *    match (#2009). What this cannot see — a fold that keeps NOTHING for a record under a placeholder — is #2018's.
 *  - A kept row at or under a member the record REMOVES is not compared, except its `removed` leaf: the save drops a gone
 *    member's kept unused part (#1914 R4's fix), and so does the record.
 *  - A kept-only line names its row, and a kept `removed` whose member the fold removed is marked `(applied)`: today
 *    books it twice (#2013). Without the key, "the fold applied it" and "the fold lost it" read the same (#2009 review). */
export function unusedDiverge(fold: FoldedInstance, rootGuid: string, livePlaceholders: ReadonlySet<string> = new Set(), removedRows: readonly string[] = [], projectsWhenRestored: (key: string) => boolean = () => false, memberInDocuments: (key: string) => boolean = () => true): string[] {
  const kept: { key: string; leaf: string }[] = [];
  const legacy: string[] = [];
  legacyLeaves(keptLegacyChannels(rootGuid) as Bag | undefined, legacy);
  for (const leaf of legacy) kept.push({ key: '(legacy)', leaf });
  const skip = (key: string, leaf: string) => [...livePlaceholders].some((k) => under(key, k))
    || removedRows.some((k) => under(key, k) && !(key === k && leaf === 'removed'));
  for (const rows of [keptMemberOrphans(rootGuid), keptUnusedRows(rootGuid)] as (Record<string, Bag> | undefined)[]) {
    for (const [key, r] of Object.entries(rows ?? {})) {
      const leaves: string[] = [];
      rowLeaves({ [key]: r }, leaves, skip);
      for (const leaf of leaves) kept.push({ key, leaf });
    }
  }
  const compared = fold.unused.filter((u) => !(u.cause === 'unresolved' && [...livePlaceholders].some((k) => under(u.key, k))));
  return pairUnused(compared, kept, (k) => fold.nodes.has(k as never), removedRows, projectsWhenRestored, memberInDocuments);
}

/** The pairing half of {@link unusedDiverge}, pure: the fold's unused records against today's kept leaves, by row.
 *  `projected` is the fold's node set; `projectsWhenRestored(key)` re-folds the record with that row's removal turned
 *  into a restore; `memberInDocuments(key)` says a document the instance reaches still holds the row's member. */
export function pairUnused(foldUnused: readonly UnusedRecord[], keptIn: readonly { key: string; leaf: string }[], projected: (key: string) => boolean, removedRows: readonly string[], projectsWhenRestored: (key: string) => boolean, memberInDocuments: (key: string) => boolean = () => true): string[] {
  const kept = [...keptIn];
  const out: string[] = [];
  for (const u of foldUnused) {
    const leaf = unusedLeaf(u);
    // By row; only a kept LEGACY leaf, which names no row, pairs by leaf alone (#2009 re-review: a cross-row fallback let
    // one row's record consume another's kept leaf, and hide both).
    let at = kept.findIndex((k) => k.key === u.key && k.leaf === leaf);
    if (at < 0) at = kept.findIndex((k) => k.key === '(legacy)' && k.leaf === leaf);
    if (at >= 0) kept.splice(at, 1);
    else out.push(`fold-only unused ${u.key} ${leaf} (${u.cause})`);
  }
  for (const k of kept) {
    // `(applied)`: the fold does not project a member it WOULD project were the removal a restore, so the removal is
    // what took it out. A gone member does not project after the restore either (and an ambiguous one is projected
    // already), so a fold that lost its "removed, gone" record cannot read as applied (#2009 re-reviews: that loss was waived as #2013, first unkeyed, then marked
    // applied by a document-membership test, which an inner layer's removal also passes).
    const applied = k.leaf === 'removed' && removedRows.includes(k.key) && !projected(k.key) && projectsWhenRestored(k.key);
    // `(unprojected)`: an own link on a row whose member no document holds any more (#2018's mechanism: the fold never
    // registers it). A member a document still holds but a layer removed is HELD, and its link is the fold's `own
    // heldNode` record; losing that is not #2018 (#2009 re-review), so it prints unmarked.
    const unprojected = k.leaf === 'own' && k.key !== '(legacy)' && !projected(k.key) && !memberInDocuments(k.key);
    out.push(`kept-only unused ${k.key} ${k.leaf}${applied ? ' (applied)' : unprojected ? ' (unprojected)' : ''}`);
  }
  return out;
}

/** `key` is `k` or lies under it. */
const under = (key: string, k: string) => k === '/' || key === k || key.startsWith(`${k}/`);

/** One instance: parse its entry, fold it, and compare against the live tree rooted at `rootId`. `copies` are the guids
 *  of the scene's `embeddedPrefabs`, which today's load expands a missing prefab from.
 *
 *  Two placeholder changes are the rules' own, and today's tree is TRANSLATED by each before the comparison — under the
 *  frame, today's expansion (or nothing) becomes the placeholder, which keeps every record under it:
 *  - B: a frame whose prefab is missing and the scene holds a copy of: today expands the copy; the rule shows the Missing
 *    Prefab placeholder (owner ruling B, design § 5.4; rule 9: no copy);
 *  - D: a nested reference row whose prefab is missing, with no copy: today spawns nothing there; the rule puts the
 *    placeholder at the row (design § 2.4 item 5, ruling D; rule 9). */
export function checkInstance(entry: SceneEntityEntry, read: PrefabReader, rootId: number, opts: ParseOptions = {}, copies: ReadonlySet<string> = new Set()): string[] {
  return checkRecord(parseInstanceRecord(entry, read, opts).record, read, rootId, copies);
}

/** {@link checkInstance} for a record already parsed — a scene reference node's (`parseReferenceNode`, #2009). */
export function checkRecord(rec: InstanceRecord, read: PrefabReader, rootId: number, copies: ReadonlySet<string> = new Set()): string[] {
  const fold = foldInstance(read, rec);
  const live = liveTree(rootId);
  for (const [k, ph] of fold.placeholders) {
    if (ph.reason !== 'missing' || live.placeholders.has(k)) continue;
    const today = [...live.nodes.keys()].filter((n) => under(n, k));
    if (copies.has(ph.source)) seen.ruledB++;
    else if (k !== '/' && !today.length) seen.ruledD++;
    else continue;
    for (const n of today) live.nodes.delete(n);
    for (const a of [...live.anchors.keys()]) if (under(a, k)) live.anchors.delete(a);
    live.placeholders.add(k);
  }
  const removedRows = [...rec.list.rows].filter(([, r]) => r.removed).map(([k]) => k);
  const projectsWhenRestored = (key: string): boolean => {
    const rows = new Map(rec.list.rows);
    rows.set(key as never, { ...rows.get(key as never)!, removed: false });
    return foldInstance(read, { ...rec, list: { ...rec.list, rows } }).nodes.has(key as never);
  };
  // The member guids the instance's documents hold. A template-added key (`a+…`) names no member guid, so it counts as
  // held: the marker that needs its absence stays off, and a loss there goes red.
  const nodeGuids = new Set<string>();
  const seenDocs = new Set<string>();
  const walk = (g: string): void => {
    if (!g || seenDocs.has(g)) return;
    seenDocs.add(g);
    const got = read(g);
    if (!('doc' in got)) return;
    for (const row of got.doc.entities ?? []) {
      if (typeof row.localId === 'number') nodeGuids.add(row.nodeGuid ?? preV5NodeGuid(g, row.localId));
      if (typeof row.prefab === 'string') walk(row.prefab);
    }
  };
  walk(rec.source);
  const memberInDocuments = (key: string): boolean => {
    const last = key.slice(key.lastIndexOf('/') + 1);
    return last.startsWith('a+') || nodeGuids.has(last);
  };
  return [...diverge(fold, live), ...unusedDiverge(fold, rec.rootGuid, live.placeholders, removedRows, projectsWhenRestored, memberInDocuments)];
}
