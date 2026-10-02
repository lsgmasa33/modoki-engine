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
import { instanceKeyMap } from '../../packages/modoki/src/editor/instance/instanceKeys';
import { unresolvedRefOf } from '../../packages/modoki/src/runtime/core/unresolvedPrefabRef';
import { foldInstance } from '../../packages/modoki/src/runtime/prefab/foldInstance';
import { parseInstanceRecord, preV5NodeGuid, type ParseOptions } from '../../packages/modoki/src/runtime/prefab/parseInstanceRecord';
import { HELD_REMAINDER, type PrefabReader, type FoldedInstance, type UnusedRecord, type InstanceRecord } from '../../packages/modoki/src/runtime/prefab/instanceRecord';

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
  const under = (id: number): boolean => { for (let p = parentOf(id), n = 0; p && n < 512; p = parentOf(p), n++) if (p === rootId) return true; return false; };
  // The row keys are S4's own (`instanceKeyMap`, #2026): the root, its members, its template-added nodes, and through each
  // template-added reference node that frame's keys under `…/a+<key>/…`. The oracle and the door share one definition.
  const keyOf: ReadonlyMap<number, string> = instanceKeyMap(rootId);
  const candidates = [...byId.keys()].filter((id) => keyOf.has(id) || under(id));
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
export const seen = {
  ruledB: 0, ruledD: 0, ruledOwn: 0, ruledOwnFix: 0, defaults: 0, instances: 0, nodes: 0, fields: 0, templateAdded: 0, nested: 0, anchors: 0, placeholders: 0, unused: 0,
  // `placementDiverge` (#2021): own links by where the rules put them, and the records it held to `unresolved`.
  ownProjected: 0, ownAtPlaceholder: 0, ownInPlaceholder: 0, ownHeld: 0, ownDuplicate: 0, heldNodeUnjudged: 0, unresolvedUnderPlaceholder: 0,
  heldUnderPlaceholder: 0,
  removedAtPlaceholder: 0,
};

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
      // A live field the fold does NOT state must be the schema default: otherwise a record the fold dropped, on a field
      // the template bag lacks, would pass (close-out review).
      const schema = (getTraitByName(n)?.trait as { schema?: Record<string, unknown> } | undefined)?.schema ?? {};
      for (const [field, lvv] of Object.entries(lv)) {
        if (field in fv || IGNORED_FIELDS[n]?.has(field) || !(field in schema)) continue;
        const d = schema[field];
        const def = typeof d === 'function' ? (d as () => unknown)() : d;
        seen.defaults++;
        if (!close(lvv, def)) out.push(`unstated ${k} ${n}.${field}: live ${show(lvv)} default ${show(def)}`);
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

/** A kept row's leaves, each link with its guid (`pairUnused`'s `(applied)` reads it): `rowLeaves`' order, so its
 *  `added` links, then its `own`. `skip` is per row and leaf, so it keeps all of a row's links or none. */
export function keptRowLeaves(key: string, r: Bag, skip: (key: string, leaf: string) => boolean = () => false): { key: string; leaf: string; guid?: string }[] {
  const leaves: string[] = [];
  rowLeaves({ [key]: r }, leaves, skip);
  const links = [...((r.added ?? []) as Bag[]), ...((r.own ?? []) as Bag[])].map((n) => n?.guid as string | undefined);
  let i = 0;
  return leaves.map((leaf) => (leaf === 'own' ? { key, leaf, guid: links[i++] } : { key, leaf }));
}

/** The fold's unused records against what today's load keeps for the save, as two leaf multisets.
 *  - A record `unresolved` under a placeholder is kept by that placeholder's verbatim record, so it is not compared — on
 *    EITHER side: under a placeholder only the rules put there (`checkInstance`'s translation B: today expands a copy),
 *    today keeps the same records as unused rows or applies them to the copy, at a granularity a leaf multiset cannot
 *    match (#2009). What this cannot see, a fold that loses or misplaces a record under a placeholder, `placementDiverge`
 *    checks against the record by the rules (#2021).
 *  - A kept row at or under a member the record REMOVES is not compared, except its `removed` leaf: the save drops a gone
 *    member's kept unused part (#1914 R4's fix), and so does the record.
 *  - A kept-only line names its row, and a kept `removed` whose member the fold removed is marked `(applied)`: today
 *    books it twice (#2013). Without the key, "the fold applied it" and "the fold lost it" read the same (#2009 review). */
export function unusedDiverge(fold: FoldedInstance, rootGuid: string, livePlaceholders: ReadonlySet<string> = new Set(), removedRows: readonly string[] = [], projectsWhenRestored: (key: string) => boolean = () => false, memberInDocuments: (key: string) => boolean = () => true, held?: Bag, ruledKept: readonly string[] = []): string[] {
  const kept: { key: string; leaf: string; guid?: string }[] = [];
  const legacy: string[] = [];
  legacyLeaves(keptLegacyChannels(rootGuid) as Bag | undefined, legacy);
  for (const leaf of legacy) kept.push({ key: '(legacy)', leaf });
  const skip = (key: string, leaf: string) => [...livePlaceholders].some((k) => under(key, k))
    || removedRows.some((k) => under(key, k) && !(key === k && leaf === 'removed'));
  for (const rows of [keptMemberOrphans(rootGuid), keptUnusedRows(rootGuid)] as (Record<string, Bag> | undefined)[]) {
    for (const [key, r] of Object.entries(rows ?? {})) kept.push(...keptRowLeaves(key, r, skip));
  }
  // Today's kept copy of a link the rules now SHOW (#2018 (i), `checkRecord`), where today kept one.
  for (const key of ruledKept) { const at = kept.findIndex((k) => k.key === key && k.leaf === 'own'); if (at >= 0) kept.splice(at, 1); }
  const compared = fold.unused.filter((u) => !(u.cause === 'unresolved' && [...livePlaceholders].some((k) => under(u.key, k))));
  // A held MEMBER ROW's record (part path `['members', k, field?, i?]`) is today's kept row, verbatim: paired as the
  // leaves that row shows in today's store, at `k` (close-out review round 4).
  const out: string[] = [];
  const rest = compared.filter((u) => {
    if (u.part.kind !== 'legacy' || u.part.path[0] !== 'members') return true;
    const [, k, field, i] = u.part.path;
    const row = ((held?.members ?? {}) as Bag)[k!] as Bag | undefined;
    if (!row || typeof row !== 'object') return true;
    const leaves: string[] = [];
    rowLeaves({ [k!]: field === undefined ? row : { [field]: i === undefined ? row[field] : [(row[field] as unknown[])[Number(i)]] } }, leaves, skip);
    for (const leaf of leaves) {
      const at = kept.findIndex((e) => e.key === k && e.leaf === leaf);
      if (at >= 0) kept.splice(at, 1); else out.push(`fold-only unused ${k} ${leaf} (${u.cause})`);
    }
    return false;
  });
  return [...out, ...pairUnused(rest, kept, (k) => fold.nodes.has(k as never), removedRows, projectsWhenRestored, memberInDocuments, (k) => (fold.anchors.get(k as never) ?? []).map((r) => r.guid))];
}

/** The pairing half of {@link unusedDiverge}, pure: the fold's unused records against today's kept leaves, by row.
 *  `projected` is the fold's node set; `projectsWhenRestored(key)` re-folds the record with that row's removal turned
 *  into a restore; `memberInDocuments(key)` says a document the instance reaches still holds the row's member;
 *  `anchoredAt(key)` is the guids the fold links at that row. */
export function pairUnused(foldUnused: readonly UnusedRecord[], keptIn: readonly { key: string; leaf: string; guid?: string }[], projected: (key: string) => boolean, removedRows: readonly string[], projectsWhenRestored: (key: string) => boolean, memberInDocuments: (key: string) => boolean = () => true, anchoredAt: (key: string) => readonly string[] = () => []): string[] {
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
    const applied = (k.leaf === 'removed' && removedRows.includes(k.key) && !projected(k.key) && projectsWhenRestored(k.key))
      // A kept LINK the fold links at the same row, by guid: today keeps the row as an orphan and also spawns the node,
      // the same double booking on a link (#1931 member 1: its orphan test misses a template member row's `own`, #2023).
      // A link the fold lost, or links elsewhere, is not an application, and prints unmarked. The line names the guid,
      // so a waiver can tie the fold's link at that row to this kept one and to nothing else.
      || (k.leaf === 'own' && k.key !== '(legacy)' && !!k.guid && anchoredAt(k.key).includes(k.guid));
    // `(unprojected)`: an own link on a row whose member no document holds any more (#2018's mechanism: the fold never
    // registers it). A member a document still holds but a layer removed is HELD, and its link is the fold's `own
    // heldNode` record; losing that is not #2018 (#2009 re-review), so it prints unmarked.
    const unprojected = k.leaf === 'own' && k.key !== '(legacy)' && !projected(k.key) && !memberInDocuments(k.key);
    out.push(`kept-only unused ${k.key} ${k.leaf}${applied ? (k.leaf === 'own' ? ` (applied ${k.guid})` : ' (applied)') : unprojected ? ' (unprojected)' : ''}`);
  }
  return out;
}

