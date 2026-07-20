/** The `useAdb` connect branch (code-review T9 / #45) — previously untested. Overrides the
 *  `adbRunner` seam so the real `adb` binary is never invoked (and no `child_process` module mock,
 *  which fights vitest's per-file module cache in the full suite). */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import net from 'net';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { DeviceConnectionManager, adbRunner } from '../../plugins/backend/deviceConnection';
import { DeviceLeaseAuthority } from '../../plugins/backend/deviceLease';

const realForward = adbRunner.forward;
const realRemove = adbRunner.removeForward;
// Per-test `.modoki` so the persisted last-target never touches the real repo and can't leak between tests.
let stateDir: string;
beforeEach(() => {
  adbRunner.forward = vi.fn(); adbRunner.removeForward = vi.fn();
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-adb-'));
});
afterEach(() => {
  adbRunner.forward = realForward; adbRunner.removeForward = realRemove;
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
    expect(adbRunner.forward).toHaveBeenCalledWith(9095);
  });

  // ── Bare reconnect reuses the saved useAdb; supplying an ip is all-or-nothing (never inherits adb) ──
  it('a bare reconnect (no ip, no useAdb) re-takes the adb branch of the last target', async () => {
    const mgr = new DeviceConnectionManager('g-adb-recon', stateDir);
    // Seed lastTarget {ip:'', useAdb:true}. adb forward is stubbed; the socket to a refused port
    // errors, but the target is remembered before the attempt — that's all we need.
    await mgr.connect({ useAdb: true, port: 1 });
    (adbRunner.forward as ReturnType<typeof vi.fn>).mockClear();
    const status = await mgr.connect({});                       // bare
    expect(adbRunner.forward).toHaveBeenCalledWith(9095);       // reused useAdb:true (default port)
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
    try {
      const status = await mgr.connect({ useAdb: true, port: device.port });
      expect(adbRunner.forward).toHaveBeenCalledWith(device.port);
      expect(status.state).toBe('connected');
      expect(status.target).toMatchObject({ host: '127.0.0.1', useAdb: true });
    } finally {
      await mgr.disconnect();
      await device.close();
    }
  });
});
