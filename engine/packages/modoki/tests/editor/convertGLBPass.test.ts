// @vitest-environment jsdom
/** convert-pass integration (Missing-Test #8 / F9) — the jsdom-feasible subset.
 *
 *  convertToGLB.test.ts covers the PURE helpers (needsGLBConversion,
 *  toStandardMaterial, stripClipPrefixes). The full pass (OBJ/FBX/DAE loaders +
 *  GLTFExporter + write) is browser/network-bound, but the two pieces F9 + #8 flag
 *  as fragile/untested ARE exercisable in jsdom against the REAL exported functions:
 *
 *    1. Clip survival (F9): export a 2-clip object graph via `exportGLB`, re-parse
 *       the GLB via GLTFLoader, and assert the clip names land — guarding the
 *       export-ordering fragility (stripClipPrefixes mutates names in the same
 *       array exportGLB binds, and that array must survive into the GLB).
 *    2. Unresolved-texture strip (#8): `stripUnresolvedTextures` drops a map whose
 *       image never decoded, and the model still exports cleanly (untextured) —
 *       i.e. one broken texture doesn't fail the whole convert.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import { exportGLB, stripUnresolvedTextures, stripClipPrefixes } from '../../src/editor/scene/convertToGLB';

// GLTFExporter's binary path reads its Blob through the browser FileReader; jsdom
// lacks it but has a Blob with .arrayBuffer(). Bridge with the same minimal shim
// the gen-skinned-test-models script uses. (P6 headless-export gotcha.)
beforeAll(() => {
  if (typeof (globalThis as any).FileReader === 'undefined') {
    (globalThis as any).FileReader = class {
      result: ArrayBuffer | null = null;
      onloadend: (() => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      readAsArrayBuffer(blob: Blob) {
        blob.arrayBuffer()
          .then((buf) => { this.result = buf; this.onloadend?.(); })
          .catch((err) => { this.onerror?.(err); });
      }
    };
  }
});

/** Build a minimal skinned object: a single bone + a SkinnedMesh bound to it, so
 *  animation tracks have a real node target to reference (clips bind by node, and
 *  GLTFExporter only serializes clips whose tracks resolve to nodes in the graph). */
function buildSkinnedObject(): THREE.Object3D {
  const bone = new THREE.Bone();
  bone.name = 'root';
  const skeleton = new THREE.Skeleton([bone]);

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  geom.setAttribute('skinIndex', new THREE.Uint16BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 4));
  geom.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));

  const mesh = new THREE.SkinnedMesh(geom, new THREE.MeshStandardMaterial());
  mesh.name = 'body';
  mesh.add(bone);
  mesh.bind(skeleton);

  const root = new THREE.Group();
  root.add(mesh);
  return root;
}

/** A clip whose track targets the bone node, so the exporter keeps it. */
function clip(name: string): THREE.AnimationClip {
  const track = new THREE.VectorKeyframeTrack('root.position', [0, 1], [0, 0, 0, 0, 1, 0]);
  return new THREE.AnimationClip(name, 1, [track]);
}

/** Re-parse a binary GLB ArrayBuffer back into a gltf result (scene + animations). */
async function parseGLB(buffer: ArrayBuffer): Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] }> {
  const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
  const loader = new GLTFLoader();
  return new Promise((resolve, reject) => {
    loader.parse(buffer, '', (gltf: any) => resolve(gltf), (err: unknown) => reject(err));
  });
}

describe('convert pass — clip survival through export → re-parse (F9 / #8)', () => {
  it('preserves both clip names (with stripped prefixes) into the exported GLB', async () => {
    const object = buildSkinnedObject();
    // FBX-style rig-qualified names; stripClipPrefixes bares them (both unique).
    const animations = [clip('Rig|Walk'), clip('Rig|Idle')];
    stripClipPrefixes(animations);
    expect(animations.map((a) => a.name)).toEqual(['Walk', 'Idle']);

    const glb = await exportGLB(object, animations);
    expect(glb.byteLength).toBeGreaterThan(0);

    const reparsed = await parseGLB(glb);
    const names = reparsed.animations.map((a) => a.name).sort();
    expect(names).toEqual(['Idle', 'Walk']);
  });
});

describe('convert pass — unresolved-texture strip (#8)', () => {
  it('drops a map whose image never decoded and still exports untextured', async () => {
    const object = buildSkinnedObject();
    const mesh = object.children[0] as THREE.Mesh;
    const material = mesh.material as THREE.MeshStandardMaterial;

    // A texture with NO backing image — exactly the "missing sibling file /
    // undecodable embed" case. hasValidImage() returns false → it must be stripped.
    const broken = new THREE.Texture();
    broken.image = undefined as any;
    material.map = broken;

    const stripped = stripUnresolvedTextures(object);
    expect(stripped).toBe(1);
    // The map ref is cleared on the material so the export doesn't throw
    // "No valid image data found".
    expect(material.map).toBeNull();

    // The model still exports cleanly (untextured) — one broken map doesn't fail
    // the whole convert.
    const glb = await exportGLB(object);
    expect(glb.byteLength).toBeGreaterThan(0);
  });

  it('keeps a map whose image is valid', async () => {
    const object = buildSkinnedObject();
    const mesh = object.children[0] as THREE.Mesh;
    const material = mesh.material as THREE.MeshStandardMaterial;

    const good = new THREE.Texture();
    good.image = { width: 4, height: 4, data: new Uint8Array(4 * 4 * 4) } as any;
    material.map = good;

    expect(stripUnresolvedTextures(object)).toBe(0);
    expect(material.map).toBe(good);
  });
});
