/** #32 Phase 1 — unit coverage for `engine/plugins/backend/deviceCdp.ts`.
 *
 *  No adb, no real device, no real WebSocket: the port derivation is pure, the parser is pure
 *  over a text fixture, and the routing/dispatch tests inject a fake `getSession`/`CdpSender` so
 *  `tryDeviceCdpInput` never opens a real socket. Hardware verification (the Samsung actually
 *  receiving a trusted touch) is out of scope for this file — see the plan doc. */

import { decodeDeviceRefusal, isDeviceFailureText } from '../../tools/shared/deviceRefusal';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { found } from '@modoki/engine/testing/inOrder';

/** NO TEST MAY REACH REAL adb (#1530 close-out). `deviceCdpAdb` refuses every real call under vitest
 *  and records it; this file fails any test that tripped the refusal, so a test that restores its
 *  spies before resetting — or never stubs the seam — is red here rather than silently swallowed by
 *  discovery's own catch. Why the seam refuses at all: `refuseRealAdbUnderTest` in deviceCdp.ts. */
afterEach(() => {
  expect(_drainRefusedAdbForTests(), 'a test reached real adb through deviceCdp').toEqual([]);
});
import { aimAsResolved } from '../../plugins/backend/deviceAim';
import {
  NO_SESSION_REASON,
  NOT_ROUTED_REASON,
  STALE_APP_REASON,
  synthFallbackBanner,
  resolveDeviceCdpPort, DEFAULT_DEVICE_CDP_PORT, parseWebviewSockets, isCdpRoutableMethod,
  tryDeviceCdpInput, cdpTap, cdpDrag, cdpPressKey, cdpHover, cdpScroll, isDeviceCdpAvailable,
  TRUSTED_CDP_MECHANISM, discoverDeviceCdpTarget, deviceCdpAdb, resetDeviceCdpSession,
  deviceCdpPageProbe, isAppPage, ambiguousPageReason, getDeviceCdpSession, CDP_DISCOVERY_TIMEOUT_MS,
  _drainRefusedAdbForTests,
  type PageVerdict,
  type CdpSender, type CdpRouteDeps, type DeviceCdpSession,
} from '../../plugins/backend/deviceCdp';

