/** One owner for a document's identifiers (#1937 C-A, step 1; owner rulings F-A (1), F-C yes).
 *
 *  Unity refuses a file whose identifiers repeat ("Duplicate identifier"); Modoki's readers each spelled their own answer
 *  to "a key used twice names neither", and one did not (#1933 S1: `templateFrameNodes` took the last, so a scene edit
 *  on that node read as backed and was dropped), while the save's whole-list fallback pinned a keyless or repeated
 *  template list onto instances nobody touched (S2). This module decides it once, before a document is seated:
 *
 *  - {@link admitPrefabDocument}: the shape (`isPrefabDocument`), then a deterministic key for every keyless template
 *    node (Unity's in-memory upgrade: written on the prefab's next real save, an existing key never touched) — seeded by
 *    the node's CONTENT, not its position (see {@link walkTemplateNodes}) — then the
 *    identifiers the document itself declares — a repeated row `localId` or `nodeGuid`, and two keyed template nodes
 *    in one frame as THIS document addresses it. A refused document reads as a prefab that did not load (I18).
 *  - {@link sceneIdentityRefusal}: a guid a scene defines twice, and a key repeated inside one of its lists (#1933 L3).
 *
 *  Pure, Node-safe, no reads: a frame a NESTED document would have to tell apart (two anchors, one of which turns out to
 *  be a nested row) is not judged here — the validator's `repeatedTemplateKeys`, which reads nested prefabs, reports
 *  those. Nothing here is wired yet; the seats, gates and writers come in later steps. */

import { deriveGuid } from '../core/assetRefRules';
import { isPrefabDocument } from './prefabDocumentShape';

