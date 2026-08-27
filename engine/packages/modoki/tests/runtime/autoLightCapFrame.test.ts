/** The per-frame driver for the automatic light cap (#188 item 7) —
 *  `runtime/rendering/autoLightCapFrame.ts`.
 *
 *  The pure rule (`autoLightCap.ts`) has had its own tests since #121 P3c. What was missing, and
 *  what these cover, is the WIRING: that the cap engages only when it should, that it composes
 *  with an artist's authored masks rather than overriding them, and that it publishes lights in
 *  the identity space the mask variants resolve against. Every one of those was unreachable while
 *  the module was imported by nothing. */

import { describe, it, expect, afterEach } from 'vitest';
import * as THREE from 'three';
import {
  armAutoLightCap, autoCapMaskFor, isAutoLightCapEngaged, getAutoLightCapStats,
  resetAutoLightCapFrame,
} from '../../src/runtime/rendering/autoLightCapFrame';
import { DEFAULT_RENDERING_LAYER_MASK, type MaskedLight } from '../../src/runtime/rendering/lightMaskVariants';
import { TIER_SETTINGS } from '../../src/runtime/rendering/qualityTier';

afterEach(() => resetAutoLightCapFrame());

/** A light at a world position. `updateMatrixWorld` is what the cap reads — see the module's note
 *  on why a local position cannot answer "nearest". */
function point(x: number, y: number, z: number, intensity = 1, mask = DEFAULT_RENDERING_LAYER_MASK): MaskedLight {
  const l = new THREE.PointLight(0xffffff, intensity);
  l.position.set(x, y, z);
  l.updateMatrixWorld(true);
  return { light: l, mask };
}
function directional(intensity: number, color = 0xffffff, mask = DEFAULT_RENDERING_LAYER_MASK): MaskedLight {
  const l = new THREE.DirectionalLight(color, intensity);
  l.updateMatrixWorld(true);
  return { light: l, mask };
}
function ambient(intensity = 0.2): MaskedLight {
  const l = new THREE.AmbientLight(0xffffff, intensity);
  l.updateMatrixWorld(true);
  return { light: l, mask: DEFAULT_RENDERING_LAYER_MASK };
}
const bitsOf = (mask: number) => {
  const out: number[] = [];
  for (let i = 0; i < 31; i++) if ((mask >> i) & 1) out.push(i);
  return out;
};

describe('engaging at all', () => {
  it('stays OFF when the scene already fits the tier — the common path is untouched', () => {
    // The census says nearly every scene is like this: one directional, few locals. `low` caps at
    // 1+1, and this scene has 1+1, so nothing is restricted and no synthetic mask is published.
    const lights = [ambient(), directional(1), point(0, 0, 0)];
    expect(armAutoLightCap(lights, TIER_SETTINGS.low)).toBe(false);
    expect(isAutoLightCapEngaged()).toBe(false);
    expect(lights.every((l) => l.mask === DEFAULT_RENDERING_LAYER_MASK)).toBe(true);
    // ...and an object's mask is handed back exactly as authored.
    expect(autoCapMaskFor(DEFAULT_RENDERING_LAYER_MASK, 0, 0, 0)).toBe(DEFAULT_RENDERING_LAYER_MASK);
  });

  it('can NEVER engage on `high` — its caps are 0, meaning unlimited', () => {
    const many = [ambient(), directional(1), directional(2), point(0, 0, 0), point(5, 0, 0), point(9, 0, 0)];
    expect(armAutoLightCap(many, TIER_SETTINGS.high)).toBe(false);
  });

  it('engages on `low` once the scene exceeds the caps', () => {
    const lights = [ambient(), directional(1), point(0, 0, 0), point(5, 0, 0)];
    expect(armAutoLightCap(lights, TIER_SETTINGS.low)).toBe(true);
    expect(getAutoLightCapStats()).toMatchObject({ engaged: true, lights: 4 });
  });

  it('DISENGAGES past 31 lights rather than capping the wrong ones', () => {
    // A 32-bit mask cannot address more than that individually, and a partial cap would silently
    // drop whichever lights fell off the end — a rendering bug that looks like an art bug.
    const lights = [ambient(), directional(1), ...Array.from({ length: 40 }, (_, i) => point(i, 0, 0))];
    expect(armAutoLightCap(lights, TIER_SETTINGS.low)).toBe(false);
  });

  it('DISENGAGES on a light type the rule cannot classify, leaving it lit', () => {
    // Hemisphere/rect-area are not in the rule's vocabulary. Keeping the scene fully lit is the
    // failure direction that looks like a missed optimisation; guessing is the one that looks
    // like a black object.
    const hemi = new THREE.HemisphereLight(0xffffff, 0x404040, 1);
    hemi.updateMatrixWorld(true);
    const lights = [ambient(), directional(1), point(0, 0, 0), point(5, 0, 0), { light: hemi, mask: DEFAULT_RENDERING_LAYER_MASK }];
    expect(armAutoLightCap(lights, TIER_SETTINGS.low)).toBe(false);
  });
});

