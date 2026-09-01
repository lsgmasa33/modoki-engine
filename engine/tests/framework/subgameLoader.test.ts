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

const h = vi.hoisted(() => ({
  isNativePlatform: vi.fn(() => true),
  convertFileSrc: vi.fn((p: string) => p),
  checkAppSubgameUpdates: vi.fn(async () => {}),
  listBundles: vi.fn(async () => ({ bundles: [] as { name: string; version: string; path: string }[] })),
  confirmBoot: vi.fn(async () => {}),
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
  ModokiOta: { listBundles: h.listBundles, confirmBoot: h.confirmBoot },
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
