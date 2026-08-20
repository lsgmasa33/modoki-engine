/** Reverse reference graph — "what references this?" (#284).
 *
 *  `asset-tree-shaker.ts` walks the project's reference graph FORWARD (scene →
 *  prefab → mesh → material → texture) to decide what a production build ships.
 *  This module inverts that same walk. It does not re-derive it: the edges come
 *  from `enumerateRefEdges`, which is the shaker's own walk with an observer
 *  attached, so there is exactly one implementation of "what counts as a
 *  reference" and it is the one the build already depends on.
 *
 *  Why that matters more than it sounds: the graph has IMPLICIT edges that no
 *  file records — most importantly a DOM `imageSrc` holds the auto-emitted
 *  whole-image sprite guid `deriveGuid('sprite:' + textureGuid)`, not the
 *  texture's own guid. An ad-hoc sweep that greps for the texture's guid finds
 *  nothing and reports "unused" for a texture wired minutes earlier — which is
 *  what happened, to every icon in `games/court`, and is why this module exists.
 *  A hand-rolled second walker would reacquire that blind spot, and a wrong
 *  "0 references" is indistinguishable from a correct one.
 *
 *  Pure over the enumeration — no filesystem access of its own — so it is
 *  testable without a project on disk. */

import type { RefEdge, RefEdgeEnumeration, GraphEntity, GuidOrigin } from './asset-tree-shaker';

// ── Node identity ─────────────────────────────────────

export type RefNodeKind = 'asset' | 'entity';

/** One node in the graph. `id` is unique across both kinds and is what the
 *  adjacency maps are keyed by. */
export interface RefNode {
  kind: RefNodeKind;
  /** `asset:<virtualPath>` or `entity:<guid>`. */
  id: string;
  /** Virtual path — set for an asset, and for an entity it is the scene/prefab
   *  file the entity is authored in. */
  path: string;
  /** Display name — the entity's name, or the asset's basename. */
  name: string;
  /** Entity guid, for an entity node. */
  guid?: string;
}

function assetNode(virtual: string): RefNode {
  return { kind: 'asset', id: `asset:${virtual}`, path: virtual, name: virtual.split('/').pop() || virtual };
}

function entityNode(e: GraphEntity): RefNode {
  return { kind: 'entity', id: `entity:${(e.guid ?? '').toLowerCase()}`, path: e.virtual, name: e.name || '(unnamed)', guid: e.guid };
}

// ── The graph ─────────────────────────────────────────

/** One edge, resolved to graph nodes. `via` names the slot that held the ref
 *  (`Renderable2D.sprite`, `material.map`, `resources[]`) — the thing a human has
 *  to go and change if they want the reference gone. */
export interface GraphEdge {
  from: RefNode;
  to: RefNode;
  via: string;
  /** Name of the entity the ref was authored on, when that entity has no guid of
   *  its own and `from` is therefore the FILE. Display only — there is nothing to
   *  address. Without it a prefab's refs all read as "tray-badge.prefab.json",
   *  losing the "Entity Coin references this" half of the answer. */
  fromEntity?: string;
  /** Provenance of the guid to path resolution. Anything but `'own'` is an
   *  implicit edge no file records — worth showing, because it is precisely the
   *  kind a reader would not have found by searching. */
  origin: GuidOrigin | 'entity-ref';
  /** The value as authored, when it differs from the target's own id — i.e. the
   *  guid actually written in the file. Present for implicit edges. */
  raw?: string;
}

