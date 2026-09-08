/** createPreviewScene — the shared WebGL mini-viewer primitive behind the asset
 *  Inspector's 3D previews (Mesh, Material; Model has its own richer loader).
 *
 *  Owns a self-sized `WebGLRenderer` + neutral RoomEnvironment IBL + key/fill
 *  lights + orbit controls + a render-on-demand rAF loop, and exposes a
 *  `contentRoot` group callers fill with meshes. Everything is disposed on
 *  `dispose()`. Modeled on ModelPreview's scene setup (matching color/tone config
 *  so PBR reads the same as the live scene); factored out so Mesh/Material previews
 *  don't each re-implement it. Throws if a WebGL context can't be created (the
 *  caller catches → shows a graceful "no WebGL" state, e.g. under jsdom). */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { applyRendererColorConfig } from '../../runtime/rendering/scene3DSync';
import { frameCameraToBoxFixed } from '../scene/sceneViewMath';
import { noteGpuContextCreated } from '../../runtime/core/gpuContextTracking';
import { type TeardownScope } from '../../runtime/core/teardownScope';
import { attachRendererLossHandling } from '../../runtime/rendering/rendererLossHandling';
import { makePreviewLossPolicy, REOPEN_INSPECTOR_HINT } from './previewLossPolicy';

export interface PreviewSceneHandle {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  /** Add preview meshes here — geometry/materials added must be OWNED by the caller
   *  (clones / freshly-created), since `clearContent`/`dispose` dispose them. */
  contentRoot: THREE.Group;
  /** Mark the next rAF tick to submit a frame (render-on-demand). */
  requestRender(): void;
  /** Fit the camera to the current content from the canonical fixed angle. */
  frameContent(): void;
  /** Toggle wireframe on every material under `contentRoot`. */
  setWireframe(on: boolean): void;
  /** Remove + dispose all content (geometry + materials) under `contentRoot`. */
  clearContent(): void;
  /** Tear down the loop, controls, content, env, and renderer. */
  dispose(): void;
  /** True once `dispose()` has run — including from a GPU-context-loss teardown fired MID-MOUNT
   *  (#795), not just from the caller's own unmount. A caller must check this before populating:
   *  a dead handle's `contentRoot` will never draw again, and its scene/renderer are already gone
   *  (finding 2, adversarial review of #795). */
  readonly disposed: boolean;
}

export interface PreviewSceneOptions {
  width?: number;
  height?: number;
  background?: number;
}

