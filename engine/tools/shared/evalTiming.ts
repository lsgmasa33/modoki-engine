/** The eval op's time budget (#1962), shared by the op (`app/debug/bridgeHelpers.ts` re-exports it), the
 *  editor backend's `/api/eval` relay and the MCP client — the `waitForTiming.ts` pattern. Each outer layer
 *  sizes its own deadline as `clampEvalTimeout(...) + headroom`; restating the clamp is what let the relay
 *  read `timeoutMs:"20000"` as the 5s default while the op ran for 20s, so a 16s eval answered 504. */

/** Default bound on how long an eval body is awaited before the bridge gives up and reports a
 *  timeout — without this, a hung/never-resolving promise would wedge the eval indefinitely
 *  instead of surfacing an error. Overridable per call (see `clampEvalTimeout`).
 *
 *  ⚠️ **This number was UNREACHABLE on both surfaces until it became overridable**, because each
 *  transport carries its own, shorter deadline and wins the race — so the caller got a generic
 *  transport error where this one would have said "code returned a Promise that never resolved":
 *  - **editor**: the backend→renderer HMR relay defaults to **3000ms** (`requestBrowser` in
 *    `vite-asset-scanner.ts`) — strictly less than this, so 3s was the real editor budget.
 *  - **device**: `TcpLeaseTransport`'s `REQUEST_TIMEOUT_MS` is **5000ms** (`deviceConnection.ts`)
 *    and its clock starts EARLIER (host-side, before the request reaches the device), so an equal
 *    5000 here always lost.
 *  Both callers now size their transport deadline from the requested eval budget — see
 *  `EDITOR_EVAL_MAX_TIMEOUT_MS` / `DEVICE_EVAL_MAX_TIMEOUT_MS` for the ceilings and why they differ. */
export const EVAL_ASYNC_TIMEOUT_MS = 5000;

/** Editor ceiling. The relay and the MCP client both take an explicit timeout, so the only real
 *  constraint is that each outer layer stays strictly larger: op ≤ 25s → relay op+10s → client
 *  op+15s, all under nothing in particular. Generous on purpose: an editor eval legitimately
 *  parks (`modoki.waitForEdit()`), and the old effective 3s made that impossible. */
export const EDITOR_EVAL_MAX_TIMEOUT_MS = 25_000;

/** Device ceiling. This used to be **4500, imposed from outside this file**: `TcpLeaseTransport`
 *  fixed its request deadline at 5000ms PER CONNECTION (`request()` took no timeout), so anything
 *  at or above that was fiction — the host gave up first and reported `device request timed out
 *  after 5000ms` instead of the eval's own, far more useful message, and 4500 was a workaround
 *  leaving ~500ms for the reply to travel back.
 *
 *  #153 plumbed a PER-REQUEST deadline through that transport, and `/api/device/request` now sizes
 *  it from this op's own budget + 5s of headroom, so the innermost timeout is the one that fires.
 *  Kept strictly BELOW `EDITOR_EVAL_MAX_TIMEOUT_MS` rather than raised to meet it: the device pays
 *  a real network hop the editor does not, so its op budget should always leave more room under
 *  the outer deadlines than the editor's does. That ordering is asserted in `bridge.test.ts`. */
export const DEVICE_EVAL_MAX_TIMEOUT_MS = 20_000;
/** Device default. Left at 4000 — below the transport's 5000 CONNECTION default, so an eval that
 *  does not ask for a budget still gets its own timeout message rather than a transport one. Only
 *  a caller that names `timeoutMs` lifts the transport deadline with it (#153). */
export const DEVICE_EVAL_TIMEOUT_MS = 4000;

/** Clamp a caller-supplied eval budget into `[50, max]`, falling back to `def` for anything
 *  absent or non-finite. CLAMPS rather than refuses — an over-cap request is a reasonable ask
 *  against a limit the caller cannot see, and the timeout message names the budget actually
 *  used, so the clamp is never silent when it matters. */
export function clampEvalTimeout(requested: unknown, def: number, max: number): number {
  const n = typeof requested === 'number' ? requested : Number(requested);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.max(50, Math.min(max, Math.floor(n)));
}

/** What the backend relay adds over the op's own budget (`/api/eval`): it crosses the HMR websocket. */
export const EVAL_RELAY_HEADROOM_MS = 10_000;
/** What the MCP client adds over the op's own budget — strictly more than the relay's, so the relay fires first. */
export const EVAL_CLIENT_HEADROOM_MS = 15_000;
