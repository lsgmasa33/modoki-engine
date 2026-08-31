/** Three.js ECS render sync — extracts frame-by-frame sync logic from Scene3D. */

import * as THREE from 'three';
import { decomposeTrs } from '../core/ecs/decomposeTrs';
import { beginBootSpan, endBootSpan, bootSpanAsync } from '../core/bootTimeline';
import type { World } from 'koota';
// See SceneView.tsx for the rationale on the published-entry import.
import type { WebGPURenderer } from 'three/webgpu';
import { Transform, Renderable3D, Renderable3DPrimitive, Camera, CameraFrame, Tint, isMaterialInstanced, SkinnedModel, SkinnedMeshRenderer, SkeletalAnimator, AnimationLibrary, BoneAttachment, Bone, Animator, SkinnedSprite2D, Billboard3D, FlatSprite3D, Text3D, TextAnimation } from '../traits';
import { layoutText, type TextQuad } from './text/layoutText';
import { buildTextGeometryByPage, buildTextPositionsByPage, buildTextColorsByPage } from './text/textMesh';
import { applyTextAnimation, isTextAnimating, isColorEffect, type TextAnimParams } from './text/textAnimate';
import { makeMtsdfMaterial, updateMtsdfStyle, type MtsdfStyle } from './text/mtsdfShader';
import { getFontTexture } from './text/fontTextureThree';
import { ensureFontLoaded, getLoadedFont } from '../loaders/fontAtlasLoader';
import { getTextDirtyVersion } from './text/textDirty';
import { getCurrentSceneId } from '../scene/SceneManager';
import { computeFrameFit, boxCornersFromMatrix, type FrameMode, type FrameAnchorV, type FrameAnchorH } from './cameraFraming';
import { getSkin2DBuffer, frameSkin2DUVs, type Skin2DPartBuffer } from '../skinning/skin2DBuffers';
import { getKTX2Loader, getEnvFormat, ensureKtx2Caps } from '../loaders/textureResolver';
import { ULTRAHDR_INTENSITY_BOOST } from '../core/environmentSettings';
import { runLateUpdates, hasLateUpdates, type IdempotencyProbe } from '../core/lateUpdate';
import { EntityAttributes } from '../core/traits/EntityAttributes';
import { Light } from '../../three/traits/Light';
import { Environment } from '../../three/traits/Environment';
import { Fog } from '../../three/traits/Fog';
import { fog as fogTsl, exponentialHeightFogFactor, uniform, renderGroup } from 'three/tsl';
import { worldTransforms, deactivatedEntities, transformPropagationSystem } from '../core/ecs/transformPropagationSystem';
import { updateSceneLightUniforms } from './sceneLightUniforms';
import { snapShadowCenter } from './shadowFollow';
import { syncVideoTextures } from './videoTextureSync';
import { setEntityMeshCollector } from './materialBroker';
import { getAnimationClip } from '../loaders/animationClipCache';
import { resolveActiveClip, resolveClipByName } from '../animation/animClipBank';
import { applyClipAtTime, applyClipAtTimeBlended } from '../animation/sampleClip';
import { buildEntityIndex } from '../core/ecs/entityIndex';
import type { AnimationClipDef } from '../animation/types';
import {
  resolveMeshTemplate, resolveMeshLodInfo, resolveMaterialForMesh, resolveMaterial,
  getCachedEnvironment, acquireEnvironment, onModelInvalidated, getMeshAsset,
  retiredEnvironments, disposeRetiredEnvironment,
  retiredMaterials3D, disposeRetiredMaterial, refreshedMaterial,
} from '../loaders/meshTemplateCache';
import { getRiggedModel, ensureRiggedModelLoaded } from '../loaders/riggedModelCache';
import {
  getRenderSettings, resolveToneMapping, getEffectiveThreeSettings, getActiveTierOverrides,
} from './renderSettings';
import { tierShadowMapSize, tierAllowsIBL, tierAmbientBoost, tierExposureBoost, shadowBiasScale } from './qualityTier';
import { worldWillUseStack } from './postfx/postFXTraitScan';
import { armAutoLightCap, autoCapMaskFor, isAutoLightCapEngaged } from './autoLightCapFrame';
import { armShadowCasterCap, shadowCasterAllowed } from './shadowCasterCapFrame';
import { casterTypeOf, keptShadowCasters, type ShadowCaster } from './shadowCasterCap';
import { applyInstancedBatching, clearInstancedBatches } from './instancedBatching';
import { resolveActiveTier } from './tierResolve';
import { clampPixelRatio, basePixelRatio } from './webCanvasSizing';
import { resolveAnimSetParams, ANIMSET_DEFAULTS, getAnimSet } from '../loaders/animSetCache';
import { clone as cloneSkeleton, retargetClip } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { resolveRef } from '../loaders/assetManifest';
import { onWorldSwap, findEntityByGuid, peekCurrentWorld } from '../core/ecs/world';
import { emit, entityRef } from '../core/journal';
import { getVisualDelta, getTime } from '../core/getTime';
import { getPlayState } from '../core/playState';
import { isSkeletalPreviewing, skeletalPreviewDelta } from '../core/skeletalPreview';
import { getSkeletalSeek, hasSkeletalSeeks, clearSkeletalSeeks } from '../core/skeletalSeek';
import { createPrimitiveMesh, isPrimitive, PRIMITIVE_NAMES } from '../loaders/primitives';
import {
  beginLightMaskFrame, getMaskedMaterial, isLightMaskingActive, maskNeedsVariant, baseOf, retireVariantsOf,
  DEFAULT_RENDERING_LAYER_MASK, type MaskedLight, type LightingFactory,
} from './lightMaskVariants';
import { cloneDerived, collectDerivedChain, retireDerivedMaterial, retiredDerivedMaterials, retiredDerivedCount, disposeRetiredDerivedMaterial } from './derivedMaterials';
import { getActiveRenderer } from '../core/activeRenderer';
import { setActiveRenderer } from '../loaders/textureResolver';
import { PARTICLE_LAYER } from './layers';

// Reused across frames to avoid per-frame allocations
const _activeLightIds = new Set<number>();
/** This frame's lights + their rendering-layer masks (#136), filled by `syncLights` and
 *  consumed by the renderable pass that follows it. Reused across frames — `beginLightMaskFrame`
 *  copies what it keeps. */
const _maskedLights: MaskedLight[] = [];
const _activeRenderIds = new Set<number>();
const _defaultMaterial = new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.5, metalness: 0 });
/** #482: names already warned about via an unresolvable `Renderable3DPrimitive.mesh` — one
 *  console.warn per bad name per world, not one per frame. Shared by both sites that can
 *  discover the name is bad: the create path (no mesh exists yet) and the rebuild gate (a mesh
 *  exists but its KIND changed to a name we don't recognize).
 *
 *  Reset on `onWorldSwap` below, like `derivedMaterials.ts`/`lightMaskVariants.ts` reset THEIR
 *  process-globals — a module-global with no reset here specifically broke reproduction: the
 *  editor runs two render surfaces on one world (SceneView + the Game panel's Scene3D) sharing
 *  this dedupe so only one ever reported, and reloading the editor to reproduce "why is my
 *  primitive invisible" warned nothing because the name was already in the set from before. */
const _warnedUnknownPrimitives = new Set<string>();
onWorldSwap(() => { _warnedUnknownPrimitives.clear(); });
function warnUnknownPrimitiveOnce(id: number, meshName: string): void {
  if (_warnedUnknownPrimitives.has(meshName)) return;
  _warnedUnknownPrimitives.add(meshName);
  // "first seen on entity N", not "entity N has" — this fires ONCE per name, so a later frame
  // with the SAME bad name on a DIFFERENT entity (koota reuses ids LIFO, so `id` can already
  // belong to something else by the time anyone reads this line) must not be read as naming the
  // entity that's currently broken.
  console.warn(
    `Renderable3DPrimitive has unknown mesh '${meshName}' (first seen on entity ${id}); expected one of: ${PRIMITIVE_NAMES.join(', ')}`,
  );
}

// Materials created inline for specific entities (not from caches) are tracked PER RENDER STATE,
// as `RenderState.ownedMaterials` — only those are safe to dispose when reassigned or at teardown;
// shared cache materials and the primitive placeholder sentinel must not be. `_defaultMaterial`
// itself is never bound directly either (#480) — `syncMaterial` clones it per entity and owns
// the clone, so the module-level instance stays untouched and is safe only as a clone SOURCE.
//
// ⚠️ Per-state, not module-global, because THE EDITOR RUNS TWO OF THESE on one world (SceneView +
// the Game panel's Scene3D) and each mints its OWN inline materials. A shared set let one loop's
// teardown clear the other's ownership record out from under it — after which that loop's
// materials were untracked and simply leaked — and it is the reason the editor teardown used to
// dispose unconditionally instead. Ownership is per-surface; so is the set.

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
const _tintMaterials = new Map<string, { clone: THREE.Material; base: THREE.Material }>();
let _tintCacheWarned = false;

/** The tinted clone of `basePath` at (`color`, `amount`), or undefined while the base is still
 *  loading.
 *
 *  ⚠️ THE ENTRY RECORDS ITS BASE, and a changed base REBUILDS the clone (#318). None of the three
 *  key components moves across a re-import — the ref, the colour and the strength are all
 *  authored — so a cache keyed on them alone kept serving a clone of the PRE-reimport bytes for
 *  the rest of the session, while an untinted mesh on the same `.mat.json` updated correctly.
 *  Identity of the resolved base is the only signal that a re-import happened, and checking it is
 *  free here because this function already re-resolves every frame. It also covers a base that
 *  changed for any OTHER reason (a mid-flight refetch loser, a swapped ref) — which an
 *  invalidation event, keyed on the path, would not have.
 *
 *  The superseded clone is RETIRED, not disposed: a mesh is binding it right now and the caller
 *  rebinds only after this returns. `sweepRetiredMaterials` frees it once nothing binds it. */
function tintedMaterial(basePath: string, color: number, amount: number): THREE.Material | undefined {
  if (!basePath) return undefined;
  const base = resolveMaterial(basePath);
  if (!base) return undefined; // async load not finished yet — try next frame
  const key = `${basePath}|${color}|${amount}`;
  const entry = _tintMaterials.get(key);
  if (entry) {
    if (entry.base === base) return entry.clone;
    // The base was re-imported (or otherwise replaced) — this clone is stale for good.
    const stale = entry.clone;
    retireVariantsOf(stale); // a light-mask variant derived from it is stale too
    retireDerivedMaterial(stale, () => stale.dispose());
    _tintMaterials.delete(key);
  }
  // `cloneDerived`, not a bare `.clone()` (#325) — a TSL/file-shader base parks real
  // `THREE.Texture` objects at `userData.textures`, which `Material.copy()` would JSON-round-trip
  // into this clone one serialised texture at a time. A tint clone must not carry that list anyway:
  // it is a texture-OWNERSHIP record, and both readers (`disposeMaterial` and `materialTextures`,
  // the latter behind the `onAssetInvalidated('texture')` listener) walk `materialCache` — i.e.
  // BASES only, never a clone.
  const clone = cloneDerived(base, base);
  (clone as unknown as { color?: THREE.Color }).color?.setHex(color);
  (clone as unknown as { nprColorPreserve: number }).nprColorPreserve = amount;
  _tintMaterials.set(key, { clone, base });
  if (import.meta.env?.DEV && !_tintCacheWarned && _tintMaterials.size > 64) {
    _tintCacheWarned = true;
    console.warn('[Tint] tinted-material cache exceeded 64 entries — Tint.color/amount appear to vary continuously (animated?). Clones are cached per distinct (material,color,amount) and only freed on scene swap, so an animated tint leaks. Prefer a fixed palette.');
  }
  return clone;
}

