import { describe, it, expect, beforeEach } from 'vitest';
import {
  resolveWdaPort, DEFAULT_WDA_PORT, makeWdaSession, wdaTap, wdaDrag,
  getDeviceWdaSession, tryDeviceWdaInput, isDeviceWdaAvailable, isWdaRoutableMethod,
  _resetDeviceWdaStateForTests, TRUSTED_WDA_MECHANISM,
  tryDeviceWdaScreenshot, pngDimensions, WDA_SHOT_NO_SESSION_REASON, WDA_SHOT_COORDINATE_WARNING,
  WDA_NOT_RUNNING_REASON, WDA_SESSION_LOST_REASON,
  type WdaFetch, type WdaSession,
} from '../../plugins/backend/deviceWda';
import { STALE_APP_REASON } from '../../plugins/backend/deviceAim';

/**
 * iOS trusted input via WebDriverAgent (#32 Phase 2). Everything here is pinned against behaviour
 * MEASURED on the iPhone Air (see deviceWda.ts's header) — these tests exist so the measured facts
 * cannot be refactored away without a failure.
 */

/** A fetch stub. `routes` maps a path SUFFIX to the JSON body WDA would return. */
function fakeFetch(routes: Record<string, unknown>, opts: { httpStatus?: number } = {}): WdaFetch & { calls: Array<{ url: string; method?: string; body?: unknown }> } {
  const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
  const f = (async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(init.body) : undefined });
    const key = Object.keys(routes).find((k) => url.includes(k));
    const payload = key ? routes[key] : { value: null };
    return {
      ok: (opts.httpStatus ?? 200) < 400,
      status: opts.httpStatus ?? 200,
      text: async () => JSON.stringify(payload),
    };
  }) as WdaFetch & { calls: typeof calls };
  f.calls = calls;
  return f;
}

const OK = { value: null };

beforeEach(() => _resetDeviceWdaStateForTests());

describe('resolveWdaPort', () => {
  it('defaults to 8100 — the port WDA binds on the DEVICE', () => {
    // No per-clone derivation on purpose: the port lives on the phone, and two clones driving one
    // phone is already serialized by the lease.
    expect(resolveWdaPort({})).toBe(DEFAULT_WDA_PORT);
    expect(resolveWdaPort({ MODOKI_WDA_PORT: '8200' })).toBe(8200);
  });

  it('ignores junk rather than producing an unusable URL', () => {
    for (const bad of ['', 'abc', '0', '70000', '-1']) {
      expect(resolveWdaPort({ MODOKI_WDA_PORT: bad })).toBe(DEFAULT_WDA_PORT);
    }
  });
});

describe('a WDA error arrives with HTTP 200 — the measured trap', () => {
  it('THROWS on an error carried in the body, despite a 200', async () => {
    // Measured: `/wda/tap/0` (the endpoint every older guide names) answers `unknown command` with
    // HTTP 200. Trusting the status code reports success for input that was never delivered — it
    // cost three no-op taps during the spike before the body was read.
    const f = fakeFetch({ '/actions': { value: { error: 'unknown command', message: 'Unhandled endpoint' } } });
    const s = makeWdaSession(f, 'http://d:8100', 'S1');
    await expect(wdaTap(s, 10, 20)).rejects.toThrow(/unknown command/);
  });

  it('still throws on a genuine non-200', async () => {
    const f = fakeFetch({}, { httpStatus: 500 });
    const s = makeWdaSession(f, 'http://d:8100', 'S1');
    await expect(wdaTap(s, 10, 20)).rejects.toThrow(/HTTP 500/);
  });
});

