/** GameConfig — interface that separates game-specific logic from the editor.
 *  Each game provides one of these. The editor and renderer consume it generically. */

// Type-only — GameConfig only references THREE.Scene in a signature. A value import
// would pull the whole `three` base into this widely-imported config module (and thus
// into a 2D-only build). Erased at compile time.
import type * as THREE from 'three';
import { decodeAssetUrlPath } from './assetUrlPath';

export interface GameConfig {
  /** Human-readable game name */
  name: string;

  /** Setup scene: lighting, environment, background color */
  sceneSetup: (scene: THREE.Scene) => void;

  /** Initialize ECS world: spawn starting entities, load models.
   *  Called only if no scenePath is set or the scene file doesn't exist. */
  initWorld: () => void;

  /** URL of the default scene file — what a `?url` import gives (`import u from './assets/scenes/main.scene.json?url'`),
   *  so it is percent-ENCODED. If set, the editor loads this scene on startup instead of calling initWorld().
   *  ⚠️ Read it as a scene PATH through `bootScenePath(config)`, never raw (#1979). */
  scenePath?: string;

  /** Disable the Three.js 3D renderer for this game (frees GPU memory). */
  disable3D?: boolean;

  /** Renderer preference. 'auto' (default) uses WebGPU when supported and
   *  falls back to legacy WebGLRenderer. 'force' always returns a
   *  WebGPURenderer (which itself has an internal WebGL2 fallback), required
   *  for TSL / NodeMaterial workflows like NPR post-processing. */
  preferWebGPU?: 'auto' | 'force';

  /** Asset manifest path (relative to public/) */
  assetManifest?: string;

  /** OTA Phase 4 — origin to resolve `scenePath` against, for a sub-game bundle
   *  whose files live in a separately-staged native folder rather than the
   *  shell's own served webroot (`Capacitor.convertFileSrc()` of the staged
   *  bundle root). Root-relative build output like `/assets/main-<hash>.json`
   *  otherwise 404s — it resolves against the SHELL's origin, not the bundle's.
   *  Unset for the shell's own (baked) game. Set by `app/subgameLoader.ts`,
   *  consumed by `bootScenePath(config)`. See
   *  docs/ota-subgame-modules.md §3. */
  assetBaseUrl?: string;

  /** Transform entity names for display (e.g., Russian→English mapping) */
  nameTransform?: (name: string) => string;
}

// ── Active game config (set at startup) ─────────────────

let activeConfig: GameConfig | null = null;

/** `config.scenePath` as an asset PATH — decoded once, here (#1979, `assetUrlPath.ts`). Vite writes a `?url` import
 *  through `encodeURI`, so a boot scene named `level 1.scene.json` arrives as `level%201.scene.json`, and a project under
 *  `My Games/` as `/@fs/…/My%20Games/…`. `loadScene` takes a path and `assetUrl` encodes it again on the way out, so
 *  passing the URL straight through double-encoded it: a 404 in production and an unmatched `/@fs/` root in the editor.
 *  A malformed escape is kept as written — no `?url` value has one.
 *
 *  An OTA sub-game's root-absolute scene path is prefixed with its `assetBaseUrl` AFTER the decode (#2051), so it is
 *  spelled the way its manifest spells every other sub-game asset (`loadManifestJson`'s `pathPrefix`): a PATH, which
 *  `assetUrl` encodes past the registered base. Prefixing the raw `?url` value kept the scene's identity encoded, so a
 *  scene-name match (`sceneMatches`, `matchingSceneCallbacks`) missed a space or non-ASCII name on a sub-game boot. */
export function bootScenePath(config: Pick<GameConfig, 'scenePath' | 'assetBaseUrl'>): string | undefined {
  const url = config.scenePath;
  if (!url) return url;
  const path = decodeAssetUrlPath(url) ?? url;
  return config.assetBaseUrl && path.startsWith('/') ? config.assetBaseUrl.replace(/\/$/, '') + path : path;
}

export function setGameConfig(config: GameConfig) {
  activeConfig = config;
}

export function getGameConfig(): GameConfig {
  if (!activeConfig) throw new Error('No game config set — call setGameConfig() at startup');
  return activeConfig;
}