/** Dispose all tinted-clone materials. Call on scene cleanup / world swap. */
export function disposeTintMaterials() {
  for (const { clone } of _tintMaterials.values()) clone.dispose();
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
// loop's disposeRenderState, which consults state.ownedMaterials to decide what to
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

/** Did the LAST {@link syncEnvironment} actually take IBL away from this scene?
 *
 *  The compensation (`iblOffAmbientBoost` / `iblOffExposure`) must key off THIS, not off the
 *  tier — suppression is conditional (the tier says no IBL *and* the scene has a loaded HDR
 *  `Environment` to lose), while a tier check alone is unconditional. Keying the compensation
 *  on the tier brightened every low-tier scene that never had an environment at all, which is
 *  a tier RAISING its output — the one thing `docs/rendering.md` § "Quality tiers" says a tier
 *  must never do. And since an unrecognised device resolves `low` (see `resolveTier`), that was
 *  every phone running any project with an `AmbientLight` and no `Environment`. */
let iblSuppressed = false;

/** Test/diagnostic read of the flag above. */
export function isIblSuppressed(): boolean {
  return iblSuppressed;
}

/** Every live render surface — the THREE.Scenes that could be binding a shared cached resource
 *  (an HDR env, a `.mat.json` material) right now. It backs BOTH retire-and-sweep passes below:
 *  a resource evicted while something still binds it is freed only once no surface here holds
 *  it (#315 for envs, #317 for materials).
 *
 *  Registered from the per-frame syncs themselves — {@link syncEnvironment} and
 *  {@link syncSceneRenderables3D}, which every surface calls every frame — plus
 *  `prewarmShadersForWorld`'s throwaway compile scene, whose bindings outlive an `await`.
 *  ⚠️ **Any new site that binds a cached material or env to a `THREE.Scene` MUST call
 *  `registerRenderSurface` first**, or the sweeps cannot see its binding and will free
 *  something it is still sampling. Held weakly: a torn-down panel's scene must not be kept
 *  alive by this set, and a dead ref just drops out. */
const envSurfaceRefs = new Set<WeakRef<THREE.Scene>>();
const envSurfaceSeen = new WeakSet<THREE.Scene>();

function registerRenderSurface(scene: THREE.Scene): void {
  if (envSurfaceSeen.has(scene)) return;
  // Prune dead refs HERE, not only in the sweep: the sweep early-returns whenever nothing is
  // retired (the overwhelmingly common case), so it cannot be the only reaper. Without this the
  // set grows by one wrapper per distinct scene for the life of the page — and since the prewarm
  // registers a THROWAWAY scene per compile, that is one per scene swap, not one per panel.
  // Amortised: this runs once per NEW scene, and the set holds roughly the live surfaces.
  for (const ref of envSurfaceRefs) if (!ref.deref()) envSurfaceRefs.delete(ref);
  envSurfaceSeen.add(scene);
  envSurfaceRefs.add(new WeakRef(scene));
}

/** Free the HDR envs that an `invalidateEnvironment` (re-import) evicted, once no live surface
 *  binds them any more (#315).
 *
 *  ⚠️ It asks each scene what it is ACTUALLY binding instead of tracking bind/unbind calls. Five
 *  sites outside this function clear `scene.environment`/`scene.background` (`Scene3D`'s teardown,
 *  `SceneView`'s UI-mode and unmount paths); a bind/unbind refcount would have to be threaded
 *  through every one of them and would go silently wrong the moment a sixth appears. Reading the
 *  property cannot go stale.
 *
 *  The failure mode this trades INTO is a leak, never a use-after-free: a surface that stops
 *  rendering while still bound keeps its texture alive — which is correct — and
 *  `disposeAllCachedResources` drains whatever is left. */
/** Free the materials an `invalidateMaterial` (a texture re-import, or an Inspector material
 *  edit) evicted, once no live surface binds them any more (#317).
 *
 *  Same shape as {@link sweepRetiredEnvironments}, one level deeper: a material is bound to a
 *  MESH, not to the scene, so this traverses. Guarded on `retired.size` — the traverse only
 *  ever runs in the few frames after an invalidation, never on an ordinary frame.
 *
 *  ⚠️ It sees only what a MESH binds. A base material whose sole remaining holders are derived
 *  clones (tint / MaterialInstance / light-mask variants, which all hold `base.clone()` and
 *  share its texture references) is freed. That matches the pre-#317 behaviour — where it was
 *  freed immediately — so it is not a regression, but it is why this fix is only half of the
 *  problem. */
/** Frames to skip after a sweep that freed nothing and saw no new retiree.
 *
 *  ⚠️ WHY A BACKOFF EXISTS AT ALL: a retiree can be pinned FOREVER, legitimately. If the refetch
 *  after an invalidation fails (asset deleted mid-session, malformed JSON), `fetchMaterial`
 *  caches `MATERIAL_FAILED`, `resolveMaterial` returns undefined for that path permanently, and
 *  `syncMaterial`'s rebind branch can never run — so the mesh keeps drawing the retiree and
 *  keeping it alive is CORRECT. Without a backoff, `retired.size` never returns to 0 and every
 *  surface pays a full `scene.traverse()` on every frame for the rest of the session. The common
 *  case is unaffected: a retiree is normally freed within a frame or two, and the counter resets
 *  the moment the set changes. */
const SWEEP_IDLE_BACKOFF_FRAMES = 30;
/** Consecutive fruitless sweeps before the backoff engages. It is NOT 1, and the tests caught
 *  why: a retiree is still bound on the sweep right after its invalidation almost by definition,
 *  so backing off on the first fruitless sweep skipped the very frame the mesh rebound on and
 *  delayed every ordinary free by up to `SWEEP_IDLE_BACKOFF_FRAMES`. The grace keeps the normal
 *  path exact and still bounds the permanent case. */
const SWEEP_IDLE_GRACE = 3;
let sweepSkipFrames = 0;
let sweepIdleRuns = 0;
let lastRetiredSize = 0;
/** How many times the sweep has actually TRAVERSED (as opposed to returning on the empty-set
 *  guard or the backoff). Test/diagnostic read, like {@link isIblSuppressed} — the backoff is a
 *  cost property, and counting the work it avoids is the only direct way to assert it. */
let sweepTraversals = 0;
export function retiredMaterialSweepTraversals(): number {
  return sweepTraversals;
}

function sweepRetiredMaterials(): void {
  const retired = retiredMaterials3D();
  const pending = retired.size + retiredDerivedCount();
  if (pending === 0) { sweepSkipFrames = 0; sweepIdleRuns = 0; lastRetiredSize = 0; return; }
  // A set that just grew always sweeps immediately — the backoff only throttles one standing
  // still, never one with a new retiree in it.
  if (pending !== lastRetiredSize) { sweepSkipFrames = 0; sweepIdleRuns = 0; }
  else if (sweepSkipFrames > 0) { sweepSkipFrames--; return; }
  sweepTraversals++;
  const bound = new Set<THREE.Material>();
  for (const ref of envSurfaceRefs) {
    const surface = ref.deref();
    if (!surface) { envSurfaceRefs.delete(ref); continue; }
    surface.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (!m) return;
      // The CHAIN, not just the bound material (#318): a mesh binding a tint / MaterialInstance /
      // light-mask clone is holding that clone's base — and the base's textures — every bit as
      // firmly as if it bound the base itself. Those caches are unreachable from a traverse, so
      // without this the base reads as unbound and `disposeMaterial` releases textures the live
      // clone is still sampling.
      if (Array.isArray(m)) { for (const one of m) collectDerivedChain(one, bound); }
      else collectDerivedChain(m, bound);
    });
  }
  let freed = 0;
  for (const mat of [...retired]) if (!bound.has(mat)) { disposeRetiredMaterial(mat); freed++; }
  // Retired CLONES are freed by the same unbound test but through their own dispose step —
  // never `disposeRetiredMaterial`, which would release the base's shared textures a second
  // time. See `derivedMaterials.ts`.
  for (const clone of retiredDerivedMaterials()) if (!bound.has(clone)) { disposeRetiredDerivedMaterial(clone); freed++; }
  // Fruitless for SWEEP_IDLE_GRACE runs in a row → what is left is genuinely still bound, and
  // may be pinned for good. Back off rather than re-traversing every surface every frame.
  sweepIdleRuns = freed === 0 ? sweepIdleRuns + 1 : 0;
  sweepSkipFrames = sweepIdleRuns >= SWEEP_IDLE_GRACE ? SWEEP_IDLE_BACKOFF_FRAMES : 0;
  lastRetiredSize = retired.size + retiredDerivedCount();
}

function sweepRetiredEnvironments(): void {
  const retired = retiredEnvironments();
  if (retired.size === 0) return; // the overwhelmingly common case — no per-surface work
  const bound = new Set<THREE.Texture>();
  for (const ref of envSurfaceRefs) {
    const surface = ref.deref();
    if (!surface) { envSurfaceRefs.delete(ref); continue; }
    if (surface.environment) bound.add(surface.environment);
    const bg = surface.background as THREE.Texture | THREE.Color | null;
    if (bg && (bg as THREE.Texture).isTexture) bound.add(bg as THREE.Texture);
  }
  for (const tex of [...retired]) if (!bound.has(tex)) disposeRetiredEnvironment(tex);
}

/** Take back a background this sync put there, when it should no longer be shown — the
 *  Environment was removed/deactivated, or `showAsBackground` was turned OFF.
 *
 *  ⚠️ Nothing else did this, so the field was WIRED IN ONE DIRECTION: unticking
 *  `showAsBackground` in the Inspector left the sky on screen forever. `syncCamera` cannot
 *  undo it either — it deliberately "leaves a TEXTURE background alone" because this sync owns
 *  it, which is exactly what made the stale one permanent. That ownership is also why testing
 *  `isTexture` is enough: a `THREE.Color` background belongs to `syncCamera` and is left alone.
 *
 *  It clears to null rather than to the camera's clearColor: `syncCamera` owns that value and
 *  re-applies it (its guard fires on `bg == null`). In `Scene3D` it runs BEFORE this, so the
 *  authored colour lands one frame later — a one-frame renderer-clear on an authoring toggle,
 *  which is the cheap side of the trade against duplicating the clearColor decision here. */
function clearTextureBackground(scene: THREE.Scene): void {
  if (scene.background && (scene.background as THREE.Texture).isTexture) scene.background = null;
}

export function syncEnvironment(world: World, scene: THREE.Scene) {
  registerRenderSurface(scene);
  let envActive = false;
  let suppressed = false;
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
      // Tier gate (#154): IBL costs ~26 ms of a ~53 ms frame on a Huawei Y6 — half of it. The
      // BACKGROUND below is left alone (measured not to be the cost); only the lighting
      // contribution is suppressed, and syncLights/applyRendererColorConfig compensate.
      const iblOn = tierAllowsIBL(getActiveTierOverrides());
      if (!iblOn) suppressed = true; // this scene HAS an env and the tier is taking it away
      const wantEnv = iblOn ? cached : null;
      const wantEnvIntensity = iblOn ? envIntensity : 1;
      if (scene.environment !== wantEnv) scene.environment = wantEnv;
      if (scene.environmentIntensity !== wantEnvIntensity) scene.environmentIntensity = wantEnvIntensity;
      if (env.showAsBackground) {
        if (scene.background !== cached) scene.background = cached;
        if (scene.backgroundIntensity !== bgIntensity) scene.backgroundIntensity = bgIntensity;
        if (scene.backgroundBlurriness !== env.backgroundBlurriness) scene.backgroundBlurriness = env.backgroundBlurriness;
      } else {
        clearTextureBackground(scene);
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
  if (!envActive) {
    if (scene.environment) {
      // Don't dispose — the texture is owned by envCache, not this scene.
      scene.environment = null;
      scene.environmentIntensity = 1;
    }
    clearTextureBackground(scene);
  }
  // Recomputed from scratch each frame, so a scene swap into a no-environment scene (or a tier
  // promotion) drops the compensation on the very next frame rather than leaving it stuck on.
  iblSuppressed = suppressed;
  // Last, so this surface's rebind above is already visible to the sweep.
  sweepRetiredEnvironments();
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

/** Set castShadow/receiveShadow on an object (and any nested meshes, e.g. LOD levels or a
 *  loaded model graph) from the entity's authored Renderable3D/Renderable3DPrimitive/
 *  SkinnedModel fields. Inert unless a light casts + the renderer's shadowMap is enabled
 *  (both gated elsewhere), so this is always safe to apply.
 *  `castMode: 'auto'` (the default) derives cast from the material: a mesh whose material
 *  is alpha-blended (`transparent: true` — water, glass, sprite billboards) does NOT cast —
 *  the shadow map treats blended geometry as fully opaque, so a translucent surface would
 *  throw a hard, wrongly-shaped shadow (see the pond water plane in demos/forest-camp —
 *  its shadow read as a ghost duplicate of itself offset across the grass). `'on'`/`'off'`
 *  force the cast flag regardless of the material. */
function applyShadowFlags(obj: THREE.Object3D, castMode: 'auto' | 'on' | 'off', receive: boolean): void {
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    const transparent = Array.isArray(mat) ? mat.some((mm) => mm.transparent) : mat?.transparent;
    m.castShadow = castMode === 'auto' ? !transparent : castMode === 'on';
    m.receiveShadow = receive;
  });
}

/** Composite cache key for `RenderState.ecsShadowFlags` — cheaper than storing a tuple, and a
 *  Map<number,string> mirrors the house style of `ecsMaterials`/`ecsColors`/`ecsSizes`. */
function shadowFlagsKey(castMode: 'auto' | 'on' | 'off', receive: boolean): string {
  return `${castMode}:${receive}`;
}

/** World position of a light's authored shadow follow target, or undefined when there is no
 *  target, the guid is stale, or the entity has no resolved world transform yet. Undefined means
 *  "fall back to the view focus" — never "centre on the origin". */
function resolveShadowFocus(guid: string, world: World): { x: number; y: number; z: number } | undefined {
  if (!guid) return undefined;
  const e = findEntityByGuid(guid, world);
  if (!e) return undefined;
  const wt = worldTransforms.get(e.id());
  return wt ? { x: wt.x, y: wt.y, z: wt.z } : undefined;
}

/** Configure a directional/spot light's shadow map + camera + bias from its Light trait.
 *  Called each frame while castShadow is on; the mapSize realloc is guarded so it only
 *  regenerates the depth texture when the size actually changes. */
