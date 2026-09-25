/** Every device tool relays the §5 code and `options` its OP named (#1211).
 *
 *  The class, stated once: **a layer relays the classification it was handed; it never invents
 *  one.** It has been broken at four hops and fixed four times — #1012 (ops threw plain Errors so
 *  the route named the code), #1070 (the same hop again), #1013 (`/api/eval`'s bare 504), #1223 P3
 *  (the device wire's string protocol → `shared/deviceRefusal.ts`). This file covers the fifth:
 *  `perceptCall` and `writeCall` hard-coded `code: 'REFUSED_BY_OP'` over every OBJECT reply, so
 *  `PARTIAL`, `NOT_FOUND` and `AMBIGUOUS` never reached the agent. `device_write_player_prefs`'s own
 *  description promises PARTIAL; the agent was told "nothing happened" while the cache write landed.
 *
 *  ⚠️ Assert on the ENVELOPE's code, never on a regex over the text — the op's body is echoed in
 *  `got`, carrying the same `"code":"…"`, so a text match passes with the hard-coded code restored.
 *  That trap is `deviceDispatchActionCode.test.ts`'s (#1223) and it is the reason `codeOf` exists.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDeviceSurface, deviceReply, type DeviceSurface } from './deviceSurface';

const MCP_TOOLS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tools/game-debug-mcp/src/mcp-tools.ts');

let s: DeviceSurface | undefined;
afterEach(() => { s?.restore(); s = undefined; });

const envelope = (text: string) => JSON.parse(text.slice(text.indexOf('{'))) as {
  error: { code: string; what: string; why: string; options?: string[] };
};
const codeOf = (text: string) => envelope(text).error.code;

/** Every tool that reaches the device through `perceptCall` or `writeCall`, with the minimum args
 *  its strict shape accepts. The point of the table is that a NEW tool added to either relay is a
 *  row here, not a silent gap — the relay callers are read from the source and checked below. */
const TOOLS: ReadonlyArray<{ name: string; args?: Record<string, unknown> }> = [
  // perceptCall
  { name: 'device_get_scene_state' },
  { name: 'device_physics_query', args: { kind: 'raycast', dim: '3d', origin: [0, 0, 0], direction: [0, 0, -1] } },
  { name: 'device_journal' },
  { name: 'device_watch', args: { action: 'list' } },
  { name: 'device_input_watch', args: { action: 'read' } },
  { name: 'device_handles' },
  { name: 'device_hit_regions' },
  { name: 'device_layout_bounds' },
  { name: 'device_introspect' },
  { name: 'device_resolve_refs', args: { refs: ['g'] } },
  { name: 'device_profiler', args: { action: 'read' } },
  { name: 'device_player_prefs' },
  { name: 'device_write_player_prefs', args: { action: 'set', key: 'k', value: 'v' } },  // its description promises PARTIAL
  { name: 'device_game_tools' },
  { name: 'device_game_tool_call', args: { name: 'court_load_level' } },
  // NOT device_diagnose: `ok:false` is its ANSWER ("this scene is unhealthy"), not a failure —
  // `OK_IS_A_VERDICT` exempts it, and running the failure check over it turned the one tool built
  // to report problems into an error envelope exactly when it had something to report. A row here
  // would assert the opposite of that fix.
  // writeCall
  { name: 'device_create_entity', args: { spec: { kind: 'primitive', mesh: 'sphere' } } },
  { name: 'device_duplicate_entity', args: { guid: 'g' } },
  { name: 'device_delete_entities', args: { guids: ['g'] } },
  { name: 'device_load_scene', args: { path: '/assets/scenes/x.scene.json' } },
  { name: 'device_set_timescale', args: { scale: 1 } },
  { name: 'device_step', args: { frames: 1 } },
  { name: 'device_invalidate_assets', args: { items: [{ path: '/assets/x.png', type: 'texture' }] } },
  { name: 'device_read_asset_def', args: { path: '/assets/x.mat.json' } },
  // their own failure branches, outside both relays
  { name: 'device_mutate_scene', args: { guid: 'g', set: { Transform: { x: 1 } } } },
  { name: 'device_type_text', args: { text: 'x' } },
];

