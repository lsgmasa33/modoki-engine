/** Single source of truth for asset-file type classification — shared by the build
 *  plugins (scanner `detectType`, tree-shaker `classify`, `readAssetGuid`) AND the
 *  editor/runtime (AssetRefField's `assetTypeFromPath`). Import-free (no fs/path/
 *  browser deps) so every layer can consume it.
 *
 *  Why it lives in the package (not plugins/): the build plugins already depend on
 *  the package (fontNaming, sceneValidation), so the dependency direction is
 *  plugins → package. Putting the classifier here lets the editor import it too
 *  without a package → plugins back-edge.
 *
 *  These classifiers used to be hand-maintained parallel lists that drifted:
 *  `.anim.json` was added to the scanner but not the tree-shaker, so Animator
 *  keyframe clips shipped in dev but were shaken out of prod builds. Adding a new
 *  asset kind is now ONE entry here, picked up everywhere. */

/** JSON asset kinds keyed by filename suffix. Each `.<kind>.json` file also carries
 *  its GUID in a top-level `id` field (see ID_BEARING_TYPES). */
export const JSON_ASSET_SUFFIX_TYPE: ReadonlyArray<readonly [suffix: string, type: string]> = [
  ['.atlas.json', 'atlas'],
  ['.mesh.json', 'mesh'],
  ['.mat.json', 'material'],
  ['.prefab.json', 'prefab'],
  ['.shader.json', 'shader'],
  ['.particle.json', 'particle'],
  ['.animset.json', 'animset'],
  ['.spriteanim.json', 'spriteanim'],
  ['.rig2d.json', 'rig2d'],
  ['.anim.json', 'animation'],
  ['.level.json', 'level'],
  ['.wave.json', 'wave'],
  ['.timeline.json', 'timeline'],
];

/** Classify a JSON asset by filename suffix. Returns the asset type, or null when
 *  no specific JSON asset kind matches (the caller applies its own scene /
 *  unknown-json / binary fallback, which differs per consumer). */
export function classifyJsonAssetSuffix(pathOrName: string): string | null {
  for (const [suffix, type] of JSON_ASSET_SUFFIX_TYPE) {
    if (pathOrName.endsWith(suffix)) return type;
  }
  return null;
}

/** Shippable BINARY asset kinds keyed by extension — the GUID-referenced runtime
 *  assets whose type BOTH the scanner and the tree-shaker must agree on (drift here
 *  is the exact `.anim.json` failure via the binary path: a kind the scanner ships
 *  but the tree-shaker classifies 'other' is dropped from the prod build).
 *
 *  Deliberately EXCLUDES:
 *   - `.obj`/`.dae` — convertible IMPORT SOURCES (normalized to GLB on import);
 *     scenes reference the GLB, never the source, so they're scanner-only extras.
 *   - `.wgsl`/`.glsl` — shader SOURCE, a distinct concern handled explicitly by the
 *     tree-shaker; not a GUID-referenced runtime asset. */
export const BINARY_EXT_TYPE: Readonly<Record<string, string>> = {
  '.glb': 'model', '.gltf': 'model', '.fbx': 'model',
  '.png': 'texture', '.jpg': 'texture', '.jpeg': 'texture', '.webp': 'texture',
  '.hdr': 'environment', '.exr': 'environment',
  '.ttf': 'font', '.otf': 'font', '.woff': 'font', '.woff2': 'font',
  // Audio: any cross-platform-safe source is a valid runtime asset. The converter
  // (later) defaults to MP3 but the runtime is format-agnostic — see docs/audio-plan.md.
  '.mp3': 'audio', '.m4a': 'audio', '.aac': 'audio', '.wav': 'audio', '.ogg': 'audio', '.flac': 'audio',
};

/** Asset types whose GUID lives in the file's OWN top-level `id` (JSON assets), as
 *  opposed to a `<file>.meta.json` sidecar (binary assets). Derived from the JSON
 *  suffix table plus `scene` (scenes are JSON with a top-level `id` but matched by
 *  directory convention, not a distinct suffix). Consumed by readAssetGuid /
 *  writeAssetGuid so the id-source list can't drift from the classifier. */
export const ID_BEARING_TYPES: ReadonlySet<string> = new Set<string>([
  ...JSON_ASSET_SUFFIX_TYPE.map(([, type]) => type),
  'scene',
]);
