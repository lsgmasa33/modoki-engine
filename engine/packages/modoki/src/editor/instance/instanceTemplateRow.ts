/**
 * The prefab-edit save's nested reference row (#2001 S8b step 5): **save writes the list** (rule 4), on the prefab side
 * too. A nested row of the document being edited is a stored instance in the edit world (its root guid the row's
 * sentinel, `buildPrefabEditScene`), and its row is written from that record (design § 2.2's prefab-edit row: "their
 * row is `templateForm(rec)`"), never from a capture of its live tree.
 *
 * The record is written by the scene writer (`writtenEntryOf`, the v20 entry the scene save writes, so the content of a
 * node the record links, live or held, comes from the same place), then put in the TEMPLATE form, which states no
 * instance's identity (I8, #1293):
 * - **No pins.** A member row's `guid` and `name` go; the `"/"` row's name is the row's own (`EntityAttributes.name`
 *   on the row, as the document states it), so it goes too.
 * - **Nodes by key.** A scene-owned node is written `guid: ''` with its template key (`toTemplateNodes`: the key its
 *   content or live node carries, else a new one).
 * - **A reference node in the row's own list is written whole** (docs/prefab-structural-overrides.md § R3b: "a node in
 *   the WRITER's own list is its own statement"): the rows the record keys INTO it (`<anchor>/a+<key>…`, its interior as
 *   a supplied node of the row's frame, design § 10.4b) go into the node's own `members`, keyed from its root.
 * - **Member refs as tokens** (#1352), each in the frame its row applies in, as the capture's rows were
 *   (`tokenizeRowMembers`): a row in the row's frames, a node's own rows in the node's frame.
 *
 * A value the parse could not interpret rides on the entry in its legacy channel (`held`), and goes onto the row as it
 * is: the document writer (`writeTemplateForm`) reads it by the rules of its own form.
 */
