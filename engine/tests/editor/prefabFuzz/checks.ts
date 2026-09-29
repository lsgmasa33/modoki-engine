/** The prefab fuzzer's checks (#1789): the invariants of docs/prefabs.md § "Model and invariants" that can be read off
 *  a world and its files, plus the round-trip and undo identities.
 *
 *  Each check has a stable id. A failure's SIGNATURE is its id plus a detail class with the run's guids and numbers
 *  stripped, so the shrinker only keeps a smaller list that fails the SAME way, never one that slides onto another bug. */

import { getAllEntities } from '@modoki/engine/runtime';
import { isRuntimeGuid } from '../../../packages/modoki/src/runtime/core/assetRefRules';
import { validatePrefabData, validateSceneData } from '../../../packages/modoki/src/runtime/loaders/sceneValidation';
import { buildSceneSchema } from '../../../packages/modoki/src/runtime/scene/sceneSchema';
import { assertNoRuntimeGuids } from '../../../packages/modoki/src/editor/scene/runtimeGuidTripwire';
import { PREFAB_FORMAT_VERSION } from '../../../packages/modoki/src/runtime/core/version';
import { getCachedPrefabSync } from '../../../packages/modoki/src/editor/scene/prefabCache';
import { findEntity } from '@modoki/engine/runtime';
import { unresolvedRefOf, UnresolvedPrefabRef } from '../../../packages/modoki/src/runtime/core/unresolvedPrefabRef';
import { piOf } from './harness';
import { sameOrientation } from '../../../packages/modoki/src/runtime/scene/transformSpace';

/** `console`: every console.error line the end walk logged, allowlisted or not, when the walk's identity check fails —
 *  the line that names the mechanism (a refusal's full text, a "not tagging" reason) is often there, not in `detail`. */
export interface Failure {
  check: string; detail: string; console?: string[];
  /** The guids each drop, paste, detach and Create Prefab of the run introduced or covered, so a stop can ask whether
   *  the entity a failure is on is the one its mechanism's op touched (set by the runner on every failure). */
  touched?: { drop: string[]; paste: string[]; detach: string[]; create: string[] };
  /** For a scene diff that names a node gone from (or new to) one place: whether that node is still on the other side
   *  somewhere else — MOVED (a respawn under the wrong parent) rather than lost or replaced (a guid regression). */
  moved?: boolean;
}

/** Whether the node a diff names as gone (`X vs undefined`) is still in `b`, or as new (`undefined vs X`) was in `a`. */
export function nodeMoved(d: string, a: unknown, b: unknown): boolean {
  const m = /: (.*) vs (.*)$/.exec(d);
  if (!m) return false;
  const [, left, right] = m;
  // A top-level entry names itself in the path (`/entities/<guid>: …`); a node names itself first in its value.
  const side = /^\/entities\/[0-9a-f]{8}-[0-9a-f-]{27}:/.test(d) ? d : right === 'undefined' ? left : left === 'undefined' ? right : '';
  if (right !== 'undefined' && left !== 'undefined') return false;
  const g = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{0,12}/.exec(side)?.[0];
  if (!g || g.length < 20) return false;
  // As an identity (a node's or an entry's own `guid`), not anywhere: a child's parentId or a member's rootInstanceId
  // still naming a LOST node does not make it moved (review).
  return JSON.stringify(right === 'undefined' ? b : a).includes(`"guid":"${g}`);
}

/** The failure's class: the check id and its detail's LOCATION (the part before the first ": ", which for a diff is the
 *  path where the two sides part), with guids, hex runs, paths and numbers reduced to placeholders. The values are left
 *  out: they carry run-specific guids, often truncated, and would make one bug look like many. */
