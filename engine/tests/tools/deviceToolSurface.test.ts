/** The `device_*` surface, asserted through REAL handlers against a stub backend.
 *
 *  This file is the payoff for making the device server importable. Every assertion here was
 *  previously impossible: the tools registered straight onto `server.tool`, so device coverage was
 *  helper unit tests plus source guards — which prove a call SHAPE and nothing about behaviour.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { expectInOrder } from '@modoki/engine/testing/inOrder';
import { join } from 'node:path';
import { loadDeviceSurface, deviceReply, DEVICE_STUB_BACKEND, type DeviceSurface } from './deviceSurface';
import { readScannedSource } from '@modoki/engine/testing';
import { nativeLogsAppTimeoutMs } from '../../tools/game-debug-mcp/src/mcp-tools';
import { PER_TOOL_MEANING } from './perToolMeaning';

let surface: DeviceSurface | undefined;
afterEach(() => { surface?.restore(); surface = undefined; });

describe('S2.7 — an unknown argument key is REFUSED, not silently stripped', () => {
  it('device_watch {action:"clear", ids:…} is refused — the typo used to clear EVERY watch', async () => {
    // The measured shape: the param is `id`, zod strips `ids`, and the tool's own contract says
    // "omit on clear to clear ALL" — so a one-character typo wiped every watch and reported
    // success. Nothing on this server validated unknown keys; the editor server fixed the same
    // class at its single definition point (conventions §1).
    const s = (surface = await loadDeviceSurface());
    const v = s.validate('device_watch', { action: 'clear', ids: 'w3' });
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/unrecognized parameter/);
    expect(v.error).toMatch(/It accepts:/);
    expect(v.error).toMatch(/\bid\b/);          // names the RIGHT param
  });

  it('the correct key still validates — the guard must not reject valid input', async () => {
    const s = (surface = await loadDeviceSurface());
    expect(s.validate('device_watch', { action: 'clear', id: 'w3' }).ok).toBe(true);
  });

  it('EVERY device tool reaches validation strictly, not just the ones with required params', async () => {
    // An all-optional schema catches nothing without strictness, and most of this surface is
    // all-optional — which is exactly why the typo above was reachable.
    const s = (surface = await loadDeviceSurface());
    expect(s.names.length).toBeGreaterThanOrEqual(20);
    for (const name of s.names) {
      const v = s.validate(name, { definitelyNotAParam__: 1 });
      expect(v.ok, `${name} accepted an unknown key`).toBe(false);
    }
  });
});

/** §11 and §2 on the DEVICE surface (#1559). Both checks lived in `mcpRegistry.test.ts`, which loads
 *  the modoki registry only — so `device_console_logs.level` went undocumented and `precision` was worded
 *  three ways across six device tools with nothing to notice. Same rules, same pardon list. */
