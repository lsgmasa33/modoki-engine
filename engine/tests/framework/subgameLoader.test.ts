/** OTA Phase 4 (docs/ota-subgame-modules.md) — subgameLoader.ts had ZERO test
 *  coverage before this file. It covers the two bugs a fresh-eyes review caught:
 *
 *  1. loadStagedSubgames() used to Promise.all() every staged sub-game's load. Each
 *     sub-game's <script> IIFE writes to the SINGLE global `__MODOKI_SUBGAME__`, which
 *     loadOneSubgame then reads and clears — loading two bundles concurrently let one
 *     sub-game's script clobber (or be clobbered by) another's read, misattributing a
 *     module to the wrong bundle. Fixed by loading sequentially; this test simulates two
 *     bundles whose scripts "execute" out of insertion order and asserts each bundle ends
 *     up registered under its OWN gameId, never crossed.
 *  2. `shared.ensure(...)` was unguarded — a rejection there propagated out of
 *     loadOneSubgame uncaught by `reportError`, contradicting this module's own
 *     "every failure is a VISIBLE reportError, never a silent skip" invariant.
 *
 *  Module-level state (loadErrors, listeners, subgamesLoadPromise) has no reset export,
 *  so each test re-imports the module fresh via vi.resetModules(). */
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** Mirrors the native `beginBundleLoad`/`reportBundleLoadFailure` return type — declared so
 *  the hoisted mocks are not narrowed to whichever branch their DEFAULT happens to return,
 *  which would reject every `mockResolvedValue` for the other branch. */
type BundleTarget = { target: 'none' } | { target: 'version'; name: string; version: string; path: string };

const h = vi.hoisted(() => ({
  isNativePlatform: vi.fn(() => true),
  convertFileSrc: vi.fn((p: string) => p),
  checkAppSubgameUpdates: vi.fn(async () => {}),
  listBundles: vi.fn(async () => ({ bundles: [] as { name: string; version: string; path: string }[] })),
  confirmBoot: vi.fn(async (_o: { name: string; version?: string }) => {}),
  // #553: the loader no longer loads what `listBundles` hands back — it asks
  // `beginBundleLoad` which version to run (pending-first, attempt counted). The DEFAULT
  // here answers from `listBundles`, so every pre-#553 test in this file keeps describing
  // the same scenario; tests about the promotion path override it explicitly.
  beginBundleLoad: vi.fn(async ({ name }: { name: string }): Promise<BundleTarget> => {
    const { bundles } = await h.listBundles();
    const b = bundles.find((x) => x.name === name);
    return b ? { target: 'version', ...b } : { target: 'none' };
  }),
  reportBundleLoadFailure: vi.fn(async (_o: { name: string; version: string; disposition: string }): Promise<BundleTarget> =>
    ({ target: 'none' })),
  ensure: vi.fn(async (_keys: string[]) => {}),
  ota: { enabled: true, bundleName: 'shell', baseUrl: 'https://example.test', publicKey: 'pk', engineApi: 1 },
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: h.isNativePlatform, convertFileSrc: h.convertFileSrc },
}));
vi.mock('virtual:modoki-project-config', () => ({ default: { ota: h.ota } }));
// ⚠️ BOTH exports, not just the one this suite drives. `subgameLoader` also imports
// `isPluginUnimplemented` to decide whether a confirmBoot rejection is worth a warning, and a
// partial mock makes it `undefined` — harmless while every confirmBoot here RESOLVES, and a
// TypeError inside the catch the moment one rejects. The reject-path test below is what makes
// that visible instead of latent.
vi.mock('../../app/ota', () => ({
  checkAppSubgameUpdates: h.checkAppSubgameUpdates,
  isPluginUnimplemented: (e: unknown) => (e as { code?: string } | null)?.code === 'UNIMPLEMENTED',
}));
vi.mock('capacitor-modoki-ota', () => ({
  ModokiOta: {
    listBundles: h.listBundles,
    confirmBoot: h.confirmBoot,
    beginBundleLoad: h.beginBundleLoad,
    reportBundleLoadFailure: h.reportBundleLoadFailure,
  },
}));
// registerDynamicGame is wrapped (not stubbed) so getGames()/__resetGameRegistryForTest() below
// still exercise the REAL registry — the wrap exists only so its invocationCallOrder can be
// compared against the asset-manifest fetch's, to assert the merge happens before registration.
vi.mock('../../app/gameRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../app/gameRegistry')>();
  return { ...actual, registerDynamicGame: vi.fn(actual.registerDynamicGame) };
});
// loadManifestJson is wrapped (not stubbed), the same way, so its invocationCallOrder can be
// compared against registerDynamicGame's — the fetch-order comparison alone would still pass a
// refactor that starts the manifest fetch early but awaits its json()/merge AFTER registration;
// this measures merge COMPLETION, not fetch initiation. See the (#540) ordering test below.
vi.mock('@modoki/engine/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@modoki/engine/runtime')>();
  return { ...actual, loadManifestJson: vi.fn(actual.loadManifestJson) };
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  h.ota.enabled = true;
  h.isNativePlatform.mockReturnValue(true); // clearAllMocks() clears call history, not mockReturnValue overrides
  h.listBundles.mockResolvedValue({ bundles: [] });
  // mockResolvedValue/mockImplementation overrides survive clearAllMocks — restore the
  // defaults these two carry, or one test's override leaks into the next.
  h.beginBundleLoad.mockImplementation(async ({ name }: { name: string }): Promise<BundleTarget> => {
    const { bundles } = await h.listBundles();
    const b = bundles.find((x) => x.name === name);
    return b ? { target: 'version', ...b } : { target: 'none' };
  });
  h.reportBundleLoadFailure.mockResolvedValue({ target: 'none' });
  document.querySelectorAll('script[data-test-subgame]').forEach((n) => n.remove());
});

