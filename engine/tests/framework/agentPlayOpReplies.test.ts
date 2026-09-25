/** The agent `play` / `stop` ops reply with what the controller DID, not with the state they re-read
 *  afterwards (#1574).
 *
 *  A refused Play reads 'stopped' — the same as a Play that was never asked for — so the ops used to
 *  answer `ok:true, playState:'stopped'` over every `enterPlay` refusal, and `ok:true` over a Stop
 *  whose revert was skipped. A restore that threw escaped as a plain throw, which the relay turns
 *  into NOT_AVAILABLE_HERE ("relaunch"). Each case drives the REAL ops over the real controller;
 *  which refusal fires is pinned per reason in `packages/modoki/tests/editor/playModeOutcome.test.ts`.
 *
 *  The Rapier loader is the controllable one from `agentOpsPhysicsRaces.test.ts` — its pending load
 *  is the only headless way to hold `enterPlay` inside its startup window. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const rapier = vi.hoisted(() => ({
  ready: false,
  release: null as (() => void) | null,
  current: null as Promise<void> | null,
}));
vi.mock('../../packages/modoki/src/runtime/physics/rapierLoader', () => ({
  isRapierReady: () => rapier.ready,
  getRapier: () => { throw new Error('test loader: no Rapier module'); },
  initRapier2D: () => {
    if (!rapier.current) rapier.current = new Promise<void>((resolve) => { rapier.release = () => { rapier.ready = true; resolve(); }; });
    return rapier.current;
  },
}));

import { runAgentOp } from '../../app/debug/agentBridge';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import { createTestWorld, type TestWorld, RigidBody2D, setPlayState, getPlayState, sceneManager, getCurrentWorld, setCurrentWorld } from '@modoki/engine/runtime';
import { createWorld } from 'koota';
import { beginTimelinePreviewSession } from '../../packages/modoki/src/editor/scene/timelinePreview';
import { setRunMode, getRunMode } from '@modoki/engine/runtime';

registerEditorAgentOps();

type Reply = { ok?: boolean; code?: string; error?: string; reason?: string; playState?: string; reverted?: boolean; queued?: boolean };

let game: TestWorld | undefined;
const settle = () => new Promise<void>((r) => setTimeout(r, 0));
beforeEach(() => {
  rapier.ready = true; rapier.release = null; rapier.current = null;
  game = createTestWorld({});
  game.spawn(RigidBody2D());
  // The runtime DEFAULT is 'playing' (a shipped game boots playing); the editor authors in 'stopped'.
  setPlayState('stopped');
});
afterEach(async () => {
  // A case that failed before releasing the load must not leave `enterPlay` parked for the next one.
  rapier.release?.();
  await settle();
  vi.restoreAllMocks();
  if (getPlayState() !== 'stopped') await runAgentOp('stop');
  // A restore that threw flags the world "not authored" until a world swap — make one.
  const before = getCurrentWorld();
  const scratch = createWorld();
  setCurrentWorld(scratch); setCurrentWorld(before); scratch.destroy();
  setPlayState('stopped');
  game?.dispose(); game = undefined;
});

describe('agent play — a refused Play is a coded refusal, not ok:true', () => {
  it('ACCEPT SIDE: play from stopped starts, and stop reports the revert', async () => {
    expect(await runAgentOp('play')).toMatchObject({ ok: true, playState: 'playing' });
    expect(await runAgentOp('stop')).toMatchObject({ ok: true, playState: 'stopped', reverted: true });
  });

  it('a scene swap in flight → REFUSED_BY_OP, reason scene-swap', async () => {
    vi.spyOn(sceneManager, 'getNext').mockReturnValue({} as ReturnType<typeof sceneManager.getNext>);
    const r = await runAgentOp('play') as Reply;
    expect(r).toMatchObject({ ok: false, code: 'REFUSED_BY_OP', reason: 'scene-swap', playState: 'stopped' });
    expect(r.error).toMatch(/Play refused — a scene load is still in flight/);
  });

  it('a second play while the first is starting up → REFUSED_BY_OP, reason already-starting', async () => {
    rapier.ready = false;
    const first = runAgentOp('play') as Promise<Reply>;
    await settle();
    expect(rapier.release, 'premise: the first Play is parked in its startup window').not.toBeNull();
    expect(await runAgentOp('play')).toMatchObject({ ok: false, code: 'REFUSED_BY_OP', reason: 'already-starting' });
    rapier.release!();
    expect(await first).toMatchObject({ ok: true, playState: 'playing' });
  });

  it('a Stop during startup: stop replies queued, and play replies REFUSED_BY_OP (Play was cut short)', async () => {
    rapier.ready = false;
    const play = runAgentOp('play') as Promise<Reply>;
    await settle();
    expect(await runAgentOp('stop')).toMatchObject({ ok: true, queued: true });
    rapier.release!();
    const r = await play;
    expect(r).toMatchObject({ ok: false, code: 'REFUSED_BY_OP', reason: 'stopped-during-startup', reverted: true, playState: 'stopped' });
    expect(r.error).toMatch(/a Stop that arrived during startup ended it/);
  });
});

describe('agent stop — the reply says whether the revert happened', () => {
  it('a restore that THROWS is REFUSED_BY_OP, not an escaped throw — and the next play is refused', async () => {
    expect(await runAgentOp('play')).toMatchObject({ ok: true });
    vi.spyOn(sceneManager, 'loadScene').mockRejectedValueOnce(new Error('reload failed'));
    const r = await runAgentOp('stop') as Reply;
    expect(r).toMatchObject({ ok: false, code: 'REFUSED_BY_OP', playState: 'stopped' });
    expect(r.error).toMatch(/restoring the authored world FAILED \(reload failed\)/);
    expect(await runAgentOp('play')).toMatchObject({ ok: false, code: 'REFUSED_BY_OP', reason: 'restore-failed' });
  });

  it('a Stop that exits a preview envelope reports its revert', async () => {
    expect(await beginTimelinePreviewSession(), 'premise: a preview session opened').toBe(true);
    setRunMode('scrub');
    const r = await runAgentOp('stop') as Reply;
    expect(r).toMatchObject({ ok: true, reverted: true });
    expect(getRunMode()).toBe('stopped');
  });

  it('a skipped revert is ok:true but reverted:false, with the reason', async () => {
    setPlayState('playing');   // playing with no authored snapshot behind it
    const r = await runAgentOp('stop') as Reply;
    expect(r).toMatchObject({ ok: true, playState: 'stopped', reverted: false });
    expect(r.reason).toMatch(/no authored snapshot/);
  });
});
