/** @modoki/engine/runtime/rendering — React rendering components (Scene3D, Scene2D, Game).
 *  Separate from main barrel to avoid pulling in PixiJS/Three.js in non-rendering contexts. */

export { default as Scene3D } from './Scene3D';
export { default as Scene2D, startScene2D, stopScene2D, setShowColliders2D, isShowColliders2D } from './Scene2D';
export { default as Game, useCanvas2DInit } from './Game';
export { createRenderer, syncCamera, syncEnvironment, syncFog, syncLights, syncRenderables, setActiveCameraFrame, computeActiveFrameFit, activeFrameId } from './scene3DSync';
export { ease as easeCameraBlend } from './cameraFraming';
export { getWebGPUSupported } from './gpuDetect';
// 3D-shader-authoring fns (moved off the main runtime barrel so a 2D game strips
// three/webgpu+three/tsl). Games building custom 3D NodeMaterial shaders import these.
export { nprFragmentOutput, applyNprFragmentOutput } from './npr/NPRPostProcess';
export {
  getSceneLightUniforms, buildSceneDiffuseNode, updateSceneLightUniforms,
  type SceneLightUniforms,
} from './sceneLightUniforms';
export { Canvas2DMount } from './Canvas2DMount';
export { computeCanvasScale, type CanvasScale } from './canvas2DScaler';
export {
  initPool, destroyPool, allocate, release, getSlot, resize, renderAll, releaseAll,
  getAllocatedEntityIds, getApp, type Canvas2DSlot,
} from './canvas2DPool';
