/** Type sidecar for `buildClaimsStore.mjs` — see that file for the design rationale.
 *  Hand-written because the module is plain JS (the three CLI scripts — `build-web.mjs`,
 *  `add-native-targets.mjs`, `ota-publish.mjs` — need to import it directly and cannot import
 *  TypeScript), but `engine/plugins/backend/buildLock.ts` imports it and is typechecked normally.
 *  Same pattern as `deviceClaimsStore.mjs`/`deviceClaimsStore.d.mts`. */

/** Who holds a project's build claim, and enough to find them. */
export interface BuildClaim {
  /** The resolved absolute project root — the claim's key. */
  projectRoot: string;
  /** The claiming process's pid. Always a real, live pid for its entire hold (unlike a
   *  `deviceClaimsStore` CLI-owned claim) — see the `.mjs` header, divergence 3. */
  pid: number;
  /** Epoch ms. Formatted only at the point a human reads it. */
  at: number;
  /** A noun phrase for the refusal message — 'ios build', 'OTA publish (CLI)', … */
  label: string;
  /** Who took it — purely for the refusal wording. */
  kind: 'editor' | 'cli';
  /** Per-acquisition identity, so a stale `release()` can never free a LATER claim on the same
   *  project root — see `acquireBuildClaim`'s own comment for why pid alone is not enough. */
  token: string;
}

export interface BuildClaimOpts {
  now?: number;
  alive?: (pid: number) => boolean;
  /** Who is asking — defaults to `'editor'`. The three CLI scripts pass `'cli'`. */
  kind?: 'editor' | 'cli';
  /** Test-only seam for `withLock`'s give-up window — see the `.mjs` header, divergence 1. */
  deadlineMs?: number;
  /** Test-only seam for the re-entrancy check — defaults to `process.env[BUILD_CLAIM_ENV_VAR]`.
   *  See the `.mjs` header, "Re-entrancy through a CHILD PROCESS". */
  envToken?: string;
}

export type BuildClaimResult =
  | { ok: true; release: () => void }
  | { ok: false; held: BuildClaim; message: string }
  /** UNKNOWN, not "nothing holds this" — the claims file exists but couldn't be read/parsed, so
   *  there is no `held` to name. Refused rather than granted; see `readClaimsResult`'s doctrine in
   *  the `.mjs`. `held?: undefined` (rather than omitting the key from the type) so callers can
   *  narrow on `held`'s truthiness the same way they already narrow on `ok`. */
  | { ok: false; held?: undefined; message: string };

/** Wall-clock backstop for a build claim whose pid check cannot settle it (60 min) — see the
 *  `.mjs` header, divergence 2, for why this differs from the LOCK's own (unexported) window. */
export declare const BUILD_CLAIM_TTL_MS: number;

/** The env var a granted claim's token is published onto, for a child process's own
 *  `acquireBuildClaim` call to recognize its ancestor's claim instead of deadlocking against it. */
export declare const BUILD_CLAIM_ENV_VAR: string;

export declare function isPidAlive(pid: number): boolean;
export declare function isStale(claim: BuildClaim, opts?: { now?: number; alive?: (pid: number) => boolean }): boolean;

/** Take the cross-process build claim for `projectRoot`, or refuse naming who holds it. See the
 *  `.mjs` for the full contract (release identity, staleness, the message). */
export declare function acquireBuildClaim(projectRoot: string, label: string, opts?: BuildClaimOpts): BuildClaimResult;

/** The live claim on `projectRoot`, or `null`. */
export declare function readBuildClaim(projectRoot: string, opts?: { now?: number; alive?: (pid: number) => boolean }): BuildClaim | null;

export declare function describeBuildClaimConflict(held: BuildClaim, now?: number): string;

/** Test-only: drop this process's in-memory tracking of what it holds. */
export declare function resetBuildClaimsForTests(): void;
