/** @modoki/runtime — ECS core, traits, loaders, config. Ships in production. */

export { ENGINE_VERSION, SCENE_FORMAT_VERSION } from './version';
export { getCurrentWorld, setCurrentWorld, onWorldSwap } from './ecs/world';
export { hostCanvases, hostCanvasUnder } from './ui/hostCanvas';
export type { World } from 'koota';
export {
  registerTrait, getAllTraits, getTraitByName, getTraitMeta, inferFields,
  setNameTransform, transformName,
  type TraitMeta, type FieldHint, type FieldType,
} from './ecs/traitRegistry';
export {
  type GameConfig, setGameConfig, getGameConfig,
} from './config';
export type { GameDefinition, EditorPanelDef } from './gameDefinition';
export {
  registerAppServices, appServices, clearAppServices,
  type AppServices, type CrashlyticsService, type AdsService, type AttributionService,
} from './appServices';
export {
  PlayerPrefs, InMemoryBackend, LocalStorageBackend, PreferencesBackend, selectDefaultBackend,
  type JsonValue, type PlayerPrefsInitOptions, type PrefsBackend,
} from './storage';
export {
  Transform, Renderable3D, SkinnedModel, SkinnedMeshRenderer, SkeletalAnimator, AnimationLibrary, BoneAttachment, Bone, SkinnedSprite2D, Bone2D, Billboard3D, FlatSprite3D, Zone3D, Zone2D, ZoneOccupant, OnZone3D, OnZone2D, Director, OnSequence, Renderable3DPrimitive, Renderable2D, Text3D, Text2D, TextAnimation, RenderableUI, EntityAttributes, Camera, CameraFrame,
  PrefabInstance, ModelSource, Paused, Persistent, markPersistent, Transient, Time, Input,
  UIElement, UIBinding, UIAction, UIFocusable, UIAnchor, Canvas2D, NPRPostFX, Rotate3D, Tint, MaterialInstance, type MaterialParamOverride, type MaterialParamSource, ParticleEmitter, FlameMesh,
  Animator, SpriteAnimator, defaultSpriteClip, clampAngle,
  RigidBody2D, Collider2D, Physics2D, Joint2D, OnCollision2D, CharacterController2D, CharacterAnimator2D,
  RigidBody3D, Collider3D, Physics3D, OnCollision3D, Joint3D, CharacterController3D,
  AudioSource, AudioListener,
  type MeshAsset, type MaterialAsset, type SpriteClip, type BodyType2D, type ColliderShape2D, type JointType2D,
  type BodyType3D, type ColliderShape3D, type JointType3D,
} from './traits';
// Particle schema + loader. The schema/types are pure (no THREE); the rendering backend
// lives behind `@modoki/engine/runtime/rendering` so the top-level runtime entry stays
// free of the `three/webgpu` import.
export { defaultParticleEffect } from './particles/types';
export type {
  ParticleEffectDef, IParticleBackend, ParticleHandle, EmitterShape, EmitterShapeType,
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
export { applyClipAtTime, resolveTrackTarget, advanceClipTime } from './animation/sampleClip';
export { switchableClipNames, ANIMATOR_CLIP_TRAITS } from './animation/switchableClips';
export {
  getAnimationClip, setAnimationClip, invalidateAnimationClip, clearAnimationClipCache,
} from './loaders/animationClipCache';
// Timeline / sequencer — asset data model, loader cache, playback system + event bus.
export {
  type TimelineDef, type TrackDef, type TrackKind, type TrackBase,
  type AnimationTrackDef, type AnimationClipBlock, type SignalTrackDef, type SignalMarker,
  type AudioTrackDef, type AudioCueBlock, type ActivationTrackDef, type ActivationSpan,
  type ControlTrackDef, type ControlClipBlock,
  defaultTimeline, normalizeTimeline, collectTimelineAudioRefs, collectTimelineControlRefs,
} from './timeline/types';
export {
  getTimeline, setTimeline, invalidateTimeline, clearTimelineCache, loadTimelineNow,
} from './loaders/timelineCache';
export { timelineSystem, resolveTimelineAt, applyTimelineState, previewTimelineAt, previewTimelineStep } from './systems/timelineSystem';
export { requestSkeletalSeek, getSkeletalSeek, clearSkeletalSeeks, hasSkeletalSeeks } from './systems/skeletalSeek';
export { setTimelinePreviewActive, isTimelinePreviewActive } from './systems/timelinePreview';
export { clearControlSpawns } from './systems/controlSpawnRegistry';
export {
  timelineEvents, timelineEventsManager,
  type SequenceStartHandler, type SequenceEndHandler, type SequenceMarkerHandler,
} from './managers/TimelineEvents';
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
} from './ecs/entityUtils';
export { findEntityById, findEntityByGuid, registerEntity, unregisterEntity } from './ecs/world';
export {
  registerModelPostprocessor, getModelPostprocessor, getAllModelPostprocessors, getModelPostprocessorIds,
  type ModelPostprocessor,
} from './loaders/modelPostprocessorRegistry';
export {
  loadModelTemplates, getMeshTemplate, resolveMeshTemplate,
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
  invalidateTexture, getSharedTextureStats, disposeAllSharedTextures,
} from './loaders/textureResolver';
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
export { loadSceneFile, collectResourceRefsFromEntities, instantiatePrefabIntoWorld, spawnPrefabInstance, deriveInstanceMemberGuids, type SceneData, type LoadSceneOptions, type SceneResourceRef, type SceneEntityEntry } from './loaders/loadSceneFile';
export { markOverride, getOverrideMarkSet, clearOverrideMarks, clearAllOverrideMarks } from './loaders/overrideMarks';
export { sceneManager, gameIdFromScenePath, type Scene, type SceneState, type LoadOptions as SceneLoadOptions } from './scene/SceneManager';
export { validateSceneData, REF_FIELDS_BY_TRAIT, type SceneSchema, type ValidationResult } from './scene/sceneValidation';
export { buildSceneSchema } from './scene/sceneSchema';
export { applyOps, type MutateOp, type MutableScene, type MutableEntity, type EntityRef as MutateEntityRef, type ApplyResult } from './scene/sceneMutate';
export { loadFont, loadAllFonts, getLoadedFontFamilies, getLoadedFonts, fontFamilyFromPath, fontPathFromFamily, parseFontFilename, type FontInfo } from './loaders/fontLoader';
export {
  isGuid, isExternalUrl, isInternalAssetPath, newGuid, registerAsset, unregisterAsset, resolveGuidToPath,
  getGuidForPath, getAssetType, getAssetEntry, getAudioLoadType, resolveRef, loadManifestJson, ensureManifestLoaded, serializeManifest,
  clearManifest, getAllAssets, resolveSceneByName,
  type AssetType, type AssetEntry, type AssetManifestEntry, type AssetManifestFile, type BinaryAssetMeta,
  type AudioImportSettings,
} from './loaders/assetManifest';
export { assetUrl, withCacheBust } from './loaders/assetUrl';
export { UIRenderer } from './ui/UIRenderer';
export { registerUIAction, unregisterUIAction, dispatchUIAction, dispatchGameAction, hasUIAction, getUIActionNames, getUIActionParams } from './ui/actionRegistry';
export type { UIActionContext, UIActionHandler, UIActionDef, UIActionPayload, DispatchOptions } from './ui/actionRegistry';
export { registerEngineActions } from './ui/engineActions';
export { applyBindings, VALUE_TOKEN } from './ui/bindings';
export type { UIActionBinding, UIActionEvent, UIActionKind } from './ui/bindings';
export { resolveTemplate } from './ui/bindingResolver';
export { registerReadSource, unregisterReadSource, getReadValue, getReadSourceNames } from './ui/readSourceRegistry';
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
export type { DebugTabDef, DebugCommandDef } from './debug/debugMenuRegistry';

