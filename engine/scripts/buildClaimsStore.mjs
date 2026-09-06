/**
 * Cross-process claim on a project's `<project>/dist` (#650).
 *
 * `engine/plugins/backend/buildLock.ts`'s `acquireBuild` is an in-process module-level flag — it
 * closes a build racing another build inside the SAME backend process (an agent firing
 * `modoki_build` while a human's build runs), but it is blind to anything outside that process.
 * Three CLI scripts write the SAME `<project>/dist` from a SEPARATE process: `build-web.mjs`,
 * `add-native-targets.mjs`, `ota-publish.mjs`. Run one of those by hand while the editor's OTA
 * publish is mid-flight and the two race unserialized — the publish can upload a bundle the CLI is
 * still writing, shipping a TORN JS bundle to every installed device with no review step in
 * between. `buildLock.ts`'s own docblock named this gap and pointed at the shape `deviceClaims.ts`
 * already implements; this module closes it the same way #285 closed the equivalent gap for
 * physical hardware — a claim file under `~/.modoki`, guarded by an O_EXCL `mkdir` lock.
 *
 * **Read `deviceClaimsStore.mjs` for the mechanics this copies**: the file layout (beside
 * `device-claims.json`, `claimsDir()` re-used from there directly — see the import below), the
 * atomic temp+rename write, the O_EXCL `mkdir` lock, and dual pid/TTL staleness.
 *
 * THREE DELIBERATE DIVERGENCES from `deviceClaimsStore.mjs`, because a BUILD claim is not a
 * DEVICE claim:
 *
 *  1. **`withLock` here THROWS on a lock timeout instead of proceeding unlocked.**
 *     `deviceClaimsStore.mjs:264` gives up and proceeds WITHOUT the lock — "never block hardware
 *     on a lock" — which is correct for a device (losing that race just means retrying a tap
 *     moments later) and WRONG here: proceeding unlocked risks losing a write in the
 *     read-modify-write, and a lost build claim is exactly the torn-dist race this module exists
 *     to prevent. Losing the race to take the LOCK is fine — the caller gets a clear error and can
 *     retry; silently losing the CLAIM itself is not. See `withLock` below.
 *
 *     The same reasoning governs the READ side too, and it was NOT carried across the first time
 *     this file was written: `readClaimsResult` (below) treats a claims file that exists but can't
 *     be read or parsed as UNKNOWN, never as "no claims". Collapsing it to `[]` would tell
 *     `acquireBuildClaim` "nothing holds this" and grant a second claim on top of one it simply
 *     couldn't see — the exact torn-dist race this module exists to prevent, reopened through the
 *     read path instead of the lock path. This function used to be `readClaims`, ending
 *     `catch { return []; // an unreadable claims file must never block a build }` — wording copied
 *     from `deviceClaimsStore.mjs`, where it is correct (losing a device race just means retrying a
 *     tap moments later) and wrong here for the identical reason the `withLock` copy above was
 *     wrong. See `readClaimsResult` and `acquireBuildClaim`'s UNKNOWN branch below; `readBuildClaim`
 *     documents its own, different call on the same three-way split, because it is an advisory read
 *     rather than a gate.
 *
 *  2. **Two different timescales get two different constants.** The `mkdir` LOCK still guards a
 *     microsecond critical section (a read, a filter, and a write of a handful of JSON records),
 *     so its stale window is UNCHANGED from `deviceClaimsStore` (`LOCK_STALE_MS = 5000`). The
 *     CLAIM itself is held for the DURATION OF A BUILD — minutes, not microseconds — so it gets
 *     its own, much longer TTL (`BUILD_CLAIM_TTL_MS`, 60 minutes). Do not "fix" a wedged build by
 *     inflating the LOCK window instead: that would wedge every OTHER build on this machine
 *     behind one crashed process for an hour, which is precisely the failure the short lock
 *     window exists to avoid. The lock and the claim answer different questions — "can I safely
 *     read-modify-write the file right now" vs. "is the thing recorded IN the file still alive" —
 *     and conflating them was never right for either module.
 *
 *  3. **No owner-token / `pid:0` trick.** `deviceClaimsStore.mjs`'s `owner`/`ttlMs` fields (#285)
 *     exist because a DEVICE claim can outlive its short-lived CLI process (e.g. "hold this phone
 *     while an install runs, then a moment longer"), so it needs a claim that survives the process
 *     exiting. A BUILD claim's holder — the editor backend, or a CLI script — stays alive for its
 *     ENTIRE hold: the CLI process does not exit until the build/publish/scaffold it is guarding
 *     is actually done. So plain pid liveness is the right PRIMARY signal, with the TTL only as a
 *     backstop for what pid liveness cannot see (a claim written by a machine whose clock jumped).
 *     See `isStale` below — same dual rule as `deviceClaimsStore.mjs:202-215`, including treating
 *     a NEGATIVE age (a claim stamped in the future) as a live claim with a bad clock, never an
 *     expiry.
 *
 * No `isSameHolder`/reentrant-refresh idiom either, and that is deliberate, not an oversight:
 * `buildLock.ts`'s own in-process `acquireBuild` refuses a SECOND acquisition unconditionally,
 * even from the exact code path that took the first one (see its own test, "refuses a second
 * build") — there is no self-reconnect case there, so this mirrors it exactly: one live claim per
 * project root, no exceptions. Release identity instead comes from a per-acquisition `token`
 * (below), because a FILE-based claim has no in-memory object to compare by reference the way
 * `buildLock.ts:64`'s `if (active === mine)` does — see `acquireBuildClaim`'s own comment.
 *
 * ── Re-entrancy through a CHILD PROCESS (deadlock fix) ──
 * `/api/build`, `/api/ota/publish` and `/api/add-native-target` each hold the claim for their
 * WHOLE pipeline and then spawn `build-web.mjs` (and, for OTA, `ota-publish.mjs` too) as a CHILD
 * process to do the actual compile — the identical `MODOKI_PROJECT`, so the child resolves the
 * SAME project root and calls `acquireBuildClaim` again, on top of its own parent's still-live
 * claim. Every existing check above refuses that unconditionally (by design: one live claim per
 * root, no exceptions) — which means the ancestor deadlocks against itself. `add-native-targets.mjs`
 * hits this too (its own `makeRunShell` spawns `build-web.mjs` as step 3 of the same scaffold that
 * already holds the claim).
 *
 * The fix is a re-entrancy SIGNAL the child inherits through the environment, not a relaxation of
 * the one-claim rule: a successful grant publishes its `token` onto `process.env[BUILD_CLAIM_ENV_VAR]`
 * (below), which every existing child-spawn path already inherits (`buildStepEnv`/`runShell`'s
 * `{ ...process.env, … }`) with no call-site change needed. A later `acquireBuildClaim` for the
 * SAME resolved root then checks the env token against the LIVE claim's own token — an exact
 * match means "I am a descendant of the process that already holds this," and grants a
 * PASS-THROUGH handle whose `release()` is a no-op: it never touches the claims file, so the
 * child cannot free the parent's claim out from under it when the child exits first.
 *
 * The match is deliberately narrow — root, token, AND a DIFFERENT pid, not merely "an env var is
 * set" — so none of the following is reachable:
 *  - A STALE token (the claim it named has since been released) cannot match, because `existing`
 *    is then either absent or a DIFFERENT claim with a DIFFERENT token — it falls straight
 *    through to the ordinary grant/refuse path below, exactly as if the env var were unset.
 *  - A FOREIGN token (a different project's claim, or a claim this process never descends from)
 *    cannot match either, for the same reason: the comparison is always against the live claim
 *    for THIS exact resolved root, never a bare "is some token present" check.
 *  - The ANCESTOR calling `acquireBuildClaim` a SECOND time on itself (no child involved at all)
 *    cannot match either, even though the token comparison alone WOULD: the token is a
 *    process-global side effect that survives in `process.env` across calls in the same process
 *    with no intervening release. Requiring `existing.pid !== process.pid` closes that — a real
 *    child is always a genuinely different OS process, so this costs the fix nothing, and it
 *    preserves `buildLock.ts`'s own "no self-reconnect" doctrine for `acquireBuild` (refuses a
 *    second acquisition unconditionally, even from the exact code path that took the first one).
 *    Caught by this file's own pre-existing "refuses a second claim on the SAME project root"
 *    test, which regressed under a token-only comparison during development.
 */

