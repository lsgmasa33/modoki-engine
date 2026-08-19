/** The `useAdb` connect branch (code-review T9 / #45) — previously untested. Overrides the
 *  `adbRunner` seam so the real `adb` binary is never invoked (and no `child_process` module mock,
 *  which fights vitest's per-file module cache in the full suite).
 *
 *  ⚠️ `androidDevicesExec.list` is stubbed for the SAME reason, and it is not optional (#149). The
 *  connect path now resolves WHICH Android before forwarding, and an un-stubbed listing shells out
 *  to `adb devices -l` — so these tests would pass or fail according to how many phones happen to be
 *  plugged into the machine running them. Measured: on a Mac with three attached, every adb-branch
 *  test failed with the ambiguity refusal instead of the behaviour under test. Exactly the
 *  half-injectable-seam trap `wdaLauncher.ts` documents for its legacy device listing. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import net from 'net';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { DeviceConnectionManager, adbRunner, releaseDeviceResourcesOnExit, reclaimStaleDeviceStateAtStartup } from '../../plugins/backend/deviceConnection';
import { androidDevicesExec, _clearFriendlyNameCache } from '../../plugins/backend/androidDevices';
import { DeviceLeaseAuthority } from '../../plugins/backend/deviceLease';
import { claimsDir, listClaims } from '../../plugins/backend/deviceClaims';
import { deviceCdpAdb, discoverDeviceCdpTarget, resetDeviceCdpSession } from '../../plugins/backend/deviceCdp';

const realForward = adbRunner.forward;
const realRemove = adbRunner.removeForward;
const realListForwards = adbRunner.listForwards;
const realList = androidDevicesExec.list;
const realDeviceName = androidDevicesExec.deviceName;
/** One attached, usable phone — the unambiguous case, so these tests exercise the adb branch rather
 *  than the device-selection rule (which has its own tests in androidDevices.test.ts). */
const ONE_DEVICE = 'List of devices attached\nTESTSERIAL1  device usb:1-1 model:Test_Phone\n';
// Per-test `.modoki` so the persisted last-target never touches the real repo and can't leak between tests.
let stateDir: string;
// …and a per-test MODOKI_HOME, for the reason deviceClaims.test.ts calls non-optional: the adb
// branch takes a machine-wide HARDWARE claim (#149) before it forwards, so without this every test
// below wrote `TESTSERIAL1` into the developer's REAL ~/.modoki/device-claims.json. Un-caught until
// #164, because the claim was also LEAKED there (the connect to port 1 fails, and the failure path
// did not release) — the suite was quietly reproducing the very bug it now guards against.
let home: string;
let prevHome: string | undefined;
let prevBackendPort: string | undefined;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-home-'));
  prevHome = process.env.MODOKI_HOME;
  process.env.MODOKI_HOME = home;
  adbRunner.forward = vi.fn(); adbRunner.removeForward = vi.fn();
  androidDevicesExec.list = () => ONE_DEVICE;
  // The friendly-name lookup is a second adb shell — stubbed for the same reason as the listing:
  // un-stubbed it asks the machine's REAL attached phones for their names (#149).
  androidDevicesExec.deviceName = () => '';
  _clearFriendlyNameCache();
  // Pin the HOST end of the tunnel (#158) to a port nothing can be listening on, so a test that
  // only cares about the forward ARGS gets a fast, deterministic connect refusal. Un-pinned it
  // would derive the real 9095 — a machine-wide port a running editor on this box may genuinely
  // hold, which would make these tests pass or fail by what else is plugged in. Same hazard as the
  // un-stubbed device listing above. Tests that need a live socket override it.
  process.env.MODOKI_DEVICE_HOST_PORT = '1';
  // Same hazard as MODOKI_HOME and the device listing above, one variable further out: the
  // per-clone port DERIVATION reads MODOKI_BACKEND_PORT, so a developer who exports it — which
  // the Clones table in CLAUDE.md actively encourages — makes these tests derive that clone's
  // ports instead of the default 9095/9333 the reclaim test pins. The suite then passes or fails
  // by the shell it was launched from. Cleared here and restored in afterEach.
  prevBackendPort = process.env.MODOKI_BACKEND_PORT;
  delete process.env.MODOKI_BACKEND_PORT;
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-adb-'));
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.MODOKI_HOME;
  else process.env.MODOKI_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.MODOKI_DEVICE_HOST_PORT;
  if (prevBackendPort === undefined) delete process.env.MODOKI_BACKEND_PORT;
  else process.env.MODOKI_BACKEND_PORT = prevBackendPort;
  adbRunner.forward = realForward; adbRunner.removeForward = realRemove; adbRunner.listForwards = realListForwards;
  androidDevicesExec.list = realList;
  androidDevicesExec.deviceName = realDeviceName;
  _clearFriendlyNameCache();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function startMockDevice(authority: DeviceLeaseAuthority): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    let live: net.Socket | null = null;
    const server = net.createServer((socket) => {
      live = socket;
      socket.setEncoding('utf8');
      let buf = '';
      socket.on('data', (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          let msg: { id: string; method: string; params?: { guid?: string } };
          try { msg = JSON.parse(line); } catch { continue; }
          const now = Date.now(); const guid = msg.params?.guid ?? '';
          let result: unknown;
          if (msg.method === 'connect') result = authority.connect(guid, now);
          else if (msg.method === 'ping') result = authority.ping(guid, now);
          else if (msg.method === 'disconnect') result = authority.disconnect(guid, now);
          else result = { ok: false, reason: 'not-owner' };
          socket.write(JSON.stringify({ id: msg.id, result }) + '\n');
        }
      });
      socket.on('close', () => authority.socketDropped(Date.now()));
      socket.on('error', () => { /* client went away */ });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({ port, close: () => new Promise<void>((r) => { live?.destroy(); server.close(() => r()); }) });
    });
  });
}

