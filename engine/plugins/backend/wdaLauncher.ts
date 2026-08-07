/**
 * Lazy WebDriverAgent launch (#32 Phase 2b) — plan Decision 1.
 *
 * WDA's HTTP server exists ONLY while an `xcodebuild test-without-building` process is alive; when
 * that exits, port 8100 dies with it. So "provisioned" (a signed build under the toolchain dir,
 * `wdaProvision.ts`) and "running" are two different states, and this module owns the second.
 *
 * Started LAZILY, on the first iOS input op that needs it — not when a device connects. An iOS
 * session that never sends input pays nothing and gains no new failure surface, which was the
 * objection to launching eagerly. The spin-up is paid once per session and cached.
 *
 * Failure is never fatal: a device_* input op falls back to synthetic and says so with the loud
 * banner. Losing WDA degrades INPUT, it does not drop the lease — screenshots, Percept reads and
 * everything else that never needed WDA keep working (Decision 2).
 *
 * macOS-ONLY, both to start and to use (#99). Starting one is an `xcodebuild` run, matching
 * `isInstallable('webdriveragent')`. Using one from elsewhere is technically possible — the agent
 * answers over the LAN and a Windows editor really did drive one end-to-end (measured 2026-08-03)
 * — but it is unreachable through the product: this module tears the agent down with the LEASE,
 * and the lease is exclusive, so a Mac cannot both hold one (which is what triggers the launch)
 * and leave it free for another machine. So the platform check runs FIRST and a non-macOS editor
 * pays nothing. docs/trusted-device-input.md carries the measurement and the reasoning.
 */

import { spawn, execFile, execFileSync, type ChildProcess } from 'child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { claimDevice, iosDeviceId, releaseDevice } from './deviceClaims';
import { wdaBaseDir } from '../../toolchain';
import { findXctestrun, wdaDerivedDataDir } from '../../toolchain/wdaProvision';

/** One iOS device `xcodebuild` could target. `connected` = a live tunnel right now.
 *
 *  `productType`/`osVersion` exist to be compared with what the LEASED device says about itself
 *  (#146) — see `resolveIosDevice`. Both optional: the legacy `xctrace` listing reports no model at
 *  all, so a pre-iPhone-X device carries only a version. */
export interface IosDevice {
  udid: string; name: string; connected: boolean;
  /** `hw.machine`, e.g. `iPhone18,4` — devicectl's `hardwareProperties.productType`. */
  productType?: string;
  /** e.g. `26.5.2`. ⚠️ devicectl reports this as of the LAST CONNECTION, so it can be stale. */
  osVersion?: string;
}

/** Pull the PAIRED iOS devices out of `xcrun devicectl list devices --json-output`, flagging which
 *  have a live tunnel. PURE, so the selection rule is testable without a phone.
 *
 *  Two things this gets right that a naive parse does not:
 *   - **`hardwareProperties.udid`, not the top-level `identifier`.** `xcodebuild -destination id=`
 *     wants the hardware UDID (`00008150-…`); devicectl's own `identifier` is a different GUID
 *     (`FACEFEED-…`) and xcodebuild does not accept it.
 *   - **`tunnelState` is a PREFERENCE, not a filter.** The obvious rule — keep only
 *     `tunnelState: 'connected'` — is too strict, and measured wrong: with the iPhone Air reporting
 *     `disconnected`, `xcodebuild test-without-building` still launched WDA fine (it establishes its
 *     own connection). Filtering on it rejected a perfectly reachable phone and reported "no iOS
 *     device is connected" with the device sitting right there. So every paired iOS device is a
 *     candidate, and `connected` only breaks ties. */
export function parseIosDevices(devicectlJson: string): IosDevice[] {
  let parsed: unknown;
  try { parsed = JSON.parse(devicectlJson); } catch { return []; }
  const devices = (parsed as { result?: { devices?: unknown[] } })?.result?.devices ?? [];
  const out: IosDevice[] = [];
  for (const raw of devices) {
    const d = raw as {
      connectionProperties?: { tunnelState?: string };
      hardwareProperties?: { udid?: string; platform?: string; productType?: string };
      deviceProperties?: { name?: string; osVersionNumber?: string };
    };
    if (d.hardwareProperties?.platform !== 'iOS') continue;
    const udid = d.hardwareProperties?.udid;
    if (udid) {
      out.push({
        udid,
        name: d.deviceProperties?.name ?? udid,
        connected: d.connectionProperties?.tunnelState === 'connected',
        ...(d.hardwareProperties?.productType ? { productType: d.hardwareProperties.productType } : {}),
        ...(d.deviceProperties?.osVersionNumber ? { osVersion: d.deviceProperties.osVersionNumber } : {}),
      });
    }
  }
  return out;
}

/** Pull iOS devices out of `xcrun xctrace list devices` — the LEGACY listing, and the only one
 *  that can see iOS 16 and older (#143).
 *
 *  `devicectl` is CoreDevice, which is iOS 17+. An older device appears in its JSON as a stub with
 *  no `udid` and no name (measured on an iPhone 8 / iOS 16.7.16:
 *  `{"platform":"iOS","model":"iPhone10,1","tunnel":"unavailable"}`), so `parseIosDevices` drops it
 *  — correctly, given what it was handed. The device was therefore unselectable for trusted input,
 *  and NOT EVEN `MODOKI_IOS_DEVICE_UDID` could reach it, because the pin is matched against that
 *  same list. That is every pre-iPhone-X handset, not one phone.
 *
 *  Format, which the parse depends on:
 *    == Devices ==
 *    Dev's MacBook Pro (98C84BED-…)           ← the Mac itself: NO OS version, so it cannot match
 *    iPhone8 (16.7.16) (deadbeef…)            ← name (os) (udid)
 *    == Devices Offline ==                    ← same shape, but not connected
 *    == Simulators ==                         ← skipped entirely
 *
 *  Requiring the `(os) (udid)` pair is what excludes the Mac without special-casing its name, and
 *  the section header decides `connected`. Note pre-iPhone-X UDIDs are 40 hex chars rather than the
 *  `00008xxx-…` form — `resolveIosDevice` compares UDIDs as opaque strings, so nothing downstream
 *  needed to change. PURE, so the parse is testable without Xcode. */
