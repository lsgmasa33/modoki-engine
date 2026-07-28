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

  /** Push a scene onto the back-stack, deduping a consecutive repeat (rapid
   *  double-nav) and bounding total depth. */
  private pushHistory(scene: string): void {
    if (this.history[this.history.length - 1] === scene) return;
    this.history.push(scene);
    if (this.history.length > MAX_HISTORY) this.history.shift();
  }

  actions = {
    'engine.loadScene': ({ payload }: UIActionContext) => { void this.loadScene(payload); },
    'engine.navigateBack': () => { void this.back(); },
  };

  init(): void {
    registerReadSource('canGoBack', () => this.canGoBack);
  }
  dispose(): void {
    unregisterReadSource('canGoBack');
    this.history = [];
  }

  get canGoBack(): boolean {
    return this.history.length > 0;
  }

  /** Navigate to a scene (GUID or path), pushing the current scene onto history
   *  so `back()` can return to it. */
  async loadScene(ref: unknown): Promise<void> {
    const path = resolvePath(ref);
    if (!path) { console.warn(`[navigation] could not resolve scene "${String(ref)}"`); return; }
    const current = sceneManager.getCurrent()?.path;
    if (current && current !== path) {
      // Forward-navigating to the scene we'd `back()` into is an oscillation
      // (A→B→A→B…) — collapse it instead of growing the stack unboundedly.
      if (this.history[this.history.length - 1] === path) this.history.pop();
      else this.pushHistory(current);
    }
    await sceneManager.loadScene(path);
  }

  /** Navigate to the previous scene, if any. Inert (no-op) at the root. */
  async back(): Promise<void> {
    const prev = this.history.pop();
    if (!prev) return;
    await sceneManager.loadScene(prev);
  }

  /** Navigate without recording history. */
  async replace(ref: unknown): Promise<void> {
    const path = resolvePath(ref);
    if (!path) { console.warn(`[navigation] could not resolve scene "${String(ref)}"`); return; }
    await sceneManager.loadScene(path);
  }
}

/** The singleton NavigationManager. Registered by core (app/ecs/register.ts);
 *  call its methods by importing this directly. Typed as {@link NavigationManager}
 *  (not the `Impl` class) so the public surface — and the generated API
 *  reference — show the documented interface, not the private implementation. */
export const navigationManager: NavigationManager = new NavigationManagerImpl();
