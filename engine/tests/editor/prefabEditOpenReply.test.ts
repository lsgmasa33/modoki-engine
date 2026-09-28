/** #1700 close-out review — the agent `prefab edit-open` reply names a failure when the edit-open did not open THIS prefab.
 *
 *  `openPrefabForEditing` reports failure by returning early (a UI path), and since #1700 it also returns early when a
 *  newer scene request replaced the world while it waited. The op read that as success whenever SOME prefab was being
 *  edited — opened from inside prefab A's edit world, an edit-open of B that returned early answered ok:true, naming A.
 *  Driven through `runAgentOp` against the real op, with the two prefabEdit entry points mocked as in
 *  `prefabEditExitGuard.test.ts`; the edit session is the REAL store.
 *
 *  Mutation checked: drop `editing.path !== p.path` — "an edit-open of B that returned early" goes green-when-wrong (red
 *  here), and nothing else in this file moves. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestWorld, type TestWorld, setPlayState } from '@modoki/engine/runtime';
import { markSceneSaved, clearHistory, clearDirtyAssets } from '@modoki/engine/editor';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import { runAgentOp } from '../../app/debug/agentBridge';
import { useEditorStore } from '../../packages/modoki/src/editor/store/editorStore';

const A = { path: '/assets/prefabs/A.prefab.json', guid: 'aaaaaaaa-0000-4000-8000-000000001700', name: 'A' };
const B = { path: '/assets/prefabs/B.prefab.json', guid: 'bbbbbbbb-0000-4000-8000-000000001700', name: 'B' };
const prefab = vi.hoisted(() => ({ opens: true, opts: [] as unknown[] }));
vi.mock('../../packages/modoki/src/editor/scene/prefabEdit', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isEditingPrefab: () => useEditorStore.getState().editingPrefab != null,
  // Stands in for the real one: it either enters the session for the path it was given, or returns early.
  openPrefabForEditing: async (asset: { path: string; name: string }, opts?: unknown) => {
    prefab.opts.push(opts);
    if (prefab.opens) useEditorStore.getState().openPrefabEditor({ path: asset.path, guid: B.guid, name: asset.name }, null);
  },
}));

registerAllTraits();
registerEditorAgentOps();

let game: TestWorld | undefined;
beforeEach(() => {
  game = createTestWorld({});
  setPlayState('stopped');
  clearHistory();
  clearDirtyAssets();
  markSceneSaved();
  prefab.opens = true;
  prefab.opts.length = 0;
  useEditorStore.getState().openPrefabEditor(A, null); // already editing A
  vi.stubGlobal('localStorage', { setItem: () => {}, getItem: () => null, removeItem: () => {} });
});
afterEach(() => {
  useEditorStore.getState().closePrefabEditor();
  game?.dispose(); game = undefined;
  vi.unstubAllGlobals();
});

describe('prefab edit-open reply names the prefab it was asked for', () => {
  it('an edit-open of B that returned early FAILS — it does not answer ok:true naming A', async () => {
    prefab.opens = false;
    const err = await runAgentOp('prefab', { prefabAction: 'edit-open', path: B.path }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/edit-open FAILED for .*B\.prefab\.json.*still editing .*A\.prefab\.json/);
  });

  it('ACCEPT SIDE: an edit-open of B that entered B succeeds', async () => {
    await expect(runAgentOp('prefab', { prefabAction: 'edit-open', path: B.path })).resolves.toBeDefined();
    expect(useEditorStore.getState().editingPrefab?.path).toBe(B.path);
  });
});

// #1745: the op's guard lets `discardUnsaved` through, and the open's own auto-save then wrote the discarded work into the
// scene file. The op must hand the discard to the open, which skips that save (prefabEditOpenDiscard.test.ts). Mutation
// checked: pass `{}` instead of the discard → the first case goes red, the accept side stays green.
describe('prefab edit-open hands the caller\'s discard to the open (#1745)', () => {
  it('edit-open {discardUnsaved:true} opens with discardUnsaved, so its auto-save is skipped', async () => {
    await runAgentOp('prefab', { prefabAction: 'edit-open', path: B.path, discardUnsaved: true });
    expect(prefab.opts).toEqual([{ discardUnsaved: true }]);
  });

  it('ACCEPT SIDE: a plain edit-open does not ask to discard', async () => {
    await runAgentOp('prefab', { prefabAction: 'edit-open', path: B.path });
    expect(prefab.opts).toHaveLength(1);
    expect((prefab.opts[0] as { discardUnsaved?: boolean } | undefined)?.discardUnsaved).not.toBe(true);
  });
});