describe('device tools relay the op\'s §5 code', () => {
  it('the table names every perceptCall/writeCall caller in the source', () => {
    const src = readFileSync(MCP_TOOLS, 'utf8');
    const callers = new Set([...src.matchAll(/\b(?:perceptCall|writeCall)\(\s*'(device_\w+)'/g)].map((m) => m[1]));
    callers.delete('device_diagnose');   // OK_IS_A_VERDICT — see the comment in the table
    expect(callers.size, 'the source scan found nothing — the regex no longer matches').toBeGreaterThan(15);
    const rows = new Set(TOOLS.map((t) => t.name));
    expect([...callers].filter((c) => !rows.has(c))).toEqual([]);
  });

  for (const { name, args } of TOOLS) {
    it(`${name} reports NOT_FOUND when the op said NOT_FOUND`, async () => {
      s = await loadDeviceSurface((req) => req.path === '/api/device/request'
        ? deviceReply({ ok: false, code: 'NOT_FOUND', error: "guid 'g' matched no entity in the live world" })
        : undefined);
      const r = await s.call(name, args);
      expect(r.isError, `${name} did not report the refusal as a failure`).toBe(true);
      expect(codeOf(s.text(r)), `${name} stamped its own code over the op's`).toBe('NOT_FOUND');
    });
  }

  it('an op that names NO code still gets the generic refusal', async () => {
    s = await loadDeviceSurface((req) => req.path === '/api/device/request'
      ? deviceReply({ ok: false, error: 'the scene is not loaded yet' })
      : undefined);
    const r = await s.call('device_get_scene_state');
    expect(codeOf(s.text(r))).toBe('REFUSED_BY_OP');
  });

  it('a junk code is not trusted — the closed set is the contract', async () => {
    s = await loadDeviceSurface((req) => req.path === '/api/device/request'
      ? deviceReply({ ok: false, code: 'BANANA', error: 'nope' })
      : undefined);
    const r = await s.call('device_get_scene_state');
    expect(codeOf(s.text(r))).toBe('REFUSED_BY_OP');
  });

  it('PARTIAL survives — the case device_write_player_prefs\'s own description promises', async () => {
    s = await loadDeviceSurface((req) => req.path === '/api/device/request'
      ? deviceReply({ ok: false, code: 'PARTIAL', error: 'the cache write landed; the disk write did not' })
      : undefined);
    const r = await s.call('device_write_player_prefs', { action: 'set', key: 'k', value: 'v' });
    expect(codeOf(s.text(r))).toBe('PARTIAL');
  });

  it('the op\'s OPTIONS reach the envelope, not just the echoed body in got', async () => {
    s = await loadDeviceSurface((req) => req.path === '/api/device/request'
      ? deviceReply({ ok: false, code: 'AMBIGUOUS', error: "two entities are named 'Ball'", options: ['guid aaa', 'guid bbb'] })
      : undefined);
    const r = await s.call('device_get_scene_state');
    // `options` is the half that unblocks the caller; buried in `got` it is diagnostic payload.
    expect(envelope(s.text(r)).error.options).toEqual(['guid aaa', 'guid bbb']);
  });
});

/** C-4: a backend that ANSWERED is classified from what it said. Before this, every non-2xx threw
 *  bare prose into `caughtFailure`, which has one catch-all: `NOT_AVAILABLE_HERE` plus *"the device
 *  app may have been backgrounded or killed; relaunch it and reconnect"*. So a 409 — a state the
 *  caller could clear in one call — sent the agent to restart a healthy app, and the real reason
 *  was one line of prose inside a reply that said the opposite. */
describe('a backend HTTP refusal keeps its meaning', () => {
  it('a 409 is the CALLER\'s to fix, not "relaunch the app"', async () => {
    s = await loadDeviceSurface((req) => req.path.startsWith('/api/device/')
      ? { status: 409, body: { error: 'a capture is already running; stop it first' } }
      : undefined);
    const r = await s.call('device_crash_reports');
    expect(r.isError).toBe(true);
    const e = envelope(s.text(r)).error;
    expect(e.code).toBe('REFUSED_BY_OP');
    expect(s.text(r)).not.toMatch(/backgrounded or killed/);
  });

  it('a 5xx still reads as "could not look" — the accept side', async () => {
    s = await loadDeviceSurface((req) => req.path.startsWith('/api/device/')
      ? { status: 500, body: { error: 'the bridge crashed' } }
      : undefined);
    const r = await s.call('device_crash_reports');
    expect(codeOf(s.text(r))).toBe('NOT_AVAILABLE_HERE');
  });

  it('a 5xx keeps the transport advice — a relay timeout is not the op refusing', async () => {
    s = await loadDeviceSurface((req) => req.path === '/api/device/request'
      ? { status: 502, body: { error: 'device request "scene-state" timed out after 5000ms' } }
      : undefined);
    const r = await s.call('device_get_scene_state');
    const e = envelope(s.text(r)).error;
    expect(e.code).toBe('NOT_AVAILABLE_HERE');
    expect(e.options?.join('\n')).toMatch(/device_status/);
    expect(e.why).not.toMatch(/refused/);
  });

  it('a 404 with an EMPTY body is a missing route, not a missing thing', async () => {
    s = await loadDeviceSurface((req) => req.path === '/api/device/request'
      ? { status: 404, body: undefined } : undefined);
    const r = await s.call('device_crash_reports');
    expect(codeOf(s.text(r))).toBe('NOT_AVAILABLE_HERE');
  });

  it('a code in the backend body beats the status', async () => {
    s = await loadDeviceSurface((req) => req.path.startsWith('/api/device/')
      ? { status: 400, body: { error: 'no such report', code: 'NOT_FOUND' } }
      : undefined);
    const r = await s.call('device_crash_reports');
    expect(codeOf(s.text(r))).toBe('NOT_FOUND');
  });

  it('the backend\'s own options reach the envelope', async () => {
    s = await loadDeviceSurface((req) => req.path.startsWith('/api/device/')
      ? { status: 409, body: { error: 'a capture is already running', options: ['device_profiler {action:"stop"} ends it'] } }
      : undefined);
    const r = await s.call('device_crash_reports');
    expect(envelope(s.text(r)).error.options).toEqual(['device_profiler {action:"stop"} ends it']);
  });
});

/** C-15: `what` had a default — "read <op> from the connected device" — and every caller that
 *  forgot to override it inherited it, including the MUTATING ones. A refused `clear` told the agent
 *  it had tried to READ, which is the wrong verb for deciding whether anything changed. `what` is now
 *  required; these rows pin that each mutating action names its own verb. */
describe('a refused mutating action names what it tried to DO', () => {
  const MUTATING: ReadonlyArray<{ name: string; args: Record<string, unknown>; what: string }> = [
    { name: 'device_input_watch', args: { action: 'clear' }, what: 'clear the device input watch' },
    { name: 'device_input_watch', args: { action: 'start' }, what: 'start the device input watch' },
    { name: 'device_watch', args: { action: 'clear' }, what: 'clear every device watch' },
    { name: 'device_watch', args: { action: 'clear', id: 'w1' }, what: 'clear the device watch w1' },
    { name: 'device_profiler', args: { action: 'reset' }, what: 'reset the device profiler markers and captures' },
    { name: 'device_profiler', args: { action: 'gpu-on' }, what: 'turn on device GPU timestamps' },
    { name: 'device_hit_regions', args: { action: 'show' }, what: 'show the device hit-region overlay' },
  ];
  for (const { name, args, what } of MUTATING) {
    it(`${name} ${JSON.stringify(args)} → "${what}"`, async () => {
      s = await loadDeviceSurface((req) => req.path === '/api/device/request'
        ? deviceReply({ ok: false, error: 'the op refused' })
        : undefined);
      const r = await s.call(name, args);
      expect(r.isError).toBe(true);
      expect(envelope(s.text(r)).error.what).toBe(what);
    });
  }

  it('the read side still says read — the accept side', async () => {
    s = await loadDeviceSurface((req) => req.path === '/api/device/request'
      ? deviceReply({ ok: false, error: 'the op refused' })
      : undefined);
    const r = await s.call('device_profiler', { action: 'read' });
    expect(envelope(s.text(r)).error.what).toBe('read the device frame profiler');
  });
});

/** C-21: `device_list` cast the route's reply and ignored `self`. */
describe('device_list decodes its reply and knows its own claim', () => {
  const claim = (clone: string, pid: number) =>
    ({ deviceId: 'adb:SER1', clone, branch: 'work-qa', pid, at: 0, purpose: 'debug' });
  const listing = (extra: Record<string, unknown>) => ({
    adb: { present: true }, ios: [], otherClaims: [],
    android: [{ serial: 'SER1', state: 'device', usable: true, name: 'Galaxy', claim: claim('/r/modoki-qa', 42) }],
    ...extra,
  });

  it('this editor\'s own claim is YOURS, not a collision', async () => {
    s = await loadDeviceSurface((req) => req.path === '/api/device/list'
      ? { body: listing({ self: { clone: '/r/modoki-qa', pid: 42 } }) } : undefined);
    const text = s.text(await s.call('device_list'));
    expect(text).toMatch(/SER1 \(Galaxy\) — held by THIS editor/);
    expect(text).not.toMatch(/CLAIMED by/);
  });

  it('a sibling clone\'s claim still reads as CLAIMED — the accept side', async () => {
    s = await loadDeviceSurface((req) => req.path === '/api/device/list'
      ? { body: listing({ self: { clone: '/r/modoki-ai', pid: 7 } }) } : undefined);
    expect(s.text(await s.call('device_list'))).toMatch(/CLAIMED by \/r\/modoki-qa \(work-qa\), debug/);
  });

  it('an unreadable reply is a refusal, never "No devices attached"', async () => {
    // Strings, not arrays: `''.length` is 0, so the old cast walked straight past every section and
    // printed "No devices attached" — a shape that merely THREW would not tell the decoder from it.
    s = await loadDeviceSurface((req) => req.path === '/api/device/list'
      ? { body: { adb: { present: true }, android: '', ios: '', otherClaims: '' } } : undefined);
    const r = await s.call('device_list');
    expect(r.isError).toBe(true);
    expect(codeOf(s.text(r))).toBe('NOT_AVAILABLE_HERE');
    expect(s.text(r)).not.toMatch(/No devices attached/);
  });
});

/** C-16: the write relays used a hand-copied `ok === false`, which reads an `{error}` body with no
 *  `ok` as a SUCCESS. They use the shared `isFailureBody` now.
 *  ⚠️ A DRIFT guard, not a live repro: every device write op answers an explicit `ok` today (read
 *  in `agentBridge.ts`/`liveLifecycle.ts`), so no current reply reaches this shape. It pins that
 *  the relays and the shared predicate cannot diverge again. */
describe('an {error} body without ok is a failure on the write relays', () => {
  for (const { name, args } of [
    { name: 'device_set_timescale', args: { scale: 1 } },
    { name: 'device_mutate_scene', args: { guid: 'g', set: { Transform: { x: 1 } } } },
  ]) {
    it(name, async () => {
      s = await loadDeviceSurface((req) => req.path === '/api/device/request'
        ? deviceReply({ error: 'no such trait: Transfrom' }) : undefined);
      const r = await s.call(name, args);
      expect(r.isError, `${name} encoded a refusal as success`).toBe(true);
      expect(envelope(s.text(r)).error.code).toBe('REFUSED_BY_OP');
    });
  }
});
