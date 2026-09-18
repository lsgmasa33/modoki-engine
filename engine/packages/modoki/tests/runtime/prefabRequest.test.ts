/**
 * `requestPrefab` (#1376) — the one re-acquire latch every runtime prefab spawner calls.
 *
 * One test per duty, driven through the REAL `acquirePrefab`/`fetchPrefab` with only `fetch` stubbed,
 * so the premise the whole design rests on is exercised rather than restated: a failed fetch
 * RESOLVES with the cache still empty. A stub of `acquirePrefab` itself would assert the mock.
 *
 * Ported from wordweave's `celebrationFxReacquire.test.ts`, which carried the worked version of this
 * latch (#1359) before it moved into the engine.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearManifest, registerAsset } from '../../src/runtime/loaders/assetManifest';
import { disposeAllCachedResources, getCachedPrefab, getResourceStats, invalidatePrefab } from '../../src/runtime/loaders/meshTemplateCache';
import {
  MAX_PREFAB_FETCH_ATTEMPTS as MAX, __resetPrefabRequests, requestPrefab,
} from '../../src/runtime/loaders/prefabRequest';
import { createTestWorld } from '../../src/runtime/harness/createTestWorld';

const GUID = '55555555-2222-4333-8444-777777777777';
const PATH = '/games/g/assets/prefab/requested.prefab.json';
const OWNER = 0x7e_57;
const DOC = { version: 1, id: GUID, entities: [{ localId: 'root', traits: {} }] };

/** What the server does with the next fetch — each test sets it. */
let serve: 'fail' | 'ok' | 'empty' = 'fail';
/** When set, every fetch parks on this until the test releases it. */
let gate: Promise<void> | null = null;
let fetches = 0;

let tw: ReturnType<typeof createTestWorld>;

/** Let the fetch and the `.finally` behind it run. */
const settle = () => new Promise((r) => setTimeout(r, 0));
const req = (opts?: Parameters<typeof requestPrefab>[2]) => requestPrefab(OWNER, GUID, opts);
const unavailable = () => tw.events({ type: 'prefab/unavailable' });

async function exhaust(): Promise<void> {
  for (let i = 0; i < MAX; i++) { req(); await settle(); }
}

beforeEach(() => {
  serve = 'fail'; gate = null; fetches = 0;
  clearManifest();
  registerAsset(GUID, PATH, 'prefab');
  vi.stubGlobal('fetch', vi.fn(async () => {
    fetches++;
    if (gate) await gate;
    if (serve === 'fail') return { ok: false, status: 503, statusText: 'Unavailable', text: async () => '' } as unknown as Response;
    const body = serve === 'ok' ? DOC : { ...DOC, entities: [] };
    return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(body) } as unknown as Response;
  }));
  __resetPrefabRequests();
  tw = createTestWorld({ seed: 1 });
});

afterEach(() => {
  tw.dispose();
  __resetPrefabRequests();
  disposeAllCachedResources();
  clearManifest();
  vi.unstubAllGlobals();
});

describe('the premise — acquirePrefab resolves on a failed fetch', () => {
  it('a 503 settles without filling the cache and without rejecting', async () => {
    // If this ever starts rejecting, the budget below is reading the wrong signal.
    expect(req()).toBeNull();
    await settle();
    expect(fetches).toBe(1);
    expect(getCachedPrefab(GUID)).toBeFalsy();
  });
});

describe('in-flight dedup', () => {
  it('calls during an outstanding fetch spend NO budget (#1373: a per-frame caller)', async () => {
    // ⚠️ Counting network fetches cannot test this: `fetchPrefab` shares one promise per path, so
    // five calls make one request with or without the dedup. What the dedup protects is the BUDGET —
    // without it, five calls during one slow fetch spend all three attempts, and a single failed
    // request becomes a permanent give-up. So: fail one gated fetch, then ask again.
    let release!: () => void;
    gate = new Promise<void>((r) => { release = r; });
    for (let i = 0; i < 5; i++) req();
    gate = null;
    release();
    await settle();
    expect(unavailable(), 'one failed fetch is not a give-up').toHaveLength(0);
    req(); await settle();
    expect(fetches, 'the next call still has budget to fetch with').toBe(2);
  });

  it('releases the hold on a FAILED settle, so a later call retries (the five latching copies)', async () => {
    req(); await settle();
    req(); await settle();
    expect(fetches).toBe(2);
  });

  it('keeps deduping against a fetch still in flight across a world swap', async () => {
    let release!: () => void;
    gate = new Promise<void>((r) => { release = r; });
    req();
    tw.dispose();
    tw = createTestWorld({ seed: 1 });
    req(); // the new world rides the outstanding fetch
    expect(fetches).toBe(1);

    gate = null;
    release();
    await settle();
    req();
    expect(fetches).toBe(2);
  });

  it('is keyed per OWNER, so a second owner still takes its own hold', async () => {
    // fetchPrefab shares one network request between them; what matters is that BOTH owners end up
    // holding the prefab, or `releaseAllForScene(firstOwner)` evicts it from under the second.
    serve = 'ok';
    requestPrefab(OWNER, GUID);
    requestPrefab(OWNER + 1, GUID);
    await settle();
    expect(fetches).toBe(1);
    expect(getResourceStats().prefabs[PATH]).toBe(2);
  });
});

