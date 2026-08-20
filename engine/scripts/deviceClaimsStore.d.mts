/** Type sidecar for `deviceClaimsStore.mjs` — see that file for the design rationale.
 *  Hand-written because the module is plain JS (a standalone Node CLI script — the #285 claim
 *  guard — needs to import it directly and cannot import TypeScript), but
 *  `engine/plugins/backend/deviceClaims.ts` imports it and is typechecked normally, and both
 *  `.mjs` files here follow the same pattern as `projectRoots.mjs` / `projectRoots.d.mts`. */

/** A device id is namespaced by HOW the device is addressed — `adb:<serial>`, `ios:<udid>`, or
 *  `ip:<host>`. See the `.mjs` header for why the namespaces are kept apart. */
export type DeviceId = string;

/** Who holds a device, and enough to find them. */
export interface DeviceClaim {
  deviceId: DeviceId;
  /** Absolute path of the claiming clone — the thing that identifies WHICH checkout, since branch
   *  alone repeats across machines and pid alone says nothing about where to go look. */
  clone: string;
  branch: string;
  /** The claiming process's pid — or `0` for a CLI-owned claim (`owner` set), which has no live
   *  process to check by the time anyone reads it. */
  pid: number;
  /** The lease GUID this claim belongs to, when it was taken by a lease. Lets a reader see that the
   *  claim and the socket lease are the same holder rather than two mechanisms that agree by luck. */
  guid?: string;
  /** Epoch ms. Formatted only at the point a human reads it — a stored ISO string would invite
   *  string comparison for the TTL. */
  at: number;
  label?: string;
  /** What the holder is doing: a held lease, a WDA launch, an install. Purely for the message —
   *  "holding a device lease" and "installing a build" call for different patience. */
  purpose?: string;
  /** (#285) A stable token identifying a holder that is NOT a live process — a CLI script's claim.
   *  Written only by the CLI path. When set, staleness is judged purely by TTL (`ttlMs` or
   *  `CLI_CLAIM_TTL_MS`), never by process liveness, and `pid` is written as `0`. */
  owner?: string;
  /** (#285) A per-claim TTL override in ms, consulted only when `owner` is set (falls back to
   *  `CLI_CLAIM_TTL_MS`). */
  ttlMs?: number;
  /** (#285) What the phone says it IS — `deviceModel` is a product type (`iPhone18,4`) and
   *  `osVersion` a system version (`26.5.2`), both as reported by the app over the debug bridge.
   *
   *  These exist to narrow the KNOWN GAP in the `.mjs` header: one iPhone can hold two claim ids,
   *  because a WiFi lease can only claim it by ADDRESS (`ip:<host>`) while every raw iOS CLI targets
   *  it by UDID (`ios:<udid>`). Nothing can prove those are the same handset — a UDID is
   *  deliberately not a fact an iOS app is allowed to report (see `deviceHardware`). But a product
   *  type IS reportable AND appears in `xcrun`'s listing, so a reader holding a UDID can look up its
   *  product type and compare. That is a HINT, never a proof: two identical phones report the same
   *  model. Treat a match as "probably the same phone, refuse", a mismatch as "different phone",
   *  and an absent model as "cannot tell" — never as "different". */
  model?: string;
  osVersion?: string;
}

export interface ClaimRequest {
  deviceId: DeviceId;
  clone?: string;
  branch?: string;
  guid?: string;
  label?: string;
  purpose?: string;
  /** (#285) Claim as a CLI-owned holder rather than this process's pid — see `DeviceClaim.owner`. */
  owner?: string;
  /** (#285) Per-claim TTL override — see `DeviceClaim.ttlMs`. */
  ttlMs?: number;
  /** (#285) The phone's own report of itself — see `DeviceClaim.model`. */
  model?: string;
  osVersion?: string;
}

export type ClaimResult =
  | { ok: true; claim: DeviceClaim }
  | { ok: false; held: DeviceClaim; message: string };

export interface StaleOpts {
  now?: number;
  alive?: (pid: number) => boolean;
}

export interface ReleaseOpts extends StaleOpts {
  /** (#285) Release an owner-claim by its token instead of by this process's pid. */
  owner?: string;
}

/** Wall-clock backstop for a pid-claim whose pid check cannot settle it (12h). */
export declare const CLAIM_TTL_MS: number;

/** (#285) TTL for a CLI-owned claim — the ONLY expiry it has (90 min). */
export declare const CLI_CLAIM_TTL_MS: number;

/** Hard ceiling on a per-claim `ttlMs` — see the `.mjs`. */
export declare const MAX_CLAIM_TTL_MS: number;

/** Clamp a requested TTL into `(0, MAX_CLAIM_TTL_MS]`; `undefined` means "use the default". */
export declare function clampTtlMs(ttlMs: number | undefined | null): number | undefined;

export declare function claimsDir(): string;

export declare function adbDeviceId(serial: string): DeviceId;
export declare function iosDeviceId(udid: string): DeviceId;
export declare function wifiDeviceId(host: string): DeviceId;

export declare function isPidAlive(pid: number): boolean;
export declare function isStale(claim: DeviceClaim, opts?: StaleOpts): boolean;

export declare function listClaims(opts?: StaleOpts): DeviceClaim[];
export declare function claimDevice(req: ClaimRequest, opts?: StaleOpts): ClaimResult;
export declare function releaseDevice(deviceId: DeviceId, opts?: ReleaseOpts): void;
export declare function releaseAllForThisProcess(opts?: StaleOpts): void;
export declare function sweepStaleClaims(opts?: StaleOpts): DeviceClaim[];
export declare function describeConflict(held: DeviceClaim, now?: number): string;

export interface ForeignClaimOpts extends StaleOpts {
  /** Which clone counts as "mine" — defaults to `process.cwd()`. Lets a caller (or a test) name the
   *  clone explicitly rather than depending on where the process happens to run. */
  clone?: string;
}

/** (#285 sibling) The live `DeviceClaim` for `deviceId` when it is held by a DIFFERENT clone than
 *  `opts.clone` (default `process.cwd()`), compared as RESOLVED paths — else `null`. The one
 *  implementation of "is this someone else's phone", used by the build path (`vite-asset-scanner.ts`)
 *  and safe for any future caller to reuse rather than re-deriving the comparison. */
export declare function foreignClaimFor(deviceId: DeviceId, opts?: ForeignClaimOpts): DeviceClaim | null;