import fs from 'node:fs';
import path from 'node:path';
import { claimsDir } from './deviceClaimsStore.mjs';

function claimsFile() {
  return path.join(claimsDir(), 'build-claims.json');
}

/** Wall-clock backstop for a claim whose pid check cannot settle it. A build is held for MINUTES,
 *  not the microseconds the `mkdir` LOCK below protects — see divergence 2 in the header. Sixty
 *  minutes is generous on purpose: expiring a LIVE claim re-opens the exact torn-dist race this
 *  file exists to prevent, whereas holding a dead one an extra hour merely produces a refusal that
 *  names a pid the human can check (and `ps`/Activity Monitor will show it's already gone). */
export const BUILD_CLAIM_TTL_MS = 60 * 60 * 1000;

/** The env var a granted claim's token is published onto, and the one a child process's own
 *  `acquireBuildClaim` reads back to recognize its ancestor's claim on the SAME resolved root —
 *  see the header's "Re-entrancy through a CHILD PROCESS" section. Exported (rather than a bare
 *  string literal at each read/write site) so a test can name it without duplicating the string. */
export const BUILD_CLAIM_ENV_VAR = 'MODOKI_BUILD_CLAIM_TOKEN';

/** Is that process still alive? `kill(pid, 0)` signals nothing and throws ESRCH when it is gone.
 *  EPERM means it EXISTS but belongs to another user — alive, and emphatically not ours to expire.
 *  Same as `deviceClaimsStore.mjs`'s `isPidAlive`, copied rather than imported: this is the one
 *  piece small and generic enough that duplicating it costs less than coupling two otherwise
 *  independent claim files to a shared helper for it. */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

