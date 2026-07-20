# Model Import & LOD

> Status: **shipped (v1)**.

How modoki turns a source `.glb` into runtime-ready meshes, materials, and a
baked level-of-detail (LOD) chain. See also [Architecture](./architecture.md),
[Rendering](./rendering.md), and the [Texture Pipeline](./textures.md).

## Overview

`importModel()` (editor side) loads a GLB, extracts textures, deduplicates
materials, writes `.mesh.json` + `.mat.json` asset files, and spawns ECS
entities. A model can provide a **postprocessor** (a `ModelPostprocessor`,
selected per-model via the `postprocessor` field in the GLB's `.meta.json`)
with three hooks:

- `filterMesh(mesh)` — return `false` to drop a mesh (e.g. a ground plane).
- `fixupMesh(mesh)` — mutate material factors / geometry attributes at import
  (e.g. synthesize grass UVs).
- `resolveImportOptions(templates, materialDir)` — return `{ excludeMeshes?,
  materialOverrides? }` for import-time mesh exclusions + material overrides
  (e.g. `weed → weed_green.mat.json`).

Material paths named in `materialOverrides` are **protected** — they are not
overwritten during the dedup pass.

At runtime the postprocessor's `fixupMesh` / `filterMesh` hooks are **not**
re-run — fixups are baked into the converted GLB (Stage A below), and the
runtime is purely a consumer of the baked artifact. Editor flows that re-derive
`.mesh.json` / `.mat.json` from a fresh parse pass `applyPostprocessorHooks:
true` to `loadModelTemplates()`.

## Two-stage conversion pipeline

Conversion runs in Node (dev server + `vite build`) via `execFileSync`, driven
by `convertModel()` in `plugins/model-convert.ts`. Per source GLB:

### Stage A — fixup baking

`plugins/model-convert/threeAdapter.ts` is a Node-side adapter that converts a
`@gltf-transform/core` `Document` into real `THREE.Mesh` instances so the
browser-shaped `ModelPostprocessor.fixupMesh(mesh)` interface runs unchanged
server-side:

- `loadGlbToThreeMeshes(absPath)` → `{ doc, meshes: { threeMesh, primitive,
  node }[] }`. It iterates **Nodes** (not Meshes), building one `THREE.Mesh` per
  `Node → Primitive` so the loader's name-based dispatch sees the per-instance
  node name (matches `GLTFLoader.traverse`).
- The postprocessor's `resolveImportOptions` / `filterMesh` decide what to drop;
  `fixupMesh` mutates the THREE meshes.
- `applyChangesToDocument(loaded, excludedNames)` writes the mutations back into
  the gltf-transform primitives and drops excluded nodes. When a shared glTF
  Material's post-fixup state **diverges** across the nodes that reference it,
  the first fingerprint reuses the original Material and each subsequent one
  gets its own `Material.clone()` named `<name>_v<N>` (the island
  "Material.010" ground-vs-weed case).
- `writeDocument(doc, absOutPath)` serializes the staged GLB.

When no postprocessor is resolvable (no `resolvePostprocessor`, or the no-op
`none`), Stage A is a verbatim `copyFileSync` of the source.

After Stage A the staged GLB is copied and `stripEmbeddedTextures()` disposes
every embedded image/texture (`prune({ keepAttributes: true, keepLeaves: true
})`) — the runtime rebuilds materials from sidecar `.mat.json` files, so a
219-tri textured LOD drops from ~26 MB to ~3 KB.

### Stage B — LOD simplification

`convertModel()` runs one encoder pass per LOD over the stripped (and optionally
welded) geometry:

- **gltf-transform** (default): `buildGltfTransformSimplifyArgs()` →
  `simplify <in> <out> --ratio <r> --error <e> --lock-border <0|1>`
  (`--lock-border 1` = conservative/preserve seams; `0` = aggressive). With
  meshopt on, `buildGltfTransformMeshoptArgs()` runs `meshopt` as a post-pass
  (`EXT_meshopt_compression`). `ratio >= 1.0` copies the source through
  unchanged. An optional `weld` pass runs first (gltf-transform only).
- **gltfpack** (opt-in single pass): `buildGltfpackArgs()` →
  `-si <ratio>` (simplify), `-slb` / `-sa` (lock-border vs aggressive), `-cc`
  (meshopt), plus `-kn -km -kv -vtf` to preserve named nodes, named materials,
  unsampled vertex attributes, and Float32 texcoords.

Triangle counts are read in-process via `@gltf-transform/core` NodeIO
(`countTriangles()`), not by parsing CLI output.

After each LOD encodes, `rebaseLodGeometry(stagedSource, lodPath)` rebases the
LOD's vertex data into the source's local coordinate space. This is a no-op for
encoders that preserve the source hierarchy (gltf-transform `simplify` /
`meshopt` hit the `matricesApproxEqual` skip path) and **required** for gltfpack,
which flattens the source's ancestor chain plus a per-mesh dequantization scale
into the mesh-node matrix.

Output is published atomically: encoders write into a per-process staging dir
(`<hash>.tmp-<pid>-<rand>`), then the whole dir is `renameSync`'d into the final
`<hash>/` so concurrent `/api/reimport` requests can't produce torn LODs.

## Settings schema

`runtime/loaders/modelSettings.ts` is the single source of truth (shared by the
Inspector, converter, build tree-shaker, and runtime). Settings live in the
GLB's `.meta.json` `model` block.

`ModelImportSettings`:

| field | type | notes |
|-------|------|-------|
| `encoder` | `'gltf-transform' \| 'gltfpack'` | default CLI for any LOD without an override |
| `lodEncoders?` | `ModelEncoder[]` | per-LOD encoder override |
| `lodCount` | `1 \| 2 \| 3` | LOD levels to bake |
| `lodRatios` | `number[]` | per-LOD triangle ratio (`1.0` = passthrough) |
| `lodDistances` | `number[]` | per-LOD `THREE.LOD` switch distance (world units) |
| `simplifyError` | `number` | gltf-transform `--error`: max deviation as a fraction of mesh radius |
| `weld` | `boolean` | collapse coincident verts before simplify (gltf-transform only) |
| `meshopt` | `boolean` | default gltfpack `-cc` |
| `lodMeshopt?` | `boolean[]` | per-LOD meshopt override (gltfpack only) |
| `aggressiveSimplify` | `boolean` | default `-sa` vs `-slb` |
| `lodAggressive?` | `boolean[]` | per-LOD aggressive override (gltfpack only) |

`DEFAULT_MODEL_SETTINGS`: `encoder: 'gltf-transform'`, `lodCount: 3`,
`lodRatios: [1.0, 0.4, 0.15]`, `lodDistances: [0, 80, 250]`,
`simplifyError: 0.5`, `weld: true`, `meshopt: true`, `aggressiveSimplify:
false`.

Per-LOD resolvers: `getLodEncoder(settings, level)`,
`getLodMeshopt(settings, level)`, `getLodAggressive(settings, level)` — the
per-LOD override wins, else the global default.

`ModelCacheInfo` (written back to the same `.meta.json` `modelCache` block by
the conversion service): `hash`, `processedPath`, `lodPaths[]` (distance order,
index 0 === `processedPath`), `lodDistances[]`, `triCounts[]`, `lodBytes[]`.

`lodUrlSuffix(level)` produces the deterministic served URL suffix —
`.processed.glb` for LOD0, `.lod<N>.glb` for LOD1+. The runtime computes these
without reading the hash, so a load needs no manifest round-trip.

`MODEL_ENCODER_VERSION = 13` — bump to invalidate every cached GLB on a flag
change. (The cache module separately tracks `MODEL_PIPELINE_VERSION = 'mdl-5'`.)

## Local cache

`plugins/model-cache.ts` is content-addressed under
`<projectRoot>/.cache/modoki-models/<urlPath>/<hash>/`
(`getModelCacheDir()` — per-game, at the project root, NOT under
`node_modules`). The hash
(`hashKey()`) mixes source bytes + import settings + `MODEL_ENCODER_VERSION` +
`MODEL_PIPELINE_VERSION` + postprocessor id + recipe version + the **CLI tool
versions** (gltfpack / gltf-transform / meshoptimizer). A tool upgrade therefore
silently invalidates everything — intentional, so a simplifier bump never ships
stale geometry.

`cacheHit()` validates each LOD by GLB magic bytes + non-zero size, so a
SIGKILL'd partial write doesn't read back as a hit. Derived GLBs are
**LOCAL-ONLY and gitignored**; `vite build` regenerates them into `dist/` and
drops the source GLB in favor of the LODs.

Cache invalidation is driven through `reimport-model.ts` (the `model` reimport
handler), which reads settings + postprocessor id from the meta, calls
`convertModel()`, and writes the `modelCache` block back. Postprocessor
declarations live in the project's `project.config.json` (`postprocessors`
field); `projectPostprocessors(projectRoot)` reads them into a
`Record<string, ModelPostprocessorDecl>` mapping a postprocessor id → recipe
version + source file so the Node converter can SSR-load it.

