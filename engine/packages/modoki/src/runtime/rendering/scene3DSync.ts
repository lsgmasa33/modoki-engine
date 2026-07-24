/** Three.js ECS render sync — extracts frame-by-frame sync logic from Scene3D. */

import * as THREE from 'three';
import type { World } from 'koota';
// See SceneView.tsx for the rationale on the published-entry import.
import type { WebGPURenderer } from 'three/webgpu';
import { Transform, Renderable3D, Renderable3DPrimitive, Camera, CameraFrame, Tint, isMaterialInstanced, SkinnedModel, SkinnedMeshRenderer, SkeletalAnimator, AnimationLibrary, BoneAttachment, Bone, Animator, SkinnedSprite2D, Billboard3D, FlatSprite3D, Text3D, TextAnimation } from '../traits';
import { layoutText, type TextQuad } from './text/layoutText';
import { buildTextGeometryByPage, buildTextPositionsByPage, buildTextColorsByPage } from './text/textMesh';
import { applyTextAnimation, isTextAnimating, isColorEffect, type TextAnimParams } from './text/textAnimate';
import { makeMtsdfMaterial, updateMtsdfStyle, type MtsdfStyle } from './text/mtsdfShader';
import { getFontTexture } from './text/fontTextureThree';
import { ensureFontLoaded, getLoadedFont } from './text/fontAtlasLoader';
import { getTextDirtyVersion } from './text/textDirty';
import { getCurrentSceneId } from '../scene/SceneManager';
import { computeFrameFit, boxCornersFromMatrix, type FrameMode, type FrameAnchorV, type FrameAnchorH } from './cameraFraming';
import { getSkin2DBuffer, frameSkin2DUVs, type Skin2DPartBuffer } from '../systems/skin2DBuffers';
import { getKTX2Loader, getEnvFormat } from '../loaders/textureResolver';
import { ULTRAHDR_INTENSITY_BOOST } from '../loaders/environmentSettings';
import { runLateUpdates, hasLateUpdates, type IdempotencyProbe } from '../systems/lateUpdate';
import { EntityAttributes } from '../traits/EntityAttributes';
import { Light } from '../../three/traits/Light';
import { Environment } from '../../three/traits/Environment';
import { Fog } from '../../three/traits/Fog';
import { fog as fogTsl, exponentialHeightFogFactor, uniform, renderGroup } from 'three/tsl';
import { worldTransforms, deactivatedEntities, transformPropagationSystem } from '../../three/systems/transformPropagationSystem';
import { updateSceneLightUniforms } from './sceneLightUniforms';
import { setEntityMeshCollector } from './materialBroker';
import { getAnimationClip } from '../loaders/animationClipCache';
import { resolveActiveClip, resolveClipByName } from '../animation/animClipBank';
import { applyClipAtTime, applyClipAtTimeBlended, buildEntityIndex } from '../animation/sampleClip';
import type { AnimationClipDef } from '../animation/types';
import {
  resolveMeshTemplate, resolveMeshLodInfo, resolveMaterialForMesh, resolveMaterial,
  getCachedEnvironment, acquireEnvironment, onModelInvalidated, getMeshAsset,
} from '../loaders/meshTemplateCache';
import { getRiggedModel, ensureRiggedModelLoaded } from '../loaders/riggedModelCache';
import { getRenderSettings, resolveToneMapping } from './renderSettings';
import { resolveAnimSetParams, ANIMSET_DEFAULTS, getAnimSet } from '../loaders/animSetCache';
import { clone as cloneSkeleton, retargetClip } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { resolveRef } from '../loaders/assetManifest';
import { onWorldSwap, findEntityByGuid, peekCurrentWorld } from '../ecs/world';
import { emit, entityRef } from '../systems/journal';
import { getVisualDelta, getTime } from '../systems/getTime';
import { getPlayState } from '../systems/playState';
import { isSkeletalPreviewing, skeletalPreviewDelta } from '../systems/skeletalPreview';
import { getSkeletalSeek, hasSkeletalSeeks, clearSkeletalSeeks } from '../systems/skeletalSeek';
import { createPrimitiveMesh } from '../loaders/primitives';
import { setActiveRenderer } from '../loaders/textureResolver';
import { PARTICLE_LAYER } from './layers';

// Reused across frames to avoid per-frame allocations
const _activeLightIds = new Set<number>();
const _activeRenderIds = new Set<number>();
const _defaultMaterial = new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.5, metalness: 0 });

// Track materials created inline for specific entities (not from caches).
// Only these are safe to dispose when reassigned — shared cache materials must not be disposed.
const _ownedMaterials = new Set<THREE.Material>();

// Per-(material,color,amount) tinted clones for the Tint trait. Keyed so all
// entities sharing a base material + tint reuse ONE clone (e.g. every ally ship
// shares the blue clone). The clone is a copy of the shared cache material with
// its `.color` set to the tint and `nprColorPreserve` set to the strength — the
// NPR composite then blends the grayscale fill toward that color per-draw.
//
// ASSUMPTION: tints come from a small fixed palette (team colors, highlight
// states). Clones are only freed on scene swap (disposeTintMaterials), so a
// continuously-varying tint (e.g. an animated color) would grow this unbounded.
// The dev warning below surfaces that case.
const _tintMaterials = new Map<string, THREE.Material>();
let _tintCacheWarned = false;

function tintedMaterial(basePath: string, color: number, amount: number): THREE.Material | undefined {
  if (!basePath) return undefined;
  const base = resolveMaterial(basePath);
  if (!base) return undefined; // async load not finished yet — try next frame
  const key = `${basePath}|${color}|${amount}`;
  let clone = _tintMaterials.get(key);
  if (!clone) {
    clone = base.clone();
    (clone as unknown as { color?: THREE.Color }).color?.setHex(color);
    (clone as unknown as { nprColorPreserve: number }).nprColorPreserve = amount;
    _tintMaterials.set(key, clone);
    if (import.meta.env?.DEV && !_tintCacheWarned && _tintMaterials.size > 64) {
      _tintCacheWarned = true;
      console.warn('[Tint] tinted-material cache exceeded 64 entries — Tint.color/amount appear to vary continuously (animated?). Clones are cached per distinct (material,color,amount) and only freed on scene swap, so an animated tint leaks. Prefer a fixed palette.');
    }
  }
  return clone;
}

/** Dispose all tinted-clone materials. Call on scene cleanup / world swap. */
export function disposeTintMaterials() {
  for (const m of _tintMaterials.values()) m.dispose();
  _tintMaterials.clear();
  _tintCacheWarned = false;
}

// Tint clones AND inline-texture materials survive any scene swap because they
// live in module-scope caches, not the refcounted materialCache. Wire their
// disposal into onWorldSwap so a long-running session doesn't accumulate them —
// and, critically, so they're freed regardless of which render loop (runtime
// Scene3D / editor SceneView) happens to be mounted at swap time. These are
// SHARED across all loops, so a single panel's unmount must NOT dispose them
// (that was the F2 use-after-free); world swap is the right boundary because
// every loop rebuilds from the new world together.
// (clearOwnedMaterials is intentionally NOT wired here: it must run AFTER each
// loop's disposeRenderState, which consults _ownedMaterials to decide what to
// dispose — so it stays in the per-instance swap handler.)
onWorldSwap(() => { disposeTintMaterials(); });

// ── Camera sync ─────────────────────────────────────────

/** Set an OrthographicCamera's frustum from a Unity-style `orthoSize` (half the
 *  visible world-height) + the current viewport aspect. Shared by syncCamera and
 *  the resize handler so both stay consistent. */
export function applyOrthoFrustum(cam: THREE.OrthographicCamera, orthoSize: number, aspect: number) {
  const halfH = orthoSize;
  const halfW = orthoSize * aspect;
  if (cam.left === -halfW && cam.right === halfW && cam.top === halfH && cam.bottom === -halfH) return;
  cam.left = -halfW; cam.right = halfW;
  cam.top = halfH; cam.bottom = -halfH;
  cam.updateProjectionMatrix();
}

/** Drive the perspective + orthographic cameras from the ECS `Camera` entity and
 *  return whichever one `Camera.projection` selects (the active render camera).
 *  Transform (pos/rot) is written to BOTH so a live projection toggle is seamless. */
export function syncCamera(
  world: World,
  scene: THREE.Scene,
  persp: THREE.PerspectiveCamera,
  ortho?: THREE.OrthographicCamera,
): THREE.PerspectiveCamera | THREE.OrthographicCamera {
  let active: THREE.PerspectiveCamera | THREE.OrthographicCamera = persp;
  world.query(Transform, Camera).updateEach(([tf, cam], entity) => {
    // Skip deactivated cameras — same convention as syncEnvironment/syncLights.
    // Without this an INACTIVE ortho camera would still be posed here (last-wins,
    // clobbering the active camera's pose) and, worse, flip the whole scene to
    // orthographic (the projection pick below is monotone persp->ortho).
    if (deactivatedEntities.has(entity.id())) return;
    const wt = worldTransforms.get(entity.id());
    const cx = wt ? wt.x : tf.x, cy = wt ? wt.y : tf.y, cz = wt ? wt.z : tf.z;
    const rx = wt ? wt.rx : tf.rx, ry = wt ? wt.ry : tf.ry, rz = wt ? wt.rz : tf.rz;
    persp.position.set(cx, cy, cz);
    persp.rotation.set(rx, ry, rz);
    if (ortho) {
      ortho.position.set(cx, cy, cz);
      ortho.rotation.set(rx, ry, rz);
    }

    if (persp.fov !== cam.fov || persp.near !== cam.near || persp.far !== cam.far) {
      persp.fov = cam.fov;
      persp.near = cam.near;
      persp.far = cam.far;
      persp.updateProjectionMatrix();
    }
    if (ortho) {
      if (ortho.near !== cam.near || ortho.far !== cam.far) {
        ortho.near = cam.near;
        ortho.far = cam.far;
        ortho.updateProjectionMatrix();
      }
      // aspect comes from the live perspective camera (kept current on resize).
      applyOrthoFrustum(ortho, cam.orthoSize, persp.aspect);
      if (cam.projection === 'orthographic') active = ortho;
    }
    // Apply the camera clearColor as the scene background. Read the ACTUAL
    // scene.background (not a module-level cache) so this is per-scene and
    // survives a scene reload that resets the background — a shared cache would
    // skip re-applying when the value is unchanged but the scene was recreated,
    // leaving a stale background in another Scene3D (e.g. the editor GameView).
    // Leave a TEXTURE background alone — that's owned by the Environment sync.
    const cc = cam.clearColor ?? 0x000000;
    const bg = scene.background as THREE.Color | THREE.Texture | null;
    const isColorBg = !!bg && (bg as THREE.Color).isColor === true;
    if (bg == null || (isColorBg && (bg as THREE.Color).getHex() !== cc)) {
      scene.background = new THREE.Color(cc);
    }
  });
  return active;
}

// ── Camera framing (CameraFrame trait) ──────────────────

const _fitMat = new THREE.Matrix4();
const _fitQuat = new THREE.Quaternion();
const _fitEuler = new THREE.Euler();
const _fitScale = new THREE.Vector3();
const _fitPos = new THREE.Vector3();

interface FrameSnapshot {
  id: number; active: boolean;
  mode: FrameMode; autoAim: boolean; continuous: boolean;
  marginTop: number; marginBottom: number; marginLeft: number; marginRight: number;
  anchorV: FrameAnchorV; anchorPosV: number;
  anchorH: FrameAnchorH; anchorPosH: number;
  blendTime: number; blendEase: string;
  x: number; y: number; z: number; rx: number; ry: number; rz: number; sx: number; sy: number; sz: number;
}

export interface ActiveFrameFit {
  /** Entity id of the frame this fit was computed for (lets the caller detect a
   *  runtime active-frame switch and re-fit). */
  frameId: number;
  position: THREE.Vector3;
  orthoSize: number;
  continuous: boolean;
  /** Seconds to blend INTO this frame on a runtime switch (0 = instant cut). */
  blendTime: number;
  /** Easing name for the blend into this frame. */
  blendEase: string;
}

/** The active CameraFrame = the first entity with `active === true` that isn't
 *  deactivated. `active` is a real on/off switch: a frame with active=false is
 *  NEVER used (no "fall back to any frame") so toggling it off releases the
 *  camera. Returns null when no frame is active. */
function selectActiveFrame(world: World): FrameSnapshot | null {
  // Holder (not bare `let`) so TS control-flow doesn't narrow the closure-
  // assigned ref back to its `null` initializer.
  const hold: { f: FrameSnapshot | null } = { f: null };
  world.query(CameraFrame, Transform).updateEach(([frame, tf], entity) => {
    if (hold.f) return;                               // first active wins
    if (!frame.active) return;                        // active=false → not a candidate
    if (deactivatedEntities.has(entity.id())) return; // disabled entity
    hold.f = {
      id: entity.id(), active: frame.active,
      mode: frame.mode as FrameMode, autoAim: frame.autoAim, continuous: frame.continuous,
      marginTop: frame.marginTop, marginBottom: frame.marginBottom,
      marginLeft: frame.marginLeft, marginRight: frame.marginRight,
      anchorV: frame.anchorV as FrameAnchorV, anchorPosV: frame.anchorPosV,
      anchorH: frame.anchorH as FrameAnchorH, anchorPosH: frame.anchorPosH,
      blendTime: frame.blendTime, blendEase: frame.blendEase,
      x: tf.x, y: tf.y, z: tf.z, rx: tf.rx, ry: tf.ry, rz: tf.rz, sx: tf.sx, sy: tf.sy, sz: tf.sz,
    };
  });
  return hold.f;
}

/** Entity id of the active CameraFrame, or null. Cheap enough to poll each frame
 *  so the caller can detect an active-frame switch / removal and re-fit. */
export function activeFrameId(world: World): number | null {
  return selectActiveFrame(world)?.id ?? null;
}

/** Snapshot a specific CameraFrame by entity id (skips deactivated), for blending
 *  FROM a now-inactive origin frame. */
function selectFrameById(world: World, id: number): FrameSnapshot | null {
  const hold: { f: FrameSnapshot | null } = { f: null };
  world.query(CameraFrame, Transform).updateEach(([frame, tf], entity) => {
    if (hold.f || entity.id() !== id) return;
    if (deactivatedEntities.has(entity.id())) return;
    hold.f = {
      id: entity.id(), active: frame.active,
      mode: frame.mode as FrameMode, autoAim: frame.autoAim, continuous: frame.continuous,
      marginTop: frame.marginTop, marginBottom: frame.marginBottom,
      marginLeft: frame.marginLeft, marginRight: frame.marginRight,
      anchorV: frame.anchorV as FrameAnchorV, anchorPosV: frame.anchorPosV,
      anchorH: frame.anchorH as FrameAnchorH, anchorPosH: frame.anchorPosH,
      blendTime: frame.blendTime, blendEase: frame.blendEase,
      x: tf.x, y: tf.y, z: tf.z, rx: tf.rx, ry: tf.ry, rz: tf.rz, sx: tf.sx, sy: tf.sy, sz: tf.sz,
    };
  });
  return hold.f;
}

/** Fit the given camera to a specific frame snapshot for `aspect`. Shared core of
 *  computeActiveFrameFit + computeFrameFitById. */
function fitFromSnapshot(
  f: FrameSnapshot,
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
  aspect: number,
  ortho: boolean,
): { position: THREE.Vector3; orthoSize: number } {
  // Box world matrix (position · rotation · scale). Prefer the propagated world
  // transform (parented boxes) over the local Transform. A zero-scale axis is
  // kept as-is (an intentionally flat 2D-plane framing box) — computeFrameFit
  // handles a zero extent without NaN.
  const wt = worldTransforms.get(f.id);
  _fitPos.set(wt ? wt.x : f.x, wt ? wt.y : f.y, wt ? wt.z : f.z);
  _fitEuler.set(wt ? wt.rx : f.rx, wt ? wt.ry : f.ry, wt ? wt.rz : f.rz);
  _fitQuat.setFromEuler(_fitEuler);
  _fitScale.set(wt ? wt.sx : f.sx, wt ? wt.sy : f.sy, wt ? wt.sz : f.sz);
  _fitMat.compose(_fitPos, _fitQuat, _fitScale);
  const { center, corners } = boxCornersFromMatrix(_fitMat);

  // Camera basis from the (authored) camera orientation.
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  const fovV = ((camera as THREE.PerspectiveCamera).fov ?? 50) * Math.PI / 180;

  return computeFrameFit({
    corners, center, right, up, forward,
    fovV, aspect,
    mode: f.mode ?? 'contain',
    margins: { top: f.marginTop, bottom: f.marginBottom, left: f.marginLeft, right: f.marginRight },
    ortho,
    autoAim: f.autoAim,
    authoredPos: camera.position.clone(),
    near: camera.near,
    anchorV: f.anchorV ?? 'off',
    anchorPosV: f.anchorPosV ?? 0.5,
    anchorH: f.anchorH ?? 'off',
    anchorPosH: f.anchorPosH ?? 0.5,
  });
}

/** Fit for a SPECIFIC frame id (the blend origin). Returns null if it's gone. */
export function computeFrameFitById(
  world: World,
  id: number,
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
  aspect: number,
  ortho: boolean,
): { position: THREE.Vector3; orthoSize: number } | null {
  const f = selectFrameById(world, id);
  return f ? fitFromSnapshot(f, camera, aspect, ortho) : null;
}

/** Compute where the given (already pose-synced) camera must sit to fit the
 *  active CameraFrame box for `aspect`. Returns null when no frame is active —
 *  the caller then leaves the authored camera untouched. `ortho` selects the
 *  ortho fit (orthoSize) vs perspective (dolly distance). */
export function computeActiveFrameFit(
  world: World,
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
  aspect: number,
  ortho: boolean,
): ActiveFrameFit | null {
  const f = selectActiveFrame(world);
  if (!f) return null;
  const result = fitFromSnapshot(f, camera, aspect, ortho);
  return {
    frameId: f.id, position: result.position, orthoSize: result.orthoSize,
    continuous: f.continuous, blendTime: f.blendTime, blendEase: f.blendEase,
  };
}

/** Switch which CameraFrame is active at runtime: set the referenced frame's
 *  `active=true` and every other CameraFrame's `active=false`. The framing loop
 *  then blends the camera into it over the TARGET frame's blendTime/blendEase.
 *  Ref by name (EntityAttributes.name), guid, or entity id. Returns true if a
 *  matching frame was found. */
export function setActiveCameraFrame(world: World, ref: { name?: string; guid?: string; id?: number }): boolean {
  // Pass 1: resolve the target entity id. A no-match is a NO-OP — a typo'd ref
  // must NOT deactivate every frame and silently kill framing.
  const target = { id: -1 };
  world.query(CameraFrame, EntityAttributes).updateEach(([, attrs], entity) => {
    if (target.id >= 0) return;
    if (deactivatedEntities.has(entity.id())) return; // can't become the active frame (selectActiveFrame skips it)
    const match =
      (ref.id != null && entity.id() === ref.id) ||
      (ref.guid != null && attrs.guid === ref.guid) ||
      (ref.name != null && attrs.name === ref.name);
    if (match) target.id = entity.id();
  });
  if (target.id < 0) return false;
  // Pass 2: activate only the target (in-place row write).
  world.query(CameraFrame).updateEach(([frame], entity) => {
    frame.active = entity.id() === target.id;
  });
  return true;
}

