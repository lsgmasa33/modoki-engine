/** #32 Phase 1 — unit coverage for `engine/plugins/backend/deviceCdp.ts`.
 *
 *  No adb, no real device, no real WebSocket: the port derivation is pure, the parser is pure
 *  over a text fixture, and the routing/dispatch tests inject a fake `getSession`/`CdpSender` so
 *  `tryDeviceCdpInput` never opens a real socket. Hardware verification (the Samsung actually
 *  receiving a trusted touch) is out of scope for this file — see the plan doc. */

import { describe, it, expect, vi } from 'vitest';
import { aimAsResolved } from '../../plugins/backend/deviceAim';
import {
  NO_SESSION_REASON,
  NOT_ROUTED_REASON,
  STALE_APP_REASON,
  synthFallbackBanner,
  resolveDeviceCdpPort, DEFAULT_DEVICE_CDP_PORT, parseWebviewSockets, isCdpRoutableMethod,
  tryDeviceCdpInput, cdpTap, cdpDrag, cdpPressKey, cdpHover, cdpScroll, isDeviceCdpAvailable,
  TRUSTED_CDP_MECHANISM, discoverDeviceCdpTarget, deviceCdpAdb, resetDeviceCdpSession,
  type CdpSender, type CdpRouteDeps, type DeviceCdpSession,
} from '../../plugins/backend/deviceCdp';

describe('resolveDeviceCdpPort — per-clone derivation', () => {
  it('defaults to 9333 with no env at all', () => {
    expect(resolveDeviceCdpPort({})).toBe(DEFAULT_DEVICE_CDP_PORT);
  });

  it('derives from MODOKI_BACKEND_PORT the same way Vite/CDP ports do (base + backend - 5179)', () => {
    expect(resolveDeviceCdpPort({ MODOKI_BACKEND_PORT: '5180' })).toBe(9334); // work-ai
    expect(resolveDeviceCdpPort({ MODOKI_BACKEND_PORT: '5181' })).toBe(9335); // work-ai2
  });

  it('two clones never collide', () => {
    const main = resolveDeviceCdpPort({ MODOKI_BACKEND_PORT: '5179' });
    const ai2 = resolveDeviceCdpPort({ MODOKI_BACKEND_PORT: '5181' });
    expect(main).not.toBe(ai2);
  });

  it('MODOKI_DEVICE_CDP_PORT is an explicit override, tried before the derivation', () => {
    expect(resolveDeviceCdpPort({ MODOKI_DEVICE_CDP_PORT: '12345', MODOKI_BACKEND_PORT: '5181' })).toBe(12345);
  });

  it('an invalid MODOKI_BACKEND_PORT falls back to the hub default (5179) rather than NaN math', () => {
    expect(resolveDeviceCdpPort({ MODOKI_BACKEND_PORT: 'not-a-port' })).toBe(DEFAULT_DEVICE_CDP_PORT);
  });
});

describe('parseWebviewSockets — /proc/net/unix parsing', () => {
  it('extracts one webview devtools socket', () => {
    const fixture = [
      'Num       RefCount Protocol Flags    Type St Inode Path',
      '0000000000000000: 00000002 00000000 00010000 0001 01 12345 @webview_devtools_remote_9876',
      '0000000000000000: 00000002 00000000 00010000 0001 01 12346 /dev/socket/zygote',
    ].join('\n');
    const sockets = parseWebviewSockets(fixture);
    expect(sockets).toEqual([{ name: 'webview_devtools_remote_9876', pid: '9876' }]);
  });

  it('extracts multiple candidates (several debuggable webviews)', () => {
    const fixture = [
      '0000000000000000: 00000002 00000000 00010000 0001 01 1 @webview_devtools_remote_111',
      '0000000000000000: 00000002 00000000 00010000 0001 01 2 @webview_devtools_remote_222',
    ].join('\n');
    expect(parseWebviewSockets(fixture).map((s) => s.pid)).toEqual(['111', '222']);
  });

  it('returns empty for output with no webview socket', () => {
    expect(parseWebviewSockets('0000000000000000: 00000002 00000000 00010000 0001 01 1 /dev/socket/foo')).toEqual([]);
  });
});