describe('the give-up budget', () => {
  it('heals when a retry succeeds, and returns the document from then on', async () => {
    req(); await settle();
    serve = 'ok';
    req(); await settle();
    expect(req()?.entities).toHaveLength(1);
    expect(fetches).toBe(2);
    expect(unavailable()).toHaveLength(0);
  });

  it('stops fetching once the budget is spent', async () => {
    await exhaust();
    for (let i = 0; i < 5; i++) { req(); await settle(); }
    expect(fetches).toBe(MAX);
  });

  it('refunds the budget on a hit, so a LATER eviction gets a full fresh run', async () => {
    req(); await settle();
    req(); await settle();
    serve = 'ok';
    req(); await settle(); // the last allowed attempt succeeds
    req(); //                  cached: the budget is handed back
    expect(fetches).toBe(3);

    invalidatePrefab(GUID); // an editor Apply evicts it
    serve = 'fail';
    for (let i = 0; i < MAX + 2; i++) { req(); await settle(); }
    expect(fetches).toBe(3 + MAX);
  });

  it('gets a FRESH budget in a new world', async () => {
    await exhaust();
    tw.dispose();
    tw = createTestWorld({ seed: 1 });
    req(); await settle();
    expect(fetches).toBe(MAX + 1);
  });

  it('an entity-less document is a MISS by default, and spends budget', async () => {
    // The empty document caches after the first fetch, so later attempts are served from the cache
    // without touching the network — the budget, not the fetch count, is what must run out.
    serve = 'empty';
    await exhaust();
    for (let i = 0; i < 3; i++) { expect(req()).toBeNull(); await settle(); }
    expect(unavailable()).toHaveLength(1);
  });

  it('a caller\'s stricter isHit is applied to BOTH the lookup and the re-arm (court refreshBadgeLayout)', async () => {
    // The document loads fine and has entities, but this caller cannot use it. A re-arm that only
    // asked "is anything cached" would release the latch after every settle and never give up.
    serve = 'ok';
    const isHit = () => false;
    for (let i = 0; i < MAX + 3; i++) { expect(req({ isHit })).toBeNull(); await settle(); }
    expect(unavailable()).toHaveLength(1);
    // Once cached, no further fetch goes out at all (fetchPrefab short-circuits a cached path), so
    // the attempts are what bound it, and they are spent.
    expect(req({ isHit })).toBeNull();
  });
});

describe('a caller predicate that throws', () => {
  it('reads as unusable at the settle, instead of an unhandled rejection', async () => {
    // The lookup never calls `isHit` on an empty cache, so the first throw happens inside the
    // settle, where nothing would catch it. Vitest fails the run on an unhandled rejection.
    serve = 'ok';
    const isHit = () => { throw new Error('unparseable'); };
    expect(req({ isHit })).toBeNull();
    await settle();
    expect(fetches).toBe(1);
  });
});

describe('the report', () => {
  it('journals prefab/unavailable ONCE when the budget is spent and the prefab never arrived (#1375)', async () => {
    await exhaust();
    for (let i = 0; i < 3; i++) { req(); await settle(); }
    const warned = unavailable();
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatchObject({ level: 'warn', payload: { prefab: GUID, owner: OWNER, attempts: MAX } });
  });

  it('stays silent through a cold cache that fills', async () => {
    serve = 'ok';
    req(); await settle();
    req();
    expect(unavailable()).toHaveLength(0);
  });

  it('stays silent when the LAST allowed attempt is the one that succeeds', async () => {
    for (let i = 0; i < MAX - 1; i++) { req(); await settle(); }
    serve = 'ok';
    req(); await settle();
    expect(fetches).toBe(MAX);
    expect(unavailable()).toHaveLength(0);
  });

  it('does not report into a world that was swapped out while the last attempt was in flight', async () => {
    for (let i = 0; i < MAX - 1; i++) { req(); await settle(); }
    let release!: () => void;
    gate = new Promise<void>((r) => { release = r; });
    req(); // the last attempt parks
    const old = tw;
    const oldEvents = () => old.events({ type: 'prefab/unavailable' });
    tw = createTestWorld({ seed: 2 }); // a swap, while the old world still exists to be written to
    release();
    await settle();
    expect(oldEvents()).toHaveLength(0);
    expect(unavailable()).toHaveLength(0);
    tw.dispose(); // unwind in reverse order, so afterEach restores the state from before `old`
    tw = old;
  });
});
