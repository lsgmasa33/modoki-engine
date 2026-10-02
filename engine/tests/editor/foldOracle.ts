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
import { parseInstanceRecord, type ParseOptions } from '../../packages/modoki/src/runtime/prefab/parseInstanceRecord';
import type { PrefabReader, FoldedInstance, UnusedRecord } from '../../packages/modoki/src/runtime/prefab/instanceRecord';

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
  /** A member's FRAME key: an owned nested root opens its own frame; any other member sits in its key's parent frame. */
  const frameOfMember = (id: number): string => {
    if (id === rootId) return '';
    const k = keyOf.get(id)!;
    const p = byId.get(id)!.get(pi) as { parentLocalId?: number } | undefined;
    return p?.parentLocalId ? k : k.slice(0, k.lastIndexOf('/'));
  };
  const templateKeyed = (id: number): string | undefined => {
    const tk = templateKeyOf(byId.get(id) as never);
    if (!tk) return undefined;
    for (let p = parentOf(id); p; p = parentOf(p)) {
      if (keyOf.has(p) && !templateKeyOf(byId.get(p) as never)) return `${frameOfMember(p)}/a+${tk}`;
    }
    return undefined;
  };
  const candidates = [...byId.keys()].filter((id) => id === rootId || memberKeys.has(id) || under(id));
  for (const id of candidates) {
    if (keyOf.has(id)) continue;
    const k = templateKeyed(id);
    if (k) keyOf.set(id, k);
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
const rowLeaves = (rows: Record<string, Bag> | undefined, out: string[]) => {
  for (const r of Object.values(rows ?? {})) {
    leavesOfTraits(r.traits, out);
    for (const n of (r.removedTraits ?? []) as string[]) out.push(`-${n}`);
    for (const n of Object.keys((r.traitRemovals ?? {}) as Bag)) out.push(`-${n}`);
    if (r.removed !== undefined) out.push('removed');
    if (r.parent) out.push('parent');
    for (const _ of [...((r.added ?? []) as unknown[]), ...((r.own ?? []) as unknown[])]) out.push('own');
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

/** The fold's unused records against what today's load keeps for the save, as two leaf multisets. A record `unresolved`
 *  under a placeholder today ALSO shows is kept by that placeholder's verbatim record, so it is not compared here. */
export function unusedDiverge(fold: FoldedInstance, rootGuid: string, livePlaceholders: ReadonlySet<string> = new Set()): string[] {
  const kept: string[] = [];
  legacyLeaves(keptLegacyChannels(rootGuid) as Bag | undefined, kept);
  rowLeaves(keptMemberOrphans(rootGuid) as Record<string, Bag> | undefined, kept);
  rowLeaves(keptUnusedRows(rootGuid) as Record<string, Bag> | undefined, kept);
  const out: string[] = [];
  const left = [...kept];
  for (const u of fold.unused) {
    if (u.cause === 'unresolved' && [...livePlaceholders].some((k) => under(u.key, k))) continue;
    const leaf = unusedLeaf(u);
    const at = left.indexOf(leaf);
    if (at >= 0) left.splice(at, 1);
    else out.push(`fold-only unused ${u.key} ${leaf} (${u.cause})`);
  }
  for (const leaf of left) out.push(`kept-only unused ${leaf}`);
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
  const fold = foldInstance(read, parseInstanceRecord(entry, read, opts).record);
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
  return [...diverge(fold, live), ...unusedDiverge(fold, entry.guid!, live.placeholders)];
}
