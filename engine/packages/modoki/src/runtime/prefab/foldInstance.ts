/**
 * `foldInstance`: (prefab chain, override list) → the instance's desired nodes (#2001 S2, #2007).
 *
 * Rule 2 (docs/prefabs.md § High-level rules): an instance IS its prefab plus its list, and ONE function says what that
 * is. This is that function's pure half; `realize` (S5) turns its output into entities. Design:
 * docs/plans/prefab-instance-model.md § 2.4 (how nested prefabs fold) and § 3.1, as amended by § 10.4 (unused causes).
 * Dead code at this commit: nothing calls it outside its tests.
 *
 * ── The algorithm (§ 2.4) ──
 * One FRAME per document expansion: the instance's own document at the top, one per nested reference row, one per
 * template-added reference node. A frame folds its LAYERS inner first, outer last:
 *   - a reference row's template list (its innermost layer), or a template reference node's `members`;
 *   - then every enclosing layer's records, descended one frame (`/<c>/…` → `/…`; `/<c>` → the frame root `/`).
 * The instance's own list is the outermost layer of every frame it reaches. Within one layer, records apply in today's
 * order (`foldMemberRowChannels`): the frame root's, each member's, then each template-added node's (`applyNodeRows`).
 * Per record: `traits` merge field by field, the later layer winning (rule 6); `traitRemovals` and `removed` set or clear;
 * `own` appends after whatever inner layers added. Token values are rebased per frame exactly as the spawner rebases them
 * (`rebaseMemberTokens` with the frame's segments).
 *
 * ── Unused (rules 7 and 9, § 10.4) ──
 * Reported for the instance's OWN list (and its `held`) only; a template list's leftovers are its prefab's business.
 * `gone`: the target is not in a loaded, intact chain — no such node, a node an inner layer removed, a removal with
 * nothing to act on, a legacy keyed move (#1883 C), a held legacy record whose localId names no row. `unresolved`: it
 * waits on a missing or damaged prefab. `unregistered`: a component this build does not register (I24). `unknownField`:
 * a field a registered component does not persist (rule 1, hub 2026-10-02, #2007). `heldNode`: a scene-owned node
 * whose anchor is not projected. Only `gone` and `unknownField` are removable (Remove Unused, S9).
 */
import { getTraitByName } from '../core/ecs/traitRegistry';
import { fieldFate } from '../loaders/overrideFate';
import { rebaseMemberTokens } from '../core/templateRefs';
import { parseSteps, type MemberStep } from '../core/assetRefRules';
import { rowPathInPrefab } from '../loaders/loadSceneFile';
import { emptyDocMap } from '../core/docKeys';
import {
  ROOT_ROW_KEY,
  type AddedNodeRef, type DesiredNode, type FoldedInstance, type InstanceRecord, type Placeholder, type PrefabDoc,
  type PrefabDocRow, type PrefabReader, type RecordPart, type RowKey, type TargetRecordOf, type TemplateAddedNode,
  type UnusedCause, type UnusedRecord,
} from './instanceRecord';
import { componentOf, frameOf, identityToKey, memberIdentities, parseTemplateLists, type Frame } from './parseInstanceRecord';
import { parseMemberToken } from '../core/templateRefs';

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Which components and fields this build registers. Default: the trait registry (`overrideFate`). */
export interface FoldSchema {
  component(name: string): boolean;
  field(trait: string, field: string): boolean;
}
const registrySchema: FoldSchema = {
  component: (name) => !!getTraitByName(name),
  field: (trait, field) => { const meta = getTraitByName(trait); return !!meta && fieldFate(meta, field) === 'applies'; },
};

export interface FoldOptions { schema?: FoldSchema }

type AnyRecord = TargetRecordOf<unknown>;
/** One layer's records, keyed RELATIVE to the frame it is handed to (`/` = that frame's root). `scene`: the instance's
 *  own list (the outermost layer, the only one whose leftovers are reported unused). */
interface Layer { rows: ReadonlyMap<RowKey, AnyRecord>; scene: boolean }

