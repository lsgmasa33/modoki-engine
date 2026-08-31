/** #509 — the COMPOSED seam: `engine/app/ota.ts`'s mandatory gate driven through the REAL
 *  `checkForUpdate`, against a fake native plugin whose `getState()` actually reflects its own
 *  `activate()`.
 *
 *  Why a separate file from `ota.test.tsx`: that suite mocks `@modoki/engine/runtime` wholesale, so
 *  `checkForUpdate` never runs there. It proves outcome → gate; `otaClient.test.ts` proves native
 *  state → outcome. Neither can see the bug #509 actually was, which lives in the COMPOSITION —
 *  a second call reading durable state written by the first. A close-out review recorded this gap;
 *  this file closes it.
 *
 *  The race, reproduced exactly (see docs/ota-updates.md § "A staged mandatory update outlives the
 *  call that staged it"):
 *    1. Call A fetches the release, arms the mandatory gate via `onWillStage` (phase `downloading`),
 *       and is mid-`stageUpdate`.
 *    2. Call B starts — the `[gameId]` boot effect re-running on a game swap. The `ready-to-restart`
 *       short-circuit does NOT stop it (the gate is only `downloading`), and B's
 *       `++otaCheckGeneration` makes every later gate write from A a permanent no-op.
 *    3. A finishes: `activate()` writes `pending[shell] = v2`. A's own `ready-to-restart` write is
 *       swallowed by the generation guard.
 *    4. B reads native state and sees `pending === target`. Under the old code that collapsed to
 *       `up-to-date`, B resolved `true`, and `setGateIfCurrent(null)` cleared the gate out from
 *       under A — the game booted past a mandatory update.
 *
 *  Both hand-offs are deterministic (deferreds signalled from inside the fakes), never timer- or
 *  microtask-count-based, so this cannot flake into passing.
 *
 *  ⚠️ `ota.ts` keeps its gate and generation in module-level `let`s with no reset export, so each
 *  test takes a FRESH module instance via `vi.resetModules()` + dynamic `import()` — same reason
 *  `ota.test.tsx` does.
 *
 *  No JSX here; the file is `.test.tsx` because `engine/vite.config.ts`'s app-suite `include` only
 *  picks up `tests/app/**\/*.test.tsx`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';

const h = vi.hoisted(() => ({
  isNativePlatform: vi.fn(() => true),
  ota: { enabled: true, baseUrl: 'https://cdn.example.test/game', publicKey: '', bundleName: 'shell', engineApi: 1 },
  native: {} as Record<string, unknown>,
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: h.isNativePlatform },
  ExceptionCode: { Unimplemented: 'UNIMPLEMENTED' },
}));
vi.mock('virtual:modoki-project-config', () => ({ default: { ota: h.ota } }));
// Deliberately NOT mocking '@modoki/engine/runtime' — the real `checkForUpdate` is the point.
vi.mock('capacitor-modoki-ota', () => ({ ModokiOta: h.native }));

function toBase64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

/** Mirrors `signingPayload`'s sorted-key canonical JSON — same inline approach `otaClient.test.ts`
 *  takes, so this does not depend on the module's non-exported `sortKeysDeep`. */
