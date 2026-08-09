/** Phase 8, device half — T2 across ALL 20 `device_*` tools, table-driven.
 *
 *  The editor surface got a contract table (`contracts.ts`) and therefore per-tool conformance for
 *  all 77 tools. The device surface had neither: `deviceToolSurface.test.ts` asserts a dozen
 *  specific behaviours (identity banner, lease refusal, unscaled-tap refusal, reply decoding) but
 *  NOTHING per tool — so 14 of the 20 had no test that called them at all, and the one failure mode
 *  this whole audit is about (a tool that is dead, or that swallows a failure) was unobservable for
 *  them.
 *
 *  Rather than duplicate the editor's full contract table for the device server — a second table to
 *  keep in sync, which §9 says will drift — this asserts the two invariants that actually matter and
 *  derives everything else from the live registry:
 *
 *    1. every DATA-PLANE tool proxies through `/api/device/request` (the lease is the only path to
 *       the device; a tool that talks to anything else has escaped the controlled-comms design), and
 *    2. every tool reports a failure as an `isError` §5 envelope rather than a cheerful string.
 *
 *  The control-plane exceptions (`device_status`/`connect`/`disconnect` hit `/api/device/*`, and
 *  `device_screenshot`/`device_native_logs` can take the adb side channel) are named, with reasons.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { loadDeviceSurface, deviceReply, type DeviceSurface } from './deviceSurface';

let surface: DeviceSurface | undefined;
afterEach(() => { surface?.restore(); surface = undefined; });

/** Tools that legitimately do NOT go through `/api/device/request`, and why. */
const NOT_DATA_PLANE: Record<string, string> = {
  device_status: 'control plane — reads the lease itself via /api/device/status',
  device_connect: 'control plane — opens the lease via /api/device/connect',
  device_disconnect: 'control plane — closes the lease via /api/device/disconnect',
  device_list: 'control plane — enumerates ATTACHED hardware (and who claims it) via /api/device/list, which is answerable with no lease open at all; it is the tool you call precisely because you do not yet know which device to lease (#149)',
  device_screenshot: 'may use the adb side channel: an Android WebView composites WebGPU in a separate GPU surface, so the device-side captureScreen returns a BLACK frame and only `adb screencap` sees the real one',
};
// `device_native_logs` USED to be exempted here, with the reason "reads logcat/idevicesyslog
// through adb — there is no device-side op for it". That was false in both halves: it calls
// `deviceRequest('nativeLogs', …)`, and the device reads logcat IN-PROCESS (`app/debug/bridge.ts`
// § nativeLogs), so it is ordinary data plane and always was. Found sweeping for un-targeted adb
// call sites (#149): the exemption described a seventh adb site that does not exist.
//
// The cost was not the wrong sentence, it was the exemption it justified — being outside the loop,
// NOTHING asserted that this tool proxies through the lease, so it could have quietly grown a real
// adb side channel (bypassing the lease's device identity, the exact #142 class) and no test would
// have objected. A guard weakened by a premise nobody rechecks is this repo's recurring failure.

/** Tools whose device op does NOT answer with a `{ok, …}` JSON envelope, so a structured
 *  `{ok:false}` is not their refusal shape and asserting it would test a protocol they never speak.
 *  Named with reasons rather than skipped silently — a blanket skip is how a real gap hides.
 *
 *  Every one of these still has to pass the `Error: …` loop above, which IS their refusal shape. */
const NOT_A_JSON_ENVELOPE: Record<string, string> = {
  device_diagnose: 'ok:false IS the answer here (your scene is unhealthy), not a failed call — it is the one entry in OK_IS_A_VERDICT',
  device_eval: 'returns whatever the evaluated code returned; an eval body may legitimately produce {ok:false} as DATA',
  device_eval_api: 'returns a discovery document (the injected object\'s op list), not a status envelope',
  device_console_logs: 'returns a log payload; its failures arrive as `Error: …`',
  device_native_logs: 'returns a log payload; its failures arrive as `Error: …`',
  device_tap: 'input tools reply with a bare `ok …` / `Error: …` STRING, not JSON',
  device_drag: 'bare-string input reply',
  device_pointer: 'bare-string input reply',
  device_hover: 'bare-string input reply',
  device_scroll: 'bare-string input reply',
  device_press_key: 'bare-string input reply',
};

