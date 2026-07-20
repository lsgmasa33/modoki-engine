import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import net from 'net';
import os from 'os';
import fs from 'fs';
import path from 'path';
import {
  DeviceConnectionManager,
  TcpLeaseTransport,
  loadOrCreateGuid,
  loadLastTarget,
  saveLastTarget,
} from '../../plugins/backend/deviceConnection';
import { DeviceLeaseAuthority } from '../../plugins/backend/deviceLease';

/**
 * A real TCP "device": a net server speaking the lease protocol
 * (`{id, method, params:{guid}}` → `{id, result}`) backed by a DeviceLeaseAuthority.
 * Proves TcpLeaseTransport + DeviceConnectionManager over an actual socket. (Grace-window
 * timing is covered by the pure P0 unit tests; here we exercise the wire + happy/busy paths.)
 */
function startMockDevice(authority: DeviceLeaseAuthority): Promise<{ port: number; close: () => Promise<void>; dropClient: () => void }> {
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
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          let msg: { id: string; method: string; params?: { guid?: string } };
          try { msg = JSON.parse(line); } catch { continue; }
          const guid = msg.params?.guid ?? '';
          const now = Date.now();
          let result;
          if (msg.method === 'connect') result = authority.connect(guid, now);
          else if (msg.method === 'ping') result = authority.ping(guid, now);
          else if (msg.method === 'disconnect') result = authority.disconnect(guid, now);
          else if (msg.method === 'echo') result = (msg as { params?: unknown }).params; // data-plane
          else result = { ok: false, reason: 'not-owner' as const };
          socket.write(JSON.stringify({ id: msg.id, result }) + '\n');
        }
      });
      socket.on('close', () => authority.socketDropped(Date.now()));
      socket.on('error', () => { /* client went away */ });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({
        port,
        close: () => new Promise<void>((r) => { live?.destroy(); server.close(() => r()); }),
        dropClient: () => { live?.destroy(); },
      });
    });
  });
}

