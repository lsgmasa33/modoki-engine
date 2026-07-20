/** convertToGLB unit tests — pure helpers: source-format detection and the
 *  legacy-material → MeshStandardMaterial normalization that makes OBJ/FBX/DAE
 *  exports clean PBR. The full convert pass (loaders + GLTFExporter + write) is
 *  browser/network-bound and exercised manually; these cover the deterministic
 *  logic that drives material fidelity and routing. */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { needsGLBConversion, toStandardMaterial, IMPORTABLE_MODEL_EXTS, stripClipPrefixes } from '../../src/editor/scene/convertToGLB';

/** Build clip-like objects with just a mutable name (stripClipPrefixes only
 *  touches `.name`). */
function clips(...names: string[]): THREE.AnimationClip[] {
  return names.map((name) => ({ name } as THREE.AnimationClip));
}

describe('stripClipPrefixes (C9 — per-clip)', () => {
  it('strips the armature prefix from every clip when bare names are unique', () => {
    const a = clips('Rig|Walk', 'Rig|Run', 'Rig|Idle');
    stripClipPrefixes(a);
    expect(a.map((c) => c.name)).toEqual(['Walk', 'Run', 'Idle']);
  });

  it('keeps the rig-qualified name ONLY for the colliding clips, strips the rest', () => {
    // Two clips bare to "Walk"; "Run"/"Idle" are unique → stripped.
    const a = clips('RigA|Walk', 'RigB|Walk', 'Rig|Run', 'Rig|Idle');
    stripClipPrefixes(a);
    expect(a.map((c) => c.name)).toEqual(['RigA|Walk', 'RigB|Walk', 'Run', 'Idle']);
  });

  it('leaves already-bare names unchanged', () => {
    const a = clips('Walk', 'Run');
    stripClipPrefixes(a);
    expect(a.map((c) => c.name)).toEqual(['Walk', 'Run']);
  });
});

describe('needsGLBConversion', () => {
  it('flags OBJ/FBX/DAE sources for conversion', () => {
    expect(needsGLBConversion('/games/x/assets/Mars.obj')).toBe(true);
    expect(needsGLBConversion('/a/b/model.fbx')).toBe(true);
    expect(needsGLBConversion('/a/b/model.dae')).toBe(true);
  });

  it('passes GLB/glTF through unchanged (handled directly by GLTFLoader)', () => {
    expect(needsGLBConversion('/a/b/model.glb')).toBe(false);
    expect(needsGLBConversion('/a/b/model.gltf')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(needsGLBConversion('/a/MARS.OBJ')).toBe(true);
    expect(needsGLBConversion('/a/Model.FBX')).toBe(true);
  });

  it('ignores non-model files', () => {
    expect(needsGLBConversion('/a/b/texture.png')).toBe(false);
    expect(needsGLBConversion('/a/b/scene.json')).toBe(false);
  });

  it('lists all importable model extensions', () => {
    expect(IMPORTABLE_MODEL_EXTS).toEqual(['.glb', '.gltf', '.obj', '.fbx', '.dae']);
  });
});

describe('toStandardMaterial', () => {
  it('returns the same instance for an already-standard material', () => {
    const std = new THREE.MeshStandardMaterial({ color: 0xff0000 });
    expect(toStandardMaterial(std)).toBe(std);
  });

  it('converts MeshPhongMaterial, carrying over color and maps', () => {
    const map = new THREE.Texture();
    const normalMap = new THREE.Texture();
    const phong = new THREE.MeshPhongMaterial({ color: 0x3366cc });
    phong.name = 'mars_surface';
    phong.map = map;
    phong.normalMap = normalMap;

    const std = toStandardMaterial(phong);
    expect(std.isMeshStandardMaterial).toBe(true);
    expect(std.name).toBe('mars_surface');
    expect(std.color.getHex()).toBe(0x3366cc);
    expect(std.map).toBe(map);
    expect(std.normalMap).toBe(normalMap);
    expect(std.metalness).toBe(0);
  });

  it('approximates Phong shininess → roughness (glossier = lower roughness)', () => {
    const glossy = toStandardMaterial(new THREE.MeshPhongMaterial({ shininess: 100 }));
    const matte = toStandardMaterial(new THREE.MeshPhongMaterial({ shininess: 0 }));
    expect(glossy.roughness).toBeLessThan(matte.roughness);
    // Clamped into a sane band so converted assets never read as mirror/dead-flat.
    expect(glossy.roughness).toBeGreaterThanOrEqual(0.3);
    expect(matte.roughness).toBeLessThanOrEqual(1);
  });

  it('defaults MeshLambert/MeshBasic (no shininess) to matte', () => {
    const lambert = toStandardMaterial(new THREE.MeshLambertMaterial({ color: 0x808080 }));
    expect(lambert.isMeshStandardMaterial).toBe(true);
    expect(lambert.roughness).toBe(0.85);
    expect(lambert.metalness).toBe(0);
    expect(lambert.color.getHex()).toBe(0x808080);
  });

  it('preserves transparency and double-sidedness', () => {
    const phong = new THREE.MeshPhongMaterial({ transparent: true, opacity: 0.5 });
    phong.side = THREE.DoubleSide;
    const std = toStandardMaterial(phong);
    expect(std.transparent).toBe(true);
    expect(std.opacity).toBe(0.5);
    expect(std.side).toBe(THREE.DoubleSide);
  });
});
