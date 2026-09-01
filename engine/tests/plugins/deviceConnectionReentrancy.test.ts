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
import { DeviceConnectionManager, adbRunner, DEVICE_PORT } from '../../plugins/backend/deviceConnection';
import { androidDevicesExec, _clearFriendlyNameCache } from '../../plugins/backend/androidDevices';
import { DeviceLeaseAuthority, DeviceLeaseClient } from '../../plugins/backend/deviceLease';
import { listClaims, adbDeviceId } from '../../plugins/backend/deviceClaims';
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
  /** How many client sockets are still OPEN on the device side. The observable for an orphaned
   *  client (#527): a lease socket nobody on the manager holds a reference to any more still
   *  counts here, because only a `DeviceLeaseClient.disconnect()` closes it. */
  openSocketCount: () => number;
  /** How many TCP connections the device has EVER accepted — every `connectInner` call opens
   *  exactly one new socket via `TcpLeaseTransport.open()`, so this is the observable for "how many
   *  separate connection ATTEMPTS happened", including ones since closed. Used to pin the Change-2
   *  join behavior: a joined second `connect()` must not increment this at all. */
  connectionCount: () => number;
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
        openSocketCount: () => liveSockets.length,
        connectionCount: () => connCount,
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

describe('DeviceConnectionManager — two racing connect() calls (#527)', () => {
  it('a second connect() landing mid-handshake leaves no orphaned socket', async () => {
    // This shape was investigated as #527's leading candidate and found to be ALREADY SAFE. Gate
    // the PRIMARY connection (#1) so connect A publishes `transport`/`client`/`target` un-gated and
    // then suspends inside `client.connect()`. Fire connect B while A is suspended: B's head
    // `await this.disconnect()` hangs up whatever `this.client` is — A's client, whose handshake has
    // NOT completed yet — and then B overwrites all three fields with its own.
    //
    // The question this test answers: when the gate releases and A's handshake completes, does A's
    // socket come up LIVE after the only disconnect that could ever have targeted it already ran? A
    // fully torn-down manager must leave no lease socket open regardless.
    const authority = new DeviceLeaseAuthority();
    const device = await startGatedMockDevice(authority, 1);
    process.env.MODOKI_DEVICE_HOST_PORT = String(device.port);
    const mgr = new DeviceConnectionManager('g-527-repro', stateDir);
    try {
      const connectA = mgr.connect({ useAdb: true });
      // A has published its client and is suspended inside the gated handshake.
      await device.secondConnectSeen;
      // B races in with a DIFFERENT request key (an `ip`, harmlessly ignored when `useAdb:true`) so
      // the Change-2 join does not collapse it into A's promise — this test wants two genuinely
      // separate `connectInner` calls racing, not one deduplicated into the other.
      const connectB = mgr.connect({ useAdb: true, ip: 'unused-so-B-has-a-different-key' });
      // Give B's head `await this.disconnect()` a turn to run against A's published client.
      await new Promise((r) => setTimeout(r, 30));
      // Let A's handshake complete. This is the moment A's socket goes live, after B's teardown.
      device.releaseGate();
      await connectA;
      await connectB;
      await new Promise((r) => setTimeout(r, 50));
      const beforeTeardown = device.openSocketCount();
      // Tear the manager down the only way anything can: the public disconnect().
      await mgr.disconnect();
      expect(mgr.status().state).toBe('disconnected');
      // Give any in-flight socket close a turn to land before counting.
      await new Promise((r) => setTimeout(r, 50));
      // POSITIVE CONTROL: the counter must have been reading a real live socket a moment ago,
      // otherwise the assertion below is vacuous and would pass against any code at all.
      expect(beforeTeardown).toBeGreaterThan(0);
      // THE ASSERTION. A fully-disconnected manager must leave no lease socket open.
      expect(device.openSocketCount()).toBe(0);
    } finally {
      await mgr.disconnect();
      await device.close();
    }
  });

  it('a teardown suspended in client.disconnect() cannot wipe a newer connect\'s published client (#527)', async () => {
    // REGRESSION GUARD for the real #527 hazard. `disconnect()` bumps the generation and awaits
    // `this.client.disconnect()`, but used to null `this.client`/`transport`/`target` only AFTER
    // that await returned — so a teardown suspended there resumed and wiped whatever those fields
    // held at that LATER moment, which can be a DIFFERENT, newer connect's published client. Fixed
    // by writing every field BEFORE the await (see `disconnect()`'s own doc).
    //
    //   1. A live client0 is installed.
    //   2. connect A -> disconnect() -> suspends inside client0.disconnect().
    //   3. connect B -> disconnect() -> suspends there too (this.client is still client0).
    //   4. A resumes: nulls the fields, publishes A's transport/client/target, suspends on connect.
    //   5. B resumes and finishes ITS disconnect body -- nulling A's just-published fields --
    //      then publishes and connects its own.
    //   6. A's handshake lands. A's socket is live; `this.client` is B's. Nothing can reach A's,
    //      UNLESS `disconnect()` captured its target into a local before the await — which it now
    //      does, so B's teardown cannot touch A's fields at all.
    //
    // Note this is a different mechanism from the one the previous test drives: the hazard is not
    // the un-gated publish inside `connectInner`, it is `disconnect()`'s post-await field nulling.
    const authority = new DeviceLeaseAuthority();
    const device = await startGatedMockDevice(authority, 99); // gate nothing; all handshakes land
    process.env.MODOKI_DEVICE_HOST_PORT = String(device.port);
    const mgr = new DeviceConnectionManager('g-527-repro2', stateDir);
    try {
      // 1. A real, live lease to be torn down.
      const first = await mgr.connect({ useAdb: true });
      expect(first.state).toBe('connected');

      // Gate the FIRST client.disconnect() call so both racing teardowns suspend inside it.
      let releaseTeardown: (() => void) | undefined;
      const teardownGate = new Promise<void>((r) => { releaseTeardown = r; });
      const realDisconnect = DeviceLeaseClient.prototype.disconnect;
      let seen = 0;
      const spy = vi.spyOn(DeviceLeaseClient.prototype, 'disconnect').mockImplementation(async function (this: DeviceLeaseClient) {
        seen += 1;
        if (seen <= 2) { await teardownGate; }
        return realDisconnect.call(this);
      });

      // Different request keys (Change 2 would otherwise join two IDENTICAL requests into one
      // `connectInner` call, defeating the two-genuinely-separate-connects setup this test needs).
      const connectA = mgr.connect({ useAdb: true });
      await new Promise((r) => setTimeout(r, 20));
      const connectB = mgr.connect({ useAdb: true, ip: 'unused-so-B-has-a-different-key' });
      await new Promise((r) => setTimeout(r, 20));
      releaseTeardown!();
      await connectA;
      await connectB;
      spy.mockRestore();

      await mgr.disconnect();
      expect(mgr.status().state).toBe('disconnected');
      await new Promise((r) => setTimeout(r, 80));
      expect(device.openSocketCount()).toBe(0);
    } finally {
      vi.restoreAllMocks();
      await mgr.disconnect();
      await device.close();
    }
  });
});