import { getAllEntities, findEntity, readTraitData } from '../../runtime/core/ecs/entityUtils';
import { getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { findEntityByGuid, getCurrentWorld } from '../../runtime/core/ecs/world';
import { memberRowKeysIn } from '../../runtime/core/ecs/memberRows';
import { storedRecord } from '../../runtime/prefab/instanceStore';
import { LEGACY_ROW_CHANNELS } from '../../runtime/prefab/templateFormDocument';
import { ROOT_ROW_KEY, type InstanceRecord } from '../../runtime/prefab/instanceRecord';
import type { AddedEntity, SceneMemberRow } from '../../runtime/loaders/loadSceneFile';
import { filterAuthoringVisible } from '../scene/authoringScope';
import { getCachedPrefabSync } from '../scene/prefabCache';
import { rowAt } from '../../runtime/core/prefabRowAt';
import { isPrefabEditWorld } from '../scene/prefabEditWorld';
import { sceneNodeTemplateKey, templateKeyOf } from '../../runtime/core/templateIdentity';
import { declaredTemplateKeys, toTemplateNodes } from '../scene/prefabCapture';
import { templateTokenizer } from '../scene/prefabTokens';
import { memberToken } from '../../runtime/core/templateRefs';
import { guidOfEntity, instanceKeyMap } from './instanceKeys';
import { consumedBy } from './instanceSave';
import { treeForWrite } from './instanceSync';
import { writtenEntryOf } from './instanceReproject';
import { liveOwnContent } from './instanceOwnContent';

type Rows = Record<string, SceneMemberRow>;
type Tokens = ReturnType<typeof templateTokenizer>;

export interface TemplateRowFromRecord {
  /** The row's list in template form; absent when it states nothing. */
  members?: Rows;
  /** What the record holds in a legacy channel (a value no reader took), for the document writer. */
  held: Record<string, unknown>;
}

/** The template-form row for the nested row whose live root is `rootId`, written from its record; null when the tree
 *  holds no record to write (the caller then writes it as before). `tokens`: the written tree's tokenizer. */
export function templateRowFromRecord(rootId: number, tokens: Tokens): TemplateRowFromRecord | null {
  const rec = recordToWrite(rootId);
  if (!rec) return null;
  const captured = new Set<number>();
  const content = liveOwnContent(captured);
  const written = writtenEntryOf(rec, rootId, content);
  const entry = written as unknown as Record<string, unknown> & { members?: Rows };
  const held: Record<string, unknown> = {};
  for (const k of LEGACY_ROW_CHANNELS) if (entry[k] !== undefined) held[k] = entry[k];
  const scene: Rows = { ...(entry.members ?? {}) };
  // The row's root order, where its row states it (`Placement.orderStated`): the entry writes it as placement (on its own
  // `traits`, which a row does not have), and a row states it on its `"/"` row, as a reference node's list does
  // (`withWrittenList`).
  if (rec.placement.orderStated) {
    const root = scene[ROOT_ROW_KEY] ?? {};
    const ea = { ...(root.traits?.EntityAttributes as Record<string, unknown> | undefined), sortOrder: rec.placement.sortOrder };
    scene[ROOT_ROW_KEY] = { ...root, traits: { ...root.traits, EntityAttributes: ea } } as SceneMemberRow;
  }
  // A node under the instance that no record links (a write that went round the door) is still the document's: written
  // at the row of the member it hangs under, as the scene save writes one as an entity of its own (`instanceSave.ts`).
  const { unstated } = consumedBy(rootId, written, captured);
  if (unstated.length) {
    const keyOf = instanceKeyMap(rootId);
    const parentOf = (id: number) => getAllEntities().find((e) => e.id === id)?.parentId ?? 0;
    const keyless = keylessTemplateGuids([rec.source, ...sourcesUnder(rootId)]);
    for (const id of unstated) {
      if (keyless.has(guidOfEntity(id))) continue;
      const key = keyOf.get(parentOf(id)) ?? (parentOf(id) === rootId ? ROOT_ROW_KEY : undefined);
      const node = key !== undefined ? content.nodeOfId(id) : undefined;
      if (key === undefined || !node) continue;
      scene[key] = { ...scene[key], own: [...(scene[key]?.own ?? []), node as unknown as AddedEntity] };
    }
  }
  const rows = templateRows(scene, true);
  absorbNodeRows(rows);
  const members = tokenizeRows(rows, rootId, tokens);
  return { ...(Object.keys(members).length ? { members } : {}), held };
}

/** The record nested row `rootId` is written from: a row of the document the prefab editor has open (design § 2.2's
 *  prefab-edit row), when its tree holds a fresh one. The plan's capture of such a row (`planPrefabRows`) only READS (no
 *  key stamped on a live node), since it writes nothing the file keeps. Create Prefab in a scene still writes its rows
 *  from the capture, whose key stamp links the tree it tags. */
export function recordToWrite(rootId: number): InstanceRecord | undefined {
  if (!isPrefabEditWorld()) return undefined;
  const world = getCurrentWorld();
  const guid = guidOfEntity(rootId);
  return guid && treeForWrite(rootId, world) ? storedRecord(world, guid) : undefined;
}

/** The guids the documents of `source`, and every prefab they nest, state their KEY-LESS template-added nodes by (a legacy
 *  file's): such a node spawns under that guid wherever the document expands, so a live one is the document's, never a
 *  node to write. No record links it in a template's world, where nothing converts it (a scene's load makes it the
 *  scene's own, `ownKeylessTemplateNodes`; a template needs no such statement, since the document still supplies it, and
 *  one written would spawn it twice). */
function keylessTemplateGuids(sources: readonly string[]): Set<string> {
  const out = new Set<string>();
  const seen = new Set<string>();
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) { for (const x of v) visit(x); return; }
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    if (typeof o.prefab === 'string' && (typeof o.localId === 'number' || typeof o.parentLocalId === 'number')) visitDoc(o.prefab);
    if (typeof o.parentLocalId === 'number' && !o.key && typeof o.guid === 'string' && o.guid) out.add(o.guid);
    for (const [k, x] of Object.entries(o)) if (k !== 'traits' && k !== 'overrides' && k !== 'nestedOverrides') visit(x);
  };
  const visitDoc = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    visit(getCachedPrefabSync(id)?.entities);
  };
  for (const s of sources) visitDoc(s);
  return out;
}

