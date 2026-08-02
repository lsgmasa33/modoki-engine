/** The `modoki` scripting object injected into editor `modoki_eval` code (see bridgeHelpers.ts
 *  handleEval). Generated from the live agent-op registry so it cannot drift from the real
 *  op set — a new registerAgentOp() call is automatically callable from eval with no code
 *  change here. Built once per eval call (op registry is static after editor startup, but this
 *  stays cheap and always current rather than caching).
 *
 *  Every call funnels through withEditorActor('agent', ...) — belt-and-suspenders with the
 *  ambient actor the outer `eval` op registration already sets for the whole eval, but a
 *  fire-and-forget (unwaited) call inside eval's code would otherwise race the ambient reset,
 *  so each individual call brackets itself explicitly. Wrapping is applied uniformly to every
 *  op (not just "mutating" ones) — matching agentEditorOps.ts's own registerAgentOp shadow,
 *  whose comment notes reads are inert to wrap, and avoiding a hand-maintained mutating/
 *  non-mutating list that could itself drift. */

import { listAgentOps, runAgentOp } from '../debug/agentBridge';
import { backendFetch, withEditorActor, runAsCompositeAction } from '@modoki/engine/editor';
import { kebabToCamel } from '../debug/bridgeHelpers';

/** Re-exported for anything still importing it from here (moved to bridgeHelpers.ts in #83 so
 *  device's deviceEvalApi.ts can share it without duplicating it). */
export { kebabToCamel };

export interface EvalApi {
  call(op: string, params?: unknown): Promise<unknown>;
  ops(): Array<{ op: string; method: string }>;
  api(path: string, init?: RequestInit): Promise<Response>;
  composite<T>(label: string, fn: () => T | Promise<T>): Promise<T>;
  [generatedMethod: string]: unknown;
}

/** Ops that OBSERVE or MANAGE attribution, and so must not themselves be attributed.
 *
 *  withEditorActor holds the ambient actor for the whole lifetime of an async handler ("the
 *  window spans the await" — see its own doc). That is a narrow accepted race for a brief op.
 *  It is fatal for one that deliberately PARKS: `wait-for-edit` waits for a source:'human'
 *  event, so bracketing it as 'agent' tags the very edit it is waiting for as 'agent', the
 *  filter never matches, and the wait can only time out. Measured — this deadlock was real
 *  before this list existed (regression test in tests/editor/evalApi.test.ts).
 *
 *  Same reasoning as agentEditorOps.ts, which registers these two via the UNWRAPPED
 *  _registerAgentOp for exactly this reason. Keep the two lists in agreement. */
const ATTRIBUTION_OPS = new Set(['wait-for-edit', 'actor-lease']);

export function makeEvalApi(): EvalApi {
  const call = (op: string, params?: unknown): Promise<unknown> =>
    ATTRIBUTION_OPS.has(op)
      ? Promise.resolve(runAgentOp(op, params))
      : withEditorActor('agent', () => runAgentOp(op, params));

  const opNames = listAgentOps();
  const api: Record<string, unknown> = {
    call,
    ops: () => opNames.map((op) => ({ op, method: `modoki.${kebabToCamel(op)}(params)` })),
    api: (path: string, init?: RequestInit) => backendFetch(path, init),
    composite: <T,>(label: string, fn: () => T | Promise<T>) => runAsCompositeAction({ label }, fn),
  };
  for (const op of opNames) {
    const method = kebabToCamel(op);
    if (!(method in api)) api[method] = (params?: unknown) => call(op, params);
  }
  return api as EvalApi;
}