// ── Environment sync ────────────────────────────────────

export function syncEnvironment(world: World, scene: THREE.Scene) {
  let envActive = false;
  world.query(Environment).updateEach(([env], entity) => {
    if (deactivatedEntities.has(entity.id())) return;
    envActive = true;
    if (!env.hdrPath) return;

    // Normal path: SceneManager.acquireResource already awaited the HDR, so
    // getCachedEnvironment() returns a ready texture before first render.
    const cached = getCachedEnvironment(env.hdrPath);
    if (cached) {
      // UltraHDR is display-referred → dimmer for IBL, so boost its intensity to land
      // closer to the scene-linear `hdr` (approximate; the user's intensity still scales).
      const boost = getEnvFormat(env.hdrPath) === 'ultrahdr' ? ULTRAHDR_INTENSITY_BOOST : 1;
      const envIntensity = env.intensity * boost;
      const bgIntensity = env.backgroundIntensity * boost;
      // Change-gate every write (F5): this runs every frame, but the env texture +
      // its scalars rarely change, and reassigning `scene.background`/intensity flags
      // the three render state dirty on some backends → redundant work.
      if (scene.environment !== cached) scene.environment = cached;
      if (scene.environmentIntensity !== envIntensity) scene.environmentIntensity = envIntensity;
      if (env.showAsBackground) {
        if (scene.background !== cached) scene.background = cached;
        if (scene.backgroundIntensity !== bgIntensity) scene.backgroundIntensity = bgIntensity;
        if (scene.backgroundBlurriness !== env.backgroundBlurriness) scene.backgroundBlurriness = env.backgroundBlurriness;
      }
    } else {
      // Fallback: an Environment entity was spawned at runtime without going
      // through SceneManager's acquire path (e.g. editor live-edit). Kick off
      // an async load so the texture lands on a subsequent frame. We use the
      // scene's id (-1) since we don't own a sceneId here — this just primes
      // the cache; refcount handling isn't meaningful for ad-hoc spawns.
      acquireEnvironment(-1, env.hdrPath);
    }
  });
  if (!envActive && scene.environment) {
    // Don't dispose — the texture is owned by envCache, not this scene.
    scene.environment = null;
    scene.environmentIntensity = 1;
  }
}

/** Force a NodeMaterialObserver refresh across the scene so a change to
 *  `scene.environmentIntensity` actually re-uploads the per-object environment uniform.
 *
 *  WHY: for a material lit by `scene.environment` (no per-material envMap), the shader
 *  samples a `materialEnvIntensity` uniform whose value is `scene.environmentIntensity`
 *  (three `nodes/accessors/MaterialProperties`). The WebGPU renderer only re-uploads
 *  that uniform when `NodeMaterialObserver.needsRefresh(renderObject)` returns true — but
 *  its monitored-property list (`refreshUniforms`) tracks MATERIAL props and does NOT
 *  include `scene.environmentIntensity`. So on a render-on-demand surface with a static
 *  camera (the editor SceneView), changing the HDR Environment intensity leaves stale
 *  uniforms on some meshes until the camera moves ("only a few meshes update; an orbit
 *  fixes the rest"). The GameView is unaffected because it re-applies its camera every
 *  frame. `envMapIntensity` IS in that monitored list, so cycling it within a tiny,
 *  drift-free band (stored `__baseEnvI` ± an imperceptible epsilon, distinct from the
 *  previous value) trips `equals()` → `needsRefresh` → the env uniform re-uploads for
 *  every mesh. It's visually inert: unused by scene-environment materials, and ±1e-4 on
 *  a real envMap material is imperceptible. Call this on the frame `environmentIntensity`
 *  changes, before rendering. */
export function refreshEnvIntensityObserver(scene: THREE.Scene): void {
  // Dedupe: materials are shared across meshes (cached per GUID). Cycle each material's
  // tick exactly ONCE — cycling per-mesh would advance a material used by N meshes N
  // times, and when N is a multiple of the modulus it lands back on the previous value
  // (no net change → the observer sees nothing → stays stale).
  const seen = new Set<THREE.Material>();
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.material) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) {
      if (seen.has(mat)) continue;
      seen.add(mat);
      const std = mat as THREE.MeshStandardMaterial;
      if (std.envMapIntensity === undefined) continue; // MeshBasic/line etc. — no env
      const ud = std.userData as { __baseEnvI?: number; __envTick?: number };
      if (ud.__baseEnvI === undefined) ud.__baseEnvI = std.envMapIntensity;
      ud.__envTick = ((ud.__envTick ?? 0) + 1) % 3; // 0,1,2 — consecutive values differ
      std.envMapIntensity = ud.__baseEnvI + ud.__envTick * 1e-4;
    }
  });
}

// ── Fog sync ────────────────────────────────────────────

/** Persistent per-scene TSL state backing height-mode `scene.fogNode`. Keyed by the
 *  actual `THREE.Scene` instance (the runtime Scene3D and the editor SceneView each
 *  own a distinct scene).
 *
 *  TWO separate invariants live here — both were learned the hard way:
 *
 *  1. **Stable node identity.** `Node.getHash()` returns the node's instance id, and
 *     that id feeds the render-object's SHADER CACHE KEY (`NodeManager.getCacheKey()`
 *     pushes `fogNode.getCacheKey()`). Rebuilding the node every frame would recompile
 *     every affected material's shader every frame. Uniform VALUES aren't part of that
 *     hash, so mutating them in place is free.
 *
 *  2. **`.setGroup(renderGroup)` on every uniform.** A bare `uniform()` defaults to
 *     `objectGroup` — a PER-RENDER-OBJECT uniform buffer. Those buffers are only
 *     re-uploaded inside `Bindings.updateForRender(renderObject)`, which `Renderer`
 *     calls **only when `NodeMaterialObserver.needsRefresh(renderObject)` is true** —
 *     and that stays false forever for a static mesh with a plain (non-node) material,
 *     because the observer only watches MATERIAL properties (its `refreshUniforms`
 *     list) + world matrix + geometry. Fog is scene-global, so nothing on that list
 *     ever changes ⇒ a live fog edit updated `.value` here but NEVER reached the GPU
 *     on static geometry (the editor grid, unmoving terrain), while animated objects
 *     looked fine — a maddening partial-staleness. `renderGroup` is a SHARED group
 *     (`shared: true`, `updateType: RENDER`): every material referencing these nodes
 *     shares ONE bind group / buffer, re-uploaded once per render call, so it can't go
 *     per-object stale. This is exactly what three's own `NodeManager.updateFog()`
 *     does for the classic `scene.fog` path (`reference(...).setGroup(renderGroup)`),
 *     which is why linear/exponential fog never had this bug.
 *
 *  RULE OF THUMB for any future TSL uniform: if the value is SCENE-GLOBAL (fog,
 *  scene lights, time, wind), it belongs in `renderGroup`/`frameGroup`. Only genuinely
 *  per-object values (e.g. a `.onObjectUpdate()` uniform read from `object.userData`)
 *  should stay in the default `objectGroup`. See docs/rendering.md "Fog". */
interface HeightFogState {
  node: unknown;
  color: ReturnType<typeof uniform>;
  density: ReturnType<typeof uniform>;
  height: ReturnType<typeof uniform>;
}
const heightFogStates = new WeakMap<THREE.Scene, HeightFogState>();

/** Apply the first active `Fog` entity's settings to the scene. A hybrid mechanism:
 *
 *  - `linear`/`exponential` drive the classic `scene.fog` object
 *    (`THREE.Fog`/`FogExp2`). Despite this engine rendering exclusively through
 *    WebGPURenderer/NodeMaterial, that classic object IS the right integration
 *    point: `NodeMaterial.fog` defaults to `true`, and three's own
 *    `NodeManager.updateFog()` transparently converts `scene.fog` into the
 *    equivalent TSL node graph each render, caching it by the Fog/FogExp2 object's
 *    OWN identity and refreshing color/near/far/density via `reference()` nodes
 *    (`NodeUpdateType.OBJECT` — re-read every frame). So mutating the SAME object's
 *    fields already gets "update without recompiling the shader" for free.
 *  - `height` (density varying with world Y — fog pools in valleys, independent of
 *    camera distance) has NO classic-object equivalent, so it drives `scene.fogNode`
 *    directly via `exponentialHeightFogFactor(density, height)` — see
 *    `HeightFogState` above for why that node's identity must stay stable.
 *
 *  `NodeManager.getFogNode()` prefers `scene.fogNode` over a derived-from-`scene.fog`
 *  node, so whichever path is inactive must be explicitly cleared or a stale one
 *  would win. First-entity-wins + clear-on-none mirrors `syncEnvironment`. */
export function syncFog(world: World, scene: THREE.Scene) {
  let active = false;
  world.query(Fog).updateEach(([f], entity) => {
    if (active || deactivatedEntities.has(entity.id())) return;
    if (!f.enabled) return;
    active = true;

    if (f.mode === 'height') {
      if (scene.fog) scene.fog = null;
      let st = heightFogStates.get(scene);
      if (!st) {
        // `.setGroup(renderGroup)` is LOAD-BEARING, not a detail — see the
        // uniform-group note on `HeightFogState` above. Same call three's own
        // `NodeManager.updateFog()` makes for the classic `scene.fog` path.
        const color = uniform(new THREE.Color(f.color)).setGroup(renderGroup);
        const density = uniform(f.density).setGroup(renderGroup);
        const height = uniform(f.height).setGroup(renderGroup);
        st = { node: fogTsl(color, exponentialHeightFogFactor(density, height)), color, density, height };
        heightFogStates.set(scene, st);
      }
      (st.color.value as THREE.Color).setHex(f.color);
      st.density.value = f.density;
      st.height.value = f.height;
      if (scene.fogNode !== st.node) scene.fogNode = st.node as never;
      return;
    }
    if (scene.fogNode) scene.fogNode = null as never;

    const isExp = f.mode === 'exponential';
    const prior = scene.fog as (THREE.Fog & THREE.FogExp2) | null;
    const wrongType = !prior || (isExp ? !prior.isFogExp2 : !prior.isFog);
    if (wrongType) {
      scene.fog = (isExp
        ? new THREE.FogExp2(f.color, f.density)
        : new THREE.Fog(f.color, f.near, f.far)) as THREE.Fog & THREE.FogExp2;
    }
    const current = scene.fog as THREE.Fog & THREE.FogExp2;
    if (current.color.getHex() !== f.color) current.color.setHex(f.color);
    if (isExp) {
      if (current.density !== f.density) current.density = f.density;
    } else {
      if (current.near !== f.near) current.near = f.near;
      if (current.far !== f.far) current.far = f.far;
    }
  });
  if (!active) {
    if (scene.fog) scene.fog = null;
    if (scene.fogNode) scene.fogNode = null as never;
  }
}

// ── Light sync ──────────────────────────────────────────

function createLightFromTrait(light: { lightType: string; color: number; intensity: number; distance: number; angle: number; penumbra: number }): THREE.Light | null {
  switch (light.lightType) {
    case 'ambient':     return new THREE.AmbientLight(light.color, light.intensity);
    case 'directional': return new THREE.DirectionalLight(light.color, light.intensity);
    case 'point':       return new THREE.PointLight(light.color, light.intensity, light.distance);
    case 'spot':        return new THREE.SpotLight(light.color, light.intensity, light.distance, light.angle, light.penumbra);
    default:            return null;
  }
}

/** Mark a freshly-created object (and any nested meshes, e.g. LOD levels or a loaded
 *  model graph) as shadow caster + receiver. Inert unless a light casts + the renderer's
 *  shadowMap is enabled (both gated elsewhere), so this is always safe to apply.
 *  A mesh whose material is alpha-blended (`transparent: true` — water, glass, sprite
 *  billboards) does NOT cast: the shadow map treats blended geometry as fully opaque,
 *  so a translucent surface would throw a hard, wrongly-shaped shadow (see the pond
 *  water plane in demos/forest-camp — its shadow read as a ghost duplicate of itself
 *  offset across the grass). It still RECEIVES shadows normally. */
function applyShadowFlags(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    const transparent = Array.isArray(mat) ? mat.some((mm) => mm.transparent) : mat?.transparent;
    m.castShadow = !transparent;
    m.receiveShadow = true;
  });
}

/** Configure a directional/spot light's shadow map + camera + bias from its Light trait.
 *  Called each frame while castShadow is on; the mapSize realloc is guarded so it only
 *  regenerates the depth texture when the size actually changes. */
function configureLightShadow(
  l: THREE.DirectionalLight | THREE.SpotLight,
  light: { shadowMapSize: number; shadowCameraSize: number; shadowBias: number; shadowNormalBias: number; shadowRadius: number },
): void {
  const s = l.shadow;
  const size = light.shadowMapSize || 2048;
  if (s.mapSize.width !== size || s.mapSize.height !== size) {
    s.mapSize.set(size, size);
    if (s.map) { s.map.dispose(); (s as unknown as { map: unknown }).map = null; }
  }
  s.bias = light.shadowBias;
  s.normalBias = light.shadowNormalBias;
  (s as unknown as { radius: number }).radius = light.shadowRadius;
  s.camera.near = 0.1;
  s.camera.far = 200;
  if (l instanceof THREE.DirectionalLight) {
    const c = light.shadowCameraSize || 16;
    const cam = s.camera as THREE.OrthographicCamera;
    cam.left = -c; cam.right = c; cam.top = c; cam.bottom = -c;
  }
  s.camera.updateProjectionMatrix();
}

/** Spot/Directional lights aim at a `target` Object3D added to the scene graph
 *  (see syncLights). When such a light is reaped or type-switched, its target must
 *  be removed too — otherwise a stray empty Object3D accumulates in the scene on
 *  light-type churn / deletion across a long session (F6). */
function removeLightTarget(l: THREE.Light, scene: THREE.Scene): void {
  if (l instanceof THREE.SpotLight || l instanceof THREE.DirectionalLight) {
    if (l.target.parent === scene) scene.remove(l.target);
  }
}

/** Match a Light trait's lightType to the matching THREE.Light subclass.
 *  Returns false if the type doesn't match the existing instance — caller
 *  should dispose and recreate. */
function lightMatchesType(l: THREE.Light, lightType: string): boolean {
  switch (lightType) {
    case 'ambient':     return l instanceof THREE.AmbientLight;
    case 'directional': return l instanceof THREE.DirectionalLight;
    case 'point':       return l instanceof THREE.PointLight;
    case 'spot':        return l instanceof THREE.SpotLight;
    default:            return false;
  }
}

export function syncLights(world: World, scene: THREE.Scene, ecsLights: Map<number, THREE.Light>) {
  _activeLightIds.clear();
  world.query(Light).updateEach(([light], entity) => {
    if (deactivatedEntities.has(entity.id())) return;
    const id = entity.id();
    _activeLightIds.add(id);

    let l = ecsLights.get(id);
    // Recreate when the lightType changed (e.g. user switched ambient → spot).
    if (l && !lightMatchesType(l, light.lightType)) {
      scene.remove(l);
      removeLightTarget(l, scene);
      l.dispose();
      ecsLights.delete(id);
      l = undefined;
    }
    if (!l) {
      const created = createLightFromTrait(light);
      if (!created) return;
      // Particles live on PARTICLE_LAYER. Three lights are layer-gated (a light only
      // illuminates objects sharing a layer), so without this, lit mesh particles
      // (MeshStandardNodeMaterial) would render black. Keep layer 0 too.
      created.layers.enable(PARTICLE_LAYER);
      scene.add(created);
      ecsLights.set(id, created);
      l = created;
    }

    // Per-frame: re-apply every field the trait carries. Light subclasses
    // ignore irrelevant fields (e.g. AmbientLight has no `distance`).
    l.color.setHex(light.color);
    l.intensity = light.intensity;
    l.castShadow = light.castShadow;
    if (light.castShadow && (l instanceof THREE.DirectionalLight || l instanceof THREE.SpotLight)) {
      configureLightShadow(l, light);
    }
    if (l instanceof THREE.PointLight || l instanceof THREE.SpotLight) {
      l.distance = light.distance;
    }
    if (l instanceof THREE.SpotLight) {
      l.angle = light.angle;
      l.penumbra = light.penumbra;
    }

    const wt = worldTransforms.get(id);
    if (wt && !(l instanceof THREE.AmbientLight)) {
      (l as THREE.DirectionalLight).position.set(wt.x, wt.y, wt.z);
      // SpotLight (and DirectionalLight) point toward `target.position`. Without
      // syncing the target, spot lights keep aiming at (0,0,0) regardless of
      // parent transform. Project the light's local -Z forward into world space.
      if (l instanceof THREE.SpotLight || l instanceof THREE.DirectionalLight) {
        const forwardX = wt.x - Math.sin(wt.ry) * Math.cos(wt.rx);
        const forwardY = wt.y + Math.sin(wt.rx);
        const forwardZ = wt.z - Math.cos(wt.ry) * Math.cos(wt.rx);
        l.target.position.set(forwardX, forwardY, forwardZ);
        if (!l.target.parent) scene.add(l.target);
      }
    }
  });
  for (const [id, l] of ecsLights) {
    if (!_activeLightIds.has(id)) {
      scene.remove(l);
      removeLightTarget(l, scene);
      l.dispose();
      ecsLights.delete(id);
    }
  }
  // Feed the same lights to custom shaders (no-op until one binds the uniforms).
  updateSceneLightUniforms(world);
}

// ── Renderable 3D sync ──────────────────────────────────

/** One target a material-slot override writes to: a cloned submesh, plus the
 *  index into its material array (-1 = single material, not an array). */
export interface MatSlotTarget {
  mesh: THREE.Mesh;
  index: number;
}

/** Render state for ONE mesh node of a rigged model (Unity's per-renderer view).
 *  A `SkinnedMeshRenderer` entity binds to this by node name and drives its
 *  materials + visibility. Built once per clone. */
export interface NodeRender {
  /** Every submesh under this node — toggled together for visibility. */
  meshes: THREE.Mesh[];
  /** Material-slot name (original material `.name`) → the submesh targets using
   *  it. The 148 eye primitives collapse to 2 slots here. */
  slots: Map<string, MatSlotTarget[]>;
  /** Mesh uuid → its baked (GLB) material(s), captured at clone time so clearing
   *  an override restores the original (array meshes store a shallow copy). */
  baked: Map<string, THREE.Material | THREE.Material[]>;
  /** Slot name → the override guid currently bound (skips redundant rebinds; a
   *  slot whose guid hasn't resolved yet is left absent so it retries). */
  appliedOverrides: Map<string, string>;
  /** Last applied visibility (skip redundant traversal writes). */
  visibleApplied: boolean;
}

/** Per-entity skeletal-animation state — the live THREE objects a SkinnedModel
 *  owns. Lives in RenderState (not the ECS trait) so the trait stays pure data. */
