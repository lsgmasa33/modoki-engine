/** Project configuration — the single source of truth for project-specific
 *  constants that the editor's "Project Settings" window edits.
 *
 *  This file is intentionally PURE (no Node imports) so it is safe for the
 *  browser type graph. The Node-side reader lives in
 *  plugins/load-project-config.ts; the browser receives resolved VALUES via
 *  the `virtual:modoki-project-config` module (see vite-asset-scanner.ts).
 *
 *  That "values come from the virtual module" rule is about the resolved CONFIG,
 *  not about this module as a whole: the string-union constants below (ORIENTATIONS,
 *  TONE_MAPPINGS, …) are imported as real values by the editor's Project Settings
 *  (app/editor/setup.ts) so the dropdowns and the validator cannot drift. That is
 *  safe precisely because this file is import-free — and it costs a game build
 *  nothing, since setup.ts only exists in the `__MODOKI_EDITOR__` chunk.
 *
 *  TWO FILES (deliberate split):
 *   - project.config.json  — COMMITTED, shareable project data (identity, scenes,
 *     web deploy target, renderer/physics, capacitor). Owned by {@link ProjectConfig}.
 *   - project.user.json    — GITIGNORED, per-machine settings (which physical device
 *     to deploy to, local SDK paths). Owned by {@link ProjectUserConfig}. Never
 *     committed, so one dev's device UDID / JAVA path never leaks into the repo.
 *
 *  THE FILE STAYS MINIMAL. project.config.json records only what the project
 *  CHOSE; everything else resolves from {@link DEFAULT_PROJECT_CONFIG} at load.
 *  So a save must never write back the fully-RESOLVED config — that bakes today's
 *  engine defaults into every project (it once handed an internal game the demo
 *  deploy bucket) and hard-couples the file to the defaults of the day. Writers go
 *  through {@link deepMergeConfigPatch} + {@link pruneProjectConfig}; readers go
 *  through {@link mergeProjectConfig}. Don't collapse those two merges into one —
 *  see the note on deepMergeConfigPatch. */

/** A project's declaration of one model postprocessor (the Stage-A bake recipe
 *  for a GLB). The PROJECT owns this — the engine no longer hardcodes per-game
 *  postprocessor source paths — so a flat one-game project points `file` at its
 *  own `runtime/postprocessor.ts`. Keyed by the postprocessor id stored in each
 *  model's `.meta.json` (`postprocessor` field). */
export interface ModelPostprocessorDecl {
  /** Bumped when the postprocessor's fixupMesh/resolveImportOptions recipe
   *  changes, to invalidate the model cache. MUST match the `recipeVersion` on
   *  the runtime ModelPostprocessor object (drift is warned at startup). */
  recipeVersion: number;
  /** PROJECT-RELATIVE path to the postprocessor source (e.g.
   *  "runtime/postprocessor.ts"). Resolved to an absolute path against the
   *  project root and SSR-loaded at bake time so the runtime registry populates
   *  server-side — no dependence on the (ambiguous) Vite/SSR root. */
  file: string;
  /** Exported function that registers the postprocessor (e.g.
   *  "registerIslandPostprocessor"). Postprocessors that auto-register at module
   *  load can omit it. */
  registerFn?: string;
}

/** One scene's entry in the project's build list. Scenes are discovered on disk
 *  (any `.json` under a `scenes/` dir); this list adds ORDER + an include flag on
 *  top of discovery. The first INCLUDED entry is the project's boot scene.
 *  Referenced by GUID (stable across renames); a scene found on disk but missing
 *  from this list is treated as included and appended. */
export interface SceneEntry {
  /** Stable asset GUID of the scene JSON. */
  guid: string;
  /** Whether the scene is bundled into the build. */
  include: boolean;
}

/** A build-time engine-module include/exclude toggle. `'auto'` resolves from a
 *  scan of the project's included scenes (see plugins/detect-modules.ts) at build
 *  time; `true`/`false` force the module in/out. Excluding an unused module
 *  tree-shakes its SDK (three.js / pixi.js / Rapier) out of the bundle — the same
 *  flag-gated-lazy-import mechanism the debug menu / journal use (App.tsx). */
export type ModuleToggle = 'auto' | boolean;

/** Per-project include/exclude of the heavy engine SDKs. Drives build-time
 *  tree-shaking for every target (web / native / playable) and is surfaced as
 *  Auto | On | Off checkboxes in Project Settings → Engine Modules. Each field
 *  defaults to `'auto'` (detect from the included scenes). */
export interface BuildModules {
  /** Three.js 3D renderer (Scene3D + the three.webgpu / TSL node pipeline). */
  render3d: ModuleToggle;
  /** PixiJS 2D renderer (Scene2D / Game). */
  render2d: ModuleToggle;
  /** Rapier 2D physics. */
  physics2d: ModuleToggle;
  /** Rapier 3D physics. */
  physics3d: ModuleToggle;
  /** Video playback (HTMLVideoElement decode, video textures, the remote-clip cache).
   *  `'auto'` detects a `VideoPlayer` trait, EXCEPT on a `--target playable` build, where
   *  'auto' resolves OFF: a ≤5 MB MRAID bundle and a video file are close to mutually
   *  exclusive. Set it to `true` to keep video in a playable anyway — a 400 KB stinger is a
   *  legitimate thing to want, so the capability is defaulted off rather than removed. */
  video: ModuleToggle;
}

/** One engine-module key (a field of {@link BuildModules}). */
export type ModuleKey = keyof BuildModules;

/** A project's authored degradation for one tier below the default
 *  (docs/rendering.md § "Quality tiers") — every field a tier may clamp, seeded
 *  from the engine's measured `TIER_SETTINGS` when a project adds one. Mirrors
 *  `TierRenderOverrides` (runtime/rendering/qualityTier.ts) field-for-field; restated rather than
 *  imported because this file is deliberately import-free (see the header). */
export interface TierOverridesConfig {
  pixelRatioCap: number;
  antialias: boolean;
  shadows: boolean;
  shadowMapCeiling: number;
  /** Per-effect post-FX gate (§3 "Post-FX is PER EFFECT, not one switch") — the same five keys
   *  as the engine's `PostFXEffect`. */
  postFX: {
    npr: boolean;
    ao: boolean;
    dof: boolean;
    bloom: boolean;
    vignette: boolean;
  };
  maxDirectional: number;
  maxLocal: number;
  /** Fraction in [0, 1) a challenger light must beat the incumbent selection by before it
   *  replaces it (#353). Mirrors `TierRenderOverrides.hysteresisMargin`
   *  (runtime/rendering/qualityTier.ts) — undefined/0 disables it, matching today's plain
   *  nearest/most-effective selection. */
  hysteresisMargin?: number;
  /** Most lights that may render a shadow map this frame. **0 = unlimited** (#229). Mirrors
   *  `TierRenderOverrides.maxShadowCasters` (runtime/rendering/qualityTier.ts) — separate from
   *  `maxDirectional`/`maxLocal` (those cap how many lights SHADE a fragment; this caps how many
   *  RENDER a shadow map, a whole extra scene submit each) and from `shadowMapCeiling` (that caps
   *  a map's size, not how many are rendered). */
  maxShadowCasters: number;
  ibl: boolean;
  iblOffAmbientBoost: number;
  iblOffExposure: number;
  /** Frame cap this tier imposes, in fps. **0 = no tier cap** — the same sentinel as
   *  `rendering.targetFps` above, which is why the engine clamps it through
   *  `applyTierToTargetFps` and not a `Math.min` (#202). */
  targetFps: number;
  /** The 2D analogue of `pixelRatioCap`, applied to the PixiJS backing buffer. **0 = uncapped**
   *  (matching `rendering.pixi.pixelRatioCap`'s own convention). `pixi.resolution` is deliberately
   *  NOT tiered — it is a pin, and capping a pin would make the pin a lie. */
  pixiPixelRatioCap: number;
  /** The 2D analogue of `antialias`. Baked into the Pixi `Application` at slot creation, so a live
   *  tier change catches up on the next slot rather than applying immediately. */
  pixiAntialias: boolean;
  /** Longest-edge cap for a TEXTURE on this tier, in pixels (texture LOD by quality tier, #212).
   *  **0 = no cap** (ship the source size). Mirrors `TierRenderOverrides.textureMaxSize`
   *  (runtime/rendering/qualityTier.ts) — this file restates rather than imports it (see the
   *  header). Read by the build emitter (`vite-asset-scanner.ts`) to decide which extra
   *  downscaled variants to convert; never touches format/codec selection. */
  textureMaxSize: number;
}

