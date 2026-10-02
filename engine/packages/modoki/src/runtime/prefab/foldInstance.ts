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
import { isMemberToken, parseMemberToken, rebaseMemberTokens } from '../core/templateRefs';
import { parseSteps, type MemberStep } from '../core/assetRefRules';
import { rowPathInPrefab } from '../loaders/loadSceneFile';
import { emptyDocMap } from '../core/docKeys';
import {
  HELD_REMAINDER, ROOT_ROW_KEY,
  type AddedNodeRef, type DesiredNode, type FoldedInstance, type InstanceRecord, type Placeholder, type PrefabDoc,
  type PrefabDocRow, type PrefabReader, type RecordPart, type RowKey, type TargetRecordOf, type TemplateAddedNode,
  type UnusedCause, type UnusedRecord,
} from './instanceRecord';
import { componentOf, frameOf, identityToKey, memberIdentities, parseTemplateLists, type Frame } from './parseInstanceRecord';

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
interface Layer {
  rows: ReadonlyMap<RowKey, AnyRecord>;
  scene: boolean;
  /** How many frames this layer was descended since it was stated: a member token in it is written from the frame
   *  it was STATED in, which is this many frames above the one it is handed to (#2007 review, item 5). */
  depth: number;
  /** The documents containing the frame whose document STATES this layer, outermost first (its own included): what a
   *  template-added reference node it carries is nested in, for the cycle check. Empty for the scene's. */
  home: readonly string[];
}

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
  /** Moved by the instance's own list to a scene guid: the removal cascade stops here, as today's `movedSet` stops it
   *  (`applyStructureCore`: "the cascade stops at a moved member"). A template move does not stop it. */
  sceneMoved?: boolean;
  /** A layer's move whose token names nothing: it still REPLACES every lower move of the member, which stays at its row,
   *  as today's drain chooses one move per member before resolving it (close-out review round 5). */
  stay?: boolean;
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
  placeholders: Map<RowKey, Placeholder & { parent: Parent }>;
  /** Scene-owned links, by the absolute key of the target they hang under, before the removal cascade. */
  links: Map<RowKey, AddedNodeRef[]>;
  /** A document's own v4 `moved` of its direct rows, resolved: the weakest move of a member, settled with the rest. */
  docMoves: Map<RowKey, Parent>;
  /** A placeholder's own `removed` record (it is a row key like any other), as `removedBy` is a node's. */
  placeholderRemovedBy: Map<RowKey, 'inner' | 'scene' | 'none'>;
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
  return { rows: out, scene: layer.scene, depth: layer.depth + 1, home: layer.home };
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

/** A nested document, refused when a document CONTAINING it is the same one: a prefab that contains itself (#2007
 *  review, item 6). Today's spawner refuses the cycle too (`instantiatePrefabIntoWorld`'s ancestor set); here the frame
 *  becomes a Damaged Prefab placeholder instead of recursing without end. `chain` is the documents that contain the
 *  statement — not the frames it HANGS in: a template-added reference node hangs in the nested frame it is anchored in,
 *  but is nested in the document that wrote it (fuzz seed 6: P's row R of Q adds a node of S, S nests Q — no cycle). */
function readChild(st: State, guid: string, chain: readonly string[]): { doc: PrefabDoc } | Placeholder {
  if (chain.includes(guid)) return { source: guid, reason: 'damaged', text: `prefab ${guid} contains itself` };
  return readDoc(st, guid);
}

function addNode(st: State, n: NodeState): NodeState {
  st.nodes.set(n.key, n);
  return n;
}

