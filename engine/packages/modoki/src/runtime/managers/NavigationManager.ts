/** NavigationManager — engine-global scene navigation + history.
 *
 *  The single home for navigation, replacing the scattered `engine.loadScene`
 *  action body and games' hand-rolled `navigateBack`. Owns the **history stack**
 *  (the missing piece — `back()` needs it) and backs onto `SceneManager`, which
 *  owns the actual transitions.
 *
 *  Exposes built-in actions (`engine.loadScene`, `engine.navigateBack`) every
 *  game inherits, and a `canGoBack` read source so a Back button can bind its
 *  disabled state. Registered once at core startup (app scope → engine
 *  infrastructure, alive the whole session, independent of scene or game).
 *
 *  Only this manager's own methods record history — direct `sceneManager.loadScene`
 *  calls (initial load, hot-reload) intentionally bypass it.
 *
 *  See docs/managers-and-systems.md ("NavigationManager"). */

import { sceneManager } from '../scene/SceneManager';
import { resolveGuidToPath } from '../loaders/assetManifest';
import { isGuid } from '../core/assetRefRules';
import { registerReadSource, unregisterReadSource } from '../core/readSourceRegistry';
import { onWorldSwap } from '../core/ecs/worldRegistry';
import type { ManagerDef } from './managerRegistry';
import type { UIActionContext } from '../core/actionRegistry';

/** Resolve a scene ref (GUID or path/URL) to a load path, or undefined. */
function resolvePath(ref: unknown): string | undefined {
  const r = typeof ref === 'string' ? ref.trim() : '';
  if (!r) return undefined;
  return isGuid(r) ? resolveGuidToPath(r) : r;
}

/** Cap on the back-stack depth — FIFO-dropped from the bottom. A real session
 *  rarely nests more than a handful of scenes; the cap just bounds pathological
 *  growth (e.g. a menu loop that forward-navigates instead of using back()). */
const MAX_HISTORY = 50;

/** Public surface of the {@link navigationManager} singleton. See the module doc above. */
export interface NavigationManager extends ManagerDef {
  /** Narrowed to the no-arg form the implementation actually has — inheriting
   *  `ManagerDef`'s `init(ctx: ManagerContext)` would force every direct caller to
   *  fabricate a context this manager never reads (#37). Required, not optional: both
   *  are always implemented. Rule + rationale: `docs/managers-and-systems.md`. */
  init(): void;
  dispose(): void;
  /** True once at least one `loadScene`/back-eligible navigation has happened. */
  readonly canGoBack: boolean;
  /** Navigate to a scene (GUID or path), pushing the current scene onto history
   *  so `back()` can return to it. */
  loadScene(ref: unknown): Promise<void>;
  /** Navigate to the previous scene, if any. Inert (no-op) at the root. */
  back(): Promise<void>;
  /** Navigate without recording history. */
  replace(ref: unknown): Promise<void>;
}

class NavigationManagerImpl implements ManagerDef {
  name = 'engine.navigation';
  scope = 'app' as const;

  private history: string[] = [];
  /** The scene we are on, as of the last world swap — the `from` half of the next
   *  transition. Tracked here because `onWorldSwap` reports WORLDS, not paths, and
   *  updated on EVERY swap (including ones this manager did not cause), or it would
   *  go stale the first time something loads a scene behind our back. */
  private lastPath: string | null = null;
  /** In-flight navigations, keyed by a per-CALL id. ⚠️ Not a `Set<path>`: two
   *  navigations to the same path are two claims, and a Set collapses them into one —
   *  whichever settled first then released it for both, so the winner's swap recorded
   *  nothing (two Back presses, or a Back racing a Menu button onto the same scene).
   *  `suppress` marks a `replace()`, which must consume its own swap WITHOUT recording
   *  so its "navigate without history" contract holds even when a `loadScene` for the
   *  same path is in flight. */
  private claims = new Map<number, { path: string; suppress: boolean }>();
  private claimSeq = 0;
  private unsubSwap: (() => void) | null = null;

  /** Push a scene onto the back-stack, deduping a consecutive repeat (rapid
   *  double-nav) and bounding total depth. */
  private pushHistory(scene: string): void {
    if (this.history[this.history.length - 1] === scene) return;
    this.history.push(scene);
    if (this.history.length > MAX_HISTORY) this.history.shift();
  }

