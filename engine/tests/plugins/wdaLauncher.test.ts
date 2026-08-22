import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import {
  parseIosDevices, resolveIosDevice, ensureWdaRunning, stopWda,
  isWdaProcessRunning, _resetWdaLauncherForTests, WDA_PROBE_TIMEOUT_MS,
  parseXctraceDevices, mergeIosDevices, mergeGoIosDevices, pickWdaFailureLine, describeExecFailure,
  _devicectlOutPath, listIosDevicesForSelection, wdaLauncherExec, _clearIosListCache,
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
    // `devicectl: true` on every row here is the point of the flag: this parse IS the devicectl
    // listing, so anything it returns can be installed to hands-free (#170).
    expect(out.filter((d) => d.connected)).toEqual([{ udid: 'A', name: 'Air', connected: true, devicectl: true }]);
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

  it('uses the only paired device, and SAYS the lease could not confirm it (#146)', () => {
    const r = resolveIosDevice([A], {}) as { device: typeof A; unverified: string };
    expect(r.device).toEqual(A);
    // With no lease hardware to compare against, the choice is a guess about WHICH PHONE — kept
    // (refusing would break every setup running an app older than #146) but never silent.
    expect(r.unverified).toMatch(/did not report its hardware/);
  });

  it('prefers the one with a LIVE tunnel when several are paired', () => {
    // A live tunnel is the strongest available evidence of "the phone on the desk right now".
    // Note it is evidence about THIS MAC, not about the lease — hence the caveat (#146).
    const r = resolveIosDevice([B, A], {}) as { device: typeof A; unverified: string };
    expect(r.device).toEqual(A);
    expect(r.unverified).toBeTruthy();
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

/**
 * #146 — the device was chosen with NO reference to the lease, so a Mac with one non-leased iPhone
 * connected would start a signed 60-second agent on that phone without asking. It fails safe for
 * input (the probe targets the lease host, so the stray agent never answers), but the surprise
 * agent is the cost, and the old code's own doc said this must not happen.
 *
 * The fix compares the phone's self-reported `hw.machine` with devicectl's `productType` — the
 * only two strings both sides can see, since iOS forbids an app reading its own UDID.
 */
describe('resolveIosDevice — tie the launch to the LEASED phone (#146)', () => {
  const air = { udid: 'AIR', name: 'Air', connected: false, productType: 'iPhone18,4', osVersion: '26.5.2' };
  const mini = { udid: 'MINI', name: 'Mini', connected: true, productType: 'iPhone14,4', osVersion: '26.5.2' };

  it('picks the leased phone even when a DIFFERENT one is the only thing connected', () => {
    // The exact #146 scenario. The old rule took `mini` outright (sole live tunnel) and launched a
    // signed agent on it; an iOS lease is a WiFi address, so "plugged in" says nothing about it.
    const r = resolveIosDevice([air, mini], {}, { deviceModel: 'iPhone18,4', osVersion: '26.5.2' });
    expect(r).toEqual({ device: air });   // no `unverified` — this one is PROVEN
  });

  it('REFUSES when no paired phone is the leased model, instead of launching on the wrong one', () => {
    const r = resolveIosDevice([air, mini], {}, { deviceModel: 'iPhone99,9', osVersion: '30.0' });
    expect(r).toHaveProperty('error');
    expect((r as { error: string }).error).toMatch(/iPhone99,9/);
    expect((r as { error: string }).error).toMatch(/matches none/);
  });

  it('a STALE os version never contradicts — devicectl reports it as of the last connection', () => {
    // The trap this rule exists to avoid: devicectl's `osVersionNumber` is from the device's LAST
    // CONNECTION, so a phone that has updated since would be excluded by its own freshness and the
    // launch would refuse with "wrong phone". Only the immutable model may contradict.
    const r = resolveIosDevice([air], {}, { deviceModel: 'iPhone18,4', osVersion: '26.6' });
    expect(r).toEqual({ device: air });
  });

  it('two phones of the SAME model: the version breaks the tie', () => {
    const twin = { ...air, udid: 'TWIN', name: 'Twin', osVersion: '26.4' };
    const r = resolveIosDevice([air, twin], {}, { deviceModel: 'iPhone18,4', osVersion: '26.5.2' });
    expect(r).toEqual({ device: air });
  });

  it('two phones the lease cannot tell apart at all: falls back, and SAYS it could not verify', () => {
    const twin = { ...air, udid: 'TWIN', name: 'Twin', connected: true };
    const r = resolveIosDevice([air, twin], {}, { deviceModel: 'iPhone18,4', osVersion: '26.5.2' }) as
      { device: typeof air; unverified: string };
    expect(r.device.udid).toBe('TWIN');   // the live tunnel still breaks the tie…
    expect(r.unverified).toMatch(/cannot say which is the leased one/);   // …but it is not a proof
  });

  it('a model-less legacy device is UNKNOWN, never contradicted', () => {
    // Every pre-iPhone-X handset: only `xctrace` can see it, and that listing carries no model. It
    // must not be excluded on version alone, nor claimed as a match.
    const legacy = { udid: 'OLD', name: 'iPhone8', connected: true, osVersion: '16.7.16' };
    const r = resolveIosDevice([legacy], {}, { deviceModel: 'iPhone18,4', osVersion: '26.5.2' }) as
      { device: typeof legacy; unverified: string };
    expect(r.device).toEqual(legacy);
    expect(r.unverified).toMatch(/no paired iPhone reports the leased device's model/);
  });

  it('the explicit pin still outranks the lease', () => {
    // Rule 1 is absolute: an explicit UDID is a human decision and must not be second-guessed by a
    // heuristic, however good the heuristic is.
    expect(resolveIosDevice([air, mini], { MODOKI_IOS_DEVICE_UDID: 'MINI' }, { deviceModel: 'iPhone18,4', osVersion: '26.5.2' }))
      .toEqual({ device: mini });
  });
});

/**
 * #144 — a WDA launch failure reported a GUESS ("check the build is still signed"), because the
 * child's output was discarded entirely. On the iPhone 8 that advice was simply wrong: re-signing
 * could never have helped, and the real reason (`Cannot test target … Logic Testing Unavailable`)
 * was visible only by re-running xcodebuild by hand. This is the one error path an agent cannot
 * investigate for itself, so whatever the message says IS the diagnosis.
 */
describe('pickWdaFailureLine — quote xcodebuild, do not guess (#144)', () => {
  it('prefers the specific error over the summary that ends the log', () => {
    // "Last line wins" is the tempting rule and it is wrong: a failed xcodebuild run ends with a
    // summary that names nothing, while the actionable line sits further up.
    expect(pickWdaFailureLine([
      'Testing started',
      'xcodebuild: error: Unable to find a destination matching the provided destination specifier',
      '** TEST EXECUTE FAILED **',
    ])).toMatch(/^xcodebuild: error:/);
  });

  it('finds the real iPhone 8 cause — the one the old message could not report', () => {
    expect(pickWdaFailureLine([
      'DVTDeviceOperation: Encountered a build number "" that is incompatible with DVTBuildVersion',
      'Cannot test target "WebDriverAgentRunner" on "iPhone8": Logic Testing Unavailable',
      '** TEST EXECUTE FAILED **',
    ])).toMatch(/Logic Testing Unavailable/);
  });

  it('falls back to the last line rather than nothing when nothing is recognised', () => {
    expect(pickWdaFailureLine(['odd', 'unrecognised tail'])).toBe('unrecognised tail');
  });

  it('has nothing to say when nothing was captured', () => {
    expect(pickWdaFailureLine([])).toBeNull();
  });
});

/** The same defect one call earlier: the DEVICE LISTING discarded devicectl's stderr too, so a
 *  failure surfaced as `could not list iOS devices (Command failed: xcrun devicectl …)` — the
 *  command echoed back, naming nothing. Found by sweeping #144's pattern rather than its symptom. */
describe('describeExecFailure — prefer what the tool said over Node\'s "Command failed"', () => {
  it('quotes stderr instead of the echoed command', () => {
    const e = Object.assign(new Error('Command failed: xcrun devicectl list devices'), {
      stderr: Buffer.from('xcrun: error: unable to find utility "devicectl", not a developer tool or in PATH\n'),
    });
    expect(describeExecFailure(e)).toMatch(/unable to find utility "devicectl"/);
    expect(describeExecFailure(e)).not.toMatch(/Command failed/);
  });

  it('accepts a string stderr as well as a Buffer', () => {
    expect(describeExecFailure(Object.assign(new Error('nope'), { stderr: 'error: no Xcode' }))).toBe('error: no Xcode');
  });

  it('falls back to the message when the tool said nothing', () => {
    // The ENOENT case: the binary never ran, so there is no stderr to prefer.
    expect(describeExecFailure(new Error('spawnSync xcrun ENOENT'))).toBe('spawnSync xcrun ENOENT');
    expect(describeExecFailure(Object.assign(new Error('m'), { stderr: Buffer.from('   \n\n') }))).toBe('m');
  });

  it('survives a non-Error throw', () => {
    expect(describeExecFailure('just a string')).toBe('just a string');
  });
});

describe('the real devicectl invocation', () => {
  it('writes each listing to its OWN temp file', () => {
    // ⚠️ The path was `modoki-devicectl-<pid>.json` — ONE file per process — and that was safe only
    // by accident: `execFileSync` blocked the single JS thread for the whole spawn→read→unlink
    // cycle, so two listings could not interleave. #168 made the POLLED listing async and left
    // `ensureWdaRunning` on the sync twin, so they can now overlap and write the same file: an
    // `/api/device/list` poll is mid-flight (its OS process still writing) when a `device_tap`
    // runs `listDevicesSync`. A torn or already-unlinked read makes `parseIosDevices` return `[]`,
    // which `ensureWdaRunning` LATCHES into `lastFailure` as "no iOS device is paired with this
    // Mac" for the rest of the session — trusted input silently degraded, looking like an
    // unplugged phone.
    //
    // Asserting UNIQUENESS rather than a format: the fix is that no two calls can collide, and a
    // format assertion would pass for a constant that merely looked unique.
    const paths = [_devicectlOutPath(), _devicectlOutPath(), _devicectlOutPath()];
    expect(new Set(paths).size, `two listings share a temp file: ${paths.join(', ')}`).toBe(3);
    for (const p of paths) expect(p).toContain(String(process.pid));
  });

  it('never writes its JSON to /dev/stdout', () => {
    // Found LIVE, not here: `--json-output /dev/stdout` interleaves devicectl's human-readable
    // table with the JSON, so it never parses — and the failure presents as "no iOS device is
    // connected" with a phone sitting right there. These tests inject the listing string, so the
    // real command is only exercised on a Mac with a device attached; this asserts the shape of
    // the command itself, which is the part they cannot reach.
    const src = readFileSync(path.join(__dirname, '../../plugins/backend/wdaLauncher.ts'), 'utf8');
    // ⚠️ Read the shared `DEVICECTL_ARGV`, not a function body. #168 split the listing into an
    // async seam (the POLLED route, which must not block the Electron main process) and a sync
    // twin (`ensureWdaRunning`, whose critical section must stay await-free), and slicing one
    // function's body would leave the other's invocation unguarded — while still passing.
    const argvLine = /const DEVICECTL_ARGV = [^\n]*\n/.exec(src)?.[0];
    expect(argvLine, 'DEVICECTL_ARGV is gone — this test no longer guards the real command').toBeDefined();
    expect(argvLine!).toContain('--json-output');
    expect(argvLine!).not.toMatch(/--json-output'?,?\s*'\/dev\/stdout'/);
    // And there is exactly ONE of them in CODE: a seam that builds its own argv inline would escape
    // the check above, which is the only way this guard can be true and useless at the same time.
    // Comment lines are excluded — the module banner and `parseIosDevices`' doc both name the flag
    // while invoking nothing, and counting those made this assert 3 and fail on prose.
    const codeMentions = src.split('\n')
      .filter((l) => l.includes('--json-output') && !/^\s*(\/\/|\*|\/\*)/.test(l));
    expect(codeMentions.length,
      `--json-output appears in ${codeMentions.length} code lines — a seam is building its own ` +
      'argv, so the assertions above no longer cover every devicectl invocation').toBe(1);
  });
});

describe('ensureWdaRunning', () => {
  const fastSleep = async () => {};
  const okProbe = async () => true;
  const deadProbe = async () => false;

  // `platform` is pinned on every case that expects to get PAST the darwin gate below. Without it
  // these read as "WDA behaviour" but silently assert "…on a Mac", and every one of them failed on
  // the ubuntu + windows CI legs — where the gate correctly refuses before the probe ever runs.
  it('does NOT spawn when WDA is already answering — including one started by hand', async () => {
    const spawnImpl = vi.fn();
    const r = await ensureWdaRunning({ host: 'd', port: 8100, platform: 'darwin', probe: okProbe, spawnImpl: spawnImpl as never });
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

  it('a dead launch QUOTES xcodebuild instead of guessing at signing (#144)', async () => {
    // End-to-end for #144: the stderr pipe, the ring buffer and the message, together. The unit
    // tests above cover the ranking; what they cannot show is that anything is captured at all —
    // which is precisely what was missing, since the child was spawned with its output discarded.
    let exitCb: (() => void) | null = null;
    const stderr = new EventEmitter() as EventEmitter & { setEncoding?: (e: string) => void };
    const proc = {
      exitCode: null, killed: false, kill() {}, stderr,
      on(ev: string, cb: () => void) { if (ev === 'exit') exitCb = cb; },
    };
    const probe = async () => {
      stderr.emit('data', 'Testing started\nCannot test target "WebDriverAgentRunner" on "iPhone8": Logic Testing Unavailable\n** TEST EXECUTE FAILED **\n');
      exitCb?.(); exitCb = null;
      return false;
    };
    const r = await ensureWdaRunning({
      host: 'd', port: 8100, probe, sleep: fastSleep, xctestrun: '/fake/WDA.xctestrun',
      listDevices: () => listing([{ udid: 'A', name: 'Air' }]),
      spawnImpl: (() => proc) as never, platform: 'darwin',
    });
    expect(r.reason).toMatch(/Logic Testing Unavailable/);
    // …and the guess it replaced is GONE from this path. Re-signing could not have helped here,
    // and saying so cost an hour on #143.
    expect(r.reason).not.toMatch(/still signed/);
  });

  it('spawns with stderr PIPED and stdout still discarded (#144)', () => {
    // The pair matters: piping stdout too would put a test runner's whole log through this
    // process, which is the thing the original `stdio:'ignore'` was right to avoid.
    const proc = { exitCode: null, killed: false, kill() {}, on() {} };
    const spawnImpl = vi.fn(() => proc);
    return ensureWdaRunning({
      host: 'd', port: 8100, probe: deadProbe, sleep: fastSleep, xctestrun: '/fake/WDA.xctestrun',
      listDevices: () => listing([{ udid: 'A', name: 'Air' }]),
      spawnImpl: spawnImpl as never, platform: 'darwin', timeoutMs: 0,
    }).then(() => {
      const opts = (spawnImpl.mock.calls[0] as unknown as [string, string[], { stdio: string[] }])[2];
      expect(opts.stdio).toEqual(['ignore', 'ignore', 'pipe']);
    });
  });

  it('a child with NO stderr still launches — losing the diagnostic must not break the launch', async () => {
    // Every injected double in this file is such a child, but the real reason is production: if
    // the pipe cannot be established, the launch is still the thing the caller asked for.
    const proc = { exitCode: null, killed: false, kill() {}, on() {} };
    const r = await ensureWdaRunning({
      host: 'd', port: 8100, probe: deadProbe, sleep: fastSleep, xctestrun: '/fake/WDA.xctestrun',
      listDevices: () => listing([{ udid: 'A', name: 'Air' }]),
      spawnImpl: (() => proc) as never, platform: 'darwin', timeoutMs: 0,
    });
    expect(r.reason).toMatch(/has been starting/);
  });

  it('passes the LEASE through, so the launch targets the leased phone (#146)', async () => {
    // The wiring, not the rule (that is unit-tested above): with two paired phones the old code
    // took the connected one outright. Here the lease names the OTHER one, and that is the one
    // `-destination id=` must carry.
    const proc = { exitCode: null, killed: false, kill() {}, on() {} };
    const spawnImpl = vi.fn(() => proc);
    await ensureWdaRunning({
      host: 'd', port: 8100, probe: deadProbe, sleep: fastSleep, xctestrun: '/fake/WDA.xctestrun',
      listDevices: () => JSON.stringify({
        result: {
          devices: [
            { connectionProperties: { tunnelState: 'disconnected' }, hardwareProperties: { udid: 'AIR', platform: 'iOS', productType: 'iPhone18,4' }, deviceProperties: { name: 'Air', osVersionNumber: '26.5.2' } },
            { connectionProperties: { tunnelState: 'connected' }, hardwareProperties: { udid: 'MINI', platform: 'iOS', productType: 'iPhone14,4' }, deviceProperties: { name: 'Mini', osVersionNumber: '26.5.2' } },
          ],
        },
      }),
      spawnImpl: spawnImpl as never, platform: 'darwin', timeoutMs: 0,
      lease: { deviceModel: 'iPhone18,4', osVersion: '26.5.2' },
    });
    const [, args] = spawnImpl.mock.calls[0] as unknown as [string, string[]];
    expect(args).toContain('id=AIR');
    expect(args).not.toContain('id=MINI');
  });

  it('an UNVERIFIED choice rides along on every later message about that launch (#146)', async () => {
    // "Guess but say so". The launch is kept — refusing would break every setup whose app predates
    // the hardware probe — but a failure must not read as though the phone was known to be right.
    const proc = { exitCode: null, killed: false, kill() {}, on() {} };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const r = await ensureWdaRunning({
        host: 'd', port: 8100, probe: deadProbe, sleep: fastSleep, xctestrun: '/fake/WDA.xctestrun',
        listDevices: () => listing([{ udid: 'A', name: 'Air' }]),
        spawnImpl: (() => proc) as never, platform: 'darwin', timeoutMs: 0,
        lease: { deviceModel: null, osVersion: null },   // an app older than #146
      });
      expect(r.reason).toMatch(/MODOKI_IOS_DEVICE_UDID/);
      expect(r.reason).toMatch(/Air \(A\)/);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('[wda]'));
    } finally {
      warn.mockRestore();
    }
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


/** #143 — `devicectl` is CoreDevice (iOS 17+), so an iOS 16-or-older device appears in its JSON as
 *  a stub with no `udid` and is dropped. That made every pre-iPhone-X handset unselectable for
 *  trusted input — and NOT EVEN `MODOKI_IOS_DEVICE_UDID` could reach it, since the pin is matched
 *  against that same list. Measured on an iPhone 8 / iOS 16.7.16 holding a live lease.
 *
 *  The fixture below is REAL output from `xcrun xctrace list devices` on the Mac where this was
 *  found, trimmed only in the simulator list — every LINE SHAPE is preserved (the version-less Mac
 *  line, the 40-hex legacy UDID, the curly vs straight apostrophe), because invented fixtures are
 *  what let the shape drift. Only the ids and owner names are replaced: a real UDID or a real
 *  person's device name in a file that ships to the public mirror is #103's leak, and it has now
 *  aborted the OSS snapshot twice (see `PLACEHOLDER_UDIDS` in scripts/scan-publish-safety.mjs). */
const XCTRACE_REAL = [
  '== Devices ==',
  'Dev’s MacBook Pro (98C84BED-A4A8-50F3-9873-8F3BE2862EE4)',
  'iPhone8 (16.7.16) (deadbeefdeadbeefdeadbeefdeadbeefdeadbeef)',
  '',
  '== Devices Offline ==',
  'Test iPhone Air (26.5.2) (DEADBEEF-0123456789ABCDEF)',
  "Someone's iPhone (26.6) (DEADBEEF-1123456789ABCDEF)",
  'Unknown (B0FE9C9A-513C-56FA-B5A2-80952F941F3B)',
  'iPhone 13 mini (26.5.2) (DEADBEEF-2123456789ABCDEF)',
  '',
  '== Simulators ==',
  'iPhone 17 Simulator (26.5) (EFED8E7C-2BC4-429F-8BF7-451E49EC84E5)',
  'iPhone Air Simulator (26.5) (CCABD5E9-2E82-4944-9033-BB15560B13E7)',
].join('\n');

describe('parseXctraceDevices — the legacy listing, the only one that sees iOS <= 16 (#143)', () => {
  it('finds the iOS 16 device devicectl cannot describe, with its 40-hex legacy UDID', () => {
    const d = parseXctraceDevices(XCTRACE_REAL).find((x) => x.name === 'iPhone8');
    // The OS version comes free with the parse and is kept (#146) — it is the ONLY hardware fact
    // this listing carries, since `xctrace` reports no model.
    expect(d).toEqual({ udid: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', name: 'iPhone8', connected: true, osVersion: '16.7.16' });
  });

  it('excludes the Mac itself — by shape, not by name', () => {
    // The Mac's line carries a UDID but NO OS version, which is why the pattern requires the
    // `(os) (udid)` pair. Matching on the name would break on a renamed machine.
    const names = parseXctraceDevices(XCTRACE_REAL).map((d) => d.name);
    expect(names.some((n) => n.includes('MacBook'))).toBe(false);
    expect(names.some((n) => n === 'Unknown')).toBe(false);   // also version-less
  });

  it('excludes simulators — a simulator is not a phone to run a signed agent on', () => {
    expect(parseXctraceDevices(XCTRACE_REAL).some((d) => d.name.includes('Simulator'))).toBe(false);
  });

  it('reads `connected` from the section, so Offline devices are candidates but not preferred', () => {
    const byName = Object.fromEntries(parseXctraceDevices(XCTRACE_REAL).map((d) => [d.name, d.connected]));
    expect(byName['iPhone8']).toBe(true);
    expect(byName['Test iPhone Air']).toBe(false);
  });

  it('returns [] for empty/garbage rather than throwing — the source is additive and may be absent', () => {
    expect(parseXctraceDevices('')).toEqual([]);
    expect(parseXctraceDevices('not a listing at all')).toEqual([]);
  });
});

describe('mergeIosDevices — devicectl stays authoritative, legacy only ADDS (#143)', () => {
  it('adds a device only the legacy listing can see', () => {
    const merged = mergeIosDevices(
      [{ udid: 'DEADBEEF-0123456789ABCDEF', name: 'Test iPhone Air', connected: false }],
      parseXctraceDevices(XCTRACE_REAL),
    );
    expect(merged.map((d) => d.name)).toContain('iPhone8');
  });

  it('does not duplicate a device both listings report', () => {
    // The two agree byte-for-byte on overlapping UDIDs (verified on hardware), so the dedupe is
    // exact rather than heuristic. A duplicate would make resolveIosDevice refuse as "ambiguous"
    // for a single phone — the failure this guards.
    const primary = [{ udid: 'DEADBEEF-0123456789ABCDEF', name: 'Test iPhone Air', connected: true }];
    const merged = mergeIosDevices(primary, parseXctraceDevices(XCTRACE_REAL));
    expect(merged.filter((d) => d.udid === 'DEADBEEF-0123456789ABCDEF')).toHaveLength(1);
    // and the devicectl entry WINS (it carries the richer fields + the live tunnel state)
    expect(merged.find((d) => d.udid === 'DEADBEEF-0123456789ABCDEF')!.connected).toBe(true);
  });

  it('the merged list makes MODOKI_IOS_DEVICE_UDID able to reach an iOS 16 device at all', () => {
    // The end-to-end point of #143: before the merge this pin answered "matches none of this
    // Mac's paired iOS devices", leaving the device unselectable by ANY means.
    const merged = mergeIosDevices(parseIosDevices('{"result":{"devices":[]}}'), parseXctraceDevices(XCTRACE_REAL));
    const r = resolveIosDevice(merged, { MODOKI_IOS_DEVICE_UDID: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' } as NodeJS.ProcessEnv);
    expect(r).toEqual({ device: { udid: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', name: 'iPhone8', connected: true, osVersion: '16.7.16' } });
  });

  it('a devicectl-listed device carries devicectl:true; a legacy-xctrace-only device carries no such field (#170)', () => {
    // The Build-menu device picker (buildTargetMenu.ts) writes `iosDevicectlId` from exactly this
    // field: present -> a hands-free `xcrun devicectl` install; absent -> an Xcode handoff, because
    // an xctrace-only device is pre-iOS-17 and `devicectl install` cannot drive it at all.
    const primary = parseIosDevices(listing([{ udid: 'DEADBEEF-0123456789ABCDEF', name: 'Test iPhone Air' }]));
    const merged = mergeIosDevices(primary, parseXctraceDevices(XCTRACE_REAL));
    const devicectlDevice = merged.find((d) => d.udid === 'DEADBEEF-0123456789ABCDEF');
    const legacyOnlyDevice = merged.find((d) => d.name === 'iPhone8');
    expect(devicectlDevice?.devicectl).toBe(true);
    expect(legacyOnlyDevice?.devicectl).toBeUndefined();
  });
});

/**
 * The device listing must include what only go-ios can see (bug `ca0A0LZ4knjvVNzclLRl`).
 *
 * Measured 2026-08-20: `Build → iOS Device` offered three DISCONNECTED phones and omitted the
 * connected iPhone 8, identically before and after `Refresh devices`, while `go-ios list`,
 * `idevice_id -l` and Xcode's Devices window all saw it. The omitted device is the only class that
 * NEEDS the go-ios install path — devicectl is CoreDevice-only and cannot see iOS ≤16 at all — so
 * #217's hands-free install was unreachable from its own picker, silently.
 */
describe('iOS listing — go-ios fills what Apple\'s listings drop', () => {
  const D = (udid: string, name: string, connected = false): ReturnType<typeof parseIosDevices>[number] =>
    ({ udid, name, connected }) as ReturnType<typeof parseIosDevices>[number];

  it('appends a device only go-ios saw, marked connected', () => {
    const out = mergeGoIosDevices([D('AAA', 'Nana’s iPhone')], [{ udid: 'BBB', name: 'iPhone8' }]);
    expect(out.map((d) => d.udid)).toEqual(['AAA', 'BBB']);
    expect(out[1]).toMatchObject({ name: 'iPhone8', connected: true });
    // No devicectlId: this is exactly the class that must take the go-ios install branch.
    expect(out[1]).not.toHaveProperty('devicectlId');
  });

  it('names a row even when the device will not answer `ios info`', () => {
    // A bare UDID is a poor row; an ABSENT row is the bug. It must also say where it came from,
    // or the reader is left wondering why one entry looks unlike the rest.
    const [row] = mergeGoIosDevices([], [{ udid: 'a11ce511deadbeef0000000000000000000000ff' }]);
    expect(row.name).toContain('a11ce511');
    expect(row.name).toContain('go-ios');
  });

  it('dedupes the go-ios list against ITSELF', () => {
    // MEASURED, not hypothetical: `ios list` on this Mac returned the iPhone 8's UDID twice in a
    // single call, and a known-set-only filter puts two identical rows in the Build menu. The
    // unit tests above did not catch it; a live probe against the real binary did.
    const out = mergeGoIosDevices([], [
      { udid: 'BBB', name: 'iPhone8' },
      { udid: 'BBB', name: 'iPhone8' },
    ]);
    expect(out.map((d) => d.udid)).toEqual(['BBB']);
  });

  it('does NOT touch a row the Apple listings already produced', () => {
    // Including a `connected:false` they may have got wrong: correcting that from here would layer
    // a second inference on the first, and the fix is about the MISSING row.
    const out = mergeGoIosDevices([D('AAA', 'iPhone8', false)], [{ udid: 'AAA', name: 'other' }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: 'iPhone8', connected: false });
  });

  it('the real listing consults go-ios and unions the result', async () => {
    const realList = wdaLauncherExec.listGoIosUdids;
    const realInfo = wdaLauncherExec.goIosInfo;
    const realDev = wdaLauncherExec.listDevices;
    const realLegacy = wdaLauncherExec.listLegacyDevices;
    try {
      _clearIosListCache();
      wdaLauncherExec.listDevices = async () => { throw new Error('no devicectl'); };
      wdaLauncherExec.listLegacyDevices = async () => '';
      wdaLauncherExec.listGoIosUdids = async () => ['a11ce511deadbeef0000000000000000000000ff'];
      wdaLauncherExec.goIosInfo = async () => ({ name: 'iPhone8', productType: 'iPhone10,1' });

      const devices = await listIosDevicesForSelection();
      expect(devices).toHaveLength(1);
      expect(devices[0]).toMatchObject({ name: 'iPhone8', connected: true, productType: 'iPhone10,1' });
    } finally {
      _clearIosListCache();
      wdaLauncherExec.listGoIosUdids = realList; wdaLauncherExec.goIosInfo = realInfo;
      wdaLauncherExec.listDevices = realDev; wdaLauncherExec.listLegacyDevices = realLegacy;
    }
  });

  it('only asks `ios info` about devices the Apple listings MISSED', async () => {
    // One extra shell-out per missing device is fine (usually zero); one per PAIRED device would
    // be paid on every poll of a listing the AI panel refreshes every 2.5s.
    const real = { l: wdaLauncherExec.listGoIosUdids, i: wdaLauncherExec.goIosInfo, d: wdaLauncherExec.listDevices, g: wdaLauncherExec.listLegacyDevices };
    const asked: string[] = [];
    try {
      _clearIosListCache();
      wdaLauncherExec.listDevices = async () => { throw new Error('no devicectl'); };
      wdaLauncherExec.listLegacyDevices = async () => '';
      wdaLauncherExec.listGoIosUdids = async () => ['AAA'];
      wdaLauncherExec.goIosInfo = async (u: string) => { asked.push(u); return {}; };
      await listIosDevicesForSelection();
      expect(asked).toEqual(['AAA']);
    } finally {
      _clearIosListCache();
      wdaLauncherExec.listGoIosUdids = real.l; wdaLauncherExec.goIosInfo = real.i;
      wdaLauncherExec.listDevices = real.d; wdaLauncherExec.listLegacyDevices = real.g;
    }
  });
});

describe('the iOS listing coalesces concurrent misses', () => {
  // Found by the close-out review. Each uncached call spawns up to FOUR bounded subprocesses
  // (devicectl 20s, xctrace 20s, `ios list` 10s, `ios info` 10s), and the AI panel polls this
  // every 2.5s — so a slow or wedged tool made every poll during that window start another full
  // set instead of waiting for the one already in flight.
  it('runs the exec seam ONCE for N concurrent callers, and they all get the same answer', async () => {
    const real = { d: wdaLauncherExec.listDevices, g: wdaLauncherExec.listLegacyDevices, l: wdaLauncherExec.listGoIosUdids, i: wdaLauncherExec.goIosInfo };
    let listCalls = 0;
    try {
      _clearIosListCache();
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      wdaLauncherExec.listDevices = async () => { listCalls++; await gate; throw new Error('no devicectl'); };
      wdaLauncherExec.listLegacyDevices = async () => '';
      wdaLauncherExec.listGoIosUdids = async () => ['AAA'];
      wdaLauncherExec.goIosInfo = async () => ({ name: 'iPhone8' });

      const all = Promise.all([listIosDevicesForSelection(), listIosDevicesForSelection(), listIosDevicesForSelection()]);
      release();
      const [a, b, c] = await all;

      expect(listCalls).toBe(1);
      expect(a).toBe(b);            // literally the same array — one listing, shared
      expect(b).toBe(c);
      expect(a.map((d) => d.name)).toEqual(['iPhone8']);
    } finally {
      _clearIosListCache();
      wdaLauncherExec.listDevices = real.d; wdaLauncherExec.listLegacyDevices = real.g;
      wdaLauncherExec.listGoIosUdids = real.l; wdaLauncherExec.goIosInfo = real.i;
    }
  });

  it('a FAILED listing does not wedge every later call', async () => {
    // The in-flight slot must be released on rejection too, or one bad listing poisons the picker
    // for the life of the process.
    const real = { d: wdaLauncherExec.listDevices, g: wdaLauncherExec.listLegacyDevices, l: wdaLauncherExec.listGoIosUdids };
    try {
      _clearIosListCache();
      wdaLauncherExec.listDevices = async () => { throw new Error('no devicectl'); };
      wdaLauncherExec.listLegacyDevices = async () => { throw new Error('boom'); };
      wdaLauncherExec.listGoIosUdids = async () => [];
      // The stub REPLACES `listLegacyDevices`' own try/catch, so this rejection reaches the
      // listing — which is precisely the case worth pinning: `.finally()` must release the
      // in-flight slot on the failure path too.
      await expect(listIosDevicesForSelection()).rejects.toThrow('boom');
      // ⚠️ NO `_clearIosListCache()` here, deliberately. That helper nulls the in-flight slot
      // itself, so clearing between the two calls would exercise the helper instead of the
      // `.finally()` release and the assertion would pass with the release deleted — it did, on
      // the first draft of this test.
      wdaLauncherExec.listLegacyDevices = async () => '';
      wdaLauncherExec.listGoIosUdids = async () => ['BBB'];
      const second = await listIosDevicesForSelection();
      expect(second.map((d) => d.udid)).toEqual(['BBB']);
    } finally {
      _clearIosListCache();
      wdaLauncherExec.listDevices = real.d; wdaLauncherExec.listLegacyDevices = real.g; wdaLauncherExec.listGoIosUdids = real.l;
    }
  });
});