describe('what it selects', () => {
  it('keeps all ambient, the most EFFECTIVE directional, and the nearest local', () => {
    const lights = [
      ambient(),                    // 0 — never capped
      directional(2, 0x0000ff),     // 1 — brighter, but deep blue: low luminance
      directional(1, 0xffffff),     // 2 — the one a viewer would call the key light
      point(100, 0, 0),             // 3 — far
      point(1, 0, 0),               // 4 — near
    ];
    expect(armAutoLightCap(lights, TIER_SETTINGS.low)).toBe(true);
    expect(bitsOf(autoCapMaskFor(DEFAULT_RENDERING_LAYER_MASK, 0, 0, 0))).toEqual([0, 2, 4]);
  });

  it('picks a DIFFERENT local light for an object at the other end of the scene', () => {
    // The per-object half of the rule. Directionals have no position, so they are chosen once
    // scene-wide; only point/spot vary.
    const lights = [ambient(), directional(1), point(-50, 0, 0), point(50, 0, 0)];
    expect(armAutoLightCap(lights, TIER_SETTINGS.low)).toBe(true);
    expect(bitsOf(autoCapMaskFor(DEFAULT_RENDERING_LAYER_MASK, -49, 0, 0))).toEqual([0, 1, 2]);
    expect(bitsOf(autoCapMaskFor(DEFAULT_RENDERING_LAYER_MASK, 49, 0, 0))).toEqual([0, 1, 3]);
  });

  it('reads the light\'s WORLD position, not its local one', () => {
    // A light parented to a moving rig has a local position that says nothing about where it is,
    // and "nearest" is the entire selection rule.
    const rig = new THREE.Group();
    rig.position.set(100, 0, 0);
    const near = new THREE.PointLight(0xffffff, 1);   // local (0,0,0) → world (100,0,0)
    rig.add(near);
    const far = new THREE.PointLight(0xffffff, 1);
    far.position.set(1, 0, 0);                        // world (1,0,0)
    rig.updateMatrixWorld(true);
    far.updateMatrixWorld(true);
    const lights: MaskedLight[] = [
      ambient(), directional(1),
      { light: near, mask: DEFAULT_RENDERING_LAYER_MASK },
      { light: far, mask: DEFAULT_RENDERING_LAYER_MASK },
    ];
    expect(armAutoLightCap(lights, TIER_SETTINGS.low)).toBe(true);
    // An object at the origin is nearest to `far` (world 1,0,0) — reading local positions would
    // have picked `near`, whose LOCAL position is the origin itself.
    expect(bitsOf(autoCapMaskFor(DEFAULT_RENDERING_LAYER_MASK, 0, 0, 0))).toEqual([0, 1, 3]);
  });

  it('`mid` keeps more than `low` — the ladder is visible in the selection, not just the table', () => {
    // Big enough that BOTH tiers engage (3 directional + 4 local exceeds mid's 2+3 as well as
    // low's 1+1) — a scene that already fits mid would simply not engage there, which is a true
    // statement about the tier but says nothing about the selection.
    const build = (): MaskedLight[] => [
      ambient(),                                                     // 0
      directional(3), directional(2), directional(1),                // 1,2,3
      point(0, 0, 0), point(1, 0, 0), point(2, 0, 0), point(50, 0, 0), // 4,5,6,7
    ];
    const low = build();
    expect(armAutoLightCap(low, TIER_SETTINGS.low)).toBe(true);
    const lowBits = bitsOf(autoCapMaskFor(DEFAULT_RENDERING_LAYER_MASK, 0, 0, 0));
    resetAutoLightCapFrame();
    const mid = build();
    expect(armAutoLightCap(mid, TIER_SETTINGS.mid)).toBe(true);
    const midBits = bitsOf(autoCapMaskFor(DEFAULT_RENDERING_LAYER_MASK, 0, 0, 0));
    expect(lowBits).toEqual([0, 1, 4]);              // ambient + brightest directional + nearest local
    expect(midBits).toEqual([0, 1, 2, 4, 5, 6]);     // 2 directional + 3 nearest locals
    // The far light is dropped by BOTH — the point of the rule.
    expect(lowBits).not.toContain(7);
    expect(midBits).not.toContain(7);
  });
});

