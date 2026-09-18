/** Shader parameter schema — network fetch half. The pure schema types + coercion helpers
 *  moved to `core/shaderSchema.ts` (P7 C10); re-exported here for existing callers. */

import { assetUrl } from './assetUrl';
import { ASSET_FETCH_INIT, parseAssetJson } from './assetFetch';
import { classifyLoadFailure, rethrowFetchFailure } from '../core/loadFailureMemo';
import { warnUnknownParamTypes, type ShaderManifest } from '../core/shaderSchema';

export {
  type ShaderParamType, type ShaderParam, type ShaderParamSchema, type ShaderManifest,
  shaderSpace, coerceParamValue, mergeParamDefaults, shaderBodyPath,
} from '../core/shaderSchema';

/** Fetch + parse a `.shader.json` manifest. Returns null on network/parse failure.
 *  Lives here (no three deps) so both the runtime loader and the editor catalog
 *  can read schemas without pulling in the WebGPU material pipeline. */
export async function fetchShaderManifest(manifestPath: string): Promise<ShaderManifest | null> {
  return fetchShaderManifestClassified(manifestPath).catch(() => null);
}

/** {@link fetchShaderManifest}, except a TRANSIENT failure (no response, a dropped body, a status
 *  other than 404/410) rejects instead of resolving null — the `assetPlumbing` contract, for the
 *  2D material cache's failure memo (#1397). An absent or unparseable manifest still resolves
 *  null: those the same bytes reproduce. */
export async function fetchShaderManifestClassified(manifestPath: string): Promise<ShaderManifest | null> {
  try {
    const res = await fetch(assetUrl(manifestPath), ASSET_FETCH_INIT).catch(rethrowFetchFailure(assetUrl(manifestPath)));
    // A missing asset arrives as 200 OK index.html (dev server SPA fallback) — parseAssetJson detects it.
    const json = (await parseAssetJson(res, manifestPath)) as ShaderManifest;
    if (!json.params) json.params = {};
    warnUnknownParamTypes(manifestPath, json.params);
    return json;
  } catch (e) {
    if (classifyLoadFailure(e) === 'transient') throw e;
    return null;
  }
}