export function parseXctraceDevices(xctraceOutput: string): IosDevice[] {
  const out: IosDevice[] = [];
  let connected = false;
  let inDevices = false;
  for (const raw of xctraceOutput.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('==')) {
      // Anything that is not a device section (notably `== Simulators ==`) turns collection OFF,
      // so a future section cannot start silently feeding simulators into the device list.
      inDevices = /^==\s*Devices(\s+Offline)?\s*==$/.test(line);
      connected = inDevices && !/Offline/i.test(line);
      continue;
    }
    if (!inDevices || !line) continue;
    const m = /^(.*?)\s+\(([0-9]+(?:\.[0-9]+)*)\)\s+\(([0-9A-Fa-f][0-9A-Fa-f-]{7,})\)$/.exec(line);
    if (!m) continue;   // the Mac (no OS version), or a shape we do not recognise
    out.push({ udid: m[3], name: m[1], connected, osVersion: m[2] });
  }
  return out;
}

/** The devicectl list, plus any device only the legacy listing can see (#143). devicectl stays
 *  AUTHORITATIVE — it carries richer fields and is the only source for iOS 17+ — so a UDID present
 *  in both keeps the devicectl entry; the legacy parse only ADDS. Dedupe is exact rather than
 *  heuristic: where the two overlap they report byte-identical UDIDs (verified on hardware — the
 *  same phone's id came back character-for-character identical from both listings). */
export function mergeIosDevices(primary: IosDevice[], legacy: IosDevice[]): IosDevice[] {
  const seen = new Set(primary.map((d) => d.udid));
  return [...primary, ...legacy.filter((d) => !seen.has(d.udid))];
}

/** Overridable seam so tests never shell out.
 *
 *  ⚠️ `--json-output` MUST be a real file, never `/dev/stdout`. devicectl writes its human-readable
 *  table to stdout as well, so redirecting the JSON there interleaves the two and the result never
 *  parses — which surfaces as "no iOS device is connected" with a phone sitting right there.
 *  Measured 2026-08-03; the unit tests could not catch it because they inject the listing string,
 *  so the real command is only ever exercised on a Mac with a device attached. */
// Promisified rather than `execFileSync`: this backend runs INSIDE the Electron main process, so a
// SYNC spawn here blocks the whole editor's input for as long as the command takes — measured
// 1.3-1.4s per call, freezing drags mid-gesture every ~10s while the AI panel polled the cache
// (#168). Do not "simplify" these back to execFileSync; that is the exact regression #168 fixed.
const execFileAsync = promisify(execFile);

/** The argv for both listings, named ONCE so the sync and async seams below cannot drift apart.
 *  They are two ways to run the SAME command, and a divergence here would make the picker and the
 *  launcher disagree about what is attached — the one thing `listIosDevicesForSelection`'s banner
 *  says must never happen. */
const DEVICECTL_ARGV = (out: string): string[] => ['devicectl', 'list', 'devices', '--json-output', out];
const XCTRACE_ARGV = ['xctrace', 'list', 'devices'];
/**
 * Where devicectl is told to write its JSON — a fresh path PER CALL.
 *
 * ⚠️ It was `modoki-devicectl-<pid>.json`, one path for the whole process, and that was safe only
 * by accident: `execFileSync` blocked the single JS thread for the entire spawn→read→unlink cycle,
 * so two listings could not interleave. #168 made the POLLED listing async and removed that
 * accident — while leaving `ensureWdaRunning` on the sync twin — so the two can now overlap:
 *
 *   1. `/api/device/list` (polled every 2.5s) cache-misses, spawns devicectl, yields.
 *   2. A `device_tap` calls `ensureWdaRunning` → `listDevicesSync()`, which computes the SAME path
 *      and spawns a second devicectl. Blocking the JS thread does not stop the first OS process,
 *      which is still writing to that file.
 *   3. Either read can see a torn or already-unlinked file. `parseIosDevices` swallows a JSON
 *      failure and returns `[]`, so `resolveIosDevice` reports "no iOS device is paired with this
 *      Mac" — and `ensureWdaRunning` LATCHES that into `lastFailure`, which short-circuits every
 *      later call until the lease is dropped. A one-off file race becomes "trusted iOS input is
 *      degraded for the rest of the session", looking exactly like an unplugged phone.
 *
 * A per-call suffix makes the whole class unrepresentable, which is cheaper than serializing the
 * two seams. A COUNTER, not `Math.random()`: this file is bounded by the process, and a counter
 * keeps the name reproducible in a log.
 */
let devicectlSeq = 0;
const devicectlOutPath = (): string =>
  path.join(os.tmpdir(), `modoki-devicectl-${process.pid}-${++devicectlSeq}.json`);