  /** Record one committed transition. ⚠️ **This is the only place `history` changes**,
   *  and that is the fix for #808 rather than an implementation detail.
   *
   *  Three earlier repairs all had the navigation's own CONTINUATION decide what to
   *  write after its `await`, by inspecting the stack — which is exactly what a
   *  concurrent navigation may have changed by then. Each guard was a different proxy
   *  for "did my navigation actually win", and each failed on a different interleaving.
   *  The swap is the authoritative, serialized answer, so no proxy is needed.
   *
   *  ⚠️ Supersession cuts both ways, and each half killed a different repair: a load
   *  superseded BEFORE its swap REJECTS (`AbortError` — normal operation, see
   *  `ui/bindings.ts`), so the loser settles first and a claim must be per-CALL; one
   *  superseded by a newer load AFTER its swap is no longer cancelled and RESOLVES, so
   *  its stale continuation runs after the winner's. (Neither is absolute: a mid-flight
   *  `unloadAll()` still throws post-swap via `postSwapSuperseded`, #542.)
   *
   *  `SceneManager` sets `loadedScenes`/`primaryId` BEFORE `setCurrentWorld`, so
   *  `getCurrent()` already reports the new scene when this fires. Full history of the
   *  six shapes, and what each one failed: `docs/managers-and-systems.md`. */
  private onSwap(): void {
    const to = sceneManager.getCurrent()?.path ?? null;
    const from = this.lastPath;
    this.lastPath = to;   // tracked for EVERY swap, ours or not
    if (!to) return;
    const claim = this.takeClaim(to);
    if (!claim || claim.suppress) return;
    // ⚠️ The pop is checked BEFORE the `from === to` guard, and unconditionally. It
    // maintains the invariant "the current scene is never the top of the back-stack",
    // and `from === to` is exactly when that invariant is most likely already broken:
    // something outside this manager (Play-stop restore, prefab undo, an agent
    // `load_scene`) put us ON the entry at the top, and then `back()` to it swaps
    // A→A. Guarding first left the entry unconsumed, so `canGoBack` stayed true and
    // every later Back reloaded the scene the player was already standing on.
    if (this.history[this.history.length - 1] === to) { this.history.pop(); return; }
    // Below here it is a genuine forward move; `from === to` is a same-scene reload,
    // which must not push (there is nothing to go back to).
    if (!from || from === to) return;
    this.pushHistory(from);
  }

  /** Register an in-flight navigation; the id is released by the caller's `finally`. */
  private addClaim(path: string, suppress = false): number {
    const id = ++this.claimSeq;
    this.claims.set(id, { path, suppress });
    return id;
  }

  /** Consume ONE claim for `path` — the most recently STARTED one.
   *
   *  ⚠️ Two concurrent navigations to the same scene with opposite intent (a `replace()`
   *  and a `loadScene()`) are genuinely ambiguous: nothing in `onWorldSwap` says which
   *  call caused the swap, so any rule here is a tie-break rather than an answer.
   *  "Most recent intent wins" is the one that is defensible in BOTH directions — it is
   *  what the player last asked for. Preferring the suppressing claim instead reads as
   *  the safer choice and is not: a `replace()` that was itself superseded, whose
   *  `finally` has not yet run, would then disarm the `loadScene` that actually
   *  committed, and Back goes dead. Claims for one path are otherwise interchangeable,
   *  so `suppress` is the only axis this has to get right.
   *
   *  Ids increase, and `Map` iterates in insertion order, so the LAST match is the
   *  newest. */
  private takeClaim(path: string): { path: string; suppress: boolean } | null {
    let newest: number | null = null;
    for (const [id, c] of this.claims) if (c.path === path) newest = id;
    if (newest === null) return null;
    const c = this.claims.get(newest)!;
    this.claims.delete(newest);
    return c;
  }

