/** #1559 C-12 — `wait-for` is registered by the RUNTIME (`agentBridge.ts`), so the device has it too.
 *  This file deliberately never calls `registerEditorAgentOps()`: what it sees is exactly the op a device
 *  build runs. `entity`/`console` answer; `chrome`/`editor` read the editor and are refused by name,
 *  RETURNED with a code (a thrown refusal would lose its code on the device relay). */

import { describe, it, expect, afterAll } from 'vitest';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { runAgentOp, relayResponseFor } from '../../app/debug/agentBridge';
import { createTestWorld, EntityAttributes, Transform } from '@modoki/engine/runtime';
import { recordConsoleRingEntry } from '@modoki/engine/runtime/core/consoleRing';

registerAllTraits();
const game = createTestWorld({});
afterAll(() => game.dispose());

type Result = { ok?: false; code?: string; error?: string; satisfied?: boolean; timedOut?: boolean; observation?: Record<string, unknown> };

describe('the runtime wait-for op (no editor registered)', () => {
  it('an entity condition is answered', async () => {
    game.spawn(Transform(), EntityAttributes({ name: 'RuntimeWaitee' }));
    const r = await runAgentOp('wait-for', { entity: { name: 'RuntimeWaitee' }, timeoutMs: 50 }) as Result;
    expect(r.satisfied).toBe(true);
  });

  it('a console condition is answered', async () => {
    const p = runAgentOp('wait-for', { console: { match: 'runtime wait probe', level: 'warn' }, timeoutMs: 1000 }) as Promise<Result>;
    recordConsoleRingEntry('error', ['runtime wait probe']);
    expect(await p).toMatchObject({ satisfied: true, observation: { level: 'error' } });
  });

  it.each([
    ['chrome', { chrome: { label: 'Play' } }],
    ['editor', { editor: { playState: 'playing' } }],
  ])('a %s condition is refused by name, returned with its code — not parked', async (kind, cond) => {
    const r = await runAgentOp('wait-for', { ...cond, timeoutMs: 5000 }) as Result;
    expect(r).toMatchObject({ ok: false, code: 'REFUSED_BY_OP' });
    expect(r.error).toMatch(new RegExp(`${kind} conditions read the EDITOR, and this surface has none`));
  });

  // #1559 review: on the HMR relay the first non-DECLINE answer wins (#1030). A page with no editor (a
  // `#/game/<id>` tab) must decline a chrome/editor wait, or its instant refusal beats the editor's park.
  it('on the relay, a page with no editor DECLINES a chrome/editor wait and serves an entity wait', async () => {
    expect(await relayResponseFor({ id: 1, op: 'wait-for', params: { chrome: { label: 'Play' }, timeoutMs: 50 } })).toEqual({ id: 1, declined: true });
    expect(await relayResponseFor({ id: 2, op: 'wait-for', params: { editor: { playState: 'playing' } } })).toEqual({ id: 2, declined: true });
    const served = await relayResponseFor({ id: 3, op: 'wait-for', params: { entity: { name: 'RuntimeWaitee' }, timeoutMs: 50 } });
    expect(served.declined).toBeUndefined();
  });
});