describe('DeviceConnectionManager — connect() joins an in-flight IDENTICAL request (#527 change 2)', () => {
  it('two concurrent identical connect() calls make only one connection attempt', async () => {
    const authority = new DeviceLeaseAuthority();
    const device = await startGatedMockDevice(authority, 99); // nothing gated; every handshake lands
    process.env.MODOKI_DEVICE_HOST_PORT = String(device.port);
    const mgr = new DeviceConnectionManager('g-527-join', stateDir);
    try {
      const before = device.connectionCount();
      // `port` is explicit so the #283 rediscovery block (this file's mocks make it fire on every
      // connect that OMITS a port — see `startGatedMockDevice`'s doc) does not add a second, unjoined
      // socket of its own and confound the count this test is measuring.
      const [a, b] = await Promise.all([
        mgr.connect({ useAdb: true, port: DEVICE_PORT }),
        mgr.connect({ useAdb: true, port: DEVICE_PORT }),
      ]);
      // The second call joined the first's own in-flight promise, rather than starting its own
      // teardown + connect: only one new socket, and both callers got the SAME resolved object.
      expect(device.connectionCount() - before).toBe(1);
      expect(a).toBe(b);
      expect(a.state).toBe('connected');
    } finally {
      await mgr.disconnect();
      await device.close();
    }
  });

  it('a concurrent request naming a DIFFERENT target does not join — it runs its own attempt', async () => {
    const authority = new DeviceLeaseAuthority();
    const device = await startGatedMockDevice(authority, 99);
    process.env.MODOKI_DEVICE_HOST_PORT = String(device.port);
    const mgr = new DeviceConnectionManager('g-527-nojoin', stateDir);
    try {
      const before = device.connectionCount();
      const [a, b] = await Promise.all([
        mgr.connect({ useAdb: true, port: DEVICE_PORT }),
        mgr.connect({ useAdb: true, port: DEVICE_PORT + 1 }), // differs only in `port` → a different key
      ]);
      // A differing key must fall straight through to `connectInner` — a re-target is deliberate,
      // and answering it with the other request's status would be wrong.
      expect(device.connectionCount() - before).toBe(2);
      expect(a).not.toBe(b);
    } finally {
      await mgr.disconnect();
      await device.close();
    }
  });

  it('an omitted serial does not join a concurrent request with an explicit empty serial (#506 review finding 5)', async () => {
    // `serial: undefined` means "reuse the remembered serial" (`connectInner`'s `wantSerial` reads
    // `req.serial === undefined ? this.lastTarget?.serial : undefined`); `serial: ''` means "no
    // preference, resolve fresh". Collapsing both to the empty string in `connectRequestKey` used to
    // join these into ONE connectInner call, so one caller's answer silently applied to a target it
    // never asked for. They must be two separate attempts.
    const authority = new DeviceLeaseAuthority();
    const device = await startGatedMockDevice(authority, 99);
    process.env.MODOKI_DEVICE_HOST_PORT = String(device.port);
    const mgr = new DeviceConnectionManager('g-f5-serial', stateDir);
    try {
      const before = device.connectionCount();
      const [a, b] = await Promise.all([
        mgr.connect({ useAdb: true, port: DEVICE_PORT }), // serial omitted
        mgr.connect({ useAdb: true, port: DEVICE_PORT, serial: '' }), // serial explicitly empty
      ]);
      expect(device.connectionCount() - before).toBe(2);
      expect(a).not.toBe(b);
    } finally {
      await mgr.disconnect();
      await device.close();
    }
  });
});