type Node = Record<string, unknown>;
const isObj = (v: unknown): v is Node => !!v && typeof v === 'object' && !Array.isArray(v);
const list = (v: unknown): Node[] => (Array.isArray(v) ? v.filter(isObj) : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const nameOf = (n: Node): string => str(n.name) || str((isObj(n.traits) && isObj(n.traits.EntityAttributes) ? n.traits.EntityAttributes.name : '')) || '(unnamed)';

/** Every template node list one owner (a document row, or a reference node inside one) declares, with the frame group
 *  its nodes share as this document addresses it: an `added` list per anchor, a `nestedStructure` slot per path and
 *  anchor, a member row's `added` and `own` together. Children share their parent's group; a reference node's own lists
 *  are a frame of their own. */
function eachTemplateList(owner: Node, container: string, seed: string, visit: (nodes: Node[], group: (n: Node) => string, seed: string) => void): void {
  const byAnchor = (base: string) => (n: Node) => `${base}#${String(n.parentLocalId ?? '')}`;
  visit(list(owner.added), byAnchor(`${container}|added`), `${seed}|added`);
  if (isObj(owner.nestedStructure)) {
    for (const [path, slot] of Object.entries(owner.nestedStructure)) {
      if (isObj(slot)) visit(list(slot.added), byAnchor(`${container}|ns:${path}`), `${seed}|ns:${path}`);
    }
  }
  if (isObj(owner.members)) {
    for (const [rowKey, row] of Object.entries(owner.members)) {
      if (!isObj(row)) continue;
      const group = () => `${container}|m:${rowKey}`;
      visit(list(row.added), group, `${seed}|m:${rowKey}:added`);
      visit(list(row.own), group, `${seed}|m:${rowKey}:own`);
    }
  }
}

/** Walk every template node of `doc`, minting a key for each keyless one when `mint` (else only reporting that one
 *  exists), and collecting each frame group's keys.
 *
 *  A mint is seeded by the document's guid, the list the node is in, the node's own content (as the file states it) and
 *  its ordinal among IDENTICAL nodes of that list — never by its index. A key from a position would move to whatever
 *  node a hand edit inserted before it, and a scene statement made on the old node would land on the new one (#1779: the
 *  hub's "nothing re-targets"). By content, an inserted node takes a key of its own; a hand edit of the node itself gives
 *  it a new key, so a scene row made on the old one is kept as unused rather than moved; and only identical nodes, which
 *  nothing tells apart, can trade keys. */
function walkTemplateNodes(doc: { id?: unknown; entities: Node[] }, mint: boolean): { keyless: boolean; groups: Map<string, Array<{ key: string; name: string }>> } {
  const groups = new Map<string, Array<{ key: string; name: string }>>();
  let keyless = false;
  const docId = str(doc.id);
  const node = (n: Node, group: string, seed: string): void => {
    if (!str(n.key) && !str(n.guid)) {
      keyless = true;
      // Seeded with the document's guid, so two documents' mints never meet in one frame; by content, so the same
      // document admitted twice mints the same keys, and no other node's edit moves this one's.
      if (mint) n.key = deriveGuid(`key|${docId}|${seed}`);
    }
    const key = str(n.key);
    if (key) {
      const at = groups.get(group) ?? [];
      at.push({ key, name: nameOf(n) });
      groups.set(group, at);
    }
    lists(list(n.children), () => group, `${seed}/children`);
    if (str(n.prefab)) eachTemplateList(n, `${group}>${key || str(n.guid) || seed}`, seed, lists);
  };
  const lists = (nodes: Node[], group: (n: Node) => string, seed: string): void => {
    // Each node's seed is fixed BEFORE any of the list is minted, from what the file states.
    const seen = new Map<string, number>();
    const seeds = nodes.map((n) => {
      const body = JSON.stringify(n);
      const ordinal = seen.get(body) ?? 0;
      seen.set(body, ordinal + 1);
      return `${seed}#${body}:${ordinal}`;
    });
    nodes.forEach((n, i) => node(n, group(n), seeds[i]!));
  };
  for (const row of doc.entities) eachTemplateList(row, `row:${String(row.localId ?? '')}`, String(row.localId ?? ''), lists);
  return { keyless, groups };
}

/** The first identifier `doc` declares twice, worded for the human, or null. */
function documentRepeat(doc: { name?: unknown; id?: unknown; entities: Node[] }, groups: Map<string, Array<{ key: string; name: string }>>): string | null {
  const label = `prefab "${str(doc.name) || str(doc.id) || '(unnamed)'}"`;
  const fix = '(a hand edit, a merge or an old build\'s carry made this; the editor never writes it)';
  for (const field of ['localId', 'nodeGuid'] as const) {
    const seen = new Map<string, string>();
    for (const row of doc.entities) {
      const v = row[field];
      if (v === undefined || v === null || v === '') continue;
      const id = String(v);
      const first = seen.get(id);
      if (first !== undefined) return `${label} gives ${field} ${id} to two rows (${first} and ${nameOf(row)}) — every ref to either lands on one of them; give one a new ${field} ${fix}`;
      seen.set(id, nameOf(row));
    }
  }
  for (const nodes of groups.values()) {
    const seen = new Map<string, string>();
    for (const { key, name } of nodes) {
      const first = seen.get(key);
      if (first !== undefined) return `${label} gives template key ${key} to two nodes in one frame (${first} and ${name}) — they derive the same guid, so every ref to either lands on one of them; give one a new key ${fix}`;
      seen.set(key, name);
    }
  }
  return null;
}

/** Admit `raw` as a prefab document, or refuse it with the reason. The input is never mutated: a document with keyless
 *  template nodes comes back as a copy carrying their minted keys; one with none comes back as itself. */
export function admitPrefabDocument<T>(raw: T): { doc: T } | { refusal: string } {
  if (!isPrefabDocument(raw)) return { refusal: 'not a prefab document (no `entities` list of rows)' };
  let doc = raw as unknown as { id?: unknown; name?: unknown; entities: Node[] };
  let walked = walkTemplateNodes(doc, false);
  if (walked.keyless) {
    doc = structuredClone(doc);
    walked = walkTemplateNodes(doc, true);
  }
  const repeat = documentRepeat(doc, walked.groups);
  return repeat ? { refusal: repeat } : { doc: doc as unknown as T };
}

// Unwired on purpose: its gate is #1937 C-A step 5, PARKED (L3 on #1933, owner ruling 2026-10-01) — not dead code.
/** A guid `data` (a scene document) defines twice — two entries, two scene-added nodes, a member row's pin beside
 *  either — or a key repeated inside one of its lists, worded for the human; null when every identifier is single. */
export function sceneIdentityRefusal(data: unknown): string | null {
  if (!isObj(data)) return null;
  const label = `scene "${str(data.name) || str(data.id) || '(unnamed)'}"`;
  const guids = new Map<string, string>();
  let found: string | null = null;
  const define = (guid: string, what: string): void => {
    if (!guid || found) return;
    const first = guids.get(guid);
    if (first !== undefined) found = `${label} defines guid ${guid} twice (${first} and ${what}) — every ref to either lands on one of them; give one a new guid`;
    else guids.set(guid, what);
  };
  const keysOnce = (nodes: Node[], where: string): void => {
    const seen = new Map<string, string>();
    for (const n of nodes) {
      const key = str(n.key);
      if (!key || found) continue;
      const first = seen.get(key);
      if (first !== undefined) found = `${label} gives key ${key} to two nodes in one list under ${where} (${first} and ${nameOf(n)})`;
      else seen.set(key, nameOf(n));
    }
  };
  const nodes = (ns: Node[], where: string): void => {
    keysOnce(ns, where);
    for (const n of ns) {
      define(str(n.guid), nameOf(n));
      inside(n, nameOf(n));
    }
  };
  const inside = (n: Node, where: string): void => {
    nodes(list(n.children), where);
    nodes(list(n.added), where);
    if (isObj(n.nestedStructure)) for (const slot of Object.values(n.nestedStructure)) if (isObj(slot)) nodes(list(slot.added), where);
    if (isObj(n.members)) {
      for (const [rowKey, row] of Object.entries(n.members)) {
        if (!isObj(row)) continue;
        define(str(row.guid), `${where} member ${str(row.name) || rowKey}`);
        nodes(list(row.added), `${where} member ${rowKey}`);
        nodes(list(row.own), `${where} member ${rowKey}`);
      }
    }
  };
  for (const e of list(data.entities)) {
    const ea = isObj(e.traits) && isObj(e.traits.EntityAttributes) ? e.traits.EntityAttributes : {};
    define(str(ea.guid) || str(e.guid), nameOf(e));
    inside(e, nameOf(e));
  }
  return found;
}

