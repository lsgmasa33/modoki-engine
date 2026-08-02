/** preflightSceneMove / formatSceneMoveConfirm — base-scene-and-persistence-
 *  plan.md Phase 14's sibling-collision scan + confirm-dialog text. Uses the
 *  REAL world/entityUtils/traitRegistry (mirrors sourceSceneProvenance.test.ts)
 *  since this module doesn't touch entityActions.ts's undo machinery; only
 *  fetch + the asset manifest are mocked. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWorld } from 'koota';
import { EntityAttributes } from '../../src/runtime/core/traits/EntityAttributes';
import { PrefabInstance } from '../../src/runtime/traits/PrefabInstance';
import { setCurrentWorld, registerEntity, indexEntityGuid } from '../../src/runtime/core/ecs/world';
import { registerTrait } from '../../src/runtime/core/ecs/traitRegistry';
import { setRunMode } from '../../src/runtime/core/playState';

const mockAssets: { guid: string; path: string; type: string }[] = [];
vi.mock('../../src/runtime/loaders/assetManifest', () => ({
  getAllAssets: () => mockAssets,
}));
vi.mock('../../src/runtime/loaders/assetUrl', () => ({
  assetUrl: (path: string) => path,
}));
vi.mock('../../src/runtime/loaders/assetFetch', () => ({
  ASSET_FETCH_INIT: {},
}));

const mockScenePath = { current: '' };
vi.mock('../../src/editor/scene/serialize', () => ({
  getCurrentScenePath: () => mockScenePath.current,
}));

function registerAll() {
  registerTrait({
    name: 'EntityAttributes', trait: EntityAttributes, category: 'component',
    fields: { name: { type: 'string' }, isActive: { type: 'boolean' }, sortOrder: { type: 'number' }, parentId: { type: 'number', entityId: { onMissing: 'root' } }, layer: { type: 'enum', options: ['', '3d', '2d', 'ui'] }, guid: { type: 'string' }, sourceScene: { type: 'string', hidden: true, runtimeOnly: true } },
  });
  registerTrait({
    name: 'PrefabInstance', trait: PrefabInstance, category: 'component',
    fields: { source: { type: 'string' }, localId: { type: 'number' }, rootInstanceId: { type: 'number', entityId: { onMissing: 'stripTrait' } }, parentLocalId: { type: 'number' } },
  });
}

function freshWorld() {
  const w = createWorld();
  setCurrentWorld(w);
  return w;
}
function spawn(w: ReturnType<typeof createWorld>, ...args: any[]) {
  const ent = w.spawn(...args);
  registerEntity(ent);
  indexEntityGuid(ent);
  return ent;
}

beforeEach(() => {
  registerAll();
  mockAssets.length = 0;
  mockScenePath.current = '';
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => {
  setRunMode('playing', { advancing: true });
  vi.unstubAllGlobals();
});

describe('preflightSceneMove', () => {
  it('reports subtree count, re-root-from name, and prefab instance roots (no scan on demote)', async () => {
    const { preflightSceneMove } = await import('../../src/editor/scene/sceneMoveScan');
    const w = freshWorld();
    const parent = spawn(w, EntityAttributes({ name: 'Parent', guid: 'g-parent' }));
    const root = spawn(w, EntityAttributes({ name: 'Root', guid: 'g-root', parentId: parent.id() }),
      PrefabInstance({ source: 'p.json', localId: 1, rootInstanceId: 0 }));
    root.set(PrefabInstance, { ...root.get(PrefabInstance)!, rootInstanceId: root.id() });
    spawn(w, EntityAttributes({ name: 'Child', guid: 'g-child', parentId: root.id() }));

    const pre = await preflightSceneMove(root.id(), ''); // demote
    expect(pre.entityName).toBe('Root');
    expect(pre.subtreeCount).toBe(2); // Root + Child
    expect(pre.reRootFrom).toBe('Parent');
    expect(pre.prefabInstanceRoots).toEqual(['Root']);
    expect(pre.collisions).toEqual([]);
    expect(pre.scanned).toBe(0);
  });

  it('flags a sibling scene (same baseScene as the promote target) containing a moving guid', async () => {
    const { preflightSceneMove } = await import('../../src/editor/scene/sceneMoveScan');
    const w = freshWorld();
    const root = spawn(w, EntityAttributes({ name: 'Root', guid: 'shared-guid' }));
    mockAssets.push(
      { guid: 'sibling-1', path: '/assets/scenes/Sibling.json', type: 'scene' },
      { guid: 'other-base', path: '/assets/scenes/OtherBase.json', type: 'scene' },
    );
    (global.fetch as any).mockImplementation((path: string) => {
      if (path === '/assets/scenes/Sibling.json') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ baseScene: 'base-1', entities: [{ traits: { EntityAttributes: { guid: 'shared-guid' } } }] }) });
      }
      if (path === '/assets/scenes/OtherBase.json') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ baseScene: 'not-base-1', entities: [{ traits: { EntityAttributes: { guid: 'shared-guid' } } }] }) });
      }
      return Promise.resolve({ ok: false });
    });

    const pre = await preflightSceneMove(root.id(), 'base-1'); // promote into base-1
    expect(pre.scanned).toBe(1); // only Sibling.json declares baseScene==='base-1'
    expect(pre.collisions).toHaveLength(1);
    expect(pre.collisions[0].path).toBe('/assets/scenes/Sibling.json');
    expect(pre.collisions[0].guids).toEqual(['shared-guid']);
  });

  it('ignores the currently-open scene and the target base scene itself', async () => {
    const { preflightSceneMove } = await import('../../src/editor/scene/sceneMoveScan');
    const w = freshWorld();
    const root = spawn(w, EntityAttributes({ name: 'Root', guid: 'g1' }));
    mockScenePath.current = '/assets/scenes/CurrentlyOpen.json';
    mockAssets.push(
      { guid: 'g1', path: '/assets/scenes/CurrentlyOpen.json', type: 'scene' },
      { guid: 'base-1', path: '/assets/scenes/Base.json', type: 'scene' },
    );
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await preflightSceneMove(root.id(), 'base-1');
    expect(fetchSpy).not.toHaveBeenCalled(); // both candidates skipped
  });

  it('records a failed fetch in scanFailed rather than throwing', async () => {
    const { preflightSceneMove } = await import('../../src/editor/scene/sceneMoveScan');
    const w = freshWorld();
    const root = spawn(w, EntityAttributes({ name: 'Root', guid: 'g1' }));
    mockAssets.push({ guid: 'sib', path: '/assets/scenes/Broken.json', type: 'scene' });
    (global.fetch as any).mockRejectedValue(new Error('network down'));

    const pre = await preflightSceneMove(root.id(), 'base-1');
    expect(pre.scanFailed).toEqual(['/assets/scenes/Broken.json']);
    expect(pre.collisions).toEqual([]);
  });

});

describe('formatSceneMoveConfirm', () => {
  it('names the re-root parent, prefab instances, and collisions', async () => {
    const { formatSceneMoveConfirm } = await import('../../src/editor/scene/sceneMoveScan');
    const text = formatSceneMoveConfirm({
      entityName: 'HeartsRoot', subtreeCount: 3, reRootFrom: 'UIRoot',
      prefabInstanceRoots: ['Fish'], collisions: [{ path: '/assets/scenes/Lvl-0002.json', name: 'Lvl-0002.json', guids: ['g1'] }],
      scanned: 1, scanFailed: [],
    }, 'base-1');
    expect(text).toContain('Promote "HeartsRoot"');
    expect(text).toContain('UIRoot');
    expect(text).toContain('Fish');
    expect(text).toContain('Lvl-0002.json');
    expect(text).toContain('Nothing is written to disk now');
  });

  it('says "Demote" and omits the "every level" line for a demote (targetScene "")', async () => {
    const { formatSceneMoveConfirm } = await import('../../src/editor/scene/sceneMoveScan');
    const text = formatSceneMoveConfirm({
      entityName: 'E', subtreeCount: 1, reRootFrom: null, prefabInstanceRoots: [], collisions: [], scanned: 0, scanFailed: [],
    }, '');
    expect(text).toContain('Demote "E"');
    expect(text).not.toContain('Every level');
  });
});