## Runtime LOD

`scene3DSync.ts` wraps a mesh in `THREE.LOD` when its parent model has baked
LODs. Resolution goes through `meshTemplateCache.ts`:

- `resolveMeshLodInfo(meshRef)` → `{ templates: MeshTemplate[], distances:
  number[] }` (distance order, LOD0 first), or `undefined` when the model has no
  baked LODs (caller falls back to `resolveMeshTemplate`) or the templates are
  still loading.
- `scene3DSync` builds a `new THREE.LOD()` and calls `lodObj.addLevel(mesh,
  distances[i])` per level.

gltfpack output uses `EXT_meshopt_compression`, so `loadModelTemplates()`
registers three's `MeshoptDecoder` on the `GLTFLoader`. Integer-quantized
position/normal/tangent attributes (`KHR_mesh_quantization`) are dequantized to
plain Float32 (`convertAttribToFloat32`) without baking `mesh.matrix` — the node
TRS stays on the entity Transform so animation hooks (rotate an oar, slide a
door) still have a meaningful handle.

`invalidateModel(modelPath)` clears every LOD GLB's templates (walking the LOD
snapshot, then the manifest's `modelCache.lodPaths`) on re-import, notifying
renderer listeners first so live `THREE.Mesh` references are dropped before the
GPU geometry is disposed.

