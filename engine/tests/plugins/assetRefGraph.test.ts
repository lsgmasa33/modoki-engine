/** Reverse reference graph tests (#284) — pure unit tests over hand-built
 *  `RefEdgeEnumeration` objects. No filesystem access: `buildRefGraph` and its
 *  queries are pure over the enumeration, so a fixture is just a few RefEdge/
 *  GraphEntity literals. See `engine/tests/plugins/assetRefGraphCourt.test.ts`
 *  for the integration test over a real project. */

import { describe, it, expect } from 'vitest';
import type { RefEdge, RefEdgeEnumeration, GraphEntity } from '../../plugins/asset-tree-shaker';
import { buildRefGraph, resolveTarget, findReferences } from '../../plugins/assetRefGraph';

// ── Fixture helper ────────────────────────────────────

function mkEnumeration(opts: {
  edges: RefEdge[];
  entities?: GraphEntity[];
  guidIndex?: Map<string, string>;
  allFiles?: string[];
  seeds?: string[];
}): RefEdgeEnumeration {
  return {
    edges: opts.edges,
    entities: opts.entities ?? [],
    guidIndex: opts.guidIndex ?? new Map(),
    guidOrigin: new Map(),
    allFiles: opts.allFiles ?? [],
    seeds: opts.seeds ?? [],
    warnings: [],
  };
}

// ── Direct reference ──────────────────────────────────

describe('findReferences — direct reference', () => {
  it('reports the referring entity at hops 1', () => {
    const enumeration = mkEnumeration({
      edges: [
        {
          from: { virtual: '/scene.json', entity: { guid: 'e1', name: 'Player' }, trait: 'Renderable2D', field: 'sprite' },
          to: '/assets/tex.png',
          raw: 'tex-guid',
          kind: 'asset',
          origin: 'own',
        },
        // A real v6+ scene also carries a bare `resources[]` entry per referenced asset,
        // sourced from the FILE itself (no entity) — this is what interns the scene's own
        // asset node, which `computeReachable` needs to seed into its entities. Points at
        // an unrelated asset so it doesn't add a second referrer of the texture under test.
        { from: { virtual: '/scene.json', field: 'resources[]' }, to: '/assets/dummy.json', raw: 'dummy-guid', kind: 'asset', origin: 'own' },
      ],
      entities: [{ virtual: '/scene.json', guid: 'e1', name: 'Player' }],
      guidIndex: new Map([['tex-guid', '/assets/tex.png']]),
      seeds: ['/scene.json'],
    });
    const graph = buildRefGraph(enumeration);
    const target = resolveTarget(graph, 'tex-guid')!;
    expect(target.path).toBe('/assets/tex.png');

    const result = findReferences(graph, target);
    expect(result.unreferenced).toBe(false);
    expect(result.direct).toHaveLength(1);
    expect(result.indirect).toHaveLength(0);
    const hit = result.direct[0]!;
    expect(hit.hops).toBe(1);
    expect(hit.from.kind).toBe('entity');
    expect(hit.from.guid).toBe('e1');
    expect(hit.chain).toHaveLength(1);
    expect(hit.chain[0]!.node.id).toBe(hit.from.id);
    expect(hit.chain[0]!.via).toBe('Renderable2D.sprite');
    // Reachable via the seed scene, which contains entity e1, which references the target.
    expect(result.reachable).toBe(true);
    expect(hit.reachable).toBe(true);
  });
});

// ── Indirect chain ────────────────────────────────────

