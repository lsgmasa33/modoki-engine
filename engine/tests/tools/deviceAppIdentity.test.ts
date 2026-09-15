/** `handleAppIdentity` (`engine/app/debug/bridge.ts`, #88) — the device-side handler behind the
 *  MCP's `device_status` app-identity line (see `deviceToolSurface.test.ts` for the MCP-side
 *  merge). This is the ONLY place the handler itself lives, so a test against the MCP tool's stub
 *  backend cannot exercise it — it can only assert the tool relays whatever the (fake) device
 *  bridge returns.
 *
 *  WHY THIS MOCKS `@capacitor/app` RATHER THAN LEANING ON JSDOM. The first version of this suite
 *  asserted only the web/jsdom path, where `getInfo()` throws "Not implemented on web" and the
 *  handler falls back to an empty `appId`. That version PASSED against a handler gutted to
 *  `return { platform, appId: '', appName: '' }` with the `getInfo()` call deleted outright
 *  (mutation-checked during the #88 close-out). An assertion that cannot tell "the platform could
 *  not answer" apart from "the handler never asked" is not coverage of a handler whose entire job
 *  is to ask.
 *
 *  So the SUCCESS branch is pinned explicitly below. That branch is the one that matters: it is
 *  what lets `device_status` name the app actually holding the socket, which is the whole point of
 *  #88. Only the real native `getInfo()` (Android/iOS returning a true package id) still needs
 *  hardware — and that is a Capacitor guarantee, not ours. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { discoverProjects } from '../../scripts/projectRoots.mjs';
import { REPO_ROOT } from '../helpers/repoLayout';
import { readScannedSource } from '@modoki/engine/testing';
import { callsTo, findNodes, flatText, functionsNamed, importsIn, parseSource, referencesToPath, stringValueOf, ts } from '@modoki/engine/testing/sourceAst';

const getInfo = vi.fn();
vi.mock('@capacitor/app', () => ({ App: { getInfo: () => getInfo() } }));
const getDeviceHardware = vi.fn();
vi.mock('capacitor-game-debug', () => ({ GameDebug: { getDeviceHardware: () => getDeviceHardware() } }));

const { handleAppIdentity } = await import('../../app/debug/bridge');

describe('handleAppIdentity', () => {
  beforeEach(() => { getInfo.mockReset(); });

  it('reports the id and name the platform gives it — the branch device_status depends on', async () => {
    getInfo.mockResolvedValue({ id: 'com.modokiengine.court', name: 'Court', build: '1', version: '1.0' });

    const info = await handleAppIdentity();

    // The measured shape from the live Samsung lease (#88 close-out):
    //   {"platform":"android","appId":"com.modokiengine.court","appName":"Court"}
    expect(info.appId).toBe('com.modokiengine.court');
    expect(info.appName).toBe('Court');
    expect(getInfo).toHaveBeenCalledTimes(1); // it ASKED — a gutted handler fails here
  });

  it('never throws — an unanswerable platform degrades to an empty appId, not a rejection', async () => {
    // `@capacitor/app`'s web plugin throws "Not implemented on web" (verified against
    // node_modules/@capacitor/app/dist/esm/web.js). The handler must stay total: the router would
    // otherwise have to translate a rejection, and `device_status` treats a missing app line as
    // "unknown", never as a tool failure.
    getInfo.mockRejectedValue(new Error('Not implemented on web'));

    const info = await handleAppIdentity();

    expect(info.appId).toBe('');
    expect(info.appName).toBe('');
    expect(typeof info.platform).toBe('string'); // still reports the platform it DID know
  });
});

/** The hardware half (#146). These two strings are how the HOST tells which of its paired iPhones
 *  the lease is holding — the phone's `hw.machine` against devicectl's `productType` — so the
 *  handler failing to report them is a silent regression: the launcher simply falls back to
 *  guessing from what is plugged into the Mac, exactly as before the fix.
 *
 *  **It is read from `capacitor-game-debug`, and that source is the point.** The first version read
 *  `Capacitor.Plugins.Device` (`@capacitor/device`) — which NO Modoki project installs, so it
 *  returned nothing on every real device and the whole mechanism was inert while these tests
 *  passed against a mocked global. Mocking proves the handler asks; it cannot prove the thing it
 *  asks is there. Hence the guard below, which is about presence rather than behaviour. */
