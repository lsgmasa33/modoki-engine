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
const { baseOf } = await import('../../src/runtime/rendering/lightMaskVariants');

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
  userData: Record<string, unknown> = {};
  clone(): FakeMaterial {
    const c = new FakeMaterial();
    c.map = this.map;
    c.roughness = this.roughness;
    // ⚠️ Faithful to `THREE.Material.copy()` ON PURPOSE, and the fidelity is what makes the #325
    // tests mean anything: three deep-copies `userData` through `JSON.parse(JSON.stringify(...))`,
    // which FLATTENS a Material parked in there into a plain document. A fake that copied
    // `userData` by reference (or not at all) would let a bare `.clone()` pass the very assertions
    // written to catch it — the first version of this fixture did exactly that, and the
    // "does not JSON-round-trip" test below passed against the unfixed code.
    c.userData = JSON.parse(JSON.stringify(this.userData));
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

/** What `applyLightMask` leaves on a masked mesh, in the shape the two properties that matter
 *  actually have: `lightsNode` and `customProgramCacheKey` are OWN properties assigned after the
 *  clone, and the base Material object itself is parked in `userData.__lightMaskBase`.
 *
 *  `FakeMaterial.clone()` copies neither own property, on purpose — so if `cloneDerived`'s
 *  own-property carry stops running, the #325 tests fail rather than passing on three's `copy()`
 *  doing the work for us.
 *
 *  ONE copy, shared by the #325 and #352 blocks (close-out review). There were two, with
 *  different signatures and only one carrying this warning — so a real variant growing another
 *  own property would have been modelled by one fixture and silently not by the other. */
function fakeVariant(base: FakeMaterial, sel = '0,2') {
  const v = new FakeMaterial() as FakeMaterial & {
    lightsNode: unknown; customProgramCacheKey: () => string; userData: Record<string, unknown>;
  };
  v.lightsNode = { sel };                         // shared per selection — carried by REFERENCE
  v.customProgramCacheKey = () => `|lightmask:${sel}`;
  v.userData = { __lightMaskBase: base };
  return v;
}

beforeEach(() => {
  world = createWorld();
  state = { ecsObjects: new Map() };
  elements.clear();
});
afterEach(() => {
  disposeVideoTextures(state);
  // koota allocates world IDs from a pool of 16 and `createWorld` THROWS once it is exhausted, so
  // a suite that only ever creates them has a hard ceiling on its own test count. This one reached
  // 16 and the next three tests added failed on `Too many worlds created` — a failure that names
  // koota rather than the test, and lands on whoever adds the 17th case.
  world.destroy();
  vi.restoreAllMocks();
});

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

describe('syncVideoTextures — cloning a LIGHT-MASK VARIANT (#325)', () => {
  it('carries lightsNode and customProgramCacheKey onto the video clone', () => {
    // THE correctness bug. Without these two the clone hashes to the BASE's pipeline key — the
    // #136 collision — and renders lit by every light, silently ignoring the authored mask.
    const base = new FakeMaterial();
    const variant = fakeVariant(base);
    const mesh = fakeMesh(variant);
    spawnVideo(mesh);

    sync(world, state);

    const bound = matOf(mesh) as FakeMaterial & {
      lightsNode: unknown; customProgramCacheKey: () => string;
    };
    expect(bound).not.toBe(variant);                        // still a private clone
    expect(bound.map).toBeInstanceOf(FakeVideoTexture);     // still carrying the video
    expect(bound.lightsNode).toBe(variant.lightsNode);      // same node — NOT a copy
    expect(bound.customProgramCacheKey()).toBe('|lightmask:0,2');
  });

  it('does not SERIALISE the base Material parked in userData', () => {
    // Asserted at the mechanism, not at the value. The obvious assertion — "`__lightMaskBase` is
    // still the Material" — passes under BOTH hypotheses, because `inheritMaskBase` rewrites that
    // key a line after the clone regardless of what the clone did to `userData`. (It was written
    // that way first, and review caught it passing against the unfixed code.)
    //
    // What actually distinguishes them is whether the round-trip HAPPENED: `JSON.stringify` calls
    // `toJSON()` on anything that has one, so a base that counts its own serialisations answers
    // yes-or-no with nothing in between. In production this is `Texture.toJSON` firing per texture
    // slot — `THREE.Texture: Unable to serialize Texture.` for a compressed one.
    const base = new FakeMaterial();
    let serialised = 0;
    (base as unknown as { toJSON: () => unknown }).toJSON = () => { serialised++; return {}; };
    const mesh = fakeMesh(fakeVariant(base));
    spawnVideo(mesh);

    sync(world, state);

    expect(serialised).toBe(0);
    // …and the parked base is still reachable as the Material object itself.
    expect((matOf(mesh) as unknown as { userData: Record<string, unknown> })
      .userData.__lightMaskBase).toBe(base);
  });

  it('answers baseOf with the variant\'s base, not with itself', () => {
    // This is what keeps the two systems at a FIXED POINT. `applyLightMask` re-derives every frame
    // from `baseOf(mesh.material)` and keys the variant cache on `${base.uuid}|${sel}`. Inheriting
    // the base keeps that key stable, so the lookup HITS and the same variant object comes back.
    // Answering with the clone instead keys on the clone's own uuid, misses, mints a variant of
    // the clone — which this module then does not recognise, so it rebuilds, which mints a new
    // clone, forever: a material and a pipeline per frame.
    const base = new FakeMaterial();
    const mesh = fakeMesh(fakeVariant(base));
    spawnVideo(mesh);

    sync(world, state);
    const bound = matOf(mesh);

    expect(baseOf(bound as never)).toBe(base);
    expect(baseOf(bound as never)).not.toBe(bound);
  });

  it('settles: re-asserting the variant each frame mints no further clones', () => {
    // The whole frame loop, as the two systems actually run it: the renderable pass puts the
    // variant back (its cache hit returns the same object), then this module re-asserts its clone.
    // Neither side may allocate after the first frame.
    const base = new FakeMaterial();
    const variant = fakeVariant(base);
    const mesh = fakeMesh(variant);
    spawnVideo(mesh);

    sync(world, state);
    const first = matOf(mesh);

    for (let frame = 0; frame < 10; frame++) {
      mesh.material = variant;   // what applyLightMask does on a cache hit
      sync(world, state);
      expect(matOf(mesh)).toBe(first);
    }
    expect(first.disposed).toBe(false);
    expect(videoTextureCount(state)).toBe(1);
  });

  it('rebuilds against the NEW variant when the mask selection changes', () => {
    // The one case that SHOULD re-clone: a different selection is a different variant object, so
    // the clone's carried lightsNode is stale and must be replaced.
    //
    // ⚠️ This pins that the rebuild is CORRECT — it says nothing about what the rebuild COSTS.
    // It used to dispose and recreate the `VideoTexture` too, which made a flapping selection pay
    // a GPU texture every frame; that half is fixed (#352) and pinned by the block below, which is
    // where the texture-identity assertions live. Keep this test material-only.
    const base = new FakeMaterial();
    const mesh = fakeMesh(fakeVariant(base, '0,2'));
    spawnVideo(mesh);
    sync(world, state);

    const moved = fakeVariant(base, '1');
    mesh.material = moved;
    sync(world, state);

    const bound = matOf(mesh) as FakeMaterial & { customProgramCacheKey: () => string };
    expect(bound.customProgramCacheKey()).toBe('|lightmask:1');
    expect(baseOf(bound as never)).toBe(base);      // still the base, not the superseded variant
  });
});

describe('syncVideoTextures — the texture follows the ELEMENT, not the material (#352)', () => {
  it('keeps the SAME VideoTexture across a mask-selection change', () => {
    // The decoupling, at its smallest. The material legitimately changed and the clone must be
    // re-derived — but nothing about the VIDEO did, so the texture has no reason to be rebuilt.
    const base = new FakeMaterial();
    const mesh = fakeMesh(fakeVariant(base, '0,2'));
    spawnVideo(mesh);
    sync(world, state);
    const first = matOf(mesh).map as FakeVideoTexture;

    mesh.material = fakeVariant(base, '1');
    sync(world, state);

    expect(matOf(mesh).map).toBe(first);          // the SAME texture object, not an equal one
    expect(first.dispose).not.toHaveBeenCalled();
  });

  it('mints exactly ONE texture across a selection that flaps for 10 frames', () => {
    // The regression that matters, asserted as the MEASUREMENT it came from. Before the fix this
    // read 10 distinct textures and 10 disposes — a GPU create+destroy every frame, indefinitely,
    // because `maskForObject` has no hysteresis and the validity test compared against a single
    // remembered material. Counted by identity rather than by `videoTextureCount`, which reports
    // the binding-table SIZE and stays at 1 through the whole churn — it cannot see this.
    const base = new FakeMaterial();
    const a = fakeVariant(base, '0,2');
    const b = fakeVariant(base, '1');
    const mesh = fakeMesh(a);
    spawnVideo(mesh);

    const textures = new Set<unknown>();
    for (let frame = 0; frame < 10; frame++) {
      mesh.material = frame % 2 === 0 ? a : b;    // what applyLightMask does on a cache hit
      sync(world, state);
      textures.add(matOf(mesh).map);
    }

    expect(textures.size).toBe(1);
    expect([...textures][0]).toBeInstanceOf(FakeVideoTexture);
    expect((([...textures][0]) as FakeVideoTexture).dispose).not.toHaveBeenCalled();
  });

  it('still re-derives the CLONE from the new variant while carrying the texture', () => {
    // Carrying the texture must not turn into carrying the material. The clone has to come from
    // whatever is on the slot NOW, or a selection change would keep rendering the old lighting —
    // trading a texture churn for a silent correctness bug.
    const base = new FakeMaterial();
    const mesh = fakeMesh(fakeVariant(base, '0,2'));
    spawnVideo(mesh);
    sync(world, state);
    const firstClone = matOf(mesh);

    const moved = fakeVariant(base, '1');
    mesh.material = moved;
    sync(world, state);

    const bound = matOf(mesh) as FakeMaterial & {
      lightsNode: unknown; customProgramCacheKey: () => string;
    };
    expect(bound).not.toBe(firstClone);                   // a new clone...
    expect(bound).not.toBe(moved);                        // ...still private, not the shared one
    expect(bound.lightsNode).toBe(moved.lightsNode);      // ...carrying the NEW selection
    expect(bound.customProgramCacheKey()).toBe('|lightmask:1');
    expect(firstClone.disposed).toBe(true);               // and the superseded one is released
  });

  it('does NOT take the map off the superseded variant — the #192 rule survives the new path', () => {
    // `rebindMaterial` is a second route by which a material leaves our hands. The cardinal rule
    // is the same on it as on `release`: nothing is handed back to the renderer map-free.
    const base = new FakeMaterial();
    const first = fakeVariant(base, '0,2');
    const mesh = fakeMesh(first);
    spawnVideo(mesh);
    sync(world, state);

    const second = fakeVariant(base, '1');
    mesh.material = second;
    sync(world, state);

    expect(first.map ?? null).toBeNull();      // never had one, never given one, never cleared
    expect(second.map ?? null).toBeNull();     // we cloned it, we did not mutate it
    expect(first.disposed).toBe(false);        // the shared variant is the cache's, not ours
    expect(second.disposed).toBe(false);
  });

  it('declines a map-less replacement instead of forcing a map onto it', () => {
    // The carry path is a SHORTCUT around `videoTargetOf`, which is where the `'map' in material`
    // guard lives. Without re-checking it here the shortcut would accept a material the full path
    // refuses — inventing a `.map` on something three never monitors for one.
    const mesh = fakeMesh(new FakeMaterial());
    spawnVideo(mesh);
    sync(world, state);

    const mapless = { roughness: 0.5, userData: {}, needsUpdate: false } as unknown as FakeMaterial;
    mesh.material = mapless;                 // no `map` property at all
    sync(world, state);

    expect(matOf(mesh)).toBe(mapless);       // left alone, not cloned and not given a map
    expect('map' in (mapless as object)).toBe(false);
    expect(videoTextureCount(state)).toBe(0);
  });

  it('SETTLES after a one-shot material change — no clone per frame afterwards', () => {
    // The guard the block was missing, found by the close-out review. Deleting `b.original = next`
    // from `rebindMaterial` — the bookkeeping that makes a rebind ONE-SHOT — passed all 25 tests
    // including every other test here. Without it `original` stays at the pre-change material, so
    // every later frame re-enters the rebind: a `dispose()` (which tears down that material's
    // RenderObject and bind groups in the WebGPU renderer), a fresh `cloneDerived`, and a
    // `needsUpdate`, forever, on a scene that is standing perfectly still.
    //
    // That is #352's own defect shape — unbounded per-frame churn — merely relocated from the
    // texture to the material. The #325 block has exactly this test for its path ("settles:
    // re-asserting the variant each frame mints no further clones"); this one did not.
    const base = new FakeMaterial();
    const mesh = fakeMesh(fakeVariant(base, '0,2'));
    spawnVideo(mesh);
    sync(world, state);

    const moved = fakeVariant(base, '1');
    mesh.material = moved;
    sync(world, state);
    const settled = matOf(mesh);

    for (let frame = 0; frame < 5; frame++) {
      mesh.material = moved;          // applyLightMask cache HIT: the same object every frame
      sync(world, state);
      expect(matOf(mesh)).toBe(settled);
    }
    expect(settled.disposed).toBe(false);
  });

  it('keeps the rVFC upload pump driving the carried texture across a rebind', () => {
    // The fix's central design claim — "the pump closes over the Bound record, which is mutated
    // IN PLACE rather than replaced, so uploads carry on" — was asserted in three comment blocks,
    // a doc bullet and a commit message, and exercised by NOTHING: jsdom has no
    // `requestVideoFrameCallback`, so `driveUploads` returns early and every other test in this
    // file runs three's per-frame fallback with `rvfcHandle` 0.
    //
    // Replacing the Bound instead of mutating it would leave the pump driving the OLD record's
    // texture — which the rebuild would have disposed — and nothing would have said so.
    const pending: (() => void)[] = [];
    const el = fakeElement() as HTMLVideoElement & {
      requestVideoFrameCallback: (cb: () => void) => number;
      cancelVideoFrameCallback: (h: number) => void;
    };
    let next = 1;
    el.requestVideoFrameCallback = vi.fn((cb: () => void) => { pending.push(cb); return next++; });
    el.cancelVideoFrameCallback = vi.fn();

    const base = new FakeMaterial();
    const mesh = fakeMesh(fakeVariant(base, '0,2'));
    const id = spawnVideo(mesh);
    elements.set(id, el);                    // an element that HAS rVFC, unlike the default fake
    sync(world, state);

    expect(pending.length).toBe(1);          // the pump registered at bind
    const texture = matOf(mesh).map as FakeVideoTexture;

    mesh.material = fakeVariant(base, '1');  // the selection moves — rebind, carrying the texture
    sync(world, state);
    expect(matOf(mesh).map).toBe(texture);

    texture.needsUpdate = false;
    pending.shift()!();                      // the decoder presents a frame AFTER the rebind

    expect(texture.needsUpdate).toBe(true);           // ...and the pump still drives it
    expect(matOf(mesh).map).toBe(texture);            // ...on the material now in the slot
    expect(texture.dispose).not.toHaveBeenCalled();
    expect(pending.length).toBe(1);                   // and it re-armed itself for the next frame
  });

  it('STILL rebuilds the texture when the ELEMENT changes — the decoupling is not a free-for-all', () => {
    // The guard against over-applying the fix. A new element is a new decoder, so the old texture
    // is genuinely dead and must be disposed; only the MATERIAL's identity was ever the wrong
    // reason to throw one away.
    const mesh = fakeMesh(new FakeMaterial());
    const id = spawnVideo(mesh);
    sync(world, state);
    const first = matOf(mesh).map as FakeVideoTexture;

    elements.set(id, fakeElement());     // clip swapped — a different HTMLVideoElement
    sync(world, state);

    expect(matOf(mesh).map).not.toBe(first);
    expect(first.dispose).toHaveBeenCalled();
  });
});
