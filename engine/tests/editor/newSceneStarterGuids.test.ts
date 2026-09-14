/** #1199 — `modoki_new_scene`'s starter entities must be guid-addressable straight away.
 *
 *  The agent `new-scene` op calls `newScene()` with no path and does NOT save. Its four starters
 *  (Camera, HDR Environment, two Lights) used to spawn with no guid, so they stayed out of the guid
 *  index until the first save or undoable edit — and every guid-addressed op refused them. The
 *  human route (Assets → Create Scene) saves immediately, which minted guids and hid the gap.
 *
 *  Driven through the registered `new-scene` op, not `newScene()` directly, because the op is the
 *  route that never saves. `SceneManager` is mocked only so `replaceWorldContent` populates the
 *  test world in place — the populate callback itself is the real one from `serialize.ts`. */

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../packages/modoki/src/runtime/scene/SceneManager', async () => {
  const { getCurrentWorld } = await import('../../packages/modoki/src/runtime/core/ecs/world');
  return {
    sceneManager: {
      getCurrent: () => null,
      loadScene: async () => {},
      getLoadedScenes: () => new Map(),
      replaceWorldContent: async (populate: (w: unknown) => void) => { populate(getCurrentWorld()); },
    },
  };
});

import { createTestWorld, type TestWorld } from '@modoki/engine/runtime';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { runAgentOp } from '../../app/debug/agentBridge';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';

vi.stubGlobal('localStorage', { setItem: () => {}, getItem: () => null, removeItem: () => {} });

registerAllTraits();
registerEditorAgentOps();

let game: TestWorld | undefined;
afterEach(() => { game?.dispose(); game = undefined; });

type Row = { id: number; guid: string | null; name: string };
const STARTERS = ['Camera', 'HDR Environment', 'Directional Light', 'Ambient Light'];

describe('new-scene starters carry real guids (#1199)', () => {
  it('each starter has a distinct guid that is not its id, and a guid-addressed read finds it', async () => {
    game = createTestWorld({});
    await runAgentOp('new-scene', {});

    const s = await runAgentOp('scene-state', {}) as { entities: Row[] };
    const starters = STARTERS.map((n) => s.entities.find((e) => e.name === n)!);
    expect(starters.every(Boolean)).toBe(true);
    for (const row of starters) {
      expect(row.guid).toBeTruthy();
      expect(row.guid).not.toBe(String(row.id));
      const byGuid = await runAgentOp('scene-state', { guid: row.guid }) as { entities: Row[] };
      expect(byGuid.entities.map((e) => e.name)).toEqual([row.name]);
    }
    expect(new Set(starters.map((r) => r.guid)).size).toBe(STARTERS.length);
  });

  it('a guid-addressed WRITE on a starter lands — the NOT_FOUND the issue reports is gone', async () => {
    game = createTestWorld({});
    await runAgentOp('new-scene', {});
    const s = await runAgentOp('scene-state', { name: 'Ambient Light' }) as { entities: Row[] };
    const guid = s.entities[0].guid!;

    const r = await runAgentOp('delete-entities', { guids: [guid] }) as { ok?: boolean; error?: string };
    expect(r.ok, r.error).not.toBe(false);
    const after = await runAgentOp('scene-state', { name: 'Ambient Light' }) as { entities: Row[] };
    expect(after.entities).toEqual([]);
  });
});
