/**
 * The FRAME CHAIN of a prefab instance: the frames its documents give, and what the template layers under an owner give
 * each frame (the chain), folded with today's fold (`prefabOverrides.ts`). The parse (`prefab/parseInstanceRecord.ts`)
 * converts an owner's statements against it, and the load asks it which of a cut row's nodes are the user's
 * (`cutRowUserLinks`, #2041), so the two cannot disagree about a pairing.
 *
 * It lives in `loaders/` because both read it: `prefab/` already depends on `loaders/`, so the load reading it from
 * `prefab/` closed a folder cycle (`loaders|prefab`, the cycle ratchet in `noNewCycles.test.ts`).
 */

import type { AddedEntity, NestedStructureDelta, SceneMemberRow } from './loadSceneFile';
import type { PrefabDoc, PrefabDocRow, PrefabReader, RowKey } from '../prefab/instanceRecord';
import { nodeRowComponent, nodeRowKey, parseSteps, preV5NodeGuid } from '../core/assetRefRules';
import { isMemberToken } from '../core/templateRefs';
import { splitMalformedChannels } from './malformedChannels';
import {
  foldRowStep, foldStructureLayers, frameKeyIndex, overRowsOf, ownRootRow,
  type ForwardState, type FrameChannels, type MemberRowChannels, type StructureLayer,
} from './prefabOverrides';

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** `prefab/instanceRecord.ts`' `ROOT_ROW_KEY`: a value import from `prefab/` would close the folder cycle. */
const ROOT_KEY: RowKey = '/';
/** A copy's `members` in no shape a reader takes. */
export const badRows = (members: unknown): boolean => isRecord(members) && Object.entries(members).some(([k, r]) => !k.startsWith('/') || !isRecord(r));

// ── Identity of a document row ──────────────────────────────────────────────────────────────────────

export { preV5NodeGuid };

/** One FRAME of an instance: the document that supplies it, and the row key of its root (`''` for the
 *  owner's own top frame, whose root is `"/"`). */
export interface Frame {
  prefix: string;
  doc: PrefabDoc;
  docGuid: string;
  byLid: Map<number, PrefabDocRow>;
  rootLid: number;
}

export function frameOf(prefix: string, doc: PrefabDoc, docGuid: string): Frame {
  const byLid = new Map<number, PrefabDocRow>();
  for (const row of doc.entities ?? []) if (typeof row?.localId === 'number') byLid.set(row.localId, row);
  return { prefix, doc, docGuid, byLid, rootLid: doc.rootLocalId ?? 1 };
}

/** The row-key component of row `lid` of `f`'s document, or null when no row has that localId. */
export function componentOf(f: Frame, lid: number): string | null {
  const row = f.byLid.get(lid);
  if (!row) return null;
  return row.nodeGuid || preV5NodeGuid(f.docGuid, lid);
}

/** The key of member `lid` of frame `f`. The frame's own root is the frame's key (a nested root is named
 *  by its reference row's key, never `/<row>/<innerRoot>`: `memberNodeId`). Null: no row has `lid`. */
export function keyOfLid(f: Frame, lid: number): RowKey | null {
  if (lid === f.rootLid) return f.prefix || ROOT_KEY;
  const c = componentOf(f, lid);
  return c === null ? null : `${f.prefix}/${c}`;
}

export type FrameRead = { frame: Frame } | { gone: true } | { unresolved: true };

/** The frame nested row `lid` of `f` expands. `gone`: no row has `lid`, or it is no reference row.
 *  `unresolved`: its document is missing or damaged. */
export function childFrame(f: Frame, lid: number, read: PrefabReader): FrameRead {
  const row = f.byLid.get(lid);
  if (!row?.prefab || lid === f.rootLid) return { gone: true };
  const got = read(row.prefab);
  if (!('doc' in got)) return { unresolved: true };
  return { frame: frameOf(`${f.prefix}/${componentOf(f, lid)!}`, got.doc, row.prefab) };
}

/** A `.`-joined localId path (`nestedOverrides` / `nestedStructure` keys, `nestedPathKey`) from frame `f`. */
export function frameAtPath(f: Frame, path: string, read: PrefabReader): FrameRead {
  let at = f;
  for (const step of parseSteps(path)) {
    if (typeof step !== 'number' || !Number.isInteger(step)) return { gone: true };
    const next = childFrame(at, step, read);
    if (!('frame' in next)) return next;
    at = next.frame;
  }
  return { frame: at };
}