describe('isCdpRoutableMethod', () => {
  it('routes tap/drag/press-key/hover/scroll', () => {
    for (const m of ['tap', 'drag', 'press-key', 'hover', 'scroll']) expect(isCdpRoutableMethod(m)).toBe(true);
  });
  it('does NOT route pointer or type-text (Phase 1 leaves them synthetic)', () => {
    expect(isCdpRoutableMethod('pointer')).toBe(false);
    expect(isCdpRoutableMethod('type-text')).toBe(false);
  });
  it('does not route an unrelated method (eval, screenshot, …)', () => {
    expect(isCdpRoutableMethod('eval')).toBe(false);
    expect(isCdpRoutableMethod('screenshot')).toBe(false);
  });
});

/** A fake CdpSender that records every call, for asserting the exact CDP params the dispatch
 *  helpers build without a real socket. */
function fakeSender(): CdpSender & { calls: Array<{ method: string; params?: Record<string, unknown> }> } {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  return { calls, send: async (method, params) => { calls.push({ method, params }); return {}; } };
}

describe('CDP dispatch helpers — exact params over a fake sender', () => {
  it('cdpTap: touchStart then touchEnd (with a hold in between)', async () => {
    const s = fakeSender();
    await cdpTap(s, 12, 34, 1);
    expect(s.calls.map((c) => c.method)).toEqual(['Input.dispatchTouchEvent', 'Input.dispatchTouchEvent']);
    expect(s.calls[0].params).toMatchObject({ type: 'touchStart', touchPoints: [{ x: 12, y: 34 }] });
    expect(s.calls[1].params).toMatchObject({ type: 'touchEnd', touchPoints: [] });
  });

  it('cdpDrag: touchStart, N touchMoves, touchEnd', async () => {
    const s = fakeSender();
    await cdpDrag(s, { x: 0, y: 0 }, { x: 100, y: 0 }, 4, 1);
    const types = s.calls.map((c) => c.params?.type);
    expect(types).toEqual(['touchStart', 'touchMove', 'touchMove', 'touchMove', 'touchMove', 'touchEnd']);
    // Last move lands exactly at the target.
    const lastMove = s.calls[4].params!.touchPoints as Array<{ x: number; y: number }>;
    expect(lastMove[0]).toMatchObject({ x: 100, y: 0 });
  });

  it('cdpPressKey: keyDown then keyUp with the modifier bitmask', async () => {
    const s = fakeSender();
    await cdpPressKey(s, 'a', ['shift', 'ctrl']);
    expect(s.calls.map((c) => c.params?.type)).toEqual(['keyDown', 'keyUp']);
    expect(s.calls[0].params).toMatchObject({ key: 'a', code: 'KeyA', modifiers: 2 | 8 });
  });

  it('cdpHover: a single mouseMoved', async () => {
    const s = fakeSender();
    await cdpHover(s, 5, 6);
    expect(s.calls).toEqual([{ method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: 5, y: 6, button: 'none' } }]);
  });

  it('cdpScroll: a single mouseWheel carrying dx/dy', async () => {
    const s = fakeSender();
    await cdpScroll(s, 5, 6, 10, -20);
    expect(s.calls).toEqual([{ method: 'Input.dispatchMouseEvent', params: { type: 'mouseWheel', x: 5, y: 6, deltaX: 10, deltaY: -20 } }]);
  });
});

/** A `proxy` stub that answers `resolve-aim` the way the REAL device transport does: a JSON
 *  **string**, never an object. Every proxy mock in this file uses it — including the cases where
 *  routing returns before `proxy` is ever called. That is deliberate: an object-shaped mock is what
 *  made Phase 1 ship unit-green and dead in production, so leaving one lying around here (even an
 *  inert one) would teach the wrong convention to the next edit that DOES reach it. Found by the
 *  #32 close-out sweep. */
const aimProxy: CdpRouteDeps['proxy'] = async () => JSON.stringify({ x: 1, y: 2, label: 'css(1,2)' });

/** Build a `CdpRouteDeps` whose `getSession` is injected — never opens a real socket. */
function depsWithSession(session: DeviceCdpSession | null, proxy: CdpRouteDeps['proxy']): CdpRouteDeps {
  return { proxy, getSession: async () => session };
}