export interface ProjectConfig {
  app: {
    /** Capacitor appId / native bundle identifier. */
    appId: string;
    /** Capacitor appName / display name. */
    appName: string;
    /** PROJECT-RELATIVE path to the source app-icon PNG (a single square image,
     *  ideally 1024×1024). The build generates all iOS AppIcon + Android mipmap
     *  sizes from it. Empty = use the bundled Modoki icon. */
    iconSource: string;
    /** Marketing version — what a player sees in the store listing ("1.0", "2.3.1").
     *  Synced by `healAndroidVersion` into `versionName` and by `healIosVersion` into
     *  `MARKETING_VERSION` (which `Info.plist` reads as `CFBundleShortVersionString`
     *  via `$(MARKETING_VERSION)`). Free-form: the stores accept anything dotted, and
     *  it carries no ordering requirement of its own. */
    version: string;
    /** Build number — the MONOTONIC integer both stores dedupe uploads by
     *  (`versionCode` on Android, `CFBundleVersion`/`CURRENT_PROJECT_VERSION` on iOS).
     *  ONE field for both platforms: their counters are independent, but a single value
     *  that only ever moves up satisfies both, and two fields is one more thing to
     *  forget.
     *
     *  ⚠️ **This exists because a duplicate is refused SILENTLY** (#199). Play does not
     *  say "that versionCode is taken" — the bundle simply never attaches, and the
     *  release page then reports three errors that all mean "this release is empty"
     *  and none of which mention versions. It reads as a broken upload rather than a
     *  refused one, so the first instinct is to re-upload, re-export, or re-check
     *  signing. App Store Connect behaves the same way, with a different but equally
     *  indirect message. Before this field, every project shipped the scaffolder's
     *  hardcoded `1` and nothing ever changed it.
     *
     *  ⚠️ **The heal never LOWERS a native value** — see `healAndroidVersion`. Lowering
     *  is the one direction that is always a mistake, and it is exactly what a stale or
     *  fresh-clone config would do to a project that has already uploaded.
     *
     *  NOT auto-incremented, on purpose: a build number that changes itself makes builds
     *  non-reproducible and churns a committed file on every build (the #18
     *  write-behind-your-back hazard). The owner bumps it — or flips {@link buildNumberAuto}
     *  on and the heal derives it instead. */
    buildNumber: number;
    /** AUTO build number. When TRUE, the typed {@link buildNumber} above is IGNORED and the
     *  effective number is derived from `git rev-list --count HEAD` of the project's repo at
     *  every open/build — no hand-bumping per store upload. The typed value still acts as a
     *  FLOOR (`max` of the two) so a store-forced jump stays possible without turning auto off.
     *  The native files always see ONE resolved number; how it was derived never leaks into them.
     *
     *  Commit counts differ between clones (main vs a worker branch) and are shared by every
     *  game in the repo; both are absorbed by the never-lower guard, since only uploads care.
     *  A project copied OUT of its repo (no git) falls back to {@link buildNumber} with a note. */
    buildNumberAuto: boolean;
  };
  content: {
    /** Ordered build scene list (see {@link SceneEntry}). The first INCLUDED
     *  entry is the boot scene. Empty = fall back to on-disk discovery + the
     *  game's own boot scene. */
    scenes: SceneEntry[];
  };
  build: {
    /** Web deploy target after the `dist/` build:
     *   - `none`   → stop at `dist/` (reveal in Finder). "Not everyone has GCS."
     *   - `gcs`    → built-in gcloud rsync + cache + CDN (uses webBucket + webCdn*).
     *   - `custom` → run webDeployCommand (uses {dist} {base}); bucket/CDN ignored.
     *  The webBucket / webCdn* fields ONLY apply in `gcs` mode; webDeployCommand
     *  ONLY in `custom`. */
    webDeployMode: (typeof WEB_DEPLOY_MODES)[number];
    /** GCS bucket the web build is rsynced to (gcs mode). */
    webBucket: string;
    /** Vite BASE_PATH for the web build (sub-path hosting). */
    webBasePath: string;
    /** Cloud CDN url-map name fronting the bucket. When set, the web deploy
     *  invalidates `<webBasePath>*` so a redeploy isn't masked by the edge cache.
     *  Empty = no CDN / skip invalidation. */
    webCdnUrlMap: string;
    /** Cloud CDN backend-bucket name fronting the bucket. When set, the web deploy
     *  whitelists the `v` query param in its cache-key policy (idempotent) so the
     *  content-hash `?v=<hash>` busts the edge cache per-version, and marks the
     *  content-hashed binaries (.glb/.ktx2/.webp) immutable. Empty = leave the
     *  binaries non-immutable. */
    webCdnBackendBucket: string;
    /** Custom web-deploy command run AFTER the `dist/` build (webDeployMode
     *  `custom`). Placeholders: `{dist}` (abs path to the built dist dir),
     *  `{base}` (webBasePath). Runs via the user's shell, so — unlike the other
     *  build fields — it is NOT metachar-sanitized (it's a command the project
     *  author wrote). */
    webDeployCommand: string;
    /** Apple Developer Team ID for iOS signing (the 10-char team, e.g.
     *  ABCDE12345). Org-level (shared across the team's builds) so it lives in the
     *  committed config, not project.user.json. The editor's heal-on-open syncs it
     *  into the iOS project's DEVELOPMENT_TEAM. Empty = leave the pbxproj as-is. */
    appleTeamId: string;
    /** Minimum iOS version this project supports — the SINGLE source of truth for the
     *  floor, driving BOTH halves of it:
     *   - the JS bundle's syntax target (`build.target` in vite.config.ts → `ios<x>`/`safari<x>`)
     *   - the native `IPHONEOS_DEPLOYMENT_TARGET`, synced by `healIosDeploymentTarget`
     *
     *  They were two independent hardcoded numbers that DISAGREED: every project's pbxproj
     *  said 15.0 while the bundle required 15.4, so the App Store would offer the game to a
     *  15.0–15.3 device that installs it and then dies on `structuredClone`/`Array.at`/
     *  `Object.hasOwn`. One value, two consumers, so they cannot drift again.
     *
     *  ⚠️ Lowering this below 15.4 needs POLYFILLS, not just a smaller number. esbuild lowers
     *  syntax; it does not add missing runtime APIs, and those three land in exactly 15.4. */
    iosMinVersion: string;
    /** Minimum Android SDK (API LEVEL, not the marketing version — 31 = Android 12) this
     *  project supports — the Android sibling of `iosMinVersion`. The SINGLE source of
     *  truth for the floor, synced into every project's `android/variables.gradle`
     *  `minSdkVersion` by `healAndroidMinSdk` on project open/build.
     *
     *  It exists for the same reason `iosMinVersion` does: `cap add` generates
     *  `minSdkVersion = 24`, and without a heal that number just sits there uninspected —
     *  every newly-scaffolded project silently reverts to API 24 and the floor drifts
     *  per-project, exactly the drift `iosMinVersion` was introduced to stop on iOS. */
    androidMinSdk: number;
    /** Debug build — ships the event journal (`emit`/`modoki_journal`), the in-game
     *  debug menu (F12 / 3-finger tap: stats, world inspector, cheats, …), AND the
     *  on-device debug server (native TCP + UDP beacon / web-WS) that every
     *  `device_*` AI tool connects to, INCLUDING `device_eval`, which runs ARBITRARY
     *  JavaScript on the device. One flag because in practice nobody wants a subset —
     *  it's "is this a build I debug with," not three independent choices. Always on
     *  in the editor (dev + the packaged Electron editor, gated by
     *  `__MODOKI_EDITOR__`); OFF by default in a shipped game build so the journal
     *  stops recording, the debug-menu chunk tree-shakes out, and the whole
     *  `./debug/bridge` import tree (incl. `device_eval`'s eval capability)
     *  tree-shakes out — a release build has no eval-capable server to connect to.
     *  Set true for a QA/playtest/profiling game build that needs any of this on
     *  device. (Previously the debug bridge was ungated on native, so every native
     *  build shipped it; this flag closes that exposure.)
     *
     *  NOTE the LOADER default below stays `false` — a config that omits the key
     *  is off — but the scaffolder template sets `"debugBuild": true`, so a NEWLY
     *  created project is debuggable/profilable out of the box and must be turned
     *  OFF before it ships (#239: six of twenty projects were unreachable by every
     *  `device_*` tool, each costing a config flip + rebuild to measure). */
    debugBuild: boolean;
    /** Build-time engine-module include/exclude toggles — tree-shakes unused
     *  SDKs (three.js / pixi.js / Rapier) out of the bundle. Each defaults to
     *  `'auto'` (detect from the included scenes; see plugins/detect-modules.ts).
     *  Resolved to `__MODOKI_MODULE_*__` Vite defines that flag-gate the module's
     *  lazy import. See docs/playable-export.md. */
    modules: BuildModules;
    /** Max byte size of a single-file `playable` build's `index.html` (Phase 4).
     *  The inliner (`inlinePlayable.ts`) FAILS the build if the self-extracting
     *  artifact exceeds this — a playable ad has a hard network ceiling (AppLovin
     *  5 MB; the portable cross-network floor is Meta's 2 MB). Default 5 MB. Only
     *  consulted by a `playable` target build; ignored by web/native builds.
     *  See docs/playable-export.md. */
    playableMaxBytes: number;
    /** Store/click-through URL the playable's CTA/install button routes to via
     *  `mraid.open` (Phase 5). Empty = the CTA still shows but the tap is a no-op
     *  (set it to the App Store / Play listing before shipping). */
    playableClickUrl: string;
    /** Ad network the playable targets (Phase 5/8) — reserved for per-network CTA/
     *  MRAID quirks. Default 'applovin'. */
    playableNetwork: (typeof PLAYABLE_NETWORKS)[number];
    /** Per-tier texture LOD variants (#212): every size ships INSIDE the package, so it's a
     *  real cost for a native install (measured: +19% dist) that only pays off when the
     *  device actually fetches just the variant it needs — i.e. when the payload travels over
     *  the wire (a web build, or a native build shipped via OTA). 'auto' (default) emits under
     *  exactly that condition; 'always' is the native opt-IN for a project whose textures are
     *  huge enough that the boot-time/GPU-memory win is worth the install size; 'never' opts a
     *  web project out. See `plugins/textureTierEmit.ts`. */
    textureTierVariants: (typeof TEXTURE_TIER_VARIANTS_MODES)[number];
  };
  /** Native Capacitor shell settings, synthesized into `capacitor.config.json`
   *  (previously hardcoded in the generator) plus native-project patches applied
   *  by healNativeConfig (orientation + status bar). */
  capacitor: {
    /** Web assets dir Capacitor serves from (relative to the project). */
    webDir: string;
    /** iOS `preferredContentMode` ('mobile' | 'desktop' | 'recommended'). */
    iosContentMode: (typeof IOS_CONTENT_MODES)[number];
    /** Android URL scheme ('http' | 'https'). */
    androidScheme: (typeof ANDROID_SCHEMES)[number];
    /** Android `allowMixedContent`. */
    allowMixedContent: boolean;
    /** Capacitor Keyboard plugin `resize` mode ('none' | 'native' | 'body' | 'ionic'). */
    keyboardResize: (typeof KEYBOARD_RESIZE_MODES)[number];
    /** Supported device orientation → iOS UISupportedInterfaceOrientations +
     *  Android android:screenOrientation. 'auto' = allow both portrait+landscape. */
    orientation: 'auto' | 'portrait' | 'landscape';
    /** Hide the OS status bar (clock/wifi/battery) → iOS UIStatusBarHidden, and on Android
     *  IMMERSIVE fullscreen: both the status bar AND the navigation (back/home/recents) bar,
     *  re-hidden on every focus regain. Android is the asymmetric one on purpose — iOS has no
     *  second bar, so "status bar hidden" there already means "the game owns the screen"; leaving
     *  Android's nav bar up would honour the name and miss the intent. Applied by
     *  `healAndroidFullscreen` (healNativeConfig.ts), which patches MainActivity.java. */
    statusBarHidden: boolean;
    /** Status-bar content style → iOS UIStatusBarStyle. 'default' = OS decides,
     *  'light' = light text (dark bg), 'dark' = dark text (light bg). */
    statusBarStyle: 'default' | 'light' | 'dark';
  };
  /** Renderer settings for the two engine render backends. */
  rendering: {
    /** Target frame rate for the rAF loop. 0 = uncapped (display refresh). A
     *  positive value throttles the loop (e.g. 30/60) to save battery/heat. */
    targetFps: number;
    /** Message shown over the brief overlay while a LIVE quality-tier promotion is applied
     *  (#227). Authored per project because it is player-facing copy: it needs each game's
     *  voice and its language, and the engine cannot supply either. Empty string = fall back
     *  to the engine default.
     *
     *  Why a message exists at all: a tier switch recompiles shaders — ~1.2 s per distinct
     *  program, measured 2.9 s on a Galaxy A23 and 16.5 s on a Huawei Y6 for postfx-demo's 14
     *  pairs (runtime/rendering/scene3DSync.ts). A promotion normally hides that inside a scene
     *  load, but a single-scene game never reaches one, so the stall lands mid-play and the
     *  player is owed an explanation rather than a freeze. */
    tierSwitchMessage: string;
    three: {
      /** GPU API: 'auto' (detect, prefer WebGPU) | 'webgpu' | 'webgl'. */
      backend: 'auto' | 'webgpu' | 'webgl';
      antialias: boolean;
      /** Upper bound on devicePixelRatio (perf vs sharpness). */
      pixelRatioCap: number;
      shadows: boolean;
      /** Quality tier (#121): 'auto' delegates to the device allowlist + on-device calibration;
       *  'low'/'mid'/'high' pin it. A tier CLAMPS the settings above — it never raises them — so
       *  'high' is exactly today's behaviour and the fields beside it stay authoritative.
       *
       *  **Defaults to 'auto' since #155**, which resolves LOW on anything not allowlisted (a
       *  desktop excepted). Pin 'high' to opt a project out — but note what that opts into: a
       *  Y6 2019 booting 'high' took a 6388 ms post-FX submit, lost its GPU context and stayed
       *  blank, where 'auto' holds 27-33 fps on the same phone. */
      qualityTier: 'auto' | 'low' | 'mid' | 'high';
      /** Tone-mapping operator ('ACESFilmic' | 'AgX' | 'Neutral' | 'Linear' | 'None'). */
      toneMapping: (typeof TONE_MAPPINGS)[number];
      exposure: number;
      /** A project's authored `mid`/`low` degradation configs
       *  (docs/rendering.md § "Quality tiers") — ABSENT, not an empty object, when
       *  the project has authored neither. **Presence is the signal**: no `tiers` means one
       *  config (the default, i.e. no clamping at all) means nothing to choose between means
       *  the boot probe does not need to run (§2.2, A2). A project adds `mid`/`low` only to opt
       *  into degradation; `rendering.three` above gains nothing from this field existing. */
      tiers?: {
        mid?: TierOverridesConfig;
        low?: TierOverridesConfig;
      };
    };
    pixi: {
      /** GPU API: 'auto' (detect, prefer WebGPU) | 'webgpu' | 'webgl'. */
      backend: 'auto' | 'webgpu' | 'webgl';
      antialias: boolean;
      /** Pixi renderer resolution; 0 = auto (devicePixelRatio). */
      resolution: number;
      /** Upper bound on devicePixelRatio for the auto path only (perf vs sharpness);
       *  a pinned `resolution` above is never capped. Mirrors `three.pixelRatioCap`. */
      pixelRatioCap: number;
    };
    /** How the web canvas is sized in the browser build:
     *   - `free`  → fill the window responsively (default).
     *   - `fixed` → render at width×height and letterbox/scale to fit.
     *   - `max`   → fill the window but clamp the render buffer to at most
     *              width×height (keeps 4K/desktop from tanking FPS). */
    web: {
      sizeMode: 'free' | 'fixed' | 'max';
      width: number;
      height: number;
    };
  };
  /** 2D physics (Rapier). Up to 16 named collision layers (index = bit position,
   *  index 0 = 'Default') + a symmetric collision matrix, where
   *  `collisionMatrix[i]` is the 16-bit mask of the layers layer i collides with.
   *  Pushed into the runtime at boot. (World gravity is authored per-scene on the
   *  `Physics2D` trait, not here.) */
  physics: {
    layers: string[];
    collisionMatrix: number[];
  };
  /** Model postprocessors this project ships, keyed by id (the `postprocessor`
   *  field in a model's `.meta.json`). Drives the Stage-A bake. Empty/absent =
   *  no project postprocessors. */
  postprocessors: Record<string, ModelPostprocessorDecl>;
  /** OTA update client config (docs/ota-updates.md, Phase 3a) — read by the app
   *  shell (App.tsx) at boot, not by game code. `enabled: false` (the default)
   *  means the shell skips the check entirely, so an unconfigured project pays
   *  no network cost and never dynamic-imports the plugin. */
  ota: {
    enabled: boolean;
    /** Base URL the bucket is served from, e.g. "https://cdn.example.com/games/mygame"
     *  (no trailing slash). Empty when disabled. */
    baseUrl: string;
    /** Ed25519 public key (base64url, 32 raw bytes) baked into the app — the
     *  counterpart of the PRIVATE key in build/ota-keys/<name>.json (gitignored,
     *  never committed). Losing the private key means these installed binaries
     *  can never be updated again. */
    publicKey: string;
    /** The bundle this running app instance drives. Phase 1-3 are single-game,
     *  so this is always 'shell'; Phase 4 sub-games get their own bundle name. */
    bundleName: string;
    /** This BUILD's own engine-API version, stamped in — NOT a designer-tunable
     *  knob. It's what `checkForUpdate` compares an incoming manifest/release
     *  against to refuse an update this running JS can't execute. A build
     *  produced by a newer/older engine should carry a different value; hand-
     *  editing this to "fix" a rejected update defeats the gate it exists for.
     *  Must equal `ENGINE_API_VERSION` (`runtime/core/version.ts`) — this file stays
     *  import-free (see header), so the two are pinned together by a vitest
     *  rather than a shared import. */
    engineApi: number;
  };
}

