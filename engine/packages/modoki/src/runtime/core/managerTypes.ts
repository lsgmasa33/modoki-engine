/** Manager lifecycle types — extracted out of `managers/managerRegistry.ts` (P7 C5) so an L2
 *  subsystem may declare its own `ManagerDef` (e.g. an event bus's teardown hook) without
 *  reaching into `managers/` (L3) for the type. The registry itself — registration, scene/game
 *  scope lifecycle, `initSceneManagersFor` — stays L3; only the interface descends. */

import type { World } from 'koota';
import type { UIActionHandler, UIActionDef } from './actionRegistry';

export type ManagerScope = 'app' | 'scene' | 'game';

/** Passed to a Manager's `init()`. `world` is the active world at activation;
 *  `scenePath` is the scene that triggered it (the current scene for app/game scope). */
export interface ManagerContext {
  world: World;
  scenePath: string;
}

/** A Manager is a plain singleton implementing this shape. `registerManager`
 *  only wires its lifecycle + owned actions — other code calls its methods by
 *  importing the singleton directly (no service locator). */
export interface ManagerDef {
  name: string;
  /** Default 'scene'. */
  scope?: ManagerScope;
  /** Scene scope only: path substrings to match; omit = every scene. */
  scenes?: string[];
  /** Game scope only: active-game ids to match; omit = every game. */
  games?: string[];
  /** Named UIAction handlers owned by this manager (same shape systems use).
   *  Registered on activate, removed on deactivate. */
  actions?: Record<string, UIActionHandler | UIActionDef>;
  init?(ctx: ManagerContext): void | Promise<void>;
  /** `ctx` carries the world the manager was operating against (on a scene swap
   *  this is the OLD world, still alive until just after dispose runs) so a
   *  dispose can tear down world-bound state on the correct world. Optional. */
  dispose?(ctx?: ManagerContext): void;
}
