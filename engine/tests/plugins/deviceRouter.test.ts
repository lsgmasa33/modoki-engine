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

/** Minimal lease-speaking device that also echoes a data method.
 *  `dataMethods` adds canned answers for other methods (e.g. `screenshot`). */
function startMockDevice(
  authority: DeviceLeaseAuthority,
  dataMethods: Record<string, unknown> = {},
): Promise<{ port: number; close: () => Promise<void> }> {
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
          else if (msg.method in dataMethods) result = dataMethods[msg.method];
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

// #102 — the screenshot branch. The iOS native capture is the APP'S OWN, so it cannot see a system
// dialog or springboard; WDA can. These pin the router's side of that: the ordinary path stays
// byte-for-byte what the device said, and the fallback only fires when the native path FAILED.
describe('/api/device/request screenshot (#102)', () => {
  afterEach(async () => { await deviceConnection.disconnect(); });

  it('passes a successful native capture through UNTOUCHED', async () => {
    // No WDA involvement, no added fields: the overwhelmingly common call must not pay for the
    // fallback existing.
    const authority = new DeviceLeaseAuthority();
    const native = { image: 'data:image/png;base64,AAAA', imageWidth: 390, imageHeight: 844, screenWidth: 1170, screenHeight: 2532 };
    const device = await startMockDevice(authority, { screenshot: native });
    try {
      await post('/api/device/connect', { ip: '127.0.0.1', port: device.port });
      const req = await post('/api/device/request', { method: 'screenshot', params: {} });
      expect(bodyOf(req)).toEqual({ result: native });
    } finally {
      await device.close();
    }
  });

  it('on a FAILED native capture, reports why the WDA fallback could not help either', async () => {
    // Both paths failed ⇒ return the NATIVE error (the one the caller asked for) and carry the WDA
    // reason alongside, so "why didn't the fallback save me" needs no second call. No WDA is
    // running against 127.0.0.1 here, which is exactly the state this asserts.
    const authority = new DeviceLeaseAuthority();
    const device = await startMockDevice(authority, { screenshot: 'Error: no window to capture' });
    try {
      await post('/api/device/connect', { ip: '127.0.0.1', port: device.port });
      const req = await post('/api/device/request', { method: 'screenshot', params: {} });
      const body = bodyOf(req);
      expect(body.result).toBe('Error: no window to capture');
      expect(String(body.wdaFallbackUnavailable)).toMatch(/WebDriverAgent/);
    } finally {
      await device.close();
    }
  });

  it('an explicit source:"wda" is REFUSED when WDA is unreachable — never silently downgraded', async () => {
    // The caller asked for the full-device capture precisely because the native one cannot see what
    // they need. Quietly handing back a native capture would answer a different question and look
    // like success.
    const authority = new DeviceLeaseAuthority();
    const device = await startMockDevice(authority, { screenshot: { image: 'data:image/png;base64,AAAA' } });
    try {
      await post('/api/device/connect', { ip: '127.0.0.1', port: device.port });
      const req = (await post('/api/device/request', { method: 'screenshot', params: { source: 'wda' } })) as { status?: number };
      expect(req.status).toBe(409);
      expect(String(bodyOf(req).error)).toMatch(/WebDriverAgent|Build Support/);
    } finally {
      await device.close();
    }
  });
});

describe('/api/device/request screenshot with NO lease (#102)', () => {
  it('source:"wda" reports "no device connected", not "install WebDriverAgent"', async () => {
    // Wrong-cause guard. The WDA reason sends the reader to Build Support, and the device MCP's
    // caughtFailure matches the "no device connected" PREFIX to build its device_connect envelope —
    // so a WDA-flavoured message loses the actionable path as well as naming the wrong problem.
    const r = (await post('/api/device/request', { method: 'screenshot', params: { source: 'wda' } })) as { status?: number };
    expect(r.status).toBe(502);
    expect(String(bodyOf(r).error)).toMatch(/^no device connected/);
  });
});

// The defect a live run caught and no unit test could have (#102). MEASURED on the iPhone Air
// 2026-08-03: pressing home SUSPENDS the app, so the lease drops to `reconnecting` and the native
// capture 502s — which is precisely when the springboard picture is wanted. An earlier revision
// gated source:'wda' on `state === 'connected'` and therefore refused the feature in its motivating
// case. WDA needs no lease at all: it answers host-side on :8100.
/** Poll `/api/device/status` until the lease state satisfies `pred`. The socket drop is async, so
 *  asserting immediately after `device.close()` races it. */
async function waitForLeaseState(pred: (s: string) => boolean, timeoutMs = 2000): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const st = await get('/api/device/status');
    if (pred(String(bodyOf(st).state))) return st;
    if (Date.now() > deadline) return st;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('/api/device/request screenshot while the lease is RECONNECTING (#102)', () => {
  afterEach(async () => { await deviceConnection.disconnect(); });

  it('source:"wda" gets PAST the lease gate when the app is suspended', async () => {
    const authority = new DeviceLeaseAuthority();
    const device = await startMockDevice(authority);
    await post('/api/device/connect', { ip: '127.0.0.1', port: device.port });
    // Kill the device end: the socket drops, the lease starts reconnecting, and `target` is
    // retained (that retention is what makes the WDA capture reachable here). The drop is
    // asynchronous — the state is still 'connected' the instant after close() — so wait for it
    // rather than racing it.
    await device.close();
    const st = (await waitForLeaseState((s) => s !== 'connected')) as unknown;
    expect(bodyOf(st).state).not.toBe('connected');
    expect((bodyOf(st).target as { host?: string } | null)?.host).toBe('127.0.0.1');

    const r = (await post('/api/device/request', { method: 'screenshot', params: { source: 'wda' } })) as { status?: number };
    // No WDA against 127.0.0.1 in a test, so it still refuses — but with the WDA reason, proving it
    // REACHED the WDA attempt instead of being short-circuited by the lease state. Before the fix
    // this was a 502 "no device connected".
    expect(r.status).toBe(409);
    expect(String(bodyOf(r).error)).toMatch(/WebDriverAgent|Build Support/);
  });

  it('a plain screenshot whose proxy THROWS still surfaces the canonical error when WDA cannot help', async () => {
    // The other half: both capture paths are unavailable, so the lease error — the actionable one —
    // must survive rather than being replaced by a WDA-flavoured message.
    const authority = new DeviceLeaseAuthority();
    const device = await startMockDevice(authority);
    await post('/api/device/connect', { ip: '127.0.0.1', port: device.port });
    await device.close();
    await waitForLeaseState((s) => s !== 'connected');
    const r = (await post('/api/device/request', { method: 'screenshot', params: {} })) as { status?: number };
    expect(r.status).toBe(502);
    expect(String(bodyOf(r).error)).toMatch(/^no device connected/);
  });
});