## Editor

The **Model Inspector** edits `ModelImportSettings` and shows the
post-conversion stats from `ModelCacheInfo` (tri counts, byte sizes). The
`ModelPreview.tsx` mini Three.js viewer (`OrbitControls`, ambient + directional
light) builds a `THREE.LOD` from one level per baked LOD GLB (resolved via
`lodUrlSuffix`) with a toolbar: LOD dropdown (`auto` / `0` / `1` / `2`),
wireframe toggle, and reset-camera. The Assets grid shows model thumbnails.

## Re-import in the Electron host (no Vite)

Re-import runs under BOTH the Vite dev server and the shipped Electron editor, over the
same `/api/reimport` route in the shared `editorBackendRouter.ts`. In dev the Vite plugin
provides the backend; in the packaged app there is no Vite, so the **main process** stands
the equivalents up itself (`engine/electron/main.ts` + `assetBackend.ts`):

- `main.ts` calls `registerReimportHandler` for every type (`texture`/`model`/`audio`/
  `font`/`environment`) into the same registry the Vite plugin uses, and `createAssetBackend`
  runs the router + a chokidar asset watcher/manifest in-process — full parity, no dev server.
- **Stage-A postprocessor bakes need `ssrLoadModule`** to load a project's model
  postprocessor. Under Vite the dev server supplies it; in main, `ssrLoader.ts` lazily
  stands up a **bare SSR-only Vite server** on the first reimport that needs it (~1–2 s,
  then reused). It aliases `@modoki/engine`'s public entry points to absolute files in the
  editor's OWN package tree and dedupes the shared singletons (three/koota) against the
  editor's `node_modules`, so a **flat project with no `node_modules` of its own** still
  resolves the postprocessor — otherwise the import fails silently and Stage A passes the
  model through un-fixed. See [build.md](./build.md) and [architecture.md](./architecture.md).

## LOD authoring reference

Practical tooling notes for tuning ratios/errors:

- **gltf-transform** `simplify --ratio <r> --error <e>`. `--error` caps how far
  ratio can drive the count — the simplifier quits once the deviation budget is
  spent, even if the target ratio isn't reached. `--lock-border 1` preserves UV
  / material seams (may stall near ~50% on hard-edge exports); `0` drops the
  guarantee to hit the ratio.
- **gltfpack** `-si <ratio>` simplifies; `-slb` locks borders (safe default);
  `-sa` ignores quality to hit the ratio; `-cc` enables meshopt compression.
- **Skinned meshes** can break under simplification — verify rigged assets.
- **Hard edges / UV seams** may collapse; gltf-transform preserves UV
  boundaries by default (`--lock-border 1`).
- **Instancing beats LOD for swarms** — many copies of one mesh are cheaper
  instanced than per-instance LOD.
- **Three levels is enough** for most games — the default `lodCount: 3`.

## Known limits (v1)

- **Multiple Nodes sharing the SAME Mesh primitive with divergent fixups** →
  "first assignment wins". `applyChangesToDocument` warns (`[model-convert]
  Shared primitive carries divergent post-fixup state …`) rather than cloning
  the primitive + re-pointing the node.
- **`transparent + alphaTest`** collapses to a single alpha mode — the
  adapter maps `transparent → BLEND`, else `alphaTest > 0 → MASK`, else
  `OPAQUE`, so a material that is both blended and masked loses the mask.

## Key files

- `plugins/model-convert.ts` — `convertModel()`, CLI arg builders,
  `rebaseLodGeometry()`, `stripEmbeddedTextures()`.
- `plugins/model-convert/threeAdapter.ts` — Stage A THREE adapter.
- `plugins/model-cache.ts` — content cache + hash key.
- `plugins/reimport-model.ts` — `model` reimport handler + `projectPostprocessors()`.
- `runtime/loaders/modelSettings.ts` — settings schema + helpers.
- `runtime/loaders/meshTemplateCache.ts` — template cache, `resolveMeshLodInfo`,
  `invalidateModel`, refcount API.
- `runtime/rendering/scene3DSync.ts` — `THREE.LOD` wrapping.
- `editor/panels/ModelPreview.tsx` — LOD preview viewer.