describe('DeviceConnectionManager — disconnect() holds the machine-wide claim across the hangup (#506 review finding 1)', () => {
  it('keeps the claim held while client.disconnect() is still in flight, and releases it only once disconnect() resolves', async () => {
    const authority = new DeviceLeaseAuthority();
    const device = await startGatedMockDevice(authority, 99); // nothing gated; the connect lands normally
    process.env.MODOKI_DEVICE_HOST_PORT = String(device.port);
    const mgr = new DeviceConnectionManager('g-f1-claim', stateDir);
    let releaseHangup: (() => void) | undefined;
    const hangupGate = new Promise<void>((r) => { releaseHangup = r; });
    const realDisconnect = DeviceLeaseClient.prototype.disconnect;
    // Slow the hangup itself — the same gating idiom the reentrancy tests above use on
    // `client.connect()` — so `disconnect()`'s `await client.disconnect()` stays suspended for as
    // long as the test wants, with the claim's fate observable on either side of it.
    const spy = vi.spyOn(DeviceLeaseClient.prototype, 'disconnect').mockImplementation(async function (this: DeviceLeaseClient) {
      await hangupGate;
      return realDisconnect.call(this);
    });
    try {
      // `port` explicit so the #283 rediscovery block does not fire and confound this measurement.
      const connected = await mgr.connect({ useAdb: true, port: DEVICE_PORT });
      expect(connected.state).toBe('connected');
      expect(listClaims().length).toBeGreaterThan(0); // sanity: the connect actually claimed hardware

      const disconnectDone = mgr.disconnect();
      // Give disconnect()'s synchronous head a turn to run and reach the gated client.disconnect().
      await new Promise((r) => setTimeout(r, 20));

      // THE ASSERTION. Mid-teardown — `client.disconnect()` still suspended on the gate — the claim
      // must STILL be held: releasing it earlier would empty the claims file while
      // `DeviceLeaseAuthority` still records our guid as the live owner, so a sibling clone polling
      // `device_list` would pass the claim gate and reach the authority's `busy`, an error the
      // client documents as non-retryable.
      expect(listClaims().length).toBeGreaterThan(0);

      releaseHangup!();
      await disconnectDone;

      // Only once `disconnect()` has fully resolved is the claim actually handed back.
      expect(listClaims()).toEqual([]);
    } finally {
      spy.mockRestore();
      await mgr.disconnect();
      await device.close();
    }
  });
});