function configureLightShadow(
  l: THREE.DirectionalLight | THREE.SpotLight,
  light: { shadowMapSize: number; shadowCameraSize: number; shadowBias: number; shadowNormalBias: number; shadowRadius: number; shadowFollowCamera: boolean },
  focus?: { x: number; y: number; z: number },
): void {
  const s = l.shadow;
  // Clamp to the tier's ceiling (#121 P3). `Light.shadowMapSize` is a per-light trait field with
  // no global cap, so without this a tier could say "shadows, but smaller" and nothing would
  // enforce it — a scene authoring 2048 across 150 casters would ignore the tier entirely.
  const authoredSize = light.shadowMapSize || 2048;
  const size = tierShadowMapSize(authoredSize, getActiveTierOverrides());
  if (s.mapSize.width !== size || s.mapSize.height !== size) {
    s.mapSize.set(size, size);
    if (s.map) { s.map.dispose(); (s as unknown as { map: unknown }).map = null; }
  }
  // Bias is texel-footprint-relative — a map clamped smaller than authored needs a scaled bias
  // or it self-shadows (see `shadowBiasScale` in qualityTier.ts, and §0b "Shadows on `low`
  // would render ACNE" for why a matching extent-shrink was tried and reverted: it silently
  // dropped distant casters' shadows rather than fixing the sampling).
  const scale = shadowBiasScale(authoredSize, size);
  s.bias = light.shadowBias * scale;
  s.normalBias = light.shadowNormalBias * scale;
  (s as unknown as { radius: number }).radius = light.shadowRadius;
  s.camera.near = 0.1;
  s.camera.far = 200;
  if (l instanceof THREE.DirectionalLight) {
    const c = light.shadowCameraSize || 16;
    const cam = s.camera as THREE.OrthographicCamera;
    cam.left = -c; cam.right = c; cam.top = c; cam.bottom = -c;

    // Recentre the box on the view instead of leaving it anchored at the light's authored
    // position (see shadowFollow.ts for the measured forest-camp footprint this fixes).
    if (light.shadowFollowCamera && focus) {
      // Capture the AUTHORED direction before moving anything — position/target for this
      // frame were already synced by the caller (syncLights runs the world-transform block
      // before calling here).
      const dx = l.target.position.x - l.position.x;
      const dy = l.target.position.y - l.position.y;
      const dz = l.target.position.z - l.position.z;
      const dirLen = Math.hypot(dx, dy, dz) || 1;
      const d = { x: dx / dirLen, y: dy / dirLen, z: dz / dirLen };
      // `size` (px) here is the TIER-CLAMPED map size computed above, not the authored one —
      // the snap has to match the map that was actually allocated.
      const center = snapShadowCenter({ focus, lightDir: d, size: c, mapSize: size });
      l.target.position.set(center.x, center.y, center.z);
      // For a directional light only the DIRECTION affects shading — moving position and
      // target together along that same direction preserves it exactly, so this only moves
      // the shadow camera, never the light's illumination.
      const back = c * 2 + 10;
      l.position.set(center.x - d.x * back, center.y - d.y * back, center.z - d.z * back);
      // The pull-back has to fit INSIDE the depth range set above, and `far` up there is a flat
      // 200 chosen when the camera sat at the light's authored position. Recentring puts the
      // focus `back` away instead, so at shadowCameraSize >= 95 the focus lands at or beyond
      // far=200 and EVERY shadow from this light silently disappears — a scene-scale box (an
      // outdoor level authoring 100+) would have been broken by a feature that defaults to on.
      // Widen rather than replace, so the common small-box case keeps its authored 200.
      s.camera.far = Math.max(s.camera.far, back + c * 2);
      l.target.updateMatrixWorld();
    }
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

/** Scratch for deriving a spot/directional light's aim (see syncLights). Module-level so
 *  the per-frame light sweep allocates nothing. */
const _lightEuler = new THREE.Euler();
const _lightForward = new THREE.Vector3();

/** This frame's shadow-casting lights, reduced to what the cap's rule needs. Reused across
 *  frames — see `_maskedLights` above for why the render sync allocates nothing per frame. */
const _shadowCasters: ShadowCaster[] = [];

/** Collect the ACTIVE casting lights for the shadow-caster cap (#229), then arm it.
 *
 *  Lives here rather than in `shadowCasterCapFrame` because reading the world means importing the
 *  `Light` trait, which an L2 subsystem may not do — this file is reclassified L3 (D4 in
 *  `docs/architecture-layers.md`), so the query belongs on this side of the seam. Same inversion
 *  `armAutoLightCap` uses with its `MaskedLight[]`.
 *
 *  An unlimited cap (`high`, and every project that never authored a tier) walks NO lights: the
 *  query is cheap, but the loop allocates one descriptor per casting light per frame, and paying
 *  that to compute a cap which cannot bite is exactly the per-frame churn that measures as the
 *  engine's CPU cost on a weak device. */
function armShadowCastersFor(world: World, max: number): void {
  _shadowCasters.length = 0;
  if (max <= 0) { armShadowCasterCap(_shadowCasters, max); return; }
  world.query(Light).forEach((entity) => {
    if (deactivatedEntities.has(entity.id())) return;
    const l = entity.get(Light);
    if (!l || !l.castShadow) return;
    const type = casterTypeOf(l.lightType);
    if (type === null) return;
    _shadowCasters.push({ id: entity.id(), type, intensity: l.intensity, color: l.color });
  });
  armShadowCasterCap(_shadowCasters, max);
}

export function syncLights(
  world: World,
  scene: THREE.Scene,
  ecsLights: Map<number, THREE.Light>,
  focus?: { x: number; y: number; z: number },
) {
  _activeLightIds.clear();
  _maskedLights.length = 0;
  // Which lights may render a shadow map at all (#229). Decided BEFORE the loop because it is a
  // question about the whole light set — see `armShadowCastersFor`.
  armShadowCastersFor(world, getActiveTierOverrides().maxShadowCasters);
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
    // Ambient carries the IBL-off compensation (#154) — a scene whose IBL was suppressed would
    // otherwise render visibly dark and flat. Gated on `isIblSuppressed()`, NOT on the tier: a
    // scene that never had an environment has nothing to compensate for, and boosting it anyway
    // is a tier raising its output. Always 1 unless this frame actually lost an environment, so
    // the authored value passes through untouched everywhere else.
    l.intensity = light.intensity
      * (iblSuppressed && l instanceof THREE.AmbientLight ? tierAmbientBoost(getActiveTierOverrides()) : 1);
    // The tier's shadow-caster cap (#229) applies HERE rather than by not authoring the flag:
    // `castShadow` is the authored intent and stays untouched in the trait, while three is told
    // what this frame can afford. A light the cap demoted renders no map and builds no
    // `ShadowNode`, which is the whole saving — an extra submit of the caster set per light.
    l.castShadow = light.castShadow && shadowCasterAllowed(id);
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
      //
      // Derive it through `applyEuler` rather than hand-rolled trig, so a light's aim uses
      // the SAME euler order the renderer applies to every other object — three's default
      // XYZ, as in `applyTransform`'s `obj.rotation.set(...)` and `getWorldTransform3D`'s
      // decomposition. The previous inline formula
      // `(-sin(ry)cos(rx), sin(rx), -cos(ry)cos(rx))` is YXZ (Ry·Rx), so the same authored
      // euler meant one orientation on a mesh/camera and a different one on a light. The
      // two agree only when `ry ≈ 0`, which is why it went unnoticed — most authored spots
      // have little yaw. (Roll is irrelevant either way: rotating about Z leaves the -Z
      // axis fixed, so `rz` cannot change the forward direction.)
      //
      // AUTHORED TARGET WINS. `targetX/Y/Z` are world-space coordinates to aim AT; when any
      // of them is non-zero the light points there and the rotation is ignored. All-zero
      // means UNSET (not "aim at the world origin") — that is what keeps every scene authored
      // before the fields were wired working unchanged, since they all serialize 0,0,0. To
      // aim at the origin, nudge one axis (e.g. targetY 0.001); the direction error is
      // immeasurable at any real light distance.
      if (l instanceof THREE.SpotLight || l instanceof THREE.DirectionalLight) {
        if (light.targetX !== 0 || light.targetY !== 0 || light.targetZ !== 0) {
          l.target.position.set(light.targetX, light.targetY, light.targetZ);
        } else {
          _lightEuler.set(wt.rx, wt.ry, wt.rz);
          _lightForward.set(0, 0, -1).applyEuler(_lightEuler);
          l.target.position.set(
            wt.x + _lightForward.x,
            wt.y + _lightForward.y,
            wt.z + _lightForward.z,
          );
        }
        if (!l.target.parent) scene.add(l.target);
      }
    }

    // Shadow config runs AFTER the position/target sync above — a follow-recentre needs this
    // frame's authored direction, not last frame's.
    if (l.castShadow && (l instanceof THREE.DirectionalLight || l instanceof THREE.SpotLight)) {
      // An authored follow TARGET beats the caller's view-derived focus: measured in
      // demos/forest-camp, the derived ground point trails the character by 2.8-3.7 m (it grows
      // while walking, since the camera lags and looks slightly ahead), which spends a quarter of
      // the box's radius on empty ground. Centred on the subject instead, `shadowCameraSize` can
      // be SMALLER for the same coverage around it — and texel size is 2*size/mapSize, so that is
      // the cheapest sharpness available. Falls back to the view focus when unset or unresolvable
      // (a stale guid must not silently pin the box at the world origin).
      // Resolve the target ONLY when it can actually be used. `configureLightShadow` consumes
      // `focus` inside its DirectionalLight branch and behind `shadowFollowCamera`, so without
      // this gate every spot-light shadow — and every directional that opted OUT of follow —
      // paid a guid lookup whose result is discarded. That matters because a STALE guid is not
      // a cheap miss: `findEntityByGuid` self-heals by rescanning the whole world, and since the
      // entity is genuinely gone the rescan repeats every frame, forever, silently (the fallback
      // renders correctly, so only a profiler would ever show it). Same self-heal precedent as
      // `syncBoneAttachments`, but that one only pays it per live BoneAttachment.
      const wantsFollow = light.shadowFollowCamera && l instanceof THREE.DirectionalLight;
      const targetFocus = wantsFollow && light.shadowFollowTarget
        ? resolveShadowFocus(light.shadowFollowTarget, world)
        : undefined;
      configureLightShadow(l, light, targetFocus ?? focus);
    }

    // Rendering-layer mask (#136) — published for the renderable pass, which runs after this
    // one (see `syncSceneRenderables3D`). Collected HERE because this is the only place the
    // ECS `Light` trait and its THREE.Light are both in hand.
    _maskedLights.push({ light: l, mask: light.renderingLayerMask });
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
  /** Last-applied shadow-flags composite key (`shadowFlagsKey`) per entity id, so
   *  `applyShadowFlags` re-runs only when the authored castShadow/receiveShadow fields
   *  actually change, not every frame (#183 — covers Renderable3D/Renderable3DPrimitive
   *  AND SkinnedModel entities, keyed by the same entity id). */
  ecsShadowFlags: Map<number, string>;
  /** The SAME cache for the SKINNED pass, and deliberately a SEPARATE map: an entity may carry
   *  a SkinnedModel AND a Renderable3D/Renderable3DPrimitive at once (nothing declares them
   *  mutually exclusive), and the two passes own DIFFERENT THREE objects under the one entity
   *  id. Sharing one map made each pass see the other's key, mismatch, and re-apply — a
   *  permanent per-frame `traverse` of the whole rig that renders correctly and so is invisible,
   *  which is exactly the cost this cache exists to avoid. */
  skinnedShadowFlags: Map<number, string>;
  ownsGeometry: Set<number>;
  /** Materials THIS surface minted inline (a primitive's default material) — the only ones it may
   *  dispose. See the note at the top of this module for why it is not module-global. */
  ownedMaterials: Set<THREE.Material>;
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
    ecsShadowFlags: new Map(),
    skinnedShadowFlags: new Map(),
    ownsGeometry: new Set(),
    ownedMaterials: new Set(),
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
      state.ecsShadowFlags.delete(id);
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
      state.skinnedShadowFlags.delete(id);
    }
  });
}

/** Dispose all tracked objects, remove from scene, and clear collections.
 *
 *  ⚠️ **Only materials this render state OWNS are disposed** — the same `ownedMaterials` gate the
 *  per-entity removal in `syncRenderables` uses, and for the same reason. This used to take a
 *  `disposeMeshMaterials` flag that the editor SceneView passed `true` for, disposing the material
 *  on every owned-geometry mesh UNCONDITIONALLY. A primitive owns its geometry whatever its
 *  material is, so that reached three things nothing here may dispose:
 *    - the **shared cached `.mat.json` material** (`resolveMaterial`), still held by the material
 *      cache and still bound by the other render loop — the editor runs two of these, and a
 *      material shared across a scene swap deliberately SURVIVES the swap's release (see
 *      docs/scene-loading.md), so the swap-time teardown tore down a material about to be reused;
 *    - **`primitives._placeholderMaterial`**, the module-level sentinel a primitive holds while its
 *      authored material is still loading (or forever, if the ref does not resolve) — documented
 *      at its definition as "must never be disposed";
 *    - **`_defaultMaterial`**, the module-level fallback for an empty ref — `syncMaterial` never
 *      binds it directly (#480), only a per-entity CLONE that IS owned and disposed normally.
 *  All but the last are process-wide singletons or cache entries, so one panel unmounting broke
 *  them for every panel. Ownership is the only safe discriminator, and it is already tracked. */