export interface SkinnedEntry {
  /** GLB ref this entry was built from — rebuilt if SkinnedModel.model changes. */
  modelRef: string;
  /** Cloned (per-instance) skeleton hierarchy added to the scene. */
  root: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  /** clip name → action. */
  actions: Map<string, THREE.AnimationAction>;
  /** First clip name (fallback when SkeletalAnimator.clip is empty). */
  firstClip: string;
  /** Currently-playing clip name (undefined until first play). */
  current?: string;
  /** Bone name → Bone, built once at clone time for O(1) BoneAttachment lookup. */
  bones: Map<string, THREE.Bone>;
  /** ROOT-bone name → the STATIC transform of everything between the clone root and
   *  that bone (the non-bone "Armature" wrapper a Blender/FBX export puts above the
   *  skeleton: Z-up→Y-up rotation + 100× unit scale). Built once at clone time. The
   *  bone bridge reads/writes a root bone's entity Transform in CLONE-ROOT space, so
   *  it must bake this wrapper in (`fwd`) and strip it back out (`inv`) — otherwise
   *  the bone entity, which hangs under the model root, collapses ~100× small at the
   *  origin every frame (the bones-snap-to-origin bug). Only root bones (whose THREE
   *  parent is not a bone) get an entry; child bones use parent-local TRS directly. */
  boneWrapperPrefix?: Map<string, { fwd: THREE.Matrix4; inv: THREE.Matrix4 }>;
  /** Mesh-node name → its render state. Child `SkinnedMeshRenderer` entities
   *  resolve into this map by node name to set materials + visibility. */
  nodes: Map<string, NodeRender>;
  /** P6 shared clip library: clip name → the animset GUID whose per-clip params
   *  drive that clip. Set only for LIBRARY clips (a clip pulled from another
   *  GLB via `AnimationLibrary`); own clips are absent and `driveAnimator` falls
   *  back to the entity's `SkeletalAnimator.animSet`. Optional — manually-built
   *  test entries / pre-P6 callers omit it. */
  clipParamSource?: Map<string, string>;
  /** P6: library source-GLB refs already merged into `actions` (so the per-frame
   *  merge is idempotent — each source's clips are bound once). */
  libraryMerged?: Set<string>;
  /** P6: stable key of the desired `AnimationLibrary` (animSets + retarget). A
   *  change rebuilds the entry (like a model-ref swap) so removed library clips
   *  don't linger in the mixer. */
  libraryKey?: string;
}

/** Per-entity state for a `SkinnedSprite2D` + `Billboard3D` (a 2D skinned rig drawn
 *  as a camera-facing mesh IN the Three.js scene — the 2.5D bridge). The deformed
 *  vertex buffers come from the SAME `skin2DBuffers` seam the PixiJS `Scene2D`
 *  reads; this entry just holds the THREE objects that present them in 3D. Lives in
 *  RenderState (not the trait) so the traits stay pure data. */
export interface BillboardEntry {
  /** Rig GUID this entry was built from — a rig swap rebuilds it. */
  rigRef: string;
  /** Topology signature (part count + each part's texture/frame/vertex count). A
   *  change (rig swap, re-tessellate, re-slice) forces a full geometry rebuild; a
   *  re-weight keeps it and just re-uploads positions on a deform-version bump. */
  sig: string;
  /** Outer group added to the scene: `applyTransform` sets its position+scale from
   *  the entity Transform, and `orientBillboards` overrides its rotation each frame
   *  to face the camera. */
  group: THREE.Group;
  /** Inner group (child of `group`) carrying the flipX/flipY mirror scale, so the
   *  billboard rotation + Transform scale on the outer group stay independent of it. */
  flip: THREE.Group;
  /** Orientation mode. `'cylindrical'`/`'spherical'` are camera-facing (Billboard3D);
   *  `'flat'` (FlatSprite3D) lies in the world XZ plane and KEEPS the entity Transform
   *  rotation. Kept here so `orientBillboards` can run without world access. */
  mode: 'cylindrical' | 'spherical' | 'flat';
  /** One mesh per rig part, in draw order (children of `flip`). */
  meshes: THREE.Mesh[];
  /** Each mesh's intra-rig paint order (mirrors `part.order`), refreshed per frame.
   *  `orientBillboards` combines it with a per-entity depth rank into `renderOrder`,
   *  so overlapping billboards composite by distance, parts within one by paint order. */
  orders: number[];
  /** Resolved page texture per part (null until the async load lands; parts sharing a
   *  page share one texture instance, disposed once). */
  textures: (THREE.Texture | null)[];
  /** Last deform version uploaded (skip re-upload when the pose is idle). */
  deformVersion: number;
  /** Set true by `disposeBillboardEntry`. An in-flight page-load resolving after this
   *  disposes its own texture instead of writing to the dead entry (leak guard). */
  disposed: boolean;
}

export interface RenderState {
  ecsObjects: Map<number, THREE.Object3D>;
  ecsSprites: Map<number, string>;
  ecsMaterials: Map<number, string>;
  ecsColors: Map<number, number>;
  ecsSizes: Map<number, number>;
  ownsGeometry: Set<number>;
  /** SkinnedModel entities — clone + mixer per entity id. */
  skinned: Map<number, SkinnedEntry>;
  /** SkinnedSprite2D + Billboard3D entities — camera-facing mesh per entity id. */
  billboards: Map<number, BillboardEntry>;
  /** Text3D entities — SDF text mesh per entity id (separate from ecsObjects: its
   *  ShaderMaterial + geometry are owned inline, and it has no color/size maps). */
  textMeshes: Map<number, TextMeshEntry>;
  /** Percept (J3): whether THIS render surface emits animation lifecycle events
   *  (@anim-start/loop/finish) to the journal. The editor runs TWO 3D viewports on
   *  one world (SceneView + GameView), each with its own mixer, but the journal is
   *  per-world — so only the PRIMARY surface (runtime/GameView Scene3D) emits, else
   *  every event would double-fire. In a shipped game there's one surface (primary).*/
  emitLifecycle: boolean;
}

/** Create a fresh RenderState with empty maps/sets. Pass emitLifecycle=true for the
 *  primary (game/runtime) surface so animation lifecycle events are journaled once. */
export function createRenderState(emitLifecycle = false): RenderState {
  return {
    ecsObjects: new Map(),
    ecsSprites: new Map(),
    ecsMaterials: new Map(),
    ecsColors: new Map(),
    ecsSizes: new Map(),
    ownsGeometry: new Set(),
    skinned: new Map(),
    billboards: new Map(),
    textMeshes: new Map(),
    emitLifecycle,
  };
}

/** Tear down one skinned entry: stop its mixer, unbind, remove the clone from the
 *  scene, and dispose each clone's per-instance Skeleton (its boneTexture is a
 *  GPU DataTexture the clone OWNS — SkeletonUtils.clone clones the skeleton per
 *  instance, so it is NOT shared with the prototype and would otherwise leak on
 *  every entity removal / model-ref swap / scene swap / re-import). Does NOT
 *  dispose geometry/materials — those ARE shared with the cached prototype
 *  (riggedModelCache owns their disposal on last scene release). */
function disposeSkinnedEntry(entry: SkinnedEntry, scene: THREE.Scene): void {
  entry.mixer.stopAllAction();
  entry.mixer.uncacheRoot(entry.root as THREE.Object3D);
  scene.remove(entry.root);
  entry.root.traverse((o) => {
    const sm = o as THREE.SkinnedMesh;
    if (sm.isSkinnedMesh) sm.skeleton?.dispose();
  });
}

/** Subscribe a render state + scene to model-invalidation events. When the
 *  mesh-template cache invalidates a model (typically an editor re-import),
 *  this evicts any THREE.Mesh / THREE.LOD whose backing template came from
 *  that model — *before* the underlying geometry is disposed. Without this,
 *  the next render frame trips WebGPU's "setIndexBuffer parameter is not a
 *  GPUBuffer" because the in-scene mesh still points at the freed buffer.
 *  Returns the unsubscribe function; callers should invoke it on teardown. */
export function attachInvalidationListener(state: RenderState, scene: THREE.Scene): () => void {
  return onModelInvalidated((_modelPath, targets) => {
    const toEvict: number[] = [];
    for (const [id, meshRef] of state.ecsSprites) {
      const asset = getMeshAsset(meshRef);
      if (!asset) continue;
      // asset.model is a guid post-migration; targets is a Set of paths
      // (modelPath + lodPaths from the manifest). Resolve before comparing.
      const modelPath = resolveRef(asset.model);
      if (modelPath && targets.has(modelPath)) toEvict.push(id);
    }
    for (const id of toEvict) {
      const obj = state.ecsObjects.get(id);
      if (obj) scene.remove(obj);
      state.ecsObjects.delete(id);
      state.ecsSprites.delete(id);
      state.ecsMaterials.delete(id);
      state.ownsGeometry.delete(id);
    }

    // Skinned (rigged) entries: evict any whose GLB was invalidated so the next
    // syncSkinnedModels rebuilds the clone from the freshly-reloaded prototype.
    // Runs BEFORE invalidateRiggedModel disposes that prototype (same event), so
    // the in-scene clones are removed before their shared geometry is freed.
    const skinnedToEvict: number[] = [];
    for (const [id, entry] of state.skinned) {
      const p = resolveRef(entry.modelRef);
      if (p && targets.has(p)) skinnedToEvict.push(id);
    }
    for (const id of skinnedToEvict) {
      const entry = state.skinned.get(id);
      if (entry) disposeSkinnedEntry(entry, scene);
      state.skinned.delete(id);
    }
  });
}

/** Dispose all tracked objects, remove from scene, and clear collections.
 *  @param disposeMeshMaterials — if true, dispose material on each owned-geometry mesh
 *    (editor does this; runtime uses clearOwnedMaterials instead). */
export function disposeRenderState(
  state: RenderState,
  scene: THREE.Scene,
  disposeMeshMaterials = false,
) {
  for (const [id, obj] of state.ecsObjects) {
    scene.remove(obj);
    if (state.ownsGeometry.has(id) && (obj as THREE.Mesh).geometry) {
      (obj as THREE.Mesh).geometry.dispose();
      if (disposeMeshMaterials) {
        // materialTargetsOf so a LOD's child-mesh materials dispose too (F11).
        for (const target of materialTargetsOf(obj)) (target.material as THREE.Material)?.dispose();
      }
    }
  }
  for (const entry of state.skinned.values()) disposeSkinnedEntry(entry, scene);
  state.skinned.clear();
  for (const [, entry] of state.billboards) disposeBillboardEntry(entry, scene);
  state.billboards.clear();
  for (const [, entry] of state.textMeshes) disposeTextMeshEntry(entry, scene);
  state.textMeshes.clear();
  state.ecsObjects.clear();
  state.ecsSprites.clear();
  state.ecsMaterials.clear();
  state.ecsColors.clear();
  state.ecsSizes.clear();
  state.ownsGeometry.clear();
}

export interface SyncCallbacks {
  /** Return false to skip transform update for this entity (e.g. gizmo-controlled). */
  shouldUpdateTransform?: (id: number) => boolean;
  /** Called when a mesh is removed, so caller can clean up associated visuals. */
  onMeshRemoved?: (id: number, obj: THREE.Object3D) => void;
}

/** Shared material update logic for both GLB and primitive renderables.
 *  Handles .mat.json paths, inline texture paths, and cache-resolved materials.
 *  Returns true if material was changed. */
/** A target for syncMaterial: either a single mesh (the common case) or every
 *  child mesh of a `THREE.LOD` (when the Renderable3D resolves to a baked LOD
 *  set). Hides the iteration so syncMaterial's body stays linear. */
function materialTargetsOf(obj: THREE.Object3D): THREE.Mesh[] {
  if ((obj as { isLOD?: boolean }).isLOD) {
    return (obj.children as THREE.Object3D[]).filter((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh[];
  }
  return [obj as THREE.Mesh];
}

/** Every live THREE.Mesh this render surface holds for one entity id — the
 *  drawable meshes whose `.material` + `.userData` the material broker reads and
 *  writes. Covers plain/primitive renderables (via `materialTargetsOf`, so a LOD's
 *  child meshes are included), camera-facing billboards, and SDF text pages.
 *  Skinned (rigged) meshes are intentionally omitted for now — their materials
 *  bind through child `SkinnedMeshRenderer` entities by node name, a mapping the
 *  broker's per-entity model doesn't yet express (see docs/rendering.md). */
export function collectEntityMeshes(state: RenderState, id: number): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  const obj = state.ecsObjects.get(id);
  if (obj) out.push(...materialTargetsOf(obj));
  const bb = state.billboards.get(id);
  if (bb) out.push(...bb.meshes);
  const tm = state.textMeshes.get(id);
  if (tm) for (const mesh of tm.pages.values()) out.push(mesh);
  return out;
}

// Inject the mesh collector into the render-layer-agnostic material broker so the
// broker doesn't statically import THIS module (scene3DSync pulls three/webgpu). Runs
// at load — i.e. only when the 3D renderer is active; a 2D build never loads scene3DSync.
setEntityMeshCollector(collectEntityMeshes);

function syncMaterial(
  obj: THREE.Object3D,
  id: number,
  curMat: string,
  state: RenderState,
  isTinted = false,
  isInstanced = false,
): void {
  const targets = materialTargetsOf(obj);
  const prevMat = state.ecsMaterials.get(id);
  if (prevMat !== curMat) {
    state.ecsMaterials.set(id, curMat);
    // Resolve the new material once (a `.mat.json` GUID, or the engine default
    // when empty), then fan it out to every target. A mesh renderer references a
    // MATERIAL only — never a texture directly (textures live on the .mat.json).
    const newMat: THREE.Material | undefined = curMat
      ? (resolveMaterial(curMat) ?? undefined)
      : _defaultMaterial;
    for (const t of targets) {
      const oldMat = t.material as THREE.Material;
      if (oldMat && _ownedMaterials.has(oldMat)) {
        _ownedMaterials.delete(oldMat);
        oldMat.dispose();
      }
      if (newMat) { t.material = newMat; t.castShadow = !newMat.transparent; }
    }
  } else if (!isTinted && !isInstanced && curMat) {
    // .mat.json path unchanged but the async load may have finished since
    // last frame — check if the resolved material is now available.
    // Skipped for tinted meshes AND for entities with a MaterialInstance prop
    // override: those bind a per-entity CLONE of the resolved material (the Tint
    // block / materialInstanceSystem own the binding), so resetting to the base
    // here would fight that clone every frame.
    const resolved = resolveMaterial(curMat);
    if (resolved) {
      for (const t of targets) {
        if (t.material !== resolved) t.material = resolved;
        t.castShadow = !resolved.transparent; // keep in sync even once the ref settles
      }
    }
  }
}

/** Apply world or local transform to a Three.js object. */
function applyTransform(
  obj: THREE.Object3D,
  id: number,
  tf: { x: number; y: number; z: number; rx: number; ry: number; rz: number; sx: number; sy: number; sz: number },
  callbacks?: SyncCallbacks,
): void {
  if (callbacks?.shouldUpdateTransform && !callbacks.shouldUpdateTransform(id)) return;
  const wt = worldTransforms.get(id);
  if (wt) {
    obj.position.set(wt.x, wt.y, wt.z);
    obj.rotation.set(wt.rx, wt.ry, wt.rz);
    obj.scale.set(wt.sx, wt.sy, wt.sz);
  } else {
    obj.position.set(tf.x, tf.y, tf.z);
    obj.rotation.set(tf.rx, tf.ry, tf.rz);
    obj.scale.set(tf.sx, tf.sy, tf.sz);
  }
}

const _activeSkinnedIds = new Set<number>();
/** Clips we've already warned about being absent (keyed modelRef:clip) so a
 *  per-frame lookup of a typo'd/stale clip name doesn't spam the console. */
const _warnedMissingClip = new Set<string>();

/** Apply a SkeletalAnimator's desired state to an entry's mixer/actions.
 *  Exported for unit tests (clip selection / fade / per-clip param resolution).
 *
 *  Per-clip params (speed/loop/fadeDuration) come from the entity's `animSet`
 *  (a `.animset.json`): each clip carries its own authored defaults. The trait's
 *  own speed/loop/fadeDuration are per-entity OVERRIDES — a field left at its
 *  trait default inherits the animset's per-clip value, a non-default value wins.
 *  `resolveAnimSetParams` returns the engine defaults when there's no animset (or
 *  it isn't loaded / the clip isn't listed), so the `field !== default` formula
 *  collapses to today's behaviour in the legacy/no-animset case. */
export function driveAnimator(
  entry: SkinnedEntry,
  a: { animSet: string; clip: string; playing: boolean; speed: number; loop: boolean; fadeDuration: number },
): void {
  let desired = a.clip || entry.firstClip;
  // Requested clip isn't in this GLB (typo, or a clip from a different model
  // after a model-ref swap). Warn once and fall back to the first clip rather
  // than silently leaving the previous clip running with the new speed/loop.
  if (desired && !entry.actions.has(desired)) {
    // Don't warn while the rig has NO clips yet: a bare rig that sources its clips
    // from an AnimationLibrary legitimately has an empty action set for the first
    // frames until the library's source GLB lazy-loads + merges (the clip arrives
    // then). Only warn once the rig DOES have clips and the requested one still
    // isn't among them — a genuine typo / stale ref.
    if (entry.actions.size > 0) {
      const key = `${entry.modelRef}:${desired}`;
      if (!_warnedMissingClip.has(key)) {
        _warnedMissingClip.add(key);
        console.warn(`[skeletal] clip "${desired}" not found in ${entry.modelRef}; falling back to "${entry.firstClip || '(none)'}"`);
      }
    }
    desired = entry.firstClip;
  }
  if (desired && desired !== entry.current) {
    const next = entry.actions.get(desired);
    if (next) {
      // Fade uses the INCOMING clip's per-clip fadeDuration (override-aware). A
      // library clip resolves its params from the animset that supplied it
      // (clipParamSource); an own clip from the entity's own SkeletalAnimator.animSet.
      const incoming = resolveAnimSetParams(entry.clipParamSource?.get(desired) || a.animSet, desired);
      const fade = a.fadeDuration !== ANIMSET_DEFAULTS.fadeDuration ? a.fadeDuration : incoming.fadeDuration;
      const prev = entry.current ? entry.actions.get(entry.current) : undefined;
      next.reset();
      next.enabled = true;
      if (fade > 0 && prev) {
        // Let crossFadeFrom own the weight ramp — forcing full weight first
        // defeats the fade (it would pop straight to the new clip).
        next.play();
        next.crossFadeFrom(prev, fade, false);
      } else {
        next.setEffectiveWeight(1);
        if (prev) prev.stop();
        next.play();
      }
      entry.current = desired;
    }
  }
  const cur = entry.current ? entry.actions.get(entry.current) : undefined;
  if (cur) {
    const p = resolveAnimSetParams(entry.clipParamSource?.get(entry.current!) || a.animSet, entry.current!);
    const speed = a.speed !== ANIMSET_DEFAULTS.speed ? a.speed : p.speed;
    const loop = a.loop !== ANIMSET_DEFAULTS.loop ? a.loop : p.loop;
    cur.paused = !a.playing;
    cur.timeScale = speed;
    cur.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    cur.clampWhenFinished = !loop;
  }
}

/** Timeline scrub-preview (Phase 5/B): pose a skeletal rig at EXACT local clip times instead of
 *  advancing its mixer by a frame delta. Each requested clip's action is set to its `time` at its
 *  `weight` (a single clip = a plain seek at weight 1; two clips = a crossfade blend, replicating
 *  the fadeDuration crossfade Play shows); every OTHER action is stopped so nothing stale bleeds
 *  in. Missing clips fall back to `firstClip` (matching `driveAnimator`). The pose is baked with
 *  `mixer.update(0)` (dt 0 evaluates without advancing). Stopped-only (the editor scrub path). */
function blendSkeletal(entry: SkinnedEntry, clips: { clip: string; time: number; weight: number }[]): void {
  // Resolve each requested clip to an action name (fallback firstClip); sum weights if the same
  // action is named twice, and keep the latest time.
  const wanted = new Map<string, { time: number; weight: number }>();
  for (const c of clips) {
    const name = entry.actions.has(c.clip) ? c.clip : entry.firstClip;
    if (!name) continue;
    const prev = wanted.get(name);
    wanted.set(name, { time: c.time, weight: (prev?.weight ?? 0) + c.weight });
  }
  if (wanted.size === 0) return;
  for (const [n, a] of entry.actions) {
    const w = wanted.get(n);
    if (!w) { if (a.isRunning() || a.getEffectiveWeight() > 0) a.stop(); continue; }
    a.enabled = true;
    a.paused = false;
    if (!a.isRunning()) a.play();
    a.setEffectiveWeight(Math.max(0, Math.min(1, w.weight)));
    const duration = a.getClip().duration;
    a.time = duration > 0 ? Math.min(Math.max(w.time, 0), duration) : 0;
  }
  // Dominant clip (highest weight) drives the read-back / entry.current.
  let best = ''; let bestW = -1;
  for (const [n, w] of wanted) if (w.weight > bestW) { bestW = w.weight; best = n; }
  entry.current = best;
  entry.mixer.update(0); // evaluate the (blended) pose at the set action times (dt 0 = seek)
}

/** Shared frozen empty map so the common "no overrides" path allocates nothing. */
const EMPTY_OVERRIDES: Record<string, string> = Object.freeze({});

/** The mesh-NODE a cloned submesh belongs to. GLTFLoader wraps a multi-primitive
 *  glTF node in a `Group` named after the node (its primitive meshes get generic
 *  `mesh_N` names); a single-primitive node names the mesh itself after the node.
 *  So: a named Group parent IS the node; otherwise the mesh's own name is. This
 *  collapses the 148 eye primitives under one `Eyes-Alien-Animal` node. */
export function nodeNameOf(mesh: THREE.Object3D): string {
  const p = mesh.parent as (THREE.Object3D & { isGroup?: boolean }) | null;
  if (p && p.name && (p.isGroup || p.type === 'Group')) return p.name;
  return mesh.name;
}

/** Walk a freshly-cloned skinned root, grouping submeshes by mesh node, and
 *  within each node by material-slot name (the material's `.name`, or the mesh
 *  name when unnamed). Captures baked material(s) for restore. Built ONCE per
 *  clone — a `SkinnedMeshRenderer` entity binds to a node by name. */
function buildNodes(root: THREE.Object3D): Map<string, NodeRender> {
  const nodes = new Map<string, NodeRender>();
  const nodeOf = (name: string): NodeRender => {
    let n = nodes.get(name);
    if (!n) { n = { meshes: [], slots: new Map(), baked: new Map(), appliedOverrides: new Map(), visibleApplied: true }; nodes.set(name, n); }
    return n;
  };
  const pushSlot = (n: NodeRender, slot: string, t: MatSlotTarget) => {
    if (!slot) return;
    let arr = n.slots.get(slot);
    if (!arr) { arr = []; n.slots.set(slot, arr); }
    arr.push(t);
  };
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const n = nodeOf(nodeNameOf(mesh));
    n.meshes.push(mesh);
    const mat = mesh.material;
    // Array meshes: shallow-copy so a per-index override can be reverted to the
    // exact baked element. Single-material meshes store the lone reference.
    n.baked.set(mesh.uuid, Array.isArray(mat) ? [...mat] : mat);
    if (Array.isArray(mat)) {
      mat.forEach((m, i) => pushSlot(n, (m?.name) || mesh.name, { mesh, index: i }));
    } else {
      pushSlot(n, (mat?.name) || mesh.name, { mesh, index: -1 });
    }
  });
  return nodes;
}

