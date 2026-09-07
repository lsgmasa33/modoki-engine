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
 *  place, from BOTH directions plus the behaviour that actually matters.
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

// The 7 types `read-asset-def` (agentBridge.ts) actually serves: every `ASSET_SCHEMA_TYPES` entry
// except `material`, which that op refuses outright (a material's live cache holds only the
// compiled THREE.Material, not the authored JSON — see agentEditorOps.ts / agentBridge.ts).
const READ_ASSET_DEF_TYPES = ASSET_SCHEMA_TYPES.filter((t) => t !== 'material');

describe('the READ-asset-def enums (modoki + device) match what the op serves (#842/#843)', () => {
  let deviceSurface: DeviceSurface | undefined;
  afterEach(async () => { await deviceSurface?.restore(); deviceSurface = undefined; });

  it('modoki_read_asset_def\'s enum lists exactly the 7 served types, in both directions', () => {
    expect([...READ_ASSET_DEF_TYPES_FOR_TESTS].sort()).toEqual([...READ_ASSET_DEF_TYPES].sort());
  });

  it('device_read_asset_def\'s enum lists exactly the 7 served types, in both directions', () => {
    expect([...DEVICE_READ_ASSET_DEF_TYPES].sort()).toEqual([...READ_ASSET_DEF_TYPES].sort());
  });

  it('modoki_read_asset_def ACCEPTS every served type and REFUSES material', async () => {
    surface = loadSurface();
    for (const type of READ_ASSET_DEF_TYPES) {
      await expect(
        surface.call('modoki_read_asset_def', { path: `/assets/x.${type}.json`, type }),
        `modoki_read_asset_def refused type '${type}', which read-asset-def serves`,
      ).resolves.toBeDefined();
    }
    await expect(
      surface.call('modoki_read_asset_def', { path: '/assets/x.mat.json', type: 'material' }),
      'modoki_read_asset_def accepted \'material\', which read-asset-def deliberately refuses',
    ).rejects.toThrow();
  });

  it('device_read_asset_def ACCEPTS every served type and REFUSES material', async () => {
    deviceSurface = await loadDeviceSurface();
    for (const type of READ_ASSET_DEF_TYPES) {
      expect(
        deviceSurface.validate('device_read_asset_def', { path: `/assets/x.${type}.json`, type }).ok,
        `device_read_asset_def refused type '${type}', which read-asset-def serves`,
      ).toBe(true);
    }
    expect(
      deviceSurface.validate('device_read_asset_def', { path: '/assets/x.mat.json', type: 'material' }).ok,
      'device_read_asset_def accepted \'material\', which read-asset-def deliberately refuses',
    ).toBe(false);
  });
});