type Parent = DesiredNode['parent'];
interface NodeState {
  key: RowKey;
  traits: Record<string, Record<string, unknown> | true>;
  removedTraits: Set<string>;
  /** Who removed it last: no one, a template layer, or the instance's own list. */
  removedBy: 'none' | 'inner' | 'scene';
  parent: Parent;
  /** A legacy move's target: a scene guid (scene form), or the key a template move's member token names. */
  movedTo?: Parent;
  nodeGuid?: string;
  templateKey?: string;
  localId?: number;
  frame: { source: string; rootKey: RowKey };
  segments: MemberStep[][];
  /** What the layers UNDER the instance's own list left (for the unused-removal test), captured before it applies. */
  below?: { traits: Set<string>; removed: Set<string> };
}

interface State {
  read: PrefabReader;
  schema: FoldSchema;
  nodes: Map<RowKey, NodeState>;
  /** Insertion order of `nodes`, so sibling order is stable. */
  placeholders: Map<RowKey, Placeholder>;
  /** Scene-owned links, by the absolute key of the target they hang under, before the removal cascade. */
  links: Map<RowKey, AddedNodeRef[]>;
  /** Keys a frame repeats (two template nodes, one key): they name neither (`frameKeyIndex`). */
  ambiguous: Set<RowKey>;
  templateLists: Map<string, Map<number, ReadonlyMap<RowKey, AnyRecord>>>;
}

const absKey = (prefix: string, rel: RowKey): RowKey => (rel === ROOT_ROW_KEY ? (prefix || ROOT_ROW_KEY) : prefix + rel);

/** `layer` one frame down, into the frame whose row-key component is `component`. */
function descend(layer: Layer, component: string): Layer {
  const own = `/${component}`;
  const out = new Map<RowKey, AnyRecord>();
  for (const [k, r] of layer.rows) {
    if (k === own) out.set(ROOT_ROW_KEY, r);
    else if (k.startsWith(`${own}/`)) out.set(k.slice(own.length), r);
  }
  return { rows: out, scene: layer.scene };
}

function cleanTraits(traits: Record<string, unknown> | undefined): Record<string, Record<string, unknown> | true> {
  const out: Record<string, Record<string, unknown> | true> = emptyDocMap();
  for (const [t, data] of Object.entries(traits ?? {})) {
    if (t === 'PrefabInstance') continue;
    if (data === true) { out[t] = true; continue; }
    if (!isRecord(data)) continue;
    const d = { ...data };
    if (t === 'EntityAttributes') { delete d.parentId; delete d.guid; }
    out[t] = d;
  }
  return out;
}

/** The template list of every reference row of document `guid`, by localId (parsed once per document). */
function templateListsOf(st: State, doc: PrefabDoc, guid: string): Map<number, ReadonlyMap<RowKey, AnyRecord>> {
  let lists = st.templateLists.get(guid);
  if (!lists) {
    lists = new Map();
    for (const [lid, r] of parseTemplateLists(doc, guid, st.read).rows) lists.set(lid, r.list.rows as ReadonlyMap<RowKey, AnyRecord>);
    st.templateLists.set(guid, lists);
  }
  return lists;
}

function readDoc(st: State, guid: string): { doc: PrefabDoc } | Placeholder {
  const got = st.read(guid);
  if ('doc' in got) return got;
  return 'damaged' in got ? { source: guid, reason: 'damaged', text: got.damaged } : { source: guid, reason: 'missing' };
}

function addNode(st: State, n: NodeState): NodeState {
  st.nodes.set(n.key, n);
  return n;
}

