/** Three.js 3D background layer — consumes GameConfig for scene setup and material fixes */

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import { getGameConfig } from '../config';
import { getCurrentWorld } from '../ecs/world';
import { onWorldSwap } from '../ecs/world';
import { addDirtyListener, onStructureDirty } from '../ecs/entityUtils';
import { onTextDirty } from './text/textDirty';
import { isSimRunning, getPlayState, onPlayStateChange, inPreviewSession } from '../systems/playState';
import { getVisualDelta } from '../systems/getTime';
import { ease } from './cameraFraming';
import { isSkeletalPreviewing } from '../systems/skeletalPreview';
import { sceneManager } from '../scene/SceneManager';
import { registerFrameCallback, unregisterFrameCallback, PRIORITY_RENDER_3D } from './frameDriver';
import { registerSceneRenderer, unregisterSceneRenderer, type SceneRenderer } from './offscreenCapture';
import { registerBoundsProvider, projectAABBToScreen, type EntityScreenBounds } from './screenBounds';
import { readbackToRGBA, type ReadbackBackend } from './readbackToRGBA';
import { createRenderer, createRenderState, disposeRenderState, syncCamera, applyOrthoFrustum, computeActiveFrameFit, computeFrameFitById, activeFrameId, type ActiveFrameFit, syncEnvironment, syncLights, syncSceneRenderables3D, orientBillboards, prewarmShadersForWorld, clearOwnedMaterials, attachInvalidationListener } from './scene3DSync';
import { registerRenderSurface } from './materialBroker';
import { getRenderSettings } from './renderSettings';
import { clampBufferSize } from './webCanvasSizing';
import { createParticleSyncState, syncParticles, disposeParticleSyncState } from './particleSync';
import { createFlameMeshSyncState, syncFlameMeshes, disposeFlameMeshSyncState } from './flameMeshSync';
import { PARTICLE_LAYER } from './layers';
import { NPRPostFX } from '../traits/NPRPostFX';
import { Camera as CameraTrait } from '../traits/Camera';
import { EntityAttributes } from '../traits/EntityAttributes';
import { NPRPostProcess } from './npr/NPRPostProcess';
import { SuperSampleRebuildDebouncer } from './npr/ssRebuildDebounce';
import { nprConfigFromTrait, nprConfigSignature, type NprTraitSnapshot } from './npr/nprConfigFromTrait';

let nextInstanceId = 0;

