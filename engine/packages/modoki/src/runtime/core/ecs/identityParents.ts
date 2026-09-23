/** Where an entity's IDENTITY steps from — read from the prefab DOCUMENT, not remembered (#1468 Phase 6).
 *
 *  A member's derived guid, the member path a template token names it by, and the frame an owned nested
 *  root belongs to are all walks up its TEMPLATE parents — the rows its document puts above it — not up
 *  where it happens to hang. A member moved inside its instance (#1437) must keep walking from the row
 *  parent it left, and one whose row parent is gone (deleted, unpacked) keeps that row's step in its path,
 *  because a reload expands the removed row until the member has been derived through it.
 *
 *  Until Phase 6 that answer was REMEMBERED on the member at move time (`PrefabInstance.homeParent` +
 *  `homeSteps`) and re-pointed whenever a home died. It is now COMPUTED from the document the frame was
 *  expanded from ({@link frameDocReader}), which is #1468 Phase 4's one invariant again (`docs/prefab-structural-overrides.md`): a localId means
 *  something only together with the document it was read from. A home was always the template parent —
 *  a load records a freshly expanded member's live parent, the editor records the old parent only when
 *  there was no home, and moving back cleared it — so every walk gets the answer it got before, from a
 *  source that cannot go stale behind it.
 *
 *  - **A linked member** (`rootInstanceId` is its frame `F`, not itself): its row in `F`'s document,
 *    climbed through `EntityAttributes.parentId`. The first ancestor row with a live entity in `F` (the
 *    root counts) is the identity parent; each ancestor row with none adds its localId to `extra`. A chain
 *    that ends in an ORPHAN row (parent 0, or naming no row) ends where the loader hangs one: under the
 *    stored root's own parent, or nothing for a nested frame.
 *  - **An OWNED nested root**: the same climb from its `parentLocalId` row, in its OWNER's frame, and only
 *    when that row is the one that expanded it (else its live parent). The owner is `PrefabInstance.ownerGuid`
 *    when that names a frame root whose document does not contradict it; every move writes the link
 *    ({@link linkOwnerBeforeMove}), because two instances of one prefab inside one outermost instance share
 *    every row and every document, so nothing else can tell them apart. An unmoved root's owner is read
 *    from where it hangs: a member parent's frame, or — under another nested ROOT — that root's own frame
 *    or its owner, whichever document has the row there (a nested row under a nested row).
 *  - **Anything else** — a stored root, a keyed or scene-added node, a plain entity — and any member whose
 *    document or row cannot be found: its LIVE parent, with no extra steps. That is the answer a member
 *    with no home always got, and it is right for everything that has not moved. */

import type { Entity, World } from 'koota';
import { getTraitByName } from './traitRegistry';
import { getStructureVersion } from './entityUtils';
import { packedOf, isPackedAlive, type PackedEntity } from './entityTable';
import { durableGuid, isOwnedRoot, isStoredRoot, isFrameStep, FRAME_STEP, type MemberStep } from '../assetRefRules';

/** What the resolver reads of a prefab document: its rows' localIds, parents and nested sources. */
export type TemplateDoc = {
  rootLocalId?: number;
  entities?: ReadonlyArray<{ localId?: number; prefab?: string; nodeGuid?: string; traits?: Record<string, unknown> }>;
};
/** A document by `source`; `root`, when given, is the ecs id of the frame root the caller is asking for,
 *  so the reader can answer with the document THAT frame was expanded from. */
export type TemplateDocReader = (source: string, root?: number) => TemplateDoc | null | undefined;

/** The `PrefabInstance` fields the resolver reads. */
export type IdentityPi = { source?: string; localId?: number; parentLocalId?: number; parentNodeGuid?: string; rootInstanceId?: number; ownerGuid?: string } | null;

/** One entity as the resolver sees it: a live one, or a node of a snapshot (`planCopyGuids`). */
export interface IdentityNode { id: number; parentId: number; guid: string; pi: IdentityPi }

/** An entity's identity parent, and the steps of the gone template rows between it and the entity — led by a
 *  `FRAME_STEP` when that parent is a nested root standing for a row of the entity's frame (#1484). */
export interface IdentityParent { parentId: number; extra: MemberStep[] }

