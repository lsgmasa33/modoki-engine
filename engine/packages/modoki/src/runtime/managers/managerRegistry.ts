/** Manager registry — the event-driven counterpart to the per-frame System
 *  pipeline (`systems/pipeline.ts`). A Manager owns long-lived state + a method
 *  surface and reacts to events (scene swaps, clicks, SDK callbacks); it has no
 *  per-frame tick. This is symmetric to `registerSystem`: a Manager may own
 *  UIActions (same `actions` shape) that are folded into the action registry on
 *  activate and removed on deactivate.
 *
 *  Scope decides lifecycle (three tiers, coarsest → finest):
 *   - 'app': activated at register, disposed only at unregister — lives the whole
 *     app session, independent of scene OR game. For engine infrastructure
 *     (TimeManager, NavigationManager) and global cross-game controllers (the
 *     scene-selector's return-to-hub action). Driven solely by register/unregister.
 *   - 'game' (opt-in): keyed on the ACTIVE GAME (`activeGameId`). Activated when
 *     its game becomes active, survives scene swaps WITHIN that game, disposed
 *     when the active game changes. Declare which game(s) via the `games` filter
 *     (omit = any game). Driven by SceneManager via `disposeActiveGameManagers()`
 *     + `initGameManagersFor()`. Use for a controller that genuinely spans a
 *     game's scenes (e.g. a camera spanning Station↔Warp). NOTE: keyed on the
 *     active game, NOT on register — so the editor registering every game's
 *     managers up front does NOT activate them all; only the active game's do.
 *   - 'scene' (default): activated when a matching scene loads, disposed on swap
 *     away — state cannot leak across scenes. Declare which scenes via the
 *     `scenes` filter. Driven by SceneManager via `disposeActiveSceneManagers()`
 *     + `initSceneManagersFor()`. A single-scene controller with an expensive
 *     init (e.g. an LLM download) belongs here, not 'game'.
 *
 *  See docs/managers-and-systems.md for the full design. */

import type { World } from 'koota';
import { getCurrentWorld } from '../ecs/world';
import { registerUIAction, unregisterUIAction, type UIActionHandler, type UIActionDef } from '../ui/actionRegistry';

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

interface Entry {
  def: ManagerDef;
  scope: ManagerScope;
  active: boolean;
  actionNames: string[];
  /** In-flight init promise (errors swallowed), or null once settled. Lets
   *  `disposeActiveSceneManagers` await a pending init before disposing, so we
   *  never dispose a half-initialized manager. */
  initPromise: Promise<void> | null;
}

const managers = new Map<string, Entry>();
/** The scene whose scene-scoped managers are currently active. */
let activeScenePath = '';
/** The game whose game-scoped managers are currently active (null = no game,
 *  e.g. the menu / a prefab-edit world). Set by `initGameManagersFor`. */
let activeGameId: string | null = null;

function sceneMatches(def: ManagerDef, scenePath: string): boolean {
  if (!def.scenes || def.scenes.length === 0) return true;
  return def.scenes.some((s) => scenePath.includes(s));
}

function gameMatches(def: ManagerDef, gameId: string): boolean {
  if (!def.games || def.games.length === 0) return true; // no filter = any active game
  return def.games.includes(gameId);
}

/** Register a manager's owned actions and return their names. */
function addActions(def: ManagerDef): string[] {
  const names = def.actions ? Object.keys(def.actions) : [];
  for (const [name, handler] of Object.entries(def.actions ?? {})) registerUIAction(name, handler);
  return names;
}

function activate(entry: Entry, scenePath: string): void | Promise<void> {
  if (entry.active) return;
  entry.active = true;
  entry.actionNames = addActions(entry.def);
  const r = entry.def.init?.({ world: getCurrentWorld(), scenePath });
  if (r && typeof (r as Promise<unknown>).then === 'function') {
    // Track the in-flight init (errors swallowed here so the tracked promise
    // never rejects; the raw `r` returned below still propagates to the caller,
    // e.g. initSceneManagersFor, so a real init failure fails the scene load).
    const tracked = Promise.resolve(r).then(() => {}, () => {}).finally(() => {
      if (entry.initPromise === tracked) entry.initPromise = null;
    });
    entry.initPromise = tracked;
  } else {
    entry.initPromise = null;
  }
  return r;
}

function deactivate(entry: Entry, ctx?: ManagerContext): void {
  if (!entry.active) return;
  try { entry.def.dispose?.(ctx); } catch (e) { console.warn(`[managers] dispose failed: ${entry.def.name}`, e); }
  for (const n of entry.actionNames) unregisterUIAction(n);
  entry.actionNames = [];
  entry.initPromise = null;
  entry.active = false;
}

/** Register a manager. App-scoped managers activate immediately and stay active
 *  until unregister. Game-/scene-scoped managers activate now only if their
 *  game/scene is already active and matches, otherwise they wait for the next
 *  matching game/scene activation. Re-registering a name replaces (and disposes)
 *  the previous one. */