export function createPreviewScene(
  container: HTMLElement,
  opts: PreviewSceneOptions,
  /** The CALLER's release path, required (#858). Every acquisition below registers into it as it
   *  is taken, so a caller whose `createPreviewScene(...)` throws can still release what was
   *  taken — which it otherwise cannot, because `dispose` only reaches it via the `return` at the
   *  end of this function and there is no handle to call it on. Owned by the caller precisely
   *  because the caller is the only one still running when this throws. */
  scope: TeardownScope,
): PreviewSceneHandle {
  const width = opts.width ?? 320;
  const height = opts.height ?? 220;
  const background = opts.background ?? 0x1a1a1a;

  // Throws in a WebGL-less environment (jsdom) — the caller catches.
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  // Fix 3 of #590's adversarial review (docs/rendering.md): this is
  // `src/editor` — dev-only, never shipped in a game build — but it creates a REAL WebGL
  // context, and an editor session (SceneView + GameView + this preview + ModelPreview +
  // ShaderPreview all open) is exactly the surface that approaches `SOFT_CONTEXT_LIMIT`. Noted
  // after a successful construction (never before — see `noteGpuContextCreated`'s doc), paired
  // with a `contextLive`-guarded decrement in `dispose()` below so a stray double-dispose can't
  // decrement twice.
  // #858. `dispose` is only handed to the caller by the `return` at the very END of this
  // function, and `Preview3DShell`'s `catch` around the call has nothing to dispose because
  // `handle` was never assigned — so everything taken between here and that return used to leak
  // outright. `pmrem.fromScene` below is a real GPU op and a realistic throw point on a degraded
  // context. The scope makes the release reachable from the first acquisition onward.
  // Pushed FIRST so LIFO drains it LAST — after which the handle honestly reports itself dead.
  // The scope is the CALLER's now, so a caller can drain it WITHOUT going through `dispose()`
  // (`Preview3DShell` legitimately does exactly that on the constructor-throw path). Without this,
  // `handle.disposed` — the field whose doc tells callers to check it before populating — would
  // report a live handle over a disposed renderer.
  scope.add(() => { isDisposed = true; });
  scope.add(noteGpuContextCreated());
  // Guards both `dispose()` (idempotent — a lost-context teardown and an unmount can both call
  // it) and the loss listener's `isStale` check below (#795): `dispose()` itself forces a context
  // loss, and without this a correct teardown would report itself as a fault. Named `isDisposed`
  // (not `disposed`, which is the PUBLIC getter below) so the two can't be confused for one another.
  let isDisposed = false;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(width, height);
  renderer.setClearColor(background, 1);
  applyRendererColorConfig(renderer);
  container.appendChild(renderer.domElement);
  scope.add(() => { try { container.removeChild(renderer.domElement); } catch { /* already gone */ } });
  // forceContextLoss BEFORE dispose: dispose() frees programs/RTs but does NOT release the
  // underlying GL context (browser GC decides, nondeterministically). A preview now mounts on
  // every mesh/material asset click, so without this the live-context count climbs to Chrome's
  // ~16 cap → "too many active WebGL contexts" blacks out previews AND the main SceneView.
  scope.add(() => { renderer.forceContextLoss(); renderer.dispose(); });
  const detachLoss = attachRendererLossHandling(
    { canvas: renderer.domElement },
    {
      label: 'previewScene',
      isStale: () => isDisposed,
      ...makePreviewLossPolicy({
        label: 'previewScene',
        teardown: () => dispose(),
        // Unlike ShaderPreview/ParticleEditor, this handle's caller (Preview3DShell) does NOT
        // unmount on the recovery path a reader would expect: selecting a different Mesh/Material
        // asset just changes `resetKey` and re-populates in place. "Reopen the panel" is wrong
        // advice here — the Inspector has to be closed and reopened, not the asset reselected
        // (finding 2, adversarial review of #795). `ModelPreview.tsx` shares this exact shape
        // (finding 6) and overrides with the same constant.
        recoverHint: REOPEN_INSPECTOR_HINT,
      }),
    },
  );

  scope.add(() => detachLoss());

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const roomEnv = new RoomEnvironment();
  const envTexture = pmrem.fromScene(roomEnv, 0.04).texture;
  roomEnv.dispose(); // free the RoomEnvironment's geometries/materials (only envTexture is kept)
  pmrem.dispose();
  scene.environment = envTexture;
  scene.add(new THREE.AmbientLight(0xffffff, 0.25));
  const key = new THREE.DirectionalLight(0xffffff, 1.0);
  key.position.set(2, 3, 2);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.3);
  fill.position.set(-2, 1, -1);
  scene.add(fill);

  const camera = new THREE.PerspectiveCamera(45, width / height, 0.01, 1000);
  camera.position.set(2, 2, 2);
  camera.lookAt(0, 0, 0);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.1;
  controls.target.set(0, 0, 0);

  const contentRoot = new THREE.Group();
  scene.add(contentRoot);

  let needsRender = true;
  let raf: number | null = null;
  const onControlsChange = () => { needsRender = true; };
  controls.addEventListener('change', onControlsChange);

  const tick = () => {
    const moving = controls.update();
    if (needsRender || moving) {
      needsRender = false;
      renderer.render(scene, camera);
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  const requestRender = () => { needsRender = true; };

  const frameContent = () => {
    const box = new THREE.Box3().setFromObject(contentRoot);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const diag = box.getSize(new THREE.Vector3()).length();
    frameCameraToBoxFixed(camera, controls.target, center, diag);
    controls.update();
    needsRender = true;
  };

  const setWireframe = (on: boolean) => {
    contentRoot.traverse((o) => {
      const mat = (o as THREE.Mesh).material;
      if (!mat) return;
      (Array.isArray(mat) ? mat : [mat]).forEach((m) => { (m as THREE.MeshStandardMaterial).wireframe = on; });
    });
    needsRender = true;
  };

  const clearContent = () => {
    for (const child of [...contentRoot.children]) {
      child.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry?.dispose();
        const mat = mesh.material;
        (Array.isArray(mat) ? mat : [mat]).forEach((m) => m?.dispose());
      });
      contentRoot.remove(child);
    }
    needsRender = true;
  };

  // Pushed LAST, so LIFO runs it FIRST. Everything in here closes over locals that only exist
  // once construction has got this far, which is precisely why `dispose` could not simply be
  // defined before the acquisitions the way `ShaderPreview.tsx` does it.
  scope.add(() => {
    if (raf !== null) cancelAnimationFrame(raf);
    controls.removeEventListener('change', onControlsChange);
    controls.dispose();
    scene.environment = null;
    envTexture.dispose();
  });

  const dispose = () => {
    // clearContent() runs on EVERY call, even a repeat one — the guard below prevents double
    // renderer teardown, not cleanup of content added AFTER the first dispose. A loss teardown
    // (#795) can fire mid-mount, and if the caller then adds more content before noticing (it
    // shouldn't, once it checks `disposed` — but this is the backstop), a second `dispose()` call
    // from unmount must still sweep it, or it leaks (finding 2, adversarial review of #795).
    clearContent();
    if (isDisposed) return; // idempotent from here down — a lost-context teardown and an unmount can both call this
    isDisposed = true;
    // Drains in reverse acquisition order: the closure above, then detachLoss, the renderer,
    // the context count, and the canvas removal. Only `detachLoss` moved relative to the old
    // hand-ordered body (it was first); safe because `isStale` reads `isDisposed`, set above.
    scope.dispose();
  };

  return {
    scene, camera, controls, contentRoot, requestRender, frameContent, setWireframe, clearContent, dispose,
    get disposed() { return isDisposed; },
  };
}