/** Is this claim dead — either its process is gone, or it has outlived the TTL? PURE (the
 *  liveness probe and the clock are injectable) so both expiry rules are testable without
 *  spawning anything. No `owner`/pid-0 branch — see divergence 3 in the header: every build claim
 *  has a real, live pid to check for its entire hold. */
export function isStale(claim, opts = {}) {
  const now = opts.now ?? Date.now();
  const alive = opts.alive ?? isPidAlive;
  if (!alive(claim.pid)) return true;
  // A NEGATIVE age (a claim stamped in the future — clock skew between two machines sharing a
  // network home dir) is not an expiry: it is a live claim with a bad clock, and expiring it would
  // hand a project's dist to a second process mid-build. Only genuine age counts. Same rule, same
  // reasoning, as deviceClaimsStore.mjs:212-215.
  return now - claim.at > BUILD_CLAIM_TTL_MS;
}

// ── File I/O ─────────────────────────────────────────────────────────────────

/** Read the on-disk claims file, distinguishing "not created yet" from "exists but I can't tell
 *  what's in it" — the three-way MATCH/MISMATCH/UNKNOWN doctrine `device.mjs:348-361`
 *  (`checkIosPhoneCollision`) sets out for exactly this shape, cited by #731's design too:
 *
 *   - **Absent (`ENOENT`)** → `{ ok: true, claims: [] }`. The ordinary first-run case — nothing has
 *     ever claimed anything on this machine — and it must stay exactly this silent.
 *   - **Present but unreadable, unparseable, or not shaped like `{ claims: [...] }` at the top
 *     level** (the only shape `writeClaims` below ever produces, so anything else means hand
 *     edited or corrupted, not merely "empty") → `{ ok: false, error }`. This is UNKNOWN, not "no
 *     claims" — the file plainly exists and was meant to hold one, and this function cannot tell
 *     whether it does. A malformed INDIVIDUAL entry inside an otherwise well-shaped array is a
 *     different case, handled by the filter below: the surrounding array is still trustworthy even
 *     when one record in it isn't, so that entry is dropped rather than poisoning the whole read.
 *
 *  UNKNOWN must never collapse into "no claims" here — that is the exact fail-open this split
 *  replaces, see the header's divergence 1 — and this function does not collapse it into a refusal
 *  either: it only reports what it found. Each CALLER decides what UNKNOWN means for its own
 *  question — `acquireBuildClaim` is a gate and refuses; `readBuildClaim` is advisory and does not
 *  (see its own comment). */