function signedRelease(bundles: Record<string, string>, mandatory: boolean, privateKey: Uint8Array) {
  const unsigned = { schema: 1, bundles, mandatory, minEngineApi: 1 };
  const payload = new TextEncoder().encode(
    JSON.stringify({ bundles: unsigned.bundles, mandatory: unsigned.mandatory, minEngineApi: unsigned.minEngineApi, schema: unsigned.schema }),
  );
  return { ...unsigned, sig: toBase64url(ed25519.sign(payload, privateKey)) };
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function jsonResponse(body: unknown) {
  return { ok: true, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  vi.resetModules();
  h.isNativePlatform.mockReturnValue(true);
  h.ota.enabled = true;
});

describe('#509 the mandatory gate, composed through the real checkForUpdate', () => {
  it('a game-swap re-check during the download window cannot tear the gate down', async () => {
    const privateKey = ed25519.utils.randomSecretKey();
    h.ota.publicKey = toBase64url(ed25519.getPublicKey(privateKey));
    const release = signedRelease({ shell: 'v2' }, true, privateKey);
    const manifest = {
      schema: 1, name: 'shell', version: 'v2', engineApi: 1,
      files: { 'index.html': { hash: 'a'.repeat(64), size: 1 } },
      bundleZip: { hash: 'b'.repeat(64), size: 100 },
    };

    // The durable native state, shared by both calls — this is what the old code could not see.
    const state: { active: Record<string, string>; pending: Record<string, string>; bootAttempts: Record<string, number> } =
      { active: { shell: 'v1' }, pending: {}, bootAttempts: {} };

    const stageEntered = deferred();
    const stageGate = deferred();
    Object.assign(h.native, {
      addListener: async () => ({ remove: async () => {} }),
      getState: async () => ({ stateJSON: JSON.stringify(state) }),
      stageUpdate: async () => { stageEntered.resolve(); await stageGate.promise; },
      stageUpdateDelta: async () => { stageEntered.resolve(); await stageGate.promise; },
      // Mirrors the real plugin: writes `pending` and CLEARS `bootAttempts` (OtaPlugin.swift:368).
      activate: async ({ name, version }: { name: string; version: string }) => {
        state.pending[name] = version;
        delete state.bootAttempts[name];
      },
      confirmBoot: async () => {},
      listBundles: async () => ({ bundles: [] }),
    });

    // Call B must not read native state until A has activated — otherwise it is a different race.
    // Held at B's own release fetch, and signalled from inside the fetch stub.
    let releaseFetches = 0;
    const bReachedFetch = deferred();
    const bGate = deferred();
    globalThis.fetch = (async (url: string) => {
      const u = String(url);
      if (u.endsWith('/release.json')) {
        releaseFetches += 1;
        if (releaseFetches === 2) { bReachedFetch.resolve(); await bGate.promise; }
        return jsonResponse(release);
      }
      if (u.endsWith('/bundles/shell/v2/manifest.json')) return jsonResponse(manifest);
      // The embedded base manifest: 404 pushes checkForUpdate onto the whole-zip path, which keeps
      // this test about the gate rather than about delta diffing.
      return { ok: false, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;

    const ota = await import('../../app/ota');
    const snapshots: unknown[] = [];
    ota.subscribeOtaGate((s) => snapshots.push(s));

    const pA = ota.checkAppOtaUpdate();
    await stageEntered.promise; // A has armed the gate and is mid-download

    const pB = ota.checkAppOtaUpdate(); // the game swap — bumps the generation, silencing A
    await bReachedFetch.promise;

    stageGate.resolve();
    expect(await pA).toBe(false); // A staged a mandatory update...
    expect(state.pending).toEqual({ shell: 'v2' }); // ...and it is durable now

    bGate.resolve();
    // THE ASSERTION #509 IS ABOUT. Old behaviour: `pending === target` collapsed to `up-to-date`,
    // so B resolved `true` and cleared the gate — App.tsx would then load a scene behind it.
    expect(await pB).toBe(false);
    expect(snapshots[snapshots.length - 1]).toEqual({ phase: 'ready-to-restart', version: 'v2' });
  });

  it('but a device already RUNNING the staged mandatory update boots normally', async () => {
    // The brick direction, composed. `pending` survives the restart (promotion needs two
    // confirmBoots), so `pending === target` is ALSO true on the launches that are serving it —
    // `bootAttempts >= 1` is what tells the two apart. Gating here would hold `ready-to-restart`
    // forever on the very update that already applied.
    const privateKey = ed25519.utils.randomSecretKey();
    h.ota.publicKey = toBase64url(ed25519.getPublicKey(privateKey));
    const release = signedRelease({ shell: 'v2' }, true, privateKey);

    const state = { active: { shell: 'v1' }, pending: { shell: 'v2' }, bootAttempts: { shell: 1 } };
    Object.assign(h.native, {
      addListener: async () => ({ remove: async () => {} }),
      getState: async () => ({ stateJSON: JSON.stringify(state) }),
      stageUpdate: vi.fn(async () => {}),
      stageUpdateDelta: vi.fn(async () => {}),
      activate: vi.fn(async () => {}),
      confirmBoot: async () => {},
      listBundles: async () => ({ bundles: [] }),
    });
    globalThis.fetch = (async (url: string) =>
      String(url).endsWith('/release.json') ? jsonResponse(release) : ({ ok: false, json: async () => ({}) } as unknown as Response)
    ) as unknown as typeof fetch;

    const ota = await import('../../app/ota');
    const snapshots: unknown[] = [];
    ota.subscribeOtaGate((s) => snapshots.push(s));

    expect(await ota.checkAppOtaUpdate()).toBe(true);
    expect(snapshots[snapshots.length - 1]).toBe(null);
    // Nothing was re-staged — the short-circuit fired before any staging path.
    expect(h.native.activate).not.toHaveBeenCalled();
  });
});
