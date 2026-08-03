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
 * STARTING one is macOS-only (it is an xcodebuild run), matching `isInstallable('webdriveragent')`.
 * USING one is not: the agent answers over the LAN, so a Windows/Linux editor can drive an agent a
 * Mac started — which is why the reachability probe runs before the platform check.
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

/** True when we have a live agent process we started. */
export function isWdaProcessRunning(): boolean { return !!child && child.exitCode === null && !child.killed; }

/** Stop the agent we started. Called when the lease drops (Decision 2: WDA is torn down with the
 *  lease, so disconnecting can never strand a signed agent running on the phone). */
export function stopWda(): void {
  if (child && child.exitCode === null) { try { child.kill(); } catch { /* already gone */ } }
  child = null;
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

async function defaultProbe(url: string): Promise<boolean> {
  try {
    const res = await fetch(url);
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

  // Already up — including a WDA someone started by hand, which must not be duplicated. Probed
  // BEFORE the platform check on purpose: a Windows/Linux editor can still USE an agent someone
  // started on a Mac (it is reached over the LAN, not locally), it just cannot start one.
  if (await probe(statusUrl)) return { running: true };

  // Building and launching WDA both need Xcode, so off macOS this can only ever fail. `xcrun`
  // does not exist there, and `isInstallable('webdriveragent')` is already darwin-gated — leaving
  // the LAUNCH ungated made the two disagree, and shelled out on every first input op to a binary
  // that cannot be there. Latched like any other permanent cause.
  if ((opts.platform ?? process.platform) !== 'darwin') {
    lastFailure = 'WebDriverAgent needs macOS + Xcode, so it cannot be started from this editor '
      + '(it can still be used if a Mac on the network is running one)';
    return { running: false, reason: lastFailure };
  }

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
  const resolved = resolveIosDevice(parseIosDevices(listing));
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
  child.on('exit', () => { child = null; });

  // Poll rather than parse the log: readiness is a property of the SERVER, and `/status` answering
  // `ready:true` is the only thing that actually matters to the next input op.
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.timeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS);
  while (now() < deadline) {
    await sleep(1000);
    if (await probe(statusUrl)) return { running: true };
    if (!child) break;   // the test process died — no point waiting out the clock
  }

  // Do NOT latch this one: a timeout can be a slow first install, and the next call may well find
  // it up. Latching would turn a transient into a permanent synthetic fallback for the session.
  stopWda();
  return { running: false, reason: 'WebDriverAgent did not become ready in time — it may still be starting; retry shortly' };
}

/** Test seam — forget any process handle and latched failure. */
export function _resetWdaLauncherForTests(): void { child = null; lastFailure = null; }