describe('DeviceConnectionManager — a stale disconnect() continuation cannot release a newer re-claim (#506 review finding 3)', () => {
  it('a disconnect() suspended in client.disconnect() does not release a claim a later connect() on this same manager already re-took', async () => {
    // The real seam for this defect is NOT `disconnect()` in isolation — it is the ROUTE two
    // `connect()`/`disconnect()` calls actually race through on one manager: session A's
    // `disconnect()` nulls `this.claimedDeviceId` synchronously, then suspends on
    // `await client.disconnect()`; while it is suspended, session B's `connect()` (the SAME
    // manager instance — `connectInner`'s own head calls `disconnect()`, sees the fields already
    // null, and falls straight through to re-claiming) completes fully and re-populates
    // `this.claimedDeviceId` with the SAME device id. When A's continuation finally resumes, its
    // captured `claimId` local still names that device — a bare `if (claimId)` would call
    // `releaseDevice(claimId)` and, because `releaseDevice` releases by `(deviceId, pid)` and both
    // sessions share this process's pid, would strip B's live claim out from under it.
    const authority = new DeviceLeaseAuthority();
    const device = await startGatedMockDevice(authority, 99); // nothing gated at the TCP level —
    // the reentrancy is driven by gating `client.disconnect()` below instead.
    process.env.MODOKI_DEVICE_HOST_PORT = String(device.port);
    const mgr = new DeviceConnectionManager('g-f3-stale-release', stateDir);
    let releaseHangup: (() => void) | undefined;
    const hangupGate = new Promise<void>((r) => { releaseHangup = r; });
    const realDisconnect = DeviceLeaseClient.prototype.disconnect;
    let disconnectCalls = 0;
    // Only the FIRST `client.disconnect()` call — session A's hangup — is gated. Session B's own
    // `connect()` never reaches this at all (by the time it runs its internal `disconnect()`,
    // `this.client` is already null from A's synchronous nulling), so nothing else needs to pass
    // through un-gated, but guard the count anyway so a future change that adds a second live call
    // here fails loudly instead of deadlocking the test.
    const spy = vi.spyOn(DeviceLeaseClient.prototype, 'disconnect').mockImplementation(async function (this: DeviceLeaseClient) {
      disconnectCalls += 1;
      if (disconnectCalls === 1) await hangupGate;
      return realDisconnect.call(this);
    });
    try {
      // Session A: a real, live lease over the fixture's one adb device (serial TESTSERIAL1).
      const sessionA = await mgr.connect({ useAdb: true, port: DEVICE_PORT });
      expect(sessionA.state).toBe('connected');
      const deviceId = adbDeviceId('TESTSERIAL1');
      expect(listClaims().map((c) => c.deviceId)).toContain(deviceId);

      // Session A's disconnect — suspends inside the gated `client.disconnect()`, after its
      // synchronous field-nulling has already run.
      const disconnectA = mgr.disconnect();
      await new Promise((r) => setTimeout(r, 20)); // give the synchronous head + gate a turn to land

      // Session B: a fresh connect() on the SAME manager instance, same target — re-claims the
      // SAME device id and completes fully while A's disconnect is still suspended.
      const sessionB = await mgr.connect({ useAdb: true, port: DEVICE_PORT });
      expect(sessionB.state).toBe('connected');
      expect(listClaims().map((c) => c.deviceId)).toContain(deviceId);

      // Release A's gate — its continuation now resumes and reaches the `releaseDevice` call.
      releaseHangup!();
      await disconnectA;

      // THE ASSERTION. B's claim must have survived A's stale continuation.
      expect(listClaims(), 'a newer session\'s claim on this same device must survive a stale '
        + 'disconnect() continuation from an OLDER session').not.toEqual([]);
      expect(listClaims().map((c) => c.deviceId)).toContain(deviceId);
      // And the manager itself must still consider itself connected as B — A's disconnect() must
      // not have torn down B's session as a side effect of releasing (or failing to release) A's
      // claim.
      expect(mgr.status().state).toBe('connected');
    } finally {
      spy.mockRestore();
      await mgr.disconnect();
      await device.close();
    }
  });
});

