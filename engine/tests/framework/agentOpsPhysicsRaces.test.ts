/** The editor `play`/`resume`/`step` ops and the device `sim-step` op around a Rapier load that is
 *  slow or permanently failed (#1175 close-out review).
 *
 *  The happy path is pinned elsewhere (editorStepPhysicsReady / simStepPhysicsReady, real WASM).
 *  What is pinned HERE is what the review found the awaits broke or left unsaid:
 *  - `resume` awaited physics and did not re-read the state: a Stop landing during the WASM fetch
 *    turned it into a full Play — the outcome the op exists to refuse;
 *  - a PERMANENT init failure must be named — refused by `step`/`resume`/`sim-step`, reported as
 *    `physicsError` by `play` — never a silent physics-free tick, and never "still loading" forever;
 *  - `sim-step` waits inside its own budget and says `physicsLoading` only when the budget runs out.
 *
 *  The loader is replaced by a controllable one with the SAME contract (#541 memoisation: one
 *  in-flight promise; a permanent failure stays memoised). */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const rapier = vi.hoisted(() => ({
  ready: false,
  mode: 'deferred' as 'deferred' | 'fail',
  release: null as (() => void) | null,
  current: null as Promise<void> | null,
}));
vi.mock('../../packages/modoki/src/runtime/physics/rapierLoader', () => ({
  isRapierReady: () => rapier.ready,
  getRapier: () => { throw new Error('test loader: no Rapier module'); },
  initRapier2D: () => {
    if (!rapier.current) {
      rapier.current = rapier.mode === 'fail'
        ? Promise.reject(new Error('wasm instantiate failed'))
        : new Promise<void>((resolve) => { rapier.release = () => { rapier.ready = true; resolve(); }; });
      rapier.current.catch(() => { /* memoised: permanent */ });
    }
    return rapier.current;
  },
}));

import { runAgentOp } from '../../app/debug/agentBridge';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import {
  createTestWorld, type TestWorld, RigidBody2D, setPlayState, getPlayState, getCurrentWorld,
  setTimeScale, getTimeScale, registerFrameCallback, unregisterFrameCallback, setCurrentWorld,
} from '@modoki/engine/runtime';
import { createWorld } from 'koota';

registerEditorAgentOps();

let game: TestWorld | undefined;
const settle = () => new Promise<void>((r) => setTimeout(r, 0));
beforeEach(() => {
  rapier.ready = false; rapier.mode = 'deferred'; rapier.release = null; rapier.current = null;
  game = createTestWorld({});
  game.spawn(RigidBody2D());
});
afterEach(() => {
  unregisterFrameCallback('__test-physics-race-probe');
  setPlayState('stopped');
  game?.dispose(); game = undefined;
});

type Reply = { ok?: boolean; error?: string; playState?: string; physicsLoading?: string[]; physicsError?: string };

describe('editor ops — physics load races and permanent failure', () => {
  it('resume: a Stop landing during the physics await is NOT turned into a full Play', async () => {
    setPlayState('paused');
    const p = runAgentOp('resume') as Promise<Reply>;
    await settle();
    expect(rapier.release, 'premise: resume is waiting on the load').not.toBeNull();
    setPlayState('stopped');           // the Stop lands mid-fetch
    rapier.release!();
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/PAUSED/);
    expect(getPlayState()).toBe('stopped');
  });

  it('step: a permanent init failure is refused and NO frame runs', async () => {
    rapier.mode = 'fail';
    setPlayState('paused');
    let frames = 0;
    registerFrameCallback('__test-physics-race-probe', () => { frames++; }, 100);
    const r = await runAgentOp('step') as Reply;
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/step refused — physics failed to initialize.*wasm instantiate failed/);
    expect(frames).toBe(0);
    expect(getPlayState()).toBe('paused');
  });

  it('play: a permanent init failure still enters Play (as a human\'s would) but REPORTS physicsError', async () => {
    rapier.mode = 'fail';
    setPlayState('stopped');
    const r = await runAgentOp('play') as Reply;
    expect(getPlayState(), 'premise: Play actually started').toBe('playing');
    expect(r.physicsError).toMatch(/physics failed to initialize.*wasm instantiate failed/);
  });

  it('play from STOPPED: a Stop landing while the op waits for physics is honoured — Play ends stopped', async () => {
    // The wait happens INSIDE enterPlay's `_entering` latch, so the Stop is queued (#470). An await in
    // front of enterPlay — the op's first shape — sat outside the latch and dropped this Stop.
    setPlayState('stopped');
    const p = runAgentOp('play') as Promise<Reply>;
    await settle();
    expect(rapier.release, 'premise: play is waiting on the load').not.toBeNull();
    const stopped = runAgentOp('stop');
    rapier.release!();
    await p; await stopped;
    expect(getPlayState()).toBe('stopped');
  });

  it('play from PAUSED waits for physics too — no tick runs while the WASM loads', async () => {
    // enterPlay's paused branch awaits nothing, so without the op's own wait this flipped to playing
    // with Rapier cold (the regression the second review found).
    setPlayState('paused');
    const p = runAgentOp('play') as Promise<Reply>;
    await settle();
    expect(rapier.release, 'premise: play is waiting on the load').not.toBeNull();
    expect(getPlayState(), 'must still be paused while physics loads').toBe('paused');
    rapier.release!();
    const r = await p;
    expect(getPlayState()).toBe('playing');
    expect(r.physicsError).toBeUndefined();
  });

  it('play from PAUSED: a Stop during the wait is not turned into a full Play', async () => {
    setPlayState('paused');
    const p = runAgentOp('play') as Promise<Reply>;
    await settle();
    setPlayState('stopped');
    rapier.release!();
    const r = await p;
    expect(r.ok).toBe(false);
    expect(getPlayState()).toBe('stopped');
  });

  it('play from PAUSED: a permanent init failure is refused like resume — the world stays paused', async () => {
    rapier.mode = 'fail';
    setPlayState('paused');
    const r = await runAgentOp('play') as Reply;
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/play refused — physics failed to initialize.*wasm instantiate failed/);
    expect(getPlayState()).toBe('paused');
  });

  it('play: a healthy load reports no physicsError', async () => {
    setPlayState('stopped');
    const p = runAgentOp('play') as Promise<Reply>;
    await settle();
    rapier.release?.();
    const r = await p;
    expect(getPlayState()).toBe('playing');
    expect(r.physicsError).toBeUndefined();
  });

  it('resume: a permanent init failure is refused and the world stays paused', async () => {
    rapier.mode = 'fail';
    setPlayState('paused');
    const r = await runAgentOp('resume') as Reply;
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/resume refused — physics failed to initialize/);
    expect(getPlayState()).toBe('paused');
  });
});

