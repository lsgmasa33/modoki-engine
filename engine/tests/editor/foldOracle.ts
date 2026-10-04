/** The #2007 oracle's comparison, shared by the corpus run (`foldInstanceOracle.test.ts`) and the fuzzer's saved scenes
 *  (`foldInstanceOracleFuzz.test.ts`): read an instance's LIVE tree by the keys the fold uses, and list every way it and
 *  `foldInstance(parse(entry))` disagree — nodes, parents, components, fields, placeholders and anchors. (It compared the
 *  fold's unused records with the stores the load kept for the save, too, until #2001 S8b: the load fills none any more,
 *  and the save writes the record's unused part itself, which the save → reload tests hold.)
 *
 *  A divergence is triaged against the rules, never forced. Where a rule CHANGES what the user sees, the change is
 *  applied to today's tree before the comparison (`translate`), as the rule states it, and the comparison stays exact. */

import type { Entity } from 'koota';
import { getCurrentWorld, getTraitByName } from '@modoki/engine/runtime';
import { getAllTraits } from '../../packages/modoki/src/runtime/core/ecs/traitRegistry';
import type { SceneEntityEntry } from '../../packages/modoki/src/runtime/loaders/loadSceneFile';
import { instanceKeyMap } from '../../packages/modoki/src/editor/instance/instanceKeys';
import { rowPlaceholderOf, unresolvedRefOf } from '../../packages/modoki/src/runtime/core/unresolvedPrefabRef';
import { foldInstance } from '../../packages/modoki/src/runtime/prefab/foldInstance';
import { parseInstanceRecord, frameOf, componentOf, type ParseOptions } from '../../packages/modoki/src/runtime/prefab/parseInstanceRecord';
import { parseSteps } from '../../packages/modoki/src/runtime/core/assetRefRules';
import { splitMalformedChannels } from '../../packages/modoki/src/runtime/loaders/malformedChannels';
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
    if (unresolvedRefOf(e as never) || rowPlaceholderOf(e as never)) out.placeholders.add(key);
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
  ruledB: 0, ruledD: 0,
  // …and the same placeholders where the live side ALREADY shows them (#2028: a load through realize shows the rulings,
  // so the translation above has nothing to do there).
  shownB: 0, shownD: 0, ruledOwn: 0, ruledOwnFix: 0, defaults: 0, instances: 0, nodes: 0, fields: 0, templateAdded: 0, nested: 0, anchors: 0, placeholders: 0, unused: 0,
  // `placementDiverge` (#2021): own links by where the rules put them, and the records it held to `unresolved`.
  ownProjected: 0, ownAtPlaceholder: 0, ownInPlaceholder: 0, ownHeld: 0, ownDuplicate: 0, heldNodeUnjudged: 0, unresolvedUnderPlaceholder: 0,
  // #2030: #2025's held forms judged — an entry-level legacy `added` node under a missing root, a slot's under a missing
  // nested document.
  heldEntryAdded: 0, heldSlotAdded: 0,
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
/** `skip`'s `keyed`: the leaf is a legacy `added` element with a template key, a statement about a template-added node
 *  (a keyed copy), not a user-added node, though it reads as an `own` leaf too. */
type LeafSkip = (key: string, leaf: string, keyed?: boolean) => boolean;
const rowLeaves = (rows: Record<string, Bag> | undefined, out: string[], skip: LeafSkip = () => false) => {
  for (const [key, r] of Object.entries(rows ?? {})) {
    const leaves: string[] = [];
    leavesOfTraits(r.traits, leaves);
    for (const n of (r.removedTraits ?? []) as string[]) leaves.push(`-${n}`);
    for (const n of Object.keys((r.traitRemovals ?? {}) as Bag)) leaves.push(`-${n}`);
    if (r.removed !== undefined) leaves.push('removed');
    if (r.parent) leaves.push('parent');
    for (const leaf of leaves) if (!skip(key, leaf)) out.push(leaf);
    for (const n of (r.added ?? []) as Bag[]) if (!skip(key, 'own', !!n?.key)) out.push('own');
    for (const _ of (r.own ?? []) as unknown[]) if (!skip(key, 'own')) out.push('own');
  }
};
export const unusedLeaf = (u: UnusedRecord): string => {
  const p = u.part;
  switch (p.kind) {
    case 'field': return `${p.trait}.${p.field}`;
    case 'trait': return `${p.trait}.*`;
    case 'traitRemoval': return `-${p.trait}`;
    default: return p.kind;
  }
};