export interface RefGraph {
  /** node id to the edges POINTING AT it. The reverse index. */
  inbound: Map<string, GraphEdge[]>;
  /** node id to the edges leaving it. Used for reachability. */
  outbound: Map<string, GraphEdge[]>;
  /** Every node, by id. */
  nodes: Map<string, RefNode>;
  /** Node ids reachable from the build's seed set. A node outside this is
   *  dropped from a production build — so a reference FROM one is real but
   *  weaker, and the difference is what makes a delete decision safe. */
  reachable: Set<string>;
  /** guid (lowercase) to the asset virtual path it resolves to. */
  guidIndex: Map<string, string>;
  /** guid (lowercase) to entity node. */
  entityByGuid: Map<string, RefNode>;
  /** Every asset file on disk, NFC-normalized. `resolveTarget` needs it to tell
   *  "this file exists and nothing references it" from "there is no such file" —
   *  see the note there for why answering the second as the first is a defect. */
  files: Set<string>;
  /** Guid-shaped values that resolved to neither a tracked asset nor an entity —
   *  from a declared asset slot (a mesh's `model`, a material's texture slot, a
   *  `resources[]` entry) as well as from the generic entity-ref sweep.
   *
   *  ⚠️ A LEAD, not a verdict. The shaker's guid index only covers asset kinds it
   *  classifies, so a ref to a GAME-DEFINED JSON kind lands here even when the file
   *  exists — measured on `games/court`, whose `.court.json` levels are
   *  `unknown-json` to `classify()`. Present it as "could not resolve", never as
   *  "broken". */
  dangling: Array<{ from: RefNode; via: string; guid: string }>;
  warnings: string[];
}

/** Stable identity for an edge, so the two probes that overlap inside
 *  `probeTraitRefs` (the REF_FIELDS_BY_TRAIT registry loop and the generic
 *  guid sweep) do not report the same reference twice. Measured on
 *  `games/court`: every `Renderable2D.sprite` was emitted by both. */
function edgeKey(e: RefEdge): string {
  return [e.from.virtual, e.from.entity?.guid ?? '', e.from.trait ?? '', e.from.field ?? '', e.raw, e.to ?? ''].join(' ');
}

/** `Trait.field`, or just the field, or a bare label. */
function viaLabel(e: RefEdge): string {
  if (e.from.trait && e.from.field) return `${e.from.trait}.${e.from.field}`;
  return e.from.field ?? e.from.trait ?? e.kind;
}

function push(map: Map<string, GraphEdge[]>, key: string, edge: GraphEdge): void {
  const list = map.get(key);
  if (list) list.push(edge);
  else map.set(key, [edge]);
}