/** The `build.*` fields that must never reach a PUBLIC repo — Apple's Team ID,
 *  internal GCS bucket/CDN names, and a deploy command that can embed either.
 *  Anything we do not want to ship to a public repo belongs in the per-machine
 *  local config (`project.user.json`, gitignored), not the committed
 *  `project.config.json` — the publish-time scrub (`SCRUBBED_BUILD_FIELDS` in
 *  `scripts/lib/scrub-project-config.mjs`, which cannot import this TS file and
 *  so is kept in step by a guard test instead) is the BACKSTOP, not the primary
 *  defense; the primary defense is that the value was never committed in the
 *  first place. See {@link overlayPrivateBuildFields}.
 *
 *  Deliberately does NOT include `debugBuild`, `webDeployMode`, or `webBasePath`
 *  — those three DO ship publicly, just with a different (public-safe) value for
 *  a published project; they are a publish-time RESET, not a leak, and stay
 *  scrubbed-in-place in the committed file. */
export const PRIVATE_BUILD_FIELDS = [
  'appleTeamId',
  'webBucket',
  'webCdnUrlMap',
  'webCdnBackendBucket',
  'webDeployCommand',
] as const;

/** One of {@link PRIVATE_BUILD_FIELDS}. */
export type PrivateBuildField = (typeof PRIVATE_BUILD_FIELDS)[number];