export default function Scene3D() {
  const containerRef = useRef<HTMLDivElement>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const container = containerRef.current;
    const config = getGameConfig();
    let renderer: WebGPURenderer | THREE.WebGLRenderer;
    let disposed = false;

    createRenderer(container, config.preferWebGPU).then(r => {
      if (disposed) { r.dispose(); r.domElement.remove(); return; }
      renderer = r;
      startRenderLoop();
    }).catch(e => {
      console.error('[Scene3D] Renderer creation failed (no WebGPU or WebGL2):', e);
    });

    function startRenderLoop() {
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(
        30, container.clientWidth / container.clientHeight, 0.1, 500,
      );
      camera.position.set(0, 8, 14);
      camera.lookAt(0, 0, 0);
      // Particles live on PARTICLE_LAYER; render them in the normal (non-NPR) forward
      // pass by enabling that layer on the camera (layer 0 geometry + particles).
      camera.layers.enable(PARTICLE_LAYER);

      // Orthographic sibling. syncCamera drives BOTH from the ECS Camera entity and
      // returns whichever `Camera.projection` selects; `activeCamera` is the one we
      // render/NPR/capture with. Frustum (left/right/top/bottom) is set from the
      // Camera trait's orthoSize + the live aspect in syncCamera and on resize.
      const orthoCamera = new THREE.OrthographicCamera(-8, 8, 4.5, -4.5, 0.1, 500);
      orthoCamera.position.copy(camera.position);
      orthoCamera.layers.enable(PARTICLE_LAYER);
      let activeCamera: THREE.PerspectiveCamera | THREE.OrthographicCamera = camera;

      // CameraFrame fit: the fit is re-APPLIED every frame (syncCamera overwrites
      // the camera pose from the authored Transform each frame, so the framing
      // override must be re-stamped after it), but only RECOMPUTED when it can
      // have changed: first fit, a viewport/scene change (framingDirty: load /
      // world swap / resize), a runtime active-frame SWITCH (frameId changed), or
      // a `continuous` frame (every frame — follows a moving box/camera). A
      // non-continuous frame is otherwise frozen, so it won't chase an animated
      // box — the documented semantic. Polling activeFrameId each frame is cheap
      // (one query, like syncCamera) and is what lets the camera return to the
      // authored pose the instant the frame is deactivated/removed.
      let framingCache: ActiveFrameFit | null = null;
      let framingDirty = true;
      // Blend state for a runtime frame SWITCH (2c). Two representations of the
      // blend ORIGIN, on purpose:
      //  - `blendFrom` (a BAKED pose) drives the LIVE view: it's the actual pose
      //    on screen when the switch fired, so a mid-blend RE-SWITCH continues
      //    smoothly from where the camera currently is, and it survives the origin
      //    frame being deleted/deactivated mid-blend.
      //  - `blendOriginId` (the origin FRAME id) drives the OFFSCREEN CAPTURE,
      //    which must reframe at ITS OWN aspect — it recomputes origin+target fits
      //    for the capture size and lerps. For a normal (non-re-switch) blend at a
      //    matching aspect the two agree; they only diverge if a capture lands
      //    during a re-switch, which is rare and acceptable.
      // blendTime lives on the TARGET frame; advanced by the VISUAL delta (0 when
      // not playing → snap). A first fit / switch from no-frame does NOT blend.
      const blendFrom = { position: new THREE.Vector3(), orthoSize: 0 };
      const lastApplied = { position: new THREE.Vector3(), orthoSize: 0, valid: false };
      const _blendPos = new THREE.Vector3();
      let blendActive = false, blendOriginId = -1, blendT = 0, blendDur = 0, blendEaseName = 'linear';
      /** CAPTURE-side blended pose for `aspect` (aspect-portable via frame id).
       *  `target` = the active frame's fit for this aspect. Does NOT advance blendT. */
      const framedPoseForAspect = (world: import('koota').World, cam: THREE.PerspectiveCamera | THREE.OrthographicCamera, aspect: number, isOrtho: boolean, target: { position: THREE.Vector3; orthoSize: number }) => {
        if (blendActive && blendOriginId >= 0) {
          const origin = computeFrameFitById(world, blendOriginId, cam, aspect, isOrtho);
          if (origin) {
            const e = ease(blendEaseName, blendT);
            return { px: _blendPos.lerpVectors(origin.position, target.position, e), os: origin.orthoSize + (target.orthoSize - origin.orthoSize) * e };
          }
        }
        return { px: target.position, os: target.orthoSize };
      };
      const applyFraming = (world: import('koota').World, cam: THREE.PerspectiveCamera | THREE.OrthographicCamera, aspect: number, isOrtho: boolean) => {
        const id = activeFrameId(world);
        if (id == null) { framingCache = null; blendActive = false; lastApplied.valid = false; return; } // no active frame → authored pose stands
        const prev = framingCache;
        // While STOPPED (editor authoring) re-fit every drawn frame so live edits to
        // the CameraFrame (box transform / mode / margins) AND the current viewport
        // aspect reflect immediately — otherwise a `continuous:false` frame only
        // recomputes on scene-swap/resize, so an edit appears to need a Play/Stop
        // (or two) to "take". During Play we still honor `continuous` (frozen fit,
        // doesn't chase the box). Cost is a query + 8-corner math on drawn frames only
        // (the idle dirty-gate stops draws once the scene settles), so it's cheap.
        const authoringLive = getPlayState() === 'stopped';
        if (framingCache == null || framingCache.frameId !== id || framingDirty || framingCache.continuous || authoringLive) {
          const fresh = computeActiveFrameFit(world, cam, aspect, isOrtho);
          if (fresh && prev && prev.frameId !== fresh.frameId && fresh.blendTime > 0) {
            // Baked origin = the current visible pose (smooth across a re-switch).
            if (lastApplied.valid) { blendFrom.position.copy(lastApplied.position); blendFrom.orthoSize = lastApplied.orthoSize; }
            else { blendFrom.position.copy(prev.position); blendFrom.orthoSize = prev.orthoSize; }
            blendOriginId = prev.frameId; blendActive = true; blendT = 0; blendDur = fresh.blendTime; blendEaseName = fresh.blendEase;
          }
          framingCache = fresh;
          framingDirty = false;
        }
        if (!framingCache) { blendActive = false; return; }
        // Live owns the blend clock: advance by presentation time. When it isn't
        // advancing (paused / stopped / timeScale 0) SNAP (blendT→1) rather than
        // freezing at the old pose — a blend that can't progress reads as stuck.
        if (blendActive) {
          const dt = getVisualDelta(world);
          blendT = blendDur > 0 && dt > 0 ? Math.min(1, blendT + dt / blendDur) : 1;
        }
        // LIVE pose: lerp from the baked origin (smooth re-switch).
        let px: THREE.Vector3 = framingCache.position, os = framingCache.orthoSize;
        if (blendActive) {
          const e = ease(blendEaseName, blendT);
          px = _blendPos.lerpVectors(blendFrom.position, framingCache.position, e);
          os = blendFrom.orthoSize + (framingCache.orthoSize - blendFrom.orthoSize) * e;
        }
        cam.position.copy(px);
        if (isOrtho) applyOrthoFrustum(cam as THREE.OrthographicCamera, os, aspect);
        cam.updateMatrixWorld(true);
        lastApplied.position.copy(px); lastApplied.orthoSize = os; lastApplied.valid = true;
        if (blendActive && blendT >= 1) blendActive = false; // blend finished this frame
      };

      // TODO: config is captured once at mount. If a future game needs a non-trivial
      // sceneSetup (lighting presets, fog, etc.), Scene3D will need to subscribe to
      // gameConfig changes and re-run sceneSetup on game switch. Today both games'
      // sceneSetup hooks are no-ops so this is safe.
      config.sceneSetup(scene);

      const ecsLights = new Map<number, THREE.Light>();
      const renderState = createRenderState(true); // primary surface — journals @anim-* (Percept J3)
      const particleState = createParticleSyncState();
      const flameState = createFlameMeshSyncState();
      const unsubInvalidation = attachInvalidationListener(renderState, scene);
      // Publish this surface so the material broker (MaterialInstance) can reach
      // this world's live materials + object userData. getCurrentWorld follows swaps.
      const unregisterSurface = registerRenderSurface(getCurrentWorld, renderState);

      // NPR post-process — built lazily on first frame where NPRPostFX.enabled
      // is true. Requires WebGPURenderer (gated below). When the trait turns
      // off we keep the composer alive but route through plain renderer.render
      // so toggling stays cheap.
      const isWebGPU = (renderer as { isWebGPURenderer?: boolean }).isWebGPURenderer === true;
      let nprComposer: NPRPostProcess | null = null;
      // The camera identity baked into `nprComposer`. A live projection toggle
      // (perspective <-> orthographic) swaps `activeCamera` to a different object;
      // the composer captured the old one at construction (and needs the ortho
      // depth-reconstruction path), so a change forces a full rebuild.
      let nprCamera: THREE.Camera | null = null;
      // Edge-trigger key for the NPR config (F6): only rebuild `nprConfig` + call
      // `setConfig` (13 uniform writes + a Color.setHex) when the trait's tracked values
      // actually change, instead of every rendered frame while playing.
      let lastNprSig: string | null = null;
      // Coalesces SS-scale-driven NPR pipeline rebuilds (F9): an SS-scale change
      // forces a full dispose()+reconstruct (shader recompile), so dragging the
      // supersample slider — which sweeps values frame-by-frame — would thrash
      // compiles. The debouncer waits for the target scale to settle before
      // committing the rebuild; cheap uniform updates still apply every frame.
      let ssRebuild: SuperSampleRebuildDebouncer | null = null;
      // True while an offscreen render_scene capture owns the renderer's render
      // target — skip the live frame so it can't render into our capture RT.
      let capturing = false;
      // Pooled offscreen-capture resources (P2-3) — reused/resized across captures
      // instead of allocating a fresh GPU RenderTarget + canvas + camera every
      // call (a 120-frame render-sequence otherwise churns 120 of each). Disposed
      // in cleanupRef. Capture calls are serialized (offscreenCapture.ts), so a
      // single shared set is safe.
      let captureRT: THREE.RenderTarget | null = null;
      let captureCanvas: HTMLCanvasElement | null = null;
      let captureCtx: CanvasRenderingContext2D | null = null;
      let captureCam: THREE.PerspectiveCamera | null = null;
      let captureOrthoCam: THREE.OrthographicCamera | null = null;

      if (import.meta.env.DEV) (window as any).__3d = { camera, scene, renderer };

      const frameKey = `render3d-${nextInstanceId++}`;

      // ── Idle render gate (T1) ────────────────────────────────────────────
      // Mirror Scene2D's idle skip: when the sim isn't running (paused/stopped)
      // the 3D scene is genuinely static — skeletal mixers and particles both
      // freeze at dt=0 (they key off getPlayState/timeScale), so nothing moves
      // between dirty events. Skip the full ECS→Three re-sync + GPU submit then;
      // the swapchain holds the last presented frame. Biggest win on a paused
      // game screen and the editor's stopped GameView panel. While the sim runs,
      // raw per-frame transform writes bypass the dirty listeners, so we never
      // gate — every frame may have changed.
      //
      // Frame COUNTDOWN, not a boolean: scene3DSync's async loaders poll
      // "not ready — retry next frame" (mesh templates / streamed textures) with
      // no completion callback, so render a short grace window past each dirty
      // event to let them converge before settling to 0 submits.
      const DIRTY_GRACE = 60; // ~1s @60fps
      let dirtyFrames = DIRTY_GRACE; // draw the first second (initial load + texture settle)
      const markRenderDirty = () => { dirtyFrames = DIRTY_GRACE; };
      const dirtyUnsubs = [
        addDirtyListener(markRenderDirty),  // trait writes through the helper API
        onStructureDirty(markRenderDirty),  // entity create / delete / reparent
        onPlayStateChange(markRenderDirty), // Play ↔ Stop ↔ Pause edges (render the settled state)
        onTextDirty(markRenderDirty),       // dynamic-font glyph gen / async atlas load (not an ECS write)
      ];

      function renderFrame() {
        if (capturing) return;
        // Idle gate: while paused/stopped only dirty events + the grace window
        // need a redraw; while playing — or while the Animation editor is previewing
        // skeletal animation (mixer advancing) — render unconditionally.
        if (!isSimRunning() && !isSkeletalPreviewing() && dirtyFrames <= 0) return;
        if (dirtyFrames > 0) dirtyFrames--;
        const world = getCurrentWorld();
        activeCamera = syncCamera(world, scene, camera, orthoCamera);
        applyFraming(world, activeCamera, camera.aspect, activeCamera === orthoCamera);
        syncEnvironment(world, scene);
        syncLights(world, scene, ecsLights);
        syncSceneRenderables3D(world, scene, renderState);
        orientBillboards(renderState, activeCamera); // face billboards toward the live camera
        // Inside the editor PREVIEW envelope the SceneView owns particle preview (it supplies its
        // own wall-clock delta + drains the timeline's one-shot restart/pause requests). If this
        // runtime renderer ALSO drained them it would consume the request first and, with the sim
        // clock frozen (getVisualDelta 0 in preview), show a stuck-at-frame-0 burst. So skip here
        // during scrub/preview; real Play (isSimRunning) is unaffected. (preview-mode-refactor Phase 5.)
        if (!inPreviewSession()) syncParticles(world, scene, particleState);
        syncFlameMeshes(world, scene, flameState);

        // Read NPR singleton — first entity with NPRPostFX, if any. The trait→config
        // mapping + signature are the pure `nprConfigFromTrait`/`nprConfigSignature`
        // (npr/nprConfigFromTrait.ts) so the loop and its unit tests share one code path.
        let nprEnabled = false;
        // Holder (not a bare `let`): TS control-flow would narrow a closure-assigned
        // `let` back to its `null` initializer; a property on an object isn't narrowed
        // that way, so the truthiness check below correctly yields the snapshot.
        const nprHold: { snap: NprTraitSnapshot | null } = { snap: null };
        world.query(NPRPostFX).updateEach(([fx]: [NprTraitSnapshot & { enabled: boolean }]) => {
          if (nprEnabled) return; // singleton — first wins
          nprEnabled = fx.enabled;
          // Copy out of the trait (updateEach reuses the row) into a plain snapshot.
          nprHold.snap = {
            fillMode: fx.fillMode,
            depthThreshold: fx.depthThreshold,
            normalThreshold: fx.normalThreshold,
            colorThreshold: fx.colorThreshold,
            lineThickness: fx.lineThickness,
            lineStrength: fx.lineStrength,
            grayscaleGamma: fx.grayscaleGamma,
            grayscaleLift: fx.grayscaleLift,
            fxaa: fx.fxaa,
            fxaaEdgeThreshold: fx.fxaaEdgeThreshold,
            fxaaEdgeThresholdMin: fx.fxaaEdgeThresholdMin,
            fxaaBlendStrength: fx.fxaaBlendStrength,
            superSampleScale: fx.superSampleScale,
          };
        });

        if (nprEnabled && isWebGPU && nprHold.snap) {
          // Camera.clearColor → NPR background. The composite shader covers every
          // pixel, so without piping this in the swapchain stays whatever the NPR
          // fill produced (pure white in flat mode, luminance-remapped grayscale
          // otherwise) regardless of scene.background. Last active camera wins.
          let clearColor = 0x000000;
          world.query(CameraTrait, EntityAttributes).updateEach(([cam, attrs]: [{ clearColor: number }, { isActive: boolean }]) => {
            if (!attrs.isActive) return;
            clearColor = cam.clearColor ?? 0x000000;
          });

          // Edge-trigger (F6): skip the config-object build + setConfig entirely when
          // nothing the NPR pass reads has changed since the last applied config.
          const liveConfig = nprConfigFromTrait(nprHold.snap, clearColor);
          const sig = nprConfigSignature(liveConfig);
          // A projection toggle swapped the active camera object — the composer
          // baked the old one (incl. its perspective/ortho depth path), so rebuild.
          const cameraChanged = nprComposer != null && nprCamera !== activeCamera;
          if (!nprComposer || cameraChanged) {
            nprComposer?.dispose();
            nprComposer = new NPRPostProcess(renderer, scene, activeCamera, liveConfig);
            nprCamera = activeCamera;
            ssRebuild = new SuperSampleRebuildDebouncer(liveConfig.superSampleScale);
            lastNprSig = sig;
          } else {
            // F9: feed the live SS-scale target to the debouncer every frame. It
            // returns true only once the value has settled — so a slider drag that
            // sweeps SS-scale frame-by-frame recompiles the pipeline once, not per
            // intermediate value. (Note: SS scale is NOT in the F6 sig path's gate
            // anymore — it's coalesced here regardless of the sig fast-out.)
            const doSsRebuild = ssRebuild!.tick(liveConfig.superSampleScale);
            if (sig !== lastNprSig || doSsRebuild) {
              // Apply cheap uniform updates every change, but hold off the costly
              // structural rebuild until the SS-scale has actually settled. While
              // the SS-scale is mid-settle, pin setConfig's view of it to the
              // applied (live-pipeline) value so it can't signal an SS rebuild
              // before the debouncer commits one.
              const cfgScale = doSsRebuild ? liveConfig.superSampleScale : ssRebuild!.appliedScale;
              const nprConfig = { ...liveConfig, superSampleScale: cfgScale };
              const needsRebuild = nprComposer.setConfig(nprConfig);
              if (needsRebuild || doSsRebuild) {
                nprComposer.dispose();
                nprComposer = new NPRPostProcess(renderer, scene, activeCamera, nprConfig);
                nprCamera = activeCamera;
              }
              // Only mark the sig applied once the SS-scale is in sync with the
              // pipeline — otherwise a still-settling SS change would latch the sig
              // and the post-settle rebuild would be skipped.
              if (cfgScale === liveConfig.superSampleScale) lastNprSig = sig;
            }
          }
          nprComposer.render();
        } else {
          renderer.render(scene, activeCamera);
        }
      }
      // Prewarm the already-current scene before the first render. The runtime
      // game mounts Scene3D BEFORE the scene loads, so the registerBeforeSwap hook
      // (below) prewarms ahead of the swap and this call is a no-op (empty world).
      // The editor lazy-mounts GameView AFTER the initial scene swap, so that hook
      // never fired for it — without prewarming here, the NPR MRT render becomes
      // the renderer's first-ever compile, which intermittently mis-emits the
      // OutputType struct ("unresolved type 'OutputType'") and drops the mesh.
      const startLoop = () => registerFrameCallback(frameKey, renderFrame, PRIORITY_RENDER_3D);
      prewarmShadersForWorld(getCurrentWorld(), renderer, camera).then(startLoop, startLoop);

      // ── render_scene (ELECTRON_PLAN Phase 5): deterministic offscreen frame.
      //    Re-syncs the live ECS world, renders the forward pass (NPR is
      //    window-bound — see offscreenCapture.ts) with a clone of the live
      //    camera (optionally overridden) into an RT, reads it back, and encodes
      //    a JPEG data URL. The `capturing` guard parks the live loop so it can't
      //    render into our target across the async readback. ──
      const offscreenRender: SceneRenderer = async (opts) => {
        const vw = container.clientWidth || 1280, vh = container.clientHeight || 720;
        const w = Math.max(1, Math.min(Math.round(opts.width ?? vw), 4096));
        const h = Math.max(1, Math.min(Math.round(opts.height ?? vh), 4096));
        const quality = opts.quality ?? 0.85;
        const r = renderer as unknown as {
          getRenderTarget(): THREE.RenderTarget | null;
          setRenderTarget(rt: THREE.RenderTarget | null): void;
          render(s: THREE.Scene, c: THREE.Camera): void;
          // WebGPU: returns the pixel buffer (no buffer arg). WebGL: fills a passed buffer.
          readRenderTargetPixelsAsync?(rt: THREE.RenderTarget, x: number, y: number, w: number, h: number): Promise<Uint8Array>;
          readRenderTargetPixels?(rt: THREE.RenderTarget, x: number, y: number, w: number, h: number, buf: Uint8Array): void;
        };
        capturing = true;
        // Reuse the pooled RT/canvas/camera; (re)allocate only on first use or a
        // size change.
        if (!captureRT || captureRT.width !== w || captureRT.height !== h) {
          captureRT?.dispose();
          captureRT = new THREE.RenderTarget(w, h, { type: THREE.UnsignedByteType, colorSpace: THREE.SRGBColorSpace, depthBuffer: true });
        }
        if (!captureCanvas) captureCanvas = document.createElement('canvas');
        if (captureCanvas.width !== w) captureCanvas.width = w;
        if (captureCanvas.height !== h) captureCanvas.height = h;
        if (!captureCtx) {
          captureCtx = captureCanvas.getContext('2d');
          if (!captureCtx) { capturing = false; throw new Error('offscreen render: 2D canvas context unavailable'); }
        }
        const rt = captureRT;
        const c2d = captureCtx;
        try {
          // Pull the latest ECS state (a mutate may have landed since last frame).
          const world = getCurrentWorld();
          const activeForCapture = syncCamera(world, scene, camera, orthoCamera);
          syncEnvironment(world, scene);
          syncLights(world, scene, ecsLights);
          // Same unconditional renderable+skeletal core as the live renderFrame
          // (runtime-rendering-3d.md F1): without syncSkinnedModels/syncBones/
          // syncBoneAttachments a skeletal scene captured absent or frozen at a
          // stale pose, breaking the "same ECS state ⇒ same framing" contract of
          // the agent-verification path (modoki_render_scene).
          syncSceneRenderables3D(world, scene, renderState);
          syncParticles(world, scene, particleState);
          syncFlameMeshes(world, scene, flameState);

          // Deterministic camera: copy the live pose into the pooled capture cam,
          // then apply overrides. Mirror the live active projection so an ortho
          // scene captures as ortho (else modoki_render_scene would show the field
          // in perspective — not what the game renders). `fov` overrides are a
          // perspective-only knob; on ortho they're ignored (framing = orthoSize).
          let cam: THREE.PerspectiveCamera | THREE.OrthographicCamera;
          if (activeForCapture === orthoCamera) {
            if (!captureOrthoCam) captureOrthoCam = new THREE.OrthographicCamera();
            const oc = captureOrthoCam;
            oc.copy(orthoCamera);
            // Re-derive the frustum for the capture aspect from the live half-height.
            applyOrthoFrustum(oc, orthoCamera.top, w / h);
            if (opts.camera?.position) oc.position.fromArray(opts.camera.position);
            if (opts.camera?.target) oc.lookAt(new THREE.Vector3().fromArray(opts.camera.target));
            cam = oc;
          } else {
            if (!captureCam) captureCam = new THREE.PerspectiveCamera();
            const pc = captureCam;
            pc.copy(camera as THREE.PerspectiveCamera);
            pc.aspect = w / h;
            if (opts.camera?.position) pc.position.fromArray(opts.camera.position);
            if (opts.camera?.fov != null) pc.fov = opts.camera.fov;
            if (opts.camera?.target) pc.lookAt(new THREE.Vector3().fromArray(opts.camera.target));
            cam = pc;
          }
          // Apply the CameraFrame fit for the CAPTURE aspect (so the render matches
          // the live framed view — INCLUDING a mid-blend pose, via the shared blend
          // descriptor), unless the caller passed an explicit camera override.
          if (!opts.camera) {
            const target = computeActiveFrameFit(world, cam, w / h, cam === captureOrthoCam);
            if (target) {
              const { px, os } = framedPoseForAspect(world, cam, w / h, cam === captureOrthoCam, target);
              cam.position.copy(px);
              if (cam === captureOrthoCam) applyOrthoFrustum(cam as THREE.OrthographicCamera, os, w / h);
            }
          }
          cam.layers.enable(PARTICLE_LAYER);
          cam.updateMatrixWorld(true);
          cam.updateProjectionMatrix();
          orientBillboards(renderState, cam); // face billboards toward the capture camera

          // Guard the GPU ops with a timeout so a stalled/lost device can't leave
          // `capturing` stuck true and permanently park the live loop (P2-4). The
          // reject propagates to the finally, which always resets `capturing`.
          const withTimeout = <T,>(p: Promise<T>, ms: number, what: string) =>
            Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`offscreen render timed out (${what}, ${ms}ms)`)), ms))]);

          const prevRT = r.getRenderTarget();
          r.setRenderTarget(rt);
          try {
            // Post-init WebGPU (createRenderer awaits renderer.init()) and WebGL
            // both support the synchronous render() — renderAsync() is deprecated.
            // The actual GPU wait happens in the async readback below, so no
            // timeout is needed around render() itself.
            r.render(scene, cam);
            // Readback row stride + orientation are backend-specific (WebGPU pads
            // rows and is top-down; WebGL is tightly packed and bottom-up) — see
            // readbackToRGBA. Both quirks caused offscreen-capture bugs (banding
            // and an upside-down image), so the conversion is unit-tested there.
            let buf: Uint8Array;
            let backend: ReadbackBackend;
            if (r.readRenderTargetPixelsAsync) {
              buf = await withTimeout(r.readRenderTargetPixelsAsync(rt, 0, 0, w, h), 10000, 'readback'); // WebGPU returns it
              backend = 'webgpu';
            } else {
              buf = new Uint8Array(w * h * 4);
              r.readRenderTargetPixels?.(rt, 0, 0, w, h, buf); // WebGL fills it (tightly packed)
              backend = 'webgl';
            }
            const img = c2d.createImageData(w, h);
            img.data.set(readbackToRGBA(buf, w, h, backend));
            c2d.putImageData(img, 0, 0);
          } finally {
            // Always restore the renderer's target, even if the GPU op timed out,
            // so the live loop resumes against the right framebuffer.
            r.setRenderTarget(prevRT);
          }
          return { width: w, height: h, dataUrl: captureCanvas.toDataURL('image/jpeg', quality) };
        } finally {
          capturing = false;
        }
      };
      registerSceneRenderer(offscreenRender);

      // ── Screen-bounds provider (layout-bounds agent op) ── project each entity's
      // live world AABB through the GAME camera to a viewport CSS rect, so an agent
      // can reason about on-screen position/size/overlap numerically. Works at any
      // hierarchy depth (Box3.setFromObject + updateWorldMatrix walk the full chain).
      const _boundsBox = new THREE.Box3();
      const unregBounds = registerBoundsProvider((ids) => {
        const out: EntityScreenBounds[] = [];
        const r = renderer.domElement.getBoundingClientRect();
        const vp = { left: r.left, top: r.top, width: r.width, height: r.height };
        for (const [id, obj] of renderState.ecsObjects) {
          if (ids && !ids.has(id)) continue;
          obj.updateWorldMatrix(true, true);
          _boundsBox.setFromObject(obj);
          // Project through the ACTIVE camera (ortho or perspective) so the
          // reported rects match what's actually rendered — an ortho scene
          // projected through the perspective frustum gives wrong CSS rects +
          // onScreen flags.
          const { screen, onScreen } = projectAABBToScreen(_boundsBox, activeCamera, vp);
          // V5: also surface the raw world-space AABB size/center (previously computed
          // then discarded) so scene-state?bounds carries true geometric extent.
          let worldAABB: EntityScreenBounds['worldAABB'];
          if (!_boundsBox.isEmpty()) {
            const s = _boundsBox.getSize(new THREE.Vector3());
            const c = _boundsBox.getCenter(new THREE.Vector3());
            worldAABB = { size: [s.x, s.y, s.z], center: [c.x, c.y, c.z] };
          }
          out.push({ id, layer: '3d', screen, onScreen, ...(worldAABB ? { worldAABB } : {}) });
        }
        return out;
      });

      // On world swap, drop all cached Three.js objects (entity IDs are world-scoped).
      // Sync functions will rebuild from queries on the next frame.
      const unsubSwap = onWorldSwap(() => {
        disposeRenderState(renderState, scene);
        disposeParticleSyncState(particleState, scene);
        disposeFlameMeshSyncState(flameState, scene);
        // clearOwnedMaterials MUST run after disposeRenderState (which consults
        // _ownedMaterials). The SHARED inline-texture/tint material caches are
        // freed by the module-level onWorldSwap listener in scene3DSync.ts, not
        // here — so they're disposed exactly once per swap regardless of how many
        // loops are mounted.
        clearOwnedMaterials();
        for (const l of ecsLights.values()) { scene.remove(l); l.dispose(); }
        ecsLights.clear();
        framingCache = null;   // new scene → drop the stale fit
        framingDirty = true;   // and re-fit against the new scene's CameraFrame
        blendActive = false;   // never resume an old scene's blend into the new one
        blendOriginId = -1;
        lastApplied.valid = false;
        markRenderDirty(); // render the freshly-swapped scene even while stopped
      });

      // Prewarm shader programs BEFORE the world swap so the first frame of the
      // new scene doesn't compile shaders on the main thread. SceneManager awaits
      // this hook between staging-world population and setCurrentWorld.
      const prewarmHook = async (stagingWorld: import('koota').World) => {
        try {
          await prewarmShadersForWorld(stagingWorld, renderer, camera);
        } catch (e) {
          console.warn('[Scene3D] Shader prewarm failed:', e);
        }
      };
      sceneManager.registerBeforeSwap(prewarmHook);

      const resizeObserver = new ResizeObserver(() => {
        const w = container.clientWidth;
        const h = container.clientHeight;
        if (w === 0 || h === 0) return;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        // Ortho frustum is aspect-driven too: syncCamera re-applies orthoSize next
        // frame, but update here so a resize while paused reframes immediately.
        applyOrthoFrustum(orthoCamera, orthoCamera.top, w / h);
        framingDirty = true; // re-fit the CameraFrame for the new aspect
        // `max` sizeMode: render into a clamped drawing buffer (≤ web.width×height)
        // but keep the canvas CSS-sized to the container so it upscales to fill.
        // `free`/`fixed` pass through (buf === w×h). No-op for the editor (free).
        const buf = clampBufferSize(w, h, getRenderSettings().web);
        if (buf.width !== w || buf.height !== h) {
          renderer.setSize(buf.width, buf.height, false);
          renderer.domElement.style.width = `${w}px`;
          renderer.domElement.style.height = `${h}px`;
        } else {
          renderer.setSize(w, h);
        }
        // NPR texelSize is recomputed every frame from the live drawing buffer
        // (NPRPostProcess.render), so the resize itself needs no NPR-side call.
        markRenderDirty(); // re-render at the new size even while stopped
      });
      resizeObserver.observe(container);

      cleanupRef.current = () => {
        unregisterSceneRenderer(offscreenRender);
        unregBounds();
        captureRT?.dispose();
        captureRT = null;
        captureCanvas = null;
        captureCtx = null;
        captureCam = null;
        captureOrthoCam = null;
        unsubSwap();
        unsubInvalidation();
        unregisterSurface();
        for (const unsub of dirtyUnsubs) unsub();
        sceneManager.unregisterBeforeSwap(prewarmHook);
        resizeObserver.disconnect();
        unregisterFrameCallback(frameKey);
        disposeParticleSyncState(particleState, scene);
        disposeFlameMeshSyncState(flameState, scene);
        nprComposer?.dispose();
        nprComposer = null;
        ssRebuild = null;
        // Tear down skinned entries (stop mixers, dispose per-clone skeleton
        // boneTextures) — consistent with the world-swap path. Without this,
        // unmount relied on renderer.dispose() reclaiming the GPU context.
        disposeRenderState(renderState, scene);
        // Don't dispose scene.environment — it's owned by meshTemplateCache's
        // envCache (refcounted by SceneManager). Just detach.
        scene.environment = null;
        scene.clear();
        // SHARED module-level material caches (_defaultMaterial, inline-texture
        // mats, tint clones, and the _ownedMaterials tracking set) are
        // intentionally NOT disposed on a single panel's unmount. The editor
        // mounts two Scene3D loops at once (GameView + SceneView); freeing a
        // shared cache here destroys materials the other panel still renders with
        // (and _defaultMaterial, a const, would never be recreated) — the F2
        // use-after-free. These caches are freed on world swap (the module-level
        // onWorldSwap listener in scene3DSync.ts), when all loops rebuild
        // together, or reclaimed with the GPU context on final teardown. See
        // engine-review/runtime-rendering-3d.md F2.
        renderer.dispose();
        renderer.domElement.remove();
      };
    }

    return () => {
      disposed = true;
      cleanupRef.current?.();
    };
  }, []);

  return (
    <div ref={containerRef} style={{ position: 'absolute', inset: 0, zIndex: 0 }} />
  );
}
