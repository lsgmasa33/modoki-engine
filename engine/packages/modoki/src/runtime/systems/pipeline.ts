/** Generic ECS Pipeline — ordered system execution with dynamic registration.
 *  Engine provides registerSystem/unregisterSystem/runPipeline.
 *  Games register their systems at startup. */

import type { World } from 'koota';
import { isSimRunning } from './playState';
import { registerUIAction, unregisterUIAction, type UIActionHandler, type UIActionDef } from '../ui/actionRegistry';

type SystemFn = (world: World) => void;

/** Optional extras a system can declare at registration. */
export interface SystemOptions {
  /** Named UIAction handlers owned by this system. They are folded into the
   *  action registry on register and removed on unregister, so a button's
   *  binding can invoke the system's logic and the editor's action dropdown
   *  lists them — with no separate bookkeeping. A value may be a bare handler or
   *  a `{ handler, params }` def that declares typed arguments for the editor. */
  actions?: Record<string, UIActionHandler | UIActionDef>;
}

interface RegisteredSystem {
  name: string;
  fn: SystemFn;
  priority: number;
  actionNames: string[];
}

const systems: RegisteredSystem[] = [];
let sorted = false;

/** Well-known priority tiers for system ordering. */
export const SYSTEM_PRIORITY = {
  /** Time resource update — must run first (priority 0) */
  TIME: 0,
  /** Input sampling — after TIME, before GAME (priority 50). The app-pipeline
   *  `inputSystem` merges attached sources into the `Input` resource here, so
   *  GAME-priority systems read a fresh frame. Not registered in the headless
   *  harness (tests set `Input` directly). */
  INPUT: 50,
  /** Game logic systems (priority 100-199) */
  GAME: 100,
  /** Keyframe animation playback — after game logic, before transform propagation
   *  (priority 150) so animated local transforms propagate the same frame. */
  ANIMATION: 150,
  /** Pre-physics world-transform pass — after game + animation write local transforms,
   *  BEFORE physics (priority 170), so `worldTransforms` holds THIS-frame world matrices
   *  when physics seeds/poses bodies. Physics for a PARENTED body reads its world pose
   *  from this cache (and inverts on readback) rather than re-walking the parent chain per
   *  body. The same `transformPropagationSystem` also runs again post-physics (TRANSFORM)
   *  so rendering sees the solved poses — it's idempotent (rebuilds the map each call). */
  TRANSFORM_PREPASS: 170,
  /** 2D physics step — after game logic + animation set velocities / drive kinematic
   *  bodies (priority 175), before transform propagation so children follow the
   *  post-physics pose. */
  PHYSICS: 175,
  /** Post-physics correction tier — the Unity-style "LateUpdate" (priority 185). Runs AFTER
   *  animation (150) + physics writeback (175) and BEFORE the final transform propagation
   *  (200), so a system here reads the ACTUAL post-step pose and its edits still compose into
   *  this frame's render/audio. `< TRANSFORM`, so it's gated with the sim (frozen when paused).
   *  The canonical home for procedural post-physics correction: surface-snapping (sling puck),
   *  IK/bone fixups after animation, camera follow, constraint solvers.
   *  CONTRACT: read fresh state via the `Transform` trait (local; for a ROOT entity local ==
   *  world) or `getWorldTransform3D(id)` (composes a parented entity's world on-demand from the
   *  fresh local chain). Do NOT read the `worldTransforms` cache — at 185 it still holds the
   *  pre-physics (TRANSFORM_PREPASS 170) snapshot. To move a body, use `setBodyTranslation3D`
   *  (so next frame's physics continues from the corrected pose) AND set the `Transform` trait
   *  (so this frame's propagation reflects it). */
  LATE_UPDATE: 185,
  /** Transform propagation — after all transform changes (priority 200) */
  TRANSFORM: 200,
  /** Audio — presentation tier, AFTER transform propagation (priority 250) so
   *  spatial sources + listener read post-propagation world positions. ≥ TRANSFORM
   *  so it keeps running while the sim is paused (a presentation concern). */
  AUDIO: 250,
  /** Material parameter driving — presentation tier (priority 260), AFTER transform
   *  propagation and ≥ TRANSFORM so it keeps writing driven material params (uniforms
   *  via object userData) while the sim is paused/stopped, exactly like AUDIO. Runs in
   *  the ECS pipeline (before the separate RENDER_3D frame callback reads the values). */
  MATERIAL: 260,
  /** Projections / store sync — after all state changes (priority 300) */
  PROJECTION: 300,
} as const;

/** Register a system to run each frame.
 *  Lower priority numbers run first. Systems at the same priority run in registration order.
 *  Pass `opts.actions` to register UIAction handlers owned by this system (removed on unregister). */
export function registerSystem(name: string, fn: SystemFn, priority: number, opts?: SystemOptions) {
  const actionNames = opts?.actions ? Object.keys(opts.actions) : [];
  for (const [actionName, handler] of Object.entries(opts?.actions ?? {})) {
    registerUIAction(actionName, handler);
  }
  // Replace if already registered with same name (drop the old one's actions first).
  const idx = systems.findIndex(s => s.name === name);
  if (idx >= 0) {
    for (const a of systems[idx].actionNames) if (!actionNames.includes(a)) unregisterUIAction(a);
    systems[idx] = { name, fn, priority, actionNames };
  } else {
    systems.push({ name, fn, priority, actionNames });
  }
  sorted = false;
}

/** Unregister a system by name (and any UIActions it owns). */
export function unregisterSystem(name: string) {
  const idx = systems.findIndex(s => s.name === name);
  if (idx >= 0) {
    for (const a of systems[idx].actionNames) unregisterUIAction(a);
    systems.splice(idx, 1);
    sorted = false;
  }
}

/** Run all registered systems in priority order. Called once per frame.
 *
 *  When the simulation is not running (editor Stopped / Paused), skip the
 *  simulation tiers — TIME (0), GAME (100), ANIMATION (150) — so game time
 *  freezes and game logic stays inert. Transform propagation (200+) and
 *  projections (300) still run so inspector/gizmo edits reflect immediately. */
export function runPipeline(world: World) {
  if (!sorted) {
    systems.sort((a, b) => a.priority - b.priority);
    sorted = true;
  }
  const simRunning = isSimRunning();
  for (const sys of systems) {
    if (!simRunning && sys.priority < SYSTEM_PRIORITY.TRANSFORM) continue;
    sys.fn(world);
  }
}

/** Get list of registered system names (for debugging). */
export function getRegisteredSystems(): string[] {
  return systems.map(s => `${s.name} (${s.priority})`);
}