describe('findReferences — indirect chain (entity -> mesh -> material -> texture)', () => {
  const enumeration = mkEnumeration({
    edges: [
      // Widget entity -> mesh
      {
        from: { virtual: '/scene2.json', entity: { guid: 'e2', name: 'Widget' }, trait: 'Renderable3D', field: 'mesh' },
        to: '/assets/mesh.mesh.json',
        raw: 'mesh-guid',
        kind: 'asset',
        origin: 'own',
      },
      // mesh -> material
      {
        from: { virtual: '/assets/mesh.mesh.json', field: 'material' },
        to: '/assets/mat.mat.json',
        raw: 'mat-guid',
        kind: 'material',
        origin: 'own',
      },
      // material -> texture
      {
        from: { virtual: '/assets/mat.mat.json', field: 'map' },
        to: '/assets/tex2.png',
        raw: 'tex2-guid',
        kind: 'texture',
        origin: 'own',
      },
    ],
    entities: [{ virtual: '/scene2.json', guid: 'e2', name: 'Widget' }],
    seeds: ['/scene2.json'],
  });
  const graph = buildRefGraph(enumeration);
  const target = graph.nodes.get('asset:/assets/tex2.png')!;

  it('reports the material as a direct (hops 1) hit', () => {
    const result = findReferences(graph, target);
    expect(result.direct).toHaveLength(1);
    expect(result.direct[0]!.from.path).toBe('/assets/mat.mat.json');
  });

  it('reports the mesh at hops 2 and the entity at hops 3, chain ordered from -> target', () => {
    const result = findReferences(graph, target);
    expect(result.indirect).toHaveLength(2);

    const meshHit = result.indirect.find(h => h.hops === 2)!;
    expect(meshHit.from.path).toBe('/assets/mesh.mesh.json');

    const entityHit = result.indirect.find(h => h.hops === 3)!;
    expect(entityHit.from.kind).toBe('entity');
    expect(entityHit.from.guid).toBe('e2');
    expect(entityHit.chain).toHaveLength(3);
    // from FIRST: chain[0] is the entity's own step (the thing a human edits).
    expect(entityHit.chain[0]!.node.id).toBe(entityHit.from.id);
    expect(entityHit.chain[0]!.via).toBe('Renderable3D.mesh');
    expect(entityHit.chain[1]!.node.path).toBe('/assets/mesh.mesh.json');
    expect(entityHit.chain[1]!.via).toBe('material');
    // target LAST-ADJACENT: the final chain step is the node that directly references the target.
    expect(entityHit.chain[2]!.node.path).toBe('/assets/mat.mat.json');
    expect(entityHit.chain[2]!.via).toBe('map');
  });
});

// ── unreferenced is NOT direct.length === 0 ───────────

describe('findReferences — unreferenced', () => {
  it('is true only when nothing references the target at all, not merely when `direct` is empty after truncation', () => {
    const enumeration = mkEnumeration({
      edges: [
        {
          from: { virtual: '/scene.json', entity: { guid: 'e1', name: 'Player' }, trait: 'Renderable2D', field: 'sprite' },
          to: '/assets/tex.png',
          raw: 'tex-guid',
          kind: 'asset',
          origin: 'own',
        },
      ],
      entities: [{ virtual: '/scene.json', guid: 'e1', name: 'Player' }],
    });
    const graph = buildRefGraph(enumeration);
    const target = graph.nodes.get('asset:/assets/tex.png')!;

    // limit:0 truncates the RETURNED direct array to empty, but the target still has a
    // real referrer — unreferenced must read the total hit count, not the truncated
    // `direct` array, or this reports a used asset as unreferenced.
    const truncated = findReferences(graph, target, { limit: 0 });
    expect(truncated.direct).toHaveLength(0);
    expect(truncated.totalCount).toBe(1);
    expect(truncated.unreferenced).toBe(false);

    // A target with genuinely no referrer.
    const lonelyTarget = { kind: 'asset' as const, id: 'asset:/assets/nobody-refs-me.png', path: '/assets/nobody-refs-me.png', name: 'nobody-refs-me.png' };
    const empty = findReferences(graph, lonelyTarget);
    expect(empty.direct).toHaveLength(0);
    expect(empty.totalCount).toBe(0);
    expect(empty.unreferenced).toBe(true);
  });
});

// ── Edge dedupe ────────────────────────────────────────