describe('W3C Actions payloads', () => {
  it('a tap is ONE call: move → down → hold → up, as a TOUCH pointer', async () => {
    const f = fakeFetch({ '/actions': OK });
    await wdaTap(makeWdaSession(f, 'http://d:8100', 'S1'), 210.4, 473.6, 90);
    const body = f.calls[0].body as { actions: Array<{ type: string; parameters: { pointerType: string }; actions: Array<Record<string, unknown>> }> };
    expect(f.calls[0].url).toBe('http://d:8100/session/S1/actions');
    expect(body.actions[0].type).toBe('pointer');
    expect(body.actions[0].parameters.pointerType).toBe('touch');   // touch, not mouse — it is a phone
    expect(body.actions[0].actions.map((a) => a.type)).toEqual(['pointerMove', 'pointerDown', 'pause', 'pointerUp']);
    // Coordinates are INTEGER CSS px, sent as-is: the transform is identity (measured).
    expect(body.actions[0].actions[0]).toMatchObject({ x: 210, y: 474 });
  });

  it('a drag hands WDA a DURATION, because WDA interpolates the move itself', async () => {
    // Measured: one durated pointerMove produced 14 intermediate trusted pointermoves. The synthetic
    // path has to emit each step by hand; converting steps×delay preserves a caller's slow drag.
    const f = fakeFetch({ '/actions': OK });
    await wdaDrag(makeWdaSession(f, 'http://d:8100', 'S1'), { x: 10, y: 20 }, { x: 300, y: 400 }, 250);
    const acts = (f.calls[0].body as { actions: Array<{ actions: Array<Record<string, unknown>> }> }).actions[0].actions;
    expect(acts.map((a) => a.type)).toEqual(['pointerMove', 'pointerDown', 'pointerMove', 'pointerUp']);
    expect(acts[2]).toMatchObject({ x: 300, y: 400, duration: 250 });
  });
});

describe('getDeviceWdaSession', () => {
  it('does NOT send a bundleId — that would RESTART the app and rebind the debug port', async () => {
    // The hazard: activating an app restarts it, and this repo's bridge then binds a different port,
    // invalidating the lease mid-run. Measured — omitting bundleId attaches without touching the
    // foreground app.
    const f = fakeFetch({ '/status': OK, '/session': { sessionId: 'S9', value: null } });
    const s = await getDeviceWdaSession({ host: '10.0.0.5', fetchImpl: f });
    expect(s?.sessionId).toBe('S9');
    const create = f.calls.find((c) => c.url.endsWith('/session'))!;
    expect(JSON.stringify(create.body)).not.toMatch(/bundleId/i);
  });

  it('returns null with no host — an adb/USB lease is Android, so there is nothing to reach', async () => {
    expect(await getDeviceWdaSession({ fetchImpl: fakeFetch({}) })).toBeNull();
  });

  it('returns null (not a throw) when WDA is unreachable, so the caller can fall back', async () => {
    const f: WdaFetch = async () => { throw new Error('ECONNREFUSED'); };
    expect(await getDeviceWdaSession({ host: '10.0.0.5', fetchImpl: f })).toBeNull();
  });

  it('a different host does not get the previous device\'s session (#519)', async () => {
    const f1 = fakeFetch({ '/status': OK, '/session': { sessionId: 'S-IPAD', value: null } });
    const s1 = await getDeviceWdaSession({ host: '10.0.0.5', fetchImpl: f1 });
    expect(s1?.sessionId).toBe('S-IPAD');
    const f2 = fakeFetch({ '/status': OK, '/session': { sessionId: 'S-AIR', value: null } });
    const s2 = await getDeviceWdaSession({ host: '10.0.0.9', fetchImpl: f2 });
    expect(s2?.sessionId).toBe('S-AIR');
    expect(s2?.baseUrl).toContain('10.0.0.9');
    expect(f2.calls.some((c) => c.url.endsWith('/session'))).toBe(true);
  });

  it('the same host DOES reuse the cached session — a guard against a legitimate reuse', async () => {
    const f = fakeFetch({ '/status': OK, '/session': { sessionId: 'S9', value: null } });
    const s1 = await getDeviceWdaSession({ host: '10.0.0.5', fetchImpl: f });
    const s2 = await getDeviceWdaSession({ host: '10.0.0.5', fetchImpl: f });
    expect(s2).toBe(s1);
    expect(f.calls.filter((c) => c.url.endsWith('/session') && c.method !== 'DELETE').length).toBe(1);
  });

  it('a call with no host drops the cached session rather than handing it over (#519)', async () => {
    const f1 = fakeFetch({ '/status': OK, '/session': { sessionId: 'S9', value: null } });
    await getDeviceWdaSession({ host: '10.0.0.5', fetchImpl: f1 });
    const noHost = await getDeviceWdaSession({ fetchImpl: fakeFetch({}) });
    expect(noHost).toBeNull();
    // Prove the cache was actually CLEARED, not merely bypassed: the next call for the SAME host
    // must rediscover rather than hand back the stale S9 session.
    const f2 = fakeFetch({ '/status': OK, '/session': { sessionId: 'S-NEW', value: null } });
    const s3 = await getDeviceWdaSession({ host: '10.0.0.5', fetchImpl: f2 });
    expect(s3?.sessionId).toBe('S-NEW');
  });

  it('a different port on the same host does not share a session', async () => {
    const f1 = fakeFetch({ '/status': OK, '/session': { sessionId: 'S-8100', value: null } });
    const s1 = await getDeviceWdaSession({ host: '10.0.0.5', port: 8100, fetchImpl: f1 });
    expect(s1?.sessionId).toBe('S-8100');
    const f2 = fakeFetch({ '/status': OK, '/session': { sessionId: 'S-8101', value: null } });
    const s2 = await getDeviceWdaSession({ host: '10.0.0.5', port: 8101, fetchImpl: f2 });
    expect(s2?.sessionId).toBe('S-8101');
  });
});

