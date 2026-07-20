/**
 * Procedurally generate skinned-model test assets for the P6 shared clip library.
 *
 * Emits THREE glb files under games/3d-test/runtime/assets/models/skinned-test/,
 * all built on the SAME 3-bone vertical chain (bone0→bone1→bone2, named
 * identically so animation tracks bind across models by bone name):
 *
 *   - cylinder.glb — a cylinder SkinnedMesh, NO clips (a bare rig)
 *   - cone.glb     — a cone SkinnedMesh, NO clips (a bare rig)
 *   - clips.glb    — a tiny rig carrying ONLY the 3 shared clips: bent / shrink / stretch
 *
 * Plus shared.animset.json (source = clips.glb, the 3 clips with per-clip params)
 * and a demo scene skinned-test.json that places the cylinder + cone side by side,
 * each with an AnimationLibrary → shared.animset. Neither display model owns a
 * clip; both play the library's clips — the cross-model P6 demonstration.
 *
 * Re-run any time:  node engine/scripts/gen-skinned-test-models.mjs
 */

import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// GLTFExporter's binary path uses the browser FileReader to read its Blob. Node
// has a global Blob (18+) with .arrayBuffer(), so bridge it with a minimal shim.
if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class {
    readAsArrayBuffer(blob) {
      blob.arrayBuffer()
        .then((buf) => { this.result = buf; this.onloadend?.(); })
        .catch((err) => { this.onerror?.(err); });
    }
  };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../..');
const OUT_DIR = path.join(REPO, 'games/3d-test/runtime/assets/models/skinned-test');
const SCENE_DIR = path.join(REPO, 'games/3d-test/runtime/assets/scenes');

// Stable GUIDs (committed; the scene + animset reference these).
const GUID = {
  cylinder: 'c0111111-0000-4a00-8000-000000000001',
  cone:     'c0222222-0000-4a00-8000-000000000002',
  clips:    'c0333333-0000-4a00-8000-000000000003',
  capsule:  'c0444444-0000-4a00-8000-000000000004', // FOREIGN rig (bones joint0/1/2)
  animset:  'a0555555-0000-4a00-8000-000000000005',
  scene:    'a0666666-0000-4a00-8000-000000000006',
  camera:   'a0666666-0000-4a00-8000-0000000000c1',
  ambient:  'a0666666-0000-4a00-8000-0000000000a1',
  sun:      'a0666666-0000-4a00-8000-0000000000d1',
  cylEnt:   'a0666666-0000-4a00-8000-0000000000e1',
  coneEnt:  'a0666666-0000-4a00-8000-0000000000e2',
  capEnt:   'a0666666-0000-4a00-8000-0000000000e3',
  boneEnt:  'a0666666-0000-4a00-8000-0000000000f1', // P7b Bone entity (cylinder bone1) — driven by a LateUpdate
  boneChild:'a0666666-0000-4a00-8000-0000000000f2', // sphere parented UNDER that bone (rides it)
};

const MODEL_HEIGHT = 3;     // mesh spans y ∈ [0, 3]
const BONE_SPACING = 1;     // bone0 @ y0, bone1 @ y1, bone2 @ y2

// The canonical (library) bone names + a FOREIGN naming for the retarget demo.
// Same structure, different names → the capsule needs a bone map to play the
// library's clips (whose tracks target bone0/1/2).
const RIG_BONES = ['bone0', 'bone1', 'bone2'];
const ALT_BONES = ['joint0', 'joint1', 'joint2'];

/** Build a 3-bone vertical chain with the given names. Same geometry every time;
 *  only the names differ (so a foreign-named rig is structurally identical). */
function buildRig(names = RIG_BONES) {
  const b0 = new THREE.Bone(); b0.name = names[0]; b0.position.set(0, 0, 0);
  const b1 = new THREE.Bone(); b1.name = names[1]; b1.position.set(0, BONE_SPACING, 0);
  const b2 = new THREE.Bone(); b2.name = names[2]; b2.position.set(0, BONE_SPACING, 0);
  b0.add(b1); b1.add(b2);
  return [b0, b1, b2];
}

