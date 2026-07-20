/** Model reimport handler — reads import settings + postprocessor id from the
 *  meta sidecar, converts the source GLB into LOD0 + LODn variants, and
 *  persists the cache bookkeeping back to the meta. Registered for the `model`
 *  asset type.
 *
 *  Postprocessor recipe version (used for cache invalidation) is read from a
 *  small static registry in this module — the converter runs in Node and
 *  can't import the engine's runtime postprocessor registry (which depends on
 *  THREE). Game authors register postprocessor recipe versions here when they
 *  ship a new fixup recipe; otherwise we treat it as 0 (the default
 *  ModelPostprocessor value).
 */

import { randomUUID } from 'crypto';
import path from 'path';
import { resolveModelSettings, lodUrlSuffix } from '../packages/modoki/src/runtime/loaders/modelSettings';
import { resolveTextureSettings } from '../packages/modoki/src/runtime/loaders/textureSettings';
import { convertModel, type FixupPostprocessor } from './model-convert';
import { convertRiggedModel } from './rigged-model-optimize';
import { readMetaSidecar, writeMetaSidecar } from './meta-sidecar';
import { loadProjectConfig } from './load-project-config';
import type { ModelPostprocessorDecl } from '../project-config';
import type { ReimportContext, ReimportHandler } from './reimport-registry';

/** A GLB is "rigged" (skeletal parallel path) iff its meta sidecar carries a
 *  `rig` block with a `clips` ARRAY — the shape importRiggedModel writes
 *  (`rig: { clips: [...] }`). A POSITIVE structural check, not `typeof === 'object'`:
 *  a stray/empty `rig: {}` on a STATIC model must NOT route it to the whole-GLB
 *  rigged converter (which would skip its `.mesh.json`/`.mat.json` flatten and
 *  silently break it). (C5) */
export function isRiggedMeta(meta: { rig?: unknown }): boolean {
  return !!meta.rig && typeof meta.rig === 'object' && Array.isArray((meta.rig as { clips?: unknown }).clips);
}

/** The PROJECT declares its model postprocessors in project.config.json
 *  (`postprocessors`). The engine no longer hardcodes per-game source paths —
 *  each project points `file` at its own postprocessor source (project-relative),
 *  resolved to an absolute path here so SSR loading doesn't depend on the
 *  (dev=engine, build=project) Vite root. */
function projectPostprocessors(projectRoot: string): Record<string, ModelPostprocessorDecl> {
  return loadProjectConfig(projectRoot).postprocessors ?? {};
}

/** Validate the project's declared postprocessors against the runtime
 *  `modelPostprocessorRegistry`. Called once at build start (and at dev-server
 *  startup) — surfaces a missing/typo'd entry loudly instead of silently
 *  shipping a passthrough Stage A bake with `recipeVersion = 0` (which would
 *  bake whatever the runtime postprocessor produces but tag the cache as if
 *  no fixup ran, so subsequent runs hit a stale cache).
 *
 *  Soft: warns but doesn't throw — many test/build contexts run without the
 *  full runtime registry loaded, and refusing to start would block those.
 *  In dev, the warning is the surface that catches the drift in practice. */
