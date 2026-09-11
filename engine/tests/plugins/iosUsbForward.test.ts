/** #1065 — the go-ios USB forward's pure decisions and its process lifecycle.
 *
 *  The device list fixtures reproduce the SHAPE `ios list --details` printed on this Mac on 2026-09-11
 *  (a status line first, then one JSON device-list line, a WiFi-synced iPhone listed twice), with
 *  invented UDIDs. The manager wiring is in `deviceConnectUsb.test.ts`. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import {
  clearIosForwardRecord, goIosForwardRunner, parseGoIosListDetails, pickUsbIosDevice, reapDeps,
  lsofRunner, parseLsofListeners, reapRecordedIosForward, recordIosForward, startIosForward, type UsbmuxEntry,
} from '../../plugins/backend/iosUsbForward';

const WARN = '{"time":"t","level":"WARN","msg":"go-ios agent is not running. You might need to start it with \'ios tunnel start\' for ios17+."}';
const dev = (udid: string, connectionType: string, productType = 'iPhone10,1') =>
  ({ Udid: udid, ProductName: 'iPhone OS', ProductType: productType, ProductVersion: '16.7.16', ConnectionType: connectionType });

describe('parseGoIosListDetails', () => {
  it('reads the device-list line past go-ios\'s own status line, in usbmuxd order', () => {
    const out = `${WARN}\n${JSON.stringify({ deviceList: [dev('UDID-IPAD', 'USB', 'iPad11,1'), dev('UDID-PHONE', 'USB'), dev('UDID-PHONE', 'Network')] })}\n`;
    expect(parseGoIosListDetails(out)).toEqual([
      { udid: 'UDID-IPAD', connectionType: 'USB', productType: 'iPad11,1', productVersion: '16.7.16' },
      { udid: 'UDID-PHONE', connectionType: 'USB', productType: 'iPhone10,1', productVersion: '16.7.16' },
      { udid: 'UDID-PHONE', connectionType: 'Network', productType: 'iPhone10,1', productVersion: '16.7.16' },
    ]);
  });

  it('null when there is no device-list line at all; an entry with no Udid is skipped', () => {
    expect(parseGoIosListDetails(`${WARN}\n`)).toBeNull();
    expect(parseGoIosListDetails(JSON.stringify({ deviceList: [{ ConnectionType: 'USB' }, dev('U1', 'USB')] }))?.map((e) => e.udid)).toEqual(['U1']);
  });
});

describe('pickUsbIosDevice', () => {
  const e = (udid: string, connectionType: string): UsbmuxEntry => ({ udid, connectionType, productType: 'iPhone10,1' });

  it('the one device on USB', () => {
    expect(pickUsbIosDevice({ entries: [e('U1', 'USB')], strict: false })).toMatchObject({ udid: 'U1' });
  });

  it('ACCEPTS a WiFi-synced twin whose USB entry comes first — what go-ios will forward through (observed)', () => {
    expect(pickUsbIosDevice({ entries: [e('U1', 'USB'), e('U1', 'Network')], strict: false })).toMatchObject({ udid: 'U1' });
  });

  it('REFUSES a twin whose NETWORK entry comes first — the lease would say USB and run over WiFi', () => {
    const r = pickUsbIosDevice({ entries: [e('U1', 'Network'), e('U1', 'USB')], strict: false });
    expect(r).toHaveProperty('error');
    expect((r as { error: string }).error).toMatch(/NETWORK before USB/);
    // Named whether or not the caller asked for it by UDID.
    expect(pickUsbIosDevice({ entries: [e('U1', 'Network'), e('U1', 'USB')], want: 'U1', strict: true })).toHaveProperty('error');
  });

  it('refuses a device reachable only over the network', () => {
    const r = pickUsbIosDevice({ entries: [e('U1', 'Network')], want: 'U1', strict: true });
    expect((r as { error: string }).error).toMatch(/only over the NETWORK/);
  });

  it('a NAMED udid usbmuxd does not see is an error that says replug — never another device', () => {
    const r = pickUsbIosDevice({ entries: [e('U2', 'USB')], want: 'U1', strict: true });
    expect((r as { error: string }).error).toMatch(/usbmuxd does not see U1 \(go-ios sees: U2\).*replug/);
  });

  it('a REMEMBERED udid that is gone falls back to the normal rule; one still attached but unusable does not', () => {
    expect(pickUsbIosDevice({ entries: [e('U2', 'USB')], want: 'U1', strict: false })).toMatchObject({ udid: 'U2' });
    expect(pickUsbIosDevice({ entries: [e('U1', 'Network'), e('U1', 'USB'), e('U2', 'USB')], want: 'U1', strict: false })).toHaveProperty('error');
  });

  it('several on USB and none named: refused, naming each', () => {
    const r = pickUsbIosDevice({ entries: [e('U1', 'USB'), e('U2', 'USB')], strict: false });
    expect((r as { error: string }).error).toMatch(/2 iOS devices are attached over USB — pass udid.*U1.*U2/);
    expect(pickUsbIosDevice({ entries: [e('U1', 'USB'), e('U2', 'USB')], want: 'U2', strict: true })).toMatchObject({ udid: 'U2' });
  });

  it('nothing on USB at all', () => {
    expect((pickUsbIosDevice({ entries: [], strict: false }) as { error: string }).error).toMatch(/sees no iOS device over USB/);
  });
});

type FakeChild = EventEmitter & {
  stdout: EventEmitter; stderr: EventEmitter; pid: number;
  exitCode: number | null; signalCode: string | null; killed: boolean; kill: ReturnType<typeof vi.fn>;
};

function fakeChild(): FakeChild {
  const c = new EventEmitter() as FakeChild;
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.pid = 4242;
  c.exitCode = null;
  c.signalCode = null;
  c.killed = false;
  c.kill = vi.fn(() => { c.killed = true; c.signalCode = 'SIGTERM'; c.emit('exit', null, 'SIGTERM'); return true; });
  return c;
}

describe('startIosForward', () => {
  const realSpawn = goIosForwardRunner.spawnForward;
  const realListenersOn = goIosForwardRunner.listenersOn;
  let child: FakeChild;
  /** What the socket table says is listening on the host port. Starts empty; `bind()` = the child bound. */
  let listeners: Array<{ pid: number; command: string }>;
  const bind = () => { listeners = [{ pid: 4242, command: 'ios' }]; };
  beforeEach(() => {
    child = fakeChild();
    listeners = [];
    goIosForwardRunner.spawnForward = vi.fn(() => child as unknown as ChildProcess);
    goIosForwardRunner.listenersOn = vi.fn(async () => ({ ok: true as const, listeners }));
  });
  afterEach(() => { goIosForwardRunner.spawnForward = realSpawn; goIosForwardRunner.listenersOn = realListenersOn; });

  const start = (extra: { readyTimeoutMs?: number; onExit?: (c: number | null, s: NodeJS.Signals | null) => void; onSpawn?: (pid: number) => void } = {}) =>
    startIosForward({ goIos: '/bin/ios', hostPort: 9097, devicePort: 9095, udid: 'U1', ...extra });
  /** The port check is async, so the child exists only once it has run. */
  const spawned = () => vi.waitFor(() => expect(goIosForwardRunner.spawnForward).toHaveBeenCalled());
  const clearSpawn = () => (goIosForwardRunner.spawnForward as ReturnType<typeof vi.fn>).mockClear();

  it('checks the port, spawns `ios forward <host> <device> --udid`, and is ready once the child is its only listener', async () => {
    const onSpawn = vi.fn();
    const f = start({ onSpawn });
    expect(f.pid).toBeUndefined();
    await spawned();
    expect(goIosForwardRunner.spawnForward).toHaveBeenCalledWith('/bin/ios', 9097, 9095, 'U1');
    expect(onSpawn).toHaveBeenCalledWith(4242);
    bind();
    child.stderr.emit('data', Buffer.from('{"level":"INFO","msg":"start listening, forwarding to device","hostPort":9097}\n'));
    await expect(f.ready).resolves.toEqual({ ok: true });
    expect(goIosForwardRunner.listenersOn).toHaveBeenCalledWith(9097);
    expect(f.pid).toBe(4242);
  });

  it('an exit before listening is a failure that carries go-ios\'s last line', async () => {
    const f = start();
    await spawned();
    child.stdout.emit('data', 'listen tcp 0.0.0.0:9097: bind: address already in use\n');
    child.exitCode = 1;
    child.emit('exit', 1, null);
    await expect(f.ready).resolves.toEqual({ ok: false, error: expect.stringMatching(/exited \(1\) before it was listening — last output: .*address already in use/) });
    await f.exited;
  });

  it('a spawn error, and silence past the timeout, are failures too', async () => {
    const f = start();
    await spawned();
    child.emit('error', new Error('ENOENT'));
    await expect(f.ready).resolves.toEqual({ ok: false, error: 'could not start go-ios forward: ENOENT' });
    await f.exited;
    child = fakeChild();
    const g = start({ readyTimeoutMs: 10 });
    await expect(g.ready).resolves.toEqual({ ok: false, error: expect.stringMatching(/was not listening on 9097 within 10ms/) });
  });

  it('the log line alone is NOT a bind — go-ios v1.3.2 logs it before net.Listen, then exits 1 on a busy port', async () => {
    const f = start();   // nothing ever listens
    await spawned();
    child.stderr.emit('data', '{"level":"INFO","msg":"start listening, forwarding to device","hostPort":9097}\n');
    child.stderr.emit('data', '{"level":"ERROR","msg":"failed to forward port","err":"forward: failed listener with err: listen tcp 0.0.0.0:9097: bind: address already in use"}\n');
    child.exitCode = 1;
    child.emit('exit', 1, null);
    await expect(f.ready).resolves.toEqual({ ok: false, error: expect.stringMatching(/exited \(1\) before it was listening — last output: .*address already in use/) });
  });

  it('ready only once THIS child holds the socket — the check keeps polling after the log line', async () => {
    const empty = { ok: true as const, listeners: [] };
    goIosForwardRunner.listenersOn = vi.fn()
      .mockResolvedValueOnce(empty)                                   // before spawning
      .mockResolvedValueOnce(empty).mockResolvedValueOnce(empty)      // logged, not bound yet
      .mockResolvedValue({ ok: true, listeners: [{ pid: 4242, command: 'ios' }] });
    const f = start();
    await spawned();
    child.stderr.emit('data', 'start listening, forwarding to device\n');
    await expect(f.ready).resolves.toEqual({ ok: true });
    expect(goIosForwardRunner.listenersOn).toHaveBeenCalledTimes(4);
  });

  it('a port ANOTHER process listens on is refused before spawning, naming it (measured: go-ios coexists with an IPv4 holder)', async () => {
    listeners = [{ pid: 84945, command: 'Python' }];
    const f = start();
    await expect(f.ready).resolves.toEqual({ ok: false, error: expect.stringMatching(/port 9097 is also listened on by Python \(pid 84945\) — the lease dials 127\.0\.0\.1/) });
    expect(goIosForwardRunner.spawnForward).not.toHaveBeenCalled();
    expect(f.pid).toBeUndefined();
    await f.exited;
    f.stop();   // nothing to stop, and must not throw
  });

  it('a socket table that cannot be read is a refusal, never "nobody listens"', async () => {
    goIosForwardRunner.listenersOn = vi.fn(async () => ({ ok: false as const, error: 'could not read the socket table to check host port 9097 (lsof: spawn lsof ENOENT)' }));
    const f = start();
    await expect(f.ready).resolves.toEqual({ ok: false, error: expect.stringMatching(/could not read the socket table/) });
    expect(goIosForwardRunner.spawnForward).not.toHaveBeenCalled();
  });

  it('a holder beside the bound child fails the tunnel — and the stop that follows is not reported as a lost tunnel', async () => {
    const onExit = vi.fn();
    const f = start({ onExit });
    await spawned();
    listeners = [{ pid: 84945, command: 'Python' }, { pid: 4242, command: 'ios' }];
    child.stderr.emit('data', 'start listening\n');
    const r = await f.ready;
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/also listened on by Python \(pid 84945\)/) });
    expect((r as { error: string }).error).not.toMatch(/pid 4242/);
    f.stop();   // what the manager does next — its exit must not reach onExit
    expect(child.kill).toHaveBeenCalledOnce();
    expect(onExit).not.toHaveBeenCalled();
  });

  it('onExit fires for an exit AFTER ready, and not for one before', async () => {
    const onExit = vi.fn();
    const f = start({ onExit });
    await spawned();
    bind();
    child.stderr.emit('data', 'start listening\n');
    await f.ready;
    child.exitCode = 1;
    child.emit('exit', 1, null);
    expect(onExit).toHaveBeenCalledWith(1, null);
    await f.exited;
    child = fakeChild();
    listeners = [];
    clearSpawn();
    const onEarly = vi.fn();
    const g = start({ onExit: onEarly });
    await spawned();
    child.emit('exit', 1, null);
    await g.ready;
    expect(onEarly).not.toHaveBeenCalled();
  });

  it('stop kills a live child once, never one that already exited, and before the spawn prevents it', async () => {
    const f = start();
    await spawned();
    f.stop();
    f.stop();
    expect(child.kill).toHaveBeenCalledOnce();
    await f.exited;
    child = fakeChild();
    clearSpawn();
    const g = start();
    await spawned();
    child.exitCode = 0;
    g.stop();
    expect(child.kill).not.toHaveBeenCalled();
    clearSpawn();
    const h = start();
    h.stop();   // while the port check is still pending
    await expect(h.ready).resolves.toEqual({ ok: false, error: 'the go-ios forward was stopped before it started' });
    expect(goIosForwardRunner.spawnForward).not.toHaveBeenCalled();
  });
});