/** Fold one frame. `root` is the frame root's place: its parent, and (a template reference node) its key. */
function foldFrame(
  st: State, f: Frame, layers: readonly Layer[], segments: MemberStep[][], root: { parent: Parent; templateKey?: string },
  /** The enclosing frames, outermost first: what a member token's `^` climbs. */
  outer: readonly Frame[] = [],
): void {
  const { doc, prefix, docGuid } = f;
  const parentOf = (row: PrefabDocRow): number => {
    const ea = row.traits?.EntityAttributes;
    return isRecord(ea) && typeof ea.parentId === 'number' ? ea.parentId : 0;
  };
  const keyOf = (lid: number): RowKey | null => (lid === f.rootLid ? absKey(prefix, ROOT_ROW_KEY) : f.byLid.has(lid) ? `${prefix}/${componentOf(f, lid)!}` : null);
  const placeOf = (row: PrefabDocRow, lid: number): Parent => {
    if (lid === f.rootLid) return root.parent;
    const p = keyOf(parentOf(row));
    // A row whose parent names no row hangs where the caller put the frame (`instantiatePrefabIntoWorld`'s second pass):
    // under the instance's parent at the top, and nowhere in a nested frame, which expands under parent 0.
    return p !== null ? { key: p } : prefix ? { guid: '' } : root.parent;
  };
  const lists = templateListsOf(st, doc, docGuid);
  const frameRef = { source: docGuid, rootKey: absKey(prefix, ROOT_ROW_KEY) };

  // 1. The document's rows: plain ones as nodes, nested reference rows as frames of their own.
  for (const row of doc.entities ?? []) {
    if (!row || typeof row.localId !== 'number') continue;
    const lid = row.localId;
    const key = keyOf(lid)!;
    if (row.prefab && lid !== f.rootLid) {
      const component = componentOf(f, lid)!;
      const child = readDoc(st, row.prefab);
      if (!('doc' in child)) { st.placeholders.set(key, child); continue; }
      const childLayers: Layer[] = [{ rows: lists.get(lid) ?? new Map(), scene: false }, ...layers.map((l) => descend(l, component))];
      foldFrame(st, frameOf(key, child.doc, row.prefab), childLayers, [...segments, rowPathInPrefab(doc as never, lid)], { parent: placeOf(row, lid) }, [...outer, f]);
      continue;
    }
    addNode(st, {
      key, traits: cleanTraits(row.traits), removedTraits: new Set(), removedBy: 'none', parent: placeOf(row, lid),
      ...(row.nodeGuid ? { nodeGuid: row.nodeGuid } : {}), localId: lid, frame: frameRef, segments,
      ...(lid === f.rootLid && root.templateKey ? { templateKey: root.templateKey } : {}),
    });
  }

  // 2. The layers, inner first.
  const nodeKeys = new Map<string, RowKey>(); // template key → its node's key in this frame
  const nestedRoots = new Set<RowKey>();
  for (const row of doc.entities ?? []) if (row?.prefab && typeof row.localId === 'number' && row.localId !== f.rootLid) nestedRoots.add(keyOf(row.localId)!);

  layers.forEach((layer) => {
    const apply = (key: RowKey, rec: AnyRecord, onlyRemoved = false): void => {
      const node = st.nodes.get(key);
      if (!node || st.ambiguous.has(key)) return;
      if (layer.scene && !node.below) node.below = { traits: new Set(Object.keys(node.traits)), removed: new Set(node.removedTraits) };
      if (typeof rec.removed === 'boolean') node.removedBy = rec.removed ? (layer.scene ? 'scene' : 'inner') : 'none';
      if (onlyRemoved) return;
      for (const [t, data] of Object.entries(rec.traits ?? {})) {
        if (data === true) { if (node.traits[t] === undefined) node.traits[t] = true; continue; }
        if (!isRecord(data)) continue;
        const cur = node.traits[t];
        node.traits[t] = { ...(isRecord(cur) ? cur : {}), ...data };
      }
      for (const [t, on] of Object.entries(rec.traitRemovals ?? {})) { if (on) node.removedTraits.add(t); else node.removedTraits.delete(t); }
      if (typeof rec.parent === 'string') {
        // Scene form: the new parent's guid. Template form: a member token from this frame's root (`^` climbs a frame),
        // resolved here; one that names no member leaves the node at its template place, as today's move drain does.
        const to = layer.scene ? { guid: rec.parent } : tokenParent(st, rec.parent, [...outer, f]);
        if (to) node.movedTo = to;
      }
      for (const own of rec.own ?? []) {
        if (layer.scene) { const refs = st.links.get(key) ?? []; refs.push(own as AddedNodeRef); st.links.set(key, refs); }
        else templateNode(own as TemplateAddedNode, key);
      }
    };
    /** A template-added node (and its subtree): keyed `a+<key>` flat in this frame (#1809). */
    const templateNode = (n: TemplateAddedNode, anchor: RowKey): void => {
      const key = `${prefix}/a+${n.key}`;
      if (!n.key || nodeKeys.has(n.key)) {
        // A key two nodes carry names neither (`frameKeyIndex`); a keyless one is addressable by nothing.
        if (n.key) st.ambiguous.add(key);
        return;
      }
      nodeKeys.set(n.key, key);
      if (n.prefab) {
        const child = readDoc(st, n.prefab);
        if (!('doc' in child)) { st.placeholders.set(key, child); return; }
        const own = new Map<RowKey, AnyRecord>(Object.entries(n.members ?? {}) as [RowKey, AnyRecord][]);
        // A template reference node's expansion is a call tree of its own: its tokens restart (`spawnReferenceNode`).
        foldFrame(st, frameOf(key, child.doc, n.prefab), [{ rows: own, scene: false }, ...layers.map((l) => descend(l, `a+${n.key}`))], [], { parent: { key: anchor }, templateKey: n.key }, [...outer, f]);
        return;
      }
      addNode(st, { key, traits: cleanTraits(n.traits as Record<string, unknown>), removedTraits: new Set(), removedBy: 'none', parent: { key: anchor }, templateKey: n.key, frame: frameRef, segments });
      for (const c of n.children ?? []) templateNode(c, key);
    };

    const rootRec = layer.rows.get(ROOT_ROW_KEY);
    // A frame root's `removed` is the enclosing frame's to apply (it deletes this whole instance).
    if (rootRec) apply(absKey(prefix, ROOT_ROW_KEY), { ...rootRec, removed: undefined });
    const nodeRows: [RowKey, AnyRecord][] = [];
    for (const [rel, rec] of layer.rows) {
      if (rel === ROOT_ROW_KEY || rel.indexOf('/', 1) > 0) continue;
      if (rel.startsWith('/a+')) { nodeRows.push([rel, rec]); continue; }
      const key = prefix + rel;
      apply(key, rec, nestedRoots.has(key));
    }
    for (const [rel, rec] of nodeRows) apply(prefix + rel, rec);
  });
}