describe('handleAppIdentity — the leased device\'s hardware', () => {
  beforeEach(() => {
    getInfo.mockResolvedValue({ id: 'com.modokiengine.court', name: 'Court' });
    getDeviceHardware.mockReset();
  });

  it('reports the model and OS version the debug plugin gives it', async () => {
    // The shape from an iPhone Air: `model` is `hw.machine`, byte-identical to what devicectl
    // calls `hardwareProperties.productType`. That identity is the whole mechanism.
    getDeviceHardware.mockResolvedValue({ model: 'iPhone18,4', osVersion: '26.5.2' });

    const info = await handleAppIdentity();

    expect(info.deviceModel).toBe('iPhone18,4');
    expect(info.osVersion).toBe('26.5.2');
  });

  it('omits them when the plugin answers empty — never invents a model', async () => {
    // The web stub, and any platform that cannot read its own hardware. A fabricated model would
    // be worse than none: the host would refuse the launch as "wrong phone" on evidence nobody
    // produced, which is a confident wrong answer (conventions §0).
    getDeviceHardware.mockResolvedValue({ model: '', osVersion: '' });

    const info = await handleAppIdentity();

    expect(info.deviceModel).toBeUndefined();
    expect(info.osVersion).toBeUndefined();
    expect(info.appId).toBe('com.modokiengine.court');   // and the rest of the answer survives
  });

  it('survives a plugin OLDER than #146, which has no such method', async () => {
    // Capacitor rejects an unknown method rather than returning undefined. Every installed app is
    // in this state until it is redeployed, so this is the common case for a while, not an edge.
    getDeviceHardware.mockRejectedValue(new Error('getDeviceHardware is not implemented on ios'));

    const info = await handleAppIdentity();

    expect(info.deviceModel).toBeUndefined();
    expect(info.appId).toBe('com.modokiengine.court');
  });
});

/** The presence guard the mocked tests structurally cannot be: `capacitor-game-debug` ships in
 *  every leasable build, `@capacitor/device` ships in none. Reading source rather than behaviour is
 *  the only way to assert WHICH plugin is asked, since a mock answers either name happily. */
