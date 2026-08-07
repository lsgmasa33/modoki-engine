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
import { DeviceConnectionManager, adbRunner } from '../../plugins/backend/deviceConnection';
import { androidDevicesExec, _clearFriendlyNameCache } from '../../plugins/backend/androidDevices';
import { DeviceLeaseAuthority } from '../../plugins/backend/deviceLease';

const realForward = adbRunner.forward;
const realRemove = adbRunner.removeForward;
const realList = androidDevicesExec.list;
const realDeviceName = androidDevicesExec.deviceName;
/** One attached, usable phone — the unambiguous case, so these tests exercise the adb branch rather
 *  than the device-selection rule (which has its own tests in androidDevices.test.ts). */
const ONE_DEVICE = 'List of devices attached\nTESTSERIAL1  device usb:1-1 model:Test_Phone\n';
// Per-test `.modoki` so the persisted last-target never touches the real repo and can't leak between tests.
let stateDir: string;
beforeEach(() => {
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
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-adb-'));
});
afterEach(() => {
  delete process.env.MODOKI_DEVICE_HOST_PORT;
  adbRunner.forward = realForward; adbRunner.removeForward = realRemove;
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
});
