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
  fetchShaderManifest(path: string): Promise<ShaderManifest | null>;
}

export const assetPlumbing = createProviderSlot<AssetPlumbing>('assetPlumbing');
