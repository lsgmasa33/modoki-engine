/** Project configuration — the single source of truth for project-specific
 *  constants that the editor's "Project Settings" window edits.
 *
 *  This file is intentionally PURE (no Node imports) so it is safe for the
 *  browser type graph. The Node-side reader lives in
 *  plugins/load-project-config.ts; the browser receives resolved values via
 *  the `virtual:modoki-project-config` module (see vite-asset-scanner.ts).
 *
 *  TWO FILES (deliberate split):
 *   - project.config.json  — COMMITTED, shareable project data (identity, scenes,
 *     web deploy target, renderer/physics, capacitor). Owned by {@link ProjectConfig}.
 *   - project.user.json    — GITIGNORED, per-machine settings (which physical device
 *     to deploy to, local SDK paths). Owned by {@link ProjectUserConfig}. Never
 *     committed, so one dev's device UDID / JAVA path never leaks into the repo. */

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
 *  defaults to `'auto'` (detect from the included scenes). `npr` and
 *  `gpuParticles` are sub-features of `render3d`. */
export interface BuildModules {
  /** Three.js 3D renderer (Scene3D + the three.webgpu / TSL node pipeline). */
  render3d: ModuleToggle;
  /** PixiJS 2D renderer (Scene2D / Game). */
  render2d: ModuleToggle;
  /** Rapier 2D physics. */
  physics2d: ModuleToggle;
  /** Rapier 3D physics. */
  physics3d: ModuleToggle;
  /** NPR post-processing (requires render3d). */
  npr: ModuleToggle;
  /** GPU-compute particle backend (requires render3d + native WebGPU). */
  gpuParticles: ModuleToggle;
}

/** One engine-module key (a field of {@link BuildModules}). */
export type ModuleKey = keyof BuildModules;

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
    webDeployMode: 'none' | 'gcs' | 'custom';
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
     *  KQ6FQ2BS8H). Org-level (shared across the team's builds) so it lives in the
     *  committed config, not project.user.json. The editor's heal-on-open syncs it
     *  into the iOS project's DEVELOPMENT_TEAM. Empty = leave the pbxproj as-is. */
    appleTeamId: string;
    /** Percept — keep the event journal (`emit`/`modoki_journal`) recording in a
     *  SHIPPED game build. The journal is always on in the editor (dev + the
     *  packaged Electron editor, gated by `__MODOKI_EDITOR__`); in a normal
     *  production game build it is OFF by default so `emit()` adds no per-event
     *  allocation on hot paths (physics contacts, etc.). Set true for a
     *  QA/profiling game build that needs the trace on device. (A broader
     *  debug|profile|release mode enum is deferred until a profiler gives
     *  'profile' a second consumer — see docs/percept-plan.md, Decision D.) */
    enableJournal: boolean;
    /** In-game debug menu — ship the extensible debug overlay (F12 / 3-finger tap:
     *  stats, world inspector, cheats, …) in this build. Always on in the editor
     *  (dev + packaged Electron editor, gated by `__MODOKI_EDITOR__`); OFF by
     *  default in a shipped game build so the whole debug-menu chunk tree-shakes
     *  out. Set true for a QA/playtest game build that needs the menu on device.
     *  See docs/debug-menu-plan.md. */
    enableDebugMenu: boolean;
    /** Debug bridge — ship the on-device debug server (native TCP + UDP beacon / web-WS)
     *  that every `device_*` AI tool connects to, INCLUDING `device_eval`, which runs
     *  ARBITRARY JavaScript on the device. Always on in the editor + dev; OFF by default
     *  in a shipped game build so the whole `./debug/bridge` import tree-shakes out — a
     *  release build has no eval-capable server to connect to. Set true for a game build
     *  you intend to debug on a device. (Previously this was ungated on native, so every
     *  native build shipped the bridge; this flag closes that exposure.) */
    debugBridge: boolean;
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
    playableNetwork: string;
  };
  /** Native Capacitor shell settings, synthesized into `capacitor.config.json`
   *  (previously hardcoded in the generator) plus native-project patches applied
   *  by healNativeConfig (orientation + status bar). */
  capacitor: {
    /** Web assets dir Capacitor serves from (relative to the project). */
    webDir: string;
    /** iOS `preferredContentMode` ('mobile' | 'desktop' | 'recommended'). */
    iosContentMode: string;
    /** Android URL scheme ('http' | 'https'). */
    androidScheme: string;
    /** Android `allowMixedContent`. */
    allowMixedContent: boolean;
    /** Capacitor Keyboard plugin `resize` mode ('none' | 'native' | 'body' | 'ionic'). */
    keyboardResize: string;
    /** Supported device orientation → iOS UISupportedInterfaceOrientations +
     *  Android android:screenOrientation. 'auto' = allow both portrait+landscape. */
    orientation: 'auto' | 'portrait' | 'landscape';
    /** Hide the OS status bar (clock/wifi/battery) → iOS UIStatusBarHidden +
     *  Android fullscreen flag. */
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
    three: {
      /** GPU API: 'auto' (detect, prefer WebGPU) | 'webgpu' | 'webgl'. */
      backend: 'auto' | 'webgpu' | 'webgl';
      antialias: boolean;
      /** Upper bound on devicePixelRatio (perf vs sharpness). */
      pixelRatioCap: number;
      shadows: boolean;
      /** Tone-mapping operator ('ACESFilmic' | 'AgX' | 'Neutral' | 'Linear' | 'None'). */
      toneMapping: string;
      exposure: number;
    };
    pixi: {
      /** GPU API: 'auto' (detect, prefer WebGPU) | 'webgpu' | 'webgl'. */
      backend: 'auto' | 'webgpu' | 'webgl';
      antialias: boolean;
      /** Pixi renderer resolution; 0 = auto (devicePixelRatio). */
      resolution: number;
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
}

/** Per-machine settings kept OUT of the committed config (gitignored
 *  project.user.json). These are about THIS developer's machine/hardware — the
 *  same iPhone/SDK regardless of which game is open — so they must never be
 *  committed. Merged over the committed config at build time. */
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
}