/** `key` is `k` or lies under it. */
const under = (key: string, k: string) => k === '/' || key === k || key.startsWith(`${k}/`);

const ROOT_KEY = '/';
/** {@link placementDiverge}'s want for a user node inside a held keyed copy: held once, by a record that keeps it. */
const HELD_IN_COPY = 'unused <the copy\'s record> heldNode|unresolved';

/** The placeholder row a held `nestedStructure` slot's path (`'5'`, `'5.3'`: localIds, frame by frame) stops at, where a
 *  document is missing: `/` when the instance's own is; null when the path resolves, names no reference row, or there
 *  is no reader. Walked here from the documents, not taken from the fold (hub ruling Q4 on #2025). */
function slotPlaceholder(source: string, path: string, read: PrefabReader | undefined): string | null {
  if (!read) return null;
  const top = read(source);
  if (!('doc' in top)) return ROOT_KEY;
  let f = frameOf('', top.doc, source);
  for (const step of parseSteps(path)) {
    const row = typeof step === 'number' && Number.isInteger(step) ? f.byLid.get(step) : undefined;
    if (!row?.prefab) return null;
    const key = `${f.prefix}/${componentOf(f, step as number)}`;
    const got = read(row.prefab);
    if (!('doc' in got)) return key;
    f = frameOf(key, got.doc, row.prefab);
  }
  return null;
}

/** A user's own node, as every held form states one: keyless (a template node has a `key`), with a guid stated — the
 *  rules link a node by its guid, so an empty one names nothing (#2030 review). Shared by the oracle and the fuzzer's
 *  file forms (`prefabFuzz/fileForms.ts`), so the two cannot disagree on which nodes there are. */
export const isUserNode = (n: unknown): n is Bag & { guid: string } =>
  !!n && typeof n === 'object' && !Array.isArray(n) && !(typeof (n as Bag).key === 'string' && (n as Bag).key) && typeof (n as Bag).guid === 'string' && !!(n as Bag).guid;

/** The stored owner {@link placementDiverge} reads a missing root's held forms from: a scene entry, or a scene-added
 *  reference node. */
export type StoredOwner = { traits?: unknown; added?: unknown; members?: unknown };

/** What {@link placementDiverge} needs beyond the fold and the record to judge #2025's held forms (#2030). Absent, the
 *  form it would judge stays unjudged (counted), as before. */
export interface PlacementContext {
  /** The instance's documents: a held `nestedStructure` slot names its frame by localIds, so where its node waits is a
   *  walk through them. */
  read?: PrefabReader;
  /** The owner AS STORED. Under a missing root, where each user node of its root forms belongs (Q3) is read from it, not
   *  from the parse: the parser takes the nodes it links out of what it holds and states them as the `/` row's `own`,
   *  so judged from the record, a parser linking every node agrees with itself (#2030 review). */
  owner?: StoredOwner;
}

/** #2021: where the fold puts what it cannot apply in place, against the RECORD (design § 10.4b, #2018's rulings).
 *  Under a placeholder today shows nothing and keeps the records at a granularity `unusedDiverge` cannot pair, so this
 *  side is checked against the rules instead:
 *  - every user-added node the record states is placed exactly ONCE, in anchors or unused, never neither and never
 *    both: AT a placeholder it hangs from it, INSIDE a placeholder's frame it is `unresolved`, on a projected member it
 *    is anchored there, on any other member it is `heldNode` (B′). A node is one guid, whatever states it: a list
 *    row's `own` link, its content in `held.heldOwn`, or a scene-owned (keyless) node in a held legacy form — § 10.4b:
 *    AT a placeholder it shows "in every file form" (#2025, judged since #2030):
 *    - a held member row's `added` or `own`, at that row;
 *    - the entry-level legacy `added` under a MISSING ROOT: AT it (`/`) when the entry states the root's localId, the
 *      node names it, and the `/` row states no whole `added` list (which replaces it once the document returns);
 *      otherwise it waits, `unresolved` (hub ruling Q3: no localId is guessed, rule 5). Read from the owner AS STORED
 *      (`ctx.owner`), with the `/` row's forms: the parse moves what it links, so it cannot judge its own linking;
 *    - a `nestedStructure` slot's `added` whose path stops at a MISSING nested document: it waits `unresolved`, keyed at
 *      that placeholder row (hub ruling Q4: AT and INSIDE cannot be told apart without the document), or `heldNode`
 *      there when a removal cut that row;
 *  - every list record at or inside a placeholder is unused `unresolved`, part by part (U9; rule 9), except a `removed`
 *    AT a nested one, which applies;
 *  - every held legacy statement of a member row under a placeholder, and every held statement when the instance's own
 *    prefab is missing, is reported, and only as `unresolved`.
 *  The fold reports only placeholders no removal cut: a cut one goes with its member (`foldInstance`'s cascade), and
 *  what is at or inside it is under the instance's own removal, so its links are `heldNode` and its other records are
 *  inert (hub, 2026-10-02, #2021: the cut dominates the placeholder; rule 3).
 *  Not judged: a guid stated more than once (a duplicate identifier: #1937 owns what it means; counted); a held node in
 *  the entry-level `added` while the root's document LOADS, or with no `ctx.owner`, and in a slot that resolves, names
 *  no reference row, or has no `ctx.read` (no ruling places those; counted) — each must still be placed exactly once; a
 *  nested-channel statement under a missing NESTED prefab; and which of a held statement's parts the fold reports — a
 *  statement needs one record besides its nodes, so one losing some of its fields passes. */