/** Apply one `SkinnedMeshRenderer`'s material overrides + visibility to its mesh
 *  node within a rig's clone. `overrides` maps a material-slot name → a
 *  `.mat.json` guid; an unset slot restores the baked GLB material. Cheap on the
 *  steady state (rebinds only on change). A guid whose material hasn't finished
 *  loading is left baked and retried next frame. Exported + `resolve`-injectable
 *  for unit tests. No-op when the node isn't in this clone (stale node name). */
export function syncNodeMaterials(
  node: NodeRender,
  overrides: Record<string, string> | undefined,
  visible: boolean,
  resolve: (guid: string) => THREE.Material | undefined = resolveMaterial,
): void {
  if (node.visibleApplied !== visible) {
    for (const m of node.meshes) m.visible = visible;
    node.visibleApplied = visible;
  }
  const ov = overrides ?? EMPTY_OVERRIDES;
  for (const [slot, targets] of node.slots) {
    const guid = ov[slot] ?? '';
    const applied = node.appliedOverrides.get(slot) ?? '';
    if (guid === applied) continue; // steady state — nothing to do this frame
    if (!guid) {
      // Override cleared → restore the baked material(s) for this slot.
      for (const t of targets) {
        const baked = node.baked.get(t.mesh.uuid);
        if (baked === undefined) continue;
        if (t.index < 0) t.mesh.material = baked as THREE.Material;
        else (t.mesh.material as THREE.Material[])[t.index] = (baked as THREE.Material[])[t.index];
      }
      node.appliedOverrides.delete(slot);
      continue;
    }
    const mat = resolve(guid);
    if (!mat) continue; // async load pending — keep baked, retry next frame
    for (const t of targets) {
      if (t.index < 0) t.mesh.material = mat;
      else (t.mesh.material as THREE.Material[])[t.index] = mat;
    }
    node.appliedOverrides.set(slot, guid);
  }
}

/** Bind every `SkinnedMeshRenderer` entity to its rig root's clone: resolve the
 *  root via `EntityAttributes.parentId` (renderers are direct children of the
 *  root), then apply the renderer's materials + visibility to its mesh node.
 *  Runs after the SkinnedModel pass so the entries exist. */
function syncSkinnedMeshRenderers(world: World, state: RenderState): void {
  world.query(SkinnedMeshRenderer).updateEach(([r], entity) => {
    const parentId = entity.has(EntityAttributes) ? entity.get(EntityAttributes)!.parentId : 0;
    const entry = parentId ? state.skinned.get(parentId) : undefined;
    if (!entry) return; // rig not built yet, or renderer not a child of a rig root
    const node = entry.nodes.get(r.node);
    if (!node) return; // stale node name (model re-imported with different meshes)
    syncNodeMaterials(node, r.materials, r.visible);
  });
}

/** Stable key for an `AnimationLibrary` value (the desired set of library
 *  animsets + retarget flag + bone maps). A change between frames means the
 *  library was edited → the entry is rebuilt so removed library clips leave the
 *  mixer and a changed bone map re-retargets. Order-independent (sorted) so
 *  reordering the list alone doesn't rebuild. */
export function animationLibraryKey(lib: AnimationLibraryValue | undefined): string {
  if (!lib || !Array.isArray(lib.animSets) || lib.animSets.length === 0) return '';
  const sets = [...lib.animSets].filter(Boolean).sort().join(',');
  // Canonical bone-map serialization (sorted outer + inner keys) so only a real
  // change rebuilds, not a re-insertion-order difference.
  let maps = '';
  if (lib.boneMaps) {
    const parts: string[] = [];
    for (const ref of Object.keys(lib.boneMaps).sort()) {
      const m = lib.boneMaps[ref];
      if (!m) continue;
      const inner = Object.keys(m).sort().map((k) => `${k}=${m[k]}`).join(',');
      if (inner) parts.push(`${ref}:{${inner}}`);
    }
    maps = parts.join(';');
  }
  return sets + (lib.retarget ? '#r' : '') + (maps ? `#m${maps}` : '');
}

/** Effective clip sources for a rig = the `AnimationLibrary`'s animSets PLUS the
 *  `SkeletalAnimator`'s own `animSet`. So assigning an animSet to the SkeletalAnimator
 *  (the natural field next to `clip`) brings that animset's `source` GLB clips into a
 *  bare rig — not only per-clip params. Returns `lib` unchanged when there's no
 *  animSet (identical behaviour for the no-animSet case). retarget/boneMaps carry
 *  from the library; the appended animSet uses direct bind (the common bare-rig case). */
export function effectiveLibrary(
  lib: AnimationLibraryValue | undefined,
  animSet: string | undefined,
): AnimationLibraryValue | undefined {
  if (!animSet) return lib;
  const animSets = lib?.animSets ? [...lib.animSets] : [];
  if (!animSets.includes(animSet)) animSets.push(animSet);
  return { animSets, retarget: lib?.retarget, boneMaps: lib?.boneMaps };
}

/** First SkinnedMesh under a root (for retargetClip's skeleton source/target). */
function firstSkinnedMesh(root: THREE.Object3D | undefined): THREE.SkinnedMesh | undefined {
  if (!root) return undefined;
  let found: THREE.SkinnedMesh | undefined;
  root.traverse((o) => { if (!found && (o as THREE.SkinnedMesh).isSkinnedMesh) found = o as THREE.SkinnedMesh; });
  return found;
}

/** `SkeletonUtils.retargetClip` resamples ONLY position(hip)+quaternion per target
 *  bone — it silently DROPS scale tracks (and non-hip position). So a scale-only
 *  clip (e.g. shrink/stretch authored on `bone0.scale`) retargets to a clip that
 *  moves nothing. Carry the source clip's `.scale` tracks onto the retargeted clip,
 *  renaming each source bone to its target bone via the inverted bone map. Scale is
 *  a per-bone LOCAL property, so it transfers across rigs by name without resampling.
 *  Mutates `bound` in place. */
function carryOverScaleTracks(
  bound: THREE.AnimationClip,
  source: THREE.AnimationClip,
  boneMap?: Record<string, string>,
): void {
  // boneMap is { targetBone: sourceBone }; invert to source→target for track names.
  const srcToTarget = boneMap
    ? Object.fromEntries(Object.entries(boneMap).map(([tgt, s]) => [s, tgt])) as Record<string, string>
    : undefined;
  let added = false;
  for (const tr of source.tracks) {
    const m = /^(.+?)\.scale$/.exec(tr.name);
    if (!m) continue;
    const srcBone = m[1];
    const tgtBone = srcToTarget ? srcToTarget[srcBone] : srcBone;
    if (!tgtBone) continue;                  // source bone isn't in the map → skip
    const cloned = tr.clone();
    cloned.name = `${tgtBone}.scale`;
    bound.tracks.push(cloned);
    added = true;
  }
  if (added) bound.resetDuration();
}

/** The `AnimationLibrary` trait value (the fields the render sync reads). */
export interface AnimationLibraryValue {
  animSets?: string[];
  retarget?: boolean;
  /** Per-animSet bone-name remap: boneMaps[animSetRef] = { targetBone: sourceBone }
   *  (the shape `retargetClip`'s `options.names` wants). */
  boneMaps?: Record<string, Record<string, string>>;
}

/** Injectable dependency surface for `mergeAnimationLibrary` (so the merge logic
 *  is unit-testable without the real caches / GLB loads). */
export interface LibraryMergeDeps {
  getAnimSet: (ref: string) => { source?: string } | null;
  getRiggedModel: (ref: string) => { prototype: THREE.Object3D; animations: THREE.AnimationClip[] } | undefined;
  ensureRiggedModelLoaded: (ref: string) => void;
  retargetClip: typeof retargetClip;
}

const DEFAULT_LIBRARY_DEPS: LibraryMergeDeps = { getAnimSet, getRiggedModel, ensureRiggedModelLoaded, retargetClip };

/** P6 — merge an `AnimationLibrary`'s clips into a rig's mixer: own clips ∪
 *  library clips, keyed by clip name, OWN CLIPS WIN on a name conflict. Each
 *  library animset names a `source` GLB; its clips bind into this rig's mixer by
 *  track/bone name (cheap + correct for a shared skeleton). `retarget:true` runs
 *  each clip through `SkeletonUtils.retargetClip` against this rig first (non-
 *  identical source rig). Idempotent + lazy: a source whose animset/GLB hasn't
 *  loaded is skipped and retried next frame; once merged it's recorded in
 *  `entry.libraryMerged` so its clips bind exactly once. Records each library
 *  clip's param source in `entry.clipParamSource` so `driveAnimator` plays it
 *  with the LIBRARY animset's per-clip params. Exported for unit tests. */
export function mergeAnimationLibrary(
  entry: SkinnedEntry,
  lib: AnimationLibraryValue | undefined,
  deps: LibraryMergeDeps = DEFAULT_LIBRARY_DEPS,
): void {
  const animSets = lib && Array.isArray(lib.animSets) ? lib.animSets.filter(Boolean) : [];
  if (animSets.length === 0) return;
  if (!entry.libraryMerged) entry.libraryMerged = new Set();
  if (!entry.clipParamSource) entry.clipParamSource = new Map();
  const globalRetarget = !!lib?.retarget;

  for (const animSetRef of animSets) {
    const set = deps.getAnimSet(animSetRef);
    if (!set) continue;                       // animset not loaded yet — retry next frame
    const source = set.source;
    if (!source) continue;                    // animset carries no clip source
    if (entry.libraryMerged.has(source)) continue; // already merged this GLB's clips

    const rig = deps.getRiggedModel(source);
    if (!rig) { deps.ensureRiggedModelLoaded(source); continue; } // GLB loading — retry next frame

    // Retarget when the global flag is set OR a per-animSet bone map exists (a map
    // means the source rig's bones are named differently → bind-by-name would fail).
    const boneMap = lib?.boneMaps?.[animSetRef];
    const useRetarget = globalRetarget || !!(boneMap && Object.keys(boneMap).length);
    const target = useRetarget ? firstSkinnedMesh(entry.root) : undefined;
    const src = useRetarget ? firstSkinnedMesh(rig.prototype) : undefined;
    for (const clip of rig.animations) {
      if (entry.actions.has(clip.name)) continue; // own clip (or an earlier library) wins
      let bound = clip;
      if (useRetarget && target && src) {
        try {
          // `names` maps THIS rig's bone → the source rig's bone (empty = match by
          // identical name, i.e. bind-pose re-sample only).
          bound = deps.retargetClip(target, src, clip, boneMap ? { names: boneMap } : {});
          bound.name = clip.name;
          // retargetClip emits skeleton-relative track names (`.bones[Name].prop`),
          // which only bind to a SkinnedMesh. Our mixer drives the clone's ROOT (a
          // Group), so rewrite them to node-name form (`Name.prop`) — the same form
          // the direct (non-retargeted) clips use — or the clip binds nothing.
          for (const tr of bound.tracks) tr.name = tr.name.replace(/^\.bones\[(.+?)\]\./, '$1.');
          // retargetClip keeps only position(hip)+quaternion — re-attach scale so a
          // scale-only clip (shrink/stretch) still animates on the retargeted rig.
          carryOverScaleTracks(bound, clip, boneMap);
        } catch (e) {
          console.warn(`[skeletal] retargetClip failed for "${clip.name}" from ${source}; binding by name`, e);
          bound = clip;
        }
      }
      entry.actions.set(clip.name, entry.mixer.clipAction(bound));
      entry.clipParamSource.set(clip.name, animSetRef);
    }
    entry.libraryMerged.add(source);
  }
}

/** Sync SkinnedModel entities: clone the rigged prototype per entity, build an
 *  AnimationMixer + per-clip actions, and drive playback from SkeletalAnimator.
 *  Advances every live mixer by this state's own clock delta. Call once per
 *  frame from the render loop (after syncRenderables). */
/** Per-frame skeletal mixer advance (seconds).
 *  - PLAYING → engine visual delta (smoothed cadence × timeScale, so skeletal
 *    respects pause / slow-mo / time-stop).
 *  - STOPPED / PAUSED → frozen (0), EXCEPT while the Animation editor previews
 *    skeletal animation (`skeletalPreviewDelta` > 0): advance by the editor's
 *    wall-clock delta so baked clips animate live out of Play mode. Shipped runtime
 *    never sets the preview, so this collapses to 0-when-not-playing there. */
export function mixerAdvanceDelta(world: World): number {
  return getPlayState() === 'playing' ? getVisualDelta(world) : skeletalPreviewDelta();
}

/** Normalized playhead (0..1) of an action, for @anim-* event payloads. */
function actionNorm(action?: THREE.AnimationAction): number {
  const d = action?.getClip().duration ?? 0;
  return d > 0 ? Math.min(Math.max(action!.time, 0) / d, 1) : 0;
}