/** Defaults for the committed project config. Used whenever project.config.json
 *  is absent or a field is missing. */
export const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  app: {
    appId: 'com.modokiengine.prototype',
    appName: 'Puzzle Prototype',
    iconSource: '',
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
    enableJournal: false,
    enableDebugMenu: false,
    debugBridge: false,
    modules: {
      render3d: 'auto', render2d: 'auto', physics2d: 'auto',
      physics3d: 'auto', npr: 'auto', gpuParticles: 'auto',
    },
    playableMaxBytes: 5_242_880, // 5 MB (AppLovin)
    playableClickUrl: '',
    playableNetwork: 'applovin',
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
    three: { backend: 'auto', antialias: true, pixelRatioCap: 2, shadows: true, toneMapping: 'ACESFilmic', exposure: 1.2 },
    pixi: { backend: 'auto', antialias: true, resolution: 0 },
    web: { sizeMode: 'free', width: 1280, height: 720 },
  },
  physics: {
    layers: ['Default'],
    collisionMatrix: [0xffff],
  },
  postprocessors: {},
};

/** Defaults for the per-machine user config. The device/SDK values here mirror
 *  the repo owner's machine so a build works out-of-the-box without a
 *  project.user.json; a real per-machine file (gitignored) overrides them. */
export const DEFAULT_PROJECT_USER_CONFIG: ProjectUserConfig = {
  device: {
    iosDeviceId: '00008150-00041CAA3AB8401C',
    iosDevicectlId: '796DC698-BD9D-529F-B068-D14867813680',
    androidDeviceId: '',
  },
  sdk: {
    javaHome: '',
    androidHome: '',
    gcloudPath: '',
  },
};

/** Merge a (possibly partial) config object over the defaults. Pure — usable in
 *  both the Node loader and the browser. Nested objects are merged one level so a
 *  partial `rendering`/`physics`/`capacitor` doesn't wipe sibling defaults. */
export function mergeProjectConfig(partial: Partial<ProjectConfig> | null | undefined): ProjectConfig {
  const p = partial ?? {};
  const d = DEFAULT_PROJECT_CONFIG;
  return {
    app: { ...d.app, ...p.app },
    content: { ...d.content, ...p.content },
    build: { ...d.build, ...p.build, modules: { ...d.build.modules, ...p.build?.modules } },
    capacitor: { ...d.capacitor, ...p.capacitor },
    rendering: {
      ...d.rendering,
      ...p.rendering,
      three: { ...d.rendering.three, ...p.rendering?.three },
      pixi: { ...d.rendering.pixi, ...p.rendering?.pixi },
      web: { ...d.rendering.web, ...p.rendering?.web },
    },
    physics: {
      ...d.physics,
      ...p.physics,
    },
    postprocessors: { ...d.postprocessors, ...p.postprocessors },
  };
}

/** Merge a (possibly partial) user config over the defaults. Pure. */
export function mergeProjectUserConfig(partial: Partial<ProjectUserConfig> | null | undefined): ProjectUserConfig {
  const p = partial ?? {};
  const d = DEFAULT_PROJECT_USER_CONFIG;
  return {
    device: { ...d.device, ...p.device },
    sdk: { ...d.sdk, ...p.sdk },
  };
}

export const PROJECT_CONFIG_FILENAME = 'project.config.json';
export const PROJECT_USER_CONFIG_FILENAME = 'project.user.json';