describe('deviceCdpAdb refuses REAL adb under vitest (#1530 close-out)', () => {
  it('every method throws BEFORE reaching adb, and the refusal is recorded for the file guards', () => {
    expect(() => deviceCdpAdb.listUnixSockets('RFDEADBEEF1')).toThrow(/real adb \(shell cat \/proc\/net\/unix\) refused under vitest/);
    expect(() => deviceCdpAdb.forward(9333, 'webview_devtools_remote_1', 'RFDEADBEEF1')).toThrow(/refused under vitest/);
    expect(() => deviceCdpAdb.listForwards()).toThrow(/refused under vitest/);
    // The dangerous one: with no serial the #158 owner check is skipped, so this is the call that
    // deleted a sibling clone's tunnel. It must refuse before listForwards or execFileSync run.
    expect(() => deviceCdpAdb.removeForward(9333)).toThrow(/real adb \(forward --remove tcp:9333\) refused/);
    // Drained here, so the file-wide afterEach sees a clean slate — this test tripped it on purpose.
    expect(_drainRefusedAdbForTests()).toEqual(['shell cat /proc/net/unix', 'forward tcp:9333', 'forward --list', 'forward --remove tcp:9333']);
  });
});

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
  /** #1223 P3 review: the device MCP finds a refusal UNDER this banner by reading the line after it,
   *  so the banner must be ONE line. A WDA reason can carry a newline (`withLaunchWarning`), and a
   *  refused synthetic tap under it was reported as a success. Built from the real banner and the
   *  router's own `${banner}\n${reply}` join, not a hand-written stand-in. */
  it('stays one line when the reason has a newline, so a refusal under it is still a failure', () => {
    const banner = synthFallbackBanner('WebDriverAgent has been starting for 12s\n⚠️ could not confirm which phone it launched on');
    expect(banner).not.toContain('\n');
    expect(isDeviceFailureText(`${banner}\nError: tap: no LIVE entity`)).toBe(true);
    expect(isDeviceFailureText(`${banner}\nok (tap) @ css(1,2)`)).toBe(false);
  });

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
    expect(found(banner.indexOf('SYNTHETIC INPUT (NOT TRUSTED)'), 'the SYNTHETIC INPUT warning')).toBeLessThan(8);
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

  /** #1223 P3: an entity aim's refusal names its code, options and `stale`. The page answers
   *  `resolve-aim` with an OBJECT, and this decode used to keep only `error` — so the trusted route,
   *  the one every Android and WDA tap takes, dropped exactly the fields the synthetic path carried. */
  it('WIRE SHAPE: an object refusal keeps code/options/stale in the reply tail', async () => {
    const sender = fakeSender();
    const proxy = async () => JSON.stringify({ error: 'Error: entity: 2 LIVE entities are named "Enemy"', code: 'AMBIGUOUS', options: ['g-a', 'g-b'], stale: 'despawned' });
    const r = await tryDeviceCdpInput('tap', { entity: { name: 'Enemy' } }, depsWithSession(sender as unknown as DeviceCdpSession, proxy));
    expect(r.handled).toBe(true);
    const reply = (r as { reply: string }).reply;
    expect(reply.startsWith('Error: entity: 2 LIVE')).toBe(true);
    expect(decodeDeviceRefusal(reply)).toMatchObject({ code: 'AMBIGUOUS', options: ['g-a', 'g-b'], stale: 'despawned' });
    expect(sender.calls).toEqual([]);
  });

  it('WIRE SHAPE: an object refusal with a code outside the closed set carries no code', async () => {
    const sender = fakeSender();
    const proxy = async () => JSON.stringify({ error: 'Error: tap: nope', code: 'BOGUS', stale: 'despawned' });
    const r = await tryDeviceCdpInput('tap', { entity: { name: 'X' } }, depsWithSession(sender as unknown as DeviceCdpSession, proxy));
    const reply = (r as { reply: string }).reply;
    // On the RAW wire: the MCP's decoder drops an unknown code by itself, so decoding here could not
    // tell whether THIS hop let it through to an older reader that trusts the tail.
    expect(reply).not.toContain('BOGUS');
    expect(decodeDeviceRefusal(reply)).toEqual({ message: 'Error: tap: nope', stale: 'despawned' });
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
    const remove = vi.spyOn(deviceCdpAdb, 'removeForward').mockImplementation(() => {});
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
      remove.mockRestore();
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
    } finally { resetDeviceCdpSession(); s.restore(); }
  });

  it('a candidate rejected on PACKAGE (not an error) is cleaned up too — the `continue` path', async () => {
    const s = stubDiscovery({
      sockets: '0000 0002 0001 @webview_devtools_remote_1234\n',
      version: { 'Android-Package': 'com.other.app' }, list: PAGE,
    });
    try {
      expect(await discoverDeviceCdpTarget({ localPort: 9335, preferPackage: 'com.modokiengine.sling', serial: 'RFDEADBEEF1' })).toBeNull();
      expect(s.remove).toHaveBeenCalledWith(9335, 'RFDEADBEEF1');
    } finally { resetDeviceCdpSession(); s.restore(); }
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
    } finally { resetDeviceCdpSession(); s.restore(); }
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

/** #1530 — ONE devtools socket is ONE PROCESS, not one page.
 *
 *  Every WebView in an Android app's process shares `webview_devtools_remote_<pid>`, so once Court
 *  embedded AppLovin MAX its socket listed the game AND the SDK's WebViews. Measured on the A23, the
 *  ad's `about:blank` came FIRST — with an interstitial up and again after a cold relaunch. Discovery
 *  took the first `page`, the aim was still resolved in the game through the bridge, and on the S22 a
 *  `device_tap` came back `ok … [input:trusted-cdp]` while the game never saw the touch. These tests
 *  put the ad page FIRST, which is the ordering that fails, and stub the per-page probe so the CHOICE
 *  is what is under test; the probe itself is covered over a fake WebSocket further down. */
describe('discovery picks the APP page, not the first page (#1530)', () => {
  const AD = { type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws://127.0.0.1:9335/devtools/page/AD' };
  const GAME = { type: 'page', url: 'http://localhost/', webSocketDebuggerUrl: 'ws://127.0.0.1:9335/devtools/page/GAME' };
  const WORKER = { type: 'worker', webSocketDebuggerUrl: 'ws://127.0.0.1:9335/devtools/page/W' };

  function stub(list: unknown[], verdicts: Record<string, PageVerdict>) {
    const sockets = vi.spyOn(deviceCdpAdb, 'listUnixSockets').mockReturnValue('0000 0002 0001 @webview_devtools_remote_1234\n');
    const forward = vi.spyOn(deviceCdpAdb, 'forward').mockImplementation(() => {});
    const remove = vi.spyOn(deviceCdpAdb, 'removeForward').mockImplementation(() => {});
    const probe = vi.spyOn(deviceCdpPageProbe, 'verdict').mockImplementation(async (u: string) => verdicts[u] ?? 'other');
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (u: string) => {
      const body = String(u).endsWith('/json/version') ? { 'Android-Package': 'com.apiary.court' } : list;
      return { ok: true, json: async () => body } as unknown as Response;
    }) as unknown as typeof fetch;
    return {
      probe,
      restore() { resetDeviceCdpSession(); globalThis.fetch = realFetch; sockets.mockRestore(); forward.mockRestore(); remove.mockRestore(); probe.mockRestore(); },
    };
  }
  const discover = () => discoverDeviceCdpTarget({ localPort: 9335, preferPackage: 'com.apiary.court' });

  it('an ad page listed FIRST is skipped — the touch goes to the page the aim was resolved in', async () => {
    const s = stub([AD, WORKER, GAME], { [GAME.webSocketDebuggerUrl]: 'app' });
    try {
      expect((await discover())?.webSocketDebuggerUrl).toBe(GAME.webSocketDebuggerUrl);
      // Only PAGES are probed — a worker is never a dispatch target, and probing it costs a connect.
      expect(s.probe.mock.calls.map(([u]) => u)).toEqual([AD.webSocketDebuggerUrl, GAME.webSocketDebuggerUrl]);
    } finally { s.restore(); }
  });

  it('a single page is taken WITHOUT a probe — no extra round trip for an app with no embedded WebView', async () => {
    const s = stub([GAME, WORKER], {});   // a probe would answer "other" — so a probe would lose the page
    try {
      expect((await discover())?.webSocketDebuggerUrl).toBe(GAME.webSocketDebuggerUrl);
      expect(s.probe).not.toHaveBeenCalled();
    } finally { s.restore(); }
  });

  it('several pages and NO app page → refuse, not the first page', async () => {
    const s = stub([AD, GAME], {});
    try { expect(await discover()).toBeNull(); } finally { s.restore(); }
  });

  it('two app pages → refuse — two candidates is a guess, whichever comes first', async () => {
    const s = stub([AD, GAME], { [AD.webSocketDebuggerUrl]: 'app', [GAME.webSocketDebuggerUrl]: 'app' });
    try { expect(await discover()).toBeNull(); } finally { s.restore(); }
  });

  it('probes every page AT ONCE — the input path pays one probe budget, not one per WebView', async () => {
    const s = stub([AD, GAME, { ...AD, webSocketDebuggerUrl: 'ws://127.0.0.1:9335/devtools/page/IDLE' }], {});
    const release: (() => void)[] = [];
    s.probe.mockImplementation((u: string) => new Promise<PageVerdict>((r) => release.push(() => r(u === GAME.webSocketDebuggerUrl ? 'app' : 'other'))));
    try {
      const pending = discover();
      // Let discovery reach the probes. None has answered yet, so a SEQUENTIAL loop is still parked
      // on the first and has asked exactly one page.
      await vi.waitFor(() => expect(release.length).toBeGreaterThan(0));
      await new Promise((r) => setTimeout(r, 0));
      expect(s.probe).toHaveBeenCalledTimes(3);
      release.forEach((go) => go());
      expect((await pending)?.webSocketDebuggerUrl).toBe(GAME.webSocketDebuggerUrl);
    } finally { s.restore(); }
  });

  it('the refusal reaches the fallback banner as ITS OWN reason, not "the socket is unreachable"', async () => {
    const s = stub([AD, GAME], {});
    const proxy = vi.fn();
    try {
      // The REAL getter (no `getSession` injected), so discovery runs over the stubs above.
      const r = await tryDeviceCdpInput('tap', { x: 1, y: 1 }, { proxy, preferPackage: 'com.apiary.court' });
      expect(r).toEqual({ handled: false, reason: ambiguousPageReason(['other', 'other']) });
      expect(proxy).not.toHaveBeenCalled();   // nothing resolved, nothing dispatched
    } finally { s.restore(); }
  });

  it('an INJECTED getter never inherits a refusal left by an earlier real discovery', async () => {
    const s = stub([AD, GAME], {});
    try {
      await discover();   // leaves the refusal set
      // The router's non-Android gate: `getSession: async () => null`. That phone has no such pages.
      const r = await tryDeviceCdpInput('tap', { x: 1, y: 1 }, { proxy: vi.fn(), getSession: async () => null });
      expect(r).toEqual({ handled: false, reason: NO_SESSION_REASON });
    } finally { s.restore(); }
  });
});

describe('ambiguousPageReason — says which ambiguity it was (#1530)', () => {
  it('a page that gave NO VERDICT is not called "not the app page" — nor claimed to have timed out', () => {
    const r = ambiguousPageReason(['other', 'no-answer']);
    expect(r).toMatch(/1 gave no verdict — timed out, refused the connection, or answered with a CDP error/);
    expect(r).toMatch(/not necessarily a foreign one/);
    expect(r).not.toMatch(/within \d+ ?ms/);   // a 1 ms CDP error is not a timeout
  });
  it('every page answering "other" names none, and adds no silence clause', () => {
    const r = ambiguousPageReason(['other', 'other']);
    expect(r).toMatch(/none of them answered as the Capacitor app page/);
    expect(r).not.toMatch(/gave no verdict/);
  });
  it('two app pages say so', () => {
    expect(ambiguousPageReason(['app', 'app'])).toMatch(/2 of them answered as the Capacitor app page/);
  });
  it('stays one line — the fallback banner is one line whatever the reason says', () => {
    expect(ambiguousPageReason(['app', 'no-answer', 'other'])).not.toMatch(/\n/);
  });
});

describe('isAppPage — the per-page answer (#1530)', () => {
  const sender = (reply: unknown) => {
    const calls: [string, Record<string, unknown> | undefined][] = [];
    return { calls, send: async (m: string, p?: Record<string, unknown>) => { calls.push([m, p]); return reply; } };
  };

  it('true only for a boolean true — the Capacitor bridge is present', async () => {
    const s = sender({ result: { type: 'boolean', value: true } });
    expect(await isAppPage(s)).toBe(true);
    expect(s.calls[0][0]).toBe('Runtime.evaluate');
    expect(s.calls[0][1]).toMatchObject({ returnByValue: true });
    expect(String(s.calls[0][1]?.expression)).toContain('Capacitor');
  });

  it('false for an ad WebView (no Capacitor), an exception, or a reply it cannot read', async () => {
    expect(await isAppPage(sender({ result: { type: 'boolean', value: false } }))).toBe(false);
    expect(await isAppPage(sender({ result: { value: true }, exceptionDetails: { text: 'Uncaught' } }))).toBe(false);
    expect(await isAppPage(sender({ result: { type: 'string', value: 'true' } }))).toBe(false);
    expect(await isAppPage(sender(undefined))).toBe(false);
  });
});

/** A stand-in for Node's global `WebSocket`, just wide enough for `DeviceCdpSession`. It opens once
 *  `openGate` settles (immediately by default; a never-settling gate is a connect that hangs, which is
 *  what a sleeping device behind an `adb forward` looks like), and answers each CDP request by
 *  `reply(method)` — `undefined` means never answer, a stalled page. Every instance is kept so a test
 *  can ask whether it was closed. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static reply: (method: string) => unknown = () => undefined;
  static failConnect = false;
  static openGate: Promise<void> = Promise.resolve();
  static reset(reply: (method: string) => unknown = () => undefined, failConnect = false) {
    FakeWebSocket.instances = []; FakeWebSocket.reply = reply; FakeWebSocket.failConnect = failConnect;
    FakeWebSocket.openGate = Promise.resolve();
  }
  closed = false;
  private listeners: Record<string, ((ev: unknown) => void)[]> = {};
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
    void FakeWebSocket.openGate.then(() => { if (!this.closed) this.emit(FakeWebSocket.failConnect ? 'error' : 'open', {}); });
  }
  addEventListener(type: string, cb: (ev: unknown) => void) { (this.listeners[type] ??= []).push(cb); }
  send(data: string) {
    const { id, method } = JSON.parse(data) as { id: number; method: string };
    const result = FakeWebSocket.reply(method);
    if (result !== undefined) queueMicrotask(() => this.emit('message', { data: JSON.stringify({ id, result }) }));
  }
  close() { if (!this.closed) { this.closed = true; this.emit('close', {}); } }
  private emit(type: string, ev: unknown) { for (const cb of this.listeners[type] ?? []) cb(ev); }
}

describe('deviceCdpPageProbe.verdict — the REAL probe, over a fake WebSocket (#1530 review)', () => {
  const URL_ = 'ws://127.0.0.1:9335/devtools/page/X';
  const setup = (reply: (m: string) => unknown, failConnect = false) => {
    FakeWebSocket.reset(reply, failConnect);
    vi.stubGlobal('WebSocket', FakeWebSocket);
  };
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); FakeWebSocket.reset(); });

  /** Advance fake time just past the discovery budget and report what the probe settled to by then
   *  — null when it had not, which is what an 8s default in place of the 4s budget looks like. */
  async function settledWithinBudget(): Promise<PageVerdict | null> {
    let settled: PageVerdict | null = null;
    void deviceCdpPageProbe.verdict(URL_).then((v) => { settled = v; });
    await vi.advanceTimersByTimeAsync(CDP_DISCOVERY_TIMEOUT_MS + 1);
    return settled;
  }

  it('the app page answers app, and the probe closes its socket', async () => {
    setup(() => ({ result: { type: 'boolean', value: true } }));
    expect(await deviceCdpPageProbe.verdict(URL_)).toBe('app');
    expect(FakeWebSocket.instances.map((w) => w.closed)).toEqual([true]);
  });

  it('an ad page answers other, and the probe still closes its socket', async () => {
    setup(() => ({ result: { type: 'boolean', value: false } }));
    expect(await deviceCdpPageProbe.verdict(URL_)).toBe('other');
    expect(FakeWebSocket.instances.map((w) => w.closed)).toEqual([true]);
  });

  it('a page that never ANSWERS is no-answer within the discovery budget, not the 8s request default', async () => {
    vi.useFakeTimers();
    setup(() => undefined);
    expect(await settledWithinBudget()).toBe('no-answer');
    expect(FakeWebSocket.instances.map((w) => w.closed)).toEqual([true]);
  });

  it('a CONNECT that never opens is no-answer within the discovery budget too', async () => {
    vi.useFakeTimers();
    setup(() => ({ result: { type: 'boolean', value: true } }));
    FakeWebSocket.openGate = new Promise<void>(() => {});   // a forward that accepts and never answers
    expect(await settledWithinBudget()).toBe('no-answer');
    expect(FakeWebSocket.instances.map((w) => w.closed)).toEqual([true]);
  });

  it('a page that refuses the connection is no-answer, never a throw', async () => {
    setup(() => undefined, true);
    expect(await deviceCdpPageProbe.verdict(URL_)).toBe('no-answer');
  });
});

