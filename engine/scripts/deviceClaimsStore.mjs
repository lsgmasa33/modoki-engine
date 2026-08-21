/**
 * Machine-wide device claims — "is another clone already using this phone?" (#149 part 2).
 *
 * The debug-bridge lease already arbitrates the SOCKET: the device enforces one owner GUID with a
 * 5s grace window, so two clones cannot both hold it and the second is refused `busy`. That works,
 * and nothing here replaces it. What it cannot cover is everything OUTSIDE the socket, all of which
 * two concurrent Claude sessions on this machine can do to the same phone unimpeded:
 *
 *   - **adb** — one machine-wide daemon. A sibling clone's `adb forward` on the same port, or any
 *     `adb shell`, is completely unaffected by the lease.
 *   - **`xcodebuild` install / launch** — two clones can install over each other on one device.
 *   - **The WebDriverAgent launch** — one agent per device on port 8100. `wdaLauncher` guards
 *     against a second launch by the SAME process; nothing stopped a second CLONE spawning a rival
 *     signed agent on the same phone.
 *   - **The physical device** — the screen shows one thing, and two agents tapping it interleave.
 *
 * So this is a claim on the HARDWARE, not on the socket, and it has to be machine-wide for the same
 * reason `~/.modoki/editor-launches.log` is: **the sibling that caused the collision is exactly what
 * a per-clone file cannot see.** It lives beside that log, in the same directory, for that reason.
 *
 * ── Why not extend the lease GUID instead? ──
 * The issue asks the right question — one arbitrator beats two that can disagree — and the answer is
 * that the lease GUID cannot reach these cases even in principle. It is presented over a TCP socket
 * to a running app; an `xcodebuild install` happens when no app is running, an `adb shell` bypasses
 * the app entirely, and a WDA launch targets a phone by UDID with no socket involved. A claim has to
 * be checkable BEFORE and WITHOUT any connection to the device, which means it has to live on this
 * machine's filesystem. The two are kept from disagreeing by construction instead: the lease OWNS
 * the claim (acquired in `connect`, released in `disconnect`), so a held lease always implies a held
 * claim, and the claim record carries the lease GUID so a reader can tell they are the same holder.
 *
 * ── Staleness is the real design risk ──
 * `docs/task-claiming.md` records that nothing expiring a `wip/*` label is a genuine cost, and a
 * dead session's device lock would be strictly worse: it blocks HARDWARE, not a ticket, and the
 * human it blocks is not the one who left it. So a claim is expired by BOTH tests, either of which
 * is sufficient:
 *   - **pid liveness** — the claiming backend process is gone (the common case: an editor was
 *     quit, or crashed, without releasing). Instant, exact, and needs no clock.
 *   - **a TTL** — a wall-clock backstop for the case pid liveness cannot see: a recycled pid, or a
 *     claim written by a machine whose clock jumped. Deliberately generous (12h), because expiring
 *     a LIVE claim silently re-opens the collision this module exists to prevent, whereas holding a
 *     dead one for an extra hour merely produces a refusal that names a pid the human can check.
 *
 * A refusal always NAMES the holder (`docs/mcp-tool-conventions.md` §5) — "clone work-ai has held
 * RFDEADBEEF2 since 14:02 (pid 8123)" is actionable; "device busy" is not.
 *
 * ── KNOWN GAP: one phone can hold two claim ids ──
 * A device is claimed under the id it was REACHED by, and an iPhone can be reached two ways: a WiFi
 * lease claims `ip:<host>` (the address is the only identity available at connect time), while the
 * WebDriverAgent launch claims `ios:<udid>` (that path knows the UDID, since it picked the device
 * out of `xcrun`). Nothing here can tell that those two ids are the same handset, so on paper two
 * clones could hold one iPhone — one by address, one by UDID.
 *
 * It is not reachable in practice, and the reason is worth stating rather than trusting: a WDA
 * launch only ever happens UNDER a lease, and the device's own socket lease is exclusive (first
 * wins, 5s grace), so a second clone cannot obtain the lease that would let it launch the agent.
 * The socket lease closes the hole that this file structurally cannot.
 *
 * What would REOPEN it is giving anything a way to launch WDA, install, or drive a phone without
 * first holding the lease. If that ever happens, the fix is to re-key the WiFi claim once the
 * bridge reports the device's identity (`deviceHardware()` arrives a round trip after connect) —
 * not to add a second arbitrator.
 *
 * ⚠️ **#285 reopened it, on purpose.** The CLI guard exists precisely so a raw `ideviceinstaller`
 * or `devicectl` — neither of which holds a lease — is checked against the claims. So the "not
 * reachable in practice" argument above no longer covers iOS: a session can now legitimately target
 * a phone by UDID while a sibling clone holds that same phone by address.
 *
 * The narrowing (not the closing) is the `model`/`osVersion` pair on the claim: a WiFi lease stamps
 * what the phone reports about itself, and a reader holding a UDID can look that UDID's product type
 * up in `xcrun`'s listing and compare. A UDID itself is deliberately never reportable by the app
 * (`deviceConnection.deviceHardware`), so this is the strongest bridge available between the two
 * namespaces — and it is a HINT, not a proof: two identical handsets report one model. Hence the
 * asymmetry the readers implement: a match refuses, a mismatch allows, and an ABSENT model is
 * "cannot tell", never "different".
 *
 * ── Implementation lives here, in a plain .mjs (#285) ──
 * This module is plain ESM JavaScript (not TypeScript) so a standalone Node CLI script — the
 * #285 claim guard that wraps raw `adb`/`xcodebuild`/`devicectl` calls outside the MCP surface —
 * can `import` it directly, the same way `engine/plugins/backend/deviceClaims.ts` does. That file
 * is now a thin typed shell re-exporting everything below; keep the design rationale here, not
 * duplicated there.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Where the claims live: beside `editor-launches.log`, machine-wide by design (see the header).
 *
 *  **Under vitest, NEVER the real `~/.modoki`.** This file is machine-wide state that blocks
 *  HARDWARE: a test that claims a device and does not release it would leave the developer's own
 *  phone refused by their editor, with a message naming a vitest worker that exited hours ago. Every
 *  test that touches claims is expected to set `MODOKI_HOME` itself (and they do), but "expected to"
 *  is not a guarantee — a test that merely CONNECTS a lease reaches this code without ever
 *  mentioning claims, which is exactly how the trap gets sprung by someone who never read this file.
 *  So the interlock lives here, where it cannot be forgotten, rather than in each test.
 *
 *  Deliberately NOT the usual "seam injectable only halfway" mistake: this does not change the RULE
 *  under test — the resolution order, the conflict, the expiry all behave identically — only the
 *  directory those rules operate on, and only when no explicit one was given. */