/** Every record part a scene record states (identity pins are not overrides: never listed). */
function partsOf(rec: AnyRecord): RecordPart[] {
  const out: RecordPart[] = [];
  for (const [t, data] of Object.entries(rec.traits ?? {})) {
    if (isRecord(data) && Object.keys(data).length) for (const f of Object.keys(data)) out.push({ kind: 'field', trait: t, field: f });
    else out.push({ kind: 'trait', trait: t });
  }
  for (const t of Object.keys(rec.traitRemovals ?? {})) out.push({ kind: 'traitRemoval', trait: t });
  if (typeof rec.removed === 'boolean') out.push({ kind: 'removed' });
  for (const own of rec.own ?? []) out.push({ kind: 'own', guid: (own as AddedNodeRef).guid });
  if (typeof rec.parent === 'string') out.push({ kind: 'parent' });
  return out;
}

/** The fold. Pure: reads the record and the reader, writes nothing. */
export function foldInstance(read: PrefabReader, rec: InstanceRecord, opts: FoldOptions = {}): FoldedInstance {
  const st: State = {
    read, schema: opts.schema ?? registrySchema,
    nodes: new Map(), placeholders: new Map(), links: new Map(), ambiguous: new Set(), templateLists: new Map(),
  };
  const unused: UnusedRecord[] = [];
  const top = readDoc(st, rec.source);
  const scene: Layer = { rows: rec.list.rows as ReadonlyMap<RowKey, AnyRecord>, scene: true };
  if ('doc' in top) foldFrame(st, frameOf('', top.doc, rec.source), [scene], [], { parent: null });
  else st.placeholders.set(ROOT_ROW_KEY, top);

  // The removal cascade, through the final parent links.
  const removed = new Map<RowKey, 'inner' | 'scene'>();
  const cut = (key: RowKey, seen = new Set<RowKey>()): 'inner' | 'scene' | undefined => {
    if (removed.has(key)) return removed.get(key);
    const n = st.nodes.get(key);
    if (!n || seen.has(key)) return undefined;
    seen.add(key);
    const self = n.removedBy !== 'none' ? n.removedBy : undefined;
    const up = n.parent && 'key' in n.parent ? cut(n.parent.key, seen) : undefined;
    const r = self ?? up;
    if (r) removed.set(key, r);
    return r;
  };
  for (const key of st.nodes.keys()) cut(key);
  const underPlaceholder = (key: RowKey): boolean => {
    for (const p of st.placeholders.keys()) if (p === ROOT_ROW_KEY || key === p || key.startsWith(`${p}/`)) return true;
    return false;
  };

  // A scene move's guid that a row of the list pins names that row's member.
  const pins = new Map<string, RowKey>();
  for (const [key, r] of rec.list.rows) if (typeof r.guid === 'string') pins.set(r.guid, key);
  const pinned = (to: Parent): Parent => (to && 'guid' in to && pins.has(to.guid) ? { key: pins.get(to.guid)! } : to);

  // The desired nodes.
  const nodes = new Map<RowKey, DesiredNode>();
  for (const [key, n] of st.nodes) {
    if (removed.has(key)) continue;
    const traits: Record<string, Record<string, unknown> | true> = emptyDocMap();
    for (const [t, data] of Object.entries(n.traits)) {
      // A removal of a component this build does not register is no removal (I24): its data stays.
      if (n.removedTraits.has(t) && st.schema.component(t)) continue;
      traits[t] = data === true ? true : rebaseMemberTokens(data, n.segments) as Record<string, unknown>;
    }
    if (key === ROOT_ROW_KEY) {
      const ea = isRecord(traits.EntityAttributes) ? traits.EntityAttributes : {};
      traits.EntityAttributes = { ...ea, name: rec.placement.name, sortOrder: rec.placement.sortOrder, ...(rec.placement.editorFolder ? { editorFolder: rec.placement.editorFolder } : {}), ...(rec.placement.sourceScene ? { sourceScene: rec.placement.sourceScene } : {}) };
    }
    const ea = traits.EntityAttributes;
    const sortOrder = isRecord(ea) && typeof ea.sortOrder === 'number' ? ea.sortOrder : 0;
    nodes.set(key, {
      key, traits, parent: n.movedTo && !n.templateKey ? pinned(n.movedTo) : n.parent, sortOrder,
      ...(n.nodeGuid ? { nodeGuid: n.nodeGuid } : {}), ...(n.templateKey ? { templateKey: n.templateKey } : {}),
      ...(n.localId !== undefined ? { localId: n.localId } : {}), frame: n.frame,
    });
  }

  // Where each scene-owned node hangs; one whose anchor is not projected is held, not linked.
  const anchors = new Map<RowKey, AddedNodeRef[]>();
  for (const [key, refs] of st.links) {
    if (nodes.has(key)) anchors.set(key, refs);
    else for (const r of refs) unused.push({ key, part: { kind: 'own', guid: r.guid }, cause: 'heldNode' });
  }

  // The instance's own list: what does not apply.
  for (const [key, r] of rec.list.rows as ReadonlyMap<RowKey, AnyRecord>) {
    const parts = partsOf(r).filter((p) => p.kind !== 'own');
    if (!parts.length) continue;
    const n = st.nodes.get(key);
    const whole = (cause: UnusedCause): void => { for (const part of parts) unused.push({ key, part, cause }); };
    if (!n || st.ambiguous.has(key)) { whole(underPlaceholder(key) ? 'unresolved' : 'gone'); continue; }
    // A member a layer UNDER the instance's own list removed, and the list does not restore: its target is gone (#1914 R4).
    if (removed.get(key) === 'inner') { whole('gone'); continue; }
    for (const part of parts) {
      if (part.kind === 'field' || part.kind === 'trait') {
        if (!st.schema.component(part.trait)) { unused.push({ key, part, cause: 'unregistered' }); continue; }
        if (part.kind === 'field' && !st.schema.field(part.trait, part.field)) unused.push({ key, part, cause: 'unknownField' });
      } else if (part.kind === 'traitRemoval') {
        if (!st.schema.component(part.trait)) { unused.push({ key, part, cause: 'unregistered' }); continue; }
        const below = n.below ?? { traits: new Set(Object.keys(n.traits)), removed: new Set<string>() };
        const on = r.traitRemovals![part.trait];
        const takes = on ? below.traits.has(part.trait) && !below.removed.has(part.trait) : below.removed.has(part.trait);
        if (!takes) unused.push({ key, part, cause: 'gone' });
      } else if (part.kind === 'parent' && n.templateKey) {
        // A legacy move of a template-keyed node (#1883 ruling C): every reader ignores it, so it is unused.
        unused.push({ key, part, cause: 'gone' });
      }
    }
  }
  for (const u of heldUnused(st, rec, 'doc' in top ? top.doc : null)) unused.push(u);

  // A stable order (by key, then part, then cause), not the rows' insertion order: a legacy record and its v20 spelling
  // hold the same rows in a different order, and the two folds must agree (#2008 P2).
  const order = (u: UnusedRecord) => `${u.key}\u0000${JSON.stringify(u.part)}\u0000${u.cause}`;
  unused.sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
  return { nodes, placeholders: st.placeholders, unused, anchors };
}

