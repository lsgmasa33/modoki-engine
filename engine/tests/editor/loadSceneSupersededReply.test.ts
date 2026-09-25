/** A superseded `load-scene` names the WINNING scene, not the editor's tracked path (#1553 review).
 *
 *  When a later load wins the swap, the editor's tracked path is written by that load's own tail, so
 *  at the moment this op replies it can still hold the pre-swap value. The error text already read
 *  `sceneManager.getCurrent()` for that reason; #1553's reply briefly paired it with a `scenePath`
 *  read from the tracked path, so one reply named two different scenes. `loadScene` is stubbed to
 *  report `superseded` — the only way to reach that branch without racing two real loads. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@modoki/engine/editor', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadScene: vi.fn(async () => 'superseded'),
}));

import { createTestWorld, type TestWorld, setPlayState, sceneManager } from '@modoki/engine/runtime';
import { clearHistory, markSceneSaved, getCurrentScenePath } from '@modoki/engine/editor';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import { runAgentOp } from '../../app/debug/agentBridge';

registerAllTraits();
registerEditorAgentOps();

let game: TestWorld;
beforeEach(() => { game = createTestWorld({}); setPlayState('stopped'); clearHistory(); markSceneSaved(); });
afterEach(() => { vi.restoreAllMocks(); game.dispose(); });

describe('superseded load-scene reply', () => {
  it('scenePath is the scene manager\'s winner, agreeing with the error text', async () => {
    vi.spyOn(sceneManager, 'getCurrent').mockReturnValue({ path: '/assets/scenes/Winner.scene.json' } as ReturnType<typeof sceneManager.getCurrent>);
    // The premise: the tracked path is NOT the winner at this instant.
    expect(getCurrentScenePath()).not.toBe('/assets/scenes/Winner.scene.json');
    const reply = await runAgentOp('load-scene', { path: '/assets/scenes/Mine.scene.json' }) as { ok: boolean; superseded?: boolean; scenePath?: string; error?: string };
    expect(reply).toMatchObject({ ok: false, superseded: true, scenePath: '/assets/scenes/Winner.scene.json' });
    expect(reply.error).toContain('"/assets/scenes/Winner.scene.json" is now the active scene');
  });
});
