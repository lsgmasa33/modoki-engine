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
 *  down from one (the save, the rebuild).
 *
 *  ⚠️ This module and `prefab.ts` import each other. Neither may touch the other at module-evaluation time: every
 *  cross call is inside a function body. */

import { getCurrentWorld } from '../../runtime/core/ecs/world';
import { worldIdentityParents, frameRootDoc } from '../../runtime/core/ecs/identityParents';
import { getTraitByName } from '../../runtime/core/ecs/traitRegistry';
import { readTraitData, findEntity } from '../../runtime/core/ecs/entityUtils';
import { isStoredRoot, isOwnedRoot, type MemberPi } from '../../runtime/core/assetRefRules';
import { templateKeyOf } from '../../runtime/core/templateIdentity';
import {
  mergeOverrideMaps, descendNestedOverrides, mergeNestedOverridePaths, descendStructureLayers, foldStructureLayers,
  type OverrideMap, type StructureLayer,
} from '../../runtime/loaders/prefabOverrides';
import type { AddedEntity, NestedOverridePaths, NestedStructurePaths, NestedStructureDelta, SceneMemberRow } from '../../runtime/loaders/loadSceneFile';
import { getCachedPrefabSync, recoverTemplateKey, type PrefabFile } from './prefab';

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

/** The fold ITSELF: everything the layers above a frame state about it, walking `path` (row localIds, outermost first)
 *  down from a first level whose document is `docs[0]`. `docs[i + 1]` is the document of the frame row `path[i]`
 *  expands. `seed` is what a layer above the first level forwards into it: a template reference node's
 *  `nestedOverrides` / `nestedStructure` / `members` (#1506, #1538). The editor expansion's order (`instantiatePrefab`):
 *  per step, the row's `overrides` under the outer layer's forwarded direct ones, the row's lists unless an outer slot
 *  owns the frame, and then every layer's member rows folded over both, inner first. */
function foldPath(
  docs: readonly (PrefabFile | null)[],
  path: readonly number[],
  seed?: { nestedOverrides?: NestedOverridePaths; nestedStructure?: NestedStructurePaths; members?: Record<string, SceneMemberRow> },
): { overrides: OverrideMap; structure: LayerStructure } {
  let prefab = docs[0] ?? null;
  let pending: NestedOverridePaths | undefined = seed?.nestedOverrides;
  let layers: StructureLayer<NestedStructureDelta, SceneMemberRow>[] = [{ slots: seed?.nestedStructure, rows: seed?.members }];
  let forwardRoots: readonly (ReadonlyMap<number, SceneMemberRow> | undefined)[] =
    seed?.members && prefab ? foldStructureLayers(prefab, layers, 0, {}).forwardRoots : [];
  let out: { overrides: OverrideMap; structure: LayerStructure } = { overrides: {}, structure: {} };
  for (let i = 0; i < path.length; i++) {
    if (!prefab) return out;
    const row = prefab.entities.find((e) => e.localId === path[i] && e.prefab);
    if (!row) return out;
    const { direct, forward } = descendNestedOverrides(pending, row.localId);
    const overrides = direct ? mergeOverrideMaps(row.overrides, direct) : (row.overrides ?? {});
    pending = mergeNestedOverridePaths(row.nestedOverrides, forward);
    const d = descendStructureLayers(layers, row, forwardRoots);
    // An outer layer addressing this path OWNS the interior — all three lists, absent read as empty (`structDirect`).
    const lower = d.direct
      ? { overrides, added: d.direct.added ?? [], removed: d.direct.removed ?? [], removedTraits: d.direct.removedTraits ?? {} }
      : { overrides, added: row.added, removed: row.removed, removedTraits: row.removedTraits };
    const child = docs[i + 1] ?? null;
    const folded = child ? foldStructureLayers(child, d.layers, d.foldFrom, lower) : { channels: lower, forwardRoots: [] };
    if (i === path.length - 1) {
      const { added, removed, removedTraits } = folded.channels;
      out = {
        overrides: folded.channels.overrides ?? {},
        structure: { added, removed, removedTraits, ...(d.direct ? { moved: d.direct.moved ?? {} } : {}) },
      };
    }
    layers = d.layers;
    forwardRoots = folded.forwardRoots;
    prefab = child;
  }
  return out;
}

