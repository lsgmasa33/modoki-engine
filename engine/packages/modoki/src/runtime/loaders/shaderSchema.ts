/** Shader parameter schema — network fetch half. The pure schema types + coercion helpers
 *  moved to `core/shaderSchema.ts` (P7 C10); re-exported here for existing callers. */

import { assetUrl } from './assetUrl';
import { ASSET_FETCH_INIT } from './assetFetch';
import { warnUnknownParamTypes, type ShaderManifest } from '../core/shaderSchema';

export {
  type ShaderParamType, type ShaderParam, type ShaderParamSchema, type ShaderManifest,
  shaderSpace, coerceParamValue, mergeParamDefaults,
} from '../core/shaderSchema';

/** Fetch + parse a `.shader.json` manifest. Returns null on network/parse failure.
 *  Lives here (no three deps) so both the runtime loader and the editor catalog
 *  can read schemas without pulling in the WebGPU material pipeline. */
export async function fetchShaderManifest(manifestPath: string): Promise<ShaderManifest | null> {
  try {
    const res = await fetch(assetUrl(manifestPath), ASSET_FETCH_INIT);
    if (!res.ok) return null;
    const json = (await res.json()) as ShaderManifest;
    if (!json.params) json.params = {};
    warnUnknownParamTypes(manifestPath, json.params);
    return json;
  } catch {
    return null;
  }
}
