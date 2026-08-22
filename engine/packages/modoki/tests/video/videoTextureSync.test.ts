// @vitest-environment jsdom

/** The 3D video surface. It had NO test at all, which is why this survived to production:
 *
 *  Binding a video used to write `map` onto the mesh's own material and restore the previous
 *  value on teardown. Both halves are wrong. The restore is the crash: three's
 *  `NodeMaterialObserver` snapshots a material's monitored properties ONCE (`_materialCache`,
 *  keyed by the material, never re-recorded — `needsUpdate` does not reset it), and the
 *  snapshot SKIPS a null while the comparison does NOT guard one:
 *
 *      getMaterialData:  if ( value === null || value === undefined ) continue;
 *      equals:           } else if ( mtlValue.isTexture === true ) {
 *
 *  So `map: texture → null` poisons that material forever: every later frame throws
 *  `Cannot read properties of null (reading 'isTexture')` out of the render loop, in every
 *  viewport. Observed on demos/video-demo, whose screens have no authored map — so the
 *  "restore the previous map" path restored null every time a clip stopped.
 *
 *  The other half is quieter: engine materials are shared and refcounted by GUID, so writing
 *  `map` onto one puts the video on every mesh using it.
 *
 *  Both are pinned below by asserting the OBSERVABLE rule that prevents them: the shared
 *  original is never mutated, and no material ever has a map taken away from it. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createWorld, type World } from 'koota';
import { VideoPlayer } from '../../src/runtime/traits/VideoPlayer';

// three's WebGPU build does not construct node materials under jsdom, so stand in for the
// handful of symbols this module touches — the same shape blobShadowSync/particleRenderDispose
// use. What is under test is the BINDING BOOKKEEPING (which object sits in which slot), and
// that is fully observable without a GPU.
class FakeTexture { dispose = vi.fn(); }
class FakeVideoTexture {
  colorSpace = ''; minFilter = 0; magFilter = 0; generateMipmaps = true; needsUpdate = false;
  dispose = vi.fn();
  constructor(public el: unknown) {}
}
vi.mock('three/webgpu', () => ({
  VideoTexture: FakeVideoTexture,
  Texture: FakeTexture,
  SRGBColorSpace: 'srgb',
  LinearFilter: 1006,
}));

const { syncVideoTextures, disposeVideoTextures, videoTextureCount } =
  await import('../../src/runtime/rendering/videoTextureSync');
const { derivedBaseOf } = await import('../../src/runtime/rendering/derivedMaterials');

// videoSystem owns the elements; this suite is about what the RENDERER does with one.
const elements = new Map<number, HTMLVideoElement>();
vi.mock('../../src/runtime/video/videoSystem', () => ({
  videoElementFor: (id: number) => elements.get(id),
}));

function fakeElement(): HTMLVideoElement {
  const el = document.createElement('video');
  el.play = vi.fn(async () => {});
  el.pause = vi.fn(() => {});
  return el;
}

/** A material that can carry a `map`. `map` is declared (not merely assignable) because the
 *  binder selects a slot with `'map' in material` — a screen material with no authored map is
 *  `{map: null}`, which is exactly the video-demo shape that crashed. */
class FakeMaterial {
  map: unknown = null;
  needsUpdate = false;
  roughness = 0.5;
  disposed = false;
  clone(): FakeMaterial {
    const c = new FakeMaterial();
    c.map = this.map;
    c.roughness = this.roughness;
    return c;
  }
  dispose(): void { this.disposed = true; }
}
type Mesh = { material: FakeMaterial | FakeMaterial[] };

/** A mesh with a single material carrying no map — a video screen as video-demo authors it. */
function fakeMesh(material?: FakeMaterial): Mesh {
  return { material: material ?? new FakeMaterial() };
}

// The real signature wants THREE.Object3D; our fake meshes carry only what the module reads
// (`material`), so the cast is at the seam rather than smeared through every call.
type State = { ecsObjects: Map<number, unknown> };
const sync = (w: World, s: State) =>
  syncVideoTextures(w, s as unknown as Parameters<typeof syncVideoTextures>[1]);

let world: World;
let state: State;

/** Spawn an entity with a VideoPlayer and a live element, and register its 3D object. */
function spawnVideo(mesh: Mesh): number {
  const e = world.spawn(VideoPlayer);
  const id = e.id();
  state.ecsObjects.set(id, mesh);
  elements.set(id, fakeElement());
  return id;
}

const matOf = (mesh: Mesh) => mesh.material as FakeMaterial;

beforeEach(() => {
  world = createWorld();
  state = { ecsObjects: new Map() };
  elements.clear();
});
afterEach(() => { disposeVideoTextures(state); vi.restoreAllMocks(); });