describe('buildRefGraph — edge dedupe', () => {
  it('collapses the same ref emitted twice into one hit', () => {
    const edge: RefEdge = {
      from: { virtual: '/scene.json', entity: { guid: 'e1', name: 'Player' }, trait: 'Renderable2D', field: 'sprite' },
      to: '/assets/tex.png',
      raw: 'tex-guid',
      kind: 'asset',
      origin: 'own',
    };
    const enumeration = mkEnumeration({
      // Two structurally-equal edges (as `probeTraitRefs`'s two overlapping probes emit) — not
      // the same object reference, but the same edgeKey().
      edges: [edge, { ...edge }],
      entities: [{ virtual: '/scene.json', guid: 'e1', name: 'Player' }],
    });
    const graph = buildRefGraph(enumeration);
    const target = graph.nodes.get('asset:/assets/tex.png')!;
    // Assert on the RAW edge list, not just findReferences' output — findReferences'
    // own per-NODE `visited` set would mask an undeduped edge list too (a second edge
    // from the same referrer never produces a second hit either way), so only the raw
    // inbound/outbound arrays actually prove buildRefGraph deduped by edgeKey().
    expect(graph.inbound.get(target.id) ?? []).toHaveLength(1);
    expect(graph.outbound.get(edge.from.entity ? `entity:${edge.from.entity.guid}` : `asset:${edge.from.virtual}`) ?? []).toHaveLength(1);

    const result = findReferences(graph, target);
    expect(result.totalCount).toBe(1);
    expect(result.direct).toHaveLength(1);
  });
});

// ── Self-edges dropped ─────────────────────────────────

describe('buildRefGraph — self-edges', () => {
  it('drops a PrefabInstance.rootInstanceId naming its own entity as a reference', () => {
    const enumeration = mkEnumeration({
      edges: [
        {
          from: { virtual: '/scene.json', entity: { guid: 'p1', name: 'Instance' }, trait: 'PrefabInstance', field: 'rootInstanceId' },
          to: null,
          raw: 'p1',
          kind: 'entity?',
        },
      ],
      entities: [{ virtual: '/scene.json', guid: 'p1', name: 'Instance' }],
    });
    const graph = buildRefGraph(enumeration);
    const selfNode = graph.entityByGuid.get('p1')!;
    expect(graph.inbound.get(selfNode.id) ?? []).toHaveLength(0);
    expect(graph.outbound.get(selfNode.id) ?? []).toHaveLength(0);
    expect(graph.dangling).toHaveLength(0);

    const result = findReferences(graph, selfNode);
    expect(result.unreferenced).toBe(true);
  });
});

// ── reachable / reachableOnly ──────────────────────────

describe('findReferences — reachable', () => {
  it('marks a referrer unreachable from the seeds, and reachableOnly excludes it', () => {
    const enumeration = mkEnumeration({
      edges: [
        // No path from the seed to /orphan.mesh.json — it references the target, but a
        // production build never walks it.
        {
          from: { virtual: '/orphan.mesh.json', field: 'material' },
          to: '/assets/orphaned-tex.png',
          raw: 'mat-guid',
          kind: 'material',
          origin: 'own',
        },
      ],
      seeds: ['/root.scene.json'],
    });
    const graph = buildRefGraph(enumeration);
    const target = graph.nodes.get('asset:/assets/orphaned-tex.png')!;
    expect(graph.reachable.has(target.id)).toBe(false);

    const all = findReferences(graph, target);
    expect(all.direct).toHaveLength(1);
    expect(all.direct[0]!.reachable).toBe(false);
    expect(all.reachable).toBe(false);

    const only = findReferences(graph, target, { reachableOnly: true });
    expect(only.direct).toHaveLength(0);
    expect(only.unreferenced).toBe(true);
  });
});

// ── limit / truncated / returnedCount vs totalCount ────

describe('findReferences — limit and truncation', () => {
  it('truncates the returned hits but reports the true total', () => {
    const edges: RefEdge[] = ['a', 'b', 'c'].map((id) => ({
      from: { virtual: `/scene-${id}.json`, entity: { guid: `e-${id}`, name: `Referrer${id}` }, trait: 'Renderable2D', field: 'sprite' },
      to: '/assets/shared-tex.png',
      raw: 'tex-guid',
      kind: 'asset',
      origin: 'own',
    }));
    const enumeration = mkEnumeration({
      edges,
      entities: ['a', 'b', 'c'].map((id) => ({ virtual: `/scene-${id}.json`, guid: `e-${id}`, name: `Referrer${id}` })),
    });
    const graph = buildRefGraph(enumeration);
    const target = graph.nodes.get('asset:/assets/shared-tex.png')!;

    const result = findReferences(graph, target, { limit: 2 });
    expect(result.totalCount).toBe(3);
    expect(result.returnedCount).toBe(2);
    expect(result.direct).toHaveLength(2);
    expect(result.truncated).toBe(true);

    const untruncated = findReferences(graph, target, { limit: 50 });
    expect(untruncated.truncated).toBe(false);
    expect(untruncated.returnedCount).toBe(3);
  });
});

