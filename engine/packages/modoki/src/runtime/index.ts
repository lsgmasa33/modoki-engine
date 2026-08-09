/** @modoki/runtime — ECS core, traits, loaders, config. Ships in production. */

// Side-effect only, imported FIRST — see instanceGuard.ts. Detects two copies of this
// runtime running side by side (OTA Phase 4's classic failure mode).
import './core/instanceGuard';
// Side-effect only — wires every core/providerSlot.ts seam (P7 C8+). See its own header.
import './loaders/registerProviders';

export { ENGINE_VERSION, SCENE_FORMAT_VERSION, ENGINE_API_VERSION } from './core/version';
export { WHITE_HDR_GUID, DEFAULT_FONT_GUID } from './assets/builtinAssets';
export { getCurrentWorld, setCurrentWorld, onWorldSwap } from './core/ecs/world';
export { hostCanvases, hostCanvasUnder } from './ui/hostCanvas';
// `computeCanvasScale` alongside the two point-mappers because a game that draws a FULL-SCREEN
// quad in design space needs the same scale the mappers use internally: with a letterboxing
// scaleMode the design box is smaller than the host element, so "cover the screen" is an extent
// the game can only compute from that scale. Court re-derived it by hand and shipped a constant
// that was 25% short on a wide host — exactly the drift `clientToDesign2D` exists to prevent.
export { clientToDesign2D, designToClient2D, computeCanvasScale } from './rendering/canvas2DScaler';
export type { World } from 'koota';
export {
  registerTrait, getAllTraits, getTraitByName, getTraitMeta, inferFields,
  setNameTransform, transformName,
  type TraitMeta, type FieldHint, type FieldType,
} from './core/ecs/traitRegistry';
export { traitFieldOrDefault } from './core/ecs/traitSchema';
export {
  type GameConfig, setGameConfig, getGameConfig,
} from './core/config';
export type { GameDefinition, EditorPanelDef } from './core/gameDefinition';
export {
  registerAppServices, appServices, clearAppServices,
  type AppServices, type CrashlyticsService, type AdsService, type AttributionService,
} from './core/appServices';
export {
  PlayerPrefs, InMemoryBackend, LocalStorageBackend, PreferencesBackend, selectDefaultBackend,
  type JsonValue, type PlayerPrefsInitOptions, type PrefsBackend,
} from './storage';
export {
  Transform, Renderable3D, SkinnedModel, SkinnedMeshRenderer, SkeletalAnimator, AnimationLibrary, BoneAttachment, Bone, SkinnedSprite2D, Bone2D, Billboard3D, FlatSprite3D, Zone3D, Zone2D, ZoneOccupant, OnZone3D, OnZone2D, Director, OnSequence, Renderable3DPrimitive, Renderable2D, Text3D, Text2D, TextAnimation, RenderableUI, EntityAttributes, Camera, CameraFrame,
  PrefabInstance, ModelSource, Paused, Persistent, markPersistent, Transient, Time, Input,
  UIElement, type UILengthUnit, UIBinding, UIAction, UIFocusable, UIAnchor, Canvas2D, NPRPostFX, BloomPostFX, VignettePostFX, DepthOfFieldPostFX, AmbientOcclusionPostFX, Rotate3D, Tint, MaterialInstance, type MaterialParamOverride, type MaterialParamSource, ParticleEmitter, FlameMesh, BlobShadow,
  Animator, SpriteAnimator, defaultSpriteClip, clampAngle,
  RigidBody2D, Collider2D, Physics2D, Joint2D, OnCollision2D, CharacterController2D, CharacterAnimator2D,
  RigidBody3D, Collider3D, Physics3D, OnCollision3D, Joint3D, CharacterController3D,
  AudioSource, AudioListener, VideoPlayer,
  type MeshAsset, type MaterialAsset, type SpriteClip, type BodyType2D, type ColliderShape2D, type JointType2D,
  type BodyType3D, type ColliderShape3D, type JointType3D,
} from './traits';
// Particle schema + loader. The schema/types are pure (no THREE); the rendering backend
// lives behind `@modoki/engine/runtime/rendering` so the top-level runtime entry stays
// free of the `three/webgpu` import.
export { defaultParticleEffect } from './particles/types';
export type {
  ParticleEffectDef, IParticleBackend, IParticleBackendCore, ParticleHandle, EmitterShape, EmitterShapeType,
  BlendMode, Curve, CurvePoint, Gradient, ColorStop, AlphaStop, RGB, MinMax, RenderConfig, EmissionBurst,
} from './particles/types';
export { getParticleEffect, setParticleEffect, invalidateParticleEffect, clearParticleCache } from './loaders/particleCache';
// Keyframe animation — clip data model, evaluation, runtime playback.
export {
  type AnimationClipDef, type AnimationTrack, type Keyframe, type TrackValueType,
  type DeformTrack, type DeformKey,
  defaultAnimationClip, normalizeAnimationClip, STEPPED, DEFAULT_TANGENT_WEIGHT,
} from './animation/types';
export { evalDeformTrack } from './animation/deformEval';
export {
  evalTrack, evalColorTrack, evalBooleanTrack, evalTrackValue,
  findKeyIndex, applyTangentMode, autoTangents, type TangentMode,
} from './animation/curveEval';
export { applyClipAtTime, advanceClipTime } from './animation/sampleClip';
export { resolveTrackTarget, buildEntityIndex, isEntityActiveInHierarchy, type EntityIndex } from './core/ecs/entityIndex';
export { switchableClipNames, ANIMATOR_CLIP_TRAITS } from './animation/switchableClips';
export {
  getAnimationClip, setAnimationClip, invalidateAnimationClip, clearAnimationClipCache,
} from './loaders/animationClipCache';
// Timeline / sequencer — asset data model, loader cache, playback system + event bus.
export {
  type TimelineDef, type TrackDef, type TrackKind, type TrackBase,
  type AnimationTrackDef, type AnimationClipBlock, type SignalTrackDef, type SignalMarker,
  type AudioTrackDef, type AudioCueBlock, type ActivationTrackDef, type ActivationSpan,
  type ControlTrackDef, type ControlClipBlock, type VideoTrackDef, type VideoClipBlock,
  defaultTimeline, normalizeTimeline, collectTimelineAudioRefs, collectTimelineControlRefs,
  collectTimelineVideoRefs,
} from './timeline/types';
export {
  getTimeline, setTimeline, invalidateTimeline, clearTimelineCache, loadTimelineNow,
} from './loaders/timelineCache';
export { timelineSystem, resolveTimelineAt, applyTimelineState, previewTimelineAt, previewTimelineStep } from './timeline/timelineSystem';
export { requestSkeletalSeek, getSkeletalSeek, clearSkeletalSeeks, hasSkeletalSeeks } from './core/skeletalSeek';
export { setTimelinePreviewActive, isTimelinePreviewActive } from './core/timelinePreview';
export { clearControlSpawns } from './timeline/controlSpawnRegistry';
export {
  timelineEvents, timelineEventsManager,
  type SequenceStartHandler, type SequenceEndHandler, type SequenceMarkerHandler,
} from './timeline/TimelineEvents';
export {
  getAnimSet, resolveAnimSetParams, setAnimSet, invalidateAnimSet, clearAnimSetCache,
  ANIMSET_DEFAULTS,
  type AnimSetDef, type AnimSetClipDef, type ResolvedAnimParams,
} from './loaders/animSetCache';
export {
  getSpriteAnim, resolveSpriteClip, activeSpriteClip, spriteAnimHasClip,
  setSpriteAnim, invalidateSpriteAnim, clearSpriteAnimCache, normalizeSpriteAnim,
  type SpriteAnimDef, type SpriteAnimSource,
} from './loaders/spriteAnimCache';
// 2D sprite skinning — rig asset loader + pure LBS math.
export {
  getRig2D, setRig2D, invalidateRig2D, clearRig2DCache, normalizeRig2D,
  type ParsedRig2D, type Rig2DFile, type Rig2DBone,
} from './loaders/rig2dCache';
export {
  identity2D, compose2D, mul2D, invert2D, apply2D, skinVertex2D, deriveBindMatrices,
  type Mat2D, type BindBone,
} from './skinning/rig2dMath';
// Auto-rig generation (tessellation + auto-weights + compose) — pure, editor/agent driven.
export { generateGridMesh, type GridMesh, type GridOptions } from './skinning/rig2dTessellate';
export { computeAutoWeights, type AutoWeights, type AutoWeightOptions } from './skinning/rig2dAutoWeights';
export { suggestBones, type SuggestBonesOptions } from './skinning/rig2dAutoBones';
export { buildRig2D, autoRig2D, type BuildRig2DOptions, type AutoRig2DOptions } from './skinning/rig2dBuild';
export { paintWeights, boneWeightField, dominantBoneField, type PaintWeightsOptions, type PaintWeightsResult } from './skinning/rig2dWeightPaint';
export {
  findEntity, getEntityTraits, readTraitData, readTraitDataFull, writeTraitField,
  getAllEntities, buildEntityTree, deleteEntity, deleteEntities, deriveLayer,
  onStructureDirty, markStructureDirty, getStructureVersion,
  type EntityInfo,
} from './core/ecs/entityUtils';
export { findEntityById, findEntityByGuid, registerEntity, spawnEntity, unregisterEntity, destroyEntity } from './core/ecs/world';
export {
  registerModelPostprocessor, getModelPostprocessor, getAllModelPostprocessors, getModelPostprocessorIds,
  type ModelPostprocessor,
} from './loaders/modelPostprocessorRegistry';
export {
  loadModelTemplates, getMeshTemplate, resolveMeshTemplate,
  // Exposed so a GAME can merge kit pieces at a chosen LOD level rather than always L0 —
  // sling's field welds its per-cell drip meshes into one object and must weld the level the
  // camera actually shows, or the merge would undo the LOD chain.
  resolveMeshLodInfo,
  registerRuntimeMeshTemplate, unregisterRuntimeMeshTemplate,
  resolveMaterial, resolveMaterialForMesh,
  getTemplatesForModel,
  invalidateModel, invalidateMaterial, disposeAllCachedResources,
  onModelInvalidated,
  // Refcount API for SceneManager
  acquireModel, releaseModel,
  acquireMesh, releaseMesh,
  acquireMaterial, releaseMaterial,
  acquirePrefab, releasePrefab, getCachedPrefab, invalidatePrefab,
  acquireEnvironment, releaseEnvironment, getCachedEnvironment,
  releaseAllForScene, getResourceStats,
  type SceneId,
} from './loaders/meshTemplateCache';
export {
  acquireRiggedModel, releaseRiggedModelsForScene, ensureRiggedModelLoaded,
  getRiggedModel, getClipNames, getBoneNames, disposeAllRiggedModels, type RiggedModel,
} from './loaders/riggedModelCache';
export { loadGLB } from './loaders/loadGLB';
export {
  rendererReady, setActiveRenderer, loadTexture3D, releaseTexture3D, onRendererReady,
  getRendererGateHealth,
  invalidateTexture, getSharedTextureStats, disposeAllSharedTextures,
} from './loaders/textureResolver';
export {
  getGpuFaultState, MAX_REPORTED_GPU_ERRORS, type GpuFaultState,
  // GPU context-loss recovery (#121 P1). `onRendererLost` is how a VIEWPORT subscribes to
  // "your renderer is dead, build a new one" — this is the only route back, because a lost
  // three renderer cannot be revived (its `_isDeviceLost` gate is never cleared).
  onRendererLost, isRecoveryAbandoned, resetRecoveryState,
  MAX_RECOVERY_ATTEMPTS, RECOVERY_WINDOW_MS, type RendererLostInfo,
} from './core/activeRenderer';
// Device capability probe (#121 P0). Safe in this SHARED barrel — it pulls no three/webgpu
// (gpuDetect probes `navigator.gpu` natively and activeRenderer's three imports are type-only),
// so a 2D-only game importing this barrel still tree-shakes the 3D stack out.
export {
  getDeviceCaps, getDeviceCapsSync, resetDeviceCaps,
  type DeviceCaps, type CompressedTextureSupport,
} from './rendering/deviceCaps';
// Frame-time profiler (#121 P2) — the instrument the per-project 30fps work depends on.
// Frame TIME, not fps: fps saturates at the vsync ceiling and reports 3ms and 16ms frames
// identically as 60.
export {
  getFrameProfile, resetFrameProfile, BUDGET_30FPS_MS, PROFILE_WINDOW_FRAMES,
  type FrameProfile, type FrameStat,
} from './core/frameProfiler';
export { readPerfProfile } from './debug/perfSources';
// Profiler markers — the data model the Profiler panel and the MCP surface are both views of.
// `profileScope` is public API: game code can name its own spans and they rank alongside the
// engine's. See docs/plans/profiler.md.
export {
  profileScope, beginProfilerSample, endProfilerSample, setProfilerEnabled, isProfilerEnabled,
  getMarkerTree, getMarkerFaults, getMarkerNodeCount, resetProfilerMarkers,
  MAX_MARKER_DEPTH, MAX_MARKER_NODES,
  type MarkerSample, type MarkerFaults,
} from './core/profilerMarkers';
export {
  getMarkerAggregate, getMarkerRanking, resetMarkerAggregate, MARKER_WINDOW_FRAMES,
  type MarkerAggregate, type MarkerStat,
} from './core/profilerAggregate';
// Frame capture (P6) — record N frames of trees and step through them. Exported as plain JSON
// so a capture taken on a phone can be reasoned about without anyone holding the phone.
export {
  startCapture, stopCapture, isCapturing, getCapture, clearCapture, exportCapture,
  getWorstCapturedFrame, MAX_CAPTURE_FRAMES,
  type CapturedFrame, type CaptureState,
} from './core/profilerCapture';
// Counters (P9) — game-authored numeric series charted alongside the engine's timings.
// setCounter for a LEVEL (persists), countEvent for a RATE (resets each frame).
export {
  setCounter, countEvent, getCounters, resetCounters,
  COUNTER_WINDOW_FRAMES, MAX_COUNTERS,
  type CounterStat, type CounterReport,
} from './core/profilerCounters';
// GPU timing (P7) — the real per-pass GPU ms that `restMs` cannot be. OFF by default and
// runtime-toggleable (three already enables the device feature, so nothing is paid until asked).
// Unavailable reports as `status: 'unsupported'` with the numbers ABSENT, never as zero.
export {
  setGpuTimingEnabled, isGpuTimingEnabled, getGpuProfile, getRestBreakdown, gpuPassScope,
  pollGpuTimings, resetGpuTimings, getNewestGpuFrameId, MAX_GPU_PASS_LABELS,
  type GpuProfile, type GpuPassStat, type GpuTimingStatus, type RestBreakdown,
} from './core/gpuTimings';
// Hit regions (#139) — the shapes a game's hitTest uses, which are authored NOWHERE and so cannot
// be seen in an inspector, a scene view or a screenshot. A game publishes them from the code that
// OWNS the geometry (never a second copy of it) via registerHitRegionProvider.
export {
  registerHitRegionProvider, collectHitRegions, hitRegionProviders,
  isHitRegionOverlayVisible, setHitRegionOverlayVisible, subscribeHitRegionOverlay,
  hitShapeContains, hitShapeDistance, regionsAt, nearestRegionTo,
  type HitRegion, type HitShape, type HitRegionFilter, type HitRegionProvider,
} from './rendering/hitRegions';
// Quality tiers (#121 P3) — two tiers, measurement as ground truth, allowlist as a shortcut.
// The allowlist ships EMPTY and `auto` is NOT the default: see the module header, both are
// deliberate states pending P5 calibration on real hardware, not unfinished work.
export {
  resolveTier, evaluateTierChange, freshTierChangeState, tierShadowMapSize, tierAllowsPostFX,
  TIER_SETTINGS, TIER_ALLOWLIST, DEFAULT_TIER_SETTING,
  type QualityTier, type QualityTierSetting, type TierResolution, type TierSource,
  type TierRenderOverrides, type TierResolveInput, type TierChangeState, type TierDecision,
  iosModelTier, parseAppleModel, IOS_HIGH_TIER_MIN_GENERATION,
} from './rendering/qualityTier';
// The boot ramp probe (#188). The PURE half only — the runner pulls in three and is imported
// dynamically at the one call site that needs it, so a headless or DCE'd build never loads it.
export {
  startRamp, rampNextLoad, recordRampFrame, readRamp, estimateIntervalMs, classifyDevice,
  probeFingerprint, PROBE_THRESHOLDS, PROBE_BUDGET_MS, RAMP_BOUNDS,
  type DeviceClass, type ProbeMeasurement, type ProbeVerdict, type RampKind, type RampReading,
  type RampState, type RampStatus, type RampStep, type ThroughputBound,
} from './rendering/rampProbe';
export { probeVerdictStore, type ProbeVerdictStore, type CachedProbeVerdict } from './core/probeVerdictStore';
export { registerMaterialType, getMaterialBuilder, getRegisteredMaterialTypes, type MaterialBuilder } from './loaders/materialTypes';
export { registerCustomShader, unregisterCustomShader, getCustomShader, getCustomShaderSchema, getRegisteredShaderNames, type CustomShaderBuild } from './loaders/customShaders';
export { mergeParamDefaults, coerceParamValue, fetchShaderManifest, type ShaderParam, type ShaderParamType, type ShaderParamSchema, type ShaderManifest } from './loaders/shaderSchema';
// 3D-shader-authoring fns (nprFragmentOutput, sceneLightUniforms) moved to the 3D
// entry '@modoki/engine/runtime/rendering' — re-exporting them from THIS shared barrel
// pulled three/webgpu + three/tsl into every game's graph, blocking a 2D game from
// stripping Three. Games building custom 3D shaders now import them from the rendering
// entry (a 2D game never statically reaches it). See docs/playable-export.md (2c).
export {
  pickSceneLights, linearFromHex, keyDirFromEuler, MAX_SHADER_POINT_LIGHTS,
  type LightSample, type PickedLights, type PickedPointLight,
} from './rendering/sceneLightPicker';
export { registerRenderSurface, getEntityObjects, getEntityMaterials, clearRenderSurfaces } from './rendering/materialBroker';
import { registerBuiltinMaterialTypes } from './loaders/materialPresets';
// Side-effect: register pbr/unlit/custom presets at engine init.
registerBuiltinMaterialTypes();
export { isPrimitive, createPrimitiveMesh, PRIMITIVE_NAMES } from './loaders/primitives';
export { PRIMITIVE_SPRITE_NAMES } from './loaders/sceneValidation';
export { loadSceneFile, collectResourceRefsFromEntities, instantiatePrefabIntoWorld, spawnPrefabInstance, deriveInstanceMemberGuids, type SceneData, type LoadSceneOptions, type SceneResourceRef, type SceneEntityEntry } from './loaders/loadSceneFile';
export { markOverride, getOverrideMarkSet, clearOverrideMarks, clearAllOverrideMarks } from './loaders/overrideMarks';
export { sceneManager, gameIdFromScenePath, type Scene, type SceneState, type LoadOptions as SceneLoadOptions, type SceneManager, type LoadedSceneEntry } from './scene/SceneManager';
export { validateSceneData, typeMismatch, REF_FIELDS_BY_TRAIT, type SceneSchema, type ValidationResult } from './loaders/sceneValidation';
export { buildSceneSchema } from './scene/sceneSchema';
export { applyOps, type MutateOp, type MutableScene, type MutableEntity, type EntityRef as MutateEntityRef, type ApplyResult } from './scene/sceneMutate';
// Entity-creation spec builders + the anchor-first UI authoring rules. In runtime (not editor)
// since #166 so the DEVICE create-entity op can build the SAME entities the editor does — the
// editor half of the package is stripped from a shipped game build. See
// docs/plans/device-authoring-parity-plan.md.
export { buildEntityCreateSpecs, type CreateEntitySpec, type CreateSpecs, type TraitSpec, type LightKind } from './scene/entityCreateSpecs';
export { buildUiCreateSpecs, type UiPreset, type UiTraitSpec } from './ui/uiAuthoring';
// Hierarchy legality (#166 P7) — the ONE self-parent/cycle rule, shared by the editor's undoable
// reparent and the device's direct parentId write. See runtime/core/ecs/hierarchy.ts.
export { isAncestorOf, reparentRefusal, type ReparentRefusal } from './core/ecs/hierarchy';
/** LOCAL↔WORLD Transform authoring (`set_transform {space}`) — the FILE-path conversion.
 *  The live path uses `worldToLocal3D`/`getWorldTransform3D` from core/ecs/worldTransform. */