// ── Routing ───────────────────────────────────────────────────────────────────

/** The device transport returns JSON **strings**, never objects. A mock returning an object is
 *  exactly what made Phase 1 ship unit-green and dead in production — so these fakes return strings. */
const aimString = (x: number, y: number, label = 'css') => JSON.stringify({ x, y, label });

function sessionStub(): WdaSession & { sent: unknown[]; released: number } {
  const sent: unknown[] = [];
  let released = 0;
  const s = {
    baseUrl: 'http://d:8100', sessionId: 'S1', sent,
    get released() { return released; },
    actions: async (p: unknown) => { sent.push(p); },
    releaseActions: async () => { released++; },
    screenshot: async () => pngBase64(390, 844),
  };
  return s as WdaSession & { sent: unknown[]; released: number };
}

describe('tryDeviceWdaInput — what iOS routes, and what it deliberately does not', () => {
  it('routes ONLY tap and drag', () => {
    expect(isWdaRoutableMethod('tap')).toBe(true);
    expect(isWdaRoutableMethod('drag')).toBe(true);
    // Measured, not unimplemented: WDA has no wheel action, a touchscreen has no hover, and a
    // trusted key reaches only a FOCUSED element (with the canvas focused the page got nothing).
    for (const m of ['press-key', 'scroll', 'hover', 'pointer', 'type-text']) {
      expect(isWdaRoutableMethod(m)).toBe(false);
    }
  });

  it('leaves a non-routable op to the caller WITHOUT inventing a reason', async () => {
    // `reason: null` matters: the caller keeps the CDP-side cause for its banner. Returning a
    // WDA-flavoured reason here would mislabel an Android device's failure as an iOS limitation.
    const r = await tryDeviceWdaInput('scroll', {}, { proxy: async () => aimString(1, 2), getSession: async () => sessionStub() });
    expect(r).toEqual({ handled: false, reason: null });
  });

  it('falls back with an ACTIONABLE reason when WDA is not running', async () => {
    const r = await tryDeviceWdaInput('tap', {}, { proxy: async () => aimString(1, 2), getSession: async () => null });
    expect(r).toEqual({ handled: false, reason: WDA_NOT_RUNNING_REASON });
    expect(WDA_NOT_RUNNING_REASON).toMatch(/Build Support/);   // says what to DO
  });

  it('dispatches a tap and reports the WDA mechanism', async () => {
    const s = sessionStub();
    const r = await tryDeviceWdaInput('tap', { x: 5, y: 6 }, { proxy: async () => aimString(210, 473, 'canvas'), getSession: async () => s });
    expect(r).toEqual({ handled: true, reply: expect.stringContaining(`[input:${TRUSTED_WDA_MECHANISM}]`) });
    expect(s.sent).toHaveLength(1);
  });

  it('WIRE SHAPE: a string aim reply is decoded, not fed to `in`', async () => {
    // The Phase 1 post-mortem in one test. If this regresses, every trusted dispatch silently
    // becomes synthetic while the unit suite stays green.
    const s = sessionStub();
    const r = await tryDeviceWdaInput('tap', {}, { proxy: async () => aimString(100, 200), getSession: async () => s });
    expect(r.handled).toBe(true);
    expect(s.sent).toHaveLength(1);
  });

  it('an app predating `resolve-aim` falls back, rather than refusing', async () => {
    const r = await tryDeviceWdaInput('tap', {}, { proxy: async () => 'Unknown method: resolve-aim', getSession: async () => sessionStub() });
    expect(r).toEqual({ handled: false, reason: STALE_APP_REASON });
  });

  it("a page's aim REFUSAL is returned verbatim — retrying via synthetic would refuse identically", async () => {
    const r = await tryDeviceWdaInput('tap', { selector: '#gone' }, {
      proxy: async () => 'Error: selector "#gone" did not resolve', getSession: async () => sessionStub(),
    });
    expect(r).toEqual({ handled: true, reply: 'Error: selector "#gone" did not resolve' });
  });

  it('a drag resolves BOTH ends and converts steps×delay into a duration', async () => {
    const s = sessionStub();
    let call = 0;
    const r = await tryDeviceWdaInput('drag', { steps: 4, delayMs: 50 }, {
      proxy: async () => (++call === 1 ? aimString(10, 20) : aimString(300, 400)),
      getSession: async () => s,
    });
    expect(r.handled).toBe(true);
    const acts = (s.sent[0] as { actions: Array<{ actions: Array<Record<string, unknown>> }> }).actions[0].actions;
    expect(acts[2]).toMatchObject({ x: 300, y: 400, duration: 200 });   // 4 × 50
  });

  it('RELEASES a possibly-stuck pointer on failure, then allows the fallback', async () => {
    // The one place WDA is BETTER than CDP: a CDP gesture is several sends, so a mid-gesture failure
    // must refuse (falling back would double-dispatch onto a stuck finger). A WDA gesture is one
    // call and W3C defines DELETE /actions, so we can clean up and still deliver the input.
    const s = sessionStub();
    s.actions = async () => { throw new Error('connection reset'); };
    const r = await tryDeviceWdaInput('tap', {}, { proxy: async () => aimString(1, 2), getSession: async () => s });
    expect(s.released).toBe(1);
    expect(r).toEqual({ handled: false, reason: WDA_SESSION_LOST_REASON });
  });
});