function readClaimsResult() {
  let raw;
  try {
    raw = fs.readFileSync(claimsFile(), 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return { ok: true, claims: [] };
    return { ok: false, error: e };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: e };
  }
  if (!Array.isArray(parsed?.claims)) {
    return { ok: false, error: new Error(`${claimsFile()} does not contain a "claims" array`) };
  }
  return { ok: true, claims: parsed.claims.filter((c) => c && typeof c.projectRoot === 'string') };
}

/** The refusal message for `acquireBuildClaim`'s UNKNOWN branch — names the file and the human's
 *  way out, same tone as `withLock`'s own timeout message just above. */
function describeBuildClaimsUnreadable(error) {
  const file = claimsFile();
  const detail = error?.message ?? String(error);
  return `The build-claims file (${file}) exists but could not be read (${detail}). Refusing this `
    + 'build because it cannot tell whether another build already holds the claim for this project '
    + '— granting one anyway risks the exact torn-dist race this file exists to prevent. If no '
    + 'build is actually running, delete that file by hand and try again.';
}

/** Write via a temp file + rename, so a reader never sees a half-written file. The rename is
 *  atomic within a directory on every platform we run on. */
function writeClaims(claims) {
  const dir = claimsDir();
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.build-claims-${process.pid}-${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ claims }, null, 2));
  fs.renameSync(tmp, claimsFile());
}

/** Serialize read-modify-write across PROCESSES with an O_EXCL lock dir — same primitive as
 *  `deviceClaimsStore.mjs:239-276`, but see divergence 1 in the header for why it THROWS instead
 *  of proceeding once `deadlineMs` passes.
 *
 *  `deadlineMs` is deliberately a SEPARATE knob from `LOCK_STALE_MS` (not exposed on the public
 *  API below — `acquireBuildClaim`'s `opts.deadlineMs` threads it through for tests only): in
 *  production it always defaults to `LOCK_STALE_MS`, so real behaviour is unchanged from
 *  "wait up to the same window that makes a lock look abandoned, then give up" — it exists as a
 *  seam so a test can shrink "how long do I personally wait" without needing to fake an
 *  ABANDONED lock (a fresh, genuinely-held lock and a "waited too long" lock are different
 *  conditions in reality, and only splitting them apart makes both independently testable). */