export { parentWorldTrs, localToWorldTrs, worldToLocalTrs, mergeTrs, matrixToTrs, persistedTrsKeys, collapsedParentAxes, type TRS } from './scene/transformSpace';
export { loadFont, loadAllFonts, getLoadedFontFamilies, getLoadedFonts, fontFamilyFromPath, fontPathFromFamily, parseFontFilename, type FontInfo } from './loaders/fontLoader';
// Text MEASUREMENT, exported because fitting text into a box is a game-level concern, not just a
// renderer-internal one: a game that generates its own copy (Court's hint narration) has to be
// able to prove the result still fits the panel it draws it in, and a game may only reach the
// engine through this package specifier (see the portability guard). Pure — no GPU, no DOM.
export { layoutText, type LayoutFont, type LayoutOptions, type TextLayout, type TextAlign } from './rendering/text/layoutText';
export {
  isGuid, isExternalUrl, isInternalAssetPath, newGuid, deriveGuid, registerAsset, unregisterAsset, resolveGuidToPath,
  getGuidForPath, getAssetType, getAssetEntry, getAudioLoadType, resolveRef, loadManifestJson, ensureManifestLoaded, serializeManifest,
  clearManifest, getAllAssets, resolveSceneByName,
  type AssetType, type AssetEntry, type AssetManifestEntry, type AssetManifestFile, type BinaryAssetMeta,
  type AudioImportSettings,
} from './loaders/assetManifest';
export { assetUrl, withCacheBust } from './loaders/assetUrl';
export { UIRenderer } from './ui/UIRenderer';
export { registerUIAction, unregisterUIAction, dispatchUIAction, dispatchGameAction, hasUIAction, getUIActionNames, getUIActionParams } from './core/actionRegistry';
export type { UIActionContext, UIActionHandler, UIActionDef, UIActionPayload, DispatchOptions } from './core/actionRegistry';
export { registerEngineActions } from './actions/engineActions';
export { applyBindings, VALUE_TOKEN } from './ui/bindings';
export type { UIActionBinding, UIActionEvent, UIActionKind } from './ui/bindings';
export { resolveTemplate } from './ui/bindingResolver';
export { registerReadSource, unregisterReadSource, getReadValue, getReadSourceNames } from './core/readSourceRegistry';
export { addStoreHook, removeStoreHook, getStoreHooks, subscribeHooksVersion, getHooksVersion } from './ui/storeHooks';
export type { StoreHook } from './ui/storeHooks';
export { setUIValues, setUIValue, clearUIValues } from './ui/uiValues';

