/**
 * A session anchor between a trusted server time and a monotonic clock.
 *
 * Pure: no PlayerPrefs, no network, no ECS. **The GAME owns fetching the server time and
 * persisting anything derived from an anchor; this module only does the arithmetic**, which is
 * what makes it testable without a plugin. `games/court/runtime/systems.ts` is the worked
 * example — `refreshTrustedClock` there anchors from `@court/app-services` and is the shape to
 * copy.
 *
 * ## Why an ANCHOR, not just a stored floor
 *
 * A high-water-mark floor (`Math.max(deviceNow, storedFloor)`) only defends the BACKWARDS
 * direction: wind the device clock forward once and `deviceNow` wins the max forever, and the
 * inflated value gets stored as the new floor besides — permanently poisoning it, cloud-replicated.
 * An anchor fixes both directions because it never reads the device wall clock again once set: it
 * remembers a real server time and a `performance.now()` reading taken in the same instant, and
 * every later "now" is that server time plus however much monotonic time has actually elapsed.
 *
 * ⚠️ **The monotonic reading is what makes this work, and that is the entire point of this file.**
 * `performance.now()` is a count of elapsed time since the page loaded — it has no notion of "wall
 * clock" and is therefore unaffected by a player winding their device's date forward or backward
 * mid-session. `trustedNow()` therefore cannot be moved by a clock change after the anchor is set,
 * which is exactly the property a device-clock floor cannot offer.
 *
 * ## Two sources, NOT equally trustworthy
 *
 * A caller can anchor from either — Court, the worked example, uses `@court/app-services`'s
 * `auth.getServerTimeMs` (an ID token's `issuedAtTime` — Google-SIGNED, unforgeable by the device,
 * but needs a signed-in user) or its
 * `serverTime.getDateHeaderTimeMs` (an HTTPS response's plain `Date` header — needs no sign-in, but
 * is only as trustworthy as the network path). `source` records which one produced the current
 * anchor so a caller — and the journal — can tell them apart; it is bookkeeping only, the
 * arithmetic below treats both identically once anchored.
 */

/** Which trusted-time source produced the current anchor. `'id-token'` is the STRONG source
 *  (Google-signed); `'date-header'` is the weaker unauthenticated fallback for a player who has
 *  never signed in. See this module's own banner. */
export type TrustedClockSource = 'id-token' | 'date-header';

interface Anchor {
  /** Server-supplied wall-clock ms at the moment the anchor was taken. */
  serverMs: number;
  /** `performance.now()`-style monotonic ms at that same moment. */
  monotonicMs: number;
  /** Which source supplied `serverMs` — see `TrustedClockSource`. */
  source: TrustedClockSource;
}

let _anchor: Anchor | null = null;

/** Record a trusted server time and the monotonic reading taken at the same instant. Rejects a
 *  non-finite or non-positive `serverMs` — a bad value here would poison every `trustedNow()` call
 *  for the rest of the session, so this is the one place to refuse it.
 *
 *  ⚠️ **Never downgrades an `'id-token'` anchor to a `'date-header'` one (close-out finding F).**
 *  `refreshTrustedClock`'s (Court's, see above) own before-the-await `hasTrustedAnchor()` check races: two concurrent
 *  calls (a boot fetch and a grant-time re-fetch, say) can both pass it before either has written
 *  an anchor, and whichever `setTrustedAnchor` call lands LAST wins unconditionally — so a slow
 *  `date-header` reply from one call can overwrite a fast, STRONGER `id-token` anchor the other
 *  call already set, silently downgrading a Google-signed anchor to one that only trusts the
 *  network path. `refreshTrustedClock`'s own re-check after each await closes the common case;
 *  this is the second, structural half — the source ordering is an invariant of the ANCHOR itself,
 *  not something every caller must get right. `'id-token'` overwriting `'id-token'` (a second
 *  strong anchor landing after the first) is still allowed — only a downgrade is refused.
 *
 *  ⚠️ The mirror image matters just as much: a `'date-header'` -> `'id-token'` UPGRADE is always
 *  allowed, including after an anchor already exists. `refreshTrustedClock`'s own re-check before
 *  writing an id-token anchor must gate on `trustedAnchorSource() !== 'id-token'`, never on
 *  `!hasTrustedAnchor()` — the latter would refuse this exact upgrade once anything has anchored,
 *  silently keeping a weaker anchor and, with it, blocking the durable floor write that is gated on
 *  `source === 'id-token'`. That was a real regression (close-out review, 2026-08-30), fixed at the
 *  call site — this function's own guard on line below was never the bug. */
export function setTrustedAnchor(serverMs: number, monotonicMs: number, source: TrustedClockSource): void {
  if (!Number.isFinite(serverMs) || serverMs <= 0) return;
  if (!Number.isFinite(monotonicMs)) return;
  if (_anchor !== null && _anchor.source === 'id-token' && source === 'date-header') return;
  _anchor = { serverMs, monotonicMs, source };
}

/** The trusted wall-clock "now", derived from the anchor plus elapsed monotonic time — or `null`
 *  when no anchor has been set this session. Never reads the device wall clock. */
export function trustedNow(monotonicMs: number): number | null {
  if (_anchor === null) return null;
  return _anchor.serverMs + (monotonicMs - _anchor.monotonicMs);
}

/** True once `setTrustedAnchor` has recorded an anchor this session. */
export function hasTrustedAnchor(): boolean {
  return _anchor !== null;
}

/** Which source produced the current anchor, or `null` when there is none — for the boot/grant
 *  journal line, so a device tells us which arm a player is actually on. */
export function trustedAnchorSource(): TrustedClockSource | null {
  return _anchor?.source ?? null;
}

/** Test/teardown seam — clears the session anchor. */
export function clearTrustedAnchor(): void {
  _anchor = null;
}