describe('synthFallbackBanner — a fallback must be impossible to skim past', () => {
  // The owner's call (2026-08-02): keep the fallback rather than refusing, but make it LOUD. The
  // pre-existing ` [input:synthetic]` marker sits at the END of a long reply, which is exactly how
  // an agent ends up believing a fidelity-sensitive check passed on a weaker mechanism.
  it('states the mechanism, the cause, and the consequence', () => {
    const banner = synthFallbackBanner(NO_SESSION_REASON);
    expect(banner).toContain('SYNTHETIC INPUT (NOT TRUSTED)');
    expect(banner).toContain(NO_SESSION_REASON);        // the CAUSE, so it is actionable
    expect(banner).toContain('isTrusted');              // the consequence: gated handlers ignore it
  });

  it('no longer claims the wrong-canvas consequence — that one is FIXED', () => {
    // This banner used to warn that synthetic input lands on the FIRST canvas rather than the
    // aimed-at one (#93). The bridge now hit-tests (`pickCanvasAt`), so repeating the warning would
    // be a doc lying about a fixed defect — the exact rot this suite exists to catch. What is left
    // is a pointer to the `canvas:` marker, since `ambiguous` is still a guess.
    const banner = synthFallbackBanner(NO_SESSION_REASON);
    expect(banner).not.toMatch(/FIRST canvas/);
    expect(banner).toContain('canvas:');
    expect(banner).toContain('#93');
  });

  it('carries the rebuild instruction when the app is the stale part', () => {
    // The most common cause right after an engine change, and the one with a concrete fix.
    expect(synthFallbackBanner(STALE_APP_REASON)).toMatch(/rebuild and reinstall/);
  });

  it('leads with the warning rather than trailing it', () => {
    // Position is the entire point — assert it, or a later refactor can quietly move it to the end
    // and reintroduce exactly the problem this replaced.
    const banner = synthFallbackBanner(NO_SESSION_REASON);
    expect(banner.indexOf('SYNTHETIC INPUT (NOT TRUSTED)')).toBeLessThan(8);
  });
});