/** Linear skin weights along Y: vertex at height y blends between the two bones
 *  that bracket it (bone0@0, bone1@1, bone2@2; anything above 2 → bone2). */
function applySkinning(geo) {
  const pos = geo.attributes.position;
  const idx = [];
  const wgt = [];
  for (let i = 0; i < pos.count; i++) {
    const t = Math.max(0, Math.min(2, pos.getY(i))); // clamp to [0, 2]
    const lower = Math.min(1, Math.floor(t));        // 0 or 1 (keeps upper ≤ 2)
    const upper = lower + 1;
    const frac = t - lower;
    idx.push(lower, upper, 0, 0);
    wgt.push(1 - frac, frac, 0, 0);
  }
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(wgt, 4));
}

/** Assemble a SkinnedMesh on a fresh copy of the 3-bone rig (optionally with
 *  foreign bone names, for the retarget demo). */
function makeSkinnedModel(geometry, color, meshName, boneNames = RIG_BONES) {
  applySkinning(geometry);
  const material = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.0 });
  const mesh = new THREE.SkinnedMesh(geometry, material);
  mesh.name = meshName;

  const bones = buildRig(boneNames);
  const root = new THREE.Group();
  root.name = `${meshName}_Root`;
  root.add(bones[0]);
  root.add(mesh);
  root.updateMatrixWorld(true);          // bones at rest BEFORE Skeleton computes inverses

  const skeleton = new THREE.Skeleton(bones);
  mesh.bind(skeleton);
  return root;
}

/** Cylinder + cone geometries spanning y ∈ [0, 3] (base at origin). */
function cylinderGeo() {
  const g = new THREE.CylinderGeometry(0.5, 0.5, MODEL_HEIGHT, 24, 12);
  g.translate(0, MODEL_HEIGHT / 2, 0);
  return g;
}
function coneGeo() {
  const g = new THREE.ConeGeometry(0.7, MODEL_HEIGHT, 24, 12);
  g.translate(0, MODEL_HEIGHT / 2, 0);
  return g;
}
/** Capsule for the FOREIGN-rig retarget demo (radius 0.5 + length 2 = height 3). */
function capsuleGeo() {
  const g = new THREE.CapsuleGeometry(0.5, MODEL_HEIGHT - 1, 6, 20);
  g.translate(0, MODEL_HEIGHT / 2, 0);
  return g;
}

// ── Shared animation clips (authored on bone tracks, loop 0→pose→0) ──────────
const TIMES = [0, 0.6, 1.2];
const DURATION = 1.2;

function quat(deg) {
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, THREE.MathUtils.degToRad(deg)));
}
const ID = [0, 0, 0, 1];

function buildClips() {
  // bent — progressively rotate the upper two bones about Z, then back.
  const bent = new THREE.AnimationClip('bent', DURATION, [
    new THREE.QuaternionKeyframeTrack('bone1.quaternion', TIMES, [...ID, ...quat(32).toArray(), ...ID]),
    new THREE.QuaternionKeyframeTrack('bone2.quaternion', TIMES, [...ID, ...quat(32).toArray(), ...ID]),
  ]);
  // shrink — uniform scale of the root bone 1 → 0.5 → 1.
  const shrink = new THREE.AnimationClip('shrink', DURATION, [
    new THREE.VectorKeyframeTrack('bone0.scale', TIMES, [1, 1, 1, 0.5, 0.5, 0.5, 1, 1, 1]),
  ]);
  // stretch — squash-and-stretch of the root bone (tall + thin, then back).
  const stretch = new THREE.AnimationClip('stretch', DURATION, [
    new THREE.VectorKeyframeTrack('bone0.scale', TIMES, [1, 1, 1, 0.7, 1.8, 0.7, 1, 1, 1]),
  ]);
  return [bent, shrink, stretch];
}

/** The clip-library rig: a tiny (never-displayed) skinned box on the shared rig,
 *  carrying the 3 clips. Both display models pull clips from here by bone name. */
function makeClipsLibrary() {
  const g = new THREE.BoxGeometry(0.05, MODEL_HEIGHT, 0.05);
  g.translate(0, MODEL_HEIGHT / 2, 0);
  return makeSkinnedModel(g, 0x888888, 'ClipCarrier');
}