describe('syncVideoTextures — binding', () => {
  it('puts the video on the mesh without mutating the material it found', () => {
    const original = new FakeMaterial();
    const mesh = fakeMesh(original);
    spawnVideo(mesh);

    sync(world, state);

    expect(matOf(mesh)).not.toBe(original);           // a clone was swapped in
    expect(matOf(mesh).map).toBeInstanceOf(FakeVideoTexture);
    // THE shared-material rule: the original is untouched, so other meshes using it are too.
    expect(original.map ?? null).toBeNull();
    expect(videoTextureCount(state)).toBe(1);
  });

  // The refcounted material cache hands the SAME object to every mesh with that GUID.
  it('does not leak the video onto a sibling mesh sharing the material', () => {
    const shared = new FakeMaterial();
    const withVideo = fakeMesh(shared);
    const sibling = fakeMesh(shared);
    spawnVideo(withVideo);

    sync(world, state);

    expect(matOf(sibling)).toBe(shared);
    expect(matOf(sibling).map ?? null).toBeNull();
  });

  it('is idempotent across frames — the same element does not rebind', () => {
    const mesh = fakeMesh();
    spawnVideo(mesh);
    sync(world, state);
    const bound = matOf(mesh);
    const tex = bound.map;

    sync(world, state);
    sync(world, state);

    expect(matOf(mesh)).toBe(bound);
    expect(matOf(mesh).map).toBe(tex);
    expect(videoTextureCount(state)).toBe(1);
  });
});

describe('syncVideoTextures — teardown (the crash)', () => {
  /** THE regression. Stopping a clip restored `map = null` on a material three had already
   *  observed holding a texture, which makes NodeMaterialObserver.equals dereference null on
   *  every later frame. The rule that prevents it: no material is ever left with a map
   *  REMOVED — the clone is swapped out whole and the untouched original goes back. */
  it('never takes a map away from a material — the original returns, map-free as it began', () => {
    const original = new FakeMaterial();
    const mesh = fakeMesh(original);
    const id = spawnVideo(mesh);

    sync(world, state);
    const clone = matOf(mesh);
    expect(clone.map).toBeInstanceOf(FakeVideoTexture);

    elements.delete(id);            // the clip stopped — this is what release() reacts to
    sync(world, state);

    expect(matOf(mesh)).toBe(original);
    // The original never held a map, so nothing was taken from it...
    expect(original.map ?? null).toBeNull();
    // ...and the material that DID hold one never had it cleared — it was discarded intact.
    expect(clone.map).toBeInstanceOf(FakeVideoTexture);
    expect(videoTextureCount(state)).toBe(0);
  });

  it('restores an authored map exactly, by object identity', () => {
    const authored = new FakeTexture();
    const original = new FakeMaterial();
    original.map = authored;
    const mesh = fakeMesh(original);
    const id = spawnVideo(mesh);

    sync(world, state);
    expect(matOf(mesh).map).toBeInstanceOf(FakeVideoTexture);

    elements.delete(id);
    sync(world, state);

    expect(matOf(mesh)).toBe(original);
    expect(matOf(mesh).map).toBe(authored);
  });

  it('survives a stop/start cycle — the case a user hits by replaying a clip', () => {
    const original = new FakeMaterial();
    const mesh = fakeMesh(original);
    const id = spawnVideo(mesh);

    sync(world, state);
    elements.delete(id);
    sync(world, state);
    expect(matOf(mesh)).toBe(original);

    elements.set(id, fakeElement());  // played again
    sync(world, state);

    expect(matOf(mesh)).not.toBe(original);
    expect(matOf(mesh).map).toBeInstanceOf(FakeVideoTexture);
    expect(original.map ?? null).toBeNull();
    expect(videoTextureCount(state)).toBe(1);
  });

  it('disposeVideoTextures restores every mesh and drops the table', () => {
    const a = new FakeMaterial();
    const b = new FakeMaterial();
    const meshA = fakeMesh(a), meshB = fakeMesh(b);
    spawnVideo(meshA); spawnVideo(meshB);
    sync(world, state);

    disposeVideoTextures(state);

    expect(matOf(meshA)).toBe(a);
    expect(matOf(meshB)).toBe(b);
    expect(a.map ?? null).toBeNull();
    expect(b.map ?? null).toBeNull();
    expect(videoTextureCount(state)).toBe(0);
  });
});

