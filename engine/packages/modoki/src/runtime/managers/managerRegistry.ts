/** Manager registry — the event-driven counterpart to the per-frame System
 *  pipeline (`core/pipeline.ts`). A Manager owns long-lived state + a method
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

import { getCurrentWorld } from '../core/ecs/world';
import { registerUIAction, unregisterUIAction } from '../core/actionRegistry';
import type { ManagerScope, ManagerContext, ManagerDef } from '../core/managerTypes';
export type { ManagerScope, ManagerContext, ManagerDef } from '../core/managerTypes';

interface Entry {
  def: ManagerDef;
  scope: ManagerScope;
  active: boolean;
  actionNames: string[];
  /** In-flight init promise (errors swallowed), or null once settled. Lets
   *  `disposeActiveSceneManagers` await a pending init before disposing, so we
   *  never dispose a half-initialized manager. */
  initPromise: Promise<void> | null;
  /** Identifies ONE activation of this entry, so a dispose sweep that awaited
   *  across a re-entrant activate/deactivate can tell "the activation I started
   *  with" from "a later one that reused the same entry" — the entry reference
   *  alone can't distinguish those two activations. Bumped in `activate()`;
   *  0 until first activated. */
  activationId: number;
}

let nextActivationId = 1;

const managers = new Map<string, Entry>();
/** Which entry's `activationId` currently owns each registered action name.
 *  `deactivate` only unregisters an action it still owns per this map — a
 *  deferred teardown (see `deactivateWhenInitSettles`) can resolve after a
 *  newer entry has already claimed the same name, and must not strip it. */
const actionOwner = new Map<string, number>();
/** The scene whose scene-scoped managers are currently active. */
let activeScenePath = '';
/** The game whose game-scoped managers are currently active. TWO writers, and the
 *  second one is the whole of #539: `initGameManagersFor` sets it on success, and
 *  `disposeActiveGameManagers` CLEARS it at its own head. So `null` carries two
 *  meanings — "no game" (the menu, a prefab-edit world) and "a game teardown is in
 *  flight" — and both readers below want the same answer for either: do not
 *  auto-activate, and re-init on the next real game. A marker written only on
 *  success is exactly the defect #539 fixed; do not restore that. */
let activeGameId: string | null = null;

function sceneMatches(def: ManagerDef, scenePath: string): boolean {
  if (!def.scenes || def.scenes.length === 0) return true;
  return def.scenes.some((s) => scenePath.includes(s));
}

function gameMatches(def: ManagerDef, gameId: string): boolean {
  if (!def.games || def.games.length === 0) return true; // no filter = any active game
  return def.games.includes(gameId);
}

/** Register a manager's owned actions and return their names. Records
 *  ownership by `entry.activationId` so `deactivate` can tell its own
 *  actions from ones a newer entry has since claimed. */
function addActions(entry: Entry): string[] {
  const def = entry.def;
  const names = def.actions ? Object.keys(def.actions) : [];
  for (const [name, handler] of Object.entries(def.actions ?? {})) {
    registerUIAction(name, handler);
    actionOwner.set(name, entry.activationId);
  }
  return names;
}

function activate(entry: Entry, scenePath: string): void | Promise<void> {
  if (entry.active) return;
  entry.active = true;
  entry.activationId = nextActivationId++;
  entry.actionNames = addActions(entry);
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
  for (const n of entry.actionNames) {
    if (actionOwner.get(n) !== entry.activationId) continue; // a newer entry claimed it — not ours to remove
    actionOwner.delete(n);
    unregisterUIAction(n);
  }
  entry.actionNames = [];
  entry.initPromise = null;
  entry.active = false;
}

/** Tear `entry` down, but never mid-init. `registerManager`/`unregisterManager` are synchronous
 *  public API called from a game's `setup.ts`, so they cannot `await entry.initPromise` the way
 *  `disposeActiveSceneManagers` and friends do — they defer instead. Safe to defer only because
 *  `deactivate` is ownership-checked (see `actionOwner`): by the time this resolves a NEW entry may
 *  own this entry's action names, and stripping them would silently disarm a live manager.
 *
 *  ⚠️ Manager defs are module-level singletons passed by identity, so on a re-register
 *  `oldEntry.def === newEntry.def`. Deferring this teardown changes WHEN it runs relative to the
 *  replacement's own init: it used to always run `dispose(old)` before `init(new)`; now, whenever
 *  `initPromise` is non-null, the deferred `dispose(old)` would land AFTER `init(new)` has already
 *  completed — on the SAME instance, tearing down what the successor just built.
 *
 *  ✅ CLOSED (#573). `actionOwner` closed this for UIAction NAMES only, and for a while nothing
 *  guarded the manager's own fields or any other named global its `dispose()` released — so the
 *  rule was that a manager whose `init()` returns a promise had to TOLERATE its own `dispose()`
 *  running after a successor's `init()` (e.g. `LLMManager.dispose()`, which nulls `llmService` and
 *  clears messages). It no longer has to: the continuation below drops a superseded teardown by
 *  checking whether a DIFFERENT, live entry now holds this same def instance. ⚠️ The check is on
 *  the def, NOT on `entry.activationId` — `registerManager` builds a fresh Entry for the
 *  replacement, so the old entry's activationId never moves and comparing it guards nothing.
 *  Managers may still tolerate a late dispose defensively; nothing depends on them doing so. */