/** The prefab of every instance root at or under `rootId` (a reference node the row's list states is one). */
function sourcesUnder(rootId: number): string[] {
  const pi = getTraitByName('PrefabInstance');
  if (!pi) return [];
  const all = getAllEntities();
  const parentOf = new Map(all.map((e) => [e.id, e.parentId]));
  const out: string[] = [];
  for (const e of all) {
    const d = readTraitData(e.id, pi) as { source?: string; rootInstanceId?: number } | null;
    if (!d?.source || d.rootInstanceId !== e.id) continue;
    for (let a: number | undefined = e.id, n = 0; a && n < 1024; a = parentOf.get(a), n++) if (a === rootId) { out.push(d.source); break; }
  }
  return out;
}

/** `rows` without any instance's identity: each row's pins gone (and, `root`, the `"/"` row's name), each scene node a
 *  template node, a reference node's own rows the same, recursively. A row left stating nothing is not written. */
function templateRows(rows: Rows, root: boolean): Rows {
  const out: Rows = {};
  for (const [key, row] of Object.entries(rows)) {
    const { guid: _guid, name: _name, ...rest } = row;
    const r: SceneMemberRow = { ...rest };
    if (root && key === ROOT_ROW_KEY && r.traits) r.traits = withoutRootName(r.traits);
    if (r.traits && !Object.keys(r.traits).length) delete r.traits;
    if (r.own) r.own = templateNodes(r.own);
    if (r.added) r.added = templateNodes(r.added);
    if (Object.keys(r).length) out[key] = r;
  }
  return out;
}

function withoutRootName(traits: NonNullable<SceneMemberRow['traits']>): NonNullable<SceneMemberRow['traits']> {
  const ea = traits.EntityAttributes;
  if (!ea || typeof ea !== 'object' || !('name' in ea)) return traits;
  const { name: _name, ...restEa } = ea as Record<string, unknown>;
  const out = { ...traits } as Record<string, unknown>;
  if (Object.keys(restEa).length) out.EntityAttributes = restEa; else delete out.EntityAttributes;
  return out as NonNullable<SceneMemberRow['traits']>;
}

/** Scene nodes as template nodes (`toTemplateNodes`), keeping a reference node's own rows, in template form. */
function templateNodes(nodes: AddedEntity[]): AddedEntity[] {
  const written = toTemplateNodes(nodes.map(keyed))!;
  return written.map((t, i) => withNodeRows(nodes[i]!, t));
}

/** `node` with its template key: the one a file gave it (its content's, or the marker its live entity carries), else one
 *  derived from the guid the record links it by. A key minted per save would rewrite the file each time; the guid is the
 *  same for every save of the same record, live or held (`held.heldOwn`), and a reload of the file then carries the key.
 *  (The capture stamped a minted key on each live node, and on its kept rows, `keySceneNodes`, for this.) */
function keyed(node: AddedEntity): AddedEntity {
  const children = (node.children ?? []).map(keyed);
  const live = node.guid ? findEntityByGuid(node.guid, getCurrentWorld()) : undefined;
  const key = node.key || (live ? templateKeyOf(live as never) : '') || (node.guid ? sceneNodeTemplateKey(node.guid) : '');
  return { ...node, ...(key ? { key } : {}), children };
}