// ── Frame Driver (no heavy deps — safe for all importers) ──
export {
  registerFrameCallback, unregisterFrameCallback,
  startFrameDriver, stopFrameDriver, stepOneFrame,
  setTargetFPS, targetFPS, getCurrentFPS,
  PRIORITY_ECS, PRIORITY_RENDER_3D, PRIORITY_RENDER_2D,
} from './rendering/frameDriver';

// ── Render settings (project-configured renderer knobs) ──
export {
  setRenderSettings, getRenderSettings, resetRenderSettings, resolveToneMapping,
} from './rendering/renderSettings';
export type { RenderSettings, ThreeRenderSettings, PixiRenderSettings, WebRenderSettings } from './rendering/renderSettings';
export { getWorldTransform3D, getWorldMatrix3D, getParentWorldMatrix3D, worldToLocal3D, hasParent } from './ecs/worldTransform';
export type { WorldTransform3D } from './ecs/worldTransform';
export { computeContainerBox, clampBufferSize } from './rendering/webCanvasSizing';
export type { WebSizing, ContainerBox } from './rendering/webCanvasSizing';
export { useGameLoop } from './rendering/useGameLoop';

// ── Offscreen scene capture (render_scene; pure registry, no heavy deps) ──
export {
  registerSceneRenderer, unregisterSceneRenderer, hasSceneRenderer, renderSceneOffscreen,
  type OffscreenRenderOpts, type OffscreenRenderResult, type OffscreenCameraOverride, type SceneRenderer,
} from './rendering/offscreenCapture';
export {
  registerBoundsProvider, collectScreenBounds,
  type ScreenRect, type EntityScreenBounds, type BoundsProvider,
} from './rendering/screenBounds';
export {
  registerHandleProvider, collectHandles, resolveHandle,
  type InteractionHandle, type HandleFilter, type HandleProvider,
} from './rendering/interactionHandles';
export {
  getAssetSchema, defaultAssetData, validateAssetData, normalizeAssetData,
  type AssetSchemaType, type AssetSchema, type FieldMeta, type AssetFieldType,
} from './assets/assetSchemas';