function deactivateWhenInitSettles(entry: Entry, ctx?: ManagerContext): void {
  const pending = entry.initPromise;
  if (!pending) { deactivate(entry, ctx); return; }
  // The identity token, captured BEFORE the deferral — the same guard
  // `pending` is the tracked promise from `activate()`, which swallows its own errors — it never
  // rejects, so a plain `.then` (no `.catch`) is correct here.
  void pending.then(() => {
    // Identity token — and it has to be about the DEF, not this entry.
    //
    // `registerManager` builds a BRAND-NEW Entry for the replacement (its body reads
    // `deactivateWhenInitSettles(existing)` … `const entry: Entry = {…}`), so `entry` in this
    // closure is the OLD object and its `activationId` never moves afterwards. Comparing that
    // field against a captured copy of itself is always equal and guards nothing — that was tried
    // here first, and a test written around it passed with the check REMOVED, which is how the
    // no-op was caught.
    //
    // What is genuinely shared is `def`: manager singletons are passed by identity, so
    // `oldEntry.def === newEntry.def`, and `deactivate` calls `entry.def.dispose?.()` on that
    // shared instance — destroying the state the successor's `init()` just built. `actionOwner`
    // closed this for UIAction names only.
    //
    // Dropping the WHOLE deactivate is right, not merely the dispose: the action names it would
    // release are already ownership-checked against `actionOwner`, and the successor has claimed
    // them. See docs/async-lifetime.md ("identity against a captured reference").
    const current = managers.get(entry.def.name);
    if (current && current !== entry && current.def === entry.def && current.active) return;
    deactivate(entry, ctx);
  });
}

/** Register a manager. App-scoped managers activate immediately and stay active
 *  until unregister. Game-/scene-scoped managers activate now only if their
 *  game/scene is already active and matches, otherwise they wait for the next
 *  matching game/scene activation. Re-registering a name replaces (and disposes)
 *  the previous one. */
