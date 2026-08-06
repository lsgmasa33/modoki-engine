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

import { spawn, execFileSync, type ChildProcess } from 'child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { wdaBaseDir } from '../../toolchain';
import { findXctestrun, wdaDerivedDataDir } from '../../toolchain/wdaProvision';

/** One iOS device `xcodebuild` could target. `connected` = a live tunnel right now. */
export interface IosDevice { udid: string; name: string; connected: boolean }

/** Pull the PAIRED iOS devices out of `xcrun devicectl list devices --json-output`, flagging which
 *  have a live tunnel. PURE, so the selection rule is testable without a phone.
 *
 *  Two things this gets right that a naive parse does not:
 *   - **`hardwareProperties.udid`, not the top-level `identifier`.** `xcodebuild -destination id=`
 *     wants the hardware UDID (`00008150-…`); devicectl's own `identifier` is a different GUID
 *     (`796DC698-…`) and xcodebuild does not accept it.
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
      hardwareProperties?: { udid?: string; platform?: string };
      deviceProperties?: { name?: string };
    };
    if (d.hardwareProperties?.platform !== 'iOS') continue;
    const udid = d.hardwareProperties?.udid;
    if (udid) {
      out.push({
        udid,
        name: d.deviceProperties?.name ?? udid,
        connected: d.connectionProperties?.tunnelState === 'connected',
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
    out.push({ udid: m[3], name: m[1], connected });
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
export const wdaLauncherExec = {
  listDevices(): string {
    const out = path.join(os.tmpdir(), `modoki-devicectl-${process.pid}.json`);
    try {
      execFileSync('xcrun', ['devicectl', 'list', 'devices', '--json-output', out], {
        timeout: 20000, stdio: 'ignore',
      });
      return fs.readFileSync(out, 'utf8');
    } finally {
      try { fs.rmSync(out, { force: true }); } catch { /* best-effort */ }
    }
  },
  /** The legacy listing (#143). Failure returns '' rather than throwing: this is an ADDITIVE
   *  source, so an Xcode without `xctrace` must leave the devicectl path working exactly as
   *  before, not break device selection outright. Bounded like every other exec here. */
  listLegacyDevices(): string {
    try {
      return execFileSync('xcrun', ['xctrace', 'list', 'devices'], {
        timeout: 20000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch { return ''; }
  },
};

/** Which iOS device to run WDA on, in strict precedence order:
 *
 *   1. `MODOKI_IOS_DEVICE_UDID` — explicit always wins, and a value that matches nothing is an
 *      ERROR rather than silently ignored (a typo must not fall through to "some other phone").
 *   2. The device with a live tunnel, if exactly one has one.
 *   3. The only paired device, if there is exactly one.
 *   4. Otherwise REFUSE, naming the candidates. Launching a signed agent on the wrong phone is
 *      surprising and slow to undo, so ambiguity is never resolved by a coin flip.
 *
 *  Step 4 is the common case on a Mac that has ever paired several iPhones — which is why the
 *  message names the env var: it is one-time config, not a bug. */
export function resolveIosDevice(
  devices: IosDevice[], env: NodeJS.ProcessEnv = process.env,
): { device: IosDevice } | { error: string } {
  const pinned = env.MODOKI_IOS_DEVICE_UDID?.trim();
  if (pinned) {
    const hit = devices.find((d) => d.udid === pinned);
    return hit ? { device: hit } : { error: `MODOKI_IOS_DEVICE_UDID=${pinned} matches none of this Mac's paired iOS devices` };
  }
  if (devices.length === 0) return { error: 'no iOS device is paired with this Mac' };
  const connected = devices.filter((d) => d.connected);
  if (connected.length === 1) return { device: connected[0] };
  if (devices.length === 1) return { device: devices[0] };
  const pool = connected.length > 1 ? connected : devices;
  return {
    error: `cannot tell which iPhone to use — ${pool.length} are paired (${pool.map((d) => `${d.name} ${d.udid}`).join(', ')}). `
      + 'Set MODOKI_IOS_DEVICE_UDID to the one you want (one-time).',
  };
}

// ── The running agent ─────────────────────────────────────────────────────────

let child: ChildProcess | null = null;
/** Why the last launch attempt failed. Kept so a repeated input op reports the SAME actionable
 *  cause instead of silently re-running a doomed 45-second spin-up on every tap. */
let lastFailure: string | null = null;
/** When the current launch was spawned, for the elapsed time in `launchInProgressReason`. Cleared
 *  with the child so a later launch never reports the previous one's age. */
let launchStartedAt: number | null = null;

/** True when we have a live agent process we started. */
export function isWdaProcessRunning(): boolean { return !!child && child.exitCode === null && !child.killed; }

/** Stop the agent we started. Called when the lease drops (Decision 2: WDA is torn down with the
 *  lease, so disconnecting can never strand a signed agent running on the phone). */
export function stopWda(): void {
  if (child && child.exitCode === null) { try { child.kill(); } catch { /* already gone */ } }
  child = null;
  launchStartedAt = null;
  lastFailure = null;
}

export interface EnsureWdaRunningOpts {
  /** Device LAN address from the lease — where WDA will answer. */
  host: string;
  port: number;
  /** Poll for readiness this long before giving up and letting the caller fall back. */
  timeoutMs?: number;
  /** Injected for tests. */
  probe?: (url: string) => Promise<boolean>;
  spawnImpl?: typeof spawn;
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
  // synchronous window is the ONLY thing making check-and-set atomic, and it is what lets this
  // module skip the `inFlight` promise-guard its neighbours carry (`getDeviceCdpSession`,
  // `inFlightBakes`, `platformInFlight`). Add an await in here — making the device listing async,
  // say — and two concurrent input ops both pass the guard and BOTH spawn a signed 60-second
  // agent, which is the bug #109 fixed wearing a different hat. Pinned by the concurrency test in
  // wdaLauncher.test.ts, which fails on the rearrangement rather than on the symptom.
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
  try { listing = (opts.listDevices ?? wdaLauncherExec.listDevices)(); }
  catch (e) {
    lastFailure = `could not list iOS devices (${e instanceof Error ? e.message : String(e)})`;
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
  const legacyDefault = opts.listDevices ? () => '' : wdaLauncherExec.listLegacyDevices;
  const legacy = (opts.listLegacyDevices ?? legacyDefault)();
  const resolved = resolveIosDevice(mergeIosDevices(parseIosDevices(listing), parseXctraceDevices(legacy)));
  if ('error' in resolved) {
    lastFailure = `cannot start WebDriverAgent — ${resolved.error}`;
    return { running: false, reason: lastFailure };
  }

  // Spawn detached-ish: we keep the handle so `stopWda` can end it with the lease, but its output
  // is discarded — a test runner's log is not something an input op should stream.
  const spawnFn = opts.spawnImpl ?? spawn;
  child = spawnFn('xcodebuild', [
    'test-without-building',
    '-xctestrun', xctestrun,
    '-destination', `id=${resolved.device.udid}`,
  ], { stdio: 'ignore' });
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
  if (!child) {
    return { running: false, reason: 'the WebDriverAgent process exited before the agent answered — check the build is still signed (Build Support → iOS), then try again' };
  }
  return { running: false, reason: launchInProgressReason(nowFn()) };
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
  return `WebDriverAgent has been starting for ${secs}s and is not answering yet — the launch is still `
    + 'running, so it will be picked up by a later call without starting another one. If it never '
    + 'comes up, reconnect the device lease to start over';
}

/** Test seam — forget any process handle and latched failure. */
export function _resetWdaLauncherForTests(): void { child = null; launchStartedAt = null; lastFailure = null; }