// ── Engine Systems ──
export { timeSystem, resetTimeBaseline } from './systems/timeSystem';
export { getTime, getSimDelta, getVisualDelta, getTimeScale, setTimeScale } from './systems/getTime';
// Input resource accessors — `input`-prefixed on the public surface to avoid
// colliding with the generic short names (`axis`/`held`/`pressed`/`released`).
export {
  getInput,
  axis as inputAxis, held as inputHeld, pressed as inputPressed, released as inputReleased,
  lastInputDevice, setAxis as setInputAxis, setDigital as setInputDigital,
  // Pointer / tap / drag accessors (already unambiguous, no prefix needed).
  pointer as inputPointer, pointerDown, pointerPressed, pointerReleased,
  pointerPos, pointerDrag, getWheelDelta, setPointer as setInputPointer,
} from './traits/Input';
export { rawNow, setManualNow, advanceManual, restoreRealClock, isManualClock } from './systems/clock';
export { stepSimulation, type StepOptions } from './systems/stepSimulation';
export { seedRng, rngNext, rngFloat, rngInt, rngBool, rngPick } from './systems/rng';
export {
  emit, entityRef, journalEvents, drainJournal, clearJournal, setJournalTick, setJournalEnabled,
  resolveRefName, setVerboseCapture, verboseCaptureState, isVerboseType,
  isJournalEnabled,
  type GameEvent, type JournalLevel,
} from './systems/journal';
export { journalState, journalDecision, journalWarn, journalError } from './systems/gameJournal';
export {
  createTestWorld,
  type TestWorld, type TestSystemDef, type CreateTestWorldOptions,
} from './harness/createTestWorld';
export { rotate3DSystem } from './systems/rotate3DSystem';
export { materialInstanceSystem, resetMaterialInstanceClocks } from './systems/materialInstanceSystem';
export { resetMaterialInstanceClones } from './rendering/materialInstanceClones';
export { animationSystem } from './systems/animationSystem';
export { spriteAnimationSystem } from './systems/spriteAnimationSystem';
export { skin2DSystem } from './systems/skin2DSystem';
export {
  getSkin2DBuffer, getSkin2DDeformVersion, clearSkin2DBuffers, type Skin2DBuffer,
} from './systems/skin2DBuffers';
export {
  getDeform2D, getDeform2DVersion, setDeform2D, beginDeform2DFrame, clearDeform2DBuffers,
} from './systems/deform2DBuffers';
export { applyClipDeform } from './systems/deform2DSystem';
export {
  physics2DSystem, raycast2D, shapeCast2D, pointQuery2D, disposePhysics2D, disposeAllPhysics2D,
  applyImpulse2D, applyTorqueImpulse2D, addForce2D, addTorque2D,
  setLinvel2D, setAngvel2D, resetForces2D, wakeBody2D,
} from './systems/physics2DSystem';
export { initRapier2D, isRapierReady } from './systems/rapierLoader';
export {
  physics3DSystem, raycast3D, shapeCast3D, pointQuery3D, disposePhysics3D, disposeAllPhysics3D,
  applyImpulse3D, applyTorqueImpulse3D, addForce3D, addTorque3D,
  setLinvel3D, setAngvel3D, setBodyTranslation3D, resetForces3D, wakeBody3D,
} from './systems/physics3DSystem';
export { initRapier3D, isRapier3DReady } from './systems/rapier3DLoader';
export { getContactState } from './systems/physicsContactIndex';
export { zone2DSystem } from './systems/zone2DSystem';
export { zone3DSystem } from './systems/zone3DSystem';
export { clearZoneState } from './systems/zoneTriggerCore';
export { characterInputSystem } from './systems/characterInputSystem';
export { characterInput3DSystem } from './systems/characterInput3DSystem';
export { characterAnimationSystem } from './systems/characterAnimationSystem';
export { audioSystem, stopWorldAudio, stopEntityAudio, setAudioWorldPositionResolver } from './systems/audioSystem';
export { registerAudioControls, useAudioMixStore } from './audio/audioControls';
// Audio subsystem — service (playback backend), cue bus, context, buffer cache.
export {
  play as audioPlay, stopAll as audioStopAll, resume as audioResume, dispose as audioDispose,
  setBusVolume as setAudioBusVolume, updateListener as updateAudioListener,
  setAudioMuted, isAudioMuted,
  crossfade as crossfadeAudio,
  getAudioLog, clearAudioLog, setAudioRecordMode,
  type BusName, type AudioPlaySpec, type AudioHandle, type AudioLogEntry,
} from './audio/audioService';
export { cueSound, cueClip, drainAudioCues, clearAudioCues, type AudioCue } from './audio/audioCues';
export { parseClipBank, stringifyClipBank, clipRefForKey, type ClipBankEntry } from './audio/clipBank';
export { getAudioContext, hasAudioSupport, disposeAudioContext } from './audio/audioContext';
export {
  acquireAudio, releaseAudioForScene, disposeAllAudioBuffers, getCachedAudioBuffer, resolveAudioUrl,
  getAudioCacheStats, invalidateAudio,
} from './loaders/audioBufferCache';
// Source-agnostic input seam (Part A of the input-and-ui-focus plan).
export { inputSystem } from './systems/inputSystem';
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
export {
  AXES, DIGITAL, applyDeadzone, clampAxes, computeEdges, computePointerEdge, createInputFrame, beginSample,
  makeAxes, makeFlags, makePointer,
  type Axis, type DigitalAction, type InputDevice, type InputFrame, type AxisMap, type FlagMap, type PointerFrame,
} from './input/actions';
export {
  vecEcsToPhys, vecPhysToEcs, angEcsToPhys, angPhysToEcs, lenToPhys, packCollisionGroups,
  parsePointsToPhys,
  type Vec2,
} from './systems/physics2DConvert';
export {
  vecEcsToPhys as vecEcsToPhys3D, vecPhysToEcs as vecPhysToEcs3D,
  lenToPhys as lenToPhys3D, packCollisionGroups as packCollisionGroups3D,
  eulerToQuat, quatToEuler,
  type Vec3, type Quat, type Euler3,
} from './systems/physics3DConvert';
export { colliderOutline2D } from './rendering/colliderOutline2D';
export {
  registerSystem, unregisterSystem, runPipeline, getRegisteredSystems,
  SYSTEM_PRIORITY,
} from './systems/pipeline';
export type { SystemOptions } from './systems/pipeline';
export { registerLateUpdate, unregisterLateUpdate, runLateUpdates, clearLateUpdates, type LateUpdateFn } from './systems/lateUpdate';
export { registerProjection, unregisterProjection, type SubscribableStore } from './systems/projection';
// ── Managers (event-driven counterpart to Systems) ──
export {
  registerManager, registerManagers, unregisterManager, unregisterManagers,
  getRegisteredManagers,
  disposeActiveGameManagers, initGameManagersFor, getActiveGameId,
} from './managers/managerRegistry';
export type { ManagerDef, ManagerContext, ManagerScope } from './managers/managerRegistry';
export { timeManager } from './managers/TimeManager';
export { navigationManager } from './managers/NavigationManager';
export { physics2DEvents, physics2DEventsManager } from './managers/Physics2DEvents';
export type { CollisionPhase, SensorHandler, CollisionHandler } from './managers/Physics2DEvents';
export { physics3DEvents, physics3DEventsManager } from './managers/Physics3DEvents';
export type { CollisionPhase3D, SensorHandler3D, CollisionHandler3D, ContactDetail3D, ContactHandler3D } from './managers/Physics3DEvents';
export { zone2DEvents, zone2DEventsManager } from './managers/Zone2DEvents';
export { zone3DEvents, zone3DEventsManager } from './managers/Zone3DEvents';
export type { ZonePhase, ZoneHandler } from './managers/zoneEventBus';
export {
  setPhysicsLayers, resetPhysicsLayers, getPhysicsLayerNames, getPhysicsLayerMatrix,
  layersCollide, resolveColliderBits,
} from './systems/physicsLayers';
export type { PhysicsLayersConfig } from './systems/physicsLayers';
export {
  type PlayState, getPlayState, setPlayState, onPlayStateChange, isSimRunning,
  type RunMode, getRunMode, setRunMode, isAdvancing, onRunModeChange,
  shouldFireActions, shouldRunSimTier, isPoseOnly, isLiveRender, canEdit, inPreviewSession,
} from './systems/playState';
export { uiTreeProjection, markUIDirty, setEditorDirtyCallback, onEditorDirty } from './ui/uiTreeStore';
// UI focus / navigation (Part B of the input-and-ui-focus plan).
export { uiFocusSystem } from './systems/uiFocusSystem';
export {
  useFocusStore, activeScope, focusedGuid, setFocus, pushScope, popScope,
  requestActivate, resetFocus, consumePendingActivation, pickInDirection,
  type NavDir,
} from './ui/focusManager';
export { addDirtyListener } from './ecs/entityUtils';
// Default game store (ECS→React bridge). Exported so a game imports it via
// `@modoki/engine/runtime` instead of a repo-relative path into the app shell —
// the latter breaks when the game is opened standalone (copied out of the repo).
export { useGameStore, type Screen, type FontStatus, type UIBindableState } from './store/gameStore';
// OTA update client (docs/plans/mobile-ota-updates-plan.md). A game calls
// checkForUpdate() with its own baseUrl/publicKey; verifyReleaseSignature and the
// schema validators are exported for tooling/tests that want them standalone.
export {
  checkForUpdate, verifyReleaseSignature, validateManifest, validateRelease,
  type OtaCheckResult, type OtaNativePlugin, type OtaManifest, type OtaRelease,
  type CheckForUpdateOptions,
} from './ota/otaClient';
