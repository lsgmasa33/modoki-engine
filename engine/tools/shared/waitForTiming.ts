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