describe('tryDeviceCdpInput — routing choice (#32 Phase 1)', () => {
  it('a NON-input method (eval, screenshot) does not route and stays silent — no mechanism to report', async () => {
    const getSession = vi.fn(async () => null);
    const r = await tryDeviceCdpInput('eval', {}, { proxy: aimProxy, getSession });
    expect(r).toEqual({ handled: false, reason: null }); // null reason ⇒ no banner
    expect(getSession).not.toHaveBeenCalled();            // and no session work done for it
  });

  it('an UNROUTED INPUT op (pointer, type-text) still warns — found in the #32 close-out sweep', () => {
    // These were bucketed with `eval` and warned about nothing. Once `tap` began reporting
    // `trusted-cdp` on the same device, silence here became actively misleading: an agent that
    // sees one input op come back trusted has every reason to assume its siblings are too.
    for (const m of ['pointer', 'type-text']) {
      expect(tryDeviceCdpInput(m, {}, { proxy: aimProxy, getSession: async () => null }))
        .resolves.toEqual({ handled: false, reason: NOT_ROUTED_REASON });
    }
  });

  it('CDP unavailable (no session) → fall back, carrying the REASON for the loud banner', async () => {
    const r = await tryDeviceCdpInput('tap', { x: 1, y: 2 }, depsWithSession(null, async () => ({ x: 1, y: 2, label: 'css(1,2)' })));
    expect(r.handled).toBe(false);
    // The reason is the point: a silent fallback is what the loud banner exists to prevent.
    expect(r).toMatchObject({ reason: NO_SESSION_REASON });
  });

  // ── The bug that shipped past every other test in this file ──────────────────
  //
  // The device bridge answers over a TCP/JSON transport, so a handler returning an OBJECT arrives
  // as a JSON **string**. Every routing test below originally mocked `proxy` as returning a plain
  // object, so the trusted path was exercised only against a shape production never produces. In
  // production `'error' in aim` ran the `in` operator on a primitive string → TypeError → the
  // catch → session reset → silent synthetic fallback. Measured on the Samsung: device_status said
  // `trusted-cdp` while every tap returned `[input:synthetic]`. Unit-green, dead on arrival.
  //
  // These three pin the REAL wire shapes. If they pass while the object-shaped tests pass, the
  // decode is total; if someone "simplifies" decodeAimReply back to a cast, these go red.
  it('WIRE SHAPE: a JSON-STRING aim reply (what the transport really returns) still routes trusted', async () => {
    const sender = fakeSender();
    const proxy = async () => JSON.stringify({ x: 10, y: 20, label: 'css(10,20)' }); // ← a string
    const r = await tryDeviceCdpInput('tap', { x: 10, y: 20 }, depsWithSession(sender as unknown as DeviceCdpSession, proxy));
    expect(r.handled && r.reply).toContain(`[input:${TRUSTED_CDP_MECHANISM}]`);
    expect(sender.calls.some((c) => c.method === 'Input.dispatchTouchEvent')).toBe(true);
  });

  it('WIRE SHAPE: an app predating resolve-aim → fall back with the rebuild reason, not a refusal', async () => {
    // The bridge signals a missing handler by RETURNING the string, never by throwing. Synthetic
    // still works against that build, so the honest outcome is a quiet fallback — NOT an error the
    // user sees, and NOT a claim of trusted input.
    const sender = fakeSender();
    const proxy = async () => 'Unknown method: resolve-aim';
    const r = await tryDeviceCdpInput('tap', { x: 1, y: 2 }, depsWithSession(sender as unknown as DeviceCdpSession, proxy));
    expect(r).toEqual({ handled: false, reason: STALE_APP_REASON });
    expect(sender.calls).toEqual([]); // nothing dispatched
  });

  it('WIRE SHAPE: a bare Error string from the page is a refusal, reported verbatim', async () => {
    const sender = fakeSender();
    const proxy = async () => 'Error: selector "#nope" did not resolve';
    const r = await tryDeviceCdpInput('tap', { selector: '#nope' }, depsWithSession(sender as unknown as DeviceCdpSession, proxy));
    expect(r).toEqual({ handled: true, reply: 'Error: selector "#nope" did not resolve' });
    expect(sender.calls).toEqual([]);
  });

  // ── #305: the TRUSTED route must release a held device_pointer press too ──
  // The synthetic path supersedes a hold inside handleTap/handleDrag; this route never reaches
  // them (it resolves the aim in-page, then injects host-side), so it has to ask the bridge.
  // Measured on an S22 before this: after a trusted tap the bridge still said `held:true` while
  // pointerSource had already handed the gesture to the tap via #299's takeover, so the next
  // `down` was refused as "already held" with nothing actually held.
  const aimThen = (releaseReply: unknown): CdpRouteDeps['proxy'] =>
    async (method: string) => (method === 'release-held-pointer'
      ? releaseReply
      : JSON.stringify({ x: 1, y: 2, label: 'css(1,2)' }));

  it('asks the bridge to release a held press BEFORE dispatching the trusted tap', async () => {
    const sender = fakeSender();
    const seen: string[] = [];
    const proxy: CdpRouteDeps['proxy'] = async (method: string) => {
      seen.push(method);
      return method === 'release-held-pointer'
        ? JSON.stringify({ released: 'left at 10.0,20.0 on canvas:hit' })
        : JSON.stringify({ x: 1, y: 2, label: 'css(1,2)' });
    };
    const r = await tryDeviceCdpInput('tap', { x: 1, y: 2 }, depsWithSession(sender as unknown as DeviceCdpSession, proxy));
    // Order is the assertion: released, THEN dispatched.
    expect(seen).toEqual(['resolve-aim', 'release-held-pointer']);
    expect(r.handled && r.reply).toContain('released a pointer left held');
    expect(sender.calls.some((c) => c.method === 'Input.dispatchTouchEvent')).toBe(true);
  });

  it('WIRE SHAPE: the release reply is a JSON STRING, and reading it as an object loses the note', async () => {
    // The trap this whole describe block exists for. A bridge handler returning an object arrives
    // as a JSON string; a cast would read `.released` as undefined, the release would still happen
    // on-device, and the reply would simply never mention it — a quiet wrong answer.
    const sender = fakeSender();
    const r = await tryDeviceCdpInput(
      'tap', { x: 1, y: 2 },
      depsWithSession(sender as unknown as DeviceCdpSession, aimThen(JSON.stringify({ released: 'left at 5.0,6.0 on canvas:hit' }))),
    );
    expect(r.handled && r.reply).toContain('left at 5.0,6.0');
  });

  it('says nothing when nothing was held — no phantom note on an ordinary tap', async () => {
    const sender = fakeSender();
    const r = await tryDeviceCdpInput(
      'tap', { x: 1, y: 2 },
      depsWithSession(sender as unknown as DeviceCdpSession, aimThen(JSON.stringify({ released: null }))),
    );
    expect(r.handled && r.reply).not.toContain('released a pointer left held');
    expect(r.handled && r.reply).toContain(`[input:${TRUSTED_CDP_MECHANISM}]`);
  });

  it('an app too old to know the op still taps — bookkeeping is never worth refusing input over', async () => {
    // A device running an older build is the NORMAL case, not an edge one: the bridge answers an
    // unknown method by returning the string. The gesture must proceed regardless.
    const sender = fakeSender();
    const r = await tryDeviceCdpInput(
      'tap', { x: 1, y: 2 },
      depsWithSession(sender as unknown as DeviceCdpSession, aimThen('Unknown method: release-held-pointer')),
    );
    expect(r.handled && r.reply).toContain(`[input:${TRUSTED_CDP_MECHANISM}]`);
    expect(r.handled && r.reply).not.toContain('released a pointer left held');
    expect(sender.calls.some((c) => c.method === 'Input.dispatchTouchEvent')).toBe(true);
  });

  it('a THROWING release still taps — the same reason, one transport failure over', async () => {
    const sender = fakeSender();
    const proxy: CdpRouteDeps['proxy'] = async (method: string) => {
      if (method === 'release-held-pointer') throw new Error('socket hiccup');
      return JSON.stringify({ x: 1, y: 2, label: 'css(1,2)' });
    };
    const r = await tryDeviceCdpInput('tap', { x: 1, y: 2 }, depsWithSession(sender as unknown as DeviceCdpSession, proxy));
    expect(r.handled && r.reply).toContain(`[input:${TRUSTED_CDP_MECHANISM}]`);
    expect(sender.calls.some((c) => c.method === 'Input.dispatchTouchEvent')).toBe(true);
  });

  it('a REFUSED aim releases nothing — a call that dispatches nothing must steal nothing', async () => {
    const sender = fakeSender();
    const seen: string[] = [];
    const proxy: CdpRouteDeps['proxy'] = async (method: string) => {
      seen.push(method);
      return 'Error: selector "#nope" did not resolve';
    };
    const r = await tryDeviceCdpInput('tap', { selector: '#nope' }, depsWithSession(sender as unknown as DeviceCdpSession, proxy));
    expect(r).toEqual({ handled: true, reply: 'Error: selector "#nope" did not resolve' });
    expect(seen).toEqual(['resolve-aim']); // the release was never asked for
  });

  it('a mid-gesture CDP failure REFUSES rather than falling back — a stuck finger must not be double-tapped', async () => {
    // cdpTap = touchStart → hold → touchEnd. A failure between them leaves a finger DOWN; falling
    // back to synthetic would then deliver a second complete gesture on top of it.
    const sender = fakeSender();
    let n = 0;
    // touchStart lands, then the socket dies before touchEnd — the stuck-finger case.
    sender.send = async () => { if (++n > 1) throw new Error('socket closed'); return {}; };
    const proxy = async () => JSON.stringify({ x: 5, y: 5, label: 'css(5,5)' });
    const r = await tryDeviceCdpInput('tap', { x: 5, y: 5 }, depsWithSession(sender as unknown as DeviceCdpSession, proxy));
    expect(r.handled).toBe(true); // a refusal, NOT a fallback — must not be retried synthetically
    expect(r.handled && r.reply).toMatch(/^Error: trusted CDP input failed mid-dispatch/);
    expect(r.handled && r.reply).toMatch(/touch still down/);
    expect(r.handled && r.reply).not.toContain(`[input:${TRUSTED_CDP_MECHANISM}]`);
  });

  it('CDP available → dispatches and reports [input:trusted-cdp]', async () => {
    const sender = fakeSender();
    const fakeSession = sender as unknown as DeviceCdpSession;
    const proxy = vi.fn(async (method: string) => {
      expect(method).toBe('resolve-aim'); // the page op, not a dispatch
      return { x: 10, y: 20, label: 'css(10,20)' };
    });
    const r = await tryDeviceCdpInput('tap', { x: 10, y: 20 }, depsWithSession(fakeSession, proxy));
    expect(r.handled && r.reply).toMatch(/^ok /);
    expect(r.handled && r.reply).toContain(`[input:${TRUSTED_CDP_MECHANISM}]`);
    expect(sender.calls.some((c) => c.method === 'Input.dispatchTouchEvent')).toBe(true);
  });

  it('an aim-resolution failure (bad selector) is handled as an Error — no false success, and no pointless synthetic retry', async () => {
    const sender = fakeSender();
    const fakeSession = sender as unknown as DeviceCdpSession;
    const proxy = async () => ({ error: 'Error: selector "#missing" did not resolve' });
    const r = await tryDeviceCdpInput('tap', { selector: '#missing' }, depsWithSession(fakeSession, proxy));
    expect(r).toEqual({ handled: true, reply: 'Error: selector "#missing" did not resolve' });
    // Nothing was dispatched — a refusal never claims a mechanism.
    expect(sender.calls).toEqual([]);
  });

  it('a CDP failure BEFORE anything landed → fall back (never a fabricated success)', async () => {
    const throwingSession = { send: async () => { throw new Error('socket closed'); } } as unknown as DeviceCdpSession;
    const proxy = async () => ({ x: 1, y: 2, label: 'css(1,2)' });
    const r = await tryDeviceCdpInput('tap', { x: 1, y: 2 }, depsWithSession(throwingSession, proxy));
    expect(r.handled).toBe(false); // nothing landed ⇒ a banner-carrying fallback is safe
  });

  it('press-key needs no aim resolution at all (proxy is never called)', async () => {
    const sender = fakeSender();
    const fakeSession = sender as unknown as DeviceCdpSession;
    const proxy = vi.fn(async () => ({ x: 0, y: 0, label: '' }));
    const r = await tryDeviceCdpInput('press-key', { key: 'Escape' }, depsWithSession(fakeSession, proxy));
    expect(r.handled && r.reply).toContain(`[input:${TRUSTED_CDP_MECHANISM}]`);
    expect(proxy).not.toHaveBeenCalled();
  });

  it('press-key with no key is refused', async () => {
    const sender = fakeSender();
    const fakeSession = sender as unknown as DeviceCdpSession;
    const r = await tryDeviceCdpInput('press-key', {}, depsWithSession(fakeSession, async () => ({ x: 0, y: 0, label: '' })));
    expect(r.handled && r.reply).toMatch(/^Error:/);
  });
});

