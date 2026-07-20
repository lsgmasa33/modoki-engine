/** Manager registry — the event-driven counterpart to the System pipeline.
 *  Covers the three scope lifecycles (app vs game vs scene), the SceneManager-
 *  driven scene + game transition hooks, owned-action register/unregister,
 *  scene/game filtering, and replace-on-re-register. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createWorld } from 'koota';
import { setCurrentWorld } from '../../src/runtime/ecs/world';
import { setPlayState } from '../../src/runtime/systems/playState';
import { getUIActionNames, dispatchUIAction } from '../../src/runtime/ui/actionRegistry';
import {
  registerManager, registerManagers, unregisterManager,
  disposeActiveSceneManagers, initSceneManagersFor, getRegisteredManagers,
  disposeActiveGameManagers, initGameManagersFor, getActiveGameId,
  __resetManagersForTesting, type ManagerDef,
} from '../../src/runtime/managers/managerRegistry';

describe('managerRegistry', () => {
  let world: ReturnType<typeof createWorld>;
  beforeEach(() => {
    world = createWorld();
    setCurrentWorld(world);
    setPlayState('playing'); // dispatchUIAction is gated on the sim running
  });
  afterEach(() => {
    __resetManagersForTesting();
    setPlayState('playing');
    // Free the koota world slot — the pool caps at 16, so a per-test createWorld
    // without this exhausts it once the suite grows past 16 cases.
    try { world.destroy(); } catch { /* already destroyed */ }
  });

  // ── app scope ─────────────────────────────────────────────────────────────

  it('app-scoped manager inits at register and disposes at unregister', () => {
    const init = vi.fn();
    const dispose = vi.fn();
    registerManager({ name: 'a', scope: 'app', init, dispose });
    expect(init).toHaveBeenCalledOnce();
    expect(dispose).not.toHaveBeenCalled();

    unregisterManager('a');
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('app-scoped manager is untouched by scene AND game transitions', async () => {
    const dispose = vi.fn();
    registerManager({ name: 'a', scope: 'app', dispose });
    disposeActiveSceneManagers();          // a scene swap occurred
    await disposeActiveGameManagers();     // the active game changed
    expect(dispose).not.toHaveBeenCalled();
  });

  it('app-scoped manager owns its actions from register to unregister', () => {
    const handler = vi.fn();
    registerManager({ name: 'a', scope: 'app', actions: { 'a.do': handler } });
    expect(getUIActionNames()).toContain('a.do');

    dispatchUIAction('a.do', { payload: 'x' });
    expect(handler).toHaveBeenCalledOnce();

    unregisterManager('a');
    expect(getUIActionNames()).not.toContain('a.do');
  });

  // ── game scope (keyed on the active game) ───────────────────────────────────

  it('game-scoped manager stays inert until its game becomes active', async () => {
    const init = vi.fn();
    registerManager({ name: 'g', scope: 'game', init });   // no active game yet
    expect(init).not.toHaveBeenCalled();

    await initGameManagersFor('space-console', '/games/space-console/scenes/Station.json');
    expect(init).toHaveBeenCalledOnce();
    expect(getActiveGameId()).toBe('space-console');
  });

  it('survives an in-game scene swap, disposes when the active game changes', async () => {
    const dispose = vi.fn();
    registerManager({ name: 'g', scope: 'game', games: ['space-console'], dispose });
    await initGameManagersFor('space-console', '/games/space-console/scenes/Station.json');

    disposeActiveSceneManagers();              // in-game scene swap (Station→Warp)
    expect(dispose).not.toHaveBeenCalled();    // game scope untouched by scene swap

    await disposeActiveGameManagers();         // active game changed away
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('respects the games filter (omitted = any active game)', async () => {
    const onlySpace = vi.fn();
    const anyGame = vi.fn();
    registerManager({ name: 'cam', scope: 'game', games: ['space-console'], init: onlySpace });
    registerManager({ name: 'any', scope: 'game', init: anyGame });

    await initGameManagersFor('chess', '/games/chess/scenes/chess.json');
    expect(onlySpace).not.toHaveBeenCalled();
    expect(anyGame).toHaveBeenCalledOnce();

    await disposeActiveGameManagers();
    await initGameManagersFor('space-console', '/games/space-console/scenes/Station.json');
    expect(onlySpace).toHaveBeenCalledOnce();
  });

  it('inits a game-scoped manager immediately if its game is already active', async () => {
    await initGameManagersFor('space-console', '/games/space-console/scenes/Station.json');
    const init = vi.fn();
    registerManager({ name: 'late', scope: 'game', games: ['space-console'], init });
    expect(init).toHaveBeenCalledOnce();
  });

  it('owns its actions only while its game is active', async () => {
    const handler = vi.fn();
    registerManager({ name: 'g', scope: 'game', actions: { 'g.do': handler } });
    expect(getUIActionNames()).not.toContain('g.do');      // game not active yet

    await initGameManagersFor('x', '/games/x/scenes/A.json');
    expect(getUIActionNames()).toContain('g.do');
    dispatchUIAction('g.do', { payload: 'x' });
    expect(handler).toHaveBeenCalledOnce();

    await disposeActiveGameManagers();
    expect(getUIActionNames()).not.toContain('g.do');
  });

  // ── scene scope ─────────────────────────────────────────────────────────--

  it('scene-scoped manager stays inert until a matching scene loads', async () => {
    const init = vi.fn();
    registerManager({ name: 's', init });           // no active scene yet
    expect(init).not.toHaveBeenCalled();

    await initSceneManagersFor('/games/x/scenes/Menu.json');
    expect(init).toHaveBeenCalledOnce();
  });

  it('scene-scoped manager disposes on swap away (and its actions drop)', async () => {
    const dispose = vi.fn();
    registerManager({ name: 's', actions: { 's.do': vi.fn() }, dispose });
    await initSceneManagersFor('/games/x/scenes/Menu.json');
    expect(getUIActionNames()).toContain('s.do');

    disposeActiveSceneManagers();
    expect(dispose).toHaveBeenCalledOnce();
    expect(getUIActionNames()).not.toContain('s.do');
  });

  it('re-inits with fresh state across scenes (state cannot leak)', async () => {
    const init = vi.fn();
    const dispose = vi.fn();
    registerManager({ name: 's', init, dispose });

    await initSceneManagersFor('/scenes/A.json');
    disposeActiveSceneManagers();
    await initSceneManagersFor('/scenes/B.json');

    expect(init).toHaveBeenCalledTimes(2);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('passes the triggering scene path into init context', async () => {
    let seen = '';
    registerManager({ name: 's', init: (ctx) => { seen = ctx.scenePath; } });
    await initSceneManagersFor('/scenes/Warp.json');
    expect(seen).toBe('/scenes/Warp.json');
  });

  it('awaits async init before resolving', async () => {
    const order: string[] = [];
    registerManager({
      name: 's',
      init: async () => { await Promise.resolve(); order.push('init-done'); },
    });
    await initSceneManagersFor('/scenes/A.json');
    order.push('after-await');
    expect(order).toEqual(['init-done', 'after-await']);
  });

  it('disposeActiveSceneManagers awaits a pending async init before disposing', async () => {
    // Regression: a scene-scoped manager registered while its scene is already
    // active (editor game-switch) has a fire-and-forget async init. A swap must
    // not dispose it mid-init — dispose must observe init having completed.
    const order: string[] = [];
    let resolveInit!: () => void;
    const initGate = new Promise<void>((r) => { resolveInit = r; });

    // Make the scene already active so registerManager activates immediately
    // via the `void activate(...)` branch (init not awaited by the caller).
    await initSceneManagersFor('/scenes/A.json');
    registerManager({
      name: 'slow',
      init: async () => { await initGate; order.push('init-done'); },
      dispose: () => { order.push('dispose'); },
    });

    // Kick off the dispose while init is still gated, then let init finish.
    const disposed = disposeActiveSceneManagers();
    resolveInit();
    await disposed;

    expect(order).toEqual(['init-done', 'dispose']); // dispose never precedes init
  });

  // ── scene filter ──────────────────────────────────────────────────────────

  it('respects the scenes filter (substring match); omitted filter = every scene', async () => {
    const onlyWarp = vi.fn();
    const everywhere = vi.fn();
    registerManager({ name: 'warp', scenes: ['Warp'], init: onlyWarp });
    registerManager({ name: 'all', init: everywhere });

    await initSceneManagersFor('/games/x/scenes/Station.json');
    expect(onlyWarp).not.toHaveBeenCalled();
    expect(everywhere).toHaveBeenCalledOnce();

    disposeActiveSceneManagers();
    await initSceneManagersFor('/games/x/scenes/Warp.json');
    expect(onlyWarp).toHaveBeenCalledOnce();
  });

  it('inits a scene-scoped manager immediately if its scene is already active', async () => {
    await initSceneManagersFor('/scenes/Menu.json'); // scene already active
    const init = vi.fn();
    registerManager({ name: 'late', init });
    expect(init).toHaveBeenCalledOnce();
  });

  it('does NOT immediately init when the active scene fails the filter', async () => {
    await initSceneManagersFor('/scenes/Menu.json');
    const init = vi.fn();
    registerManager({ name: 'late', scenes: ['Other'], init });
    expect(init).not.toHaveBeenCalled();
  });

  // ── misc ──────────────────────────────────────────────────────────────────

  it('replace-on-re-register disposes the previous (active) instance', () => {
    const disposeA = vi.fn();
    registerManager({ name: 'dup', scope: 'app', dispose: disposeA });
    registerManager({ name: 'dup', scope: 'app', dispose: vi.fn() });
    expect(disposeA).toHaveBeenCalledOnce();
    expect(getRegisteredManagers().filter((s) => s.startsWith('dup'))).toHaveLength(1);
  });

  it('registerManagers registers a list', () => {
    const defs: ManagerDef[] = [
      { name: 'a', scope: 'app' },
      { name: 'b', scope: 'app' },
    ];
    registerManagers(defs);
    const names = getRegisteredManagers();
    expect(names.some((s) => s.startsWith('a'))).toBe(true);
    expect(names.some((s) => s.startsWith('b'))).toBe(true);
  });
});
