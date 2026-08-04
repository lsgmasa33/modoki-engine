import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  parseIosDevices, resolveIosDevice, ensureWdaRunning, stopWda,
  isWdaProcessRunning, _resetWdaLauncherForTests, WDA_PROBE_TIMEOUT_MS,
} from '../../plugins/backend/wdaLauncher';

/**
 * Lazy WebDriverAgent launch (#32 Phase 2b). No Xcode, no phone — `spawn`, the device listing and
 * the readiness probe are all injected.
 *
 * What every test here has in common: the failure it guards is SILENT in production. Nothing
 * crashes, input just quietly stops being trusted — or a signed 60-second process starts on
 * someone's phone and nobody is told. Specifically:
 *
 *   - picking the WRONG phone (a signed agent launches somewhere surprising);
 *   - re-running a doomed spin-up on every tap because a permanent failure was not remembered;
 *   - spending a network probe off macOS, where nothing can be started or used (#99);
 *   - killing a slow launch and then advising the caller to wait for it (#109);
 *   - starting a SECOND agent because the first had not answered yet (#109) — including the
 *     concurrent case, which rests on an invariant no type checker enforces.
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
    const [d] = parseIosDevices(listing([{ udid: 'DEADBEEF-0123456789ABCDEF', name: 'Air' }]));
    expect(d.udid).toBe('DEADBEEF-0123456789ABCDEF');
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

  it('off macOS it does not even PROBE — the refusal costs no network (#99)', async () => {
    // This inverts what the previous revision asserted, and the reversal is the point.
    //
    // The probe used to run BEFORE the platform check so a Windows editor could drive an agent a
    // Mac had started. That capability is REAL — measured end-to-end from the Windows clone on
    // 2026-08-03 (`[input:trusted-wda]`, `isTrusted:true`, 227ms `/status`). It is also
    // unreachable through the product: the agent is torn down with the LEASE and the lease is
    // exclusive, so a Mac cannot both hold one (which is what launches the agent) and leave it
    // free for Windows. Only a hand-run xcodebuild outside the editor can, which is not a
    // workflow we ship.
    //
    // So the cost had to go: an unbounded probe on EVERY input op, measured at ~2.5s per tap on
    // Windows. Asserting the probe is never CALLED — not merely that the result is false — is what
    // pins that, because a reordering that still probes would pass a result-only assertion.
    const probe = vi.fn(async () => true);   // an agent IS answering, and it still must not be used
    const r = await ensureWdaRunning({ host: 'd', port: 8100, probe, platform: 'win32' });
    expect(r.running).toBe(false);
    expect(r.reason).toMatch(/macOS \+ Xcode/);
    expect(probe).not.toHaveBeenCalled();
  });

  it('bounds the real probe with a timeout — an unbounded fetch was the whole per-op cost (#99)', async () => {
    // The default probe is the one that shipped the cost: a bare `fetch` waits out the OS connect
    // timeout, which is 2.5s on Windows, ~1.0s on macOS against an iPhone that silently drops, and
    // ~0.4s against an Android phone that sends RST — three prices for one line, none chosen. A
    // live agent answered in 72-227ms, so the budget is an order of magnitude above the real thing.
    expect(WDA_PROBE_TIMEOUT_MS).toBeGreaterThanOrEqual(1000);
    expect(WDA_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(3000);
    const seen: RequestInit[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_u: string, init: RequestInit) => {
      seen.push(init);
      throw new Error('connect timeout');   // what a dead :8100 looks like
    }) as unknown as typeof fetch;
    try {
      // No `probe` override ⇒ exercises the REAL defaultProbe, which is the thing under test.
      const r = await ensureWdaRunning({
        host: 'd', port: 8100, platform: 'darwin', sleep: fastSleep,
        xctestrun: null, listDevices: () => listing([]),
      });
      expect(r.running).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
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

  it('a timeout neither latches, nor kills, nor re-spawns — the slow install gets to finish (#109)', async () => {
    // REPLACES a test that asserted `spawnImpl` was called TWICE. That expectation was wrong, and
    // it was actively defending the bug: it read "do not latch a timeout" as "start another agent
    // next time", when what it should mean is "notice the agent that is STILL COMING UP". The old
    // code called stopWda() on timeout and then advised "it may still be starting; retry shortly" —
    // advice whose premise the kill had just destroyed — so every later input op paid the whole 60s
    // again to spawn-then-kill another signed agent on the phone, forever, with no backoff.
    const proc = { exitCode: null, killed: false, kill() { this.killed = true; }, on() {} };
    const spawnImpl = vi.fn(() => proc);
    const ticker = () => { let t = 0; return () => (t += 1500); };
    const base = {
      host: 'd', port: 8100, sleep: fastSleep, xctestrun: '/fake/WDA.xctestrun',
      listDevices: () => listing([{ udid: 'A', name: 'Air' }]),
      spawnImpl: spawnImpl as never,
      platform: 'darwin' as NodeJS.Platform,
      timeoutMs: 3000,
    };

    const first = await ensureWdaRunning({ ...base, probe: deadProbe, now: ticker() });
    expect(first.running).toBe(false);
    expect(first.reason).toMatch(/has been starting for \d+s/);
    // The whole point: the launch is left ALIVE so it can finish.
    expect(proc.killed).toBe(false);

    // A second op must NOT start a rival agent — it reports the one already coming up, cheaply.
    const second = await ensureWdaRunning({ ...base, probe: deadProbe, now: ticker() });
    expect(second.running).toBe(false);
    expect(second.reason).toMatch(/has been starting for/);
    expect(spawnImpl).toHaveBeenCalledTimes(1);

    // And it is still not LATCHED — the original property this test existed to protect. Once the
    // slow install answers, the very next call reports trusted input with no new launch.
    const third = await ensureWdaRunning({ ...base, probe: okProbe, now: ticker() });
    expect(third).toEqual({ running: true });
    expect(spawnImpl).toHaveBeenCalledTimes(1);
  });

  it('two CONCURRENT input ops spawn exactly ONE agent (#109 close-out sweep)', async () => {
    // The already-launching guard covers the SEQUENTIAL case (op 2 after op 1 returned). Nothing
    // covered two ops in flight at once, and this module carries no `inFlight` promise-guard even
    // though its neighbours do (getDeviceCdpSession, inFlightBakes, platformInFlight). It is
    // currently safe for one reason only: there is no `await` between the guard and the spawn, so
    // check-and-set is atomic on the event loop.
    //
    // That is an invariant no type or lint rule enforces — adding an await in that window (an
    // async device listing, say) silently reintroduces the double-spawn. Asserting on CONCURRENT
    // calls rather than on the source layout means this fails on the rearrangement itself.
    const proc = { exitCode: null, killed: false, kill() {}, on() {} };
    const spawnImpl = vi.fn(() => proc);
    const opts = {
      host: 'd', port: 8100, probe: deadProbe, sleep: fastSleep, xctestrun: '/fake/WDA.xctestrun',
      listDevices: () => listing([{ udid: 'A', name: 'Air' }]),
      spawnImpl: spawnImpl as never,
      platform: 'darwin' as NodeJS.Platform,
      timeoutMs: 0,
    };
    const [a, b] = await Promise.all([ensureWdaRunning(opts), ensureWdaRunning(opts)]);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    // Neither caller is told it has trusted input, since the agent never answered.
    expect(a.running).toBe(false);
    expect(b.running).toBe(false);
  });

  it('a launch whose PROCESS DIES says so, and the next call starts a fresh one (#109)', async () => {
    // The other half of not-killing: "still starting" must not be said about a process that is
    // gone. These two outcomes need different advice — one is "wait", the other is "your build is
    // probably unsigned" — and the old single message covered both with the wrong one.
    let exitCb: (() => void) | null = null;
    const proc = {
      exitCode: null, killed: false, kill() {},
      on(ev: string, cb: () => void) { if (ev === 'exit') exitCb = cb; },
    };
    const spawnImpl = vi.fn(() => proc);
    const base = {
      host: 'd', port: 8100, sleep: fastSleep, xctestrun: '/fake/WDA.xctestrun',
      listDevices: () => listing([{ udid: 'A', name: 'Air' }]),
      spawnImpl: spawnImpl as never,
      platform: 'darwin' as NodeJS.Platform,
    };
    // xcodebuild exits during the first poll — a signing failure looks exactly like this.
    const dyingProbe = async () => { exitCb?.(); exitCb = null; return false; };

    const r = await ensureWdaRunning({ ...base, probe: dyingProbe });
    expect(r.running).toBe(false);
    expect(r.reason).toMatch(/exited/);
    expect(r.reason).not.toMatch(/has been starting/);

    // Nothing is alive to join, so the next call is free to try again from scratch.
    await ensureWdaRunning({ ...base, probe: deadProbe, timeoutMs: 0 });
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
