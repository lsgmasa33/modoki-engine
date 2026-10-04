/** prefabBase — the ONE answer to "what does this frame show with no edit of its own?" (#1693, invariants I1–I3).
 *
 *  An instance is its template folded with every ENCLOSING layer — the reference rows above it, or the template
 *  reference node that spawned it — from the outside in (docs/prefabs.md § "Model and invariants"). Before #1693 each
 *  surface composed that itself: the override list and Revert through `enclosingLayer`, the save and the rebuild through
 *  two unseeded top-down walks (`resolveEffectivePrefabOverride` / `…Structure`), each level read from the CACHE. So a
 *  component an enclosing row added was invisible to the capture's removed-components pass (#1676), and Apply wrote
 *  against the bare child document (#1658).
 *
 *  {@link frameBase} climbs by identity (`ownerOf`, #1691), reads every level from the FRAME RECORD — the document that
 *  level was expanded from — and folds with the runtime's own folds (`prefabOverrides.ts`), exactly as the editor's
 *  expansion does (`instantiatePrefab`): a row's fields under the outer layer's forwarded ones, then every layer's member
 *  rows over those. {@link chainLayer} is the same fold from a stored root the caller names, for the writers that walk
 *  down from one (the save, the rebuild). */

import { rowAt } from '../../runtime/core/prefabRowAt';
import { hasDocKey } from '../../runtime/core/docKeys';
import { getCurrentWorld } from '../../runtime/core/ecs/world';
import { worldIdentityParents, frameRootDoc } from '../../runtime/core/ecs/identityParents';
import { getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { readTraitData, findEntity, getAllEntities } from '../../runtime/core/ecs/entityUtils';
import { isStoredRoot, isOwnedRoot, type MemberPi } from '../../runtime/core/assetRefRules';
import { templateKeyOf } from '../../runtime/core/templateIdentity';
import { foldStructureLayers, foldPath as sharedFoldPath, type OverrideMap, type StructureLayer, type FoldDoc, type ForwardState as SharedForwardState, referenceRowAt, ownRootRow } from '../../runtime/loaders/prefabOverrides';
import type { AddedEntity, NestedStructureDelta, SceneMemberRow } from '../../runtime/loaders/loadSceneFile';
import { type PrefabFile, valuesEqual } from './prefab';
import { getCachedPrefabSync, recoverTemplateKey } from './prefabCache';
import { addCaptureKey, overrideKeysOf } from '../instance/instanceOverrideView';

/** A layer's structural lists, as the fold leaves them for the frame it reaches. `moved` only when an outer layer's
 *  whole-frame slot addressed the frame (it owns the frame's moves then). */
export interface LayerStructure {
  added?: AddedEntity[];
  removed?: number[];
  removedTraits?: Record<number, string[]>;
  moved?: Record<number, string>;
}

/** A layer's three structural lists, every one present. */
export interface LayerLists {
  added: AddedEntity[];
  removed: number[];
  removedTraits: Record<number, string[]>;
}

/** What the layers ENCLOSING a frame author on it: fields and structure, member tokens unresolved. */
export interface FrameLayer {
  overrides: OverrideMap;
  structure: LayerLists;
}

/** How one level of a chain hangs off the level above it. */
export type LevelStep =
  | { kind: 'top' }                    // a stored root: a scene instance, a node the SCENE added, a template node's own frame
  | { kind: 'row'; row: number };      // the expansion of row `row` (a localId of the level above's document)

export interface FrameLevel {
  /** The live frame root at this level. */
  root: number;
  source: string;
  /** The document this level was EXPANDED from: its frame record, else the cache. Null when neither has it. */
  doc: PrefabFile | null;
  fromRecord: boolean;
  step: LevelStep;
}

export interface FrameBase {
  frame: number;
  /** Outermost first; the last level's `root` is `frame`. The first level is a stored root. */
  levels: FrameLevel[];
  /** The frame's own document (the last level's). */
  doc: PrefabFile | null;
  /** The template REFERENCE node that spawned the first level (#1506), when one did. */
  node: AddedEntity | null;
  /** Everything enclosing the frame, folded. Null for a stored root nothing encloses. */
  layer: FrameLayer | null;
}

/** The document the live frame root `root` (an instance of `source`) was expanded from — its own frame record, read
 *  only for the source it was recorded under (a root re-tagged by Create Prefab keeps a record of its old prefab) —
 *  else the cache. I3: a capture measures a frame against what built it, not whatever the cache holds now. */
export function levelDoc(root: number, source: string): { doc: PrefabFile | null; fromRecord: boolean } {
  const entity = root ? findEntity(root) : undefined;
  const rec = entity ? frameRootDoc(getCurrentWorld(), entity) : undefined;
  if (rec && rec.source === source) return { doc: rec.doc as PrefabFile, fromRecord: true };
  return { doc: getCachedPrefabSync(source), fromRecord: false };
}

/** The document a WRITER captures the live frame root `root` (an instance of `source`) against: the cache, else the
 *  frame's own record (#1738). A prefab that stopped resolving mid-session (its caches evicted with no reload) is a
 *  reference the writer cannot read, and I18 says it writes back the record it was loaded with: the frame record IS that
 *  record, the document the frame was expanded from. Without it the writers flattened, dropped or truncated the
 *  instance. The cache comes first, so a capture that works today reads the bytes it always read. */
export function captureDoc(root: number, source: string): PrefabFile | null {
  return getCachedPrefabSync(source) ?? levelDoc(root, source).doc;
}

/** What the layers above a frame FORWARD into its expansion — its `nestedOverrides`, its `layers`, and what those forward
 *  to its nested roots, as the expansion of the row above hands them to it. The shared fold's (`prefabOverrides.ts`, #1707). */
export type ForwardState = SharedForwardState<NestedStructureDelta, SceneMemberRow>;

/** The forward state a template REFERENCE node hands the expansion of its frame, whose document is `doc`: its path-keyed
 *  channels and its member rows, as the one spawner hands them (`spawnReferenceNode`). */
export function nodeForward(node: AddedEntity, doc: PrefabFile | null): ForwardState {
  const layers: StructureLayer<NestedStructureDelta, SceneMemberRow>[] = [{ slots: node.nestedStructure, rows: node.members, ...ownRootRow(node.members), valuePaths: node.nestedOverrides }];
  return {
    layers,
    forwardRoots: node.members && doc ? foldStructureLayers(doc, layers, 0, {}).forwardRoots : [],
  };
}

/** The VALUES a template reference node states about its own frame's members on its rows (prefab v10, #2001 S6): a member
 *  row's `traits`, and the `"/"` row's for the root, by localId of `doc`. A v9 node stated them in `overrides`, which is
 *  all a reader of the node's root layer looked at. A nested root's row is not here: the fold forwards it to that root's
 *  own expansion ({@link nodeForward}'s `forwardRoots`). */
export function nodeRowValues(node: AddedEntity, doc: PrefabFile | null): OverrideMap {
  if (!node.members || !doc) return {};
  return foldStructureLayers(doc, [{ rows: node.members, ...ownRootRow(node.members) }], 0, {}).channels.overrides ?? {};
}

/** The fold ITSELF (`prefabOverrides.ts` `foldPath`, #1707 — the step the validator and the UIEntries pool share): everything
 *  the layers above a frame state about it, walking `path` (row localIds, outermost first) down from a first level whose
 *  document is `docs[0]`. `seed` is what a layer above the first level forwards into it: a template reference node's
 *  channels ({@link nodeForward}), or the whole state above a nested frame a rebuild re-expands ({@link frameForward}). */
function foldPath(
  docs: readonly (PrefabFile | null)[],
  path: readonly number[],
  seed?: ForwardState,
): { overrides: OverrideMap; structure: LayerStructure; forward: ForwardState | null } {
  return sharedFoldPath<AddedEntity, NestedStructureDelta, SceneMemberRow>(docs as readonly (FoldDoc<AddedEntity, NestedStructureDelta, SceneMemberRow> | null)[], path, seed);
}

/** {@link foldPath} from the frame `top` down `path`: the layer the prefab chain puts on the nested frame `path`
 *  reaches. Each level's document is its live frame's record where the frame is live (found by descending the row
 *  partition), else the cache. `topDoc` pins the first level's document when the caller knows better than the record —
 *  a rebuild measuring against the document the tree was built from while the cache already holds the new one. `seed`
 *  is what the layers ENCLOSING `top` forward into it ({@link frameForward}), when `top` is not a stored root nothing
 *  encloses: the rebuild expands `top` under that state, so its nested capture has to subtract it too (#1737). */
export function chainLayer(
  top: number, source: string, path: readonly number[], topDoc?: PrefabFile | null, seed?: ForwardState,
): { overrides: OverrideMap; structure: LayerStructure } {
  const docs: (PrefabFile | null)[] = [topDoc !== undefined ? topDoc : levelDoc(top, source).doc];
  let at = top;
  for (let i = 0; i < path.length; i++) {
    const row = referenceRowAt(docs[i], path[i]);
    if (!row) break;
    at = at ? ownedRootAt(at, path[i]!) : 0;
    docs.push(at ? levelDoc(at, row.prefab!).doc : getCachedPrefabSync(row.prefab!));
  }
  return foldPath(docs, path, seed);
}

/** {@link foldPath} over DOCUMENTS alone — the first given, each deeper one read from the cache — for a caller whose
 *  levels are not live frames. Only Apply's pose base for a member moved out of a nested frame (`layerPose`) asks it. */
export function docChainLayer(topDoc: PrefabFile | null, path: readonly number[]): { overrides: OverrideMap; structure: LayerStructure } {
  const docs: (PrefabFile | null)[] = [topDoc];
  for (let i = 0; i < path.length; i++) {
    const row = referenceRowAt(docs[i], path[i]);
    if (!row) break;
    docs.push(getCachedPrefabSync(row.prefab!));
  }
  return foldPath(docs, path);
}

/** The live root row `row` of frame `frame` expanded — the owned root with that stamp whose OWNER is `frame`. 0 when
 *  it is not live (deleted, or the frame was never expanded). */
export function ownedRootAt(frame: number, row: number): number {
  const piMeta = getTraitByName('PrefabInstance');
  if (!piMeta) return 0;
  const identity = worldIdentityParents(getCurrentWorld());
  let found = 0;
  getCurrentWorld().query(piMeta.trait).updateEach(([pi], entity) => {
    if (found) return;
    const p = pi as MemberPi;
    const id = entity.id();
    if (isOwnedRoot(p, id) && p?.parentLocalId === row && identity.ownerOf(id) === frame) found = id;
  });
  return found;
}

/** Frame `frame`'s chain up to the stored root above it, climbing by ownership (#1437: a moved root's owner is its
 *  frame): the row localIds down from that root, every level, and the template reference node that spawned the root. */
function climbFrame(frame: number, depth: number): { chain: number[]; levels: FrameLevel[]; node: AddedEntity | null } | null {
  const piMeta = getTraitByName('PrefabInstance');
  if (!piMeta || depth > 16) return null;
  const sourceOf = (id: number) => (readTraitData(id, piMeta)?.source as string) || '';
  let identity: ReturnType<typeof worldIdentityParents> | undefined;
  const chain: number[] = [];
  const roots: number[] = [frame];
  let top = frame;
  for (let hops = 0; hops < 64; hops++) {
    const plid = (readTraitData(top, piMeta)?.parentLocalId as number) || 0;
    if (!plid) break;
    const owner = (identity ??= worldIdentityParents(getCurrentWorld())).ownerOf(top);
    if (!owner) return null;
    chain.unshift(plid);
    roots.unshift(owner);
    top = owner;
  }
  const levels: FrameLevel[] = roots.map((root, i) => {
    const source = sourceOf(root);
    return { root, source, ...levelDoc(root, source), step: i === 0 ? { kind: 'top' } : { kind: 'row', row: chain[i - 1]! } };
  });
  if (!levels[0]!.source) return null;
  return { chain, levels, node: templateReferenceNode(top, depth) };
}

/** Frame `frame`'s effective base (I1): its chain, its document, and everything enclosing it folded. See the module
 *  docblock. Null when `frame` is not an instance root, or its chain cannot be read. */
export function frameBase(frame: number, depth = 0): FrameBase | null {
  const climbed = climbFrame(frame, depth);
  if (!climbed) return null;
  const { chain, levels, node } = climbed;
  const doc = levels[levels.length - 1]!.doc;
  let layer: FrameLayer | null = null;
  if (!chain.length) {
    if (node) {
      // Its localId channels, with its member rows folded over them as the spawners fold them: a template node carries
      // template-form rows since #1538, and its direct ones are part of what it authors on this frame. It carries no
      // `moved`, which is live scene identity, stripped on the way into a template (`toTemplateNodes`).
      const lower = { overrides: node.overrides, added: node.added, removed: node.removed, removedTraits: node.removedTraits };
      const own = node.members && doc ? foldStructureLayers(doc, [{ rows: node.members, ...ownRootRow(node.members) }], 0, lower).channels : lower;
      layer = {
        overrides: own.overrides ?? {},
        structure: { added: own.added ?? [], removed: own.removed ?? [], removedTraits: own.removedTraits ?? {} },
      };
    }
  } else {
    const folded = foldPath(levels.map((l) => l.doc), chain, node ? nodeForward(node, levels[0]!.doc) : undefined);
    const s = folded.structure;
    layer = { overrides: folded.overrides, structure: { added: s.added ?? [], removed: s.removed ?? [], removedTraits: s.removedTraits ?? {} } };
  }
  return { frame, levels, doc, node, layer };
}

/** The field values the layers enclosing frame `frame` give its members that a copy of a subtree leaves BEHIND: those a
 *  level whose frame root is outside the subtree (`inside` answers false) states, and no level inside restates equal. A
 *  copy that makes the frame (or one above it inside the subtree) a stored root shows them with no layer to give them,
 *  so it records them (#1914 — a paste or duplicate records the copy's values off its own base, Unity's rule), where the
 *  old loader's marks carried every layer's value along. By localId, as the layer states them (tokens unresolved: the
 *  copy compares nothing, it only records). Null when nothing is left behind. */
export function layerFieldsLeftBehind(frame: number, inside: (root: number) => boolean): OverrideMap | null {
  const climbed = climbFrame(frame, 0);
  if (!climbed) return null;
  const { chain, levels } = climbed;
  const k = levels.findIndex((l) => inside(l.root));
  // Every level inside (or the frame itself outside, which a copy of it never promotes): nothing is left behind. A
  // template reference node's own channels (`node`) are its layer's too, and are left behind with the level above.
  if (k <= 0 && !climbed.node) return null;
  if (k < 0) return null;
  const full = frameBase(frame)?.layer?.overrides;
  if (!full || !Object.keys(full).length) return null;
  const kept = k === levels.length - 1 ? {} : foldPath(levels.slice(k).map((l) => l.doc), chain.slice(k)).overrides;
  const out: OverrideMap = {};
  for (const [lid, traits] of Object.entries(full)) {
    for (const [trait, fields] of Object.entries(traits)) {
      const inner = kept[Number(lid)]?.[trait];
      for (const [f, v] of Object.entries(fields ?? {})) {
        if (inner && hasDocKey(inner, f) && valuesEqual(inner[f], v)) continue;
        ((out[Number(lid)] ??= {})[trait] ??= {})[f] = v;
      }
    }
  }
  return Object.keys(out).length ? out : null;
}

/** For a subtree rooted at `rootId`, what each member of it would lose as "Trait.field" keys ({@link
 *  layerFieldsLeftBehind}), asked once per frame. The ONE reader for the two writes that take a subtree out of its
 *  layers: a copy (`snapshotEntity` → `copySnapshot`) and Create Prefab (`serializePrefab`, {@link withLeftBehindRecorded}). */
export function leftBehindReader(
  rootId: number,
  /** The subtree's root frame is UNPACKED, not kept (Create Prefab bakes the selected instance into the new template's
   *  own rows): its document's rows are left behind too. A copy keeps it — the copy is another instance of it. */
  unpackRoot = false,
): (pi: { rootInstanceId?: number; localId?: number } | null | undefined) => string[] {
  let inside: Set<number> | undefined;
  const lost = new Map<number, OverrideMap | null>();
  return (pi) => {
    if (!pi?.rootInstanceId || !pi.localId) return [];
    const frame = pi.rootInstanceId;
    if (!lost.has(frame)) {
      if (!inside) {
        const set = new Set([rootId]);
        const all = getAllEntities();
        for (let grew = true; grew;) {
          grew = false;
          for (const e of all) if (!set.has(e.id) && set.has(e.parentId)) { set.add(e.id); grew = true; }
        }
        if (unpackRoot) set.delete(rootId);
        inside = set;
      }
      const set = inside;
      lost.set(frame, layerFieldsLeftBehind(frame, (r) => set.has(r)));
    }
    const fields = lost.get(frame)?.[pi.localId];
    return fields ? Object.entries(fields).flatMap(([t, fs]) => Object.keys(fs ?? {}).map((f) => `${t}.${f}`)) : [];
  };
}

/** Run `fn` (a capture of the subtree at `rootId` into a NEW template: Create Prefab) with every field the subtree's
 *  members would lose to the layers outside it among the keys the capture reads (`addCaptureKey`, inside the capture's
 *  `withCaptureKeys`). The new template's rows state what the tree showed (#1914: a layer's value is base, and so
 *  unrecorded, and the record-gated capture skipped it). */
export function withLeftBehindRecorded<T>(rootId: number, fn: () => T): T {
  const piMeta = getTraitByName('PrefabInstance');
  const read = leftBehindReader(rootId, true);
  if (piMeta) {
    for (const e of getAllEntities()) {
      const keys = read(readTraitData(e.id, piMeta) as { rootInstanceId?: number; localId?: number } | null);
      const ent = keys.length ? findEntity(e.id) : undefined;
      if (!ent) continue;
      for (const k of keys) {
        if (!overrideKeysOf(ent)?.has(k)) addCaptureKey(e.id, k);
      }
    }
  }
  return fn();
}

/** What the layers ENCLOSING frame `frame` forward into its expansion from `doc` (#1737), and the cycle stack that
 *  expansion runs under: the state a load hands the frame when it expands the row above it. `doc` is the document the
 *  expansion is FROM — a rebuild's new one, or the one the live tree was built from when a capture subtracts it —
 *  because what a layer forwards to the frame's nested roots is folded against that document's rows.
 *
 *  Null for a stored root no PREFAB layer encloses (a scene instance, a node the scene added): its expansion is the plain
 *  top call it always was. What a load does hand such a root, a scene entry's legacy `nestedOverrides` or a scene-added
 *  node's channels, is the scene's own statement, and it still comes back through the live capture alone (a frame that
 *  capture cannot reach loses it: #1780). A template reference node's frame gets the node's channels. The stack holds the
 *  documents of the levels above, from the stored root down — not across that root, since a reference node's spawner
 *  starts a fresh one. Null too when a level is not readable: the expansion then falls back to the plain top call. */
export function frameForward(frame: number, doc: PrefabFile): (ForwardState & { stack: string[] }) | null {
  const climbed = climbFrame(frame, 0);
  if (!climbed) return null;
  const { chain, levels, node } = climbed;
  if (!chain.length) return node ? { ...nodeForward(node, doc), stack: [] } : null;
  const docs = [...levels.slice(0, -1).map((l) => l.doc), doc];
  const { forward } = foldPath(docs, chain, node ? nodeForward(node, docs[0]!) : undefined);
  if (!forward) return null;
  const stack = levels.slice(0, -1).map((l) => l.doc?.id ?? '').filter(Boolean);
  return { ...forward, stack };
}

/** `kept` with `live` laid over it, leaf by leaf: the live value wins every field it states. */
function underLive(kept: unknown, live: unknown): unknown {
  if (live === undefined) return structuredClone(kept);
  if (!isPlain(kept) || !isPlain(live)) return live;
  const out: Record<string, unknown> = { ...live };
  for (const [k, v] of Object.entries(kept)) out[k] = underLive(v, live[k]);
  return out;
}
const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** One row with an unused part put back under it. A removal goes in the form the row already states removals in — a
 *  whole `removedTraits` list takes a name, `traitRemovals` a statement — or, when it states none, in the part's own. A
 *  removal of a component the member carries live (`carried`; the store is refreshed by a load, and an undo that hands
 *  the component back is not one) is left out. */
export function withUnusedPart(row: SceneMemberRow | undefined, part: SceneMemberRow, carried: (name: string) => boolean): SceneMemberRow {
  const out: SceneMemberRow = { ...(row ?? {}) };
  if (part.traits) out.traits = underLive(part.traits, out.traits) as SceneMemberRow['traits'];
  // [name, removes, stated as a list entry]
  const removals: [string, boolean, boolean][] = [
    ...(part.removedTraits ?? []).map((t): [string, boolean, boolean] => [t, true, true]),
    ...Object.entries(part.traitRemovals ?? {}).map(([t, on]): [string, boolean, boolean] => [t, on, false]),
  ];
  for (const [t, on, fromList] of removals) {
    if (on && carried(t)) continue;
    if ((out.traitRemovals && t in out.traitRemovals) || out.removedTraits?.includes(t)) continue;
    if (Array.isArray(out.removedTraits)) { if (on) out.removedTraits = [...out.removedTraits, t]; continue; }
    if (out.traitRemovals || !fromList) out.traitRemovals = { ...out.traitRemovals, [t]: on };
    else out.removedTraits = [t];
  }
  return out;
}


/** Per member of `doc`, the traits `layer`'s field overrides put on it that `doc`'s own row lacks: what a removal on the
 *  member is measured against, beside the row's own traits (#1676, `StructureCaptureOpts.layerTraits`). An added TAG
 *  counts: it is overridden as `{Tag: {}}`.
 *
 *  ⚠️ A trait the layer adds AND removes (a row adds it, a row further out removes it) stays in: its absence is then
 *  captured as a removal EQUAL to the layer's, which every subtraction takes off (`traitRemovalStatements`,
 *  `subtractChainStructure`). Left out, the capture listed no removal where the layer states one, and the scene writer
 *  read that as the scene putting the trait BACK — `{T: false}` — so an untouched save undid the layer's removal
 *  (#1693 close-out review, P1–P3). */
export function layerAddedTraits(layer: Pick<FrameLayer, 'overrides'>, doc: PrefabFile): Record<number, string[]> {
  const out: Record<number, string[]> = {};
  for (const [lid, traits] of Object.entries(layer.overrides)) {
    const row = rowAt(doc, Number(lid));
    if (!row || row.prefab) continue;
    const names = Object.keys(traits).filter((t) => row.traits[t] === undefined);
    if (names.length) out[Number(lid)] = names;
  }
  return out;
}

/** The template node that expanded reference-node root `refRoot` — a keyed `added` node with `prefab` that the layer
 *  enclosing the frame it hangs in authored — or null when `refRoot` is not one (a stored root, a row expansion, a node
 *  the SCENE added). Matched by template KEY, as the rebuild matches a chain's nodes (`subtractChainStructure`): the
 *  marker first, the guid-derived recovery when it was lost (Play→Stop, an undo respawn). The recovery scans every
 *  cached document's keys, so it runs only when the enclosing layer actually holds a keyed reference node.
 *
 *  The node may hang inside a plain added node's `children` (#1513): the frame is then the one the first MEMBER above
 *  it belongs to, and the node is looked for through the layer's `children` too. Not through a reference node's own
 *  `added`: that list is the layer of the node's OWN frame, which a node below one of its members reaches directly. */
export function templateReferenceNode(refRoot: number, depth: number): AddedEntity | null {
  const piMeta = getTraitByName('PrefabInstance');
  const eaMeta = getTraitByName('EntityAttributes');
  const pi = piMeta ? readTraitData(refRoot, piMeta) : null;
  if (!eaMeta || !isStoredRoot(pi as MemberPi, refRoot)) return null; // a root no row expanded; a template's node is one
  const frame = enclosingFrameOf(refRoot);
  if (!frame || frame === refRoot) return null;
  const candidates: AddedEntity[] = [];
  const collect = (nodes: readonly AddedEntity[] | undefined) => {
    for (const n of nodes ?? []) {
      if (n.prefab) { if (n.key) candidates.push(n); } else collect(n.children);
    }
  };
  collect(frameBase(frame, depth + 1)?.layer?.structure.added);
  if (!candidates.length) return null;
  const key = templateKeyOf(findEntity(refRoot)) || recoverTemplateKey(refRoot);
  return key ? candidates.find((n) => n.key === key) ?? null : null;
}

/** The frame an added node `id` hangs in: the instance root of the first instance entity above it, or 0. The LIVE parents:
 *  a root no row expanded has no frame of its own, so its identity parent is exactly its live one (`identityParents.ts`),
 *  and so is a plain added node's. Read directly, not through a world identity walk, which an Inspector recompute of every
 *  scene-level instance paid for (close-out review: 0.004 → 0.63 ms at 3000 entities). Climbed past plain entities to the
 *  first instance entity: a template's plain node carries no PrefabInstance. */
function enclosingFrameOf(id: number): number {
  const piMeta = getTraitByName('PrefabInstance');
  const eaMeta = getTraitByName('EntityAttributes');
  if (!piMeta || !eaMeta) return 0;
  const parentOf = (e: number) => (readTraitData(e, eaMeta)?.parentId as number) || 0;
  for (let at = parentOf(id), hops = 0; at && hops < 64; at = parentOf(at), hops++) {
    const frame = (readTraitData(at, piMeta)?.rootInstanceId as number) || 0;
    if (frame) return frame;
  }
  return 0;
}

/** The template node that spawned PLAIN added node `nodeId` (#1914 R3a) — a keyed node without `prefab` that the layer
 *  enclosing its frame authored, at any depth of that layer's `children` — with the frame it hangs in, or null when
 *  `nodeId` is not one (a member, a reference node's root, a node the WRITER added: the scene's, or in prefab edit the
 *  edited document's, which no enclosing layer states). Its values are the node's BASE: what it shows with no record of
 *  its own. Matched by template key, as {@link templateReferenceNode} matches. */
export function templatePlainNode(nodeId: number): { node: AddedEntity; frame: number } | null {
  const piMeta = getTraitByName('PrefabInstance');
  const e = findEntity(nodeId);
  if (!piMeta || !e || e.has(piMeta.trait)) return null;
  const key = templateKeyOf(e) || recoverTemplateKey(nodeId);
  const frame = key ? enclosingFrameOf(nodeId) : 0;
  if (!frame) return null;
  const find = (nodes: readonly AddedEntity[] | undefined): AddedEntity | null => {
    for (const n of nodes ?? []) {
      if (n.prefab) continue;
      if (n.key === key) return n;
      const hit = find(n.children);
      if (hit) return hit;
    }
    return null;
  };
  const node = find(frameBase(frame)?.layer?.structure.added);
  return node ? { node, frame } : null;
}

/** Every frame an OWNED nested root of `root` is, at any depth, with the chain of row localIds that reaches it from
 *  `root` — climbing by ownership (`ownerOf`), as the rebuild and the save address them. Shallowest first. The frames of
 *  a node the SCENE added are not in it: their chain passes through a stored root, which no row names (#1693, U14). */
export function ownedFrames(root: number): { frame: number; chain: number[] }[] {
  const piMeta = getTraitByName('PrefabInstance');
  if (!piMeta) return [];
  const identity = worldIdentityParents(getCurrentWorld());
  const out: { frame: number; chain: number[] }[] = [];
  getCurrentWorld().query(piMeta.trait).updateEach(([pi], entity) => {
    const id = entity.id();
    if (id === root || !isOwnedRoot(pi as MemberPi, id)) return;
    const chain: number[] = [];
    let f = id;
    for (let hops = 0; f && f !== root && hops < 64; hops++) {
      const p = readTraitData(f, piMeta) as MemberPi;
      if (!isOwnedRoot(p, f)) { f = 0; break; }
      chain.unshift(p!.parentLocalId!);
      f = identity.ownerOf(f);
    }
    if (f === root) out.push({ frame: id, chain });
  });
  return out.sort((a, b) => a.chain.length - b.chain.length);
}
