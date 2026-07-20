/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assetScannerPlugin } from './plugins/vite-asset-scanner'
import { loadProjectConfig } from './plugins/load-project-config'
import { resolveModules } from './plugins/detect-modules'
import { inlinePlayablePlugin } from './plugins/inlinePlayable'

// C3: engine/ is the vite root (this config + index.html + app/ live here). The
// npm root + node_modules stay at the repo root (Capacitor needs them there), so
// build output goes back to <repo>/dist and the asset scanner's projectRoot is
// the repo root (engine/'s parent) — see the plugin's configResolved.
const engineDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(engineDir, '..')

// #29: build output goes to the OPEN PROJECT's dist/ — a flat one-game project
// owns its own build output (games/<id>/dist), so building game A never clobbers
// game B and each web/device deploy is isolated. MODOKI_PROJECT steers it; unset
// ⇒ repo root (legacy). Capacitor `webDir` and the editor's /api/build web-deploy
// rsync resolve this SAME path so the three stay in lockstep.
const buildProjectRoot = process.env.MODOKI_PROJECT ? path.resolve(process.env.MODOKI_PROJECT) : repoRoot

// Percept — whether the event journal records in THIS build. Baked as a define so
// the runtime bootstrap (app/main.tsx) can gate it without a config fetch. Always
// on for the editor (see the __MODOKI_EDITOR__ OR in main.tsx); for a shipped GAME
// build it follows the open project's build.enableJournal (default false → off,
// dropping per-event overhead). Editor/dev has no project.config.json at repoRoot,
// so this resolves to false there and the __MODOKI_EDITOR__ OR turns it on.
const enableJournalFlag = loadProjectConfig(buildProjectRoot).build.enableJournal === true

// In-game debug menu — same pattern as the journal flag. Baked as a define so the
// runtime bootstrap (app/main.tsx) gates enablement and App.tsx gates the lazy
// import (tree-shaking the menu out when off) without a config fetch. Always on for
// the editor (the __MODOKI_EDITOR__ OR in App.tsx/main.tsx); for a shipped GAME
// build it follows the open project's build.enableDebugMenu (default false → off).
const enableDebugMenuFlag = loadProjectConfig(buildProjectRoot).build.enableDebugMenu === true

// Absolute dir of @zappar/msdf-generator, pinned so its bare import resolves even when the
// dep-optimize cache is relocated out of the tree in a packaged editor (see resolve.alias
// below). Hoisting puts it at <repoRoot>/node_modules in both the dev clone AND the packaged
// app.asar.unpacked layout; guard with existsSync so a future layout change degrades to Vite's
// default resolution rather than aliasing to a missing path.
const msdfGeneratorDir = (() => {
  const dir = path.join(repoRoot, 'node_modules', '@zappar', 'msdf-generator')
  return fs.existsSync(path.join(dir, 'package.json')) ? dir : null
})()

// An external project (MODOKI_PROJECT outside the repo), if any.
const externalProject = (() => {
  if (!process.env.MODOKI_PROJECT) return null
  const proj = path.resolve(process.env.MODOKI_PROJECT)
  return proj !== repoRoot && !proj.startsWith(repoRoot + path.sep) ? proj : null
})()

// C4c-2: serve an external project's game code (`/@fs/<proj>/...`) — Vite blocks
// paths outside fs.allow. repoRoot covers the in-repo example.
const fsAllow = externalProject ? [repoRoot, externalProject] : [repoRoot]