// The REAL `lsof`, not the seam — its exit status 1 for "nothing matches" is what decides whether every
// real connect works, and only a real run can pin it. macOS only: go-ios forwarding is darwin-only, and
// the Linux/Windows CI legs may have no lsof at all.
describe.skipIf(process.platform !== 'darwin')('goIosForwardRunner.listenersOn against the real lsof', () => {
  it('a port nobody listens on answers ok with no listeners; a port this process listens on names this pid', async () => {
    const net = await import('node:net');
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as import('node:net').AddressInfo).port;
    try {
      const held = await goIosForwardRunner.listenersOn(port);
      expect(held.ok).toBe(true);
      expect((held as { listeners: Array<{ pid: number }> }).listeners.map((l) => l.pid)).toContain(process.pid);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
    await expect(goIosForwardRunner.listenersOn(port)).resolves.toEqual({ ok: true, listeners: [] });
  });
});

describe('listenersOn does not wait on an lsof that never finishes', () => {
  const realExec = lsofRunner.exec;
  afterEach(() => { lsofRunner.exec = realExec; vi.useRealTimers(); });

  it('a stuck lsof becomes a refusal after the hard bound — execFile\'s own timeout only signals it', async () => {
    vi.useFakeTimers();
    lsofRunner.exec = vi.fn(() => new Promise<never>(() => { /* never settles */ }));
    const pending = goIosForwardRunner.listenersOn(9097);
    await vi.advanceTimersByTimeAsync(4_100);
    await expect(pending).resolves.toEqual({ ok: false, error: expect.stringMatching(/did not finish within 4000ms — refusing/) });
  });
});

