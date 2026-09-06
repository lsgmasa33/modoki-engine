/** FORMAT version of an `assets.manifest.json` document. Written by every producer,
 *  and checked by the sub-game loader before it merges a fragment — a merge has no
 *  undo, so a manifest we cannot interpret must be refused BEFORE it lands.
 *
 *  Deliberately its OWN file, with zero imports: `assetManifest.ts` (where this
 *  constant conceptually belongs, next to `AssetManifestFile`) transitively imports
 *  `assetFetch.ts`/`assetUrl.ts`, which touch browser-only globals (`window`,
 *  `location`, `import.meta.env`). `vite-asset-scanner.ts` — a Node-context Vite
 *  plugin, reached from `vite.config.ts` under `tsconfig.node.json` (no DOM lib, no
 *  `vite/client` types) — needs this same version number to stamp the manifests it
 *  writes, and importing it from `assetManifest.ts` directly would drag that whole
 *  browser-only import graph into the Node-lib compilation and fail typecheck. This
 *  file is the shared, side-effect-free source both sides import from. */
export const ASSET_MANIFEST_VERSION = 2;
