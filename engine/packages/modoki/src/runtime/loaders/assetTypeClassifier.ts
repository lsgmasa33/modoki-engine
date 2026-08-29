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
  // Scenes are positively identified by suffix, like every other JSON asset kind
  // (issue #54) — before this, `detectType`'s JSON classification ended in a
  // catch-all that guessed ANY uncategorized `.json` under an asset root was a
  // scene, which misclassified e.g. Court's `assets/levels/index.json`. New scenes
  // are `.scene.json`; a plain `.json` under a `/scenes/` directory is still
  // accepted as a LEGACY fallback (see `detectType`'s comment).
  ['.scene.json', 'scene'],
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
  // Court's puzzle level data (regions/civilians/solution) — a pure-data leaf, same
  // shape as Sling's `.level.json`/`.wave.json`: no embedded asset refs, so the
  // tree-shaker's default "leaf" handling is correct with no extra walk branch.
  ['.court.json', 'court-level'],
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
  // Video: follows AUDIO's shape, not the model one — the SOURCE keeps the GUID and
  // the converter emits a `~video.mp4` variant beside it, so every accepted source
  // container is itself a runtime asset. (Contrast `.obj`/`.dae`, excluded above
  // because import NORMALIZES them into a different file that scenes reference.)
  // Output is always H.264/mp4 regardless of input — the only codec the iOS
  // WKWebView plays. See docs/video.md.
  '.mp4': 'video', '.mov': 'video', '.m4v': 'video', '.webm': 'video', '.mkv': 'video',
};

/** Classify a BINARY asset by file extension — the mirror of {@link classifyJsonAssetSuffix},
 *  over {@link BINARY_EXT_TYPE}. Returns null when the extension is not a shippable binary
 *  asset kind (the caller applies its own fallback).
 *
 *  Exists so a CONSUMER can share the table without importing node's `path` to split the
 *  extension itself — which is what pushed `AssetRefField.assetTypeFromPath` into hand-writing
 *  a parallel regex ladder that then drifted (#417): it silently labelled `.fbx`, `.exr` and
 *  every video container 'unknown' while the build classified them correctly. */
export function classifyBinaryExt(pathOrName: string): string | null {
  const base = pathOrName.slice(pathOrName.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot < 0) return null;
  return BINARY_EXT_TYPE[base.slice(dot).toLowerCase()] ?? null;
}

/** Asset types whose GUID lives in the file's OWN top-level `id` (JSON assets),
 *  as opposed to a `<file>.meta.json` sidecar (binary assets). `scene` now comes
 *  from the JSON suffix table itself (`.scene.json`, issue #54) rather than being
 *  appended by hand. Consumed by readAssetGuid / writeAssetGuid so the id-source
 *  list can't drift from the classifier. */
export const ID_BEARING_TYPES: ReadonlySet<string> = new Set<string>(
  JSON_ASSET_SUFFIX_TYPE.map(([, type]) => type),
);