describe('isDeviceCdpAvailable — the device_status probe', () => {
  it('true when a session resolves', async () => {
    const fakeSession = fakeSender() as unknown as DeviceCdpSession;
    expect(await isDeviceCdpAvailable({ getSession: async () => fakeSession })).toBe(true);
  });
  it('false when no session is available (refusal carries no mechanism)', async () => {
    expect(await isDeviceCdpAvailable({ getSession: async () => null })).toBe(false);
  });
});

/** Found sweeping for siblings of #99's unbounded WebDriverAgent probe. Every other I/O boundary in
 *  deviceCdp.ts is deliberately capped — three `execFileSync` at 4s, the WebSocket connect on a
 *  timer, `send()` on the pending-map timer — and discovery's two HTTP GETs were not. The 127.0.0.1
 *  address makes them look safe and does not make them safe: an `adb forward` LISTENS whether or
 *  not anything is behind it, so with WiFi-adb or a sleeping device the socket accepts and then
 *  never answers. Discovery is on the input path via `getDeviceCdpSession`, so an unbounded wait
 *  there hangs `device_tap` outright rather than merely making it slow. */
describe('discoverDeviceCdpTarget — discovery I/O is bounded (#99 sweep)', () => {
  it('passes an AbortSignal to every discovery GET, and a hanging endpoint yields null not a hang', async () => {
    const sockets = vi.spyOn(deviceCdpAdb, 'listUnixSockets')
      .mockReturnValue('0000 0002 0001 @webview_devtools_remote_1234\n');
    const forward = vi.spyOn(deviceCdpAdb, 'forward').mockImplementation(() => {});
    const inits: (RequestInit | undefined)[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_u: string, init?: RequestInit) => {
      inits.push(init);
      throw new Error('aborted');   // what a bounded wait on a dead forward looks like
    }) as unknown as typeof fetch;
    try {
      // Must RESOLVE (to null) rather than reject: discovery's contract is "null = no trusted
      // route", which is the fallback-to-synthetic signal, not an error to surface.
      expect(await discoverDeviceCdpTarget({ localPort: 9333 })).toBeNull();
    } finally {
      globalThis.fetch = realFetch;
      sockets.mockRestore();
      forward.mockRestore();
    }
    // Asserting the SIGNAL is passed, not merely that the call failed: a regression that drops the
    // timeout still fails this way against a dead endpoint, and would pass a result-only check.
    expect(inits).toHaveLength(1);
    expect(inits[0]?.signal).toBeInstanceOf(AbortSignal);
  });
});