describe('composing with an ARTIST\'s authored masks', () => {
  it('never hands back a light the author masked away', () => {
    // The composition rule, and the reason it is an intersection rather than a replacement: the
    // cap is an automatic fallback for scenes that authored nothing, and it must not overrule the
    // one scene that did.
    const LAYER_A = 0b01;
    const LAYER_B = 0b10;
    const lights = [
      ambient(),                                   // 0 — layer A (default)
      directional(1),                              // 1 — layer A
      point(0, 0, 0, 1, LAYER_B),                  // 2 — layer B ONLY: not for a layer-A object
      point(1, 0, 0, 1, LAYER_A),                  // 3 — layer A, slightly farther
      point(9, 0, 0, 1, LAYER_A),                  // 4 — layer A, far. TWO locals on layer A, so a
    ];                                             //     layer-A object does NOT already fit and
                                                   //     must go through the composition.
    expect(armAutoLightCap(lights, TIER_SETTINGS.low)).toBe(true);
    // Light 2 is NEAREST of all, so choosing globally and intersecting afterwards would pick it,
    // then delete it — leaving the object with NO local light. Restricting the candidates first
    // gives the nearest one it is ALLOWED to see: light 3.
    expect(bitsOf(autoCapMaskFor(LAYER_A, 0, 0, 0))).toEqual([0, 1, 3]);
    // ...and a layer-B object sees the layer-B light.
    expect(bitsOf(autoCapMaskFor(LAYER_B, 0, 0, 0))).toEqual([2]);
  });

  it('republishes lights under IDENTITY masks so the variant cache resolves the selection', () => {
    // Two mask spaces: authored masks are LAYERS (several lights can share one), the cap names
    // individual lights. Publishing `1 << i` is what makes `lightsForMask` return exactly the
    // cap's choice.
    const lights = [ambient(), directional(1), point(0, 0, 0), point(9, 0, 0)];
    armAutoLightCap(lights, TIER_SETTINGS.low);
    expect(lights.map((l) => l.mask)).toEqual([1, 2, 4, 8]);
  });
});

describe('an object whose authored selection already fits is LEFT ALONE', () => {
  it('hands back the authored bits unchanged rather than re-capping them', () => {
    // MEASURED, not assumed. On a Galaxy A23 with demos/postfx-demo — the one project that authors
    // masks — capping an already-culled object anyway ran the GPU at 6.29ms against 5.18ms
    // uncapped, and cost +1.8ms of CPU: a per-object "nearest local" selection splits objects that
    // shared an authored selection into MORE material variants, and every variant is a pipeline.
    const LAYER_A = 0b01, LAYER_B = 0b10;
    const lights = [
      ambient(),                            // 0 — both layers? no: default layer = A
      directional(1),                       // 1 — layer A
      point(0, 0, 0, 1, LAYER_B),           // 2 — layer B
      point(1, 0, 0, 1, LAYER_B),           // 3 — layer B
      point(2, 0, 0, 1, LAYER_B),           // 4 — layer B
    ];
    // Globally this exceeds low's 1+1 (three locals), so the cap engages...
    expect(armAutoLightCap(lights, TIER_SETTINGS.low)).toBe(true);
    // ...but a LAYER_A object only sees ambient + 1 directional + 0 locals, which already fits.
    // It must get exactly its authored selection back — same lights, hence the same variant.
    expect(bitsOf(autoCapMaskFor(LAYER_A, 0, 0, 0))).toEqual([0, 1]);
    // A LAYER_B object sees three locals and no directional, so it IS capped to the nearest one.
    expect(bitsOf(autoCapMaskFor(LAYER_B, 0, 0, 0))).toEqual([2]);
  });

  it('still caps an unauthored object in the same frame — the test is per object, not per scene', () => {
    const lights = [ambient(), directional(1), point(0, 0, 0), point(1, 0, 0), point(2, 0, 0)];
    expect(armAutoLightCap(lights, TIER_SETTINGS.low)).toBe(true);
    expect(bitsOf(autoCapMaskFor(DEFAULT_RENDERING_LAYER_MASK, 0, 0, 0))).toEqual([0, 1, 2]);
  });
});

