/** Build-time engine-module detection + resolution.
 *
 *  A project can include/exclude the heavy engine SDKs (three.js, pixi.js,
 *  Rapier 2D/3D) per build via `build.modules` in project.config.json. Each
 *  toggle is `'auto' | boolean`; `'auto'` is resolved HERE by scanning the
 *  project's scene JSON for the trait/layer signals that imply a module is used.
 *  The resolved booleans become `__MODOKI_MODULE_*__` Vite defines (see
 *  vite.config.ts) which flag-gate the module's lazy import so Rolldown
 *  dead-code-eliminates the SDK when it's off — the same mechanism the debug
 *  menu / journal use (App.tsx). Node-only (filesystem); NEVER in the browser
 *  graph. See docs/playable-export.md. */

import fs from 'node:fs';
import path from 'node:path';
import type { BuildModules, ModuleKey } from '../project-config';

export type { ModuleKey };

export const MODULE_KEYS: ModuleKey[] = ['render3d', 'render2d', 'physics2d', 'physics3d', 'npr', 'gpuParticles'];

/** Which module a trait name implies. Matched against the trait keys present on
 *  any entity in any included scene. Intentionally BROAD — a false-positive
 *  (shipping an unused SDK) is safe (just bigger); a false-negative (stripping a
 *  used one) is loud, caught by the build-time validation + runtime guard. */
const TRAIT_TO_MODULE: Record<string, ModuleKey> = {
  Renderable3D: 'render3d', ModelSource: 'render3d', Light: 'render3d', Camera: 'render3d', Environment: 'render3d',
  Renderable2D: 'render2d', Sprite: 'render2d', SkinnedSprite2D: 'render2d', Canvas2D: 'render2d',
  // NOTE: Zone2D/Zone3D are deliberately NOT mapped — zones are physics-FREE
  // (geometric containment over ZoneOccupant, no Rapier — see CLAUDE.md), so a
  // zones-only game must still strip Rapier.
  RigidBody2D: 'physics2d', Collider2D: 'physics2d', CharacterController2D: 'physics2d',
  RigidBody3D: 'physics3d', Collider3D: 'physics3d', CharacterController3D: 'physics3d',
};

export interface DetectResult {
  /** Per-module: was a signal for it found in any scanned scene? */
  used: Record<ModuleKey, boolean>;
  /** Number of scene files scanned (for logging / tests). */
  scenesScanned: number;
}

/** All resolved module flags default off; a scan flips the used ones on. */
function emptyFlags(): Record<ModuleKey, boolean> {
  return { render3d: false, render2d: false, physics2d: false, physics3d: false, npr: false, gpuParticles: false };
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'ios', 'android', '.git']);

/** Collect every scene JSON under `dir` — a `.json` (not `.meta.json`) living
 *  under a `scenes/` directory WITHIN the project, matching the engine's scene
 *  convention (see asset-tree-shaker.ts `findSceneFiles`). `inScenes` tracks
 *  whether the recursion is already inside a `scenes/` subtree, so an ancestor
 *  path segment named "scenes" (e.g. a project cloned under `.../scenes/…`) can't
 *  false-match non-scene JSON. */
function collectSceneFiles(dir: string, out: string[], inScenes = false): void {
  if (!fs.existsSync(dir)) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      collectSceneFiles(full, out, inScenes || e.name === 'scenes');
    } else if (inScenes && full.endsWith('.json') && !full.endsWith('.meta.json')) {
      out.push(full);
    }
  }
}

/** Scan a project's scenes and report which engine modules are used. */
export function detectModules(projectRoot: string): DetectResult {
  const used = emptyFlags();
  const files: string[] = [];
  collectSceneFiles(projectRoot, files);

  for (const file of files) {
    let json: unknown;
    try {
      json = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue; // a malformed scene shouldn't crash a build's module scan
    }
    const entities = (json as { entities?: unknown }).entities;
    if (!Array.isArray(entities)) continue;
    for (const ent of entities) {
      const traits = (ent as { traits?: Record<string, unknown> }).traits;
      if (!traits || typeof traits !== 'object') continue;
      for (const traitName of Object.keys(traits)) {
        const mod = TRAIT_TO_MODULE[traitName];
        if (mod) used[mod] = true;
      }
      const layer = (traits.EntityAttributes as { layer?: unknown } | undefined)?.layer;
      if (layer === '3d') used.render3d = true;
      else if (layer === '2d') used.render2d = true;
    }
  }

  // Sub-features of the 3D renderer. Until finer per-feature detection lands
  // (an NPR camera setting / a particle backend field), 'auto' conservatively
  // keeps them whenever 3D is present — safe (never strips a used feature); an
  // explicit `false` still forces them out. TODO: detect NPR/GPU-particle usage.
  if (used.render3d) {
    used.npr = true;
    used.gpuParticles = true;
  }

  return { used, scenesScanned: files.length };
}

/** Combine a project's `build.modules` config with an 'auto' scan into concrete
 *  booleans for the `__MODOKI_MODULE_*__` defines. `projectRoot` null (the
 *  project-less editor build / dev) → everything on (the editor needs all SDKs).
 *  Logs a loud warning when a module is forced OFF but the scenes use it. */
export function resolveModules(
  modules: BuildModules,
  projectRoot: string | null,
): Record<ModuleKey, boolean> {
  if (!projectRoot) {
    return { render3d: true, render2d: true, physics2d: true, physics3d: true, npr: true, gpuParticles: true };
  }

  const detect = detectModules(projectRoot);
  const out = emptyFlags();
  for (const key of MODULE_KEYS) {
    const cfg = modules[key] ?? 'auto';
    if (cfg === 'auto') {
      out[key] = detect.used[key];
    } else {
      out[key] = cfg;
      if (cfg === false && detect.used[key]) {
        console.warn(
          `[modoki] build.modules.${key} is forced OFF but the project's scenes use it — ` +
          `the build may render nothing / throw at runtime. Set it to 'auto' or 'true' if unintended.`,
        );
      }
    }
  }
  return out;
}