/** `key` is `k` or lies under it. */
const under = (key: string, k: string) => k === '/' || key === k || key.startsWith(`${k}/`);

/** #2021: where the fold puts what it cannot apply in place, against the RECORD (design § 10.4b, #2018's rulings).
 *  Under a placeholder today shows nothing and keeps the records at a granularity `unusedDiverge` cannot pair, so this
 *  side is checked against the rules instead:
 *  - every user-added node the record states is placed exactly ONCE, in anchors or unused, never neither and never
 *    both: AT a placeholder it hangs from it, INSIDE a placeholder's frame it is `unresolved`, on a projected member it
 *    is anchored there, on any other member it is `heldNode` (B′). A node is one guid, whatever states it: a list
 *    row's `own` link, its content in `held.heldOwn`, or a scene-owned (keyless) node in a held legacy row's `added`
 *    (§ 10.4b: AT a placeholder it shows "in every file form");
 *  - every list record at or inside a placeholder is unused `unresolved`, part by part (U9; rule 9), except a `removed`
 *    AT a nested one, which applies;
 *  - every held legacy statement of a member row under a placeholder, and every held statement when the instance's own
 *    prefab is missing, is reported, and only as `unresolved`.
 *  The fold reports only placeholders no removal cut: a cut one goes with its member (`foldInstance`'s cascade), and
 *  what is at or inside it is under the instance's own removal, so its links are `heldNode` and its other records are
 *  inert (hub, 2026-10-02, #2021: the cut dominates the placeholder; rule 3).
 *  Not judged: a guid stated more than once (a duplicate identifier: #1937 owns what it means; counted); WHERE a held
 *  node in a form that does not name its anchor row shows, and its cause (#2025's family; counted) — it must still be
 *  placed exactly once; a nested-channel statement under a missing NESTED prefab; and which of a held statement's parts
 *  the fold reports — a statement needs one record besides its nodes, so one losing some of its fields passes. */
