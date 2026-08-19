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
import { ASSET_TYPES_FOR_TESTS } from '../../tools/modoki-mcp/src/tools/assets';
import { loadSurface, type Surface } from './mcpSurface';

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
