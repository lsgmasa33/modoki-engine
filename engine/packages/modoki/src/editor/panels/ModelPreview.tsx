/** ModelPreview — embeddable mini 3D viewer for the Model Inspector.
 *
 *  Owns its own `WebGLRenderer` (sized to the panel) plus orbit controls, an
 *  ambient + directional light pair, and a small toolbar for LOD level switch
 *  + wireframe toggle + reset camera.
 *
 *  Disposes everything on unmount — the steady-state cost is +1 WebGL context
 *  while the inspector shows a model and 0 otherwise.
 */

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { assetUrl } from '../../runtime/loaders/assetUrl';
import { lodUrlSuffix } from '../../runtime/loaders/modelSettings';
import { getKTX2Loader } from '../../runtime/loaders/textureResolver';
import { needsGLBConversion, loadSourceModel } from '../scene/convertToGLB';
import { frameCameraToBoxFixed } from '../scene/sceneViewMath';
import { applyRendererColorConfig } from '../../runtime/rendering/scene3DSync';

interface Props {
  /** Source GLB URL — e.g. `/games/.../island.glb`. Suffixes are computed
   *  via `lodUrlSuffix` against this base. */
  sourceUrl: string;
  /** Whether the model has been imported (modelCache present). When false the
   *  preview falls back to the raw source GLB and the LOD switcher is hidden. */
  hasLods: boolean;
  /** Number of baked LOD levels (1..3). Ignored when `hasLods` is false. */
  lodCount: number;
}

type LodChoice = 'auto' | 0 | 1 | 2;

const PREVIEW_W = 320;
const PREVIEW_H = 220;

/** Fit the camera to the loaded model from the canonical fixed angle. Shared by the
 *  load path's initial frame and the Reset button (was duplicated, and Reset used to
 *  skip the near/far update). Sets `needsRender` so the render-on-demand loop redraws. */
function frameModelRoot(s: {
  modelRoot: THREE.Object3D;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  needsRender: boolean;
}): void {
  const box = new THREE.Box3().setFromObject(s.modelRoot);
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  const diag = box.getSize(new THREE.Vector3()).length();
  frameCameraToBoxFixed(s.camera, s.controls.target, center, diag);
  s.controls.update();
  s.needsRender = true;
}