function withNodeRows(scene: AddedEntity, t: AddedEntity): AddedEntity {
  const out: AddedEntity = { ...t, children: (t.children ?? []).map((c, i) => withNodeRows(scene.children?.[i] ?? c, c)) };
  if (typeof scene.prefab === 'string' && scene.members) {
    const rows = templateRows(scene.members, false);
    const root = rows[ROOT_ROW_KEY];
    if (root?.traits) {
      root.traits = withoutUnchangedRootDefaults(root.traits, scene.name, scene.prefab);
      if (!Object.keys(root.traits).length) delete root.traits;
      if (!Object.keys(root).length) delete rows[ROOT_ROW_KEY];
    }
    if (Object.keys(rows).length) out.members = rows;
  }
  return out;
}

/** A reference node's `"/"` row as the template states it: the live read of the node states its root's name and order
 *  there (`instanceOwnContent.ts`), and a template states them only where they differ from what the node already says:
 *  its `name`, and its prefab root's own order. */
function withoutUnchangedRootDefaults(traits: NonNullable<SceneMemberRow['traits']>, name: string | undefined, prefab: string): NonNullable<SceneMemberRow['traits']> {
  const ea = traits.EntityAttributes;
  if (!ea || typeof ea !== 'object') return traits;
  const rest = { ...(ea as Record<string, unknown>) };
  if (rest.name === name) delete rest.name;
  if ('sortOrder' in rest && rest.sortOrder === templateRootOrder(prefab)) delete rest.sortOrder;
  const out = { ...traits } as Record<string, unknown>;
  if (Object.keys(rest).length) out.EntityAttributes = rest; else delete out.EntityAttributes;
  return out as NonNullable<SceneMemberRow['traits']>;
}

/** The sibling order the root of document `prefab` states (the trait default, 0, where it states none). */
function templateRootOrder(prefab: string): number {
  const doc = getCachedPrefabSync(prefab);
  const root = rowAt(doc, doc?.rootLocalId ?? 1);
  const ea = root?.traits?.EntityAttributes;
  const order = ea && ea !== true ? (ea as { sortOrder?: unknown }).sortOrder : undefined;
  return typeof order === 'number' ? order : 0;
}

/** Move each row the record keys INTO a reference node of `rows`' own lists (`<frame>/a+<key>`, and the rows under it,
 *  where `<frame>` is the frame whose list holds the node's anchor: the anchor or a key above it) onto that node's own
 *  `members`, keyed from its root; then the same inside each node. Mutates `rows`. */
function absorbNodeRows(rows: Rows): void {
  for (const [anchor, row] of Object.entries(rows)) {
    const frames: string[] = [];
    for (let k = anchor === ROOT_ROW_KEY ? '' : anchor; ; k = k.slice(0, k.lastIndexOf('/'))) { frames.push(k); if (!k) break; }
    const visit = (n: AddedEntity): void => {
      if (typeof n.prefab === 'string' && n.key) {
        const at = frames.map((f) => `${f}/a+${n.key}`).find((a) => Object.keys(rows).some((k) => k === a || k.startsWith(`${a}/`))) ?? '';
        const mine: Rows = { ...(n.members ?? {}) };
        let moved = false;
        for (const [k, r] of Object.entries(rows)) {
          if (!at || (k !== at && !k.startsWith(`${at}/`))) continue;
          const own = k === at ? ROOT_ROW_KEY : k.slice(at.length);
          mine[own] = mine[own] ? { ...mine[own], ...r } : r;
          delete rows[k];
          moved = true;
        }
        if (moved) {
          absorbNodeRows(mine);
          n.members = Object.fromEntries(Object.keys(mine).sort().map((k) => [k, mine[k]!]));
        }
      }
      for (const c of n.children ?? []) visit(c);
    };
    for (const n of row.own ?? []) visit(n);
    for (const n of row.added ?? []) visit(n);
  }
}