describe('DeviceConnectionManager — connectRequestKey does not throw on an explicit null serial (#506 review finding 6)', () => {
  it('connect() with an explicit null serial does not throw or reject', async () => {
    const authority = new DeviceLeaseAuthority();
    const device = await startGatedMockDevice(authority, 99);
    process.env.MODOKI_DEVICE_HOST_PORT = String(device.port);
    const mgr = new DeviceConnectionManager('g-f6-null-serial', stateDir);
    try {
      // `serial: null` is reachable at runtime via `POST /api/device/connect` even though
      // `ConnectRequest.serial` is typed `string | undefined` — the router passes the parsed JSON
      // body straight through, and JSON has no `undefined`. Before the fix,
      // `req.serial === undefined ? null : req.serial.trim()` called `.trim()` on that `null` and
      // threw a `TypeError` instead of resolving/rejecting cleanly.
      await expect(mgr.connect({ useAdb: true, port: DEVICE_PORT, serial: null as unknown as string }))
        .resolves.toMatchObject({ state: 'connected' });
    } finally {
      await mgr.disconnect();
      await device.close();
    }
  });

  it('an explicit null serial joins an explicit empty-string serial, but not an omitted one', async () => {
    // `connectRequestKey` is not exported, so this pins its behaviour through the public join
    // seam (#527 change 2): two concurrent requests that key the SAME collapse into one
    // `connectInner` call and resolve to the identical status object; two that key DIFFERENTLY
    // each run their own attempt.
    const authority = new DeviceLeaseAuthority();
    const device = await startGatedMockDevice(authority, 99);
    process.env.MODOKI_DEVICE_HOST_PORT = String(device.port);

    // null vs '' — both mean "no preference" and must join into a single connectInner call.
    {
      const mgr = new DeviceConnectionManager('g-f6-null-joins-empty', stateDir);
      try {
        const before = device.connectionCount();
        const [a, b] = await Promise.all([
          mgr.connect({ useAdb: true, port: DEVICE_PORT, serial: null as unknown as string }),
          mgr.connect({ useAdb: true, port: DEVICE_PORT, serial: '' }),
        ]);
        expect(device.connectionCount() - before).toBe(1);
        expect(a).toBe(b);
      } finally {
        await mgr.disconnect();
      }
    }

    // null vs omitted — omitted means "reuse the remembered serial", a different meaning, so these
    // must NOT join.
    {
      const mgr = new DeviceConnectionManager('g-f6-null-vs-omitted', stateDir);
      try {
        const before = device.connectionCount();
        const [a, b] = await Promise.all([
          mgr.connect({ useAdb: true, port: DEVICE_PORT, serial: null as unknown as string }),
          mgr.connect({ useAdb: true, port: DEVICE_PORT }), // serial omitted
        ]);
        expect(device.connectionCount() - before).toBe(2);
        expect(a).not.toBe(b);
      } finally {
        await mgr.disconnect();
      }
    }

    await device.close();
  });
});
