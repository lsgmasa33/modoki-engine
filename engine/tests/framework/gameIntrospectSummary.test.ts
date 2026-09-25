/** #1557 — `modoki_list_actions` / `device_introspect` (the one `game-introspect` op) are summary-first:
 *  a bare call answers action NAMES, and `name=<substr>` buys the `{name, params}` detail rows. Every
 *  row used to carry its param schema, `null` for nearly all of them — a median 5.7k chars per call. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { registerUIAction, unregisterUIAction } from '@modoki/engine/runtime';
import { runAgentOp } from '../../app/debug/agentBridge';

const WITH_PARAMS = 'probe1557.pick';
const BARE = 'probe1557.close';

beforeAll(() => {
  registerUIAction(WITH_PARAMS, { handler: () => {}, params: { slot: { type: 'number' } } });
  registerUIAction(BARE, () => {});
});
afterAll(() => { unregisterUIAction(WITH_PARAMS); unregisterUIAction(BARE); });

type Introspect = {
  actions: Array<string | { name: string; params: unknown }>;
  actionCount?: number; returnedCount?: number; totalCount?: number; hint?: string; readValues: unknown[];
};

describe('game-introspect is summary-first (#1557)', () => {
  it('a bare call answers names only, with a hint naming the drill-down', async () => {
    const r = await runAgentOp('game-introspect', {}) as Introspect;
    expect(r.actions).toEqual(expect.arrayContaining([WITH_PARAMS, BARE]));
    expect(r.actions.every((a) => typeof a === 'string')).toBe(true);
    expect(r.actionCount).toBe(r.actions.length);
    expect(r.hint).toMatch(/name=<substr>/);
    expect(Array.isArray(r.readValues)).toBe(true);
  });

  it('name= returns the case-insensitive matches with their param schemas', async () => {
    const r = await runAgentOp('game-introspect', { name: 'PROBE1557' }) as Introspect;
    expect(r.actions).toEqual([
      { name: WITH_PARAMS, params: { slot: { type: 'number' } } },
      { name: BARE, params: null },
    ]);
    expect(r.returnedCount).toBe(2);
    expect(r.totalCount).toBe(2);
    expect(r.hint).toBeUndefined();
  });

  it('a name that matches nothing says so and names the closest live action', async () => {
    const r = await runAgentOp('game-introspect', { name: 'probe1557.pik' }) as Introspect;
    expect(r.actions).toEqual([]);
    expect(r.hint).toMatch(/no action matches name=probe1557\.pik, but [1-9]\d* exist/);
    expect(r.hint).toContain(WITH_PARAMS);
  });
});
