/** #1077 — WebDriverAgent is lease-owned, so EVERY ending of a lease stops it, not only the Disconnect route.
 *
 *  The stop used to live in `/api/device/disconnect`. `DeviceConnectionManager.connect()` begins with its
 *  own `disconnect()`, which never reached it, so connecting to iPhone B without disconnecting from A left
 *  A's agent running with `ios:<A>` claimed — and left `wdaLauncher`'s module state (`child`, `lastFailure`)
 *  behind, so the first tap on B read "has been starting for Ns" and a latched failure from A was reported
 *  for B. These drive the real manager over a real socket and the real launcher with an injected spawn, so
 *  nothing here needs Xcode or a phone.
 *
 *  `MODOKI_HOME` is a temp dir per test: the launcher takes a machine-wide claim, and one written into the
 *  developer's real `~/.modoki` would refuse their own phone. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import net from 'net';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { DeviceConnectionManager, releaseDeviceResourcesOnExit, wdaHostFor } from '../../plugins/backend/deviceConnection';
import { DeviceLeaseAuthority } from '../../plugins/backend/deviceLease';
import { ensureWdaRunning, isWdaProcessRunning, stopWda, _resetWdaLauncherForTests } from '../../plugins/backend/wdaLauncher';
import { listClaims } from '../../plugins/backend/deviceClaims';

/** A lease-speaking device. `disconnectDelayMs` holds back the reply to a lease `disconnect`, so the
 *  manager's hangup stays suspended on its await. */
function startMockDevice(opts: { disconnectDelayMs?: number } = {}): Promise<{ port: number; close: () => Promise<void> }> {
  const authority = new DeviceLeaseAuthority();
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
          const guid = msg.params?.guid ?? '';
          if (msg.method === 'disconnect' && opts.disconnectDelayMs) {
            const id = msg.id;
            setTimeout(() => {
              if (!socket.destroyed) socket.write(JSON.stringify({ id, result: authority.disconnect(guid, Date.now()) }) + '\n');
            }, opts.disconnectDelayMs);
            continue;
          }
          const now = Date.now();
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

/** A devicectl listing with the given phones (none ⇒ "no iOS device is paired"). */
const listing = (...udids: string[]) => JSON.stringify({
  result: { devices: udids.map((udid) => ({ identifier: `GUID-${udid}`, hardwareProperties: { udid, platform: 'iOS' }, deviceProperties: { name: udid } })) },
});

type FakeAgent = { exitCode: number | null; killed: boolean; kill(): void; on(): void };
function fakeAgent(): FakeAgent {
  const p: FakeAgent = { exitCode: null, killed: false, kill() { p.killed = true; }, on() { /* exit is never emitted */ } };
  return p;
}

const launchOpts = (listDevices: () => string, spawnImpl: () => FakeAgent, probe: () => Promise<boolean>) => ({
  host: '10.0.0.5', port: 8100, sleep: async () => {}, xctestrun: '/fake/WDA.xctestrun',
  listDevices, spawnImpl: spawnImpl as never, probe, platform: 'darwin' as NodeJS.Platform,
});

/** What a first iOS tap does: launch the agent on `udid` and leave it running. */
async function launchAgent(udid: string): Promise<FakeAgent> {
  const agent = fakeAgent();
  let up = false;
  const r = await ensureWdaRunning(launchOpts(() => listing(udid), () => agent, async () => { const v = up; up = true; return v; }));
  expect(r).toEqual({ running: true });
  return agent;
}

const claimed = () => listClaims().map((c: { deviceId: string }) => c.deviceId);

let stateDir: string;
let home: string;
let prevHome: string | undefined;
let prevPin: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-wda-home-'));
  prevHome = process.env.MODOKI_HOME;
  process.env.MODOKI_HOME = home;
  // A pinned UDID in the developer's shell would make every listing below "match none".
  prevPin = process.env.MODOKI_IOS_DEVICE_UDID;
  delete process.env.MODOKI_IOS_DEVICE_UDID;
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-wda-conn-'));
  _resetWdaLauncherForTests();
});