/** Per-machine settings kept OUT of the committed config (gitignored
 *  project.user.json). These are about THIS developer's machine/hardware — the
 *  same iPhone/SDK regardless of which game is open — so they must never be
 *  committed. Merged over the committed config at build time.
 *
 *  The `build` section (below) widens what this file MEANS: it is no longer only
 *  "this developer's hardware" — it is also "private to this checkout," a
 *  broader idea that happens to share the same gitignored, per-machine home. The
 *  five fields in {@link PRIVATE_BUILD_FIELDS} (Apple Team ID, GCS bucket, CDN
 *  names, deploy command) are ORG-shared in principle — the same value across
 *  everyone's build of a given project — but they must never reach a PUBLIC repo,
 *  and `project.config.json` is exactly the file that gets published. Rather than
 *  invent a third file for "shared-but-private," they overlay onto the same
 *  gitignored home `device`/`sdk` already use; see {@link overlayPrivateBuildFields}. */
export interface ProjectUserConfig {
  device: {
    /** iOS hardware UDID for `xcodebuild -destination 'id=...'`. */
    iosDeviceId: string;
    /** iOS devicectl identifier for `xcrun devicectl --device ...`. */
    iosDevicectlId: string;
    /** Android serial for `adb -s <id>`. Empty = default adb device. */
    androidDeviceId: string;
  };
  sdk: {
    /** Override for JAVA_HOME used by Android Gradle builds. Empty = auto-detect
     *  (brew openjdk, then `/usr/libexec/java_home -v 21`). */
    javaHome: string;
    /** Override for ANDROID_HOME (SDK location). Empty = auto-detect
     *  ($ANDROID_HOME/$ANDROID_SDK_ROOT, then common installs). */
    androidHome: string;
    /** Override for the `gcloud` CLI used by the web GCS deploy — the gcloud binary
     *  path OR its bin dir. Empty = auto-detect (Homebrew / the Cloud SDK's own
     *  install dirs, then the login shell). Needed because a Finder-launched packaged
     *  editor has a minimal PATH without the Google Cloud SDK. */
    gcloudPath: string;
  };
  /** Overlay values for the {@link PRIVATE_BUILD_FIELDS} of `ProjectConfig.build`
   *  — see that constant for the rule. Empty string = "not set here," which falls
   *  through to whatever `project.config.json` has (see
   *  {@link overlayPrivateBuildFields}), so a project that has not migrated yet
   *  keeps working unchanged. */
  build: {
    appleTeamId: string;
    webBucket: string;
    webCdnUrlMap: string;
    webCdnBackendBucket: string;
    webDeployCommand: string;
  };
}

