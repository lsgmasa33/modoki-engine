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
import { acquirePrefab, disposeAllCachedResources, getCachedPrefab, getResourceStats, invalidatePrefab } from '../../src/runtime/loaders/meshTemplateCache';
import {
  MAX_PREFAB_FETCH_ATTEMPTS as MAX, __resetPrefabRequests, requestPrefab,
} from '../../src/runtime/loaders/prefabRequest';
import { createTestWorld } from '../../src/runtime/harness/createTestWorld';
import { setManualNow, advanceManual, restoreRealClock } from '../../src/runtime/core/clock';
import { RETRY_BASE_MS } from '../../src/runtime/core/loadFailureMemo';

const GUID = '55555555-2222-4333-8444-777777777777';
const PATH = '/games/g/assets/prefab/requested.prefab.json';
const OWNER = 0x7e_57;
const DOC = { version: 1, id: GUID, entities: [{ localId: 'root', traits: {} }] };

/** What the server does with the next fetch — each test sets it. `gone` is a prefab that is not
 *  coming (404, remembered by the cache until invalidated); `fail` is an OUTAGE (503, backed off,
 *  never an attempt — #1397). */
let serve: 'gone' | 'fail' | 'ok' | 'empty' | 'reject' = 'gone';
/** When set, every fetch parks on this until the test releases it. */
let gate: Promise<void> | null = null;
let fetches = 0;

let tw: ReturnType<typeof createTestWorld>;

/** Let the fetch and the `.finally` behind it run. */
const settle = () => new Promise((r) => setTimeout(r, 0));
const req = (opts?: Parameters<typeof requestPrefab>[2]) => requestPrefab(OWNER, GUID, opts);
const unavailable = () => tw.events({ type: 'prefab/unavailable' });

async function ask(n: number): Promise<void> {
  for (let i = 0; i < n; i++) { req(); await settle(); }
}

