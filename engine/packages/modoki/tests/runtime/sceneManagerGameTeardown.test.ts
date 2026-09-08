/** #539 — `activeGameId` cleared at the HEAD of `disposeActiveGameManagers`, before any await.
 *
 *  `disposeActiveGameManagers` used to write `activeGameId` only via the FOLLOWING
 *  `initGameManagersFor` (never during its own teardown await), so `getActiveGameId()` kept
 *  answering the OUTGOING game for the whole teardown window. `SceneManager.loadScene` computes
 *  `gameChanged = nextGameId !== getActiveGameId()` — a re-entrant load back to the outgoing
 *  game, landing while `disposeActiveGameManagers` was still parked, saw `gameChanged === false`,
 *  skipped `initGameManagersFor` entirely, and left that game's game-scoped managers permanently
 *  deactivated (the A→B→A dead state). The fix clears `activeGameId` synchronously at the head of
 *  `disposeActiveGameManagers`, closing that window.
 *
 *  Driven through the real `sceneManager.loadScene` (via `preloaded` data, so no fetch / resource
 *  worlds) — `managerRegistry.test.ts` already proves `initGameManagersFor` re-activates in
 *  isolation, but nothing there exercises `SceneManager`'s own `gameChanged` computation, which is
 *  the actual seam #539 fixed.
 *
 *  Own file for the same reason as `sceneManagerLifecycle.test.ts`: koota caps a module graph at
 *  16 live worlds and that file is already tuned tight to its own budget — the A→B→A shape here
 *  needs three worlds (G, H, G2) concurrently alive at once (a shared hang blocks any pool
 *  replenishment before the 2nd and 4th `createWorld()` calls), which doesn't fit alongside
 *  `sceneManagerLifecycle.test.ts`'s own tests without borrowing from them. A separate file gets a
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

describe('SceneManager ↔ game-scoped manager teardown (#539)', () => {
  // #539: `disposeActiveGameManagers` used to write `activeGameId` only via the
  // FOLLOWING `initGameManagersFor` (never during its own teardown await), so
  // `getActiveGameId()` kept answering the OUTGOING game for the whole teardown
  // window. `SceneManager.loadScene` computes `gameChanged = nextGameId !==
  // getActiveGameId()` — a re-entrant load back to the outgoing game, landing
  // while `disposeActiveGameManagers` was still parked, saw `gameChanged ===
  // false`, skipped `initGameManagersFor` entirely, and left that game's
  // game-scoped managers permanently deactivated. The fix clears `activeGameId`
  // synchronously at the head of `disposeActiveGameManagers`, before any await.
  it('#539: a re-entrant loadScene back to the outgoing game re-activates its game-scoped manager', async () => {
    const { sceneManager, managers, getCurrentWorld } = await setup();

    const namesInCurrentWorld = (): string[] => {
      const names: string[] = [];
      getCurrentWorld().query(EntityAttributes).updateEach(([ea]: [{ name: string }]) => names.push(ea.name));
      return names;
    };

    // A single shared hang: G's manager parks its FIRST init on it, so it is
    // still `active` with a still-pending `initPromise` at the moment H's
    // load tries to tear it down — exactly the window `disposeActiveGameManagers`
    // must park in for this seam to matter. `initCount` proves whether the
    // manager was (re)activated at all, and `getRegisteredManagers()` below
    // proves whether it ends up active.
    let resolveHang: () => void = () => {};
    const hang = new Promise<void>((resolve) => { resolveHang = resolve; });
    let initCount = 0;
    managers.registerManager({
      name: 'gameMgrG', scope: 'game', games: ['G'],
      init: () => { initCount++; return hang; },
    });

    // Load G (NOT awaited — its manager's init hangs on the shared promise, so
    // loadScene(G) itself won't settle until we release it far below). Wait for
    // the swap to commit and the manager's init to actually start; both are
    // synchronous with `activeGameId` being set to 'G', so once observed the
    // manager is `active` with a pending `initPromise`.
    const pG = sceneManager.loadScene('/sceneG.json', { preloaded: sceneOf('G') as never, gameId: 'G' });
    await vi.waitFor(() => { if (!namesInCurrentWorld().includes('G')) throw new Error('G has not swapped in yet'); });
    await vi.waitFor(() => { if (initCount !== 1) throw new Error('gameMgrG init has not started yet'); });
    const worldG = getCurrentWorld();
    const destroyG = vi.spyOn(worldG, 'destroy');

    // Issue the game CHANGE (NOT awaited): gameId 'H' !== 'G', so this enters
    // `if (gameChanged) await disposeActiveGameManagers(...)` right after its
    // own swap commits, finds gameMgrG active with its initPromise still
    // pinned on the shared hang, and parks there.
    const pH = sceneManager.loadScene('/sceneH.json', { preloaded: sceneOf('H') as never, gameId: 'H' });
    await vi.waitFor(() => { if (!namesInCurrentWorld().includes('H')) throw new Error('H has not swapped in yet'); });
    const worldH = getCurrentWorld();
    const destroyH = vi.spyOn(worldH, 'destroy');

    // While H's teardown is parked on the hang, issue the RE-ENTRANT load back
    // to G. Its own `gameChanged` computation reads `getActiveGameId()`
    // synchronously: with the #539 fix, H's `disposeActiveGameManagers` already
    // cleared it to null at its own head, so this sees `gameChanged === true`
    // (null !== 'G') and will re-activate gameMgrG once it reaches its own
    // game-managers-init step. Pre-fix, `activeGameId` still read 'G' (written
    // only on success) — same as this load's own `nextGameId` — so
    // `gameChanged` would be false and it would skip re-activation entirely,
    // leaving gameMgrG permanently dead even though we are back in game G.
    const pG2 = sceneManager.loadScene('/sceneG2.json', { preloaded: sceneOf('G2') as never, gameId: 'G' });

    // G2 needs its OWN handful of real awaits (chain resolution etc., same as
    // every other overlapping load in this file) before it reaches its own
    // atomic swap and its own `disposeActiveGameManagers` call — release the
    // hang only once THAT has committed too, or H's parked dispose resumes
    // (and — pre-fix — writes `activeGameId = 'H'` via its own
    // `initGameManagersFor`) before G2 ever reads `getActiveGameId()`, which
    // would let G2 see 'H' instead of the stale 'G' the bug actually depends
    // on and silently stop testing the seam.
    await vi.waitFor(() => { if (!namesInCurrentWorld().includes('G2')) throw new Error('G2 has not swapped in yet'); });

    resolveHang();
    await Promise.all([pG, pH, pG2]);

    // The regression: gameMgrG must have been re-activated by the re-entrant
    // load, not left dead. Exactly 2 (not merely >= 2): the first activation
    // (G) plus the one re-activation the re-entrant load (G2) causes — nothing
    // else in this scenario would call `init` again, so a tighter count also
    // catches a pathological re-activation loop that `>=` would miss.
    expect(initCount).toBe(2);
    expect(managers.getRegisteredManagers().find((s) => s.startsWith('gameMgrG'))).toContain('active');

    // worldG's and worldH's own `oldWorld.destroy()` steps deferred behind
    // gameMgrG's in-flight init (same #468 mechanism) and are fire-and-forget
    // (not awaited by `loadScene`) — flush until both actually ran, so this
    // test doesn't leak koota worldId slots (capped at 16) into later tests
    // in this file.
    await vi.waitFor(() => { if (destroyG.mock.calls.length === 0) throw new Error('worldG destroy has not run yet'); });
    await vi.waitFor(() => { if (destroyH.mock.calls.length === 0) throw new Error('worldH destroy has not run yet'); });
  });
});
