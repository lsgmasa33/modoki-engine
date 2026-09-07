/** An HDR re-import must not DESTROY the environment texture a live surface still binds (#315).
 *
 *  THE DEFECT THIS PINS. `invalidateEnvironment` disposed the cached HDR unconditionally, while
 *  its own contract KEEPS the scene owners — i.e. `scene.environment` / `scene.background` are
 *  still bound to that very instance. Re-importing an HDR from the Environment Inspector
 *  therefore destroyed a texture the next command buffer submitted:
 *  `WebGPU uncaptured error: Destroyed texture used in a submit`.
 *
 *  It is the sibling of the `invalidateTexture` fix (62aca63b4) but NOT a copy of it: the env
 *  cache has owner-SETS and no per-holder release, so there is no refcount to hang the free off.
 *  The texture is retired instead, and freed by `syncEnvironment`'s sweep once no live surface
 *  binds it — which is why this test drives the REAL `syncEnvironment` rather than poking the
 *  cache. A test that only asserted on the cache could not tell "retired" from "leaked".
 *
 *  The multi-surface case is the one that decides the design: the editor renders the SceneView
 *  and the Game panel from two different THREE.Scenes off the same env cache, so a free keyed to
 *  the first surface to rebind would still destroy a texture the other one binds. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';

// Each load yields a DISTINCT instance so "did the surface rebind?" is answerable by identity.
// `created` records EVERY texture the loader handed out, so a test can reach the one that did
// NOT win the cache — otherwise "the loser was freed" and "the loser was orphaned" are
// indistinguishable from outside (#863).
const hdr = vi.hoisted(() => ({ n: 0, created: [] as any[] }));
vi.mock('three/examples/jsm/loaders/HDRLoader.js', () => ({
  HDRLoader: class {
    load(path: string, onLoad: (texture: any) => void) {
      const tex = { mapping: 0, isTexture: true, dispose: vi.fn(), uuid: `hdr-${path}-${++hdr.n}` };
      hdr.created.push(tex);
      setTimeout(() => onLoad(tex), 0);
    }
  },
}));

import { createWorld } from 'koota';
import { Environment } from '../../src/runtime/../three/traits/Environment';
import {
  acquireEnvironment, releaseEnvironment, invalidateEnvironment, getCachedEnvironment,
  retiredEnvironments, disposeAllCachedResources,
} from '../../src/runtime/loaders/meshTemplateCache';
import { syncEnvironment } from '../../src/runtime/rendering/scene3DSync';
import { registerAsset, clearManifest } from '../../src/runtime/loaders/assetManifest';

const GUID = '44444444-5555-4666-8777-888888888888';
const PATH = '/games/g/assets/env/sky.hdr';

/** Let the HDR "load" and its promise chain settle. Several macrotask turns, not one: the
 *  fetch awaits the (memoised) loader before it even schedules the loader's own timer, so a
 *  single `setTimeout(0)` lands BEFORE the load is queued. */
const settle = async () => {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 0));
    for (let j = 0; j < 10; j++) await Promise.resolve();
  }
};

const spawnEnv = (world: ReturnType<typeof createWorld>, showAsBackground = true) =>
  world.spawn(Environment({ hdrPath: GUID, intensity: 1, showAsBackground, backgroundIntensity: 1, backgroundBlurriness: 0 }));

beforeEach(() => {
  hdr.created.length = 0; // per-test, or `created.find(...)` below reaches a SIBLING test's texture
  clearManifest();
  registerAsset(GUID, PATH, 'environment'); // unconverted → the load URL is the source path
});

afterEach(() => {
  disposeAllCachedResources(); // don't leak this scene's owner (or a retiree) into sibling tests
  clearManifest();
  hdr.n = 0;
});

