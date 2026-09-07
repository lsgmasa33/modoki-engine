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
import type { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { makeGltfLoader } from '../../runtime/loaders/threeLoaderModules';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { assetUrl } from '../../runtime/loaders/assetUrl';
import { lodUrlSuffix } from '../../runtime/loaders/modelSettings';
import { getKTX2Loader } from '../../runtime/loaders/textureResolver';
import { needsGLBConversion, loadSourceModel, disposeSourceModel } from '../scene/convertToGLB';
import { frameCameraToBoxFixed } from '../scene/sceneViewMath';
import { applyRendererColorConfig } from '../../runtime/rendering/scene3DSync';
import { noteGpuContextCreated, noteGpuContextDestroyed } from '../../runtime/core/gpuContextTracking';
import { attachRendererLossHandling } from '../../runtime/rendering/rendererLossHandling';
import { makePreviewLossPolicy, REOPEN_INSPECTOR_HINT } from './previewLossPolicy';
import { useModelInvalidationEpoch, cacheBustReimport } from './useAssetInvalidationEpoch';
import { collectMaterialResources, disposeOwnedResources } from './modelPreviewResources';
import { gateModelLoad, shouldAttachLoadedModel } from './modelPreviewLoss';

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
    /** Set only on the OBJ/FBX/DAE preview path — its meshes are ALSO in
     *  ownedGeometries/ownedMaterials, but disposeSourceModel additionally sweeps the
     *  textures a freshly-parsed source model carries (sibling .mtl maps). Calling it
     *  alongside the geometry/material/texture dispose loops below is redundant, not
     *  wrong: both target the same objects and dispose() is idempotent. */
    sourceRoot: THREE.Object3D | null;
    envTexture: THREE.Texture | null;
    ownedMaterials: Set<THREE.Material>;
    ownedGeometries: Set<THREE.BufferGeometry>;
    /** THREE.Material.dispose() does not free the textures hanging off it (map,
     *  normalMap, emissiveMap, …) — those leak unless collected and disposed separately. */
    ownedTextures: Set<THREE.Texture>;
    raf: number | null;
    activeLevel: LodChoice;
    /** Set by `teardown()` (finding 3a, adversarial review of #795) — the signal an in-flight
     *  "load the model" effect has no other way to receive, since that effect's OWN `cancelled`
     *  flag is set only by ITS cleanup, which does not run when `teardown` fires from a
     *  GPU-context loss instead of an unmount or a [hasLods] re-run. */
    aborted: boolean;
    /** Render-on-demand flag (F7). The tick loop only submits a GPU frame when
     *  this is set — by the OrbitControls 'change' event (orbit/zoom/pan +
     *  damping settle) or by content changes (model load, wireframe, reframe).
     *  A static thumbnail then costs 0 GPU submits instead of 60/s. */
    needsRender: boolean;
  } | null>(null);

  // A re-import rewrites the baked `.glb`s in place, so `sourceUrl` — the only thing
  // the load effect keys on — is exactly what does NOT change (#294, widened from
  // MeshPreview). Two failures stack here and the epoch fixes both: React never
  // re-runs the effect, and even if it did, the browser would replay its cached copy
  // of an unchanged URL. Filtered to THIS model (`targets` also names its baked LOD
  // siblings) so an unrelated re-import doesn't refetch a multi-MB GLB for nothing.
  const reimportEpoch = useModelInvalidationEpoch((_modelPath, targets) => targets.has(sourceUrl));

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
    // Fix 3 of #590's adversarial review (docs/rendering.md): this is
    // `src/editor` — dev-only, never shipped in a game build — but it creates a REAL WebGL
    // context, and an editor session with several previews/viewports open is exactly the surface
    // that approaches `SOFT_CONTEXT_LIMIT`. Noted after a successful construction (never before
    // — see `noteGpuContextCreated`'s doc), paired with a `contextLive`-guarded decrement in the
    // unmount cleanup below, matching `scene3DSync.ts`'s `makeWebGPURenderer` convention.
    noteGpuContextCreated();
    let contextLive = true;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(PREVIEW_W, PREVIEW_H);
    renderer.setClearColor(0x1a1a1a, 1);
    // Match the main viewport's color/tone conventions (ACESFilmic @ exposure 1.2,
    // sRGB output) via the single shared config `makeWebGPURenderer` also applies, so
    // imported PBR materials read the same here as in the live scene.
    applyRendererColorConfig(renderer);
    container.appendChild(renderer.domElement);
    // Loss detection (#795) — wired as soon as the context exists. `stateRef.current === null`
    // doubles as the stale check: `teardown` below nulls it BEFORE doing anything else, and
    // React always runs this effect's cleanup (which calls `teardown`) before a later run of
    // this same effect (the [hasLods] re-run) attaches its own listener, so a stale event from a
    // superseded renderer can never reach a live `stateRef.current`.
    const detachLoss = attachRendererLossHandling(
      { canvas: renderer.domElement },
      {
        label: 'ModelPreview', isStale: () => stateRef.current === null,
        // This panel is embedded in the Model Inspector (`ModelAssetView`, mounted with no `key`)
        // — selecting a different model re-populates THIS SAME instance rather than unmounting it,
        // so the default "reopen the panel" hint is wrong (finding 6, third adversarial review of
        // #795; same shape as `previewScene.ts`'s Mesh/Material Preview3DShell, finding 2).
        ...makePreviewLossPolicy({ label: 'ModelPreview', teardown: () => teardown(), recoverHint: REOPEN_INSPECTOR_HINT }),
      },
    );

    const scene = new THREE.Scene();
    // IBL: a neutral RoomEnvironment gives MeshStandardMaterial the indirect
    // light it needs so metallic/rough surfaces show form instead of flat white.
    // The main scene uses HDR envs via a shared cache; for this standalone
    // preview a procedural RoomEnvironment is the standard drop-in equivalent.
    const pmrem = new THREE.PMREMGenerator(renderer);
    const roomEnv = new RoomEnvironment();
    const envTexture = pmrem.fromScene(roomEnv, 0.04).texture;
    roomEnv.dispose(); // free the RoomEnvironment's geometries/materials (only envTexture is kept)
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
      renderer, scene, camera, controls, modelRoot, sourceRoot: null, envTexture,
      ownedMaterials: new Set(), ownedGeometries: new Set(), ownedTextures: new Set(),
      raf: null, activeLevel: hasLods ? 'auto' : 0, aborted: false,
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

    // The panel's ONE teardown path — called on unmount AND (#795) on a lost GPU context, so a
    // loss tears the preview down exactly the same way an unmount would. Idempotent by
    // construction: `stateRef.current` is nulled FIRST, so a second call sees `s === null` and
    // returns immediately.
    const teardown = () => {
      const s = stateRef.current;
      stateRef.current = null;
      if (!s) return;
      // Signal any in-flight "load the model" effect to stop attaching/collecting onto this dead
      // scene (finding 3a, adversarial review of #795) — that effect closes over THIS SAME state
      // object, so it can observe the flip even though `stateRef.current` above is already null.
      s.aborted = true;
      detachLoss();
      if (s.raf !== null) cancelAnimationFrame(s.raf);
      s.controls.removeEventListener('change', onControlsChange);
      s.controls.dispose();
      disposeOwnedResources(s.ownedGeometries, s.ownedMaterials, s.ownedTextures);
      // Redundant with the sweep above for the OBJ/FBX/DAE path (see the sourceRoot field
      // comment) — kept because disposeSourceModel is the one place that also walks a
      // freshly-parsed source model's own hierarchy, not just the sets collected from it.
      if (s.sourceRoot) { disposeSourceModel(s.sourceRoot); s.sourceRoot = null; }
      s.scene.environment = null;
      s.envTexture?.dispose();
      // dispose() does NOT release the GL context — see previewScene.ts's dispose() for the
      // full explanation. This effect re-runs on [hasLods] flips too, not just unmount, so a
      // missing call strands a context per flip. Placed before dispose() to match previewScene;
      // either order works (dispose() never touches the extensions closure or _gl), so what is
      // load-bearing is that the call happens at all — which is what the guard checks.
      s.renderer.forceContextLoss();
      s.renderer.dispose();
      if (contextLive) { contextLive = false; noteGpuContextDestroyed(); }
      try { container.removeChild(s.renderer.domElement); } catch { /* already gone */ }
    };

    return () => { teardown(); };
  }, [hasLods]);

  // ── Load / reload the model when the source or LOD choice changes ────────
  useEffect(() => {
    const s0 = stateRef.current;
    // `!s0` means the mount effect's teardown already ran (unmount, or #795's GPU-loss path) —
    // this used to return BEFORE `setLoading(true)`, so the NEXT model selection after a loss
    // silently left `loading: false, error: null`: a permanently empty box reporting success
    // (finding 3b, adversarial review of #795).
    const gate = gateModelLoad(!!s0);
    if (!gate.proceed) { setLoading(false); setError(gate.error); return; }
    const s = s0!; // non-null from here down — every use below is unchanged from before finding 3
    let cancelled = false;
    setLoading(true);
    setError(null);

    // Defeat the browser's cached copy of an unchanged URL after a re-import. Applied
    // to the BAKED artifacts only — the raw source model (OBJ/FBX/DAE below) is an
    // input to the importer, never rewritten by it, and its sidecar .mtl/texture refs
    // resolve relative to the URL. `withCacheBust` is not the tool here: it is
    // PROD-and-content-hash only, and the editor runs neither.
    const bust = (url: string) => cacheBustReimport(url, reimportEpoch);

    // Clear any previously loaded geometry/materials before fetching the next one.
    const clearModel = () => {
      while (s.modelRoot.children.length > 0) s.modelRoot.remove(s.modelRoot.children[0]);
      disposeOwnedResources(s.ownedGeometries, s.ownedMaterials, s.ownedTextures);
      // Redundant with the sweep above for the OBJ/FBX/DAE path (see the sourceRoot field
      // comment) — kept because disposeSourceModel is the one place that also walks a
      // freshly-parsed source model's own hierarchy, not just the sets collected from it.
      if (s.sourceRoot) { disposeSourceModel(s.sourceRoot); s.sourceRoot = null; }
    };

    // Built on first use, not up front: three's GLTFLoader/meshopt/KTX2 modules are imported
    // on demand (#254), so every step here is async. Memoised per effect run — the two load
    // paths below share one loader, as they did when it was a plain `new GLTFLoader()`.
    let loaderPromise: Promise<GLTFLoader> | null = null;
    const getLoader = () => (loaderPromise ??= (async () => {
      const l = await makeGltfLoader();
      // The derived `.processed.glb` variants carry KTX2 (KHR_texture_basisu)
      // textures — without a KTX2Loader the GLTFLoader throws "setKTX2Loader must
      // be called before loading KTX2 textures" and the preview shows nothing.
      // Reuse the shared transcoder singleton (transcoder path + GPU-format
      // detection already wired by the main editor renderer's setActiveRenderer).
      try { l.setKTX2Loader(await getKTX2Loader()); }
      catch (e) { console.warn('[ModelPreview] KTX2Loader unavailable:', e); }
      return l;
    })().catch((e) => { loaderPromise = null; throw e; }));

    // Make the raw-GLB material read like the engine will render it. The import
    // pipeline (.mat.json) drops the GLB's emissive entirely, so a source GLB
    // that authors a full-surface emissive (e.g. emissiveFactor [1,1,1] with
    // KHR_materials_emissive_strength) would otherwise glow pure white here and
    // hide all lit/PBR form — which is NOT how the model looks in-engine. Zero
    // the emissive so the preview matches the runtime's no-emissive treatment.
    const prepMaterial = (mat: THREE.Material) => {
      const std = mat as THREE.MeshStandardMaterial;
      if (std.emissive) std.emissive.setScalar(0);
      collectMaterialResources(s.ownedMaterials, s.ownedTextures, mat);
    };
    const collectMaterials = (m: THREE.Mesh) => {
      s.ownedGeometries.add(m.geometry);
      const mat = m.material;
      if (Array.isArray(mat)) for (const x of mat) prepMaterial(x);
      else if (mat) prepMaterial(mat);
    };

    const buildSingle = (gltf: { scene: THREE.Group }) => {
      const root = gltf.scene;
      // A GPU-loss teardown (finding 3a) means there is no NEXT `clearModel()` coming to sweep
      // whatever gets collected below — collecting into `s.ownedGeometries`/`ownedMaterials` would
      // leak them forever. Dispose the parsed document directly instead and stop here — the same
      // `disposeSourceModel` helper used for the OBJ/FBX/DAE path below, not a second sweep (an
      // earlier version of this fix grew its own geometry/material-only copy that leaked every
      // texture, finding 1, second adversarial review of #795).
      if (s.aborted) { disposeSourceModel(root); return; }
      // Collect FIRST and unconditionally (for the ORDINARY cancel case below): a cancelled run's
      // parsed document must still be owned, or it leaks (#537 — this is the path that leaked).
      root.traverse((child) => {
        const m = child as THREE.Mesh;
        if (m.isMesh) collectMaterials(m);
      });
      // ATTACHING is what must be conditional. The next effect run calls clearModel()
      // synchronously before its own await, so a cancelled run adding here would leave BOTH
      // models as children of modelRoot, rendering together until the next clear. (`s.aborted` is
      // always false past the early return above, so `shouldAttachLoadedModel` no longer takes it
      // — finding 7, third adversarial review of #795.)
      if (shouldAttachLoadedModel(cancelled)) s.modelRoot.add(root);
    };

    const buildLodAuto = async () => {
      // Build a THREE.LOD with one level per baked LOD GLB.
      const lod = new THREE.LOD();
      s.modelRoot.add(lod);
      for (let i = 0; i < lodCount; i++) {
        const url = bust(assetUrl(sourceUrl + lodUrlSuffix(i)));
        const gltf = await (await getLoader()).loadAsync(url);
        const root = gltf.scene;
        // Same reasoning as `buildSingle` (finding 3a) — a GPU-loss teardown leaves no next
        // `clearModel()` to sweep a collected-but-never-attached level, so dispose it directly.
        if (s.aborted) { disposeSourceModel(root); return; }
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
        // Collect BEFORE bailing on cancellation: this LOD's geometries/materials/
        // textures are now owned, so the next clearModel() disposes them WHEN THE EFFECT
        // RE-RUNS. On unmount, the mount effect's cleanup runs first and already disposed
        // + nulled state, so a late resolve here collects into sets nobody sweeps — CPU-side
        // only, since the renderer is already gone. Only LATER LODs are skipped.
        //
        // Note: `lod` is attached to modelRoot BEFORE this loop's first await, unlike
        // buildSingle's root. Don't "fix" that by symmetry — the next run's clearModel()
        // detaches this same THREE.LOD group, so a cancelled run's later addLevel() calls
        // land on an orphan, never visible.
        if (cancelled) return;
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
      // `s.aborted` (finding 3a) joins the existing `cancelled` check here — same disposal, two
      // different reasons nothing else will ever attach or sweep this parsed model.
      if (cancelled || s.aborted) { disposeSourceModel(obj); return; }
      s.modelRoot.add(obj);
      s.sourceRoot = obj;
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
          const url = bust(hasLods ? assetUrl(sourceUrl + lodUrlSuffix(level)) : assetUrl(sourceUrl));
          const gltf = await (await getLoader()).loadAsync(url);
          buildSingle(gltf as { scene: THREE.Group });
          if (cancelled || s.aborted) return;
          frameCamera();
        }
        // `s.aborted` (finding 3, adversarial review of #795) joins `cancelled` in every one of
        // these post-await checks: a loss can land after any of the branches above already
        // started, and reaching `setLoading(false)` here would report a successfully-loaded model
        // for a scene that stopped drawing when the loss teardown ran.
        if (cancelled || s.aborted) return;
        applyWireframe();
        s.needsRender = true; // new geometry/materials are in the scene
        setLoading(false);
      } catch (e) {
        if (cancelled || s.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [sourceUrl, lodChoice, hasLods, lodCount, reimportEpoch]);

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