export function disposeRenderState(state: RenderState, scene: THREE.Scene) {
  for (const [id, obj] of state.ecsObjects) {
    scene.remove(obj);
    if (state.ownsGeometry.has(id) && (obj as THREE.Mesh).geometry) {
      (obj as THREE.Mesh).geometry.dispose();
    }
    // materialTargetsOf so a LOD's child-mesh materials are reaped too (F11) — mirrors the
    // per-entity removal path in syncRenderables, gate included.
    for (const target of materialTargetsOf(obj)) {
      const mat = target.material as THREE.Material | undefined;
      if (mat && state.ownedMaterials.has(mat)) {
        state.ownedMaterials.delete(mat);
        mat.dispose();
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
  state.ecsShadowFlags.clear();
  state.skinnedShadowFlags.clear();
  state.ownsGeometry.clear();
  state.ownedMaterials.clear();
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
  isMasked = false,
  castMode: 'auto' | 'on' | 'off' = 'auto',
  // #480 (narrowed by review — see below): true for a caller whose EMPTY-ref material is written
  // into IN PLACE by something else in the same pass (the primitive colour block's
  // `color.setHex`), so an empty ref must not hand it the shared `_defaultMaterial` singleton.
  // False (the default) for every other caller — a GLB (`Renderable3D`) mesh with no override
  // never has anything write into its material (Tint/MaterialInstance bind their OWN clones), so
  // it keeps binding the shared singleton exactly as before #480.
  mintsPrivateDefault = false,
): void {
  const targets = materialTargetsOf(obj);
  const prevMat = state.ecsMaterials.get(id);
  if (prevMat !== curMat) {
    // Resolve the new material once (a `.mat.json` GUID, the engine default for most empty-ref
    // callers, or a fresh per-entity clone of it for `mintsPrivateDefault` — see below), then fan
    // it out to every target. A mesh renderer references a MATERIAL only — never a texture
    // directly (textures live on the .mat.json).
    let newMat: THREE.Material | undefined;
    if (curMat) {
      newMat = resolveMaterial(curMat) ?? undefined;
    } else if (mintsPrivateDefault) {
      // #480: clone rather than bind the shared `_defaultMaterial` singleton — the PRIMITIVE
      // colour block (the only caller that passes `mintsPrivateDefault`) writes straight into
      // `material.color`, so two primitives whose refs clear to '' in the same frame would
      // otherwise fight over one object, with the pollution outliving both. The clone is tracked
      // as OWNED so the existing lifecycle (the retirement handoff below, `disposeRenderState`)
      // frees it exactly like any other inline material.
      //
      // ⚠️ CONFINED TO `mintsPrivateDefault` ON PURPOSE — an earlier version of this fix made the
      // clone unconditional and broke two things measured on real entities:
      //  - `applyInstancedBatching` (instancedBatching.ts) keys on `${geo.uuid}|${mat.uuid}`; 8
      //    identical GLB entities sharing `_defaultMaterial` went from
      //    `{considered:8,batched:8,groups:1,drawCallsSaved:7}` to
      //    `{considered:8,batched:0,skipped:{"below-threshold":8}}` once each held its own clone.
      //  - a light-masked GLB with an empty ref would mint a PER-ENTITY light-mask variant
      //    (`cloneDerived` stamps `__derivedBase`, so `baseOf(clone)` is the clone ITSELF —
      //    `lightMaskVariants.ts` shares variants by base identity, so a distinct base per entity
      //    means a distinct variant per entity in a cache with an explicit "must not grow per
      //    entity" test). A `Renderable3DPrimitive` can never reach this: `masked` there is
      //    `!!rend.material && …`, so an empty-ref PRIMITIVE is never masked in the first place —
      //    which is what makes confining the clone to primitives safe from this specific risk too.
      // `cloneDerived`, not a bare `.clone()` — every material clone bound to a live mesh must
      // go through it (materialCloneStamp.test.ts), and it is also what lets this clone
      // participate in the same retire/refresh bookkeeping as every other derived material.
      newMat = cloneDerived(_defaultMaterial, _defaultMaterial);
      state.ownedMaterials.add(newMat);
      // Force the primitive colour block to re-apply `rend.color` this frame: it only calls
      // `setHex` when the cached colour differs from the authored one, and a fresh clone starts
      // at `_defaultMaterial`'s grey — which can equal a stale `ecsColors` entry left over from
      // before the ref cleared, so the authored colour would otherwise never get written.
      state.ecsColors.delete(id);
    } else {
      newMat = _defaultMaterial;
    }
    // Record the ref only once it actually resolved (#479): while `newMat` stays undefined (a
    // `.mat.json` load still in flight, or MATERIAL_FAILED), leaving `prevMat !== curMat` true
    // makes this branch re-run — and retry — every following frame, for EVERY entity kind,
    // including tinted / MaterialInstance / light-masked ones the `else if` below skips.
    // Recording the ref immediately would make an unresolved ref look "handled" when nothing
    // was ever bound.
    if (newMat) state.ecsMaterials.set(id, curMat);
    // Collect candidate owned materials rather than disposing inline: when `newMat` is not
    // yet resolved (async .mat.json load still in flight, or MATERIAL_FAILED), `t.material`
    // is left pointing at the old material below, and disposing it out from under a mesh
    // still in the scene corrupts that frame's render (#477). Freed below, once we know
    // whether anything still binds it.
    // Lazily allocated (#479): this branch can now run every frame for an entity whose ref
    // never resolves, and an owned material needing to be freed here is rare — an
    // unconditional `new Set()` is exactly the per-frame GC churn `syncRenderablesChurn`
    // polices, same reasoning as the lazy allocation in the branch below.
    let toFree: Set<THREE.Material> | undefined;
    for (const t of targets) {
      const oldMat = t.material as THREE.Material;
      if (oldMat && state.ownedMaterials.has(oldMat)) (toFree ??= new Set()).add(oldMat);
      // Only 'auto' re-derives cast from the new material's transparency — an explicit
      // 'on'/'off' override (#183) must survive a material swap, not be clobbered here.
      if (newMat) { t.material = newMat; if (castMode === 'auto') t.castShadow = !newMat.transparent; }
    }
    // INVARIANT (#477): an owned material is freed only once a replacement is actually
    // assigned to every target that held it. `newMat === undefined` leaves it bound
    // everywhere (nothing to free yet — no replacement resolved this frame; the polling
    // branch below closes the leak once the async load lands).
    if (toFree) {
      for (const m of toFree) {
        if (targets.some((t) => t.material === m)) {
          // Still bound — no replacement landed. NOT ours to free now, but nor can we simply
          // leave it: syncMaterial is not the only writer of `t.material` (applyLightMask #136,
          // materialInstanceSystem), and for a masked/instanced entity the polling branch below
          // never runs, so nobody would ever come back for it. Hand it to the per-frame sweep,
          // which frees it once NOTHING binds it — whoever did the rebinding (#477).
          state.ownedMaterials.delete(m);
          retireDerivedMaterial(m, () => m.dispose());
          continue;
        }
        state.ownedMaterials.delete(m);
        m.dispose();
      }
    }
  } else if (!isTinted && !isInstanced && !isMasked && curMat) {
    // .mat.json path unchanged but the async load may have finished since
    // last frame — check if the resolved material is now available.
    // Skipped for tinted meshes AND for entities with a MaterialInstance prop
    // override: those bind a per-entity CLONE of the resolved material (the Tint
    // block / materialInstanceSystem own the binding), so resetting to the base
    // here would fight that clone every frame.
    // Skipped for light-masked entities (#136) for the same reason — `applyLightMask` binds a
    // shared (material, mask) variant afterwards. NOTE the branch ABOVE still runs for them, so
    // a genuine material-ref change is still picked up and the variant rebuilds from the new
    // base; only the per-frame re-bind is suppressed.
    const resolved = resolveMaterial(curMat);
    if (resolved) {
      // BACKSTOP, not the live path (#477). Today this frees nothing: the only site that
      // marks a material owned is the primitive branch, and branch 1 above always takes an
      // owned material OUT of `ownedMaterials` — disposing it when a replacement resolved,
      // else handing it to the retirement sweep — so by the time we get here `has(oldMat)`
      // is false. It is kept, and gated on `ownedMaterials`, for two reasons: a future
      // second insertion site would otherwise silently leak here, and the gate is what
      // stops us double-freeing a material the sweep now owns. Assign the replacement
      // BEFORE freeing, same collect-then-check-then-free shape as above.
      // Lazily allocated: this branch runs every frame for every non-tinted/non-instanced/
      // non-masked renderable carrying a `.mat.json`, and an owned material needing to be
      // freed here is rare — an unconditional `new Set()` was hundreds of Sets/frame of GC
      // churn on the path `syncRenderablesChurn` polices.
      let toFree: Set<THREE.Material> | undefined;
      for (const t of targets) {
        const oldMat = t.material as THREE.Material;
        if (oldMat !== resolved && oldMat && state.ownedMaterials.has(oldMat)) {
          (toFree ??= new Set()).add(oldMat);
        }
        if (t.material !== resolved) t.material = resolved;
        // See the 'auto'-only guard above.
        if (castMode === 'auto') t.castShadow = !resolved.transparent; // keep in sync even once the ref settles
      }
      if (toFree) {
        for (const m of toFree) {
          if (targets.some((t) => t.material === m)) continue;
          state.ownedMaterials.delete(m);
          m.dispose();
        }
      }
    }
  }
}

/** Swap an entity's meshes onto the light-mask variant of whatever material they ended up with
 *  (#136). Runs LAST, after `syncMaterial`, Tint and MaterialInstance have settled the material,
 *  so it composes with them instead of competing: the variant is derived FROM the material the
 *  entity actually has, whether that is the shared base, a tint clone, or a per-entity clone.
 *
 *  No-op unless masking is active AND the entity's mask sees fewer than every light — so an
 *  unauthored scene walks this and allocates nothing.
 *
 *  The `!==` guard makes it a genuine no-op once applied. That matters more than usual here:
 *  reassigning `.material` every frame is what `syncRenderablesChurn` exists to catch, and the
 *  first hand-patched device test of this feature measured NO improvement precisely because
 *  `syncMaterial` was reassigning the base underneath a per-mesh override every frame. */
/** The light mask for one object: the authored layer mask, or — when the automatic cap is
 *  engaged — the authored intent intersected with the cap's per-object selection.
 *
 *  Position comes from `matrixWorld`, NOT the Transform trait: the cap picks the NEAREST local
 *  lights, and a child entity's local position says nothing about where it is in the world (the
 *  world-transform gap — rendering is the one layer that composes parents). A frame of staleness
 *  is acceptable here and cheaper than forcing an update: the selection only has to be right
 *  about which lights are closest, not about the exact metre. */
function lightMaskFor(renderableMask: number, obj: THREE.Object3D): number {
  if (!isAutoLightCapEngaged()) return renderableMask;
  const p = obj.matrixWorld.elements;
  // `obj` doubles as the hysteresis identity (#353) — the same Object3D every frame for a given
  // entity, so its previously-kept local lights are remembered across frames.
  return autoCapMaskFor(renderableMask, p[12], p[13], p[14], obj);
}

function applyLightMask(obj: THREE.Object3D, mask: number): void {
  if (!isLightMaskingActive()) return;
  const factory = getActiveRenderer() as unknown as LightingFactory | null;
  // No renderer yet (first frames / headless): leave the material alone rather than caching a
  // variant we cannot build — masking picks up on a later frame.
  if (!factory?.lighting) return;
  for (const t of materialTargetsOf(obj)) {
    const cur = t.material as THREE.Material | THREE.Material[];
    // Multi-material meshes are not covered yet: each slot would need its own variant, and no
    // authored content uses one with a mask. Skipped here rather than silently mis-lit.
    if (Array.isArray(cur) || !cur) continue;
    // `baseOf` — by frame 2 `t.material` IS last frame's variant, and cloning that would clone
    // the clone every frame (measured: variants growing 1, 2, 3, … with nothing looking wrong).
    let base = baseOf(cur);
    // …and that recovered base can be a RETIRED instance (#318). `syncMaterial` deliberately
    // skips its per-frame re-bind for a masked entity, so nothing else ever hands this mesh the
    // re-imported material: left alone, the variant is re-derived from the dead pointer under an
    // unchanged `${uuid}|${sel}` key and the mesh shows the pre-reimport bytes for the rest of
    // the session. `refreshedMaterial` is the one route from the dead instance back to its
    // successor; it returns undefined until the async refetch lands, and the sweep keeps the
    // retiree alive in the meantime, so the gap renders the old bytes rather than nothing.
    const fresh = refreshedMaterial(base);
    if (fresh) {
      retireVariantsOf(base); // the variants of the dead base are stale for good
      base = fresh;
    }
    const variant = getMaskedMaterial(base, mask, factory);
    if (variant && t.material !== variant) t.material = variant;
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
 *  for unit tests. No-op when the node isn't in this clone (stale node name).
 *  Returns whether any MATERIAL was rebound this call (visibility alone doesn't count) —
 *  the caller uses that to re-derive `castShadow` for an `'auto'` rig, since a swapped-in
 *  material can differ in transparency from the one the flags were derived from (#183). */
export function syncNodeMaterials(
  node: NodeRender,
  overrides: Record<string, string> | undefined,
  visible: boolean,
  resolve: (guid: string) => THREE.Material | undefined = resolveMaterial,
): boolean {
  let changed = false;
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
      changed = true;
      continue;
    }
    const mat = resolve(guid);
    if (!mat) continue; // async load pending — keep baked, retry next frame
    for (const t of targets) {
      if (t.index < 0) t.mesh.material = mat;
      else (t.mesh.material as THREE.Material[])[t.index] = mat;
    }
    node.appliedOverrides.set(slot, guid);
    changed = true;
  }
  return changed;
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
    // A rebound material can differ in transparency from the one the rig's shadow flags were
    // derived from, and this pass runs AFTER the SkinnedModel loop that applies them — so drop
    // the cached key and let the next frame re-derive. Unconditional rather than 'auto'-only:
    // re-applying an explicit 'on'/'off' just re-asserts the same value, and reaching the rig's
    // mode from a child renderer entity would cost more than the one extra traverse it saves.
    if (syncNodeMaterials(node, r.materials, r.visible)) state.skinnedShadowFlags.delete(parentId);
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
      // A fresh clone is about to be built below, defaulting to no shadow (see the scene.add(root)
      // comment) — force the next shadow-flags check to re-apply rather than reading a stale key.
      state.skinnedShadowFlags.delete(id);
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
      // #183 — this call was MISSING entirely: every rigged character kept THREE's defaults
      // (castShadow false, receiveShadow false) and never cast OR received a shadow. A
      // receiveShadow of false is the tell that this function never ran on a mesh — every
      // OTHER renderer path (LOD/GLB/primitive, below) calls applyShadowFlags and none of
      // them leaves receiveShadow false, since today's default is unconditional true.
      applyShadowFlags(root, sm.castShadow, sm.receiveShadow);
      state.skinnedShadowFlags.set(id, shadowFlagsKey(sm.castShadow, sm.receiveShadow));
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

    // Live-edit path: the clone above already got its shadow flags at creation — this only
    // re-applies when the authored fields change on an EXISTING entry (#183).
    {
      const shadowKey = shadowFlagsKey(sm.castShadow, sm.receiveShadow);
      if (state.skinnedShadowFlags.get(id) !== shadowKey) {
        applyShadowFlags(entry.root, sm.castShadow, sm.receiveShadow);
        state.skinnedShadowFlags.set(id, shadowKey);
      }
    }

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
    state.skinnedShadowFlags.delete(id);
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
    // The scale here is deliberately discarded (see above), but the ROTATION is not: a bone
    // with a zero scale axis decomposes to an identity quaternion through three, which would
    // leave the attached prop unrotated (#258).
    decomposeTrs(bone.matrixWorld, _bonePos, _boneQuat, _boneScale);
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
      _boneBridgeMat.compose(bone.position, bone.quaternion, bone.scale).premultiply(prefix.fwd);
      decomposeTrs(_boneBridgeMat, _bonePrefixPos, _bonePrefixQuat, _bonePrefixScl); // singular-safe — #258
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
        .premultiply(prefix.inv);
      // USER-REACHABLE: Bone entities are hand-posable, so typing 0 into a bone's scale in the
      // Inspector makes this matrix singular — through three that wrote scale 1 and an identity
      // rotation straight onto the THREE.Bone, snapping the limb back to full size (#258).
      decomposeTrs(_boneBridgeMat, bone.position, bone.quaternion, bone.scale);
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
  const { ecsObjects, ecsSprites, ecsMaterials, ecsColors, ecsSizes, ecsShadowFlags, ownsGeometry } = state;
  _activeRenderIds.clear();

  // Rendering-layer light masks (#136). Publish the light set BEFORE the renderable loops so
  // `applyLightMask` can look variants up as each entity's material settles.
  //
  // The renderable side is scanned separately rather than folded into the loop below because
  // masking has to be armed BEFORE the first entity is processed: a renderable whose mask
  // excludes the default layer must stop being lit by default-layer lights, and discovering
  // that mid-loop would leave every entity before it lit wrongly for a frame. The scan reads
  // one number per renderable and is skipped entirely once a masked light has already armed it.
  let anyRenderableMasked = false;
  world.query(Renderable3D).updateEach(([rend]) => {
    if (rend.renderingLayerMask !== DEFAULT_RENDERING_LAYER_MASK) anyRenderableMasked = true;
  });
  if (!anyRenderableMasked) {
    world.query(Renderable3DPrimitive).updateEach(([rend]) => {
      if (rend.material && rend.renderingLayerMask !== DEFAULT_RENDERING_LAYER_MASK) anyRenderableMasked = true;
    });
  }
  // ── The automatic light cap (#188 item 7) ────────────────────────────────────────────────
  // Armed HERE, between the renderable scan and the publication, because it must see the frame's
  // final light list and must republish it before any entity resolves a mask. It engages only
  // when the tier's caps would actually restrict something (`high` never can — its caps are 0 =
  // unlimited), so the common path is untouched. When it engages it also ARMS masking, since the
  // scene itself may have authored nothing.
  // `state` doubles as the hysteresis memory's per-surface key (#353 review) — SceneView and the
  // Game panel's `Scene3D` each own their own `RenderState` and their own `THREE.Light` instances
  // for the same scene, so a shared memory would see two different light sets alternate every
  // call and permanently invalidate itself. One `RenderState` per surface (see its own header
  // note) makes it the identity already at hand here.
  const capEngaged = armAutoLightCap(_maskedLights, getActiveTierOverrides(), state);
  beginLightMaskFrame(_maskedLights, anyRenderableMasked || capEngaged);

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
      // A fresh THREE object is about to be built below, defaulting to no shadow — force the
      // next applyShadowFlags check to re-apply rather than reading a stale "unchanged" key.
      ecsShadowFlags.delete(id);
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
        scene.add(lodObj);
        ecsObjects.set(id, lodObj);
        ecsSprites.set(id, rend.mesh);
        obj = lodObj;
      } else {
        const template = resolveMeshTemplate(rend.mesh);
        if (template) {
          const material = resolveMaterialForMesh(rend.material, rend.mesh) || template.material;
          const mesh = new THREE.Mesh(template.geometry, material);
          scene.add(mesh);
          ecsObjects.set(id, mesh);
          ecsSprites.set(id, rend.mesh);
          obj = mesh;
        }
      }
    }

    // Shadow flags — apply on creation and re-apply only when the authored fields change
    // (the ecsShadowFlags cache holds the last-applied key; #183).
    if (obj) {
      const shadowKey = shadowFlagsKey(rend.castShadow, rend.receiveShadow);
      if (ecsShadowFlags.get(id) !== shadowKey) {
        applyShadowFlags(obj, rend.castShadow, rend.receiveShadow);
        ecsShadowFlags.set(id, shadowKey);
      }
    }

    // Update material (GLB: .mat.json only, no inline textures)
    if (obj && rend.mesh) {
      const instanced = isMaterialInstanced(entity);
      // MaterialInstance (a per-entity material clone driven by materialInstanceSystem) takes
      // precedence over Tint — both would otherwise claim mesh.material and fight each frame.
      const tinted = !instanced && entity.has(Tint);
      const lightMask = lightMaskFor(rend.renderingLayerMask, obj);
      const masked = maskNeedsVariant(lightMask);
      // `mintsPrivateDefault` intentionally omitted (defaults to false, #480 review) — nothing
      // writes into a GLB's material in place (Tint/MaterialInstance bind their OWN clones), so
      // an empty ref keeps binding the shared `_defaultMaterial`, exactly as before #480. See the
      // parameter's doc comment on `syncMaterial` for the batching regression this avoids.
      syncMaterial(obj, id, rend.material || '', state, tinted, instanced, masked, rend.castShadow);
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
      // Last, so it derives from the settled material (base / tint clone / instance clone).
      applyLightMask(obj, lightMask);
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
    const kindChanged = obj && ecsSprites.get(id) !== rend.mesh;
    // Short-circuited so `isPrimitive` is called ONLY when the kind actually changed — matching
    // the original evaluation order (several tests mock `loaders/primitives` with just
    // `createPrimitiveMesh`, no `isPrimitive`/`PRIMITIVE_NAMES`, because their scenarios never
    // touch a kind change; calling it unconditionally here broke those mocks for no behavioural
    // gain — `obj &&` below already makes `meshKnown` irrelevant whenever `kindChanged` is falsy).
    const meshKnown = !kindChanged || isPrimitive(rend.mesh);
    // #482: a kind change to a name `isPrimitive` doesn't recognize (a hand-edited scene, or a
    // primitive kind renamed since the scene was authored) must not warn silently — warn once,
    // but leave the entity rendering whatever it already has; below, the rebuild gate skips it.
    if (kindChanged && !meshKnown) warnUnknownPrimitiveOnce(id, rend.mesh);
    // #482: do not free the OLD mesh until the replacement is actually in hand — the same
    // ordering discipline as #477. An UNKNOWN name is INERT here, full stop, regardless of what
    // else changed: no rebuild, no free, the old mesh (if any) is kept exactly as it was. This
    // gate used to read `sizeChanged || (kindChanged && meshKnown)`, which let a size change
    // paired with an unknown name (or a later size edit on an entity ALREADY stuck on an unknown
    // name — `ecsSprites` is deliberately not updated for one, so `kindChanged` stays true
    // forever) fall through the `sizeChanged` half and tear down anyway: geometry disposed, maps
    // cleared, then the create path's null check fires and the entity vanishes permanently with
    // nothing left to warn about (`warnUnknownPrimitiveOnce` had already fired for that name on
    // the frame the kind changed). Gating the ENTIRE condition on `meshKnown` closes every route.
    if (obj && meshKnown && (sizeChanged || kindChanged)) {
      scene.remove(obj);
      // Dispose owned geometry from the previous mesh so size churn doesn't leak.
      if (ownsGeometry.has(id) && (obj as THREE.Mesh).geometry) {
        (obj as THREE.Mesh).geometry.dispose();
      }
      // The owned MATERIAL needs the same care as the geometry above, and for the #477 reason:
      // nothing binds it once this mesh is dropped, and no later pass would come back for it —
      // `disposeRenderState` only walks `ecsObjects`, which no longer holds this mesh. Retire it
      // rather than disposing inline; this runs mid-pass, in the frame callback that also renders.
      const discardedMat = (obj as THREE.Mesh).material as THREE.Material;
      if (discardedMat && state.ownedMaterials.has(discardedMat)) {
        state.ownedMaterials.delete(discardedMat);
        retireDerivedMaterial(discardedMat, () => discardedMat.dispose());
      }
      ecsObjects.delete(id);
      ecsSprites.delete(id);
      ecsColors.delete(id);
      ecsMaterials.delete(id);
      ecsSizes.delete(id);
      // A fresh mesh is about to be built below, defaulting to no shadow — force the next
      // applyShadowFlags check to re-apply rather than reading a stale "unchanged" key.
      ecsShadowFlags.delete(id);
      ownsGeometry.delete(id);
      obj = undefined;
    }

    if (!obj) {
      // Skip the default material when an override is set — avoids the
      // create-then-immediately-dispose churn we'd otherwise pay on every spawn.
      const hasOverride = !!rend.material;
      const built = createPrimitiveMesh(rend.mesh, rend.size, rend.color, hasOverride);
      // #482: `rend.mesh` names a shape `createPrimitiveMesh` doesn't recognize (a hand-edited
      // scene, or a primitive kind renamed since the scene was authored). Do not free anything —
      // there is nothing to free here, this is the "no mesh exists yet" path — and do not throw:
      // warn once per bad name and leave the entity unrendered rather than crash the frame.
      if (!built) {
        warnUnknownPrimitiveOnce(id, rend.mesh);
        return;
      }
      obj = built;
      // #479: whether the ref is SETTLED as of this creation frame — an empty ref always is (the
      // primitive owns the default material `createPrimitiveMesh` just minted); a non-empty one
      // is settled only once `resolveMaterial` actually returns something.
      let materialSettled = true;
      if (!hasOverride) {
        // Track the primitive's default material as owned (safe to dispose)
        state.ownedMaterials.add((obj as THREE.Mesh).material as THREE.Material);
      } else if (rend.material) {
        const resolved = resolveMaterial(rend.material);
        if (resolved) (obj as THREE.Mesh).material = resolved;
        else materialSettled = false;
      }
      scene.add(obj);
      ecsObjects.set(id, obj);
      ecsSprites.set(id, rend.mesh);
      ecsColors.set(id, rend.color);
      // Record the ref only once it is SETTLED (#479) — recording an unresolved ref here is the
      // fourth door into the same defect `syncMaterial`'s own branch 1 closes: `syncMaterial`
      // runs later in this very callback and would see `ecsMaterials` already equal to `curMat`
      // and take the unchanged-ref `else if`, which is SKIPPED for a masked/instanced/tinted
      // entity — so a primitive SPAWNED with a not-yet-resolved ref would never bind it, staying
      // on `primitives._placeholderMaterial` (`visible: false`) forever instead of just looking
      // stale. Leaving it unset here makes `syncMaterial` take branch 1 and retry every frame
      // until the load lands, same as everywhere else.
      if (materialSettled) ecsMaterials.set(id, rend.material || '');
      ecsSizes.set(id, rend.size);
      ownsGeometry.add(id);
    }

    // Shadow flags — apply on creation and re-apply only when the authored fields change
    // (the ecsShadowFlags cache holds the last-applied key; #183).
    {
      const shadowKey = shadowFlagsKey(rend.castShadow, rend.receiveShadow);
      if (ecsShadowFlags.get(id) !== shadowKey) {
        applyShadowFlags(obj, rend.castShadow, rend.receiveShadow);
        ecsShadowFlags.set(id, shadowKey);
      }
    }

    // Material override — a .mat.json material GUID (empty = engine default).
    const instanced = isMaterialInstanced(entity);
    // Masks apply only to explicit-material primitives — see the trait's field comment: a
    // default-material primitive owns a per-entity material that the colour block below writes
    // into, and a shared (material, mask) variant would fight it.
    const lightMask = lightMaskFor(rend.renderingLayerMask, obj);
    const masked = !!rend.material && maskNeedsVariant(lightMask);
    // `mintsPrivateDefault: true` — the colour block right below writes into an empty-ref
    // primitive's material in place, so it must never be the shared `_defaultMaterial` (#480).
    syncMaterial(obj as THREE.Mesh, id, rend.material || '', state, false, instanced, masked, rend.castShadow, true);

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
    // After the colour block, and only for explicit materials (the colour path above owns the
    // default-material case outright).
    if (rend.material) applyLightMask(obj, lightMask);

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
        if (mat && state.ownedMaterials.has(mat)) {
          state.ownedMaterials.delete(mat);
          mat.dispose();
        }
      }
      ecsObjects.delete(id);
      ecsSprites.delete(id);
      ecsColors.delete(id);
      ecsMaterials.delete(id);
      ecsShadowFlags.delete(id);
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
async function loadBillboardPage(url: string): Promise<THREE.Texture> {
  const isKtx = /\.ktx2(\?|$)/.test(url);
  // KTX2Loader.loadAsync throws "Missing initialization with `.detectSupport()`" if it runs
  // before GPU caps are known. This used to be guaranteed by the editor's up-front renderer
  // gate; now that scene load no longer waits on a viewport, this is the one KTX2-touching site
  // that must gate itself explicitly (see docs/textures.md, "Runtime resolution").
  if (isKtx) await ensureKtx2Caps();
  // The KTX2 loader module is imported on demand (#254) — hence the await.
  const loader = isKtx ? await getKTX2Loader() : new THREE.TextureLoader();
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
        const mat = makeMtsdfMaterial(ptex, provider.atlas.width, provider.atlas.height, provider.atlas.distanceRange, provider.atlas.size, textStyle(t), provider.atlas.type !== 'msdf');
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
  callbacks?: {
    renderables?: SyncCallbacks;
    skinned?: SyncCallbacks;
    /** Collapse repeated (geometry, material) draws into InstancedMesh (#154 P4b). Opt-in:
     *  the editor SceneView must NOT enable it, because it picks entities by raycasting the
     *  individual meshes a batch hides. See instancedBatching.ts. */
    batchDrawCalls?: boolean;
  },
) {
  registerRenderSurface(scene);
  syncRenderables(world, scene, state, callbacks?.renderables);
  syncSkinnedModels(world, scene, state, callbacks?.skinned);
  syncBones(world, scene, state);
  syncBoneAttachments(world, scene, state);
  // Billboarded 2D skinned sprites (2.5D). Geometry/placement only; the camera-facing
  // rotation is per-caller via orientBillboards (runtime/editor/capture each use their
  // own camera). Uses the gizmo-aware renderables callback for consistent transform skip.
  syncBillboardSprites(world, scene, state, callbacks?.renderables);
  syncText3D(world, scene, state, callbacks?.renderables);
  // Video screens — binds a VideoPlayer entity's live element onto its material as a
  // VideoTexture. Runs LAST because it reads the objects the syncs above create, and
  // lives in its own module (an additive concern; this file is big enough).
  if (__MODOKI_MODULE_VIDEO__) syncVideoTextures(world, state);

  // Draw-call batching (#154 P4b) — LAST, and opt-in per caller. It reads the geometry,
  // material and world transform the syncs above settled, and decides none of them; running it
  // earlier would key off half-resolved materials and merge things that are about to diverge.
  //
  // OPT-IN because it hides the individual meshes it replaces, and the editor SceneView picks
  // entities by raycasting those meshes — batching them there would break selection. The game
  // runtime, which has no picking, is where the 237-draw-call frame lives.
  // Turning it OFF must RESTORE the scene, not just stop batching: the pass hides every member it
  // replaced, so skipping the call would leave those meshes hidden and their InstancedMesh still
  // in the scene — a scene that renders FEWER draws with batching "off" than with it on, which
  // silently corrupts exactly the A/B a caller flips this flag to run.
  if (callbacks?.batchDrawCalls) applyInstancedBatching(scene, state.ecsObjects.values());
  else clearInstancedBatches(scene);

  // Last, so this surface's re-binds above are already visible to the sweep.
  sweepRetiredMaterials();
}

/** Clear this surface's owned-material tracking. `disposeRenderState` already disposes and clears
 *  it; this stays as the explicit belt-and-braces call on world swap. */
export function clearOwnedMaterials(state: RenderState) {
  state.ownedMaterials.clear();
}

// ── Shader prewarm ──────────────────────────────────────

/** Objects the prewarm MINTED itself (primitive geometries/materials, side-pinned clones, the F4
 *  placeholder) — disposed at the START of the next prewarm rather than at the end of this one.
 *
 *  ⚠️ **Disposing them immediately RELEASES the pipeline they just warmed** (#238). three refcounts
 *  a render pipeline by the render objects that reference it (`Pipelines.delete` → `usedTimes--` →
 *  `_releasePipeline` at zero), and disposing a material tears down its render object. Measured on
 *  `games/3d-test`: `renderer._pipelines.caches` dropped by one at the exact millisecond the old
 *  dispose block ran — prewarm work undone by the prewarm's own cleanup. Holding them until the
 *  next swap costs a handful of small buffers and keeps the warm pipeline alive long enough for
 *  the first real frame to take a reference to it. */
const _prewarmRetained: Array<{ dispose(): void }> = [];

function disposeRetainedPrewarmObjects(): void {
  for (const o of _prewarmRetained) o.dispose();
  _prewarmRetained.length = 0;
}

/** Common preparation for every placeholder this prewarm places.
 *
 *  ⚠️ `frustumCulled = false` is load-bearing, not tidiness. `Renderer.compileAsync` builds its
 *  render list through `_projectObject`, which frustum-culls exactly as a render does — against
 *  the module-level `_frustum` LEFT BEHIND BY THE LAST RENDERED FRAME, since compile never updates
 *  it. The prewarm runs while the OUTGOING scene is still rendering, so what the prewarm compiles
 *  would otherwise depend on where the previous scene's camera happened to be pointing: a
 *  correctness lottery, and the kind of input that makes a boot stall INTERMITTENT. The prewarm
 *  scene is never drawn, so opting every placeholder out of culling costs nothing. */
function prepPrewarmMesh(mesh: THREE.Mesh): void {
  mesh.frustumCulled = false;
}

/** Whether three will draw this material in TWO side-pinned passes rather than one double-sided
 *  pass. Mirrors the condition in three's `Renderer.renderObject` EXACTLY — the prewarm has to
 *  make the same decision three does, and a paraphrase of it would be the drift this whole
 *  function exists to prevent (r184, Renderer.js:3452):
 *
 *  ```js
 *  if ( material.transparent === true && material.side === DoubleSide && material.forceSinglePass === false ) {
 *      material.side = BackSide;  handleObject(..., 'backSide');
 *      material.side = FrontSide; handleObject(..., passId);
 *      material.side = DoubleSide;
 *  }
 *  ```
 *
 *  ⚠️ **`compileAsync` walks that same branch and still compiles the WRONG pipeline**, which is
 *  why this exists at all. Its handler (`Renderer._createObjectPipeline`) only QUEUES the work
 *  while compiling, and the queue is drained after the block above has restored
 *  `material.side = DoubleSide` — so the prewarm builds one `cullMode: 'none'` pipeline where the
 *  render needs two `cullMode: 'back'` ones (three flips `frontFace` for the BackSide pass rather
 *  than the cull mode). Measured on `games/3d-test`: 6 of its 8 synchronous post-swap
 *  `MeshStandardMaterial` builds were exactly these variants, ~130 ms each on the A23. */
function sidePinnedVariants(material: THREE.Material): THREE.Side[] {
  return material.transparent === true && material.side === THREE.DoubleSide && material.forceSinglePass === false
    ? [THREE.BackSide, THREE.FrontSide]
    : [];
}

/** Clone a material with `side` pinned, WITHOUT losing what makes it distinct to the cache.
 *
 *  ⚠️ `Material.copy()` is a hand-written property list, so a clone silently drops any OWN
 *  property added after construction — and #136's light-mask variants add exactly the two that
 *  DECIDE the cache key: `lightsNode` (which three's key cannot see) and the
 *  `customProgramCacheKey` that exists to make it visible. A clone missing them hashes to a
 *  different key, so it would warm a pipeline nothing reads: this issue's defect, one layer down.
 *
 *  Carried GENERICALLY rather than by name — anything the source owns that the clone did not
 *  receive is copied across, so the next mechanism to hang a property off a material is covered
 *  without anyone remembering to update a list. The one exclusion is the `_`/`is`-prefixed set,
 *  which is exactly what `RenderObject.getMaterialCacheKey()` itself skips, so it cannot affect
 *  the key — and `_listeners` in particular MUST NOT be shared, or a dispose on either material
 *  would fire the other's handlers. */
export function pinnedSideClone(material: THREE.Material, side: THREE.Side): THREE.Material {
  // The `userData`-suppressing clone and the own-property carry that used to live here are now
  // `cloneDerived` (#325) — the prewarm was the FIRST site to need them, and videoTextureSync
  // turned out to be the second, having hit the identical trap independently. Read that function's
  // header for the two failure modes; the stand-ins' own stamping requirement (#318) is satisfied
  // inside it, on the clone line, exactly as `materialCloneStamp.test.ts` requires.
  const clone = cloneDerived(material, material);
  clone.side = side;
  return clone;
}

/** Meshes that stand in for one side-pinned mesh during the live compile — one per pinned pass.
 *
 *  Returns `[]` when a stand-in provably CANNOT match: `getMaterialCacheKey()` folds
 *  `object.uuid` in for an instanced / batched / morph-target mesh, so a different object is a
 *  different key by construction and the stand-in would warm a pipeline nothing reads. Those keep
 *  the hide-only behaviour and pay their first draw, which is honest rather than silent. */
export function pinnedStandIns(mesh: THREE.Mesh, retain: Array<{ dispose(): void }>): THREE.Mesh[] {
  const material = mesh.material as THREE.Material;
  const obj = mesh as unknown as {
    isInstancedMesh?: boolean; isBatchedMesh?: boolean; count?: number;
    morphTargetInfluences?: number[]; isSkinnedMesh?: boolean;
    skeleton?: THREE.Skeleton; bindMatrix?: THREE.Matrix4;
  };
  if (obj.isInstancedMesh || obj.isBatchedMesh || (obj.count ?? 0) > 1
      || Array.isArray(obj.morphTargetInfluences)) return [];

  const out: THREE.Mesh[] = [];
  for (const side of sidePinnedVariants(material)) {
    const clone = pinnedSideClone(material, side);
    retain.push(clone);
    let stand: THREE.Mesh;
    if (obj.isSkinnedMesh && obj.skeleton) {
      // A skeleton reaches the key as `object.skeleton.bones.length`, and skinning changes the
      // node graph — so a plain Mesh would be a different program, not a stand-in. Sharing one
      // skeleton across two meshes is what three itself does for LOD levels.
      const skinned = new THREE.SkinnedMesh(mesh.geometry, clone);
      skinned.bind(obj.skeleton, obj.bindMatrix ?? new THREE.Matrix4());
      stand = skinned;
    } else {
      stand = new THREE.Mesh(mesh.geometry, clone);
    }
    // Only the SIGN of the world determinant reaches the pipeline key (three flips `frontFace` for
    // a mirrored object), so copying the source's world matrix onto a scene-level child is enough
    // — it does not have to land in the same place, and it never draws.
    stand.matrixAutoUpdate = false;
    stand.matrix.copy(mesh.matrixWorld);
    stand.matrixWorld.copy(mesh.matrixWorld);
    stand.castShadow = mesh.castShadow;
    stand.receiveShadow = mesh.receiveShadow;
    stand.layers.mask = mesh.layers.mask;
    stand.renderOrder = mesh.renderOrder;
    prepPrewarmMesh(stand);
    out.push(stand);
  }
  return out;
}


/** Build a throwaway THREE.Scene containing placeholder meshes for every DISTINCT
 *  (mesh, material) pair among the world's Renderable3D + Renderable3DPrimitive
 *  entities, and run renderer.compileAsync against it. This compiles all shader
 *  programs the new scene will need BEFORE the world swap, eliminating
 *  first-frame stutter.
 *
 *  **One placeholder per PAIR, not per entity** (#154 P4a). Deduping is sound because
 *  both refs resolve deterministically: the same (mesh, material) pair always yields
 *  the same geometry + material object, hence the same program. Size/colour are
 *  deliberately NOT part of the key — they are uniforms, and a primitive's size
 *  changes vertex VALUES, not the attribute layout the program is built from.
 *
 *  ⚠️ **This is a redundant-work cleanup, NOT the fix for the boot stall — measured.**
 *  It looked like the fix: `compileAsync` walks its render list object-by-object, and a
 *  warm sweep on the Y6 2019 read a clean ~65 ms per DISTINCT object (1→51 objects,
 *  181→3548 ms). But an A/B/A in one app run on a Galaxy A23 (SC-56C), toggling the
 *  dedupe between scene reloads, put 33 placeholders at 1326/1131/1174/1182 ms against
 *  14 at 920/1132/1326/1226 ms — **no difference outside the noise**. The warm sweep
 *  varied distinct programs; deduping only removes DUPLICATES, and a duplicate is
 *  already nearly free. What the stall actually is: **cold shader compilation**,
 *  ~1.2 s per distinct program on the Y6 (postfx-demo's 14 distinct pairs = **16.5 s**
 *  of boot prewarm there, against 2.9 s on the A23). Cutting the object count cannot
 *  touch that; cutting the number of distinct MATERIALS would.
 *
 *  What this still buys: 19 fewer render-list objects and, for postfx-demo, 18 skipped
 *  `createPrimitiveMesh` calls — each of which mints a geometry + material only to
 *  dispose it below. Keep it for that; do not credit it with a framerate or boot win.
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
  // Boot timeline (#238): shader prewarm is one of the three boot phases the stall could be
  // hiding in, and the only one whose cost was ever attributed (wrongly, twice) from frame
  // markers. Two spans, not one — the scene BUILD and the actual `compileAsync` are different
  // costs and the earlier guesses could not tell them apart.
  //
  // Wrapped rather than begin/end'd around the body: `bootSpanAsync` closes on a throw, and a
  // leaked span is worse than a missing one — `bootSpansOverlapping` reads an open span as still
  // running, so it would rank first in a later stall attribution.
  return bootSpanAsync('shader-prewarm', () => prewarmShadersForWorldInner(world, renderer, camera));
}

async function prewarmShadersForWorldInner(
  world: World,
  renderer: WebGPURenderer | THREE.WebGLRenderer,
  camera: THREE.PerspectiveCamera,
): Promise<void> {
  // Free what the PREVIOUS prewarm minted before building this one — see
  // `_prewarmRetained` for why it is not freed at the end of its own call.
  disposeRetainedPrewarmObjects();

  const prewarmScene = new THREE.Scene();
  // Register AT CREATION, not at each binding site (#315, #317). This scene binds cached envs
  // AND cached materials, and holds both across the `await compileAsync` below — so a re-import
  // during that await would let a sweep free something this compile is still sampling. The first
  // cut registered inside the env mirror's `if (cached)` branch, which left every material
  // binding unguarded and skipped registration entirely for a scene with no Environment or a
  // tier with IBL off. Registering where the surface is BORN makes the resource kind irrelevant
  // and cannot go stale when a future mirror binds something new. The ref is weak, so the
  // throwaway scene still dies.
  registerRenderSurface(prewarmScene);
  let count = 0;

  /** Will the incoming world be drawn through a post-FX stack? If so, EVERY per-(mesh, material)
   *  placeholder below is provably worthless and this pass places none of them (#324b).
   *
   *  Two independent reasons, either of which alone is fatal, both measured rather than argued:
   *  the placeholders compile in the CANVAS render context at call depth 0 while the stack draws
   *  the scene through its own pass at depth 1 (`context.id` keys the node-builder cache — see
   *  docs/rendering.md sharp edge 3), and the materials the render actually binds are
   *  per-(material, light-selection) variant CLONES that `applyLightMask` mints from live
   *  `THREE.Light` instances a pre-swap copy cannot reproduce, and whose cache the swap disposes
   *  anyway. Measured on `demos/postfx-demo` with `nodeprobe.mjs` (2026-08-26): the prewarm builds
   *  9 node-builder states in `ctx 0` costing 163 ms, the live post-swap compile builds 22 in the
   *  stack's `ctx 4`, and the overlap between the two sets is ZERO.
   *
   *  ⚠️ **This is a SKIP, not a delete.** The F4 placeholder below is forced on regardless (see its
   *  note), because the first-compile race it guards has nothing to do with post-FX and everything
   *  to do with a normal material being the renderer's first compile. What the world loses here is
   *  covered by `compileLiveScene`, which runs after the swap through the stack's own pass — the
   *  only half that CAN be right under a stack.
   *
   *  ⚠️ The predicate deliberately shares `Scene3D`'s trait enumeration rather than re-listing the
   *  post-FX traits (`postfx/postFXTraitScan.ts`). A second list here would silently stop matching
   *  the moment a sixth post-FX trait is added — and it would fail in the expensive direction:
   *  reporting "no stack" for a world that gets one, so this pass resumes paying for placeholders
   *  nothing reads. */
  const willUseStack = worldWillUseStack(world, {
    isWebGPU: (renderer as { isWebGPURenderer?: boolean }).isWebGPURenderer === true,
  });
  /** Read at each walk below. Named rather than inlined as `!willUseStack` so the reason a walk is
   *  skipped is legible at the walk. */
  const walkPlaceholders = !willUseStack;

  // Lights are disposed at the end of this call; everything else the prewarm mints outlives it
  // (see `_prewarmRetained`). GLB template geometries/materials are SHARED and never disposed here.
  const prewarmLights: THREE.Light[] = [];

  // Which entities are MIRRORED — an odd number of negative scale factors along their parent
  // chain (#238). three folds `object.matrixWorld.determinant() < 0` into the render pipeline key
  // (`WebGPUPipelineUtils._getPrimitiveState` flips `frontFace` to CW for it), so a mirrored
  // entity needs a DIFFERENT pipeline from the same mesh+material drawn unmirrored. Every
  // placeholder below used to sit at identity, so only the CCW variant was ever compiled and the
  // first real frame built the CW one synchronously — measured on `games/3d-test`, 2 of its 8
  // post-swap synchronous builds.
  //
  // Derived HERE from the staging world rather than read out of `worldTransforms`: that map holds
  // the world that is still RENDERING, and this function runs before the swap — the same reason
  // the shadow-caster mirror above computes the pure rule instead of arming the live one. Only the
  // SIGN is needed, and sign(det) is the product of the sign of each ancestor's local scale, so no
  // matrices are composed.
  const localScaleSign = new Map<number, number>();
  const parentOf = new Map<number, number>();
  world.query(Transform).updateEach(([tf]: [{ sx: number; sy: number; sz: number }], entity) => {
    localScaleSign.set(entity.id(), tf.sx * tf.sy * tf.sz < 0 ? -1 : 1);
  });
  world.query(EntityAttributes).updateEach(([ea]: [{ parentId: number }], entity) => {
    if (ea.parentId) parentOf.set(entity.id(), ea.parentId);
  });
  const isMirrored = (id: number): boolean => {
    let sign = 1;
    let cur: number | undefined = id;
    // Depth-bounded, like `transformPropagationSystem`'s own walk: a parentId CYCLE in authored
    // data must degrade to a wrong-but-terminating answer, never hang the boot.
    for (let depth = 0; cur && depth < 64; depth++) {
      sign *= localScaleSign.get(cur) ?? 1;
      cur = parentOf.get(cur);
    }
    return sign < 0;
  };

  /** Add the placeholder(s) one (geometry, material) pair needs, and return how many were added.
   *  One mesh normally; TWO side-pinned clones when three would draw the material in two passes
   *  (see `sidePinnedVariants`). The clones are retained, not disposed here — disposing them would
   *  release the pipelines they exist to warm. */
  const place = (
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    mirrored: boolean,
    applyFlags: (obj: THREE.Object3D) => void,
  ): number => {
    const sides = sidePinnedVariants(material);
    const materials: THREE.Material[] = [];
    if (sides.length === 0) materials.push(material);
    else for (const side of sides) {
      // `pinnedSideClone` stamps the clone for the retired-material sweep (#318): this surface IS
      // registered (see `registerRenderSurface(prewarmScene)`) precisely so the sweeps can see it,
      // and an `invalidateMaterial` landing during the async `compileAsync` would otherwise free
      // the base out from under this clone. After `prewarmScene.clear()` nothing binds it, so it
      // pins nothing.
      const clone = pinnedSideClone(material, side);
      _prewarmRetained.push(clone);
      materials.push(clone);
    }
    for (const m of materials) {
      const mesh = new THREE.Mesh(geometry, m);
      // Mirrored entities compile the CW variant; the axis is arbitrary, only the SIGN of the
      // determinant reaches the pipeline key.
      if (mirrored) mesh.scale.x = -1;
      prepPrewarmMesh(mesh);
      applyFlags(mesh);
      prewarmScene.add(mesh);
    }
    return materials.length;
  };

  // Unresolved-ref tally (#238). The prewarm can only compile what it can RESOLVE, and every
  // resolution here fails SILENTLY into a still-plausible object: a missing mesh template skips
  // the entity, and a missing material leaves the primitive wearing the default
  // `createPrimitiveMesh` minted — which compiles a pipeline the render will never use and looks
  // exactly like success. That is unfalsifiable from the outside, so the prewarm now says what it
  // could not resolve instead of leaving the next investigator to infer it from pipeline labels.
  //
  // Declared HERE, above every loop that increments them. They lived beside `prewarmRigRoots`
  // further down for one commit, which put the primitive loop's `unresolvedMaterial++` in the
  // temporal dead zone — a ReferenceError on the FAILURE path only, so the counter that exists to
  // report a silent failure would have thrown at the exact moment it had something to say.
  // Counted per DISTINCT (mesh, material, shadow-flags) key, not per entity — the dedupe `skip()`
  // runs before resolution, so twenty entities sharing one unresolvable material report as 1.
  // That matches what the number is FOR (one unresolved key is one uncompiled pipeline) but it is
  // not a headcount, and the warning says "distinct" so nobody sizes the blast radius from it.
  let unresolvedMesh = 0;
  let unresolvedMaterial = 0;
  let unresolvedRig = 0;

  // Distinct (mesh, material) pairs already placed — see the header note. Prefixed
  // per renderer kind so a GLB mesh ref can never collide with a primitive keyword.
  const seenPairs = new Set<string>();
  const skip = (k: string) => { if (seenPairs.has(k)) return true; seenPairs.add(k); return false; };

  // Mirror the staging world's Environment so compileAsync produces the correct
  // PBR shader variant (with envMap sampling). Without this, the first real
  // render recompiles shaders and stutters.
  //
  // GATED ON THE TIER, for the same reason the mirror exists at all (#154): a tier with `ibl`
  // false renders with `scene.environment` null, so mirroring the env here would compile the
  // envMap variant that the real render never uses — and the first frame would then compile the
  // NON-env variant synchronously, which is precisely the cold-compile stutter this mirror is
  // here to prevent (measured at 3926 ms on the Y6, P4a). The prewarm must model the scene the
  // tier will actually draw, not the scene as authored.
  if (tierAllowsIBL(getActiveTierOverrides())) {
    world.query(Environment).readEach(([env]: [{ hdrPath: string; intensity: number }]) => {
      if (!env.hdrPath) return;
      const cached = getCachedEnvironment(env.hdrPath);
      if (cached) {
        prewarmScene.environment = cached;
        prewarmScene.environmentIntensity = env.intensity;
      }
    });
  }

  // Mirror the world's FOG, for exactly the reason the environment above is mirrored (#238).
  // three's `NodeManager.getCacheKey()` names the three scene-global inputs to a render object's
  // pipeline key — `lightsNode`, `environmentNode`, `fogNode` — and this prewarm covered two of
  // them. A fogged scene therefore compiled every lit material WITHOUT fog and the first real
  // frame rebuilt the lot, which is the same stall shadows were causing.
  //
  // Driven through the REAL `syncFog` rather than re-deriving the node here: it owns a
  // height-fog TSL graph and a per-scene uniform group, and a hand-rolled second copy would be
  // one refactor away from compiling a fog variant the render does not use — the failure this
  // whole function exists to prevent. `heightFogStates` is keyed by scene in a WeakMap, so the
  // throwaway scene's entry dies with it.
  syncFog(world, prewarmScene);

  // Which lights will actually RENDER a shadow map once this world is live (#238). Computed
  // through the pure rule rather than `armShadowCastersFor`, deliberately: that helper writes the
  // module-global per-frame answer that `syncLights` reads, and the prewarm runs against the
  // STAGING world while the OLD one is still rendering frames — arming it here would decide the
  // outgoing scene's shadows from the incoming scene's lights for the length of the load.
  const prewarmCasters: ShadowCaster[] = [];
  const maxShadowCasters = getActiveTierOverrides().maxShadowCasters;
  if (maxShadowCasters > 0) {
    world.query(Light).forEach((entity) => {
      if (deactivatedEntities.has(entity.id())) return;
      const l = entity.get(Light);
      if (!l || !l.castShadow) return;
      const type = casterTypeOf(l.lightType);
      if (type === null) return;
      prewarmCasters.push({ id: entity.id(), type, intensity: l.intensity, color: l.color });
    });
  }
  const keptCasters = keptShadowCasters(prewarmCasters, maxShadowCasters);
  const prewarmCasterAllowed = (id: number) => keptCasters === null || keptCasters.has(id);

  // Mirror the staging world's lights so compileAsync produces the correct
  // shader variants (otherwise Three.js's LightsNode warns + skips compile).
  //
  // ⚠️ `castShadow` is mirrored with the SAME tier gate the real render applies (#238). A
  // shadow-casting light puts a `ShadowNode` in every lit material's node graph, so a prewarm
  // scene with no caster compiles a DIFFERENT pipeline from the one the first real frame needs —
  // and the first frame then builds the real set synchronously, which is the stall. Measured on
  // the A23: 8 of forest-camp's pipelines were built twice, the second time at ~150 ms each.
  // Same reasoning as the environment mirror above: model the scene the tier will actually draw.
  world.query(Light).updateEach(([light]: [{ lightType: string; color: number; intensity: number; distance: number; angle: number; penumbra: number; castShadow: boolean }], entity) => {
    if (deactivatedEntities.has(entity.id())) return;
    const l = createLightFromTrait(light);
    if (l) {
      l.castShadow = light.castShadow && prewarmCasterAllowed(entity.id());
      prewarmScene.add(l);
      prewarmLights.push(l);
    }
  });

  if (walkPlaceholders) world.query(Renderable3D).updateEach(([rend]: [{ isVisible: boolean; mesh: string; material: string; castShadow: 'auto' | 'on' | 'off'; receiveShadow: boolean }], entity) => {
    if (!rend.isVisible || !rend.mesh) return;
    // Shadow flags join the dedupe key (#238): they are part of the pipeline key, not a uniform,
    // so two entities sharing a (mesh, material) pair but differing in what they cast or receive
    // need BOTH variants compiled. Keying without them compiles whichever the first entity had
    // and leaves the other for the first real frame — the stall this prewarm exists to prevent.
    // The mirror flag joins the dedupe key for the same reason the shadow flags do: it is
    // pipeline key, not a uniform, so a mesh+material drawn both ways needs both variants.
    const mirrored = isMirrored(entity.id());
    if (skip(`g|${rend.mesh}|${rend.material}|${shadowFlagsKey(rend.castShadow, rend.receiveShadow)}|${mirrored ? 'm' : ''}`)) return;
    const template = resolveMeshTemplate(rend.mesh);
    if (!template) { unresolvedMesh++; return; }
    const authored = resolveMaterialForMesh(rend.material, rend.mesh);
    // An empty `material` is a legitimate "use the mesh's baked material" — only a ref that was
    // AUTHORED and did not resolve is a miss.
    if (rend.material && !authored) unresolvedMaterial++;
    const material = authored || template.material;
    count += place(template.geometry, material, mirrored, (o) => applyShadowFlags(o, rend.castShadow, rend.receiveShadow));
  });

  if (walkPlaceholders) world.query(Renderable3DPrimitive).updateEach(([rend]: [{ isVisible: boolean; mesh: string; size: number; color: number; material: string; castShadow: 'auto' | 'on' | 'off'; receiveShadow: boolean }], entity) => {
    if (!rend.isVisible) return;
    const mirrored = isMirrored(entity.id());
    if (skip(`p|${rend.mesh}|${rend.material}|${shadowFlagsKey(rend.castShadow, rend.receiveShadow)}|${mirrored ? 'm' : ''}`)) return;
    const obj = createPrimitiveMesh(rend.mesh, rend.size, rend.color);
    if (obj) {
      const mesh = obj as THREE.Mesh;
      // Apply .mat.json override if set (mirrors runtime sync behaviour)
      const mintedMaterial = mesh.material as THREE.Material;
      if (rend.material) {
        const resolved = resolveMaterial(rend.material);
        if (resolved) mesh.material = resolved;
        else unresolvedMaterial++;
      }
      // Whatever `createPrimitiveMesh` minted is ours to free — but at the NEXT prewarm, not here
      // (see `_prewarmRetained`). The geometry always; the material only while it is still the
      // minted one, since a RESOLVED `.mat.json` override replaced it with a SHARED material the
      // mesh cache owns. Keyed off whether the swap actually happened, NOT off whether a ref was
      // authored: an authored ref that fails to resolve leaves the minted material in place, and
      // testing `rend.material` there leaks it once per scene swap on exactly the failure path the
      // unresolved tally exists to report.
      _prewarmRetained.push(mesh.geometry);
      const minted = mesh.material as THREE.Material;
      // `place` re-homes the pair onto its own mesh (and may pin sides), so this object is only a
      // carrier for what `createPrimitiveMesh` resolved.
      count += place(mesh.geometry, minted, mirrored, (o) => applyShadowFlags(o, rend.castShadow, rend.receiveShadow));
      if (minted === mintedMaterial) _prewarmRetained.push(minted);
    }
  });

  // Skinned (rigged) meshes (#238). A `THREE.SkinnedMesh` puts a skinning node into the vertex
  // graph, so its pipeline is genuinely DIFFERENT from the plain `THREE.Mesh` this function builds
  // for the same material — and until now the prewarm placed zero of them, leaving every rigged
  // character's material for the first real frame to build synchronously. Third instance of the
  // one defect the shadow and fog mirrors were: the prewarm must model the scene the tier will
  // actually draw, and a rig it never places is a scene it never modelled.
  //
  // Built through the REAL helpers — `cloneSkeleton` + `buildNodes` + `syncNodeMaterials`, the same
  // three `syncSkinnedModels`/`syncSkinnedMeshRenderers` use — rather than a hand-rolled stand-in.
  // The override pass matters as much as the clone: a `SkinnedMeshRenderer` rebinds the node's
  // material by slot, so mirroring the rig WITHOUT its overrides would compile the baked GLB
  // material the render is about to replace, and buy a variant nobody draws.
  //
  // The prototype is in cache by now, and that is a property of the LOAD ORDER, not luck:
  // `SkinnedModel.model` is a `riggedModel` ref in `SCALAR_RESOURCE_TYPE_BY_FIELD`, SceneManager's
  // prefab walk collects it transitively (forest-camp's Ranger arrives via a prefab, and its scene
  // file authors no `riggedModel` entry at all), and `acquireResource` awaits it before the swap
  // hook that calls this. If that ever stops being true this pass goes quiet rather than wrong —
  // an uncached rig is skipped, exactly as `syncSkinnedModels` skips it.
  const prewarmRigRoots: THREE.Object3D[] = [];
  /** Rigs placed. Counted separately from `count` on purpose — see the F4 note below. */
  let rigCount = 0;
  const overridesByParent = new Map<number, { node: string; materials: Record<string, string> | undefined; visible: boolean }[]>();
  if (walkPlaceholders) world.query(SkinnedMeshRenderer).updateEach(([r]: [{ node: string; materials: Record<string, string>; visible: boolean }], entity) => {
    const parentId = entity.has(EntityAttributes) ? entity.get(EntityAttributes)!.parentId : 0;
    if (!parentId) return;
    const list = overridesByParent.get(parentId) ?? [];
    list.push({ node: r.node, materials: r.materials, visible: r.visible });
    overridesByParent.set(parentId, list);
  });

  if (walkPlaceholders) world.query(SkinnedModel).updateEach(([sm]: [{ isVisible: boolean; model: string; castShadow: 'auto' | 'on' | 'off'; receiveShadow: boolean }], entity) => {
    if (!sm.isVisible || !sm.model || deactivatedEntities.has(entity.id())) return;
    // Overrides join the dedupe key alongside the shadow flags, for the same reason they do on
    // Renderable3D: two entities sharing a rig but rebinding different materials need both
    // variants. Sorted so two identical override sets in a different authoring order collapse.
    const ov = overridesByParent.get(entity.id()) ?? [];
    const ovKey = ov
      .map((o) => `${o.node}:${o.visible ? 1 : 0}:${Object.entries(o.materials ?? {}).sort().map(([k, v]) => `${k}=${v}`).join(',')}`)
      .sort().join('|');
    if (skip(`k|${sm.model}|${ovKey}|${shadowFlagsKey(sm.castShadow, sm.receiveShadow)}|${isMirrored(entity.id()) ? 'm' : ''}`)) return;
    const rigged = getRiggedModel(sm.model);
    if (!rigged) { unresolvedRig++; return; } // not cached — the real frame will build it
    const root = cloneSkeleton(rigged.prototype);
    // Same mirror rule as the two loops above — a rigged character mirrored by a negative parent
    // scale needs the CW pipeline variant, and `isMesh` is true for a SkinnedMesh.
    if (isMirrored(entity.id())) root.scale.x = -1;
    root.traverse((o) => { if ((o as THREE.Mesh).isMesh) prepPrewarmMesh(o as THREE.Mesh); });
    // Overrides BEFORE the shadow flags, matching the primitive path above and for the same
    // reason: `castShadow: 'auto'` derives from `material.transparent`, so applying the flags
    // first would read the baked material rather than the one the render will draw.
    const nodes = buildNodes(root);
    for (const o of ov) {
      const node = nodes.get(o.node);
      if (node) syncNodeMaterials(node, o.materials, o.visible);
    }
    applyShadowFlags(root, sm.castShadow, sm.receiveShadow);
    // ⚠️ A rig does NOT go through `place()`, so the side-pinning above does not reach it: a rigged
    // model wearing a transparent DOUBLE-SIDED material still compiles the un-pinned variant and
    // leaves both real ones to the first frame (#238). Unmeasured — no project in the fleet
    // authors one — and listed with the prewarm's other known gaps in docs/plans/profiler.md
    // rather than fixed blind, since the whole point of this pass is to compile what the render
    // will actually draw and nothing has yet shown that it would.
    prewarmScene.add(root);
    prewarmRigRoots.push(root);
    // Deliberately NOT `count++`: `count` gates the F4 placeholder below, whose guarantee is that
    // a PLAIN standard material is the renderer's first compile. A rig's material is a
    // `MeshStandardMaterial` but its program is the SKINNED variant, and F4 exists because of a
    // lazy init in three's node builder that a normal compile has to prime — "close enough to
    // normal" is not a property this can be reasoned into. A skinned-only scene therefore still
    // gets the throwaway plain mesh, exactly as it did before rigs were mirrored at all; the cost
    // is one trivial compile on a scene that now has real work to do anyway.
    rigCount++;
  });

  // F4: even when the staging world has no PLAIN renderable — a particle-only, UI-only, or
  // skinned-only NPR scene (a mirrored rig does not count here, and the note on `rigCount` above
  // says why) — we must still make a NORMAL material the
  // renderer's first compile. Otherwise the NPR MRT pass becomes the first compile
  // and re-triggers the WGSL `unresolved type 'OutputType'` bug this prewarm exists
  // to prevent. Add a throwaway 1-tri standard mesh so a plain material is always
  // compiled first. Cost is one trivial compile per scene swap; harmless if NPR is off.
  //
  // ⚠️ **Also forced whenever a post-FX stack is coming** (#324b). `willUseStack` skipped every
  // walk above, so `count` is 0 by construction there and this branch would fire anyway — the
  // condition names the second reason explicitly rather than leaning on that coincidence, because
  // the coincidence is exactly the kind a later refactor breaks silently. Under a stack this
  // placeholder is the ONLY thing the pre-swap half compiles, and that is the point: it costs one
  // trivial plain-material compile and it is what keeps the renderer's first compile a NORMAL
  // material rather than the stack's MRT/NPR pass.
  //
  // It keeps the scene-global mirrors (lights, environment, fog) set up above, deliberately rather
  // than by omission: those mirrors are what make this build exercise the LIT graph. Measured
  // 2026-08-26 on `games/3d-test` — a bare, environment-free warm build costs ~1 ms and primes
  // NOTHING (the next real lit build still cost 25.6 ms), whereas the first lit+env build costs
  // ~24 ms and every later lit build then costs ~5 ms. So under a stack this placeholder is also
  // what absorbs that one-time premium on behalf of `compileLiveScene`.
  let placeholderMesh: THREE.Mesh | undefined;
  if (count === 0 || willUseStack) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
    geo.computeVertexNormals();
    placeholderMesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.5, metalness: 0 }));
    prepPrewarmMesh(placeholderMesh);
    prewarmScene.add(placeholderMesh);
  }

  // compileAsync is available on both WebGLRenderer (r152+) and WebGPURenderer.
  const compile = (renderer as THREE.WebGLRenderer).compileAsync;
  // try/finally: `compileAsync` can reject (a bad shader graph, a lost device), and a leaked span
  // is worse than a missing one — `bootSpansOverlapping` reads an open span as still running, so it
  // would rank first in a later stall attribution. Same reasoning as SceneManager's spans.
  const unresolved = unresolvedMesh + unresolvedMaterial + unresolvedRig;
  const unresolvedDetail = unresolved
    ? `, UNRESOLVED ${unresolvedMesh} mesh / ${unresolvedMaterial} material / ${unresolvedRig} rig`
    : '';
  // Loud, because the failure it reports is otherwise invisible: the prewarm still "succeeds",
  // still compiles something, and the cost lands seconds later as a first-frame stall in a
  // completely different part of the trace. Not dev-gated — this is a production boot cost, and
  // a release build is exactly where nobody is watching a console for it.
  if (unresolved) {
    console.warn(
      `[prewarm] ${unresolved} DISTINCT asset ref(s) did not resolve at prewarm time ` +
      `(${unresolvedMesh} mesh, ${unresolvedMaterial} material, ${unresolvedRig} rig) — ` +
      'those compile their real pipelines on the first frame instead. See #238.',
    );
  }
  // ⚠️ Before compiling, not for tidiness: three reads `object.matrixWorld.determinant()` when it
  // builds the pipeline key (the mirrored-entity variant above), and `compileAsync` never updates
  // world matrices itself — an un-updated placeholder reports the identity determinant and every
  // mirror placed above would compile the variant it was placed to avoid.
  prewarmScene.updateMatrixWorld(true);
  // "placeholders", not "pairs": a transparent double-sided material contributes TWO (the
  // side-pinned clones), so the two numbers stopped being the same thing (#238).
  const compileSpan = beginBootSpan('shader-compile', `${count} placeholders${rigCount ? ` + ${rigCount} rigs` : ''}${unresolvedDetail}`);
  try {
    if (typeof compile === 'function') {
      await (renderer as THREE.WebGLRenderer).compileAsync(prewarmScene, camera);
    } else {
      // Fallback: synchronous compile (still better than first-frame-stutter)
      (renderer as THREE.WebGLRenderer).compile?.(prewarmScene, camera);
    }
  } finally { endBootSpan(compileSpan); }

  // Release prewarm-owned objects but leave GLB template geometries/materials (and the shared
  // envCache-owned environment) alone. Anything whose disposal would RELEASE A WARMED PIPELINE —
  // primitive geometries/materials, the side-pinned clones, the F4 placeholder — went into
  // `_prewarmRetained` and is freed at the start of the next prewarm instead; see its header.
  for (const l of prewarmLights) l.dispose();
  // Rig clones share the prototype's geometry + materials (SkeletonUtils.clone does not copy
  // them), so dispose ONLY what the clone minted: its Skeleton. Same split `disposeSkinnedEntry`
  // makes — disposing the shared halves here would tear the prototype out from under every
  // other scene holding it, which is precisely what the scene-scoped refcount exists to prevent.
  for (const root of prewarmRigRoots) {
    root.traverse((o) => {
      const sm = o as THREE.SkinnedMesh;
      if (sm.isSkinnedMesh) sm.skeleton?.dispose();
    });
  }
  if (placeholderMesh) {
    _prewarmRetained.push(placeholderMesh.geometry, placeholderMesh.material as THREE.Material);
  }
  prewarmScene.environment = null; // detach shared env before clear
  prewarmScene.clear();
}