// ── Debug menu registry (pure — no React UI pulled in; the UI lives behind the
//    `@modoki/engine/runtime/debug` subpath, lazy-imported by the app shell) ──
export {
  registerDebugTab,
  unregisterDebugTab,
  registerDebugCommand,
  unregisterDebugCommand,
  getDebugTabs,
  getDebugCommands,
  getDebugCommandTabs,
  isDebugMenuEnabled,
  setDebugMenuEnabled,
} from './debug/debugMenuRegistry';
export {
  setDebugHandlesEnabled,
  areDebugHandlesEnabled,
} from './core/debugHandles';
export type { DebugTabDef, DebugCommandDef } from './debug/debugMenuRegistry';

// ── Frame Driver (no heavy deps — safe for all importers) ──
export {
  registerFrameCallback, unregisterFrameCallback,
  startFrameDriver, stopFrameDriver, stepOneFrame,
  setTargetFPS, targetFPS, getCurrentFPS, getFrameLoopHealth,
  PRIORITY_ECS, PRIORITY_RENDER_3D, PRIORITY_RENDER_2D,
} from './rendering/frameDriver';
export type { FrameLoopHealth } from './rendering/frameDriver';

// ── Render settings (project-configured renderer knobs) ──
export {
  setRenderSettings, getRenderSettings, resetRenderSettings, resolveToneMapping,
  setActiveQualityTier, getActiveQualityTier, getEffectiveThreeSettings, getActiveTierOrDefault,
} from './rendering/renderSettings';
export {
  tickTierCalibration, applyPendingTierPromotion, resetTierCalibration,
  getPendingTierPromotion, CALIBRATION_INTERVAL_MS,
} from './rendering/tierCalibration';
export {
  getPlayerQualityTier, setPlayerQualityTier, hasPlayerQualityTier, choosePlayerQualityTier,
} from './rendering/playerQualityTier';
export { playerTierStore, type PlayerTierStore } from './core/playerTierStore';
export type { RenderSettings, ThreeRenderSettings, PixiRenderSettings, WebRenderSettings } from './rendering/renderSettings';
export { getWorldTransform3D, getWorldMatrix3D, getParentWorldMatrix3D, worldToLocal3D, hasParent } from './core/ecs/worldTransform';
export type { WorldTransform3D } from './core/ecs/worldTransform';
// The CACHED half of the world-transform contract (the on-demand half is worldTransform.ts
// above). Lived in `src/three/` until P5; `@modoki/engine/three` still re-exports these for
// back-compat, but this barrel is the canonical import path.
export { transformPropagationSystem, worldTransforms, deactivatedEntities } from './core/ecs/transformPropagationSystem';
export { computeContainerBox, clampBufferSize } from './rendering/webCanvasSizing';
export type { WebSizing, ContainerBox } from './rendering/webCanvasSizing';
export { useGameLoop } from './rendering/useGameLoop';