export function signature(f: Failure): string {
  const where = f.detail.split(': ')[0];
  const cls = where
    // An absolute path (a route's message names the scratch file) and the per-run folder first: they differ on every
    // replay, and a signature that carries them can never match, so the shrinker could not shrink (review).
    .replace(/(?:\/[^\s'",)]*)?\/fuzz\/[^\s'",)]+/g, 'PATH')
    // Either OS's form: on Windows the route names `E:\…\modoki-prefab-fuzz-x\r…\H.prefab.json` (#1840).
    .replace(/(?:[A-Za-z]:)?[\\/][^\s'",)]*modoki-prefab-fuzz-[^\s'",)]*/g, 'PATH')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, 'G')
    .replace(/\b[0-9a-f]*\d[0-9a-f]*\b/gi, 'N')
    .slice(0, 100);
  return `${f.check}: ${cls}`;
}

// ── The world ────────────────────────────────────────────────────────────────────────────────────────────────────

/** I7: no two authored entities on one guid. I6: every member names a live frame root of its own source. I18: a
 *  missing-prefab placeholder still carries its record. */
export function checkWorld(): Failure[] {
  const out: Failure[] = [];
  const all = getAllEntities().filter((e) => !e.isResource);
  const byGuid = new Map<string, string[]>();
  for (const e of all) {
    if (!e.guid || isRuntimeGuid(e.guid)) continue;
    byGuid.set(e.guid, [...(byGuid.get(e.guid) ?? []), e.name]);
  }
  // Where the holders hang tells two mechanisms apart: under one top-level root (a collision inside one instance, #1777's
  // shape) or under different ones (an entity moved out of the instance, #1792's).
  const parentOf = new Map(all.map((e) => [e.id, e.parentId]));
  const top = (id: number) => { let cur = id; for (let i = 0; i < 1000 && parentOf.get(cur); i++) cur = parentOf.get(cur)!; return cur; };
  const holders = new Map<string, number[]>();
  for (const e of all) if (e.guid && !isRuntimeGuid(e.guid)) holders.set(e.guid, [...(holders.get(e.guid) ?? []), e.id]);
  // …and whether they are rows of one frame (#1777's shape: a pin colliding with a derivation inside one instance) or
  // not (#1792's: an entity that left its row, by any route, beside the row respawned).
  // A frame is named by its root's ENTITY, not its guid: the duplicated guid may be the frame root's own (#1792's promote
  // route duplicates the nested root and its members), and two frames would then read as one.
  const frameOf = (id: number) => { const pi = piOf(id); return pi ? `${pi.source}@${pi.rootInstanceId}` : 'plain'; };
  for (const [guid, names] of byGuid) {
    if (names.length < 2) continue;
    const ids = holders.get(guid) ?? [];
    const tops = new Set(ids.map(top));
    const frames = new Set(ids.map(frameOf));
    out.push({ check: 'I7 duplicate guid', detail: `${guid} held by ${names.join(', ')} (under ${tops.size === 1 ? 'one top-level root' : 'different top-level roots'}; ${frames.size === 1 && !frames.has('plain') ? 'rows of one frame' : 'not rows of one frame'})` });
  }

  const ids = new Set(all.map((e) => e.id));
  for (const e of all) {
    const pi = piOf(e.id);
    if (!pi) continue;
    if (!pi.source) { out.push({ check: 'I6 member without source', detail: e.name }); continue; }
    if (pi.rootInstanceId === e.id) continue;
    const root = pi.rootInstanceId && ids.has(pi.rootInstanceId) ? piOf(pi.rootInstanceId) : undefined;
    if (!root) out.push({ check: 'I6 member names no live root', detail: `${e.name} → ${pi.rootInstanceId}` });
    else if (root.rootInstanceId !== pi.rootInstanceId) out.push({ check: 'I6 member root is not a frame root', detail: e.name });
    else if (root.source !== pi.source) out.push({ check: 'I6 member source differs from its root', detail: `${e.name}: ${pi.source} vs ${root.source}` });
  }

  // The marker is not a registered trait, so it is read off each entity, not out of `e.traits`.
  for (const e of all) {
    const ent = findEntity(e.id);
    if (!ent || !(ent as { has?: (t: unknown) => boolean }).has?.(UnresolvedPrefabRef)) continue;
    const rec = unresolvedRefOf(ent as never);
    if (!rec || !rec.source || !rec.record || typeof rec.record !== 'object') out.push({ check: 'I18 placeholder without its record', detail: e.name });
  }
  return out;
}

// ── The files ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Per run: every (prefab id, localId) → the nodeGuid it was first seen with, across every version of every file. */
export type LocalIdHistory = Map<string, string>;

interface Row { localId?: number; nodeGuid?: string; prefab?: string; added?: AddedNode[] }
interface AddedNode { prefab?: string; children?: AddedNode[] }
interface Doc { id?: string; version?: number; nextLocalId?: number; entities?: Row[] }

/** Drop the history of the document `text` holds, so the next `checkFiles` re-seeds it from those bytes. */
export function forgetHistoryOf(history: LocalIdHistory, text: string): void {
  let id: string | undefined;
  try { id = (JSON.parse(text) as Doc).id; } catch { return; }
  if (!id) return;
  for (const k of [...history.keys()]) if (k.startsWith(`${id}:`)) history.delete(k);
}

/** For every file but a hand-edited one: I8 (no runtime guid in a template), I15 (a file this run wrote is at the writer's version), I16 (no template
 *  contains itself), I4 (a localId is never re-bound to another node, #1774; the mark covers every number), plus the
 *  validator. `written` names the files the run has changed, which I15 holds to the current version. */
export function checkFiles(
  files: Map<string, string>, history: LocalIdHistory, written: ReadonlySet<string>, handEdited: ReadonlySet<string> = new Set(),
): Failure[] {
  const out: Failure[] = [];
  const docs = new Map<string, Doc>();
  for (const [path, text] of files) {
    if (!path.endsWith('.prefab.json')) continue;
    let doc: Doc;
    try { doc = JSON.parse(text) as Doc; } catch (e) { out.push({ check: 'prefab file unparseable', detail: `${path}: ${String(e)}` }); continue; }
    if (doc.id) docs.set(doc.id, doc);
    // A file whose current bytes an outside edit wrote is held to nothing but the cycle check: what it says is the hand
    // edit's, and the editor's next write of it is what these rules bind.
    if (handEdited.has(path)) continue;
    for (const w of validatePrefabData(doc).warnings) out.push({ check: 'prefab validator', detail: `${path}: ${w}` });
    try { assertNoRuntimeGuids(doc, path); } catch (e) { out.push({ check: 'I8 runtime guid in a template', detail: String((e as Error).message).split('\n')[0] }); }
    if (written.has(path) && doc.version !== PREFAB_FORMAT_VERSION) out.push({ check: 'I15 written at an old version', detail: `${path}: v${doc.version}` });
    const rows = doc.entities ?? [];
    const nodeGuids = new Set<string>();
    let max = 0;
    for (const r of rows) {
      if (typeof r.localId === 'number') max = Math.max(max, r.localId);
      if (r.nodeGuid) {
        if (nodeGuids.has(r.nodeGuid)) out.push({ check: 'I5 two rows on one nodeGuid', detail: `${path}: ${r.nodeGuid}` });
        nodeGuids.add(r.nodeGuid);
      }
      if (doc.id && typeof r.localId === 'number' && r.nodeGuid) {
        const key = `${doc.id}:${r.localId}`;
        const was = history.get(key);
        if (was === undefined) history.set(key, r.nodeGuid);
        else if (was !== r.nodeGuid) out.push({ check: 'I4 localId re-bound to another node', detail: `${path}: localId ${r.localId} ${was} → ${r.nodeGuid}` });
      }
    }
    if ((doc.version ?? 0) >= 8 && !(typeof doc.nextLocalId === 'number' && doc.nextLocalId > max)) {
      out.push({ check: 'I4 high-water mark below a localId', detail: `${path}: nextLocalId ${doc.nextLocalId} max ${max}` });
    }
  }
  // I16: no cycle through reference rows and added reference nodes.
  const refsOf = (d: Doc): string[] => {
    const refs: string[] = [];
    const walk = (n: AddedNode) => { if (n.prefab) refs.push(n.prefab); for (const c of n.children ?? []) walk(c); };
    for (const r of d.entities ?? []) { if (r.prefab) refs.push(r.prefab); for (const a of r.added ?? []) walk(a); }
    return refs;
  };
  const state = new Map<string, 'open' | 'done'>();
  const visit = (id: string, trail: string[]): void => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'open') { out.push({ check: 'I16 a template contains itself', detail: [...trail, id].join(' → ') }); return; }
    state.set(id, 'open');
    const d = docs.get(id);
    if (d) for (const r of refsOf(d)) visit(r, [...trail, id]);
    state.set(id, 'done');
  };
  for (const id of docs.keys()) visit(id, []);
  return out;
}

/** The serialized scene passes the scene validator (schema, refs, member rows). */
export function checkScene(scene: unknown): Failure[] {
  const r = validateSceneData(scene, buildSceneSchema(), (ref) => getCachedPrefabSync(ref) ?? undefined);
  return r.warnings.map((w) => ({ check: 'scene validator', detail: w }));
}

// ── Identities ──────────────────────────────────────────────────────────────────────────────────────────────────

const NODE_LISTS = new Set(['added', 'children', 'own']);

/** The first place two JSON-like values differ, as a path, or null. */
export function firstDiff(a: unknown, b: unknown, path = ''): string | null {
  if (a === b) return null;
  // A node list (own / added / children) is matched by each node's identity, not by index: compared by index, one
  // missing node reads as whichever node shifted into its slot, and the diff names the wrong node (a stop keyed on
  // WHICH node moved could not see it). Order is compared last, only once every node matches.
  // A scene's top-level `entities` likewise, by each entry's guid (an instance entry's own, a plain one's
  // EntityAttributes.guid), and the entity is named in the path: by index, a lost plain entry read as the next entry
  // having shifted into its slot (review: a dropped instance beside it then looked "moved", and #1793 claimed the loss).
  if (Array.isArray(a) && Array.isArray(b) && path === '/entities') {
    const id = (x: unknown) => { const o = x as { guid?: string; traits?: { EntityAttributes?: { guid?: string } } } | null; return o?.guid || o?.traits?.EntityAttributes?.guid || ''; };
    const ia = a.map(id); const ib = b.map(id);
    if (ia.every(Boolean) && ib.every(Boolean) && new Set(ia).size === ia.length && new Set(ib).size === ib.length) {
      const gone = ia.findIndex((k) => !ib.includes(k));
      if (gone >= 0) return `${path}/${ia[gone]}: ${JSON.stringify(a[gone])?.slice(0, 60)} vs undefined`;
      const extra = ib.findIndex((k) => !ia.includes(k));
      if (extra >= 0) return `${path}/${ib[extra]}: undefined vs ${JSON.stringify(b[extra])?.slice(0, 60)}`;
      for (let i = 0; i < a.length; i++) {
        const d = firstDiff(a[i], b[ib.indexOf(ia[i])], `${path}/${ia[i]}`);
        if (d) return d;
      }
      return ia.join() === ib.join() ? null : `${path}: order of ${ia.length} entries differs`;
    }
  }
  if (Array.isArray(a) && Array.isArray(b) && NODE_LISTS.has(path.slice(path.lastIndexOf('/') + 1))) {
    const id = (x: unknown) => { const o = x as { guid?: string; key?: string } | null; return `${o?.guid ?? ''}|${o?.key ?? ''}`; };
    const ia = a.map(id); const ib = b.map(id);
    if (new Set(ia).size === ia.length && new Set(ib).size === ib.length) {
      const gone = ia.findIndex((k) => !ib.includes(k));
      if (gone >= 0) return `${path}: ${JSON.stringify(a[gone])?.slice(0, 60)} vs undefined`;
      const extra = ib.findIndex((k) => !ia.includes(k));
      if (extra >= 0) return `${path}: undefined vs ${JSON.stringify(b[extra])?.slice(0, 60)}`;
      for (let i = 0; i < a.length; i++) {
        const d = firstDiff(a[i], b[ib.indexOf(ia[i])], `${path}/${i}`);
        if (d) return d;
      }
      return ia.join() === ib.join() ? null : `${path}: order ${ia.length} nodes differ`;
    }
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    if (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-6) return null;
    return `${path || '<root>'}: ${JSON.stringify(a)?.slice(0, 60)} vs ${JSON.stringify(b)?.slice(0, 60)}`;
  }
  const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
  for (const k of [...keys].sort()) {
    const d = firstDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}/${k}`);
    if (d) return d;
  }
  return null;
}

/** A serialized scene made comparable: a placeholder entry's `PrefabInstance.localId`/`nodeGuid` dropped (its record's
 *  FORM follows where it sits, and both fields re-derive once the prefab is back, unresolvedPrefabRefs.ts
 *  `asSceneEntry`). */
export function canonScene(scene: unknown, placeholders: ReadonlySet<string>): unknown {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (!v || typeof v !== 'object') return v;
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = walk(x);
    const guid = typeof o.guid === 'string' ? o.guid : undefined;
    const pi = (o.traits as { PrefabInstance?: Record<string, unknown> } | undefined)?.PrefabInstance;
    if (guid && placeholders.has(guid) && pi) { delete pi.localId; delete pi.nodeGuid; }
    return o;
  };
  return walk(scene);
}

/** Save → reload is the identity, and save → reload → save writes the same bytes.
 *
 *  When the run deleted a prefab (`restored` is set, #1805), the identity is measured against the save reloaded WITH the
 *  deleted prefabs put back: the live instance of a deleted prefab stays expanded while a plain reload gives its Missing
 *  Prefab placeholder (Unity does the same), so the two cannot be equal, and what must hold is that the save lost nothing
 *  the live world holds. The byte check still runs on the plain reload's save, so the placeholder must write its record
 *  back byte for byte. */
/** `after`, with each entity's rotation spelled as in `before` wherever the two are the SAME orientation (#1838). A
 *  rotation is one value, not three fields (#1490's `sameOrientation`): the save drops a member's rotation whose
 *  orientation equals the chain's, and the reload gives the chain's spelling (`rx: 0.283…` comes back `-6`, the same turn
 *  less 2π). Only the spelling is forgiven — a different orientation is left as it is, and still differs — up to
 *  `sameOrientation`'s own tolerance (`1 - |q·q'| <= 1e-9`, about 1e-4 rad): a smaller real change is forgiven here, and
 *  is left to the save→reload→save byte check, which compares the numbers the file holds. */
export function alignEqualOrientations(before: unknown, after: unknown): unknown {
  type Tf = { rx?: number; ry?: number; rz?: number };
  const tfOf = (e: unknown) => (e as { traits?: { Transform?: Tf } } | undefined)?.traits?.Transform;
  const b = before as Record<string, unknown>;
  const a = after as Record<string, unknown>;
  if (!b || !a || typeof b !== 'object' || typeof a !== 'object') return after;
  let out: Record<string, unknown> | null = null;
  for (const k of Object.keys(a)) {
    const tb = tfOf(b[k]); const ta = tfOf(a[k]);
    if (!tb || !ta) continue;
    const rot = (t: Tf) => ({ rx: t.rx ?? 0, ry: t.ry ?? 0, rz: t.rz ?? 0 });
    const [rb, ra] = [rot(tb), rot(ta)];
    if ((rb.rx === ra.rx && rb.ry === ra.ry && rb.rz === ra.rz) || !sameOrientation(rb, ra)) continue;
    const e = a[k] as { traits: { Transform: Tf } & Record<string, unknown> } & Record<string, unknown>;
    const tf: Tf & Record<string, unknown> = { ...e.traits.Transform };
    for (const f of ['rx', 'ry', 'rz'] as const) { if (f in tb) tf[f] = tb[f]; else delete tf[f]; }
    out ??= { ...a };
    out[k] = { ...e, traits: { ...e.traits, Transform: tf } };
  }
  return out ?? after;
}

/** `restored` made comparable with a live world that holds UNEXPANDED frames of a deleted prefab beside kept ones
 *  (#1831 G1 M1). The restored reload expands every frame, and it is what the editor itself shows once the file is back
 *  (an OS-Trash restore reloads the open scene; an asset delete has no undo since #1868). So a frame the
 *  live world could not expand may come back expanded, and only that frame:
 *  - an unexpanded row (`unexpanded`, keyed `<frame root guid>:<localId>`, read before the save): a gained frame root of a
 *    deleted prefab whose outer frame recorded its row as unexpanded, with everything gained under it, is dropped;
 *  - a Missing Prefab placeholder of a deleted prefab: it comes back an instance root of that prefab under the same guid,
 *    its gained members are dropped, and it is compared by its placement (name, parent, order, active) as the live
 *    placeholder shows it. The record's CONTENT is held by the second save's byte identity.
 *  Everything else must still be identical. */
export function forgiveExpandedFrames(
  before: unknown, restored: unknown, unexpanded: ReadonlySet<string>, prefabGone: (source: string) => boolean,
): unknown {
  type Node = { traits?: { EntityAttributes?: Record<string, unknown>; PrefabInstance?: { source?: string; rootInstanceId?: unknown; parentLocalId?: number } }; unresolved?: string };
  const b = before as Record<string, Node>;
  const r = restored as Record<string, Node>;
  if (!b || !r || typeof b !== 'object' || typeof r !== 'object') return restored;
  const parentOf = (k: string) => { const p = r[k]?.traits?.EntityAttributes?.parentId; return typeof p === 'string' ? p : undefined; };
  const placeholderOfGone = (k: string) => !!b[k]?.unresolved && prefabGone(b[k].unresolved!);
  const expandedRoot = (k: string): boolean => {
    const pi = r[k]?.traits?.PrefabInstance;
    if (!pi?.source || pi.rootInstanceId !== k || !prefabGone(pi.source)) return false;
    if (k in b) return placeholderOfGone(k) && b[k].unresolved === pi.source;
    const parent = parentOf(k);
    const outer = parent ? r[parent]?.traits?.PrefabInstance?.rootInstanceId : undefined;
    return typeof outer === 'string' && unexpanded.has(`${outer}:${pi.parentLocalId}`);
  };
  const out: Record<string, Node> = { ...r };
  for (const k of Object.keys(r)) {
    if (k in b) continue;
    // Up through the gained entities to the first one whose parent the live world holds.
    let top = k;
    for (let hops = 0, p = parentOf(top); p && !(p in b) && p in r && hops < 256; hops++, p = parentOf(top)) top = p;
    const boundary = parentOf(top);
    if (expandedRoot(top) || (boundary && expandedRoot(boundary))) delete out[k];
  }
  const PLACEMENT = ['name', 'parentId', 'sortOrder', 'isActive'] as const;
  for (const k of Object.keys(b)) {
    if (!placeholderOfGone(k) || !expandedRoot(k)) continue;
    const ea = (n: Node) => n.traits?.EntityAttributes ?? {};
    if (PLACEMENT.every((f) => JSON.stringify(ea(b[k])[f]) === JSON.stringify(ea(r[k])[f]))) out[k] = b[k];
  }
  return out;
}

export function checkRoundTrip(
  rt: { before: unknown; after: unknown; firstBytes: string; secondBytes: string; restored?: unknown; unexpanded?: ReadonlySet<string> },
  prefabGone: (source: string) => boolean = () => false,
): Failure[] {
  const out: Failure[] = [];
  // Either comparison may hold, and the run fails only when NEITHER does. The plain one holds when the live world already
  // shows the deleted prefab's instances as the reload does (a world swap after the delete made them placeholders, or they
  // never expanded); the restored one holds when the live instance is still expanded and the save carried all of it. The
  // restored one alone would fail a correct run whose live world holds a frame the delete left unexpanded: restored, it
  // expands. Reported through the restored comparison, the stricter one for the case it exists for.
  const restoring = rt.restored !== undefined && firstDiff(rt.before, alignEqualOrientations(rt.before, rt.after)) !== null;
  const reloaded = alignEqualOrientations(rt.before, restoring ? forgiveExpandedFrames(rt.before, rt.restored, rt.unexpanded ?? new Set(), prefabGone) : rt.after);
  const d = firstDiff(rt.before, reloaded);
  if (d) {
    // Whether a whole entity went missing, and if so whether one with its name took a NEW guid on the other side (a guid
    // that changed across the reload) or nothing did (lost, or gained): the KNOWN_OPEN predicates key on it.
    const before = rt.before as Record<string, { traits?: { EntityAttributes?: { name?: string } } }>;
    const after = reloaded as Record<string, { traits?: { EntityAttributes?: { name?: string } } }>;
    const nameOf = (e: { traits?: { EntityAttributes?: { name?: string } } } | undefined) => e?.traits?.EntityAttributes?.name;
    const onlyIn = (a: typeof before, b: typeof before) => Object.keys(a).filter((k) => !(k in b));
    const lost = onlyIn(before, after); const gained = onlyIn(after, before);
    const renamed = lost.some((k) => gained.some((g) => nameOf(after[g]) === nameOf(before[k])));
    // Or whether the entity the difference is on was an instance live and came back a Missing Prefab placeholder: its
    // first difference is then whatever sorts first (often a mark), which says nothing about why.
    const g = d.split('/')[1] ?? '';
    const placeholderSource = (after[g] as { unresolved?: string } | undefined)?.unresolved;
    const becamePlaceholder = !(before[g] as { unresolved?: string } | undefined)?.unresolved && !!placeholderSource;
    // A lost entity that is, or sits under, an instance of a prefab whose file is gone (#1805's shape, not any loss).
    type Node = { traits?: { EntityAttributes?: { parentId?: unknown }; PrefabInstance?: { source?: string } }; unresolved?: string };
    const ofGonePrefab = (k: string) => {
      for (let e = before[k] as Node | undefined, hops = 0; e && hops < 64; hops++) {
        const src = e.traits?.PrefabInstance?.source ?? e.unresolved;
        if (src && prefabGone(src)) return true;
        const parent = e.traits?.EntityAttributes?.parentId;
        e = typeof parent === 'string' ? before[parent] as Node | undefined : undefined;
      }
      return false;
    };
    const lostKind = lost.some(ofGonePrefab) ? ' (an entity of a deleted prefab was lost)' : ' (an entity was lost)';
    const kind = lost.length || gained.length ? (renamed ? ' (an entity changed guid)' : lost.length ? lostKind : ' (an entity was gained)')
      : becamePlaceholder ? (prefabGone(placeholderSource!) ? ' (it came back a Missing Prefab placeholder of a deleted prefab)' : ' (it came back a Missing Prefab placeholder)') : '';
    out.push({ check: 'save→reload is not the identity', detail: `${d}${kind}${restoring ? ' (with the deleted prefab restored)' : ''}` });
  }
  if (rt.firstBytes !== rt.secondBytes) {
    const a = JSON.parse(rt.firstBytes); const b = JSON.parse(rt.secondBytes);
    out.push({ check: 'save→reload→save is not byte-identical', detail: firstDiff(a, b) ?? 'formatting or key order only' });
  }
  return out;
}