/** Compile the pipelines the LIVE scene needs, before the first frame draws it (#238).
 *
 *  The companion to `prewarmShadersForWorld`, and the half that cannot drift. The prewarm builds a
 *  COPY of the incoming scene before the swap, and six separate times that copy has differed from
 *  what the renderer then drew — shadows, fog, rigs, mirrored transforms, side-pinned transparency,
 *  and light-mask variants. This runs AFTER the swap, on the objects the sync just placed, so
 *  there is no copy to be wrong: the materials are the ones the render will bind, including the
 *  per-(material, light-selection) variant clones that `applyLightMask` mints.
 *
 *  ⚠️ **A pre-swap prewarm cannot cover those variants, and this is a fact about the mechanism
 *  rather than an effort question.** A variant is keyed by the `THREE.Light` INSTANCES it selects
 *  (`lightMaskVariants.lightId`, a per-object counter, deliberately — two render surfaces build
 *  their own lights for the same ECS entities), and the whole variant cache is disposed on world
 *  swap. So a variant minted before the swap is both keyed wrongly and thrown away by the swap.
 *  Measured on `demos/postfx-demo`, comparing material `uuid`s inside ONE process: the prewarm
 *  compiled 13 materials, the render drew 21, and the overlap was zero.
 *
 *  Self-limiting by construction: everything the prewarm got right is already in three's pipeline
 *  cache, so this walks the scene and finds hits. It costs what the prewarm MISSED, which is the
 *  property that makes it safe to run on every swap.
 *
 *  `compile` overrides the compile call for a post-FX stack, whose scene pass owns a different
 *  render context (see `PostFXStack.compileSceneAsync`). */
