/** #877 — `unloadAll()` must free the koota world slot of the world it replaces.
 *
 *  koota caps live worlds at 16 (`WORLD_ID_BITS = 4`), and `releaseWorldId` is
 *  reachable from exactly one place: `world.destroy()`. Before the fix,
 *  `unloadAll()` was the only one of SceneManager's three world promoters that
 *  never destroyed the world it replaced — measured, a bare `unloadAll()` loop
 *  (no scene loaded at all) exhausted the pool after 15 teardowns and the 16th
 *  threw `Koota: Too many worlds created`.
 *
 *  Own file, deliberately: the cycle test at the end is ALLOWED to exhaust koota's
 *  per-module-graph pool when the fix regresses, and it must take nothing else
 *  down with it when it does. Nothing here loads a scene, so no traitRegistry
 *  mock or preloaded scene data is needed. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

beforeEach(() => { vi.resetModules(); });

async function setup() {
  const scene = await import('../../src/runtime/scene/SceneManager');
  scene.sceneManager.resetForTesting();
  const managers = await import('../../src/runtime/managers/managerRegistry');
  managers.__resetManagersForTesting();
  const world = await import('../../src/runtime/core/ecs/world');
  return { sceneManager: scene.sceneManager, managers, getCurrentWorld: world.getCurrentWorld };
}

/** Assert `world` has NOT been destroyed.
 *
 *  ⚠️ Almost nothing koota exposes can tell the difference, which is why this is a named helper
 *  rather than an inline assertion someone might "simplify". MEASURED on koota: after
 *  `destroy()`, `spawn()` still returns an entity, `query().updateEach()` reads it straight back,
 *  and `get`/`has`/`set`/`entities.length`/`id` all answer without complaint. An earlier version
 *  of these tests asserted `expect(() => w.spawn()).not.toThrow()` and could therefore never
 *  fail. `destroy()` nulls `world[$internal].worldEntity` and `isAlive()` dereferences it, so
 *  this is the one probe that separates the two — and it is a real discriminator, not an
 *  always-throw: on a live world it returns `true`. */
function expectLive(world: { spawn: () => { isAlive: () => boolean } }): void {
  expect(world.spawn().isAlive()).toBe(true);
}

