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
 *  fresh module graph (and a fresh koota counter).
 *
 *  One exception to "no fetch": the "#535 defect 1: a rejecting scene manager
 *  init" case below needs a REAL acquired resource (not just entities) to make
 *  post-swap resource ownership observable via `getResourceStats()`, so it
 *  swaps `global.fetch` in for its own duration only and restores it after. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { trait } from 'koota';
import { completeResponse } from '../stubs/assetResponse';

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

  // #535: unloadAll() aborts an in-flight preload at its HEAD (before any await) but
  // performs five of its own awaits before its tail unconditionally wipes loadedScenes/
  // primaryId/currentBaseScene/currentWorld. A loadScene() that STARTS during one of
  // those five awaits is issued AFTER the head abort already ran (so it isn't cancelled),
  // and — pre-fix — would complete its own swap before unloadAll's tail resumes, with the
  // tail then wiping that completed swap out from under a caller who already received a
  // resolved promise.
  //
  // THE OWNER'S RULING (documented here so the assertion direction below doesn't read as
  // a fix dodging its own repro): teardown is authoritative — UNLOAD WINS. A loadScene()
  // that races an unloadAll() must never win, and must never silently resolve having
  // actually lost. So this test's expected outcome is NOT "A survives" (that would be
  // load-wins, the losing side of the fork this issue decided) — it's "A rejects with an
  // AbortError, and unloadAll's tail leaves nothing loaded." The interleaving below
  // predates that ruling and is unchanged; only the assertions at the bottom were flipped
  // to match it.
  it('#535: a loadScene that starts while unloadAll is in flight rejects — unload wins', async () => {
    const { sceneManager, managers, getCurrentWorld } = await setup();

    // Load O fully first (no manager registered yet, so nothing can hang here).
    await sceneManager.loadScene('/sceneO.json', { preloaded: sceneOf('O') as never });
    // `unloadAll()` below installs a fresh world without destroying this one (a
    // separate, pre-existing property of `unloadAll`) — reclaim it explicitly so
    // this test doesn't permanently burn a slot out of koota's 16-world-per-file
    // cap (see the file docblock: this file is tuned to that budget).
    const worldO = getCurrentWorld();

    // Register a scene manager for O AFTER O is already active: registerManager
    // self-activates synchronously against the currently-active scene, so
    // entry.active/entry.initPromise are set immediately — init() itself won't
    // settle until we resolve `hang` below. This is the gated await: unloadAll's
    // disposeActiveSceneManagers call awaits this in-flight initPromise (see
    // managerRegistry.ts's disposeActiveSceneManagers, which collects
    // `entry.initPromise` into `pending` and awaits it), which is exactly the
    // window a second loadScene can start underneath unloadAll.
    let resolveHang: () => void = () => {};
    const hang = new Promise<void>((resolve) => { resolveHang = resolve; });
    managers.registerManager({ name: 'mgrO', scenes: ['O'], init: () => hang });

    // Kick off unloadAll WITHOUT awaiting it. Its head-abort has nothing to abort
    // (no nextLoad in flight), so it runs straight through disposeActiveGameManagers
    // (no game managers registered, resolves immediately) into
    // disposeActiveSceneManagers, where it parks on mgrO's still-hanging initPromise —
    // but not before its head has already bumped `teardownInFlight`/`teardownGeneration`.
    const pUnload = sceneManager.unloadAll();

    // Let microtasks drain so unloadAll is actually parked inside the gated await,
    // not still running synchronously ahead of us.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Now start loadScene(A) while unloadAll is stuck above (teardownInFlight > 0).
    // Under unload-wins, loadScene checks that counter FIRST, before any work, and
    // rejects immediately with an AbortError — it never gets far enough to swap in A
    // or to touch mgrO's hanging initPromise at all.
    const pA = sceneManager.loadScene('/sceneA.json', { preloaded: sceneOf('A') as never });
    await expect(pA).rejects.toMatchObject({ name: 'AbortError' });

    // Release the hang so unloadAll's own dispose-of-O call can proceed to completion.
    resolveHang();
    await pUnload;

    // THE RULING ASSERTION: unload wins. unloadAll's tail is unconditional and A never
    // got far enough to be at risk of "surviving" it — both are true, and together mean
    // nothing is loaded once both operations have settled.
    expect(sceneManager.getCurrent()).toBeNull();
    expect(sceneManager.getLoadedScenes().size).toBe(0);
    expect(getCurrentWorld()).not.toBeNull();
    worldO.destroy();
  });

  it('#535: a loadScene already in flight when unloadAll starts is superseded and rejects', async () => {
    const { sceneManager, getCurrentWorld } = await setup();

    await sceneManager.loadScene('/sceneO.json', { preloaded: sceneOf('O') as never });
    // See the cleanup comment on the previous test — reclaim the koota world
    // slot `unloadAll()` below leaks.
    const worldO = getCurrentWorld();

    // Hang A mid-flight via a `registerBeforeSwap` hook, awaited at the LAST
    // `isSuperseded` checkpoint before the atomic swap (see the class docblock's
    // step 9/10 boundary) — so this exercises case (a) specifically: a teardown
    // that starts while a load is still PRE-swap, not the post-swap-tail shape
    // #435/#468 already cover via a manager's `init`.
    let resolveHangSwap: () => void = () => {};
    const hangSwap = new Promise<void>((resolve) => { resolveHangSwap = resolve; });
    let hookStarted = false;
    const hook = () => { hookStarted = true; return hangSwap; };
    sceneManager.registerBeforeSwap(hook);

    try {
      const pA = sceneManager.loadScene('/sceneA.json', { preloaded: sceneOf('A') as never });

      // Let A run up to (and park inside) the beforeSwap hook's await — several
      // real awaits precede it (chain resolution, resource collection, entity
      // spawn), so poll for the hook itself firing rather than counting ticks.
      await vi.waitFor(() => { if (!hookStarted) throw new Error('beforeSwap hook has not started yet'); });

      // unloadAll starts while A is still mid-flight, pre-swap (case (a): a
      // teardown starting during a load). Its head bumps `teardownGeneration`
      // past what A captured at its own entry — but A is still `this.nextLoad`
      // at this point (pre-swap), so `unloadAll()`'s head ALSO aborts A's own
      // controller directly. That means the checkpoint A hits below is
      // satisfied by `controller.signal.aborted`, not by the generation
      // comparison — the generation is redundant here (confirmed by mutation:
      // gutting `isSuperseded` to `return controller.signal.aborted;` leaves
      // this test green). The generation is what makes the POST-swap
      // checkpoints live, once `nextLoad` no longer exists to abort THROUGH —
      // see the `#535 defect 1` tests below.
      const pUnload = sceneManager.unloadAll();

      // Release the hook: A resumes, hits the `isSuperseded` checkpoint right
      // after `fireBeforeSwapHooks` (before "10. Atomic swap"), sees its own
      // controller already aborted, and rejects — it never reaches the swap at
      // all.
      resolveHangSwap();
      await expect(pA).rejects.toMatchObject({ name: 'AbortError' });
      await pUnload;

      expect(sceneManager.getCurrent()).toBeNull();
      worldO.destroy();
    } finally {
      sceneManager.unregisterBeforeSwap(hook);
    }
  });

  it('#535: a loadScene issued after unloadAll has fully settled succeeds normally', async () => {
    const { sceneManager, getCurrentWorld } = await setup();

    await sceneManager.loadScene('/sceneO.json', { preloaded: sceneOf('O') as never });
    // See the cleanup comment two tests up — reclaim the koota world slot
    // `unloadAll()` below leaks.
    const worldO = getCurrentWorld();
    await sceneManager.unloadAll();

    // The single most important post-fix case: once a teardown has fully settled
    // (teardownInFlight back at 0, generation stable), a fresh loadScene must not be
    // treated as still racing it — a naive fix that never resets/rechecks the
    // in-flight counter would reject this too.
    await sceneManager.loadScene('/sceneA.json', { preloaded: sceneOf('A') as never });

    expect(sceneManager.getCurrent()?.path).toBe('/sceneA.json');
    expect(getCurrentWorld()).not.toBeNull();
    worldO.destroy();
  });

  it('#535: an unloadAll whose internals throw still leaves the teardown counter at zero', async () => {
    const { sceneManager, managers } = await setup();

    await sceneManager.loadScene('/sceneO.json', { preloaded: sceneOf('O') as never });

    // Force unloadAll to throw partway through one of its five awaits. `dispose()`
    // errors are swallowed by managerRegistry (see `deactivate` there), so that's
    // not a real throw path — but `initSceneManagersFor('')`'s `Promise.all` awaits
    // the RAW init promise (not the swallowed tracked one), and a manager with no
    // `scenes` filter matches scenePath '' too, so it gets re-activated during
    // unloadAll's tail-reset step and its rejecting init propagates out.
    managers.registerManager({
      name: 'mgrThrows',
      init: () => Promise.reject(new Error('boom')),
    });

    await expect(sceneManager.unloadAll()).rejects.toThrow('boom');
    // Done its job — unregister before the next load, or its still-rejecting
    // `init` (no `scenes` filter, matches any path) would fail loadScene(A) too,
    // for reasons unrelated to what this test pins.
    managers.unregisterManager('mgrThrows');

    // Pins the try/finally: the counter must not stick at a nonzero value just
    // because unloadAll's body threw, or every loadScene() after this would reject
    // forever — a worse bug than the race #535 fixes.
    await sceneManager.loadScene('/sceneA.json', { preloaded: sceneOf('A') as never });
    expect(sceneManager.getCurrent()?.path).toBe('/sceneA.json');
  });

  // #535 defect 1: the atomic swap clears `nextLoad`, so a `loadScene()` whose swap has
  // ALREADY committed has nothing left for a racing `unloadAll()`'s head-abort to cancel
  // THROUGH — its dispose/init tail runs on regardless. Pre-fix, a load parked there
  // settled RESOLVED even though `unloadAll()`'s unconditional tail had already wiped
  // `loadedScenes`/`primaryId`/`currentWorld` out from under it. This is the permanent
  // regression test for that window; see `isPostSwapSuperseded` and the class docblock's
  // paragraph on the post-swap tail.
  it('#535 defect 1: a loadScene parked in its post-swap tail rejects when unloadAll wins the race', async () => {
    const { sceneManager, managers, getCurrentWorld } = await setup();

    // Load O fully first (no manager registered yet, so nothing can hang here).
    await sceneManager.loadScene('/sceneO.json', { preloaded: sceneOf('O') as never });

    // Register a scene manager for O AFTER O is already active — self-activates
    // synchronously (same pattern as the #435/#468 tests above), so
    // `disposeActiveSceneManagers` for O has to await its still-in-flight `init`
    // before it can dispose it. This is the controllable window: A's tail parks
    // HERE, right after A's own atomic swap has already committed.
    let resolveHang: () => void = () => {};
    const hang = new Promise<void>((resolve) => { resolveHang = resolve; });
    managers.registerManager({ name: 'mgrO', scenes: ['O'], init: () => hang });

    const namesInCurrentWorld = (): string[] => {
      const names: string[] = [];
      getCurrentWorld().query(EntityAttributes).updateEach(([ea]: [{ name: string }]) => names.push(ea.name));
      return names;
    };

    // Load A (not awaited): its swap commits (primaryId → A, currentWorld → worldA,
    // clearing `nextLoad`), then its tail parks in `disposeActiveSceneManagers` for
    // O's still-hanging manager — `disposeActiveSceneManagers` disposes every
    // ACTIVE scene manager regardless of the `scenePath` it's passed, so mgrO's
    // hang blocks it even though A's own call passes O's (old) path.
    const pA = sceneManager.loadScene('/sceneA.json', { preloaded: sceneOf('A') as never });
    await vi.waitFor(() => { if (!namesInCurrentWorld().includes('A')) throw new Error('A has not swapped in yet'); });
    const worldA = getCurrentWorld();

    // unloadAll starts while A is stuck in its post-swap tail. `nextLoad` is
    // already null (A's own swap cleared it), so unloadAll's head-abort has
    // nothing left to cancel — exactly the window `isPostSwapSuperseded` exists
    // for. unloadAll's own `disposeActiveSceneManagers` call also has to await
    // mgrO's hang (same reason as A's), so both are parked on it together.
    const pUnload = sceneManager.unloadAll();

    // Release the shared hang: both A's own dispose call and unloadAll's resume.
    // Under unload-wins, A must reject — not resolve having actually lost.
    resolveHang();
    await expect(pA).rejects.toMatchObject({ name: 'AbortError' });
    await pUnload;

    expect(sceneManager.getCurrent()).toBeNull();
    expect(sceneManager.getLoadedScenes().size).toBe(0);
    expect(getCurrentWorld()).not.toBeNull();

    // `unloadAll()`'s tail installs a fresh empty world without destroying the
    // one it replaces (a separate, pre-existing property of `unloadAll`, not
    // this fix's concern) — destroy `worldA` explicitly so this test doesn't
    // permanently burn a slot out of koota's 16-world-per-file cap (this file's
    // budget is already tuned to it; see the file docblock).
    worldA.destroy();
  });

  // #535 defect 2 — liveness proof for `teardownGeneration`: `teardownInFlight` alone
  // cannot catch an `unloadAll()` that starts AND FULLY SETTLES while a load is parked
  // in a post-swap await, because the counter is back at zero by the time the load
  // resumes. Only the generation comparison in `isPostSwapSuperseded` can still see
  // that a teardown raced it. Confirmed by mutation (see the session report): gutting
  // `isPostSwapSuperseded` to `return this.teardownInFlight > 0;` turns this test red.
  it('#535 defect 2: an unloadAll that starts and fully settles inside a post-swap await is still caught by the generation', async () => {
    const { sceneManager, managers, getCurrentWorld } = await setup();

    await sceneManager.loadScene('/sceneO.json', { preloaded: sceneOf('O') as never });

    const namesInCurrentWorld = (): string[] => {
      const names: string[] = [];
      getCurrentWorld().query(EntityAttributes).updateEach(([ea]: [{ name: string }]) => names.push(ea.name));
      return names;
    };

    // A scene-scoped manager for A, registered BEFORE A loads so it self-activates
    // as part of A's own `initSceneManagersFor` call — the LAST post-swap checkpoint.
    let resolveHang: () => void = () => {};
    const hang = new Promise<void>((resolve) => { resolveHang = resolve; });
    let initStarted = false;
    managers.registerManager({
      name: 'mgrA', scenes: ['A'],
      init: () => { initStarted = true; return hang; },
    });

    const pA = sceneManager.loadScene('/sceneA.json', { preloaded: sceneOf('A') as never });
    await vi.waitFor(() => { if (!namesInCurrentWorld().includes('A')) throw new Error('A has not swapped in yet'); });
    const worldA = getCurrentWorld();
    await vi.waitFor(() => { if (!initStarted) throw new Error('mgrA init has not started yet'); });

    // Unregister mgrA WITHOUT resolving its hang. A's own `initSceneManagersFor`
    // call already captured the raw `init()` promise directly (`activate()`
    // returns it unwrapped, before any await) — unregistering doesn't touch that
    // closure, so A stays parked. But the registry no longer considers mgrA
    // active, so `unloadAll()`'s own `disposeActiveSceneManagers` — which
    // disposes every ACTIVE manager, not filtered by path — has nothing left to
    // await and can run straight through to completion.
    managers.unregisterManager('mgrA');

    // unloadAll starts AND FULLY SETTLES here: `teardownInFlight` is back at 0 by
    // the time A resumes below. Only `teardownGeneration` still differs from what
    // A captured at its own entry — this is the case the counter alone is blind
    // to.
    await sceneManager.unloadAll();

    resolveHang();
    await expect(pA).rejects.toMatchObject({ name: 'AbortError' });

    expect(sceneManager.getCurrent()).toBeNull();
    expect(sceneManager.getLoadedScenes().size).toBe(0);

    // See the previous test's cleanup comment — `unloadAll()` never destroys the
    // world it replaces, so this test must reclaim `worldA`'s koota slot itself.
    worldA.destroy();
  });

  // #535 defect 1, real-review finding: the `if (!swapped)` guard in `loadScene`'s
  // `catch` block (SceneManager.ts) had ZERO coverage. This pins the live production
  // path it protects: `activate()` in managerRegistry.ts returns the RAW init
  // promise, so a scene-scoped manager whose `init()` rejects fails
  // `initSceneManagersFor` AFTER the atomic swap has already committed. Without the
  // guard, the catch block's unconditional release loop would run
  // `releaseAllForScene` on the ids of the scene that is now CURRENT and on
  // screen — dropping its mesh templates/materials/textures while `loadedScenes`
  // still lists it. Needs a real acquired resource (not just entities) to make
  // that observable, so this test swaps in a scoped `global.fetch` for one
  // material fetch only, and restores it in `finally`.
  it('#535 defect 1: a rejecting scene manager init does not strand the swapped-in scene\'s resources', async () => {
    const { sceneManager, managers, getCurrentWorld } = await setup();
    const { getResourceStats } = await import('../../src/runtime/loaders/meshTemplateCache');
    const manifest = await import('../../src/runtime/loaders/assetManifest');

    // Asset refs are GUID-only (never a literal path) — register the material's
    // GUID→path mapping on this fresh module graph, same pattern as
    // SceneManager.test.ts's MAT_GUIDS.
    const MAT_A_GUID = '30000000-0000-4000-8000-000000000001';
    const MAT_A_PATH = '/materials/mA.mat.json';
    manifest.clearManifest();
    manifest.registerAsset(MAT_A_GUID, MAT_A_PATH, 'material');

    const realFetch = global.fetch;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(MAT_A_PATH)) {
        return completeResponse({ ok: true, json: async () => ({ color: 0xff0000 }) });
      }
      return completeResponse({ ok: false, status: 404, json: async () => ({}) });
    }) as typeof fetch;

    try {
      await sceneManager.loadScene('/sceneO.json', { preloaded: sceneOf('O') as never });
      const worldO = getCurrentWorld();

      const sceneA = {
        ...sceneOf('A'),
        resources: [{ type: 'material', path: MAT_A_GUID }],
      };

      // Registered before A loads, scoped to 'A' — self-activates as part of A's
      // own `initSceneManagersFor` call, AFTER A's atomic swap has already
      // committed (`swapped = true`). Its rejecting init is what the `catch`
      // block sees.
      managers.registerManager({
        name: 'mgrA',
        scenes: ['A'],
        init: () => Promise.reject(new Error('boom')),
      });

      await expect(
        sceneManager.loadScene('/sceneA.json', { preloaded: sceneA as never }),
      ).rejects.toThrow('boom');

      // A's swap already committed — its material must still be owned. Pre-fix,
      // the guard-less release loop dropped it out from under the scene that is
      // now live.
      expect(getResourceStats().materials[MAT_A_PATH]).toBe(1);
      expect(sceneManager.getCurrent()?.path).toBe('/sceneA.json');
      expect(getCurrentWorld()).not.toBe(worldO);
      // Not manually destroyed: this is an ordinary successful swap (unlike the
      // hang-based #535 tests above), so `loadScene`'s own tail already destroyed
      // `worldO` synchronously in step 8, well before `mgrA`'s rejection below —
      // no in-flight manager init existed yet to defer it behind.
    } finally {
      global.fetch = realFetch;
      managers.unregisterManager('mgrA');
    }
  });
});