/** {@link foldPath} from the stored root `top` down `path`: the layer the prefab chain puts on the nested frame `path`
 *  reaches. Each level's document is its live frame's record where the frame is live (found by descending the row
 *  partition), else the cache. `topDoc` pins the first level's document when the caller knows better than the record —
 *  a rebuild measuring against the document the tree was built from while the cache already holds the new one. */
export function chainLayer(
  top: number, source: string, path: readonly number[], topDoc?: PrefabFile | null,
): { overrides: OverrideMap; structure: LayerStructure } {
  const docs: (PrefabFile | null)[] = [topDoc !== undefined ? topDoc : levelDoc(top, source).doc];
  let at = top;
  for (let i = 0; i < path.length; i++) {
    const row = docs[i]?.entities.find((e) => e.localId === path[i] && e.prefab);
    if (!row) break;
    at = at ? ownedRootAt(at, path[i]!) : 0;
    docs.push(at ? levelDoc(at, row.prefab!).doc : getCachedPrefabSync(row.prefab!));
  }
  return foldPath(docs, path);
}

/** {@link foldPath} over DOCUMENTS alone — the first given, each deeper one read from the cache — for a caller whose
 *  levels are not live frames. Only Apply's pose base for a member moved out of a nested frame (`layerPose`) asks it. */
export function docChainLayer(topDoc: PrefabFile | null, path: readonly number[]): { overrides: OverrideMap; structure: LayerStructure } {
  const docs: (PrefabFile | null)[] = [topDoc];
  for (let i = 0; i < path.length; i++) {
    const row = docs[i]?.entities.find((e) => e.localId === path[i] && e.prefab);
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

/** Frame `frame`'s effective base (I1): its chain, its document, and everything enclosing it folded. See the module
 *  docblock. Null when `frame` is not an instance root, or its chain cannot be read. */
export function frameBase(frame: number, depth = 0): FrameBase | null {
  const piMeta = getTraitByName('PrefabInstance');
  if (!piMeta || depth > 16) return null;
  const sourceOf = (id: number) => (readTraitData(id, piMeta)?.source as string) || '';
  // The chain of rows down from the top of this frame, climbing by ownership (#1437: a moved root's owner is its frame).
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
  const doc = levels[levels.length - 1]!.doc;
  const node = templateReferenceNode(top, depth);
  let layer: FrameLayer | null = null;
  if (!chain.length) {
    if (node) {
      // Its localId channels, with its member rows folded over them as the spawners fold them: a template node carries
      // template-form rows since #1538, and its direct ones are part of what it authors on this frame. It carries no
      // `moved`, which is live scene identity, stripped on the way into a template (`toTemplateNodes`).
      const lower = { overrides: node.overrides, added: node.added, removed: node.removed, removedTraits: node.removedTraits };
      const own = node.members && doc ? foldStructureLayers(doc, [{ rows: node.members }], 0, lower).channels : lower;
      layer = {
        overrides: own.overrides ?? {},
        structure: { added: own.added ?? [], removed: own.removed ?? [], removedTraits: own.removedTraits ?? {} },
      };
    }
  } else {
    const folded = foldPath(levels.map((l) => l.doc), chain, node ?? undefined);
    const s = folded.structure;
    layer = { overrides: folded.overrides, structure: { added: s.added ?? [], removed: s.removed ?? [], removedTraits: s.removedTraits ?? {} } };
  }
  return { frame, levels, doc, node, layer };
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
    const row = doc.entities.find((e) => e.localId === Number(lid));
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
  // The LIVE parents: a root no row expanded has no frame of its own, so its identity parent is exactly its live one
  // (`identityParents.ts`), and so is a plain added node's. Read directly, not through a world identity walk, which an
  // Inspector recompute of every scene-level instance paid for (close-out review: 0.004 → 0.63 ms at 3000 entities).
  // Climbed past plain entities to the first instance entity: a template's plain node carries no PrefabInstance.
  const parentOf = (id: number) => (readTraitData(id, eaMeta)?.parentId as number) || 0;
  let frame = 0;
  for (let at = parentOf(refRoot), hops = 0; at && hops < 64; at = parentOf(at), hops++) {
    frame = (readTraitData(at, piMeta!)?.rootInstanceId as number) || 0;
    if (frame) break;
  }
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
