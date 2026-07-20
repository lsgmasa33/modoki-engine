/** Single source of truth for `.mat.json` texture-slot field names.
 *
 *  These are the GUID-ref fields the runtime material loader reads
 *  (`meshTemplateCache.ts` does `loadInto(data.<slot>, …)` for each). Three surfaces
 *  MUST agree on this list, and deriving them all from here prevents the drift that
 *  once shipped station/fighter WITHOUT their normal/roughness/metalness maps:
 *   1. the runtime loader (meshTemplateCache loadInto calls),
 *   2. the build tree-shaker's material texture-slot probe (asset-tree-shaker MAP_FIELDS) —
 *      a slot it doesn't probe is stripped from the prod build and the map 404s at runtime,
 *   3. the editor schema (assetSchemas MATERIAL_FIELDS) that renders each as an asset-ref field.
 *
 *  The engine's `.mat.json` format names them `…Texture` (NOT the Three.js `…Map`
 *  names). Import-free so the build plugins can consume it. */
export const MATERIAL_TEXTURE_SLOTS = [
  'texture', 'alphaTexture', 'normalTexture', 'bumpTexture', 'displacementTexture',
  'roughnessTexture', 'metalnessTexture', 'emissiveTexture', 'aoTexture',
  'lightTexture', 'envTexture',
] as const;