describe('parseLsofListeners', () => {
  it('reads one entry per process from `lsof -F pc` (format captured 2026-09-11)', () => {
    expect(parseLsofListeners('p88939\ncPython\nf3\np88940\ncPython\nf3\n')).toEqual([
      { pid: 88939, command: 'Python' },
      { pid: 88940, command: 'Python' },
    ]);
    expect(parseLsofListeners('')).toEqual([]);
  });
});

describe('the startup reap of a recorded forward', () => {
  const realDeps = { ...reapDeps };
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-iosfwd-'));
    reapDeps.kill = vi.fn();
  });
  afterEach(() => {
    Object.assign(reapDeps, realDeps);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const file = () => path.join(dir, 'ios-forward.json');

  it('kills the recorded pid while it is still that go-ios forward, and drops the record', () => {
    recordIosForward(dir, { pid: 777, hostPort: 9097, bin: '/toolchain/go-ios/ios', owner: 55555 });
    reapDeps.isAlive = () => false;   // the backend that owned it is gone — a real orphan
    reapDeps.commandOf = () => '/toolchain/go-ios/ios forward 9097 9095 --udid=U1';
    expect(reapRecordedIosForward(dir)).toMatch(/reaped a go-ios forward \(pid 777\) on tcp:9097/);
    expect(reapDeps.kill).toHaveBeenCalledWith(777);
    expect(fs.existsSync(file())).toBe(false);
  });

  it('a LIVE owner keeps its forward AND its record — Electron\'s Vite child runs this pass on every project open', () => {
    recordIosForward(dir, { pid: 777, hostPort: 9097, bin: '/toolchain/go-ios/ios', owner: 55555 });
    reapDeps.isAlive = (pid) => pid === 55555;
    reapDeps.commandOf = () => '/toolchain/go-ios/ios forward 9097 9095 --udid=U1';
    expect(reapRecordedIosForward(dir)).toBeNull();
    expect(reapDeps.kill).not.toHaveBeenCalled();
    expect(fs.existsSync(file())).toBe(true);
  });

  it('a record THIS module load owns is never reaped — its manager is alive and will stop the child itself', () => {
    recordIosForward(dir, { pid: 777, hostPort: 9097, bin: '/toolchain/go-ios/ios' });   // owner + instance stamped
    reapDeps.commandOf = () => '/toolchain/go-ios/ios forward 9097 9095 --udid=U1';
    expect(reapRecordedIosForward(dir)).toBeNull();
    expect(reapDeps.kill).not.toHaveBeenCalled();
    expect(fs.existsSync(file())).toBe(true);
  });

  it('a record this PID owns through an EARLIER module load is reaped — a Vite config restart abandons that manager', () => {
    // Skipping it (the previous rule) left a forward nothing could stop, refusing every new connect's port
    // check until the dev server exited (close-out re-review).
    recordIosForward(dir, { pid: 777, hostPort: 9097, bin: '/toolchain/go-ios/ios', owner: process.pid, instance: 'an-earlier-evaluation' });
    reapDeps.commandOf = () => '/toolchain/go-ios/ios forward 9097 9095 --udid=U1';
    expect(reapRecordedIosForward(dir)).toMatch(/reaped a go-ios forward \(pid 777\)/);
    expect(reapDeps.kill).toHaveBeenCalledWith(777);
  });

  it.each([
    ['a recycled pid running something else', '/usr/bin/some-other-process forward 9097 9095'],
    ['the same binary forwarding ANOTHER port', '/toolchain/go-ios/ios forward 9098 9095 --udid=U1'],
    ['a pid that is gone', null],
  ])('leaves %s alone', (_label, command) => {
    recordIosForward(dir, { pid: 777, hostPort: 9097, bin: '/toolchain/go-ios/ios', owner: 55555 });
    reapDeps.isAlive = () => false;
    reapDeps.commandOf = () => command;
    expect(reapRecordedIosForward(dir)).toBeNull();
    expect(reapDeps.kill).not.toHaveBeenCalled();
    expect(fs.existsSync(file())).toBe(false);
  });

  it('clearing a record only clears the one that names this pid', () => {
    recordIosForward(dir, { pid: 777, hostPort: 9097, bin: '/b', owner: 1 });
    clearIosForwardRecord(dir, 778);
    expect(fs.existsSync(file())).toBe(true);
    clearIosForwardRecord(dir, 777);
    expect(fs.existsSync(file())).toBe(false);
  });
});