/** #160 — the CDP tunnel's LIFETIME. `deviceCdpAdb.removeForward` had exactly one definition and
 *  zero call sites, so nothing ever removed the `adb forward` discovery creates: rules outlived the
 *  editor, survived unplugging the phone, and pointed at dead webview pids.
 *
 *  These tests assert the two ends of the lifetime — that a REJECTED candidate takes its rule with
 *  it, and that teardown removes the one that was kept, with the SERIAL it was created with (which
 *  `removeForward`'s #158 ownership check needs and which is gone from scope by teardown time).
 *  They stub the adb seam, so they are necessary and NOT sufficient: what proves the fix is the
 *  live check in the issue — `adb forward --list` after a real disconnect. The seam being stubbed
 *  everywhere is precisely how the dead function went unnoticed. */
describe('CDP forward lifecycle — the tunnel is torn down (#160)', () => {
  /** Discovery over one socket, with `fetch` faked to whatever the probe should see. */
  function stubDiscovery(opts: { sockets: string; version?: unknown; list?: unknown; fail?: boolean }) {
    const sockets = vi.spyOn(deviceCdpAdb, 'listUnixSockets').mockReturnValue(opts.sockets);
    const forward = vi.spyOn(deviceCdpAdb, 'forward').mockImplementation(() => {});
    const remove = vi.spyOn(deviceCdpAdb, 'removeForward').mockImplementation(() => {});
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (u: string) => {
      if (opts.fail) throw new Error('dead endpoint');
      const body = String(u).endsWith('/json/version') ? opts.version : opts.list;
      return { ok: true, json: async () => body } as unknown as Response;
    }) as unknown as typeof fetch;
    return {
      forward, remove,
      restore() { globalThis.fetch = realFetch; sockets.mockRestore(); forward.mockRestore(); remove.mockRestore(); },
    };
  }

  const PAGE = [{ type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:9335/devtools/page/1' }];

  it('a candidate that fails its probe does not leave its rule behind', async () => {
    const s = stubDiscovery({ sockets: '0000 0002 0001 @webview_devtools_remote_1234\n', fail: true });
    try {
      expect(await discoverDeviceCdpTarget({ localPort: 9335, serial: 'RFDEADBEEF1' })).toBeNull();
      // The bug: `forward` ran, discovery declined the candidate, and the rule survived the call.
      expect(s.forward).toHaveBeenCalledTimes(1);
      expect(s.remove).toHaveBeenCalledWith(9335, 'RFDEADBEEF1');
    } finally { s.restore(); resetDeviceCdpSession(); }
  });

  it('a candidate rejected on PACKAGE (not an error) is cleaned up too — the `continue` path', async () => {
    const s = stubDiscovery({
      sockets: '0000 0002 0001 @webview_devtools_remote_1234\n',
      version: { 'Android-Package': 'com.other.app' }, list: PAGE,
    });
    try {
      expect(await discoverDeviceCdpTarget({ localPort: 9335, preferPackage: 'com.modokiengine.sling', serial: 'RFDEADBEEF1' })).toBeNull();
      expect(s.remove).toHaveBeenCalledWith(9335, 'RFDEADBEEF1');
    } finally { s.restore(); resetDeviceCdpSession(); }
  });

  it('the WINNING candidate keeps its rule — that tunnel IS the session\'s route', async () => {
    const s = stubDiscovery({
      sockets: '0000 0002 0001 @webview_devtools_remote_1234\n',
      version: { 'Android-Package': 'com.modokiengine.sling' }, list: PAGE,
    });
    try {
      const target = await discoverDeviceCdpTarget({ localPort: 9335, serial: 'RFDEADBEEF1' });
      expect(target?.androidPackage).toBe('com.modokiengine.sling');
      expect(s.remove).not.toHaveBeenCalled();
    } finally { s.restore(); resetDeviceCdpSession(); }
  });

  it('teardown removes the kept rule, with the port AND serial it was forwarded with', async () => {
    const s = stubDiscovery({
      sockets: '0000 0002 0001 @webview_devtools_remote_1234\n',
      version: { 'Android-Package': 'com.modokiengine.sling' }, list: PAGE,
    });
    try {
      await discoverDeviceCdpTarget({ localPort: 9335, serial: 'RFDEADBEEF1' });
      resetDeviceCdpSession();
      expect(s.remove).toHaveBeenCalledWith(9335, 'RFDEADBEEF1');
      // Latch cleared: a second teardown must not re-issue a removal for a rule already gone —
      // with a sibling clone's rule potentially now on that port, that is the #158 hazard.
      s.remove.mockClear();
      resetDeviceCdpSession();
      expect(s.remove).not.toHaveBeenCalled();
    } finally { s.restore(); }
  });

  it('teardown never throws when adb cannot remove the rule — a leak must not fail the cleanup', async () => {
    const s = stubDiscovery({
      sockets: '0000 0002 0001 @webview_devtools_remote_1234\n',
      version: { 'Android-Package': 'com.modokiengine.sling' }, list: PAGE,
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await discoverDeviceCdpTarget({ localPort: 9335, serial: 'RFDEADBEEF1' });
      s.remove.mockImplementation(() => { throw new Error('adb: device not found'); });
      expect(() => resetDeviceCdpSession()).not.toThrow();
      expect(warn).toHaveBeenCalled();
    } finally { warn.mockRestore(); s.restore(); }
  });
});

/** #497: the trusted routes report an aim that was resolved by a round trip TO THE DEVICE and is
 *  never re-checked before the input lands, so the reply must not read as a verified hit. The owner
 *  chose to reword rather than buy a second round-trip on every input — which makes the WORDING the
 *  entire fix, and therefore the thing worth pinning.
 *
 *  ⚠️ The contrast is the point, not the sentence. The SYNTHETIC path (`app/debug/bridge.ts`) does
 *  re-check in-page (#486 finding C) and says so with its own drift warning when the aim moved —
 *  there, silence MEANS verified. Copying this caveat onto that surface, or deleting it from this
 *  one, collapses a real distinction into noise; `deviceInputMechanism.test.ts` pins the other half
 *  (`ok (hover div) @ css(5,5)` — no caveat). */
describe('aimAsResolved — the trusted reply does not claim a verified hit (#497)', () => {
  it('names the aim as RESOLVED, and says it was not re-checked', () => {
    const out = aimAsResolved('#play→button#play');
    expect(out).toContain('#play→button#play');       // the aim is still reported
    expect(out).toMatch(/as resolved/);               // …as what it is
    expect(out).toMatch(/not re-checked/);            // …and explicitly not verified at dispatch
  });

  it('wraps rather than replaces, so the label stays greppable', () => {
    expect(aimAsResolved('x').startsWith('x')).toBe(true);
  });
});
