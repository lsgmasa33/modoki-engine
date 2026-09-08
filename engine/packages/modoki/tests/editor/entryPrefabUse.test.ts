/** entryPrefabUse (#671, editor half) — pure unit tests over `entryKindHitsFrom` fixture bodies,
 *  plus the `entryKindUsesOf` network wrapper mocked the same way `makeTexture2D.test.ts` mocks
 *  `backendFetch` for `textureRefCount`. Per CLAUDE.md's "editor .tsx carries no tests"
 *  convention, this never mounts the Inspector panel — the pure function and its network wrapper
 *  are the whole surface. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/editor/backend/editorBackend', () => ({ backendFetch: vi.fn() }));

import { backendFetch } from '../../src/editor/backend/editorBackend';
import { entryKindHitsFrom, entryKindUsesOf } from '../../src/editor/panels/entryPrefabUse';
import type { FindReferencesResultLike, RefHitLike, RefNodeLike } from '../../src/editor/panels/findReferencesFormat';

const mockedBackendFetch = vi.mocked(backendFetch);
const jsonRes = (body: unknown, ok = true) => ({ ok, json: () => Promise.resolve(body) } as Response);

beforeEach(() => { mockedBackendFetch.mockReset(); });

const targetNode: RefNodeLike = { kind: 'asset', id: 'asset:/assets/entry.prefab.json', path: '/assets/entry.prefab.json', name: 'entry.prefab.json' };

function bodyWith(direct: RefHitLike[], indirect: RefHitLike[] = []): FindReferencesResultLike {
  return {
    target: targetNode,
    direct,
    indirect,
    returnedCount: direct.length + indirect.length,
    totalCount: direct.length + indirect.length,
    truncated: false,
    unreferenced: direct.length === 0 && indirect.length === 0,
    reachable: true,
    warnings: [],
    unresolvedRefsFromTarget: [],
  };
}

function viewEntityHit(via: string, opts: { scenePath?: string; viewName?: string; fromEntity?: string } = {}): RefHitLike {
  const node: RefNodeLike = {
    kind: 'entity',
    id: 'entity:some-guid',
    path: opts.scenePath ?? '/assets/Level.scene.json',
    name: opts.viewName ?? 'ScrollView',
    guid: 'some-guid',
  };
  return {
    from: node,
    hops: 1,
    chain: [{ node, via, origin: 'own', ...(opts.fromEntity ? { fromEntity: opts.fromEntity } : {}) }],
    reachable: true,
  };
}

describe('entryKindHitsFrom (#671)', () => {
  it('maps a direct UIEntries.prefabs[].prefab hit to {scenePath, viewName}', () => {
    const hit = viewEntityHit('UIEntries.prefabs[].prefab', { scenePath: '/assets/Level.scene.json', viewName: 'ScrollView' });
    expect(entryKindHitsFrom(bodyWith([hit]))).toEqual([{ scenePath: '/assets/Level.scene.json', viewName: 'ScrollView' }]);
  });

  it('excludes a hit via a DIFFERENT via label (e.g. PrefabInstance.source)', () => {
    const hit = viewEntityHit('PrefabInstance.source');
    expect(entryKindHitsFrom(bodyWith([hit]))).toEqual([]);
  });

  it('excludes a multi-hop/indirect hit — it is never scanned from `direct`', () => {
    // An indirect hit (hops >= 2) whose FIRST chain step carries the right via label must still
    // not surface: entryKindHitsFrom only ever looks at `body.direct` (hops === 1).
    const indirectHit: RefHitLike = {
      from: { kind: 'entity', id: 'entity:g2', path: '/assets/Level.scene.json', name: 'ScrollView', guid: 'g2' },
      hops: 2,
      chain: [
        { node: { kind: 'entity', id: 'entity:g2', path: '/assets/Level.scene.json', name: 'ScrollView', guid: 'g2' }, via: 'UIEntries.prefabs[].prefab', origin: 'own' },
        { node: targetNode, via: 'PrefabInstance.source', origin: 'own' },
      ],
      reachable: true,
    };
    expect(entryKindHitsFrom(bodyWith([], [indirectHit]))).toEqual([]);
  });

  it('an empty result gives []', () => {
    expect(entryKindHitsFrom(bodyWith([]))).toEqual([]);
  });

  it('handles a malformed body (missing/non-array `direct`, or no body at all) without throwing', () => {
    expect(entryKindHitsFrom({} as FindReferencesResultLike)).toEqual([]);
    expect(entryKindHitsFrom({ direct: null } as unknown as FindReferencesResultLike)).toEqual([]);
    expect(entryKindHitsFrom(null as unknown as FindReferencesResultLike)).toEqual([]);
  });

  it('handles a hit with an empty chain without throwing', () => {
    const hit: RefHitLike = { from: targetNode, hops: 1, chain: [], reachable: true };
    expect(entryKindHitsFrom(bodyWith([hit]))).toEqual([]);
  });

  it('uses the EntityName@file label when the referring node has no guid of its own (fromEntity set)', () => {
    const hit = viewEntityHit('UIEntries.prefabs[].prefab', { scenePath: '/assets/Bank.prefab.json', viewName: 'Bank.prefab.json', fromEntity: 'ScrollView' });
    expect(entryKindHitsFrom(bodyWith([hit]))).toEqual([{ scenePath: '/assets/Bank.prefab.json', viewName: 'ScrollView@Bank.prefab.json' }]);
  });

  it('collects multiple direct entry-kind hits, in order', () => {
    const a = viewEntityHit('UIEntries.prefabs[].prefab', { scenePath: '/assets/A.scene.json', viewName: 'A' });
    const b = viewEntityHit('UIEntries.prefabs[].prefab', { scenePath: '/assets/B.scene.json', viewName: 'B' });
    expect(entryKindHitsFrom(bodyWith([a, b]))).toEqual([
      { scenePath: '/assets/A.scene.json', viewName: 'A' },
      { scenePath: '/assets/B.scene.json', viewName: 'B' },
    ]);
  });
});

describe('entryKindUsesOf (#671) — network wrapper', () => {
  it('delegates to entryKindHitsFrom on a well-formed 200 response', async () => {
    const hit = viewEntityHit('UIEntries.prefabs[].prefab', { scenePath: '/assets/Level.scene.json', viewName: 'ScrollView' });
    mockedBackendFetch.mockResolvedValue(jsonRes(bodyWith([hit])));
    expect(await entryKindUsesOf('some-guid')).toEqual([{ scenePath: '/assets/Level.scene.json', viewName: 'ScrollView' }]);
  });

  it('hits /api/find-references with the guid, URL-encoded', async () => {
    mockedBackendFetch.mockResolvedValue(jsonRes(bodyWith([])));
    await entryKindUsesOf('some guid/with-specials');
    expect(mockedBackendFetch).toHaveBeenCalledWith(`/api/find-references?target=${encodeURIComponent('some guid/with-specials')}`);
  });

  // `null` must stay distinct from `[]` — same rule textureRefCount's docblock states: "not an
  // entry kind" is a claim strong enough to change what the Inspector tells the author, and a
  // failed lookup must never be able to assert it.
  it('returns null — NOT [] — on a non-ok response (missing endpoint, 404, 500)', async () => {
    mockedBackendFetch.mockResolvedValue(jsonRes({ error: 'no asset or entity matches' }, false));
    expect(await entryKindUsesOf('missing-guid')).toBeNull();
  });

  it('returns null — NOT [] — when the response body carries an `error` field even with res.ok', async () => {
    mockedBackendFetch.mockResolvedValue(jsonRes({ error: 'nope' }, true));
    expect(await entryKindUsesOf('some-guid')).toBeNull();
  });

  it('returns null — NOT [] — on a malformed (non-JSON) body', async () => {
    mockedBackendFetch.mockResolvedValue({ ok: true, json: () => Promise.reject(new Error('not json')) } as unknown as Response);
    expect(await entryKindUsesOf('some-guid')).toBeNull();
  });

  it('returns null — NOT [] — when the fetch itself rejects (network error)', async () => {
    mockedBackendFetch.mockRejectedValue(new Error('network down'));
    expect(await entryKindUsesOf('some-guid')).toBeNull();
  });
});