/** The smallest VALID call per tool — the ergonomic form, same rule as the editor table's
 *  `minimalArgs`. Explicit rather than synthesized: a synthesized aim (`{x:1,y:2}`) would trip the
 *  unscaled-coordinate refusal and test that instead of the tool. */
const MINIMAL: Record<string, Record<string, unknown>> = {
  device_status: {},
  device_connect: { useAdb: true },
  device_disconnect: {},
  device_list: {},
  device_get_scene_state: {},
  device_diagnose: {},
  device_journal: {},
  device_watch: { action: 'list' },
  device_input_watch: { action: 'read' },
  device_hit_regions: { action: 'read' },
  device_layout_bounds: {},
  device_resolve_refs: { refs: ['g-1'] },
  device_introspect: {},
  device_dispatch_action: { name: 'engine.playClip' },
  device_mutate_scene: { guid: 'g-1', set: { 'Renderable3D.isVisible': false } },
  device_create_entity: { spec: { kind: 'primitive', mesh: 'sphere' } },
  device_duplicate_entity: { guid: 'g-1' },
  device_delete_entities: { guids: ['g-1'] },
  device_step: {},
  device_load_scene: { path: '/games/x/main.scene.json' },
  device_read_asset_def: { path: '/games/x/fx.particle.json' },
  device_profiler: {},
  device_set_timescale: { scale: 0 },
  device_handles: {},
  device_invalidate_assets: { items: [{ path: '/a.glb', type: 'model' }] },
  device_console_logs: {},
  device_native_logs: {},
  device_eval: { code: 'return 1' },
  device_eval_api: {},   // discovery for device_eval's injected `modoki` object (#83) — no params
  device_screenshot: {},
  device_tap: { selector: '#play' },
  device_drag: { fromSelector: '#a', toSelector: '#b' },
  device_pointer: { action: 'down', selector: '#play' },
  device_hover: { selector: '#play' },
  device_scroll: { selector: '#list', deltaY: 120 },   // canonical name — see the twin-parity note in mcp-tools.ts
  device_press_key: { key: 'Space' },
  device_type_text: { text: 'hi' },
};