/** `rows`' member refs as tokens, each row in the frame its key applies in (`tokenizeRowMembers`' rule): a nested ROOT's
 *  row (its key names a frame) in that frame, any other in the frame its key less its last component names, else
 *  `rootId`'s. A reference node's own rows in the node's frame, when the node is live. */
function tokenizeRows(rows: Rows, rootId: number, tokens: Tokens): Rows {
  const byKey = new Map<string, number>();
  for (const [id, k] of memberRowKeysIn(rootId)) byKey.set(k, id);
  const pi = getTraitByName('PrefabInstance');
  const isFrameRoot = (id: number | undefined): id is number => {
    const d = id !== undefined && pi ? readTraitData(id, pi) as { rootInstanceId?: number } | null : null;
    return !!d && d.rootInstanceId === id;
  };
  const frameOf = (key: string): number => {
    const self = byKey.get(key);
    if (isFrameRoot(self)) return self;
    const up = byKey.get(key.slice(0, key.lastIndexOf('/')));
    return isFrameRoot(up) ? up : rootId;
  };
  const out: Rows = {};
  for (const [key, row] of Object.entries(rows)) {
    const frame = key === ROOT_ROW_KEY ? rootId : frameOf(key);
    const r: SceneMemberRow = { ...row };
    if (r.traits) r.traits = tokens.value(r.traits, frame) as SceneMemberRow['traits'];
    // A move's parent, a guid in the scene form, is a member token in the template's. One naming the row's own root (#1883
    // C: a kept keyed move hung right under the row) is named from the document's frame, one up, as the capture named it
    // (`templateMoves`): the frame's own root has no path inside it.
    if (typeof r.parent === 'string') {
      const own = r.parent === guidOfEntity(frame) ? tokens.pathOf(frame) : undefined;
      r.parent = own ? memberToken(1, own) : tokens.value(r.parent, frame) as string;
    }
    if (r.own) r.own = nodeRowsTokenized(tokens.added(r.own, frame)!, r.own);
    if (r.added) r.added = nodeRowsTokenized(tokens.added(r.added, frame)!, r.added);
    out[key] = r;
  }
  return out;
}

/** The written tree's tokenizer leaves a reference node's payload whole (it applies in the node's own frame): each live
 *  reference node's own rows, tokenized in that frame. `before`: the same nodes as the record wrote them. */
function nodeRowsTokenized(nodes: AddedEntity[], before: AddedEntity[]): AddedEntity[] {
  return nodes.map((n, i) => {
    const was = before[i];
    const children = (n.children ?? []).map((c, j) => nodeRowsTokenized([c], [was?.children?.[j] ?? c])[0]!);
    if (typeof n.prefab !== 'string' || !n.members) return { ...n, children };
    const live = liveNodeOf(n.key);
    if (!live) return { ...n, children };
    const own = templateTokenizer(live, filterAuthoringVisible(getAllEntities()), new Map(), new Map(), true);
    const members = tokenizeRows(n.members, live, own);
    // A token may name a keyed node only if some file declares that key (the node writer's rule, `prefabCapture.ts`): what
    // the node writes, or its prefab and what that nests. A token through any other key names nothing on reload, where the
    // guid it was written for may. ⚠️ No test reaches the reject side: the case it was found by (#1538, a key the capture
    // minted for a legacy key-less node) no longer arises, since a key-less template node is the document's
    // (`keylessTemplateGuids`) and the plan's capture stamps no key here. Dropping this call measured green; narrowing
    // `declared` measured red (an OLD copy's slot key, `templateReferenceNodeRows.test.ts`).
    const declared = declaredTemplateKeys({ entities: [{ members }] }, [n.prefab]);
    return { ...n, children, members: own.undeclaredKeys(members, declared) as Rows };
  });
}

/** The live root of the reference node keyed `key`, if one is live. */
function liveNodeOf(key: string | undefined): number | undefined {
  if (!key) return undefined;
  return getAllEntities().find((e) => templateKeyOf(findEntity(e.id) as never) === key)?.id;
}