export interface IdentityParents {
  /** `id`'s identity parent and extra steps; `{ parentId: <live>, extra: [] }` for anything that did not move. */
  of(id: number): IdentityParent;
  /** `id`'s identity parent alone. */
  parentOf(id: number): number;
  /** Whether `id` sits somewhere other than its template puts it — the question `!!homeParent` answered. */
  moved(id: number): boolean;
  /** The frame an OWNED nested root belongs to (the instance whose row expanded it); 0 when unknown. */
  ownerOf(id: number): number;
}

// ── The per-world document registry ─────────────────────────────────────────────────────────────

/** Per world, the document each frame ROOT was expanded from — what its members' localIds mean. By root
 *  first, because one source's instances can be expanded from different documents at once: Apply to
 *  Prefab rebuilds the instances of a source one at a time, and until an instance's turn its live tree is
 *  the OLD document's, so reading the new one there made its unmoved members read as moved. Keyed by the
 *  PACKED entity (#868): a root's index is recycled after a destroy, and a respawned root (an undo) is a
 *  new entity that falls through to the per-source record below. A swapped-out world takes both maps with
 *  it, like the loader's other per-world state (`templateKeyRecovery`) — `WeakMap<World, …>`, so the
 *  owner clears (`entityTable.ts` § world swap). */
const rootDocsByWorld = new WeakMap<World, Map<PackedEntity, { source: string; doc: TemplateDoc }>>();
/** …and per source, the document it was LAST expanded from: the answer for a frame whose root has no
 *  record of its own. */
const docsByWorld = new WeakMap<World, Map<string, TemplateDoc>>();

/** Record that `world` expanded `source` from `doc` — at `root`, when the caller knows it. The loader
 *  calls it for every instance it spawns, the editor for every frame it makes itself. */
export function noteFrameDoc(world: World, source: string, doc: TemplateDoc, root?: Entity): void {
  if (!source) return;
  let docs = docsByWorld.get(world);
  if (!docs) { docs = new Map(); docsByWorld.set(world, docs); }
  docs.set(source, doc);
  if (root === undefined) return;
  let roots = rootDocsByWorld.get(world);
  if (!roots) { roots = new Map(); rootDocsByWorld.set(world, roots); }
  roots.set(packedOf(root), { source, doc });
  // Every runtime spawn records its frames here and nothing removes one when its root dies, so sweep the
  // dead each time the map doubles: amortised O(1) a note, and the map stays bounded by the live roots.
  const floor = pruneFloor.get(roots) ?? 64;
  if (roots.size >= floor) {
    for (const packed of [...roots.keys()]) if (!isPackedAlive(packed)) roots.delete(packed);
    pruneFloor.set(roots, Math.max(64, roots.size * 2));
  }
}
const pruneFloor = new WeakMap<object, number>();
/** How many frame-root records `world` holds — for the sweep's test. */
export function frameDocRootCount(world: World): number {
  return rootDocsByWorld.get(world)?.size ?? 0;
}

/** The reader consulted when a world never expanded a source: the editor registers its prefab cache
 *  here (`editor/scene/prefab.ts`), for a frame it tagged live (Create Prefab), expanded through its own
 *  `instantiatePrefab`, or respawned into a world that never expanded that source. A runtime build has
 *  none; the runtime cache below stands under it in both. */
let defaultFallback: TemplateDocReader | undefined;
export function setFrameDocFallback(reader: TemplateDocReader | undefined): void {
  defaultFallback = reader;
}
/** …and under it, the RUNTIME prefab cache, which the loader registers (`loadSceneFile.ts`). A frame whose
 *  root record was lost to a flat respawn (a kept base scene across a swap, Play→Stop) reads the document
 *  its source is cached as; before this, a device had no fallback at all and read such a frame as unmoved. */
let runtimeFallback: TemplateDocReader | undefined;
export function setRuntimeFrameDocFallback(reader: TemplateDocReader | undefined): void {
  runtimeFallback = reader;
}

/** A reader over the documents `world` expanded — the frame root's own first, then the source's latest —
 *  then `fallback` (by default the one registered with {@link setFrameDocFallback}). */
export function frameDocReader(
  world: World, fallback: TemplateDocReader | undefined = defaultFallback,
  /** The world's id → packed map, when the caller already walked it (`worldIdentityParents`). */
  knownPacked?: ReadonlyMap<number, PackedEntity>,
): TemplateDocReader {
  const docs = docsByWorld.get(world);
  const roots = rootDocsByWorld.get(world);
  let packedById = knownPacked;
  return (source, root) => {
    if (root && roots?.size) {
      if (!packedById) {
        const built = new Map<number, PackedEntity>();
        for (const e of world.entities as Iterable<Entity>) built.set(e.id(), packedOf(e));
        packedById = built;
      }
      const packed = packedById.get(root);
      // Only for the source it was recorded under: a root re-tagged as another prefab (Create Prefab over
      // an instance) keeps its entity, and its old document says nothing about the new one's rows.
      const own = packed === undefined ? undefined : roots.get(packed);
      if (own && own.source === source) return own.doc;
    }
    return docs?.get(source) ?? fallback?.(source) ?? runtimeFallback?.(source) ?? undefined;
  };
}