describe('hysteresis across frames (#353)', () => {
  const WITH_MARGIN = { ...TIER_SETTINGS.low, hysteresisMargin: 0.2 };

  it('an object with no identity key gets no memory — same as today', () => {
    // The SAME underlying lights both frames (no reset in between, matching every real frame) —
    // if `autoCapMaskFor` ever fell back to some shared/default key when `objKey` is omitted,
    // reusing the same lights (rather than resetting) is what would let that leak show up here.
    const amb = ambient(), dir = directional(1);
    const near = point(0, 0, 0), far = point(10, 0, 0);
    const build = () => [
      { light: amb.light, mask: amb.mask }, { light: dir.light, mask: dir.mask },
      { light: near.light, mask: near.mask }, { light: far.light, mask: far.mask },
    ];
    // Frame 1: object sits at x=0, nearest is `near`.
    armAutoLightCap(build(), WITH_MARGIN);
    expect(bitsOf(autoCapMaskFor(DEFAULT_RENDERING_LAYER_MASK, 0, 0, 0))).toEqual([0, 1, 2]);
    // Frame 2: the object drifts to a near tie (d²=27.04 vs 23.04) — without a key to remember
    // it by, the raw-nearest light (`far`) wins outright, same as before this fix.
    armAutoLightCap(build(), WITH_MARGIN);
    expect(bitsOf(autoCapMaskFor(DEFAULT_RENDERING_LAYER_MASK, 5.2, 0, 0))).toEqual([0, 1, 3]);
  });

  // The SAME underlying THREE lights every frame, matching the real caller: `armAutoLightCap`'s
  // hysteresis memory is keyed on light IDENTITY (`sameLightIdentity`, #353 review) precisely so
  // a removed/reordered light can't silently misapply someone else's incumbent — which means a
  // test that wants the memory to survive across frames must reuse the same `.light` instances,
  // not rebuild them. `armAutoLightCap` also MUTATES `.mask` to a synthetic identity (see its own
  // doc comment), so each frame gets a FRESH wrapper array (fresh `{light, mask}` records) around
  // those same persistent lights — exactly what `scene3DSync` rebuilds every frame from the ECS.
  const rigLights = () => [ambient(), directional(1), point(0, 0, 0), point(10, 0, 0)];
  const rig = (persistent: ReturnType<typeof rigLights>) =>
    persistent.map((l) => ({ light: l.light, mask: l.mask }));

  it('an object WITH an identity key keeps its incumbent through the same near tie', () => {
    const persistent = rigLights();
    const entity = {}; // stands in for the caller's THREE.Object3D
    armAutoLightCap(rig(persistent), WITH_MARGIN);
    expect(bitsOf(autoCapMaskFor(DEFAULT_RENDERING_LAYER_MASK, 0, 0, 0, entity))).toEqual([0, 1, 2]);
    // `armAutoLightCap` rebuilds the frame's light bookkeeping, but NOT the hysteresis memory —
    // it must survive exactly this, since it means nothing otherwise.
    armAutoLightCap(rig(persistent), WITH_MARGIN);
    expect(bitsOf(autoCapMaskFor(DEFAULT_RENDERING_LAYER_MASK, 5.2, 0, 0, entity))).toEqual([0, 1, 2]);
    // ...but a DIFFERENT object at the same position, with no memory of its own, gets the plain
    // nearest-light answer — the memory is per-object, not global.
    expect(bitsOf(autoCapMaskFor(DEFAULT_RENDERING_LAYER_MASK, 5.2, 0, 0, {}))).toEqual([0, 1, 3]);
  });

  it('a clear winner still displaces the incumbent, even with an identity key', () => {
    const persistent = rigLights();
    const entity = {};
    armAutoLightCap(rig(persistent), WITH_MARGIN);
    autoCapMaskFor(DEFAULT_RENDERING_LAYER_MASK, 0, 0, 0, entity); // pt(0,0,0) becomes incumbent
    armAutoLightCap(rig(persistent), WITH_MARGIN);
    expect(bitsOf(autoCapMaskFor(DEFAULT_RENDERING_LAYER_MASK, 9, 0, 0, entity))).toEqual([0, 1, 3]);
  });

  it('a light set that changes shape drops the memory instead of misapplying it (#353 review)', () => {
    // The bug the review caught: `index` is a POSITION, not an identity. Removing a light shifts
    // every LATER light's index down one, so a stored incumbent bit silently starts naming a
    // DIFFERENT light — and the margin discount can make that wrong light win outright.
    const amb = ambient(), dir = directional(1);
    const far = point(100, 0, 0), near = point(0, 0, 0), mid = point(6, 0, 0);
    const entity = {};
    armAutoLightCap(
      [{ light: amb.light, mask: amb.mask }, { light: dir.light, mask: dir.mask },
       { light: far.light, mask: far.mask }, { light: near.light, mask: near.mask },
       { light: mid.light, mask: mid.mask }],
      WITH_MARGIN,
    );
    // At x=2.9: `near` (d²=8.41) beats `mid` (d²=9.61) — `near` (index 3) becomes the incumbent.
    expect(bitsOf(autoCapMaskFor(DEFAULT_RENDERING_LAYER_MASK, 2.9, 0, 0, entity))).toEqual([0, 1, 3]);
    // `far` is removed — `near` shifts from index 3 to index 2, and `mid` from index 4 to index 3.
    // A stale "bit 3 is the incumbent" would now name `mid`, not `near`.
    armAutoLightCap(
      [{ light: amb.light, mask: amb.mask }, { light: dir.light, mask: dir.mask },
       { light: near.light, mask: near.mask }, { light: mid.light, mask: mid.mask }],
      WITH_MARGIN,
    );
    // `near` (now index 2) is still the genuinely nearer light — but a stale bit-3 incumbent would
    // discount `mid`'s d²=9.61 to 7.688 (this file's margin is 0.2), which beats `near`'s
    // undiscounted 8.41 and wins WRONG.
    // Mutation-checked: reverting `sameLightIdentity`'s guard flips this assertion to [0, 1, 3].
    expect(bitsOf(autoCapMaskFor(DEFAULT_RENDERING_LAYER_MASK, 2.9, 0, 0, entity))).toEqual([0, 1, 2]);
  });

  it('an object that FITS for a while does not carry its old incumbent back (#353 review)', () => {
    // The staleness the review flagged: `fits` is a fast path that returns early WITHOUT touching
    // the hysteresis memory — so an incumbent recorded before an object started fitting must not
    // survive to bias it once it stops fitting again.
    const LAYER_A = 0b01, LAYER_B = 0b10;
    const amb = ambient();
    const near = point(0, 0, 0, 1, LAYER_A), mid = point(10, 0, 0, 1, LAYER_A);
    const entity = {};
    const build = (midMask: number) => [
      { light: amb.light, mask: amb.mask },
      { light: near.light, mask: LAYER_A },
      { light: mid.light, mask: midMask },
    ];
    // Frame 1: both eligible under LAYER_A (2 locals > cap 1) — doesn't fit. `near` is the clear
    // winner at x=2.9 and becomes this object's incumbent.
    armAutoLightCap(build(LAYER_A), WITH_MARGIN);
    expect(bitsOf(autoCapMaskFor(LAYER_A, 2.9, 0, 0, entity))).toEqual([0, 1]);
    // Frame 2: `mid` is re-masked off LAYER_A — only `near` is eligible (1 ≤ cap 1) — FITS. The
    // fast path returns without reading OR writing the incumbent memory.
    armAutoLightCap(build(LAYER_B), WITH_MARGIN);
    expect(bitsOf(autoCapMaskFor(LAYER_A, 2.9, 0, 0, entity))).toEqual([0, 1]);
    // Frame 3: `mid` is back on LAYER_A — doesn't fit again. Queried at x=5.2, `mid` is now the
    // genuinely nearer light (d²=23.04 vs `near`'s 27.04) by a gap inside the margin. A stale
    // `near` incumbent surviving frame 2 would discount 27.04 to 21.632 (< 23.04) and win WRONG.
    // Mutation-checked: skipping the fits-path `.delete()` flips this to [0, 1].
    armAutoLightCap(build(LAYER_A), WITH_MARGIN);
    expect(bitsOf(autoCapMaskFor(LAYER_A, 5.2, 0, 0, entity))).toEqual([0, 2]);
  });

  it('the directional flap source is damped the same way, scene-wide', () => {
    // Two directionals whose effectiveness ranking is a near tie that evolves frame to frame as
    // intensity animates — #353's second flap source, independent of any object position. Memory
    // here is NOT reset between frames (only `armAutoLightCap` runs, as it would every real
    // frame) — resetting it would defeat exactly the thing under test. The SAME two directional
    // light instances are reused and only their `.intensity` changes, matching a real light
    // animating in place rather than being replaced.
    const amb = ambient(), dirA = directional(10), dirB = directional(12);
    const ptA = point(0, 0, 0), ptB = point(1, 0, 0);
    const frame = (a: number, b: number) => {
      dirA.light.intensity = a;
      dirB.light.intensity = b;
      const lights = [
        { light: amb.light, mask: amb.mask }, { light: dirA.light, mask: dirA.mask },
        { light: dirB.light, mask: dirB.mask }, { light: ptA.light, mask: ptA.mask },
        { light: ptB.light, mask: ptB.mask },
      ];
      armAutoLightCap(lights, WITH_MARGIN);
      return bitsOf(autoCapMaskFor(DEFAULT_RENDERING_LAYER_MASK, 0, 0, 0));
    };
    expect(frame(10, 12)).toContain(2);   // B (index 2) is clearly ahead — becomes incumbent
    // A edges past B's RAW effectiveness (13 > 12) but not past B's margin-boosted 12*1.2=14.4 —
    // without hysteresis this frame would flip to A every time.
    expect(frame(13, 12)).toContain(2);
    // A pulls clearly ahead of even the boosted incumbent — hysteresis damps flap, it does not
    // freeze the scene forever.
    expect(frame(20, 12)).toContain(1);
  });

  it('two surfaces interleaving arm calls do not wipe each other\'s memory (#353 review)', () => {
    // The editor runs SceneView and the Game panel's Scene3D at once, each with its OWN
    // `ecsLights` map and therefore its OWN `THREE.Light` instances describing the SAME scene —
    // `armAutoLightCap` is called once per surface, every frame, and a module-global memory would
    // see surface A's lights, then surface B's DIFFERENT objects, read every single call as a
    // changed light set, and permanently wipe whichever memory it just wrote.
    const surfaceA = {}, surfaceB = {};
    const objA = {}, objB = {};
    // Two independent light rigs describing the SAME geometry — near@x=0, mid@x=10 — the way two
    // real surfaces each hold their own THREE.Light instances for one authored scene. Persistent
    // underlying lights, fresh WRAPPER arrays per frame (armAutoLightCap mutates `.mask`).
    const makeRig = () => ({ amb: ambient(), dir: directional(1), near: point(0, 0, 0), mid: point(10, 0, 0) });
    const wrap = (r: ReturnType<typeof makeRig>) => [
      { light: r.amb.light, mask: r.amb.mask }, { light: r.dir.light, mask: r.dir.mask },
      { light: r.near.light, mask: r.near.mask }, { light: r.mid.light, mask: r.mid.mask },
    ];
    const rigA = makeRig(), rigB = makeRig();
    // Frame 1, both surfaces: `near` becomes each surface's OWN incumbent at x=2.9.
    armAutoLightCap(wrap(rigA), WITH_MARGIN, surfaceA);
    expect(bitsOf(autoCapMaskFor(DEFAULT_RENDERING_LAYER_MASK, 2.9, 0, 0, objA))).toEqual([0, 1, 2]);
    armAutoLightCap(wrap(rigB), WITH_MARGIN, surfaceB);
    expect(bitsOf(autoCapMaskFor(DEFAULT_RENDERING_LAYER_MASK, 2.9, 0, 0, objB))).toEqual([0, 1, 2]);
    // Frame 2, interleaved the same way: at x=5.2 (the near tie, d²=27.04 vs 23.04) BOTH surfaces
    // must still favour `near` via their own held incumbent — surface A's arm call must not see
    // surface B's DIFFERENT light objects (or vice versa) as "the light set changed" and wipe its
    // memory. A module-global memory fails this: A arms, sees B's stale identity from between the
    // frames, mismatches, wipes; B arms, sees A's, mismatches, wipes — neither ever holds.
    armAutoLightCap(wrap(rigA), WITH_MARGIN, surfaceA);
    expect(bitsOf(autoCapMaskFor(DEFAULT_RENDERING_LAYER_MASK, 5.2, 0, 0, objA))).toEqual([0, 1, 2]);
    armAutoLightCap(wrap(rigB), WITH_MARGIN, surfaceB);
    expect(bitsOf(autoCapMaskFor(DEFAULT_RENDERING_LAYER_MASK, 5.2, 0, 0, objB))).toEqual([0, 1, 2]);
  });
});