beforeEach(() => {
  serve = 'gone'; gate = null; fetches = 0;
  setManualNow(0);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  clearManifest();
  registerAsset(GUID, PATH, 'prefab');
  vi.stubGlobal('fetch', vi.fn(async () => {
    fetches++;
    if (gate) await gate;
    // What iOS's scheme handler does for a file missing from the bundle, and what offline does anywhere.
    if (serve === 'reject') throw new TypeError('Load failed');
    if (serve === 'gone') return { ok: false, status: 404, statusText: 'Not Found', text: async () => '' } as unknown as Response;
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
  vi.restoreAllMocks();
  restoreRealClock();
});

describe('the premise — acquirePrefab resolves on a failed fetch', () => {
  it('a 404 settles without filling the cache and without rejecting', async () => {
    // If this ever starts rejecting, the budget below is reading the wrong signal.
    expect(req()).toBeNull();
    await settle();
    expect(fetches).toBe(1);
    expect(getCachedPrefab(GUID)).toBeFalsy();
  });
});

describe('in-flight dedup', () => {
  it('calls during an outstanding fetch spend NO budget (#1373: a per-frame caller)', async () => {
    // What the dedup protects is the BUDGET — without it, five calls during one slow fetch spend all
    // of it, and a single failed request becomes a permanent give-up. So: fail one gated fetch, then
    // count how many more asks it takes to give up. (Not fetches — a 404 is fetched once, #1397.)
    let release!: () => void;
    gate = new Promise<void>((r) => { release = r; });
    for (let i = 0; i < 5; i++) req();
    gate = null;
    release();
    await settle();
    expect(unavailable(), 'one failed fetch is not a give-up').toHaveLength(0);
    await ask(MAX - 2);
    expect(unavailable(), 'the five calls spent ONE attempt').toHaveLength(0);
    await ask(1);
    expect(unavailable()).toHaveLength(1);
  });

  it('releases the hold on a FAILED settle, so a later call retries (the five latching copies)', async () => {
    serve = 'fail';
    req(); await settle();
    advanceManual(RETRY_BASE_MS);
    req(); await settle();
    expect(fetches).toBe(2);
  });

  it('keeps deduping against a fetch still in flight across a world swap', async () => {
    serve = 'fail';
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
    advanceManual(RETRY_BASE_MS);
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

describe('an OUTAGE is not an attempt (#1397)', () => {
  it('never gives up on a 503: it backs off instead of spending the budget', async () => {
    // Before #1397 a flat 3 fetches — about 1.5 s of outage — gave the prefab up for the session.
    serve = 'fail';
    for (let i = 0; i < 10; i++) {
      await ask(5); // a per-frame caller inside the backoff: no fetch
      advanceManual(10 * 60 * 1000);
    }
    expect(fetches, 'one fetch per backoff step, not per frame').toBe(10);
    expect(unavailable(), 'and never reported as given up').toHaveLength(0);
    serve = 'ok';
    await ask(1);
    expect(req()?.entities).toHaveLength(1);
  });
});

describe('the give-up budget', () => {
  it('heals when a retry succeeds, and returns the document from then on', async () => {
    serve = 'fail';
    req(); await settle();
    serve = 'ok';
    advanceManual(RETRY_BASE_MS);
    req(); await settle();
    expect(req()?.entities).toHaveLength(1);
    expect(fetches).toBe(2);
    expect(unavailable()).toHaveLength(0);
  });

  it('gives up on a 404 once the budget is spent, and fetches it only once', async () => {
    await ask(MAX);
    await ask(5);
    expect(fetches, 'the cache remembers a 404 — no refetch per attempt (#1397)').toBe(1);
    expect(unavailable()).toHaveLength(1);
  });

  it('refunds the budget on a hit, so a LATER eviction gets a full fresh run', async () => {
    await ask(1);           // a 404 spends one attempt
    invalidatePrefab(GUID); // the file is created / fixed
    serve = 'ok';
    await ask(1);           // it loads
    req();                  // cached: the budget is handed back

    invalidatePrefab(GUID); // an editor Apply evicts it, and the file is gone again
    serve = 'gone';
    await ask(MAX - 1);
    expect(unavailable(), 'a full run, not what was left of the old one').toHaveLength(0);
    await ask(1);
    expect(unavailable()).toHaveLength(1);
  });

  it('gets a FRESH budget in a new world', async () => {
    await ask(MAX);
    tw.dispose();
    tw = createTestWorld({ seed: 1 });
    await ask(MAX - 1);
    expect(unavailable()).toHaveLength(0);
    await ask(1);
    expect(unavailable()).toHaveLength(1);
  });

  it('an entity-less document is a MISS by default, and spends budget', async () => {
    // The empty document caches after the first fetch, so later attempts are served from the cache
    // without touching the network — the budget, not the fetch count, is what must run out.
    serve = 'empty';
    await ask(MAX);
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
    await ask(MAX);
    await ask(3);
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
    await ask(MAX - 1);     // 404s
    invalidatePrefab(GUID); // the file is fixed — the budget is NOT reset by that
    serve = 'ok';
    req(); await settle();  // the last allowed attempt
    expect(req()?.entities).toHaveLength(1);
    expect(unavailable()).toHaveLength(0);
  });

  it('does not report into a world that was swapped out while the last attempt was in flight', async () => {
    await ask(MAX - 1);
    invalidatePrefab(GUID); // let the last attempt actually go to the network, so it can park
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

describe('fetchPrefab — a stale load settling (#1397)', () => {
  it('does not evict the in-flight entry of the load that replaced it', async () => {
    serve = 'ok';
    const releases: Array<() => void> = [];
    vi.stubGlobal('fetch', vi.fn(async () => {
      fetches++;
      await new Promise<void>((r) => releases.push(r));
      return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(DOC) } as unknown as Response;
    }));
    const stale = acquirePrefab(OWNER, GUID);
    invalidatePrefab(GUID);                        // supersedes it
    const replacement = acquirePrefab(OWNER, GUID);
    expect(fetches).toBe(2);
    releases[0]();                                 // the stale load settles first
    await stale;
    void acquirePrefab(OWNER, GUID);               // an ask while the replacement is still in flight
    expect(fetches, 'was 3: the stale settle deleted the replacement\'s entry').toBe(2);
    releases[1]();
    await replacement;
  });
});

/** An iOS native build (#1402): Capacitor present, and the page on `capacitor://localhost`. */
function stubIosNative(): void {
  vi.stubGlobal('Capacitor', { isNativePlatform: () => true });
  vi.stubGlobal('location', { href: 'capacitor://localhost/', protocol: 'capacitor:', host: 'localhost' });
}

describe('a prefab MISSING from a native app bundle (#1402)', () => {
  it('iOS fails the request instead of answering 404, and it is still given up and journalled prefab/unavailable', async () => {
    stubIosNative();
    serve = 'reject';
    await ask(MAX);
    await ask(5);
    expect(fetches, 'remembered as absent, so not refetched').toBe(1);
    expect(unavailable()).toHaveLength(1);
  });

  it('accept side: the same rejection on the WEB is an outage, which backs off and spends no budget', async () => {
    serve = 'reject';
    for (let i = 0; i < 4; i++) { await ask(MAX); advanceManual(10 * 60 * 1000); }
    expect(fetches).toBe(4);
    expect(unavailable()).toHaveLength(0);
  });
});