export function syncSkinnedModels(world: World, scene: THREE.Scene, state: RenderState, callbacks?: SyncCallbacks) {
  const { skinned } = state;
  _activeSkinnedIds.clear();
  // Real Play advances mixers normally — drop any leftover timeline scrub-preview seeks so a
  // rig that was scrubbed before pressing Play doesn't stay pinned to the scrubbed frame.
  if (getPlayState() === 'playing') clearSkeletalSeeks();

  world.query(Transform, SkinnedModel).updateEach(([tf, sm], entity) => {
    if (!sm.isVisible || deactivatedEntities.has(entity.id())) return;
    const id = entity.id();

    let entry = skinned.get(id);

    // P6 — shared clip library on this root (own ∪ library clips). The effective
    // sources are the AnimationLibrary's animSets PLUS the SkeletalAnimator's own
    // `animSet` (so assigning an animSet to the animator brings its clips into a bare
    // rig). Compute a stable key so an edit (added/removed/changed animset) rebuilds.
    const lib = entity.has(AnimationLibrary) ? entity.get(AnimationLibrary)! : undefined;
    const anim = entity.has(SkeletalAnimator) ? entity.get(SkeletalAnimator)! : undefined;
    const effLib = effectiveLibrary(lib, anim?.animSet);
    const libKey = animationLibraryKey(effLib);

    // Model ref OR library set changed → rebuild from the new prototype (a removed
    // library clip must leave the mixer, which a partial merge can't undo).
    if (entry && (entry.modelRef !== sm.model || entry.libraryKey !== libKey)) {
      disposeSkinnedEntry(entry, scene);
      skinned.delete(id);
      entry = undefined;
    }

    if (!entry && sm.model) {
      const rigged = getRiggedModel(sm.model);
      if (!rigged) {
        // Not loaded yet — kick a lazy load (no-op once a scene has acquired it)
        // and skip rendering this entity until the prototype is in cache.
        ensureRiggedModelLoaded(sm.model);
        return;
      }
      const root = cloneSkeleton(rigged.prototype);
      const mixer = new THREE.AnimationMixer(root);
      // Percept (J3): journal clip loop/finish from the live mixer. THREE fires
      // `loop` per cycle for looping clips and `finished` only when a non-looping
      // (LoopOnce) clip ends. `entity` is captured for the entry's lifetime.
      const rigEntity = entity;
      // Only the PRIMARY surface journals (else two viewports double-fire), and only
      // while actually playing (mixer also advances during editor preview → skip).
      // Fire into the ACTIVE world via peek (never lazily allocate one). `state` is
      // stable per RenderState; getPlayState() is checked at event-fire time.
      const animEmit = (type: '@anim-loop' | '@anim-finish', e: unknown) => {
        if (!state.emitLifecycle || getPlayState() !== 'playing') return;
        const w = peekCurrentWorld();
        if (!w) return;
        const action = (e as { action?: THREE.AnimationAction }).action;
        emit(type, { entity: entityRef(rigEntity), clip: action?.getClip().name ?? '', t: actionNorm(action) }, w);
      };
      mixer.addEventListener('loop', (e) => animEmit('@anim-loop', e));
      mixer.addEventListener('finished', (e) => animEmit('@anim-finish', e));
      const actions = new Map<string, THREE.AnimationAction>();
      for (const clip of rigged.animations) actions.set(clip.name, mixer.clipAction(clip));
      const bones = new Map<string, THREE.Bone>();
      root.traverse((o) => { if ((o as THREE.Bone).isBone) bones.set(o.name, o as THREE.Bone); });
      scene.add(root);
      // Cache each ROOT bone's static wrapper prefix (clone-root → bone.parent), so the
      // bone bridge can read/write that bone's entity Transform in clone-root space (the
      // space the import authored it in — see SkinnedEntry.boneWrapperPrefix).
      root.updateMatrixWorld(true);
      const invRootWorld = _bonePrefixTmp.copy(root.matrixWorld).invert();
      const boneWrapperPrefix = new Map<string, { fwd: THREE.Matrix4; inv: THREE.Matrix4 }>();
      for (const bone of bones.values()) {
        const par = bone.parent as (THREE.Object3D & { isBone?: boolean }) | null;
        if (par && par.isBone) continue; // child bone — uses parent-local TRS
        if (!par) continue;
        const fwd = new THREE.Matrix4().multiplyMatrices(invRootWorld, par.matrixWorld);
        boneWrapperPrefix.set(bone.name, { fwd, inv: fwd.clone().invert() });
      }
      entry = {
        modelRef: sm.model, root, mixer, actions,
        firstClip: rigged.animations[0]?.name ?? '', bones,
        boneWrapperPrefix,
        nodes: buildNodes(root),
        clipParamSource: new Map(), libraryMerged: new Set(), libraryKey: libKey,
      };
      skinned.set(id, entry);
    }

    if (!entry) return;
    _activeSkinnedIds.add(id);

    // Merge any newly-loaded library/animSet clips this frame (lazy + idempotent).
    // Before driveAnimator so a freshly-bound clip can be the requested one.
    if (effLib && effLib.animSets && effLib.animSets.length) {
      mergeAnimationLibrary(entry, effLib);
      // A model with NO own clips (a bare rig) inherits its default clip from the
      // library, so autoplay + the empty-clip fallback still have something to play.
      if (!entry.firstClip && entry.actions.size > 0) {
        entry.firstClip = entry.actions.keys().next().value ?? '';
      }
    }

    // Timeline scrub-preview seek (Phase 5): while stopped, pose the mixer at an exact clip time
    // instead of advancing/crossfading it. Bypasses driveAnimator entirely (so the authored
    // SkeletalAnimator.clip isn't fought and no @anim-start fires during a scrub); Play clears
    // seeks (above) and falls through to driveAnimator.
    const seek = getPlayState() !== 'playing' ? getSkeletalSeek(id) : undefined;
    if (seek) {
      blendSkeletal(entry, seek);
    } else if (anim) {
      const prevClip = entry.current;
      driveAnimator(entry, anim);
      // Percept (J3): the resolved active clip CHANGED → a clip started. Primary
      // surface only (dedup vs the other viewport). NO play-state gate here (unlike
      // @anim-loop/@anim-finish): the active clip usually resolves on the play-reload's
      // first frame BEFORE getPlayState() flips to 'playing', and it only changes once,
      // so gating on playing would drop the start entirely (verified live). It fires
      // once on clip resolution — incl. scene load — which is informative, not spurious.
      if (state.emitLifecycle && entry.current && entry.current !== prevClip) {
        emit('@anim-start', { entity: entityRef(entity), clip: entry.current, t: actionNorm(entry.actions.get(entry.current)) }, world);
      }
    } else if (!entry.current && entry.firstClip) {
      // No animator trait → autoplay the first clip on a loop.
      entry.actions.get(entry.firstClip)!.play();
      entry.current = entry.firstClip;
      if (state.emitLifecycle) {
        emit('@anim-start', { entity: entityRef(entity), clip: entry.current, t: 0 }, world);
      }
    }

    applyTransform(entry.root, id, tf, callbacks);
  });

  // Reap entries for entities that vanished (deleted / deactivated / model cleared).
  for (const [id, entry] of skinned) {
    if (_activeSkinnedIds.has(id)) continue;
    disposeSkinnedEntry(entry, scene);
    skinned.delete(id);
  }

  // Apply per-mesh materials + visibility from child SkinnedMeshRenderer entities.
  // After the reap so a renderer never binds into a just-disposed entry.
  syncSkinnedMeshRenderers(world, state);

  // Advance every live mixer by this frame's delta — by play state:
  //  - PLAYING: engine Time (visual delta = smoothed cadence × timeScale) so
  //    skeletal respects pause/slow-mo/time-stop. (Previously this used its own
  //    performance.now() and kept animating while paused — the Phase 1 bug.)
  //  - PAUSED: freeze (dt 0). An explicit pause stops skeletal the same frame.
  //  - STOPPED (authoring): freeze too (dt 0) — NO wall-clock idle preview. "Not
  //    playing → no animation": the rig sits at its bind/static pose so you author
  //    against a stable pose, and Bone entities stay hand-posable (syncBones writes
  //    each Bone Transform back into the skeleton while stopped, so dragging a bone
  //    deforms the mesh). Press Play to animate. (Removing the wall-clock read here
  //    also drops scene3DSync from the determinism wall-clock allowlist.)
  const dt = mixerAdvanceDelta(world);
  if (dt > 0) {
    for (const id of _activeSkinnedIds) {
      skinned.get(id)!.mixer.update(dt);
      // NOTE: bone world matrices are refreshed by the renderer's own
      // updateMatrixWorld before draw. A forced refresh is needed ONLY so
      // syncBoneAttachments can read posed bones pre-render — so it's done there,
      // per-targeted-entry, instead of force-updating EVERY rig here every frame. (A5)
    }
  }

  // Percept read-back (S4): mirror each rig's live mixer state onto its
  // SkeletalAnimator so scene-state reports the RESOLVED clip, playhead (secs +
  // 0..1), blend weight and effective-paused — the numeric animation state the
  // authored fields can't show. Mirrors the Time-trait write-back pattern; runs
  // every frame (even frozen) so a paused/stopped rig reports its held pose. The
  // fields are runtimeOnly, so this never touches the serialized scene.
  const playing = getPlayState() === 'playing';
  world.query(SkeletalAnimator).updateEach(([sa], entity) => {
    const entry = skinned.get(entity.id());
    if (!entry) {
      // No live rig (deactivated, model cleared, or reaped this frame) — report
      // "not playing" instead of leaving the last live values stale.
      sa.activeClip = ''; sa.time = 0; sa.normalizedTime = 0; sa.weight = 0; sa.effectivePaused = true;
      return;
    }
    const cur = entry.current ? entry.actions.get(entry.current) : undefined;
    const duration = cur?.getClip()?.duration ?? 0;
    const time = cur ? cur.time : 0;
    sa.activeClip = entry.current ?? '';
    sa.time = time;
    // THREE keeps action.time in [0, duration] (wraps on loop, clamps on LoopOnce),
    // so plain division is the phase — and a finished one-shot (time===duration)
    // correctly reads 1, which `time % duration` would have reported as 0.
    sa.normalizedTime = duration > 0 ? Math.min(Math.max(time, 0) / duration, 1) : 0;
    sa.weight = cur ? cur.getEffectiveWeight() : 0;
    sa.effectivePaused = !playing || (cur ? cur.paused : true);
  });
}

// Scratch objects for the bone-attachment compose (avoid per-frame allocations).
const _bonePos = new THREE.Vector3();
const _boneQuat = new THREE.Quaternion();
const _boneScale = new THREE.Vector3();
const _attOffset = new THREE.Vector3();
const _attLocalQuat = new THREE.Quaternion();
const _attEuler = new THREE.Euler();
/** Skinned roots already force-posed this frame (so two attachments on the same
 *  rig don't double-update its matrix world). */
const _posedThisFrame = new Set<THREE.Object3D>();

/** Drive BoneAttachment entities: pin each to a named bone of a SkinnedModel's
 *  animated skeleton, applying the entity's Transform as a local offset in bone
 *  space. Runs AFTER syncSkinnedModels (bones posed + matrixWorld refreshed) so
 *  the attached object's world transform reflects the current animation frame. */
export function syncBoneAttachments(world: World, _scene: THREE.Scene, state: RenderState) {
  const { skinned, ecsObjects } = state;
  if (skinned.size === 0) return;

  _posedThisFrame.clear();
  world.query(Transform, BoneAttachment).updateEach(([tf, att], entity) => {
    if (!att.target || !att.bone) return;
    const id = entity.id();
    const obj = ecsObjects.get(id);
    if (!obj) return; // attached entity has no renderable yet

    // Resolve the target rig by its GUID through the maintained O(1) guid index
    // (self-healing on a miss) instead of rebuilding a full-world GUID→id map per
    // frame — the old path was O(N_entities) on the first attachment every frame
    // even though only the handful of attachment targets are needed. (rendering-3d F4)
    const targetEntity = findEntityByGuid(att.target, world);
    const targetId = targetEntity?.id();
    const entry = targetId != null ? skinned.get(targetId) : undefined;
    const bone = entry?.bones.get(att.bone);
    if (!entry || !bone) return;

    // Force-refresh THIS rig's world matrices (once per frame) so the bone is read
    // at its posed transform, before the renderer's own pre-draw update. Only the
    // rigs that are actual attachment targets pay this. (A5)
    if (!_posedThisFrame.has(entry.root)) {
      entry.root.updateMatrixWorld(true);
      _posedThisFrame.add(entry.root);
    }

    // Follow the bone's world POSITION + ROTATION, but keep the prop's OWN scale
    // (the entity Transform scale) — don't inherit the model's bake scale, which
    // would make any prop microscopic on a heavily-scaled rig. The entity's
    // Transform position is a local offset in world units, rotated into the bone's
    // orientation; its rotation composes onto the bone's.
    bone.matrixWorld.decompose(_bonePos, _boneQuat, _boneScale);
    _attLocalQuat.setFromEuler(_attEuler.set(tf.rx, tf.ry, tf.rz));
    obj.quaternion.copy(_boneQuat).multiply(_attLocalQuat);
    obj.position.copy(_attOffset.set(tf.x, tf.y, tf.z).applyQuaternion(_boneQuat)).add(_bonePos);
    obj.scale.set(tf.sx, tf.sy, tf.sz);
  });
}

// ── P7b: Bone two-way bridge (read-back → LateUpdate → write-back) ───────────
type BoneTf = { x: number; y: number; z: number; rx: number; ry: number; rz: number; sx: number; sy: number; sz: number };
type BoneEnt = { id(): number; get: (t: typeof Transform) => BoneTf | undefined; set: (t: typeof Transform, v: BoneTf) => void };
type BonePrefix = { fwd: THREE.Matrix4; inv: THREE.Matrix4 } | undefined;
const _boneBridge: { entity: BoneEnt; bone: THREE.Bone; hasClip: boolean; prefix: BonePrefix }[] = [];
// Scratch for the root-bone wrapper conversion (read-back / write-back) + clone-time prefix build.
const _bonePrefixTmp = new THREE.Matrix4();
const _boneBridgeMat = new THREE.Matrix4();
const _bonePrefixPos = new THREE.Vector3();
const _bonePrefixQuat = new THREE.Quaternion();
const _bonePrefixScl = new THREE.Vector3();

// Per-bone baseline = the mixer/bind pose expressed in the entity Transform's space
// (clone-root for a wrapper-baked root bone, else bone-local), stored in the SAME
// representation the Transform uses — pos3 + euler3 + scl3 = 9 floats — indexed by
// `_boneBridge` position. (Euler, not quaternion: read-back writes exactly this euler
// into the Transform, so the pure-clip compare is byte-identical; a quaternion baseline
// from a sheared decompose can't round-trip through euler and would falsely read dirty.)
// Captured in read-back, compared against the post-layer Transform to gate write-back.
// Grows to the max bone count seen; never shrinks.
let _boneBaseline = new Float64Array(0);
function baselineSlots(count: number): Float64Array {
  const need = count * 9;
  if (need > _boneBaseline.length) {
    const next = new Float64Array(Math.max(need, _boneBaseline.length * 2, 576));
    next.set(_boneBaseline);
    _boneBaseline = next;
  }
  return _boneBaseline;
}
/** Mixed absolute+relative compare, tolerant of the ~1e-6 noise a compose→decompose /
 *  quaternion→euler round-trip leaves but far below any real gizmo/Animator/LateUpdate
 *  edit. Used to detect whether a bone's Transform diverged from its mixer baseline. */
function boneApproxEq(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-5 * (1 + Math.max(Math.abs(a), Math.abs(b)));
}

/** Dev-only idempotency probe for `runLateUpdates`: snapshot/restore the Transform of
 *  every Bone entity in `_boneBridge` (the bones this frame's LateUpdates can edit). The
 *  guard double-runs the systems on the same captured pose and flags any drift. */
function boneTransformProbe(): IdempotencyProbe {
  const bridge = _boneBridge;
  return {
    capture() {
      const out = new Float64Array(bridge.length * 9);
      for (let i = 0; i < bridge.length; i++) {
        const tf = bridge[i].entity.get(Transform);
        if (!tf) continue;
        const o = i * 9;
        out[o] = tf.x; out[o + 1] = tf.y; out[o + 2] = tf.z;
        out[o + 3] = tf.rx; out[o + 4] = tf.ry; out[o + 5] = tf.rz;
        out[o + 6] = tf.sx; out[o + 7] = tf.sy; out[o + 8] = tf.sz;
      }
      return out;
    },
    restore(snap) {
      for (let i = 0; i < bridge.length; i++) {
        const o = i * 9;
        bridge[i].entity.set(Transform, {
          x: snap[o], y: snap[o + 1], z: snap[o + 2],
          rx: snap[o + 3], ry: snap[o + 4], rz: snap[o + 5],
          sx: snap[o + 6], sy: snap[o + 7], sz: snap[o + 8],
        });
      }
    },
  };
}
const _boneParentMap = new Map<number, number>();
const _boneBridgeEuler = new THREE.Euler();
const _boneIds = new Set<number>();
const _boneAffected = new Set<number>();
// Identity local fallback for applyTransform — bone descendants always have a
// computed worldTransform (they're non-root), so this is never actually read.
const _identityTf = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 };

/** Walk up `parentId` from a `Bone` entity to the nearest ancestor that carries a
 *  `SkinnedModel` (i.e. has a render entry) → that rig's `SkinnedEntry`. The bone
 *  hierarchy lives under the model root, Unity-style. Depth-capped against cycles. */
function resolveBoneRig(id: number, skinned: Map<number, SkinnedEntry>): SkinnedEntry | undefined {
  let cur = id;
  for (let i = 0; i < 128; i++) {
    const entry = skinned.get(cur);
    if (entry) return entry;
    const parent = _boneParentMap.get(cur);
    if (parent === undefined || parent === 0) return undefined;
    cur = parent;
  }
  return undefined;
}

/** Is `id` a bridged bone, or a (transitive) descendant of one? Used to find the
 *  renderables that ride a bone, so they can be re-placed the same frame the bone
 *  moves. Walks up `parentId`; depth-capped against cycles. */
function isUnderBone(id: number): boolean {
  let cur = id;
  for (let i = 0; i < 128; i++) {
    if (_boneIds.has(cur)) return true;
    const parent = _boneParentMap.get(cur);
    if (parent === undefined || parent === 0) return false;
    cur = parent;
  }
  return false;
}

/** P7b-1b: re-apply `Animator` clips that live INSIDE a `SkinnedModel` rig (on the
 *  model root or on a `Bone` entity) in the RENDER phase, after bone read-back, so a
 *  keyframe clip LAYERS ON TOP of (overrides) the skeletal mixer pose for the bones
 *  it targets — Unity's override-layer / avatar-mask shape. The playhead was already
 *  advanced by the pipeline `animationSystem`; here we re-pose at the current
 *  `Animator.time` ONLY (idempotent), because read-back has since overwritten the
 *  bone Transforms with the clip pose. An Animator NOT inside a rig resolves no rig
 *  and is left to `animationSystem` alone. Returns true if any animator posed. */
function applyBoneAnimators(world: World, skinned: Map<number, SkinnedEntry>): boolean {
  const pending: {
    rootId: number; clip: AnimationClipDef; t: number;
    from?: { clip: AnimationClipDef; time: number }; w: number;
  }[] = [];
  world.query(Animator).updateEach(([anim], entity) => {
    const id = entity.id();
    if (!anim.playing || deactivatedEntities.has(id)) return;
    const resolved = resolveActiveClip(anim);
    if (!resolved) return;
    if (!resolveBoneRig(id, skinned)) return; // a regular scene animator, not bone-targeting
    const clip = getAnimationClip(resolved.ref);
    if (!clip) return;
    // Re-pose at the CURRENT playhead/fade only (idempotent) — animationSystem already
    // advanced them this frame. Mirror its crossfade blend so a bone-layer clip switch
    // crossfades too (read-only here; the fade state was advanced in the pipeline pass).
    let from: { clip: AnimationClipDef; time: number } | undefined;
    let w = 1;
    const fadeDuration = resolved.fadeDuration ?? anim.fadeDuration;
    if (anim.fadeFrom && fadeDuration > 0 && anim.fadeElapsed < fadeDuration) {
      const fromEntry = resolveClipByName(anim, anim.fadeFrom);
      const fromClip = fromEntry ? getAnimationClip(fromEntry.ref) : null;
      if (fromClip) { from = { clip: fromClip, time: anim.fadeFromTime }; w = anim.fadeElapsed / fadeDuration; }
    }
    pending.push({ rootId: id, clip, t: anim.time, from, w });
  });
  if (!pending.length) return false;
  const index = buildEntityIndex(world);
  for (const p of pending) {
    if (p.from) applyClipAtTimeBlended(world, p.rootId, p.from, { clip: p.clip, time: p.t }, p.w, index);
    else applyClipAtTime(world, p.rootId, p.clip, p.t, index);
  }
  return true;
}