export function placementDiverge(fold: FoldedInstance, rec: InstanceRecord, ctx: PlacementContext = {}): string[] {
  const out: string[] = [];
  const phs = [...fold.placeholders.keys()];
  const atPh = (key: string) => phs.includes(key);
  const underPh = (key: string) => phs.some((k) => under(key, k));
  const allowedAt = (key: string): string => (atPh(key) ? `anchor ${key}` : underPh(key) ? `unused ${key} unresolved` : fold.nodes.has(key) ? `anchor ${key}` : `unused ${key} heldNode`);
  const pending = (rec.held.pendingLegacy ?? {}) as Bag;
  const pathOf = (path: readonly string[]) => path.join('\u0000');

  // The user-added nodes the record states: guid → each statement's anchor key and where the rules put it.
  const stated = new Map<string, { key: string; want: string }[]>();
  const state = (guid: string, key: string, want = allowedAt(key)) => stated.set(guid, [...(stated.get(guid) ?? []), { key, want }]);
  // AT a missing root (Q3), each user node of the STORED owner's root forms: the legacy `added` shows at `/` when the
  // owner states the root's localId, the node names it, and the `/` row states no whole `added` (which replaces those
  // nodes once the document returns); otherwise it waits, `unresolved` (no localId is guessed, rule 5). A `/` row's
  // `own`, and the keyless nodes of its whole `added`, show at `/`. Wherever the parse states these, they are judged here.
  const fromOwner = new Set<string>();
  if (atPh(ROOT_KEY) && ctx.owner) {
    // As the file boundary reads it: a channel no reader takes (a malformed list) is kept verbatim, stating no node.
    const o = splitMalformedChannels(ctx.owner).clean as Bag;
    const rootLid = statedRootLid(o);
    const row = o.members && typeof o.members === 'object' ? (o.members as Bag)[ROOT_KEY] as Bag | undefined : undefined;
    const rowReplaces = !!row && typeof row === 'object' && Array.isArray(row.added) && row[HELD_REMAINDER] !== true;
    const own = (list: unknown, want: (n: Bag) => string) => { for (const n of Array.isArray(list) ? list : []) if (isUserNode(n)) { state(n.guid, ROOT_KEY, want(n)); fromOwner.add(n.guid); } };
    own(o.added, (n) => { seen.heldEntryAdded++; return rootLid !== null && n.parentLocalId === rootLid && !rowReplaces ? `anchor ${ROOT_KEY}` : `unused ${ROOT_KEY} unresolved`; });
    if (row && typeof row === 'object') for (const list of ['own', 'added'] as const) own(row[list], () => `anchor ${ROOT_KEY}`);
  }
  for (const [key, r] of rec.list.rows) for (const o of r.own ?? []) {
    if (!fromOwner.has(o.guid)) state(o.guid, key);
    // The owner states it at the missing root: a link elsewhere is the parse moving it, not a second statement (which
    // would leave the guid unjudged as a duplicate).
    else if (key !== ROOT_KEY) out.push(`own link ${o.guid}: stated at ${ROOT_KEY} by the owner, linked at ${key} by the parse`);
  }
  const linked = new Set(stated.keys());
  // `heldOwn` holds a node's CONTENT; with a link of the same guid it is that link's node, not a second one.
  for (const [key, nodes] of rec.held.heldOwn ?? []) for (const n of nodes) { const g = typeof n.guid === 'string' ? n.guid : ''; if (!linked.has(g)) state(g, key); }
  /** The scene-owned (keyless) nodes of a held list, by index. */
  const nodesOf = (list: unknown): [string, string][] => (Array.isArray(list) ? list.flatMap((n, i): [string, string][] => (isUserNode(n) ? [[String(i), n.guid]] : [])) : []);
  /** A held node the rules place: the fold reports it at its legacy path, or within the held record that holds it. One
   *  the stored owner already states at a missing root is judged by that statement. */
  const nodePaths = new Map<string, string>();
  const heldNode = (path: string[], guid: string, key: string, want?: string) => { if (!(key === ROOT_KEY && fromOwner.has(guid))) state(guid, key, want); nodePaths.set(pathOf(path), guid); };
  // A node held in a form the rules do not place (counted): it is still placed exactly once, at its own path.
  const unjudged = new Map<string, string>();
  // Through a held KEYED copy (held whole, a template copy): every list the parser reads a copy's nodes from states the
  // user's nodes — a plain copy's `children`, a reference copy's `added`, its member rows' `own`/`added`, its slots'
  // `added` — at any depth (#2036). Such a node is placed exactly once, in an unused record that keeps it (`heldNode`,
  // or `unresolved` where the copy waits), by its own record or by the record of a copy holding it: the copy's key and
  // cause are the fold's to give (the copy may sit at a placeholder or name a missing prefab), so only that is judged.
  const holders = new Map<string, Set<string>>();
  const copiesIn = (list: unknown, at: string[], outer: string[] = [], depth = 0): void => {
    if (depth > 64 || !Array.isArray(list)) return;
    list.forEach((n, i) => {
      const p = [...at, String(i)];
      if (!(n && typeof n === 'object' && typeof (n as Bag).key === 'string' && (n as Bag).key)) {
        if (outer.length && isUserNode(n)) { state(n.guid, '', HELD_IN_COPY); nodePaths.set(pathOf(p), n.guid); holders.set(pathOf(p), new Set(outer)); }
        return;
      }
      const c = n as Bag, here = [...outer, pathOf(p)];
      copiesIn(c.added, [...p, 'added'], here, depth + 1);
      copiesIn(c.children, [...p, 'children'], here, depth + 1);
      for (const [o, i2] of (Array.isArray(c.own) ? c.own : []).map((x, j) => [x, j] as const)) if (isUserNode(o)) { const q = [...p, 'own', String(i2)]; state(o.guid, '', HELD_IN_COPY); nodePaths.set(pathOf(q), o.guid); holders.set(pathOf(q), new Set(here)); }
      for (const [mk, r] of Object.entries((c.members ?? {}) as Bag)) if (r && typeof r === 'object') {
        copiesIn((r as Bag).added, [...p, 'members', mk, 'added'], here, depth + 1);
        copiesIn((r as Bag).own, [...p, 'members', mk, 'own'], here, depth + 1);
      }
      for (const [sk, sl] of Object.entries((c.nestedStructure ?? {}) as Bag)) if (sl && typeof sl === 'object') copiesIn((sl as Bag).added, [...p, 'nestedStructure', sk, 'added'], here, depth + 1);
    });
  };
  // A held member row's `added` (v16) and `own` (v17): the row names its anchor.
  for (const [k, row] of Object.entries((pending.members ?? {}) as Bag)) {
    if (!row || typeof row !== 'object') continue;
    for (const list of ['added', 'own'] as const) for (const [i, g] of nodesOf((row as Bag)[list])) heldNode(['members', k, list, i], g, k);
    copiesIn((row as Bag).added, ['members', k, 'added']);
  }
  for (const [k, slot] of Object.entries((pending.nestedStructure ?? {}) as Bag)) if (slot && typeof slot === 'object') copiesIn((slot as Bag).added, ['nestedStructure', k, 'added']);
  // The entry-level legacy `added` names its anchor by the localId of a document that, under a missing root, is gone:
  // judged from the stored owner (above), else unjudged.
  for (const [i, g] of nodesOf(pending.added)) {
    const path = ['added', i];
    if (fromOwner.has(g)) heldNode(path, g, ROOT_KEY);
    else unjudged.set(pathOf(path), g);
  }
  // A `nestedStructure` slot's `added`, at the placeholder its path stops at.
  for (const [k, slot] of Object.entries((pending.nestedStructure ?? {}) as Bag)) {
    if (!slot || typeof slot !== 'object') continue;
    const ph = slotPlaceholder(rec.source, k, ctx.read);
    for (const [i, g] of nodesOf((slot as Bag).added)) {
      const path = ['nestedStructure', k, 'added', i];
      if (ph === null) { unjudged.set(pathOf(path), g); continue; }
      seen.heldSlotAdded++;
      heldNode(path, g, ph, `unused ${ph} ${underPh(ph) ? 'unresolved' : 'heldNode'}`);
    }
  }
  const unjudgedGuids = new Set(unjudged.values());
  seen.heldNodeUnjudged += unjudged.size;
  // Where the fold put each one.
  const places = new Map<string, string[]>();
  const place = (guid: string, where: string) => places.set(guid, [...(places.get(guid) ?? []), where]);
  for (const [k, refs] of fold.anchors) for (const r of refs) place(r.guid, `anchor ${k}`);
  for (const u of fold.unused) {
    if (u.part.kind === 'own') place(u.part.guid, `unused ${u.key} ${u.cause}`);
    else if (u.part.kind === 'legacy') {
      // The record AT a node's path; a held row's `own` node, also the record holding it whole: the fold splits a held
      // `added` node by node, but a row's `own` is one of its fields. Only there, or one record for a whole list would
      // place every node of it (#2030 review).
      const p = pathOf(u.part.path);
      for (const [np, g] of nodePaths) if (np === p || (np.split('\u0000')[2] === 'own' && np.startsWith(`${p}\u0000`)) || holders.get(np)?.has(p)) place(g, `unused ${u.key} ${u.cause}`);
    }
  }
  // An unjudged node is still ONE node: shown once, or held once at its own path — never neither, both or twice.
  for (const [path, guid] of unjudged) {
    if (stated.has(guid)) continue;
    const at = [...(places.get(guid) ?? []).filter((p) => p.startsWith('anchor ')), ...fold.unused.filter((u) => u.part.kind === 'legacy' && pathOf(u.part.path) === path).map((u) => `unused ${u.key} ${u.cause}`)];
    if (at.length !== 1) out.push(`held node ${guid} (${show(path.split('\u0000'))}): placed ${show(at)}`);
  }
  for (const guid of new Set([...stated.keys(), ...places.keys()])) {
    if (unjudgedGuids.has(guid) && !stated.has(guid)) continue;
    const st = stated.get(guid) ?? [];
    if (st.length > 1) { seen.ownDuplicate++; continue; }
    const got = places.get(guid) ?? [];
    const want = st[0]?.want;
    if (st.length && want !== HELD_IN_COPY) seen[atPh(st[0]!.key) ? 'ownAtPlaceholder' : underPh(st[0]!.key) ? 'ownInPlaceholder' : fold.nodes.has(st[0]!.key) ? 'ownProjected' : 'ownHeld']++;
    const ok = want === HELD_IN_COPY ? got.length === 1 && /^unused \S+ (heldNode|unresolved)$/.test(got[0]!) : got.length === 1 && got[0] === want;
    if (!ok) out.push(`own link ${guid}: stated ${show(want ? [want] : [])} placed ${show(got)}`);
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
export function checkInstance(entry: SceneEntityEntry, read: PrefabReader, rootId: number, opts: ParseOptions, copies: ReadonlySet<string> = new Set(), ownEntry?: (guid: string) => boolean): string[] {
  return checkRecord(parseInstanceRecord(entry, read, opts).record, read, rootId, copies, entry, ownEntry);
}

/** The root localId a stored owner (a scene entry, or a scene-added reference node) states, `null` when none. */
export function statedRootLid(owner: { traits?: unknown }): number | null {
  const pi = (owner.traits as Record<string, unknown> | undefined)?.PrefabInstance as { localId?: unknown } | undefined;
  return typeof pi?.localId === 'number' ? pi.localId : null;
}

/** {@link checkInstance} for a record already parsed — a scene reference node's (`parseReferenceNode`, #2009). `owner` is
 *  the entry or node as stored, which judges its root forms under a missing root; left out, the legacy `added` there
 *  stays unjudged (`placementDiverge`). `ownEntry`: see {@link translatedLive}. */
export function checkRecord(rec: InstanceRecord, read: PrefabReader, rootId: number, copies: ReadonlySet<string> = new Set(), owner?: StoredOwner, ownEntry?: (guid: string) => boolean): string[] {
  const { fold, live } = translatedLive(rec, read, rootId, copies, ownEntry);
  return [...diverge(fold, live), ...placementDiverge(fold, rec, { read, owner })];
}

/** The live tree of the instance rooted at `rootId`, with the rules' visible changes applied to it (what
 *  {@link checkRecord} compares the fold with). Exported for the frozen baseline (`foldOracleFrozen.test.ts`): at S5 the
 *  load IS fold + realize, so comparing the fold with the live tree no longer says anything about today (design
 *  § 10.4b); the translated tree of the pre-S5 load is frozen instead. `ruledKept`: the own links the rules now show
 *  where today kept a copy of the link (#2018 (i)). */
export function translatedLive(rec: InstanceRecord, read: PrefabReader, rootId: number, copies: ReadonlySet<string> = new Set(), ownEntry?: (guid: string) => boolean): { fold: FoldedInstance; live: Live; ruledKept: string[] } {
  const fold = foldInstance(read, rec);
  const live = liveTree(rootId);
  // `ownEntry`: a node the scene states as an entry of its OWN, not in this record (a live scene, `foldCheck`). It hangs
  // at a Missing Prefab placeholder once a save after the reload wrote the node the placeholder shows (#2018) where a
  // scene entity under a placeholder goes: a scene entry parented to it. Not one of this record's anchors.
  if (ownEntry) {
    for (const [k, gs] of [...live.anchors]) {
      const rest = gs.filter((g) => !ownEntry(g));
      if (rest.length) live.anchors.set(k, rest); else live.anchors.delete(k);
    }
  }
  // What today shows, anchored anywhere, before any translation moves a subtree out.
  const shownToday = new Set([...live.anchors.values()].flat());
  for (const [k, ph] of fold.placeholders) {
    if (ph.reason !== 'missing') continue;
    if (live.placeholders.has(k)) { if (copies.has(ph.source)) seen.shownB++; else if (k !== '/') seen.shownD++; continue; }
    const today = [...live.nodes.keys()].filter((n) => under(n, k));
    if (copies.has(ph.source)) seen.ruledB++;
    else if (k !== '/' && !today.length) seen.ruledD++;
    else continue;
    for (const n of today) live.nodes.delete(n);
    for (const a of [...live.anchors.keys()]) if (under(a, k)) live.anchors.delete(a);
    // A placeholder today shows INSIDE the frame (a missing nested row of it, ruling D) goes with the frame's nodes.
    for (const p of [...live.placeholders]) if (p !== k && under(p, k)) live.placeholders.delete(p);
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
  return { fold, live, ruledKept };
}

/** Numbers rounded to the oracle's tolerance (`close`), keys sorted: a value that `close` calls equal prints the same. */
const canon = (v: unknown): unknown => {
  if (typeof v === 'number') return Number.isFinite(v) ? Number(v.toPrecision(7)) : String(v);
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Bag)[k])]));
  return v;
};