/** Fold one frame. `root` is the frame root's place: its parent, and (a template reference node) its key. */
function foldFrame(
  st: State, f: Frame, layers: readonly Layer[], segments: MemberStep[][],
  /** `orphan`: where a top-frame row whose parent names no row hangs — the instance's own parent, as today's second pass
   *  puts it — so `parent: null` means the instance root and nothing else (close-out review). */
  root: { parent: Parent; templateKey?: string; orphan?: Parent },
  /** The enclosing frames, outermost first: what a member token's `^` climbs. */
  outer: readonly Frame[] = [],
  /** The documents containing this frame, outermost first, its own included (`readChild`). */
  chain: readonly string[] = [f.docGuid],
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
    return p !== null ? { key: p } : prefix ? { guid: '' } : root.orphan ?? root.parent;
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
      const child = readChild(st, row.prefab, chain);
      if (!('doc' in child)) { st.placeholders.set(key, { ...child, parent: placeOf(row, lid) }); continue; }
      const childLayers: Layer[] = [{ rows: lists.get(lid) ?? new Map(), scene: false, depth: 0, home: chain }, ...layers.map((l) => descend(l, component))];
      foldFrame(st, frameOf(key, child.doc, row.prefab), childLayers, [...segments, rowPathInPrefab(doc as never, lid)], { parent: placeOf(row, lid) }, [...outer, f], [...chain, row.prefab]);
      continue;
    }
    addNode(st, {
      key, traits: cleanTraits(row.traits), removedTraits: new Set(), removedBy: 'none', parent: placeOf(row, lid),
      ...(row.nodeGuid ? { nodeGuid: row.nodeGuid } : {}), localId: lid, frame: frameRef, segments,
      ...(lid === f.rootLid && root.templateKey ? { templateKey: root.templateKey } : {}),
    });
  }

  // 1b. The document's own v4 `moved` of its DIRECT rows (member path → member token from this document's root): a row
  // moved under a nested instance's member, which `parentId` cannot name (#2009 F1, win seed 6858). Today's load applies
  // it, so it is the document's structure, under every layer. A move of a NESTED member is shared to its reference
  // row's list instead (`parseTemplateLists`); one naming no member leaves the row in place, as today's drain does.
  // The path is a member TREE path (`2.4`: row 4 under row 2), read as its identity; a token is read from this
  // document's root and no further (today's drain resolves a `^` here to nothing). Resolved here, settled with every
  // other move after the layers (`settleMoves`), as today's drain settles them in one queue.
  const moved = isRecord(doc.moved) ? Object.entries(doc.moved) : [];
  const ids = moved.length ? memberIdentities(docGuid, {}, st.read) : undefined;
  for (const [path, token] of moved) {
    const parts = ids?.get(path)?.split('/').filter(Boolean);
    if (typeof token !== 'string' || parts?.length !== 1 || !/^\d+$/.test(parts[0]!) || Number(parts[0]) === f.rootLid) continue;
    const key = keyOf(Number(parts[0]));
    const to = key === null ? null : tokenParent(st, token, [f]);
    if (to && key !== null) st.docMoves.set(key, to);
  }

  // 2. The layers, inner first.
  const nodeKeys = new Map<string, RowKey>(); // template key → its node's key in this frame
  // A frame root's records are applied INSIDE its frame; the frame that holds it applies only `removed` (item 9).
  const nestedRoots = new Set<RowKey>();
  for (const row of doc.entities ?? []) if (row?.prefab && typeof row.localId === 'number' && row.localId !== f.rootLid) nestedRoots.add(keyOf(row.localId)!);

  layers.forEach((layer) => {
    const apply = (key: RowKey, rec: AnyRecord, onlyRemoved = false): void => {
      const node = st.nodes.get(key);
      // A removal of a row whose prefab is missing still removes it: the placeholder goes, as the row would (close-out
      // review round 4: the user's own deletion came back as a placeholder).
      if (!node && st.placeholders.has(key) && typeof rec.removed === 'boolean') st.placeholderRemovedBy.set(key, rec.removed ? (layer.scene ? 'scene' : 'inner') : 'none');
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
        // A scene record states a guid; a member token there is a reference node's converted `templateMoved` (#2007
        // review, item 8), a template move like any other.
        const sceneMove = layer.scene && !isMemberToken(rec.parent);
        const to = sceneMove ? { guid: rec.parent } : tokenParent(st, rec.parent, [...outer, f], layer.depth);
        // A template-keyed node's legacy move is ignored (#1883 C): it neither moves it nor stops the cascade.
        if (to) { node.movedTo = to; node.sceneMoved = sceneMove && !node.templateKey; node.stay = false; }
        else { node.movedTo = undefined; node.sceneMoved = false; node.stay = true; }
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
        nestedRoots.add(key);
        const child = readChild(st, n.prefab, layer.home);
        if (!('doc' in child)) { st.placeholders.set(key, { ...child, parent: { key: anchor } }); return; }
        const own = new Map<RowKey, AnyRecord>(Object.entries(n.members ?? {}) as [RowKey, AnyRecord][]);
        // A template reference node's expansion is a call tree of its own: its tokens restart (`spawnReferenceNode`).
        foldFrame(st, frameOf(key, child.doc, n.prefab), [{ rows: own, scene: false, depth: 0, home: layer.home }, ...layers.map((l) => descend(l, `a+${n.key}`))], [], { parent: { key: anchor }, templateKey: n.key }, [...outer, f], [...layer.home, n.prefab]);
        return;
      }
      addNode(st, { key, traits: cleanTraits(n.traits as Record<string, unknown>), removedTraits: new Set(), removedBy: 'none', parent: { key: anchor }, templateKey: n.key, frame: frameRef, segments });
      for (const c of n.children ?? []) templateNode(c, key);
    };

    const rootRec = layer.rows.get(ROOT_ROW_KEY);
    // A frame root's `removed` is the enclosing frame's to apply (it deletes this whole instance).
    // The instance root's `parent` is no move: its place is the placement, which every reader keeps (#2022 item 3).
    if (rootRec) apply(absKey(prefix, ROOT_ROW_KEY), { ...rootRec, removed: undefined, ...(prefix ? {} : { parent: undefined }) });
    const nodeRows: [RowKey, AnyRecord][] = [];
    for (const [rel, rec] of layer.rows) {
      if (rel === ROOT_ROW_KEY || rel.indexOf('/', 1) > 0) continue;
      if (rel.startsWith('/a+')) { nodeRows.push([rel, rec]); continue; }
      const key = prefix + rel;
      apply(key, rec, nestedRoots.has(key));
    }
    for (const [rel, rec] of nodeRows) apply(prefix + rel, rec, nestedRoots.has(prefix + rel));
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
    nodes: new Map(), placeholders: new Map(), links: new Map(), docMoves: new Map(), placeholderRemovedBy: new Map(), ambiguous: new Set(), templateLists: new Map(),
  };
  const unused: UnusedRecord[] = [];
  const top = readDoc(st, rec.source);
  const scene: Layer = { rows: rec.list.rows as ReadonlyMap<RowKey, AnyRecord>, scene: true, depth: 0, home: [] };
  if ('doc' in top) foldFrame(st, frameOf('', top.doc, rec.source), [scene], [], { parent: null, orphan: { guid: rec.placement.parent } });
  else st.placeholders.set(ROOT_ROW_KEY, { ...top, parent: null });
  // A scene row's member-token parent, held (#2022 items 5-6): today's drain still takes it as the member's one move,
  // and it names nothing — the member stays, over every lower move.
  const heldRows = (rec.held.pendingLegacy as { members?: Record<string, unknown> } | undefined)?.members ?? {};
  for (const [k, row] of Object.entries(heldRows)) {
    const n = isRecord(row) && typeof row.parent === 'string' ? st.nodes.get(k) : undefined;
    if (n) { n.movedTo = undefined; n.sceneMoved = false; n.stay = true; }
  }

  // The removal cascade, through the final parent links.
  const removed = new Map<RowKey, 'inner' | 'scene'>();
  const cut = (key: RowKey, seen = new Set<RowKey>()): 'inner' | 'scene' | undefined => {
    if (removed.has(key)) return removed.get(key);
    const n = st.nodes.get(key);
    if (seen.has(key)) return undefined;
    // A placeholder is a row like any other: its own removal, or its parent's, takes what hangs under it (#2022 item 2:
    // a plain row under a removed missing-prefab row kept a parent that names nothing).
    const ph = n ? undefined : st.placeholders.get(key);
    if (ph) {
      seen.add(key);
      const self = st.placeholderRemovedBy.get(key);
      const up = ph.parent && 'key' in ph.parent ? cut(ph.parent.key, seen) : undefined;
      return up === 'scene' ? up : (self && self !== 'none' ? self : undefined) ?? up;
    }
    if (!n) return undefined;
    seen.add(key);
    const self = n.removedBy !== 'none' ? n.removedBy : undefined;
    const up = !n.sceneMoved && n.parent && 'key' in n.parent ? cut(n.parent.key, seen) : undefined;
    // The instance's own removal anywhere on the way up covers what an inner one removed too (rule 3; #2022 review).
    const r = up === 'scene' ? up : self ?? up;
    if (r) removed.set(key, r);
    return r;
  };
  for (const key of st.nodes.keys()) cut(key);
  // A placeholder hangs where its row would: under a removed member it goes with it (#2007 review, item 3).
  const cutPlaceholders = new Map<RowKey, 'inner' | 'scene'>();
  const cutParent = new Map<RowKey, Parent>();
  for (const [key, ph] of [...st.placeholders]) {
    const r = cut(key);
    if (r) { cutPlaceholders.set(key, r); cutParent.set(key, ph.parent); }
  }
  for (const key of cutPlaceholders.keys()) st.placeholders.delete(key);
  const underCut = (key: RowKey): 'inner' | 'scene' | undefined => {
    for (const [p, r] of cutPlaceholders) if (key === p || key.startsWith(`${p}/`)) return r;
    return undefined;
  };
  const underPlaceholder = (key: RowKey): boolean => {
    for (const p of st.placeholders.keys()) if (p === ROOT_ROW_KEY || key === p || key.startsWith(`${p}/`)) return true;
    return false;
  };

  // A scene move's guid that a row of the list pins names that row's member.
  const pins = new Map<string, RowKey>();
  for (const [key, r] of rec.list.rows) if (typeof r.guid === 'string') pins.set(r.guid, key);
  const pinned = (to: Parent): Parent => (to && 'guid' in to && pins.has(to.guid) ? { key: pins.get(to.guid)! } : to);

  // Every move settles as today's drain settles them, in ONE queue (`loadSceneFile`, #1452), close-out review round 3:
  // one move per member — the instance's own over any prefab's, an outer prefab's over an inner's (a layer's `movedTo`,
  // the last layer's winning), a document's own `moved` weakest — each resolved before any applies. One whose target
  // still sits inside the member waits for the others; one still waiting when nothing else can move is a cycle,
  // refused as `moveMember` refuses it, and the member stays at its row.
  const parentOf = new Map<RowKey, Parent>();
  for (const [k, n] of st.nodes) parentOf.set(k, n.parent);
  for (const [k, ph] of st.placeholders) parentOf.set(k, ph.parent);
  const insideOf = (to: Parent, key: RowKey): boolean => {
    let p: Parent | undefined = to;
    for (let i = 0; p && 'key' in p && i < 100_000; i++) { if (p.key === key) return true; p = parentOf.get(p.key); }
    return false;
  };
  // A move FAILS when its target is no surviving node (removed, a placeholder, nothing): the member stays at its row,
  // and if that row is going with a removed ancestor — the member outlived the cascade only by moving — it is lifted to
  // the nearest ancestor that stays, as `settleMove` lifts it (close-out review round 5). A guid outside the instance
  // is the realize's to judge, not the fold's.
  const alive = (to: Parent): boolean => !to || !('key' in to) || (st.nodes.has(to.key) && !removed.has(to.key));
  const fail = (k: RowKey): void => {
    // Up through every removed row, a cut placeholder included (#2022 review: the lift stopped on one).
    let p = st.nodes.get(k)?.parent;
    for (let i = 0; p && 'key' in p && (removed.has(p.key) || cutParent.has(p.key)) && i < 100_000; i++) p = st.nodes.get(p.key)?.parent ?? cutParent.get(p.key);
    // `null` is the instance root's place (the placement): kept, never read as "the root" (final review: a failed root
    // move made the root its own parent).
    parentOf.set(k, p === undefined ? { key: ROOT_ROW_KEY } : p);
  };
  let pendingMoves: [RowKey, Parent][] = [];
  for (const [k, n] of st.nodes) {
    if (removed.has(k)) continue;
    const to = n.movedTo && !n.templateKey ? pinned(n.movedTo) : n.stay ? undefined : st.docMoves.get(k);
    if (to) pendingMoves.push([k, to]);
  }
  for (let progressed = true; progressed;) {
    progressed = false;
    pendingMoves = pendingMoves.filter(([k, to]) => {
      if (!alive(to)) { fail(k); progressed = true; return false; }
      if (insideOf(to, k)) return true;
      parentOf.set(k, to);
      progressed = true;
      return false;
    });
  }
  for (const [k] of pendingMoves) fail(k);

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
      key, traits, parent: parentOf.get(key) ?? n.parent, sortOrder,
      ...(n.nodeGuid ? { nodeGuid: n.nodeGuid } : {}), ...(n.templateKey ? { templateKey: n.templateKey } : {}),
      ...(n.localId !== undefined ? { localId: n.localId } : {}), frame: n.frame,
    });
  }

  // Where each scene-owned node hangs (#2018: every own link is projected or held, never neither). Its anchor, when
  // projected. Else, anchored AT a placeholder no removal cut, that placeholder: today shows these nodes — under the
  // instance root where a missing nested row spawns nothing (ruling D), under the copy's root where the scene held one
  // (ruling B) — and the placeholder is what stands there now. One anchored INSIDE a placeholder's frame waits with
  // every record there (`unresolved`, U9): today shows it only where an ignored scene copy happened to hold its anchor
  // (ruling B's change; observed on #2018). Anything else is held (`heldNode`): a gone member's nodes, which today keeps
  // and does not show.
  // A link on a key no frame applies (nothing projects it, or it lies inside a placeholder frame) never reached `apply`:
  // it is taken from the list itself, so none is dropped.
  const seenLink = new Set([...st.links].flatMap(([k, refs]) => refs.map((r) => `${k}\u0000${r.guid}`)));
  for (const [key, r] of rec.list.rows as ReadonlyMap<RowKey, AnyRecord>) {
    for (const own of (r.own ?? []) as AddedNodeRef[]) {
      if (seenLink.has(`${key}\u0000${own.guid}`)) continue;
      seenLink.add(`${key}\u0000${own.guid}`);
      st.links.set(key, [...(st.links.get(key) ?? []), own]);
    }
  }
  const anchors = new Map<RowKey, AddedNodeRef[]>();
  const hang = (key: RowKey, refs: readonly AddedNodeRef[]): void => { anchors.set(key, [...(anchors.get(key) ?? []), ...refs]); };
  for (const [key, refs] of st.links) {
    if (nodes.has(key)) { hang(key, refs); continue; }
    if (st.placeholders.has(key) && !underCut(key)) { hang(key, refs); continue; }
    const cause: UnusedCause = underPlaceholder(key) && !underCut(key) ? 'unresolved' : 'heldNode';
    for (const r of refs) unused.push({ key, part: { kind: 'own', guid: r.guid }, cause });
  }

  // The instance's own list: what does not apply.
  for (const [key, r] of rec.list.rows as ReadonlyMap<RowKey, AnyRecord>) {
    const parts = partsOf(r).filter((p) => p.kind !== 'own');
    if (!parts.length) continue;
    const n = st.nodes.get(key);
    const whole = (cause: UnusedCause): void => { for (const part of parts) unused.push({ key, part, cause }); };
    // Under a placeholder the cascade took: the instance's own removal keeps its records (rule 3), an inner one is gone.
    const cutBy = underCut(key);
    if (cutBy === 'scene') continue;
    if (cutBy === 'inner') { whole('gone'); continue; }
    if (!n || st.ambiguous.has(key)) {
      // A removal AT a placeholder row targets the reference ROW, in a document that loaded: it decides whether the
      // placeholder shows, so it is applied, never unused — as `removed: true` there is (cut, inert; #2024, hub ruling).
      const atPlaceholder = !n && st.placeholders.has(key);
      for (const part of parts) if (!(atPlaceholder && part.kind === 'removed')) unused.push({ key, part, cause: underPlaceholder(key) ? 'unresolved' : 'gone' });
      continue;
    }
    // A member a layer UNDER the instance's own list removed, and the list does not restore: its target is gone (#1914 R4).
    if (removed.get(key) === 'inner') { whole('gone'); continue; }
    // Under the instance's OWN removal a record is inert, kept and not removable (rule 3, G2; #2022 item 4): only a
    // cause Remove Unused never takes is still reported.
    const inert = removed.get(key) === 'scene';
    for (const part of parts) {
      if (part.kind === 'field' || part.kind === 'trait') {
        if (!st.schema.component(part.trait)) { unused.push({ key, part, cause: 'unregistered' }); continue; }
        if (part.kind === 'field' && !inert && !st.schema.field(part.trait, part.field)) unused.push({ key, part, cause: 'unknownField' });
      } else if (part.kind === 'traitRemoval') {
        if (!st.schema.component(part.trait)) { unused.push({ key, part, cause: 'unregistered' }); continue; }
        const below = n.below ?? { traits: new Set(Object.keys(n.traits)), removed: new Set<string>() };
        const on = r.traitRemovals![part.trait];
        const takes = on ? below.traits.has(part.trait) && !below.removed.has(part.trait) : below.removed.has(part.trait);
        if (!takes && !inert) unused.push({ key, part, cause: 'gone' });
      } else if (part.kind === 'parent' && key === ROOT_ROW_KEY) {
        // The root's own `parent`: names nothing every reader takes (#2022 item 3, "never neither").
        unused.push({ key, part, cause: 'gone' });
      } else if (part.kind === 'parent' && n.templateKey && !inert) {
        // A legacy move of a template-keyed node (#1883 ruling C): every reader ignores it, so it is unused.
        unused.push({ key, part, cause: 'gone' });
      }
    }
  }
  for (const u of heldUnused(st, rec, 'doc' in top ? top.doc : null, underCut, (k) => removed.get(k))) unused.push(u);

  // A stable order (by key, then part, then cause), not the rows' insertion order: a legacy record and its v20 spelling
  // hold the same rows in a different order, and the two folds must agree (#2008 P2).
  const order = (u: UnusedRecord) => `${u.key}\u0000${JSON.stringify(u.part)}\u0000${u.cause}`;
  unused.sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
  return { nodes, placeholders: st.placeholders, unused, anchors };
}