describe('#877: unloadAll frees the world slot it replaces', () => {
  // Per-symptom: the world that was current when the teardown promoted is the
  // one destroyed — not merely "some world was".
  it('destroys the outgoing world, not the fresh one it promotes', async () => {
    const { sceneManager, getCurrentWorld } = await setup();

    const outgoing = getCurrentWorld();
    const destroySpy = vi.spyOn(outgoing, 'destroy');

    await sceneManager.unloadAll();

    expect(destroySpy).toHaveBeenCalledTimes(1);
    expect(getCurrentWorld()).not.toBe(outgoing);
    expectLive(getCurrentWorld());
  });

  // WHY the shared `destroyWorldWhenSafe` helper rather than a bare
  // `outgoing.destroy()`: `unloadAll` disposes scene- and game-scoped managers
  // only. An APP-scoped manager is never disposed here at all (it activates at
  // `registerManager` and stays active until unregister), and `activate()` hands
  // `init()` a `{ world: getCurrentWorld() }` context — so an app manager with an
  // async init in flight is holding the outgoing world at exactly the moment the
  // teardown wants to free it. Destroying immediately would pull the world out
  // from under that init; the helper defers behind `pendingManagerInits()`.
  it('defers the destroy behind an in-flight app-scoped manager init', async () => {
    const { sceneManager, managers, getCurrentWorld } = await setup();

    let resolveInit: () => void = () => {};
    const hang = new Promise<void>((resolve) => { resolveInit = resolve; });
    let capturedWorld: unknown;
    managers.registerManager({
      name: 'appMgr',
      scope: 'app',
      init: (ctx?: { world: unknown }) => { capturedWorld = ctx?.world; return hang; },
    });

    const outgoing = getCurrentWorld();
    expect(capturedWorld).toBe(outgoing);
    const destroySpy = vi.spyOn(outgoing, 'destroy');

    await sceneManager.unloadAll();

    // The teardown has fully settled and the promote has happened — but the
    // world the app manager is still initialising against must be intact.
    expect(getCurrentWorld()).not.toBe(outgoing);
    expect(destroySpy).not.toHaveBeenCalled();

    resolveInit();
    await vi.waitFor(() => { expect(destroySpy).toHaveBeenCalledTimes(1); });
  });

  // The test that pins WHICH world the tail frees — the only shape where
  // `unloadAll`'s head-captured `oldWorld` and the world current at its tail are
  // different objects. Neither `unloadAll` nor `replaceWorldContent` refuses to
  // start while another teardown is in flight (`teardownInFlight` is a counter
  // both bump, not a lock), so the second call captures the SAME world as the
  // first and the first tail destroys it. A tail reusing its head capture would
  // free that world twice — koota's `releaseWorldId` is not idempotent, and a
  // double release hands one world id to two live worlds — while leaking the
  // world actually current.
  //
  // A racing `loadScene` deliberately does NOT appear here: its last pre-swap
  // checkpoint and its `setCurrentWorld` are one await-free stretch, so it cannot
  // commit a swap inside a teardown's awaits, and this divergence is unreachable
  // through it.
  it('two teardowns racing free each world exactly once', async () => {
    const { sceneManager, getCurrentWorld } = await setup();

    const first = getCurrentWorld();
    const destroyFirst = vi.spyOn(first, 'destroy');

    // Both heads run before either tail: the second call's synchronous head
    // executes while the first is parked on its own first await, so both see
    // `first` as the current world.
    const pA = sceneManager.unloadAll();
    const pB = sceneManager.unloadAll();
    await Promise.all([pA, pB]);

    // Two promotes, two frees, and the world both heads captured is freed once.
    expect(destroyFirst).toHaveBeenCalledTimes(1);
    expect(getCurrentWorld()).not.toBe(first);
    expectLive(getCurrentWorld());
  });

  // The same defect one method over, found by #877's close-out sweep — and this one is
  // production-reachable where `unloadAll` is not. `replaceWorldContent` (Assets → Create
  // Scene, and the `new_scene` agent op) captured its `oldWorld` ~90 lines and three manager
  // awaits before its own promote, then destroyed that capture. Two Create Scene gestures in
  // quick succession both capture the same world, and whichever tail runs first frees it.
  it('two Create Scene gestures racing free each world exactly once', async () => {
    const { sceneManager, getCurrentWorld } = await setup();

    const first = getCurrentWorld();
    const destroyFirst = vi.spyOn(first, 'destroy');

    await Promise.all([
      sceneManager.replaceWorldContent(() => {}),
      sceneManager.replaceWorldContent(() => {}),
    ]);

    // Pre-fix this was 2: both tails freed the head-captured world, koota's non-idempotent
    // `releaseWorldId` decremented the cursor twice, and the world the first gesture promoted
    // was left holding a slot nobody would ever free.
    expect(destroyFirst).toHaveBeenCalledTimes(1);
    expect(getCurrentWorld()).not.toBe(first);
    expectLive(getCurrentWorld());
  });

  // THE mechanism test, and LAST in the file on purpose: koota's universe is
  // module-level in a dependency that `vi.resetModules()` does not reload, so the
  // 16-world pool is shared by every test in this file. When this one regresses it
  // drains the pool, and running it last keeps that from swallowing the two precise
  // assertions above under the same failure message.
  //
  // Asserting that a promote merely RESOLVES proves nothing here — the leak is invisible until
  // the pool runs dry — so this drives past the pool's remaining capacity, for BOTH promoters
  // this change touched.
  //
  // ⚠️ It does NOT catch the opposite error, and an earlier version of this comment claimed it
  // did. MEASURED: a promoter that freed the world it just PROMOTED leaks exactly one id in
  // total, not one per iteration — each pass allocates an id and hands the same id straight
  // back, so the loop runs forever without exhausting anything (40/40 iterations against a
  // 16-slot pool). The wrong-side hypothesis is caught by the exactly-once `destroy` counts and
  // `expectLive` above, not here.
  //
  // The bound is MEASURED rather than koota's literal 16: `WORLD_ID_BITS` is private, so a
  // hard-coded loop would silently stop testing anything if the cap ever rose. Note what the
  // probe actually measures — the HEADROOM left after the tests above it, not the cap — which is
  // the stronger property: the margin below stays at +5 however many slots this file has already
  // spent. Do not "correct" it to koota's real cap.
  it('survives more promotes than the world pool has room for', async () => {
    const { sceneManager } = await setup();
    const { createWorld } = await import('koota');

    // Bounded, and it rethrows anything that is not the cap: an unbounded `while (true)` whose
    // catch swallowed every error would become an infinite loop in the suite the day koota stops
    // throwing here, rather than a red test.
    const probes: Array<{ destroy: () => void }> = [];
    for (let i = 0; i < 256; i++) {
      try {
        probes.push(createWorld());
      } catch (e) {
        if (!/Too many worlds/i.test(String(e))) throw e;
        break;
      }
    }
    expect(probes.length).toBeLessThan(256);   // the pool refused before the bound: a real probe
    const headroom = probes.length;
    for (const w of probes) w.destroy();       // allocation order — nothing is stranded
    expect(headroom).toBeGreaterThanOrEqual(1);

    for (let i = 0; i < headroom + 5; i++) {
      await expect(sceneManager.unloadAll()).resolves.toBeUndefined();
    }
    for (let i = 0; i < headroom + 5; i++) {
      await expect(sceneManager.replaceWorldContent(() => {})).resolves.toBeUndefined();
    }
  });
});