export async function validatePostprocessorRegistry(ctx: ReimportContext): Promise<void> {
  if (!ctx.ssrLoadModule) return; // no SSR — build path with the registry preloaded elsewhere
  try {
    // Absolute engine-src path when known (packaged: the `@modoki/engine` symlink is
    // dereferenced, so the root-relative `/packages/modoki/...` URL won't resolve —
    // same reason resolvePostprocessorForId uses enginePkgSrc).
    const registryUrl = ctx.enginePkgSrc
      ? path.join(ctx.enginePkgSrc, 'runtime/loaders/modelPostprocessorRegistry.ts')
      : '/packages/modoki/src/runtime/loaders/modelPostprocessorRegistry.ts';
    const registryMod = await ctx.ssrLoadModule(registryUrl) as {
      getModelPostprocessorIds?: () => string[];
    };
    const runtimeIds = new Set<string>(registryMod.getModelPostprocessorIds?.() ?? []);
    const declaredIds = new Set(Object.keys(projectPostprocessors(ctx.projectRoot)));
    const missingFromConfig = [...runtimeIds].filter((id) => !declaredIds.has(id) && id !== 'none');
    if (missingFromConfig.length > 0) {
      console.warn(
        `[reimport-model] postprocessor drift: runtime registry has ${JSON.stringify(missingFromConfig)} but project.config.json "postprocessors" does not. Stage A bake will be a silent passthrough for these — declare them with the correct recipeVersion + project-relative source file.`,
      );
    }
  } catch {
    // ssrLoadModule failure here is non-fatal — the registry validation is
    // a sanity check, not a build prerequisite.
  }
}

/** Try to import the postprocessor's source via SSR + reach into the runtime
 *  registry to get the THREE.Mesh-shaped `ModelPostprocessor`. Returns null
 *  when the postprocessor is the built-in 'none', no SSR loader is available
 *  (build path), or the source file fails to load (broken import). */
export async function resolvePostprocessorForId(
  postprocessorId: string,
  ctx: ReimportContext,
): Promise<FixupPostprocessor | null> {
  if (postprocessorId === 'none') return null;
  const reg = projectPostprocessors(ctx.projectRoot)[postprocessorId];
  if (!reg || !reg.file) {
    console.log(`[reimport-model] no project.config.json "postprocessors" entry for postprocessorId="${postprocessorId}"`);
    return null;
  }
  if (!ctx.ssrLoadModule) {
    console.log(`[reimport-model] no ssrLoadModule (build context?) — skipping Stage A bake for "${postprocessorId}"`);
    return null;
  }
  // Resolve the project-relative `file` to an ABSOLUTE path so SSR loading is
  // independent of the Vite/SSR root (dev roots at engine/, build roots at the
  // project). The old root-relative "/games/<id>/..." form broke for a flat
  // one-game project whose root IS the game folder.
  const absFile = path.resolve(ctx.projectRoot, reg.file);
  try {
    // The postprocessor's source file must call `registerModelPostprocessor` at
    // module load so the registry singleton populates as a side effect. Need
    // to load the registry FIRST so the singleton is shared between the
    // postprocessor module and our subsequent `getModelPostprocessor` lookup
    // (separate SSR loads otherwise produce separate module instances).
    // Load the registry by ABSOLUTE path in the build (enginePkgSrc set) so it
    // resolves regardless of the SSR root; dev uses the root-relative path (root =
    // engine/). Both forms resolve to the same file, so the registry singleton is
    // shared with the postprocessor's own `@modoki/engine/runtime` import.
    const registryUrl = ctx.enginePkgSrc
      ? path.join(ctx.enginePkgSrc, 'runtime/loaders/modelPostprocessorRegistry.ts')
      : '/packages/modoki/src/runtime/loaders/modelPostprocessorRegistry.ts';
    const registryMod = await ctx.ssrLoadModule(registryUrl) as { getModelPostprocessor: (id: string) => FixupPostprocessor };
    const postprocessorModule = await ctx.ssrLoadModule(absFile) as Record<string, unknown>;
    // Most postprocessors gate registration behind an exported function (e.g.
    // `registerIslandPostprocessor`) — invoke it so the registry's singleton
    // sees the postprocessor. Ones that auto-register at module load already
    // populated it via the SSR import above; the explicit call is a no-op
    // duplicate.
    if (reg.registerFn) {
      const fn = postprocessorModule[reg.registerFn];
      if (typeof fn === 'function') (fn as () => void)();
      else console.warn(`[reimport-model] ${absFile} has no exported "${reg.registerFn}"`);
    }
    const postprocessor = registryMod.getModelPostprocessor(postprocessorId);
    // `getModelPostprocessor` falls back to the no-op 'none' when unregistered.
    // Detect the fallback by name so we don't proceed with a silent passthrough.
    if (!postprocessor || (postprocessor as { name?: string }).name === 'None') {
      console.warn(`[reimport-model] postprocessor "${postprocessorId}" not in registry after SSR load — did ${absFile} register it under that id?`);
      return null;
    }
    console.log(`[reimport-model] postprocessor "${postprocessorId}" ready for Stage A bake`);
    return postprocessor;
  } catch (e) {
    console.warn(`[reimport-model] Failed to load postprocessor "${postprocessorId}" from ${absFile}:`, e);
    return null;
  }
}

