/** GameConfig — interface that separates game-specific logic from the editor.
 *  Each game provides one of these. The editor and renderer consume it generically. */

// Type-only — GameConfig only references THREE.Scene in a signature. A value import
// would pull the whole `three` base into this widely-imported config module (and thus
// into a 2D-only build). Erased at compile time.
import type * as THREE from 'three';

export interface GameConfig {
  /** Human-readable game name */
  name: string;

  /** Setup scene: lighting, environment, background color */
  sceneSetup: (scene: THREE.Scene) => void;

  /** Initialize ECS world: spawn starting entities, load models.
   *  Called only if no scenePath is set or the scene file doesn't exist. */
  initWorld: () => void;

  /** Path to the default scene file (e.g., "/scenes/scene.json").
   *  If set, the editor loads this scene on startup instead of calling initWorld(). */
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

  /** Transform entity names for display (e.g., Russian→English mapping) */
  nameTransform?: (name: string) => string;
}

// ── Active game config (set at startup) ─────────────────

let activeConfig: GameConfig | null = null;

export function setGameConfig(config: GameConfig) {
  activeConfig = config;
}

export function getGameConfig(): GameConfig {
  if (!activeConfig) throw new Error('No game config set — call setGameConfig() at startup');
  return activeConfig;
}