// ── The chain: what the layers UNDER an owner give a frame ──────────────────────────────────────────

export type Lists = FrameChannels<AddedEntity>;
export type Layer = StructureLayer<NestedStructureDelta, MemberRowChannels<AddedEntity>>;

/** The chain at one frame: the frame's lists as the template layers alone fold them, and what those layers
 *  hand the frames below. */
export interface Chain { frame: Frame; lists: Lists; state: ForwardState<NestedStructureDelta, MemberRowChannels<AddedEntity>> }

export const topChain = (f: Frame): Chain => ({ frame: f, lists: {}, state: { layers: [{}], forwardRoots: [] } });

/** One frame down the chain, into the nested row whose row-key component is `component` (a `nodeGuid`, or
 *  `a+<key>` for a template-added reference node). The same fold today's spawner runs (`foldRowStep`, and for a
 *  reference node `spawnReferenceNode`'s layers: its own channels, then what the layers above state into it),
 *  with no layer of the owner's own: that is what makes it the CHAIN. */
export function chainStep(c: Chain, component: string, read: PrefabReader): Chain | { gone: true } | { unresolved: true } {
  const key = nodeRowKey(component);
  if (key) {
    const node = frameKeyIndex(c.lists.added as (AddedEntity & { key?: string })[] | undefined).get(key);
    if (!node?.prefab) return { gone: true };
    const got = read(node.prefab);
    if (!('doc' in got)) return { unresolved: true };
    const frame = frameOf(`${c.frame.prefix}/${component}`, got.doc, node.prefab);
    const layers: Layer[] = [
      { slots: node.nestedStructure, rows: node.members, ...ownRootRow(node.members), values: node.overrides, valuePaths: node.nestedOverrides },
      ...overRowsOf<AddedEntity>(node).map((o): Layer => ({ rows: o.rows, rootRow: o.rootRow })),
    ];
    const folded = foldStructureLayers(got.doc as never, layers, 0, { added: node.added, removed: node.removed, removedTraits: node.removedTraits });
    return { frame, lists: folded.channels, state: { layers, forwardRoots: folded.forwardRoots } };
  }
  const row = (c.frame.doc.entities ?? []).find((r) => (r.nodeGuid || (typeof r.localId === 'number' ? preV5NodeGuid(c.frame.docGuid, r.localId) : '')) === component);
  if (!row?.prefab || row.localId === c.frame.rootLid) return { gone: true };
  const got = read(row.prefab);
  if (!('doc' in got)) return { unresolved: true };
  const step = foldRowStep(row as never, c.state as never, got.doc as never);
  return {
    frame: frameOf(`${c.frame.prefix}/${component}`, got.doc, row.prefab),
    lists: step.channels as Lists,
    state: (step.forward ?? { layers: [{}], forwardRoots: [] }) as Chain['state'],
  };
}

/** The chain at the frame whose key is `prefix` (`''` = the owner's top frame). */
export function chainAt(top: Frame, prefix: string, read: PrefabReader): Chain | { gone: true } | { unresolved: true } {
  let c = topChain(top);
  for (const component of prefix.split('/').filter(Boolean)) {
    const next = chainStep(c, component, read);
    if (!('frame' in next)) return next;
    c = next;
  }
  return c;
}

/** The key a hand-written `/<row>/<innerRoot>` alias names: the nested root `/<row>` (§ 2.1), or `key` itself when it is
 *  no alias. No writer emits one; the parse reads one this way (`canonicalKey`), so every reader of a row key must. */
export function canonicalRowKey(top: Frame, key: RowKey, read: PrefabReader): RowKey {
  const comps = key.split('/').filter(Boolean);
  if (comps.length < 2 || nodeRowKey(comps[comps.length - 1]!)) return key;
  const canon = `/${comps.slice(0, -1).join('/')}`;
  const outer = chainAt(top, canon, read);
  if (!('frame' in outer) || outer.frame.prefix !== canon) return key;
  const root = outer.frame.byLid.get(outer.frame.rootLid);
  return root && (root.nodeGuid || preV5NodeGuid(outer.frame.docGuid, outer.frame.rootLid)) === comps[comps.length - 1] ? canon : key;
}

