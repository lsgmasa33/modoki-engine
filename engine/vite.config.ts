/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { courtTouched } from './scripts/courtAuthored.mjs'
import { assetScannerPlugin } from './plugins/vite-asset-scanner'
import { loadProjectConfig } from './plugins/load-project-config'
import { resolveModules } from './plugins/detect-modules'
import { inlinePlayablePlugin } from './plugins/inlinePlayable'
import { subgameBuildPlugin, SUBGAME_ENTRY_VIRTUAL_ID, subgameOutDir } from './plugins/subgameBuild'
import { perfCoreWorkers } from './testWorkers'

// C3: engine/ is the vite root (this config + index.html + app/ live here). The
// npm root + node_modules stay at the repo root (Capacitor needs them there), so
// build output goes back to <repo>/dist and the asset scanner's projectRoot is
// the repo root (engine/'s parent) — see the plugin's configResolved.
// #326: the PACKAGED editor loads an esbuild-bundled CJS copy of this file (see
// `engine/scripts/build-web.mjs`), because Vite's default `bundle` config loader writes
// its compiled config to `node_modules/.vite-temp` — which, in a packaged app, is INSIDE
// the signed `.app` and breaks its code signature. The CJS branch of
// `loadConfigFromBundledFile` compiles in memory and writes nothing. Under that bundle
// `import.meta` is empty, so resolve self-location the way `font-instance.ts` and
// `nodeProvision.ts` already do: prefer `import.meta.url`, fall back to CJS `__filename`.
// The bundled copy is emitted into THIS directory, so `engineDir` is identical either way.
// ⚠️ `import.meta.url` must appear here VERBATIM: Vite's own config bundler rewrites that exact
// expression to a variable holding the ORIGINAL file's URL, and any paraphrase
// (`(import.meta as {url?: string}).url`) slips past the define — the config then reports the
// temp file's own location and the build dies on `engine/node_modules/.vite-temp/index.html`.
const selfUrl: string | undefined =
  typeof import.meta !== 'undefined' ? import.meta.url : undefined
const selfPath = selfUrl
  ? fileURLToPath(selfUrl)
  : typeof __filename === 'string' && __filename
    ? __filename
    : path.join(process.cwd(), 'engine', 'vite.config.ts')
const engineDir = path.dirname(selfPath)
const repoRoot = path.resolve(engineDir, '..')


// #29: build output goes to the OPEN PROJECT's dist/ — a flat one-game project
// owns its own build output (games/<id>/dist), so building game A never clobbers
// game B and each web/device deploy is isolated. MODOKI_PROJECT steers it; unset
// ⇒ repo root (legacy). Capacitor `webDir` and the editor's /api/build web-deploy
// rsync resolve this SAME path so the three stay in lockstep.
const buildProjectRoot = process.env.MODOKI_PROJECT ? path.resolve(process.env.MODOKI_PROJECT) : repoRoot

// Debug build — whether the event journal records, the in-game debug menu ships, AND
// the debug bridge (native TCP / web-WS server carrying device_* MCP tools, INCLUDING
// device_eval — arbitrary JS on the device) ships in THIS build. One flag for all
// three (see project-config.ts's `debugBuild` doc comment for why). Baked as a define
// so the runtime bootstrap (app/main.tsx) can gate all three, and App.tsx can gate the
// debug-menu lazy import, without a config fetch. Always on for the editor (see the
// __MODOKI_EDITOR__ OR in main.tsx/App.tsx); for a shipped GAME build it follows the
// open project's build.debugBuild (default false → off, dropping journal per-event
// overhead, tree-shaking the debug-menu chunk, and tree-shaking the whole
// `./debug/bridge` import so a release build has no eval-capable server to connect
// to). Editor/dev has no project.config.json at repoRoot, so this resolves to false
// there and the __MODOKI_EDITOR__ OR turns it on.
const debugBuildFlag = loadProjectConfig(buildProjectRoot).build.debugBuild === true

// The shipped browser floor — see the `target:` note in `build` below for why it is pinned
// at all. Sanitized here rather than trusted: nothing validates numeric config (#39), and a
// junk value would silently become an esbuild target string like `iosbanana`, which esbuild
// rejects with an error far from its cause. Falls back to the schema default (16.4 — lowering
// below 15.4 needs polyfills; esbuild lowers syntax, it does not add missing runtime APIs).
const rawIosMin = loadProjectConfig(buildProjectRoot).build.iosMinVersion
const iosMinVersion = /^\d+(\.\d+)?$/.test(String(rawIosMin ?? '')) ? String(rawIosMin) : '16.4'