export function placementDiverge(fold: FoldedInstance, rec: InstanceRecord): string[] {
  const out: string[] = [];
  const phs = [...fold.placeholders.keys()];
  const atPh = (key: string) => phs.includes(key);
  const underPh = (key: string) => phs.some((k) => under(key, k));
  const allowedAt = (key: string): string => (atPh(key) ? `anchor ${key}` : underPh(key) ? `unused ${key} unresolved` : fold.nodes.has(key) ? `anchor ${key}` : `unused ${key} heldNode`);
  const pending = (rec.held.pendingLegacy ?? {}) as Bag;
  const pathOf = (path: readonly string[]) => path.join('\u0000');

  // The user-added nodes the record states: guid → where each statement anchors it.
  const stated = new Map<string, string[]>();
  const state = (guid: string, key: string) => stated.set(guid, [...(stated.get(guid) ?? []), key]);
  for (const [key, r] of rec.list.rows) for (const o of r.own ?? []) state(o.guid, key);
  const linked = new Set(stated.keys());
  // `heldOwn` holds a node's CONTENT; with a link of the same guid it is that link's node, not a second one.
  for (const [key, nodes] of rec.held.heldOwn ?? []) for (const n of nodes) { const g = typeof n.guid === 'string' ? n.guid : ''; if (!linked.has(g)) state(g, key); }
  // A scene-owned node in a held legacy member row's `added`: the fold reports it at that legacy path.
  const nodePaths = new Map<string, string>();
  for (const [k, row] of Object.entries((pending.members ?? {}) as Bag)) {
    const added = row && typeof row === 'object' ? (row as Bag).added : undefined;
    if (!Array.isArray(added)) continue;
    added.forEach((el, i) => {
      const n = el as Bag | null;
      if (!n || typeof n !== 'object' || (typeof n.key === 'string' && n.key) || typeof n.guid !== 'string') return;
      state(n.guid, k);
      nodePaths.set(pathOf(['members', k, 'added', String(i)]), n.guid);
    });
  }
  // A scene-owned node held in a form that does not name its anchor row — the entry-level legacy `added` (by a localId
  // of the missing document) and a held `nestedStructure` slot's `added` — is the #2025 family: whether and where it
  // shows is the fold's open question there, so it is neither placed nor held to `unresolved` here (counted). Holding
  // it to `unresolved` would push a fix that shows it ("every file form", § 10.4b) the wrong way.
  const unjudged = new Map<string, string>();
  const keyless = (list: unknown, at: string[]) => {
    if (Array.isArray(list)) list.forEach((el, i) => {
      const n = el as Bag | null;
      if (n && typeof n === 'object' && !(typeof n.key === 'string' && n.key) && typeof n.guid === 'string') unjudged.set(pathOf([...at, String(i)]), n.guid);
    });
  };
  keyless(pending.added, ['added']);
  for (const [k, slot] of Object.entries((pending.nestedStructure ?? {}) as Bag)) if (slot && typeof slot === 'object') keyless((slot as Bag).added, ['nestedStructure', k, 'added']);
  const unjudgedGuids = new Set(unjudged.values());
  seen.heldNodeUnjudged += unjudged.size;
  // Where the fold put each one.
  const places = new Map<string, string[]>();
  const place = (guid: string, where: string) => places.set(guid, [...(places.get(guid) ?? []), where]);
  for (const [k, refs] of fold.anchors) for (const r of refs) place(r.guid, `anchor ${k}`);
  for (const u of fold.unused) {
    if (u.part.kind === 'own') place(u.part.guid, `unused ${u.key} ${u.cause}`);
    else if (u.part.kind === 'legacy' && nodePaths.has(pathOf(u.part.path))) place(nodePaths.get(pathOf(u.part.path))!, `unused ${u.key} ${u.cause}`);
  }
  // An unjudged node is still ONE node: shown once, or held once at its own path — never neither, both or twice.
  for (const [path, guid] of unjudged) {
    if (stated.has(guid)) continue;
    const at = [...(places.get(guid) ?? []).filter((p) => p.startsWith('anchor ')), ...fold.unused.filter((u) => u.part.kind === 'legacy' && pathOf(u.part.path) === path).map((u) => `unused ${u.key} ${u.cause}`)];
    if (at.length !== 1) out.push(`held node ${guid} (${show(path.split('\u0000'))}): placed ${show(at)}`);
  }
  for (const guid of new Set([...stated.keys(), ...places.keys()])) {
    if (unjudgedGuids.has(guid) && !stated.has(guid)) continue;
    const keys = stated.get(guid) ?? [];
    if (keys.length > 1) { seen.ownDuplicate++; continue; }
    const got = places.get(guid) ?? [];
    const want = keys.length ? allowedAt(keys[0]!) : undefined;
    if (keys.length) seen[atPh(keys[0]!) ? 'ownAtPlaceholder' : underPh(keys[0]!) ? 'ownInPlaceholder' : fold.nodes.has(keys[0]!) ? 'ownProjected' : 'ownHeld']++;
    if (got.length !== 1 || got[0] !== want) out.push(`own link ${guid}: stated ${show(want ? [want] : [])} placed ${show(got)}`);
  }

  // Every other list record at or under a placeholder is unused `unresolved`, and nothing else the fold keeps there is.
  const expected: string[] = [];
  for (const [key, r] of rec.list.rows) {
    if (!underPh(key)) continue;
    const leaves: string[] = [];
    rowLeaves({ [key]: r as Bag }, leaves);
    // A `removed` AT a nested placeholder targets the reference ROW of a loaded document: it applies (it decides whether
    // the placeholder shows), so it is not unused (hub, 2026-10-02, #2021: projected or unused, never both).
    const applies = (leaf: string) => leaf === 'removed' && atPh(key) && key !== '/';
    for (const leaf of leaves) if (leaf !== 'own' && !applies(leaf)) expected.push(`${key} ${leaf} (unresolved)`);
    if (atPh(key) && key !== '/' && r.removed !== undefined) seen.removedAtPlaceholder++;
  }
  seen.unresolvedUnderPlaceholder += expected.length;
  const kept = fold.unused.filter((u) => u.part.kind !== 'own' && u.part.kind !== 'legacy' && underPh(u.key)).map((u) => `${u.key} ${unusedLeaf(u)} (${u.cause})`);
  for (const e of expected) {
    const i = kept.indexOf(e);
    if (i >= 0) kept.splice(i, 1);
    else out.push(`under a placeholder, not unused unresolved: ${e}`);
  }
  for (const k of kept) out.push(`under a placeholder, unused but not stated: ${k}`);

  // Every held legacy statement under a placeholder is reported, and only as `unresolved`. A statement is a channel's
  // entry; a member row's is under a placeholder when its key is, every one is when the instance's own prefab is missing.
  // NOT judged: a `nestedOverrides`/`nestedStructure` statement whose path runs through a missing NESTED prefab (it is
  // keyed at `/`; telling which placeholder it waits on is a frame walk this check does not repeat), and a slot that
  // states nothing (`{}`, or only the remainder marker).
  const statements: string[][] = [];
  // Only a member row or a nested slot is a CONTAINER; any other channel's entry is one statement, empty or not.
  const statesNothing = (channel: string, v: unknown) => (channel === 'members' || channel === 'nestedStructure')
    && !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every((k) => k === HELD_REMAINDER);
  const values = new Map<string, unknown>();
  for (const [channel, value] of Object.entries(pending)) {
    if (channel === HELD_REMAINDER) continue;
    if (Array.isArray(value)) value.forEach((v, i) => { statements.push([channel, String(i)]); values.set(pathOf([channel, String(i)]), v); });
    else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) if (!statesNothing(channel, v)) { statements.push([channel, k]); values.set(pathOf([channel, k]), v); }
    } else { statements.push([channel]); values.set(pathOf([channel]), value); }
  }
  /** What a statement holds besides user-added nodes (each checked as a node above): it needs a record of its own. */
  const holdsMore = (st: readonly string[]): boolean => {
    const v = values.get(pathOf(st));
    const isNode = (p: string[]) => nodePaths.has(pathOf(p)) || unjudged.has(pathOf(p));
    if (isNode([...st])) return false;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return true;
    const added = (v as Bag).added;
    if (Object.keys(v).some((k) => k !== 'added' && k !== HELD_REMAINDER)) return true;
    return !Array.isArray(added) || !added.length || added.some((_e, i) => !isNode([...st, 'added', String(i)]));
  };
  const legacy = fold.unused.filter((u): u is UnusedRecord & { part: { kind: 'legacy'; path: string[] } } => u.part.kind === 'legacy');
  const inside = (path: readonly string[], st: readonly string[]) => st.every((x, i) => path[i] === x);
  for (const st of statements) {
    if (!(atPh('/') || (st[0] === 'members' && st.length === 2 && underPh(st[1]!)))) continue;
    seen.heldUnderPlaceholder++;
    const recs = legacy.filter((u) => inside(u.part.path, st) && !nodePaths.has(pathOf(u.part.path)) && !unjudged.has(pathOf(u.part.path)));
    if (!recs.length && holdsMore(st)) out.push(`under a placeholder, held ${show(st)} not reported`);
    for (const u of recs) if (u.cause !== 'unresolved') out.push(`under a placeholder, held ${show(u.part.path)} unused ${u.cause}, not unresolved`);
  }
  for (const u of legacy) if (!statements.some((st) => inside(u.part.path, st))) out.push(`unused legacy ${show(u.part.path)} names no held statement`);
  return out;
}