// ── glTF export ──────────────────────────────────────────────────────────────
function exportGLB(root, animations) {
  return new Promise((resolve, reject) => {
    root.updateMatrixWorld(true);
    new GLTFExporter().parse(
      root,
      (result) => resolve(Buffer.from(result)),
      (err) => reject(err),
      { binary: true, animations, onlyVisible: false, includeCustomExtensions: false },
    );
  });
}

function writeMeta(glbName, id, clipNames) {
  const meta = { version: 2, id };
  if (clipNames && clipNames.length) meta.rig = { clips: clipNames };
  // Binary assets carry a sidecar named "<file>.<ext>.meta.json" (e.g. cone.glb.meta.json).
  fs.writeFileSync(path.join(OUT_DIR, `${glbName}.glb.meta.json`), JSON.stringify(meta, null, 2) + '\n');
}

function ea(name, guid, sortOrder = 0, parentId = 0, layer = '') {
  return { name, isActive: true, sortOrder, parentId, layer, guid };
}
function transform(x, y, z, rx = 0, ry = 0, rz = 0, s = 1) {
  return { x, y, z, rx, ry, rz, sx: s, sy: s, sz: s };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const clips = buildClips();
  const clipNames = clips.map((c) => c.name);

  const assets = [
    { name: 'cylinder', root: makeSkinnedModel(cylinderGeo(), 0x4f8bff, 'CylinderMesh'), anims: [], id: GUID.cylinder, clips: [] },
    { name: 'cone',     root: makeSkinnedModel(coneGeo(),     0xff9a3c, 'ConeMesh'),     anims: [], id: GUID.cone,     clips: [] },
    // Foreign rig: structurally identical, but bones named joint0/1/2 → needs a bone map to retarget.
    { name: 'capsule',  root: makeSkinnedModel(capsuleGeo(),  0x57d08a, 'CapsuleMesh', ALT_BONES), anims: [], id: GUID.capsule, clips: [] },
    { name: 'clips',    root: makeClipsLibrary(),                                        anims: clips, id: GUID.clips,  clips: clipNames },
  ];

  for (const a of assets) {
    const buf = await exportGLB(a.root, a.anims);
    fs.writeFileSync(path.join(OUT_DIR, `${a.name}.glb`), buf);
    writeMeta(a.name, a.id, a.clips);
    console.log(`  ✓ ${a.name}.glb (${(buf.length / 1024).toFixed(1)} KB)${a.anims.length ? ` + ${a.anims.length} clips` : ''}`);
  }

  // shared.animset.json — per-clip playback params; source = clips.glb.
  const animset = {
    id: GUID.animset,
    source: GUID.clips,
    clips: [
      { name: 'bent',    speed: 1,   loop: true, fadeDuration: 0.2 },
      { name: 'shrink',  speed: 1,   loop: true, fadeDuration: 0.2 },
      { name: 'stretch', speed: 0.9, loop: true, fadeDuration: 0.2 },
    ],
  };
  fs.writeFileSync(path.join(OUT_DIR, 'shared.animset.json'), JSON.stringify(animset, null, 2) + '\n');
  console.log('  ✓ shared.animset.json');

  // Demo scene — three shapes pulling clips from ONE shared library. Cylinder +
  // cone share the library's bone names (direct bind). The capsule is a FOREIGN
  // rig (bones joint0/1/2): it plays the same clips via a bone map + retarget.
  const skinnedEntity = (id, name, guid, modelGuid, x, clip, boneMaps) => ({
    id,
    name,
    traits: {
      Transform: transform(x, 0, 0),
      SkinnedModel: { model: modelGuid, isActive: true },
      // animSet left empty: the library supplies BOTH the clips and their params.
      SkeletalAnimator: { animSet: '', clip, playing: true, speed: 1, loop: true, fadeDuration: 0 },
      // A non-empty boneMaps[animset] implies retargeting for that animset.
      AnimationLibrary: { animSets: [GUID.animset], retarget: false, boneMaps: boneMaps ?? {} },
      EntityAttributes: ea(name, guid, 10, 0, ''),
    },
  });
  // The foreign rig's bone map: THIS rig's bone → the library's (source) bone.
  const capsuleBoneMap = { [GUID.animset]: { joint0: 'bone0', joint1: 'bone1', joint2: 'bone2' } };

  const CYL_ID = 4, BONE_ID = 7;   // entry ids referenced by parentId (loader remaps to runtime ids)
  const scene = {
    id: GUID.scene,
    version: 8,
    resources: [
      { type: 'riggedModel', path: GUID.cylinder },
      { type: 'riggedModel', path: GUID.cone },
      { type: 'riggedModel', path: GUID.capsule },
      { type: 'animset', path: GUID.animset },
    ],
    entities: [
      {
        id: 1,
        name: 'Camera',
        traits: {
          Transform: transform(0, 2, 11, -0.12, 0, 0),
          Camera: { fov: 55, near: 0.1, far: 100, overlayDistance: 3, clearColor: 0x20242e },
          EntityAttributes: ea('Camera', GUID.camera, 20, 0, '3d'),
        },
      },
      {
        id: 2,
        name: 'Ambient Light',
        traits: {
          Transform: transform(0, 0, 0),
          Light: { lightType: 'ambient', color: 0xffffff, intensity: 0.7, targetX: 0, targetY: 0, targetZ: 0, distance: 0, angle: 0.5, penumbra: 0, castShadow: false },
          EntityAttributes: ea('Ambient Light', GUID.ambient, 50, 0, ''),
        },
      },
      {
        id: 3,
        name: 'Sun',
        traits: {
          Transform: transform(4, 6, 5, -0.9, 0.6, 0),
          Light: { lightType: 'directional', color: 0xffffff, intensity: 1.6, targetX: 0, targetY: 1, targetZ: 0, distance: 0, angle: 0.5, penumbra: 0, castShadow: false },
          EntityAttributes: ea('Sun', GUID.sun, 51, 0, ''),
        },
      },
      // Cylinder (bent, direct bind) ── Cone (stretch, direct bind) ── Capsule
      // (bent, FOREIGN rig retargeted via bone map): cylinder + capsule bend in
      // sync from the same clip — the A/B proof retargeting works.
      skinnedEntity(CYL_ID, 'Cylinder', GUID.cylEnt, GUID.cylinder, -3.5, 'bent'),
      skinnedEntity(5, 'Cone', GUID.coneEnt, GUID.cone, 0, 'stretch'),
      skinnedEntity(6, 'Capsule (foreign rig)', GUID.capEnt, GUID.capsule, 3.5, 'bent', capsuleBoneMap),
      // P7b — the cylinder's bone1 as a real ECS entity (child of the cylinder). The
      // "bent" clip poses it (read-back mirrors the pose onto this entity); the sphere
      // below is parented UNDER it and rides along. Proves bones-as-entities + a child
      // following a bone. (To drive a bone FROM code, register a LateUpdate that targets
      // a SPECIFIC entity — NOT all bones by name, which collides across models.)
      {
        id: BONE_ID,
        name: 'Cylinder bone1',
        traits: {
          Transform: transform(0, 0, 0),
          Bone: { name: 'bone1' },
          EntityAttributes: ea('Cylinder bone1', GUID.boneEnt, 12, CYL_ID, ''),
        },
      },
      // A sphere parented UNDER the bone entity — it rides bone1 via normal
      // transform propagation (no BoneAttachment needed). Proves "parent an entity
      // to a bone as a child".
      {
        id: 8,
        name: 'Bone child marker',
        traits: {
          Transform: transform(0, 1, 0),  // local offset above bone1
          Renderable3DPrimitive: { mesh: 'sphere', color: 0xffe14d, size: 0.5, material: '', isActive: true },
          EntityAttributes: ea('Bone child marker', GUID.boneChild, 13, BONE_ID, ''),
        },
      },
    ],
  };
  fs.mkdirSync(SCENE_DIR, { recursive: true });
  fs.writeFileSync(path.join(SCENE_DIR, 'skinned-test.json'), JSON.stringify(scene, null, 2) + '\n');
  console.log('  ✓ scenes/skinned-test.json');
  console.log('\nDone. Open the 3d-test project and load scenes/skinned-test.json.');
}

main().catch((e) => { console.error(e); process.exit(1); });