// ── The resolver ────────────────────────────────────────────────────────────────────────────────

interface DocIndex { parent: Map<number, number>; prefab: Map<number, string>; node: Map<number, string>; root: number }
const indexByDoc = new WeakMap<object, DocIndex>();
function docIndex(doc: TemplateDoc): DocIndex {
  let idx = indexByDoc.get(doc);
  if (idx) return idx;
  idx = { parent: new Map(), prefab: new Map(), node: new Map(), root: doc.rootLocalId ?? 1 };
  for (const e of doc.entities ?? []) {
    if (!e.localId) continue;
    const ea = e.traits?.EntityAttributes;
    idx.parent.set(e.localId, ea && typeof ea === 'object' ? ((ea as { parentId?: number }).parentId ?? 0) : 0);
    if (e.prefab) idx.prefab.set(e.localId, e.prefab);
    if (e.nodeGuid) idx.node.set(e.localId, e.nodeGuid);
  }
  indexByDoc.set(doc, idx);
  return idx;
}

/** Resolve identity parents over `nodes`. Built once per walk: callers ask it per entity. */
export function resolveIdentityParents(nodes: Iterable<IdentityNode>, readDoc: TemplateDocReader): IdentityParents {
  const byId = new Map<number, IdentityNode>();
  const idOfGuid = new Map<string, number>();
  for (const n of nodes) {
    byId.set(n.id, n);
    if (n.guid) idOfGuid.set(n.guid, n.id);
  }
  const isRoot = (n: IdentityNode | undefined): boolean => !!n?.pi && n.pi.rootInstanceId === n.id;
  const docOf = (source: string | undefined, root: number): DocIndex | null => {
    const doc = source ? readDoc(source, root) : null;
    return doc ? docIndex(doc) : null;
  };
  /** Whether `d`'s row `row` is the one that expanded owned root `n`: that row nests `n`'s source, and — where
   *  both carry a minted identity (prefab v5) — it IS the row `n` says expanded it. Row number and source
   *  alone cannot tell apart two nested roots with the same stamp under one parent, one per frame (a nested
   *  row under a nested row that nests the same prefab at the same localId as its own). */
  const expands = (d: DocIndex, row: number, n: IdentityNode): boolean => {
    if (d.prefab.get(row) !== n.pi!.source) return false;
    const minted = d.node.get(row);
    return !minted || !n.pi!.parentNodeGuid || minted === n.pi!.parentNodeGuid;
  };

  const ownerMemo = new Map<number, number>();
  /** The frame an UNMOVED owned root belongs to, read off where it hangs. A MEMBER parent is in one frame,
   *  and that is the owner. A ROOT parent is two candidates. Its own frame owns the row when the row hangs
   *  under that document's root. When the parent is itself an owned root, the frame that owns IT owns the
   *  row if the row hangs under that nested row: a nested row under a nested row, which the editor's
   *  prefab-edit save writes. The document decides which; with no document to ask, the first candidate,
   *  the answer this gave before #1468 Phase 6 (close-out review: reading `rootInstanceId` alone put such
   *  a root in the inner frame, where its row number named an unrelated member and it took that guid). */
  const ownerByPlace = (n: IdentityNode, row: number): number => {
    const p = byId.get(n.parentId);
    if (!p?.pi?.rootInstanceId) return 0;
    const cands: Array<{ frame: number; under: number | 'root' }> = isRoot(p)
      ? [{ frame: p.id, under: 'root' }, ...(p.pi.parentLocalId ? [{ frame: ownerOf(p.id), under: p.pi.parentLocalId }] : [])]
      : [{ frame: p.pi.rootInstanceId, under: p.pi.localId ?? 0 }];
    for (const c of cands) {
      const d = c.frame ? docOf(byId.get(c.frame)?.pi?.source, c.frame) : null;
      if (!d || !expands(d, row, n)) continue;
      if (d.parent.get(row) === (c.under === 'root' ? d.root : c.under)) return c.frame;
    }
    return cands[0]!.frame;
  };
  const ownerOf = (id: number): number => {
    const memo = ownerMemo.get(id);
    if (memo !== undefined) return memo;
    ownerMemo.set(id, 0); // a damaged chain that loops answers "no owner" instead of recursing
    const n = byId.get(id);
    let owner = 0;
    if (n?.pi && isRoot(n) && n.pi.parentLocalId) {
      // The link, when it still names a frame root whose document — where there is one to ask — has this row
      // expanding this source. A link the document contradicts names some other frame now, and is ignored.
      const linked = n.pi.ownerGuid ? byId.get(idOfGuid.get(n.pi.ownerGuid) ?? -1) : undefined;
      const linkedDoc = linked && isRoot(linked) ? docOf(linked.pi!.source, linked.id) : null;
      if (linked && isRoot(linked) && (!linkedDoc || expands(linkedDoc, n.pi.parentLocalId, n))) owner = linked.id;
      // Otherwise where it hangs: its owner until it moves, and every move writes the link.
      else owner = ownerByPlace(n, n.pi.parentLocalId);
    }
    ownerMemo.set(id, owner);
    return owner;
  };

  // Each frame's live rows: localId → entity. An owned nested root sits in its OWNER's frame, at the
  // row that expanded it.
  const frames = new Map<number, Map<number, number>>();
  const put = (frame: number, localId: number, id: number): void => {
    if (!frame || !localId) return;
    let m = frames.get(frame);
    if (!m) { m = new Map(); frames.set(frame, m); }
    if (!m.has(localId)) m.set(localId, id);
  };
  for (const n of byId.values()) {
    if (!n.pi?.rootInstanceId) continue;
    if (!isRoot(n)) put(n.pi.rootInstanceId, n.pi.localId ?? 0, n.id);
    else if (n.pi.parentLocalId) put(ownerOf(n.id), n.pi.parentLocalId, n.id);
  }

  const memo = new Map<number, IdentityParent>();
  const of = (id: number): IdentityParent => {
    const hit = memo.get(id);
    if (hit) return hit;
    const n = byId.get(id);
    const live: IdentityParent = { parentId: n?.parentId ?? 0, extra: [] };
    let out = live;
    const pi = n?.pi;
    if (n && pi?.rootInstanceId) {
      let frame = 0; let row = 0; let source: string | undefined;
      if (!isRoot(n)) { frame = pi.rootInstanceId; row = pi.localId ?? 0; source = pi.source; }
      else if (pi.parentLocalId) { frame = ownerOf(id); row = pi.parentLocalId; source = byId.get(frame)?.pi?.source; }
      const doc = frame && row ? docOf(source, frame) : null;
      // An owned root walks its owner's document only from the row that EXPANDED it. A document that says
      // otherwise (a dropped or renumbered row, read for a frame whose own record was lost) names some other
      // member at that number, and walking from it gave the root that member's path and guid (close-out
      // review 2). Its live parent is the answer it had before Phase 6.
      if (doc?.parent.has(row) && !(isRoot(n) && !expands(doc, row, n))) {
        const rows = frames.get(frame);
        const extra: MemberStep[] = [];
        const seen = new Set<number>([row]);
        for (let p = doc.parent.get(row) ?? 0; ; p = doc.parent.get(p) ?? 0) {
          if (p === doc.root || seen.has(p)) { out = { parentId: frame, extra }; break; }
          // An ORPHAN row — parent 0, or a parent no row has — hangs where the loader put it: under the parent
          // the expanding call was given, which is a stored root's own parent and nothing (0) for a nested one.
          if (!p || !doc.parent.has(p)) { out = { parentId: isStoredRoot(byId.get(frame)?.pi, frame) ? byId.get(frame)!.parentId : 0, extra }; break; }
          const at = rows?.get(p);
          if (at !== undefined) {
            // A nested ROOT of this frame, standing for its row: the step below it is ours, not its document's (#1484).
            if (at !== frame && isRoot(byId.get(at))) extra.unshift(FRAME_STEP);
            out = { parentId: at, extra };
            break;
          }
          seen.add(p);
          extra.unshift(p); // a gone row still steps by its localId — a nested row's root would step by it too
        }
      }
    }
    memo.set(id, out);
    return out;
  };

  return {
    of,
    parentOf: (id) => of(id).parentId,
    moved: (id) => { const r = of(id); return r.extra.some((s) => !isFrameStep(s)) || r.parentId !== (byId.get(id)?.parentId ?? 0); },
    ownerOf,
  };
}