/** Stand-ins and clone materials from the LAST live compile, freed at the start of the next one.
 *
 *  ⚠️ Deliberately NOT `_prewarmRetained`, which is what this used first. That list is emptied at
 *  the top of every PREWARM — which runs in the before-swap hook, i.e. potentially while a live
 *  compile from the previous swap is still in flight. It would then dispose that compile's clone
 *  materials out from under it, defeating the warm silently, while the stand-in meshes were still
 *  parented in the shared live `THREE.Scene` (`Scene3D` reuses one across every swap, and
 *  `disposeRenderState` removes only what it tracks in `ecsObjects` — never an untracked child).
 *  The visible half of that was worse than the wasted warm: a transparent object from the OLD
 *  scene left standing inside the NEW one until the abandoned compile finally settled.
 *
 *  Freeing them here instead ties the lifetime to the thing that owns it. A second swap still
 *  abandons the first compile — but now the abandonment is what CLEANS UP, rather than something
 *  unrelated disposing its materials behind its back. */
const _liveStandIns: THREE.Mesh[] = [];
const _liveRetained: Array<{ dispose(): void }> = [];

function clearPreviousLiveStandIns(): void {
  // Removal first and unconditionally: a straggler still parented is a duplicate draw, and it
  // costs nothing to detach one that its own `finally` already removed.
  for (const s of _liveStandIns) s.parent?.remove(s);
  _liveStandIns.length = 0;
  // Disposal is the half that must wait a generation — see `_prewarmRetained`: freeing a clone
  // releases the pipeline it was minted to warm, so it has to outlive the first real frame.
  for (const m of _liveRetained) m.dispose();
  _liveRetained.length = 0;
}

