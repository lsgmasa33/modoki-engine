/** SceneManager ↔ Manager lifecycle integration.
 *
 *  Drives the real `sceneManager.loadScene` (via `preloaded` data, so no fetch /
 *  resource worlds) and asserts Managers init/dispose through the swap — in
 *  particular that `dispose` receives the OLD world it was operating against (not
 *  the freshly-promoted one), that scene-scoped Managers re-init each swap, and
 *  that game-scoped Managers survive an in-game swap but dispose on a game change.
 *
 *  Lives in its own file because koota caps live worlds at 16 and
 *  SceneManager.test.ts is already tuned to that budget; a separate file gets a
 *  fresh module graph (and a fresh koota counter). */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { trait } from 'koota';

const Transform = trait({ x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 });
const EntityAttributes = trait({ name: '', isActive: true, sortOrder: 0, parentId: 0, layer: '' as '' | '3d' | '2d' | 'ui', guid: '' });

vi.mock('../../src/runtime/core/ecs/traitRegistry', () => {
  const traits = [
    { name: 'Transform', trait: Transform, category: 'component', fields: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, rx: { type: 'number' }, ry: { type: 'number' }, rz: { type: 'number' }, sx: { type: 'number' }, sy: { type: 'number' }, sz: { type: 'number' } } },
    { name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: { name: { type: 'string' }, isActive: { type: 'boolean' }, sortOrder: { type: 'number' }, parentId: { type: 'number', entityId: { onMissing: 'root' } }, layer: { type: 'string' }, guid: { type: 'string' } } },
    { name: 'Persistent', trait: null as unknown, category: 'tag', fields: {} }, // patched in beforeEach
  ];
  return {
    getAllTraits: () => traits,
    getTraitByName: (name: string) => traits.find((t) => t.name === name),
  };
});

const sceneOf = (name: string) => ({
  version: 8,
  resources: [],
  entities: [{ id: 1, traits: { Transform: { x: 1 }, EntityAttributes: { name, parentId: 0 } } }],
});

beforeEach(async () => {
  vi.resetModules();
  const { Persistent } = await import('../../src/runtime/traits/Persistent');
  const { getAllTraits } = await import('../../src/runtime/core/ecs/traitRegistry');
  const meta = getAllTraits().find((m: { name: string }) => m.name === 'Persistent');
  if (meta) (meta as { trait: unknown }).trait = Persistent;
});

async function setup() {
  const scene = await import('../../src/runtime/scene/SceneManager');
  scene.sceneManager.resetForTesting();
  const managers = await import('../../src/runtime/managers/managerRegistry');
  managers.__resetManagersForTesting();
  const world = await import('../../src/runtime/core/ecs/world');
  return { sceneManager: scene.sceneManager, managers, getCurrentWorld: world.getCurrentWorld };
}