/** Defaults for the committed project config. Used whenever project.config.json
 *  is absent or a field is missing. */
export const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  app: {
    appId: 'com.modokiengine.prototype',
    appName: 'Puzzle Prototype',
    iconSource: '',
    // '1.0' / 1 are exactly what `cap add` scaffolds into versionName/versionCode and
    // MARKETING_VERSION/CURRENT_PROJECT_VERSION, so adopting these fields rewrites NOTHING
    // in any existing project (measured across all 20: every one is 1.0/1 bar iap-test,
    // which has uploaded and carries its own). Deliberately unlike `androidMinSdk`, whose
    // default overrides the scaffold because the scaffold's 24 is wrong; there is nothing
    // wrong with starting at 1.0/1 — it was just unmanaged.
    version: '1.0',
    buildNumber: 1,
    buildNumberAuto: false,
  },
  content: {
    scenes: [],
  },
  build: {
    // 'gcs' keeps existing bucket-configured projects deploying as before; an
    // empty bucket in gcs mode falls back to a local dist build.
    webDeployMode: 'gcs',
    webBucket: 'gs://modoki-www-site/demo',
    webBasePath: '/demo/',
    webCdnUrlMap: 'static-lb',
    webCdnBackendBucket: '',
    webDeployCommand: '',
    appleTeamId: '',
    // 16.4 by owner decision (2026-08-04), deliberately dropping the iPhone 7 / 6s / SE1
    // era. Comfortably above the 15.4 runtime-API line (structuredClone / Array.at /
    // Object.hasOwn all land in 15.4), so no polyfills are needed at this floor.
    iosMinVersion: '16.4',
    // 31 = Android 12. cap add scaffolds minSdkVersion 24; healAndroidMinSdk syncs this
    // value into android/variables.gradle so the floor can't drift per-project.
    androidMinSdk: 31,
    debugBuild: false,
    modules: {
      render3d: 'auto', render2d: 'auto', physics2d: 'auto',
      physics3d: 'auto', video: 'auto',
    },
    playableMaxBytes: 5_242_880, // 5 MB (AppLovin)
    playableClickUrl: '',
    playableNetwork: 'applovin',
    textureTierVariants: 'auto',
  },
  capacitor: {
    webDir: 'dist',
    iosContentMode: 'mobile',
    androidScheme: 'http',
    allowMixedContent: true,
    keyboardResize: 'none',
    orientation: 'auto',
    statusBarHidden: false,
    statusBarStyle: 'default',
  },
  rendering: {
    targetFps: 60, // matches the frame driver's historical default cap
    tierSwitchMessage: '', // empty = the engine's own default copy
    three: { backend: 'auto', antialias: true, pixelRatioCap: 2, shadows: true, qualityTier: 'auto', toneMapping: 'ACESFilmic', exposure: 1.2 },
    pixi: { backend: 'auto', antialias: true, resolution: 0, pixelRatioCap: 2 },
    web: { sizeMode: 'free', width: 1280, height: 720 },
  },
  physics: {
    layers: ['Default'],
    collisionMatrix: [0xffff],
  },
  postprocessors: {},
  ota: {
    enabled: false,
    baseUrl: '',
    publicKey: '',
    bundleName: 'shell',
    engineApi: 1,
  },
};

/** Defaults for the per-machine user config. Every field is EMPTY on purpose:
 *  these describe THIS developer's hardware, and this file ships publicly (the
 *  OSS snapshot), so a real value here would both leak the author's device and
 *  silently aim a stranger's build at hardware that is not theirs (#103). A
 *  per-machine project.user.json (gitignored) supplies them; an empty id is an
 *  expected, handled state — validateBuildConfig allows it, and the iOS build
 *  step turns it into an actionable "set iosDeviceId in Project Settings". */
export const DEFAULT_PROJECT_USER_CONFIG: ProjectUserConfig = {
  device: {
    iosDeviceId: '',
    iosDevicectlId: '',
    androidDeviceId: '',
  },
  sdk: {
    javaHome: '',
    androidHome: '',
    gcloudPath: '',
  },
  // Same all-empty rationale as `device`/`sdk` above: empty means "not set here,"
  // which overlayPrivateBuildFields falls through to project.config.json for —
  // load-bearing for every project that hasn't migrated a given field yet.
  build: {
    appleTeamId: '',
    webBucket: '',
    webCdnUrlMap: '',
    webCdnBackendBucket: '',
    webDeployCommand: '',
  },
};

/** Coerce a hand-edited string-union field to a value a consumer actually handles.
 *
 *  The file is committed JSON a human (or an older tool) edits by hand, and the
 *  merge below is a plain spread — so an out-of-union string used to flow straight
 *  through, TYPED as the union, and land on whatever branch the consumer's `!==`
 *  guards happened to leave. That is silent and wrong, not loud and wrong:
 *  `rendering.web.sizeMode: "portrait"` (games/sling, issue #25 — the native
 *  `capacitor.orientation` vocabulary leaking into the web sizing field) rendered
 *  identically to `free` for months, ignoring the 1080×1920 sitting next to it,
 *  and showed as an unmatched blank in the Project Settings dropdown.
 *
 *  Falling back to the DEFAULT (rather than throwing) keeps a typo'd config
 *  openable in the editor, which is the same call the malformed-JSON read path
 *  makes; the warn is what stops it being silent. Coercions are also RECORDED (the
 *  optional `issues` sink) so a UI can say it happened — see
 *  {@link projectConfigIssues}. */
function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
  path: string,
  issues?: ProjectConfigIssue[],
): T {
  if (value === undefined) return fallback;
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
  const message = `${path}: ${JSON.stringify(value)} is not one of ` +
    `${allowed.map((a) => JSON.stringify(a)).join(' | ')} — using ${JSON.stringify(fallback)}.`;
  if (issues) issues.push({ path, value, allowed: allowed as readonly string[], using: fallback, message });
  else console.warn(`[project-config] ${message}`); // a collector means someone is reporting it; don't double-log
  return fallback;
}