describe('isDeviceWdaAvailable — the WHOLE chain, not the cheap half', () => {
  it('false without a session', async () => {
    expect(await isDeviceWdaAvailable({ getSession: async () => null })).toBe(false);
  });

  it('false when the app cannot resolve an aim, even though WDA is up', async () => {
    // Checking only the session is what made device_status claim `trusted-cdp` on Android while
    // every tap came back synthetic. Same trap, same guard, other transport.
    const ok = await isDeviceWdaAvailable({
      getSession: async () => sessionStub(), proxy: async () => 'Unknown method: resolve-aim',
    });
    expect(ok).toBe(false);
  });

  it('true when both halves answer', async () => {
    expect(await isDeviceWdaAvailable({ getSession: async () => sessionStub(), proxy: async () => aimString(0, 0) })).toBe(true);
  });

  it('a throwing proxy is NOT available (never an optimistic claim)', async () => {
    const ok = await isDeviceWdaAvailable({
      getSession: async () => sessionStub(), proxy: async () => { throw new Error('lease dropped'); },
    });
    expect(ok).toBe(false);
  });
});

// ── Screenshot (#102) ────────────────────────────────────────────────────────
//
// The iOS native capture is the APP'S OWN, so it can only ever show the app: a system permission
// dialog is a different window and comes back with the app UNDERNEATH it — a fine-looking
// screenshot of the wrong thing. WDA sees the whole screen. These tests pin the two properties
// that make that safe to ship: a WDA reply is decoded from its BODY (WDA answers failures with
// HTTP 200), and every capture carries the coordinate-space warning, because its pixels are the
// device screen and feeding them to device_tap would be silently wrong.

/** A real PNG header (signature + IHDR) — enough for `pngDimensions`, which reads bytes 16..24. */
function pngBase64(width: number, height: number): string {
  const buf = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12);
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf.toString('base64');
}

