/** #506 item 3 — reentrancy in the #283 port-rediscovery block inside `connect()`.
 *
 *  `disconnect()` nulls `client`/`transport`/`target` and releases the machine-wide claim; the
 *  rediscovery block used to assign `this.transport`/`this.client`/`this.target` straight from a
 *  suspended continuation AFTER several `await`s, so an external `device_disconnect` landing inside
 *  that window was undone by the resume — re-installing a live, connected client on a manager that
 *  had already given the hardware back. This file drives that exact window with a real TCP mock
 *  device whose SECOND connection (the rediscovery retry) is held open until the test releases it,
 *  so a `disconnect()` can be made to land while `client.connect()` is still in flight.
 *
 *  A NEW file, not an addition to `deviceConnection.test.ts`: reaching the rediscovery branch needs
 *  `useAdb: true` with no explicit `port`, which pulls in the same machine-scoped seams
 *  `deviceConnectAdb.test.ts` isolates (`androidDevicesExec.list`, `adbRunner.forward`,
 *  `MODOKI_HOME`) — none of which the real-TCP suite's tests need or expect. `discoverBridgePort`
 *  itself is exercised for REAL (not `vi.mock`ed): its own `adb shell` reads sit behind the
 *  `bridgePortExec` seam (see `androidBridgePort.ts`), which is stubbed the same way the other
 *  adb-shaped reads are — so this file needs no whole-module mock and cannot corrupt the real-TCP
 *  suite's module graph.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import net from 'net';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { DeviceConnectionManager, adbRunner } from '../../plugins/backend/deviceConnection';
import { androidDevicesExec, _clearFriendlyNameCache } from '../../plugins/backend/androidDevices';
import { DeviceLeaseAuthority, DeviceLeaseClient } from '../../plugins/backend/deviceLease';
import { listClaims } from '../../plugins/backend/deviceClaims';
import { bridgePortExec } from '../../plugins/backend/androidBridgePort';

const realForward = adbRunner.forward;
const realRemove = adbRunner.removeForward;
const realLogcatDump = adbRunner.logcatDump;
const realList = androidDevicesExec.list;
const realDeviceName = androidDevicesExec.deviceName;
const realProcNetTcp = bridgePortExec.procNetTcp;
const realDumpsysWindow = bridgePortExec.dumpsysWindow;
const realPackageUid = bridgePortExec.packageUid;

const ONE_DEVICE = 'List of devices attached\nTESTSERIAL1  device usb:1-1 model:Test_Phone\n';

// The app the "foreground" fixture names, and the port `discoverBridgePort` resolves for it — kept
// DIFFERENT from `DEVICE_PORT` (9095) so the rediscovery branch fires on every connect in this file,
// regardless of whether the primary attempt landed.
const FOUND_PKG = 'test.foreground.pkg';
const FOUND_PORT = 9200; // 0x23F0

const FAKE_DUMPSYS_WINDOW = `mFocusedApp=ActivityRecord{a1b2c3 u0 ${FOUND_PKG}/.MainActivity} t1}\n`;
const FAKE_PACKAGE_UID = 'userId=10123\n';
const FOUND_PORT_HEX = FOUND_PORT.toString(16).toUpperCase().padStart(4, '0');
const FAKE_PROC_NET_TCP =
  'sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n'
  + ` 0: 0100007F:${FOUND_PORT_HEX} 00000000:0000 0A 00000000:00000000 00:00000000 00000000 10123        0 12345 1 0000000000000000 100 0 0 10 0\n`;

let stateDir: string;
let home: string;
let prevHome: string | undefined;
let prevBackendPort: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-home-'));
  prevHome = process.env.MODOKI_HOME;
  process.env.MODOKI_HOME = home;
  adbRunner.forward = vi.fn();
  adbRunner.removeForward = vi.fn();
  adbRunner.logcatDump = vi.fn(async () => '');
  androidDevicesExec.list = () => ONE_DEVICE;
  androidDevicesExec.deviceName = () => '';
  _clearFriendlyNameCache();
  bridgePortExec.procNetTcp = () => FAKE_PROC_NET_TCP;
  bridgePortExec.dumpsysWindow = () => FAKE_DUMPSYS_WINDOW;
  bridgePortExec.packageUid = () => FAKE_PACKAGE_UID;
  prevBackendPort = process.env.MODOKI_BACKEND_PORT;
  delete process.env.MODOKI_BACKEND_PORT;
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-reentrancy-'));
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.MODOKI_HOME;
  else process.env.MODOKI_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.MODOKI_DEVICE_HOST_PORT;
  if (prevBackendPort === undefined) delete process.env.MODOKI_BACKEND_PORT;
  else process.env.MODOKI_BACKEND_PORT = prevBackendPort;
  adbRunner.forward = realForward;
  adbRunner.removeForward = realRemove;
  adbRunner.logcatDump = realLogcatDump;
  androidDevicesExec.list = realList;
  androidDevicesExec.deviceName = realDeviceName;
  bridgePortExec.procNetTcp = realProcNetTcp;
  bridgePortExec.dumpsysWindow = realDumpsysWindow;
  bridgePortExec.packageUid = realPackageUid;
  _clearFriendlyNameCache();
  fs.rmSync(stateDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A real TCP "device" whose SECOND connection (the rediscovery retry client) is held open until
 *  the test calls `releaseGate()` — everything up to and including the `connect` handshake
 *  response is deferred, so `client.connect()` inside the manager's rediscovery block stays
 *  suspended for as long as the test wants. The FIRST connection (the primary attempt) always
 *  answers immediately, so the happy-path primary landing is not what this file is measuring. */
