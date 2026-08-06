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
import { WDA_NOT_IOS_REASON, _resetDeviceWdaStateForTests } from '../../plugins/backend/deviceWda';
import { _resetDeviceCdpStateForTests, _setDeviceCdpSessionProbeForTests } from '../../plugins/backend/deviceCdp';
import { _resetWdaLauncherForTests } from '../../plugins/backend/wdaLauncher';

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
 *  asserting immediately after `device.close()` races it.
 *
 *  THROWS on timeout — it must not return the last-seen state. The earlier version did, which made
 *  a timeout indistinguishable from the behaviour under test failing: on the public Windows runner
 *  the drop took longer than the old 2s budget, so this returned `connected` and the caller's
 *  `expect(state).not.toBe('connected')` failed. That reads as "WDA was short-circuited by the lease
 *  gate" — a product bug in the feature this test guards — when in fact the PRECONDITION never
 *  happened and the real assertion below never ran. A helper that gives up must say so, not hand
 *  back a value the caller will misread.
 *
 *  The budget is Windows-shaped: socket-close propagation there is slower than on ubuntu/macOS,
 *  and 10s sits well inside the suite's 20s `testTimeout` (engine/vite.config.ts). */
async function waitForLeaseState(pred: (s: string) => boolean, timeoutMs = 10_000): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  let last: string;
  for (;;) {
    const st = await get('/api/device/status');
    last = String(bodyOf(st).state);
    if (pred(last)) return st;
    if (Date.now() > deadline) {
      throw new Error(
        `waitForLeaseState: lease never left state "${last}" within ${timeoutMs}ms. `
        + 'This is the WAIT failing, not the assertion that follows it — the precondition for the '
        + 'test never happened, so nothing about the device-request behaviour was proven.',
      );
    }
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

// #99 — the WebDriverAgent route is iOS-only, but nothing enforced it before this. An Android
// device connected by IP has no CDP route (CDP discovery needs adb), so it fell through into the
// iOS agent path: every device_tap probed port 8100 on the ANDROID phone and answered "cannot
// start WebDriverAgent — cannot tell which iPhone to use — 4 are paired… Set
// MODOKI_IOS_DEVICE_UDID". Measured on a Samsung reached by IP, 2026-08-03. `devicePlatform()`
// (deviceConnection.ts) closes the gap by asking the bridge's `app-identity` op once per lease and
// gating both WDA entry points (input + all three screenshot sites in editorBackendRouter.ts) on
// the answer being `'ios'`.
describe('/api/device/request WDA gated on device platform (#99)', () => {
  afterEach(async () => {
    await deviceConnection.disconnect();
    // wdaLauncher/deviceWda hold MODULE-LEVEL state (a latched lastFailure, a cached session) that
    // otherwise leaks into the NEXT test and makes these order-dependent — the same trap #102's
    // WDA tests already had to account for.
    _resetWdaLauncherForTests();
    _resetDeviceWdaStateForTests();
  });

  it('an Android device gets NO iOS wording in the fallback banner — the regression itself', async () => {
    const authority = new DeviceLeaseAuthority();
    const device = await startMockDevice(authority, { 'app-identity': { platform: 'android', appId: 'x', appName: 'y' } });
    try {
      await post('/api/device/connect', { ip: '127.0.0.1', port: device.port });
      const req = await post('/api/device/request', { method: 'tap', params: { x: 1, y: 2 } });
      const result = bodyOf(req).result as { inputFidelityWarning?: string };
      const warning = result.inputFidelityWarning ?? '';
      // Before the fix this string named an iPhone and told the reader to set an env var that
      // does not exist on this device — the exact wrong-machine diagnostic that was measured live.
      expect(warning).not.toMatch(/iPhone/i);
      expect(warning).not.toContain('MODOKI_IOS_DEVICE_UDID');
      expect(warning).toMatch(/SYNTHETIC INPUT \(NOT TRUSTED\)/);
      // The reason it DOES carry is the CDP one (unchanged by this fix) — Android's real advice.
      expect(warning).toMatch(/adb/);
    } finally {
      await device.close();
    }
  });

  it('an iOS device still gets the WDA path attempted', async () => {
    const authority = new DeviceLeaseAuthority();
    const device = await startMockDevice(authority, { 'app-identity': { platform: 'ios', appId: 'x', appName: 'y' } });
    try {
      await post('/api/device/connect', { ip: '127.0.0.1', port: device.port });
      const req = await post('/api/device/request', { method: 'tap', params: { x: 1, y: 2 } });
      const result = bodyOf(req).result as { inputFidelityWarning?: string };
      // No real WDA agent answers in this test (no toolchain dir), so it fails to find one and
      // falls back to synthetic — that is fine and expected. What this pins is that the branch is
      // still REACHED for iOS: the gate is `=== 'ios'`, not merely "not confirmed Android".
      expect(result.inputFidelityWarning ?? '').toMatch(/WebDriverAgent/);
    } finally {
      await device.close();
    }
  });

  it('an old bridge with no app-identity handler is treated as NOT-confirmed-iOS, never assumed', async () => {
    // Deliberate: an unknown answer must never be read as "iOS" (the whole reason `platform` and
    // `platformResolved` are separate fields on the manager). This mock has no 'app-identity'
    // canned reply at all, so the device answers the generic `{ok:false,reason:'not-owner'}` —
    // exactly what an old bridge without the op would send.
    const authority = new DeviceLeaseAuthority();
    const device = await startMockDevice(authority);
    try {
      await post('/api/device/connect', { ip: '127.0.0.1', port: device.port });
      const req = await post('/api/device/request', { method: 'tap', params: { x: 1, y: 2 } });
      const result = bodyOf(req).result as { inputFidelityWarning?: string };
      const warning = result.inputFidelityWarning ?? '';
      expect(warning).not.toMatch(/iPhone/i);
      expect(warning).not.toContain('MODOKI_IOS_DEVICE_UDID');
      expect(warning).toMatch(/SYNTHETIC INPUT \(NOT TRUSTED\)/);
      expect(warning).toMatch(/adb/);
    } finally {
      await device.close();
    }
  });

  it('app-identity is asked exactly ONCE per lease, even across several input ops', async () => {
    // `startMockDevice`'s `dataMethods` is a plain lookup table with no counting of its own.
    // Wrapping it in a counting Proxy here — rather than teaching the shared helper about counting
    // — is enough to see how many times the bridge was actually asked for its identity.
    const counts: Record<string, number> = {};
    const dataMethods: Record<string, unknown> = new Proxy<Record<string, unknown>>(
      { 'app-identity': { platform: 'android', appId: 'x', appName: 'y' } },
      {
        get(target, prop) {
          const key = String(prop);
          counts[key] = (counts[key] ?? 0) + 1;
          return target[key];
        },
      },
    );
    const authority = new DeviceLeaseAuthority();
    const device = await startMockDevice(authority, dataMethods);
    try {
      await post('/api/device/connect', { ip: '127.0.0.1', port: device.port });
      await post('/api/device/request', { method: 'tap', params: { x: 1, y: 2 } });
      await post('/api/device/request', { method: 'tap', params: { x: 3, y: 4 } });
      await post('/api/device/request', { method: 'tap', params: { x: 5, y: 6 } });
      // Resolved eagerly in connect() and latched (`platformResolved`) — three more taps must not
      // ask again. This is the whole point of the cache: the answer cannot change without a
      // reconnect, and this sits on the input hot path.
      expect(counts['app-identity']).toBe(1);
    } finally {
      await device.close();
    }
  });

  it('screenshot source:"wda" on Android 409s naming the non-iOS reason', async () => {
    const authority = new DeviceLeaseAuthority();
    const device = await startMockDevice(authority, { 'app-identity': { platform: 'android', appId: 'x', appName: 'y' } });
    try {
      await post('/api/device/connect', { ip: '127.0.0.1', port: device.port });
      const req = (await post('/api/device/request', { method: 'screenshot', params: { source: 'wda' } })) as { status?: number };
      expect(req.status).toBe(409);
      expect(bodyOf(req).error).toBe(WDA_NOT_IOS_REASON);
    } finally {
      await device.close();
    }
  });
});

// #142 — the MIRROR of the #99 gate above, and it was missing. CDP discovery runs entirely through
// adb (`/proc/net/unix` → `adb forward`) and knows nothing about the lease, so "a CDP route exists"
// is NOT "the leased device is the one adb sees". Measured on hardware 2026-08-06: an iPhone leased
// over WiFi (app `com.modokiengine.court`, platform `ios`) with a Samsung on USB — `device_tap`
// dispatched into the SAMSUNG and returned `ok (cdp touch) … [input:trusted-cdp]` while the
// iPhone's page received zero events, with the coordinates resolved through the LEASE (computed on
// the iPhone's 375x667 layout, injected into a different screen).
//
// These tests inject `getSession` so no adb/hardware is needed: a session that WOULD have been
// used proves the gate by never being asked for.
describe('/api/device/request CDP gated on device platform + app identity (#142)', () => {
  afterEach(async () => {
    await deviceConnection.disconnect();
    _resetWdaLauncherForTests();
    _resetDeviceWdaStateForTests();
    _resetDeviceCdpStateForTests();
  });

  it('an iOS lease never reaches the CDP route, even with a session available', async () => {
    // The regression itself. Before the gate this returned a trusted-cdp reply for an iOS lease.
    let asked = 0;
    const spy = async () => { asked++; return null; };
    const authority = new DeviceLeaseAuthority();
    const device = await startMockDevice(authority, {
      'app-identity': { platform: 'ios', appId: 'com.modokiengine.court', appName: 'Court' },
    });
    try {
      await post('/api/device/connect', { ip: '127.0.0.1', port: device.port });
      _setDeviceCdpSessionProbeForTests(spy);
      const req = await post('/api/device/request', { method: 'tap', params: { x: 1, y: 2 } });
      const result = bodyOf(req).result as { inputFidelityWarning?: string } | string;
      expect(asked, 'CDP discovery must not even be attempted for an iOS lease').toBe(0);
      expect(JSON.stringify(result)).not.toContain('trusted-cdp');
    } finally {
      _setDeviceCdpSessionProbeForTests(null);
      await device.close();
    }
  });

  it('an Android lease still reaches the CDP route, and asks for ITS OWN package', async () => {
    // Strictly `=== 'android'`, so this pins that the gate did not simply disable CDP everywhere —
    // and that the lease's appId is what gets handed to discovery as the identity to match.
    let seenPreferPackage: string | undefined | symbol = Symbol('never asked');
    const spy = async (opts: { preferPackage?: string }) => { seenPreferPackage = opts.preferPackage; return null; };
    const authority = new DeviceLeaseAuthority();
    const device = await startMockDevice(authority, {
      'app-identity': { platform: 'android', appId: 'com.modokiengine.invader', appName: 'Invader' },
    });
    try {
      await post('/api/device/connect', { ip: '127.0.0.1', port: device.port });
      _setDeviceCdpSessionProbeForTests(spy);
      await post('/api/device/request', { method: 'tap', params: { x: 1, y: 2 } });
      expect(seenPreferPackage).toBe('com.modokiengine.invader');
    } finally {
      _setDeviceCdpSessionProbeForTests(null);
      await device.close();
    }
  });

  it('an old bridge with no app-identity is NOT assumed Android — same rule as the iOS gate', async () => {
    let asked = 0;
    const spy = async () => { asked++; return null; };
    const authority = new DeviceLeaseAuthority();
    const device = await startMockDevice(authority);
    try {
      await post('/api/device/connect', { ip: '127.0.0.1', port: device.port });
      _setDeviceCdpSessionProbeForTests(spy);
      await post('/api/device/request', { method: 'tap', params: { x: 1, y: 2 } });
      expect(asked, 'an unconfirmed platform must never be read as Android').toBe(0);
    } finally {
      _setDeviceCdpSessionProbeForTests(null);
      await device.close();
    }
  });

  it('GET /api/device/status does not claim trusted-cdp for an iOS lease', async () => {
    // The status route had the same asymmetry, and it is the one an agent reads BEFORE deciding
    // whether to trust its input — so a lie here is consulted first.
    const authority = new DeviceLeaseAuthority();
    const device = await startMockDevice(authority, {
      'app-identity': { platform: 'ios', appId: 'com.modokiengine.court', appName: 'Court' },
    });
    try {
      await post('/api/device/connect', { ip: '127.0.0.1', port: device.port });
      _setDeviceCdpSessionProbeForTests(async () => null);
      const r = await get('/api/device/status');
      expect(bodyOf(r).inputMechanism).not.toBe('trusted-cdp');
    } finally {
      _setDeviceCdpSessionProbeForTests(null);
      await device.close();
    }
  });
});