export function buildRefGraph(enumeration: RefEdgeEnumeration): RefGraph {
  const nodes = new Map<string, RefNode>();
  const inbound = new Map<string, GraphEdge[]>();
  const outbound = new Map<string, GraphEdge[]>();
  const dangling: RefGraph['dangling'] = [];

  const intern = (n: RefNode): RefNode => {
    const existing = nodes.get(n.id);
    if (existing) return existing;
    nodes.set(n.id, n);
    return n;
  };

  // Entities first — an `entity?` edge can only be resolved against a complete index,
  // and a forward reference (an entity naming one declared later in the file) is
  // ordinary. Entities with no guid are skipped: they have no identity anything could
  // reference, so they can be an edge's SOURCE (via their file) but never its target.
  const entityByGuid = new Map<string, RefNode>();
  for (const e of enumeration.entities) {
    if (!e.guid) continue;
    const node = intern(entityNode(e));
    entityByGuid.set(e.guid.toLowerCase(), node);
  }

  const seen = new Set<string>();
  for (const edge of enumeration.edges) {
    const key = edgeKey(edge);
    if (seen.has(key)) continue;
    seen.add(key);

    // Source: the entity when the ref came from one AND that entity has a guid;
    // otherwise the file itself (a material's texture slots, a mesh's model, an
    // entity the author never gave a guid).
    const fromGuid = edge.from.entity?.guid?.toLowerCase();
    const from = fromGuid && entityByGuid.has(fromGuid)
      ? entityByGuid.get(fromGuid)!
      : intern(assetNode(edge.from.virtual));

    let to: RefNode;
    let origin: GraphEdge['origin'];
    if (edge.to) {
      to = intern(assetNode(edge.to));
      origin = edge.origin ?? 'own';
    } else if (edge.kind === 'font-family') {
      // A family NAME, not a guid. `resolveFontsByFamily` turns families into files at
      // the END of the shake, and that resolution is not per-edge, so there is no
      // single node to point at — and it is not unresolved either.
      continue;
    } else {
      // `to` is null and this is not a font family, so `pushRef` emitted it from its
      // guid-miss branch: a guid that is NOT in the asset index. Two outcomes.
      //
      // `entity?` is the generic trait sweep's guess that a guid might name an entity,
      // so it gets looked up. Every OTHER kind is a DECLARED asset slot (a mesh's
      // `model`, a material's `map`, a `resources[]` entry, an Animator clip bank), and
      // an unresolvable guid in one of those is simply broken — the shake itself already
      // warns `unresolved GUID ref:` about it.
      //
      // Both land in `dangling`. They did not: this branch used to `continue` for
      // everything that was not `entity?`, so a `.mesh.json` whose `model` guid pointed
      // at nothing reported `unresolvedRefsFromTarget: []` — the structured signal
      // silently absent for exactly the asset-to-asset refs it claims to cover, while
      // the doc comment promised the opposite. Found in the #284 close-out review.
      const target = edge.kind === 'entity?' ? entityByGuid.get(edge.raw.toLowerCase()) : undefined;
      if (!target) {
        dangling.push({ from, via: viaLabel(edge), guid: edge.raw });
        continue;
      }
      to = target;
      origin = 'entity-ref';
    }

    // A self-edge is not a reference. `PrefabInstance.rootInstanceId` on an instance
    // ROOT names that instance's own guid, so every prefab instance in the project
    // would otherwise report itself as a referrer of itself — noise that also makes
    // `unreferenced` wrong, since a self-edge is an inbound edge.
    if (from.id === to.id) continue;

    const g: GraphEdge = { from, to, via: viaLabel(edge), origin };
    if (from.kind === 'asset' && edge.from.entity?.name) g.fromEntity = edge.from.entity.name;
    // Show the authored guid only when it is NOT the target's own id — i.e. when the
    // edge is implicit and a reader searching for the target's guid would have missed it.
    if (origin !== 'own' && origin !== 'entity-ref') g.raw = edge.raw;

    push(inbound, to.id, g);
    push(outbound, from.id, g);
  }

  return {
    inbound,
    outbound,
    nodes,
    reachable: computeReachable(enumeration.seeds, nodes, outbound),
    guidIndex: enumeration.guidIndex,
    entityByGuid,
    files: new Set(enumeration.allFiles.map(f => f.virtual.normalize('NFC'))),
    dangling,
    warnings: enumeration.warnings,
  };
}

/** Forward BFS from the SHAKE's real seeds (scenes + keep-list), not from every
 *  walkable file. This is what separates "referenced" from "referenced only by
 *  something that is itself dropped from the build" — the distinction a human
 *  needs before deleting anything.
 *
 *  An entity is reachable iff its FILE is: keeping a scene keeps everything its
 *  entities reference, and an entity has no independent existence in the build. */
function computeReachable(
  seeds: string[],
  nodes: Map<string, RefNode>,
  outbound: Map<string, GraphEdge[]>,
): Set<string> {
  // Precomputed rather than scanned per file: the scan is O(files x nodes), which is
  // invisible on a 250-entity project and is not on a large one.
  const entitiesByFile = new Map<string, RefNode[]>();
  for (const n of nodes.values()) {
    if (n.kind !== 'entity') continue;
    const list = entitiesByFile.get(n.path);
    if (list) list.push(n);
    else entitiesByFile.set(n.path, [n]);
  }
  const reachable = new Set<string>();
  const queue: string[] = [];
  const visit = (id: string): void => {
    if (reachable.has(id)) return;
    reachable.add(id);
    queue.push(id);
  };

  for (const seed of seeds) visit(`asset:${seed}`);

  while (queue.length > 0) {
    const id = queue.shift()!;
    // Reaching a scene/prefab file reaches every entity authored in it, and those
    // entities' own refs. Folded in here rather than as a second pass, so a file
    // discovered LATE in the walk still pulls its entities in.
    //
    // The path comes from the ID, NOT from `nodes.get(id)`. A file only becomes a
    // node by appearing at one END of an edge, and a prefab whose every ref is
    // authored on a guid-bearing entity never does — the entity is the edge source,
    // not the file. Looking the node up first therefore skipped the fold for exactly
    // those files, and a prefab named in the keep-list read as though nothing it
    // contained survived the build. Real v6+ SCENES hid this, because their
    // `resources[]` manifest always emits one file-sourced edge.
    if (id.startsWith('asset:')) {
      for (const child of entitiesByFile.get(id.slice('asset:'.length)) ?? []) visit(child.id);
    }
    for (const e of outbound.get(id) ?? []) visit(e.to.id);
  }
  return reachable;
}