// ── Offscreen scene capture (render_scene; pure registry, no heavy deps) ──
export {
  registerSceneRenderer, unregisterSceneRenderer, hasSceneRenderer, renderSceneOffscreen,
  normalizeJpegQuality,
  type OffscreenRenderOpts, type OffscreenRenderResult, type OffscreenCameraOverride, type SceneRenderer,
} from './rendering/offscreenCapture';
export {
  registerBoundsProvider, collectScreenBounds, mountedSurfaces,
  type ScreenRect, type EntityScreenBounds, type BoundsProvider, type BoundsSurface,
} from './core/screenBounds';
export {
  registerPickProvider, pickAt, pickableSurfaces, hasPickProvider,
  type PickProvider,
} from './core/screenPick';
export {
  registerHandleProvider, collectHandles, resolveHandle,
  type InteractionHandle, type HandleFilter, type HandleProvider,
} from './rendering/interactionHandles';
export {
  getAssetSchema, defaultAssetData, validateAssetData, normalizeAssetData,
  type AssetSchemaType, type AssetSchema, type FieldMeta, type AssetFieldType,
} from './assets/assetSchemas';

// ── Engine Systems ──
export { timeSystem, resetTimeBaseline } from './core/timeSystem';
export { getTime, getSimDelta, getVisualDelta, getTimeScale, setTimeScale } from './core/getTime';
// Input resource accessors — `input`-prefixed on the public surface to avoid
// colliding with the generic short names (`axis`/`held`/`pressed`/`released`).
export {
  getInput,
  axis as inputAxis, held as inputHeld, pressed as inputPressed, released as inputReleased,
  lastInputDevice, setAxis as setInputAxis, setDigital as setInputDigital,
  // Pointer / tap / drag accessors (already unambiguous, no prefix needed).
  pointer as inputPointer, pointerDown, pointerPressed, pointerReleased,
  pointerPos, pointerDrag, getWheelDelta, setPointer as setInputPointer,
  // Latency compensation — `pointerPredictedPos` is RENDERING-only; hit-tests read `pointerPos`.
  pointerPredictedPos, pointerVelocity, setPointerLeadMs, getPointerLeadMs,
  POINTER_LEAD_MS_DEFAULT, POINTER_LEAD_MS_ANDROID_60HZ,
  setPointerLeadGate, getPointerLeadGate, pointerLeadGateFactor, POINTER_LEAD_GATE_DEFAULTS,
} from './traits/Input';
export {
  setPointerFilterParams, getPointerFilterParams,
} from './input/pointerSource';
export {
  createOneEuroFilter, oneEuroAlpha, POINTER_FILTER_DEFAULTS, type OneEuroParams,
} from './input/oneEuroFilter';
export { rawNow, setManualNow, advanceManual, restoreRealClock, isManualClock } from './core/clock';
export { stepSimulation, type StepOptions } from './core/stepSimulation';
export { seedRng, rngNext, rngFloat, rngInt, rngBool, rngPick } from './core/rng';
export {
  emit, entityRef, journalEvents, drainJournal, clearJournal, setJournalTick, journalTick, setJournalEnabled,
  resolveRefName, setVerboseCapture, verboseCaptureState, isVerboseType,
  isJournalEnabled,
  type GameEvent, type JournalLevel,
} from './core/journal';
export { journalState, journalDecision, journalWarn, journalError } from './core/gameJournal';
export {
  createTestWorld,
  type TestWorld, type TestSystemDef, type CreateTestWorldOptions,
} from './harness/createTestWorld';
export { rotate3DSystem } from './rendering/rotate3DSystem';
export { materialInstanceSystem, resetMaterialInstanceClocks } from './rendering/materialInstanceSystem';
export { resetMaterialInstanceClones } from './rendering/materialInstanceClones';
export { animationSystem } from './animation/animationSystem';
export { spriteAnimationSystem } from './animation/spriteAnimationSystem';
export { skin2DSystem } from './skinning/skin2DSystem';
export {
  getSkin2DBuffer, getSkin2DDeformVersion, clearSkin2DBuffers, type Skin2DBuffer,
} from './skinning/skin2DBuffers';
export {
  getDeform2D, getDeform2DVersion, setDeform2D, beginDeform2DFrame, clearDeform2DBuffers,
} from './animation/deform2DBuffers';
export { applyClipDeform } from './animation/deform2DSystem';
export {
  physics2DSystem, raycast2D, shapeCast2D, pointQuery2D, disposePhysics2D, disposeAllPhysics2D,
  applyImpulse2D, applyTorqueImpulse2D, addForce2D, addTorque2D,
  setLinvel2D, setAngvel2D, resetForces2D, wakeBody2D,
} from './physics/physics2DSystem';
export { initRapier2D, isRapierReady } from './physics/rapierLoader';
export {
  physics3DSystem, raycast3D, shapeCast3D, pointQuery3D, disposePhysics3D, disposeAllPhysics3D,
  applyImpulse3D, applyTorqueImpulse3D, addForce3D, addTorque3D,
  setLinvel3D, setAngvel3D, setBodyTranslation3D, resetForces3D, wakeBody3D,
} from './physics/physics3DSystem';
export { initRapier3D, isRapier3DReady } from './physics/rapier3DLoader';
export { getContactState } from './physics/physicsContactIndex';
export { zone2DSystem } from './zones/zone2DSystem';
export { zone3DSystem } from './zones/zone3DSystem';
export { clearZoneState } from './zones/zoneTriggerCore';
export { characterInputSystem } from './input/characterInputSystem';
export { characterInput3DSystem } from './input/characterInput3DSystem';
export { characterAnimationSystem } from './animation/characterAnimationSystem';
export { audioSystem, stopWorldAudio, stopEntityAudio, setAudioWorldPositionResolver } from './audio/audioSystem';
export { registerAudioControls, useAudioMixStore } from './actions/audioControls';
export { registerVideoControls } from './actions/videoControls';
// Fullscreen cutscene layer. React + DOM only (no THREE), so exporting it here does
// not pull the 3D graph into a 2D game — see the rendering-entry note below.
export { VideoOverlay, type VideoOverlayProps } from './video/VideoOverlay';
export {
  videoEvents, clearVideoEventHandlers, emitVideoSkip, type VideoEventPayload,
} from './video/VideoEvents';
// Audio subsystem — service (playback backend), cue bus, context, buffer cache.
export {
  play as audioPlay, stopAll as audioStopAll, resume as audioResume, dispose as audioDispose,
  setBusVolume as setAudioBusVolume, updateListener as updateAudioListener,
  setAudioMuted, isAudioMuted,
  crossfade as crossfadeAudio,
  getAudioLog, clearAudioLog, setAudioRecordMode,
  type BusName, type AudioPlaySpec, type AudioHandle, type AudioLogEntry,
} from './audio/audioService';
// Video subsystem — playback core (HTMLVideoElement lifetime, timeScale coupling,
// autoplay-block recovery). Its SOUND routes onto the audio bus above.
export {
  playVideo, applyTimeScale as applyVideoTimeScale, disposeAllVideo, liveVideoCount,
  type VideoHandle, type VideoPlaySpec, type VideoTimeMode,
} from './video/videoService';
export {
  videoSystem, stopWorldVideo, setVideoUrlResolver, videoElementFor, seekEntityVideo,
  setVideoSourceResolver, setVideoDownloader, type ResolvedVideoSource,
} from './video/videoSystem';
export { resolveVideoUrl, resolveVideoSource, type VideoSource } from './loaders/videoUrl';
export {
  VideoCache, CacheApiBackend, hasCacheStorage,
  type CacheBackend, type VideoCacheOptions, type DownloadProgress,
} from './video/videoCache';
export {
  planAdmission, explainRefusal, totalBytes as videoCacheTotalBytes,
  type CacheEntry, type AdmissionResult,
} from './video/videoCachePolicy';
export { cueSound, cueClip, drainAudioCues, clearAudioCues, type AudioCue } from './audio/audioCues';
export { parseClipBank, stringifyClipBank, clipRefForKey, type ClipBankEntry } from './audio/clipBank';
export { getAudioContext, hasAudioSupport, disposeAudioContext } from './audio/audioContext';
export {
  acquireAudio, releaseAudioForScene, disposeAllAudioBuffers, getCachedAudioBuffer, resolveAudioUrl,
  getAudioCacheStats, invalidateAudio,
} from './loaders/audioBufferCache';
// Source-agnostic input seam (Part A of the input-and-ui-focus plan).
export { inputSystem } from './input/inputSystem';
export {
  registerSource, unregisterSource, getSources, attachAll as attachInputSources,
  detachAll as detachInputSources, inputSourcesManager, type InputSource,
} from './input/inputSources';
export { keyboardSource } from './input/keyboardSource';
export { gamepadSource, sampleGamepadInto, type GamepadSnapshot } from './input/gamepadSource';
// Presentation-invariant input: keep gameplay feel constant under editor/browser/OS zoom.
export { getPresentationScale, calibratePresentationScale } from './input/presentationScale';
// Device-appropriate UI prompts ("Press A" vs "Click") — Part B4/Phase 4.
export { promptFor, PROMPT_ACTIONS, type PromptAction } from './input/inputPrompts';
export { registerInputPromptSources } from './input/inputPromptSources';
// Pointer-block roots — a DOM overlay (a game's own hand-built chrome, e.g. a modal
// sibling of the game canvas) claims exclusive ownership of pointer gestures that
// start on it, so `pointerSource` never latches them as a game gesture.
export { registerPointerBlocker, registerPointerPassthrough, isPointerBlocked } from './core/pointerBlockers';
// Input WATCH (#134) — a game publishes what its OWN hit-test resolved a press to, which is the
// one thing no engine-side observer can compute for a canvas game. Safe to call unconditionally:
// it is a no-op until an agent opens a watch window.
// The control half is consumed by `engine/app/debug/agentBridge.ts`, which reaches this package
// only through its declared `exports` map — so an agent op cannot register without these.
export {
  noteInputResolution,
  startInputWatch, stopInputWatch, clearInputPresses, readInputPresses, isInputWatchOpen,
  type InputPressRecord, type InputResolution,
} from './input/pointerRecorder';
export {
  AXES, DIGITAL, applyDeadzone, clampAxes, computeEdges, computePointerEdge, createInputFrame, beginSample,
  makeAxes, makeFlags, makePointer,
  type Axis, type DigitalAction, type InputDevice, type InputFrame, type AxisMap, type FlagMap, type PointerFrame,
} from './core/inputActions';
export {
  vecEcsToPhys, vecPhysToEcs, angEcsToPhys, angPhysToEcs, lenToPhys, packCollisionGroups,
  parsePointsToPhys,
  type Vec2,
} from './physics/physics2DConvert';
export {
  vecEcsToPhys as vecEcsToPhys3D, vecPhysToEcs as vecPhysToEcs3D,
  lenToPhys as lenToPhys3D, packCollisionGroups as packCollisionGroups3D,
  eulerToQuat, quatToEuler,
  // eulerToQuatInto/quatToEulerInto: allocation-free `Into` twins of the pair above, for hot loops.
  eulerToQuatInto, quatToEulerInto,
  type Vec3, type Quat, type Euler3,
} from './physics/physics3DConvert';
export { colliderOutline2D } from './rendering/colliderOutline2D';
export {
  registerSystem, unregisterSystem, runPipeline, getRegisteredSystems,
  SYSTEM_PRIORITY,
} from './core/pipeline';
export type { SystemOptions } from './core/pipeline';
export { registerLateUpdate, unregisterLateUpdate, runLateUpdates, clearLateUpdates, type LateUpdateFn } from './core/lateUpdate';
export { registerProjection, unregisterProjection, type SubscribableStore, type ProjectionOptions } from './core/projection';
// ── Managers (event-driven counterpart to Systems) ──
export {
  registerManager, registerManagers, unregisterManager, unregisterManagers,
  getRegisteredManagers,
  disposeActiveGameManagers, initGameManagersFor, getActiveGameId,
} from './managers/managerRegistry';
export type { ManagerDef, ManagerContext, ManagerScope } from './managers/managerRegistry';
export { timeManager, type TimeManager } from './managers/TimeManager';
export { navigationManager, type NavigationManager } from './managers/NavigationManager';
export { physics2DEvents, physics2DEventsManager } from './physics/Physics2DEvents';
export type { CollisionPhase, SensorHandler, CollisionHandler } from './physics/Physics2DEvents';
export { physics3DEvents, physics3DEventsManager } from './physics/Physics3DEvents';
export type { CollisionPhase3D, SensorHandler3D, CollisionHandler3D, ContactDetail3D, ContactHandler3D } from './physics/Physics3DEvents';
export { zone2DEvents, zone2DEventsManager } from './zones/Zone2DEvents';
export { zone3DEvents, zone3DEventsManager } from './zones/Zone3DEvents';
export type { ZonePhase, ZoneHandler } from './zones/zoneEventBus';
export {
  setPhysicsLayers, resetPhysicsLayers, getPhysicsLayerNames, getPhysicsLayerMatrix,
  layersCollide, resolveColliderBits,
} from './physics/physicsLayers';
export type { PhysicsLayersConfig } from './physics/physicsLayers';
export {
  type PlayState, getPlayState, setPlayState, onPlayStateChange, isSimRunning,
  type RunMode, getRunMode, setRunMode, isAdvancing, onRunModeChange,
  shouldFireActions, shouldRunSimTier, isPoseOnly, isLiveRender, canEdit, inPreviewSession,
} from './core/playState';
export { uiTreeProjection, markUIDirty, setEditorDirtyCallback, onEditorDirty } from './ui/uiTreeStore';
// UI focus / navigation (Part B of the input-and-ui-focus plan).
export { uiFocusSystem } from './ui/uiFocusSystem';
export {
  useFocusStore, activeScope, focusedGuid, setFocus, pushScope, popScope,
  requestActivate, resetFocus, consumePendingActivation, pickInDirection,
  type NavDir,
} from './ui/focusManager';
export { addDirtyListener } from './core/ecs/entityUtils';
// Default game store (ECS→React bridge). Exported so a game imports it via
// `@modoki/engine/runtime` instead of a repo-relative path into the app shell —
// the latter breaks when the game is opened standalone (copied out of the repo).
export { useGameStore, type Screen, type FontStatus, type UIBindableState } from './store/gameStore';
// OTA update client (docs/ota-updates.md). A game calls
// checkForUpdate() with its own baseUrl/publicKey; verifyReleaseSignature and the
// schema validators are exported for tooling/tests that want them standalone.
// signingPayload: the canonical payload serializer that must match the signing side
// byte-for-byte, exported for anyone verifying or re-signing a release.
export {
  checkForUpdate, fetchRelease, verifyReleaseSignature, signingPayload, validateManifest, validateRelease,
  type OtaCheckResult, type OtaNativePlugin, type OtaManifest, type OtaRelease,
  type CheckForUpdateOptions, type FetchReleaseOptions, type FetchReleaseResult,
} from './ota/otaClient';
