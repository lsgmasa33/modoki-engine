/** `scene-changed`'s `kind` is a PROTOCOL-supplied key into a code-declared table (#993).
 *
 *  `ASSET_CACHE_INVALIDATORS` in `app/debug/agentBridge.ts` is a code-declared literal, and
 *  `msg.kind` arrives on the device-debug / HMR broadcast. So `kind: "constructor"` used to
 *  resolve to `Object.prototype.constructor` — truthy, so the `if (invalidateCachedAsset)` guard
 *  passed — and the very next line CALLS it: `Object(urlPath)`. The looked-up value being
 *  INVOKED is what makes this the sharpest read in #993's family after scroll-demo's URL param.
 *
 *  ⚠️ The observable is WHICH BRANCH RAN, read off `sceneManager.getCurrent`. Two things it is
 *  deliberately NOT read off:
 *   - the invalidator being called — with the bug the branch calls `Object(urlPath)` instead, so
 *     "no invalidator ran" is true either way and the assertion could not fail;
 *   - `fireDirtyListeners()` at the end of that branch — measured: it never lands here, because
 *     the `await dropParkedWriteFor()` one line above does `await import('@modoki/engine/editor')`
 *     and that import does not resolve under vitest. Anything after it is unreachable from a test.
 *
 *  So: the asset-cache branch returns BEFORE the scene-reload path, and an unrecognised kind must
 *  fall through TO it. `getCurrent` is the first thing that path touches.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sceneManager } from '@modoki/engine/runtime';

const PROTO_KEYS = [
  '__proto__', 'constructor', 'toString', 'valueOf',
  'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString',
] as const;

const REAL_KINDS = [
  'particle', 'animation', 'timeline', 'spriteanim', 'rig2d', 'animset', 'material', 'shader',
] as const;

type Handler = (data: unknown) => void;
type Win = typeof window & { __modokiElectron?: { bridge?: unknown } };

/** Emit one `scene-changed` and report whether it fell through to the scene-reload path. */
async function fellThroughToSceneReload(kind: unknown): Promise<boolean> {
  const win = window as Win;
  const handlers = new Map<string, Handler[]>();
  win.__modokiElectron = {
    bridge: {
      on: (event: string, cb: Handler) => { handlers.set(event, [...(handlers.get(event) ?? []), cb]); },
      send: vi.fn(),
    },
  };
  const { initAgentBridge } = await import('../../app/debug/agentBridge');
  initAgentBridge();
  expect(handlers.has('scene-changed')).toBe(true);

  const getCurrent = vi.spyOn(sceneManager, 'getCurrent').mockReturnValue(null);
  try {
    for (const cb of handlers.get('scene-changed') ?? []) {
      cb({ urlPath: '/games/g/assets/x.particle.json', kind });
    }
    await Promise.resolve(); await Promise.resolve();
    return getCurrent.mock.calls.length > 0;
  } finally {
    getCurrent.mockRestore();
  }
}

describe('agentBridge scene-changed kind vocabulary (#993)', () => {
  let win: Win;
  beforeEach(() => { win = window as Win; delete win.__modokiElectron; });
  afterEach(() => { delete win.__modokiElectron; });

  it.each(PROTO_KEYS)('kind %s is NOT an invalidator — it falls through, and nothing is invoked', async (kind) => {
    await expect(fellThroughToSceneReload(kind)).resolves.toBe(true);
  });

  it('an ordinary unknown kind falls through too', async () => {
    expect(await fellThroughToSceneReload('partcile')).toBe(true);
  });

  // ⚠️ ACCEPT SIDE. A guard that rejected everything would pass every case above while making the
  // whole invalidator table dead — the exact #74 symptom it exists to end ("my edit was ignored"),
  // and one no other assertion here would notice.
  it.each(REAL_KINDS)('ACCEPT: kind %s still takes the asset-cache branch and returns there', async (kind) => {
    expect(await fellThroughToSceneReload(kind)).toBe(false);
  });
});