/** A save asks for the world's identity parents once per instance and per capture step, over a world that
 *  does not change underneath it — close-out review measured a 3000-entity save at +30% for rebuilding it
 *  each time. Inside a scope ({@link openIdentityScope}) the resolver is built once and reused for as long
 *  as the world's structure version stands still; any reparent, spawn or delete bumps it (`markStructureDirty`)
 *  and the next ask rebuilds. The save's loop awaits between instances, which is why the version check and
 *  not the scope alone decides. ⚠️ Residual, measured harmless in close-out review 2: a few writers change a
 *  resolver input without bumping the version (a promotion's `PrefabInstance` write, the loader's raw
 *  `parentId` set). Only a user action landing in one of the save's awaits could interleave one, and the
 *  sources are fetched before the loop, so those awaits resolve from the cache. */
let scopeDepth = 0;
let scoped: { world: World; version: number; parents: IdentityParents } | null = null;
export function openIdentityScope(): void { scopeDepth++; }
export function closeIdentityScope(): void {
  if (--scopeDepth > 0) return;
  scopeDepth = 0;
  scoped = null;
}

/** {@link resolveIdentityParents} over the live `world`, reading the documents it expanded and then
 *  `fallback`. */
export function worldIdentityParents(world: World, fallback?: TemplateDocReader): IdentityParents {
  if (scopeDepth > 0 && !fallback) {
    // A module stubbed by an explicit export list (the editor's tests do this to `entityUtils`) throws on a
    // missing export; with no version to compare, build fresh — the uncached answer is always right.
    let version: number;
    try { version = getStructureVersion(); } catch { return buildWorldIdentityParents(world); }
    if (scoped && scoped.world === world && scoped.version === version) return scoped.parents;
    const parents = buildWorldIdentityParents(world);
    scoped = { world, version, parents };
    return parents;
  }
  return buildWorldIdentityParents(world, fallback);
}

