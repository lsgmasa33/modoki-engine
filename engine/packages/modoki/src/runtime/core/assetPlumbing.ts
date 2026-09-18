/** Provider slot for the "GUID/path → fetchable URL" plumbing seam (P7 C10). Installed by
 *  `loaders/{assetUrl,assetFetch,shaderSchema}.ts` at composition time. Consumed by
 *  `rendering/pixiShaderBuilder.ts`, which needs to fetch a shader manifest + its raw WGSL/GLSL
 *  body over the asset-URL scheme without importing `loaders/` directly. */

import { createProviderSlot } from './providerSlot';
import type { ShaderManifest } from './shaderSchema';

export interface AssetPlumbing {
  assetUrl(path: string): string;
  /** Cache-policy fetch options — spread into `fetch(url, fetchInit)`. See
   *  `loaders/assetFetch.ts` for why dev/prod differ. */
  fetchInit: RequestInit;
  /** Resolves null when the manifest is NOT THERE or unusable (404/410, the SPA fallback, a parse
   *  error) — a failure the same bytes reproduce. REJECTS with a transient error
   *  (`AssetNetworkError`, or a non-absent `MissingAssetError`) when the server could not be
   *  reached or could not serve it, so the 2D material cache can back off instead of falling back
   *  for the rest of the scene (#1397). Unlike the public `fetchShaderManifest`, which flattens
   *  both to null. */
  fetchShaderManifest(path: string): Promise<ShaderManifest | null>;
}

export const assetPlumbing = createProviderSlot<AssetPlumbing>('assetPlumbing');
