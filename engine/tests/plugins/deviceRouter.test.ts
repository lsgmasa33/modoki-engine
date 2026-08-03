/** Integration tests for the /api/device/* routes — the contract the thin device MCP depends on.
 *  Drives handleBackendRequest against the process-global `deviceConnection` connected to a real
 *  mock TCP device, proving the request→router→manager→transport→device round-trip and the route
 *  error mapping (the whole data plane was previously untested — code-review T1/T2). */

import { describe, it, expect, afterEach } from 'vitest';
import net from 'net';
import os from 'os';
import { handleBackendRequest, type BackendContext, type Manifest } from '../../plugins/backend/editorBackendRouter';
import { deviceConnection } from '../../plugins/backend/deviceConnection';
import { DeviceLeaseAuthority } from '../../plugins/backend/deviceLease';

/** Minimal lease-speaking device that also echoes a data method. */
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
          else if (msg.method === 'eval') result = (msg as { params?: unknown }).params;
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

function makeCtx(): BackendContext {
  return {
    projectRoot: os.tmpdir(),
    resolveAssetPath: (p: string) => p,
    absToAssetUrl: (p: string) => p,
    firstRootDir: () => null,
    getManifest: () => ({ version: 2, assets: [] }) as Manifest,
    rebuildManifest: () => ({ version: 2, assets: [] }) as Manifest,
    requestBrowser: async () => ({}),
    getSchema: () => undefined,
    invalidateProjectConfig: () => {},
  } as unknown as BackendContext;
}

const post = (urlPath: string, body: unknown) =>
  handleBackendRequest(makeCtx(), { method: 'POST', urlPath, query: new URLSearchParams(), body });
const get = (urlPath: string) =>
  handleBackendRequest(makeCtx(), { method: 'GET', urlPath, query: new URLSearchParams(), body: undefined });
const bodyOf = (r: unknown) => (r as { body: unknown }).body as Record<string, unknown>;

describe('/api/device/* routes', () => {
  afterEach(async () => { await deviceConnection.disconnect(); });

  it('GET /api/device/status reports disconnected before any connect', async () => {
    const r = await get('/api/device/status');
    expect(bodyOf(r).state).toBe('disconnected');
    expect(bodyOf(r).guid).toBeTypeOf('string');
  });

  it('POST /api/device/request 400s when method is missing', async () => {
    const r = (await post('/api/device/request', {})) as { status?: number };
    expect(r.status).toBe(400);
    expect(bodyOf(r).error).toMatch(/method required/i);
  });

  it('POST /api/device/request 502s the proxy when no device is connected', async () => {
    const r = (await post('/api/device/request', { method: 'eval', params: {} })) as { status?: number };
    expect(r.status).toBe(502);
    expect(bodyOf(r).error).toMatch(/no device connected/i);
  });

  it('connect → request → disconnect round-trips through the lease (T1)', async () => {
    const authority = new DeviceLeaseAuthority();
    const device = await startMockDevice(authority);
    try {
      const conn = await post('/api/device/connect', { ip: '127.0.0.1', port: device.port });
      expect(bodyOf(conn).state).toBe('connected');

      const req = await post('/api/device/request', { method: 'eval', params: { x: 7 } });
      // The data-plane reply is wrapped as { result: <device result> }.
      expect(bodyOf(req)).toEqual({ result: { x: 7 } });

      const dis = await post('/api/device/disconnect', {});
      expect(bodyOf(dis).state).toBe('disconnected');
    } finally {
      await device.close();
    }
  });

  // #32 close-out: everything above proves the lease round-trip, and the CDP/WDA modules are unit
  // tested in isolation — but NOTHING drove the router's actual CDP → WDA → synthetic fallback
  // CHAIN, which is the path every real device_* input call takes. That seam is where a routing
  // change silently stops warning, or starts warning about the wrong thing.
  it('an INPUT op with no trusted route falls back to synthetic AND says so (the chain)', async () => {
    const authority = new DeviceLeaseAuthority();
    const device = await startMockDevice(authority);
    try {
      await post('/api/device/connect', { ip: '127.0.0.1', port: device.port });
      // No adb session and no WebDriverAgent here, so both trusted routes decline and the router
      // runs the synthetic proxy — fronted by the loud banner naming the cause.
      const req = await post('/api/device/request', { method: 'tap', params: { x: 1, y: 2 } });
      // The warning rides on BOTH reply shapes. This mock echoes an object, so it takes the
      // `inputFidelityWarning` FIELD branch — the one that exists because `type_text` returns an
      // object and would otherwise warn about nothing, i.e. the silent-synthetic gap wearing a
      // different return type. The string branch prefixes the same banner.
      const result = bodyOf(req).result as { inputFidelityWarning?: string };
      expect(result.inputFidelityWarning).toMatch(/SYNTHETIC INPUT \(NOT TRUSTED\)/);
      expect(result.inputFidelityWarning).toMatch(/isTrusted/);
    } finally {
      await device.close();
    }
  });

  it('a NON-input op gets NO banner — there is no mechanism to report for `eval`', async () => {
    // The other half of the rule, and the one a careless "warn on everything" change breaks: a
    // Percept read or a screenshot has no input fidelity to talk about, so prefixing it would be
    // noise on every call.
    const authority = new DeviceLeaseAuthority();
    const device = await startMockDevice(authority);
    try {
      await post('/api/device/connect', { ip: '127.0.0.1', port: device.port });
      const req = await post('/api/device/request', { method: 'eval', params: { x: 7 } });
      expect(bodyOf(req)).toEqual({ result: { x: 7 } });   // untouched, no banner
    } finally {
      await device.close();
    }
  });
});