export const modelReimportHandler: ReimportHandler = async (sourceUrlPath, absPath, ctx) => {
  // Only GLB/glTF feed the gltfpack LOD pipeline. OBJ/FBX/DAE are *convertible
  // model sources* (also classified as type 'model' so the Assets panel offers
  // "Import Model"), but their GLB normalization happens in-browser at import
  // time — gltfpack can't read them. Skip them here so "Re-import all" doesn't
  // error; the GLB this conversion produces is what gets LOD-processed.
  if (!/\.(glb|gltf)$/i.test(sourceUrlPath)) return;

  const meta = readMetaSidecar(absPath);

  // Rigged (skeletal) GLBs take the parallel converter — convertModel would
  // strip their textures + flatten the skeleton. They derive a single optimized
  // variant (resize + KTX2 + meshopt) into the SAME model cache + `processed.glb`
  // layout, so the dev middleware / build copy / runtime resolution all reuse the
  // static plumbing. The committed source GLB is never mutated.
  if (isRiggedMeta(meta)) {
    const texSettings = resolveTextureSettings(meta as Parameters<typeof resolveTextureSettings>[0]);
    const result = await convertRiggedModel({
      projectRoot: ctx.projectRoot, sourceUrlPath, absSource: absPath, settings: texSettings,
    });
    if (typeof meta.id !== 'string') meta.id = randomUUID();
    meta.version = 2;
    // Single-variant modelCache: the rigged runtime loads processedPath whole
    // (no LOD). lodPaths has just the one entry so the dev/build copy loops that
    // iterate lodPaths handle it uniformly.
    meta.modelCache = {
      hash: result.hash,
      processedPath: sourceUrlPath + lodUrlSuffix(0),
      lodPaths: [sourceUrlPath + lodUrlSuffix(0)],
      lodDistances: [0],
      triCounts: [0],
      lodBytes: [result.bytes],
    };
    writeMetaSidecar(absPath, meta);
    return;
  }

  const settings = resolveModelSettings(meta as { model?: Record<string, unknown> });
  const postprocessorId = typeof meta.postprocessor === 'string' ? meta.postprocessor : 'none';
  const recipeVersion = projectPostprocessors(ctx.projectRoot)[postprocessorId]?.recipeVersion ?? 0;

  const result = await convertModel({
    projectRoot: ctx.projectRoot,
    sourceUrlPath,
    absSource: absPath,
    settings,
    postprocessorId,
    recipeVersion,
    resolvePostprocessor: (id) => resolvePostprocessorForId(id, ctx),
  });

  if (typeof meta.id !== 'string') meta.id = randomUUID();
  meta.version = 2;
  meta.model = settings;
  meta.modelCache = {
    hash: result.hash,
    // URL-form paths so the runtime can resolve directly. The deterministic
    // <source>.processed.glb / <source>.lod<N>.glb convention is mirrored in
    // the GET middleware that streams them out of the cache dir.
    processedPath: sourceUrlPath + lodUrlSuffix(0),
    lodPaths: result.lodPaths.map((_, i) => sourceUrlPath + lodUrlSuffix(i)),
    lodDistances: result.lodDistances,
    triCounts: result.triCounts,
    lodBytes: result.lodBytes,
  };
  writeMetaSidecar(absPath, meta);
};