/** One out-of-union value found while resolving a config (see {@link oneOf}). */
export interface ProjectConfigIssue {
  /** Dot-path of the offending field, e.g. `rendering.web.sizeMode`. */
  path: string;
  /** What the file actually said. */
  value: unknown;
  /** The values a consumer handles. */
  allowed: readonly string[];
  /** What the resolved config is using instead. */
  using: string;
  /** Display-ready one-liner. */
  message: string;
}

/** The out-of-union values in a raw config, WITHOUT resolving it for use.
 *
 *  Exists because coercing silently trades one invisible problem for another: before
 *  it, a bad `sizeMode` showed as an unmatched BLANK in the Project Settings dropdown
 *  (odd-looking, so maybe noticed); after it, the dropdown reads "Free" and looks
 *  perfectly correct while the file still says `portrait` — and the write path
 *  deliberately keeps the file's word, so the two disagree indefinitely. That is the
 *  same "plausible-looking lie" the `configErrors` diagnostic was invented for on this
 *  very route (a malformed file rendering as engine defaults with nothing saying so),
 *  so it gets the same treatment: the GET reports it, the dialog shows it. */
export function projectConfigIssues(partial: Partial<ProjectConfig> | null | undefined): ProjectConfigIssue[] {
  const issues: ProjectConfigIssue[] = [];
  mergeProjectConfig(partial, { issues });
  return issues;
}

/** The legal value sets for every string-union config field — ONE source, exported, so the
 *  type, the merge-time validator and (via a guard test) the editor's select options cannot
 *  disagree. Before #39 each set existed up to three times: as a TS union, restated in a doc
 *  comment, and hardcoded again in the Project Settings dropdown.
 *
 *  Kept here rather than beside each consumer because this file is deliberately IMPORT-FREE
 *  (see the header) — a set defined in the package could not be reached from here without
 *  breaking that. The one place that costs us is `TONE_MAPPINGS`, whose consumer
 *  (`resolveToneMapping`, in the package) owns the name→THREE mapping; the pairing is held by
 *  a guard test instead of by an import. */
export const WEB_SIZE_MODES = ['free', 'fixed', 'max'] as const;
export const GPU_BACKENDS = ['auto', 'webgpu', 'webgl'] as const;
/** Quality tiers a project may select (#121 P3, `mid` added by #188). 'auto' delegates to the
 *  device allowlist + the boot ramp probe + on-device calibration; 'low'/'mid'/'high' pin it.
 *  Kept in the same weakest-first order as the package's `TIER_ORDER`, which is what a pinning UI
 *  reads as a ladder. */
export const QUALITY_TIERS = ['auto', 'low', 'mid', 'high'] as const;
export const WEB_DEPLOY_MODES = ['none', 'gcs', 'custom'] as const;
/** Ad-network MRAID/CTA conventions for the playable export. */
export const PLAYABLE_NETWORKS = ['applovin', 'unity', 'ironsource', 'facebook', 'mintegral', 'generic'] as const;
/** Whether a build emits per-tier texture LOD variants (#212) — 'auto' emits only when the
 *  payload is delivered OVER THE WIRE (a web build, or a native build that's actually an OTA
 *  publish); 'always'/'never' override that in either direction. See
 *  `plugins/textureTierEmit.ts` for the predicate this drives. */
export const TEXTURE_TIER_VARIANTS_MODES = ['auto', 'always', 'never'] as const;
export const CAPACITOR_ORIENTATIONS = ['auto', 'portrait', 'landscape'] as const;
export const STATUS_BAR_STYLES = ['default', 'light', 'dark'] as const;
/** Capacitor `ios.preferredContentMode` (see addNativeTarget.ts). */
export const IOS_CONTENT_MODES = ['mobile', 'desktop', 'recommended'] as const;
/** Capacitor `server.androidScheme`. Capacitor itself tolerates a custom scheme, but this
 *  project has only ever meant one of these two — widen the set deliberately if that changes,
 *  rather than by typo. */
export const ANDROID_SCHEMES = ['http', 'https'] as const;
/** Capacitor Keyboard plugin `resize` mode. */
export const KEYBOARD_RESIZE_MODES = ['none', 'native', 'body', 'ionic'] as const;
/** three.js tone-mapping names. MUST stay in step with `resolveToneMapping`'s switch in
 *  runtime/rendering/renderSettings.ts — that function owns the name→THREE constant mapping and
 *  falls unknown back to ACESFilmic, which is exactly why a typo was invisible (#39): the most
 *  common intended value IS the fallback. Guarded by a test that compares the two. */
export const TONE_MAPPINGS = ['None', 'Linear', 'ACESFilmic', 'AgX', 'Neutral'] as const;

/** Merge a (possibly partial) config object over the defaults. Pure — usable in
 *  both the Node loader and the browser. Nested objects are merged one level so a
 *  partial `rendering`/`physics`/`capacitor` doesn't wipe sibling defaults.
 *  EVERY string-union field in the config is validated (see {@link oneOf}).
 *
 *  `coerceUnions:false` turns that validation OFF, and the WRITE path must use it.
 *  The editor's save resolves the patched config through this function and writes the
 *  RESULT back (pruned), so with coercion on, pressing Apply on an unrelated section
 *  would silently rewrite an out-of-union value the author never touched. That is not
 *  a harmless heal: `sizeMode: "portrait"` is what revealed sling was *meant* to be
 *  portrait (issue #25) — normalizing it to `free` on some unrelated save would have
 *  erased the only evidence of intent and left a file that merely looked correct.
 *  Reading coerces (so the engine renders something a consumer handles); writing
 *  round-trips (so the file keeps saying what its author said). */
/** What `mergeProjectConfig` actually accepts. `Partial<ProjectConfig>` was too strict and did
 *  not describe the implementation: every section below is applied with a SPREAD
 *  (`{...d.app, ...p.app}`), so a partial section has always worked — the type just demanded a
 *  complete one. Nothing noticed while the input came off disk as arbitrary JSON, but it meant a
 *  test fixture overriding one field had to name every sibling, so every field added to a section
 *  broke unrelated fixtures (adding `app.version` broke addNativeTarget.test.ts). One level deep
 *  is exactly what the implementation does; `build.modules` is the one nested case and it gets
 *  its own spread below.
 *
 *  `postprocessors` is excluded because it is MAP-LIKE (keyed by postprocessor id, see the
 *  deep-merge notes further down) rather than fixed-shape: a `Record` is already
 *  "any subset of keys", and wrapping it in `Partial` would only widen its VALUES to
 *  `ModelPostprocessorDecl | undefined`, which is a different and wrong claim. */
type MapLikeSection = 'postprocessors';
type PartialProjectConfig = {
  [K in keyof ProjectConfig]?: K extends MapLikeSection ? ProjectConfig[K] : Partial<ProjectConfig[K]>;
};

