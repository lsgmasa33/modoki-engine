/** #1065 — the `useUsb` connect branch: iOS over USB through a lease-owned go-ios `ios forward`.
 *
 *  Same seam discipline as `deviceConnectAdb.test.ts`: `goIosForwardRunner` is overridden, so neither
 *  the real go-ios binary nor the machine's attached iPhones decide a result, `MODOKI_HOME` is a temp
 *  dir so the hardware claim never lands in the developer's real claims file, and the host port is
 *  pinned. The child is a fake that behaves like `ios forward` where it matters: it logs "start listening"
 *  — which go-ios v1.3.2 does BEFORE binding, so readiness is the socket table `listenersOn`, modelled
 *  here as "the newest live child holds the port" — and `kill()` makes it exit. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import net from 'net';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import {
  DeviceConnectionManager, adbRunner, loadLastTarget, releaseDeviceResourcesOnExit, reclaimStaleDeviceStateAtStartup,
  shouldReclaimDeviceStateHere, VITE_UNDER_ELECTRON_ENV,
} from '../../plugins/backend/deviceConnection';
import { readScannedSource } from '@modoki/engine/testing';
import { goIosForwardRunner, reapDeps } from '../../plugins/backend/iosUsbForward';
import { DeviceLeaseAuthority } from '../../plugins/backend/deviceLease';
import { listClaims } from '../../plugins/backend/deviceClaims';

let nextPid = 4242;

type FakeChild = EventEmitter & {
  stdout: EventEmitter; stderr: EventEmitter; pid: number;
  exitCode: number | null; signalCode: string | null; killed: boolean; kill: ReturnType<typeof vi.fn>;
};

/** `listens:false` = a child that never binds, so the connect stays suspended on its readiness. */
function fakeChild(o: { listens?: boolean } = {}): FakeChild {
  const c = new EventEmitter() as FakeChild;
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.pid = nextPid++;
  c.exitCode = null;
  c.signalCode = null;
  c.killed = false;
  c.kill = vi.fn(() => { c.killed = true; c.signalCode = 'SIGTERM'; c.emit('exit', null, 'SIGTERM'); return true; });
  if (o.listens !== false) queueMicrotask(() => c.stderr.emit('data', '{"level":"INFO","msg":"start listening, forwarding to device"}\n'));
  return c;
}

const WARN = '{"level":"WARN","msg":"go-ios agent is not running."}';
const entry = (udid: string, connectionType: string) =>
  ({ Udid: udid, ProductName: 'iPhone OS', ProductType: 'iPad11,1', ProductVersion: '26.6.1', ConnectionType: connectionType });
const listing = (...entries: object[]) => `${WARN}\n${JSON.stringify({ deviceList: entries })}\n`;

const BIN = '/fake/toolchain/go-ios/ios';
const real = { ...goIosForwardRunner };
const realAdb = { forward: adbRunner.forward, removeForward: adbRunner.removeForward, listForwards: adbRunner.listForwards };
const realReap = { ...reapDeps };

let children: FakeChild[];
let nextChild: () => FakeChild;
let stateDir: string;
let home: string;
let prevHome: string | undefined;
let prevBackendPort: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-home-'));
  prevHome = process.env.MODOKI_HOME;
  process.env.MODOKI_HOME = home;
  prevBackendPort = process.env.MODOKI_BACKEND_PORT;
  delete process.env.MODOKI_BACKEND_PORT;
  process.env.MODOKI_DEVICE_HOST_PORT = '1';
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-usb-'));
  children = [];
  nextPid = 4242;
  nextChild = () => fakeChild();
  goIosForwardRunner.resolveBinary = () => BIN;
  // Every child that has not EXITED still holds the port — a killed one included, until its exit lands.
  goIosForwardRunner.listenersOn = vi.fn(async () => ({
    ok: true as const,
    listeners: children.filter((c) => c.exitCode === null && c.signalCode === null).map((c) => ({ pid: c.pid, command: 'ios' })),
  }));
  goIosForwardRunner.listDetails = vi.fn(async () => listing(entry('UDID-IPAD', 'USB')));
  goIosForwardRunner.spawnForward = vi.fn(() => { const c = nextChild(); children.push(c); return c as unknown as ChildProcess; });
  adbRunner.forward = vi.fn();
  adbRunner.removeForward = vi.fn();
});

