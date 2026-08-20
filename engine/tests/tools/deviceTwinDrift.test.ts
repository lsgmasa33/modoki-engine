/** Device-MCP drift from its editor twins — the defects the 2026-07-30 independent review found.
 *
 *  The device tools are meant to be the same surface as the editor ones, reached over the lease.
 *  Where they diverged, they diverged SILENTLY: a scope param dropped, a scale never sent, a
 *  verdict misread as a failure. Each of these reported success (or a plausible-looking refusal)
 *  while doing the wrong thing, which is the whole class this surface exists not to have.
 *
 *  Driven through the REAL handlers against a stub backend (`deviceSurface.ts`), so a fix only
 *  passes if the code path produces it.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { loadDeviceSurface, deviceReply, type DeviceSurface } from './deviceSurface';

let s: DeviceSurface | undefined;
afterEach(() => { s?.restore(); s = undefined; });

/** The op + params the tool actually relayed to the device. */
function relayed(surface: DeviceSurface): { method?: string; params?: Record<string, unknown> } {
  const req = surface.real().find((r) => r.path.startsWith('/api/device/request'));
  return (req?.body ?? {}) as { method?: string; params?: Record<string, unknown> };
}

describe('device_watch: start-time scope must reach the device', () => {
  it('forwards `guids` on action:start — it used to be destructured away', async () => {
    // The old signature was `({ action, id, name, guids, … , ...start })` and the start branch
    // spread only `...start`, so `guids` — a documented start-time scope — never reached
    // watch-start. `startWatch()` with no scope watches EVERY entity carrying the component and
    // answers ok:true, so a watch the caller believed was scoped to one entity reported success.
    s = await loadDeviceSurface(() => deviceReply({ ok: true, id: 'w1', matched: [] }));
    await s.call('device_watch', { action: 'start', component: 'Transform', guids: ['g-1', 'g-2'] });
    expect(relayed(s).method).toBe('watch-start');
    expect(relayed(s).params).toMatchObject({ component: 'Transform', guids: ['g-1', 'g-2'] });
  });

  it('forwards `names` too, and does not leak read-only keys into the start payload', async () => {
    s = await loadDeviceSurface(() => deviceReply({ ok: true, id: 'w1' }));
    await s.call('device_watch', { action: 'start', component: 'Transform', names: ['puck'], fields: ['x'] });
    const p = relayed(s).params ?? {};
    expect(p).toMatchObject({ names: ['puck'], fields: ['x'] });
    for (const readOnly of ['id', 'limit', 'clear', 'samples', 'precision']) {
      expect(p, `start payload must not carry ${readOnly}`).not.toHaveProperty(readOnly);
    }
  });

  it('REFUSES a read-time key on a start call instead of dropping it (the editor twin already did)', async () => {
    s = await loadDeviceSurface(() => deviceReply({ ok: true, id: 'w1' }));
    const r = await s.call('device_watch', { action: 'start', component: 'Transform', name: 'puck' });
    expect(r.isError).toBe(true);
    expect(s.text(r)).toMatch(/not accepted by action:'start'/);
    expect(s.text(r)).toMatch(/EVERY entity carrying the component/);
    expect(s.real().some((q) => q.path.startsWith('/api/device/request'))).toBe(false);
  });

  it('REFUSES a scope param on clear, so a scoped clear cannot become a clear-ALL', async () => {
    s = await loadDeviceSurface(() => deviceReply({ ok: true, cleared: 4 }));
    const r = await s.call('device_watch', { action: 'clear', name: 'puck' });
    expect(r.isError).toBe(true);
    expect(s.text(r)).toMatch(/clear EVERY watch/);
    expect(s.real().some((q) => q.path.startsWith('/api/device/request'))).toBe(false);
  });
});

describe('device_diagnose: ok:false is the ANSWER, not a failed call', () => {
  it('reports an unhealthy scene as a successful read', async () => {
    // `perceptCall` ran the shared `isFailureBody` over every Percept reply, including diagnose —
    // whose `ok:false` means "this scene is unhealthy". So the one tool built to report problems
    // became a REFUSED_BY_OP envelope exactly when it had something to report, and the diagnosis
    // the caller asked for was discarded. The editor twin deliberately does not run the check.
    s = await loadDeviceSurface(() => deviceReply({ ok: false, issues: ['no camera in the scene'], entityCount: 12 }));
    const r = await s.call('device_diagnose');
    expect(r.isError, `an unhealthy scene is an ANSWER: ${s.text(r)}`).toBeFalsy();
    expect(s.text(r)).toContain('no camera in the scene');
  });

  it('…but a sibling Percept op with ok:false is STILL a failure (the exemption is narrow)', async () => {
    s = await loadDeviceSurface(() => deviceReply({ ok: false, error: 'no scene loaded' }));
    const r = await s.call('device_get_scene_state');
    expect(r.isError).toBe(true);
    expect(s.text(r)).toContain('no scene loaded');
  });
});

