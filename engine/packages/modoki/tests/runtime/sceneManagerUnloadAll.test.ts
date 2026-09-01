/** SceneManager.unloadAll() teardown + preloaded-data aliasing.
 *
 *  F1 — unloadAll() must dispose the active scene/game managers (like a normal
 *  swap does) and reset the manager registry's active scope state. Before the
 *  fix it released resources + installed an empty world but skipped manager
 *  dispose entirely, leaking subscriptions/owned-actions and leaving a stale
 *  activeGameId so the NEXT loadScene mis-computes `gameChanged`.
 *
 *  F3 — loadScene() must treat `opts.preloaded` as caller-owned + read-only; it
 *  shallow-clones before rewriting `data.resources` / `data.version`, so a caller
 *  that holds onto the parsed object (dev hot-reload / agent validate-then-load)
 *  doesn't get it silently mutated.
 *
 *  Mirrors sceneManagerLifecycle.test.ts: drives the real sceneManager.loadScene
 *  via `preloaded` (no fetch / resource worlds), own module graph + fresh koota
 *  counter (koota caps live worlds at 16). */

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
  version: 8, // current SCENE_FORMAT_VERSION → no in-place migration runs
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

describe('SceneManager.unloadAll — F1 manager dispose + scope reset', () => {
  it('disposes active scene + game managers and clears active scopes', async () => {
    const { sceneManager, managers, getCurrentWorld } = await setup();

    const sceneDispose = vi.fn();
    const gameDispose = vi.fn();
    managers.registerManager({
      name: 'sceneMgr', scenes: ['scene'], dispose: sceneDispose,
    });
    managers.registerManager({
      name: 'gameMgr', scope: 'game', games: ['space'], dispose: gameDispose,
    });

    // Load a scene in game 'space' → both managers activate.
    await sceneManager.loadScene('/sceneA.json', { preloaded: sceneOf('A') as never, gameId: 'space' });
    const worldA = getCurrentWorld();
    expect(managers.getActiveGameId()).toBe('space');

    await sceneManager.unloadAll();

    // F1: both active managers' dispose() ran (was skipped entirely before).
    expect(sceneDispose).toHaveBeenCalledTimes(1);
    expect(gameDispose).toHaveBeenCalledTimes(1);
    // Disposed against the world they were running on, not the fresh empty one.
    expect((sceneDispose.mock.calls[0][0] as { world: unknown }).world).toBe(worldA);
    expect((gameDispose.mock.calls[0][0] as { world: unknown }).world).toBe(worldA);

    // Active scope state reset: activeGameId is null again.
    expect(managers.getActiveGameId()).toBeNull();
  });

  it('after unloadAll, a fresh load re-computes gameChanged correctly (no stale activeGameId)', async () => {
    const { sceneManager, managers } = await setup();

    const init = vi.fn();
    managers.registerManager({ name: 'spaceMgr', scope: 'game', games: ['space'], init });

    await sceneManager.loadScene('/sceneA.json', { preloaded: sceneOf('A') as never, gameId: 'space' });
    expect(init).toHaveBeenCalledTimes(1);

    await sceneManager.unloadAll();
    expect(managers.getActiveGameId()).toBeNull();

    // Re-loading 'space' AGAIN must re-init the game manager. If unloadAll had
    // left activeGameId='space' stale, gameChanged would be false and init would
    // NOT fire — the leak this guards against.
    await sceneManager.loadScene('/sceneA.json', { preloaded: sceneOf('A') as never, gameId: 'space' });
    expect(init).toHaveBeenCalledTimes(2);
  });

  it('leaves all managers inactive (no spurious re-activation of a no-filter scene manager)', async () => {
    const { sceneManager, managers } = await setup();

    const init = vi.fn();
    const dispose = vi.fn();
    // No `scenes` filter → matches any path, including the '' used during reset.
    managers.registerManager({ name: 'anyScene', init, dispose });

    await sceneManager.loadScene('/sceneA.json', { preloaded: sceneOf('A') as never });
    expect(init).toHaveBeenCalledTimes(1);

    await sceneManager.unloadAll();

    // Net: activated once on load, disposed during unloadAll. The reset routine
    // may momentarily re-activate a no-filter manager against '', but unloadAll
    // disposes it again, so it ends INACTIVE — init/dispose counts stay balanced
    // and equal.
    expect(dispose.mock.calls.length).toBe(init.mock.calls.length);

    // And a subsequent load re-activates it cleanly (proving it was left inactive).
    await sceneManager.loadScene('/sceneB.json', { preloaded: sceneOf('B') as never });
    expect(init).toHaveBeenCalledTimes(dispose.mock.calls.length + 1);
  });
});