describe('invalidateEnvironment retires instead of destroying', () => {
  it('leaves a bound HDR alive across the re-import, then frees it once the surface rebinds', async () => {
    const world = createWorld();
    spawnEnv(world);
    await acquireEnvironment(1, GUID);
    const first = getCachedEnvironment(GUID) as any;
    expect(first, 'the HDR fixture must actually load, or this test proves nothing').toBeTruthy();

    const scene = new THREE.Scene();
    syncEnvironment(world, scene);
    expect(scene.environment, 'the surface must actually bind the env').toBe(first);
    expect(scene.background).toBe(first); // showAsBackground → the second binding slot

    invalidateEnvironment(PATH); // the editor re-import calls this with the SOURCE PATH
    expect(first.dispose, 'the bound texture must NOT be destroyed — this is #315').not.toHaveBeenCalled();
    expect(getCachedEnvironment(GUID), 'but it must be gone from the cache').toBeUndefined();

    // A frame rendered in the gap before the fresh bytes land: the surface keeps the old
    // texture (there is nothing else to draw), and the sweep must leave it alone.
    syncEnvironment(world, scene);
    expect(scene.environment).toBe(first);
    expect(first.dispose).not.toHaveBeenCalled();

    await settle(); // the `else` branch above re-acquired; the fresh HDR arrives
    const second = getCachedEnvironment(GUID) as any;
    expect(second, 'the re-import must re-fetch').toBeTruthy();
    expect(second).not.toBe(first);

    syncEnvironment(world, scene); // rebinds to the fresh instance, so the sweep can free the old
    expect(scene.environment).toBe(second);
    expect(first.dispose, 'freed exactly once, after nothing binds it').toHaveBeenCalledTimes(1);
    expect(retiredEnvironments().size).toBe(0);
  });

  it('keeps the retired HDR alive while a SECOND surface still binds it', async () => {
    const world = createWorld();
    spawnEnv(world);
    await acquireEnvironment(1, GUID);
    const first = getCachedEnvironment(GUID) as any;

    const sceneA = new THREE.Scene();
    const sceneB = new THREE.Scene(); // e.g. the editor's SceneView + Game panel
    syncEnvironment(world, sceneA);
    syncEnvironment(world, sceneB);
    expect(sceneA.environment).toBe(first);
    expect(sceneB.environment).toBe(first);

    invalidateEnvironment(PATH);
    // A frame in the gap is what re-acquires (syncEnvironment's no-cache branch), same as
    // production — the Inspector's re-import does not itself re-fetch.
    syncEnvironment(world, sceneA);
    syncEnvironment(world, sceneB);
    await settle();
    const second = getCachedEnvironment(GUID) as any;
    expect(second, 'the re-import must re-fetch').toBeTruthy();
    expect(second).not.toBe(first);

    syncEnvironment(world, sceneA); // only A has rebound
    expect(sceneA.environment).toBe(second);
    expect(sceneB.environment, 'B has not rendered yet').toBe(first);
    expect(first.dispose, 'a free keyed to the first rebind would destroy B\'s texture').not.toHaveBeenCalled();

    syncEnvironment(world, sceneB); // now the last binding is gone
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(retiredEnvironments().size).toBe(0);
  });

  it('retires on the SCENE-SWAP release too — last owner is not "nothing binds it"', async () => {
    // releaseEnvironmentByPath disposed on last owner. But a render-on-demand SceneView that
    // has not redrawn since the swap still has the instance on scene.environment, so the frames
    // between the release and its next sync would draw a destroyed texture.
    // showAsBackground OFF on purpose: `syncEnvironment` clears `scene.environment` when no env
    // is active but leaves `scene.background` alone (a separate, pre-existing gap — a camera
    // clearColor is what overwrites it in practice). With it on, the stale background binding
    // legitimately keeps the retiree alive and this test would be asserting that gap, not the
    // release path.
    const world = createWorld();
    spawnEnv(world, false);
    await acquireEnvironment(1, GUID);
    const tex = getCachedEnvironment(GUID) as any;
    const scene = new THREE.Scene();
    syncEnvironment(world, scene);
    expect(scene.environment).toBe(tex);

    releaseEnvironment(1, GUID);                       // the swap drops the last owner
    expect(getCachedEnvironment(GUID)).toBeUndefined();
    expect(tex.dispose, 'the surface still binds it').not.toHaveBeenCalled();

    // The surface now renders the swapped-in scene, which has no Environment at all.
    syncEnvironment(createWorld(), scene);
    expect(scene.environment, 'syncEnvironment clears IBL when no env is active').toBeNull();
    expect(tex.dispose).toHaveBeenCalledTimes(1);
  });

  it('an invalidate mid-flight discards the losing load outright, instead of writing then retiring it (#863)', async () => {
    // Before #863: invalidateEnvironment cleared envLoadPromises, so a fetch already in flight no
    // longer deduped a second one — both callbacks reached `envCache.set`, with the SECOND writer
    // retiring whichever texture the FIRST one left behind. #863 gave `fetchEnvironment` its own
    // PER-KEY liveness capture, so the invalidated (first) load's own guard now disposes it
    // directly before it ever reaches the cache — there is nothing left to retire. See
    // `environmentInvalidateKeyRace.test.ts` for #863's own dedicated (order-controlled) coverage
    // of this race.
    acquireEnvironment(1, GUID);            // fetch #1, deliberately NOT awaited
    invalidateEnvironment(PATH);            // clears the in-flight promise AND its liveness capture
    acquireEnvironment(1, GUID);            // fetch #2 starts alongside it
    await settle();

    const cached = getCachedEnvironment(GUID) as any;
    expect(cached, 'the surviving (post-invalidate) load must occupy the cache').toBeTruthy();
    // FAILS pre-#863: that version left ONE env retired (the discarded-then-overwritten loser)
    // instead of zero.
    expect(retiredEnvironments().size, 'the loser was discarded outright, not retired').toBe(0);
    // ⚠️ The two assertions below are what keep this test honest, and are why the retired-set
    // check cannot stand alone: an EMPTY retired set is ALSO exactly what a LEAK looks like —
    // orphaned, unreachable to `envCache`, to the sweep and to `disposeAllCachedResources`. That
    // leak is the property this test was written for (#315), so #863 narrowing the race must not
    // quietly downgrade it to "the set is empty". Name the loser and prove it was FREED.
    const loser = hdr.created.find((t) => t !== cached);
    expect(loser, 'both loads must actually have produced a texture').toBeTruthy();
    expect(loser.dispose, 'the discarded loser must be freed, not orphaned').toHaveBeenCalledTimes(1);
    expect(cached.dispose, 'the survivor must NOT be freed — it is the live env').not.toHaveBeenCalled();
  });

  it('takes the background back when showAsBackground goes off, and when the env goes away', async () => {
    // The field was wired in ONE direction: nothing ever cleared a texture background, and
    // `syncCamera` deliberately leaves one alone ("owned by the Environment sync"), so unticking
    // the box in the Inspector left the sky on screen forever. Observed live on games/3d-test
    // before the fix: scene.background stayed the HDR across frames after the toggle.
    // It also pinned a retired texture on a live surface, which the sweep then could never free.
    const world = createWorld();
    const e = spawnEnv(world, true);
    await acquireEnvironment(1, GUID);
    const tex = getCachedEnvironment(GUID) as any;
    const scene = new THREE.Scene();
    syncEnvironment(world, scene);
    expect(scene.background).toBe(tex);

    e.set(Environment, { showAsBackground: false });
    syncEnvironment(world, scene);
    expect(scene.background, 'the sky must come off when the box is unticked').toBeNull();
    expect(scene.environment, 'IBL is unaffected — only the backdrop was turned off').toBe(tex);

    // ...and the same when the Environment goes away entirely (entity removed/deactivated).
    e.set(Environment, { showAsBackground: true });
    syncEnvironment(world, scene);
    expect(scene.background).toBe(tex);
    e.destroy();
    syncEnvironment(world, scene);
    expect(scene.background).toBeNull();
    expect(scene.environment).toBeNull();

    // With nothing binding it, an invalidate can now actually be swept.
    invalidateEnvironment(PATH);
    syncEnvironment(world, scene);
    expect(tex.dispose).toHaveBeenCalledTimes(1);
  });

  it('drains retirees on disposeAllCachedResources, so a surface that stops rendering cannot strand one', async () => {
    const world = createWorld();
    spawnEnv(world);
    await acquireEnvironment(1, GUID);
    const first = getCachedEnvironment(GUID) as any;
    const scene = new THREE.Scene();
    syncEnvironment(world, scene);

    invalidateEnvironment(PATH);
    expect(retiredEnvironments().size).toBe(1); // still bound → retired, not freed

    // The sweep only runs from syncEnvironment; nothing renders again here. The generation
    // teardown is what closes that tail, and everything binding it is torn down with it.
    disposeAllCachedResources();
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(retiredEnvironments().size).toBe(0);
  });
});
