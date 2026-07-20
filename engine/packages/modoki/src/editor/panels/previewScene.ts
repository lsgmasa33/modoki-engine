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
}

export interface PreviewSceneOptions {
  width?: number;
  height?: number;
  background?: number;
}

export function createPreviewScene(container: HTMLElement, opts: PreviewSceneOptions = {}): PreviewSceneHandle {
  const width = opts.width ?? 320;
  const height = opts.height ?? 220;
  const background = opts.background ?? 0x1a1a1a;

  // Throws in a WebGL-less environment (jsdom) — the caller catches.
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(width, height);
  renderer.setClearColor(background, 1);
  applyRendererColorConfig(renderer);
  container.appendChild(renderer.domElement);

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

  const dispose = () => {
    if (raf !== null) cancelAnimationFrame(raf);
    controls.removeEventListener('change', onControlsChange);
    controls.dispose();
    clearContent();
    scene.environment = null;
    envTexture.dispose();
    // forceContextLoss BEFORE dispose: dispose() frees programs/RTs but does NOT
    // release the underlying GL context (browser GC decides, nondeterministically).
    // A preview now mounts on every mesh/material asset click, so without this the
    // live-context count climbs to Chrome's ~16 cap → "too many active WebGL
    // contexts" blacks out previews AND the main SceneView. forceContextLoss frees
    // it deterministically on unmount.
    renderer.forceContextLoss();
    renderer.dispose();
    try { container.removeChild(renderer.domElement); } catch { /* already gone */ }
  };

  return { scene, camera, controls, contentRoot, requestRender, frameContent, setWireframe, clearContent, dispose };
}