export function claimsDir() {
  if (process.env.MODOKI_HOME) return process.env.MODOKI_HOME;
  if (process.env.VITEST) return path.join(os.tmpdir(), `modoki-claims-vitest-${process.pid}`);
  return path.join(os.homedir(), '.modoki');
}

function claimsFile() {
  return path.join(claimsDir(), 'device-claims.json');
}

/** Wall-clock backstop for a claim whose pid check cannot settle it. Generous on purpose — see the
 *  header: expiring a live claim re-opens the collision, expiring a dead one late costs a message. */
export const CLAIM_TTL_MS = 12 * 60 * 60 * 1000;

/** TTL for a CLI-owned claim (#285) — one with an `owner` token instead of a live pid to check.
 *  Deliberately far SHORTER than `CLAIM_TTL_MS`: a pid-claim has a second, independent expiry (the
 *  process dying) and the TTL is only ever the backstop, but an owner-claim's process is EXPECTED
 *  to be gone the moment the CLI script exits — the TTL is the ONLY expiry it has. Twelve hours of
 *  that would block hardware for half a working day on every CLI invocation; 90 minutes is long
 *  enough to cover one device session without needing a keepalive, short enough that an abandoned
 *  claim clears itself before it becomes a mystery. */
export const CLI_CLAIM_TTL_MS = 90 * 60 * 1000;