/** Simulates a bundle's remote assets: subgame.json + optional assets.manifest.json, and
 *  a <script> tag whose "execution" (writing globalThis.__MODOKI_SUBGAME__ then firing
 *  onload) happens on the schedule the test controls via `scriptDelayMs`, so two bundles'
 *  scripts can be made to complete in a chosen (possibly reordered) sequence. */
function mockBundleEnv(bundles: Record<string, { manifest: object; gameId: string; scriptDelayMs: number; assetsManifest?: object }>) {
  const fetchMock = vi.fn(async (url: string) => {
    for (const [path, b] of Object.entries(bundles)) {
      if (url === `${path}/subgame.json`) {
        return { ok: true, json: async () => b.manifest } as Response;
      }
      if (url === `${path}/assets.manifest.json`) {
        if (b.assetsManifest) return { ok: true, json: async () => b.assetsManifest } as Response;
        return { ok: false, status: 404, json: async () => ({}) } as Response;
      }
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);

  vi.spyOn(document.head, 'appendChild').mockImplementation(((node: Node) => {
    const script = node as HTMLScriptElement;
    script.setAttribute('data-test-subgame', '1');
    const entry = Object.entries(bundles).find(([path, b]) => script.src.endsWith(`${path}/${(b.manifest as { entry: string }).entry}`));
    if (entry) {
      const [, b] = entry;
      setTimeout(() => {
        (globalThis as unknown as { __MODOKI_SUBGAME__?: unknown }).__MODOKI_SUBGAME__ = {
          game: { id: b.gameId, name: b.gameId, loadConfig: async () => ({ scenePath: '' }) },
          engineApi: (b.manifest as { engineApi: number }).engineApi,
        };
        script.onload?.(new Event('load'));
      }, b.scriptDelayMs);
    } else {
      setTimeout(() => script.onerror?.(new Event('error')), 0);
    }
    return node;
  }) as typeof document.head.appendChild);

  return fetchMock;
}

describe('subgameLoader — concurrency & error-visibility fixes', () => {
  beforeEach(() => {
    vi.resetModules();
    (globalThis as unknown as { __MODOKI_SHARED__?: unknown }).__MODOKI_SHARED__ = {
      registrySchema: 1, engineApi: 1, modules: {}, ensure: h.ensure,
    };
  });

  it('loads two sub-games whose scripts complete OUT of insertion order without cross-attributing modules', async () => {
    mockBundleEnv({
      '/bundle-a': { manifest: { schema: 1, engineApi: 1, sharedDeps: [], entry: 'subgame.js' }, gameId: 'game-a', scriptDelayMs: 30, assetsManifest: {} },
      '/bundle-b': { manifest: { schema: 1, engineApi: 1, sharedDeps: [], entry: 'subgame.js' }, gameId: 'game-b', scriptDelayMs: 5, assetsManifest: {} },
    });
    h.listBundles.mockResolvedValue({
      bundles: [
        { name: 'bundle-a', version: 'v1', path: '/bundle-a' },
        { name: 'bundle-b', version: 'v1', path: '/bundle-b' },
      ],
    });

    const { loadStagedSubgames, subscribeSubgameLoadErrors } = await import('../../app/subgameLoader');
    const { getGames, __resetGameRegistryForTest } = await import('../../app/gameRegistry');
    __resetGameRegistryForTest();

    await loadStagedSubgames();

    const errors: unknown[] = [];
    subscribeSubgameLoadErrors((e) => errors.push(...e))();
    expect(errors).toEqual([]);

    const ids = getGames().map((g) => g.id).sort();
    expect(ids).toEqual(['game-a', 'game-b']); // neither bundle's game.id was lost or swapped
    __resetGameRegistryForTest();
  });

  it('reports a failed shared.ensure() through the VISIBLE error list, not a silent skip', async () => {
    h.ensure.mockRejectedValueOnce(new Error('shared dep script failed'));
    mockBundleEnv({
      '/bundle-a': { manifest: { schema: 1, engineApi: 1, sharedDeps: ['three'], entry: 'subgame.js' }, gameId: 'game-a', scriptDelayMs: 0 },
    });
    h.listBundles.mockResolvedValue({ bundles: [{ name: 'bundle-a', version: 'v1', path: '/bundle-a' }] });

    const { loadStagedSubgames, subscribeSubgameLoadErrors } = await import('../../app/subgameLoader');
    const { getGames, __resetGameRegistryForTest } = await import('../../app/gameRegistry');
    __resetGameRegistryForTest();

    await loadStagedSubgames();

    const errors: { bundleName: string; message: string }[] = [];
    subscribeSubgameLoadErrors((e) => { errors.length = 0; errors.push(...e); })();
    expect(errors).toHaveLength(1);
    expect(errors[0].bundleName).toBe('bundle-a');
    expect(errors[0].message).toMatch(/shared dependency load failed/);
    expect(getGames()).toEqual([]); // never registered — the failure happened before load
    __resetGameRegistryForTest();
  });

  it('merges the asset-manifest fragment BEFORE registering the game (#540)', async () => {
    const fetchMock = mockBundleEnv({
      '/bundle-a': {
        manifest: { schema: 1, engineApi: 1, sharedDeps: [], entry: 'subgame.js' },
        gameId: 'game-a',
        scriptDelayMs: 0,
        assetsManifest: { assets: {} },
      },
    });
    h.listBundles.mockResolvedValue({ bundles: [{ name: 'bundle-a', version: 'v1', path: '/bundle-a' }] });

    const { loadStagedSubgames } = await import('../../app/subgameLoader');
    const { registerDynamicGame, getGames, __resetGameRegistryForTest } = await import('../../app/gameRegistry');
    const { loadManifestJson } = await import('@modoki/engine/runtime');
    __resetGameRegistryForTest();

    await loadStagedSubgames();

    expect(getGames().map((g) => g.id)).toEqual(['game-a']);

    // Fetch-order check: still worth keeping, but not authoritative on its own — it measures
    // when the manifest fetch STARTS, not when the merge finishes.
    const manifestCallIndex = fetchMock.mock.calls.findIndex(([url]) => url === '/bundle-a/assets.manifest.json');
    expect(manifestCallIndex).toBeGreaterThanOrEqual(0);
    const manifestCallOrder = fetchMock.mock.invocationCallOrder[manifestCallIndex];
    const registerCallOrder = (registerDynamicGame as unknown as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[0];
    expect(manifestCallOrder).toBeLessThan(registerCallOrder);

    // Authoritative: the MERGE (loadManifestJson) must have COMPLETED before registration —
    // this is what a refactor that starts the fetch early but merges late would still catch.
    const mergeCallOrder = (loadManifestJson as unknown as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[0];
    expect(mergeCallOrder).toBeLessThan(registerCallOrder);
    __resetGameRegistryForTest();
  });

  it('a gameId collision is caught BEFORE the manifest merge, so it never repoints the existing game\'s asset paths', async () => {
    mockBundleEnv({
      '/bundle-a': {
        manifest: { schema: 1, engineApi: 1, sharedDeps: [], entry: 'subgame.js' },
        gameId: 'game-a',
        scriptDelayMs: 0,
        assetsManifest: { assets: {} },
      },
    });
    h.listBundles.mockResolvedValue({ bundles: [{ name: 'bundle-a', version: 'v1', path: '/bundle-a' }] });

    const { loadStagedSubgames, subscribeSubgameLoadErrors } = await import('../../app/subgameLoader');
    const { getGames, __resetGameRegistryForTest, registerDynamicGame } = await import('../../app/gameRegistry');
    const { loadManifestJson } = await import('@modoki/engine/runtime');
    __resetGameRegistryForTest();
    // Simulate the baked game already occupying "game-a" — the collision this bundle must be
    // refused for.
    registerDynamicGame({ id: 'game-a', name: 'game-a', loadConfig: async () => ({ scenePath: '' }) } as never);

    await loadStagedSubgames();

    const errors: { bundleName: string; message: string }[] = [];
    subscribeSubgameLoadErrors((e) => { errors.length = 0; errors.push(...e); })();
    expect(errors).toHaveLength(1);
    expect(errors[0].bundleName).toBe('bundle-a');
    expect(errors[0].message).toMatch(/gameId collision/);
    // The regression: loadManifestJson must never even be CALLED for the rejected bundle —
    // calling it would repoint the already-registered game-a's asset paths (last-write-wins on
    // a GUID) before the bundle is discarded.
    expect(loadManifestJson).not.toHaveBeenCalled();
    expect(getGames().map((g) => g.id)).toEqual(['game-a']);
    __resetGameRegistryForTest();
  });

  it('a non-ok asset-manifest fetch is FATAL — the game is never registered, and reports through the VISIBLE error list (#540)', async () => {
    mockBundleEnv({
      '/bundle-a': { manifest: { schema: 1, engineApi: 1, sharedDeps: [], entry: 'subgame.js' }, gameId: 'game-a', scriptDelayMs: 0 },
      // no assetsManifest given — mockBundleEnv's default responds 404 to assets.manifest.json
    });
    h.listBundles.mockResolvedValue({ bundles: [{ name: 'bundle-a', version: 'v1', path: '/bundle-a' }] });

    const { loadStagedSubgames, subscribeSubgameLoadErrors } = await import('../../app/subgameLoader');
    const { getGames, __resetGameRegistryForTest } = await import('../../app/gameRegistry');
    __resetGameRegistryForTest();

    await loadStagedSubgames();

    const errors: { bundleName: string; message: string }[] = [];
    subscribeSubgameLoadErrors((e) => { errors.length = 0; errors.push(...e); })();
    expect(errors).toHaveLength(1);
    expect(errors[0].bundleName).toBe('bundle-a');
    expect(errors[0].message).toMatch(/assets\.manifest\.json fetch failed/);
    expect(getGames()).toEqual([]); // never registered — a broken manifest is a broken bundle, not "no assets"
    __resetGameRegistryForTest();
  });

  it('an UNPARSEABLE asset-manifest is FATAL too — the throwing branch, which had no test at all (#553)', async () => {
    // The non-ok branch above was covered; `.json()` THROWING was not, and the two are
    // different code paths reached by different device failures (a 404 vs. a truncated or
    // corrupted file that still responds 200). Device-confirmed as distinct on a Galaxy S22.
    mockBundleEnv({
      '/bundle-a': { manifest: { schema: 1, engineApi: 1, sharedDeps: [], entry: 'subgame.js' }, gameId: 'game-a', scriptDelayMs: 0 },
    });
    const fetchMock = vi.mocked(globalThis.fetch);
    const inner = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((async (url: string) => {
      if (url === '/bundle-a/assets.manifest.json') {
        return { ok: true, json: async () => { throw new SyntaxError('Unexpected token T in JSON at position 0'); } } as unknown as Response;
      }
      return inner(url as never);
    }) as never);
    h.listBundles.mockResolvedValue({ bundles: [{ name: 'bundle-a', version: 'v1', path: '/bundle-a' }] });

    const { loadStagedSubgames, subscribeSubgameLoadErrors } = await import('../../app/subgameLoader');
    const { getGames, __resetGameRegistryForTest } = await import('../../app/gameRegistry');
    __resetGameRegistryForTest();

    await loadStagedSubgames();

    const errors: { message: string }[] = [];
    subscribeSubgameLoadErrors((e) => { errors.length = 0; errors.push(...e); })();
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/assets\.manifest\.json parse threw.*SyntaxError/);
    expect(getGames()).toEqual([]);
    expect(h.confirmBoot).not.toHaveBeenCalled();
    __resetGameRegistryForTest();
  });
});

/**
 * #553 — promotion used to be decoupled from the version being promoted.
 *
 * `listBundles()` prefers `active` over `pending`, so on an UPDATE the loader ran the OLD
 * version, it loaded fine, and the unconditional `confirmBoot` that followed credited the NEW
 * one. Two launches of that promoted a bundle to `active` that had never once executed — then
 * it failed, and nothing could demote it. Device-verified offline on a Galaxy S22, 2026-09-01.
 *
 * These tests pin the three halves of the fix: the version to load comes from
 * `beginBundleLoad` (not `listBundles`), a confirm NAMES the version that loaded, and a
 * refusal is reported to the watchdog with a disposition that decides quarantine.
 */
describe('subgameLoader — versioned promotion + the load-failure watchdog (#553/#550)', () => {
  beforeEach(() => {
    vi.resetModules();
    (globalThis as unknown as { __MODOKI_SHARED__?: unknown }).__MODOKI_SHARED__ = {
      registrySchema: 1, engineApi: 1, modules: {}, ensure: h.ensure,
    };
  });

  it('loads the version beginBundleLoad names, NOT the one listBundles hands back, and confirms THAT version', async () => {
    mockBundleEnv({
      '/bundle-a-v2': { manifest: { schema: 1, engineApi: 1, sharedDeps: [], entry: 'subgame.js' }, gameId: 'game-a', scriptDelayMs: 0, assetsManifest: {} },
    });
    // listBundles reports the ACTIVE version (v1) — exactly the inversion that caused #553.
    h.listBundles.mockResolvedValue({ bundles: [{ name: 'bundle-a', version: 'v1', path: '/bundle-a-v1' }] });
    // The watchdog says the PENDING version (v2) is what this launch must actually attempt.
    h.beginBundleLoad.mockResolvedValue({ target: 'version', name: 'bundle-a', version: 'v2', path: '/bundle-a-v2' });

    const { loadStagedSubgames } = await import('../../app/subgameLoader');
    const { __resetGameRegistryForTest } = await import('../../app/gameRegistry');
    __resetGameRegistryForTest();

    await loadStagedSubgames();

    expect(h.beginBundleLoad).toHaveBeenCalledWith({ name: 'bundle-a' });
    // The load fetched v2's files, not v1's — the old code would have fetched /bundle-a-v1.
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledWith('/bundle-a-v2/subgame.json');
    // And the confirm is EVIDENCE ABOUT v2, named explicitly.
    expect(h.confirmBoot).toHaveBeenCalledWith({ name: 'bundle-a', version: 'v2' });
    __resetGameRegistryForTest();
  });

  it('a fatal refusal falls back to the previous version and NEVER confirms it — the defect restated', async () => {
    // v2 is served and refused (no assets.manifest.json); v1 is the watchdog's fallback and
    // loads fine. A confirm here would credit v1's success to... whatever is pending, which is
    // precisely how a broken bundle got promoted in the first place.
    mockBundleEnv({
      '/bundle-a-v2': { manifest: { schema: 1, engineApi: 1, sharedDeps: [], entry: 'subgame.js' }, gameId: 'game-a', scriptDelayMs: 0 },
      '/bundle-a-v1': { manifest: { schema: 1, engineApi: 1, sharedDeps: [], entry: 'subgame.js' }, gameId: 'game-a', scriptDelayMs: 0, assetsManifest: {} },
    });
    h.listBundles.mockResolvedValue({ bundles: [{ name: 'bundle-a', version: 'v2', path: '/bundle-a-v2' }] });
    h.beginBundleLoad.mockResolvedValue({ target: 'version', name: 'bundle-a', version: 'v2', path: '/bundle-a-v2' });
    h.reportBundleLoadFailure.mockResolvedValue({ target: 'version', name: 'bundle-a', version: 'v1', path: '/bundle-a-v1' });

    const { loadStagedSubgames } = await import('../../app/subgameLoader');
    const { getGames, __resetGameRegistryForTest } = await import('../../app/gameRegistry');
    __resetGameRegistryForTest();

    await loadStagedSubgames();

    expect(h.reportBundleLoadFailure).toHaveBeenCalledWith({ name: 'bundle-a', version: 'v2', disposition: 'fatal' });
    expect(getGames().map((g) => g.id)).toEqual(['game-a']); // the player still gets the game
    expect(h.confirmBoot).not.toHaveBeenCalled(); // ⚠️ the whole point
    __resetGameRegistryForTest();
  });

  it('does not retry past the first fallback — a fallback that also fails is reported, then dropped', async () => {
    mockBundleEnv({
      '/bundle-a-v2': { manifest: { schema: 1, engineApi: 1, sharedDeps: [], entry: 'subgame.js' }, gameId: 'game-a', scriptDelayMs: 0 },
      '/bundle-a-v1': { manifest: { schema: 1, engineApi: 1, sharedDeps: [], entry: 'subgame.js' }, gameId: 'game-a', scriptDelayMs: 0 },
    });
    h.listBundles.mockResolvedValue({ bundles: [{ name: 'bundle-a', version: 'v2', path: '/bundle-a-v2' }] });
    h.beginBundleLoad.mockResolvedValue({ target: 'version', name: 'bundle-a', version: 'v2', path: '/bundle-a-v2' });
    h.reportBundleLoadFailure.mockResolvedValue({ target: 'version', name: 'bundle-a', version: 'v1', path: '/bundle-a-v1' });

    const { loadStagedSubgames } = await import('../../app/subgameLoader');
    const { getGames, __resetGameRegistryForTest } = await import('../../app/gameRegistry');
    __resetGameRegistryForTest();

    await loadStagedSubgames();

    // Twice: once for v2, once for the fallback v1 — and then it stops, rather than looping on
    // a watchdog that keeps answering with a version that cannot load.
    expect(h.reportBundleLoadFailure).toHaveBeenCalledTimes(2);
    expect(h.reportBundleLoadFailure).toHaveBeenLastCalledWith({ name: 'bundle-a', version: 'v1', disposition: 'fatal' });
    expect(getGames()).toEqual([]);
    __resetGameRegistryForTest();
  });

  it('loads nothing when the watchdog has no version to offer', async () => {
    mockBundleEnv({});
    h.listBundles.mockResolvedValue({ bundles: [{ name: 'bundle-a', version: 'v1', path: '/bundle-a' }] });
    h.beginBundleLoad.mockResolvedValue({ target: 'none' });

    const { loadStagedSubgames } = await import('../../app/subgameLoader');
    await loadStagedSubgames();

    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
    expect(h.confirmBoot).not.toHaveBeenCalled();
    expect(h.reportBundleLoadFailure).not.toHaveBeenCalled();
  });

  /**
   * ⚠️ The disposition is the load-bearing part, not the refusal. `'fatal'` QUARANTINES the
   * version on this device permanently (owner ruling, 2026-09-01) — and `rejected` deliberately
   * survives a binary update. So an engineApi mismatch reported as fatal would block a bundle
   * that the NEXT app binary runs perfectly, forever. These cases pin each mapping.
   */
  it.each([
    ['a broken assets manifest — the bundle\'s own bytes', 'fatal', { engineApi: 1, breakManifest: true }],
    ['an engineApi mismatch — about the HOST, never quarantine', 'notEvidence', { engineApi: 99, breakManifest: false }],
  ])('reports %s as disposition %s', async (_label, expected, opts) => {
    mockBundleEnv({
      '/bundle-a': {
        manifest: { schema: 1, engineApi: opts.engineApi, sharedDeps: [], entry: 'subgame.js' },
        gameId: 'game-a', scriptDelayMs: 0,
        ...(opts.breakManifest ? {} : { assetsManifest: {} }),
      },
    });
    h.listBundles.mockResolvedValue({ bundles: [{ name: 'bundle-a', version: 'v1', path: '/bundle-a' }] });

    const { loadStagedSubgames } = await import('../../app/subgameLoader');
    const { __resetGameRegistryForTest } = await import('../../app/gameRegistry');
    __resetGameRegistryForTest();

    await loadStagedSubgames();

    expect(h.reportBundleLoadFailure).toHaveBeenCalledWith({ name: 'bundle-a', version: 'v1', disposition: expected });
    __resetGameRegistryForTest();
  });

  it('reports a failed shared-dependency fetch as transient — it may simply not recur', async () => {
    h.ensure.mockRejectedValueOnce(new Error('network down'));
    mockBundleEnv({
      '/bundle-a': { manifest: { schema: 1, engineApi: 1, sharedDeps: ['three'], entry: 'subgame.js' }, gameId: 'game-a', scriptDelayMs: 0, assetsManifest: {} },
    });
    h.listBundles.mockResolvedValue({ bundles: [{ name: 'bundle-a', version: 'v1', path: '/bundle-a' }] });

    const { loadStagedSubgames } = await import('../../app/subgameLoader');
    await loadStagedSubgames();

    expect(h.reportBundleLoadFailure).toHaveBeenCalledWith({ name: 'bundle-a', version: 'v1', disposition: 'transient' });
  });

  /**
   * ⚠️ The shell's JS is delivered OVER THE AIR; the native plugin ships in the APP BINARY. So a
   * new shell bundle genuinely can run on a device whose binary predates `beginBundleLoad`.
   * Without the degradation path this asserts, that one UNIMPLEMENTED rejection reaches
   * `loadStagedSubgames`'s outer catch and NO sub-game loads at all on those devices — silently,
   * and only until they happen to take an app-store update.
   */
  it('still loads sub-games on a binary whose native plugin predates beginBundleLoad — but never confirms them', async () => {
    h.beginBundleLoad.mockRejectedValue(Object.assign(new Error('not implemented'), { code: 'UNIMPLEMENTED' }));
    mockBundleEnv({
      '/bundle-a': { manifest: { schema: 1, engineApi: 1, sharedDeps: [], entry: 'subgame.js' }, gameId: 'game-a', scriptDelayMs: 0, assetsManifest: {} },
    });
    h.listBundles.mockResolvedValue({ bundles: [{ name: 'bundle-a', version: 'v1', path: '/bundle-a' }] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const { loadStagedSubgames } = await import('../../app/subgameLoader');
    const { getGames, __resetGameRegistryForTest } = await import('../../app/gameRegistry');
    __resetGameRegistryForTest();

    await loadStagedSubgames();

    expect(getGames().map((g) => g.id)).toEqual(['game-a']); // the player still gets the game
    // ⚠️ NOT confirmed: `listBundles` prefers `active`, so this load cannot be attributed to the
    // pending version, and confirming an unattributable load is #553 itself. Promotion waits.
    expect(h.confirmBoot).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled(); // an old binary is ordinary, not a Crashlytics issue
    __resetGameRegistryForTest();
  });

  /**
   * ⚠️ The finding an adversarial review caught, and the one the device runs never touched.
   *
   * A `<script>` whose code THROWS at evaluation fires `load`, not `error` — so `loadScriptTag`
   * resolves and the global is simply never assigned. That is a CRASHING bundle, the likeliest
   * real breakage there is. It used to share a branch with the engineApi mismatch and be
   * reported `notEvidence`, which refunds the attempt: `bootAttempts` never passed 1, `boot()`'s
   * exhaustion revert could never fire, and `checkForUpdate` short-circuits `up-to-date` on a
   * still-pending version. Refused every launch, forever, never quarantined — the exact state
   * #553 exists to remove, surviving inside its own fix.
   *
   * No prior test could reach this: `mockBundleEnv` always assigns the global before firing
   * `onload`.
   */
  it('a bundle whose script THROWS at evaluation ESCALATES — never notEvidence, which refunded the attempt', async () => {
    mockBundleEnv({
      '/bundle-a': { manifest: { schema: 1, engineApi: 1, sharedDeps: [], entry: 'subgame.js' }, gameId: 'game-a', scriptDelayMs: 0, assetsManifest: {} },
    });
    // Resolve the script tag WITHOUT assigning globalThis.__MODOKI_SUBGAME__ — exactly what the
    // browser does when the IIFE throws partway through.
    vi.spyOn(document.head, 'appendChild').mockImplementation(((node: Node) => {
      const script = node as HTMLScriptElement;
      script.setAttribute('data-test-subgame', '1');
      setTimeout(() => script.onload?.(new Event('load')), 0);
      return node;
    }) as typeof document.head.appendChild);
    h.listBundles.mockResolvedValue({ bundles: [{ name: 'bundle-a', version: 'v1', path: '/bundle-a' }] });

    const { loadStagedSubgames, subscribeSubgameLoadErrors } = await import('../../app/subgameLoader');
    await loadStagedSubgames();

    // The load-bearing assertion is NOT the exact disposition but that it is not 'notEvidence':
    // that alone refunds the attempt, and a refunded attempt is what made the bundle
    // un-escalatable forever. 'transient' is the deliberate choice between the two escalating
    // options — see the branch's comment on why this evidence is ambiguous.
    const call = h.reportBundleLoadFailure.mock.calls[0][0];
    expect(call).toMatchObject({ name: 'bundle-a', version: 'v1' });
    expect(call.disposition).not.toBe('notEvidence');
    expect(call.disposition).toBe('transient');
    const errors: { message: string }[] = [];
    subscribeSubgameLoadErrors((e) => { errors.length = 0; errors.push(...e); })();
    expect(errors[0].message).toMatch(/did not assign globalThis\.__MODOKI_SUBGAME__/);
  });

  /**
   * ⚠️ A `fetch` REJECTING is transport; a non-ok response is content. Collapsing them charged a
   * WebView-loader hiccup as a permanent quarantine — and `rejected` survives
   * `resetForNewBinary`, with no un-quarantine path anywhere in the codebase, so a single blip
   * would block a perfectly good published version on that device forever.
   *
   * `transient` still costs an attempt and still quarantines after `maxAttempts`, so a genuinely
   * dead file is not let off — it just has to prove it three times.
   */
  it.each([
    ['subgame.json', '/bundle-a/subgame.json'],
    ['assets.manifest.json', '/bundle-a/assets.manifest.json'],
  ])('a REJECTED %s fetch is transient, never a quarantine', async (_label, failingUrl) => {
    mockBundleEnv({
      '/bundle-a': { manifest: { schema: 1, engineApi: 1, sharedDeps: [], entry: 'subgame.js' }, gameId: 'game-a', scriptDelayMs: 0, assetsManifest: {} },
    });
    const fetchMock = vi.mocked(globalThis.fetch);
    const inner = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((async (url: string) => {
      if (url === failingUrl) throw new TypeError('Load failed');
      return inner(url as never);
    }) as never);
    h.listBundles.mockResolvedValue({ bundles: [{ name: 'bundle-a', version: 'v1', path: '/bundle-a' }] });

    const { loadStagedSubgames } = await import('../../app/subgameLoader');
    const { __resetGameRegistryForTest } = await import('../../app/gameRegistry');
    __resetGameRegistryForTest();

    await loadStagedSubgames();

    expect(h.reportBundleLoadFailure).toHaveBeenCalledWith({ name: 'bundle-a', version: 'v1', disposition: 'transient' });
    __resetGameRegistryForTest();
  });

  it('a NON-OK subgame.json is fatal — the leg whose whole point is that a status IS content evidence', async () => {
    // ⚠️ This leg had no test anywhere: demoting it to 'transient' left all 24 tests green, so a
    // future edit "harmonising" the two fetches would silently stop quarantining a broken bundle.
    mockBundleEnv({});  // no bundle registered -> mockBundleEnv's default answers 404 to everything
    h.listBundles.mockResolvedValue({ bundles: [{ name: 'bundle-a', version: 'v1', path: '/bundle-a' }] });

    const { loadStagedSubgames, subscribeSubgameLoadErrors } = await import('../../app/subgameLoader');
    await loadStagedSubgames();

    expect(h.reportBundleLoadFailure).toHaveBeenCalledWith({ name: 'bundle-a', version: 'v1', disposition: 'fatal' });
    const errors: { message: string }[] = [];
    subscribeSubgameLoadErrors((e) => { errors.length = 0; errors.push(...e); })();
    expect(errors[0].message).toMatch(/subgame\.json fetch failed \(404\)/);
  });

  it('an UNPARSEABLE subgame.json is still fatal — the split must not demote content evidence', async () => {
    mockBundleEnv({
      '/bundle-a': { manifest: { schema: 1, engineApi: 1, sharedDeps: [], entry: 'subgame.js' }, gameId: 'game-a', scriptDelayMs: 0, assetsManifest: {} },
    });
    const fetchMock = vi.mocked(globalThis.fetch);
    const inner = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((async (url: string) => {
      if (url === '/bundle-a/subgame.json') {
        return { ok: true, json: async () => { throw new SyntaxError('bad json'); } } as unknown as Response;
      }
      return inner(url as never);
    }) as never);
    h.listBundles.mockResolvedValue({ bundles: [{ name: 'bundle-a', version: 'v1', path: '/bundle-a' }] });

    const { loadStagedSubgames } = await import('../../app/subgameLoader');
    await loadStagedSubgames();

    expect(h.reportBundleLoadFailure).toHaveBeenCalledWith({ name: 'bundle-a', version: 'v1', disposition: 'fatal' });
  });

  it('survives a watchdog that is not implemented on this platform', async () => {
    h.reportBundleLoadFailure.mockRejectedValueOnce(Object.assign(new Error('not implemented'), { code: 'UNIMPLEMENTED' }));
    mockBundleEnv({
      '/bundle-a': { manifest: { schema: 1, engineApi: 1, sharedDeps: [], entry: 'subgame.js' }, gameId: 'game-a', scriptDelayMs: 0 },
    });
    h.listBundles.mockResolvedValue({ bundles: [{ name: 'bundle-a', version: 'v1', path: '/bundle-a' }] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const { loadStagedSubgames } = await import('../../app/subgameLoader');
    await expect(loadStagedSubgames()).resolves.toBeUndefined();
    // Quiet, like the shell's own confirmBoot: `console.warn` files a Crashlytics issue, and a
    // project that simply ships no OTA plugin would file one every single launch.
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('subgameLoader — confirmBoot rejection handling', () => {
  beforeEach(() => {
    vi.resetModules();
    (globalThis as unknown as { __MODOKI_SHARED__?: unknown }).__MODOKI_SHARED__ = {
      registrySchema: 1, engineApi: 1, modules: {}, ensure: h.ensure,
    };
  });

  /**
   * ⚠️ The confirmBoot REJECT path had no test, and that is what let a partial `app/ota` mock go
   * unnoticed: `subgameLoader` imports `isPluginUnimplemented` to decide whether a rejection is
   * worth a warning, the mock above did not provide it, and every existing test's confirmBoot
   * RESOLVES — so the `undefined` was never called. It would have thrown a TypeError inside the
   * catch on the first real rejection, turning a non-fatal OTA hiccup into a broken load path.
   *
   * Both branches asserted, because the whole point of the helper is telling them apart: an
   * UNIMPLEMENTED rejection (no OTA plugin on this platform) is ordinary and must NOT warn — since
   * `console.warn` files a Crashlytics issue — while any other failure still must.
   */
  it.each([
    ['UNIMPLEMENTED (no OTA plugin) — quiet', Object.assign(new Error('not implemented'), { code: 'UNIMPLEMENTED' }), false],
    ['a genuine confirmBoot failure — warns', new Error('watchdog write failed'), true],
  ])('survives a confirmBoot rejection: %s', async (_label, rejection, expectWarn) => {
    h.confirmBoot.mockRejectedValueOnce(rejection);
    mockBundleEnv({
      '/bundle-a': { manifest: { schema: 1, engineApi: 1, sharedDeps: [], entry: 'subgame.js' }, gameId: 'game-a', scriptDelayMs: 0, assetsManifest: {} },
    });
    h.listBundles.mockResolvedValue({ bundles: [{ name: 'bundle-a', version: 'v1', path: '/bundle-a' }] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const { loadStagedSubgames } = await import('../../app/subgameLoader');
    const { getGames, __resetGameRegistryForTest } = await import('../../app/gameRegistry');
    __resetGameRegistryForTest();

    // The load itself must still succeed — confirmBoot is best-effort.
    await expect(loadStagedSubgames()).resolves.not.toThrow();
    expect(getGames().map((g) => g.id)).toEqual(['game-a']);

    const warnedAboutConfirmBoot = warn.mock.calls.some((c) => String(c[0]).includes('confirmBoot failed'));
    expect(warnedAboutConfirmBoot).toBe(expectWarn);
    __resetGameRegistryForTest();
  });

  it('is a no-op when ota.enabled is false', async () => {
    h.ota.enabled = false;
    const { loadStagedSubgames } = await import('../../app/subgameLoader');
    await loadStagedSubgames();
    expect(h.checkAppSubgameUpdates).not.toHaveBeenCalled();
    expect(h.listBundles).not.toHaveBeenCalled();
  });

  it('is a no-op on a non-native platform (web)', async () => {
    h.isNativePlatform.mockReturnValue(false);
    const { loadStagedSubgames } = await import('../../app/subgameLoader');
    await loadStagedSubgames();
    expect(h.checkAppSubgameUpdates).not.toHaveBeenCalled();
    expect(h.listBundles).not.toHaveBeenCalled();
  });

  it('memoizes — a second call does not re-run listBundles', async () => {
    mockBundleEnv({});
    h.listBundles.mockResolvedValue({ bundles: [] });
    const { loadStagedSubgames } = await import('../../app/subgameLoader');
    await loadStagedSubgames();
    await loadStagedSubgames();
    expect(h.listBundles).toHaveBeenCalledTimes(1);
  });
});