describe('the device surface keeps the editor surface\'s param rules (#1559)', () => {
  type Field = { description?: string };

  it('every parameter is documented — in its own .describe() or the tool description', async () => {
    const s = (surface = await loadDeviceSurface());
    const missing: string[] = [];
    for (const name of s.names) {
      const desc = s.descriptionOf(name);
      for (const [param, field] of Object.entries(s.shapeFor(name) as Record<string, Field>)) {
        if (!field.description && !new RegExp(`\\b${param}\\b`).test(desc)) missing.push(`${name}.${param}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('a param used by 3+ tools means ONE thing, or is declared per-tool', async () => {
    // The editor check's rule exactly: the shortest wording is the shared base, and every longer
    // one must contain it verbatim (a tool adds its nuance AFTER the shared rule, never instead).
    const s = (surface = await loadDeviceSurface());
    const byParam = new Map<string, Map<string, string[]>>();
    for (const name of s.names) {
      for (const [param, field] of Object.entries(s.shapeFor(name) as Record<string, Field>)) {
        const forParam = byParam.get(param) ?? new Map<string, string[]>();
        const d = field.description ?? '';
        forParam.set(d, [...(forParam.get(d) ?? []), name]);
        byParam.set(param, forParam);
      }
    }
    const drifted: string[] = [];
    for (const [param, byDesc] of byParam) {
      if (PER_TOOL_MEANING.includes(param)) continue;
      const described = [...byDesc].filter(([d]) => d !== '');
      const users = described.flatMap(([, tools]) => tools);
      if (users.length < 3 || described.length === 1) continue;
      const descs = described.map(([d]) => d);
      const base = descs.reduce((a, b) => (a.length <= b.length ? a : b));
      if (descs.some((d) => !d.includes(base.replace(/\.$/, '')))) drifted.push(`${param} (${users.join(', ')})`);
    }
    expect(drifted, 'put the shared wording in tools/shared/paramBases.ts and concatenate onto it').toEqual([]);
  });
});

describe('S2.39 — the device server knows WHICH editor it is driving', () => {
  it('banners a wrong-clone backend on the result itself', async () => {
    // `.mcp.json` defaults MODOKI_BACKEND to 5179 for every clone and this server had no identity
    // check at all, so a device_* call from one clone drove another clone's editor — and its
    // physical device — with every call reporting success.
    const s = (surface = await loadDeviceSurface((req) =>
      req.path === '/api/identity'
        ? { body: { repoRoot: '/Users/someone/Projects/modoki', projectRoot: '/Users/someone/Projects/modoki/games/y', backendPort: 5179, pid: 2, branch: 'main', packaged: false } }
        : undefined));
    const r = await s.call('device_status');
    expect(s.text(r)).toMatch(/modoki/);
    // The probe happened at all — that is the thing that did not exist before.
    expect(s.requests.some((q) => q.path === '/api/identity')).toBe(true);
  });

  it('says nothing when the backend IS this checkout (no false alarm)', async () => {
    // This asserted `not.toMatch(/BACKEND MISMATCH/)` — a string that appears NOWHERE in the device
    // or shared identity code (it is a fixture in the editor's mcpResult test). The banner reads
    // "⚠️  WRONG EDITOR". So the assertion was vacuously true and would have passed while the tool
    // emitted a false warning on every call — which, thanks to module-level memoization leaking
    // the previous test's banner, is exactly what it was doing.
    const s = (surface = await loadDeviceSurface());   // default identity == process.cwd()
    const r = await s.call('device_status');
    expect(s.text(r)).not.toMatch(/WRONG EDITOR/);
    expect(s.text(r)).not.toMatch(/⚠/);
  });

  it('device_status names WHICH editor backend holds the lease, not just the lease (S2.39)', async () => {
    // With clones side by side, a lease summary that never says which editor answered is unusable:
    // every call succeeds while driving another clone's phone. The mismatch BANNER covers the wrong
    // case; this covers the ordinary one, so "which backend am I on?" needs no second tool.
    const s = (surface = await loadDeviceSurface());
    const text = s.text(await s.call('device_status'));
    expect(text).toContain(DEVICE_STUB_BACKEND);
    expect(text).toMatch(/\[modoki\] backend/);
  });

  it('the banner text the tools actually emit is the one the tests assert on', () => {
    // A guard against the class of bug above: a test asserting a string no code produces is
    // indistinguishable from a passing test. Pin the two together.
    const src = readScannedSource(join(__dirname, '../../tools/shared/identity.ts')).code;
    expect(src).toContain('WRONG EDITOR');
  });
});

describe('device tools reach the lease relay, and shape its replies', () => {
  it('device_get_scene_state proxies through /api/device/request with its filters', async () => {
    const s = (surface = await loadDeviceSurface((req) =>
      req.path === '/api/device/request' ? deviceReply({ returnedCount: 2, totalCount: 2, entities: [] }) : undefined));
    await s.call('device_get_scene_state', { name: 'Player', world: true });
    const sent = s.real().find((r) => r.path === '/api/device/request');
    expect(sent?.method).toBe('POST');
    expect(sent?.body).toMatchObject({ method: 'scene-state', params: { name: 'Player', world: true } });
  });

  it('a device reply of {ok:false} is a FAILED tool call, not a success (C7)', async () => {
    // NOTE the tool choice. This used `device_diagnose`, which is precisely the op where `ok:false`
    // is the ANSWER ("this scene is unhealthy") rather than a status — so it pinned the behaviour
    // that made the one tool built to report problems fail whenever it had something to report
    // (independent review, 2026-07-30). The C7 rule is real; it just needs an op whose `ok` IS a
    // success flag. `deviceTwinDrift.test.ts` pins both sides of the distinction.
    const s = (surface = await loadDeviceSurface((req) =>
      req.path === '/api/device/request' ? deviceReply({ ok: false, error: 'no scene loaded' }) : undefined));
    const r = await s.call('device_get_scene_state');
    expect(r.isError).toBe(true);
    expect(s.text(r)).toMatch(/no scene loaded/);
  });

  it('a device `Error: …` string reply is REFUSED_BY_OP with the options', async () => {
    const s = (surface = await loadDeviceSurface((req) =>
      req.path === '/api/device/request' ? deviceReply('Error: element is occluded') : undefined));
    const r = await s.call('device_tap', { selector: '#play' });
    expect(r.isError).toBe(true);
    const env = JSON.parse(s.text(r).split('\n').pop()!) as { error: { code: string; tool: string; options?: string[] } };
    expect(env.error.code).toBe('REFUSED_BY_OP');
    expect(env.error.tool).toBe('device_tap');
    expect(env.error.options?.join(' ')).toMatch(/occluded|re-read/);
  });

  it('a missing lease is NOT_AVAILABLE_HERE naming how the HUMAN connects one', async () => {
    const s = (surface = await loadDeviceSurface((req) => {
      if (req.path === '/api/device/request') return { status: 502, body: { error: 'no device connected (state: idle) — connect in the AI panel first' } };
      return undefined;
    }));
    const r = await s.call('device_get_scene_state');
    expect(r.isError).toBe(true);
    const env = JSON.parse(s.text(r).split('\n').pop()!) as { error: { code: string; options?: string[] } };
    expect(env.error.code).toBe('NOT_AVAILABLE_HERE');
    expect(env.error.options?.join(' ')).toMatch(/Connect a Device/);
  });

  it('aiming with neither selector nor complete coords is refused before anything is sent', async () => {
    const s = (surface = await loadDeviceSurface());
    const r = await s.call('device_tap', { x: 10 });          // y missing
    expect(r.isError).toBe(true);
    expect(s.real().some((q) => q.path === '/api/device/request')).toBe(false);
  });

  it('a COORDINATE tap on an adb lease with no scale is REFUSED, not sent unscaled', async () => {
    // An adb device has no screenInfo of its own (only the native captureScreen sets one, which
    // Android skips), so without ours the coordinates go unscaled and the tap lands somewhere else
    // — answered as `Tapped (x,y) — ok`. Dropping stale dims on a lease change made this reachable.
    const s = (surface = await loadDeviceSurface((req) =>
      req.path === '/api/device/status'
        ? { body: { state: 'connected', target: { host: 'localhost', port: 8095, useAdb: true }, lastTarget: null } }
        : undefined));
    const r = await s.call('device_tap', { x: 100, y: 200 });   // no screenshot taken → no scale
    expect(r.isError).toBe(true);
    const env = JSON.parse(s.text(r).split('\n').pop()!) as { error: { code: string; why: string; options?: string[] } };
    expect(env.error.code).toBe('NOT_AVAILABLE_HERE');
    expect(env.error.why).toMatch(/unscaled/);
    expect(env.error.options?.join(' ')).toMatch(/device_screenshot/);
    // The load-bearing half: nothing was sent to the device.
    expect(s.real().some((q) => q.path === '/api/device/request')).toBe(false);
  });

  it('a SELECTOR aim on the same lease is unaffected — it needs no scale', async () => {
    const s = (surface = await loadDeviceSurface((req) => {
      if (req.path === '/api/device/status') return { body: { state: 'connected', target: { host: 'localhost', port: 8095, useAdb: true }, lastTarget: null } };
      if (req.path === '/api/device/request') return deviceReply('ok tapped #play');
      return undefined;
    }));
    const r = await s.call('device_tap', { selector: '#play' });
    expect(r.isError).toBeFalsy();
    expect(s.real().some((q) => q.path === '/api/device/request')).toBe(true);
  });

  it('reports the configured backend in an unreachable-backend failure', async () => {
    const s = (surface = await loadDeviceSurface(() => { throw new Error('ECONNREFUSED'); }));
    const r = await s.call('device_status');
    expect(r.isError).toBe(true);
    expect(s.text(r)).toContain(DEVICE_STUB_BACKEND);
  });
});

describe('device_status reports the app identity the SOCKET actually holds (#88)', () => {
  // A fixed shared port (9095) means a stale backgrounded app can keep the socket after a fresh
  // app fails to bind — every device_* call then silently answers from the WRONG app. This is the
  // one-call check for that, so it must come from the device over the same lease every other
  // device_* call proxies through, not a value the MCP invents locally.

  it('connected + a bridge that answers app-identity: the app id appears in the report', async () => {
    const s = (surface = await loadDeviceSurface((req) => {
      if (req.path === '/api/device/status') {
        return { body: { state: 'connected', target: { host: '10.0.0.5', port: 9095, useAdb: false }, lastTarget: null } };
      }
      if (req.path === '/api/device/request') {
        const body = req.body as { method?: string } | undefined;
        if (body?.method === 'app-identity') {
          return deviceReply({ platform: 'android', appId: 'com.modokiengine.tropicalisland', appName: 'Tropical Island' });
        }
      }
      return undefined;
    }));
    const text = s.text(await s.call('device_status'));
    expect(text).toContain('com.modokiengine.tropicalisland');
    expect(text).toContain('Tropical Island');
    expect(text).toMatch(/reported by the device holding the socket/);
    const sent = s.real().find((q) => q.path === '/api/device/request');
    expect(sent?.body).toMatchObject({ method: 'app-identity' });
  });

  it('names the HARDWARE too, on its own line — which phone, not just which app (#146)', async () => {
    // Same probe, different question. `device_status` is the one-call "what am I connected to",
    // and on iOS this model is what decides the phone a WebDriverAgent launch targets — so an
    // agent debugging a wrong-device session can read it instead of inferring it.
    const s = (surface = await loadDeviceSurface((req) => {
      if (req.path === '/api/device/status') {
        return { body: { state: 'connected', target: { host: '10.0.0.5', port: 9095, useAdb: false }, lastTarget: null } };
      }
      if (req.path === '/api/device/request' && (req.body as { method?: string })?.method === 'app-identity') {
        return deviceReply({
          platform: 'ios', appId: 'com.modokiengine.audiodemo', appName: 'Audio Demo',
          deviceModel: 'iPhone18,4', osVersion: '26.5.2',
        });
      }
      return undefined;
    }));
    const text = s.text(await s.call('device_status'));
    expect(text).toMatch(/Device: iPhone18,4 \/ 26\.5\.2/);
    // Kept DISTINCT from the app line (conventions §2): a wrong-app session and a wrong-device
    // session are different failures with different fixes.
    expect(text).toMatch(/App: Audio Demo/);
    expectInOrder(text, ['App:', 'Device:'], 'device_status');
  });

  it('omits the hardware line for a bridge older than #146 rather than guessing', async () => {
    // Every installed app is in this state until redeployed. "Could not look" is never reported as
    // an answer (§5), and a fabricated model would be read by the host as a real one.
    const s = (surface = await loadDeviceSurface((req) => {
      if (req.path === '/api/device/status') {
        return { body: { state: 'connected', target: { host: '10.0.0.5', port: 9095, useAdb: false }, lastTarget: null } };
      }
      if (req.path === '/api/device/request' && (req.body as { method?: string })?.method === 'app-identity') {
        return deviceReply({ platform: 'ios', appId: 'com.modokiengine.audiodemo', appName: 'Audio Demo' });
      }
      return undefined;
    }));
    const text = s.text(await s.call('device_status'));
    expect(text).toMatch(/App: Audio Demo/);
    expect(text).not.toMatch(/Device:/);
  });

  it('a PRE-#88 bridge on the socket is reported as a warning, not swallowed', async () => {
    // Measured on the Samsung during the #88 close-out: with an old build squatting 9095, the
    // probe comes back `Unknown method: app-identity` — the device bridge signals a missing
    // handler by RETURNING the string, not throwing (see isDeviceError). This is precisely the
    // wrong-app scenario the probe exists for, because the squatter is by definition the older
    // build, so reporting nothing here would leave device_status silent exactly when it matters.
    const s = (surface = await loadDeviceSurface((req) => {
      if (req.path === '/api/device/status') {
        return { body: { state: 'connected', target: { host: '127.0.0.1', port: 9095, useAdb: true }, lastTarget: null } };
      }
      if (req.path === '/api/device/request') return deviceReply('Unknown method: app-identity');
      return undefined;
    }));
    const r = await s.call('device_status');
    expect(r.isError).toBeFalsy();               // still a report, not a tool failure
    const text = s.text(r);
    expect(text).toMatch(/App: UNKNOWN/);
    expect(text).toMatch(/predates\s+#88/);
    expect(text).toMatch(/grep modoki/);          // names the check that resolves it
    // It must NOT claim an identity it does not have.
    expect(text).not.toMatch(/reported by the device holding the socket/);
  });

  it('connected but the device/request call fails: degrades to no app line, not an error', async () => {
    const s = (surface = await loadDeviceSurface((req) => {
      if (req.path === '/api/device/status') {
        return { body: { state: 'connected', target: { host: '10.0.0.5', port: 9095, useAdb: false }, lastTarget: null } };
      }
      if (req.path === '/api/device/request') return { status: 500, body: { error: 'no client connected' } };
      return undefined;
    }));
    const r = await s.call('device_status');
    expect(r.isError).toBeFalsy();
    expect(s.text(r)).not.toMatch(/reported by the device holding the socket/);
  });

  it('disconnected: never probes for an app identity at all (nothing to ask)', async () => {
    const s = (surface = await loadDeviceSurface((req) => {
      if (req.path === '/api/device/status') return { body: { state: 'disconnected', target: null, lastTarget: null } };
      return undefined;
    }));
    await s.call('device_status');
    expect(s.real().some((q) => q.path === '/api/device/request')).toBe(false);
  });
});

describe('#1558 — device_native_logs gives the in-process read a budget sized from its window', () => {
  const nativeLogsParams = (s: DeviceSurface) =>
    (s.real().find((q) => q.path === '/api/device/request')?.body as { params?: Record<string, unknown> } | undefined)?.params;

  it('source:app forwards timeoutMs, so a long lookback is not cut off at the relay\'s fixed 5000ms', async () => {
    // Without it the router's deadline is the lease transport's default, and the transcripts show
    // every long `seconds` read ending "device request timed out after 5000ms".
    const s = (surface = await loadDeviceSurface((q) => (q.path === '/api/device/request' ? deviceReply(['line']) : undefined)));
    await s.call('device_native_logs', { seconds: 600 });
    expect(nativeLogsParams(s)?.timeoutMs).toBe(nativeLogsAppTimeoutMs(600));
    expect(nativeLogsAppTimeoutMs(600)).toBeGreaterThan(5_000);
  });

  it('source:system sends none — the router answers it host-side, before the device relay', async () => {
    const s = (surface = await loadDeviceSurface((q) => (q.path === '/api/device/request' ? deviceReply(['line']) : undefined)));
    await s.call('device_native_logs', { source: 'system', seconds: 10 });
    expect(nativeLogsParams(s)).toBeDefined();
    expect(nativeLogsParams(s)?.timeoutMs).toBeUndefined();
  });

  it('refuses a window or limit the native readers would turn into a silent "No logs." or a crash', async () => {
    // #1558 review: limit 0 crashed the iOS ring (removeFirst on empty); seconds < 1 is a start in
    // the FUTURE (empty on both platforms); a non-integer made Capacitor's getInt return nil, so
    // the window silently became 60 s; a huge one overflowed Android's -T into a malformed time.
    const s = (surface = await loadDeviceSurface());
    for (const bad of [{ limit: 0 }, { limit: 2.5 }, { seconds: 0 }, { seconds: -5 }, { seconds: 1.5 }, { seconds: 2_000_000_000 }]) {
      expect(s.validate('device_native_logs', bad).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(s.validate('device_native_logs', { limit: 1, seconds: 1 }).ok).toBe(true);
    expect(s.validate('device_native_logs', { seconds: 2_592_000 }).ok).toBe(true);
  });

  it('a logcat that rejected its arguments is refused as that, not as a missing permission', async () => {
    const reply = (error: string) => (q: { path: string }) => (q.path === '/api/device/request' ? deviceReply({ logs: [], error }) : undefined);
    const s = (surface = await loadDeviceSurface(reply('logcat exited 1 (-T -1234.-567)')));
    const r = await s.call('device_native_logs', {});
    expect(s.text(r)).toContain('NOT_AVAILABLE_HERE');
    expect(s.text(r)).toContain('logcat rejected the read itself');
    surface.restore();
    const denied = (surface = await loadDeviceSurface(reply('OSLogStore error: denied')));
    expect(denied.text(await denied.call('device_native_logs', {}))).not.toContain('logcat rejected');
  });

  it('the budget is bounded at both ends', () => {
    expect(nativeLogsAppTimeoutMs(0)).toBe(5_000);
    expect(nativeLogsAppTimeoutMs(-5)).toBe(5_000);
    expect(nativeLogsAppTimeoutMs(1_000_000)).toBe(20_000);
  });
});