/** Hard ceiling on a per-claim `ttlMs`. It exists because the TTL is the ONLY expiry an owner-claim
 *  has: a pid-claim is bounded twice over (its process dies, or 12h passes), so a silly value there
 *  self-corrects, while `device claim --ttl 999999999` was measured writing a ~1900-YEAR expiry,
 *  after which nothing but the same clone's own token — or a hand-edit of the claims file — could
 *  ever give the hardware back. Clamped rather than rejected, so a fat-fingered flag still claims
 *  the device instead of failing outright; the caller is told when the clamp bites. The ceiling is
 *  `CLAIM_TTL_MS` because nothing here is entitled to hold hardware longer than the pid backstop. */
export const MAX_CLAIM_TTL_MS = CLAIM_TTL_MS;

/** Clamp a requested TTL into `(0, MAX_CLAIM_TTL_MS]`; `undefined` means "use the default". */
export function clampTtlMs(ttlMs) {
  if (ttlMs === undefined || ttlMs === null) return undefined;
  const n = Number(ttlMs);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(n, MAX_CLAIM_TTL_MS);
}

/** A device id is namespaced by HOW the device is addressed, because the namespaces genuinely have
 *  different identity guarantees and silently mixing them would let a strong id and a weak one
 *  collide:
 *    - `adb:<serial>`  — a hardware serial. Stable, unique, the real thing.
 *    - `ios:<udid>`    — a hardware UDID from `xcrun`. Same strength.
 *    - `ip:<host>`     — a WiFi lease, where the ADDRESS is the only identity available at connect
 *                        time (the phone reports its model over the bridge, but not until the lease
 *                        is already open, and a model is not unique anyway). Weaker: DHCP can move
 *                        it. Namespaced so nobody mistakes it for a hardware id, and so the same
 *                        phone reached two ways yields two claims rather than one false match. */

const ADB_PREFIX = 'adb:';
export function adbDeviceId(serial) { return `${ADB_PREFIX}${serial}`; }

/** The inverse of `adbDeviceId` — the serial inside an `adb:` id, or `undefined` for any other kind.
 *  Exists so no caller re-derives the prefix by hand: a `deviceId.slice('adb:'.length)` at a call
 *  site is a second copy of the encoding that a change here would leave behind, silently yielding a
 *  MANGLED serial (`adb -s dbRFCT… install`) rather than a clean miss. */
export function adbSerialOf(deviceId) {
  return typeof deviceId === 'string' && deviceId.startsWith(ADB_PREFIX)
    ? deviceId.slice(ADB_PREFIX.length)
    : undefined;
}
export function iosDeviceId(udid) { return `ios:${udid}`; }
export function wifiDeviceId(host) { return `ip:${host}`; }

/** Who holds a device, and enough to find them. `label` is the human-facing device name when the
 *  claimer knew one (`SC_56C`, `Masaki iPhone Air`) — a serial alone is hard to match to the phone
 *  on the desk.
 *
 *  `DeviceClaim` fields (documented here since this is plain JS — see `deviceClaims.ts` for the
 *  typed interface):
 *    - deviceId, clone, branch, pid, at — as below.
 *    - guid?    — the lease GUID this claim belongs to, when it was taken by a lease.
 *    - label?, purpose? — as below.
 *    - owner?   — (#285) a stable token identifying a holder that is NOT a live process (a CLI
 *      script). Written only by the CLI path. When set, `pid` is written as 0 and staleness is
 *      judged purely by TTL (`ttlMs` or `CLI_CLAIM_TTL_MS`) rather than by process liveness.
 *    - ttlMs?   — (#285) a per-claim TTL override, consulted only when `owner` is set.
 */

/** Is that process still alive? `kill(pid, 0)` signals nothing and throws ESRCH when it is gone.
 *  EPERM means it EXISTS but belongs to another user — alive, and emphatically not ours to expire. */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

