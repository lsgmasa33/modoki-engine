/** Manager registry — the event-driven counterpart to the System pipeline.
 *  Covers the three scope lifecycles (app vs game vs scene), the SceneManager-
 *  driven scene + game transition hooks, owned-action register/unregister,
 *  scene/game filtering, and replace-on-re-register. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createWorld } from 'koota';
import { setCurrentWorld } from '../../src/runtime/core/ecs/world';
import { setPlayState } from '../../src/runtime/core/playState';
import { getUIActionNames, dispatchUIAction } from '../../src/runtime/core/actionRegistry';
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
    registerManager({ name: 's', actions: { 's.do': vi.fn<() => void>() }, dispose });
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

  // ── activation-token race (#487 item 5) ─────────────────────────────────────
  // disposeActiveSceneManagers/disposeActiveGameManagers each await pending
  // inits, THEN re-walk `managers.values()` deactivating every active entry of
  // that scope. A manager activated DURING that await belongs to the INCOMING
  // scene/game, not the outgoing one, and must not be swept up in it.

  it('does not dispose a manager activated during the sweep\'s await (scene scope)', async () => {
    const disposeSlow = vi.fn();
    const disposeLate = vi.fn();
    let resolveInit!: () => void;
    const initGate = new Promise<void>((r) => { resolveInit = r; });

    await initSceneManagersFor('/scenes/A.json');
    registerManager({
      name: 'slow',
      init: async () => { await initGate; },
      dispose: disposeSlow,
    });

    // Start disposing the outgoing scene's managers; 'slow' is mid-init.
    const disposed = disposeActiveSceneManagers();

    // While that dispose is awaiting, the INCOMING scene activates a second
    // manager sharing the registry's Map — it must survive the sweep above.
    await initSceneManagersFor('/scenes/B.json');
    registerManager({ name: 'late', dispose: disposeLate });

    resolveInit();
    await disposed;

    expect(disposeSlow).toHaveBeenCalledOnce();   // the outgoing manager IS disposed
    expect(disposeLate).not.toHaveBeenCalled();   // the incoming one is NOT
    expect(getRegisteredManagers().find((s) => s.startsWith('late'))).toContain('active');
  });

  it('still waits for the async init to settle before disposing (keep direction)', async () => {
    const order: string[] = [];
    let resolveInit!: () => void;
    const initGate = new Promise<void>((r) => { resolveInit = r; });

    await initSceneManagersFor('/scenes/A.json');
    registerManager({
      name: 'slow',
      init: async () => { await initGate; order.push('init-done'); },
      dispose: () => { order.push('dispose'); },
    });

    const disposed = disposeActiveSceneManagers();
    resolveInit();
    await disposed;

    expect(order).toEqual(['init-done', 'dispose']); // dispose never precedes init
  });

  it('does not dispose a manager activated during the sweep\'s await (game scope)', async () => {
    const disposeSlow = vi.fn();
    const disposeLate = vi.fn();
    let resolveInit!: () => void;
    const initGate = new Promise<void>((r) => { resolveInit = r; });

    await initGameManagersFor('space-console', '/games/space-console/scenes/Station.json');
    registerManager({
      name: 'slow-g',
      scope: 'game',
      init: async () => { await initGate; },
      dispose: disposeSlow,
    });

    const disposed = disposeActiveGameManagers();

    await initGameManagersFor('chess', '/games/chess/scenes/chess.json');
    registerManager({ name: 'late-g', scope: 'game', dispose: disposeLate });

    resolveInit();
    await disposed;

    expect(disposeSlow).toHaveBeenCalledOnce();
    expect(disposeLate).not.toHaveBeenCalled();
    expect(getRegisteredManagers().find((s) => s.startsWith('late-g'))).toContain('active');
  });

  // ── activeGameId cleared at teardown head (#539) ────────────────────────────
  // `disposeActiveGameManagers` used to write `activeGameId` only on the
  // FOLLOWING `initGameManagersFor` (i.e. never, during its own await), so
  // `getActiveGameId()` kept answering the OUTGOING game for the whole
  // teardown window. Two readers cared: `registerManager` (auto-activates a
  // newly-registered game-scoped manager against `activeGameId`) and a
  // re-entrant `loadScene`'s `gameChanged` computation.

  it('a manager registered mid-teardown is NOT auto-activated against the outgoing game', async () => {
    let resolveInit!: () => void;
    const initGate = new Promise<void>((r) => { resolveInit = r; });

    await initGameManagersFor('space-console', '/games/space-console/scenes/Station.json');
    // An in-flight async init on an already-active manager holds the dispose
    // sweep's await open, giving us a window to register during teardown.
    registerManager({
      name: 'slow',
      scope: 'game',
      games: ['space-console'],
      init: async () => { await initGate; },
    });

    const disposed = disposeActiveGameManagers();

    // Registered WHILE the dispose above is still awaiting — matches the game
    // being torn down.
    const lateInit = vi.fn();
    registerManager({ name: 'late', scope: 'game', games: ['space-console'], init: lateInit });
    expect(lateInit).not.toHaveBeenCalled(); // must not activate against the dying game

    resolveInit();
    await disposed;

    // The assertion that actually matters: registering mid-teardown DEFERS
    // activation rather than losing it. `lateInit` not having fired proves
    // nothing on its own — the sweep's `owned` snapshot excludes it either
    // way, fix or no fix. What the doc comment above promises is that the
    // NEXT `initGameManagersFor` for the same game picks it up.
    await initGameManagersFor('space-console', '/games/space-console/scenes/Station.json');
    expect(lateInit).toHaveBeenCalledOnce();
  });

  it('getActiveGameId() is null once teardown has begun, and a re-entrant initGameManagersFor re-activates', async () => {
    let resolveInit!: () => void;
    const initGate = new Promise<void>((r) => { resolveInit = r; });

    const initA = vi.fn();
    registerManager({ name: 'a-mgr', scope: 'game', games: ['A'], init: initA });
    await initGameManagersFor('A', '/games/A/scenes/S.json');
    expect(initA).toHaveBeenCalledOnce();
    expect(getActiveGameId()).toBe('A');

    // Hold the sweep open via a second in-flight init.
    registerManager({ name: 'slow', scope: 'game', games: ['A'], init: async () => { await initGate; } });
    const disposed = disposeActiveGameManagers();

    expect(getActiveGameId()).toBeNull(); // cleared synchronously at the head, before the await

    resolveInit();
    await disposed;
    expect(getActiveGameId()).toBeNull();

    // A re-entrant A→B→A load would compute gameChanged = 'A' !== getActiveGameId().
    // With activeGameId cleared, that is true, so SceneManager calls
    // initGameManagersFor('A', ...) again — it must actually re-activate.
    // NOTE: this tail drives the registry directly (`initGameManagersFor`, not
    // `SceneManager.loadScene`) — it does not exercise the `gameChanged`
    // computation itself. That seam is covered by the real `SceneManager`
    // integration test in sceneManagerGameTeardown.test.ts ('#539: a re-entrant
    // loadScene back to the outgoing game re-activates its game-scoped manager').
    await initGameManagersFor('A', '/games/A/scenes/S.json');
    expect(initA).toHaveBeenCalledTimes(2);
    expect(getActiveGameId()).toBe('A');
  });

  // ── activation-token re-use (SAME entry, not a new one) ─────────────────────
  // The two tests above prove the OWNED-ARRAY snapshot excludes a brand-new
  // entry activated during the await. They can't tell "the entry reference
  // alone" from "the activation id" apart, because a new Entry never differs
  // in id from what it was snapshotted with (it was never snapshotted at all).
  // This one re-activates the SAME Entry object with a NEW activationId while
  // the outer sweep is still suspended on an unrelated manager, so only the id
  // comparison (not `entry.active` alone) can tell the two activations apart.

  it('does not dispose a re-activated entry whose sweep already fired once (activationId)', async () => {
    const disposeE = vi.fn();
    let resolveFInit!: () => void;
    const fGate = new Promise<void>((r) => { resolveFInit = r; });

    await initSceneManagersFor('/scenes/A.json');
    registerManager({ name: 'e', dispose: disposeE }); // sync init -> settles immediately
    registerManager({ name: 'f', init: () => fGate }); // keeps the outer sweep suspended

    // Outer sweep: snapshots [e, idA] and [f, idF], then awaits both. 'f' never
    // settles until resolveFInit() below, so this stays suspended for the rest
    // of the test.
    const outerSweep = disposeActiveSceneManagers();

    // Drop 'f' from the registry entirely (its own dispose() runs synchronously
    // — deactivate() never waits on a pending init). The outer sweep's `pending`
    // still holds the ORIGINAL fGate promise object, so it stays suspended.
    unregisterManager('f');

    // A full, non-suspending cycle on the SAME 'e' Entry: by now 'e' has nothing
    // pending (its sync init already settled), and 'f' is gone from the map, so
    // this dispose call finds nothing to await and runs to completion
    // synchronously — disposing 'e' for real (idA still matches) and clearing
    // `active`.
    disposeActiveSceneManagers();
    expect(disposeE).toHaveBeenCalledOnce();

    // Re-activate the SAME Entry object for the incoming scene: a NEW
    // activationId, same identity.
    await initSceneManagersFor('/scenes/B.json');
    expect(getRegisteredManagers().find((s) => s.startsWith('e'))).toContain('active');

    // Let the outer sweep resume: it still holds 'e' at the OLD activationId.
    resolveFInit();
    await outerSweep;

    // The outer sweep must not have torn down the incoming scene's 'e'.
    expect(disposeE).toHaveBeenCalledOnce();
    expect(getRegisteredManagers().find((s) => s.startsWith('e'))).toContain('active');
  });
});