/** The key a template move's member token names, from the innermost of `frames`; null when it names no member. */
function tokenParent(st: State, token: string, frames: readonly Frame[]): Parent | null {
  const t = parseMemberToken(token);
  if (!t || t.up >= frames.length) return null;
  const base = frames[frames.length - 1 - t.up]!;
  const id = memberIdentities(base.docGuid, {}, st.read).get(t.path.map(String).join('.'));
  const key = id === undefined ? null : identityToKey(base, id, st.read);
  return key === null ? null : { key };
}

/** The unused records `held` carries (§ 10.4; format rule, hub refinement 2026-10-02): every held legacy record (`gone`
 *  when the document resolves, since then its localId names no row; `unresolved` when it, or the nested path it runs
 *  through, does not), and every held scene-owned node (`heldNode`). */
function heldUnused(st: State, rec: InstanceRecord, doc: PrefabDoc | null): UnusedRecord[] {
  const out: UnusedRecord[] = [];
  const pending = rec.held.pendingLegacy as Record<string, unknown> | undefined;
  const pathCause = (path: string): UnusedCause => {
    if (!doc) return 'unresolved';
    let f = frameOf('', doc, rec.source);
    for (const step of parseSteps(path)) {
      const row = typeof step === 'number' && Number.isInteger(step) ? f.byLid.get(step) : undefined;
      if (!row?.prefab) return 'gone';
      const got = st.read(row.prefab);
      if (!('doc' in got)) return 'unresolved';
      f = frameOf(`${f.prefix}/${componentOf(f, step as number)}`, got.doc, row.prefab);
    }
    return 'gone';
  };
  for (const [channel, value] of Object.entries(pending ?? {})) {
    const cause = !doc ? 'unresolved' : 'gone';
    if (Array.isArray(value)) value.forEach((_v, i) => out.push({ key: ROOT_ROW_KEY, part: { kind: 'legacy', path: [channel, String(i)] }, cause }));
    else if (isRecord(value)) {
      for (const k of Object.keys(value)) {
        const c = !doc ? 'unresolved' : channel === 'nestedOverrides' || channel === 'nestedStructure' ? pathCause(k) : cause;
        out.push({ key: ROOT_ROW_KEY, part: { kind: 'legacy', path: [channel, k] }, cause: c });
      }
    } else out.push({ key: ROOT_ROW_KEY, part: { kind: 'legacy', path: [channel] }, cause });
  }
  for (const [key, nodes] of rec.held.heldOwn ?? []) for (const n of nodes) out.push({ key, part: { kind: 'own', guid: typeof n.guid === 'string' ? n.guid : '' }, cause: 'heldNode' });
  return out;
}
