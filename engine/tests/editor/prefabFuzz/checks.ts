/** The prefab fuzzer's checks (#1789): the invariants of docs/prefabs.md § "Model and invariants" that can be read off
 *  a world and its files, plus the round-trip and undo identities.
 *
 *  Each check has a stable id. A failure's SIGNATURE is its id plus a detail class with the run's guids and numbers
 *  stripped, so the shrinker only keeps a smaller list that fails the SAME way, never one that slides onto another bug. */

import { parseReferenceNode, parseTemplateLists } from '../../../packages/modoki/src/runtime/prefab/parseInstanceRecord';
import { editorPrefabReader } from '../../../packages/modoki/src/editor/instance/instanceSync';
import { INSTANCE_MODEL_SCENE_VERSION } from '../../../packages/modoki/src/runtime/core/version';
import { LEGACY_ROW_CHANNELS } from '../../../packages/modoki/src/runtime/prefab/templateFormDocument';
import { getAllEntities } from '@modoki/engine/runtime';
import { isRuntimeGuid } from '../../../packages/modoki/src/runtime/core/assetRefRules';
import { validatePrefabData, validateSceneData } from '../../../packages/modoki/src/runtime/loaders/sceneValidation';
import { buildSceneSchema } from '../../../packages/modoki/src/runtime/scene/sceneSchema';
import { assertNoRuntimeGuids } from '../../../packages/modoki/src/editor/scene/runtimeGuidTripwire';
import { PREFAB_FORMAT_VERSION } from '../../../packages/modoki/src/runtime/core/version';
import { getCachedPrefabSync } from '../../../packages/modoki/src/editor/scene/prefabCache';
import { findEntity } from '@modoki/engine/runtime';
import { rowPlaceholderOf, unresolvedRefOf, UnresolvedPrefabRef } from '../../../packages/modoki/src/runtime/core/unresolvedPrefabRef';
import { piOf } from './harness';
import { sameOrientation } from '../../../packages/modoki/src/runtime/scene/transformSpace';
import { storedLocalIdCounter } from '../../../packages/modoki/src/runtime/core/localIdCounter';

/** `console`: every console.error line the end walk logged, allowlisted or not, when the walk's identity check fails —
 *  the line that names the mechanism (a refusal's full text, a "not tagging" reason) is often there, not in `detail`. */
export interface Failure {
  check: string; detail: string; console?: string[];
  /** The guids each drop, paste, detach and Create Prefab of the run introduced or covered, so a stop can ask whether
   *  the entity a failure is on is the one its mechanism's op touched (set by the runner on every failure). */
  touched?: { drop: string[]; paste: string[]; detach: string[]; create: string[];
    /** #2009: what a live agent scene-mutate added, and the entry a file-direct one wrote (its target, or the parent it
     *  added under). Optional: a stop that reads them treats a failure without them as touched by neither. */
    agent?: string[]; fileDirect?: string[] };
  /** For a scene diff that names a node gone from (or new to) one place: whether that node is still on the other side
   *  somewhere else — MOVED (a respawn under the wrong parent) rather than lost or replaced (a guid regression). */
  moved?: boolean;
}

/** Owner ruling R's refusal reasons (`require`, entityRef.ts): the target no longer resolves, or changed kind. Shared by
 *  the allowlist's refusal lines, a single step's and a composite's (#2010: its pre-pass refuses in its sub's words). */