describe('SceneManager.loadScene — F3 preloaded data is not mutated', () => {
  it('does not rewrite caller-owned preloaded.resources / .version in place', async () => {
    const { sceneManager } = await setup();

    const preloaded = sceneOf('A') as never as {
      version: number;
      resources: unknown[];
      entities: unknown[];
    };
    const originalResources = preloaded.resources;
    const originalVersion = preloaded.version;

    await sceneManager.loadScene('/sceneA.json', { preloaded: preloaded as never });

    // F3: loadScene shallow-clones before mutating, so the caller's object is
    // untouched. Before the fix, data.resources was reassigned to the full
    // transitive ref walk and data.version bumped — both observable here.
    expect(preloaded.resources).toBe(originalResources);
    expect(preloaded.resources).toEqual([]); // still the empty array we passed
    expect(preloaded.version).toBe(originalVersion);
    expect(preloaded.version).toBe(8);
  });

  it('reusing the same preloaded object across two loads sees identical input both times', async () => {
    const { sceneManager } = await setup();

    const preloaded = sceneOf('A') as never as { version: number; resources: unknown[] };

    await sceneManager.loadScene('/sceneA.json', { preloaded: preloaded as never });
    const afterFirst = { version: preloaded.version, resources: preloaded.resources };

    await sceneManager.loadScene('/sceneA.json', { preloaded: preloaded as never });

    // Second load must see the same untouched input the first one saw — proving
    // no aliasing rewrite leaked between calls.
    expect(preloaded.version).toBe(afterFirst.version);
    expect(preloaded.resources).toBe(afterFirst.resources);
    expect(preloaded.resources).toEqual([]);
  });
});

