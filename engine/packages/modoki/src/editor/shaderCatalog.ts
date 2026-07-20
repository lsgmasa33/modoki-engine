/** Editor-only catalog of shaders selectable in the material inspector. Merges
 *  the two built-in standard shaders, code-registered custom shaders (from the
 *  runtime registry), and file-based shader assets (from the asset manifest).
 *
 *  An option's `value` doubles as the material's shader reference:
 *    - builtin → 'pbr' | 'unlit' (written to the material's `type`)
 *    - code    → the registered shader name (e.g. "space-console/stripes")
 *    - file    → the shader asset's guid (resolves to its .shader.json)
 *  Map a material back to its option with {@link optionValueForMaterial}. */

import { getRegisteredShaderNames, getCustomShaderSchema } from '../runtime/loaders/customShaders';
import { getAllAssets, resolveRef, isGuid } from '../runtime/loaders/assetManifest';
import { fetchShaderManifest, type ShaderParamSchema } from '../runtime/loaders/shaderSchema';

export type ShaderKind = 'builtin' | 'code' | 'file';

export interface ShaderOption {
  label: string;
  value: string;
  kind: ShaderKind;
}

function labelFromPath(path: string): string {
  const base = path.split('/').pop() || path;
  return base.replace(/\.shader\.json$/i, '');
}

/** All shaders selectable for a material, in display order. */
export function listShaderOptions(): ShaderOption[] {
  const opts: ShaderOption[] = [
    { label: 'Standard', value: 'pbr', kind: 'builtin' },
    { label: 'Unlit', value: 'unlit', kind: 'builtin' },
  ];
  for (const name of getRegisteredShaderNames()) {
    opts.push({ label: name, value: name, kind: 'code' });
  }
  for (const asset of getAllAssets()) {
    if (asset.type === 'shader') {
      opts.push({ label: labelFromPath(asset.path), value: asset.guid, kind: 'file' });
    }
  }
  return opts;
}

/** The option value representing a material's current shader selection. */
export function optionValueForMaterial(data: Record<string, unknown>): string {
  const type = (data.type as string) ?? 'pbr';
  if (type === 'unlit') return 'unlit';
  if (type === 'custom') return (data.shader as string) ?? 'pbr';
  return 'pbr';
}

/** Translate a chosen option value into the material fields to write. Returns the
 *  new `type` and (for custom shaders) the `shader` ref. */
export function materialFieldsForOption(value: string): { type: string; shader?: string } {
  if (value === 'pbr') return { type: 'pbr' };
  if (value === 'unlit') return { type: 'unlit' };
  return { type: 'custom', shader: value };
}

/** Param schema for an option, or null for built-in shaders (the inspector renders
 *  their fixed field sets instead). Code shaders return their registered schema;
 *  file shaders fetch their .shader.json. */
export async function resolveShaderSchema(opt: { kind: ShaderKind; value: string }): Promise<ShaderParamSchema | null> {
  if (opt.kind === 'builtin') return null;
  if (opt.kind === 'code') return getCustomShaderSchema(opt.value) ?? null;
  // file shader: value is a guid (or a live path) → resolve to the .shader.json.
  // Only route GUIDs through resolveRef; a path is used as-is (resolveRef rejects
  // internal paths loudly).
  const path = isGuid(opt.value) ? resolveRef(opt.value) : opt.value;
  if (!path) return null;
  const manifest = await fetchShaderManifest(path);
  return manifest?.params ?? null;
}