describe('SceneManager ↔ scene-scoped manager lifecycle', () => {
  it('inits on load, then disposes on swap against the OLD world before re-init', async () => {
    const { sceneManager, managers, getCurrentWorld } = await setup();

    const order: string[] = [];
    const initWorlds: unknown[] = [];
    const disposeWorlds: unknown[] = [];
    managers.registerManager({
      name: 'lifecycle',
      scenes: ['scene'], // matches both paths below
      init: (ctx) => { order.push('init'); initWorlds.push(ctx.world); },
      dispose: (ctx) => { order.push('dispose'); disposeWorlds.push(ctx?.world); },
    });

    await sceneManager.loadScene('/sceneA.json', { preloaded: sceneOf('A') as never });
    expect(order).toEqual(['init']);
    const worldA = getCurrentWorld();
    expect(initWorlds[0]).toBe(worldA);

    await sceneManager.loadScene('/sceneB.json', { preloaded: sceneOf('B') as never });
    const worldB = getCurrentWorld();

    // dispose precedes re-init; dispose saw world A (the one it ran against),
    // NOT the freshly-promoted world B. This pins the dispose-ordering fix.
    expect(order).toEqual(['init', 'dispose', 'init']);
    expect(disposeWorlds[0]).toBe(worldA);
    expect(disposeWorlds[0]).not.toBe(worldB);
    expect(initWorlds[1]).toBe(worldB);
  });

  it('does not init a scene-scoped manager whose filter fails the loaded scene', async () => {
    const { sceneManager, managers } = await setup();
    const init = vi.fn();
    managers.registerManager({ name: 'onlyWarp', scenes: ['Warp'], init });

    await sceneManager.loadScene('/sceneA.json', { preloaded: sceneOf('A') as never });
    expect(init).not.toHaveBeenCalled();
  });

  it('activates a game-scoped manager when its game loads, and it survives an in-game swap', async () => {
    const { sceneManager, managers } = await setup();
    const init = vi.fn();
    const dispose = vi.fn();
    managers.registerManager({ name: 'spaceCtrl', scope: 'game', games: ['space'], init, dispose });

    // Game becomes active (explicit gameId on the switch) → init fires.
    await sceneManager.loadScene('/Station.json', { preloaded: sceneOf('Station') as never, gameId: 'space' });
    expect(init).toHaveBeenCalledOnce();

    // In-game scene swap (no gameId → keep the active game) → manager persists,
    // not re-inited and not disposed.
    await sceneManager.loadScene('/Warp.json', { preloaded: sceneOf('Warp') as never });
    expect(dispose).not.toHaveBeenCalled();
    expect(init).toHaveBeenCalledOnce();
  });

  it('disposes a game-scoped manager (against the OLD world) when the active game changes', async () => {
    const { sceneManager, managers, getCurrentWorld } = await setup();
    const disposeWorlds: unknown[] = [];
    managers.registerManager({
      name: 'spaceCtrl', scope: 'game', games: ['space'],
      dispose: (ctx) => { disposeWorlds.push(ctx?.world); },
    });

    await sceneManager.loadScene('/Station.json', { preloaded: sceneOf('Station') as never, gameId: 'space' });
    const worldSpace = getCurrentWorld();

    // Switch to a different game → dispose fires once, against the OLD (space)
    // world it was running on, not the freshly-promoted one.
    await sceneManager.loadScene('/chess.json', { preloaded: sceneOf('chess') as never, gameId: 'chess' });
    const worldChess = getCurrentWorld();

    expect(disposeWorlds).toHaveLength(1);
    expect(disposeWorlds[0]).toBe(worldSpace);
    expect(disposeWorlds[0]).not.toBe(worldChess);
  });

  it('does not activate a game-scoped manager whose games filter fails the active game', async () => {
    const { sceneManager, managers } = await setup();
    const init = vi.fn();
    managers.registerManager({ name: 'onlySpace', scope: 'game', games: ['space'], init });

    await sceneManager.loadScene('/chess.json', { preloaded: sceneOf('chess') as never, gameId: 'chess' });
    expect(init).not.toHaveBeenCalled();
  });

  // #435: an overlapping loadScene during another load's post-swap tail must not let the
  // superseded (stale) load rewrite the module-global active-scene state or spawn its
  // manager into the world the NEWER load already promoted.
  it('#435: a stale post-swap tail does not activate its scene-manager against a newer world', async () => {
    const { sceneManager, managers, getCurrentWorld } = await setup();

    // Load O fully first (no manager registered yet, so nothing can hang here).
    await sceneManager.loadScene('/sceneO.json', { preloaded: sceneOf('O') as never });

    // Register a scene manager for O AFTER O is already active: registerManager
    // self-activates synchronously against the currently-active scene (see
    // managerRegistry.ts's registerManager), so entry.active/entry.initPromise are
    // set immediately — init() itself won't settle until we resolve `hang` below.
    // This is the "controllable window": disposeActiveSceneManagers awaits this
    // in-flight initPromise before it can dispose O's manager, and that await is
    // exactly where a second loadScene can start and finish underneath the first.
    let resolveHang: () => void = () => {};
    const hang = new Promise<void>((resolve) => { resolveHang = resolve; });
    managers.registerManager({ name: 'mgrO', scenes: ['O'], init: () => hang });

    const mgrAInit = vi.fn();
    managers.registerManager({ name: 'mgrA', scenes: ['A'], init: mgrAInit });

    const mgrBCtx: { world?: unknown; scenePath?: string } = {};
    managers.registerManager({
      name: 'mgrB', scenes: ['B'],
      init: (ctx) => { mgrBCtx.world = ctx.world; mgrBCtx.scenePath = ctx.scenePath; },
    });

    const namesInCurrentWorld = (): string[] => {
      const names: string[] = [];
      getCurrentWorld().query(EntityAttributes).updateEach(([ea]: [{ name: string }]) => names.push(ea.name));
      return names;
    };

    // Load A (not awaited): its swap runs through a couple of internal awaits
    // (chain resolution etc.) before reaching the atomic swap (primaryId → A,
    // currentWorld → worldA), then it hits `disposeActiveSceneManagers` for O's
    // still-hanging manager and yields BEFORE reaching its own guarded
    // fireSceneCallbacks/init block (this.primaryId === id check). `this.nextLoad`
    // is only cleared once that swap commits — so B must not be issued before
    // then, or step 1 of loadScene(B) would abort A's still-in-flight call
    // outright instead of overlapping it.
    const pA = sceneManager.loadScene('/sceneA.json', { preloaded: sceneOf('A') as never });
    await vi.waitFor(() => { if (!namesInCurrentWorld().includes('A')) throw new Error('A has not swapped in yet'); });

    // Load B (not awaited) while A's tail is stuck above. B's own swap and dispose
    // call both run synchronously up to the SAME hang (mgrO is still active from
    // A's perspective too), so B's swap (primaryId → B, currentWorld → worldB)
    // commits before either tail resumes.
    const pB = sceneManager.loadScene('/sceneB.json', { preloaded: sceneOf('B') as never });

    // B's own swap (unrelated to the hang — it reaches disposeActiveSceneManagers
    // only AFTER its atomic swap commits) needs its own handful of internal
    // awaits to run first. Wait for it to actually commit BEFORE releasing the
    // hang, so the guard check A performs once it resumes is guaranteed to see B
    // as primary — otherwise A (needing fewer remaining ticks to resume than B
    // needs to finish its own swap) can race ahead and reach its guard check
    // while primaryId is still A's, defeating the whole point of this test.
    await vi.waitFor(() => { if (!namesInCurrentWorld().includes('B')) throw new Error('B has not swapped in yet'); });

    // Release the shared hang: both A's and B's disposeActiveSceneManagers calls
    // unblock. A's tail then re-checks `this.primaryId === id` for A and finds B
    // is now primary, so it must skip fireSceneCallbacks/initSceneManagersFor for
    // A entirely — mgrA.init must never run, and B's manager must be the one that
    // sees the live world.
    resolveHang();
    await Promise.all([pA, pB]);

    expect(mgrAInit).not.toHaveBeenCalled();
    expect(mgrBCtx.scenePath).toBe('/sceneB.json');
    expect(mgrBCtx.world).toBe(getCurrentWorld());

    // The live world holds only B's entity — a stale A tail that ran
    // initSceneManagersFor/fireSceneCallbacks against the promoted world would be
    // the only way this observably drifted (dynamic entity spawning fires through
    // those same calls, per fireSceneCallbacks' own contract).
    expect(namesInCurrentWorld()).toEqual(['B']);
  });

  // #468: a game-scoped manager's async init, launched by a load that is later
  // superseded, must not write into the world that same load's OWN destroy
  // step already tore down. The superseding load sees `gameChanged === false`
  // (the superseded load already set `activeGameId`) so it correctly skips
  // both dispose and re-init for game managers — nothing re-activates or
  // awaits the still-hanging init from there. The fix defers `oldWorld.destroy()`
  // behind any in-flight manager init instead of racing it.
  it('#468: a game manager\'s async init resumes before its world is destroyed', async () => {
    const { sceneManager, managers, getCurrentWorld } = await setup();

    // Load O fully first (no game, nothing hangs here).
    await sceneManager.loadScene('/sceneO.json', { preloaded: sceneOf('O') as never });

    const namesInCurrentWorld = (): string[] => {
      const names: string[] = [];
      getCurrentWorld().query(EntityAttributes).updateEach(([ea]: [{ name: string }]) => names.push(ea.name));
      return names;
    };

    let resolveHang: () => void = () => {};
    const hang = new Promise<void>((resolve) => { resolveHang = resolve; });
    let capturedWorld: unknown;
    let initStarted = false;
    let destroyedBeforeResume = false;
    const spy: { destroy?: ReturnType<typeof vi.spyOn> } = {};
    managers.registerManager({
      name: 'gameMgr', scope: 'game', games: ['G'],
      init: async (ctx) => {
        capturedWorld = ctx.world;
        initStarted = true; // signals A's tail has reached initGameManagersFor
        await hang;
        // If the world was already destroyed by the time we resume, the
        // pre-#468 code let this happen; the fix must keep it alive.
        destroyedBeforeResume = (spy.destroy?.mock.calls.length ?? 0) > 0;
      },
    });

    // Load A (not awaited): explicit gameId → gameChanged is true, so A's tail
    // activates gameMgr against its own (freshly-promoted) world once it swaps.
    const pA = sceneManager.loadScene('/sceneA.json', { preloaded: sceneOf('A') as never, gameId: 'G' });
    await vi.waitFor(() => { if (!namesInCurrentWorld().includes('A')) throw new Error('A has not swapped in yet'); });
    await vi.waitFor(() => { if (!initStarted) throw new Error('gameMgr init has not started yet'); });

    const worldA = getCurrentWorld();
    spy.destroy = vi.spyOn(worldA, 'destroy');

    // Load B (not awaited), same gameId → B computes `gameChanged === false`
    // (A already set activeGameId to 'G'), so B skips both
    // disposeActiveGameManagers and initGameManagersFor for gameMgr — nothing
    // re-activates or awaits its still-hanging init. B's own oldWorld is worldA,
    // so this is exactly the #468 race: B's destroy step must defer behind
    // gameMgr's in-flight init instead of destroying worldA out from under it.
    const pB = sceneManager.loadScene('/sceneB.json', { preloaded: sceneOf('B') as never, gameId: 'G' });
    await vi.waitFor(() => { if (!namesInCurrentWorld().includes('B')) throw new Error('B has not swapped in yet'); });

    resolveHang();
    await Promise.all([pA, pB]);
    // B's deferred `oldWorld.destroy()` is fire-and-forget (not awaited by
    // loadScene, so as not to block B on a slow init) — flush until it runs.
    await vi.waitFor(() => { if (spy.destroy!.mock.calls.length === 0) throw new Error('destroy has not run yet'); });

    // The regression: the world was still alive when gameMgr's init resumed.
    expect(destroyedBeforeResume).toBe(false);
    // gameMgr's ctx.world is the load-A world it was activated against, not
    // whatever the newer load promoted.
    expect(capturedWorld).toBe(worldA);
    // The koota worldId slot is still freed — no world leak.
    expect(spy.destroy).toHaveBeenCalled();
  });

  // Regression for the review of the #468 fix above: `activate()` clears `entry.initPromise`
  // in a `.finally`, so an init that NEVER settles (a genuine hang, distinct from the resolved
  // `hang` promise above) leaves `pendingManagerInits()` non-null FOREVER — every LATER swap's
  // `oldWorld.destroy()` would then chain behind it and never run, leaking a koota world slot
  // (capped at 16) on every subsequent swap. `WORLD_DESTROY_DEFER_MAX_MS` bounds the defer:
  // past it, destroy runs anyway and a warning names the situation.
  it('bounds the destroy-defer: a manager init that never settles does not block later world destroys forever', async () => {
    vi.useFakeTimers();
    try {
      const { sceneManager, managers, getCurrentWorld } = await setup();
      const { WORLD_DESTROY_DEFER_MAX_MS } = await import('../../src/runtime/scene/SceneManager');

      const namesInCurrentWorld = (): string[] => {
        const names: string[] = [];
        getCurrentWorld().query(EntityAttributes).updateEach(([ea]: [{ name: string }]) => names.push(ea.name));
        return names;
      };

      // `vi.waitFor`'s default polling is timer-driven, which deadlocks once fake timers are
      // active (nothing advances its own poll timer) — flush microtasks directly instead. Every
      // condition here (the swap, `initStarted`) is reached via a chain of plain `await`s with
      // no real timer of its own, so spinning the microtask queue is sufficient.
      async function flushUntil(pred: () => boolean, maxTicks = 500): Promise<void> {
        for (let i = 0; i < maxTicks && !pred(); i++) await Promise.resolve();
        if (!pred()) throw new Error('condition not met after flushing microtasks');
      }

      let initStarted = false;
      const spy: { destroy?: ReturnType<typeof vi.spyOn> } = {};
      managers.registerManager({
        name: 'hungMgr', scope: 'game', games: ['G'],
        init: () => {
          initStarted = true;
          return new Promise<void>(() => {}); // never settles — a genuine hang, not a rejection
        },
      });

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Load A: gameChanged → activates hungMgr against world A, whose init hangs forever. NOT
      // awaited — `initGameManagersFor` awaits the manager's raw init promise directly (not the
      // swallowing wrapper), so `pA` itself would never settle.
      const pA = sceneManager.loadScene('/sceneA.json', { preloaded: sceneOf('A') as never, gameId: 'G' });
      pA.catch(() => {});
      await flushUntil(() => namesInCurrentWorld().includes('A') && initStarted);

      const worldA = getCurrentWorld();
      spy.destroy = vi.spyOn(worldA, 'destroy');

      // Load B, same gameId → gameChanged is false (A already set activeGameId), so B skips
      // re-activating/awaiting hungMgr — its still-hanging init just sits there, exactly the
      // #468 shape, except this init never resumes on its own. B itself is NOT gated on
      // hungMgr (it's untouched this swap), so its own promise settles normally.
      const pB = sceneManager.loadScene('/sceneB.json', { preloaded: sceneOf('B') as never, gameId: 'G' });
      await pB;
      expect(namesInCurrentWorld()).toContain('B');

      // Not yet destroyed — still deferred behind the hung init.
      expect(spy.destroy).not.toHaveBeenCalled();

      // Advance past the bound; the timeout side of the race should win and destroy anyway.
      await vi.advanceTimersByTimeAsync(WORLD_DESTROY_DEFER_MAX_MS + 1);

      expect(spy.destroy).toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(String(WORLD_DESTROY_DEFER_MAX_MS)));

      warn.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});
