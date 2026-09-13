/** The editor agent `step` op waits for physics before it ticks (#1175).
 *
 *  Observed on a cold editor: Play → pause → step×5 reported success with NO physics in those
 *  ticks — Rapier's WASM was still loading and the physics system skips a tick until it lands. The
 *  scene LOAD now awaits it, but a body added after load (an agent `create_entity`) reaches the
 *  step op still cold, so the op awaits it too.
 *
 *  What is asserted is the thing that went wrong: the frame the step RUNS sees Rapier instantiated.
 *  A frame callback records readiness at frame time — reading it after the op returns could not
 *  tell "awaited, then stepped" from "stepped, then the load happened to land".
 *
 *  Own file: the loader is process-global, and this must start with Rapier NOT instantiated. */

import { describe, it, expect, afterEach } from 'vitest';
import { runAgentOp } from '../../app/debug/agentBridge';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import {
  createTestWorld, type TestWorld, RigidBody2D, isRapierReady, setPlayState, getPlayState,
  registerFrameCallback, unregisterFrameCallback,
} from '@modoki/engine/runtime';

registerEditorAgentOps();

let game: TestWorld | undefined;
afterEach(() => {
  unregisterFrameCallback('__test-physics-ready-probe');
  setPlayState('stopped');
  game?.dispose(); game = undefined;
});

describe('editor step op — physics readiness', () => {
  it('a body added after load: the stepped frame already has Rapier2D instantiated', async () => {
    game = createTestWorld({});
    game.spawn(RigidBody2D());
    setPlayState('paused');
    expect(isRapierReady(), 'premise: Rapier starts cold in this file').toBe(false);

    const readyAtFrame: boolean[] = [];
    registerFrameCallback('__test-physics-ready-probe', () => { readyAtFrame.push(isRapierReady()); }, 100);

    const r = await runAgentOp('step') as { ok?: boolean; error?: string; playState?: string };

    expect(r.ok, r.error).not.toBe(false);
    expect(readyAtFrame).toEqual([true]);
    expect(getPlayState()).toBe('paused');
  });
});