/** The frozen form of one instance (design § 10.4b): its translated live tree ({@link translatedLive}), as one stable
 *  text. Equal texts mean the same nodes, parents, components and values (to `close`'s tolerance), and the same
 *  placeholders and anchors. EntityAttributes' `guid` is left out, as `diverge` leaves it out: identity is the derive's,
 *  and the S4 shadow checks it. (It held the stores the load kept for the save, too, until #2001 S8b: see
 *  `foldOracleFrozen.test.ts`.) */
export function frozenForm(t: { live: Live; ruledKept: readonly string[] }): string {
  const nodes = [...t.live.nodes.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).map((n) => {
    const traits: Bag = {};
    for (const [name, d] of Object.entries(n.traits)) {
      if (d === true) { traits[name] = true; continue; }
      const kept = { ...d };
      for (const f of IGNORED_FIELDS[name] ?? []) delete kept[f];
      traits[name] = kept;
    }
    return [n.key, n.parent, traits];
  });
  const anchors = [...t.live.anchors].map(([k, gs]) => [k, [...gs].sort()]).sort((a, b) => ((a[0] as string) < (b[0] as string) ? -1 : 1));
  return JSON.stringify(canon({ nodes, anchors, placeholders: [...t.live.placeholders].sort(), ruledKept: [...t.ruledKept].sort() }));
}