// C4c-3a: HOST-PROVIDED DEPS. An external project's game code imports the shared
// singletons (@modoki/engine, three, react, …) but should NOT have to install
// them — the editor provides its OWN copies, and they MUST be the same instance
// (a second `three`/`react`/koota world breaks TSL / hooks / ECS). This plugin
// intercepts those bare imports *from external-project files* and re-resolves
// them against the editor's tree (respecting @modoki/engine's exports map);
// resolve.dedupe then guarantees one instance. The project's own unique deps
// (chess.js, …) fall through to normal resolution from its node_modules.
function hostSharedDeps(): Plugin {
  const SHARED = new Set(['@modoki/engine', 'three', 'react', 'react-dom', '@pixi/react', 'koota', 'zustand', 'pixi.js', '@capacitor/core'])
  const anchor = path.join(engineDir, 'app', 'main.tsx') // a real file inside the editor tree
  const pkgOf = (id: string) => (id[0] === '@' ? id.split('/').slice(0, 2).join('/') : id.split('/')[0])
  return {
    name: 'modoki:host-shared-deps',
    enforce: 'pre',
    async resolveId(id, importer) {
      if (!importer) return null
      const from = importer.split('?')[0]
      // Only redirect imports coming FROM external-project files.
      if (from.startsWith(repoRoot + path.sep)) return null
      if (!SHARED.has(pkgOf(id))) return null
      const r = await this.resolve(id, anchor, { skipSelf: true })
      return r?.id ?? null
    },
  }
}