/** The frame a row key's TARGET belongs to (its chain) and the target's localId there; null for a template-added node
 *  (`a+key`) or a key that names nothing. A nested row names its frame's ROOT. */
export function rowTarget(ctx: { top: Frame; read: PrefabReader }, key: RowKey): { chain: Chain; lid: number | null } | null {
  const comps = key.split('/').filter(Boolean);
  if (!comps.length) { const c = topChain(ctx.top); return { chain: c, lid: ctx.top.rootLid }; }
  const last = comps[comps.length - 1]!;
  const outer = chainAt(ctx.top, comps.length > 1 ? `/${comps.slice(0, -1).join('/')}` : '', ctx.read);
  if (!('frame' in outer)) return null;
  if (nodeRowKey(last)) return { chain: outer, lid: null };
  const row = rowOfComponent(outer.frame, last);
  if (!row || typeof row.localId !== 'number') return null;
  if (!row.prefab) return { chain: outer, lid: row.localId };
  const inner = chainStep(outer, last, ctx.read);
  if (!('frame' in inner)) return null;
  return { chain: inner, lid: inner.frame.rootLid };
}


export function rowOfComponent(f: Frame, component: string): PrefabDocRow | undefined {
  for (const [lid, row] of f.byLid) if ((row.nodeGuid || preV5NodeGuid(f.docGuid, lid)) === component) return row;
  return undefined;
}


/** The user's own nodes stored row `row` at `key` states (#2041), each at the key this parse links it at, for the load to
 *  keep when the instance's OWN removal cuts the row (§ 10.4b: under that cut a user node is held, never dropped). Null
 *  when the row states none.
 *
 *  The row's `own`, and each node of its legacy `added` that `pinAdded` links as `own` rather than pairs with a template
 *  node — a keyless one, and a keyed one no template node anchored at the row's member pairs with — stay on the row: a
 *  keyless one in `added`, as before, and a keyed one in `own`. Under a NODE row every node of `added` is the node's own
 *  list (`wholeAdded`). A keyed one
 *  that DOES pair is a copy of the template's node, which the cut takes; the user's nodes INSIDE it are lifted onto the
 *  key the parse links them at, the node-row form #2038 keeps: a plain copy's unpaired children onto `<frame>/a+<key>`
 *  (paired children recursively, by `pinAdded`'s own pairing), a reference copy's member rows' nodes onto those rows
 *  below the copy's frame, and its keyless `added` onto the member it anchors at. A reference copy carrying any other
 *  node of the user's — one the parse would hold the copy whole for, or one this does not place — is kept whole on the
 *  row, as the parse holds it: kept is never lost. */
export function cutRowUserLinks(source: string, key: RowKey, row: SceneMemberRow, read: PrefabReader): Record<RowKey, SceneMemberRow> | null {
  const out = new Map<RowKey, { own: AddedEntity[]; added: AddedEntity[] }>();
  const at = (k: RowKey, into: typeof out = out) => { let e = into.get(k); if (!e) into.set(k, e = { own: [], added: [] }); return e; };
  if (Array.isArray(row.own) && row.own.length) at(key).own.push(...row.own);
  const list = Array.isArray(row.added) ? row.added : [];
  const got = list.length ? read(source) : null;
  const target = got && 'doc' in got ? rowTarget({ top: frameOf('', got.doc, source), read }, key) : null;
  const keyOf = (n: unknown): string => (isRecord(n) && typeof n.key === 'string' ? n.key : '');
  // A keyed node the parse links as the user's goes in `own`, the list it is linked in: left in `added`, every reader of a
  // cut row would take it for a template node's copy, which is what a key says there.
  const user = (n: AddedEntity): void => { (keyOf(n) ? at(key).own : at(key).added).push(n); };
  if (!target) at(key).added.push(...list); // a frame this cannot read: the whole list, as before
  else if (target.lid === null) list.forEach(user); // a node row's list is the node's own (`wholeAdded`)
  else {
    const lower = (target.chain.lists.added ?? []) as AddedEntity[];
    const index = frameKeyIndex(lower as (AddedEntity & { key?: string })[]);
    const pairs = (n: AddedEntity, candidates: readonly AddedEntity[]): AddedEntity | null => {
      const hit = keyOf(n) ? index.get(keyOf(n)) : undefined;
      return hit && candidates.includes(hit) && (hit.prefab ?? '') === (n.prefab ?? '') ? hit : null;
    };
    const prefix = target.chain.frame.prefix;
    // Into `into`, the user's nodes inside copy `node` of `hit`; false when a reference copy carries one this cannot place.
    const lift = (node: AddedEntity, hit: AddedEntity, into: typeof out, depth = 0): boolean => {
      const nodeKey = `${prefix}/${nodeRowComponent(keyOf(node))}`;
      if (hit.prefab) return referenceCopyLinks(node, nodeKey, target.chain, read, (k) => at(k, into));
      for (const child of node.children ?? []) {
        const childHit = depth < 64 && isRecord(child) ? pairs(child, hit.children ?? []) : null;
        if (!childHit) at(nodeKey, into).own.push(child);
        else if (!lift(child, childHit, into, depth + 1)) return false;
      }
      return true;
    };
    const replaced = lower.filter((n) => n.parentLocalId === target.lid);
    for (const node of list) {
      const hit = isRecord(node) ? pairs(node, replaced) : null;
      const lifted: typeof out = new Map();
      if (!hit) user(node);
      else if (!lift(node, hit, lifted)) at(key).added.push(node);
      else for (const [k, e] of lifted) { at(k).own.push(...e.own); at(k).added.push(...e.added); }
    }
  }
  const rows = [...out].filter(([, e]) => e.own.length || e.added.length);
  return rows.length ? Object.fromEntries(rows.map(([k, e]) => [k, { ...(e.own.length ? { own: e.own } : {}), ...(e.added.length ? { added: e.added } : {}) }])) : null;
}

