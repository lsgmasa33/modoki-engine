/** The `modoki` scripting object injected into DEVICE `device_eval` code (#83) — the device twin
 *  of `../editor/evalApi.ts`. Generated from the live agent-op registry so it cannot drift from
 *  the real op set — a new `registerAgentOp()` call is automatically callable from eval with no
 *  code change here.
 *
 *  Deliberately NARROWER than the editor's `EvalApi`: no `api()` (there is no editor backend to
 *  fetch on device — every op already funnels through the device lease) and no `composite()`
 *  (there is no undo stack on device). See issue #83 for why cargo-culting those would be
 *  inventing a need rather than meeting one.
 *
 *  Module identity matters here (#19's trap): the device's own op proxying
 *  (`bridge.ts`'s `getRunAgentOp()`) reaches the registry via a DYNAMIC `import('./agentBridge')`
 *  so the ops chunk stays code-split out of the main bundle. This file uses the SAME dynamic
 *  import for the same reason — a static import here would defeat that code-splitting. */

import { kebabToCamel } from './bridgeHelpers';

export interface DeviceEvalApi {
  call(op: string, params?: unknown): Promise<unknown>;
  ops(): Array<{ op: string; method: string }>;
  [generatedMethod: string]: unknown;
}

export async function makeDeviceEvalApi(): Promise<DeviceEvalApi> {
  const { listAgentOps, runAgentOp } = await import('./agentBridge');

  const call = (op: string, params?: unknown): Promise<unknown> => runAgentOp(op, params);

  const opNames = listAgentOps();
  const api: Record<string, unknown> = {
    call,
    ops: () => opNames.map((op) => ({ op, method: `modoki.${kebabToCamel(op)}(params)` })),
  };
  for (const op of opNames) {
    const method = kebabToCamel(op);
    if (!(method in api)) api[method] = (params?: unknown) => call(op, params);
  }
  return api as DeviceEvalApi;
}