describe('syncVideoTextures — holding the slot against syncMaterial', () => {
  /** `syncMaterial` re-binds an entity's resolved `.mat.json` material every frame once the
   *  async load settles. Without a re-assert that silently drops the clone and the screen goes
   *  blank — the failure the clone approach could have introduced, so it is pinned. */
  it('re-asserts the clone when something re-binds the base material mid-frame', () => {
    const original = new FakeMaterial();
    const mesh = fakeMesh(original);
    spawnVideo(mesh);
    sync(world, state);
    const clone = matOf(mesh);

    mesh.material = original;        // stand-in for syncMaterial's per-frame re-bind
    sync(world, state);

    expect(matOf(mesh)).toBe(clone);
    expect(matOf(mesh).map).toBeInstanceOf(FakeVideoTexture);
    expect(videoTextureCount(state)).toBe(1);
  });

  /** The slot SHAPE can change under a live binding (single ⇄ array). Re-asserting blindly
   *  is worse than not re-asserting: for a single-material binding it overwrites a freshly
   *  assigned material ARRAY with one stale clone (destroying the other slots), and for an
   *  array binding it silently no-ops and strands a binding nothing can restore. Both must
   *  instead drop the binding and re-derive from what the mesh looks like NOW. */
  it('does not clobber a material ARRAY that replaced the single slot it was bound to', () => {
    const original = new FakeMaterial();
    const mesh = fakeMesh(original);
    spawnVideo(mesh);
    sync(world, state);                       // bound to the single slot

    const a = new FakeMaterial(), b = new FakeMaterial();
    mesh.material = [a, b];                   // the mesh became multi-material
    sync(world, state);

    const mats = mesh.material as FakeMaterial[];
    expect(Array.isArray(mesh.material), 'the array must survive').toBe(true);
    expect(mats).toHaveLength(2);
    expect(mats[1]).toBe(b);                  // the other slot is untouched
    expect(mats[0]).not.toBe(a);              // slot 0 re-bound from the NEW base
    expect(mats[0].map).toBeInstanceOf(FakeVideoTexture);
    expect(a.map ?? null).toBeNull();         // ...and that new base was not mutated
  });

  it('re-binds instead of stranding when an array slot collapses to a single material', () => {
    const slot0 = new FakeMaterial(), slot1 = new FakeMaterial();
    const mesh = fakeMesh();
    mesh.material = [slot0, slot1];
    spawnVideo(mesh);
    sync(world, state);

    const replacement = new FakeMaterial();
    mesh.material = replacement;              // collapsed to a single material
    sync(world, state);

    expect(matOf(mesh)).not.toBe(replacement);
    expect(matOf(mesh).map).toBeInstanceOf(FakeVideoTexture);
    expect(replacement.map ?? null).toBeNull();
    expect(videoTextureCount(state)).toBe(1);
  });

  it('rebuilds from the NEW base when the material ref genuinely changes', () => {
    const original = new FakeMaterial();
    const mesh = fakeMesh(original);
    spawnVideo(mesh);
    sync(world, state);

    const replacement = new FakeMaterial();
    replacement.roughness = 0.25;    // distinguishable, so we can prove which base was cloned
    mesh.material = replacement;
    sync(world, state);

    const bound = matOf(mesh);
    expect(bound).not.toBe(replacement);              // still a clone, not the shared object
    expect(bound.roughness).toBe(0.25);               // ...cloned from the NEW base
    expect(bound.map).toBeInstanceOf(FakeVideoTexture);
    expect(replacement.map ?? null).toBeNull();
  });
});

describe('syncVideoTextures — multi-material meshes', () => {
  it('binds slot 0 and restores it without disturbing the other slots', () => {
    const slot0 = new FakeMaterial();
    const slot1 = new FakeMaterial();
    const mesh = fakeMesh();
    mesh.material = [slot0, slot1];
    const id = spawnVideo(mesh);

    sync(world, state);
    const mats = mesh.material as FakeMaterial[];
    expect(mats[0]).not.toBe(slot0);
    expect(mats[0].map).toBeInstanceOf(FakeVideoTexture);
    expect(mats[1]).toBe(slot1);

    elements.delete(id);
    sync(world, state);

    expect((mesh.material as FakeMaterial[])[0]).toBe(slot0);
    expect((mesh.material as FakeMaterial[])[1]).toBe(slot1);
    expect(slot0.map ?? null).toBeNull();
  });
});

describe('syncVideoTextures — the clone keeps its base alive (#318)', () => {
  it('stamps the bound clone with the material it was cloned from', () => {
    // Only `.map` is replaced; every other slot the base carries — normalMap, roughnessMap,
    // emissiveMap — is still a SHARED texture reference. `sweepRetiredMaterials` frees a retired
    // base once no MESH binds it, and after this swap no mesh binds the base: the clone does. The
    // stamp is what makes the sweep count that as holding the base, so a `.mat.json` re-import
    // cannot release textures this clone is drawing with.
    //
    // Asserted here rather than through the sweep because that needs a real THREE.Scene, which
    // this suite's fakes deliberately do not build; `materialCloneInvalidation.test.ts` drives the
    // sweep against the stamp itself.
    const original = new FakeMaterial();
    const mesh = fakeMesh(original);
    spawnVideo(mesh);

    sync(world, state);

    expect(matOf(mesh)).not.toBe(original);
    expect(derivedBaseOf(matOf(mesh) as never)).toBe(original);
  });

  it('re-stamps against the NEW base when the material ref changes underneath', () => {
    // The rebuild path (`current !== existing.original`) makes a second clone; a stamp applied
    // only on the first bind would leave that one pointing at a base nothing uses any more.
    const original = new FakeMaterial();
    const mesh = fakeMesh(original);
    spawnVideo(mesh);
    sync(world, state);

    const replacement = new FakeMaterial();
    replacement.roughness = 0.25;
    mesh.material = replacement;
    sync(world, state);

    expect(derivedBaseOf(matOf(mesh) as never)).toBe(replacement);
  });
});