// The editor's favicon is the engine's bundled Modoki icon. With publicDir off and
// no public/ dir, the editor SPA build (`build:editor`) would otherwise ship NO
// favicon — index.html's `<link rel="icon" href="%BASE_URL%favicon.png">` 404s. This
// plugin (a) emits favicon.png at the dist root on build, so the packaged Electron
// shell serves it, and (b) serves it in `vite` dev.
function faviconPlugin(): Plugin {
  const faviconSrc = path.join(engineDir, 'packages/modoki/src/runtime/assets/favicon.png')
  return {
    name: 'modoki:favicon',
    generateBundle() {
      try { this.emitFile({ type: 'asset', fileName: 'favicon.png', source: fs.readFileSync(faviconSrc) }) }
      catch { /* favicon missing — skip (not fatal) */ }
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const reqUrl = (req.url || '').split('?')[0]
        if (reqUrl !== '/favicon.png' && reqUrl !== `${server.config.base}favicon.png`) { next(); return }
        try {
          const buf = fs.readFileSync(faviconSrc)
          res.setHeader('Content-Type', 'image/png')
          res.end(buf)
        } catch { next() }
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ command }) => {
  // #29 teardown: the repo root is no longer a buildable game. Each game ships
  // from its OWN flat project (MODOKI_PROJECT=games/<id>) with its own dist +
  // native. A bare production build with no project would silently emit an EMPTY
  // bundle (virtual:modoki-games resolves to []), so fail loudly instead. The
  // packaged EDITOR build (MODOKI_EDITOR=true) is exempt — it's a project-less
  // shell that opens projects at runtime. Dev (command==='serve') is exempt too:
  // the editor's "Open Project" re-roots the dev server live.
  if (command === 'build' && !process.env.MODOKI_PROJECT && process.env.MODOKI_EDITOR !== 'true') {
    throw new Error(
      '[modoki] No MODOKI_PROJECT set — the repo root is not a buildable game since the per-game teardown (#29).\n' +
      '  • Build a game:     MODOKI_PROJECT=games/3d-test npm run build\n' +
      '  • Build the editor: npm run build:editor\n' +
      '  • From the editor:  Build → Web / iOS Device / Android Device (recommended).',
    )
  }
  // Engine-module toggles (build.modules). Editor + dev builds need EVERY SDK
  // (you can open any project, switch renderers live) → all modules on. Only a
  // real game/playable build (not the editor, not dev-serve) scans the project's
  // scenes to strip unused SDKs; 'auto' → detected, else forced. Baked as
  // __MODOKI_MODULE_*__ defines so flag-gated lazy imports DCE the unused three/
  // pixi/Rapier. See plugins/detect-modules.ts.
  const isEditorBuild = command === 'serve' || process.env.MODOKI_EDITOR === 'true'
  const moduleFlags = resolveModules(
    loadProjectConfig(buildProjectRoot).build.modules,
    isEditorBuild || !process.env.MODOKI_PROJECT ? null : buildProjectRoot,
  )
  // Playable single-file target (Phase 4). VITE_PLAYABLE=1 ⇒ (a) run the asset profile
  // (MODOKI_PLAYABLE) so assets shrink, (b) emit ONE JS chunk (inlineDynamicImports) so
  // there's a single bundle to inline, (c) run inlinePlayablePlugin to collapse the output
  // into one self-contained index.html + enforce the byte cap. See plugins/inlinePlayable.ts.
  //
  // A playable builds to a SEPARATE `ads/` dir, NOT `dist/`: they'd otherwise clobber each
  // other (both emptyOutDir), and Capacitor's webDir is `dist/` — so a native build right
  // after a playable build would ship the single-file ad. Keeping them apart is a
  // correctness fix, not just tidiness. (`ads/` can also hold future per-network variants.)
  const isPlayable = command === 'build' && process.env.VITE_PLAYABLE === '1'
  const playableOutDir = path.join(buildProjectRoot, 'ads')
  if (isPlayable) {
    process.env.MODOKI_PLAYABLE = '1'
    process.env.MODOKI_DIST_DIR = playableOutDir
  }
  const playableBuildCfg = loadProjectConfig(buildProjectRoot).build
  const playableMaxBytes = playableBuildCfg.playableMaxBytes
  return {
  root: engineDir,
  // Vite's dep-optimize cache. Default (under the Vite root) is fine for dev, but a
  // PACKAGED editor's bundle is read-only and signed — Vite can't write the cache
  // there. main sets MODOKI_VITE_CACHEDIR to a writable userData path when packaged
  // so optimizeDeps works on first launch. Unset in dev → Vite default.
  ...(process.env.MODOKI_VITE_CACHEDIR ? { cacheDir: process.env.MODOKI_VITE_CACHEDIR } : {}),
  // Sub-path hosting (e.g. GCS bucket served at modoki-engine.com/demo). Defaults
  // to '/' so dev and native Capacitor builds are unaffected; the web deploy sets
  // BASE_PATH=/demo/. Runtime asset URLs are prefixed via assetUrl() to match.
  base: process.env.BASE_PATH || '/',
  // ELECTRON_PLAN Phase 1: the editor + agent/backend APIs are gated on this
  // explicit flag, NOT on import.meta.env.DEV / import.meta.hot. True in `vite`
  // dev (command==='serve') and for any build that opts in via MODOKI_EDITOR=true
  // (the packaged Electron editor sets it). The game-only web deploy leaves it
  // false, stripping the agent bridge — same as today's DEV gate did.
  define: {
    __MODOKI_EDITOR__: JSON.stringify(command === 'serve' || process.env.MODOKI_EDITOR === 'true'),
    __MODOKI_ENABLE_JOURNAL__: JSON.stringify(enableJournalFlag),
    __MODOKI_ENABLE_DEBUG_MENU__: JSON.stringify(enableDebugMenuFlag),
    __MODOKI_MODULE_RENDER3D__: JSON.stringify(moduleFlags.render3d),
    __MODOKI_MODULE_RENDER2D__: JSON.stringify(moduleFlags.render2d),
    __MODOKI_MODULE_PHYSICS2D__: JSON.stringify(moduleFlags.physics2d),
    __MODOKI_MODULE_PHYSICS3D__: JSON.stringify(moduleFlags.physics3d),
    __MODOKI_MODULE_NPR__: JSON.stringify(moduleFlags.npr),
    __MODOKI_MODULE_GPU_PARTICLES__: JSON.stringify(moduleFlags.gpuParticles),
    // Playable (Phase 5): the app boots the MRAID/CTA layer only in a playable build,
    // and the CTA routes to this store URL. False/'' in every other build → the whole
    // playable-overlay import DCEs out.
    __MODOKI_PLAYABLE__: JSON.stringify(isPlayable),
    __MODOKI_PLAYABLE_CLICK_URL__: JSON.stringify(isPlayable ? playableBuildCfg.playableClickUrl : ''),
  },
  plugins: [react(), faviconPlugin(), assetScannerPlugin(), ...(externalProject ? [hostSharedDeps()] : []), ...(isPlayable ? [inlinePlayablePlugin(playableMaxBytes)] : [])],
  publicDir: false, // No public/ — assets served via convention-based assets/ folders
  build: {
    // Emit to the open project's dist/ (games/<id>/dist for a flat project; repo
    // root when MODOKI_PROJECT is unset). The asset-shaker follows Rollup's
    // output dir, and Capacitor webDir + /api/build resolve the same path. A
    // playable build diverts to a SEPARATE `ads/` dir (see the isPlayable note above)
    // so it never clobbers the web/native `dist/`.
    outDir: isPlayable ? playableOutDir : path.join(buildProjectRoot, 'dist'),
    emptyOutDir: true,
    // Don't inline assets as base64 data URLs — scene files use path-based
    // callbacks that break when Vite inlines small JSON as data: URLs.
    assetsInlineLimit: 0,
    // Playable: collapse the whole graph (incl. render3d-gated lazy Scene3D etc.)
    // into ONE JS chunk so inlinePlayable has a single bundle to embed. The real
    // Rollup option is `inlineDynamicImports` (folds every dynamic import into the
    // entry chunk) — NOT `codeSplitting`, which Rollup silently ignores, leaving the
    // lazy renderer chunk split out so the inliner's stray-JS guard aborts the build.
    ...(isPlayable ? { rollupOptions: { output: { inlineDynamicImports: true } } } : {}),
  },
  server: {
    // The app (under engine/) imports the open project's games via
    // virtual:modoki-games / the runtime loader → <projectRoot>/games/registry,
    // which is OUTSIDE the engine vite root. Allow the repo root (in-repo games)
    // + an external MODOKI_PROJECT (C4c-2) so those imports resolve in dev.
    fs: { allow: fsAllow },
  },
  // The runtime MSDF font generator ships its OWN module Worker + wasm and resolves
  // them via `new URL('./worker.js', import.meta.url)` / `new URL('msdfgen_wasm.wasm',
  // import.meta.url)`. esbuild dep-optimization bundles the lib into a single chunk,
  // which BREAKS those relative URLs (the sibling files no longer sit next to the
  // chunk). Excluding it keeps the lib served from node_modules as-is so the URLs
  // resolve and Vite still transforms the worker's bare imports (comlink).
  optimizeDeps: {
    exclude: ['@zappar/msdf-generator'],
  },
  resolve: {
    // Dedupe three so every TSL node builder (NPR pipeline + particle SpriteNodeMaterial)
    // shares one three/webgpu+three/tsl module instance — avoids "multiple instances of
    // three", which otherwise breaks WGSL node codegen. The ECS singletons
    // (@modoki/engine, koota, zustand) are deduped too so project game code loaded
    // at runtime (C4c) shares the editor's world/trait registries and stores —
    // a second instance would silently split ECS/store state.
    dedupe: ['react', 'react-dom', '@pixi/react', 'three', 'pixi.js', '@modoki/engine', 'koota', 'zustand', '@capacitor/core'],
    // PACKAGED-EDITOR FIX: @zappar/msdf-generator is optimizeDeps.exclude'd (above),
    // so its bare import survives inside the OTHER optimized dep chunks (e.g. SceneManager).
    // A packaged editor relocates the dep-optimize cache OUT of the tree
    // (MODOKI_VITE_CACHEDIR → userData/vite-cache, since the signed bundle is read-only), and
    // Vite resolves that surviving bare import relative to the chunk's out-of-tree location —
    // where the node_modules walk never reaches app.asar.unpacked/node_modules, so the import
    // fails and the whole editor renderer blanks (Vite error overlay). Pin it to an absolute
    // path so it resolves regardless of cache location. Kept as a package-DIR alias (not the
    // entry file) so the resolver still honours the package's own `new URL('./worker.js' /
    // 'msdfgen_wasm.wasm', import.meta.url)` self-resolution next to the real dist/.
    // Playable: alias @zappar/msdf-generator to a stub — the real lib emits a Worker + wasm
    // via new URL(import.meta.url) that can't be inlined into the single file (would 404 +
    // trip the inliner's single-chunk guard). Playables use pre-baked font atlases, so the
    // runtime generator is never needed. Otherwise keep the packaged-editor package-dir alias.
    // Playable also stubs each game's `@<game>/app-services` package: it statically imports the
    // AppLovin/Adjust/Firebase native-SDK wrappers, which do nothing in an ad webview but (because
    // registerAppServices is a dynamic-import closure the single-chunk build folds in) would ship
    // as dead SDK weight against the byte cap. registerAppServices() is skipped in a playable
    // anyway (App.tsx), so the no-op stub is safe. Regex matches the whole `@<scope>/app-services`.
    ...(isPlayable
      ? { alias: [
          { find: '@zappar/msdf-generator', replacement: path.join(engineDir, 'plugins/playable-msdf-stub.ts') },
          { find: /^@[^/]+\/app-services$/, replacement: path.join(engineDir, 'plugins/playable-appservices-stub.ts') },
        ] }
      : (msdfGeneratorDir ? { alias: { '@zappar/msdf-generator': msdfGeneratorDir } } : {})),
  },
  test: {
    // Paths are relative to root (engineDir): tests/ and packages/ live under engine/.
    globals: true,
    environment: 'jsdom',
    setupFiles: './tests/setup.ts',
    // The default 5s per-test timeout is too tight for the FIRST test in a file that cold-imports a
    // heavy dependency graph (three.js + the engine) — esbuild's first transform of that graph can
    // take several seconds on Windows, so tests intermittently timed out under full-suite load.
    // Mac/Linux CI finishes these in milliseconds, so the higher ceiling never triggers there; it
    // only gives a cold Windows compile room. hookTimeout covers heavy beforeAll/afterEach setup.
    testTimeout: 20000,
    hookTimeout: 30000,
    include: [
      // ENGINE tests only — tests/** is the engine test surface, and it ships to the
      // public OSS repo (docs/plans/engine-oss-public-repo.md). DEMO-GAME tests live with
      // their game under ../games/<id>/tests (globbed below) and stay private. Do NOT add
      // a game-specific tests/ subdir here.
      'tests/framework/**/*.test.ts',
      'tests/ui/**/*.test.tsx',
      'tests/editor/**/*.test.ts',
      'tests/editor/**/*.test.tsx',
      'tests/ecs/**/*.test.ts',
      'tests/plugins/**/*.test.ts',
      'tests/assets/**/*.test.ts',
      'tests/electron/**/*.test.ts',
      // MCP server units (result formatting, identity) — `tools/` ships to the agent,
      // not to a game, but it is still CI-gated code.
      'tests/tools/**/*.test.ts',
      // Game-owned tests (demo-game logic + @3d-test/app-services packages). Co-located
      // with the game's code so their deps resolve from the game's own node_modules; the
      // glob matches nothing when games/ is absent (the public repo has no games/).
      '../games/*/tests/**/*.test.ts',
      '../games/*/tests/**/*.test.tsx',
      '../games/*/packages/*/**/*.test.ts',
    ],
    exclude: [
      '**/node_modules/**',
      'packages/**',
      // electron-builder output (gitignored) — a full repo copy under app.asar.unpacked
      // that vitest would otherwise re-discover and run as duplicate (often stale) tests.
      '**/release/**',
    ],
  },
  }
})
