// @vitest-environment jsdom
/** Contract test for `newScene()` (editor/scene/serialize.ts).
 *
 *  A freshly-created scene must be LIT out of the box — the regression that
 *  motivated this (commit bb55957) was new scenes rendering everything black
 *  because they had only a Camera. `newScene()` now spawns a ready-to-use
 *  starting world: Camera + Environment (built-in white.hdr) + a Directional key
 *  light + an Ambient fill. This locks that contract (entity set, names, the
 *  white-HDR GUID, and sortOrder) so it can't silently regress. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createWorld } from 'koota';
import { setCurrentWorld, getCurrentWorld, onWorldSwap, peekCurrentWorld } from '../../src/runtime/core/ecs/world';
import { registerTrait } from '../../src/runtime/core/ecs/traitRegistry';
import { getAllEntities } from '../../src/runtime/core/ecs/entityUtils';
import { Camera } from '../../src/runtime/traits/Camera';
import { Transform } from '../../src/runtime/core/traits/Transform';
import { EntityAttributes } from '../../src/runtime/core/traits/EntityAttributes';
import { Environment } from '../../src/three/traits/Environment';
import { Light } from '../../src/three/traits/Light';
import { Time } from '../../src/runtime/core/traits/Time';
import { Input } from '../../src/runtime/traits/Input';
import { newScene, getCurrentScenePath, setCurrentScenePath } from '../../src/editor/scene/serialize';
import { WHITE_HDR_GUID } from '../../src/runtime/assets/builtinAssets';
import { sceneManager } from '../../src/runtime/scene/SceneManager';
import { registerManager, unregisterManager } from '../../src/runtime/managers/managerRegistry';

function registerAll() {
  registerTrait({ name: 'EntityAttributes', trait: EntityAttributes, category: 'component', fields: { name: { type: 'string' }, isActive: { type: 'boolean' }, sortOrder: { type: 'number' }, parentId: { type: 'number', entityId: { onMissing: 'root' } }, layer: { type: 'enum', options: ['', '3d', '2d', 'ui'] }, guid: { type: 'string' } } });
  registerTrait({ name: 'Transform', trait: Transform, category: 'component', fields: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, rx: { type: 'number' }, ry: { type: 'number' }, rz: { type: 'number' }, sx: { type: 'number' }, sy: { type: 'number' }, sz: { type: 'number' } } });
  registerTrait({ name: 'Camera', trait: Camera, category: 'component', fields: { fov: { type: 'number' } } });
  registerTrait({ name: 'Environment', trait: Environment, category: 'component', fields: { hdrPath: { type: 'string' }, intensity: { type: 'number' } } });
  registerTrait({ name: 'Light', trait: Light, category: 'component', fields: { lightType: { type: 'enum', options: ['ambient', 'directional', 'point', 'spot'] }, color: { type: 'color' }, intensity: { type: 'number' } } });
  // Registered because PRODUCTION registers it (`engine/app/ecs/registerTraits.ts`, category
  // 'resource'). Without it `getAllEntities()` cannot see the materialized Time singleton, and
  // every count below would understate what the editor actually shows by one — the Hierarchy
  // renders resource entities, with an `R` badge.
  registerTrait({ name: 'Time', trait: Time, category: 'resource', fields: { timeScale: { type: 'number' } } });
}

// serialize.ts persists the last-scene path to localStorage; the jsdom env here
// doesn't provide one, so back it with a tiny in-memory store.
function installLocalStorage() {
  if (typeof globalThis.localStorage !== 'undefined') return;
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  } as Storage;
}

describe('newScene()', () => {
  beforeEach(() => {
    installLocalStorage();
    setCurrentWorld(createWorld());
    registerAll();
    setCurrentScenePath('/assets/scenes/prev.json'); // simulate a prior scene
  });

  // Each newScene() promotes a world and destroys the one it replaced, so the world it
  // PROMOTED is still live when the test ends. koota caps worlds at 16 (WORLD_ID_BITS=4),
  // and this file makes two per test — without this the suite exhausts the pool partway
  // through and later tests fail for a reason that has nothing to do with what they assert.
  afterEach(() => {
    try { peekCurrentWorld()?.destroy(); } catch { /* already destroyed */ }
  });

  it('spawns four starter entities, plus the Time resource row the editor shows', async () => {
    await newScene();
    // FIVE, not four: the four authored starters plus the materialized `Time` resource, which
    // the Hierarchy renders like any other row (with an `R` badge). A loaded scene shows it too,
    // so this matches what Create Scene now looks like rather than a harness-only count.
    expect(getAllEntities()).toHaveLength(5);
    expect(getAllEntities().filter((e) => !e.isResource)).toHaveLength(4);
  });

  it('spawns Camera + HDR Environment + Directional + Ambient by name and order', async () => {
    await newScene();
    // Authored starters only — the materialized `Time` resource has no EntityAttributes, so it
    // carries no name or sortOrder of its own and is not part of this contract.
    const byOrder = getAllEntities().filter((e) => !e.isResource).sort((a, b) => a.sortOrder - b.sortOrder);
    expect(byOrder.map((e) => e.name)).toEqual(['Camera', 'HDR Environment', 'Directional Light', 'Ambient Light']);
    expect(byOrder.map((e) => e.sortOrder)).toEqual([0, 1, 2, 3]);
  });

  it('binds the Environment to the built-in white.hdr GUID', async () => {
    await newScene();
    const env = getCurrentWorld().query(Environment)[0];
    expect(env).toBeDefined();
    expect(env.get(Environment)!.hdrPath).toBe(WHITE_HDR_GUID);
  });

  it('spawns a lit setup: a directional key light and an ambient fill', async () => {
    await newScene();
    const lights = getCurrentWorld().query(Light).map((e) => e.get(Light)!);
    const types = lights.map((l) => l.lightType).sort();
    expect(types).toEqual(['ambient', 'directional']);
    // The directional key is meaningfully bright; ambient is a softer fill.
    const directional = lights.find((l) => l.lightType === 'directional')!;
    const ambient = lights.find((l) => l.lightType === 'ambient')!;
    expect(directional.intensity).toBeGreaterThan(0);
    expect(ambient.intensity).toBeGreaterThan(0);
    expect(directional.intensity).toBeGreaterThan(ambient.intensity);
  });

  it('clears the current scene path (untitled)', async () => {
    await newScene();
    expect(getCurrentScenePath()).toBeNull();
  });

  // ── #853: replacing every entity IS a world swap ────────────────────────────────────
  // These are the MECHANISM tests. Before #853 `newScene()` deleted and respawned into the
  // SAME world, which made it the one path in the repo that replaces all content without
  // emitting `setCurrentWorld` — so every id-keyed teardown keyed on `onWorldSwap` (the
  // Hierarchy's collapse restore, SceneView's gizmo/outline maps, the 2D renderer's slot and
  // last-render caches, the Timeline's Director rebind) was silently skipped. koota recycles
  // ids LIFO and totally, so that state did not merely go stale, it aliased exactly onto the
  // new scene's entities.
  //
  // ⚠️ The fix is NOT that ids stop colliding — a fresh koota world hands out 1,2,3… again, so
  // they still can. It is that every holder is TOLD. That is why these assert on the swap
  // firing, not on id values.

  it('promotes a NEW world and fires onWorldSwap exactly once', async () => {
    const before = getCurrentWorld();
    const calls: Array<{ next: object; prev: object }> = [];
    const unsub = onWorldSwap((next, prev) => calls.push({ next, prev }));
    try {
      await newScene();
    } finally { unsub(); }

    expect(calls).toHaveLength(1);
    expect(calls[0].prev).toBe(before);
    expect(calls[0].next).toBe(getCurrentWorld());
    expect(getCurrentWorld()).not.toBe(before);
  });

  it('has already populated the world by the time swap listeners run', async () => {
    // Populate-before-promote, and it is load-bearing rather than stylistic: a swap fired
    // against an EMPTY world lets the Hierarchy's restore latch its collapse owner on a
    // zero-length tree, and the content then arrives with the owner already claimed — #839
    // reached by another route. A listener is the only place that ordering is observable.
    let countInsideListener = -1;
    const unsub = onWorldSwap(() => { countInsideListener = getAllEntities().length; });
    try {
      await newScene();
    } finally { unsub(); }

    expect(countInsideListener).toBe(5);   // four starters + the Time resource
  });

  it('has already set the editor scene path by the time swap listeners run', async () => {
    // Same ordering requirement, other half. The Hierarchy reads getCurrentScenePath() from a
    // refresh scheduled by the swap; if the path were still the OUTGOING scene's, the restore
    // would key the new world's tree to the old scene's saved set and then persist over it.
    let pathInsideListener: string | null = 'unset';
    const unsub = onWorldSwap(() => { pathInsideListener = getCurrentScenePath(); });
    try {
      await newScene('/assets/scenes/beta.json');
    } finally { unsub(); }

    expect(pathInsideListener).toBe('/assets/scenes/beta.json');
    expect(getCurrentScenePath()).toBe('/assets/scenes/beta.json');
  });

  // NOT TESTED HERE, deliberately: "leaves no loaded scenes behind". `sceneManager` in this
  // harness has never loaded anything, so `getLoadedScenes()` is empty whether or not
  // `replaceWorldContent` clears it — the assertion cannot fail, and a test that cannot fail is
  // worse than no test. Making it real needs a genuine `loadScene` (fetch, migrations, resource
  // acquisition), which belongs in the SceneManager suite, not here. The e2e covers the
  // observable consequence instead.

  it('materializes the Time and Input singletons the fresh world would otherwise lack', async () => {
    // `loadScene` spawns both into its staging world before promoting, and NOTHING else in the
    // repo spawns either — so a world promoted without them is one where `inputSystem` and
    // `timeSystem` both early-return on the missing resource and write nothing. The new scene
    // then reads as frozen and dead to input the moment you press Play.
    //
    // ⚠️ `Input` is the one that regressed. It is absent from the trait registry, so the OLD
    // in-place `deleteEntities(getAllEntities()…)` never saw it and it survived by accident;
    // a freshly-minted world has no such accident. Neither is visible through
    // `getAllEntities()`, so query the world directly — via getAllEntities this would pass
    // while both were missing.
    await newScene();

    expect(getCurrentWorld().queryFirst(Time)).toBeDefined();
    expect(getCurrentWorld().queryFirst(Input)).toBeDefined();
  });

  it('destroys the world it replaced, so koota\'s 16-world pool is not leaked', async () => {
    // The method's own docblock cites this as the reason not to reimplement it as
    // `unloadAll()` + spawn. koota's cap is hard: `allocateWorldId` THROWS "Too many worlds
    // created. The maximum is 16." So a future edit that drops the destroy ships a hard throw
    // on the ~16th Create Scene of a session — and, before this test, with a green gate:
    // deleting `destroyWorldWhenSafe` left all 10804 tests passing.
    const before = getCurrentWorld();
    const witness = before.spawn(EntityAttributes({ name: 'witness' }));
    expect(witness.isAlive()).toBe(true);
    const destroySpy = vi.spyOn(before, 'destroy');   // spyOn calls through

    await newScene();

    expect(getCurrentWorld()).not.toBe(before);
    // ⚠️ This asserts the SYNCHRONOUS branch of `destroyWorldWhenSafe`, which is the one taken
    // here because `pendingManagerInits()` is null in this harness. The deferred branch (the
    // Promise.race behind WORLD_DESTROY_DEFER_MAX_MS) is not covered, and if a future change
    // leaves a manager init pending across a newScene this goes RED against a correct
    // implementation. That is a loud failure rather than a hollow pass, so it is left as-is —
    // but read it as "the destroy was not deferred", not "the destroy always happens".
    expect(destroySpy).toHaveBeenCalledTimes(1);      // it was asked to free the slot…
    // …and it took effect. ⚠️ On a destroyed world koota's `isAlive()` THROWS (the entity's
    // internal world ref is nulled) rather than returning false — so `.toBe(false)` would fail
    // against a correct implementation. Asserting the throw is what makes this a check on the
    // destroy having landed rather than on the spy alone.
    expect(() => witness.isAlive()).toThrow();
  });

  // NOT TESTED HERE, for the same reason the loaded-scenes assertion was dropped above: the
  // `releaseAllForScene` half of the tail iterates `loadedScenes`, which is empty in this
  // harness, so a spy would record zero calls whether or not the loop exists. It needs a real
  // `loadScene` first, which belongs in the SceneManager suite.

  it('a throwing populate leaves the live world untouched and strands no koota slot', async () => {
    // `replaceWorldContent` is on the public SceneManager interface, so `populate` is
    // caller-supplied and can throw. Two things must hold: the live world is untouched (it was
    // never promoted), and the staging world is destroyed rather than left to occupy one of
    // koota's 16 slots forever.
    //
    // The slot half is asserted by REPETITION rather than by inspecting the staging world,
    // which the method never exposes: koota's `allocateWorldId` THROWS "Too many worlds
    // created. The maximum is 16." So without the cleanup this loop dies partway through with
    // a koota error instead of the 20 'boom's it expects — which is exactly the failure a user
    // would eventually hit, just reached deterministically.
    const before = getCurrentWorld();

    for (let i = 0; i < 20; i++) {
      await expect(
        sceneManager.replaceWorldContent(() => { throw new Error('boom'); }),
      ).rejects.toThrow('boom');
    }

    expect(getCurrentWorld()).toBe(before);   // never promoted, not once
  });

  it('a filter-less scene manager cannot spawn into the world being promoted', async () => {
    // The manager block clears `activeScenePath` via `initSceneManagersFor('')`, copied from
    // `unloadAll`. ⚠️ What has to be copied is the POSITION, not the two lines:
    // `initSceneManagersFor('')` spuriously re-activates any manager with no `scenes` filter
    // (`sceneMatches` returns true for ''), and `activate()` hands that manager's `init()`
    // `getCurrentWorld()`. `unloadAll` is safe because it promotes AFTERWARDS, into a world
    // nobody keeps. Run after the promote here and a filter-less manager's `init()` spawns its
    // entities straight into the brand-new scene, where the dispose — holding the OLD world —
    // cannot see them, and the next save writes them into the new scene file.
    //
    // No manager in the repo has this shape today (the unfiltered ones carry no `init`), which
    // is exactly why the gate was silent on it — so the test has to build one.
    const spawnedInto: object[] = [];
    registerManager({
      name: 'qaFilterlessProbe',
      scope: 'scene',
      // no `scenes` — matches every path, including ''
      init: ({ world }) => {
        spawnedInto.push(world);
        world.spawn(EntityAttributes({ name: 'strayFromManager', sortOrder: 99 }));
      },
    });
    try {
      await newScene('/assets/scenes/beta.json');

      const names = getAllEntities().map((e) => e.name);
      expect(names).not.toContain('strayFromManager');
      // …and it never even saw the promoted world, which is the mechanism rather than the symptom.
      expect(spawnedInto).not.toContain(getCurrentWorld());
    } finally {
      unregisterManager('qaFilterlessProbe');
    }
  });

  it('replaces the previous world (no leftover entities across calls)', async () => {
    await newScene();
    await newScene();
    expect(getAllEntities()).toHaveLength(5); // not 10 — the prior world is gone, not added to
  });
});
