/** materialInstanceClones — INTEGRATION test against REAL three.js materials. The
 *  system unit test uses a material stub; this verifies the actual THREE semantics the
 *  prop path relies on: clone() yields an independent MeshStandardMaterial, color.setHex
 *  works, transparent toggles with opacity, the shared base is never mutated, entities get
 *  independent clones, and the registry frees/rebuilds. The base material is passed IN (the
 *  caller resolves it from the entity's GUID), so a base swap re-clones cleanly. No renderer
 *  / GPU needed — Material classes are pure JS. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as THREE from 'three';
import { applyPropOverride, resetMaterialInstanceClones } from '../../src/runtime/rendering/materialInstanceClones';

// A mesh is just an object with a `.material` for this helper.
const mesh = (material: THREE.Material | THREE.Material[]) =>
  ({ material } as unknown as THREE.Mesh);

beforeEach(() => resetMaterialInstanceClones());

describe('applyPropOverride (real THREE materials)', () => {
  it('binds an independent clone and drives opacity without touching the base', () => {
    const base = new THREE.MeshStandardMaterial({ opacity: 1, transparent: false });
    const m = mesh(base);
    applyPropOverride(1, [m], base, 'opacity', 0.3);

    expect(m.material).not.toBe(base);
    expect(m.material).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect((m.material as THREE.MeshStandardMaterial).opacity).toBeCloseTo(0.3, 9);
    expect((m.material as THREE.MeshStandardMaterial).transparent).toBe(true);
    // Shared base is pristine.
    expect(base.opacity).toBe(1);
    expect(base.transparent).toBe(false);
  });

  it('drives color as a packed hex via Color.setHex', () => {
    const base = new THREE.MeshStandardMaterial({ color: 0x000000 });
    const m = mesh(base);
    applyPropOverride(2, [m], base, 'color', 0x3366ff);
    expect((m.material as THREE.MeshStandardMaterial).color.getHex()).toBe(0x3366ff);
    expect(base.color.getHex()).toBe(0x000000); // base untouched
  });

  it('drives roughness / metalness / emissiveIntensity as scalars', () => {
    const base = new THREE.MeshStandardMaterial({ roughness: 0, metalness: 0, emissiveIntensity: 1 });
    const m = mesh(base);
    applyPropOverride(3, [m], base, 'roughness', 0.7);
    applyPropOverride(3, [m], base, 'metalness', 0.4);
    applyPropOverride(3, [m], base, 'emissiveIntensity', 2);
    const clone = m.material as THREE.MeshStandardMaterial;
    expect(clone.roughness).toBeCloseTo(0.7, 9);
    expect(clone.metalness).toBeCloseTo(0.4, 9);
    expect(clone.emissiveIntensity).toBeCloseTo(2, 9);
  });

  it('ignores an unsupported target without touching material internals', () => {
    const base = new THREE.MeshStandardMaterial();
    const m = mesh(base);
    const clone0 = (base.clone()); // reference for comparing internals
    applyPropOverride(4, [m], base, 'side', 99);      // unknown/dangerous target → no-op
    const clone = m.material as THREE.MeshStandardMaterial;
    expect(clone.side).toBe(clone0.side);             // internal NOT overwritten with 99
  });

  it('gives two entities sharing a base INDEPENDENT clones', () => {
    const base = new THREE.MeshStandardMaterial({ opacity: 1 });
    const a = mesh(base), b = mesh(base);
    applyPropOverride(10, [a], base, 'opacity', 0.2);
    applyPropOverride(11, [b], base, 'opacity', 0.8);
    expect(a.material).not.toBe(b.material);
    expect((a.material as THREE.MeshStandardMaterial).opacity).toBeCloseTo(0.2, 9);
    expect((b.material as THREE.MeshStandardMaterial).opacity).toBeCloseTo(0.8, 9);
  });

  it('binds ONE clone across an entity\'s two meshes (both surfaces) — no dispose thrash', () => {
    const base = new THREE.MeshStandardMaterial({ opacity: 1 }); // shared cache material
    const a = mesh(base), b = mesh(base);
    applyPropOverride(12, [a, b], base, 'opacity', 0.25);
    expect(a.material).toBe(b.material);      // same single clone
    expect(a.material).not.toBe(base);
    // A second frame with the SAME base must not re-clone or dispose.
    const clone = a.material;
    applyPropOverride(12, [a, b], base, 'opacity', 0.25);
    expect(a.material).toBe(clone);
    expect((clone as THREE.MeshStandardMaterial).opacity).toBeCloseTo(0.25, 9);
  });

  it('re-clones when the resolved base changes (ref swap / async load), disposing the old', () => {
    const baseA = new THREE.MeshStandardMaterial({ opacity: 1 });
    const baseB = new THREE.MeshStandardMaterial({ opacity: 1 });
    const m = mesh(baseA);
    applyPropOverride(13, [m], baseA, 'opacity', 0.5);
    const cloneA = m.material as THREE.MeshStandardMaterial;
    expect(cloneA.opacity).toBeCloseTo(0.5, 9);
    applyPropOverride(13, [m], baseB, 'opacity', 0.5); // base changed
    const cloneB = m.material as THREE.MeshStandardMaterial;
    expect(cloneB).not.toBe(cloneA);          // fresh clone from the new base
    expect(cloneB.opacity).toBeCloseTo(0.5, 9);
  });

  it('applies multiple prop overrides onto the SAME single clone', () => {
    const base = new THREE.MeshStandardMaterial();
    const m = mesh(base);
    applyPropOverride(20, [m], base, 'opacity', 0.5);
    const clone = m.material;
    applyPropOverride(20, [m], base, 'roughness', 0.9); // second prop, same frame/entity
    expect(m.material).toBe(clone); // not re-cloned
    expect((clone as THREE.MeshStandardMaterial).opacity).toBeCloseTo(0.5, 9);
    expect((clone as THREE.MeshStandardMaterial).roughness).toBeCloseTo(0.9, 9);
  });

  it('recompiles (needsUpdate) only when the transparent flag flips, not every frame', () => {
    const base = new THREE.MeshStandardMaterial({ opacity: 1, transparent: false });
    const m = mesh(base);
    applyPropOverride(50, [m], base, 'opacity', 0.5); // opaque → transparent: one recompile
    const clone = m.material as THREE.MeshStandardMaterial;
    const v1 = clone.version;
    applyPropOverride(50, [m], base, 'opacity', 0.4); // still transparent: NO recompile
    expect(clone.version).toBe(v1);
    expect(clone.transparent).toBe(true);
    applyPropOverride(50, [m], base, 'opacity', 1);   // transparent → opaque: recompile
    expect(clone.version).toBeGreaterThan(v1);
    expect(clone.transparent).toBe(false);
  });

  it('drives a multi-material (array) base via per-slot clones on every slot', () => {
    const baseArr = [new THREE.MeshStandardMaterial({ opacity: 1 }), new THREE.MeshStandardMaterial({ opacity: 1 })];
    const m = mesh(baseArr);
    applyPropOverride(30, [m], baseArr, 'opacity', 0.4);
    const clones = m.material as THREE.MeshStandardMaterial[];
    expect(Array.isArray(clones)).toBe(true);
    expect(clones).not.toBe(baseArr);              // a fresh array of clones
    expect(clones[0]).not.toBe(baseArr[0]);
    expect(clones[0].opacity).toBeCloseTo(0.4, 9); // every slot driven
    expect(clones[1].opacity).toBeCloseTo(0.4, 9);
    expect(baseArr[0].opacity).toBe(1);            // bases untouched
  });

  it('drives map offset/repeat (Vector2 sub-props) when the material has a base map', () => {
    const base = new THREE.MeshStandardMaterial();
    base.map = new THREE.Texture();
    const m = mesh(base);
    applyPropOverride(31, [m], base, 'mapOffsetX', 0.25);
    applyPropOverride(31, [m], base, 'mapRepeatY', 3);
    const clone = m.material as THREE.MeshStandardMaterial;
    expect(clone.map!.offset.x).toBeCloseTo(0.25, 9);
    expect(clone.map!.repeat.y).toBeCloseTo(3, 9);
    expect(base.map!.offset.x).toBe(0); // base texture untouched (clone has its own)
  });

  it('no-ops (no throw) for a map target on a material without a base map', () => {
    const base = new THREE.MeshStandardMaterial(); // no .map
    const m = mesh(base);
    expect(() => applyPropOverride(32, [m], base, 'mapOffsetX', 0.5)).not.toThrow();
  });

  it('clones the base map ONCE per material and frees it when the clone is superseded', () => {
    const base = new THREE.MeshStandardMaterial();
    base.map = new THREE.Texture();
    const m = mesh(base);
    applyPropOverride(60, [m], base, 'mapOffsetX', 0.1);
    const ownedTex = (m.material as THREE.MeshStandardMaterial).map!;
    expect(ownedTex).not.toBe(base.map);               // per-material texture clone
    const disposeSpy = vi.spyOn(ownedTex, 'dispose');
    applyPropOverride(60, [m], base, 'mapRepeatY', 2);  // second map prop, SAME base
    expect((m.material as THREE.MeshStandardMaterial).map).toBe(ownedTex); // NOT re-cloned
    expect(disposeSpy).not.toHaveBeenCalled();
    // Base change → the superseded clone AND its owned texture are disposed.
    const base2 = new THREE.MeshStandardMaterial();
    base2.map = new THREE.Texture();
    applyPropOverride(60, [m], base2, 'mapOffsetX', 0.3);
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(base.map!.dispose).toBeTypeOf('function'); // base texture never disposed (its own instance)
  });

  it('disposes an owned map texture on registry reset (world swap)', () => {
    const base = new THREE.MeshStandardMaterial();
    base.map = new THREE.Texture();
    const m = mesh(base);
    applyPropOverride(61, [m], base, 'mapOffsetX', 0.2);
    const ownedTex = (m.material as THREE.MeshStandardMaterial).map!;
    const disposeSpy = vi.spyOn(ownedTex, 'dispose');
    resetMaterialInstanceClones();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it('disposes EVERY slot clone when a multi-material base changes', () => {
    const baseArr = [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial()];
    const m = mesh(baseArr);
    applyPropOverride(70, [m], baseArr, 'opacity', 0.4);
    const [c0, c1] = m.material as THREE.MeshStandardMaterial[];
    const s0 = vi.spyOn(c0, 'dispose'), s1 = vi.spyOn(c1, 'dispose');
    const baseArr2 = [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial()];
    applyPropOverride(70, [m], baseArr2, 'opacity', 0.6); // base ref changed → old slots freed
    expect(s0).toHaveBeenCalledTimes(1);
    expect(s1).toHaveBeenCalledTimes(1);
  });

  it('gives two entities sharing a multi-material base INDEPENDENT per-slot clones', () => {
    const baseArr = [new THREE.MeshStandardMaterial({ opacity: 1 }), new THREE.MeshStandardMaterial({ opacity: 1 })];
    const a = mesh(baseArr), b = mesh(baseArr);
    applyPropOverride(71, [a], baseArr, 'opacity', 0.2);
    applyPropOverride(72, [b], baseArr, 'opacity', 0.8);
    const ca = a.material as THREE.MeshStandardMaterial[];
    const cb = b.material as THREE.MeshStandardMaterial[];
    expect(ca[0]).not.toBe(cb[0]);
    expect(ca[1]).not.toBe(cb[1]);
    expect(ca[0].opacity).toBeCloseTo(0.2, 9);
    expect(ca[1].opacity).toBeCloseTo(0.2, 9);
    expect(cb[0].opacity).toBeCloseTo(0.8, 9);
    expect(baseArr[0].opacity).toBe(1); // shared bases untouched
  });

  it('does NOT dispose a driven clone merely by ceasing to drive it — only reset() frees it (per-scene invariant)', () => {
    const base = new THREE.MeshStandardMaterial({ opacity: 1 });
    const m = mesh(base);
    applyPropOverride(80, [m], base, 'opacity', 0.5);
    const clone = m.material as THREE.MeshStandardMaterial;
    const disposeSpy = vi.spyOn(clone, 'dispose');

    // Stop calling applyPropOverride for this entity (the system no longer drives it). There is NO
    // per-entity release — the clone stays resident, undisposed, until the scene (world) swaps.
    expect(disposeSpy).not.toHaveBeenCalled();

    // Only a world swap / resetMaterialInstanceClones() frees it — then exactly once.
    resetMaterialInstanceClones();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it('rebuilds the clone after a reset (registry cleared)', () => {
    const base = new THREE.MeshStandardMaterial();
    const m = mesh(base);
    applyPropOverride(40, [m], base, 'opacity', 0.5);
    const first = m.material;
    resetMaterialInstanceClones();
    m.material = base; // simulate the render loop rebinding the base after teardown
    applyPropOverride(40, [m], base, 'opacity', 0.5);
    expect(m.material).not.toBe(first); // a fresh clone, not the disposed one
    expect(m.material).not.toBe(base);
  });
});
