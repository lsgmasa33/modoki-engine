/** The asset-type list is ONE list, and the copy that cannot import it must not drift (#259).
 *
 *  There used to be three hand-kept copies: the engine's `AssetSchemaType` union, the backend
 *  router's `ASSET_SCHEMA_TYPES`, and the MCP tools' `ASSET_TYPES`. Two of them had already
 *  drifted NARROWER than the schemas they describe, and the failure is not cosmetic on this
 *  surface: the router advertised a wrong `valid: …` set in its own 400s, and the MCP's zod enum
 *  REFUSED a type the backend serves — which is how `modoki_asset_schema {type:'timeline'}` came
 *  to be rejected by the very tools that tell an agent to call it.
 *
 *  Two copies are now gone: the union is derived from `ASSET_SCHEMA_TYPES` (so `SCHEMAS`, being a
 *  `Record<AssetSchemaType, …>`, makes a missing schema a compile error), and the router imports
 *  it. The MCP package genuinely cannot import it — it bundles standalone with its own
 *  node_modules and pulls nothing from the engine — so this guard is what holds that last copy in
 *  place, from BOTH directions.
 *
 *  ⚠️ **Scope, after #855: this file compares the enums to the SCHEMA LIST, never to an op.**
 *  `ASSET_SCHEMA_TYPES` is a legitimate subject for the `modoki_asset_schema`/`modoki_create_asset`
 *  enum, because `SCHEMAS` is keyed by it — the constant IS the thing those tools serve. It is NOT
 *  a legitimate subject for `read-asset-def`, whose served set is a property of a dispatch chain in
 *  two other files; deriving that here from a hand-maintained exemption map is what made this guard
 *  unfalsifiable and pushed `de3cdce48` the wrong way. That half now lives with each op — see the
 *  comment above the second describe below.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { ASSET_SCHEMA_TYPES } from '../../packages/modoki/src/runtime/assets/assetSchemas';
import { ASSET_TYPES_FOR_TESTS, READ_ASSET_DEF_TYPES_FOR_TESTS } from '../../tools/modoki-mcp/src/tools/assets';
import { DEVICE_READ_ASSET_DEF_TYPES } from '../../tools/game-debug-mcp/src/mcp-tools';
import { loadSurface, type Surface } from './mcpSurface';
import { loadDeviceSurface, type DeviceSurface } from './deviceSurface';

let surface: Surface | undefined;
afterEach(() => { surface?.restore(); surface = undefined; });

describe('the MCP asset-type enum matches the engine schema list', () => {
  it('lists exactly the same types, in both directions', () => {
    // Sorted, because agreeing on the SET is the contract; the order is each file's own business.
    expect([...ASSET_TYPES_FOR_TESTS].sort()).toEqual([...ASSET_SCHEMA_TYPES].sort());
  });

  it('every engine asset type is ACCEPTED by the tools that take one', async () => {
    // The list is only worth keeping in sync because tools validate against it. A const-to-const
    // comparison alone would still pass if a tool hardcoded its own enum, so drive the real zod
    // validation — `surface.call` validates args through each tool's registered shape, exactly as
    // the MCP transport does.
    surface = loadSurface();
    for (const type of ASSET_SCHEMA_TYPES) {
      await expect(
        surface.call('modoki_asset_schema', { type }),
        `modoki_asset_schema refused type '${type}', which assetSchemas.ts serves`,
      ).resolves.toBeDefined();
      await expect(
        surface.call('modoki_create_asset', { type, path: `/assets/x.${type}.json` }),
        `modoki_create_asset refused type '${type}', which assetSchemas.ts serves`,
      ).resolves.toBeDefined();
    }
  });

  it('a type the engine does NOT serve is refused', async () => {
    // The guard has to fail in the other direction too, or "accepts everything" would pass it.
    surface = loadSurface();
    await expect(surface.call('modoki_asset_schema', { type: 'not-an-asset-type' })).rejects.toThrow();
  });
});

// What `read-asset-def` serves is NOT decided here any more (#855). This file used to derive it:
//
//     const READ_ASSET_DEF_TYPES = ASSET_SCHEMA_TYPES.filter((t) => !(t in NOT_READABLE));
//
// — a hand-maintained exemption map subtracted from a sibling constant, with nothing in the file
// ever calling the op. So every assertion compared one derived constant against another and the
// guard could not fail for the reason it existed; when #831 grew the schema list, the cheapest way
// to green was to widen the enums, and `de3cdce48` widened them to `atlas`, which the op has no arm
// for. A tool that ACCEPTS a type it cannot serve is worse than one that refuses it.
//
// The enum is now pinned against the OP, by probing it, in the two files that can each reach one:
//   - `tests/editor/readAssetDef.test.ts`        — modoki_read_asset_def vs agentEditorOps.ts
//   - `tests/framework/liveLifecycleOps.test.ts` — device_read_asset_def vs agentBridge.ts
// (Two files because `registerAgentOp` is register-or-replace on one Map and the editor
// registration is one-shot — see `tests/tools/readAssetDefServed.ts`.)
//
// What stays HERE is the half this file can honestly observe: that the shipped tools are
// registered with that enum and validate against it. That is not parity with the op — it is
// parity with the transport, and it is the `modoki_prefab` class (400'd on every call for months
// with a green suite because no test ever loaded the real tool surface).

describe('the READ-asset-def tools validate against their own enum (#842/#843)', () => {
  let deviceSurface: DeviceSurface | undefined;
  afterEach(async () => { await deviceSurface?.restore(); deviceSurface = undefined; });

  it('modoki_read_asset_def ACCEPTS every type it lists, and REFUSES material', async () => {
    surface = loadSurface();
    for (const type of READ_ASSET_DEF_TYPES_FOR_TESTS) {
      await expect(
        surface.call('modoki_read_asset_def', { path: `/assets/x.${type}.json`, type }),
        `modoki_read_asset_def refused type '${type}', which it advertises`,
      ).resolves.toBeDefined();
    }
    await expect(
      surface.call('modoki_read_asset_def', { path: '/assets/x.mat.json', type: 'material' }),
      'modoki_read_asset_def accepted \'material\', which read-asset-def deliberately refuses',
    ).rejects.toThrow();
  });

  it('modoki_read_asset_def REFUSES atlas at zod — de3cdce48\'s regression, pinned at the surface', async () => {
    // The shipped consequence of the widening: the call passed validation and died at the backend,
    // with the tool description advertising `.atlas.json`. `atlas` is a real ASSET_SCHEMA_TYPES
    // entry and a real `modoki_create_asset` type, so "it is not an asset type" would be wrong —
    // it is specifically not a READABLE one.
    surface = loadSurface();
    await expect(
      surface.call('modoki_read_asset_def', { path: '/assets/x.atlas.json', type: 'atlas' }),
    ).rejects.toThrow();
    await expect(surface.call('modoki_create_asset', { type: 'atlas', path: '/assets/x.atlas.json' }))
      .resolves.toBeDefined();
  });

  it('device_read_asset_def ACCEPTS every type it lists, and REFUSES material', async () => {
    deviceSurface = await loadDeviceSurface();
    for (const type of DEVICE_READ_ASSET_DEF_TYPES) {
      expect(
        deviceSurface.validate('device_read_asset_def', { path: `/assets/x.${type}.json`, type }).ok,
        `device_read_asset_def refused type '${type}', which it advertises`,
      ).toBe(true);
    }
    expect(
      deviceSurface.validate('device_read_asset_def', { path: '/assets/x.mat.json', type: 'material' }).ok,
      'device_read_asset_def accepted \'material\', which read-asset-def deliberately refuses',
    ).toBe(false);
  });

  it('device_read_asset_def REFUSES atlas at zod too', async () => {
    deviceSurface = await loadDeviceSurface();
    expect(deviceSurface.validate('device_read_asset_def', { path: '/assets/x.atlas.json', type: 'atlas' }).ok)
      .toBe(false);
  });
});