export function mergeProjectConfig(
  partial: PartialProjectConfig | null | undefined,
  opts?: { coerceUnions?: boolean; issues?: ProjectConfigIssue[] },
): ProjectConfig {
  const p = partial ?? {};
  const d = DEFAULT_PROJECT_CONFIG;
  const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T, path: string): T =>
    // `=== undefined`, not `??`: with coercion off this must round-trip whatever the
    // file said, and a hand-written `null` is something the author wrote too.
    opts?.coerceUnions === false ? (value === undefined ? fallback : (value as T)) : oneOf(value, allowed, fallback, path, opts?.issues);
  return {
    app: { ...d.app, ...p.app },
    content: { ...d.content, ...p.content },
    build: {
      ...d.build, ...p.build,
      modules: { ...d.build.modules, ...p.build?.modules },
      // #39: these were plain spreads, so an out-of-union value flowed through untouched and the
      // deploy/playable step silently picked a branch for it.
      webDeployMode: pick(p.build?.webDeployMode, WEB_DEPLOY_MODES, d.build.webDeployMode, 'build.webDeployMode'),
      playableNetwork: pick(p.build?.playableNetwork, PLAYABLE_NETWORKS, d.build.playableNetwork, 'build.playableNetwork'),
      textureTierVariants: pick(p.build?.textureTierVariants, TEXTURE_TIER_VARIANTS_MODES, d.build.textureTierVariants, 'build.textureTierVariants'),
    },
    capacitor: {
      ...d.capacitor, ...p.capacitor,
      // #39: written into NATIVE config verbatim, so a typo here ships. `orientation` is the
      // sharp one — a bad value silently unlocks rotation on BOTH platforms (iOS falls back to
      // `auto` in healNativeConfig, Android to `fullSensor`) while the launch log echoes the value
      // you wrote, so the log looks correct.
      orientation: pick(p.capacitor?.orientation, CAPACITOR_ORIENTATIONS, d.capacitor.orientation, 'capacitor.orientation'),
      statusBarStyle: pick(p.capacitor?.statusBarStyle, STATUS_BAR_STYLES, d.capacitor.statusBarStyle, 'capacitor.statusBarStyle'),
      iosContentMode: pick(p.capacitor?.iosContentMode, IOS_CONTENT_MODES, d.capacitor.iosContentMode, 'capacitor.iosContentMode'),
      androidScheme: pick(p.capacitor?.androidScheme, ANDROID_SCHEMES, d.capacitor.androidScheme, 'capacitor.androidScheme'),
      keyboardResize: pick(p.capacitor?.keyboardResize, KEYBOARD_RESIZE_MODES, d.capacitor.keyboardResize, 'capacitor.keyboardResize'),
    },
    rendering: {
      ...d.rendering,
      ...p.rendering,
      three: {
        ...d.rendering.three, ...p.rendering?.three,
        backend: pick(p.rendering?.three?.backend, GPU_BACKENDS, d.rendering.three.backend, 'rendering.three.backend'),
        toneMapping: pick(p.rendering?.three?.toneMapping, TONE_MAPPINGS, d.rendering.three.toneMapping, 'rendering.three.toneMapping'),
        qualityTier: pick(p.rendering?.three?.qualityTier, QUALITY_TIERS, d.rendering.three.qualityTier, 'rendering.three.qualityTier'),
      },
      pixi: {
        ...d.rendering.pixi, ...p.rendering?.pixi,
        backend: pick(p.rendering?.pixi?.backend, GPU_BACKENDS, d.rendering.pixi.backend, 'rendering.pixi.backend'),
      },
      web: {
        ...d.rendering.web, ...p.rendering?.web,
        sizeMode: pick(p.rendering?.web?.sizeMode, WEB_SIZE_MODES, d.rendering.web.sizeMode, 'rendering.web.sizeMode'),
      },
    },
    physics: {
      ...d.physics,
      ...p.physics,
    },
    postprocessors: { ...d.postprocessors, ...p.postprocessors },
    ota: { ...d.ota, ...p.ota },
  };
}

/** Merge a (possibly partial) user config over the defaults. Pure. */
export function mergeProjectUserConfig(partial: Partial<ProjectUserConfig> | null | undefined): ProjectUserConfig {
  const p = partial ?? {};
  const d = DEFAULT_PROJECT_USER_CONFIG;
  return {
    device: { ...d.device, ...p.device },
    sdk: { ...d.sdk, ...p.sdk },
    build: { ...d.build, ...p.build },
  };
}

/** Overlay the private `build.*` fields (see {@link PRIVATE_BUILD_FIELDS}) from
 *  the per-machine user config onto a committed config, for READING. A NON-EMPTY
 *  value in `user.build` wins over whatever `config.build` has; an EMPTY user
 *  value falls through to the committed value unchanged. That fallthrough is
 *  load-bearing: it is what keeps every project that has not yet migrated a given
 *  field (its value still sitting in `project.config.json`) working exactly as
 *  before — the overlay only takes over a field once the private value has moved.
 *
 *  Returns a NEW object; mutates neither argument. Callers pass the RESULT
 *  wherever `config.build.<field>` used to be read directly — the canonical key
 *  path is unchanged, only where the value physically lives has moved. */
export function overlayPrivateBuildFields(config: ProjectConfig, user: ProjectUserConfig): ProjectConfig {
  const build = { ...config.build };
  for (const field of PRIVATE_BUILD_FIELDS) {
    const userValue = user.build[field];
    if (userValue !== '') build[field] = userValue;
  }
  return { ...config, build };
}

/** The inverse of {@link overlayPrivateBuildFields}, for the CLIENT-visible config: blank every
 *  {@link PRIVATE_BUILD_FIELDS} value. Used by the `virtual:modoki-project-config` module
 *  (`engine/plugins/vite-asset-scanner.ts`), which inlines the RESOLVED config into the browser
 *  bundle — so without this the Apple Team ID and the internal bucket/CDN names ship inside every
 *  built game's JavaScript, downloadable by anyone who can load the page. That is a WIDER
 *  exposure than the committed-file one #172 set out to fix (a public URL, no repo access needed),
 *  and it predates it: the values used to reach the same bundle from `project.config.json`.
 *
 *  All five are BUILD-time concerns — signing, deploy target, deploy command — and nothing in
 *  `engine/app/**` or the runtime reads any of them (the editor's Project Settings dialog gets its
 *  values from `GET /api/project-settings`, not this module, so editing is unaffected).
 *
 *  Blanks rather than deletes: the fields stay present and typed `string`, so a consumer that
 *  someday reads one gets `''` — the same already-handled "not set" state an unmigrated project
 *  produces — instead of an `undefined` that throws on `.trim()`. */
export function stripPrivateBuildFields(config: ProjectConfig): ProjectConfig {
  const build = { ...config.build };
  for (const field of PRIVATE_BUILD_FIELDS) build[field] = '';
  return { ...config, build };
}

/** The on-disk shape of either config file: whatever subset of the config the
 *  project actually chose to record. NOT the resolved config — see the
 *  file-stays-minimal invariant below. */
export type RawProjectConfig = Record<string, unknown>;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Keys that must never be copied out of an untrusted patch body: assigning
 *  `out.__proto__` reparents the object instead of adding a property, so the key
 *  silently vanishes from the written JSON (and can reshape the merge result).
 *  JSON.parse DOES produce these as own properties, so a body can carry them. */
