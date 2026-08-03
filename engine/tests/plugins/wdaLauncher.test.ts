import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  parseIosDevices, resolveIosDevice, ensureWdaRunning, stopWda,
  isWdaProcessRunning, _resetWdaLauncherForTests,
} from '../../plugins/backend/wdaLauncher';

/**
 * Lazy WebDriverAgent launch (#32 Phase 2b). No Xcode, no phone — `spawn`, the device listing and
 * the readiness probe are all injected.
 *
 * The two behaviours worth guarding both fail QUIETLY in production: picking the wrong phone (a
 * signed agent launches somewhere surprising), and re-running a doomed 60-second spin-up on every
 * single tap because a permanent failure was not remembered.
 */

/** A devicectl listing. Every phone ever paired stays listed forever, and `tunnelState` says which
 *  has a live tunnel right now — a PREFERENCE when choosing, never a filter (see the tests). */
function listing(devices: Array<{ udid: string; name: string; state?: string; platform?: string }>): string {
  return JSON.stringify({
    result: {
      devices: devices.map((d) => ({
        identifier: `GUID-${d.udid}`,   // devicectl's own id — deliberately NOT what we use
        connectionProperties: { tunnelState: d.state ?? 'connected', pairingState: 'paired' },
        hardwareProperties: { udid: d.udid, platform: d.platform ?? 'iOS' },
        deviceProperties: { name: d.name },
      })),
    },
  });
}

beforeEach(() => _resetWdaLauncherForTests());

describe('parseIosDevices', () => {
  it('keeps EVERY paired iOS device, flagging which has a live tunnel', () => {
    // Filtering on `tunnelState` was the obvious rule and it was measured WRONG: xcodebuild
    // launched WDA fine on a device reporting `disconnected` (it opens its own connection), so
    // filtering rejected a reachable phone and reported "no device" with one sitting right there.
    // Tunnel state is a tie-breaker, not a gate.
    const out = parseIosDevices(listing([
      { udid: 'A', name: 'Air' },
      { udid: 'B', name: 'Old', state: 'disconnected' },
      { udid: 'C', name: 'Older', state: 'disconnected' },
    ]));
    expect(out.filter((d) => d.connected)).toEqual([{ udid: 'A', name: 'Air', connected: true }]);
    expect(out).toHaveLength(3);   // all three are CANDIDATES; only the tunnel state differs
  });

  it('reports the HARDWARE udid, which is the only form xcodebuild accepts', () => {
    // devicectl's top-level `identifier` is a different GUID; `-destination id=<that>` does not work.
    const [d] = parseIosDevices(listing([{ udid: '00008150-00041CAA3AB8401C', name: 'Air' }]));
    expect(d.udid).toBe('00008150-00041CAA3AB8401C');
    expect(d.udid).not.toMatch(/^GUID-/);
  });

  it('ignores non-iOS devices and survives junk', () => {
    expect(parseIosDevices(listing([{ udid: 'W', name: 'Watch', platform: 'watchOS' }]))).toEqual([]);
    expect(parseIosDevices('not json')).toEqual([]);
    expect(parseIosDevices('{}')).toEqual([]);
  });
});

describe('resolveIosDevice — never guess which phone', () => {
  const A = { udid: 'A', name: 'Air', connected: true };
  const B = { udid: 'B', name: 'Mini', connected: false };

  it('uses the only paired device', () => {
    expect(resolveIosDevice([A], {})).toEqual({ device: A });
  });

  it('prefers the one with a LIVE tunnel when several are paired', () => {
    // A live tunnel is the strongest available evidence of "the phone on the desk right now".
    expect(resolveIosDevice([B, A], {})).toEqual({ device: A });
  });

  it('REFUSES when the choice is genuinely ambiguous, naming the candidates AND the fix', () => {
    // Launching a signed agent on the wrong phone is surprising and slow to undo, so ambiguity is
    // an error with an actionable fix, not a coin flip. This is the common case on a Mac that has
    // paired several iPhones over the years — hence the env var in the message.
    const bothIdle = [{ ...A, connected: false }, B];
    const r = resolveIosDevice(bothIdle, {});
    expect(r).toHaveProperty('error');
    expect((r as { error: string }).error).toMatch(/Air/);
    expect((r as { error: string }).error).toMatch(/Mini/);
    expect((r as { error: string }).error).toMatch(/MODOKI_IOS_DEVICE_UDID/);
  });

  it('an explicit UDID wins, and a wrong one is refused rather than ignored', () => {
    // A typo must not silently fall through to "some other phone".
    expect(resolveIosDevice([A, B], { MODOKI_IOS_DEVICE_UDID: 'B' })).toEqual({ device: B });
    expect(resolveIosDevice([A, B], { MODOKI_IOS_DEVICE_UDID: 'ZZZ' })).toHaveProperty('error');
  });

  it('says so when nothing is paired', () => {
    expect(resolveIosDevice([], {})).toEqual({ error: 'no iOS device is paired with this Mac' });
  });
});