// Absolute dir of @zappar/msdf-generator, pinned so its bare import resolves even when the
// dep-optimize cache is relocated out of the tree in a packaged editor (see resolve.alias
// below). Hoisting puts it at <repoRoot>/node_modules in both the dev clone AND the packaged
// app.asar.unpacked layout; guard with existsSync so a future layout change degrades to Vite's
// default resolution rather than aliasing to a missing path.
const msdfGeneratorDir = (() => {
  const dir = path.join(repoRoot, 'node_modules', '@zappar', 'msdf-generator')
  return fs.existsSync(path.join(dir, 'package.json')) ? dir : null
})()

// PACKAGED-ONLY: same "first seen only once a project opens" class of bug as the
// @modoki/engine subpaths below, but for a GAME's own native-SDK wrapper deps
// (`games/<id>/packages/app-services` — AppLovin/Adjust/Firebase, per CLAUDE.md's
// Native SDK Pattern). Those are dynamic-imported only from inside the game module,
// so Vite's cold-start scan never sees them; it discovers them mid-session instead,
// forces a full reload to re-optimize, and the editor's project-open flow (asset
// import progress dialog) visibly runs TWICE. Confirmed via engine-vite.log: EVERY
// packaged boot logs `dependencies optimized: @capacitor-firebase/analytics,
// @capacitor-firebase/crashlytics` + `optimized dependencies changed. reloading`
// right after the project's dev server comes up — 100% reproducible, not the rare
// race the @modoki/engine include list guards against (though a request landing in
// THAT reload's window is the leading theory for the rare EditorBootBoundary retry
// case in App.tsx). Reads the CURRENTLY OPEN project's app-services package.json
// (buildProjectRoot tracks MODOKI_PROJECT, re-resolved fresh per dev-server spawn —
// see devServer.ts) so this generalizes to any future game's app-services deps
// without hardcoding package names here. Skips file:/link:/workspace: specifiers —
// those are local source packages (like @modoki/engine), not registry deps, and
// forcing them into the optimizer would fight the same class of staleness this is
// meant to fix.
//
// GOTCHA #1 that cost a full extra build/install cycle to find: a bare package NAME in
// optimizeDeps.include resolves relative to VITE'S OWN ROOT (engine/), via ordinary
// node_modules walk-up from there — NOT relative to the game project. `games/<id>`'s
// own node_modules (where these deps actually live, npm workspaces don't hoist them
// to the repo root) is a SIBLING of engine/, not an ancestor, so the bare name never
// resolves and Vite logs "Failed to resolve dependency ... present in client
// optimizeDeps.include" and silently falls back to the exact lazy mid-session
// discovery this was meant to prevent (confirmed via modoki-vite.log on a real
// packaged install — the reload fired anyway).
//
// GOTCHA #2, found immediately after fixing #1 by handing Vite the resolved absolute
// path instead of the bare name: that made the COLD scan succeed, but the game's own
// `import { X } from '@capacitor-firebase/analytics'` in app-services/src/analytics.ts
// still resolves the BARE name from ITS OWN location at live-import time — a different
// id than the absolute path we fed the cold scan, as far as Vite's optimizer cache is
// concerned — so it treated that as a NEWLY discovered dependency and re-optimized +
// reloaded anyway (confirmed live: `_metadata.json` ended up with BOTH the bare name
// AND the raw path as separate optimized entries). Fix: also `resolve.alias` the bare
// name to the SAME resolved path, so cold-scan-time and live-import-time resolution
// produce the identical id — same technique already used for @zappar/msdf-generator
// below, for the same "resolves differently depending on where Vite is looking from"
// class of bug.
//
// `firebase` itself is deliberately NOT force-included even though it's declared in
// app-services/package.json: it's an ESM-only package whose `exports` map has no root
// entry reachable via `require.resolve` (peer dep of @capacitor-firebase/*, never
// imported by bare name from game code) — see the resolution-failure log this emits
// if that ever changes.
const nativeSdkRequire = createRequire(selfPath)
const projectNativeSdkDeps: { name: string; resolvedPath: string }[] = (() => {
  const pkgPath = path.join(buildProjectRoot, 'packages', 'app-services', 'package.json')
  if (!fs.existsSync(pkgPath)) return []
  const appServicesDir = path.dirname(pkgPath)
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { dependencies?: Record<string, string> }
    const names = Object.entries(pkg.dependencies ?? {})
      .filter(([, spec]) => !/^(file:|link:|workspace:)/.test(spec))
      .map(([name]) => name)
    const resolved: { name: string; resolvedPath: string }[] = []
    for (const name of names) {
      try {
        resolved.push({ name, resolvedPath: nativeSdkRequire.resolve(name, { paths: [appServicesDir, buildProjectRoot] }) })
      } catch (e) {
        console.warn(`[vite.config] could not cold-start pre-bundle native-SDK dep "${name}" from ${appServicesDir} — it will still be discoverable lazily at runtime, just re-optimized mid-session (double reload). Resolution error: ${e instanceof Error ? e.message : e}`)
      }
    }
    return resolved
  } catch {
    return []
  }
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

// ── `test:court:quick` — the pre-commit FEEDBACK LOOP for a clone that IS working on Court ──────
//
// Owner, 2026-08-13: *"even for Court, we cannot wait for 7 mins every time we make a change."* The
// file-level gate below buys the OTHER clones their time back; this buys it for the Court session.
//
// ⚠️ **An EXCLUDE list, deliberately — never a keep-list.** The two rot in opposite directions and
// only one of them rots visibly: a new heavy file that nobody adds here makes `quick` slow, which
// you notice on the next run; a new UNIT file missing from a keep-list silently stops being
// covered, and nothing ever tells you. Same fail-toward-running direction as `courtTouched()`.
//
// Sized from a MEASUREMENT, not from which names sound expensive (2026-08-14, this Mac, 731 levels,
// whole Court suite with sweeps OFF — 102 files, 135s wall, per-file test-body time):
//
//   corpus.test.ts          137.0s │ generator.test.ts       9.0s │ every other file  < 1.6s
//   strategies.test.ts       81.4s │ rules.test.ts           3.4s │
//   shapeGeneration.test.ts  37.6s │ hintAudit.test.ts       1.5s │
//
// Three files are 256s of the 275s of test-body time, and they are what this drops. What is left
// runs in ~6s.
//
// ⚠️ **THOSE THREE NUMBERS ARE HISTORICAL as of 2026-08-18** — the same three files were memoised,
// sharded and split that day (corpus 174.9 -> 20.3s, strategies 119.0 -> 16.9s, shapeGeneration
// 113.8 -> 65.2s across five files). They are STILL the right things to exclude, so the list does
// not change; the figures above just record why it was drawn, not what it costs now. ⚠️ Note also
// that the table is per-file TEST-BODY time, which EXCLUDES import — and describe-body work is
// billed to import, which is how shapeGeneration read 37.6s here while the file took 113.8s.
//
// ⚠️ **Measure before adding anything here, because the obvious culprit was not one.** Court's
// files were believed to pay ~5-6s EACH at import — a figure that came from dividing a total which
// one file dominated. `hintPainting.test.ts` was walking the corpus at describe-body scope, where
// `describe.skipIf` cannot reach it (vitest runs a describe callback to collect its tasks), so it
// cost 419s of a 434s run with the sweeps switched OFF. With that fixed, Court's real import cost
// is ~0.4-1.2s per file and the whole suite is 135s. Cutting file count is worth far less than the
// two paragraphs above once suggested.
const COURT_QUICK_EXCLUDE = [
  // The three heavy bodies. `shapeGeneration` RUNS the generator; `corpus`/`strategies` walk all
  // 731 shipped levels through the solver. `generator.test.ts` (9s) is deliberately KEPT — it is
  // the rejection-funnel cover a generator edit breaks first, and this tier can afford it.
  '../games/court/tests/corpus.test.ts',
  '../games/court/tests/strategies.test.ts',
  // A GLOB: `shapeGeneration` split into five files on 2026-08-18 (its describe-body generation
  // was 76.2 s of a 114.3 s file, billed under `import`), so an exact path would have quietly
  // readmitted four of them into the fast loop.
  '../games/court/tests/shapeGeneration*.test.ts',
  // The 60 sharded sweep files. ⚠️ The count has moved three times and in OPPOSITE directions: #216
  // merged three 12-file families into one (36 -> 12), then #223 sharded hintNotes, hintStories and
  // hint.test.ts's two corpus tests (12 -> 48), then corpus.test.ts's rating walk (48 -> 60). With
  // the sweeps off they run ZERO tests (every one
  // skips), so that is several seconds for no assertions whatsoever. A CONVENTION, not an enumeration:
  // `tests/shard.ts` splits a corpus sweep across files because vitest parallelizes by FILE and
  // cannot split one `it()`, so anything `*.shard*` is a corpus walker by construction and a fourth
  // family sharded tomorrow is covered on the day it lands.
  '../games/court/tests/*.shard*.test.ts',
]

/** Is this run the `quick` tier? Announced, because a fast green must never look like a full one. */
const courtQuick = !!process.env.VITEST && process.env.MODOKI_COURT_QUICK === '1'
if (courtQuick) {
  // ⚠️ **This is a FEEDBACK LOOP, not a gate**, and saying so here is the whole point of the
  // banner: CLAUDE.md's rule from the CI-budget incident is that a gate which is silently off is
  // worse than one deliberately off. What `quick` drops is exactly the cover that catches a
  // generator or corpus regression, so a green here licenses a COMMIT, never a ship.
  console.error(
    '\n[court] QUICK TIER — the corpus-walking and sweep files are NOT in this run.\n'
    + '[court] It is a feedback loop, not a gate: a green here means "keep going", not "ready to ship".\n'
    + '[court] Before Court work leaves this clone: MODOKI_COURT_SWEEPS=1 npm test (tier 3).\n'
    + `[court] Excluded: ${COURT_QUICK_EXCLUDE.map((p) => p.replace('../games/court/tests/', '')).join(' ')}\n`,
  )
}

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
    { playable: process.env.VITE_PLAYABLE === '1' },
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

  // OTA Phase 4 — sub-game module target (engine/scripts/build-subgame.mjs sets this,
  // never a normal `vite build`). Builds buildProjectRoot's game.ts as one externalized
  // IIFE (games/<id>/subgame-dist/subgame.js) instead of the shell app. See
  // plugins/subgameBuild.ts + docs/ota-subgame-modules.md §2.
  const isSubgame = command === 'build' && process.env.MODOKI_SUBGAME === '1'
  const subgameEngineApi = loadProjectConfig(buildProjectRoot).ota.engineApi
  // Sub-path hosting (#40). An explicit BASE_PATH still wins. Otherwise ONLY a
  // web-target build takes the project's build.webBasePath — a native build's dist is
  // served from the app root by Capacitor, and a playable is one self-contained file,
  // so both must stay "/". The target arrives as MODOKI_BUILD_TARGET from
  // build-web.mjs (--target); a direct `vite build` (build:editor, build-subgame.mjs)
  // has no target and keeps "/".
  const resolvedBase = process.env.BASE_PATH
    || (process.env.MODOKI_BUILD_TARGET === 'web'
      ? (loadProjectConfig(buildProjectRoot).build.webBasePath || '/')
      : '/')
  if (command === 'build') {
    const source = process.env.BASE_PATH
      ? 'BASE_PATH env'
      : process.env.MODOKI_BUILD_TARGET === 'web'
        ? 'build.webBasePath'
        : 'default'
    console.log(`[vite.config] base=${JSON.stringify(resolvedBase)} (${source})`)
  }
  return {
  root: engineDir,
  // Vite's dep-optimize cache. Default (under the Vite root) is fine for dev, but a
  // PACKAGED editor's bundle is read-only and signed — Vite can't write the cache
  // there. main sets MODOKI_VITE_CACHEDIR to a writable userData path when packaged
  // so optimizeDeps works on first launch. Unset in dev → Vite default.
  ...(process.env.MODOKI_VITE_CACHEDIR ? { cacheDir: process.env.MODOKI_VITE_CACHEDIR } : {}),
  // Sub-path hosting (e.g. GCS bucket served at modoki-engine.com/demo) — see
  // resolvedBase above. Runtime asset URLs are prefixed via assetUrl() to match.
  base: resolvedBase,
  // ELECTRON_PLAN Phase 1: the editor + agent/backend APIs are gated on this
  // explicit flag, NOT on import.meta.env.DEV / import.meta.hot. True in `vite`
  // dev (command==='serve') and for any build that opts in via MODOKI_EDITOR=true
  // (the packaged Electron editor sets it). The game-only web deploy leaves it
  // false, stripping the agent bridge — same as today's DEV gate did.
  define: {
    __MODOKI_EDITOR__: JSON.stringify(command === 'serve' || process.env.MODOKI_EDITOR === 'true'),
    __MODOKI_DEBUG_BUILD__: JSON.stringify(debugBuildFlag),
    __MODOKI_MODULE_RENDER3D__: JSON.stringify(moduleFlags.render3d),
    __MODOKI_MODULE_RENDER2D__: JSON.stringify(moduleFlags.render2d),
    __MODOKI_MODULE_PHYSICS2D__: JSON.stringify(moduleFlags.physics2d),
    __MODOKI_MODULE_PHYSICS3D__: JSON.stringify(moduleFlags.physics3d),
    __MODOKI_MODULE_VIDEO__: JSON.stringify(moduleFlags.video),
    // Playable (Phase 5): the app boots the MRAID/CTA layer only in a playable build,
    // and the CTA routes to this store URL. False/'' in every other build → the whole
    // playable-overlay import DCEs out.
    __MODOKI_PLAYABLE__: JSON.stringify(isPlayable),
    __MODOKI_PLAYABLE_CLICK_URL__: JSON.stringify(isPlayable ? playableBuildCfg.playableClickUrl : ''),
  },
  plugins: [
    react(),
    faviconPlugin(),
    assetScannerPlugin(),
    ...(externalProject ? [hostSharedDeps()] : []),
    ...(isPlayable ? [inlinePlayablePlugin(playableMaxBytes)] : []),
    ...(isSubgame ? [subgameBuildPlugin({ projectRoot: buildProjectRoot, engineApi: subgameEngineApi })] : []),
  ],
  publicDir: false, // No public/ — assets served via convention-based assets/ folders
  build: {
    // ⚠️ PIN THE TARGET — do not delete this and fall back to Vite's default.
    //
    // Vite 8's default `build.target` is 'baseline-widely-available', which resolves to
    // ["chrome111","edge111","firefox114","safari16.4","ios16.4"]. That silently makes
    // **iOS 16.4 the minimum for every game we ship**: esbuild sees ios16.4 as the floor,
    // decides ES2022 static class blocks are supported, and emits three.js's
    // `class e { static { e.prototype.isVector2 = true } }` verbatim.
    //
    // A static block is a PARSE error on older WebKit, so the failure is maximally silent:
    // the whole chunk fails to parse, the module graph dies, and the app hangs on the splash
    // with ZERO JavaScript console output — nothing to grep for. And three.core is on the
    // EAGER boot path (index → renderSettings → three.core), so it takes down 2D-only games
    // too, which have no reason to care about three at all. Found on an iPhone 7 (iOS 15,
    // Court, 2026-08-04); it would equally have hit every other game.
    //
    // The floor is therefore an explicit, reviewed decision rather than whatever the
    // bundler's default drifts to on the next major. It comes from the PROJECT's
    // `build.iosMinVersion` (default 16.4 — raised from 15.4 on 2026-08-04 by owner
    // decision, deliberately dropping the iPhone 7 / 6s / SE1 era), which is the same
    // value that drives the native IPHONEOS_DEPLOYMENT_TARGET — one source of truth, so
    // the bundle's floor and the floor the App Store enforces cannot disagree. They
    // previously did: every pbxproj said 15.0 while the bundle needed 15.4. NOTE this
    // governs SYNTAX only — esbuild lowers syntax, it does not polyfill missing runtime
    // APIs, so lowering `iosMinVersion` below 15.4 needs polyfills (structuredClone /
    // Array.at / Object.hasOwn all land in 15.4 — the hard lower bound regardless of
    // where the floor is currently set).
    // The desktop entries stay pinned: the editor is Electron/Chromium, not a shipped floor.
    target: [`safari${iosMinVersion}`, `ios${iosMinVersion}`, 'chrome87', 'edge88', 'firefox78'],
    // Emit to the open project's dist/ (games/<id>/dist for a flat project; repo
    // root when MODOKI_PROJECT is unset). The asset-shaker follows Rollup's
    // output dir, and Capacitor webDir + /api/build resolve the same path. A
    // playable build diverts to a SEPARATE `ads/` dir (see the isPlayable note above)
    // so it never clobbers the web/native `dist/`.
    outDir: isSubgame ? subgameOutDir(buildProjectRoot) : (isPlayable ? playableOutDir : path.join(buildProjectRoot, 'dist')),
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
    // Sub-game: build the virtual entry (subgameBuildPlugin re-exports the project's
    // game.ts) as one IIFE instead of the default index.html/ESM app build. externals
    // are resolved by that plugin's `resolveId` hook; format/globals MUST be set HERE,
    // in config, not via a plugin's `outputOptions` hook — measured: a plugin-returned
    // outputOptions object was silently not applied (format stayed 'es'), so this
    // config-level `rollupOptions` is the only place confirmed to take effect.
    // NOTE: this Vite ships Rolldown as its bundler, which does not expose IIFE named
    // exports the way classic Rollup does — measured: an `export const` with no other
    // reference was silently dropped (empty bundle) regardless of `treeshake`/`minify`
    // settings. subgameBuildPlugin's entry source works around this by having the
    // module itself assign `globalThis.__MODOKI_SUBGAME__` as a side effect, so
    // `output.name` (Rollup's own iife-export-naming option) is unused here.
    ...(isSubgame ? { rollupOptions: {
      input: SUBGAME_ENTRY_VIRTUAL_ID,
      output: {
        format: 'iife',
        inlineDynamicImports: true,
        entryFileNames: 'subgame.js',
        globals: (id: string) => `__MODOKI_SHARED__.modules[${JSON.stringify(id)}]`,
      },
    } } : {}),
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
    // PACKAGED-ONLY: pre-bundle the @modoki/engine subpaths the DYNAMICALLY-loaded game
    // module imports but the editor's own startup graph does NOT (notably
    // `runtime/rendering`). In a packaged app electron-builder dereferences the
    // @modoki/engine symlink into a real node_modules dir, so Vite OPTIMIZES it. If
    // `runtime/rendering` is first seen only when a project opens, Vite re-optimizes
    // mid-session, rehashes every @modoki_engine_* chunk, and the already-loaded
    // `runtime.js?v=<old>` goes stale → the renderer blanks with "does not provide an
    // export named …". Forcing these into the cold-start optimize gives one stable hash
    // before any game loads. Gated on MODOKI_VITE_CACHEDIR (set only when packaged) so
    // DEV keeps engine HMR — there @modoki/engine is a symlinked SOURCE dep, never
    // optimized, and including it would replace Fast Refresh with full reloads.
    ...(process.env.MODOKI_VITE_CACHEDIR ? {
      include: [
        '@modoki/engine/runtime',
        '@modoki/engine/runtime/rendering',
        '@modoki/engine/runtime/debug',
        '@modoki/engine/editor',
        '@modoki/engine/editor/rendering',
        '@modoki/engine/three',
        ...projectNativeSdkDeps.map(d => d.name),
      ],
    } : {}),
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
    // See GOTCHA #2 by projectNativeSdkDeps above: aliasing each native-SDK bare name to
    // the SAME resolved path fed to optimizeDeps.include makes cold-scan-time and
    // live-import-time resolution agree, so the mid-session re-optimize + reload doesn't
    // fire a second time after the cold pre-bundle already covered it. Same gate
    // (MODOKI_VITE_CACHEDIR, packaged-only) as the include list — they must move together.
    ...(isPlayable
      ? { alias: [
          // BEFORE the package stub — array aliases match in order, and that entry is a
          // PREFIX match, so it would rewrite the runtime's `msdfgen_wasm.wasm?url` import
          // into `<stub>.ts/msdfgen_wasm.wasm` and fail the build outright (ENOTDIR).
          // Unanchored on purpose: the id carries a `?url` query, which a `$`-anchored
          // pattern would not match. Points at an empty 8-byte module so the
          // playable emits a few bytes instead of the real 1.5 MB wasm against its 5 MB cap;
          // it is never instantiated, since the stub generator never initializes.
          { find: /^@zappar\/msdf-generator\/msdfgen_wasm\.wasm/, replacement: path.join(engineDir, 'plugins/playable-msdf-stub.wasm') },
          { find: '@zappar/msdf-generator', replacement: path.join(engineDir, 'plugins/playable-msdf-stub.ts') },
          { find: /^@[^/]+\/app-services$/, replacement: path.join(engineDir, 'plugins/playable-appservices-stub.ts') },
        ] }
      : {
          // ARRAY form, not an object: order matters and the first entry needs a REGEX.
          // The runtime imports `@zappar/msdf-generator/msdfgen_wasm.wasm?url` so Vite emits
          // the wasm as a hashed asset (the worker's own `new URL(...)` fallback is buried in
          // an emscripten ternary Vite cannot see, so nothing shipped and the worker 404'd —
          // that is what stuck Court's iOS build on its splash screen). The package-DIR alias
          // below would rewrite that subpath to <pkg>/msdfgen_wasm.wasm, which does not exist;
          // a plain STRING find cannot pre-empt it because @rollup/plugin-alias does not match
          // an id carrying a `?url` query. Hence the unanchored regex, first.
          //
          // Import the package's EXPORTED name, never `dist/…`: outside this config (the
          // engine package's own vitest project has no aliases at all) the exports map is what
          // resolves it, and it exposes only the exported name. Using `dist/` here failed to
          // collect 114 engine test files.
          alias: [
            ...(msdfGeneratorDir ? [
              { find: /^@zappar\/msdf-generator\/msdfgen_wasm\.wasm/, replacement: path.join(msdfGeneratorDir, 'dist', 'msdfgen_wasm.wasm') },
              { find: '@zappar/msdf-generator', replacement: msdfGeneratorDir },
            ] : []),
            ...(process.env.MODOKI_VITE_CACHEDIR
              ? projectNativeSdkDeps.map(d => ({ find: d.name, replacement: d.resolvedPath }))
              : []),
          ],
        }),
  },
  test: {
    // Paths are relative to root (engineDir): tests/ and packages/ live under engine/.
    globals: true,
    // Worker cap, shared with the engine suite — vitest's `availableParallelism() - 1` counts
    // Apple-Silicon EFFICIENCY cores and Windows SMT siblings as if they were cores, and both cost
    // more than they buy. `engine/testWorkers.ts` owns the measurement for every platform; do not
    // restate it here. (This comment used to carry a copy, and the copy went stale the day the
    // win32 branch landed — it still claimed Windows keeps vitest's default.)
    // `engine/scripts/verify.mjs` overrides it per lane so its concurrent pools do not
    // oversubscribe each other.
    ...perfCoreWorkers(),
    // Coverage is OFF unless --coverage is passed; this block only says what to measure
    // when it is. It exists because every coverage number this repo had acted on came
    // from a `grep`-for-imports proxy (see docs/editor.md § Panels), which
    // over-counts transitively-exercised modules and under-counts assertion depth.
    // `all` is deliberately on: an untested file must appear at 0%, not be absent — the
    // whole question here is "what does NO test reach", which a tested-files-only report
    // cannot answer. It costs a transform of every included file, which is why the
    // include list is the shipped source we actually gate on, not the whole tree.
    coverage: {
      provider: 'v8',
      all: true,
      // The SECOND of two legs (see the engine package's vitest.config.ts for the mechanism
      // and for the two merge strategies that failed silently). This leg emits raw per-file
      // data only; engine/scripts/merge-coverage.mjs turns both legs into the real report.
      // Its include paths all live under engine/, which is why the MERGED report is
      // attributed from this leg's root — a glob cannot reach up out of a run's root.
      reportsDirectory: './coverage/.legs/root', // engine/coverage — gitignored
      reporter: ['json'],
      include: [
        'packages/modoki/src/editor/**/*.{ts,tsx}',
        'packages/modoki/src/runtime/**/*.{ts,tsx}',
        'packages/modoki/src/three/**/*.{ts,tsx}',
        'app/**/*.{ts,tsx}',
        'plugins/**/*.ts',
        'electron/**/*.ts',
      ],
      exclude: [
        '**/*.d.ts',
        '**/*.test.{ts,tsx}',
        '**/__mocks__/**',
        // Type-only barrels and generated files carry no decisions to cover.
        '**/index.ts',
      ],
    },
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
      // public OSS repo (docs/engine-oss-publishing.md). DEMO-GAME tests live with
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
      'tests/architecture/**/*.test.ts',
      // App-shell boot (engine/app/App.tsx). `.tsx` because the once-per-gameId boot
      // contract (#267) is a React SCHEDULING property — only a real render can pin it.
      'tests/app/**/*.test.tsx',
      // MCP server units (result formatting, identity) — `tools/` ships to the agent,
      // not to a game, but it is still CI-gated code.
      'tests/tools/**/*.test.ts',
      // Project-owned tests (game/demo logic + @3d-test/app-services packages). Co-located
      // with the project's code so their deps resolve from its own node_modules; each glob
      // matches nothing when that root is absent (the public repo has neither).
      // KEEP IN SYNC with PROJECT_ROOT_DIRS in engine/scripts/projectRoots.mjs — static
      // config can't import it.
      //
      // Dropped from a COVERAGE run only (`npm run coverage`). V8's precise-coverage mode
      // deoptimizes hot functions, measured at 3.6x on Court's solver (13.6s → 48.6s of test
      // time for hintIntegration+corpus on the Windows clone) — enough to blow both the 20s
      // default timeout and hintAudit's 900s budget, so the run died before emitting a report.
      // Excluding them is not just expedient: these tests exercise GAME code, and no game
      // source is in the coverage include list, so instrumenting them buys nothing here.
      // The honest cost is that engine `runtime/**` coverage becomes a LOWER bound (a game
      // test reaching engine runtime no longer counts); editor coverage — what this run
      // exists to measure — is unaffected, since no game test can reach editor source.
      ...(process.env.MODOKI_COVERAGE_ENGINE_ONLY === '1' ? [] : [
        '../games/*/tests/**/*.test.ts',
        '../games/*/tests/**/*.test.tsx',
        '../games/*/packages/*/**/*.test.ts',
        '../demos/*/tests/**/*.test.ts',
        '../demos/*/tests/**/*.test.tsx',
        '../demos/*/packages/*/**/*.test.ts',
      ]),
    ],
    exclude: [
      '**/node_modules/**',
      'packages/**',
      // electron-builder output (gitignored) — a full repo copy under app.asar.unpacked
      // that vitest would otherwise re-discover and run as duplicate (often stale) tests.
      '**/release/**',
      // ── COURT'S TESTS, on a clone that has nothing to do with Court ──────────────────────────
      //
      // Owner, 2026-08-13: *"other clones who don't work on court doesn't need to run this"*. The
      // hard-track production run took the corpus 184 -> 731 and the app-tests leg from ~110s to
      // 507s here; the Windows clone is ~4.5x slower again.
      //
      // A FILE-LEVEL exclusion, so a clone with nothing to do with Court does not even discover
      // these files. `sweepGate.ts`'s gates remain, for a clone that IS on Court and wants tiers.
      //
      // ⚠️ **The original justification here was WRONG and is worth not repeating.** It read
      // "`describe.skipIf` does not save wall clock — each of Court's ~100 files pays ~5s at
      // import", from a measurement where gating every corpus-walking describe moved test-body time
      // 255.7s -> 50.7s and wall clock 412s -> 428s. The clock did not move because BOTH arms were
      // pinned by one file walking the corpus at describe-body scope, where a `skipIf` cannot reach
      // it (vitest runs a describe callback to collect its tasks, and bills that under `import`).
      // With `hintPainting.test.ts` fixed on 2026-08-14 the whole Court suite went 434s -> 135s,
      // and Court's real per-file import is ~0.4-1.2s. The exclusion still earns its place
      // (`verify` 145s -> 43s here, measured 2026-08-14 after the fix) — just not for that reason.
      // ⚠️ That pair is a SNAPSHOT and the "with Court" half is superseded: `verify` is 82-86s as
      // of 2026-08-18 (games/court/test-cost.md § 9). The exclusion's value has not been
      // re-measured since, so treat 43s as un-refreshed rather than current.
      //
      // Same predicate as those gates (`courtAuthored.mjs`, one implementation, two consumers) and
      // the same fail-safe direction: `courtTouched()` returns `null` when git cannot answer, and
      // only an explicit `false` excludes. So a broken detector runs the tests rather than silently
      // dropping them — the failure mode that makes a gate worse than no gate.
      //
      // `MODOKI_COURT_TESTS=1` forces them back in (and any Court env override implies it, so
      // `MODOKI_COURT_SWEEPS=1` on a non-Court clone still works rather than mysteriously running
      // nothing); `=0` forces them OUT, which is how a Court-authoring clone measures what everyone
      // else now pays, and how you bisect an unrelated failure without Court in the way. Guarded on
      // `VITEST` because this config also serves the dev server, which must never pay a git probe.
      ...(process.env.VITEST && (
        process.env.MODOKI_COURT_TESTS === '0'
        || (!process.env.MODOKI_COURT_TESTS
            && !process.env.MODOKI_COURT_SWEEPS
            && !process.env.MODOKI_COURT_CORPUS
            && !process.env.MODOKI_COURT_QUICK
            && courtTouched() === false)
      ) ? ['../games/court/tests/**'] : []),
      // The quick tier's heavy files (see COURT_QUICK_EXCLUDE above). Here rather than on the
      // vitest CLI because **`--exclude` on the command line does not narrow the config's
      // exclude — it replaces the option and was measured doing nothing**: an `--exclude` of the
      // three heaviest files still ran all 102 (`Test Files 60 passed | 42 skipped (102)`) and took
      // 483s. The only exclusion vitest honours here is this array.
      ...(courtQuick ? COURT_QUICK_EXCLUDE : []),
    ],
  },
  }
})