/** Is this claim dead — either its process is gone, or it has outlived the TTL? PURE (the liveness
 *  probe and the clock are injectable) so both expiry rules are testable without spawning anything.
 *
 *  (#285) An OWNER claim (a CLI-owned claim, no live process to check) is judged purely by TTL —
 *  `claim.owner` set means `pid` is 0 and there is nothing for `alive()` to probe, so the pid check
 *  is skipped entirely rather than treating pid 0 as a dead process (which it would report as
 *  stale unconditionally and defeat the TTL). Everything else — including the "a negative age is
 *  not an expiry" rule below — is unchanged and applies to both kinds of claim identically, since
 *  it falls out of the same `now - claim.at > ttl` comparison either way. */
export function isStale(claim, opts = {}) {
  const now = opts.now ?? Date.now();
  if (claim.owner) {
    // A negative age (a claim stamped in the future) is not an expiry here either — same
    // comparison, same reasoning as the pid-claim path below.
    return now - claim.at > (claim.ttlMs ?? CLI_CLAIM_TTL_MS);
  }
  const alive = opts.alive ?? isPidAlive;
  if (!alive(claim.pid)) return true;
  // A NEGATIVE age (a claim stamped in the future — a clock skew between two machines sharing a
  // network home dir) is not an expiry: it is a live claim with a bad clock, and expiring it would
  // hand the device to a second session. Only genuine age counts.
  return now - claim.at > CLAIM_TTL_MS;
}

// ── File I/O ─────────────────────────────────────────────────────────────────

function readClaims() {
  try {
    const parsed = JSON.parse(fs.readFileSync(claimsFile(), 'utf8'));
    return Array.isArray(parsed?.claims) ? parsed.claims.filter((c) => c && typeof c.deviceId === 'string') : [];
  } catch {
    return []; // not created yet, or corrupt — an unreadable claims file must never block hardware
  }
}

/** Write via a temp file + rename, so a reader never sees a half-written file. The rename is atomic
 *  within a directory on every platform we run on. */
function writeClaims(claims) {
  const dir = claimsDir();
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.device-claims-${process.pid}-${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ claims }, null, 2));
  fs.renameSync(tmp, claimsFile());
}

/** Serialize read-modify-write across PROCESSES with an O_EXCL lock dir.
 *
 *  Four clones acquiring at once is the whole premise of this module, so a bare read→write really
 *  can interleave and lose a claim — and the claim it loses is the one that would have refused the
 *  collision. `mkdir` is the classic exclusive primitive (atomic on every filesystem we care about,
 *  unlike `open(O_EXCL)` over NFS).
 *
 *  A lock older than `LOCK_STALE_MS` is broken rather than waited on: a process killed mid-claim
 *  would otherwise wedge every clone on this machine permanently, which is a far worse failure than
 *  the vanishingly unlikely race breaking it re-opens. The whole critical section is a read, a
 *  filter and a write of a file with single-digit entries — microseconds, so 5s is enormous. */
const LOCK_STALE_MS = 5000;