describe('DeviceConnectionManager (real TCP)', () => {
  let cleanup: (() => Promise<void>) | null = null;
  // Per-test `.modoki` so the persisted last-target is isolated (never touches the real repo, and
  // one test's saved target can't leak into another's bare-reconnect path).
  let stateDir: string;
  beforeEach(() => { stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-conn-')); });
  afterEach(async () => {
    if (cleanup) { await cleanup(); cleanup = null; }
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('connects to a device over TCP and reports connected + target', async () => {
    const authority = new DeviceLeaseAuthority();
    const device = await startMockDevice(authority);
    const mgr = new DeviceConnectionManager('guid-1', stateDir);
    cleanup = async () => { await mgr.disconnect(); await device.close(); };

    const status = await mgr.connect({ ip: '127.0.0.1', port: device.port });
    expect(status.state).toBe('connected');
    expect(status.guid).toBe('guid-1');
    expect(status.target).toEqual({ host: '127.0.0.1', port: device.port, useAdb: false });
    expect(authority.status(Date.now()).guid).toBe('guid-1');
  });

  it('reports busy when the device is already leased to another Modoki', async () => {
    const authority = new DeviceLeaseAuthority();
    authority.connect('someone-else', Date.now());
    const device = await startMockDevice(authority);
    const mgr = new DeviceConnectionManager('guid-mine', stateDir);
    cleanup = async () => { await mgr.disconnect(); await device.close(); };

    const status = await mgr.connect({ ip: '127.0.0.1', port: device.port });
    expect(status.state).toBe('busy');
  });

  it('releases the lease on disconnect', async () => {
    const authority = new DeviceLeaseAuthority();
    const device = await startMockDevice(authority);
    const mgr = new DeviceConnectionManager('guid-2', stateDir);
    cleanup = async () => { await device.close(); };

    await mgr.connect({ ip: '127.0.0.1', port: device.port });
    const status = await mgr.disconnect();
    expect(status.state).toBe('disconnected');
    expect(status.target).toBeNull();
    // Give the server's close handler a tick, then confirm the lease is free.
    await new Promise((r) => setTimeout(r, 20));
    expect(authority.status(Date.now()).leased).toBe(false);
  });

  it('errors (not throws) when neither IP nor adb is provided', async () => {
    const mgr = new DeviceConnectionManager('guid-3', stateDir);
    const status = await mgr.connect({});
    expect(status.state).toBe('error');
    expect(status.detail).toMatch(/no IP/i);
  });

  it('errors cleanly when the device IP is unreachable', async () => {
    const mgr = new DeviceConnectionManager('guid-4', stateDir);
    cleanup = async () => { await mgr.disconnect(); };
    // Port 1 on localhost refuses fast.
    const status = await mgr.connect({ ip: '127.0.0.1', port: 1 });
    expect(status.state).toBe('error');
  });

  // ── T1: the data plane (proxy) — the path every device_* MCP tool depends on ──
  it('proxy() round-trips a data-plane request over the held socket', async () => {
    const authority = new DeviceLeaseAuthority();
    const device = await startMockDevice(authority);
    const mgr = new DeviceConnectionManager('guid-proxy', stateDir);
    cleanup = async () => { await mgr.disconnect(); await device.close(); };

    await mgr.connect({ ip: '127.0.0.1', port: device.port });
    const res = await mgr.proxy('echo', { hello: 'world', n: 42 });
    expect(res).toEqual({ hello: 'world', n: 42 });
  });

  it('proxy() throws when not connected', async () => {
    const mgr = new DeviceConnectionManager('guid-nc', stateDir);
    await expect(mgr.proxy('echo', {})).rejects.toThrow(/no device connected/i);
  });

  // ── T2: real-TCP unexpected drop → auto-reconnect (the Bonjour replacement) ──
  it('auto-reconnects over real TCP after an unexpected socket drop, resuming the lease', async () => {
    const authority = new DeviceLeaseAuthority();
    const device = await startMockDevice(authority);
    const mgr = new DeviceConnectionManager('guid-recon', stateDir);
    cleanup = async () => { await mgr.disconnect(); await device.close(); };

    await mgr.connect({ ip: '127.0.0.1', port: device.port });
    expect(mgr.status().state).toBe('connected');

    device.dropClient();                                   // socket dies (WiFi blip)
    await new Promise((r) => setTimeout(r, 60));
    expect(mgr.status().state).toBe('reconnecting');

    // Same device still listening; the client re-presents the same guid within grace.
    await new Promise((r) => setTimeout(r, 1400));         // > reconnectDelayMs (1000)
    expect(mgr.status().state).toBe('connected');
    expect(authority.status(Date.now()).guid).toBe('guid-recon');
  });

  // ── Bare reconnect: connect({}) after a prior target reuses it (the documented no-arg path) ──
  it('a bare reconnect (no ip, no useAdb) reuses the last WiFi target instead of erroring', async () => {
    const mgr = new DeviceConnectionManager('guid-wifi-recon', stateDir);
    cleanup = async () => { await mgr.disconnect(); };
    // A first connect to a refused port seeds lastTarget {ip:'127.0.0.1', useAdb:false} (saved before
    // the socket attempt); it errors, which is fine — we only need the target remembered.
    await mgr.connect({ ip: '127.0.0.1', port: 1 });
    // The bare call must take the reconnect branch — select the saved host — NOT short-circuit to the
    // "no IP provided" error the way it does with no remembered target.
    const status = await mgr.connect({});
    expect(status.detail ?? '').not.toMatch(/no IP/i);
    expect(status.target?.host).toBe('127.0.0.1');
    expect(status.target?.useAdb).toBe(false);
  });

  it('a bare reconnect with NO prior target still returns the honest no-IP error', async () => {
    const mgr = new DeviceConnectionManager('guid-no-prior', stateDir);
    const status = await mgr.connect({});
    expect(status.state).toBe('error');
    expect(status.detail).toMatch(/no IP/i);
  });
});

// ── T2b: TcpLeaseTransport timeouts (injectable so the test is fast + deterministic) ──
describe('TcpLeaseTransport timeouts', () => {
  it('rejects a request after requestTimeoutMs when the device never replies', async () => {
    // A server that accepts the socket but never writes a reply.
    let serverSock: net.Socket | null = null;
    const server = net.createServer((s) => { serverSock = s; }); // swallow, never respond
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as net.AddressInfo).port;
    const t = new TcpLeaseTransport('127.0.0.1', port, { requestTimeoutMs: 60 });
    try {
      await t.open();
      await expect(t.send('echo', {})).rejects.toThrow(/timed out/i);
    } finally {
      t.close();
      serverSock?.destroy();                       // else server.close() waits on the live socket
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('rejects open() on a silent (black-holed) connect via the connect-timeout', async () => {
    // 192.0.2.1 is TEST-NET-1 (RFC 5737) — non-routable, so the SYN is dropped.
    const t = new TcpLeaseTransport('192.0.2.1', 9, { connectTimeoutMs: 150 });
    // Either our timeout fires or the OS reports the route unreachable — both reject + settle once.
    await expect(t.open()).rejects.toThrow();
    t.close();
  });
});

// ── T3: GUID + last-target persistence (the reason Modoki mints the GUID) ──
describe('device persistence helpers', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-dev-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('mints a GUID once and returns the SAME one on reload (survives editor restart)', () => {
    const g1 = loadOrCreateGuid(dir);
    expect(g1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(loadOrCreateGuid(dir)).toBe(g1); // second load reads the persisted token
  });

  it('a different clone dir mints its own distinct GUID', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-dev2-'));
    try { expect(loadOrCreateGuid(dir)).not.toBe(loadOrCreateGuid(other)); }
    finally { fs.rmSync(other, { recursive: true, force: true }); }
  });

  it('round-trips the last target and returns null before anything is saved', () => {
    expect(loadLastTarget(dir)).toBeNull();
    saveLastTarget({ ip: '192.168.1.54', useAdb: false }, dir);
    expect(loadLastTarget(dir)).toEqual({ ip: '192.168.1.54', useAdb: false });
    saveLastTarget({ ip: '192.168.1.54', useAdb: true }, dir);
    expect(loadLastTarget(dir)).toEqual({ ip: '192.168.1.54', useAdb: true });
  });

  it('returns null (not a throw) for a corrupt device-target.json', () => {
    fs.writeFileSync(path.join(dir, 'device-target.json'), '{not valid json');
    expect(loadLastTarget(dir)).toBeNull();
  });
});