function withLock(fn, opts = {}) {
  const lock = path.join(claimsDir(), '.build-claims.lock');
  fs.mkdirSync(claimsDir(), { recursive: true });
  const deadlineMs = opts.deadlineMs ?? LOCK_STALE_MS;
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (e) {
      // ONLY EEXIST means "another process holds the lock" — the contention this loop exists to
      // wait out. Any other errno (EACCES/EROFS/ENOSPC — `~/.modoki` uncreatable, a read-only
      // filesystem, a full disk) is a REAL failure, not contention: `fs.statSync(lock)` right below
      // would then throw ENOENT (the lock dir was never created), its own catch would `continue`,
      // and the loop would retry the identical failing `mkdirSync` forever — an unbounded
      // synchronous spin that skips the deadline check entirely (measured: 2m12s at 30% CPU before
      // being killed). Same split as `vendorPlugins.ts`'s `ensurePluginBuilt` lock. Fail loud
      // instead, naming the path and the errno.
      if (e?.code !== 'EEXIST') {
        throw new Error(`Could not create the build-claims lock directory (${lock}): ${e?.code ?? ''} ${e?.message ?? e}`.trim(), { cause: e });
      }
      let age;
      try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { continue; /* vanished — retry */ }
      if (age > LOCK_STALE_MS) { try { fs.rmSync(lock, { recursive: true, force: true }); } catch { /* raced */ } continue; }
      if (Date.now() > deadline) {
        // DIVERGES FROM deviceClaimsStore.mjs:264 ON PURPOSE. That one gives up and proceeds
        // WITHOUT the lock ("never block hardware on a lock") — right for a device, where losing
        // the race just means retrying a tap. Here the critical section guards a build CLAIM, and
        // proceeding unlocked risks losing a write in the read-modify-write — exactly the
        // torn-claim (and so torn-dist) race this file exists to prevent. A later "cleanup" that
        // makes this "consistent" with the device store by removing the throw would silently
        // restore that fail-open behaviour — see buildClaimsStore.test.ts's explicit assertion.
        throw new Error(
          `Timed out after ${deadlineMs}ms waiting for the build-claims lock (${lock}) — another `
          + 'process may be stuck mid-write. Refusing to proceed WITHOUT the lock (losing a build '
          + 'claim in an unlocked read-modify-write is the exact torn-dist race this file exists '
          + 'to prevent). If no build is actually running, remove the lock directory by hand and '
          + 'retry.',
          // The EEXIST from the mkdirSync attempt that led here — this branch is only reached
          // after the `if` above rules out every OTHER errno, so `e` is genuinely EEXIST, the
          // proximate cause of "still waiting", not an unrelated error attached for lint's sake.
          { cause: e },
        );
      }
      // Busy-wait deliberately: this is a microsecond critical section and the caller is sync.
      const until = Date.now() + 15;
      while (Date.now() < until) { /* spin */ }
    }
  }
  try {
    return fn();
  } finally {
    try { fs.rmSync(lock, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

/** Stale window for the `mkdir` LOCK only — see divergence 2 in the header. Unchanged from
 *  `deviceClaimsStore.mjs`: the critical section it guards is exactly as short here. */
const LOCK_STALE_MS = 5000;

// ── The API ──────────────────────────────────────────────────────────────────

/** Take the cross-process build claim for `projectRoot`, or refuse naming who holds it.
 *
 *  Keyed by the RESOLVED absolute project root, so a caller passing a relative path or one with a
 *  trailing slash still collides correctly with an existing claim for the same project.
 *
 *  `opts.kind` records WHO is asking — `'editor'` (the default) or `'cli'` — purely for the
 *  refusal message: `buildLock.ts`'s `acquireBuildSlot` passes `'editor'`; the three CLI scripts
 *  pass `'cli'`. `opts.now`/`opts.alive` are the same injectable-clock/liveness seam every
 *  staleness check here takes. `opts.deadlineMs` is test-only — see `withLock`.
 *
 *  The returned `release` is IDEMPOTENT and only ever clears the acquisition it belongs to — the
 *  same contract `buildLock.ts:56-59`/`acquireBuild` documents, and for the same reason: a route
 *  can release from a signal that fires more than once (`releasePolicy`), and a stale release
 *  firing late must never be able to free a LATER claim on the same project. `buildLock.ts` gets
 *  that from `if (active === mine)` — a reference to an in-memory object. A FILE has no such
 *  reference, so release identity here is a per-acquisition `token` instead: release matches
 *  `(projectRoot, token)`, not merely `(projectRoot, pid)` — the same pid can legitimately
 *  re-acquire after releasing (a CLI script running twice in a row), and matching on pid alone
 *  would let the FIRST run's stale release wipe the SECOND run's live claim.
 *
 *  `release` also NEVER THROWS — see `releaseBuildClaimByToken`'s own comment. Several callers
 *  invoke it from a place that cannot tolerate an exception (an EventEmitter `close` listener, a
 *  floating `.finally()`), so a failure taking the lock back is warned to the console and
 *  swallowed rather than propagated. */
export function acquireBuildClaim(projectRoot, label, opts = {}) {
  const root = path.resolve(projectRoot);
  const now = opts.now ?? Date.now();
  const kind = opts.kind === 'cli' ? 'cli' : 'editor';
  // The re-entrancy signal — see the header's "Re-entrancy through a CHILD PROCESS" section.
  // `opts.envToken` is a test-only seam (mirrors `now`/`alive` above); production always reads the
  // real environment a spawned child inherits.
  const envToken = opts.envToken !== undefined ? opts.envToken : process.env[BUILD_CLAIM_ENV_VAR];
  return withLock(() => {
    const result = readClaimsResult();
    if (!result.ok) return { ok: false, message: describeBuildClaimsUnreadable(result.error) };
    const live = result.claims.filter((c) => !isStale(c, opts));
    const existing = live.find((c) => c.projectRoot === root);
    if (existing) {
      // Re-entrancy: this call is happening inside a CHILD PROCESS an ancestor spawned while
      // already holding the claim for this EXACT resolved root — the token it published onto the
      // environment (below) matches the live claim's own token byte-for-byte, AND the pid asking
      // is NOT the pid that took the claim (`existing.pid`) — i.e. this is genuinely a SEPARATE OS
      // process, not the ancestor calling `acquireBuildClaim` a second time on itself. That second
      // clause is load-bearing, not defensive: the env token is a process-global side effect that
      // persists across calls in the SAME process even without an intervening release, so without
      // it the ancestor's own second call (exactly the case `buildLock.ts`'s `acquireBuild` docs
      // call "no self-reconnect case… refuses a SECOND acquisition unconditionally, even from the
      // exact code path that took the first one") would wrongly pass through instead of refusing —
      // caught by this file's own "refuses a second claim on the SAME project root" test, which
      // regressed under the token-only comparison. Grant a PASS-THROUGH handle rather than
      // refusing: it never writes to the claims file (this isn't a new acquisition — the
      // ancestor's IS the acquisition) and its `release()` is a genuine no-op, so the child exiting
      // first can never free the ancestor's still-in-use claim. A stale token (the claim it named
      // is gone) or a foreign one (a different project, or no live claim at all here) fails this
      // comparison and falls straight through to the ordinary refusal below.
      if (envToken && existing.token === envToken && existing.pid !== process.pid) {
        return { ok: true, release: () => {} };
      }
      return { ok: false, held: existing, message: describeBuildClaimConflict(existing, now) };
    }
    const token = `${process.pid}-${now}-${Math.random().toString(36).slice(2, 10)}`;
    const claim = { projectRoot: root, pid: process.pid, at: now, label, kind, token };
    writeClaims([...live.filter((c) => c.projectRoot !== root), claim]);
    held.set(root, token);
    heldDir = claimsDir();
    installExitHook();
    // Publish the token so a CHILD PROCESS this one spawns (build-web.mjs, ota-publish.mjs, a CLI
    // scaffold's own `npm run build` step, …) can recognize this exact claim instead of deadlocking
    // against it — see the header. Every existing child-spawn env (`buildStepEnv`, the CLI scripts'
    // `{ ...process.env, … }`) already inherits `process.env`, so this alone is enough; no call site
    // that spawns a build step needs to change.
    process.env[BUILD_CLAIM_ENV_VAR] = token;
    return { ok: true, release: () => releaseBuildClaimByToken(root, token) };
  }, opts);
}

function releaseBuildClaimByToken(root, token) {
  // `withLock` THROWS rather than proceeding unlocked (divergence 1 in the header) — right for
  // ACQUIRE, where losing the race risks granting a second claim on top of one it couldn't see,
  // but wrong for RELEASE: `release()` is called from an EventEmitter 'close' listener and from a
  // floating `.finally()` in several callers (vite-asset-scanner.ts, build-web.mjs,
  // ota-publish.mjs, add-native-targets.mjs), none of which wrap it — a synchronous throw there is
  // an uncaught exception or an unhandled rejection, either of which can take the whole process
  // down over a build that already finished successfully. So a failed release is caught and
  // WARNED, never propagated — a thrown release has no backstop at all, it just crashes the
  // caller. `held.delete`/the env-var clear below still run regardless, so this process at least
  // stops believing it holds a claim it can no longer safely touch.
  //
  // ⚠️ Not fully self-healing: `isStale`'s pid-liveness half is INERT for the case that actually
  // produces a swallowed release — the thrower here is the long-lived EDITOR BACKEND, and that
  // process keeps running after the throw, so `isPidAlive(claim.pid)` stays true for as long as
  // the editor does. Only the TTL half (`BUILD_CLAIM_TTL_MS`, 60 minutes) can expire this claim,
  // and because `held.delete` already ran, this process's own exit hook won't release it either —
  // so every later build in that same editor is refused with "an editor already holds the build
  // claim … pid <its own pid>" for up to an hour. Recovery until then is deleting the claims file
  // by hand. Accepted trade-off, not a regression: the alternative was crashing the backend from a
  // 'close' listener (#682 close-out round 3, MEDIUM 4).
  try {
    withLock(() => {
      const result = readClaimsResult();
      // Release is best-effort and non-gating (called from a route's cleanup and from the exit
      // hook) — on UNKNOWN, silently do nothing rather than write a guess: we cannot see what's
      // actually on disk, so writing our OWN filtered view of "nothing" would clobber whatever is
      // really there. The in-memory `held` entry is still cleared below either way, so this process
      // at least stops believing it holds a claim it can no longer safely touch.
      if (!result.ok) return;
      const all = result.claims;
      const next = all.filter((c) => !(c.projectRoot === root && c.token === token));
      // Write only when THIS token's claim actually went — a stale release (its claim already
      // gone, or superseded by a later acquisition with a different token) is a silent no-op,
      // never a write, so it can't clobber whatever is CURRENTLY there.
      if (next.length !== all.length) writeClaims(next);
    });
  } catch (e) {
    console.warn(
      `[buildClaimsStore] could not release the build claim for ${root}: `
      + `${e instanceof Error ? e.message : String(e)}. The claim may remain on disk until its `
      + 'pid/TTL staleness check expires it.',
    );
  }
  if (held.get(root) === token) held.delete(root);
  // Clear the re-entrancy signal exactly when it's still ours to clear — matched by TOKEN, not
  // merely "an env var is set", so a stale release firing late (the same idempotent-release
  // contract every other release path here carries) can never erase a NEWER acquisition's signal
  // that has since overwritten it with a different token.
  if (process.env[BUILD_CLAIM_ENV_VAR] === token) delete process.env[BUILD_CLAIM_ENV_VAR];
}

/** The live claim on `projectRoot`, or `null` — a plain filtered read, no lock (reads never need
 *  one; only the read-modify-write in `acquireBuildClaim`/release does).
 *
 *  Deliberately returns `null` on UNKNOWN too (file present but unreadable/unparseable — see
 *  `readClaimsResult`), unlike `acquireBuildClaim`'s refusal: this function has no production
 *  caller today and is documented as advisory/reporting (a route surfacing "who's building this?",
 *  or a test) rather than a gate — nothing consults it to decide whether writing `dist` is safe, so
 *  a `null` here can't reopen the torn-dist race the way collapsing `acquireBuildClaim`'s read
 *  would. ⚠️ That said, `null` from THIS function is NOT proof "nothing holds a claim" — it also
 *  means "couldn't tell". A caller that starts using this to gate a decision must not treat `null`
 *  as the strong guarantee it is for `acquireBuildClaim`'s "grants when free" case. */
export function readBuildClaim(projectRoot, opts = {}) {
  const root = path.resolve(projectRoot);
  const result = readClaimsResult();
  if (!result.ok) return null;
  return result.claims.filter((c) => !isStale(c, opts)).find((c) => c.projectRoot === root) ?? null;
}

/** The refusal text — names the project, the label, the holder's kind and pid, and how long ago.
 *  Used verbatim by every caller: the three CLI scripts print it straight to stderr, and
 *  `buildLock.ts`'s `acquireBuildSlot` forwards it as-is for a cross-process refusal (its OWN
 *  `describeBuildConflict` stays scoped to the in-process case it can actually observe — see that
 *  module for why splitting the wording this way, rather than re-deriving it in TypeScript, is
 *  the right seam given a CLI script cannot import a `.ts` module at all). */
export function describeBuildClaimConflict(held, now = Date.now()) {
  const mins = Math.max(0, Math.round((now - held.at) / 60000));
  const when = new Date(held.at).toLocaleTimeString();
  const who = held.kind === 'cli' ? 'a command-line build' : 'an editor';
  return `${who} already holds the build claim for ${held.projectRoot} — "${held.label}", started `
    + `${when} (${mins} min ago, pid ${held.pid}). Builds, OTA publishes and native scaffolds all `
    + 'compile into the SAME <project>/dist, so running two at once risks shipping (or uploading) a '
    + 'TORN bundle. Wait for it to finish, or close it, then try again.';
}

/** Exactly what this process took — so the exit hook gives back what it holds rather than
 *  "whatever in the current file bears my pid". Keyed by resolved project root, valued by the
 *  TOKEN (not a boolean): the exit hook must release by the same identity `acquireBuildClaim`
 *  handed out, for the same reason `releaseBuildClaimByToken` matches on token rather than pid. */
const held = new Map();
let heldDir = null;

/** Give every claim back when this process exits — registered LAZILY, on the first successful
 *  claim, so a process that never claims anything never touches the claims file. `exit` only,
 *  deliberately, same reasoning as `deviceClaimsStore.mjs:450-457`: the uncovered cases (a
 *  signal, a crash, `kill -9`) are exactly what pid-liveness expiry (`isStale`) is for.
 *
 *  Pinned to `heldDir` for exactly the reason `deviceClaimsStore.mjs:443-446` documents:
 *  `claimsDir()` is resolved dynamically from `MODOKI_HOME`/`VITEST`, and a long-lived vitest
 *  WORKER process runs many tests before it actually exits — by then `MODOKI_HOME` could be
 *  whatever the LAST test left it as, not what it was when THIS claim was taken. Re-resolving at
 *  exit would release against the wrong directory (or, worse, silently do nothing there and leak
 *  a claim into a directory this process never touches again). */
let exitHookInstalled = false;
function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    if (!held.size || !heldDir) return;
    const prev = process.env.MODOKI_HOME;
    try {
      process.env.MODOKI_HOME = heldDir;
      for (const [root, token] of [...held]) releaseBuildClaimByToken(root, token);
    } catch { /* nothing left to do at exit */ } finally {
      if (prev === undefined) delete process.env.MODOKI_HOME; else process.env.MODOKI_HOME = prev;
    }
  });
}

/** Test-only: drop this process's in-memory tracking of what it holds, so one test cannot leak
 *  state into the next. Mirrors `resetBuildLockForTests` — never called by a route or script.
 *  Also clears the re-entrancy env var (#650 follow-up): the vitest WORKER is one long-lived
 *  process, so a token a test set (or a grant left behind) would otherwise leak into every
 *  LATER test's `process.env`, not just the one that set it. */
export function resetBuildClaimsForTests() {
  delete process.env[BUILD_CLAIM_ENV_VAR];
  held.clear();
  heldDir = null;
}