// #542: the post-swap tail's outer guard (SceneManager.ts, "if (this.primaryId
// === id)") gates re-activation on `primaryId` alone. `unloadAll()` only nulls
// `primaryId` in its OWN tail, after five awaits — so a load whose tail is
// still parked mid-flight when `unloadAll()` starts can pass that guard and
// call `initSceneManagersFor(path)`, which writes `activeScenePath` at ITS
// head SYNCHRONOUSLY (managerRegistry.ts). If that write lands after
// `unloadAll`'s own `initSceneManagersFor('')` write, `activeScenePath` is left
// holding the torn-down scene's path even though the load itself correctly
// rejects (postSwapSuperseded still throws). See docs/scene-loading.md for the
// verdict.
describe('SceneManager #542 — activeScenePath after unloadAll races a post-swap tail', () => {
  it('does not leave activeScenePath stuck on a torn-down scene when unloadAll interleaves with a game-changing load\'s post-swap tail', async () => {
    const { sceneManager, managers, getCurrentWorld } = await setup();

    const namesInCurrentWorld = (): string[] => {
      const names: string[] = [];
      getCurrentWorld().query(EntityAttributes).updateEach(([ea]: [{ name: string }]) => names.push(ea.name));
      return names;
    };

    // Establish scene O in game 'space'.
    await sceneManager.loadScene('/sceneO.json', { preloaded: sceneOf('O') as never, gameId: 'space' });

    // M_wild: no `scenes` filter, so it matches ANY path — including ''.
    // Registered NOW, while O is already active, so `registerManager`'s
    // scene-scope branch self-activates it immediately (call #1, resolved
    // synchronously — see below). That first activation is disposed a moment
    // later by loadScene(A)'s (or unloadAll's — order is immaterial, see the
    // comment further down) own `disposeActiveSceneManagers` call, which
    // sweeps every ACTIVE scope-'scene' manager unconditionally. So by the
    // time `unloadAll` reaches its OWN reset step, M_wild is genuinely
    // inactive — exactly what lets THAT step's `initSceneManagersFor('')`
    // reactivate it (call #2, this time returning the real controllable hang)
    // and park there, right after writing activeScenePath = ''.
    let wildCalls = 0;
    let resolveWild: () => void = () => {};
    let wildInitStarted = false;
    const hangWild = new Promise<void>((resolve) => { resolveWild = resolve; });
    managers.registerManager({
      name: 'M_wild',
      init: () => {
        wildCalls++;
        if (wildCalls === 1) return undefined; // matches O at registration — resolves instantly, no gate
        wildInitStarted = true;
        return hangWild;
      },
    });

    // M_scene: scope 'scene', filter matches any path containing "scene" — both
    // '/sceneO.json' and the loading '/sceneA.json' — but NOT '' (the empty
    // string unloadAll resets to). Registered while O is active, so it
    // self-activates immediately; its init hangs until released, gating BOTH
    // loadScene(A)'s and unloadAll's first `disposeActiveSceneManagers` call
    // (that call disposes every ACTIVE scene manager, not filtered by the
    // scenePath it's passed).
    let resolveScene: () => void = () => {};
    const hangScene = new Promise<void>((resolve) => { resolveScene = resolve; });
    managers.registerManager({ name: 'M_scene', scenes: ['scene'], init: () => hangScene });

    // M_game: scope 'game', belongs to the NEW game only. Still inactive right
    // now (activeGameId is 'space') — it activates only once the load below
    // changes games and calls initGameManagersFor('chess', ...). This is the
    // asymmetric extra hop that keeps the load parked behind the teardown.
    let resolveGame: () => void = () => {};
    let gameInitStarted = false;
    const hangGame = new Promise<void>((resolve) => { resolveGame = resolve; });
    managers.registerManager({
      name: 'M_game', scope: 'game', games: ['chess'],
      init: () => { gameInitStarted = true; return hangGame; },
    });

    // Start loadScene(A) in a DIFFERENT game (gameChanged === true). Not
    // awaited: its swap commits (primaryId -> A, currentWorld -> worldA,
    // clearing `nextLoad`), then its tail parks in `disposeActiveSceneManagers`
    // on M_scene's still-hanging init.
    const pA = sceneManager.loadScene('/sceneA.json', { preloaded: sceneOf('A') as never, gameId: 'chess' });
    // Suppress the "unhandled rejection" warning for the window between A
    // rejecting (which can happen as soon as `resolveScene()` below, on the
    // fixed code) and the `await expect(pA).rejects...` further down that
    // actually asserts on it.
    pA.catch(() => {});
    await vi.waitFor(() => { if (!namesInCurrentWorld().includes('A')) throw new Error('A has not swapped in yet'); });
    const worldA = getCurrentWorld();

    // unloadAll starts while A is stuck in its post-swap tail. `nextLoad` is
    // already null (A's own swap cleared it), so unloadAll's head-abort has
    // nothing to cancel. Its own disposeActiveGameManagers call resolves
    // immediately (M_game is not active yet), so it reaches its own
    // disposeActiveSceneManagers call and parks on the SAME hangScene promise.
    const pUnload = sceneManager.unloadAll();

    // Release the shared gate — both A's own dispose call and unloadAll's
    // resume, in whichever order the microtask queue picks. On the FIXED code
    // A's outer guard already re-checks `postSwapSuperseded` here (it is
    // already true — `unloadAll`'s head bumped `teardownInFlight` before this
    // resolve), so A skips straight to its final throw and never touches
    // M_game at all; `gameInitStarted` then simply never flips. Everything
    // below is written to hold up regardless of which of those two things
    // happens, which is why it waits on `wildInitStarted` (driven solely by
    // `unloadAll`'s OWN chain, unaffected by the fix) rather than on
    // `gameInitStarted`.
    resolveScene();

    // unloadAll's own tail is untouched by this fix either way: it proceeds
    // through `initGameManagersFor(null,'')` (early-returns on null) into
    // `initSceneManagersFor('')`, which writes activeScenePath = '' at ITS
    // head and then activates M_wild (2nd call — the real, controllable hang),
    // parking there.
    await vi.waitFor(() => { if (!wildInitStarted) throw new Error('M_wild init has not started yet'); });

    // unloadAll has not reached its own tail yet (it's parked on M_wild), so
    // `this.primaryId` still names A. On the OLD code A is genuinely parked on
    // M_game's hang at this point — releasing it now lets A's tail proceed to
    // `initSceneManagersFor(path)`, which writes activeScenePath = path at ITS
    // head. THE DEFECT: that write lands strictly after unloadAll's '' write
    // above, which we've just confirmed already happened. On the FIXED code
    // A rejected already and never registered M_game's init — resolving an
    // unused promise here is a harmless no-op.
    resolveGame();
    await expect(pA).rejects.toMatchObject({ name: 'AbortError' });
    // Documents which of the two real interleavings actually ran: unfixed code
    // reaches M_game (this is true); the fix's outer-guard short-circuit means
    // it never does (this stays false). Either way A rejects — see above.
    void gameInitStarted;

    // Now let unloadAll finish its own tail.
    resolveWild();
    await pUnload;

    expect(sceneManager.getCurrent()).toBeNull();
    expect(sceneManager.getLoadedScenes().size).toBe(0);

    // ASSERT ON THE HARM, not a private field: managerRegistry exposes no
    // getActiveScenePath(). Register a NEW scene-scoped manager whose filter
    // matches the torn-down scene's path. If activeScenePath is still stuck on
    // '/sceneA.json' (the defect), registerManager's self-activation branch
    // fires against it even though that scene is gone and its world destroyed.
    // With the fix (or if this never reproduces), activeScenePath is '' and
    // this manager stays inactive.
    const probeInit = vi.fn();
    managers.registerManager({ name: 'probeA', scenes: ['sceneA'], init: probeInit });
    expect(probeInit).not.toHaveBeenCalled();

    // `unloadAll()` never destroys the world it replaces (a separate,
    // pre-existing property) — reclaim worldA's koota slot explicitly. worldO
    // is destroyed by A's own tail already (oldWorld !== promotedWorld).
    if (worldA !== getCurrentWorld()) worldA.destroy();
  });
});
