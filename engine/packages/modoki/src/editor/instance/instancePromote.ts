/**
 * A nested frame made an instance of its own (#2001 S8b): the record a copy of PART of an instance gives a nested
 * prefab's root it carries, when the frame that held it stays behind (#1756's link rules, `copySnapshot`'s `promote`;
 * Unity: a copied nested prefab instance is an instance of its own prefab).
 *
 * What the copy shows is what the frame showed, so its list states what every layer OUTSIDE the frame stated: the
 * template lists of the documents that hold it and the instance's own list, composed in the fold's order (inner first,
 * the scene's last; `FoldOptions.layersAt`). The values are the live ones (a copy shows the projection's values, and a
 * template layer can state an entity ref as a member token). Nodes the layers outside added (a template-added node
 * anchored in the frame) and the user's nodes under its members are plain content in the copy, linked by `own`.
 *
 * Nothing is re-derived from a capture or a mark: the record is built from records and the live tree, and checked
 * against the fold before it is used — the composed record must fold to exactly the nodes and values the frame showed,
 * or there is no record and the caller keeps its old path.
 */
import type { World } from 'koota';
import { getCurrentWorld, findEntityByGuid } from '../../runtime/core/ecs/world';
import { getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { findEntity, readTraitDataFull } from '../../runtime/core/ecs/entityUtils';
import { foldInstance, type HandedLayer } from '../../runtime/prefab/foldInstance';
import { ROOT_ROW_KEY, type DesiredNode, type InstanceRecord, type RowKey, type SceneOwnedNode, type SceneTargetRecord } from '../../runtime/prefab/instanceRecord';
import { guidOfEntity, instanceKeyMap } from './instanceKeys';
import { editorPrefabReader } from './instanceSync';

type Bag = Record<string, unknown>;
const isBag = (v: unknown): v is Bag => !!v && typeof v === 'object' && !Array.isArray(v);
const clone = <T>(v: T): T => (v && typeof v === 'object' ? structuredClone(v) : v);

/** A root's placement fields: the record's `placement` states them, never its `"/"` row. */
const PLACEMENT_FIELDS = ['name', 'sortOrder', 'parentId', 'guid', 'editorFolder'];

/** The layers handed to a frame, composed into one list in the fold's order (a later layer's value wins, field by
 *  field). Moves are left out: the caller compares where the nodes land instead. */
function compose(layers: readonly HandedLayer[]): Map<RowKey, SceneTargetRecord> {
  const rows = new Map<RowKey, SceneTargetRecord>();
  for (const layer of layers) {
    for (const [rel, r] of layer.rows) {
      let row = rows.get(rel);
      if (!row) rows.set(rel, (row = {}));
      for (const [t, data] of Object.entries(r.traits ?? {})) {
        const traits = (row.traits ??= {});
        if (data === true) { if (traits[t] === undefined) traits[t] = true; continue; }
        if (!isBag(data)) continue;
        const cur = traits[t];
        traits[t] = { ...(isBag(cur) ? cur : {}), ...clone(data) };
      }
      for (const [t, on] of Object.entries(r.traitRemovals ?? {})) (row.traitRemovals ??= {})[t] = on;
      // A frame root's own removal is the enclosing frame's to apply: the copy exists, so nothing removed it.
      if (typeof r.removed === 'boolean' && rel !== ROOT_ROW_KEY) row.removed = r.removed;
    }
  }
  return rows;
}

/** What the template lists handed to the frame HOLD (`HandedLayer.held`: a statement their parse could not name — under a
 *  Missing Prefab placeholder in the frame, say), merged in the fold's order: the instance's list holds it the same way,
 *  verbatim, until the document resolves (format rule; `held.pendingLegacy`). */
function composeHeld(layers: readonly HandedLayer[]): InstanceRecord['held'] {
  const merge = (a: unknown, b: unknown): unknown => {
    if (!isBag(a) || !isBag(b)) return clone(b);
    const out: Bag = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = k in out ? merge(out[k], v) : clone(v);
    return out;
  };
  let held: Bag = {};
  for (const l of layers) if (l.held) held = merge(held, l.held) as Bag;
  return held as InstanceRecord['held'];
}

/** Drop what a row no longer states. */
function tidy(rows: Map<RowKey, SceneTargetRecord>): void {
  for (const [k, row] of [...rows]) {
    if (row.traits) {
      for (const [t, d] of Object.entries(row.traits)) if (isBag(d) && !Object.keys(d).length) delete row.traits[t];
      if (!Object.keys(row.traits).length) delete row.traits;
    }
    if (row.traitRemovals && !Object.keys(row.traitRemovals).length) delete row.traitRemovals;
    if (row.own && !row.own.length) delete row.own;
    if (!Object.keys(row).length) rows.delete(k);
  }
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** A node's place, relative to the frame at `frameKey`, or null when it hangs outside it. */
function relParent(p: DesiredNode['parent'], frameKey: RowKey): string | null {
  if (!p) return '';
  if (!('key' in p)) return null;
  if (p.key === frameKey) return ROOT_ROW_KEY;
  return p.key.startsWith(`${frameKey}/`) ? p.key.slice(frameKey.length) : null;
}

/**
 * The record of the nested frame at `frameKey` of fresh record `rec`, as an instance of its own: keyed relative to the
 * frame, under the live frame root's guid. Null when the frame cannot be stated that way — it is not a projected nested
 * frame, it holds a placeholder, a layer outside it moves one of its nodes (a legacy move, which no gesture writes), or
 * the composed list does not fold to what the frame shows.
 */
export function promotedRecord(rec: InstanceRecord, frameKey: RowKey, world: World = getCurrentWorld()): InstanceRecord | null {
  if (frameKey === ROOT_ROW_KEY) return null;
  const layersAt = new Map<RowKey, readonly HandedLayer[]>();
  const outer = foldInstance(editorPrefabReader, rec, { layersAt });
  const layers = layersAt.get(frameKey);
  const top = outer.nodes.get(frameKey);
  if (!layers || !top?.opens) return null;
  const under = (k: RowKey) => k === frameKey || k.startsWith(`${frameKey}/`);
  // A placeholder in it, or a link the fold does not place there that names no node the record holds: not something a
  // copy can restate exactly. A node the record HOLDS there (`held.heldOwn`: a user's node whose anchor the template no
  // longer projects) the copy holds too, as it holds any other unused record there (a removal or override of what the
  // template no longer has, R2) — as a copy of a whole instance does (#1788): carried below, under the frame's key.
  const heldHere = new Map<RowKey, SceneOwnedNode[]>();
  for (const [k, nodes] of rec.held.heldOwn ?? []) if (under(k)) heldHere.set(k, nodes);
  const heldGuids = new Set([...heldHere.values()].flat().map((n) => n.guid));
  if (outer.unused.some((u) => under(u.key) && ((u.part.kind === 'own' && !heldGuids.has(u.part.guid)) || u.part.kind === 'legacy'))) return null;
  const rel = (k: RowKey): RowKey => (k === frameKey ? ROOT_ROW_KEY : (k.slice(frameKey.length) as RowKey));
  const abs = (r: RowKey): RowKey => (r === ROOT_ROW_KEY ? frameKey : (`${frameKey}${r}` as RowKey));
  const source = top.frame.source;

  // The live tree: the instance's keyed nodes, and the frame root's.
  const liveRoot = findEntityByGuid(rec.rootGuid, world)?.id();
  if (!liveRoot) return null;
  const idOfKey = new Map<RowKey, number>();
  for (const [id, k] of instanceKeyMap(liveRoot)) idOfKey.set(k, id);
  const frameRootId = idOfKey.get(frameKey);
  if (!frameRootId) return null;

  // The frame's own nodes: what its documents supply, with no layer outside it.
  const empty: InstanceRecord = { rootGuid: '', source, placement: { parent: '', sortOrder: 0, name: '' }, list: { rows: new Map() }, held: {} };
  const own = foldInstance(editorPrefabReader, empty);
  // A Missing Prefab placeholder the frame's documents hold (a nested row whose prefab is gone) is the frame's too: the
  // copy shows it, and the records waiting inside it (`unresolved`) are carried as the frame's own rows.
  if (own.placeholders.has(ROOT_ROW_KEY)) return null;
  const inPlaceholder = (r: RowKey) => [...own.placeholders.keys()].some((p) => r === p || r.startsWith(`${p}/`));
  const members = new Set<RowKey>([...own.nodes.keys()]);
  const isOwn = (r: RowKey) => members.has(r) || inPlaceholder(r);

  // The layers outside, composed, on the frame's own nodes only (a node a layer outside added is plain in the copy).
  const rows = compose(layers);
  for (const k of [...rows.keys()]) if (!isOwn(k)) rows.delete(k);
  const root = rows.get(ROOT_ROW_KEY);
  if (root) {
    const ea = root.traits?.EntityAttributes;
    if (isBag(ea)) for (const f of PLACEMENT_FIELDS) delete ea[f];
    delete root.parent;
  }
  tidy(rows);

  // Checked: the composed list folds to exactly the nodes the frame shows, in the same places, with the same values.
  const placement = { parent: '', sortOrder: 0, name: '' };
  const promoted: InstanceRecord = { rootGuid: guidOfEntity(frameRootId), source, placement, list: { rows }, held: composeHeld(layers) };
  const inner = foldInstance(editorPrefabReader, promoted);
  const shown = [...outer.nodes.keys()].filter((k) => under(k) && members.has(rel(k)));
  if (shown.length !== inner.nodes.size) return null;
  // The same placeholders, in the same places, standing for the same rows.
  const shownPh = [...outer.placeholders.keys()].filter(under);
  if (shownPh.length !== inner.placeholders.size) return null;
  for (const k of shownPh) {
    const want = outer.placeholders.get(k)!, got = inner.placeholders.get(rel(k));
    if (!got || relParent(want.parent ?? null, frameKey) !== relParent(got.parent ?? null, '')) return null;
    if (want.source !== got.source || want.reason !== got.reason || want.name !== got.name || want.sortOrder !== got.sortOrder) return null;
  }
  for (const k of shown) {
    const want = outer.nodes.get(k)!, got = inner.nodes.get(rel(k));
    if (!got) return null;
    if (k !== frameKey && relParent(want.parent, frameKey) !== relParent(got.parent, '')) return null;
    for (const [t, data] of Object.entries(want.traits)) {
      if (t === 'EntityAttributes' && k === frameKey) continue; // the root's placement: the live copy's
      if (!sameJson(data, got.traits[t])) return null;
    }
    if (Object.keys(got.traits).some((t) => !(t in want.traits))) return null;
  }

  // The unused records under the frame (R2), each part as the scene states it, with the pin of a row whose member is gone:
  // the copy plan re-mints that identity (`keptGuidMints`) and the seat follows it.
  for (const u of outer.unused) {
    if (!under(u.key) || u.part.kind === 'own' || u.part.kind === 'legacy') continue;
    const from = rec.list.rows.get(u.key);
    if (!from) continue;
    const r = rel(u.key);
    let row = rows.get(r);
    if (!row) rows.set(r, (row = {}));
    const part = u.part;
    if (part.kind === 'field' || part.kind === 'trait') {
      const data = from.traits?.[part.trait];
      if (data === undefined) continue;
      const traits = (row.traits ??= {});
      if (part.kind === 'trait' || !isBag(data)) traits[part.trait] = clone(data);
      else ((traits[part.trait] ??= {}) as Bag)[part.field] = clone(data[part.field]);
    } else if (part.kind === 'traitRemoval') {
      if (from.traitRemovals?.[part.trait] !== undefined) (row.traitRemovals ??= {})[part.trait] = from.traitRemovals[part.trait]!;
    } else if (part.kind === 'removed') {
      if (typeof from.removed === 'boolean') row.removed = from.removed;
    } else if (part.kind === 'parent') {
      if (from.parent !== undefined) row.parent = clone(from.parent);
    }
    if (from.guid !== undefined && row.guid === undefined) { row.guid = from.guid; if (from.name !== undefined) row.name = from.name; }
  }

  // Then the live values of what the layers state: a template layer can state an entity ref as a member token, which the
  // copy shows resolved.
  for (const [r, row] of rows) {
    const id = idOfKey.get(abs(r));
    if (id === undefined || !row.traits) continue;
    for (const [t, bag] of Object.entries(row.traits)) {
      const meta = getTraitByName(t);
      if (!meta || !isBag(bag) || !findEntity(id)?.has(meta.trait)) continue;
      const live = readTraitDataFull(id, meta) as Bag | null;
      for (const f of Object.keys(bag)) if (live && f in live) bag[f] = clone(live[f]);
    }
  }
  // The user's nodes, and the nodes a layer outside added, hang in the copy as plain content: linked by `own` on the
  // member they hang under, in sibling order (as the save writes them).
  const ea = getTraitByName('EntityAttributes')!;
  const memberIds = new Map<number, RowKey>();
  for (const k of [...shown, ...shownPh]) { const id = idOfKey.get(k); if (id !== undefined) memberIds.set(id, rel(k)); }
  const links = new Map<RowKey, { guid: string; order: number }[]>();
  for (const e of world.entities) {
    const id = e.id();
    if (memberIds.has(id)) continue;
    const a = e.get(ea.trait) as { parentId?: number; sortOrder?: number; guid?: string } | undefined;
    const anchor = a?.parentId ? memberIds.get(a.parentId) : undefined;
    if (anchor === undefined || !a?.guid) continue;
    const list = links.get(anchor) ?? [];
    list.push({ guid: a.guid, order: a.sortOrder ?? 0 });
    links.set(anchor, list);
  }
  for (const [anchor, list] of links) {
    list.sort((x, y) => x.order - y.order || (x.guid < y.guid ? -1 : x.guid > y.guid ? 1 : 0));
    let row = rows.get(anchor);
    if (!row) rows.set(anchor, (row = {}));
    row.own = list.map(({ guid }) => ({ guid }));
  }
  // The nodes held under the frame's members, with the links that name them and the pin of the row they hang on.
  for (const [k, nodes] of heldHere) {
    const r = rel(k);
    let row = rows.get(r);
    if (!row) rows.set(r, (row = {}));
    const from = rec.list.rows.get(k);
    const links = (from?.own ?? []).filter((o) => heldGuids.has(o.guid)).map((o) => ({ ...o }));
    if (links.length) row.own = [...(row.own ?? []), ...links];
    if (from?.guid !== undefined && row.guid === undefined) { row.guid = from.guid; if (from.name !== undefined) row.name = from.name; }
    (promoted.held.heldOwn ??= new Map()).set(r, clone(nodes));
  }

  const attrs = findEntity(frameRootId)?.get(ea.trait) as { name?: string; sortOrder?: number; editorFolder?: string } | undefined;
  promoted.placement = {
    parent: '', sortOrder: attrs?.sortOrder ?? 0, name: attrs?.name ?? '',
    ...(attrs?.editorFolder ? { editorFolder: attrs.editorFolder } : {}),
  };
  return promoted;
}