/** Drive `Bone` entities (Phase 7b) — the two-way bridge between a `SkinnedModel`'s
 *  THREE.Bones and the ECS `Bone` entities, every frame, post-pose:
 *
 *    1. read-back + baseline — capture each bone's posed transform (the BASELINE), and
 *       for a CLIP-DRIVEN bone while Playing copy it into the entity's `Transform` (so
 *       children parented under a bone follow + a LateUpdate can layer on top).
 *    2. layer — a bone-targeting `Animator` (P7b-1b) re-poses ON TOP of the clip, then
 *       LateUpdate systems edit those Transforms (both Play only).
 *    3. write-back — copy a bone's `Transform` back into the THREE.Bone ONLY if it
 *       DIVERGED from the baseline (a per-bone dirty flag — see below).
 *    4. re-propagate — recompute world transforms so a renderable parented UNDER a bone
 *       (a sword in a hand) tracks the bone THIS frame, not one frame late (P7b-1b).
 *
 *  Write-back is dirty-gated: the THREE.Bone is the source of truth until something moves
 *  its entity `Transform` off the mixer/bind baseline, then the `Transform` wins. So:
 *   - **clip-driven, Playing, untouched** → read-back fills the Transform, nothing diverges
 *     → write-back SKIPPED, the mixer pose renders verbatim (no lossy compose→decompose
 *     echo — that echo is what made a wrapper-baked rig jitter on a fast clip).
 *   - **clip-driven + a layer** → an Animator/LateUpdate moves some bones off baseline;
 *     ONLY those write back (per-bone, so siblings the clip still drives stay verbatim).
 *   - **no clip** (a hand-posed rig: SkinnedModel + Bone entities, no animation) → NO
 *     read-back; the entity Transform IS the pose, diverges from the bind baseline, and
 *     writes back. Editing a bone in the inspector/gizmo deforms the mesh and STICKS.
 *   - **Stopped** → mixer frozen (syncSkinnedModels uses dt 0, no wall-clock preview); the
 *     entity Transforms are the pose, so a hand-posed/dragged bone diverges and writes back,
 *     while an untouched bone stays put. Press Play to let the clip drive again.
 *  Read-back never runs while Stopped (authoring stays serialize-clean). Runs once per
 *  active 3D viewport; after `syncSkinnedModels`, before attachments. */
export function syncBones(world: World, _scene: THREE.Scene, state: RenderState) {
  const { skinned } = state;
  if (skinned.size === 0) return;
  // Treat Animation-editor preview like Playing: the mixer just posed the bones
  // (syncSkinnedModels advanced it with the preview delta), so read-back must copy
  // that pose into the bone Transforms — otherwise step-3 write-back sees the
  // entity Transforms diverge from the freshly-animated baseline and clobbers the
  // mixer pose back to the static/bind values, freezing the preview.
  const playing = getPlayState() !== 'stopped' || isSkeletalPreviewing();
  // A timeline scrub-seek (Phase 5) poses the mixer while STOPPED (seekSkeletal → mixer.update(0)).
  // Read-back must copy that seeked pose into the bone Transforms too, else write-back would
  // clobber it back to bind — same reasoning as preview above. But it is NOT "playing": the layer
  // pass (bone Animators + LateUpdates, step 2) must stay off during a scrub, so keep that gated on
  // `playing` and use `readback` only for step 1.
  const readback = playing || hasSkeletalSeeks();

  // Parent map for ancestor resolution (parentId is a runtime entity id).
  _boneParentMap.clear();
  world.query(EntityAttributes).updateEach(([ea]: [{ parentId: number }], e) => {
    if (ea.parentId) _boneParentMap.set(e.id(), ea.parentId);
  });

  // ── 1. read-back + baseline capture: posed bone → entity Transform. The BASELINE
  // (the bone's current pose in entity space) is captured for EVERY bone, every frame;
  // it's what write-back compares against to decide if anything moved the bone off the
  // mixer/bind pose. read-back (copy baseline into the Transform) runs only for a
  // clip-driven bone while Playing — otherwise the entity Transform IS the authored pose. ──
  _boneBridge.length = 0;
  _boneIds.clear();
  let anyClipDriven = false;
  world.query(Transform, Bone).updateEach(([tf, b], entity) => {
    const id = entity.id();
    if (!b.name || deactivatedEntities.has(id)) return;
    const entry = resolveBoneRig(id, skinned);
    const bone = entry?.bones.get(b.name);
    if (!bone) return;
    const hasClip = !!entry!.current;
    // Root bones live in CLONE-ROOT space in the entity world (the wrapper is baked
    // in); child bones use parent-local TRS. `prefix` set ⟺ this is a root bone.
    const prefix = entry!.boneWrapperPrefix?.get(b.name);
    if (prefix) {
      // boneLocal → clone-root space: prefix.fwd · compose(bone TRS).
      _boneBridgeMat.compose(bone.position, bone.quaternion, bone.scale).premultiply(prefix.fwd)
        .decompose(_bonePrefixPos, _bonePrefixQuat, _bonePrefixScl);
    } else {
      _bonePrefixPos.copy(bone.position); _bonePrefixQuat.copy(bone.quaternion); _bonePrefixScl.copy(bone.scale);
    }
    _boneBridgeEuler.setFromQuaternion(_bonePrefixQuat);
    const i = _boneBridge.length;
    const base = baselineSlots(i + 1);
    const o = i * 9;
    base[o] = _bonePrefixPos.x; base[o + 1] = _bonePrefixPos.y; base[o + 2] = _bonePrefixPos.z;
    base[o + 3] = _boneBridgeEuler.x; base[o + 4] = _boneBridgeEuler.y; base[o + 5] = _boneBridgeEuler.z;
    base[o + 6] = _bonePrefixScl.x; base[o + 7] = _bonePrefixScl.y; base[o + 8] = _bonePrefixScl.z;
    if (readback && hasClip) {
      anyClipDriven = true;
      // read-back: copy the baseline (this exact euler) into the entity Transform.
      tf.x = _bonePrefixPos.x; tf.y = _bonePrefixPos.y; tf.z = _bonePrefixPos.z;
      tf.rx = _boneBridgeEuler.x; tf.ry = _boneBridgeEuler.y; tf.rz = _boneBridgeEuler.z;
      tf.sx = _bonePrefixScl.x; tf.sy = _bonePrefixScl.y; tf.sz = _bonePrefixScl.z;
    }
    _boneBridge.push({ entity, bone, hasClip, prefix });
    _boneIds.add(id);
  });

  // ── 2. layer (Play only): a bone-targeting Animator overrides the clip pose, then
  // game LateUpdates run ON TOP of that. ──
  let animatorPosed = false;
  if (playing) {
    animatorPosed = applyBoneAnimators(world, skinned);
    // Pass the dev idempotency probe only in DEV — in prod it's undefined (zero overhead).
    runLateUpdates(world, import.meta.env?.DEV ? boneTransformProbe() : undefined);
  }

  // ── 3. write-back: entity Transform → THREE.Bone, but ONLY for a bone whose Transform
  // DIVERGED from its mixer/bind baseline (a per-bone dirty flag). What moves a bone off
  // baseline: a gizmo/inspector edit, a bone-targeting Animator, a LateUpdate, or an
  // authored hand-pose on a no-clip/stopped rig — exactly the cases the entity Transform
  // is the source of truth. A bone nobody touched (pure clip playback, or an idle stopped
  // rig) is byte-equal to its baseline → skipped, so the mixer pose stays authoritative.
  //
  // This replaces the old `playing && hasClip` echo: round-tripping the mixer pose through
  // compose→decompose every frame degraded it (decompose drops the shear a wrapper-baked
  // root bone's non-uniform scale + rotation produces) → visible jitter on a fast clip
  // like Run. Being PER-BONE (not the coarse global `!layered`) also means one Animator/IK
  // bone never drags its clip-driven siblings back through that echo. ──
  for (let i = 0; i < _boneBridge.length; i++) {
    const { entity, bone, prefix } = _boneBridge[i];
    const tf = entity.get(Transform);
    if (!tf) continue;
    // Dirty? Compare the post-layer Transform to the captured baseline, component-wise
    // in the Transform's own (pos/euler/scale) representation. read-back wrote this exact
    // baseline, so a clip-driven bone nobody touched compares equal → skipped; an
    // Animator/LateUpdate/gizmo edit shifts a component past the noise floor → written.
    const o = i * 9;
    const diverged =
      !boneApproxEq(tf.x, _boneBaseline[o]) || !boneApproxEq(tf.y, _boneBaseline[o + 1]) || !boneApproxEq(tf.z, _boneBaseline[o + 2]) ||
      !boneApproxEq(tf.rx, _boneBaseline[o + 3]) || !boneApproxEq(tf.ry, _boneBaseline[o + 4]) || !boneApproxEq(tf.rz, _boneBaseline[o + 5]) ||
      !boneApproxEq(tf.sx, _boneBaseline[o + 6]) || !boneApproxEq(tf.sy, _boneBaseline[o + 7]) || !boneApproxEq(tf.sz, _boneBaseline[o + 8]);
    if (!diverged) continue;
    if (prefix) {
      // Root bone: entity Transform is clone-root space → strip the wrapper back to
      // bone-local before writing the THREE.Bone (the inverse of read-back).
      _boneBridgeEuler.set(tf.rx, tf.ry, tf.rz);
      _bonePrefixQuat.setFromEuler(_boneBridgeEuler);
      _boneBridgeMat.compose(_bonePrefixPos.set(tf.x, tf.y, tf.z), _bonePrefixQuat, _bonePrefixScl.set(tf.sx, tf.sy, tf.sz))
        .premultiply(prefix.inv)
        .decompose(bone.position, bone.quaternion, bone.scale);
    } else {
      bone.position.set(tf.x, tf.y, tf.z);
      _boneBridgeEuler.set(tf.rx, tf.ry, tf.rz);
      bone.quaternion.setFromEuler(_boneBridgeEuler);
      bone.scale.set(tf.sx, tf.sy, tf.sz);
    }
  }

  // ── 4. same-frame child-of-bone placement (P7b-1b). Bone Transforms we just set
  // (read-back / Animator / LateUpdate) were NOT seen by the pipeline's transform
  // propagation (it ran before the mixer posed). Re-propagate now and re-place any
  // renderable under a bone so it tracks the bone THIS frame instead of one late.
  // Skipped unless a bone Transform actually changed (a static no-clip rig's children
  // were already placed correctly by the pipeline). ──
  if (readback && _boneIds.size && (anyClipDriven || animatorPosed || hasLateUpdates())) {
    _boneAffected.clear();
    for (const id of _boneParentMap.keys()) {
      if (isUnderBone(id)) _boneAffected.add(id);
    }
    if (_boneAffected.size) {
      transformPropagationSystem(world);
      for (const id of _boneAffected) {
        const obj = state.ecsObjects.get(id);
        if (obj) applyTransform(obj, id, _identityTf);
      }
    }
  }
}

export function syncRenderables(world: World, scene: THREE.Scene, state: RenderState, callbacks?: SyncCallbacks) {
  const { ecsObjects, ecsSprites, ecsMaterials, ecsColors, ecsSizes, ownsGeometry } = state;
  _activeRenderIds.clear();

  // ── GLB meshes (Renderable3D) ─────────────────────────
  world.query(Transform, Renderable3D).updateEach(([tf, rend], entity) => {
    if (!rend.isVisible || deactivatedEntities.has(entity.id())) return;
    const id = entity.id();
    _activeRenderIds.add(id);

    let obj = ecsObjects.get(id);

    if (obj && ecsSprites.get(id) !== rend.mesh) {
      scene.remove(obj);
      ecsObjects.delete(id);
      ecsSprites.delete(id);
      ownsGeometry.delete(id);
      obj = undefined;
    }

    if (!obj && rend.mesh) {
      // Try the LOD-aware path first — when the parent model has baked LODs,
      // wrap them in THREE.LOD so distance-based switching is automatic.
      const lod = resolveMeshLodInfo(rend.mesh);
      if (lod) {
        const material = resolveMaterialForMesh(rend.material, rend.mesh) || lod.templates[0].material;
        const lodObj = new THREE.LOD();
        for (let i = 0; i < lod.templates.length; i++) {
          const mesh = new THREE.Mesh(lod.templates[i].geometry, material);
          lodObj.addLevel(mesh, lod.distances[i] ?? 0);
        }
        applyShadowFlags(lodObj);
        scene.add(lodObj);
        ecsObjects.set(id, lodObj);
        ecsSprites.set(id, rend.mesh);
        obj = lodObj;
      } else {
        const template = resolveMeshTemplate(rend.mesh);
        if (template) {
          const material = resolveMaterialForMesh(rend.material, rend.mesh) || template.material;
          const mesh = new THREE.Mesh(template.geometry, material);
          applyShadowFlags(mesh);
          scene.add(mesh);
          ecsObjects.set(id, mesh);
          ecsSprites.set(id, rend.mesh);
          obj = mesh;
        }
      }
    }

    // Update material (GLB: .mat.json only, no inline textures)
    if (obj && rend.mesh) {
      const instanced = isMaterialInstanced(entity);
      // MaterialInstance (a per-entity material clone driven by materialInstanceSystem) takes
      // precedence over Tint — both would otherwise claim mesh.material and fight each frame.
      const tinted = !instanced && entity.has(Tint);
      syncMaterial(obj, id, rend.material || '', state, tinted, instanced);
      // Per-entity Tint: bind a tinted clone of the resolved material. Passing
      // isTinted above stops syncMaterial from re-binding the base each frame, so
      // this block owns the material — the clone cache + `!==` guard then make it
      // a genuine no-op once applied (no per-frame reassignment). Removing the
      // Tint trait lets syncMaterial restore the base on the next frame.
      if (tinted) {
        const t = entity.get(Tint)!;
        const clone = tintedMaterial(rend.material || '', t.color, t.amount);
        if (clone) {
          for (const child of materialTargetsOf(obj)) {
            if (child.material !== clone) child.material = clone;
          }
        }
      }
    }

    if (obj) applyTransform(obj, id, tf, callbacks);
  });

  // ── Primitive meshes (Renderable3DPrimitive) ──────────
  world.query(Transform, Renderable3DPrimitive).updateEach(([tf, rend], entity) => {
    if (!rend.isVisible || deactivatedEntities.has(entity.id())) return;
    const id = entity.id();
    _activeRenderIds.add(id);

    let obj = ecsObjects.get(id);

    // Recreate when the shape kind OR size changed. The primitive's geometry
    // is baked in createPrimitiveMesh, so a size change can't be applied via
    // scale (that would also affect children) — geometry has to be rebuilt.
    const sizeChanged = obj && ecsSizes.get(id) !== rend.size;
    if (obj && (ecsSprites.get(id) !== rend.mesh || sizeChanged)) {
      scene.remove(obj);
      // Dispose owned geometry from the previous mesh so size churn doesn't leak.
      if (ownsGeometry.has(id) && (obj as THREE.Mesh).geometry) {
        (obj as THREE.Mesh).geometry.dispose();
      }
      ecsObjects.delete(id);
      ecsSprites.delete(id);
      ecsColors.delete(id);
      ecsMaterials.delete(id);
      ecsSizes.delete(id);
      ownsGeometry.delete(id);
      obj = undefined;
    }

    if (!obj) {
      // Skip the default material when an override is set — avoids the
      // create-then-immediately-dispose churn we'd otherwise pay on every spawn.
      const hasOverride = !!rend.material;
      obj = createPrimitiveMesh(rend.mesh, rend.size, rend.color, hasOverride)!;
      if (!hasOverride) {
        // Track the primitive's default material as owned (safe to dispose)
        _ownedMaterials.add((obj as THREE.Mesh).material as THREE.Material);
      } else if (rend.material) {
        const resolved = resolveMaterial(rend.material);
        if (resolved) (obj as THREE.Mesh).material = resolved;
      }
      applyShadowFlags(obj);
      scene.add(obj);
      ecsObjects.set(id, obj);
      ecsSprites.set(id, rend.mesh);
      ecsColors.set(id, rend.color);
      ecsMaterials.set(id, rend.material || '');
      ecsSizes.set(id, rend.size);
      ownsGeometry.add(id);
    }

    // Material override — a .mat.json material GUID (empty = engine default).
    const instanced = isMaterialInstanced(entity);
    syncMaterial(obj as THREE.Mesh, id, rend.material || '', state, false, instanced);

    // Update color when changed (only applies to the default material, not a .mat.json). A
    // single default-material primitive is NOT a supported MaterialInstance prop base (its
    // material is recreated on resize — see resolvePropBase), so `rend.color` stays the live
    // color path for it; a prop override there is skipped upstream, not fought here.
    if (!(rend.material || '')) {
      const prevColor = ecsColors.get(id);
      if (prevColor !== rend.color) {
        ecsColors.set(id, rend.color);
        ((obj as THREE.Mesh).material as THREE.MeshStandardMaterial).color.setHex(rend.color);
      }
    }

    applyTransform(obj, id, tf, callbacks);
  });

  for (const [id, obj] of ecsObjects) {
    if (!_activeRenderIds.has(id)) {
      callbacks?.onMeshRemoved?.(id, obj);
      scene.remove(obj);
      if (ownsGeometry.has(id) && (obj as THREE.Mesh).geometry) {
        (obj as THREE.Mesh).geometry.dispose();
      }
      // Dispose material only if owned (created inline for this entity). Route through
      // materialTargetsOf so a LOD object's owned materials (on its child meshes, not
      // LOD.material which is undefined) are reaped too — mirrors syncMaterial. (F11)
      for (const target of materialTargetsOf(obj)) {
        const mat = target.material as THREE.Material;
        if (mat && _ownedMaterials.has(mat)) {
          _ownedMaterials.delete(mat);
          mat.dispose();
        }
      }
      ecsObjects.delete(id);
      ecsSprites.delete(id);
      ecsColors.delete(id);
      ecsMaterials.delete(id);
      ownsGeometry.delete(id);
    }
  }
}

// ── Billboarded 2D skinned sprites (2.5D) ───────────────────────────────
//
// A `SkinnedSprite2D` + `Billboard3D` entity is a CPU-skinned 2D rig drawn INTO the
// Three.js scene as a camera-facing mesh. The deform is reused verbatim from
// `skin2DBuffers` (the same seam PixiJS `Scene2D` reads); this pass only PRESENTS it
// in 3D — one alpha-tested `THREE.Mesh` per rig part (so it writes depth ⇒ correct
// 2.5D occlusion), rotated toward the camera each frame by `orientBillboards`.
//
// Structure per entity: outer `group` (scene child — `applyTransform` sets its
// position+scale from the entity Transform, `orientBillboards` overrides its
// rotation) → inner `flip` group (flipX/flipY mirror + the pixels-per-unit scale, so
// the billboard rotation stays independent of it) → one mesh per part.

const _billboardActive = new Set<number>();
const _billboardCamPos = new THREE.Vector3();
const _billboardOrder: BillboardEntry[] = []; // scratch: depth-sorted entries in orientBillboards
// renderOrder = BASE + depthRank*STRIDE + part.order. BASE clears opaque geometry (default 0)
// so sprites composite after the world; STRIDE is the per-entity band (> any rig's part count).
const BILLBOARD_RENDER_ORDER_BASE = 10000;
const BILLBOARD_RANK_STRIDE = 1000;