// ── Cycle safety ───────────────────────────────────────

describe('findReferences — reference cycles', () => {
  it('terminates on a cycle and does not duplicate a referrer', () => {
    const enumeration = mkEnumeration({
      edges: [
        { from: { virtual: '/m1.mesh.json', field: 'x' }, to: '/target-tex.png', raw: 'r1', kind: 'asset', origin: 'own' },
        { from: { virtual: '/m2.mesh.json', field: 'y' }, to: '/m1.mesh.json', raw: 'r2', kind: 'asset', origin: 'own' },
        { from: { virtual: '/m1.mesh.json', field: 'z' }, to: '/m2.mesh.json', raw: 'r3', kind: 'asset', origin: 'own' },
      ],
    });
    const graph = buildRefGraph(enumeration);
    const target = graph.nodes.get('asset:/target-tex.png')!;

    const result = findReferences(graph, target);
    // m1 -> target (hops 1), m2 -> m1 (hops 2); the cycle edge m1 -> m2 must NOT re-visit
    // m1 a second time (which a naive walk without a visited-set would loop on forever).
    expect(result.totalCount).toBe(2);
    expect(result.direct).toHaveLength(1);
    expect(result.direct[0]!.from.path).toBe('/m1.mesh.json');
    expect(result.indirect).toHaveLength(1);
    expect(result.indirect[0]!.from.path).toBe('/m2.mesh.json');
    // m1 appears exactly once across the whole hit list, despite the cycle.
    const m1Hits = [...result.direct, ...result.indirect].filter(h => h.from.path === '/m1.mesh.json');
    expect(m1Hits).toHaveLength(1);
  });
});

// ── resolveTarget ──────────────────────────────────────

describe('resolveTarget', () => {
  const enumeration = mkEnumeration({
    edges: [
      {
        from: { virtual: '/scene.json', entity: { guid: 'e1', name: 'Player' }, trait: 'Renderable2D', field: 'sprite' },
        to: '/assets/tex.png',
        raw: 'tex-guid',
        kind: 'asset',
        origin: 'own',
      },
    ],
    entities: [{ virtual: '/scene.json', guid: 'e1', name: 'Player' }],
    guidIndex: new Map([['tex-guid', '/assets/tex.png']]),
  });
  const graph = buildRefGraph(enumeration);

  it('resolves an asset guid', () => {
    const node = resolveTarget(graph, 'tex-guid');
    expect(node?.kind).toBe('asset');
    expect(node?.path).toBe('/assets/tex.png');
  });

  it('resolves an entity guid', () => {
    const node = resolveTarget(graph, 'e1');
    expect(node?.kind).toBe('entity');
    expect(node?.name).toBe('Player');
  });

  it('resolves a virtual path', () => {
    const node = resolveTarget(graph, '/assets/tex.png');
    expect(node?.kind).toBe('asset');
    expect(node?.id).toBe('asset:/assets/tex.png');
  });

  it('returns null for an empty string', () => {
    expect(resolveTarget(graph, '')).toBeNull();
    expect(resolveTarget(graph, '   ')).toBeNull();
  });

  it('refuses a path with no node UNLESS the file actually exists (a typo is a refusal, not "unreferenced")', () => {
    // Not a graph node (nothing references or is referenced by it) AND not in
    // enumeration.allFiles — a typo'd/deleted path. Synthesizing a node here would let
    // a caller ask about a path that never existed and get back `unreferenced: true`,
    // which reads as "safe to delete".
    expect(resolveTarget(graph, '/assets/does-not-exist.png')).toBeNull();

    // A REAL file that just happens to have no edges touching it (never became a graph
    // node) must still resolve — an on-disk file nothing references is the orphan case
    // exists to report, and it has to be reachable by path to report it correctly.
    const withOrphanFile = mkEnumeration({
      edges: [],
      allFiles: ['/assets/orphan.png'],
    });
    const orphanGraph = buildRefGraph(withOrphanFile);
    const node = resolveTarget(orphanGraph, '/assets/orphan.png');
    expect(node?.kind).toBe('asset');
    expect(node?.path).toBe('/assets/orphan.png');
  });
});