describe('device tool surface — every tool, table-driven', () => {
  it('the MINIMAL table covers exactly the registered tools (neither stale nor short)', async () => {
    const s = (surface = await loadDeviceSurface());
    expect(Object.keys(MINIMAL).sort()).toEqual([...s.names].sort());
  });

  it('every fixture is VALID against its own strict schema', async () => {
    // A fixture the transport would refuse describes a call that cannot happen — the harness must
    // not manufacture states (mcpSurface's docblock; nine unreachable findings came from it once).
    const s = (surface = await loadDeviceSurface());
    const bad: string[] = [];
    for (const [name, args] of Object.entries(MINIMAL)) {
      const v = s.validate(name, args);
      if (!v.ok) bad.push(`${name}: ${v.error}`);
    }
    expect(bad).toEqual([]);
  });

  describe('a data-plane tool proxies through the lease relay', () => {
    for (const name of Object.keys(MINIMAL)) {
      if (name in NOT_DATA_PLANE) continue;
      it(`${name} → POST /api/device/request`, async () => {
        const s = (surface = await loadDeviceSurface((req) =>
          req.path === '/api/device/request' ? deviceReply({ ok: true }) : undefined));
        await s.call(name, MINIMAL[name]);
        const sent = s.real().find((r) => r.path === '/api/device/request');
        expect(sent, `${name} never reached the lease relay; it called: ${s.real().map((r) => r.path).join(', ') || '(nothing)'}`).toBeDefined();
        expect(sent!.method).toBe('POST');
        // The relay envelope names the device-side op — a tool sending no `method` would reach the
        // device's router default ("Unknown method"), which is a dead tool with a 200 in front of it.
        expect((sent!.body as { method?: string })?.method, `${name} sent no device op name`).toBeTruthy();
      });
    }
  });

  describe('every tool reports a transport failure as a §5 envelope', () => {
    for (const name of Object.keys(MINIMAL)) {
      it(`${name} surfaces an unreachable backend`, async () => {
        const s = (surface = await loadDeviceSurface(() => { throw new Error('ECONNREFUSED'); }));
        const r = await s.call(name, MINIMAL[name]);
        expect(r.isError, `${name} reported an unreachable backend as success`).toBe(true);
        const text = s.text(r);
        const parsed = JSON.parse(text.split('\n').pop()!) as { error?: { code?: string; tool?: string; why?: string } };
        expect(parsed.error?.code, `${name} failure carries no code`).toBeTruthy();
        expect(parsed.error?.tool, `${name} failure does not name the tool`).toBe(name);
        expect(parsed.error?.why, `${name} failure has no cause`).toBeTruthy();
      });
    }
  });

  describe('every data-plane tool fails when the DEVICE refuses', () => {
    // The device signals a handler failure by RETURNING an `Error: …` string, which the transport
    // resolves as a normal result — the C7 class, and the reason `isDeviceError` exists. It was
    // fixed for the six Percept tools; this asserts it for all of them.
    for (const name of Object.keys(MINIMAL)) {
      if (name in NOT_DATA_PLANE) continue;
      it(`${name} treats an 'Error: …' reply as a failure`, async () => {
        const s = (surface = await loadDeviceSurface((req) =>
          req.path === '/api/device/request' ? deviceReply('Error: the op refused') : undefined));
        const r = await s.call(name, MINIMAL[name]);
        expect(r.isError, `${name} reported a device refusal as success`).toBe(true);
        expect(s.text(r)).toMatch(/refused/);
      });
    }
  });

  describe('every data-plane tool fails when the device refuses with a STRUCTURED body', () => {
    // The `Error: …` loop above covers only the STRING refusal shape. An op can also refuse with a
    // 200 carrying `{ok:false, error}` — which is the shape EVERY write op added in #166 uses, and
    // the one `isFailureBody` exists for. That path was spot-checked for two tools in another file
    // and table-driven for none, so the doc's "table-driven over the registry, so it cannot miss a
    // tool" claim (§10) did not actually hold for it. Concrete mutation this now catches: adding an
    // op to `OK_IS_A_VERDICT` in mcp-tools.ts turns a genuine refusal into a reported success.
    for (const name of Object.keys(MINIMAL)) {
      if (name in NOT_DATA_PLANE || name in NOT_A_JSON_ENVELOPE) continue;
      it(`${name} treats a 200 {ok:false} as a failure`, async () => {
        const s = (surface = await loadDeviceSurface((req) =>
          req.path === '/api/device/request'
            ? deviceReply({ ok: false, error: 'the op refused: structured body' })
            : undefined));
        const r = await s.call(name, MINIMAL[name]);
        expect(r.isError, `${name} reported a structured {ok:false} refusal as success`).toBe(true);
        expect(s.text(r)).toMatch(/refused/);
      });
    }
  });

  it('device_native_logs also fails on an `Error: …` reply (it is outside the loop above)', async () => {
    // Kept as its OWN assertion even now that the loop covers this tool's routing: the loop proves
    // it reaches the lease, and this proves it treats an `Error: …` REPLY as a failure. Without the
    // check the error string was String()'d straight into the payload and read as log CONTENT.
    const s = (surface = await loadDeviceSurface((req) =>
      req.path === '/api/device/request' ? deviceReply('Error: logcat unavailable') : undefined));
    const r = await s.call('device_native_logs', MINIMAL.device_native_logs);
    expect(r.isError).toBe(true);
    expect(s.text(r)).toMatch(/logcat unavailable/);
  });

  it('the NOT_DATA_PLANE exemptions each carry a real reason', () => {
    for (const [tool, why] of Object.entries(NOT_DATA_PLANE)) {
      expect(why.length, `${tool} needs a real reason`).toBeGreaterThan(20);
      expect(Object.keys(MINIMAL), `${tool} is exempted but not registered`).toContain(tool);
    }
  });
});