describe('pngDimensions', () => {
  it('reads width/height out of the IHDR chunk', () => {
    expect(pngDimensions(pngBase64(1170, 2532))).toEqual({ width: 1170, height: 2532 });
  });

  it('returns null for anything that is not a PNG — no confident nonsense', () => {
    // Degrading to "no dimensions" keeps a surprise payload from being reported as a real size.
    for (const junk of ['', 'bm90IGEgcG5n', Buffer.alloc(24).toString('base64')]) {
      expect(pngDimensions(junk)).toBeNull();
    }
  });
});

describe('session.screenshot', () => {
  it('GETs the session screenshot endpoint and returns the base64 body', async () => {
    const png = pngBase64(390, 844);
    const f = fakeFetch({ '/screenshot': { value: png } });
    const s = makeWdaSession(f, 'http://d:8100', 'S1');
    expect(await s.screenshot()).toBe(png);
    expect(f.calls[0].url).toBe('http://d:8100/session/S1/screenshot');
    expect(f.calls[0].method).toBe('GET');
  });

  it('THROWS on an error carried in a 200 body', async () => {
    // Measured on the iPhone: WDA answers a bad endpoint with HTTP 200 + {value:{error}}. Trusting
    // the status code is what silently reported success for taps that never landed.
    const f = fakeFetch({ '/screenshot': { value: { error: 'unknown command', message: 'no such route' } } });
    const s = makeWdaSession(f, 'http://d:8100', 'S1');
    await expect(s.screenshot()).rejects.toThrow(/unknown command/);
  });

  it('THROWS rather than passing off a non-string value as an image', async () => {
    const f = fakeFetch({ '/screenshot': { value: null } });
    const s = makeWdaSession(f, 'http://d:8100', 'S1');
    await expect(s.screenshot()).rejects.toThrow(/no image data/);
  });
});

describe('tryDeviceWdaScreenshot', () => {
  it('returns the image with its source, dimensions and the coordinate warning', async () => {
    const r = await tryDeviceWdaScreenshot({ getSession: async () => sessionStub() });
    expect(r.handled).toBe(true);
    if (!r.handled) return;
    expect(r.reply.image).toMatch(/^data:image\/png;base64,/);
    expect(r.reply.source).toBe(TRUSTED_WDA_MECHANISM);
    expect(r.reply).toMatchObject({ imageWidth: 390, imageHeight: 844 });
    // The whole risk of this feature in one field: these pixels are NOT page coordinates.
    expect(r.reply.warning).toBe(WDA_SHOT_COORDINATE_WARNING);
    expect(String(r.reply.warning)).toMatch(/device_tap/);
  });

  it('refuses with an actionable reason when there is no session', async () => {
    const r = await tryDeviceWdaScreenshot({ getSession: async () => null });
    expect(r).toEqual({ handled: false, reason: WDA_SHOT_NO_SESSION_REASON });
    expect(WDA_SHOT_NO_SESSION_REASON).toMatch(/Build Support/);
  });

  it('does NOT auto-launch by default, and does when asked', async () => {
    // A screenshot that silently takes ~6s starting an agent — on the AUTOMATIC fallback path,
    // where nobody asked for WDA — is worse than one that says why it could not help. An explicit
    // source:'wda' is a different bargain: the caller wants that capture and can pay for it.
    const seen: Array<boolean | undefined> = [];
    const getSession = async (o: { autoLaunch?: boolean }) => { seen.push(o.autoLaunch); return sessionStub(); };
    await tryDeviceWdaScreenshot({ getSession });
    await tryDeviceWdaScreenshot({ getSession }, { autoLaunch: true });
    expect(seen).toEqual([false, true]);
  });

  it('reports a capture failure instead of throwing, and drops the cached session', async () => {
    // The usual cause is a dead agent (its xcodebuild test process exited); a stale session id
    // would then fail every later call the same way.
    const s = sessionStub();
    s.screenshot = async () => { throw new Error('socket hang up'); };
    const r = await tryDeviceWdaScreenshot({ getSession: async () => s });
    expect(r).toMatchObject({ handled: false });
    if (r.handled) return;
    expect(r.reason).toMatch(/socket hang up/);
  });
});