describe('sim-step — waits inside its own budget', () => {
  beforeEach(() => { setTimeScale(getCurrentWorld(), 0); });

  it('a load that lands within the budget is waited for, then the step proceeds', async () => {
    const p = runAgentOp('sim-step', { frames: 1, timeoutMs: 400 }) as Promise<Reply>;
    await settle();
    expect(rapier.release, 'premise: sim-step is waiting on the load').not.toBeNull();
    rapier.release!();
    const r = await p;
    // Headless has no rAF loop, so a PROCEEDING step ends on the frame-loop timeout — not a physics refusal.
    expect(r.physicsLoading).toBeUndefined();
    expect(r.error).toMatch(/frame loop/i);
    expect(getTimeScale(getCurrentWorld())).toBe(0);
  });

  it('a load that outlasts the budget is refused with physicsLoading, world still frozen', async () => {
    const r = await runAgentOp('sim-step', { frames: 1, timeoutMs: 120 }) as Reply;
    expect(r.ok).toBe(false);
    expect(r.physicsLoading).toEqual(['physics2D']);
    expect(getTimeScale(getCurrentWorld())).toBe(0);
  });

  it('the frames get only what the physics wait LEFT of the budget — the host deadline derives from timeoutMs', async () => {
    const p = runAgentOp('sim-step', { frames: 1, timeoutMs: 600 }) as Promise<Reply>;
    await new Promise((r) => setTimeout(r, 350));
    rapier.release!();
    const r = await p;
    const ms = Number(/within (\d+)ms/.exec(r.error ?? '')?.[1]);
    expect(r.error, 'premise: the step proceeded to the frame-loop timeout').toMatch(/frame loop/i);
    expect(ms).toBeGreaterThanOrEqual(100);
    expect(ms).toBeLessThanOrEqual(600 - 300);
  });

  it('a world resumed DURING the wait is refused, not silently re-frozen', async () => {
    const world = getCurrentWorld();
    const p = runAgentOp('sim-step', { frames: 1, timeoutMs: 600 }) as Promise<Reply>;
    await settle();
    setTimeScale(world, 1);            // device_set_timescale {scale:1} lands mid-load
    rapier.release!();
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/PAUSED world — timeScale became 1/);
    expect(getTimeScale(world), 'the resume stands').toBe(1);
  });

  it('two concurrent sim-steps during a load: exactly one steps, the other is refused', async () => {
    const a = runAgentOp('sim-step', { frames: 1, timeoutMs: 300 }) as Promise<Reply>;
    const b = runAgentOp('sim-step', { frames: 1, timeoutMs: 300 }) as Promise<Reply>;
    await settle();
    rapier.release!();
    const replies = await Promise.all([a, b]);
    const refusedPaused = replies.filter((r) => /PAUSED world/.test(r.error ?? ''));
    const proceeded = replies.filter((r) => /frame loop/i.test(r.error ?? ''));
    expect(refusedPaused).toHaveLength(1);
    expect(proceeded).toHaveLength(1);
  });

  it('a world REPLACED during the wait is reported, and the old world is never unfrozen', async () => {
    const old = getCurrentWorld();
    const p = runAgentOp('sim-step', { frames: 1, timeoutMs: 600 }) as Promise<Reply>;
    await settle();
    const next = createWorld();
    setCurrentWorld(next);             // a scene load swapped the world mid-fetch
    rapier.release!();
    const r = await p as Reply & { worldReplaced?: boolean; stepped?: number };
    expect(r.ok).toBe(false);
    expect(r.worldReplaced).toBe(true);
    expect(r.stepped).toBe(0);
    // Stepping on would setTimeScale(old, 1) and then — seeing the swap — touch it no further, leaving
    // the replaced world RUNNING (or throwing, if the swap had destroyed it). The branch never unfreezes it.
    expect(getTimeScale(old)).toBe(0);
    setCurrentWorld(old); next.destroy();
  });

  it('a PERMANENT failure is named as one — not "still loading, retry" forever', async () => {
    rapier.mode = 'fail';
    const r = await runAgentOp('sim-step', { frames: 1, timeoutMs: 1000 }) as Reply;
    expect(r.ok).toBe(false);
    expect(r.physicsLoading).toBeUndefined();
    expect(r.error).toMatch(/physics failed to initialize.*wasm instantiate failed/);
  });
});