const FORBIDDEN_PATCH_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Deep-merge a (possibly partial) PATCH onto a BASE. This is the WRITE-time
 *  merge — the counterpart to {@link mergeProjectConfig}, which is the LOAD-time
 *  resolver that merges over the DEFAULTS. Keep them separate: "resolve what this
 *  project's values are" and "apply an edit to what's on disk" are different
 *  operations, and conflating them is what made a partial save destructive.
 *
 *  Rules:
 *   - Plain objects merge recursively, so a patch touching only `build.debugBuild`
 *     leaves `app.*` and the rest of `build` alone.
 *   - ARRAYS ARE LEAVES — replaced wholesale, never concatenated or index-merged.
 *     Otherwise you could never remove a `content.scenes` entry or a physics layer.
 *   - A key PRESENT in the patch always wins, including `""`, `false` and `0`.
 *     Only ABSENCE means "don't touch" — which is what lets the Project Settings
 *     dialog (which posts the whole object) still blank a field.
 *   - `undefined` in the patch is treated as absent (JSON never produces it, but a
 *     hand-built body might). `null` is NOT: no config field is nullable, so a null
 *     is a caller mistake, and silently dropping it would be a false success. The
 *     caller-facing check is {@link findNullPatchPaths}, which the route rejects on.
 *   - MAP-LIKE sections can only be added to or updated, never pruned: `postprocessors`
 *     is keyed by postprocessor id, and since objects merge recursively there is no way
 *     to express "delete this entry" through a patch. Removing one means editing
 *     project.config.json directly. Fixed-shape sections are unaffected, and arrays
 *     (content.scenes, physics.layers) do support removal because they replace.
 *   - ...EXCEPT the paths in {@link REPLACE_WHOLESALE}, which behave like arrays. See there. */
/** Dot-paths merged as LEAVES — replaced wholesale — because for them the ABSENCE of a key is
 *  meaningful data rather than "leave it alone".
 *
 *  ⚠️ **`rendering.three.tiers` is here because without it the Project Settings "Remove" button
 *  is a lie.** The dialog posts the whole draft and the backend deep-merges it, so a removed
 *  `low` is simply an absent key — which every other map-like section reads as "don't touch". The
 *  dialog would close cleanly, report success, and the tier would still be in the file on the next
 *  load. Found by testing the real merge rather than the component (`deepMergeConfigPatch` with a
 *  `low`-omitting patch demonstrably returned the `low` unchanged), which is the only way to see
 *  it — the component's own object is correct, and every unit test of it passes.
 *
 *  It is also the ONE map here whose emptiness is semantic: no `tiers` (or an empty one) means the
 *  project authored a single quality config, which is what tells the boot probe not to run at all
 *  (docs/rendering.md § "Quality tiers"). A section that cannot express removal cannot
 *  express that. */
const REPLACE_WHOLESALE = new Set(['rendering.three.tiers']);

export function deepMergeConfigPatch(
  base: RawProjectConfig,
  patch: RawProjectConfig,
  path = '',
): RawProjectConfig {
  const out: RawProjectConfig = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || FORBIDDEN_PATCH_KEYS.has(k)) continue;
    const here = path ? `${path}.${k}` : k;
    const prev = out[k];
    out[k] = isPlainObject(v) && isPlainObject(prev) && !REPLACE_WHOLESALE.has(here)
      ? deepMergeConfigPatch(prev, v, here)
      : v;
  }
  return out;
}

/** Collect the dot-paths of every `null` in a patch body. No field in either config
 *  is nullable, so a null means the caller wanted to CLEAR something and picked the
 *  wrong value — writing it through poisons a typed field (`appName: null` survives
 *  the merge and reaches consumers), and skipping it silently would report success
 *  for an edit that did nothing. Reject instead, and say to use `""`/`false`/`0`. */
export function findNullPatchPaths(patch: unknown, prefix = ''): string[] {
  const out: string[] = [];
  const at = (k: string | number) => (prefix ? `${prefix}.${k}` : String(k));
  // Arrays too: content.scenes / physics.layers hold objects and strings, and a null
  // smuggled inside one would otherwise slip past the guard the route relies on.
  const entries: [string | number, unknown][] = Array.isArray(patch)
    ? patch.map((v, i) => [i, v])
    : isPlainObject(patch) ? Object.entries(patch) : [];
  for (const [k, v] of entries) {
    if (v === null) out.push(at(k));
    else if (v && typeof v === 'object') out.push(...findNullPatchPaths(v, at(k)));
  }
  return out;
}

/** Prune a RESOLVED config down to what belongs in the file, so
 *  project.config.json records only what the project CHOSE and everything else
 *  resolves from {@link DEFAULT_PROJECT_CONFIG} at load time.
 *
 *  `onDisk` MUST be the file as it was BEFORE the edit, not the patched result.
 *  Pass the patched config and every key is trivially "already present", so
 *  nothing prunes — which is exactly what a full-object save from the Project
 *  Settings dialog posts, and it would silently restore the write-the-resolved-
 *  config bug for the most common human path. (Measured: it did.)
 *
 *  A key is emitted iff it differs from the default OR it was already explicitly
 *  present in `onDisk`. The "already present" half is deliberate:
 *   - it keeps existing project files byte-stable instead of slimming all of them
 *     on their next save (quiet diffs), and
 *   - it records deliberate intent: a project that chose today's default value
 *     keeps that choice instead of silently following a future default change.
 *  The "differs from default" half is what stops a save from INTRODUCING keys the
 *  project never had — the bug that handed an internal game the demo deploy
 *  bucket.
 *
 *  `defaults` is REQUIRED, not defaulted to DEFAULT_PROJECT_CONFIG: this function
 *  serves BOTH config files, and silently pruning project.user.json against the
 *  PROJECT defaults would match nothing and write every resolved value back —
 *  including the repo owner's real device UDID, onto a machine that never set one.
 *  Make the caller name which defaults it means.
 *
 *  INVARIANT: `mergeProjectConfig(pruneProjectConfig(resolved, onDisk, defaults))`
 *  must deep-equal `resolved`. Pruning may never change what a project resolves to. */
export function pruneProjectConfig(
  resolved: RawProjectConfig,
  onDisk: RawProjectConfig,
  defaults: RawProjectConfig,
): RawProjectConfig {
  const kept: [string, unknown][] = [];
  for (const [k, v] of Object.entries(resolved)) {
    if (v === undefined) continue;
    const def = defaults[k];
    const disk = onDisk[k];
    const onDiskHasKey = Object.prototype.hasOwnProperty.call(onDisk, k);
    if (isPlainObject(v) && isPlainObject(def)) {
      const nested = pruneProjectConfig(v, isPlainObject(disk) ? disk : {}, def);
      // An empty nested result means every child matched its default and none was
      // recorded — emit the branch only if the file already had it.
      if (Object.keys(nested).length > 0 || onDiskHasKey) kept.push([k, nested]);
      continue;
    }
    if (onDiskHasKey || !deepEqualJson(v, def)) kept.push([k, v]);
  }
  // Emit in the file's existing key order, with genuinely new keys appended in
  // resolved order. Purely cosmetic, but it makes a no-op save a no-op DIFF —
  // otherwise every project's config gets reordered the first time anyone opens
  // Project Settings and hits OK, which reads as a real change in review.
  const order = Object.keys(onDisk);
  const rank = (k: string) => {
    const i = order.indexOf(k);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  return Object.fromEntries(kept.map((e, i) => [e, i] as const)
    .sort(([a, ia], [b, ib]) => rank(a[0]) - rank(b[0]) || ia - ib) // stable
    .map(([e]) => e));
}

/** Structural equality over JSON-shaped values (used to compare a resolved value
 *  against its default). Key ORDER is irrelevant; array order is not. */
function deepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqualJson(x, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqualJson(a[k], b[k]));
  }
  return false;
}

export const PROJECT_CONFIG_FILENAME = 'project.config.json';
export const PROJECT_USER_CONFIG_FILENAME = 'project.user.json';