describe('DeviceConnectionManager — useAdb branch', () => {
  it('reports state:error (not a throw) when `adb forward` fails', async () => {
    (adbRunner.forward as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('no devices/emulators found'); });
    const mgr = new DeviceConnectionManager('g-adbfail', stateDir);
    const status = await mgr.connect({ useAdb: true });
    expect(status.state).toBe('error');
    expect(status.detail).toMatch(/adb forward failed/i);
    expect(adbRunner.forward).toHaveBeenCalledWith(1, 'TESTSERIAL1', 9095);
  });

  // ── Bare reconnect reuses the saved useAdb; supplying an ip is all-or-nothing (never inherits adb) ──
  it('a bare reconnect (no ip, no useAdb) re-takes the adb branch of the last target', async () => {
    const mgr = new DeviceConnectionManager('g-adb-recon', stateDir);
    // Seed lastTarget {ip:'', useAdb:true}. adb forward is stubbed; the socket to a refused port
    // errors, but the target is remembered before the attempt — that's all we need.
    await mgr.connect({ useAdb: true, port: 1 });
    (adbRunner.forward as ReturnType<typeof vi.fn>).mockClear();
    const status = await mgr.connect({});                       // bare
    expect(adbRunner.forward).toHaveBeenCalledWith(1, 'TESTSERIAL1', 9095); // reused useAdb:true (default port)
    expect(status.detail ?? '').not.toMatch(/no IP/i);
    await mgr.disconnect();
  });

  it('an explicit ip after an adb connect switches to WiFi (does NOT inherit the saved useAdb)', async () => {
    const mgr = new DeviceConnectionManager('g-adb-then-wifi', stateDir);
    await mgr.connect({ useAdb: true, port: 1 });               // lastTarget {ip:'', useAdb:true}
    (adbRunner.forward as ReturnType<typeof vi.fn>).mockClear();
    const status = await mgr.connect({ ip: '127.0.0.1', port: 1 }); // explicit ip → WiFi, not a bare reconnect
    expect(adbRunner.forward).not.toHaveBeenCalled();
    expect(status.target?.useAdb).toBe(false);
    await mgr.disconnect();
  });

  it('forwards over adb and targets 127.0.0.1 on success', async () => {
    const authority = new DeviceLeaseAuthority();
    const device = await startMockDevice(authority);
    const mgr = new DeviceConnectionManager('g-adbok', stateDir);
    // The mock stands in for the HOST end of the tunnel (adb itself is stubbed, so nothing actually
    // forwards) — so the host port is pinned to it via the same override production uses (#158),
    // while `port` keeps its real meaning: the port the app listens on ON THE PHONE.
    process.env.MODOKI_DEVICE_HOST_PORT = String(device.port);
    try {
      const status = await mgr.connect({ useAdb: true, port: 9095 });
      expect(adbRunner.forward).toHaveBeenCalledWith(device.port, 'TESTSERIAL1', 9095);
      expect(status.state).toBe('connected');
      // The resolved serial rides on the lease (#149) — every later adb call reuses THIS, rather
      // than re-picking a device of its own.
      expect(status.target).toMatchObject({ host: '127.0.0.1', useAdb: true, serial: 'TESTSERIAL1' });
      // The status carries the HOST port, because that is what a later call would have to dial.
      expect(status.target?.port).toBe(device.port);
    } finally {
      delete process.env.MODOKI_DEVICE_HOST_PORT;
      await mgr.disconnect();
      await device.close();
    }
  });

  // ── Which phone (#149) ──────────────────────────────────────────────────────
  describe('device selection', () => {
    const TWO = 'List of devices attached\n'
      + 'AAA111  device usb:1-1 model:Phone_A\n'
      + 'BBB222  device usb:1-2 model:Phone_B\n';

    it('refuses — without forwarding — when several are attached and none was chosen', async () => {
      androidDevicesExec.list = () => TWO;
      const mgr = new DeviceConnectionManager('g-ambig', stateDir);
      const status = await mgr.connect({ useAdb: true });
      expect(status.state).toBe('error');
      // The refusal must NAME the candidates: "more than one device/emulator" is what this replaced.
      expect(status.detail).toContain('AAA111');
      expect(status.detail).toContain('BBB222');
      // Nothing was touched — a refusal that had already forwarded would leave a stray rule behind.
      expect(adbRunner.forward).not.toHaveBeenCalled();
    });

    it('forwards to the serial the caller asked for', async () => {
      androidDevicesExec.list = () => TWO;
      const mgr = new DeviceConnectionManager('g-pick', stateDir);
      const status = await mgr.connect({ useAdb: true, port: 1, serial: 'BBB222' });
      expect(adbRunner.forward).toHaveBeenCalledWith(1, 'BBB222', 1);
      expect(status.target?.serial).toBe('BBB222');
      await mgr.disconnect();
    });

    it('refuses a serial that matches nothing attached, rather than using another phone', async () => {
      androidDevicesExec.list = () => TWO;
      const mgr = new DeviceConnectionManager('g-typo', stateDir);
      const status = await mgr.connect({ useAdb: true, serial: 'NOPE' });
      expect(status.state).toBe('error');
      expect(status.detail).toContain('NOPE');
      expect(adbRunner.forward).not.toHaveBeenCalled();
    });

    it('remembers the chosen serial and reuses it on a bare reconnect', async () => {
      androidDevicesExec.list = () => TWO;
      const mgr = new DeviceConnectionManager('g-remember', stateDir);
      await mgr.connect({ useAdb: true, port: 1, serial: 'BBB222' });
      await mgr.disconnect();
      (adbRunner.forward as ReturnType<typeof vi.fn>).mockClear();
      await mgr.connect({});                                   // bare
      expect(adbRunner.forward).toHaveBeenCalledWith(1, 'BBB222', 9095);
      await mgr.disconnect();
    });

    // A REMEMBERED serial is a preference, not a pin: the overwhelmingly likely reason it no longer
    // matches is that the phone was unplugged, and refusing a single-phone reconnect over a stale
    // memory the user never typed would be worse than falling back to the normal rule.
    it('falls back to the normal rule when the remembered serial is no longer attached', async () => {
      androidDevicesExec.list = () => TWO;
      const mgr = new DeviceConnectionManager('g-unplugged', stateDir);
      await mgr.connect({ useAdb: true, port: 1, serial: 'BBB222' });
      await mgr.disconnect();
      androidDevicesExec.list = () => ONE_DEVICE;              // BBB222 unplugged; one left
      (adbRunner.forward as ReturnType<typeof vi.fn>).mockClear();
      const status = await mgr.connect({});
      expect(adbRunner.forward).toHaveBeenCalledWith(1, 'TESTSERIAL1', 9095);
      expect(status.detail ?? '').not.toMatch(/matches none/i);
      await mgr.disconnect();
    });

    it('refuses an attached-but-unauthorized device with the fix that happens ON THE PHONE', async () => {
      androidDevicesExec.list = () => 'List of devices attached\nCCC333  unauthorized usb:1-1\n';
      const mgr = new DeviceConnectionManager('g-unauth', stateDir);
      const status = await mgr.connect({ useAdb: true });
      expect(status.state).toBe('error');
      expect(status.detail).toMatch(/UNAUTHORIZED/i);
      expect(status.detail).toMatch(/allow usb debugging/i);
      expect(adbRunner.forward).not.toHaveBeenCalled();
    });
  });

  /** #160 — releasing the phone must release EVERYTHING pointing at it. The CDP session rides a
   *  second, separate `adb forward` on its own per-clone port, and the lease's `disconnect()` used
   *  to reclaim only its own tunnel: `resetDeviceCdpSession` had two production callers (a
   *  cache-key mismatch and a dispatch failure), neither of them the lease. So a disconnect left a
   *  cached session and a live tunnel aimed at a device the editor no longer holds. */
  describe('disconnect() also tears down the CDP tunnel (#160)', () => {
    it('drops the CDP forward the session was reached through', async () => {
      const listSockets = vi.spyOn(deviceCdpAdb, 'listUnixSockets')
        .mockReturnValue('0000 0002 0001 @webview_devtools_remote_1234\n');
      const cdpForward = vi.spyOn(deviceCdpAdb, 'forward').mockImplementation(() => {});
      const cdpRemove = vi.spyOn(deviceCdpAdb, 'removeForward').mockImplementation(() => {});
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (u: string) => ({
        ok: true,
        json: async () => (String(u).endsWith('/json/version')
          ? { 'Android-Package': 'com.modokiengine.sling' }
          : [{ type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:9335/devtools/page/1' }]),
      }) as unknown as Response) as unknown as typeof fetch;
      try {
        // Open a tunnel the way the input path does, then release the phone.
        await discoverDeviceCdpTarget({ localPort: 9335, serial: 'TESTSERIAL1' });
        expect(cdpForward).toHaveBeenCalledTimes(1);
        expect(cdpRemove).not.toHaveBeenCalled();

        const mgr = new DeviceConnectionManager('g-cdp-teardown', stateDir);
        await mgr.disconnect();

        expect(cdpRemove).toHaveBeenCalledWith(9335, 'TESTSERIAL1');
      } finally {
        globalThis.fetch = realFetch;
        listSockets.mockRestore(); cdpForward.mockRestore(); cdpRemove.mockRestore();
        resetDeviceCdpSession();
      }
    });

    /** Found in the #160 close-out, by attacking the paths the fix did NOT touch.
     *
     *  `disconnect()` has exactly one production caller — the explicit `/api/device/disconnect`
     *  route. So the resources came back when a human clicked Disconnect, and leaked on the far
     *  more common ending: quitting the editor with a device still connected. That is precisely
     *  the state #160 was reported from ("no editor was running for any of the three"), which
     *  means the fix that closed it did not reach the path its own evidence came from.
     *
     *  Measured after the fix, before this one: connect, one trusted tap, quit the editor —
     *  `tcp:9097` and `tcp:9335` both still standing and the claim still held by a dead pid. */
    it('releases BOTH forwards and this pid\'s claims on process exit, without a disconnect()', async () => {
      const listSockets = vi.spyOn(deviceCdpAdb, 'listUnixSockets')
        .mockReturnValue('0000 0002 0001 @webview_devtools_remote_1234\n');
      const cdpForward = vi.spyOn(deviceCdpAdb, 'forward').mockImplementation(() => {});
      const cdpRemove = vi.spyOn(deviceCdpAdb, 'removeForward').mockImplementation(() => {});
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (u: string) => ({
        ok: true,
        json: async () => (String(u).endsWith('/json/version')
          ? { 'Android-Package': 'com.modokiengine.sling' }
          : [{ type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:9335/devtools/page/1' }]),
      }) as unknown as Response) as unknown as typeof fetch;
      try {
        const mgr = new DeviceConnectionManager('g-exit', stateDir);
        await mgr.connect({ useAdb: true });
        (adbRunner.removeForward as ReturnType<typeof vi.fn>).mockClear();
        await discoverDeviceCdpTarget({ localPort: 9335, serial: 'TESTSERIAL1' });

        // The exit path — NOT disconnect(). Nothing is awaited: it must be sync all the way
        // down, because `process.on('exit')` cannot await and a signal may skip before-quit.
        releaseDeviceResourcesOnExit(mgr);

        expect(cdpRemove).toHaveBeenCalledWith(9335, 'TESTSERIAL1');   // the CDP tunnel
        expect(adbRunner.removeForward).toHaveBeenCalled();            // the lease's own forward
      } finally {
        globalThis.fetch = realFetch;
        listSockets.mockRestore(); cdpForward.mockRestore(); cdpRemove.mockRestore();
        resetDeviceCdpSession();
      }
    });

    /** Startup reclamation — the part that actually closes #160's observed symptom.
     *
     *  The exit-path teardown above is real but insufficient, and that was MEASURED rather than
     *  reasoned: `process.on('exit')`/`SIGINT`/`SIGTERM` handlers registered in the backend are
     *  installed under Electron and then never fire (Chromium takes the signal), and `kill -9`,
     *  an OOM and a crash would skip them anyway. Startup is the one teardown point nothing can
     *  skip — the same shape the claims file already uses, where a claim is expired by pid-liveness
     *  ON READ rather than by a polite release. */
    it('reclaims a leftover rule on THIS clone\'s ports at startup, and leaves other ports alone', () => {
      // The suite pins MODOKI_DEVICE_HOST_PORT (see beforeEach); drop it HERE so the real per-clone
      // derivation runs, which is the thing under test — reclaiming the wrong port is the whole risk.
      delete process.env.MODOKI_DEVICE_HOST_PORT;
      // 9095 = this clone's derived lease host port under the default backend; 9333 = its CDP port.
      // The third rule is a SIBLING's — a different port entirely, and touching it would be #158.
      adbRunner.listForwards = () => [
        'TESTSERIAL1 tcp:9095 tcp:9095',
        'TESTSERIAL1 tcp:9333 localabstract:webview_devtools_remote_777',
        'OTHERSERIAL tcp:9334 localabstract:webview_devtools_remote_888',
      ].join('\n');
      (adbRunner.removeForward as ReturnType<typeof vi.fn>).mockClear();

      reclaimStaleDeviceStateAtStartup();

      const ports = (adbRunner.removeForward as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
      expect(ports.sort()).toEqual([9095, 9333]);
      expect(ports).not.toContain(9334);          // the sibling clone's lane, never ours to reclaim
    });

    it('reclaims nothing when the ports are clear — the normal startup, and it must stay silent', () => {
      adbRunner.listForwards = () => 'OTHERSERIAL tcp:9334 localabstract:webview_devtools_remote_888';
      (adbRunner.removeForward as ReturnType<typeof vi.fn>).mockClear();
      reclaimStaleDeviceStateAtStartup();
      expect(adbRunner.removeForward).not.toHaveBeenCalled();
    });

    /** #225 — the claims half of the same startup hook.
     *
     *  A dead-pid claim never BLOCKED another clone (every reader applies `isStale`, and
     *  `deviceClaims.test.ts` measures that directly). What it did was sit in
     *  `~/.modoki/device-claims.json` naming a clone, a branch and a purpose — a file CLAUDE.md
     *  tells an agent to read as "did I give the phone back" — so the corpse read as a live hold
     *  and was hand-deleted twice before it became an issue. Startup is where it gets swept,
     *  because `stop-editor.sh` sends a SIGTERM that no in-process hook survives. */
    it('sweeps a dead-pid claim out of the claims FILE at startup, leaving live ones', () => {
      const file = path.join(claimsDir(), 'device-claims.json');
      fs.mkdirSync(claimsDir(), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ claims: [
        { deviceId: 'adb:THEIRS', clone: '/Users/x/Projects/modoki-ai3', branch: 'work-ai3', pid: 424242, at: Date.now(), purpose: 'holding a device lease over USB' },
        { deviceId: 'adb:MINE', clone: '/Users/x/Projects/modoki', branch: 'main', pid: process.pid, at: Date.now() },
      ] }));
      adbRunner.listForwards = () => '';

      reclaimStaleDeviceStateAtStartup();

      const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')).claims as Array<{ deviceId: string }>;
      expect(onDisk.map((c) => c.deviceId)).toEqual(['adb:MINE']);
      fs.rmSync(file, { force: true });
    });

    it('is a no-op when nothing is held — a bare import must not touch adb on exit', () => {
      const cdpRemove = vi.spyOn(deviceCdpAdb, 'removeForward').mockImplementation(() => {});
      (adbRunner.removeForward as ReturnType<typeof vi.fn>).mockClear();
      try {
        // No lease, no latched CDP forward, no claim for this pid. This is every test process that
        // merely imports the module — the exit hook is installed at module scope, so "harmless
        // when idle" is what makes that safe rather than a suite-wide adb side effect.
        expect(() => releaseDeviceResourcesOnExit()).not.toThrow();
        expect(cdpRemove).not.toHaveBeenCalled();
        expect(adbRunner.removeForward).not.toHaveBeenCalled();
      } finally { cdpRemove.mockRestore(); }
    });
  });
});

/** #164 — the claim a FAILED connect leaves behind.
 *
 *  The adb branch claims the hardware machine-wide BEFORE it forwards (#149), and the
 *  forward-failure path hands it straight back. The handshake-failure path did not — so the single
 *  commonest failure on USB (the app is not listening) left a claim standing under this clone's
 *  name. The symptom is worse than a leak: the RETRY is refused as busy, naming this very clone, so
 *  the caller's own dead attempt is indistinguishable from a sibling clone hogging the phone. Only
 *  an explicit `device_disconnect` cleared it, which nobody runs after a connect that failed.
 *
 *  Asserted against the CLAIMS FILE rather than a spy: what blocks the next connect is the file's
 *  content, and a released-in-memory claim that still has a row on disk would pass a spy test and
 *  fail in the only way that matters. */
describe('a connect that fails releases the hardware claim (#164)', () => {
  it('leaves no claim behind when the lease handshake never lands', async () => {
    // MODOKI_DEVICE_HOST_PORT is pinned to 1 by the suite, so this connect cannot succeed: the
    // forward is stubbed, nothing is listening, and the lease gives up. Exactly the shape of the
    // reported failure (the app is running; its debug server is not).
    const mgr = new DeviceConnectionManager('g-claim-leak', stateDir);
    const status = await mgr.connect({ useAdb: true });
    expect(status.state).not.toBe('connected');

    expect(listClaims(), 'a failed connect must not hold hardware — the retry would be refused as '
      + 'busy by this clone\'s own dead attempt').toEqual([]);
  });

  /** THE CONTROL. Without it, "no claim after a failure" would also pass if the connect path had
   *  stopped claiming altogether, or released unconditionally — a guard that holds for the wrong
   *  reason. A lease that DID land must keep its hold, which is the entire point of #149. */
  it('but a connect that SUCCEEDS keeps its claim — the release is scoped to failure', async () => {
    const authority = new DeviceLeaseAuthority();
    const device = await startMockDevice(authority);
    const mgr = new DeviceConnectionManager('g-claim-ok', stateDir);
    process.env.MODOKI_DEVICE_HOST_PORT = String(device.port);
    try {
      const status = await mgr.connect({ useAdb: true, port: 9095 });
      expect(status.state).toBe('connected');
      expect(listClaims().map((c) => c.deviceId)).toEqual(['adb:TESTSERIAL1']);
    } finally {
      delete process.env.MODOKI_DEVICE_HOST_PORT;
      await mgr.disconnect();
      await device.close();
    }
    expect(listClaims(), 'disconnect hands the hardware back too').toEqual([]);
  });
});
