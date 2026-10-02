/** `wait_for`'s park budget, shared by the op (`app/debug/waitFor.ts`) and both MCP twins so the
 *  tools' schemas and the op's clamp cannot drift (the #822 lesson `simStepTiming.ts` carries). */

export const WAIT_FOR_DEFAULT_MS = 5_000;
export const WAIT_FOR_MIN_MS = 50;
/** Same ceiling as `wait-for-edit`: long enough for a scene load or a human, short enough that a
 *  wedged renderer does not hold an HTTP request open indefinitely. Call again to keep waiting. */
export const WAIT_FOR_MAX_MS = 120_000;
/** The ceiling on ANY device request's deadline (`deviceConnection.ts`'s `deadlineFor`). */
export const DEVICE_REQUEST_MAX_MS = 60_000;
/** What `/api/device/request` adds to an op's own `timeoutMs` for the round trip (#153). */
export const DEVICE_REQUEST_HEADROOM_MS = 5_000;
/** The DEVICE twin's ceiling (#1559 C-12), DERIVED from the two above: a longer park would outlive
 *  its own transport and read as a dead link. */
export const DEVICE_WAIT_FOR_MAX_MS = DEVICE_REQUEST_MAX_MS - DEVICE_REQUEST_HEADROOM_MS;

/** `wait-for-edit`'s park budget (#28), shared by the op (`agentEditorOps.ts`), the `/api/wait-for-edit` relay
 *  and the MCP tool, each of which sizes its own transport deadline over it (#1962: two of the three restated
 *  the clamp). Default 30s; long enough for a human to look away and make one edit, short enough that a wedged
 *  renderer does not hold an HTTP request open indefinitely (a blocking long-poll, not an SSE stream — see the
 *  #28 brief). A caller that wants to keep watching calls again with the returned `nextSeq`. */
export const WAIT_FOR_EDIT_DEFAULT_MS = 30_000;
export const WAIT_FOR_EDIT_MAX_MS = 120_000;
/** Floor — guards against a 0/negative timeoutMs turning the park into a busy-poll. */
export const WAIT_FOR_EDIT_MIN_MS = 50;

/** The park a `wait-for-edit` call actually gets: a non-finite or absent request is the default, anything else
 *  is clamped into `[MIN, MAX]` (a 0 or negative one to the floor, NOT the default). */
export function clampWaitForEditTimeout(requested: unknown): number {
  const n = typeof requested === 'number' && Number.isFinite(requested) ? requested : WAIT_FOR_EDIT_DEFAULT_MS;
  return Math.max(WAIT_FOR_EDIT_MIN_MS, Math.min(WAIT_FOR_EDIT_MAX_MS, n));
}