/** Topology signature — a change forces a full geometry rebuild (vs. a cheap
 *  position re-upload on a deform bump). */
function billboardSig(parts: Skin2DPartBuffer[]): string {
  return parts.map((p) => {
    const fk = p.uvRect ? `${p.uvRect.u0},${p.uvRect.v0},${p.uvRect.uw},${p.uvRect.vh}` : '';
    return `${p.sprite ?? p.url}#${fk}#${p.positions.length}#${p.indices.length}`;
  }).join('|');
}

/** Build a part's geometry: rig pixel-space verts → local mesh space. Positions are
 *  RAW pixels with Y negated (2D y-down → 3D y-up); the pixels-per-unit + flip scale
 *  lives on the parent `flip` group, so a ppu change never rebuilds geometry. */
function buildBillboardGeometry(part: Skin2DPartBuffer): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  const vcount = part.positions.length / 2;
  const pos = new Float32Array(vcount * 3);
  for (let i = 0; i < vcount; i++) {
    pos[i * 3] = part.positions[i * 2];
    pos[i * 3 + 1] = -part.positions[i * 2 + 1];
    pos[i * 3 + 2] = 0;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  // UVs remapped into the sprite's sub-rect on its shared texture PAGE (atlas), to MATCH
  // the page texture loaded from part.url — exactly what Scene2D does. (A whole-image
  // sprite has no uvRect and these pass through as 0..1.) The page is forced bottom-origin
  // (see loadBillboardPage) so these page-space UVs sample right-side up with no V flip.
  geo.setAttribute('uv', new THREE.BufferAttribute(frameSkin2DUVs(part.uvs, part.uvRect), 2));
  geo.setIndex(new THREE.BufferAttribute(part.indices.slice(), 1));
  return geo;
}

/** Re-upload deformed positions in place (index/uv unchanged). Frustum culling is
 *  off on billboard meshes, so no bounding-volume recompute is needed. */
function uploadBillboardPositions(entry: BillboardEntry, buf: NonNullable<ReturnType<typeof getSkin2DBuffer>>): void {
  for (let pi = 0; pi < entry.meshes.length && pi < buf.parts.length; pi++) {
    const src = buf.parts[pi].positions;
    const attr = entry.meshes[pi].geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    const vcount = src.length / 2;
    for (let i = 0; i < vcount; i++) {
      arr[i * 3] = src[i * 2];
      arr[i * 3 + 1] = -src[i * 2 + 1];
      arr[i * 3 + 2] = 0;
    }
    attr.needsUpdate = true;
  }
}

function disposeBillboardEntry(entry: BillboardEntry, scene: THREE.Scene): void {
  entry.disposed = true; // in-flight page loads dispose their own texture instead of writing here
  scene.remove(entry.group);
  for (const m of entry.meshes) {
    entry.flip.remove(m); // detach so a stale mesh can't be mistaken for live (see load guard)
    m.geometry.dispose();
    (m.material as THREE.Material).dispose();
  }
  // Page textures are shared across parts of a rig — dispose each unique one once.
  const disposed = new Set<THREE.Texture>();
  for (const t of entry.textures) {
    if (t && !disposed.has(t)) { disposed.add(t); t.dispose(); }
  }
}

/** Load a texture-page URL (KTX2 or WebP/PNG) as a THREE texture. Mirrors what Scene2D
 *  loads (part.url — the sprite's shared page), so the page + the buffer's page-space UVs
 *  match. Both are forced BOTTOM-origin: KTX2 is inherently bottom-origin (flipY ignored),
 *  and we set flipY=false on plain textures so a single UV convention works for both with
 *  no per-part V flip. */
function loadBillboardPage(url: string): Promise<THREE.Texture> {
  const isKtx = /\.ktx2(\?|$)/.test(url);
  const loader = isKtx ? getKTX2Loader() : new THREE.TextureLoader();
  return (loader.loadAsync(url) as Promise<THREE.Texture>).then((tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    if (!isKtx) { tex.flipY = false; tex.needsUpdate = true; }
    return tex;
  });
}

/** Create the THREE objects for one billboarded rig and kick off texture loads. */
function buildBillboardEntry(
  ss: { rig: string; color: number; opacity: number },
  opt: { mode: 'cylindrical' | 'spherical' | 'flat'; alphaTest: number },
  buf: NonNullable<ReturnType<typeof getSkin2DBuffer>>,
  scene: THREE.Scene,
): BillboardEntry {
  const group = new THREE.Group();
  const flip = new THREE.Group();
  group.add(flip);
  const entry: BillboardEntry = {
    rigRef: ss.rig, sig: billboardSig(buf.parts), mode: opt.mode, group, flip,
    meshes: [], orders: [], textures: [], deformVersion: -1, disposed: false,
  };
  // Load each distinct page URL once and share across the parts that use it.
  const pageCache = new Map<string, Promise<THREE.Texture>>();
  buf.parts.forEach((part) => {
    // Coplanar parts layered by painter's order (Scene2D uses zIndex): draw back-to-front
    // by rig order with depthWrite OFF so they don't z-fight/occlude each other, but
    // depthTest ON so the 3D world still occludes the sprite (2.5D). renderOrder (set per
    // frame by orientBillboards) is offset past opaque geometry so the sprite composites
    // after the world, and depth-ranked so overlapping billboards order by distance.
    const mat = new THREE.MeshBasicMaterial({
      transparent: true, alphaTest: opt.alphaTest, depthWrite: false, depthTest: true,
      side: THREE.DoubleSide, toneMapped: false,
    });
    mat.color.setHex(ss.color);
    mat.opacity = ss.opacity;
    const mesh = new THREE.Mesh(buildBillboardGeometry(part), mat);
    mesh.frustumCulled = false; // billboard rotation + few instances ⇒ skip cull recompute
    flip.add(mesh);
    const idx = entry.meshes.length;
    entry.meshes.push(mesh);
    entry.orders.push(part.order);
    entry.textures.push(null);
    if (part.url) {
      let job = pageCache.get(part.url);
      if (!job) { job = loadBillboardPage(part.url); pageCache.set(part.url, job); }
      job.then((tex) => {
        // Disposed/rebuilt mid-load: the entry is dead and its texture-dispose loop
        // already ran (saw null here), so free this late arrival ourselves — else it leaks.
        if (entry.disposed) { tex.dispose(); return; }
        mat.map = tex; mat.needsUpdate = true;
        entry.textures[idx] = tex;
      }).catch((e) => console.warn(`[billboard] texture load failed: ${part.url}`, e));
    }
  });
  scene.add(group);
  return entry;
}

/** Normalised presentation options shared by the camera-facing (Billboard3D) and
 *  flat (FlatSprite3D) paths — the only per-trait difference feeding the 3D sprite. */
interface SpriteMode3D {
  mode: 'cylindrical' | 'spherical' | 'flat';
  alphaTest: number;
  pixelsPerUnit: number;
  anchor: 'bottom' | 'center';
}

/** Build/update one SkinnedSprite2D's 3D entry (billboard OR flat) from `skin2DBuffers`.
 *  Camera-INDEPENDENT — `orientBillboards` does the per-frame facing / render-order. */
function syncSkinnedSprite3D(
  scene: THREE.Scene, state: RenderState, id: number,
  tf: { x: number; y: number; z: number; rx: number; ry: number; rz: number; sx: number; sy: number; sz: number },
  ss: { rig: string; color: number; opacity: number; flipX: boolean; flipY: boolean; isVisible: boolean },
  opt: SpriteMode3D, callbacks?: SyncCallbacks,
): void {
  const { billboards } = state;
  const buf = getSkin2DBuffer(id);
  if (!buf || !buf.parts.length) return; // rig not deformed yet — skin2DSystem retries next frame
  _billboardActive.add(id);

  let entry = billboards.get(id);
  const sig = billboardSig(buf.parts);
  if (entry && (entry.rigRef !== ss.rig || entry.sig !== sig)) {
    disposeBillboardEntry(entry, scene); billboards.delete(id); entry = undefined;
  }
  if (!entry) { entry = buildBillboardEntry(ss, opt, buf, scene); billboards.set(id, entry); }
  entry.mode = opt.mode;

  // Cheap per-frame sync of the things that change without a topology rebuild:
  // tint / opacity / cutout, plus per-part visibility + paint order (an editor
  // toggle/reorder isn't in billboardSig, so it must be applied here, mirroring Scene2D).
  for (let pi = 0; pi < entry.meshes.length; pi++) {
    const m = entry.meshes[pi];
    const part = buf.parts[pi];
    const mat = m.material as THREE.MeshBasicMaterial;
    if (mat.color.getHex() !== ss.color) mat.color.setHex(ss.color);
    if (mat.opacity !== ss.opacity) mat.opacity = ss.opacity;
    if (mat.alphaTest !== opt.alphaTest) { mat.alphaTest = opt.alphaTest; mat.needsUpdate = true; }
    const vis = part?.visible !== false;
    if (m.visible !== vis) m.visible = vis;
    entry.orders[pi] = part?.order ?? 0; // renderOrder is applied by orientBillboards
  }

  // Pixels-per-unit + flip live on the inner group (no geometry rebuild on change).
  const ppu = opt.pixelsPerUnit > 0 ? opt.pixelsPerUnit : 100;
  const sy = (ss.flipY ? -1 : 1) / ppu;
  entry.flip.scale.set((ss.flipX ? -1 : 1) / ppu, sy, 1);
  if (opt.mode === 'flat') {
    // Lay the sprite plane into the world XZ ground plane: rotate -90° about X so the
    // geometry's local +Y (texture down) runs along world −Z. The entity Transform then
    // yaws it about world Y (heading) — `orientBillboards` leaves flat rotation alone.
    // Centred pivot (author the rig pivot-centred so it rotates about its middle).
    entry.flip.rotation.x = -Math.PI / 2;
    entry.flip.position.set(0, 0, 0);
  } else {
    // Vertical anchor: place `flip` so the chosen pivot of the BIND-pose extent lands at
    // the group origin (= the entity Transform, and the billboard's rotation pivot). The
    // extent is the buffer's bind-pose extent (stable across animation — computed once
    // from the un-skinned verts), so an animated foot-lift still leaves the ground.
    // Geometry maps pixel y → -y, then `sy` scales it, so the extent spans [yTop, yBot].
    entry.flip.rotation.x = 0;
    const yTop = sy * -buf.bindMinY;
    const yBot = sy * -buf.bindMaxY;
    entry.flip.position.set(0, opt.anchor === 'center'
      ? -(yTop + yBot) / 2                 // mid-point at origin (floating)
      : -Math.min(yTop, yBot), 0);         // lowest vertex (feet) at origin (grounded)
  }

  // Re-upload deformed positions only when the pose actually moved.
  if (entry.deformVersion !== buf.version) { uploadBillboardPositions(entry, buf); entry.deformVersion = buf.version; }

  // Placement from the entity Transform. Billboard rotation is overridden by
  // orientBillboards; flat mode keeps this Transform rotation (heading yaw).
  applyTransform(entry.group, id, tf, callbacks);
  entry.group.visible = ss.isVisible && !deactivatedEntities.has(id);
}

/**
 * Build/update the 3D meshes for every `SkinnedSprite2D` promoted into the Three.js
 * scene — camera-facing (`Billboard3D`) AND flat ground-plane (`FlatSprite3D`) — from
 * the shared `skin2DBuffers`. Camera-INDEPENDENT (geometry + material + placement only)
 * so it runs inside the shared render core and the offscreen capture alike;
 * `orientBillboards` does the per-frame facing / render-order with each caller's camera.
 */
export function syncBillboardSprites(world: World, scene: THREE.Scene, state: RenderState, callbacks?: SyncCallbacks) {
  const { billboards } = state;
  _billboardActive.clear();
  world.query(Transform, SkinnedSprite2D, Billboard3D).updateEach(([tf, ss, bb], entity) => {
    syncSkinnedSprite3D(scene, state, entity.id(), tf, ss,
      { mode: bb.mode, alphaTest: bb.alphaTest, pixelsPerUnit: bb.pixelsPerUnit, anchor: bb.anchor }, callbacks);
  });
  world.query(Transform, SkinnedSprite2D, FlatSprite3D).updateEach(([tf, ss, fs], entity) => {
    syncSkinnedSprite3D(scene, state, entity.id(), tf, ss,
      { mode: 'flat', alphaTest: fs.alphaTest, pixelsPerUnit: fs.pixelsPerUnit, anchor: 'center' }, callbacks);
  });

  // Sweep entities that no longer render in 3D (removed, or lost the required trait).
  for (const [id, entry] of billboards) {
    if (!_billboardActive.has(id)) { disposeBillboardEntry(entry, scene); billboards.delete(id); }
  }
}

/**
 * Per-frame camera-facing rotation. MUST run every frame with the camera actually
 * being rendered (the camera moves even when a pose is idle), so it is separate from
 * the version-gated `syncBillboardSprites` and each caller invokes it with its own
 * camera (runtime game cam / editor orbit cam / deterministic capture cam).
 */
export function orientBillboards(state: RenderState, camera: THREE.Camera) {
  // Text3D billboards: face the camera (screen-aligned). Runs regardless of whether
  // any skinned-sprite billboards exist, so it's BEFORE the early-return below.
  if (state.textMeshes.size > 0) {
    for (const entry of state.textMeshes.values()) {
      if (entry.billboard && entry.group.visible) entry.group.quaternion.copy(camera.quaternion);
    }
  }
  if (state.billboards.size === 0) return;
  camera.getWorldPosition(_billboardCamPos);
  // Depth-rank visible billboards far→near so their transparent, depth-write-OFF parts
  // composite by distance (a near sprite paints over a far one where they overlap). Within
  // one rig, `part.order` keeps the paint order. THREE's transparent sort keys on
  // renderOrder BEFORE camera distance, so distance must be baked into renderOrder here —
  // a per-entity depth band (`RANK_STRIDE` > any rig's part count) plus the intra-rig order.
  _billboardOrder.length = 0;
  for (const entry of state.billboards.values()) {
    if (!entry.group.visible) continue;
    _billboardOrder.push(entry);
  }
  _billboardOrder.sort((a, b) =>
    _billboardCamPos.distanceToSquared(b.group.position) - _billboardCamPos.distanceToSquared(a.group.position),
  ); // farthest first (lowest renderOrder → drawn first / behind)
  for (let rank = 0; rank < _billboardOrder.length; rank++) {
    const entry = _billboardOrder[rank];
    const base = BILLBOARD_RENDER_ORDER_BASE + rank * BILLBOARD_RANK_STRIDE;
    for (let i = 0; i < entry.meshes.length; i++) entry.meshes[i].renderOrder = base + entry.orders[i];

    // Flat sprites lie in the ground plane and KEEP their entity-Transform rotation
    // (heading yaw applied by applyTransform) — only depth-rank them, never re-orient.
    if (entry.mode === 'flat') continue;

    const g = entry.group;
    if (entry.mode === 'spherical') {
      g.quaternion.copy(camera.quaternion); // full-face: parallel to the camera plane
    } else {
      // Y-locked: yaw so the sprite's +Z faces the camera horizontally, staying upright.
      const dx = _billboardCamPos.x - g.position.x;
      const dz = _billboardCamPos.z - g.position.z;
      g.rotation.set(0, Math.atan2(dx, dz), 0);
    }
  }
}

/**
 * The unconditional renderable + skeletal core of the per-frame ECS→Three sync,
 * run verbatim by `Scene3D.renderFrame`, the offscreen `render_scene` capture,
 * AND `SceneView.animate`. These four calls always run together, in this order,
 * in every 3D path.
 *
 * Keeping them in ONE place is the structural guard for cross-cutting theme T2
 * (engine-review/00-cross-cutting-themes.md): the orchestration around the
 * shared sync fns used to be copy-pasted between the runtime and editor loops
 * and the offscreen capture, and had already drifted — the capture omitted
 * `syncSkinnedModels`/`syncBoneAttachments` entirely (runtime-rendering-3d.md
 * F1), so skeletal scenes rendered wrong (or empty) in `modoki_render_scene`.
 * Routing all three callers through this helper means a future step added here
 * (e.g. a `syncDecals`) can't silently skip the editor viewport or the
 * deterministic agent-verification capture.
 *
 * Camera, environment, light, particle, and flame sync are deliberately NOT
 * here: their orchestration legitimately differs per caller (editor orbit
 * camera + ghost/game camera, gizmo interleaving, particle/flame preview
 * toggles), so each caller runs those around this core. `renderables` and
 * `skinned` take separate callbacks because the editor passes a gizmo-aware
 * `shouldUpdateTransform`/`onMeshRemoved` while the runtime passes none.
 */
// ── Text3D (SDF text meshes) ──────────────────────────────
interface TextMeshEntry {
  /** Container carrying the entity transform + billboard rotation; holds one child
   *  mesh per atlas PAGE the text touches (dynamic CJK spills across pages, each mesh
   *  bound to that page's texture). Baked / single-page text has exactly one child. */
  group: THREE.Group;
  /** page → its mesh (rebuilt wholesale on a layout/atlas change). */
  pages: Map<number, THREE.Mesh>;
  /** Layout-input hash — geometry rebuilds only when it changes. */
  hash: string;
  fontId: string;
  billboard: boolean;
  /** Un-animated layout quads + anchor offset, kept so per-glyph animation can
   *  recompute page positions each frame WITHOUT rebuilding materials. */
  baseQuads?: TextQuad[];
  ax?: number;
  ay?: number;
  /** Whether the last frame applied a MOTION / COLOUR effect — so we restore the base
   *  pose/colour ONCE when it deactivates (stop / effect:none) rather than every frame. */
  wasMotion?: boolean;
  wasColored?: boolean;
  /** smoothedElapsed captured when animation last (re)activated OR the effect was
   *  switched, so each Play (and each effect change) restarts the effect from t=0
   *  (Time.smoothedElapsed never resets across plays). */
  animStart?: number;
  /** The effect that was active last frame — a change restarts animStart so a one-shot
   *  fade/typewriter intro replays when the effect is switched mid-Play. */
  animEffect?: string;
}
const _activeText = new Set<number>();

/** Rewrite each page mesh's position attribute from `quads` (reusing the material +
 *  UVs + indices — no shader rebuild), applying the entry's anchor offset. `quads`
 *  must be the SAME length/order as the base layout (animation is length-invariant),
 *  so per-page vertex counts match and the update is in place. */
function updateTextPagePositions3D(entry: TextMeshEntry, quads: TextQuad[]): void {
  const ax = entry.ax ?? 0, ay = entry.ay ?? 0;
  // Positions-only (UVs/indices are invariant, baked into the mesh) — keyed by PAGE.
  for (const { page, positions } of buildTextPositionsByPage(quads, { yUp: true })) {
    const mesh = entry.pages.get(page);
    if (!mesh) continue;
    const pos = positionsTo3D(positions);
    for (let i = 0; i < pos.length; i += 3) { pos[i] += ax; pos[i + 1] += ay; }
    const attr = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    if (attr.array.length === pos.length) {
      (attr.array as Float32Array).set(pos);
      attr.needsUpdate = true;
    }
  }
}