export const RULING_R = 'is a Missing Prefab now|is no longer in the scene|is not a Missing Prefab any more|is no longer an instance of|is no longer a prefab instance|is a prefab instance again';

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
    // A missing nested ROW's placeholder (#2001 S5, ruling D) carries its row, not a record: the records under it are
    // the instance's own rows, which the settle keeps and the save writes (`settleEntryRows`, the capture).
    const row = rowPlaceholderOf(ent as never);
    if (row) {
      if (!row.source || !row.localId) out.push({ check: 'I18 row placeholder without its row', detail: e.name });
      continue;
    }
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
 *  validator. `written` names the files the run has changed, which I15 holds to the current version. */export function checkFiles(
  files: Map<string, string>, history: LocalIdHistory, written: ReadonlySet<string>, handEdited: ReadonlySet<string> = new Set(),
): Failure[] {
  const out: Failure[] = [];
  const docs = new Map<string, Doc>();
  // Every document by id, for the validator's template-key walk into NESTED prefabs (#1876).
  const byId = new Map<string, Doc>();
  for (const [path, text] of files) {
    if (!path.endsWith('.prefab.json')) continue;
    try { const d = JSON.parse(text) as Doc; if (d.id) byId.set(d.id, d); } catch { /* reported below */ }
  }
  for (const [path, text] of files) {
    if (!path.endsWith('.prefab.json')) continue;
    let doc: Doc;
    try { doc = JSON.parse(text) as Doc; } catch (e) { out.push({ check: 'prefab file unparseable', detail: `${path}: ${String(e)}` }); continue; }
    if (doc.id) docs.set(doc.id, doc);
    // A file whose current bytes an outside edit wrote is held to nothing but the cycle check: what it says is the hand
    // edit's, and the editor's next write of it is what these rules bind.
    if (handEdited.has(path)) continue;
    for (const w of validatePrefabData(doc, (g) => byId.get(g)).warnings) {
      // Saying which frames it could not check is coverage, not a violation — true after a trash. Only when every prefab
      // it names really is gone from the files: one this reader failed to give is a harness gap, and stays a finding.
      const unread = /not checked below nested prefab\(s\) (.*) — they could not be read$/.exec(w);
      if (unread && unread[1]!.split(', ').every((g) => !byId.has(g))) continue;
      out.push({ check: 'prefab validator', detail: `${path}: ${w}` });
    }
    try { assertNoRuntimeGuids(doc, path); } catch (e) { out.push({ check: 'I8 runtime guid in a template', detail: String((e as Error).message).split('\n')[0] }); }
    if (written.has(path) && doc.version !== PREFAB_FORMAT_VERSION) out.push({ check: 'I15 written at an old version', detail: `${path}: v${doc.version}` });
    // A document this build wrote states a reference row's list as `members` (prefab v10, #2001 S6): a v9 channel is on a
    // row only as a HELD value (docs/prefabs.md § Format rule: a frame whose prefab did not resolve, a record naming a
    // localId the frame lacks, a value no reader takes), which the one parser says. A writer that skipped the conversion
    // leaves channels the parser holds nothing of.
    if (written.has(path) && doc.version === PREFAB_FORMAT_VERSION && doc.id) {
      const read = (g: string) => { const d = byId.get(g); return d ? { doc: d as never } : { missing: true as const }; };
      const lists = parseTemplateLists(doc as never, doc.id, read as never).rows;
      for (const r of (doc.entities ?? []) as Array<Record<string, unknown>>) {
        if (typeof r.prefab !== 'string') continue;
        const v9 = LEGACY_ROW_CHANNELS.filter((k) => k in r);
        const held = lists.get(r.localId as number)?.list.held;
        if (v9.length && !held?.pendingLegacy && !held?.unparsed) out.push({ check: 'I15 a v10 row states a v9 channel', detail: `${path}: row ${String(r.localId)} ${v9.join(', ')}` });
      }
    }
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

/** Per run: every prefab document's localId high-water mark (by id), the highest the EDITOR has held it at. */
export type MarkHistory = Map<string, number>;

/** I4's mark never goes down (#1774, docs/prefabs.md § "The localId high-water mark"), read off what the editor HOLDS:
 *  `view` is the prefab files with every PARKED document laid over its file (#1868), since a park is what the next
 *  writer mints from and what Save writes. A park whose mark is lower than one the editor held for that document before
 *  hands out a number an earlier row took (#1877 3b S1: a restore after a Save wrote a higher mark). The file under a park
 *  is not read: it may lawfully hold a lower mark than the park until Save lands it. A hand edit (`handEdited`) is held to
 *  nothing; the runner forgets the document's mark when an outside edit writes it, as it does the localId history. */
export function checkMarks(view: ReadonlyMap<string, string>, marks: MarkHistory, parked: ReadonlySet<string>, handEdited: ReadonlySet<string> = new Set()): Failure[] {
  const out: Failure[] = [];
  for (const [path, text] of view) {
    if (!path.endsWith('.prefab.json') || handEdited.has(path)) continue;
    let doc: Doc;
    try { doc = JSON.parse(text) as Doc; } catch { continue; } // `checkFiles` reports an unparseable file
    if (!doc.id) continue;
    // What the document STATES (#1933 S5): the renderer's in-memory reservation would lift a lowered mark back up.
    const now = storedLocalIdCounter(doc);
    const was = marks.get(doc.id);
    if (was !== undefined && now < was) out.push({ check: 'I4 high-water mark went down', detail: `${path}${parked.has(path) ? ' (parked)' : ''}: ${was} → ${now}` });
    marks.set(doc.id, Math.max(was ?? 0, now));
  }
  return out;
}

/** The serialized scene passes the scene validator (schema, refs, member rows), and states every scene-owned reference
 *  node in the current form (#2001 S8b, docs/prefabs.md's format rule): its list on `members` rows, never the old
 *  capture's channels — live or held (`withWrittenList`). The one old channel allowed is one the record HOLDS verbatim
 *  because its target cannot be named (the format rule's exception, `held.pendingLegacy`: a nested prefab it runs
 *  through is missing): the node's parse holds that channel whole, exactly as written. */
export function checkScene(scene: unknown): Failure[] {
  const r = validateSceneData(scene, buildSceneSchema(), (ref) => getCachedPrefabSync(ref) ?? undefined);
  const out: Failure[] = r.warnings.map((w) => ({ check: 'scene validator', detail: w }));
  const OLD = ['overrides', 'removed', 'removedTraits', 'moved', 'nestedOverrides', 'nestedStructure'];
  const isBag = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const node = (n: unknown, at: string): void => {
    if (!isBag(n)) return;
    let old = typeof n.prefab === 'string' ? OLD.filter((k) => n[k] !== undefined) : [];
    if (old.length) {
      const held = parseReferenceNode(n as never, editorPrefabReader, { sceneVersion: INSTANCE_MODEL_SCENE_VERSION }).record.held.pendingLegacy as Record<string, unknown> | undefined;
      old = old.filter((k) => JSON.stringify(held?.[k]) !== JSON.stringify(n[k]));
    }
    if (old.length) out.push({ check: 'a scene-owned reference node is written in an old form', detail: `${at} ${String(n.guid ?? '')}: ${old.join(', ')}` });
    if (Array.isArray(n.children)) for (const c of n.children) node(c, at);
    rows(n.members, `${at} ${String(n.guid ?? '')}`);
  };
  const rows = (members: unknown, at: string): void => {
    if (!isBag(members)) return;
    for (const [k, row] of Object.entries(members)) if (isBag(row) && Array.isArray(row.own)) for (const n of row.own) node(n, `${at}${k}`);
  };
  const entities = isBag(scene) && Array.isArray(scene.entities) ? scene.entities : [];
  for (const e of entities) if (isBag(e)) rows(e.members, String(e.guid ?? ''));
  return out;
}

// ── Identities ──────────────────────────────────────────────────────────────────────────────────────────────────

const NODE_LISTS = new Set(['added', 'children', 'own']);

/** A prefab document with the #1774 mark (`nextLocalId`) and the format `version` set aside: #1892's one "same document"
 *  rule, stated once for the harness (the paste check, the hand-edit and park matching, I15's carry, a restored file's
 *  diff). A restore may raise both on the rows it gives back (an Apply's undo), and nothing that expands a frame reads
 *  either. Stated here, not imported from `documentContentKey`, so the checks do not share a defect in which fields it
 *  sets aside (#1913); the paste check does share the product's key sort (`canonicalJson`). Only the exemption is one
 *  statement: each caller's equality after it is its own (sorted keys, the formatted text, `firstDiff`). A copy through
 *  JSON, as a write would put it: an undefined field is no field. */
export function markFree(doc: object): Record<string, unknown> {
  const d = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
  delete d.nextLocalId;
  delete d.version;
  return d;
}

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

/** Save → reload is the identity, and save → reload → save writes the same bytes. The live instance of a deleted prefab
 *  stays expanded, and the reload expands it from the scene's copy (F8 = A1, #1867, #1935), so the plain reload must give
 *  the live world back — every frame its scene's copy lists as live at the save (#1939), a scene-added node's too. A run
 *  that leaves a frame unexpanded still holds it unexpanded after the reload. (Until #1934 F4 this compared against a reload with the deleted prefabs put back, and forgave
 *  frames that came back expanded, which hid every instance the copy failed to restore: hunt seeds 1011 and 3004.) */
export function checkRoundTrip(
  rt: { before: unknown; after: unknown; firstBytes: string; secondBytes: string; settled?: { after: unknown; bytes: string } },
  prefabGone: (source: string) => boolean = () => false,
): Failure[] {
  const out: Failure[] = [];
  const reloaded = alignEqualOrientations(rt.before, rt.after);
  const ruled = ruledMissing(rt.before, reloaded, prefabGone);
  // Where ruling B turned a live frame into its placeholder, the first save stated the frame and the second its
  // placeholder (and the nodes it shows as entries of their own): the byte identity, I23's "save → reload → save", holds
  // from the save of the reloaded world on — and that world must reload as itself.
  if (ruled !== rt.before && rt.settled) {
    const d2 = firstDiff(reloaded, alignEqualOrientations(reloaded, rt.settled.after));
    if (d2) out.push({ check: 'save→reload is not the identity', detail: `${d2} (the reloaded world's own round trip)` });
    if (rt.secondBytes !== rt.settled.bytes) {
      out.push({ check: 'save→reload→save is not byte-identical', detail: `${firstDiff(JSON.parse(rt.secondBytes), JSON.parse(rt.settled.bytes)) ?? 'formatting or key order only'} (from the reloaded world's save)` });
    }
  }
  const bytes = ruled !== rt.before && rt.settled ? null : [rt.firstBytes, rt.secondBytes] as const;
  const sides = { before: ruled, after: reloaded };
  const d = firstDiff(sides.before, sides.after);
  if (d) {
    // Whether a whole entity went missing, and if so whether one with its name took a NEW guid on the other side (a guid
    // that changed across the reload) or nothing did (lost, or gained): the KNOWN_OPEN predicates key on it.
    const before = sides.before as Record<string, { traits?: { EntityAttributes?: { name?: string } } }>;
    const after = sides.after as Record<string, { traits?: { EntityAttributes?: { name?: string } } }>;
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
    out.push({ check: 'save→reload is not the identity', detail: `${d}${kind}` });
  }
  if (bytes && bytes[0] !== bytes[1]) {
    const a = JSON.parse(bytes[0]); const b = JSON.parse(bytes[1]);
    out.push({ check: 'save→reload→save is not byte-identical', detail: firstDiff(a, b) ?? 'formatting or key order only' });
  }
  return out;
}

/** `before` (a live world) as the rules show it once reloaded (#2001 S5): every frame of a DELETED prefab live at the save
 *  — kept live by #1862, as Unity keeps it — reloads as its Missing Prefab placeholder (rule 9, owner ruling B: a scene's
 *  copy is never expanded). Applied, not pardoned (design § 10.4b): the frame's members and everything anchored inside it
 *  go (their records are the placeholder's, which the byte check holds), the nodes the scene linked AT its root stay
 *  under it (#2018), and the root is the reloaded placeholder, compared by its prefab and its place, not its fields (a
 *  placeholder shows the row's or the record's name and order). Anything else still differs. */
export function ruledMissing(before: unknown, after: unknown, prefabGone: (source: string) => boolean): unknown {
  type Node = { traits?: { EntityAttributes?: { parentId?: unknown }; PrefabInstance?: { source?: string; rootInstanceId?: unknown; parentLocalId?: number } }; unresolved?: string; row?: boolean };
  const b = before as Record<string, Node>;
  const a = after as Record<string, Node>;
  if (!b || typeof b !== 'object') return before;
  const piOfKey = (k: string) => b[k]?.traits?.PrefabInstance;
  const roots = Object.keys(b).filter((k) => { const pi = piOfKey(k); return !!pi?.source && pi.rootInstanceId === k && !b[k]!.unresolved && prefabGone(pi.source); });
  if (!roots.length) return before;
  const children = new Map<string, string[]>();
  for (const k of Object.keys(b)) { const p = b[k]!.traits?.EntityAttributes?.parentId; if (typeof p === 'string') children.set(p, [...(children.get(p) ?? []), k]); }
  const out: Record<string, Node> = { ...b };
  const drop = (k: string): void => { if (!(k in out)) return; delete out[k]; for (const c of children.get(k) ?? []) drop(c); };
  for (const r of roots) {
    if (!(r in out)) continue; // inside a frame already taken
    for (const c of children.get(r) ?? []) {
      const pi = piOfKey(c);
      // A scene node, or a scene-added reference node (a stored root of its own), linked AT the root stays. A missing
      // ROW's placeholder (ruling D) is the frame's own content, and goes with it.
      const linked = !b[c]!.row && (!pi || (pi.rootInstanceId === c && !pi.parentLocalId));
      if (!linked) drop(c);
    }
    for (const k of Object.keys(out)) if (k !== r && piOfKey(k)?.rootInstanceId === r) drop(k); // members moved out
    const shown = a?.[r];
    if (shown?.unresolved === piOfKey(r)!.source && shown.traits?.EntityAttributes?.parentId === b[r]!.traits?.EntityAttributes?.parentId) out[r] = shown;
  }
  return out;
}

/** The ops that never act on a scene instance's own records (#1914 I23): they change templates or files, or (#2009) enter
 *  an envelope whose edits Stop or the exit discards (rule 11). (A save→reload is held by the round trip's own identity
 *  checks.) */
export const RECORD_NEUTRAL: ReadonlySet<string> = new Set(['outsideEdit', 'prefabEdit', 'trashPrefab', 'renamePrefab', 'playStop', 'timelinePreview']);

/** Every override record a saved scene states, as `<entry guid> <channel path>` leaf keys (values left out: a record is
 *  its key, #1914 I23). An instance entry and a Missing Prefab placeholder's kept record alike; the entry's own `traits`
 *  (its name, parent, placement) are not records. */
export function recordKeys(sceneBytes: string): Set<string> {
  // ⚠️ Leaves only: an empty `traits: {}` that later holds a placement is not a record lost (hunt seed 1247).
  const out = new Set<string>();
  let scene: { entities?: Array<Record<string, unknown>> };
  try { scene = JSON.parse(sceneBytes) as typeof scene; } catch { return out; }
  const CHANNELS = ['overrides', 'members', 'removed', 'removedTraits', 'added', 'nestedOverrides', 'nestedStructure', 'moved'];
  // A component bag IS a record, with fields or none: `{T: {}}` adds the component (F6 counts it as one, #1933). So each
  // bag keys its own path besides its leaves; an empty bag that later fills keeps that key, and the seed-1247 case holds.
  const isComponent = (path: string) => /\/traits\/[^/]+$/.test(path) || /^overrides\/[^/]+\/[^/]+$/.test(path) || /^nestedOverrides\/[^/]+\/[^/]+\/[^/]+$/.test(path);
  // A scene node is keyed by its OWN guid, whichever container states it (#2001 S5): a node in an entry's `added`, a row's
  // `own`/`added` or a node's `children` is the same record as a top-level entry with that guid. A frame of a deleted
  // prefab reloads as its placeholder (ruling B) and the nodes linked AT it show (#2018), so a save after the reload
  // writes each as its own entry; keyed by place in a list, every one read as lost. Its placement (where it hangs) is
  // not a record.
  const nodeWalk = (n: Record<string, unknown>, g: string) => {
    out.add(`${g} node`);
    for (const c of CHANNELS) if (n[c] !== undefined) walk(c === 'members' ? withoutRootOrder(n[c]) : n[c], c, g);
    if (n.prefab === undefined && n.traits && typeof n.traits === 'object') {
      const { EntityAttributes: ea, ...rest } = n.traits as Record<string, unknown>;
      const own = ea && typeof ea === 'object' ? (({ parentId: _p, guid: _g, ...r }) => r)(ea as Record<string, unknown>) : ea;
      walk({ ...rest, ...(own !== undefined ? { EntityAttributes: own } : {}) }, 'traits', g);
    }
  };
  const walk = (v: unknown, path: string, guid: string) => {
    if (Array.isArray(v) && /(^|\/)(added|own|children)$/.test(path) && v.every((x) => isRecordNode(x))) {
      for (const x of v) nodeWalk(x as Record<string, unknown>, (x as { guid: string }).guid);
      return;
    }
    if (v && typeof v === 'object' && !Array.isArray(v) && isComponent(path)) out.add(`${guid} ${path}`);
    if (Array.isArray(v) && v.length && v.every((x) => !x || typeof x !== 'object')) {
      for (const x of v) out.add(`${guid} ${path}[${String(x)}]`);
    } else if (v && typeof v === 'object' && Object.keys(v).length) {
      for (const [k, x] of Object.entries(v)) walk(x, `${path}/${k}`, guid);
    } else if (!v || typeof v !== 'object') out.add(`${guid} ${path}`); // an EMPTY object or list is no record (it may fill)
  };
  for (const e of scene.entities ?? []) {
    const guid = typeof e.guid === 'string' ? e.guid
      : typeof (e.traits as { EntityAttributes?: { guid?: unknown } } | undefined)?.EntityAttributes?.guid === 'string' ? (e.traits as { EntityAttributes: { guid: string } }).EntityAttributes.guid : '?';
    nodeWalk(e, guid);
  }
  return out;
}
/** `members` without the `"/"` row's `EntityAttributes.sortOrder` (scene v20, #2001 S6): a stored root's sibling order is
 *  PLACEMENT, which an inline reference node states on its `"/"` row and a top-level entry on its own traits (design § 2.2).
 *  The same node is written either way (a node shown at a Missing Prefab placeholder is an entry of its own), so the
 *  statement moving between the two is not a record lost. */
function withoutRootOrder(members: unknown): unknown {
  const row = members && typeof members === 'object' ? (members as Record<string, { traits?: Record<string, unknown> }>)['/'] : undefined;
  const ea = row?.traits?.EntityAttributes;
  if (!ea || typeof ea !== 'object' || !('sortOrder' in ea)) return members;
  const { sortOrder: _order, ...rest } = ea as Record<string, unknown>;
  return { ...(members as object), '/': { ...row, traits: { ...row!.traits, EntityAttributes: rest } } };
}
const isRecordNode = (x: unknown): boolean => !!x && typeof x === 'object' && typeof (x as { guid?: unknown }).guid === 'string';