  actions = {
    // Return (not `void`) the promise — `applyBindings`' `trackLockPromise` (#466) duck-types
    // a 'call' handler's return value and holds the global input lock open until it settles.
    // `void`-ing it made these two built-ins the one gap in the owner's "wait for the button
    // action to be done" ruling: with nothing to await, the lock lifted on the 300ms floor
    // alone, so a Play button bound to `engine.loadScene`, tapped at t=0 and t=350ms against a
    // ~2s load, fired the load TWICE — the exact overlapping-load race #435/#468 exist to
    // contain. `UIActionHandler` is `=> unknown`, so returning the promise here is legal.
    // ⚠️ Honest caveat: the lock is released by `bindings.ts`'s `onWorldSwap` hook at the scene
    // SWAP, not when this promise finally resolves — `loadScene`'s own promise settles slightly
    // AFTER the swap it triggers. So this covers the pre-swap window (chain resolution,
    // resource acquisition), which is where a double-tap actually lands, not the post-swap
    // tail. That's intended, not a shortcut: a new scene should start with fresh input.
    'engine.loadScene': ({ payload }: UIActionContext) => this.loadScene(payload),
    'engine.navigateBack': () => this.back(),
  };

  init(): void {
    registerReadSource('canGoBack', () => this.canGoBack);
    this.unsubSwap = onWorldSwap(() => this.onSwap());
    // Seed from whatever is already live. ⚠️ In the CURRENT boot order this always reads
    // null and is therefore dead: `registerAll()` activates this manager (which calls
    // `init()` synchronously) before `loadInitialScene()` runs, and the editor path is
    // the same. Kept because it costs one read and the alternative is a silent wrong
    // `from` on the first transition if that order ever changes — but do not cite it as
    // load-bearing, and do not let it imply a boot scene may already exist here.
    this.lastPath = sceneManager.getCurrent()?.path ?? null;
  }
  dispose(): void {
    unregisterReadSource('canGoBack');
    this.unsubSwap?.();
    this.unsubSwap = null;
    this.history = [];
    this.claims.clear();
    this.lastPath = null;
  }

  get canGoBack(): boolean {
    return this.history.length > 0;
  }

  /** Navigate to a scene (GUID or path), recording the scene we LEAVE so `back()`
   *  can return to it.
   *
   *  This method does not touch `history` at all — it only CLAIMS its target, and
   *  `onSwap` records the transition if and when that swap actually commits. See
   *  `onSwap` for why three earlier repairs that wrote here were each wrong. */
  async loadScene(ref: unknown): Promise<void> {
    const path = resolvePath(ref);
    if (!path) { console.warn(`[navigation] could not resolve scene "${String(ref)}"`); return; }
    const claim = this.addClaim(path);
    try {
      await sceneManager.loadScene(path);
    } finally {
      // Normally already consumed by `onSwap` mid-await; this releases THIS call's own
      // claim when the load never swapped (rejected, superseded before its swap,
      // aborted) — and only its own, so a sibling navigation to the same path keeps its.
      this.claims.delete(claim);
    }
  }

  /** Navigate to the previous scene, if any. Inert (no-op) at the root. */
  async back(): Promise<void> {
    // Read without popping. `onSwap` does the pop, via the same rule that collapses an
    // A→B→A oscillation — arriving at the entry we would back() into IS the back.
    const prev = this.history[this.history.length - 1];
    if (!prev) return;
    const claim = this.addClaim(prev);
    try {
      await sceneManager.loadScene(prev);
    } finally {
      this.claims.delete(claim);
    }
  }

  /** Navigate without recording history. Claims its target as SUPPRESSING rather than
   *  not claiming at all — otherwise a `loadScene` for the same path that happens to be
   *  in flight would have its claim consumed by this swap and record a push. */
  async replace(ref: unknown): Promise<void> {
    const path = resolvePath(ref);
    if (!path) { console.warn(`[navigation] could not resolve scene "${String(ref)}"`); return; }
    const claim = this.addClaim(path, true);
    try {
      await sceneManager.loadScene(path);
    } finally {
      this.claims.delete(claim);
    }
  }
}

/** The singleton NavigationManager. Registered by core (app/ecs/register.ts);
 *  call its methods by importing this directly. Typed as {@link NavigationManager}
 *  (not the `Impl` class) so the public surface — and the generated API
 *  reference — show the documented interface, not the private implementation. */
export const navigationManager: NavigationManager = new NavigationManagerImpl();