/** Rewrite each page mesh's per-glyph colour attribute from `quads` (colour effects —
 *  rainbow/fade). Keyed by page; length-guarded; base quads (no colour) → white. */
function updateTextPageColors3D(entry: TextMeshEntry, quads: TextQuad[]): void {
  for (const { page, colors } of buildTextColorsByPage(quads)) {
    const mesh = entry.pages.get(page);
    if (!mesh) continue;
    const attr = mesh.geometry.getAttribute('aTextColor') as THREE.BufferAttribute | undefined;
    if (attr && attr.array.length === colors.length) {
      (attr.array as Float32Array).set(colors);
      attr.needsUpdate = true;
    }
  }
}

function disposeTextPageMeshes(entry: TextMeshEntry): void {
  for (const mesh of entry.pages.values()) {
    entry.group.remove(mesh);
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
  }
  entry.pages.clear();
}

function disposeTextMeshEntry(entry: TextMeshEntry, scene: THREE.Scene): void {
  disposeTextPageMeshes(entry);
  scene.remove(entry.group);
  // The atlas TEXTURES are owned by the font provider (disposed on font release via
  // provider.addDisposable), NOT here — they're shared by every text mesh of this font.
}

function textStyle(t: {
  color: number; opacity: number; weight: number;
  outlineColor: number; outlineWidth: number; outlineOpacity: number;
  glowColor: number; glowSize: number; glowStrength: number;
  shadowColor: number; shadowOpacity: number; shadowOffsetX: number; shadowOffsetY: number; shadowSoftness: number;
}): MtsdfStyle {
  return {
    color: t.color, opacity: t.opacity, weight: t.weight,
    outlineColor: t.outlineColor, outlineWidth: t.outlineWidth, outlineOpacity: t.outlineOpacity,
    glowColor: t.glowColor, glowSize: t.glowSize, glowStrength: t.glowStrength,
    shadowColor: t.shadowColor, shadowOpacity: t.shadowOpacity,
    shadowOffsetX: t.shadowOffsetX, shadowOffsetY: t.shadowOffsetY, shadowSoftness: t.shadowSoftness,
  };
}

function codepointsOf(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) out.push(ch.codePointAt(0)!);
  return out;
}

function positionsTo3D(p2: Float32Array): Float32Array {
  const n = p2.length / 2;
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { out[i * 3] = p2[i * 2]; out[i * 3 + 1] = p2[i * 2 + 1]; out[i * 3 + 2] = 0; }
  return out;
}

/** Build/update the SDF text mesh for every Text3D entity. Geometry rebuilds only
 *  when a layout input (text/font/size/wrap/spacing/anchor/atlasVersion) changes;
 *  style uniforms update every frame (cheap). Billboard facing is applied per-camera
 *  in {@link orientBillboards}. */
export function syncText3D(world: World, scene: THREE.Scene, state: RenderState, callbacks?: SyncCallbacks) {
  const { textMeshes } = state;
  const sceneId = getCurrentSceneId();
  _activeText.clear();

  world.query(Transform, Text3D).updateEach(([tf, t], entity) => {
    const id = entity.id();
    if (!t.isVisible || deactivatedEntities.has(id)) return;
    _activeText.add(id);
    // Kick a load if the font isn't cached yet (safety net for editor-authored text
    // not yet in the scene resource manifest). SceneManager pre-acquires scene fonts.
    if (t.font && sceneId !== undefined) ensureFontLoaded(sceneId, t.font);
    const provider = t.font ? getLoadedFont(t.font) : undefined;
    let entry = textMeshes.get(id);

    if (!provider) { if (entry) entry.group.visible = false; return; }
    // Page 0 texture readiness gates the whole entity (a baked atlas still loading, or
    // a dynamic provider before its first page). Per-page textures are fetched below.
    if (!getFontTexture(provider, 0)) { if (entry) entry.group.visible = false; return; }

    const hash = [t.font, t.text, t.fontSize, t.align, t.maxWidth, t.lineSpacing,
      t.letterSpacing, t.anchorX, t.anchorY, provider.atlasVersion, getTextDirtyVersion()].join('|');

    if (!entry || entry.hash !== hash) {
      provider.ensureGlyphs(codepointsOf(t.text));
      const layout = layoutText(provider, t.text, {
        fontSize: t.fontSize, maxWidth: t.maxWidth, align: t.align as 'left' | 'center' | 'right',
        lineSpacing: t.lineSpacing, letterSpacing: t.letterSpacing,
      });
      if (!entry) {
        entry = { group: new THREE.Group(), pages: new Map(), hash, fontId: t.font, billboard: !!t.billboard };
        scene.add(entry.group);
        textMeshes.set(id, entry);
      }
      // Rebuild every page mesh from scratch (a layout/atlas change is infrequent, and
      // the atlas TEXTURE is baked into each TSL node graph so a page's material can't
      // be mutated in place anyway).
      disposeTextPageMeshes(entry);
      // Anchor: block spans x[0,width], yUp y[0,-height]. Shift so the anchor point
      // (anchorX across width, anchorY down height) sits at the entity origin — same
      // for every page since they share one layout.
      const ax = -t.anchorX * layout.width, ay = t.anchorY * layout.height;
      for (const { page, geo } of buildTextGeometryByPage(layout.quads, { yUp: true })) {
        const ptex = getFontTexture(provider, page);
        if (!ptex) continue; // page texture not ready — rebuilds when atlasVersion/textDirty bumps
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(positionsTo3D(geo.positions), 3));
        g.setAttribute('uv', new THREE.BufferAttribute(geo.uvs, 2));
        g.setAttribute('aTextColor', new THREE.BufferAttribute(geo.colors, 4)); // per-glyph colour (white ⇒ no tint)
        g.setIndex(new THREE.BufferAttribute(geo.indices, 1));
        g.translate(ax, ay, 0);
        const mat = makeMtsdfMaterial(ptex, provider.atlas.width, provider.atlas.height, provider.atlas.distanceRange, provider.atlas.size, textStyle(t));
        const mesh = new THREE.Mesh(g, mat);
        // Per-glyph animation nudges verts past the static bounds; skip frustum
        // culling (text is cheap) so an animated glyph never pops out at the edge.
        mesh.frustumCulled = false;
        entry.group.add(mesh);
        entry.pages.set(page, mesh);
      }
      entry.hash = hash;
      entry.fontId = t.font;
      entry.baseQuads = layout.quads; // for per-frame animation (positions/colours)
      entry.ax = ax; entry.ay = ay;
      entry.wasMotion = false; entry.wasColored = false;
    }

    // Per-glyph animation: recompute page positions (motion effects) or colours
    // (rainbow/fade) from the base quads each frame while playing (frozen when stopped,
    // like skeletal); reuses the materials. Restore the base pose/colour ONCE when the
    // effect deactivates (wasMotion/wasColored latches).
    const anim = (entity.has(TextAnimation) ? entity.get(TextAnimation) : undefined) as TextAnimParams | undefined;
    const animActive = isTextAnimating(anim) && getPlayState() === 'playing';
    const motion = animActive && !isColorEffect(anim!.effect);
    const colored = animActive && isColorEffect(anim!.effect);
    if ((motion || colored || entry.wasMotion || entry.wasColored) && entry.baseQuads) {
      const now = getTime(world)?.smoothedElapsed ?? 0;
      // Restart at t=0 on (re)activation OR an effect switch (effect isn't in the mesh
      // hash, so switching mid-Play keeps the stale start → one-shot intros would skip).
      if (animActive && ((!entry.wasMotion && !entry.wasColored) || entry.animEffect !== anim!.effect)) entry.animStart = now;
      entry.animEffect = animActive ? anim!.effect : undefined;
      const tsec = animActive ? now - (entry.animStart ?? now) : 0;
      const quads = animActive ? applyTextAnimation(entry.baseQuads, anim!, tsec, t.fontSize) : entry.baseQuads;
      if (motion || entry.wasMotion) { updateTextPagePositions3D(entry, quads); entry.wasMotion = motion; }
      if (colored || entry.wasColored) { updateTextPageColors3D(entry, quads); entry.wasColored = colored; }
    }

    entry.billboard = !!t.billboard;
    entry.group.visible = true;
    const style = textStyle(t);
    for (const mesh of entry.pages.values()) updateMtsdfStyle(mesh.material as THREE.Material, style);
    applyTransform(entry.group, id, tf, callbacks);
  });

  for (const [id, entry] of textMeshes) {
    if (!_activeText.has(id)) { disposeTextMeshEntry(entry, scene); textMeshes.delete(id); }
  }
}

export function syncSceneRenderables3D(
  world: World,
  scene: THREE.Scene,
  state: RenderState,
  callbacks?: { renderables?: SyncCallbacks; skinned?: SyncCallbacks },
) {
  syncRenderables(world, scene, state, callbacks?.renderables);
  syncSkinnedModels(world, scene, state, callbacks?.skinned);
  syncBones(world, scene, state);
  syncBoneAttachments(world, scene, state);
  // Billboarded 2D skinned sprites (2.5D). Geometry/placement only; the camera-facing
  // rotation is per-caller via orientBillboards (runtime/editor/capture each use their
  // own camera). Uses the gizmo-aware renderables callback for consistent transform skip.
  syncBillboardSprites(world, scene, state, callbacks?.renderables);
  syncText3D(world, scene, state, callbacks?.renderables);
}

/** Clear all owned-material tracking. Call on world swap alongside clearing
 *  ecsObjects so stale references don't accumulate. */
export function clearOwnedMaterials() {
  _ownedMaterials.clear();
}

// ── Shader prewarm ──────────────────────────────────────

/** Build a throwaway THREE.Scene containing placeholder meshes for every
 *  Renderable3D + Renderable3DPrimitive in the given world, and run
 *  renderer.compileAsync against it. This compiles all shader programs the
 *  new scene will need BEFORE the world swap, eliminating first-frame stutter.
 *
 *  The geometries + materials come from the world-independent mesh/material
 *  caches (already populated by SceneManager's resource acquire), so no
 *  per-world state is touched. The throwaway scene is cleared (but does NOT
 *  dispose shared geometries/materials) once compile completes. */
export async function prewarmShadersForWorld(
  world: World,
  renderer: WebGPURenderer | THREE.WebGLRenderer,
  camera: THREE.PerspectiveCamera,
): Promise<void> {
  const prewarmScene = new THREE.Scene();
  let count = 0;

  // Track primitive geometries and lights so we can dispose them at the end.
  // GLB template geometries/materials are shared and must NOT be disposed.
  const primitiveMeshes: THREE.Mesh[] = [];
  const prewarmLights: THREE.Light[] = [];

  // Mirror the staging world's Environment so compileAsync produces the correct
  // PBR shader variant (with envMap sampling). Without this, the first real
  // render recompiles shaders and stutters.
  world.query(Environment).updateEach(([env]: [{ hdrPath: string; intensity: number }]) => {
    if (!env.hdrPath) return;
    const cached = getCachedEnvironment(env.hdrPath);
    if (cached) {
      prewarmScene.environment = cached;
      prewarmScene.environmentIntensity = env.intensity;
    }
  });

  // Mirror the staging world's lights so compileAsync produces the correct
  // shader variants (otherwise Three.js's LightsNode warns + skips compile).
  world.query(Light).updateEach(([light]: [{ lightType: string; color: number; intensity: number; distance: number; angle: number; penumbra: number }]) => {
    const l = createLightFromTrait(light);
    if (l) {
      prewarmScene.add(l);
      prewarmLights.push(l);
    }
  });

  world.query(Renderable3D).updateEach(([rend]: [{ isVisible: boolean; mesh: string; material: string }]) => {
    if (!rend.isVisible || !rend.mesh) return;
    const template = resolveMeshTemplate(rend.mesh);
    if (!template) return;
    const material = resolveMaterialForMesh(rend.material, rend.mesh) || template.material;
    const mesh = new THREE.Mesh(template.geometry, material);
    prewarmScene.add(mesh);
    count++;
  });

  world.query(Renderable3DPrimitive).updateEach(([rend]: [{ isVisible: boolean; mesh: string; size: number; color: number; material: string }]) => {
    if (!rend.isVisible) return;
    const obj = createPrimitiveMesh(rend.mesh, rend.size, rend.color);
    if (obj) {
      // Apply .mat.json override if set (mirrors runtime sync behaviour)
      if (rend.material) {
        const resolved = resolveMaterial(rend.material);
        if (resolved) (obj as THREE.Mesh).material = resolved;
      }
      prewarmScene.add(obj);
      primitiveMeshes.push(obj as THREE.Mesh);
      count++;
    }
  });

  // F4: even when the staging world has NO Renderable3D/Primitive — a
  // particle-only, UI-only, or skinned-only NPR scene (skinned meshes are synced
  // separately and not counted here) — we must still make a NORMAL material the
  // renderer's first compile. Otherwise the NPR MRT pass becomes the first compile
  // and re-triggers the WGSL `unresolved type 'OutputType'` bug this prewarm exists
  // to prevent. Add a throwaway 1-tri standard mesh so a plain material is always
  // compiled first. Cost is one trivial compile per scene swap; harmless if NPR is off.
  let placeholderMesh: THREE.Mesh | undefined;
  if (count === 0) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
    geo.computeVertexNormals();
    placeholderMesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.5, metalness: 0 }));
    prewarmScene.add(placeholderMesh);
  }

  // compileAsync is available on both WebGLRenderer (r152+) and WebGPURenderer.
  const compile = (renderer as THREE.WebGLRenderer).compileAsync;
  if (typeof compile === 'function') {
    await (renderer as THREE.WebGLRenderer).compileAsync(prewarmScene, camera);
  } else {
    // Fallback: synchronous compile (still better than first-frame-stutter)
    (renderer as THREE.WebGLRenderer).compile?.(prewarmScene, camera);
  }

  // Dispose prewarm-owned objects but leave GLB template geometries/materials
  // (and the shared envCache-owned environment) alone.
  for (const m of primitiveMeshes) {
    m.geometry.dispose();
    (m.material as THREE.Material).dispose();
  }
  for (const l of prewarmLights) l.dispose();
  if (placeholderMesh) {
    placeholderMesh.geometry.dispose();
    (placeholderMesh.material as THREE.Material).dispose();
  }
  prewarmScene.environment = null; // detach shared env before clear
  prewarmScene.clear();
}

// ── Renderer creation ───────────────────────────────────

/** Create + init a WebGPURenderer with the standard editor/game config (DPR cap,
 *  ACES tone mapping), appending its canvas to `container` and returning the
 *  initialized renderer.
 *
 *  Always uses WebGPURenderer: when native WebGPU is unavailable its `forceWebGL`
 *  option runs the SAME node/TSL pipeline on top of WebGL2, so TSL NodeMaterials
 *  and NPR post-processing work uniformly on every device. (The classic
 *  THREE.WebGLRenderer can't run NodeMaterials/NPR and silently broke any
 *  node-based scene on machines without WebGPU — including the editor.)
 *
 *  `getWebGPUSupported()` can report true while the actual adapter/device request
 *  fails at init (blocklisted mobile GPUs, Safari quirks, lost context); in that
 *  case we retry once on the WebGL2 backend. If that retry ALSO fails we dispose +
 *  detach the dead renderer before rethrowing so nothing leaks. Shared by the game
 *  renderer (createRenderer) and the editor SceneView so both get identical backend
 *  selection + fallback. */
/** Color/tone conventions shared by the live renderer (`makeWebGPURenderer`) and the
 *  editor's standalone `ModelPreview` so imported PBR materials read identically in
 *  both. Applied via {@link applyRendererColorConfig} — the single source of truth that
 *  used to be hand-copied (and drift-prone) between the two renderer setups. */
export const RENDERER_TONE_MAPPING = THREE.ACESFilmicToneMapping;
export const RENDERER_TONE_EXPOSURE = 1.2;

/** Apply the project-configured tone mapping + exposure / sRGB-output config to any
 *  renderer-like object (WebGPURenderer or WebGLRenderer — both expose these fields).
 *  Reads {@link getRenderSettings} `.three.{toneMapping,exposure}`; the defaults there
 *  are ACESFilmic @ 1.2 so an un-injected renderer looks exactly as before. */
export function applyRendererColorConfig(r: {
  toneMapping: THREE.ToneMapping;
  toneMappingExposure: number;
  outputColorSpace: string;
}): void {
  const { toneMapping, exposure } = getRenderSettings().three;
  r.toneMapping = resolveToneMapping(toneMapping);
  r.toneMappingExposure = exposure;
  r.outputColorSpace = THREE.SRGBColorSpace;
}

export async function makeWebGPURenderer(container: HTMLDivElement): Promise<WebGPURenderer> {
  const { getWebGPUSupported } = await import('./gpuDetect');
  const webgpuSupported = await getWebGPUSupported();
  const three = getRenderSettings().three;
  // Backend selection: 'webgl' forces the WebGL2 backend outright; 'webgpu'/'auto'
  // use native WebGPU when the device supports it, else fall back to WebGL2. (Both
  // run the same TSL/node pipeline — see the createRenderer doc comment.)
  const startForceWebGL = three.backend === 'webgl' || !webgpuSupported;
  // Published `three/webgpu` entry — see import comment for why we avoid the
  // deep-source path.
  const { WebGPURenderer: WebGPURendererMod } = await import('three/webgpu');
  const make = (forceWebGL: boolean) => {
    const r = new WebGPURendererMod({
      antialias: three.antialias,
      forceWebGL,
    } as ConstructorParameters<typeof WebGPURendererMod>[0]);
    r.setPixelRatio(Math.min(window.devicePixelRatio, three.pixelRatioCap));
    r.setSize(container.clientWidth, container.clientHeight);
    // Global shadow gate. Per-light `castShadow` still applies; this master switch
    // lets a project disable all shadow-map work for perf.
    (r as unknown as { shadowMap: { enabled: boolean } }).shadowMap.enabled = three.shadows;
    applyRendererColorConfig(r);
    return r;
  };
  let r = make(startForceWebGL);
  container.appendChild(r.domElement);
  try {
    await r.init();
  } catch (e) {
    // If we already started on WebGL2 there's nothing left to fall back to.
    if (startForceWebGL) throw e;
    console.warn('[makeWebGPURenderer] WebGPU init failed; falling back to WebGL2', e);
    r.dispose();
    r.domElement.remove();
    r = make(true);
    container.appendChild(r.domElement);
    try {
      await r.init();
    } catch (e2) {
      // WebGL2 fallback also failed — don't leak the appended renderer.
      r.dispose();
      r.domElement.remove();
      throw e2;
    }
  }
  return r;
}

export async function createRenderer(
  container: HTMLDivElement,
  preferWebGPU: 'auto' | 'force' = 'auto',
): Promise<WebGPURenderer> {
  // `preferWebGPU` is retained for API/signature compatibility — both 'auto' and
  // 'force' now use WebGPURenderer (with WebGL2 fallback).
  void preferWebGPU;
  const r = await makeWebGPURenderer(container);
  setActiveRenderer(r); // KTX2Loader format detection (needs an initialized renderer)
  return r;
}