describe('the real devicectl invocation', () => {
  it('never writes its JSON to /dev/stdout', () => {
    // Found LIVE, not here: `--json-output /dev/stdout` interleaves devicectl's human-readable
    // table with the JSON, so it never parses — and the failure presents as "no iOS device is
    // connected" with a phone sitting right there. These tests inject the listing string, so the
    // real command is only exercised on a Mac with a device attached; this asserts the shape of
    // the command itself, which is the part they cannot reach.
    const src = readFileSync(path.join(__dirname, '../../plugins/backend/wdaLauncher.ts'), 'utf8');
    const call = src.slice(src.indexOf('listDevices()'), src.indexOf('listDevices()') + 600);
    expect(call).toContain('--json-output');
    expect(call).not.toMatch(/--json-output'?,?\s*'\/dev\/stdout'/);
  });
});

describe('ensureWdaRunning', () => {
  const fastSleep = async () => {};
  const okProbe = async () => true;
  const deadProbe = async () => false;

  it('does NOT spawn when WDA is already answering — including one started by hand', async () => {
    const spawnImpl = vi.fn();
    const r = await ensureWdaRunning({ host: 'd', port: 8100, probe: okProbe, spawnImpl: spawnImpl as never });
    expect(r).toEqual({ running: true });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('REFUSES off macOS without shelling out — xcrun cannot exist there', async () => {
    // Found in the #32 close-out sweep. `isInstallable('webdriveragent')` is darwin-gated, so WDA
    // can never be PROVISIONED off macOS — but the LAUNCH was ungated, so a Windows/Linux editor
    // would shell out to a binary that cannot be there on every first input op. The two must agree.
    const listDevices = vi.fn(() => listing([{ udid: 'A', name: 'Air' }]));
    const spawnImpl = vi.fn();
    const r = await ensureWdaRunning({
      host: 'd', port: 8100, probe: deadProbe, sleep: fastSleep, xctestrun: '/fake/WDA.xctestrun',
      listDevices, spawnImpl: spawnImpl as never, platform: 'win32',
    });
    expect(r.running).toBe(false);
    expect(r.reason).toMatch(/macOS \+ Xcode/);
    expect(listDevices).not.toHaveBeenCalled();
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('but a REMOTE agent already running is still usable off macOS', async () => {
    // The probe runs BEFORE the platform check on purpose: WDA is reached over the LAN, so a
    // Windows editor can drive an agent a Mac started. Refusing outright would remove a capability
    // that actually works.
    const r = await ensureWdaRunning({ host: 'd', port: 8100, probe: okProbe, platform: 'win32' });
    expect(r).toEqual({ running: true });
  });

  // `platform: 'darwin'` is pinned on every call below that expects to reach the MACOS path.
  // Omitting it inherits `process.platform`, which is darwin on a Mac clone and passes locally —
  // but on CI's ubuntu/windows legs `ensureWdaRunning` short-circuits with "needs macOS + Xcode",
  // so all six of these assertions failed there while `npm test` stayed green here. The two tests
  // above deliberately omit it: their probe answers first, and the reachability check runs BEFORE
  // the platform gate (a non-Mac editor can still drive an agent someone else started).
  it('REMEMBERS a permanent failure instead of retrying a 60s spin-up on every tap', async () => {
    // "No device connected" cannot fix itself between two taps. Without this latch, every input op
    // pays the full timeout — which reads as the tool hanging.
    const listDevices = vi.fn(() => listing([]));
    const first = await ensureWdaRunning({ host: 'd', port: 8100, probe: deadProbe, listDevices, sleep: fastSleep, xctestrun: '/fake/WDA.xctestrun', platform: 'darwin' });
    expect(first.running).toBe(false);
    expect(first.reason).toMatch(/no iOS device is paired/);

    const second = await ensureWdaRunning({ host: 'd', port: 8100, probe: deadProbe, listDevices, sleep: fastSleep, xctestrun: '/fake/WDA.xctestrun', platform: 'darwin' });
    expect(second).toEqual(first);
    expect(listDevices).toHaveBeenCalledTimes(1);   // not re-probed — the answer was latched
  });

  it('reports an ambiguous device choice as the actionable cause', async () => {
    const r = await ensureWdaRunning({
      host: 'd', port: 8100, probe: deadProbe, sleep: fastSleep, xctestrun: '/fake/WDA.xctestrun',
      listDevices: () => listing([{ udid: 'A', name: 'Air' }, { udid: 'B', name: 'Mini' }]),
      platform: 'darwin',
    });
    expect(r.running).toBe(false);
    expect(r.reason).toMatch(/MODOKI_IOS_DEVICE_UDID/);
  });

  it('never throws when the device listing blows up — an input op must DEGRADE, not fail', async () => {
    const r = await ensureWdaRunning({
      host: 'd', port: 8100, probe: deadProbe, sleep: fastSleep, xctestrun: '/fake/WDA.xctestrun',
      listDevices: () => { throw new Error('xcrun missing'); },
      platform: 'darwin',
    });
    expect(r.running).toBe(false);
    expect(r.reason).toMatch(/could not list iOS devices/);
  });

  it('does NOT latch a timeout — a slow first install must not disable WDA for the session', async () => {
    // The distinction from the permanent-failure latch above: a timeout can simply mean the agent
    // is still installing onto the phone, and the next call may well find it up.
    const proc = { exitCode: null, killed: false, kill() { this.killed = true; }, on() {} };
    const spawnImpl = vi.fn(() => proc);
    const opts = {
      host: 'd', port: 8100, probe: deadProbe, sleep: fastSleep, xctestrun: '/fake/WDA.xctestrun',
      listDevices: () => listing([{ udid: 'A', name: 'Air' }]),
      spawnImpl: spawnImpl as never,
      platform: 'darwin' as NodeJS.Platform,
      timeoutMs: 3000,
      now: (() => { let t = 0; return () => (t += 1500); })(),
    };
    const r = await ensureWdaRunning(opts);
    expect(r.running).toBe(false);
    expect(r.reason).toMatch(/retry shortly/);
    // Latching would have short-circuited this second attempt without spawning again.
    await ensureWdaRunning({ ...opts, now: (() => { let t = 0; return () => (t += 1500); })() });
    expect(spawnImpl).toHaveBeenCalledTimes(2);
  });

  it('spawns xcodebuild against the RESOLVED udid, and reports running once it answers', async () => {
    const proc = { exitCode: null, killed: false, kill() {}, on() {} };
    const spawnImpl = vi.fn(() => proc);
    let ready = false;
    const r = await ensureWdaRunning({
      host: 'd', port: 8100, sleep: fastSleep, xctestrun: '/fake/WDA.xctestrun',
      probe: async () => { const v = ready; ready = true; return v; },   // down first, up on the poll
      listDevices: () => listing([{ udid: 'UDID-1', name: 'Air' }]),
      spawnImpl: spawnImpl as never,
      platform: 'darwin',
    });
    expect(r).toEqual({ running: true });
    const [cmd, args] = spawnImpl.mock.calls[0] as unknown as [string, string[]];
    expect(cmd).toBe('xcodebuild');
    expect(args).toContain('test-without-building');
    expect(args).toContain('id=UDID-1');
    expect(args.some((a) => a.endsWith('.xctestrun'))).toBe(true);
  });

  it('stopWda ends the agent — the lease must never strand it on the phone', async () => {
    const proc = { exitCode: null as number | null, killed: false, kill() { this.killed = true; }, on() {} };
    let ready = false;
    await ensureWdaRunning({
      host: 'd', port: 8100, sleep: fastSleep, xctestrun: '/fake/WDA.xctestrun',
      probe: async () => { const v = ready; ready = true; return v; },
      listDevices: () => listing([{ udid: 'A', name: 'Air' }]),
      spawnImpl: (() => proc) as never,
      platform: 'darwin',
    });
    expect(isWdaProcessRunning()).toBe(true);
    stopWda();
    expect(proc.killed).toBe(true);
    expect(isWdaProcessRunning()).toBe(false);
  });
});
