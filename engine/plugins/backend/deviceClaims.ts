/**
 * Machine-wide device claims — "is another clone already using this phone?" (#149 part 2).
 *
 * The IMPLEMENTATION moved to `../../scripts/deviceClaimsStore.mjs` (#285): a standalone Node CLI
 * script (the #285 claim guard that wraps raw `adb`/`xcodebuild`/`devicectl` calls made OUTSIDE the
 * MCP surface) needs to share this exact logic, and a plain Node script cannot import TypeScript.
 * This file is now a thin typed shell that re-exports every function from the `.mjs` and keeps the
 * TypeScript types for the rest of the (typed) codebase to consume. **Read the `.mjs` file for the
 * design rationale** — the socket-lease-vs-hardware-claim reasoning, the staleness rules, the
 * `owner`/CLI-claim additions, all of it lives there now, not here.
 */

export {
  claimsDir,
  CLAIM_TTL_MS,
  CLI_CLAIM_TTL_MS,
  adbDeviceId,
  iosDeviceId,
  wifiDeviceId,
  isPidAlive,
  isStale,
  listClaims,
  claimDevice,
  releaseDevice,
  releaseAllForThisProcess,
  sweepStaleClaims,
  describeConflict,
  foreignClaimFor,
} from '../../scripts/deviceClaimsStore.mjs';

export type {
  DeviceId,
  DeviceClaim,
  ClaimRequest,
  ClaimResult,
} from '../../scripts/deviceClaimsStore.d.mts';