function withLock(fn) {
  const lock = path.join(claimsDir(), '.device-claims.lock');
  fs.mkdirSync(claimsDir(), { recursive: true });
  const deadline = Date.now() + LOCK_STALE_MS;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch {
      let age;
      try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { continue; /* vanished — retry */ }
      if (age > LOCK_STALE_MS) { try { fs.rmSync(lock, { recursive: true, force: true }); } catch { /* raced */ } continue; }
      if (Date.now() > deadline) break; // give up waiting and proceed: never block hardware on a lock
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

// ── The API ──────────────────────────────────────────────────────────────────

/** Every LIVE claim, stale ones dropped. The read behind `device_list` and the AI panel. */
export function listClaims(opts = {}) {
  return readClaims().filter((c) => !isStale(c, opts));
}

/** `ClaimRequest` fields (documented here since this is plain JS — see `deviceClaims.ts` for the
 *  typed interface): deviceId, clone?, branch?, guid?, label?, purpose?, and (#285) owner?, ttlMs?
 *  — carried onto the written claim exactly as `DeviceClaim.owner`/`ttlMs` above. */

/** `ClaimResult` is `{ ok: true, claim }` or `{ ok: false, held, message }` — see `deviceClaims.ts`
 *  for the typed union. */

/** (#285) Is `existing` the SAME holder as the one making `req` — i.e. is this a legitimate
 *  refresh rather than a collision? Three cases, in order:
 *   1. `!existing.owner && existing.pid === process.pid` — today's rule, unchanged: a pid-claim
 *      reconnecting from the same process (the lease reconnects, the WDA launcher and an install
 *      all legitimately re-claim within one session).
 *   2. `req.owner && existing.owner === req.owner` — the CLI reclaiming or refreshing its OWN
 *      claim by token, since a CLI invocation has no stable pid to match on (see `pid: 0` below).
 *   3. `existing.owner && existing.clone === (req.clone ?? process.cwd())` — this clone's EDITOR
 *      taking over a claim its own CLI left behind, so a CLI claim followed by an MCP claim inside
 *      the SAME checkout does not self-deadlock. This matches on the clone ONLY for a claim that
 *      HAS an owner — i.e. only ever a CLI claim — so it loosens nothing for a pid-claim: two
 *      editors in one clone (`MODOKI_MULTI=1`) still refuse each other exactly as before, because
 *      neither of their claims carries an `owner`. */
/** ⚠️ `req.clone` is TRUSTED by case 3 below, which hands a CLI-owned claim to any request whose
 *  clone matches. Every caller today supplies it from a trustworthy source (`device.mjs`'s resolved
 *  repo root, or the default `process.cwd()`), so no steal is reachable — but the moment a caller
 *  threads a value in from a request body or an argv a stranger can set, that stops being true and
 *  this needs a real check rather than a comparison. Do not widen it casually. */
function isSameHolder(existing, req) {
  if (!existing.owner && existing.pid === process.pid) return true;
  if (req.owner && existing.owner === req.owner) return true;
  if (existing.owner && existing.clone === (req.clone ?? process.cwd())) return true;
  return false;
}

/** Take a device, or refuse naming who has it.
 *
 *  Re-claiming a device THIS process already holds is a no-op success, not a conflict: the lease
 *  reconnects, the WDA launcher and an install all legitimately claim the same phone within one
 *  session, and making them coordinate amongst themselves would put the arbitration back in the
 *  place this module took it out of. The claim is refreshed (a new timestamp, the latest purpose)
 *  so a long session cannot age out of its own TTL.
 *
 *  (#285) Compatibility is now decided by `isSameHolder`, not a bare pid comparison — see its
 *  comment for the three cases. On the compatible path the refreshed claim carries the REQUEST's
 *  `owner`/`ttlMs` (not the old claim's), so a CLI claim handed off to a fresh invocation with a
 *  new token, or an editor taking over from its own CLI, does not keep stale values around.
 *
 *  A CLI-owned claim (`req.owner` set) is written with `pid: 0`, never `process.pid`: a CLI claim
 *  must survive its (short-lived) process exiting, so it must never be revocable by some UNRELATED
 *  future process that happens to recycle that pid — `releaseAllForThisProcess` filters by pid, and
 *  a real pid there would let a totally different later process accidentally own/clear it. */
export function claimDevice(req, opts = {}) {
  const now = opts.now ?? Date.now();
  return withLock(() => {
    const live = readClaims().filter((c) => !isStale(c, opts));
    const existing = live.find((c) => c.deviceId === req.deviceId);
    if (existing && !isSameHolder(existing, req)) {
      return { ok: false, held: existing, message: describeConflict(existing, now) };
    }
    const claim = {
      deviceId: req.deviceId,
      clone: req.clone ?? process.cwd(),
      branch: req.branch ?? currentBranch(),
      pid: req.owner ? 0 : process.pid,
      at: now,
      ...(req.guid ? { guid: req.guid } : {}),
      ...(req.label ? { label: req.label } : {}),
      ...(req.purpose ? { purpose: req.purpose } : {}),
      ...(req.owner ? { owner: req.owner } : {}),
      ...(clampTtlMs(req.ttlMs) !== undefined ? { ttlMs: clampTtlMs(req.ttlMs) } : {}),
      ...(req.model ? { model: req.model } : {}),
      ...(req.osVersion ? { osVersion: req.osVersion } : {}),
    };
    writeClaims([...live.filter((c) => c.deviceId !== req.deviceId), claim]);
    // Only a pid-claim registers for the exit hook: an owner-claim's whole point is to outlive
    // this process, so this process must never auto-release it just by exiting.
    if (!req.owner) {
      held.add(req.deviceId);
      heldDir = claimsDir();
      installExitHook();
    }
    return { ok: true, claim };
  });
}

/** Give a device back. Only THIS process's claim is dropped — a release must never be able to
 *  revoke a sibling clone's hold, which would turn a stop-my-own-session action into a way to seize
 *  hardware from someone else. Stale entries are swept in the same write, since we hold the lock.
 *
 *  (#285) `opts.owner` widens "mine" for the CLI case: an owner-claim has no pid to match (it is
 *  written as 0, shared by every CLI invocation), so matching by pid alone would either release
 *  every owner-claim ever written (pid 0 === 0) or none. A release must never revoke a holder that
 *  is NOT you — that is why this drops by `(deviceId, owner)` when an owner is given, and by
 *  `(deviceId, pid, !owner)` otherwise, rather than simply "drop by deviceId". */
export function releaseDevice(deviceId, opts = {}) {
  withLock(() => {
    const all = readClaims();
    const next = all
      .filter((c) => !isStale(c, opts))
      .filter((c) => !(c.deviceId === deviceId && (opts.owner ? c.owner === opts.owner : (c.pid === process.pid && !c.owner))));
    // Write when anything went — our claim, or stale entries swept while we hold the lock. Compared
    // against the file as READ, so a pure stale-sweep still persists rather than being discarded.
    if (next.length !== all.length) writeClaims(next);
    held.delete(deviceId);
  });
}

/** Drop every claim held by this process — the editor is shutting down. Best-effort by design: a
 *  crash skips it entirely, which is exactly what pid-liveness expiry is for. */
export function releaseAllForThisProcess(opts = {}) {
  withLock(() => {
    const all = readClaims();
    const next = all.filter((c) => !isStale(c, opts)).filter((c) => c.pid !== process.pid);
    // Write ONLY when something actually goes. Unconditionally writing would make merely IMPORTING
    // this module (a test, a tool) create `~/.modoki/device-claims.json` on exit — a module with no
    // claims must leave no trace.
    if (next.length !== all.length) writeClaims(next);
    held.clear();
  });
}

/** Drop every claim whose holder is provably gone — from the FILE, not merely from a read.
 *
 *  Every reader already applies `isStale`, so a dead-pid claim never actually blocks anyone. That
 *  is measured, not assumed, and it is the half of #225 that was wrong: the report described a
 *  phone "locked out for the rest of a working day", and a probe with a synthetic dead-pid claim
 *  showed `listClaims()` returning `[]` and a sibling clone claiming the same device unrefused.
 *
 *  What a corpse in the file DOES do is lie to a human. `~/.modoki/device-claims.json` is a
 *  documented read surface — CLAUDE.md tells an agent to check it is clear of this clone after a
 *  session — and an entry naming this clone, this branch and a purpose reads exactly like a live
 *  hold. Twice that cost the reporter a hand-edit, and then an issue. So the fix is to make the
 *  file agree with the rule, rather than to change a rule that was already right.
 *
 *  Called at backend STARTUP, the same lifetime hook `reclaimStaleDeviceStateAtStartup` uses for
 *  adb forwards and for exactly the same reason: startup is the one teardown point that a crash, a
 *  `kill -9`, or the SIGTERM `stop-editor.sh` sends cannot skip. Writes only when something
 *  actually goes, so importing this module — or starting a backend on a machine with no claims —
 *  never creates the file.
 *
 *  Returns what it swept, so the caller can say so rather than cleaning up silently. */
export function sweepStaleClaims(opts = {}) {
  return withLock(() => {
    const all = readClaims();
    // Partition ONCE. Calling isStale twice — once to collect, once to filter the write — reads
    // the clock and probes the pid twice, so a claim that expires BETWEEN the two calls is dropped
    // from the file by the second and missing from the list returned by the first. The write would
    // still be right; the caller's "swept N" line would not, and a cleanup that misreports what it
    // cleaned is exactly the class of message #225 was filed about.
    const stale = [];
    const live = [];
    for (const c of all) (isStale(c, opts) ? stale : live).push(c);
    if (!stale.length) return [];
    writeClaims(live);
    return stale;
  });
}

/** Exactly what this process took, and from which claims dir — so the exit hook gives back what it
 *  holds rather than "whatever in the current file bears my pid".
 *
 *  The distinction is not theoretical: `claimsDir()` is read dynamically (that is how tests point it
 *  at a temp dir), so a hook that re-resolved it at exit would run against whatever `MODOKI_HOME`
 *  happened to be by then — a test process could reach the developer's REAL claims file and delete a
 *  live claim that merely shared a pid. Recording the pair makes that unreachable. */
const held = new Set();
let heldDir = null;

/** Give every claim back when this process exits — registered LAZILY, on the first successful claim,
 *  so a process that never claims anything never installs a hook and never touches the claims file.
 *
 *  `exit` only, deliberately. Adding SIGINT/SIGTERM listeners would SUPPRESS Node's default
 *  terminate-on-signal behaviour, changing how the editor shuts down to buy a tidier claims file —
 *  a bad trade. The uncovered cases (a signal, a crash, a `kill -9`) are exactly what pid-liveness
 *  expiry is for: the next clone to ask sees a dead pid and takes the device immediately. */
let exitHookInstalled = false;
function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    if (!held.size || !heldDir) return;
    // Everything below is synchronous fs — the only kind of work an `exit` handler can do. Pinned to
    // the dir the claims were TAKEN in, for the reason on `heldDir`.
    const prev = process.env.MODOKI_HOME;
    try {
      process.env.MODOKI_HOME = heldDir;
      for (const id of [...held]) releaseDevice(id);
    } catch { /* nothing left to do at exit */ } finally {
      if (prev === undefined) delete process.env.MODOKI_HOME; else process.env.MODOKI_HOME = prev;
    }
  });
}