describe('the hardware probe reads a plugin that is actually present (#146)', () => {
  it('asks capacitor-game-debug, never @capacitor/device', () => {
    const probe = hardwareProbe(readScannedSource(path.join(__dirname, '../../app/debug/bridge.ts')).code, 'bridge.ts');
    expect(probe.imports).toContain('capacitor-game-debug');
    // The original bug, pinned by name: `@capacitor/device` is optional and no project installs it.
    expect(probe.deviceReads).toEqual([]);
  });

  it('reads the probe\'s own body, and every way it could reach the Device plugin (#1195)', () => {
    // The body used to run to the first '\n}', and the Device check was a regex over that text.
    const probe = (body: string) => hardwareProbe(`async function readDeviceHardware() {\n  const t = \`\n}\`;\n${body}\n}\nfunction other() { registerPlugin('Device'); return [Plugins.Device, import('@capacitor/device')]; }`, 'probe.ts');
    expect(probe("const { GameDebug } = await import('capacitor-game-debug');")).toEqual({ imports: ['capacitor-game-debug'], deviceReads: [] });
    expect(probe("const d = (window as any).Capacitor.Plugins?.Device;\nconst { Device } = await import('@capacitor/device');\nconst r = registerPlugin('Device');").deviceReads)
      .toEqual(['(window as any).Capacitor.Plugins?.Device', "import('@capacitor/device')", "registerPlugin('Device')"]);
    expect(probe("log('Plugins.Device is not used'); const x = Plugins.DeviceInfo; registerPlugin('GameDebug');").deviceReads).toEqual([]);
    expect(probe("const spec = '@capacitor/device';\nawait import(spec);\nloadPlugin(`@capacitor/device`);").deviceReads)
      .toEqual(["'@capacitor/device'", '`@capacitor/device`']);
    expect(() => hardwareProbe('function other() {}', 'probe.ts')).toThrow(/readDeviceHardware is gone or renamed/);
  });

  it('no Modoki project depends on @capacitor/device — the reason the first version was inert', () => {
    // If this ever fails, someone added the dependency to a project and the reasoning above needs
    // revisiting — not the code. Asserting the FACT keeps the comment honest.
    // Enumerate via the shared helper rather than walking `['games','demos']` by hand: the OSS
    // snapshot ships demos but NO `games/`, so a hand-rolled walk threw ENOENT there while every
    // dev clone stayed green — a red public `ci/main` for a tree-shape difference, not a bug.
    // `discoverProjects` skips absent roots by contract (see `scripts/projectRoots.mjs`).
    const withDevicePlugin: string[] = [];
    const projects = discoverProjects(REPO_ROOT);
    let read = 0;
    for (const proj of projects) {
      const file = path.join(proj.dir, 'package.json');
      // Only an ABSENT package.json is "not a workspace project". The old bare `catch {}` also
      // swallowed a malformed one, so a read that failed for every project passed (#1105).
      if (!existsSync(file)) continue;
      const pkg = JSON.parse(readFileSync(file, 'utf8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if ('@capacitor/device' in deps) withDevicePlugin.push(`${proj.root}/${proj.name}`);
      read++;
    }
    expect(withDevicePlugin).toEqual([]);
    // Non-vacuity floor (#1105), conditional and minimal: the public snapshot ships no projects, or
    // a two-demo `--with-demos` subset on CI, while this clone reads 25.
    if (projects.length > 0) {
      expect(read, 'no project package.json was read — discovery or the read is broken; fix it, do not delete this assertion')
        .toBeGreaterThan(0);
    }
  });
});

/**
 * What `readDeviceHardware` imports dynamically, and every way its body reaches the `@capacitor/device`
 * plugin — a `Plugins.Device` read (optional chains and a `Capacitor.` prefix included), an import of
 * `@capacitor/device`, or `registerPlugin('Device')` — as flat source text.
 *
 * All of it from the parser, inside the function's own body (#1193, #1195): the body used to be cut to
 * the first `'\n}'`, and the Device check was `/Plugins\?\.Device|@capacitor\/device/` over that text.
 */
function hardwareProbe(code: string, label: string): { imports: string[]; deviceReads: string[] } {
  const sf = parseSource(code, label);
  const fns = functionsNamed(sf, 'readDeviceHardware');
  expect(fns.length, 'readDeviceHardware is gone or renamed').toBe(1);
  const body = fns[0]!.body;
  const inBody = importsIn(sf).filter((e) => e.node.pos >= body.pos && e.node.end <= body.end);
  return {
    imports: inBody.filter((e) => e.kind === 'dynamic').map((e) => e.spec),
    deviceReads: [
      ...referencesToPath(body, 'Plugins.Device').map(flatText),
      ...inBody.filter((e) => e.spec === '@capacitor/device').map((e) => flatText(e.node)),
      ...callsTo(body, 'registerPlugin').filter((c) => stringValueOf(c.arguments[0]) === 'Device').map(flatText),
      // The specifier held in a string anywhere else — `const spec = '@capacitor/device'; await import(spec)` — which
      // the regex over the body saw and an import-edge reader does not (#1195 close-out review).
      ...findNodes(body, ts.isStringLiteralLike)
        .filter((s) => s.text.includes('@capacitor/device') && !inBody.some((e) => e.node.pos <= s.pos && s.end <= e.node.end))
        .map(flatText),
    ],
  };
}
