import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing
const mockRegisterAll = vi.fn();
vi.mock('../../app/ecs/register', () => ({
  registerAll: () => mockRegisterAll(),
}));

const mockGetGameConfig = vi.fn().mockReturnValue({
  assetManifest: '/test-manifest.json',
  scenePath: '/test-scene.json',
});
const mockLoadAllFonts = vi.fn().mockResolvedValue(undefined);
const mockLoadScene = vi.fn().mockResolvedValue(undefined);

vi.mock('@modoki/engine/runtime', () => ({
  getGameConfig: () => mockGetGameConfig(),
  loadAllFonts: (...args: any[]) => mockLoadAllFonts(...args),
  loadManifestJson: vi.fn(),
  // init.ts reads useGameStore.getState().setFontStatus (the store moved into the
  // engine package — see gamePortability guard). A minimal stub is enough here.
  useGameStore: { getState: () => ({ setFontStatus: vi.fn() }) },
  // Mirror the real memoized loader: fetch the URL, return parsed JSON (or null
  // on failure). init.ts now goes through this instead of fetching directly.
  ensureManifestLoaded: async (url: string) => {
    try {
      const res = await mockFetch(url);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  },
  sceneManager: {
    loadScene: (...args: any[]) => mockLoadScene(...args),
  },
}));

// Mock global fetch for font loading
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

describe('initWorldSync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ assets: [{ path: '/fonts/test.ttf', type: 'font' }] }),
    });
  });

  it('calls registerAll on init', async () => {
    const { initWorldSync } = await import('../../app/ecs/init');
    initWorldSync();
    expect(mockRegisterAll).toHaveBeenCalledTimes(1);
  });

  it('fetches font manifest from config path', async () => {
    vi.resetModules();
    const { initWorldSync } = await import('../../app/ecs/init');
    initWorldSync();

    // Font loading is fire-and-forget — give it a tick
    await new Promise(r => setTimeout(r, 10));

    expect(mockFetch).toHaveBeenCalledWith('/test-manifest.json');
  });

  it('uses default manifest path when config has none', async () => {
    mockGetGameConfig.mockReturnValue({ assetManifest: null, scenePath: null });
    vi.resetModules();
    const { initWorldSync } = await import('../../app/ecs/init');
    initWorldSync();

    await new Promise(r => setTimeout(r, 10));

    expect(mockFetch).toHaveBeenCalledWith('/assets.manifest.json');
  });

  it('calls loadAllFonts with manifest assets', async () => {
    vi.resetModules();
    const { initWorldSync } = await import('../../app/ecs/init');
    initWorldSync();

    await new Promise(r => setTimeout(r, 10));

    expect(mockLoadAllFonts).toHaveBeenCalledWith([{ path: '/fonts/test.ttf', type: 'font' }]);
  });

  it('handles fetch failure gracefully', async () => {
    mockFetch.mockRejectedValue(new Error('network error'));
    vi.resetModules();
    const { initWorldSync } = await import('../../app/ecs/init');

    // Should not throw
    initWorldSync();
    await new Promise(r => setTimeout(r, 10));

    expect(mockLoadAllFonts).not.toHaveBeenCalled();
  });
});

describe('loadInitialScene', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads scene from config scenePath', async () => {
    mockGetGameConfig.mockReturnValue({ scenePath: '/scenes/test.json' });
    vi.resetModules();
    const { loadInitialScene } = await import('../../app/ecs/init');

    await loadInitialScene();

    expect(mockLoadScene).toHaveBeenCalledWith('/scenes/test.json');
  });

  it('skips loading when no scenePath is set', async () => {
    mockGetGameConfig.mockReturnValue({ scenePath: null });
    vi.resetModules();
    const { loadInitialScene } = await import('../../app/ecs/init');

    await loadInitialScene();

    expect(mockLoadScene).not.toHaveBeenCalled();
  });

  it('re-throws scene load errors', async () => {
    mockGetGameConfig.mockReturnValue({ scenePath: '/bad-scene.json' });
    mockLoadScene.mockRejectedValue(new Error('scene not found'));
    vi.resetModules();
    const { loadInitialScene } = await import('../../app/ecs/init');

    await expect(loadInitialScene()).rejects.toThrow('scene not found');
  });
});