/** The refusal text. Names the clone, the branch, when, and the pid — every one of which is a
 *  different way for the human to find the session that is holding their phone.
 *
 *  (#285) When `held.owner` is set, "pid N" is meaningless (pid is always 0 for an owner-claim), so
 *  this names the owner token instead and says the claim expires on a TTL rather than on process
 *  death — a CLI holder's process is expected to already be gone, so "process death" would read as
 *  a promise that never resolves. Owner-claims also get an actionable release command appended,
 *  since `device_disconnect` (the pid-claim release path) has nothing to disconnect for one. */
export function describeConflict(held, now = Date.now()) {
  const where = held.label ? `${held.label} (${held.deviceId})` : held.deviceId;
  const when = new Date(held.at).toLocaleTimeString();
  const mins = Math.max(0, Math.round((now - held.at) / 60000));
  const doing = held.purpose ? ` ${held.purpose}` : '';
  if (held.owner) {
    const ttl = held.ttlMs ?? CLI_CLAIM_TTL_MS;
    const remainingMins = Math.max(0, Math.round((held.at + ttl - now) / 60000));
    return `${where} is already claimed by clone ${held.clone} on branch ${held.branch}${doing} — `
      + `owner "${held.owner}" since ${when} (${mins} min ago), expiring in ${remainingMins} min `
      + '(a TTL, not process death — a CLI-owned claim has no process to check). Two sessions driving '
      + 'one phone interleave taps and install over each other, so this is refused rather than shared. '
      + `Release it with \`npm run device:release ${held.deviceId}\`, or use a different device.`;
  }
  return `${where} is already claimed by clone ${held.clone} on branch ${held.branch}${doing} — `
    + `since ${when} (${mins} min ago, pid ${held.pid}). Two sessions driving one phone interleave `
    + 'taps and install over each other, so this is refused rather than shared. Release it there '
    + '(device_disconnect, or quit that editor), or use a different device.';
}