export function ModelPreview({ sourceUrl, hasLods, lodCount }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    modelRoot: THREE.Group;
    envTexture: THREE.Texture | null;
    ownedMaterials: Set<THREE.Material>;
    ownedGeometries: Set<THREE.BufferGeometry>;
    raf: number | null;
    activeLevel: LodChoice;
    /** Render-on-demand flag (F7). The tick loop only submits a GPU frame when
     *  this is set — by the OrbitControls 'change' event (orbit/zoom/pan +
     *  damping settle) or by content changes (model load, wireframe, reframe).
     *  A static thumbnail then costs 0 GPU submits instead of 60/s. */
    needsRender: boolean;
  } | null>(null);

  const [lodChoice, setLodChoice] = useState<LodChoice>(hasLods ? 'auto' : 0);
  const [wireframe, setWireframe] = useState(false);
  // Mirror of `wireframe` the load effect reads without subscribing to it, so
  // toggling wireframe doesn't refetch/rebuild the GLB. The dedicated [wireframe]
  // effect below applies the toggle to already-loaded materials in place.
  const wireframeRef = useRef(wireframe);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ── Mount: build renderer, scene, controls ───────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(PREVIEW_W, PREVIEW_H);
    renderer.setClearColor(0x1a1a1a, 1);
    // Match the main viewport's color/tone conventions (ACESFilmic @ exposure 1.2,
    // sRGB output) via the single shared config `makeWebGPURenderer` also applies, so
    // imported PBR materials read the same here as in the live scene.
    applyRendererColorConfig(renderer);
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    // IBL: a neutral RoomEnvironment gives MeshStandardMaterial the indirect
    // light it needs so metallic/rough surfaces show form instead of flat white.
    // The main scene uses HDR envs via a shared cache; for this standalone
    // preview a procedural RoomEnvironment is the standard drop-in equivalent.
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    scene.environment = envTexture;
    // Ambient lowered (0.6 -> 0.25) now that IBL provides ambient fill, so
    // highlights aren't blown out. Key/fill directionals keep directional form.
    scene.add(new THREE.AmbientLight(0xffffff, 0.25));
    const key = new THREE.DirectionalLight(0xffffff, 1.0);
    key.position.set(2, 3, 2);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.3);
    fill.position.set(-2, 1, -1);
    scene.add(fill);

    const camera = new THREE.PerspectiveCamera(45, PREVIEW_W / PREVIEW_H, 0.05, 1000);
    camera.position.set(2, 2, 2);
    camera.lookAt(0, 0, 0);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    controls.target.set(0, 0, 0);
    // Render-on-demand: OrbitControls fires 'change' on every camera move
    // (user orbit/zoom/pan AND each damping-settle step inside update()), so
    // this is the single source for "the view moved → redraw".
    const onControlsChange = () => { if (stateRef.current) stateRef.current.needsRender = true; };
    controls.addEventListener('change', onControlsChange);

    const modelRoot = new THREE.Group();
    scene.add(modelRoot);

    stateRef.current = {
      renderer, scene, camera, controls, modelRoot, envTexture,
      ownedMaterials: new Set(), ownedGeometries: new Set(),
      raf: null, activeLevel: hasLods ? 'auto' : 0,
      needsRender: true, // draw the first frame
    };

    const tick = () => {
      const s = stateRef.current;
      if (!s) return;
      // update() returns true while damping is still settling; it also dispatches
      // 'change' (→ needsRender) on any movement. Render only when something changed.
      const moving = s.controls.update();
      if (s.needsRender || moving) {
        s.needsRender = false;
        s.renderer.render(s.scene, s.camera);
      }
      s.raf = requestAnimationFrame(tick);
    };
    stateRef.current.raf = requestAnimationFrame(tick);

    return () => {
      const s = stateRef.current;
      stateRef.current = null;
      if (!s) return;
      if (s.raf !== null) cancelAnimationFrame(s.raf);
      s.controls.removeEventListener('change', onControlsChange);
      s.controls.dispose();
      for (const g of s.ownedGeometries) g.dispose();
      for (const m of s.ownedMaterials) m.dispose();
      s.scene.environment = null;
      s.envTexture?.dispose();
      s.renderer.dispose();
      try { container.removeChild(s.renderer.domElement); } catch { /* already gone */ }
    };
  }, [hasLods]);

  // ── Load / reload the model when the source or LOD choice changes ────────
  useEffect(() => {
    const s = stateRef.current;
    if (!s) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    // Clear any previously loaded geometry/materials before fetching the next one.
    const clearModel = () => {
      while (s.modelRoot.children.length > 0) s.modelRoot.remove(s.modelRoot.children[0]);
      for (const g of s.ownedGeometries) g.dispose();
      for (const m of s.ownedMaterials) m.dispose();
      s.ownedGeometries.clear();
      s.ownedMaterials.clear();
    };

    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    // The derived `.processed.glb` variants carry KTX2 (KHR_texture_basisu)
    // textures — without a KTX2Loader the GLTFLoader throws "setKTX2Loader must
    // be called before loading KTX2 textures" and the preview shows nothing.
    // Reuse the shared transcoder singleton (transcoder path + GPU-format
    // detection already wired by the main editor renderer's setActiveRenderer).
    try { loader.setKTX2Loader(getKTX2Loader()); }
    catch (e) { console.warn('[ModelPreview] KTX2Loader unavailable:', e); }

    // Make the raw-GLB material read like the engine will render it. The import
    // pipeline (.mat.json) drops the GLB's emissive entirely, so a source GLB
    // that authors a full-surface emissive (e.g. emissiveFactor [1,1,1] with
    // KHR_materials_emissive_strength) would otherwise glow pure white here and
    // hide all lit/PBR form — which is NOT how the model looks in-engine. Zero
    // the emissive so the preview matches the runtime's no-emissive treatment.
    const prepMaterial = (mat: THREE.Material) => {
      const std = mat as THREE.MeshStandardMaterial;
      if (std.emissive) std.emissive.setScalar(0);
      s.ownedMaterials.add(mat);
    };
    const collectMaterials = (m: THREE.Mesh) => {
      s.ownedGeometries.add(m.geometry);
      const mat = m.material;
      if (Array.isArray(mat)) for (const x of mat) prepMaterial(x);
      else if (mat) prepMaterial(mat);
    };

    const buildSingle = (gltf: { scene: THREE.Group }) => {
      const root = gltf.scene;
      s.modelRoot.add(root);
      root.traverse((child) => {
        const m = child as THREE.Mesh;
        if (m.isMesh) collectMaterials(m);
      });
    };

    const buildLodAuto = async () => {
      // Build a THREE.LOD with one level per baked LOD GLB.
      const lod = new THREE.LOD();
      s.modelRoot.add(lod);
      for (let i = 0; i < lodCount; i++) {
        const url = assetUrl(sourceUrl + lodUrlSuffix(i));
        const gltf = await loader.loadAsync(url);
        // Bail between LOD loads on cancellation. Any later LODs that would
        // have run produce wasted bytes; the already-loaded gltf gets disposed
        // by the cleanup-time clearModel() pass via ownedGeometries.
        if (cancelled) return;
        const root = gltf.scene;
        // Switch distance: we don't know the model's lodDistances here without
        // an extra fetch; use linearly-spaced placeholders so orbit-back/forward
        // visibly switches levels. The "Auto" option is for visual verification,
        // not for matching scene runtime distances.
        const d = i === 0 ? 0 : i * 4;
        lod.addLevel(root, d);
        root.traverse((child) => {
          const m = child as THREE.Mesh;
          if (m.isMesh) collectMaterials(m);
        });
      }
      frameCamera();
    };

    const frameCamera = () => frameModelRoot(s);

    // Reads the live ref (not captured state) so this effect needn't depend on
    // `wireframe` — freshly loaded materials still adopt the current toggle.
    const applyWireframe = () => {
      for (const m of s.ownedMaterials) (m as THREE.MeshStandardMaterial).wireframe = wireframeRef.current;
    };

    // Non-GLB sources (OBJ/FBX/DAE) can't be parsed by GLTFLoader — they're
    // converted to GLB only at import time. Preview them by running the same
    // in-browser source loader the importer uses, so what you see is what gets
    // imported. (LODs never apply pre-import, so this path ignores lodChoice.)
    const buildFromSource = async () => {
      const obj = await loadSourceModel(sourceUrl);
      if (cancelled) {
        obj.traverse((child) => {
          const m = child as THREE.Mesh;
          if (m.isMesh) { m.geometry?.dispose(); const mm = m.material; (Array.isArray(mm) ? mm : [mm]).forEach((x) => x?.dispose()); }
        });
        return;
      }
      s.modelRoot.add(obj);
      obj.traverse((child) => {
        const m = child as THREE.Mesh;
        if (m.isMesh) collectMaterials(m);
      });
      frameCamera();
    };

    (async () => {
      try {
        clearModel();
        if (needsGLBConversion(sourceUrl)) {
          await buildFromSource();
        } else if (hasLods && lodChoice === 'auto') {
          await buildLodAuto();
        } else {
          // Single-level: load just the chosen GLB (LOD0 fallback when no LODs).
          const level = hasLods ? (lodChoice as number) : 0;
          const url = hasLods ? assetUrl(sourceUrl + lodUrlSuffix(level)) : assetUrl(sourceUrl);
          const gltf = await loader.loadAsync(url);
          if (cancelled) return;
          buildSingle(gltf as { scene: THREE.Group });
          frameCamera();
        }
        if (cancelled) return;
        applyWireframe();
        s.needsRender = true; // new geometry/materials are in the scene
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [sourceUrl, lodChoice, hasLods, lodCount]);

  // Toggle wireframe on already-loaded materials in place — no GLB refetch.
  useEffect(() => {
    wireframeRef.current = wireframe;
    const s = stateRef.current;
    if (s) {
      for (const m of s.ownedMaterials) (m as THREE.MeshStandardMaterial).wireframe = wireframe;
      s.needsRender = true;
    }
  }, [wireframe]);

  // ── Toolbar handlers ─────────────────────────────────────
  const resetCamera = () => {
    const s = stateRef.current;
    if (s) frameModelRoot(s);
  };

  // ── Render ───────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11 }}>
        {hasLods && (
          <select
            value={String(lodChoice)}
            onChange={(e) => {
              const v = e.target.value;
              setLodChoice(v === 'auto' ? 'auto' : (parseInt(v, 10) as LodChoice));
            }}
            style={{ background: '#1f1f1f', color: '#ddd', border: '1px solid #444', fontSize: 11 }}
          >
            <option value="auto">Auto</option>
            {Array.from({ length: lodCount }).map((_, i) => (
              <option key={i} value={String(i)}>LOD{i}</option>
            ))}
          </select>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, color: '#bbb' }}>
          <input type="checkbox" checked={wireframe} onChange={(e) => setWireframe(e.target.checked)} />
          Wireframe
        </label>
        <button
          onClick={resetCamera}
          style={{ background: '#2a2a2a', color: '#bbb', border: '1px solid #444', padding: '2px 6px', fontSize: 11, cursor: 'pointer' }}
        >
          Reset
        </button>
      </div>
      <div
        ref={containerRef}
        style={{
          width: PREVIEW_W, height: PREVIEW_H,
          background: '#1a1a1a', border: '1px solid #333',
          position: 'relative',
        }}
      >
        {loading && (
          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#888', fontSize: 11, pointerEvents: 'none' }}>
            Loading…
          </div>
        )}
        {error && (
          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#e88', fontSize: 11, padding: 8, textAlign: 'center', pointerEvents: 'none' }}>
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