afterEach(() => {
  Object.assign(goIosForwardRunner, real);
  Object.assign(adbRunner, realAdb);
  Object.assign(reapDeps, realReap);
  if (prevHome === undefined) delete process.env.MODOKI_HOME; else process.env.MODOKI_HOME = prevHome;
  if (prevBackendPort === undefined) delete process.env.MODOKI_BACKEND_PORT; else process.env.MODOKI_BACKEND_PORT = prevBackendPort;
  delete process.env.MODOKI_DEVICE_HOST_PORT;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(stateDir, { recursive: true, force: true });
});

/** `disconnectDelayMs` holds back the reply to a lease `disconnect`, so a hang-up stays in flight. */
function startMockDevice(authority: DeviceLeaseAuthority, opts: { disconnectDelayMs?: number } = {}): Promise<{ port: number; close: () => Promise<void> }> {
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
          if (msg.method === 'disconnect' && opts.disconnectDelayMs) {
            const id = msg.id;
            setTimeout(() => {
              if (!socket.destroyed) socket.write(JSON.stringify({ id, result: authority.disconnect(guid, Date.now()) }) + '\n');
            }, opts.disconnectDelayMs);
            continue;
          }
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

const claimed = () => listClaims().map((c: { deviceId: string }) => c.deviceId);
const recordFile = () => path.join(stateDir, 'ios-forward.json');

/** A connected USB lease against a mock device standing in for the host end of the tunnel. */
async function connectedUsb(mgr: DeviceConnectionManager, opts: { disconnectDelayMs?: number } = {}) {
  const device = await startMockDevice(new DeviceLeaseAuthority(), opts);
  process.env.MODOKI_DEVICE_HOST_PORT = String(device.port);
  const status = await mgr.connect({ useUsb: true });
  return { device, status };
}

describe('DeviceConnectionManager — useUsb branch (#1065)', () => {
  it('forwards through go-ios to 127.0.0.1, holds the phone by UDID, and records the child', async () => {
    const mgr = new DeviceConnectionManager('g-usb-ok', stateDir);
    const { device, status } = await connectedUsb(mgr);
    try {
      expect(goIosForwardRunner.spawnForward).toHaveBeenCalledWith(BIN, device.port, 9095, 'UDID-IPAD');
      expect(status.state).toBe('connected');
      expect(status.target).toEqual({ host: '127.0.0.1', port: device.port, useAdb: false, useUsb: true, udid: 'UDID-IPAD' });
      expect(claimed()).toContain('ios:UDID-IPAD');
      expect(JSON.parse(fs.readFileSync(recordFile(), 'utf8'))).toEqual({ pid: 4242, hostPort: device.port, bin: BIN, owner: process.pid, instance: expect.any(String) });
      expect(adbRunner.forward).not.toHaveBeenCalled();
    } finally {
      await mgr.disconnect();
      await device.close();
    }
  });

  it('disconnect kills the child, drops its record and hands the phone back', async () => {
    const mgr = new DeviceConnectionManager('g-usb-disc', stateDir);
    const { device } = await connectedUsb(mgr);
    try {
      await mgr.disconnect();
      expect(children[0].kill).toHaveBeenCalledOnce();
      expect(fs.existsSync(recordFile())).toBe(false);
      expect(claimed()).not.toContain('ios:UDID-IPAD');
    } finally {
      await device.close();
    }
  });

  it('a connect that SUPERSEDES the USB lease kills its child — disconnect heads every connect', async () => {
    const mgr = new DeviceConnectionManager('g-usb-super', stateDir);
    const { device } = await connectedUsb(mgr);
    try {
      await mgr.connect({ ip: '127.0.0.1', port: 1 });
      expect(children[0].kill).toHaveBeenCalledOnce();
    } finally {
      await mgr.disconnect();
      await device.close();
    }
  });

  it('a USB connect that does not LAND stops its child and releases the claim (#164\'s rule, for a process)', async () => {
    const mgr = new DeviceConnectionManager('g-usb-noland', stateDir);   // host port 1: nothing answers
    const status = await mgr.connect({ useUsb: true });
    expect(status.state).not.toBe('connected');
    expect(children[0].kill).toHaveBeenCalledOnce();
    expect(fs.existsSync(recordFile())).toBe(false);
    expect(claimed()).not.toContain('ios:UDID-IPAD');
  });

  it('a forward that never binds is a connect error carrying go-ios\'s own reason, with nothing left held', async () => {
    // The order go-ios v1.3.2 really prints it: the "start listening" line FIRST, then the bind error.
    goIosForwardRunner.listenersOn = vi.fn(async () => ({ ok: true as const, listeners: [] }));
    nextChild = () => {
      const c = fakeChild({ listens: false });
      queueMicrotask(() => {
        c.stderr.emit('data', '{"level":"INFO","msg":"start listening, forwarding to device"}\n');
        c.stderr.emit('data', '{"level":"ERROR","msg":"failed to forward port","err":"listen tcp 0.0.0.0:1: bind: address already in use"}\n');
        c.exitCode = 1;
        c.emit('exit', 1, null);
      });
      return c;
    };
    const mgr = new DeviceConnectionManager('g-usb-bind', stateDir);
    const status = await mgr.connect({ useUsb: true });
    expect(status.state).toBe('error');
    expect(status.detail).toMatch(/^go-ios forward failed: .*address already in use/);
    expect(claimed()).not.toContain('ios:UDID-IPAD');
    expect(fs.existsSync(recordFile())).toBe(false);
  });

  it('a disconnect landing while the forward is still starting kills it, and the connect publishes nothing', async () => {
    nextChild = () => fakeChild({ listens: false });
    const mgr = new DeviceConnectionManager('g-usb-race', stateDir);
    const pending = mgr.connect({ useUsb: true });
    await vi.waitFor(() => expect(goIosForwardRunner.spawnForward).toHaveBeenCalled());
    await mgr.disconnect();
    // Killed BY THE DISCONNECT — asserted before the connect settles. The connect's own superseded
    // branch also stops the child, but only once its readiness wait ends (5s for a child that never
    // binds), so a test that looked after `await pending` stayed green with the forward unpublished.
    expect(children[0].kill).toHaveBeenCalled();
    await pending;
    expect(mgr.status().state).toBe('disconnected');
    expect(mgr.status().target).toBeNull();
    expect(claimed()).not.toContain('ios:UDID-IPAD');
  });

  it('a forward that dies MID-LEASE ends the lease with the reason, and hands the phone back', async () => {
    // Before this the handle was dropped but the lease sat in `reconnecting` against a dead port for good,
    // keeping `ios:<udid>` claimed — observed by the close-out re-review.
    const mgr = new DeviceConnectionManager('g-usb-midlease', stateDir);
    const { device } = await connectedUsb(mgr);
    try {
      const child = children[0];
      child.exitCode = 1;
      child.emit('exit', 1, null);
      await vi.waitFor(() => expect(mgr.status().state).toBe('error'));
      expect(mgr.status().detail).toMatch(/go-ios forward exited \(1\) mid-lease/);
      expect(claimed()).not.toContain('ios:UDID-IPAD');
      expect(fs.existsSync(recordFile())).toBe(false);
      child.exitCode = null;   // so a stop() through a STALE handle would reach kill() — it must not get to
      await mgr.disconnect();
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      await device.close();
    }
  });

  it('a connect that lands while the dead forward\'s teardown is still hanging up keeps its state — the teardown\'s error is stale', async () => {
    const mgr = new DeviceConnectionManager('g-usb-deadrace', stateDir);
    const { device } = await connectedUsb(mgr, { disconnectDelayMs: 300 });
    try {
      children[0].exitCode = 1;
      children[0].emit('exit', 1, null);      // onExit starts a disconnect whose hang-up waits 300ms for a reply
      const again = await mgr.connect({ useUsb: true });
      expect(again.state).toBe('connected');
      await new Promise((r) => setTimeout(r, 450));   // past the reply: the stale teardown's continuation has run
      expect(mgr.status().state).toBe('connected');
      expect(mgr.status().detail ?? '').not.toMatch(/mid-lease/);
    } finally {
      await mgr.disconnect();
      await device.close();
    }
  });

  it('a re-target waits for the old forward to EXIT, so the new connect does not find it on the port', async () => {
    // go-ios exits on SIGTERM within milliseconds, not synchronously — model that.
    nextChild = () => {
      const c = fakeChild();
      c.kill = vi.fn(() => {
        c.killed = true;
        setTimeout(() => { c.signalCode = 'SIGTERM'; c.emit('exit', null, 'SIGTERM'); }, 30);
        return true;
      });
      return c;
    };
    const mgr = new DeviceConnectionManager('g-usb-retarget', stateDir);
    const { device } = await connectedUsb(mgr);
    try {
      const again = await mgr.connect({ useUsb: true });
      expect(again.detail ?? '').not.toMatch(/also listened on by/);
      expect(again.state).toBe('connected');
      expect(children).toHaveLength(2);
    } finally {
      await mgr.disconnect();
      await device.close();
    }
  });

  it('a host port another process already listens on is refused before spawning, naming the holder', async () => {
    goIosForwardRunner.listenersOn = vi.fn(async () => ({ ok: true as const, listeners: [{ pid: 84945, command: 'Python' }] }));
    const mgr = new DeviceConnectionManager('g-usb-portheld', stateDir);
    const status = await mgr.connect({ useUsb: true });
    expect(status.state).toBe('error');
    expect(status.detail).toMatch(/^go-ios forward failed: .*also listened on by Python \(pid 84945\)/);
    expect(goIosForwardRunner.spawnForward).not.toHaveBeenCalled();
    expect(claimed()).not.toContain('ios:UDID-IPAD');
  });

  it('refuses a device whose usbmuxd NETWORK entry comes first — spawning nothing, claiming nothing', async () => {
    goIosForwardRunner.listDetails = vi.fn(async () => listing(entry('UDID-PHONE', 'Network'), entry('UDID-PHONE', 'USB')));
    const mgr = new DeviceConnectionManager('g-usb-netfirst', stateDir);
    const status = await mgr.connect({ useUsb: true });
    expect(status.state).toBe('error');
    expect(status.detail).toMatch(/NETWORK before USB/);
    expect(goIosForwardRunner.spawnForward).not.toHaveBeenCalled();
    expect(claimed()).toEqual([]);
  });

  it('refuses useAdb together with useUsb, before touching either tool', async () => {
    const mgr = new DeviceConnectionManager('g-usb-both', stateDir);
    const status = await mgr.connect({ useAdb: true, useUsb: true });
    expect(status.detail).toMatch(/two different tunnels/);
    expect(goIosForwardRunner.listDetails).not.toHaveBeenCalled();
    expect(adbRunner.forward).not.toHaveBeenCalled();
  });

  it('says go-ios is missing when it is', async () => {
    goIosForwardRunner.resolveBinary = () => null;
    const status = await new DeviceConnectionManager('g-usb-nogoios', stateDir).connect({ useUsb: true });
    expect(status.detail).toMatch(/go-ios is not installed/);
  });

  it('remembers USB + the UDID, so a bare reconnect re-picks the same device among several', async () => {
    const mgr = new DeviceConnectionManager('g-usb-recon', stateDir);
    goIosForwardRunner.listDetails = vi.fn(async () => listing(entry('UDID-A', 'USB'), entry('UDID-B', 'USB')));
    await mgr.connect({ useUsb: true, udid: 'UDID-B' });
    expect(loadLastTarget(stateDir)).toMatchObject({ useUsb: true, udid: 'UDID-B' });
    (goIosForwardRunner.spawnForward as ReturnType<typeof vi.fn>).mockClear();
    await mgr.connect({});
    expect(goIosForwardRunner.spawnForward).toHaveBeenCalledWith(BIN, 1, 9095, 'UDID-B');
    await mgr.disconnect();
  });

  it('the exit path kills the child synchronously', async () => {
    const mgr = new DeviceConnectionManager('g-usb-exit', stateDir);
    const { device } = await connectedUsb(mgr);
    try {
      releaseDeviceResourcesOnExit(mgr);
      expect(children[0].kill).toHaveBeenCalledOnce();
    } finally {
      await mgr.disconnect();
      await device.close();
    }
  });

  it('startup reaps a forward a previous run of this clone recorded', () => {
    fs.writeFileSync(recordFile(), JSON.stringify({ pid: 777, hostPort: 9097, bin: BIN }));
    reapDeps.commandOf = () => `${BIN} forward 9097 9095 --udid=UDID-IPAD`;
    reapDeps.kill = vi.fn();
    adbRunner.listForwards = () => '';
    reclaimStaleDeviceStateAtStartup(stateDir);
    expect(reapDeps.kill).toHaveBeenCalledWith(777);
    expect(fs.existsSync(recordFile())).toBe(false);
  });
});

describe('the startup reclaim is skipped in Electron\'s Vite child (#1065 close-out review)', () => {
  it('reclaims in a backend host, not in a Vite server Electron spawned', () => {
    expect(shouldReclaimDeviceStateHere({})).toBe(true);
    expect(shouldReclaimDeviceStateHere({ [VITE_UNDER_ELECTRON_ENV]: '1' })).toBe(false);
  });

  it('Electron spawns its Vite child with that marker, and the Vite host asks before reclaiming', () => {
    const devServer = readScannedSource(path.join(__dirname, '../../electron/devServer.ts')).code;
    expect(devServer).toMatch(new RegExp(`env: \\{[^}]*${VITE_UNDER_ELECTRON_ENV}: '1'`));
    const vite = readScannedSource(path.join(__dirname, '../../plugins/vite-asset-scanner.ts')).code;
    expect(vite).toMatch(/if \(shouldReclaimDeviceStateHere\(\)\) reclaimStaleDeviceStateAtStartup\(\);/);
  });
});