export function registerManager(def: ManagerDef): void {
  const scope = def.scope ?? 'scene';
  const existing = managers.get(def.name);
  if (existing) { deactivate(existing); managers.delete(def.name); }

  const entry: Entry = { def, scope, active: false, actionNames: [], initPromise: null };
  managers.set(def.name, entry);

  if (scope === 'app') {
    void activate(entry, activeScenePath);
  } else if (scope === 'game') {
    if (activeGameId !== null && gameMatches(def, activeGameId)) void activate(entry, activeScenePath);
  } else if (activeScenePath && sceneMatches(def, activeScenePath)) {
    void activate(entry, activeScenePath);
  }
}

/** Convenience: register a list of manager singletons (used by a game's setup manifest). */
export function registerManagers(defs: ManagerDef[]): void {
  for (const d of defs) registerManager(d);
}

/** Unregister a manager by name — disposes it and drops its owned actions. */
export function unregisterManager(name: string): void {
  const entry = managers.get(name);
  if (!entry) return;
  deactivate(entry);
  managers.delete(name);
}

export function unregisterManagers(names: string[]): void {
  for (const n of names) unregisterManager(n);
}

/** Dispose every currently-active scene-scoped manager. Called by SceneManager
 *  on a scene swap, just before the old world is destroyed — pass that old world
 *  via `ctx` so a dispose() that tears down world-bound state operates on the
 *  world it was running against, not the freshly-promoted one. Game-scoped
 *  managers are untouched (they survive swaps).
 *
 *  Awaits any in-flight scene-manager init first, so a manager registered mid-
 *  scene (e.g. editor game-switch) whose async init is still running is never
 *  disposed half-initialized. */
export async function disposeActiveSceneManagers(ctx?: ManagerContext): Promise<void> {
  const pending: Promise<void>[] = [];
  for (const entry of managers.values()) {
    if (entry.scope === 'scene' && entry.active && entry.initPromise) pending.push(entry.initPromise);
  }
  if (pending.length) await Promise.all(pending);
  for (const entry of managers.values()) {
    if (entry.scope === 'scene' && entry.active) deactivate(entry, ctx);
  }
}

/** Activate scene-scoped managers whose filter matches the new scene. Awaitable
 *  so SceneManager can let async init (e.g. entity spawning) finish before
 *  `loadScene` resolves. Sets the active scene path used by later registrations. */
export async function initSceneManagersFor(scenePath: string): Promise<void> {
  activeScenePath = scenePath;
  const pending: Promise<void>[] = [];
  for (const entry of managers.values()) {
    if (entry.scope !== 'scene' || entry.active) continue;
    if (!sceneMatches(entry.def, scenePath)) continue;
    const r = activate(entry, scenePath);
    if (r) pending.push(r);
  }
  if (pending.length) await Promise.all(pending);
}

/** The active game id (null = no game). */
export function getActiveGameId(): string | null {
  return activeGameId;
}

/** Dispose every currently-active game-scoped manager. Called by SceneManager
 *  when the active game is *changing*, just before the old world is destroyed
 *  (pass that old world via `ctx`). App- and scene-scoped managers are untouched.
 *
 *  Awaits any in-flight game-manager init first, mirroring
 *  `disposeActiveSceneManagers`, so a manager whose async init is still running
 *  is never disposed half-initialized. */
export async function disposeActiveGameManagers(ctx?: ManagerContext): Promise<void> {
  const pending: Promise<void>[] = [];
  for (const entry of managers.values()) {
    if (entry.scope === 'game' && entry.active && entry.initPromise) pending.push(entry.initPromise);
  }
  if (pending.length) await Promise.all(pending);
  for (const entry of managers.values()) {
    if (entry.scope === 'game' && entry.active) deactivate(entry, ctx);
  }
}

/** Set the active game and activate game-scoped managers whose `games` filter
 *  matches it. `gameId === null` clears the active game (activates nothing).
 *  Awaitable so SceneManager can let async init finish before `loadScene`
 *  resolves. Idempotent for already-active managers. Pair with
 *  `disposeActiveGameManagers` when the game actually changes — this function
 *  only activates, it never disposes. */
export async function initGameManagersFor(gameId: string | null, scenePath: string): Promise<void> {
  activeGameId = gameId;
  if (gameId === null) return;
  const pending: Promise<void>[] = [];
  for (const entry of managers.values()) {
    if (entry.scope !== 'game' || entry.active) continue;
    if (!gameMatches(entry.def, gameId)) continue;
    const r = activate(entry, scenePath);
    if (r) pending.push(r);
  }
  if (pending.length) await Promise.all(pending);
}

/** Registered manager names + scope/active state (for debugging). */
export function getRegisteredManagers(): string[] {
  return [...managers.values()].map((e) => `${e.def.name} (${e.scope}${e.active ? ', active' : ''})`);
}

/** Test-only: dispose + clear everything and reset the active scene/game. */
export function __resetManagersForTesting(): void {
  for (const entry of managers.values()) deactivate(entry);
  managers.clear();
  activeScenePath = '';
  activeGameId = null;
}