export const wdaLauncherExec = {
  async listDevices(): Promise<string> {
    const out = devicectlOutPath();
    try {
      // stderr is PIPED, not ignored, for the same reason the launch pipes it (#144): the caller
      // turns a throw here into "could not list iOS devices (<message>)", and with stderr
      // discarded that message is `Command failed: xcrun devicectl …` — the command echoed back,
      // naming nothing. devicectl's own line (no Xcode, xcrun refusing, a broken CoreDevice) is
      // the only thing that says what to DO. stdout stays ignored: the JSON goes to a file, and
      // the human-readable table there is exactly what must not be read (see above).
      await execFileAsync('xcrun', DEVICECTL_ARGV(out), { timeout: 20000 });
      return fs.readFileSync(out, 'utf8');
    } finally {
      try { fs.rmSync(out, { force: true }); } catch { /* best-effort */ }
    }
  },
  /** The legacy listing (#143). Failure returns '' rather than throwing: this is an ADDITIVE
   *  source, so an Xcode without `xctrace` must leave the devicectl path working exactly as
   *  before, not break device selection outright. Bounded like every other exec here. */
  async listLegacyDevices(): Promise<string> {
    try {
      const { stdout } = await execFileAsync('xcrun', XCTRACE_ARGV, { timeout: 20000, encoding: 'utf8' });
      return stdout;
    } catch { return ''; }
  },

  // ── The SYNC twins, for `ensureWdaRunning` only ──────────────────────────────────────────────
  //
  // ⚠️ These are not leftovers, and they are not the thing #168 removed. #168 is about the POLLED
  // read: the AI panel hits `/api/device/list` every 2.5s, so a sync exec there froze the editor's
  // input every ~10s. `ensureWdaRunning` is the opposite case — a human-initiated launch that then
  // spends 60s spinning WebDriverAgent up, where 1.4s of sync exec costs nothing anyone can feel.
  //
  // What it DOES cost, if made async, is the await-free window documented at that call site: the
  // check-and-set from `isWdaProcessRunning()` down to `spawnFn(...)` is atomic only because no
  // `await` interleaves it, which is what lets this module skip the in-flight promise-guard its
  // neighbours carry. Awaiting the listing inside that window makes two concurrent input ops both
  // spawn a signed 60-second agent — #109 wearing a different hat, and `wdaLauncher.test.ts`'s
  // "two CONCURRENT input ops spawn exactly ONE agent" catches it (measured: 2 spawns, not 1).
  //
  // So the split is deliberate: async where it is polled, sync where it must be atomic. Both go
  // through the SAME argv above and the same parse+merge below, so the picker's list and the
  // launcher's list still cannot disagree.
  listDevicesSync(): string {
    const out = devicectlOutPath();
    try {
      execFileSync('xcrun', DEVICECTL_ARGV(out), { timeout: 20000, stdio: ['ignore', 'ignore', 'pipe'] });
      return fs.readFileSync(out, 'utf8');
    } finally {
      try { fs.rmSync(out, { force: true }); } catch { /* best-effort */ }
    }
  },
  listLegacyDevicesSync(): string {
    try {
      return execFileSync('xcrun', XCTRACE_ARGV, { timeout: 20000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { return ''; }
  },
};

/** Every iOS device this Mac could target, both listings merged (#149) — the read behind
 *  `/api/device/list`'s iOS half and the AI panel's device picker.
 *
 *  Shares `mergeIosDevices` + both parses with the launcher's own selection so the list a human
 *  picks from and the list `resolveIosDevice` chooses within can never disagree — a picker offering
 *  a device the launcher would then refuse to use is worse than no picker. Shells out twice
 *  (`devicectl`, then `xctrace`), each already bounded; returns `[]` rather than throwing, since a
 *  listing that cannot be produced is "none visible", not an error the caller can act on.
 *
 *  **`async`, not sync (#168).** This backend runs inside the Electron MAIN process, and the AI
 *  panel's device picker polls the route this feeds every 2.5s — a sync `execFileSync` here froze
 *  ALL editor input (mouse/keyboard forwarding to the renderer) for the ~1.4s the command took,
 *  every ~10s once the cache lapsed. Measured: 6 freezes of 1326-1425ms in 75s; zero once async.
 *  Do not revert this to a sync seam "for simplicity" — that reintroduces #168.
 *
 *  macOS-only in practice — both commands are `xcrun`. The caller gates on the platform. */
export async function listIosDevicesForSelection(): Promise<IosDevice[]> {
  const now = Date.now();
  if (iosListCache && now - iosListCache.at < IOS_LIST_TTL_MS) return iosListCache.devices;
  let primary: IosDevice[] = [];
  try { primary = parseIosDevices(await wdaLauncherExec.listDevices()); } catch { /* no Xcode / devicectl */ }
  const devices = mergeIosDevices(primary, parseXctraceDevices(await wdaLauncherExec.listLegacyDevices()));
  iosListCache = { at: now, devices };
  return devices;
}

/** Briefly cached, because this is TWO `xcrun` shell-outs and the AI panel's device picker polls
 *  the listing every 2.5s — measured at ~1.6-2.9s per uncached call, i.e. the poll would never stop
 *  paying for itself and would keep two `xcrun` processes almost permanently resident.
 *
 *  Short (10s), not memoized like the Android name cache: the set of PAIRED iPhones genuinely
 *  changes when someone plugs a phone in, and a picker that cannot see a just-connected device is
 *  the same "why isn't it listed" confusion this whole feature exists to remove. Ten seconds is
 *  below the threshold where a human re-checks, and four polls out of five now cost nothing. */
const IOS_LIST_TTL_MS = 10_000;
let iosListCache: { at: number; devices: IosDevice[] } | null = null;

/** Test seam — drop the cached listing so a test can change what `xcrun` reports. */
export function _clearIosListCache(): void { iosListCache = null; }

/** Test seam for the per-call temp path (see `devicectlOutPath`) — the ONLY way to assert the
 *  uniqueness that keeps a concurrent sync + async listing from sharing a file. */
export function _devicectlOutPath(): string { return devicectlOutPath(); }

/** What the LEASED device reports about its own hardware, for tying the launch to it (#146).
 *  Either field may be null — see `resolveIosDevice` for what that means.
 *
 *  **Structurally identical to `DeviceHardware` in `deviceConnection.ts`, which produces it, and
 *  deliberately NOT imported from there.** This module is pure — no import, so its rules are
 *  testable without the lease manager — and one type-only import in either direction would be a
 *  new module edge to carry two fields. The pairing is still enforced where it matters: the router
 *  passes `deviceHardware()` straight into `lease`, so ADDING a required field here fails that
 *  call's typecheck until the producer supplies it. (Adding one to the producer only is harmless —
 *  this side ignores what it does not read.) */
export interface LeaseHardware { deviceModel: string | null; osVersion: string | null }

/** Does this paired device contradict / confirm / say nothing about the leased one?
 *
 *  **`productType` decides; `osVersion` only breaks ties.** The model is immutable and both sides
 *  spell it identically (`hw.machine` on the phone, `hardwareProperties.productType` in devicectl),
 *  so a disagreement there is real. A version disagreement is NOT: devicectl reports the OS as of
 *  the device's LAST CONNECTION, so a phone that updated since would be excluded by its own
 *  freshness — a false "wrong phone" refusal, which is worse than the guess it replaced.
 *
 *  A device the listing knows no model for (every pre-iPhone-X handset, which only `xctrace` can
 *  see) is therefore always `'unknown'`: it can never be confirmed, and must never be contradicted
 *  on version alone. */
function leaseMatch(device: IosDevice, lease: LeaseHardware): 'confirms' | 'contradicts' | 'unknown' {
  if (!lease.deviceModel || !device.productType) return 'unknown';
  return device.productType === lease.deviceModel ? 'confirms' : 'contradicts';
}

/** The chosen device, plus a warning when the choice could not be tied to the lease. */
export interface IosDeviceChoice { device: IosDevice; unverified?: string }

/** Which iOS device to run WDA on, in strict precedence order:
 *
 *   1. `MODOKI_IOS_DEVICE_UDID` — explicit always wins, and a value that matches nothing is an
 *      ERROR rather than silently ignored (a typo must not fall through to "some other phone").
 *   2. **The device the LEASE is holding**, when the phone reported hardware we can match (#146).
 *      Exactly one match ⇒ that one, verified. No match at all, with a model to compare against,
 *      is an ERROR: the leased phone is not among the ones this Mac can drive, so every candidate
 *      is the wrong phone. Several matches narrow the pool and fall through.
 *   3. The device with a live tunnel, if exactly one has one.
 *   4. The only paired device, if there is exactly one.
 *   5. Otherwise REFUSE, naming the candidates. Launching a signed agent on the wrong phone is
 *      surprising and slow to undo, so ambiguity is never resolved by a coin flip.
 *
 *  Step 5 is the common case on a Mac that has ever paired several iPhones — which is why the
 *  message names the env var: it is one-time config, not a bug.
 *
 *  **Why step 2 exists.** Steps 3 and 4 pick on evidence that has NOTHING to do with the lease: an
 *  iOS lease is a WiFi address, and the phone at that address need not be the one plugged in — so
 *  with a single non-leased iPhone connected, step 3 would confidently start a signed 60-second
 *  agent on it (#146). It fails safe for INPUT (the readiness probe targets the lease host, so the
 *  stray agent never answers and the caller falls back to synthetic with the usual banner), but a
 *  surprise agent on someone else's phone is not something to resolve by guessing.
 *
 *  **Steps 3-5 are still reached, and still guess** — deliberately. A bridge older than #146
 *  reports no hardware, and refusing there would break every setup that works today until the game
 *  on the phone is redeployed. So the guess is kept and SAID: `unverified` carries the reason, the
 *  caller surfaces it, and the pin remains the way to make it certain. */
export function resolveIosDevice(
  devices: IosDevice[], env: NodeJS.ProcessEnv = process.env, lease?: LeaseHardware,
): IosDeviceChoice | { error: string } {
  const pinned = env.MODOKI_IOS_DEVICE_UDID?.trim();
  if (pinned) {
    const hit = devices.find((d) => d.udid === pinned);
    return hit ? { device: hit } : { error: `MODOKI_IOS_DEVICE_UDID=${pinned} matches none of this Mac's paired iOS devices` };
  }
  if (devices.length === 0) return { error: 'no iOS device is paired with this Mac' };

  let pool = devices;
  let unverified: string | undefined;
  if (lease?.deviceModel) {
    const confirmed = devices.filter((d) => leaseMatch(d, lease) === 'confirms');
    if (confirmed.length === 1) return { device: confirmed[0] };
    if (confirmed.length === 0) {
      const unknown = devices.filter((d) => leaseMatch(d, lease) === 'unknown');
      if (unknown.length === 0) {
        return {
          error: `the leased device reports itself as ${describeLease(lease)}, which matches none of this Mac's `
            + `paired iPhones (${devices.map((d) => `${d.name} ${d.productType ?? '?'}`).join(', ')}). `
            + 'Refusing rather than starting a signed agent on the wrong phone — pair the leased device with this '
            + 'Mac, or set MODOKI_IOS_DEVICE_UDID if it really is one of these.',
        };
      }
      // Only devices we know nothing about are left (a pre-iPhone-X handset the modern listing
      // cannot describe). Not a contradiction — but not a match either, so say so.
      pool = unknown;
      unverified = `no paired iPhone reports the leased device's model (${describeLease(lease)}), so the choice below could not be verified`;
    } else {
      // Several phones of the SAME model. The version is allowed to break that tie, since here it
      // can only narrow a set that already agrees on the immutable fact.
      const byVersion = lease.osVersion ? confirmed.filter((d) => !d.osVersion || d.osVersion === lease.osVersion) : confirmed;
      pool = byVersion.length === 1 ? byVersion : confirmed;
      if (pool.length === 1) return { device: pool[0] };
      unverified = `${pool.length} paired iPhones are a ${describeLease(lease)}, so the lease cannot say which is the leased one`;
    }
  } else {
    unverified = 'the device did not report its hardware (an app older than this editor), so the choice '
      + 'below is a guess from what is plugged into this Mac, not from the lease';
  }

  const warn = unverified ? { unverified } : {};
  const connected = pool.filter((d) => d.connected);
  if (connected.length === 1) return { device: connected[0], ...warn };
  if (pool.length === 1) return { device: pool[0], ...warn };
  const ambiguous = connected.length > 1 ? connected : pool;
  return {
    error: `cannot tell which iPhone to use — ${ambiguous.length} are paired (${ambiguous.map((d) => `${d.name} ${d.udid}`).join(', ')}). `
      + 'Set MODOKI_IOS_DEVICE_UDID to the one you want (one-time).',
  };
}

function describeLease(lease: LeaseHardware): string {
  return [lease.deviceModel, lease.osVersion ? `iOS ${lease.osVersion}` : null].filter(Boolean).join(' / ');
}

// ── The running agent ─────────────────────────────────────────────────────────

let child: ChildProcess | null = null;
/** Why the last launch attempt failed. Kept so a repeated input op reports the SAME actionable
 *  cause instead of silently re-running a doomed 45-second spin-up on every tap. */
let lastFailure: string | null = null;
/** When the current launch was spawned, for the elapsed time in `launchInProgressReason`. Cleared
 *  with the child so a later launch never reports the previous one's age. */
let launchStartedAt: number | null = null;
/** The tail of the last launch's stderr, kept so a failure can report the REASON rather than a
 *  guess (#144). Survives the child, since the diagnosis is wanted precisely once it has exited. */
let stderrTail: string[] = [];
/** Set when the launched device could NOT be tied to the lease (#146). Carried into every later
 *  message about this launch, because "we guessed which phone" stays true for as long as the agent
 *  runs — and a launch that then works would otherwise never mention it again. */
let launchWarning: string | null = null;
/** The machine-wide hardware claim this launch holds (#149), so `stopWda` hands back exactly what
 *  the launch took. Null when no agent is running. */
let claimedUdid: string | null = null;

/** How much of the child's stderr to keep. Both bounds matter: a test runner can emit megabytes,
 *  and one line of it can itself be enormous. */
const STDERR_TAIL_LINES = 20;
const STDERR_TAIL_LINE_CHARS = 400;

/** Keep the last few stderr lines of the launch, WITHOUT streaming them.
 *
 *  "Do not stream a test runner's log" and "keep nothing at all" are different decisions and only
 *  the first was intended (#144). Keeping nothing meant a launch failure could only ever be
 *  reported as a guess — and on #143's iPhone 8 the guess ("check the build is still signed") was
 *  simply wrong: the real cause was `Cannot test target "WebDriverAgentRunner" … Logic Testing
 *  Unavailable`, visible only by re-running the command by hand. That is the one error path an
 *  agent cannot investigate for itself, so whatever this message says IS the diagnosis.
 *
 *  Tolerates a child with no `stderr` (every injected test double, and a `stdio:'ignore'` spawn),
 *  because losing the diagnostic must never break the launch it is describing. */
function captureStderr(proc: ChildProcess): void {
  stderrTail = [];
  const stream = proc.stderr;
  if (!stream) return;
  let partial = '';
  stream.setEncoding?.('utf8');
  stream.on('data', (chunk: string) => {
    partial += chunk;
    const lines = partial.split('\n');
    partial = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) stderrTail.push(trimmed.slice(0, STDERR_TAIL_LINE_CHARS));
    }
    if (stderrTail.length > STDERR_TAIL_LINES) stderrTail = stderrTail.slice(-STDERR_TAIL_LINES);
  });
  stream.on('error', () => { /* the pipe died — we simply have no diagnostic */ });
}

/** The xcodebuild lines worth quoting, most specific first. Ordered rather than "last line wins"
 *  because the tail of a failed `xcodebuild` run is usually a summary (`** TEST EXECUTE FAILED **`)
 *  that names nothing, while the actionable line sits further up. */
const DIAGNOSTIC_PATTERNS: RegExp[] = [
  /^xcodebuild: error:/i,
  /^error:/i,
  /Cannot test target/i,
  /Unable to find a destination|IDERunDestination|Supported platforms/i,
  /code ?sign|provisioning profile|not registered|Developer Mode/i,
  /DVTDevice|DVTBuildVersion|Logic Testing Unavailable/i,
];

/** What a failed `execFileSync` actually said, preferring its stderr over its message (#144).
 *
 *  Node's message for a non-zero exit is `Command failed: <the command>` — the command echoed
 *  back, which the caller already knows. The tool's own line is the only part that says what to
 *  do about it. PURE and exported so the preference is testable without shelling out. */
export function describeExecFailure(e: unknown): string {
  const stderr = (e as { stderr?: unknown } | null)?.stderr;
  const text = typeof stderr === 'string' ? stderr : Buffer.isBuffer(stderr) ? stderr.toString('utf8') : '';
  const line = pickWdaFailureLine(text.split('\n').map((l) => l.trim()).filter(Boolean));
  if (line) return line;
  return e instanceof Error ? e.message : String(e);
}

/** The most specific captured line, or null when nothing was captured. PURE, so the ranking is
 *  testable without spawning anything. */
export function pickWdaFailureLine(lines: string[]): string | null {
  for (const pattern of DIAGNOSTIC_PATTERNS) {
    const hit = lines.find((l) => pattern.test(l));
    if (hit) return hit;
  }
  return lines.length > 0 ? lines[lines.length - 1] : null;
}

/** True when we have a live agent process we started. */
export function isWdaProcessRunning(): boolean { return !!child && child.exitCode === null && !child.killed; }

/** Stop the agent we started. Called when the lease drops (Decision 2: WDA is torn down with the
 *  lease, so disconnecting can never strand a signed agent running on the phone). */
export function stopWda(): void {
  if (child && child.exitCode === null) { try { child.kill(); } catch { /* already gone */ } }
  child = null;
  launchStartedAt = null;
  lastFailure = null;
  // Hand the phone back (#149). Done here rather than on the child's `exit` because THIS is the
  // point the device is genuinely free: an agent that exited on its own is about to be relaunched
  // by the next input op, and releasing the claim in between would let a sibling clone take the
  // device out from under a live session.
  if (claimedUdid) {
    try { releaseDevice(claimedUdid); } catch { /* an unwritable claims file must never block a stop */ }
    claimedUdid = null;
  }
  // The warning describes the launch we just ended; carrying it into the NEXT one would attach a
  // stale "could not verify" caveat to a launch that may well be verified. Same reasoning as
  // `launchStartedAt`. `stderrTail` is deliberately NOT cleared: the diagnosis is wanted after the
  // process is gone, and `captureStderr` resets it at the next spawn anyway.
  launchWarning = null;
}

export interface EnsureWdaRunningOpts {
  /** Device LAN address from the lease — where WDA will answer. */
  host: string;
  port: number;
  /** Poll for readiness this long before giving up and letting the caller fall back. */
  timeoutMs?: number;
  /** What the LEASED device says its own hardware is, so the launch can be tied to that phone
   *  rather than to whatever is plugged into this Mac (#146). Absent/null fields ⇒ unverified. */
  lease?: LeaseHardware;
  /** Injected for tests. */
  probe?: (url: string) => Promise<boolean>;
  spawnImpl?: typeof spawn;
  /** Sync in tests (a plain string-returning function) is fine — `await` on a non-promise is a
   *  no-op — but the real seam (`wdaLauncherExec.listDevices`) is async (#168): this runs in the
   *  Electron main process, so a sync spawn here would freeze the whole editor's input. */
  listDevices?: () => string;
  /** The legacy `xctrace` listing (#143) — injected separately so a test can prove the union. */
  listLegacyDevices?: () => string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Injected so the non-macOS refusal is testable from a Mac (and vice versa). */
  platform?: NodeJS.Platform;
  /** The provisioned `.xctestrun` to run. Defaults to whatever Build Support built under the
   *  toolchain dir; injected by tests so they need neither a toolchain dir nor a real build. */
  xctestrun?: string | null;
}

/** Locate the `.xctestrun` Build Support produced, or explain why there isn't one. */
function provisionedXctestrun(): { path: string } | { error: string } {
  const base = wdaBaseDir();
  if (!base) return { error: 'no toolchain directory, so WebDriverAgent cannot be provisioned (this is a plain dev editor)' };
  const found = findXctestrun(wdaDerivedDataDir(base));
  return found ? { path: found } : { error: 'WebDriverAgent is not built — install it from Build Support (iOS)' };
}

/** How long to wait for a freshly-spawned agent to answer. Measured spin-up was ~35s cold; the
 *  extra headroom covers a first run that also has to install the runner onto the phone. */
const DEFAULT_LAUNCH_TIMEOUT_MS = 60_000;

/** How long a single `/status` probe may take before we call it "not answering".
 *
 *  MUST be bounded, and this is the whole of #99's Claim-1 cost. An unbounded `fetch` waits out the
 *  OS connect timeout, which differs per platform AND per how the phone refuses — measured
 *  2026-08-03 against a dead :8100: **2.5s from Windows** and ~1.0s from macOS against an iPhone
 *  (which silently drops), ~0.4s against an Android phone (which sends RST). Three prices for the
 *  same line, none of them chosen. A live agent answered in **72–227ms** over the same LAN, so this
 *  budget is an order of magnitude above the real thing while capping the failure case. */
export const WDA_PROBE_TIMEOUT_MS = 1500;

async function defaultProbe(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(WDA_PROBE_TIMEOUT_MS) });
    if (!res.ok) return false;
    const body = await res.json() as { value?: { ready?: boolean } };
    return body?.value?.ready === true;
  } catch { return false; }
}