export async function compileLiveScene(
  renderer: WebGPURenderer | THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  compile?: () => Promise<void>,
): Promise<void> {
  return bootSpanAsync('live-scene-compile', async () => {
    // Whatever the previous compile left behind, before adding more.
    clearPreviousLiveStandIns();
    // three reads `matrixWorld` for the pipeline key (the mirrored-entity variant) and for
    // culling, and `compileAsync` updates neither.
    scene.updateMatrixWorld(true);
    const unculled: THREE.Object3D[] = [];
    const revealed: THREE.Object3D[] = [];
    const lods: THREE.LOD[] = [];
    const hidden: THREE.Object3D[] = [];
    const standIns: THREE.Mesh[] = [];
    try {
      scene.traverse((o) => {
      const lod = o as THREE.LOD;
      if (lod.isLOD) {
        // `_projectObject` calls `LOD.update(camera)` while building the compile render list,
        // which re-hides every level but the one at the current distance — undoing the reveal
        // below. Pinning autoUpdate off for the compile is what makes the reveal stick.
        if (lod.autoUpdate) { lod.autoUpdate = false; lods.push(lod); }
        for (const level of lod.levels) if (!level.object.visible) { level.object.visible = true; revealed.push(level.object); }
      }
      const mesh = o as THREE.Mesh;
      // ⚠️ A material three draws SIDE-PINNED is hidden from this compile and STOOD IN FOR by one
      // pinned clone per pass — the same trick the pre-swap prewarm uses.
      //
      // Compiling the mesh itself is worse than not compiling it, which is the opposite of what it
      // looks like. `compileAsync` walks three's own two-pass branch but its queue is drained
      // after `material.side` is restored (see `sidePinnedVariants`), so it compiles the
      // DoubleSide program — and the first frame's pinned draw then builds fresh pipelines over
      // THAT program instead of finding the pinned ones. Measured on `games/3d-test`: including
      // these meshes in the live compile put six synchronous first-frame builds BACK that the
      // prewarm's pinned clones had already removed; hiding them returned it to zero.
      //
      // Hiding ALONE, which is what this did until 2026-08-22, leaves them covered by nothing
      // under a post-FX stack: the prewarm's clones compile in the CANVAS context, and the pass
      // draws through its own. Priced from a Dawn trace on an A23 (`demos/postfx-demo`): one such
      // material, compiled twice, was 187 ms + 171 ms = 358 ms — 48% of the 751 ms pipeline burst
      // the last remaining boot gap waits on, and the single most expensive thing in the boot.
      if (mesh.isMesh && !Array.isArray(mesh.material) && mesh.material
          && sidePinnedVariants(mesh.material as THREE.Material).length > 0 && mesh.visible) {
        mesh.visible = false;
        hidden.push(mesh);
        for (const stand of pinnedStandIns(mesh, _liveRetained)) { standIns.push(stand); _liveStandIns.push(stand); }
        return;
      }
      // Same reason as the prewarm's placeholders: `compileAsync` frustum-culls its render list
      // against the frustum the LAST RENDERED FRAME left behind, which here is the OUTGOING
      // scene's camera. Without this, what gets compiled depends on where the previous scene was
      // looking — and on the first swap after boot, on a camera that has never framed anything.
      if (mesh.isMesh && mesh.frustumCulled) { mesh.frustumCulled = false; unculled.push(mesh); }
      });
      // Added AFTER the traverse — mutating a tree mid-`traverse` is undefined behaviour, and
      // these must not be walked by the loop that created them.
      for (const stand of standIns) scene.add(stand);
      // ⚠️ The traverse is INSIDE the try, and that is not tidiness. It mints clones and meshes
      // now, so it can throw where it used to only flip booleans — and a throw that escaped the
      // `finally` would leave every already-hidden mesh invisible FOREVER: the next call's guard
      // only re-hides a mesh that is still `visible`, so nothing ever restores it.
      if (compile) await compile();
      else await (renderer as THREE.WebGLRenderer).compileAsync?.(scene, camera);
    } finally {
      // Restored in a `finally` because a rejected compile must not leave the live scene with
      // culling off (every object drawn every frame) or every LOD level visible (N draws per
      // model) — a failed prewarm would otherwise become a permanent framerate bug.
      for (const o of unculled) o.frustumCulled = true;
      // ⚠️ `hidden` BEFORE `revealed`, and the order is load-bearing: a non-active LOD level whose
      // material is side-pinned lands in BOTH lists. `traverse` visits the LOD first, so the level
      // is already revealed (visible) by the time the side-pinned branch sees it, and it hides it
      // again. Restoring `revealed` last is what puts it back to invisible; the other order left a
      // far LOD level drawing on top of the near one for the rest of the scene's life.
      for (const o of hidden) o.visible = true;
      for (const o of revealed) o.visible = false;
      for (const lod of lods) lod.autoUpdate = true;
      // Removed from the scene, but the clone materials are NOT disposed — disposing one tears
      // down its render object and releases the very pipeline it was minted to warm (see
      // `_prewarmRetained`). They are held until the next prewarm frees them.
      for (const stand of standIns) scene.remove(stand);
    }
  });
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
  r.outputColorSpace = THREE.SRGBColorSpace;
  // The AUTHORED exposure, with no IBL-off compensation on it. The compensation belongs to a
  // surface that syncs an `Environment` and can therefore know whether one was suppressed —
  // this function also serves the asset-preview renderers (ModelPreview, previewScene), which
  // never sync one, so baking it in here would light a material thumbnail 1.25x brighter
  // because a game panel elsewhere happened to be on the low tier.
  r.toneMappingExposure = exposure;
}