function startGatedMockDevice(authority: DeviceLeaseAuthority, gateConnNumber = 2, opts: { refuseGated?: boolean } = {}): Promise<{
  port: number;
  close: () => Promise<void>;
  releaseGate: () => void;
  secondConnectSeen: Promise<void>;
}> {
  const { refuseGated = false } = opts;
  let connCount = 0;
  let releaseGate: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
  let markSecondConnectSeen: (() => void) | undefined;
  const secondConnectSeen = new Promise<void>((resolve) => { markSecondConnectSeen = resolve; });
  // A test that stubs `DeviceLeaseClient.prototype.disconnect` (to isolate the onState guard from
  // the unwind's own disconnect call, see the third `it` below) never closes these sockets from
  // the client side — `net.Server#close()` waits for every open connection to end before its
  // callback fires, so without tracking and force-destroying them here, `close()` would hang for
  // the rest of the suite rather than for this file's own reason.
  const liveSockets: net.Socket[] = [];

  return new Promise((resolveServer) => {
    const server = net.createServer((socket) => {
      connCount += 1;
      const isSecond = connCount === gateConnNumber;
      liveSockets.push(socket);
      socket.on('close', () => { const i = liveSockets.indexOf(socket); if (i >= 0) liveSockets.splice(i, 1); });
      socket.setEncoding('utf8');
      let buf = '';
      socket.on('data', (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          let msg: { id: string; method: string; params?: { guid?: string } };
          try { msg = JSON.parse(line); } catch { continue; }
          const guid = msg.params?.guid ?? '';
          const respond = (result: unknown) => socket.write(JSON.stringify({ id: msg.id, result }) + '\n');
          if (msg.method === 'connect' && isSecond) {
            markSecondConnectSeen?.();
            // `refuseGated` answers the GATED connection with an explicit refusal instead of
            // routing it through the authority — used to reach a `landed !== 'connected'` outcome
            // on the gated attempt itself, which a plain `authority.connect()` (always ok:true
            // here) cannot produce.
            void gate.then(() => respond(refuseGated ? { ok: false, reason: 'busy' } : authority.connect(guid, Date.now())));
          } else if (msg.method === 'connect') {
            respond(authority.connect(guid, Date.now()));
          } else if (msg.method === 'ping') {
            respond(authority.ping(guid, Date.now()));
          } else if (msg.method === 'disconnect') {
            respond(authority.disconnect(guid, Date.now()));
          } else {
            respond({ ok: false, reason: 'not-owner' });
          }
        }
      });
      socket.on('close', () => authority.socketDropped(Date.now()));
      socket.on('error', () => { /* client went away */ });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      resolveServer({
        port,
        close: () => new Promise<void>((r) => { for (const s of liveSockets.slice()) s.destroy(); server.close(() => r()); }),
        releaseGate: () => releaseGate?.(),
        secondConnectSeen,
      });
    });
  });
}

