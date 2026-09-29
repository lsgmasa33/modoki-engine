/** The ONE rule for whether a backend reply body says the operation did not happen (#1824, R2 of
 *  `docs/refusal-reporting.md`).
 *
 *  Both halves ask it: the editor client's reader (`readBackendAnswer`, `editorBackend.ts`) and the agent side's
 *  `isFailureBody` (`engine/tools/shared/errorCodes.ts`, which the MCP servers and the device-shipped `agentBridge`
 *  import). `@modoki/engine` cannot import `tools/shared` — its build is rooted at `packages/modoki/src` — so the
 *  definition lives HERE and `errorCodes.ts` imports it, rather than two copies drifting apart.
 *
 *  ⚠️ **Keep this file import-free.** `errorCodes.ts` is value-imported by the MCP bundles and by `agentBridge`, which
 *  ships to devices; an import here reaches all three. `failureBodyIsALeaf.test.ts` fails on one. */

/** The detail a failure body states, or null when the body claims no failure.
 *
 *  `ok` is a success FLAG on a mutating route, never an answer, so:
 *  - an EXPLICIT `ok:true` wins over a non-empty `errors[]` — it is the route's own verdict, and `/api/reimport`
 *    answers a partial success as `{ok:true, errors}` (a 20-of-21 bake is not a failed call);
 *  - otherwise `ok:false`, a non-empty `errors[]`, or a non-empty `error` is a failure.
 *
 *  The detail is the `errors` joined, else `error`, else `reason` (the journal/watch capture ops answer a refusal as
 *  `{ok:false, reason}`), else a fixed sentence — never empty.
 *
 *  ⚠️ A READ whose `ok:false` IS the answer (`diagnose`, `validate_scene`, `/api/validate-prefab`) must not be passed
 *  through this: that turns an honest negative answer into a refusal. The agent side opts a call in (`getJson`'s
 *  `checkFailure`); the client reader takes `verdict:'status'` for such a read. */
export function failureDetail(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as { ok?: unknown; errors?: unknown; error?: unknown; reason?: unknown };
  if (b.ok === true) return null;
  const errors = Array.isArray(b.errors) ? b.errors.filter((e): e is string => typeof e === 'string') : [];
  const hasError = typeof b.error === 'string' && b.error !== '';
  const hasReason = typeof b.reason === 'string' && b.reason !== '';
  if (b.ok !== false && errors.length === 0 && !hasError) return null;
  return errors.length ? errors.join('; ')
    : hasError ? (b.error as string)
      : hasReason ? (b.reason as string)
        : 'the operation reported ok:false';
}