function buildWorldIdentityParents(world: World, fallback?: TemplateDocReader): IdentityParents {
  const eaMeta = getTraitByName('EntityAttributes');
  const piMeta = getTraitByName('PrefabInstance');
  const nodes: IdentityNode[] = [];
  const packed = new Map<number, PackedEntity>();
  for (const e of world.entities as Iterable<Entity>) {
    const ea = eaMeta && e.has(eaMeta.trait) ? (e.get(eaMeta.trait) as { parentId?: number; guid?: string }) : undefined;
    const pi = piMeta && e.has(piMeta.trait) ? (e.get(piMeta.trait) as IdentityPi) : null;
    nodes.push({ id: e.id(), parentId: ea?.parentId ?? 0, guid: ea?.guid ?? '', pi });
    packed.set(e.id(), packedOf(e));
  }
  return resolveIdentityParents(nodes, frameDocReader(world, fallback ?? defaultFallback, packed));
}

/** Before an OWNED nested root moves, record which frame owns it (`PrefabInstance.ownerGuid`): the frame
 *  the resolver reads off where it hangs now, which is its owner for as long as it has not moved. Every site
 *  that moves a linked entity calls this where it used to record a home. A root already linked keeps its
 *  link — it was written at its first move, while where it hung still said — and anything but an owned root
 *  is left alone. No link is written when the owner has no durable guid: nothing could resolve it later. */
export function linkOwnerBeforeMove(world: World, id: number): void {
  const piMeta = getTraitByName('PrefabInstance');
  const eaMeta = getTraitByName('EntityAttributes');
  if (!eaMeta || !piMeta) return;
  // A world walk, not the entity index: editor tests stub the world module by an explicit export list. The
  // owned-root test comes first, so a move of anything else (most of them) costs one scan and no resolver.
  let self: Entity | undefined;
  for (const e of world.entities as Iterable<Entity>) if (e.id() === id) { self = e; break; }
  if (!self?.has(piMeta.trait)) return;
  const pi = self.get(piMeta.trait) as NonNullable<IdentityPi>;
  if (!isOwnedRoot(pi, id) || pi.ownerGuid) return;
  const owner = worldIdentityParents(world).ownerOf(id);
  let guid = '';
  for (const e of world.entities as Iterable<Entity>) {
    if (owner && e.id() === owner) { guid = e.has(eaMeta.trait) ? durableGuid((e.get(eaMeta.trait) as { guid?: string }).guid) : ''; break; }
  }
  if (guid) self.set(piMeta.trait, { ...pi, ownerGuid: guid });
}