/** The #1530 review's race: a reset cannot cancel a discovery already running, so one that started
 *  before the lease let go used to finish after it and CACHE a session for a lease nobody holds.
 *  The probes widened that window from two HTTP calls to a probe budget. A stale run is checked at
 *  three points — queued behind another, before its connect, after its connect — and each test
 *  below invalidates it at exactly one of them. */
describe('a reset during discovery keeps nothing (#1530 review)', () => {
  const PKG = { preferPackage: 'com.apiary.court' };
  let fetchGate: Promise<void>;
  let openFetch: () => void;
  let adb: { sockets: ReturnType<typeof vi.spyOn>; forward: ReturnType<typeof vi.spyOn>; remove: ReturnType<typeof vi.spyOn> };

  beforeEach(() => {
    FakeWebSocket.reset();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    adb = {
      sockets: vi.spyOn(deviceCdpAdb, 'listUnixSockets').mockReturnValue('0000 0002 0001 @webview_devtools_remote_1234\n'),
      forward: vi.spyOn(deviceCdpAdb, 'forward').mockImplementation(() => {}),
      remove: vi.spyOn(deviceCdpAdb, 'removeForward').mockImplementation(() => {}),
    };
    fetchGate = new Promise<void>((r) => { openFetch = r; });
    vi.stubGlobal('fetch', async (u: string) => {
      await fetchGate;   // hold discovery mid-flight until the test has done its reset
      const body = String(u).endsWith('/json/version') ? { 'Android-Package': 'com.apiary.court' }
        : [{ type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:9335/devtools/page/GAME' }];
      return { ok: true, json: async () => body } as unknown as Response;
    });
  });
  afterEach(() => {
    resetDeviceCdpSession();   // while the adb spies are still in place — see the file-top guard
    adb.sockets.mockRestore(); adb.forward.mockRestore(); adb.remove.mockRestore();
    vi.unstubAllGlobals(); FakeWebSocket.reset();
  });

  it('reset MID-DISCOVERY: the stale run connects nothing, caches nothing, gives its forward back — and the next run waits for it', async () => {
    const stale = getDeviceCdpSession(PKG);
    await vi.waitFor(() => expect(adb.forward).toHaveBeenCalledTimes(1));
    resetDeviceCdpSession();   // the lease lets go while discovery is still running
    // The next call starts a new discovery — but it must WAIT: both forward on this clone's one
    // port, so running alongside the stale one would overwrite its rule mid-probe.
    const fresh = getDeviceCdpSession(PKG);
    await new Promise((r) => setTimeout(r, 0));
    expect(adb.forward).toHaveBeenCalledTimes(1);
    openFetch();
    expect(await stale).toBeNull();
    expect(adb.remove).toHaveBeenCalled();
    // The stale run finishing must not clear the NEWER in-flight discovery: a caller arriving now
    // joins it rather than starting a third.
    const joined = getDeviceCdpSession(PKG);
    const session = await fresh;
    expect(session).not.toBeNull();
    expect(await joined).toBe(session);
    expect(adb.sockets).toHaveBeenCalledTimes(2);
    // Only the live run ever opened a session socket.
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('reset while QUEUED: a run already stale when its turn comes does no adb and opens nothing', async () => {
    const a = getDeviceCdpSession(PKG);   // in flight, held at the fetch gate
    await vi.waitFor(() => expect(adb.forward).toHaveBeenCalledTimes(1));
    resetDeviceCdpSession();
    const b = getDeviceCdpSession(PKG);   // queued behind a…
    resetDeviceCdpSession();              // …and stale before it ever starts
    const c = getDeviceCdpSession(PKG);   // the live lease's call, queued behind both
    openFetch();
    expect(await a).toBeNull();
    expect(await b).toBeNull();
    expect(await c).not.toBeNull();
    // a and c discovered; b did not — the live caller did not pay for a lease that had let go.
    expect(adb.sockets).toHaveBeenCalledTimes(2);
    expect(adb.forward).toHaveBeenCalledTimes(2);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('a run skipped while QUEUED does not hand its caller the stale run\'s refusal', async () => {
    // Two pages that both give no verdict: the stale run ahead will REFUSE, and set the refusal.
    vi.stubGlobal('fetch', async (u: string) => {
      await fetchGate;
      const body = String(u).endsWith('/json/version') ? { 'Android-Package': 'com.apiary.court' }
        : [{ type: 'page', webSocketDebuggerUrl: 'ws://x/AD' }, { type: 'page', webSocketDebuggerUrl: 'ws://x/GAME' }];
      return { ok: true, json: async () => body } as unknown as Response;
    });
    const probe = vi.spyOn(deviceCdpPageProbe, 'verdict').mockResolvedValue('no-answer');
    try {
      const a = getDeviceCdpSession(PKG);   // the OLD lease's run, held mid-discovery
      await vi.waitFor(() => expect(adb.forward).toHaveBeenCalledTimes(1));
      resetDeviceCdpSession();
      // A new lease's tap queues behind it (real getter: no `getSession` injected)…
      const b = tryDeviceCdpInput('tap', { x: 1, y: 1 }, { proxy: vi.fn(), preferPackage: 'com.other.app', serial: 'NEW' });
      resetDeviceCdpSession();   // …and that lease lets go too, before its run's turn comes
      openFetch();
      expect(await a).toBeNull();
      // The banner must not describe the OLD lease's two pages to this caller.
      expect(await b).toEqual({ handled: false, reason: NO_SESSION_REASON });
    } finally { probe.mockRestore(); }
  });

  it('reset DURING THE CONNECT: the session that opens late is closed, not cached, and the forward is released', async () => {
    openFetch();
    let openSocket!: () => void;
    FakeWebSocket.openGate = new Promise<void>((r) => { openSocket = r; });
    const stale = getDeviceCdpSession(PKG);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    resetDeviceCdpSession();   // after discovery latched its forward, before the socket opens
    openSocket();
    expect(await stale).toBeNull();
    expect(FakeWebSocket.instances[0].closed).toBe(true);
    // Released exactly once — by the reset, which found it latched. Nothing is left standing.
    expect(adb.remove).toHaveBeenCalledTimes(1);
    // Nothing cached: the next call discovers again.
    FakeWebSocket.openGate = Promise.resolve();
    expect(await getDeviceCdpSession(PKG)).not.toBeNull();
    expect(adb.sockets).toHaveBeenCalledTimes(2);
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

/** #1016 — the TRUSTED route must supply the gesture, because nothing upstream does.
 *
 *  ⚠️ **This is the third aim path to be found unwired, and the one that matters most.**
 *  `resolveAimViaDevice` forwards `{...params}`, and `params` is the RAW MCP payload — `device_tap`'s
 *  schema is `{selector, x, y}` with no gesture field. So the gesture cannot arrive from the caller
 *  and the ROUTE has to name it. Until it did, `handleResolveAim` saw `undefined` on every
 *  production call and fell to the strict reading, leaving #1016's original symptom live on the
 *  surface that drives a real phone — while the synthetic fallback, which already flags itself
 *  with a banner, was the only path that carried one.
 *
 *  The assertion is deliberately about **what goes on the wire**, for the same reason
 *  `bridgeAimGesture.test.ts` exists: the resolver's behaviour is covered elsewhere, and testing it
 *  again here would leave the wiring unasserted, which is precisely how this went missing twice. */
describe('#1016 — the trusted CDP route names its gesture on the wire', () => {
  /** Capture the `resolve-aim` payloads, answering in the STRING shape the real transport uses. */
  function capturingProxy() {
    const sent: Array<Record<string, unknown>> = [];
    const proxy: CdpRouteDeps['proxy'] = async (method, params) => {
      if (method === 'resolve-aim') sent.push((params ?? {}) as Record<string, unknown>);
      return JSON.stringify({ x: 1, y: 2, label: 'css(1,2)' });
    };
    return { sent, proxy };
  }

  const session = { send: async () => ({}) } as unknown as DeviceCdpSession;
  const gestures = (sent: Array<Record<string, unknown>>) => sent.map((p) => p.gesture);

  it('tap sends `tap` — the only click-shaped gesture, and the only one the gap affected', async () => {
    const { sent, proxy } = capturingProxy();
    await tryDeviceCdpInput('tap', { selector: '[data-entity-id="42"]' }, depsWithSession(session, proxy));
    expect(gestures(sent)).toEqual(['tap']);
  });

  it('drag sends `drag` for both endpoints', async () => {
    const { sent, proxy } = capturingProxy();
    await tryDeviceCdpInput('drag', { fromSelector: '#a', toSelector: '#b' }, depsWithSession(session, proxy));
    expect(gestures(sent)).toEqual(['drag', 'drag']);
  });

  it('hover sends `hover` and scroll sends `scroll`', async () => {
    const { sent, proxy } = capturingProxy();
    await tryDeviceCdpInput('hover', { selector: '#a' }, depsWithSession(session, proxy));
    await tryDeviceCdpInput('scroll', { selector: '#a', dy: 10 }, depsWithSession(session, proxy));
    expect(gestures(sent)).toEqual(['hover', 'scroll']);
  });

  it('the gesture is not read from the caller payload — the tool schema has no such field', async () => {
    // A caller cannot smuggle one in: `device_tap` exposes no `gesture`, so a value appearing in
    // `params` is not something the surface accepts, and the ROUTE's choice must win. Pinned
    // because "forward `...params` and hope" is exactly what shipped and did nothing.
    const { sent, proxy } = capturingProxy();
    await tryDeviceCdpInput('drag', { fromSelector: '#a', toSelector: '#b', gesture: 'tap' },
      depsWithSession(session, proxy));
    expect(gestures(sent), 'a drag stays a drag').toEqual(['drag', 'drag']);
  });
});