/** {@link cutRowUserLinks} for a paired REFERENCE copy whose node row is `nodeKey`: its member rows' `own` and keyless
 *  `added` onto `<nodeKey><row>`, and its keyless `added` onto the member of the copy's frame it anchors at. False — keep
 *  the copy whole — when the parse would hold it whole (its frame unreadable, a `templateMoved`, a malformed channel, a
 *  member-token parent), or it carries a node of the user's this does not place: a keyed node in its lists (a copy whose
 *  pairing is the copy's own structure), a `nestedStructure` slot's, or a `children` entry. A keyless `added` node a
 *  member row's whole `added` replaces is linked by nothing (`copySession`), so it is not lifted either. */
function referenceCopyLinks(
  node: AddedEntity, nodeKey: RowKey, chain: Chain, read: PrefabReader, at: (k: RowKey) => { own: AddedEntity[] },
): boolean {
  const sub = chainStep(chain, nodeKey.slice(nodeKey.lastIndexOf('/') + 1), read);
  if (!('frame' in sub)) return false;
  if (isRecord(node.templateMoved) && Object.keys(node.templateMoved).length) return false;
  if (splitMalformedChannels(node).malformed.length || badRows(node.members)) return false;
  const rows = Object.entries(isRecord(node.members) ? node.members : {}) as [string, SceneMemberRow][];
  if (rows.some(([, r]) => typeof r.parent === 'string' && isMemberToken(r.parent))) return false;
  const keyed = (l: unknown): boolean => Array.isArray(l) && l.some((n) => isRecord(n) && typeof n.key === 'string' && !!n.key);
  if (keyed(node.added) || rows.some(([, r]) => keyed(r.added) || keyed(r.own))) return false;
  if (Array.isArray(node.children) && node.children.length) return false;
  if (Object.values(isRecord(node.nestedStructure) ? node.nestedStructure : {}).some((s) => isRecord(s) && Array.isArray(s.added) && s.added.length)) return false;
  const lifted: Array<[RowKey, AddedEntity[]]> = [];
  for (const [k, r] of rows) {
    const nodes = [...(Array.isArray(r.added) ? r.added : []), ...(Array.isArray(r.own) ? r.own : [])];
    if (nodes.length) lifted.push([`${nodeKey}${k}`, nodes]);
  }
  for (const n of Array.isArray(node.added) ? node.added : []) {
    const anchor = keyOfLid(sub.frame, n.parentLocalId);
    if (anchor === null) return false;
    const rel = anchor.slice(nodeKey.length);
    // Replaced by that member row's whole list: today spawns the row's list, not this node.
    if (rel && rows.some(([k, r]) => k === rel && Array.isArray(r.added))) continue;
    lifted.push([anchor, [n]]);
  }
  for (const [k, nodes] of lifted) at(k).own.push(...nodes);
  return true;
}