describe('game-registered tools relay to the ops, not to a game-shaped route (#286)', () => {
  it('device_game_tools reads the declaration feed', async () => {
    s = await loadDeviceSurface(() => deviceReply({ version: 2, tools: [{ name: 'court_load_level', mutates: true }] }));
    await s.call('device_game_tools', {});
    expect(relayed(s).method).toBe('game-tools');
  });

  it('device_game_tool_call forwards the name and the args object', async () => {
    s = await loadDeviceSurface(() => deviceReply({ ok: true }));
    await s.call('device_game_tool_call', { name: 'court_load_level', args: { track: 'hard', trackIndex: 19 } });
    expect(relayed(s).method).toBe('game-tool-call');
    expect(relayed(s).params).toMatchObject({ name: 'court_load_level', args: { track: 'hard', trackIndex: 19 } });
  });

  it('omitted args become {} rather than undefined, so a no-argument tool is callable bare', async () => {
    // The op reads `p.args ?? {}`, but sending `undefined` would make the relayed payload
    // structurally different from the editor path's for the same call — and the two are meant to
    // be the same surface reached two ways.
    s = await loadDeviceSurface(() => deviceReply({ ok: true }));
    await s.call('device_game_tool_call', { name: 'court_level_info' });
    expect(relayed(s).params).toMatchObject({ name: 'court_level_info', args: {} });
  });

  it('a refusal names the GAME TOOL, not the relay op (§5, caller\'s terms)', async () => {
    // Every refusal used to read "read game-tool-call from the connected device" — which names our
    // plumbing rather than what the caller asked for, and calls a mutating jump a "read". The
    // editor MCP's own postJson docs say exactly why that is wrong.
    s = await loadDeviceSurface(() => deviceReply({ ok: false, reason: 'nope' }));
    const r = await s.call('device_game_tool_call', { name: 'court_load_level', args: {} });
    const body = s.text(r);
    expect(r.isError).toBe(true);
    expect(body).toMatch(/court_load_level/);
    expect(body).not.toMatch(/read game-tool-call/);
  });

  it('names no specific game — the connected build decides what exists', async () => {
    // Not purity: an example name is actively MISLEADING here. The editor's tools describe the
    // OPEN PROJECT, but a phone may be running any game at all, so "e.g. court_load_level" hints
    // at a tool that is probably not on the device in front of you. The description has to send
    // the caller to the discovery call instead. (Substring check — it catches the name that was
    // actually there, not every game a future description might invent.)
    s = await loadDeviceSurface(() => deviceReply({ ok: true }));
    const src = (s.descriptionOf('device_game_tool_call') + s.descriptionOf('device_game_tools')).toLowerCase();
    expect(src).not.toMatch(/court/);
    expect(src).toMatch(/device_game_tools/);   // …and it does point at discovery
  });
});

describe('coordinate aims all carry the screenshot scale', () => {
  /** An adb lease with no prior screenshot: `currentScreenInfo()` is null and the device has no
   *  `lastScreenInfo` of its own, so raw pixels would be used unscaled as CSS coordinates. */
  const adbLeaseNoScale = (req: { path: string }) =>
    req.path.startsWith('/api/device/status')
      ? { body: { state: 'connected', guid: 'g', target: { host: '127.0.0.1', port: 8095, useAdb: true } } }
      : deviceReply('ok');

  for (const [tool, args] of [
    ['device_tap', { x: 100, y: 200 }],
    ['device_hover', { x: 100, y: 200 }],
    ['device_scroll', { x: 100, y: 200, deltaY: 120 }],
  ] as const) {
    it(`${tool} REFUSES a coordinate aim on an adb lease with no measured scale`, async () => {
      // tap/drag already did this; hover/scroll documented `x`/`y` as "screenshot pixels", went
      // through the same on-device screenshotToCSS, and passed them RAW — landing at the wrong
      // point and reporting ok.
      s = await loadDeviceSurface(adbLeaseNoScale);
      const r = await s.call(tool, args as Record<string, unknown>);
      expect(r.isError, `${tool} dispatched an unscaled coordinate aim`).toBe(true);
      expect(s.text(r)).toMatch(/no screenshot scale/);
      expect(s.real().some((q) => q.path.startsWith('/api/device/request'))).toBe(false);
    });

    it(`${tool} still aims by selector on the same lease (a selector needs no scale)`, async () => {
      s = await loadDeviceSurface(adbLeaseNoScale);
      const sel = { ...(args as Record<string, unknown>), x: undefined, y: undefined, selector: '#btn' };
      const r = await s.call(tool, Object.fromEntries(Object.entries(sel).filter(([, v]) => v !== undefined)));
      expect(r.isError, `${tool} refused a selector aim that needs no scale: ${s.text(r)}`).toBeFalsy();
    });
  }
});