/**
 * Make sure WDA is answering on the device, launching it if not.
 *
 * Returns `{running:true}` when the agent is up (already, or after we started it). Otherwise
 * `{running:false, reason}` — an actionable string the caller puts in the synthetic-fallback
 * banner. NEVER throws: an input op must degrade, not fail.
 */
export async function ensureWdaRunning(opts: EnsureWdaRunningOpts): Promise<{ running: boolean; reason?: string }> {
  const probe = opts.probe ?? defaultProbe;
  const statusUrl = `http://${opts.host}:${opts.port}/status`;

  // Off macOS there is NOTHING to reach and nothing to start, so refuse FIRST — before spending a
  // network probe (#99).
  //
  // This ordering was the other way round, deliberately: starting an agent is macOS-only but USING
  // one is not, so a Windows editor probed first in case a Mac on the LAN had one running. That
  // capability is real — measured end-to-end from the Windows clone on 2026-08-03, `[input:
  // trusted-wda]` with `isTrusted:true` and a 227ms `/status`. It is nonetheless UNREACHABLE
  // through the product, which is why the ordering is now gone: the Mac editor tears its agent
  // down WITH the lease (Decision 2) and the device lease is EXCLUSIVE, so a Mac cannot both hold
  // a lease (what triggers its lazy launch) and leave that lease free for Windows to take. The
  // only way to produce a Windows-drivable agent is a hand-run `xcodebuild test-without-building`
  // outside the editor entirely. Charging every non-macOS input op an unbounded probe to serve a
  // workflow the product cannot produce was the wrong trade — measured at ~2.5s per tap on
  // Windows. See docs/trusted-device-input.md for the full measurement and the reasoning.
  //
  // Latched like any other permanent cause: the platform cannot change mid-session.
  if ((opts.platform ?? process.platform) !== 'darwin') {
    lastFailure = 'WebDriverAgent needs macOS + Xcode, so it cannot be started or used from this '
      + 'editor — iOS input here is synthetic. Drive the device from a Mac editor for trusted input';
    return { running: false, reason: lastFailure };
  }

  // Already up — including a WDA someone started by hand, which must not be duplicated.
  if (await probe(statusUrl)) return { running: true };

  // ⚠️ INVARIANT: from this guard down to `child = spawnFn(...)` there must be NO `await`. That
  // synchronous window is the ONLY thing making check-and-set atomic, which is what lets this
  // module skip the in-flight promise-guard its neighbours carry (`getDeviceCdpSession`,
  // `inFlightBakes`, `platformInFlight`). Add an await in here — making the device listing async,
  // say — and two concurrent input ops both pass the guard and BOTH spawn a signed 60-second
  // agent, which is the bug #109 fixed wearing a different hat. Pinned by the concurrency test in
  // `wdaLauncher.test.ts`.
  //
  // ⚠️ #168 is exactly that temptation, and it was tried: making these two seams async reopened the
  // double-spawn and the test caught it (2 spawns, not 1 — measured, not assumed). The listing here
  // therefore uses the SYNC twins on `wdaLauncherExec` while the POLLED read
  // (`listIosDevicesForSelection`) uses the async ones. See the twins' banner for why that split is
  // right rather than a leftover: sync exec is free in a 60s human-initiated launch and ruinous in
  // a route polled every 2.5s from the Electron main process.
  //
  // A launch WE started is still running but not answering yet (#109). Report that and return —
  // never spawn a second one. This is the half that makes "do not kill it on timeout" safe: the
  // launcher is otherwise not idempotent w.r.t. an in-flight launch, so an agent left running would
  // simply be joined by another on the next tap, which is worse than the bug being fixed. Cheap by
  // construction: the caller pays one bounded probe rather than a fresh 60s spin-up.
  const nowFn = opts.now ?? Date.now;
  if (isWdaProcessRunning()) return { running: false, reason: launchInProgressReason(nowFn()) };

  // A previous attempt failed for a reason that will not fix itself between two taps (no device,
  // not provisioned, ambiguous device). Report it again rather than burn another spin-up per call.
  if (lastFailure) return { running: false, reason: lastFailure };

  let xctestrun: string;
  if (opts.xctestrun) {
    xctestrun = opts.xctestrun;
  } else {
    const found = provisionedXctestrun();
    if ('error' in found) {
      lastFailure = found.error;
      return { running: false, reason: lastFailure };
    }
    xctestrun = found.path;
  }

  let listing: string;
  try { listing = (opts.listDevices ?? wdaLauncherExec.listDevicesSync)(); }
  catch (e) {
    lastFailure = `could not list iOS devices (${describeExecFailure(e)})`;
    return { running: false, reason: lastFailure };
  }
  // Union with the legacy listing so an iOS 16-or-older device is selectable at all (#143). Kept
  // outside the try above deliberately: this source is ADDITIVE and swallows its own failure, so it
  // must not turn a working devicectl listing into "could not list iOS devices".
  //
  // Note what the default is tied to: injecting `listDevices` (a test) implies a HERMETIC device
  // listing, so the legacy source defaults to empty there rather than to the real `xctrace`.
  // Without that, every existing test that injected only the primary listing silently shelled out
  // to this Mac's actual hardware and merged it in — six of them failed, one after 61 REAL seconds.
  // A seam that is injectable only halfway is worse than none: it makes unit tests depend on which
  // phones happen to be plugged in.
  const legacyDefault = opts.listDevices ? () => '' : wdaLauncherExec.listLegacyDevicesSync;
  const legacy = (opts.listLegacyDevices ?? legacyDefault)();
  const resolved = resolveIosDevice(
    mergeIosDevices(parseIosDevices(listing), parseXctraceDevices(legacy)), process.env, opts.lease,
  );
  if ('error' in resolved) {
    lastFailure = `cannot start WebDriverAgent — ${resolved.error}`;
    return { running: false, reason: lastFailure };
  }
  // An unverified choice is REPORTED, not refused (#146) — see `resolveIosDevice`'s last paragraph
  // for why. Latched onto the launch so every later message about it carries the caveat too: the
  // agent may well come up and answer, in which case nothing else would ever mention that the
  // phone it is running on was picked by guesswork.
  launchWarning = resolved.unverified
    ? `⚠️  WebDriverAgent was started on ${resolved.device.name} (${resolved.device.udid}), but ${resolved.unverified}. `
      + 'If input is landing on the wrong phone, set MODOKI_IOS_DEVICE_UDID.'
    : null;
  if (launchWarning) console.warn(`[wda] ${launchWarning}`);

  // Claim the PHONE before spawning an agent on it (#149 part 2). `wdaLauncher` already guards
  // against a second launch by THIS process (`child` above); what it could not see is a second
  // CLONE spawning a rival signed agent on the same device — two agents fighting over port 8100 on
  // one phone, with neither session aware of the other. The claim is machine-wide, so it can.
  //
  // Refusing here is safe by construction: a failed launch is never fatal on this surface (the
  // module header — input degrades to synthetic with the loud banner), so the caller already
  // handles "no agent" and now gets a reason that names the clone holding the device.
  const claim = claimDevice({
    deviceId: iosDeviceId(resolved.device.udid),
    label: resolved.device.name,
    purpose: 'running WebDriverAgent',
  });
  if (!claim.ok) {
    lastFailure = `cannot start WebDriverAgent — ${claim.message}`;
    return { running: false, reason: lastFailure };
  }
  claimedUdid = iosDeviceId(resolved.device.udid);

  // Spawn detached-ish: we keep the handle so `stopWda` can end it with the lease. stdout stays
  // discarded — a test runner's log is not something an input op should stream — but stderr is
  // PIPED into a small ring buffer so a failure can name its own cause (#144, `captureStderr`).
  const spawnFn = opts.spawnImpl ?? spawn;
  child = spawnFn('xcodebuild', [
    'test-without-building',
    '-xctestrun', xctestrun,
    '-destination', `id=${resolved.device.udid}`,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  captureStderr(child);
  child.on('exit', () => { child = null; launchStartedAt = null; });
  launchStartedAt = nowFn();

  // Poll rather than parse the log: readiness is a property of the SERVER, and `/status` answering
  // `ready:true` is the only thing that actually matters to the next input op.
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = nowFn() + (opts.timeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS);
  while (nowFn() < deadline) {
    await sleep(1000);
    if (await probe(statusUrl)) return { running: true };
    if (!child) break;   // the test process died — no point waiting out the clock
  }

  // Do NOT latch this one: a timeout can be a slow first install, and a later call may well find it
  // up. Latching would turn a transient into a permanent synthetic fallback for the session.
  //
  // And do NOT kill it either (#109). The previous revision called `stopWda()` here and then said
  // "it may still be starting; retry shortly" — advice whose premise the kill had just destroyed.
  // It could not still be starting, so "a later call may find it up" could never happen, and the
  // next input op paid the whole 60s again to spawn-then-kill another signed agent on the phone,
  // indefinitely, with no backoff. Leaving it running costs nothing: it is still owned by the lease
  // and `stopWda()` on disconnect still guarantees nothing is stranded (Decision 2). A slow install
  // now gets to FINISH, and the guard above turns every later call into one bounded probe.
  if (!child) return { running: false, reason: wdaExitedReason() };
  return { running: false, reason: launchInProgressReason(nowFn()) };
}

/** Why the launch process died, quoting xcodebuild where it said something (#144).
 *
 *  The signing hint is kept, but DEMOTED to what it always was — a guess — and used only when
 *  nothing was captured. It was previously stated unconditionally as though it were the diagnosis,
 *  and on an iOS 16 device it was actively misleading: re-signing could never have helped, and the
 *  hour spent trying is what this function exists to prevent. */
function wdaExitedReason(): string {
  const line = pickWdaFailureLine(stderrTail);
  const why = line
    ? `the WebDriverAgent process exited before the agent answered — xcodebuild said: ${line}`
    : 'the WebDriverAgent process exited before the agent answered, and said nothing on stderr '
      + '— check the build is still signed (Build Support → iOS), then try again';
  return withLaunchWarning(why);
}

/** Append the "we could not verify which phone" caveat to a reason, when there is one (#146). It
 *  belongs on EVERY message about this launch: a failure whose real cause is "that agent went to
 *  the other phone" is otherwise indistinguishable from one that did not. */
function withLaunchWarning(reason: string): string {
  return launchWarning ? `${reason}\n${launchWarning}` : reason;
}

/** The "still coming up" reason, shared by the timeout return and the already-launching guard.
 *
 *  Reports the ELAPSED time rather than a bare "retry shortly", because that is what makes the
 *  message self-diagnosing without inventing a give-up policy: 20s reads as normal, 5 minutes reads
 *  as wedged, and the reader can tell which without knowing our timeouts. The escape hatch is named
 *  for the same reason — reconnecting the lease runs `stopWda()`, so there IS a way to start over,
 *  and a message that admits no way out invites someone to invent one. */
function launchInProgressReason(nowMs: number): string {
  const secs = launchStartedAt === null ? 0 : Math.max(0, Math.round((nowMs - launchStartedAt) / 1000));
  return withLaunchWarning(
    `WebDriverAgent has been starting for ${secs}s and is not answering yet — the launch is still `
    + 'running, so it will be picked up by a later call without starting another one. If it never '
    + 'comes up, reconnect the device lease to start over',
  );
}

/** Test seam — forget any process handle and latched failure. */
export function _resetWdaLauncherForTests(): void {
  child = null; launchStartedAt = null; lastFailure = null; launchWarning = null; stderrTail = [];
}