afterEach(() => {
  stopWda();
  _resetWdaLauncherForTests();
  if (prevHome === undefined) delete process.env.MODOKI_HOME; else process.env.MODOKI_HOME = prevHome;
  if (prevPin !== undefined) process.env.MODOKI_IOS_DEVICE_UDID = prevPin;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe('WebDriverAgent is torn down with the lease, however it ends (#1077)', () => {
  it('a connect that SUPERSEDES the lease stops the agent, gives its phone back, and lets the new device launch', async () => {
    const a = await startMockDevice();
    const b = await startMockDevice();
    const mgr = new DeviceConnectionManager('g-wda-super', stateDir);
    try {
      expect((await mgr.connect({ ip: '127.0.0.1', port: a.port })).state).toBe('connected');
      const agentA = await launchAgent('UDID-A');
      expect(claimed()).toContain('ios:UDID-A');

      // No Disconnect — straight to another device, the path the route never covered.
      expect((await mgr.connect({ ip: '127.0.0.1', port: b.port })).state).toBe('connected');
      expect(agentA.killed).toBe(true);
      expect(isWdaProcessRunning()).toBe(false);
      expect(claimed()).not.toContain('ios:UDID-A');

      // The visible symptom: with A's child still recorded, this returned "has been starting for Ns"
      // instead of launching on B.
      const agentB = await launchAgent('UDID-B');
      expect(agentB.killed).toBe(false);
      expect(claimed()).toContain('ios:UDID-B');
    } finally {
      await mgr.disconnect();
      await a.close();
      await b.close();
    }
  });

  it('a launch failure latched on the old lease is not reported for the new one', async () => {
    const a = await startMockDevice();
    const b = await startMockDevice();
    const mgr = new DeviceConnectionManager('g-wda-latch', stateDir);
    try {
      await mgr.connect({ ip: '127.0.0.1', port: a.port });
      const failed = await ensureWdaRunning(launchOpts(() => listing(), vi.fn(fakeAgent), async () => false));
      expect(failed.running).toBe(false);
      expect(failed.reason).toMatch(/no iOS device is paired/);
      // Latched for this lease, by design — the next tap does not even list devices again.
      const relist = vi.fn(() => listing('UDID-A'));
      expect((await ensureWdaRunning(launchOpts(relist, vi.fn(fakeAgent), async () => false))).reason).toBe(failed.reason);
      expect(relist).not.toHaveBeenCalled();

      await mgr.connect({ ip: '127.0.0.1', port: b.port });
      await launchAgent('UDID-B');   // throws on `{running:false}` if A's latched failure carried over
    } finally {
      await mgr.disconnect();
      await a.close();
      await b.close();
    }
  });

  it('an explicit disconnect() stops it — the manager, not the route, owns the stop now', async () => {
    const a = await startMockDevice();
    const mgr = new DeviceConnectionManager('g-wda-disc', stateDir);
    try {
      await mgr.connect({ ip: '127.0.0.1', port: a.port });
      const agent = await launchAgent('UDID-A');
      await mgr.disconnect();
      expect(agent.killed).toBe(true);
      expect(isWdaProcessRunning()).toBe(false);
      expect(claimed()).not.toContain('ios:UDID-A');
    } finally {
      await a.close();
    }
  });

  it('quitting stops it — releaseDeviceResourcesOnExit, with no disconnect()', async () => {
    const mgr = new DeviceConnectionManager('g-wda-exit', stateDir);
    const agent = await launchAgent('UDID-A');
    releaseDeviceResourcesOnExit(mgr);
    // The claim alone would be freed by `releaseAllForThisProcess`; the PROCESS is what this adds.
    expect(agent.killed).toBe(true);
    expect(isWdaProcessRunning()).toBe(false);
  });

  it('a stale disconnect resuming after its hangup does not stop an agent a NEWER session launched (#527)', async () => {
    const a = await startMockDevice({ disconnectDelayMs: 300 });
    const mgr = new DeviceConnectionManager('g-wda-stale', stateDir);
    try {
      await mgr.connect({ ip: '127.0.0.1', port: a.port });
      const first = await launchAgent('UDID-A');
      const teardown = mgr.disconnect();   // suspended on the delayed lease `disconnect` reply
      expect(first.killed).toBe(true);     // stopped in the synchronous part, before the await
      const second = await launchAgent('UDID-A');   // the next session's first tap, mid-hangup
      await teardown;
      expect(second.killed).toBe(false);
      expect(isWdaProcessRunning()).toBe(true);
      expect(claimed()).toContain('ios:UDID-A');
    } finally {
      await a.close();
    }
  });
});

/** Found by #1077's close-out review (and reproduced there): `stopWda` is a one-time reset, and a launch that
 *  was already past an `await` wrote over it afterwards — onto the next lease. */
describe('a launch still in flight when the lease ends abandons itself (#1077)', () => {
  /** A probe whose FIRST answer the test gives by hand; every later probe says "not up". */
  function heldProbe() {
    let answer!: (up: boolean) => void;
    let first = true;
    const probe = () => {
      if (!first) return Promise.resolve(false);
      first = false;
      return new Promise<boolean>((r) => { answer = r; });
    };
    return { probe, answer: (up: boolean) => answer(up) };
  }

  it('a tap whose first probe is still out claims and spawns nothing once the lease has moved', async () => {
    const a = await startMockDevice();
    const b = await startMockDevice();
    const mgr = new DeviceConnectionManager('g-wda-inflight', stateDir);
    try {
      await mgr.connect({ ip: '127.0.0.1', port: a.port });
      const held = heldProbe();
      const spawn = vi.fn(fakeAgent);
      const launching = ensureWdaRunning({ ...launchOpts(() => listing('UDID-A'), spawn, held.probe), timeoutMs: 50 });
      await mgr.connect({ ip: '127.0.0.1', port: b.port });   // the lease moves while that probe is out
      held.answer(false);
      expect((await launching).reason).toMatch(/lease ended/);
      expect(spawn).not.toHaveBeenCalled();
      expect(isWdaProcessRunning()).toBe(false);
      expect(claimed()).not.toContain('ios:UDID-A');
    } finally {
      await mgr.disconnect();
      await a.close();
      await b.close();
    }
  });

  it('a failure the old lease\'s launch hits after the lease moved is not latched for the new one', async () => {
    const a = await startMockDevice();
    const b = await startMockDevice();
    const mgr = new DeviceConnectionManager('g-wda-inflight-latch', stateDir);
    try {
      await mgr.connect({ ip: '127.0.0.1', port: a.port });
      const held = heldProbe();
      const launching = ensureWdaRunning({ ...launchOpts(() => listing(), vi.fn(fakeAgent), held.probe), timeoutMs: 50 });
      await mgr.connect({ ip: '127.0.0.1', port: b.port });
      held.answer(false);
      await launching;
      await launchAgent('UDID-B');   // throws on `{running:false}` if "no iOS device is paired" was latched
    } finally {
      await mgr.disconnect();
      await a.close();
      await b.close();
    }
  });

  it('a launch in its poll loop reports the lease ending, not a crash, when a reconnect kills its agent', async () => {
    const a = await startMockDevice();
    const mgr = new DeviceConnectionManager('g-wda-inflight-poll', stateDir);
    try {
      await mgr.connect({ ip: '127.0.0.1', port: a.port });
      let wake!: () => void;
      const agent = fakeAgent();
      const launching = ensureWdaRunning({
        ...launchOpts(() => listing('UDID-A'), () => agent, async () => false),
        sleep: () => new Promise<void>((r) => { wake = r; }),
      });
      await vi.waitFor(() => expect(isWdaProcessRunning()).toBe(true));   // spawned, now sleeping in the loop
      await mgr.connect({ ip: '127.0.0.1', port: a.port });   // the reconnect "starting for Ns" invites
      expect(agent.killed).toBe(true);
      wake();
      expect((await launching).reason).toMatch(/lease ended/);
    } finally {
      await mgr.disconnect();
      await a.close();
    }
  });
});

describe('wdaHost — WebDriverAgent is reachable only through a WiFi lease (#1077)', () => {
  it('is the host for a WiFi lease, and undefined for USB, adb and no lease', () => {
    expect(wdaHostFor({ host: '10.0.0.5', port: 9095, useAdb: false })).toBe('10.0.0.5');
    // A USB lease dials 127.0.0.1 through a go-ios forward of the bridge's port only — no :8100 there.
    expect(wdaHostFor({ host: '127.0.0.1', port: 9098, useAdb: false, useUsb: true, udid: 'UDID-A' })).toBeUndefined();
    expect(wdaHostFor({ host: '127.0.0.1', port: 9097, useAdb: true, serial: 'SERIAL' })).toBeUndefined();
    expect(wdaHostFor(null)).toBeUndefined();
  });

  it('the manager reads it off its live target', async () => {
    const a = await startMockDevice();
    const mgr = new DeviceConnectionManager('g-wda-host', stateDir);
    try {
      expect(mgr.wdaHost()).toBeUndefined();
      await mgr.connect({ ip: '127.0.0.1', port: a.port });
      expect(mgr.wdaHost()).toBe('127.0.0.1');
      await mgr.disconnect();
      expect(mgr.wdaHost()).toBeUndefined();
    } finally {
      await a.close();
    }
  });
});