export function registerManager(def: ManagerDef): void {
  const scope = def.scope ?? 'scene';
  const existing = managers.get(def.name);
  if (existing) { deactivateWhenInitSettles(existing); managers.delete(def.name); }

  const entry: Entry = { def, scope, active: false, actionNames: [], initPromise: null, activationId: 0 };
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
  deactivateWhenInitSettles(entry);
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
 *  disposed half-initialized.
 *
 *  Snapshots which activation of each entry it OWNS before awaiting, and
 *  deactivates only those activations afterward — a manager (re)activated
 *  DURING that await belongs to the INCOMING scene, not the outgoing one, and
 *  must survive this sweep. An entry unregistered during the await is already
 *  inactive (`unregisterManager` deactivated it), so the snapshot skips it.
 *
 *  ⚠️ Known residual, and an ACCEPTED one — #554, closed wontfix by owner ruling
 *  2026-09-01. Same shape #539 fixed one tier up on `activeGameId`, deliberately
 *  NOT fixed here: `initSceneManagersFor` has no `sceneChanged` gate (its
 *  game-scoped twin does), so this self-heals on the very next swap instead of
 *  stranding a scene for the session, and clearing `activeScenePath` here would
 *  hand a mid-swap app-scoped manager `scenePath: ''`. Don't "complete" #539 with
 *  it. See docs/managers-and-systems.md. A `registerManager` landing INSIDE
 *  the await activates against `activeScenePath`, which is still the OUTGOING
 *  scene (only `initSceneManagersFor` moves it, and SceneManager runs that after
 *  this) — so that manager belongs to the outgoing scene yet survives this sweep.
 *  It is caught by the next swap. Distinguishing it would need a second key on top
 *  of the activation id, and the old re-iterate-the-map behaviour traded this for
 *  the worse bug above: tearing down the INCOMING scene's live managers. */
export async function disposeActiveSceneManagers(ctx?: ManagerContext): Promise<void> {
  const owned: Array<[Entry, number]> = [];
  const pending: Promise<void>[] = [];
  for (const entry of managers.values()) {
    if (entry.scope !== 'scene' || !entry.active) continue;
    owned.push([entry, entry.activationId]);
    if (entry.initPromise) pending.push(entry.initPromise);
  }
  if (pending.length) await Promise.all(pending);
  for (const [entry, id] of owned) {
    if (entry.active && entry.activationId === id) deactivate(entry, ctx);
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
 *  Clears `activeGameId` SYNCHRONOUSLY at the head, before the entry-collection
 *  loop and before any await (#539, the #516 pattern one layer down: a marker
 *  written only on success — `initGameManagersFor` — was read during a teardown
 *  that started earlier). Without this, `getActiveGameId()` kept answering the
 *  OUTGOING game for the whole await below, which had two bad readers:
 *  `registerManager` would auto-activate a newly-registered manager against the
 *  dead game (into a world about to be destroyed), and a re-entrant `loadScene`
 *  back to the outgoing game mid-teardown would compute `gameChanged === false`
 *  and skip `initGameManagersFor` entirely, permanently deactivating that game's
 *  managers. Clearing it here closes both: `registerManager` now sees null and
 *  defers activation to `initGameManagersFor`'s own sweep, and a re-entrant load
 *  can see `gameChanged === true` and re-init.
 *
 *  ⚠️ **"can", not "will" — the second half is closed only for a load that NAMES its
 *  game.** `SceneManager` computes `nextGameId` as `gameIdFromScenePath(path) ??
 *  getActiveGameId()` and compares it against `getActiveGameId()`, so when the path
 *  yields no game id the fallback makes `gameChanged` false by construction, before
 *  and after this change alike. That covers the app shell (always passes
 *  `opts.gameId`) and the editor, but NOT `NavigationManager.loadScene`, which passes
 *  none — and in a shipped web build the resolved path is a hashed asset URL that
 *  `gameIdFromScenePath` returns null for. Such a load is no worse off than before
 *  the fix (it was equally stuck), and is now strictly more recoverable: the next
 *  load that does name its game re-inits, where a stale id made that false forever.
 *
 *  Awaits any in-flight game-manager init first, mirroring
 *  `disposeActiveSceneManagers`, so a manager whose async init is still running
 *  is never disposed half-initialized.
 *
 *  Same activation-token snapshot as `disposeActiveSceneManagers` — see its
 *  comment: a manager (re)activated during the await belongs to the incoming
 *  game, not the outgoing one. */
export async function disposeActiveGameManagers(ctx?: ManagerContext): Promise<void> {
  activeGameId = null;
  const owned: Array<[Entry, number]> = [];
  const pending: Promise<void>[] = [];
  for (const entry of managers.values()) {
    if (entry.scope !== 'game' || !entry.active) continue;
    owned.push([entry, entry.activationId]);
    if (entry.initPromise) pending.push(entry.initPromise);
  }
  if (pending.length) await Promise.all(pending);
  for (const [entry, id] of owned) {
    if (entry.active && entry.activationId === id) deactivate(entry, ctx);
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

/** Every in-flight manager `init()` promise across ALL scopes (app/game/scene),
 *  or null when none are pending. The tracked promises swallow their own errors
 *  (see `activate`), so the returned promise never rejects.
 *
 *  At the point SceneManager calls this (just before destroying the old world in
 *  `loadScene`), it is normally a no-op: `disposeActiveSceneManagers` has already
 *  awaited + deactivated scene managers (clearing their `initPromise`), and a
 *  `gameChanged` swap has already awaited + deactivated game managers, with
 *  `initGameManagersFor` running only AFTER the destroy. So a non-null result
 *  here means an init was launched by a *different*, superseded `loadScene` call
 *  (#468) — plus the app-scoped case of a manager registered just before a swap. */
export function pendingManagerInits(): Promise<void> | null {
  const pending: Promise<void>[] = [];
  for (const entry of managers.values()) {
    if (entry.active && entry.initPromise) pending.push(entry.initPromise);
  }
  return pending.length ? Promise.all(pending).then(() => {}) : null;
}

/** Registered manager names + scope/active state (for debugging). */
export function getRegisteredManagers(): string[] {
  return [...managers.values()].map((e) => `${e.def.name} (${e.scope}${e.active ? ', active' : ''})`);
}

/** Test-only: dispose + clear everything and reset the active scene/game. */
export function __resetManagersForTesting(): void {
  for (const entry of managers.values()) deactivate(entry);
  managers.clear();
  actionOwner.clear();
  activeScenePath = '';
  activeGameId = null;
}