/** Is `deviceId` held by a DIFFERENT clone than this one — the one check the BUILD path needs (#285
 *  sibling). `claim-guard.mjs` (the raw-CLI hook) and `device.mjs` each re-derive this same "is it
 *  someone else's" question inline; this is the ONE implementation, so a future caller — the build
 *  path here, or the next one — cannot re-derive it subtly differently (e.g. comparing raw strings
 *  and missing the trailing-slash case below).
 *
 *  Goes through `listClaims()`, never a raw file read, so staleness is applied exactly like every
 *  other reader (#225: a dead-pid record holds nothing, and treating one as live would refuse a
 *  build against the developer's OWN unclaimed phone for no reason).
 *
 *  "Different clone" compares RESOLVED paths, not raw strings — the same comparison
 *  `heldByThisClone` (`claim-guard.mjs`) and the WiFi-claim filter (`device.mjs`) already make, so a
 *  trailing slash cannot make this clone look like a stranger and refuse its own phone.
 *
 *  Returns the live `DeviceClaim` when the holder is foreign, else `null` — never throws, so a
 *  caller can drop it straight into a boolean/error branch without its own try/catch. */
export function foreignClaimFor(deviceId, opts = {}) {
  const clone = path.resolve(opts.clone ?? process.cwd());
  const held = listClaims(opts).find((c) => c.deviceId === deviceId);
  if (!held) return null;
  return path.resolve(held.clone) === clone ? null : held;
}