/** One instance: parse its entry, fold it, and compare against the live tree rooted at `rootId`. `copies` are the guids
 *  of the scene's `embeddedPrefabs`, which today's load expands a missing prefab from.
 *
 *  Two placeholder changes are the rules' own, and today's tree is TRANSLATED by each before the comparison — under the
 *  frame, today's expansion (or nothing) becomes the placeholder, which keeps every record under it:
 *  - B: a frame whose prefab is missing and the scene holds a copy of: today expands the copy; the rule shows the Missing
 *    Prefab placeholder (owner ruling B, design § 5.4; rule 9: no copy);
 *  - D: a nested reference row whose prefab is missing, with no copy: today spawns nothing there; the rule puts the
 *    placeholder at the row (design § 2.4 item 5, ruling D; rule 9). */
export function checkInstance(entry: SceneEntityEntry, read: PrefabReader, rootId: number, opts: ParseOptions, copies: ReadonlySet<string> = new Set()): string[] {
  return checkRecord(parseInstanceRecord(entry, read, opts).record, read, rootId, copies);
}

/** {@link checkInstance} for a record already parsed — a scene reference node's (`parseReferenceNode`, #2009). */
export function checkRecord(rec: InstanceRecord, read: PrefabReader, rootId: number, copies: ReadonlySet<string> = new Set()): string[] {
  const fold = foldInstance(read, rec);
  const live = liveTree(rootId);
  // What today shows, anchored anywhere, before any translation moves a subtree out.
  const shownToday = new Set([...live.anchors.values()].flat());
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
  // Every scene-owned node the record links AT a placeholder hangs from it (#2018; hub ruling 2026-10-02 (i), a visible
  // FIX): today shows it under the copy's root (B) or the instance root (D) — or, in the v17+ `own` form and under a
  // template-added reference node, HIDES it (kept as an unused row, or in no store, lost on the next save).
  const ruledKept: string[] = [];
  for (const k of fold.placeholders.keys()) {
    const linked = new Set(((rec.list.rows.get(k) as { own?: { guid: string }[] } | undefined)?.own ?? []).map((o) => o.guid));
    if (!linked.size) continue;
    const shown = new Set([...linked].filter((g) => shownToday.has(g)));
    for (const [a, gs] of [...live.anchors]) {
      const rest = gs.filter((g) => !linked.has(g));
      if (rest.length === gs.length) continue;
      if (rest.length) live.anchors.set(a, rest); else live.anchors.delete(a);
    }
    live.anchors.set(k, [...linked]);
    if (shown.size) seen.ruledOwn++;
    if (shown.size < linked.size) { seen.ruledOwnFix++; for (let i = shown.size; i < linked.size; i++) ruledKept.push(k); }
  }
  const removedRows = [...rec.list.rows].filter(([, r]) => r.removed).map(([k]) => k);
  const projectsWhenRestored = (key: string): boolean => {
    const rows = new Map(rec.list.rows);
    rows.set(key as never, { ...rows.get(key as never)!, removed: false });
    // A placeholder is a projected row too: the removal of a missing-prefab row is applied when it takes the placeholder.
    const restored = foldInstance(read, { ...rec, list: { ...rec.list, rows } });
    return restored.nodes.has(key as never) || restored.placeholders.has(key as never);
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
  return [...diverge(fold, live), ...unusedDiverge(fold, rec.rootGuid, live.placeholders, removedRows, projectsWhenRestored, memberInDocuments, rec.held.pendingLegacy as Bag | undefined, ruledKept), ...placementDiverge(fold, rec)];
}