// ── Query ─────────────────────────────────────────────

/** One step of the chain from a referrer down to the target. */
export interface RefChainStep {
  node: RefNode;
  /** See `GraphEdge.fromEntity` — the un-addressable entity the ref sits on. */
  fromEntity?: string;
  /** The slot on `node` that holds the ref to the NEXT step. */
  via: string;
  origin: GraphEdge['origin'];
  raw?: string;
}

export interface RefHit {
  /** The thing that (transitively) references the target. */
  from: RefNode;
  /** 1 = a direct reference; 2+ = through that many intermediate assets. */
  hops: number;
  /** `from` down to the target, so a human can see WHERE to break the link. */
  chain: RefChainStep[];
  /** False when `from` is itself dropped from a production build. */
  reachable: boolean;
}

export interface FindReferencesResult {
  target: RefNode;
  /** hops === 1. */
  direct: RefHit[];
  /** hops >= 2, nearest first. */
  indirect: RefHit[];
  /** Hits in this response. */
  returnedCount: number;
  /** Hits found before `limit` was applied. */
  totalCount: number;
  truncated: boolean;
  /** True when NOTHING references the target — the "is this still used?" answer.
   *  Distinct from `direct.length === 0`, which can still have indirect hits. */
  unreferenced: boolean;
  /** Whether the target itself survives a production build. */
  reachable: boolean;
  warnings: string[];
}

/** The exact JSON body `GET /api/find-references` returns — the result plus the
 *  route's own additions. Declared here rather than inline in the router so both
 *  ends of the wire name ONE type: the editor dialog mirrors this shape (it cannot
 *  import this module, which pulls filesystem code into the browser bundle), and
 *  `engine/tests/plugins/findReferencesWireShape.test.ts` fails typecheck if the
 *  mirror stops accepting what this sends. A hand-sync promise is not a guard. */
export interface FindReferencesResponse extends FindReferencesResult {
  /** Guid-shaped values ON THE TARGET that resolved to neither an asset nor an
   *  entity. A lead, not a verdict — see `RefGraph.dangling`. */
  unresolvedRefsFromTarget: Array<{ via: string; guid: string }>;
}

export interface FindReferencesOptions {
  /** Max hits returned (direct first, then nearest indirect). Default 50. */
  limit?: number;
  /** Max hops to walk backwards. Default 6 — deep enough for
   *  entity to mesh to material to texture with room to spare. */
  maxDepth?: number;
  /** Only count references that survive a production build. Default false. */
  reachableOnly?: boolean;
}

/** Resolve a target string — a guid (asset OR entity) or a virtual path — to a node. */
export function resolveTarget(graph: RefGraph, target: string): RefNode | null {
  const t = target.trim();
  if (!t) return null;
  if (t.startsWith('/')) {
    const known = graph.nodes.get(`asset:${t}`);
    if (known) return known;
    // A path with no node is fine — a file nothing references and that references
    // nothing never becomes one — but only if the FILE EXISTS. Synthesizing a node
    // for any `/`-shaped string made a typo'd or deleted path answer
    // `unreferenced: true`, which reads as "safe to delete" and is the §5
    // could-not-look-reported-as-nothing-there failure. Unknown path is a refusal.
    return graph.files.has(t.normalize('NFC')) ? assetNode(t) : null;
  }
  const lower = t.toLowerCase();
  const entity = graph.entityByGuid.get(lower);
  if (entity) return entity;
  const asset = graph.guidIndex.get(lower);
  // An asset guid resolves through the SAME index the shaker resolves refs by, so a
  // derived-sprite guid and its texture's own guid answer identically — which is the
  // point: a caller holding either one is asking about the same file.
  if (asset) return graph.nodes.get(`asset:${asset}`) ?? assetNode(asset);
  return null;
}

