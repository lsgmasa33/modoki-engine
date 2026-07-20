/** reimportTargets — which assets a Re-import touches (editor-panels missing
 *  test #7). The Assets panel's `reimport` filters by recursive-prefix match AND
 *  by "has a server handler" (texture/model only). Extracted to assetOps.ts (F6/
 *  F7) so the matching rule — the F9 client/server-drift seam — is testable
 *  without rendering the panel. */

import { describe, it, expect, vi, afterEach } from 'vitest';

// Stub the backend transport so refreshHandlerTypes() can be driven without a
// dev server. Hoisted by vitest above the import below.
const backendFetchMock = vi.fn();
vi.mock('../../src/editor/backend/editorBackend', () => ({
  backendFetch: (...args: unknown[]) => backendFetchMock(...args),
}));

import { reimportTargets, HANDLER_TYPES, refreshHandlerTypes } from '../../src/editor/panels/assetOps';
import type { AssetEntry } from '../../src/editor/utils/assetPaths';

/** Reset HANDLER_TYPES to its seeded default after each test that mutates it,
 *  since it's a module-level singleton shared across the suite. */
function resetHandlerTypes() {
  HANDLER_TYPES.clear();
  HANDLER_TYPES.add('texture');
  HANDLER_TYPES.add('model');
}

const A = (path: string, type: string): AssetEntry => ({ path, name: path.split('/').pop()!, type });

const assets: AssetEntry[] = [
  A('/assets/models/island.glb', 'model'),
  A('/assets/models/rock.glb', 'model'),
  A('/assets/textures/sand.png', 'texture'),
  A('/assets/textures/leaf.png', 'texture'),
  A('/assets/prefabs/Island.prefab.json', 'prefab'),   // non-handler type
  A('/assets/scenes/main.json', 'scene'),               // non-handler type
];

describe('reimportTargets', () => {
  it('non-recursive matches exactly the asset at the target path', () => {
    const t = reimportTargets(assets, '/assets/models/island.glb', false);
    expect(t.map((a) => a.path)).toEqual(['/assets/models/island.glb']);
  });

  it("recursive '/' = ALL handler assets (models + textures), never prefabs/scenes", () => {
    const t = reimportTargets(assets, '/', true);
    expect(t.map((a) => a.path).sort()).toEqual([
      '/assets/models/island.glb',
      '/assets/models/rock.glb',
      '/assets/textures/leaf.png',
      '/assets/textures/sand.png',
    ]);
  });

  it('recursive folder match uses a prefix (and tolerates a trailing slash)', () => {
    expect(reimportTargets(assets, '/assets/textures', true).map((a) => a.path).sort())
      .toEqual(['/assets/textures/leaf.png', '/assets/textures/sand.png']);
    // Trailing slash on the folder must not break the prefix.
    expect(reimportTargets(assets, '/assets/textures/', true).map((a) => a.path).sort())
      .toEqual(['/assets/textures/leaf.png', '/assets/textures/sand.png']);
  });

  it('prefix match is folder-boundary aware (does not leak a sibling folder)', () => {
    // "/assets/model" must NOT match "/assets/models/*" — the prefix appends "/".
    expect(reimportTargets(assets, '/assets/model', true)).toEqual([]);
  });

  it('filters non-handler types out even on an exact hit ("Nothing to re-import")', () => {
    // A prefab/scene has no server handler — selecting it directly yields nothing.
    expect(reimportTargets(assets, '/assets/prefabs/Island.prefab.json', false)).toEqual([]);
    expect(reimportTargets(assets, '/assets/scenes/main.json', false)).toEqual([]);
    // An empty set is the "Nothing to re-import" path the panel guards on.
    expect(reimportTargets([], '/', true)).toEqual([]);
  });

  it('HANDLER_TYPES is exactly the texture/model set', () => {
    expect([...HANDLER_TYPES].sort()).toEqual(['model', 'texture']);
  });
});

describe('refreshHandlerTypes (F9 — derive re-import set from the server registry)', () => {
  afterEach(() => { backendFetchMock.mockReset(); resetHandlerTypes(); });

  const okResponse = (body: unknown) => ({ ok: true, json: async () => body }) as unknown as Response;

  it('overwrites HANDLER_TYPES with the server-registered types', async () => {
    backendFetchMock.mockResolvedValue(okResponse({ types: ['texture', 'model', 'audio'] }));
    await refreshHandlerTypes();
    expect(backendFetchMock).toHaveBeenCalledWith('/api/reimport-types');
    expect([...HANDLER_TYPES].sort()).toEqual(['audio', 'model', 'texture']);
  });

  it('makes a newly-registered server type re-importable via reimportTargets', async () => {
    backendFetchMock.mockResolvedValue(okResponse({ types: ['texture', 'model', 'audio'] }));
    await refreshHandlerTypes();
    const withAudio: AssetEntry[] = [
      ...assets,
      A('/assets/sfx/click.wav', 'audio'),
    ];
    // Before F9 this would be filtered out (audio not in the hardcoded set); now
    // it surfaces because the set was derived from the server.
    expect(reimportTargets(withAudio, '/assets/sfx/click.wav', false).map((a) => a.path))
      .toEqual(['/assets/sfx/click.wav']);
  });

  it('keeps the seeded fallback when the server is unreachable / not ok', async () => {
    backendFetchMock.mockResolvedValue({ ok: false } as unknown as Response);
    await refreshHandlerTypes();
    expect([...HANDLER_TYPES].sort()).toEqual(['model', 'texture']);
    backendFetchMock.mockRejectedValue(new Error('no dev server'));
    await refreshHandlerTypes();
    expect([...HANDLER_TYPES].sort()).toEqual(['model', 'texture']);
  });

  it('keeps the seeded fallback rather than blanking on an empty/garbage payload', async () => {
    backendFetchMock.mockResolvedValue(okResponse({ types: [] }));
    await refreshHandlerTypes();
    expect([...HANDLER_TYPES].sort()).toEqual(['model', 'texture']);
    backendFetchMock.mockResolvedValue(okResponse({ notTypes: 1 }));
    await refreshHandlerTypes();
    expect([...HANDLER_TYPES].sort()).toEqual(['model', 'texture']);
  });
});
