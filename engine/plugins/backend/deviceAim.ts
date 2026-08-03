/**
 * The bits every TRUSTED device-input route shares, regardless of transport (#32).
 *
 * Extracted from `deviceCdp.ts` when the iOS/WebDriverAgent route (Phase 2) arrived, because both
 * routes have to resolve an aim the SAME way: the host can dispatch at coordinates but cannot
 * resolve a CSS selector or an entity — only the page can, via its `resolve-aim` op. Duplicating
 * that decode per transport would put the exact seam that made Phase 1 dead-on-arrival in two
 * places, free to drift apart. One decode, one set of failure meanings, both routes.
 */

/** The outcome of trying to route ONE input op through a trusted path.
 *
 *  `handled` carries the reply to return verbatim (a trusted success, or a refusal the trusted path
 *  legitimately produced). `!handled` means the caller should run the SYNTHETIC path — and `reason`
 *  is why, so the caller can say it OUT LOUD rather than leaving a ` [input:synthetic]` suffix at
 *  the end of a long line to be skimmed past. `reason: null` means "not an input op" — nothing to
 *  warn about. */
export type RouteOutcome =
  | { handled: true; reply: string }
  | { handled: false; reason: string | null };

/** The app is too old to participate: trusted input resolves aim through the page's `resolve-aim`
 *  op, which only exists in builds from #32 Phase 1 onward. Measured on the Samsung — this is the
 *  common case right after a plugin/engine change, and the fix is a rebuild, so say so. */
export const STALE_APP_REASON =
  'the app installed on the device predates trusted input (its debug bridge has no `resolve-aim` op) '
  + '— rebuild and reinstall it to get trusted input';

/** Does this device reply signal FAILURE?
 *
 *  The bridge never throws across the transport — a failed handler RETURNS `Error: …`, and an
 *  unrouted method returns `Unknown method: …`, both of which arrive as an ordinary successful
 *  reply. Encoded here (backend-side) for the same reason `isDeviceError` encodes it in the MCP
 *  package: they are separate module graphs, so the convention is duplicated rather than imported —
 *  but it must be stated identically in both. Callers that treat a reply as data without this check
 *  report an error string as their result. */
export function isDeviceFailureReply(raw: unknown): raw is string {
  return typeof raw === 'string' && (raw.startsWith('Error:') || raw.startsWith('Unknown method:'));
}

/** What an aim resolution needs from the caller: the device-lease proxy to reach the page. */
export interface AimProxyDeps {
  proxy(method: string, params: Record<string, unknown>): Promise<unknown>;
}

/** The device bridge answers over a TCP/JSON transport, so a handler that returns an OBJECT arrives
 *  here as a JSON **string** — and a handler that FAILED arrives as a bare string too (the bridge
 *  signals failure by RETURNING `Error: …` / `Unknown method: …`, never by throwing; same
 *  convention `isDeviceError` encodes on the MCP side). Both have to be decoded here.
 *
 *  This is the seam that made Phase 1 dead on arrival, and no unit test could see it: the routing
 *  tests mocked `proxy` as returning `{x, y, label}` — an object — while the real transport returns
 *  `'{"x":180,"y":353,…}'`. `'error' in aim` then ran the `in` operator on a primitive string,
 *  which THROWS `TypeError`, so every trusted dispatch fell into the catch, reset the session and
 *  silently fell back to synthetic. Measured on the Samsung 2026-08-02: `device_status` claimed
 *  `trusted-cdp` while every tap came back `[input:synthetic]`. Mock drift, caught only on device.
 *  Any test that fakes `proxy` MUST return a string. */
export type AimOutcome =
  | { kind: 'aim'; aim: { x: number; y: number; label: string } }
  | { kind: 'refusal'; error: string }   // the page resolved nothing — a real refusal, report it
  | { kind: 'unsupported' };             // an app build predating `resolve-aim` — fall back quietly

export function decodeAimReply(raw: unknown): AimOutcome {
  let v = raw;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { /* not JSON — a bare device-convention string, below */ }
  }
  if (typeof v === 'string') {
    // An older app build has no `resolve-aim` handler; the trusted route cannot work against it,
    // but synthetic still can — so this is "fall back", not "refuse".
    if (v.startsWith('Unknown method:')) return { kind: 'unsupported' };
    return { kind: 'refusal', error: v };
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.error === 'string') return { kind: 'refusal', error: o.error };
    if (typeof o.x === 'number' && typeof o.y === 'number') {
      return { kind: 'aim', aim: { x: o.x, y: o.y, label: String(o.label ?? `css(${Math.round(o.x)},${Math.round(o.y)})`) } };
    }
  }
  // An unrecognised shape must not be guessed at — treat it as "no trusted route" so the caller
  // falls back to a path that is known to work, rather than dispatching at coordinates we invented.
  return { kind: 'unsupported' };
}

/** Ask the PAGE to resolve an aim (selector / entity / screenshot pixels) to a CSS viewport point.
 *  `selKey`/`xKey`/`yKey` name the params, so a drag's two ends reuse the same call. */
export async function resolveAimViaDevice(
  deps: AimProxyDeps,
  params: Record<string, unknown>,
  selKey: string,
  xKey: string,
  yKey: string,
  center = false,
): Promise<AimOutcome> {
  const raw = await deps.proxy('resolve-aim', { ...params, selKey, xKey, yKey, ...(center ? { center: true } : {}) });
  return decodeAimReply(raw);
}