describe('DeviceConnectionManager — a disconnect() landing inside the #283 rediscovery window (#506)', () => {
  it('does not leave a live client installed on the manager', async () => {
    const authority = new DeviceLeaseAuthority();
    const device = await startGatedMockDevice(authority);
    process.env.MODOKI_DEVICE_HOST_PORT = String(device.port);
    const mgr = new DeviceConnectionManager('g-506-1', stateDir);
    try {
      const connectDone = mgr.connect({ useAdb: true });
      await device.secondConnectSeen; // the rediscovery retry is now suspended on the handshake
      await mgr.disconnect(); // the external device_disconnect landing mid-window
      device.releaseGate(); // let the suspended handshake resolve
      const status = await connectDone;

      // The disconnect must WIN: the manager reports the disconnected state it settled on, not a
      // client re-installed by the resumed continuation.
      expect(status.state).toBe('disconnected');
      expect(status.target).toBeNull();
      // Read back through status() again — a second call proves this is the manager's settled
      // state, not a one-off value returned by the raced connect() before publishing landed late.
      expect(mgr.status().state).toBe('disconnected');
      expect(mgr.status().target).toBeNull();
    } finally {
      await mgr.disconnect();
      await device.close();
    }
  });

  it('hangs up the superseded client, rather than merely dropping it', async () => {
    const authority = new DeviceLeaseAuthority();
    const device = await startGatedMockDevice(authority);
    process.env.MODOKI_DEVICE_HOST_PORT = String(device.port);
    const mgr = new DeviceConnectionManager('g-506-2', stateDir);
    const disconnectSpy = vi.spyOn(DeviceLeaseClient.prototype, 'disconnect');
    try {
      const connectDone = mgr.connect({ useAdb: true });
      await device.secondConnectSeen;
      await mgr.disconnect();
      const disconnectCallsAfterExternalDisconnect = disconnectSpy.mock.calls.length;
      device.releaseGate();
      await connectDone;

      // The LOCALLY-BUILT retry client (never published onto `this.client`) must still be hung up
      // — this is what distinguishes "unwind" from "just don't publish and leak the socket". (The
      // unwind deliberately does NOT also remove the forward rule it made — see Finding 1 in
      // #506's review: that rule is host-port-scoped and shared with whoever superseded us, so
      // removing it here would tear down a WINNER's live tunnel, not a leaked one.)
      expect(disconnectSpy.mock.calls.length).toBeGreaterThan(disconnectCallsAfterExternalDisconnect);
    } finally {
      await mgr.disconnect();
      await device.close();
    }
  });

  it('a superseded onState callback cannot write connected status onto a disconnected manager', async () => {
    const authority = new DeviceLeaseAuthority();
    const device = await startGatedMockDevice(authority);
    process.env.MODOKI_DEVICE_HOST_PORT = String(device.port);
    const mgr = new DeviceConnectionManager('g-506-3', stateDir);
    // The Part-3 unwind's own `client.disconnect()` call ALSO ends in `setState('disconnected')`
    // (see `DeviceLeaseClient.disconnect()`), which would otherwise overwrite an unguarded
    // onState's 'connected' write back to 'disconnected' and make this test pass whether or not
    // the onState guard exists. Stub it out so the ONLY thing that can still write `manager.state`
    // after `mgr.disconnect()` is the onState callback itself — isolating exactly the guard this
    // test exists to pin. `manager.disconnect()`'s own `this.state = 'disconnected'` (set directly,
    // not through this callback) is unaffected by the stub.
    const disconnectStub = vi.spyOn(DeviceLeaseClient.prototype, 'disconnect').mockResolvedValue(undefined);
    try {
      const connectDone = mgr.connect({ useAdb: true });
      await device.secondConnectSeen;
      await mgr.disconnect();
      expect(mgr.status().state).toBe('disconnected');
      // The gate release lets the retry's handshake succeed — the exact moment the (guarded)
      // onState callback fires 'connected' on a manager that has already moved on.
      device.releaseGate();
      await connectDone;
      expect(mgr.status().state).toBe('disconnected');
    } finally {
      disconnectStub.mockRestore();
      await mgr.disconnect();
      await device.close();
    }
  });

  it('a superseded PRIMARY onState callback cannot write connected status onto a disconnected manager', async () => {
    const authority = new DeviceLeaseAuthority();
    // Gate connection #1 (the PRIMARY `client.connect()` at `:716`, before rediscovery even runs)
    // instead of #2 (the rediscovery retry the other three tests exercise). Removing the
    // `generation !== this.sessionGeneration` guard from the PRIMARY `onState` callback (`:713`)
    // leaves the other tests in this file green — they all suspend later, inside the rediscovery
    // block's own retry client, which has its own separately-guarded `onState`. This is the common
    // path: no adb rediscovery even needs to fire for a `disconnect()` to land while the primary
    // `client.connect()` is still in flight.
    const device = await startGatedMockDevice(authority, 1);
    process.env.MODOKI_DEVICE_HOST_PORT = String(device.port);
    const mgr = new DeviceConnectionManager('g-506-primary', stateDir);
    try {
      const connectDone = mgr.connect({ useAdb: true });
      // Despite the property's name (written for the #2 case), it resolves on whichever connection
      // was gated — here, the first.
      await device.secondConnectSeen;
      await mgr.disconnect();
      expect(mgr.status().state).toBe('disconnected');
      // The gate release lets the primary handshake succeed — the exact moment the (guarded)
      // onState callback fires 'connected' on a manager that has already moved on.
      device.releaseGate();
      await connectDone;
      expect(mgr.status().state).toBe('disconnected');
    } finally {
      await mgr.disconnect();
      await device.close();
    }
  });

  it('does not write a stale detail after a superseded connect fails to land (#506 finding 4)', async () => {
    const authority = new DeviceLeaseAuthority();
    // Gate the PRIMARY connection and REFUSE it once released, so it lands as something other than
    // 'connected' — the finding-4 write path (`:854`) is only reached on a non-connected landing,
    // which none of the tests above exercise (their primary attempt always succeeds outright).
    const device = await startGatedMockDevice(authority, 1, { refuseGated: true });
    process.env.MODOKI_DEVICE_HOST_PORT = String(device.port);
    // A non-empty logcat so `parseBoundBridgePort` actually finds a port and the write this test
    // pins would have something to write — an empty dump (the file's usual default mock) makes
    // `if (sniffed)` false regardless of the generation guard, which would let this test pass for
    // the wrong reason.
    const logcatDumpStub = vi.spyOn(adbRunner, 'logcatDump').mockResolvedValue('listening on port 9321\n');
    const mgr = new DeviceConnectionManager('g-506-4', stateDir);
    try {
      const connectDone = mgr.connect({ useAdb: true });
      await device.secondConnectSeen;
      await mgr.disconnect();
      device.releaseGate();
      const status = await connectDone;

      expect(status.state).toBe('disconnected');
      // The superseded continuation still runs the (best-effort) logcat sniff, but must not WRITE
      // its result onto a manager that has already moved on — `disconnect()` settled `detail` to
      // undefined, and that must stick.
      expect(mgr.status().detail).toBeUndefined();
    } finally {
      logcatDumpStub.mockRestore();
      await mgr.disconnect();
      await device.close();
    }
  });
});

/** #164 REGRESSION GUARD — the Part 2 trap. Moving the `sessionGeneration` capture back above
 *  `await this.disconnect()` (as `connect()` used to do) makes `generation === this.sessionGeneration`
 *  false on EVERY connect (not just a raced one), since `disconnect()`'s own bump lands one line
 *  later — silently disabling the #164 release-on-failure guard. This must fail if that capture is
 *  moved back. */
describe('DeviceConnectionManager — a failed connect still releases the claim (#164 regression guard)', () => {
  it('leaves no claim behind when the lease handshake never lands', async () => {
    // MODOKI_DEVICE_HOST_PORT is left unset → derives a real, almost-certainly-refused port via
    // resolveDeviceHostPort's normal band; pin it to 1 instead so this can never accidentally land.
    process.env.MODOKI_DEVICE_HOST_PORT = '1';
    const mgr = new DeviceConnectionManager('g-506-164', stateDir);
    const status = await mgr.connect({ useAdb: true });
    expect(status.state).not.toBe('connected');

    expect(listClaims(), 'a failed connect must not hold hardware — the retry would be refused as '
      + 'busy by this clone\'s own dead attempt').toEqual([]);
  });
});