/** The key a template move's member token names, from the innermost of `frames`; null when it names no member. */
function tokenParent(st: State, token: string, frames: readonly Frame[], depth = 0): Parent | null {
  const t = parseMemberToken(token);
  if (!t || depth + t.up >= frames.length) return null;
  const base = frames[frames.length - 1 - depth - t.up]!;
  const id = memberIdentities(base.docGuid, {}, st.read).get(t.path.map(String).join('.'));
  const key = id === undefined ? null : identityToKey(base, id, st.read);
  return key === null ? null : { key };
}

/** The unused records `held` carries (§ 10.4; format rule, hub refinement 2026-10-02): every held legacy record (`gone`
 *  when the document resolves, since then its localId names no row; `unresolved` when it, or the nested path it runs
 *  through, does not), and every held scene-owned node (`heldNode`). */
function heldUnused(
  st: State, rec: InstanceRecord, doc: PrefabDoc | null,
  /** The removal cascade's verdict on a placeholder frame it took (rule 3: the instance's own removal keeps records). */
  underCut: (key: RowKey) => 'inner' | 'scene' | undefined,
  /** The cascade's verdict on a node: under the instance's own removal a held row is inert too (#2022 review). */
  removedBy: (key: RowKey) => 'inner' | 'scene' | undefined = () => undefined,
): UnusedRecord[] {
  const out: UnusedRecord[] = [];
  const pending = rec.held.pendingLegacy as Record<string, unknown> | undefined;
  const pathCause = (path: string): UnusedCause | null => {
    if (!doc) return 'unresolved';
    let f = frameOf('', doc, rec.source);
    for (const step of parseSteps(path)) {
      const row = typeof step === 'number' && Number.isInteger(step) ? f.byLid.get(step) : undefined;
      if (!row?.prefab) return 'gone';
      const cut = underCut(`${f.prefix}/${componentOf(f, step as number)}`);
      if (cut) return cut === 'scene' ? null : 'gone';
      const got = st.read(row.prefab);
      if (!('doc' in got)) return 'unresolved';
      f = frameOf(`${f.prefix}/${componentOf(f, step as number)}`, got.doc, row.prefab);
    }
    return 'gone';
  };
  /** A held value that names a prefab the reader cannot give WAITS on it (a reference copy held because its prefab is
   *  missing): `unresolved`, which Remove Unused never takes (rules 7 and 9; #2007 review, item 7). */
  const waits = (v: unknown, depth = 0): boolean => {
    if (depth > 64) return false;
    if (Array.isArray(v)) return v.some((x) => waits(x, depth + 1));
    if (!isRecord(v)) return false;
    if (typeof v.prefab === 'string' && v.prefab && !('doc' in st.read(v.prefab))) return true;
    return Object.values(v).some((x) => waits(x, depth + 1));
  };
  /** A held member row (its whole lists held, the target unnameable): under a placeholder it waits, `unresolved`; under
   *  the instance's own removal it is kept unreported (rule 3); otherwise its target is gone. */
  const rowCause = (k: RowKey): UnusedCause | null => {
    const cut = underCut(k);
    if (cut === 'scene' || removedBy(k) === 'scene') return null;
    if (cut === 'inner') return 'gone';
    return [...st.placeholders.keys()].some((p) => k === p || k.startsWith(`${p}/`)) ? 'unresolved' : 'gone';
  };
  /** The frame prefix a held slot's member path names, or null when a step does not resolve. */
  const framePrefix = (path: string): string | null => {
    if (!doc) return null;
    let f = frameOf('', doc, rec.source);
    for (const step of parseSteps(path)) {
      const row = typeof step === 'number' && Number.isInteger(step) ? f.byLid.get(step) : undefined;
      const got = row?.prefab ? st.read(row.prefab) : undefined;
      if (!got || !('doc' in got)) return null;
      f = frameOf(`${f.prefix}/${componentOf(f, step as number)}`, got.doc, row!.prefab!);
    }
    return f.prefix;
  };
  /** A record is keyed by the TARGET it stands for (§ 2; hub ruling 2026-10-02, #2016): a held reference copy stands for
   *  the keyed node `<frame>/a+<key>` of the list it was stated in, so it is one record there, part path `[…, 'added',
   *  i]`. The rest of its container (its other lists, its marker aside) stays one record at the root, as before. */
  const container = (path: string[], held: Record<string, unknown>, prefix: string | null, c: UnusedCause, restKey: RowKey = ROOT_ROW_KEY): void => {
    const added = Array.isArray(held.added) ? held.added : undefined;
    added?.forEach((el, i) => {
      const at = [...path, 'added', String(i)];
      if (!(isRecord(el) && typeof el.key === 'string' && el.key)) {
        // A keyless node is a SCENE-OWNED one: the user's own, kept and never removable (`heldNode`; under a placeholder,
        // `unresolved` with everything there) — never `gone`, whatever its anchor (close-out review round 5).
        out.push({ key: restKey, part: { kind: 'legacy', path: at }, cause: c === 'unresolved' ? 'unresolved' : 'heldNode' });
        return;
      }
      const key = prefix !== null ? `${prefix}/a+${el.key}` : restKey;
      // A copy held while the node it stands for SHOWS (a statement it carries names nothing, or a `templateMoved` no
      // record can carry) did not lose its target: it waits, kept, never `gone` (close-out review round 2).
      const cause = of(el, c);
      out.push({ key, part: { kind: 'legacy', path: at }, cause: cause === 'gone' && prefix !== null && st.nodes.has(key) ? 'unresolved' : cause });
    });
    // A held list stating no element is still a held statement: reported, not invisible.
    if (added && !added.length) out.push({ key: restKey, part: { kind: 'legacy', path: [...path, 'added'] }, cause: c });
    const rest = Object.keys(held).filter((k) => k !== HELD_REMAINDER && !(added && k === 'added'));
    // Once the copies are split out, the rest is one record per field, so no record's path contains another's.
    if (added) for (const k of rest) out.push({ key: restKey, part: { kind: 'legacy', path: [...path, k] }, cause: of(held[k], c) });
    else if (rest.length) out.push({ key: restKey, part: { kind: 'legacy', path }, cause: of(held, c) });
  };
  const of = (v: unknown, c: UnusedCause): UnusedCause => (c === 'gone' && waits(v) ? 'unresolved' : c);
  for (const [channel, value] of Object.entries(pending ?? {})) {
    if (channel === HELD_REMAINDER) continue;
    const cause = !doc ? 'unresolved' : 'gone';
    if (Array.isArray(value)) value.forEach((v, i) => out.push({ key: ROOT_ROW_KEY, part: { kind: 'legacy', path: [channel, String(i)] }, cause: of(v, cause) }));
    else if (isRecord(value)) {
      for (const [k, v] of Object.entries(value)) {
        const c = !doc ? 'unresolved' : channel === 'nestedOverrides' || channel === 'nestedStructure' ? pathCause(k) : channel === 'members' ? rowCause(k) : cause;
        if (c === null) continue;
        if (!isRecord(v) || (channel !== 'members' && channel !== 'nestedStructure')) {
          out.push({ key: ROOT_ROW_KEY, part: { kind: 'legacy', path: [channel, k] }, cause: of(v, c) });
          continue;
        }
        const n = channel === 'members' ? st.nodes.get(k) : undefined;
        // A row at a placeholder frame root (its prefab missing) anchors that frame's keyed nodes, as a node would.
        const prefix = channel === 'members' ? (n ? (n.frame.rootKey === ROOT_ROW_KEY ? '' : n.frame.rootKey) : st.placeholders.has(k) ? k : null) : framePrefix(k);
        // A held member row is keyed at its own row: it is that target's record (§ 2), kept verbatim.
        container([channel, k], v, prefix, c, channel === 'members' ? k : ROOT_ROW_KEY);
      }
    } else out.push({ key: ROOT_ROW_KEY, part: { kind: 'legacy', path: [channel] }, cause: of(value, cause) });
  }
  for (const [key, nodes] of rec.held.heldOwn ?? []) for (const n of nodes) out.push({ key, part: { kind: 'own', guid: typeof n.guid === 'string' ? n.guid : '' }, cause: 'heldNode' });
  return out;
}