/** The exposure half of the IBL-off compensation (#154), split out because it is the one part of
 *  the color config that is NOT fixed at renderer creation.
 *
 *  `applyRendererColorConfig` runs once, when the renderer is made — before any scene has loaded,
 *  so it cannot yet know whether this scene owns an `Environment` to lose. The compensation must
 *  follow the same "was IBL actually suppressed" predicate as the ambient boost (otherwise the
 *  two halves disagree and the tier raises exposure on scenes that never had IBL), so the render
 *  loop calls this after `syncEnvironment` each frame. Change-gated: the assignment is skipped
 *  when the value already matches, so the steady state writes nothing.
 *
 *  **Call it immediately after your OWN `syncEnvironment`, on every surface that has one.**
 *  `isIblSuppressed()` is module state describing what the LAST `syncEnvironment` saw, and the
 *  editor mounts two surfaces that each call it. A surface that sets the flag and never reads it
 *  back keeps whatever exposure it was constructed with — which is how the Scene panel came to
 *  bake in a compensation belonging to the Game panel. */
export function reconcileToneExposure(r: { toneMappingExposure: number }): void {
  const { exposure } = getRenderSettings().three;
  const want = exposure * (iblSuppressed ? tierExposureBoost(getActiveTierOverrides()) : 1);
  if (r.toneMappingExposure !== want) r.toneMappingExposure = want;
}


export interface MakeRendererOptions {
  /** Honour the shipped web build's `rendering.web.sizeMode` when sizing the FIRST
   *  buffer. Opt-in per surface — exactly like `Canvas2DMount`'s prop of the same
   *  name — because `makeWebGPURenderer` is shared with the editor SceneView,
   *  ParticleEditor, ModelPreview and the caps probe, none of which should inherit a
   *  game's `max` clamp. Only `createRenderer` (the game / GameView 3D surface, whose
   *  ResizeObserver applies the same clamp on every later resize) passes it. */
  applyWebSizeMode?: boolean;
}

export async function makeWebGPURenderer(
  container: HTMLDivElement,
  opts: MakeRendererOptions = {},
): Promise<WebGPURenderer> {
  const { getWebGPUSupported } = await import('./gpuDetect');
  const webgpuSupported = await getWebGPUSupported();
  const settings = getRenderSettings();
  await resolveActiveTier(settings.three.qualityTier);
  // Tier-ADJUSTED, not raw: this is where the first drawing buffer is allocated, and Scene3D's
  // ResizeObserver reads the same accessor on every later resize so the two cannot disagree.
  const three = getEffectiveThreeSettings();
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
    const w = container.clientWidth;
    const h = container.clientHeight;
    // The `max` clamp has to land HERE, not after init(): this setPixelRatio+setSize
    // pair is what allocates the first drawing buffer, and a `max`-mode game exists
    // precisely to never allocate the full-resolution one (#56). Scene3D's
    // ResizeObserver re-applies it on every later resize, computing basePR the same
    // way — the two must agree or the first fire would reallocate. Why the clamp
    // rides the RATIO rather than the size: see clampPixelRatio's doc.
    const basePR = basePixelRatio(window.devicePixelRatio, three.pixelRatioCap);
    r.setPixelRatio(opts.applyWebSizeMode ? clampPixelRatio(w, h, basePR, settings.web) : basePR);
    r.setSize(w, h);
    // Global shadow gate. Per-light `castShadow` still applies; this master switch
    // lets a project disable all shadow-map work for perf.
    (r as unknown as { shadowMap: { enabled: boolean } }).shadowMap.enabled = three.shadows;
    applyRendererColorConfig(r);
    return r;
  };
  let r = make(startForceWebGL);
  container.appendChild(r.domElement);
  try {
    // Device/adapter acquisition + backend init — the one boot cost that happens before any
    // asset exists, and therefore the one a scene-shaped hypothesis can never explain (#238).
    await bootSpanAsync('renderer-init', () => r.init(), startForceWebGL ? 'webgl2' : 'webgpu');
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
  // applyWebSizeMode: this is the shipped-game / GameView 3D surface, so its FIRST
  // buffer honours `rendering.web.sizeMode` — the editor's own viewports call
  // makeWebGPURenderer directly and stay unclamped.
  const r = await makeWebGPURenderer(container, { applyWebSizeMode: true });
  // Awaited: registering now imports three's KTX2Loader on demand (#254), and the caps it
  // detects must be in place before anything this renderer draws asks for a KTX2 texture.
  await setActiveRenderer(r); // KTX2Loader format detection (needs an initialized renderer)
  return r;
}