/** (#235 cross-process) The adb serial THIS clone currently holds a claim on, or `null`.
 *
 *  Exists because the build path's lease check was reading the WRONG COPY of the lease. The router
 *  that owns `deviceConnection` is mounted in TWO processes — the Electron backend
 *  (`electron/backendServer.ts`) and the Vite dev server (`plugins/vite-asset-scanner.ts`) — and
 *  `deviceConnection` is a module singleton, so each process holds its own in-memory lease state.
 *  `device_connect` opens the lease in the ELECTRON one; `Build -> Android` resolves its serial in
 *  the VITE one, where the lease is forever `disconnected`. So #235's fix never fired: the build
 *  refused with a message offering `device_connect {useAdb:true, serial}` and the AI panel's
 *  picker, both of which the caller had ALREADY done. Same class of dishonest refusal #235 set out
 *  to remove, one layer down.
 *
 *  The claims FILE is the cross-process state that in-memory singleton is not — the lease writes a
 *  claim here at connect and drops it at disconnect, and this is already how the sibling-clone
 *  check (`foreignClaimFor`, called from that same build path) works. So the fix is to read the
 *  lease from the place both processes can see, not to dedupe the singleton.
 *
 *  Deliberately covers CLI (`npm run device:claim`) and WDA claims too, not just the socket lease:
 *  the question the build asks is "which phone has this clone taken", and a clone that claimed a
 *  handset from a terminal means it just as much as one that opened a lease.
 *
 *  AMBIGUITY IS NOT RESOLVED HERE. Holding claims on two handsets returns `null` rather than a
 *  guess, so the caller falls through to the ordinary rule and refuses with both candidates named
 *  — the #149 contract. A silent first-match is the exact bug that rule exists to prevent.
 *
 *  Applied as a PREFERENCE by the caller, never a pin: `resolveBuildAndroidSerial` drops a claimed
 *  serial that is no longer attached, because a claim outlives a cable. */
export function ownAdbClaim(opts = {}) {
  const clone = path.resolve(opts.clone ?? process.cwd());
  const mine = listClaims(opts).filter(
    (c) => adbSerialOf(c.deviceId) !== undefined && path.resolve(c.clone) === clone,
  );
  return mine.length === 1 ? mine[0] : null;
}

/** This clone's branch, for the claim record. Read from `.git/HEAD` rather than by spawning git:
 *  claiming sits on the connect path and must not pay a process spawn, and a detached HEAD (or no
 *  git at all) is an unknown branch, never an error. */
function currentBranch() {
  try {
    const head = fs.readFileSync(path.join(process.cwd(), '.git', 'HEAD'), 'utf8').trim();
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return m ? m[1] : head.slice(0, 12);
  } catch {
    return 'unknown';
  }
}
