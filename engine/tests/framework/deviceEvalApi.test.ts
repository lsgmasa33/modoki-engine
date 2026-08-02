/** The `modoki` scripting object injected into DEVICE `device_eval` code (#83) — the device twin
 *  of `engine/tests/editor/evalApi.test.ts`. Proves GENERATION (a throwaway op registered in the
 *  test shows up), not a hardcoded op list, and proves the device surface is deliberately
 *  NARROWER than the editor's (no `api`/`composite`). */

import { describe, it, expect } from 'vitest';
import { registerAgentOp, listAgentOps } from '../../app/debug/agentBridge';
import { kebabToCamel } from '../../app/debug/bridgeHelpers';
import { makeDeviceEvalApi } from '../../app/debug/deviceEvalApi';

describe('kebabToCamel (shared, bridgeHelpers)', () => {
  it('maps a real op name to its camelCase method name', () => {
    expect(kebabToCamel('layout-bounds')).toBe('layoutBounds');
    expect(kebabToCamel('set-timescale')).toBe('setTimescale');
  });
  it('is a no-op on a name with no hyphen', () => {
    expect(kebabToCamel('diagnose')).toBe('diagnose');
  });
});

describe('makeDeviceEvalApi().ops()', () => {
  it('lists every currently-registered op, including one just registered in this test', async () => {
    registerAgentOp('probe-device-eval-api-op', () => 42);
    const api = await makeDeviceEvalApi();
    const names = api.ops().map((o) => o.op);
    for (const op of listAgentOps()) expect(names).toContain(op);
    const entry = api.ops().find((o) => o.op === 'probe-device-eval-api-op');
    expect(entry?.method).toBe('modoki.probeDeviceEvalApiOp(params)');
  });
});

describe('makeDeviceEvalApi().call / generated methods', () => {
  it('call(op, params) invokes the registered handler with those params and returns its result', async () => {
    const handler = (params: unknown) => ({ echoed: params });
    registerAgentOp('probe-device-eval-api-call', handler);
    const api = await makeDeviceEvalApi();
    const result = await api.call('probe-device-eval-api-call', { x: 1 });
    expect(result).toEqual({ echoed: { x: 1 } });
  });

  it('a generated camelCase method calls through to the SAME op as .call(...)', async () => {
    const handler = (params: unknown) => ({ via: 'generated', params });
    registerAgentOp('probe-device-generated-method', handler);
    const api = await makeDeviceEvalApi();
    const result = await (api.probeDeviceGeneratedMethod as (p?: unknown) => Promise<unknown>)({ y: 2 });
    expect(result).toEqual({ via: 'generated', params: { y: 2 } });
  });
});

describe('makeDeviceEvalApi() is narrower than the editor EvalApi', () => {
  it('has no api() or composite() — device has no editor backend and no undo stack (#83)', async () => {
    const api = await makeDeviceEvalApi();
    expect((api as Record<string, unknown>).api).toBeUndefined();
    expect((api as Record<string, unknown>).composite).toBeUndefined();
  });
});
