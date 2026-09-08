/** Guards the ADDITIVE-load invariant for the `manifest-updated` handler `initAgentBridge`
 *  registers off the Electron bridge (see the `bridge.on('manifest-updated', ...)` block in
 *  `app/debug/agentBridge.ts`, added for #503): it must call `loadManifestJson` WITHOUT
 *  `{ prune: true }`, because `createEditor.tsx`'s own load is the sole authority that a missing
 *  guid means a deleted asset. A future edit that adds `prune: true` here — e.g. "simplify, just
 *  treat every payload as a full rescan" — would let a late/stale IPC payload delete a guid that
 *  was only briefly absent from IT, not from the project; this test breaks on that edit, by
 *  asserting a guid registered from elsewhere survives a payload that doesn't mention it.
 *
 *  ⚠️ This is NOT regression cover for #503 itself, and the file used to claim it was — that claim
 *  was backwards. #503's bug was the handler being registered `if (!hot)` only, so in Electron DEV
 *  (`import.meta.hot` truthy) the handler was never registered at all. `import.meta.hot` is a
 *  per-module STATIC binding baked in at compile time, not a value `initAgentBridge` takes as a
 *  parameter — so no vitest module under the natural `node`/`jsdom` environment can ever observe it
 *  truthy, and this file cannot reach the configuration #503's bug lived in. Concretely: reverting
 *  `agentBridge.ts` to the OLD `if (!hot) { bridge.on('manifest-updated', ...) }` gate and rerunning
 *  this suite still passes, because vitest's `import.meta.hot` reads `undefined`, so `!hot` is
 *  `true` and the old code registers the handler exactly as the new code does — the two
 *  configurations are indistinguishable from here. Do NOT refactor `agentBridge.ts` to accept an
 *  injectable `hot` just to close that gap; that is a separate, out-of-scope change.
 *
 *  #503's actual verification was a live MCP check in the running Electron dev editor (per
 *  CLAUDE.md § "Debug Tools (MCP)" — "Verifying a change to the MCP surface — YOU run the live
 *  gate, nobody else"): a live run confirmed `create_asset` → `particle_set` back-to-back, with no
 *  sleep and no retry, succeeded — the real reproduction of the ~1s window this fix closes, in the
 *  one configuration (Electron dev) a unit test cannot reach. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { registerAllTraits } from '../../app/ecs/registerTraits';
import { getGuidForPath, loadManifestJson, unregisterAsset } from '@modoki/engine/runtime';

registerAllTraits();

type Handler = (data: unknown) => void;

function fakeBridge() {
  const handlers = new Map<string, Handler[]>();
  return {
    bridge: {
      on: (event: string, cb: Handler) => {
        const list = handlers.get(event) ?? [];
        list.push(cb);
        handlers.set(event, list);
      },
      send: vi.fn(),
    },
    emit: (event: string, payload: unknown) => {
      for (const cb of handlers.get(event) ?? []) cb(payload);
    },
    has: (event: string) => (handlers.get(event)?.length ?? 0) > 0,
  };
}

const TEST_GUID = '11111111-1111-4111-8111-111111111111';
const OTHER_GUID = '22222222-2222-4222-8222-222222222222';
const OTHER_PATH = '/assets/particles/unrelated.particle.json';

describe('agentBridge manifest-updated handler loads additively, never pruning (#503)', () => {
  let win: typeof window & { __modokiElectron?: { bridge?: unknown } };

  beforeEach(() => {
    win = window as typeof window & { __modokiElectron?: { bridge?: unknown } };
    delete win.__modokiElectron;
  });

  afterEach(() => {
    unregisterAsset(TEST_GUID);
    unregisterAsset(OTHER_GUID);
    delete win.__modokiElectron;
  });

  it('loads a manifest-updated payload additively — an unmentioned guid survives', async () => {
    // A guid registered from a PREVIOUS manifest load (e.g. an earlier scan) — must survive
    // a later additive load that doesn't mention it. Seeded via `loadManifestJson` itself
    // (not a direct `registerAsset`) so it lands in `_manifestGuids`, the very set the prune
    // pass below would walk — a `registerAsset` seed would never be at risk from `{ prune:
    // true }` in the first place, since the prune pass only considers guids IT registered.
    loadManifestJson({ version: 1, assets: [{ guid: OTHER_GUID, path: OTHER_PATH, type: 'particle' }] });

    const { bridge, emit, has } = fakeBridge();
    win.__modokiElectron = { bridge };

    const { initAgentBridge } = await import('../../app/debug/agentBridge');
    initAgentBridge();

    expect(has('manifest-updated')).toBe(true);
    expect(getGuidForPath('/assets/particles/probe.particle.json')).toBeUndefined();

    emit('manifest-updated', {
      assets: [{ guid: TEST_GUID, path: '/assets/particles/probe.particle.json', type: 'particle' }],
    });

    expect(getGuidForPath('/assets/particles/probe.particle.json')).toBe(TEST_GUID);
    // Additive load: no `{ prune: true }` — a payload naming only the new asset must not
    // delete a guid it simply didn't mention.
    expect(getGuidForPath(OTHER_PATH)).toBe(OTHER_GUID);
  });

  it('does nothing when there is no Electron bridge (browser dev/build)', async () => {
    const { initAgentBridge } = await import('../../app/debug/agentBridge');
    expect(() => initAgentBridge()).not.toThrow();
  });
});
