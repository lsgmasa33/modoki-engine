/** The Assets double-click and the Inspector's Open Scene button both open a scene through
 *  `openAssetInEditor`, and it must ask the unsaved-work gate BEFORE the load (#1419) — the load is
 *  what discards the open scene and, since #1409, its undo stack. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const gate = vi.fn<(action: string, scope: string) => Promise<boolean>>();
const loadScene = vi.fn(async () => 'loaded');
vi.mock('../../packages/modoki/src/editor/scene/unsavedGate', () => ({ confirmDiscardUnsaved: gate }));
vi.mock('../../packages/modoki/src/editor/scene/serialize', () => ({ loadScene }));
const openPrefabForEditing = vi.fn(async (_a: unknown, _o?: { confirmDiscard?: (action: string) => Promise<boolean> }) => {});
vi.mock('../../packages/modoki/src/editor/scene/prefabEdit', () => ({ openPrefabForEditing }));

const { openAssetInEditor } = await import('../../packages/modoki/src/editor/panels/openAssetInEditor');

describe('openAssetInEditor asks before opening a scene (#1419)', () => {
  beforeEach(() => { gate.mockReset(); loadScene.mockClear(); });

  it('Cancel on the gate leaves the open scene alone', async () => {
    gate.mockResolvedValue(false);
    await openAssetInEditor({ path: '/assets/scenes/B.scene.json', type: 'scene', name: 'B' } as never);
    expect(gate).toHaveBeenCalledWith('open scene B', 'world-swap');
    expect(loadScene).not.toHaveBeenCalled();
  });

  it('a proceeding gate loads the scene', async () => {
    gate.mockResolvedValue(true);
    await openAssetInEditor({ path: '/assets/scenes/B.scene.json', type: 'scene', name: 'B' } as never);
    expect(loadScene).toHaveBeenCalledWith('/assets/scenes/B.scene.json');
  });
});

// The prefab route hands the gate to `openPrefabForEditing`, which asks only about what its own
// auto-save could not write (an untitled scene, a failed save). Without the option the human route
// would behave like the agent op, which passes none.
describe('openAssetInEditor hands the prefab route the unsaved-work gate (#1419)', () => {
  it('passes a confirmDiscard that asks the gate with world-swap scope', async () => {
    gate.mockReset().mockResolvedValue(false);
    await openAssetInEditor({ path: '/assets/prefabs/P.prefab.json', type: 'prefab', name: 'P' } as never);
    const opts = openPrefabForEditing.mock.calls[0]?.[1];
    expect(opts?.confirmDiscard).toBeTypeOf('function');
    expect(await opts!.confirmDiscard!('edit prefab P')).toBe(false);
    expect(gate).toHaveBeenCalledWith('edit prefab P', 'world-swap');
  });
});