/** Walk the reverse index backwards from `target`, breadth-first, returning every
 *  referrer with the chain that reaches the target. */
export function findReferences(graph: RefGraph, target: RefNode, opts: FindReferencesOptions = {}): FindReferencesResult {
  const limit = opts.limit ?? 50;
  // Floored at 1 deliberately. `maxDepth: 0` skipped the loop entirely and returned
  // `unreferenced: true` no matter what actually referenced the target — a value that
  // reads as "safe to delete". The HTTP route and the MCP schema both already reject 0,
  // so this guards the exported function against its own worst answer rather than any
  // reachable caller.
  const maxDepth = Math.max(1, opts.maxDepth ?? 6);

  const hits: RefHit[] = [];
  // Visited by NODE, not by chain: a diamond (two meshes sharing one material) would
  // otherwise enumerate a combinatorial number of chains through the same referrers,
  // and the second chain tells a human nothing the first did not.
  const visited = new Set<string>([target.id]);
  let frontier: Array<{ node: RefNode; chain: RefChainStep[] }> = [{ node: target, chain: [] }];

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: typeof frontier = [];
    for (const { node, chain } of frontier) {
      for (const edge of graph.inbound.get(node.id) ?? []) {
        if (visited.has(edge.from.id)) continue;
        visited.add(edge.from.id);
        const reachable = graph.reachable.has(edge.from.id);
        if (opts.reachableOnly && !reachable) continue;
        const step: RefChainStep = { node: edge.from, via: edge.via, origin: edge.origin };
        if (edge.fromEntity) step.fromEntity = edge.fromEntity;
        if (edge.raw) step.raw = edge.raw;
        const fullChain = [step, ...chain];
        hits.push({ from: edge.from, hops: depth, chain: fullChain, reachable });
        next.push({ node: edge.from, chain: fullChain });
      }
    }
    frontier = next;
  }

  const direct = hits.filter(h => h.hops === 1);
  const indirect = hits.filter(h => h.hops > 1).sort((a, b) => a.hops - b.hops);
  const ordered = [...direct, ...indirect].slice(0, limit);

  return {
    target,
    direct: ordered.filter(h => h.hops === 1),
    indirect: ordered.filter(h => h.hops > 1),
    returnedCount: ordered.length,
    totalCount: hits.length,
    truncated: hits.length > ordered.length,
    unreferenced: hits.length === 0,
    reachable: graph.reachable.has(target.id),
    warnings: graph.warnings,
  };
}

/** Every asset node nothing references — the "unreferenced assets" query, which
 *  falls out of the reverse index as "inbound is empty".
 *
 *  ⚠️ This is NOT the same question as `/api/unused-assets`, and the difference is
 *  load-bearing. That route asks "would a production build DROP this?", which is
 *  about reachability from a root; this one asks "does anything point at it?". A
 *  root scene is referenced by nothing and is emphatically not unused, so seeds are
 *  excluded here. Reaching for this one when you meant the other reports every
 *  scene in the project as garbage. */
export function findUnreferenced(graph: RefGraph, enumeration: RefEdgeEnumeration): RefNode[] {
  const seedIds = new Set(enumeration.seeds.map(s => `asset:${s}`));
  const out: RefNode[] = [];
  // Over EVERY file on disk, not over the graph's nodes. A file with no refs in and
  // none out never appears in an edge, so it is not a node — and it is exactly the
  // file this query exists to find. Iterating nodes would answer "nothing is
  // unreferenced" for a project full of orphans.
  for (const { virtual } of enumeration.allFiles) {
    const id = `asset:${virtual}`;
    if (seedIds.has(id)) continue;
    if ((graph.inbound.get(id) ?? []).length > 0) continue;
    out.push(graph.nodes.get(id) ?? { kind: 'asset', id, path: virtual, name: virtual.split('/').pop() || virtual });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
