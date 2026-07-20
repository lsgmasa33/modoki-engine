/**
 * Lazy Vite SSR module loader for the Electron main process (ELECTRON_PLAN
 * Phase 3). The reimport pipeline needs `ssrLoadModule` to load model
 * postprocessor modules for Stage-A bakes — under Vite the dev server provides
 * it; in main we stand up a bare SSR-only Vite server on demand (the exact
 * pattern the asset-scanner's writeBundle uses for build-time bakes).
 *
 * Heavy (~1–2s startup) so it's created lazily on the first reimport that needs
 * it, then reused. Plain TS modules load via Vite's default esbuild transform.
 *
 * HOST-PROVIDED DEPS (C4c-3a, main-process analogue): a project's postprocessor
 * imports `@modoki/engine/runtime` (+ three/koota/…). A FLAT project root has no
 * `node_modules`, and even an in-repo root resolves `@modoki/engine`'s symlink to
 * a path the project-rooted server serves under the wrong base — either way the
 * import fails ("Failed to load url /packages/modoki/...") and the postprocessor
 * silently doesn't load, so Stage A passes the model through UN-fixed. We alias
 * the engine's public entry points to absolute files in the editor's OWN package
 * tree and dedupe the shared singletons against the editor's node_modules, so the
 * postprocessor always resolves against the editor — regardless of the project
 * root or whether it has installed anything.
 */

import path from 'node:path';

let server: { ssrLoadModule: (url: string) => Promise<Record<string, unknown>>; close: () => Promise<void> } | null = null;
let creating: Promise<void> | null = null;

/**
 * Get the SSR `ssrLoadModule`. `repoRoot` is the editor's own root (where its
 * node_modules + engine packages live) — used to resolve shared deps so a project
 * postprocessor loads against the editor, not the (possibly bare) project folder.
 */
export async function getSsrLoadModule(projectRoot: string, repoRoot: string): Promise<(url: string) => Promise<Record<string, unknown>>> {
  if (!server) {
    if (!creating) {
      creating = (async () => {
        const { createServer } = await import('vite');
        // Alias `@modoki/engine/*` to ABSOLUTE files in the editor's engine-package
        // source, mirroring the package's exports map. A project postprocessor imports
        // `@modoki/engine/runtime` (+ three); resolving that via the `@modoki/engine`
        // workspace SYMLINK breaks in the packaged app — electron-builder DEREFERENCES
        // the symlink into a real dir copy, so the old `/packages/modoki/...` URL no
        // longer resolves and the postprocessor silently fails to load → Stage A passes
        // the model through UN-fixed (lost procedural UVs → untextured meshes on reimport).
        // The alias resolves it by absolute path regardless of the symlink (dev + packaged).
        const enginePkgSrc = path.join(repoRoot, 'engine', 'packages', 'modoki', 'src');
        const aliasFor = (sub: string, file: string) =>
          ({ find: new RegExp(`^@modoki/engine${sub}$`), replacement: path.join(enginePkgSrc, file) });
        const inner = await createServer({
          configFile: false,
          // Root at the EDITOR's vite root (<repo>/engine) — the SAME root the
          // renderer's vite.config uses. The project's own files (the postprocessor)
          // load by absolute path via fs.allow (covers in-repo games AND an external
          // opened project); @modoki/engine resolves via the alias below.
          root: path.join(repoRoot, 'engine'),
          resolve: {
            alias: [
              aliasFor('/runtime/rendering', 'runtime/rendering/index.ts'),
              aliasFor('/runtime', 'runtime/index.ts'),
              aliasFor('/editor/rendering', 'editor/rendering/index.ts'),
              aliasFor('/editor', 'editor/index.ts'),
              aliasFor('/three', 'three/index.ts'),
            ],
            dedupe: ['three', 'react', 'react-dom', 'koota', 'zustand', 'pixi.js'],
          },
          server: {
            middlewareMode: true,
            hmr: false,
            fs: { allow: [repoRoot, projectRoot] },
          },
          appType: 'custom',
          logLevel: 'warn',
          // SSR-only: no index.html entry to scan, so skip dep pre-bundling
          // (otherwise Vite logs a noisy "Failed to run dependency scan").
          optimizeDeps: { noDiscovery: true, include: [] },
        });
        server = {
          ssrLoadModule: (url) => inner.ssrLoadModule(url) as Promise<Record<string, unknown>>,
          close: () => inner.close().then(() => undefined),
        };
        console.log('[modoki-electron] SSR loader up (reimport postprocessor bakes enabled)');
      })().catch((e) => {
        // Reset so a transient failure (e.g. a bad config) doesn't wedge every
        // later reimport on the same rejected promise — the next call retries.
        creating = null;
        throw e;
      });
    }
    await creating;
  }
  return server!.ssrLoadModule;
}

export async function closeSsrLoader(): Promise<void> {
  const s = server;
  server = null;
  creating = null;
  await s?.close().catch(() => {});
}
