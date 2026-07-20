/** Scene View — 3D viewport + UI editor mode toggle. */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import * as THREE from 'three';
// Use the published `three/webgpu` entry (not the deep source path) so Vite's
// dep optimizer puts WebGPURenderer in the same pre-bundle as `three/tsl`.
// Importing via `three/src/...` creates a separate pre-bundle that ships its
// own copy of TSL constants (e.g. `normalView`), and the duplicate
// `.toVar('normalView')` instance trips
// "TSL: Declaration name 'normalView' already in use" on every shader compile.
import { WebGPURenderer } from 'three/webgpu';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { getCurrentWorld, onWorldSwap } from '../../runtime/ecs/world';
import { isSimRunning, onPlayStateChange, inPreviewSession } from '../../runtime/systems/playState';
import { setSkeletalPreview } from '../../runtime/systems/skeletalPreview';
import { clearSkeletalSeeks } from '../../runtime/systems/skeletalSeek';
import { getAllTraits } from '../../runtime/ecs/traitRegistry';
import { worldTransforms, deactivatedEntities } from '../../three/systems/transformPropagationSystem';
import { findEntity, fireDirtyListeners, addDirtyListener, onStructureDirty, getAllEntities, subtreeIds } from '../../runtime/ecs/entityUtils';
import { markOverrideIfInstance } from '../undo/entityActions';
import { Transform, EntityAttributes, Collider3D, clampAngle, Bone2D, Billboard3D, CameraFrame, Zone3D } from '../../runtime/traits';
import { colliderWireframeGeometry, colliderOutlineSig3D, type ColliderOutline3DParams } from '../../runtime/rendering/colliderOutline3D';
import {
  syncEnvironment, syncLights, syncSceneRenderables3D, orientBillboards,
  refreshEnvIntensityObserver,
  createRenderState, disposeRenderState, attachInvalidationListener,
  makeWebGPURenderer, computeActiveFrameFit, applyOrthoFrustum,
} from '../../runtime/rendering/scene3DSync';
import { registerRenderSurface } from '../../runtime/rendering/materialBroker';
import {
  registerFrameCallback, unregisterFrameCallback,
  startFrameDriver, stopFrameDriver,
  PRIORITY_EDITOR_3D, PRIORITY_EDITOR_2D,
} from '../../runtime/rendering/frameDriver';
import { createParticleSyncState, syncParticles, disposeParticleSyncState } from '../../runtime/rendering/particleSync';
import { registerBoundsProvider, projectAABBToScreen, type EntityScreenBounds } from '../../runtime/rendering/screenBounds';
import { registerHandleProvider, type InteractionHandle } from '../../runtime/rendering/interactionHandles';
import { createFlameMeshSyncState, syncFlameMeshes, disposeFlameMeshSyncState } from '../../runtime/rendering/flameMeshSync';
import { PARTICLE_LAYER } from '../../runtime/rendering/layers';
import { getWorldTransform2D, getWorldTransform2DInto } from '../../runtime/rendering/renderUtils';
import { setActiveRenderer } from '../../runtime/loaders/textureResolver';
import { drawColliderOutline, drawSkinnedMeshFlat2D, drawSkinnedMeshWireframe2D, drawWeightHeatmap2D, drawDominantBoneMap2D, computePivotOffset, COLLIDER_SPRITE } from '../../runtime/rendering/render2DUtils';
import { getSkin2DBuffer } from '../../runtime/systems/skin2DBuffers';
import { getRig2D, type ParsedRig2D } from '../../runtime/loaders/rig2dCache';
import { getGuidForPath } from '../../runtime/loaders/assetManifest';
import { resolveMeshTemplate } from '../../runtime/loaders/meshTemplateCache';
import { boneWeightField, dominantBoneField, paintWeights } from '../../runtime/skinning/rig2dWeightPaint';
import { deriveBindMatrices } from '../../runtime/skinning/rig2dMath';
import { computeCanvasScale, screenToReference2D } from '../../runtime/rendering/canvas2DScaler';
import { findCanvasAncestor } from '../../runtime/rendering/canvas2DRouting';
import { computePaintOrder } from '../../runtime/rendering/paintOrder';
import { UIRenderer } from '../../runtime/ui/UIRenderer';
import { useEditorStore } from '../store/editorStore';
import { loadScene } from '../scene/serialize';
import { worldToLocalTransform } from '../scene/gizmoTransform';
import { boneRelToProxyLocal, proxyLocalToBoneLocal } from '../scene/billboardBonePose';
import { setEditorViewportCamera, setFocusEntityHandler, focusEntityInSceneView } from '../scene/sceneViewBus';
import { withWarnFilter } from '../scene/warnFilter';
import { mintEditor3DFrameKey, editor2DChromeFrameKey } from '../scene/frameKeys';
import { computeUIModeNDC, computeFullNDC, computeCamFrustumPositions, computeLetterbox, frameCameraToBox, gameAspectFromRect, createSelectGesture, outlineSourceGeometry, resolveFocusTarget } from '../scene/sceneViewMath';
import { sceneManager } from '../../runtime/scene/SceneManager';
import { PREFAB_EDIT_SCENE_PREFIX, PREFAB_EDIT_ROOT_GUID } from '../scene/prefabEdit';
import { pushAction } from '../undo/undoManager';
import { buildTransformUndoAction } from '../scene/gizmoUndo';
import { entityRef } from '../undo/entityRef';
import { notifyFieldEdited } from '../animation/recording';
import {
  parseColliderPoints, serializeColliderPoints, moveVertex, insertVertex, removeVertex,
  nearestEdgeInsertion, minPointsForShape, type Pt,
} from '../../runtime/scene/colliderPoints';
import { colliderEditInfo, worldPointToLocal, localToWorld, pickVertex, colliderPickHalfExtents } from './colliderEdit2D';
import { drawGizmo2D, hitTestGizmo2D, cursorForHandle, applyGizmoDrag2D, snapDragResult, DEFAULT_GIZMO_SNAP, worldToLocal2D, type GizmoHandle } from './Gizmo2D';
import { layoutText } from '../../runtime/rendering/text/layoutText';
import { getLoadedFont } from '../../runtime/rendering/text/fontAtlasLoader';
import { onTextDirty } from '../../runtime/rendering/text/textDirty';

/** The 2D gizmo box for a Text2D entity: the laid-out text block (px in Canvas2D
 *  units) as HALF-extents (the gizmo/outline convention — box is w*2×h*2), with the
 *  text's anchor as the pivot. Returns null if the entity isn't a visible Text2D or
 *  its font hasn't loaded yet (gizmo just waits a frame, like the text render does).
 *  Lets the 2D gizmo target text — it has a Transform but no Renderable2D box. */
function text2DGizmoBox(entity: { has: (t: unknown) => boolean; get: (t: unknown) => Record<string, unknown> } | null, text2dMeta: { trait: unknown } | undefined): { halfW: number; halfH: number; pivotX: number; pivotY: number } | null {
  if (!text2dMeta || !entity || !entity.has(text2dMeta.trait)) return null;
  const t = entity.get(text2dMeta.trait) as Record<string, unknown>;
  if (t.isVisible === false || !t.text) return null;
  const provider = getLoadedFont(t.font as string);
  if (!provider) return null;
  const layout = layoutText(provider, t.text as string, {
    fontSize: t.fontSize as number, maxWidth: (t.maxWidth as number) || 0,
    align: (t.align as 'left' | 'center' | 'right') ?? 'left',
    lineSpacing: (t.lineSpacing as number) ?? 1, letterSpacing: (t.letterSpacing as number) ?? 0,
  });
  return { halfW: layout.width / 2, halfH: layout.height / 2, pivotX: (t.anchorX as number) ?? 0.5, pivotY: (t.anchorY as number) ?? 0.5 };
}
import { pick2D, pick3D, type Pick2DCandidate, type Pick3DEntry } from './picking';
import { UIResizeOverlay } from './UIResizeOverlay';
import { UIFocusGraphOverlay } from './UIFocusGraphOverlay';
import { createViewportDirtyGate, useRearmDirtyOnChange } from './viewportDirtyGate';
import { mark2DDirty, get2DDirtyVersion, ensureCanvas2DListeners } from '../store/canvas2DDirty';
import { Canvas2DMount } from '../../runtime/rendering/Canvas2DMount';
import { editorCanvas2DPool, editorScene2DRenderer, editorMarkScene2DDirty } from '../rendering/editorScene2D';

// Bridge so the 2D Canvas overlay can raycast-pick 2.5D billboards. A billboard renders as a
// THREE mesh via the game camera in BOTH 3D and 2D mode, so its screen position is a 3D
// projection the Canvas2D AABB pick can't reproduce. ThreeJSViewport publishes this game-camera
// raycast while mounted; the 2D pointer handler calls it when its own pick2D misses. Null when
// no 3D viewport is mounted.
let _pickBillboardInUI: ((clientX: number, clientY: number) => number | null) | null = null;

// Reusable Three.js objects for SceneView render loop — avoids per-frame allocations
const _svCamPos = new THREE.Vector3();

// NB: resolveSprite / resolveDomImageUrl are deliberately called FRESH each frame in the draw
// loop below (not memoized). They must reflect mid-session edits that do NOT swap the world —
// a sprite RE-SLICE (registerSprite bumps getSpriteEpoch) and a texture RE-IMPORT (new
// content-hash cache-bust URL) both change the resolution live; a guid-keyed memo cleared only
// on onWorldSwap would serve a stale frame rect / URL until a scene reload. The runtime Scene2D
// keys its slots on getSpriteEpoch for exactly this reason; the per-frame cost here is a few
// map lookups + a small object, which is not worth a staleness bug in the editor preview.

// Per-rig weight-field memo (weight-view / heatmap overlay). Keyed by the ParsedRig2D object,
// which is REPLACED whenever the rig's weights change (setRig2D reseeds the cache), so the
// WeakMap invalidates automatically — a re-weight misses and recomputes, a static rig reuses
// the field instead of allocating new Array(vertCount) + rescanning every redraw.
const boneWeightFieldCache = new WeakMap<object, Map<number, number[]>>();
const dominantBoneFieldCache = new WeakMap<object, number[]>();
function boneWeightFieldCached(rig: ParsedRig2D, bi: number): number[] {
  let m = boneWeightFieldCache.get(rig);
  if (!m) { m = new Map(); boneWeightFieldCache.set(rig, m); }
  let f = m.get(bi);
  if (!f) { f = boneWeightField(rig.skinIndices, rig.skinWeights, bi, rig.vertCount); m.set(bi, f); }
  return f;
}
function dominantBoneFieldCached(rig: ParsedRig2D): number[] {
  let f = dominantBoneFieldCache.get(rig);
  if (!f) { f = dominantBoneField(rig.skinIndices, rig.skinWeights, rig.vertCount); dominantBoneFieldCache.set(rig, f); }
  return f;
}


/** True iff `obj` is part of `scene`'s ancestor chain — used as the gizmo's
 *  detach guard before render. `parent === null` alone misses the case where
 *  the immediate parent still exists but is itself orphaned (e.g. a disposed
 *  Group that was removed from the scene but the gizmo's target still
 *  references it). Cheap O(depth) walk. */
function objectReachesScene(obj: THREE.Object3D, scene: THREE.Scene): boolean {
  let cur: THREE.Object3D | null = obj;
  while (cur) {
    if (cur === scene) return true;
    cur = cur.parent;
  }
  return false;
}
/** Shared gizmo mode + space toggle buttons used in both 3D and 2D modes. */
function GizmoToolbar({ gizmoModes, gizmoMode, setGizmoMode, gizmoSpace, setGizmoSpace }: {
  gizmoModes: Array<{ value: 'translate' | 'rotate' | 'scale'; icon: string; key: string }>;
  gizmoMode: string;
  setGizmoMode: (mode: 'translate' | 'rotate' | 'scale') => void;
  gizmoSpace: string;
  setGizmoSpace: (space: 'local' | 'world') => void;
}) {
  return (
    <>
      <div style={{ width: 1, height: 18, background: '#444', margin: '0 6px' }} />
      {gizmoModes.map((m) => (
        <button key={m.value} onClick={() => setGizmoMode(m.value)}
          data-ui-id={`sceneView.toolbar.gizmo.${m.value}`} data-ui-kind="button" data-ui-label={m.value}
          style={{
          width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: gizmoMode === m.value ? '#2a1e1e' : 'none',
          border: `1px solid ${gizmoMode === m.value ? '#e74c3c' : '#333'}`,
          borderRadius: 3, color: gizmoMode === m.value ? '#e74c3c' : '#444',
          fontSize: '13px', cursor: 'pointer', padding: 0, lineHeight: 1,
        }} title={`${m.value} (${m.key.toUpperCase()})`}>{m.icon}</button>
      ))}
      <div style={{ width: 1, height: 18, background: '#444', margin: '0 6px' }} />
      <button onClick={() => setGizmoSpace(gizmoSpace === 'world' ? 'local' : 'world')}
        data-ui-id="sceneView.toolbar.gizmo.space" data-ui-kind="toggle" data-ui-label="gizmo space"
        style={{
        width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: gizmoSpace === 'local' ? '#2a1e1e' : 'none',
        border: `1px solid ${gizmoSpace === 'local' ? '#e74c3c' : '#333'}`,
        borderRadius: 3, color: gizmoSpace === 'local' ? '#e74c3c' : '#444',
        fontSize: '10px', cursor: 'pointer', padding: 0, lineHeight: 1, fontWeight: 'bold', fontFamily: 'monospace',
      }} title={`Space: ${gizmoSpace} (X)`}>{gizmoSpace === 'local' ? 'L' : 'G'}</button>
    </>
  );
}

/** Ground-grid visibility toggle (3D mode only — the grid is always hidden in UI
 *  mode). Renders its own leading divider so callers just drop it in. */
function GridButton({ showGrid, setShowGrid }: {
  showGrid: boolean;
  setShowGrid: (v: boolean) => void;
}) {
  return (
    <>
      <div style={{ width: 1, height: 18, background: '#444', margin: '0 6px' }} />
      <button onClick={() => setShowGrid(!showGrid)} title="Show/hide the ground grid (G)"
        data-ui-id="sceneView.toolbar.grid" data-ui-kind="toggle" data-ui-label="grid"
        style={{
        height: 24, padding: '0 8px', display: 'flex', alignItems: 'center', gap: 4,
        background: showGrid ? '#1e2630' : 'none',
        border: `1px solid ${showGrid ? '#5a9fd4' : '#444'}`,
        borderRadius: 3, color: showGrid ? '#5a9fd4' : '#666', fontSize: '10px',
        cursor: 'pointer', fontWeight: 'bold', fontFamily: 'monospace', lineHeight: 1,
      }}>▦ Grid</button>
    </>
  );
}

/** Show-all-colliders toggle. When on, the SceneView outlines EVERY Collider3D (not just
 *  the selected entity's) so generated/child colliders — field rim walls, fences — are
 *  visible for debugging without hunting entity-by-entity. */
function ColliderButton({ showColliders, setShowColliders }: {
  showColliders: boolean;
  setShowColliders: (v: boolean) => void;
}) {
  return (
    <button onClick={() => setShowColliders(!showColliders)} title="Show/hide all collider wireframes (C)"
      data-ui-id="sceneView.toolbar.colliders" data-ui-kind="toggle" data-ui-label="colliders"
      style={{
        height: 24, padding: '0 8px', display: 'flex', alignItems: 'center', gap: 4, marginLeft: 6,
        background: showColliders ? '#2a2618' : 'none',
        border: `1px solid ${showColliders ? '#e0a030' : '#444'}`,
        borderRadius: 3, color: showColliders ? '#e0a030' : '#666', fontSize: '10px',
        cursor: 'pointer', fontWeight: 'bold', fontFamily: 'monospace', lineHeight: 1,
      }}>◫ Colliders</button>
  );
}

/** Particle FX preview toggle. Shared between 3D and 2D modes — particles can
 *  appear in either (3D effects, 2D match-3 bursts), so both toolbars expose it.
 *  Renders its own leading divider so callers just drop it in. */
function FXButton({ particlePreview, setParticlePreview }: {
  particlePreview: boolean;
  setParticlePreview: (v: boolean) => void;
}) {
  return (
    <>
      <div style={{ width: 1, height: 18, background: '#444', margin: '0 6px' }} />
      <button onClick={() => setParticlePreview(!particlePreview)} title="Preview particle effects in the scene (P)"
        data-ui-id="sceneView.toolbar.fx-preview" data-ui-kind="toggle" data-ui-label="FX preview"
        style={{
        height: 24, padding: '0 8px', display: 'flex', alignItems: 'center', gap: 4,
        background: particlePreview ? '#2a1e2e' : 'none',
        border: `1px solid ${particlePreview ? '#e056fd' : '#444'}`,
        borderRadius: 3, color: particlePreview ? '#e056fd' : '#666', fontSize: '10px',
        cursor: 'pointer', fontWeight: 'bold', fontFamily: 'monospace', lineHeight: 1,
      }}>✦ FX</button>
    </>
  );
}

/** Toolbar toggle for on-canvas collider-mesh editing (Phase 4.3). Shown only when the
 *  selection has a polygon/mesh Collider2D; auto-clears the mode when it stops being
 *  editable (shape switched, selection changed to a box/circle, deselected). */
function ColliderEditButton() {
  const colliderEditMode = useEditorStore((s) => s.colliderEditMode);
  const setColliderEditMode = useEditorStore((s) => s.setColliderEditMode);
  const selectedId = useEditorStore((s) => s.selectedEntityId);
  let editable = false;
  if (selectedId != null) {
    const colMeta = getAllTraits().find((t) => t.name === 'Collider2D');
    const ent = colMeta ? findEntity(selectedId) : null;
    if (ent && colMeta && ent.has(colMeta.trait)) {
      const shape = (ent.get(colMeta.trait) as { shape: string }).shape;
      // Any point-list shape is editable (polygon/concave = 3, polyline = 2) — use the
      // single source of truth so new point-shapes never desync from this gate.
      editable = minPointsForShape(shape) !== null;
    }
  }
  useEffect(() => { if (!editable && colliderEditMode) setColliderEditMode(false); }, [editable, colliderEditMode, setColliderEditMode]);
  if (!editable) return null;
  return (
    <button onClick={() => setColliderEditMode(!colliderEditMode)}
      data-ui-id="sceneView.toolbar.collider-points" data-ui-kind="toggle" data-ui-label="collider points"
      title="Edit collider vertices: drag handles · double-click an edge to add · Alt/Cmd-click a handle to delete"
      style={{
        height: 24, padding: '0 8px', display: 'flex', alignItems: 'center', gap: 4,
        background: colliderEditMode ? '#12291f' : 'none',
        border: `1px solid ${colliderEditMode ? '#2effa6' : '#444'}`,
        borderRadius: 3, color: colliderEditMode ? '#2effa6' : '#888', fontSize: '10px',
        cursor: 'pointer', fontWeight: 'bold', fontFamily: 'monospace', lineHeight: 1,
      }}>⬟ Points</button>
  );
}

/** Toolbar toggle (UI mode) for the UIFocusable nav-graph overlay — arrows between
 *  focusables (explicit links + spatial fallback), focusOrder badges, autoFocus ring.
 *  Visualization only; state persists in localStorage via the store setter. */
function FocusGraphButton() {
  const showFocusGraph = useEditorStore((s) => s.showFocusGraph);
  const setShowFocusGraph = useEditorStore((s) => s.setShowFocusGraph);
  return (
    <button onClick={() => setShowFocusGraph(!showFocusGraph)}
      title="Show the UIFocusable navigation graph: solid = explicit navUp/Down/Left/Right link, dashed = spatial fallback the runtime would pick · number = focusOrder · gold ring = autoFocus"
      style={{
        height: 24, padding: '0 8px', display: 'flex', alignItems: 'center', gap: 4,
        background: showFocusGraph ? '#12291f' : 'none',
        border: `1px solid ${showFocusGraph ? '#2effa6' : '#444'}`,
        borderRadius: 3, color: showFocusGraph ? '#2effa6' : '#888', fontSize: '10px',
        cursor: 'pointer', fontWeight: 'bold', fontFamily: 'monospace', lineHeight: 1,
      }}>⇄ Focus</button>
  );
}

// Static gizmo mode list — hoisted to module scope so its identity is stable
// (no need to thread it through effect deps).
const gizmoModes: Array<{ value: 'translate' | 'rotate' | 'scale'; icon: string; key: string }> = [
  { value: 'translate', icon: '✥', key: 'w' },
  { value: 'rotate', icon: '↻', key: 'e' },
  { value: 'scale', icon: '⤡', key: 'r' },
];

/** Display name for a scene path: last segment minus the .json extension. */
function sceneDisplayName(path: string | null): string {
  if (!path) return 'Untitled';
  const seg = path.split('/').pop() || path;
  return seg.replace(/\.json$/i, '');
}

/** Breadcrumb shown at the left of the SceneView toolbar. Always shows the
 *  current scene name; in prefab-edit mode it becomes a clickable trail back to
 *  the scene the prefab was opened from. */
function SceneBreadcrumb({ onExitPrefab }: { onExitPrefab: () => void }) {
  const editingPrefab = useEditorStore((s) => s.editingPrefab);
  const returnScenePath = useEditorStore((s) => s.prefabReturnScenePath);
  // The current scene path is module-level (non-reactive) state in serialize.ts;
  // re-read it on every world swap so the name tracks scene loads.
  const [, bump] = useState(0);
  useEffect(() => onWorldSwap(() => bump((n) => n + 1)), []);
  // SceneManager holds the authoritative live-scene path (set on every load,
  // including the editor's startup restore which bypasses serialize.ts's
  // _currentScenePath). Use it so the name is correct regardless of load route.
  const scenePath = sceneManager.getCurrent()?.path ?? null;

  // Ground truth for prefab-edit mode is the LIVE scene being the synthetic
  // prefab-edit world — not just the editingPrefab flag, which can go stale if we
  // return to a real scene without an explicit exit (e.g. loading a scene directly
  // while the flag is set). A stale flag otherwise leaves the breadcrumb stuck
  // showing "← <prefab-edit-guid> › prefab" forever.
  const inPrefabEdit = !!editingPrefab && !!scenePath && scenePath.startsWith(PREFAB_EDIT_SCENE_PREFIX);
  useEffect(() => {
    if (editingPrefab && scenePath && !scenePath.startsWith(PREFAB_EDIT_SCENE_PREFIX)) {
      useEditorStore.getState().closePrefabEditor(); // self-heal a stale flag
    }
  }, [editingPrefab, scenePath]);

  const segStyle: CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 4, height: 24, padding: '0 6px',
    fontFamily: 'monospace', fontSize: '12px', whiteSpace: 'nowrap',
  };

  if (inPrefabEdit) {
    return (
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <button onClick={onExitPrefab} title="Back to scene" style={{
          ...segStyle, background: 'none', border: '1px solid #444', borderRadius: 3,
          color: '#aaa', cursor: 'pointer',
        }}>← {sceneDisplayName(returnScenePath)}</button>
        <span style={{ color: '#555', margin: '0 2px' }}>›</span>
        <span style={{ ...segStyle, color: '#e056fd', fontWeight: 'bold' }}
          title={editingPrefab.path}>🧩 {editingPrefab.name}</span>
      </div>
    );
  }
  return (
    <span style={{ ...segStyle, color: '#999' }} title={scenePath || undefined}>
      📄 {sceneDisplayName(scenePath)}
    </span>
  );
}

export default function SceneView() {
  // Mode lives in the editor store (init from localStorage there) so it's
  // agent-drivable (set-scene-view-mode) — the <select> below is native and can't
  // be operated by trusted input. The setter persists to localStorage + marks 2D dirty.
  const mode = useEditorStore((s) => s.sceneViewMode);
  const setMode = useEditorStore((s) => s.setSceneViewMode);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const [layers, setLayers] = useState({ show3D: true, show2D: true, showUI: true });
  const [showGrid, setShowGrid] = useState(true);
  const [showColliders, setShowColliders] = useState(false);
  const selectedId = useEditorStore((s) => s.selectedEntityId);
  const editingPrefab = useEditorStore((s) => s.editingPrefab);

  // Auto-select the viewport mode that can actually SHOW the prefab being edited.
  // The 3D viewport renders nothing for a UI prefab (layer:'ui') — the UI overlay
  // only draws in 'ui' mode — so opening a UI prefab in (default) 3D mode looked
  // empty. On entry to a UI-prefab edit, switch to UI mode; restore the prior mode
  // on exit (so returning to a 3D scene isn't left blank). A manual switch made
  // during the edit doesn't re-trigger this (keyed on editingPrefab only).
  useEffect(() => {
    if (!editingPrefab) return;
    if (!(sceneManager.getCurrent()?.path ?? '').startsWith(PREFAB_EDIT_SCENE_PREFIX)) return;
    let rootLayer = '';
    getCurrentWorld().query(EntityAttributes).updateEach(([ea]: Record<string, unknown>[]) => {
      if ((ea as Record<string, unknown>).guid === PREFAB_EDIT_ROOT_GUID) rootLayer = ((ea as Record<string, unknown>).layer as string) || '';
    });
    if (rootLayer !== 'ui') return;
    const prev = modeRef.current;
    setMode('ui');
    return () => setMode(prev); // restore when leaving this prefab-edit session
  }, [editingPrefab]);
  const toggleLayer = (key: 'show3D' | 'show2D' | 'showUI') => setLayers(prev => ({ ...prev, [key]: !prev[key] }));
  const gizmoMode = useEditorStore((s) => s.gizmoMode);
  const setGizmoMode = useEditorStore((s) => s.setGizmoMode);
  const gizmoSpace = useEditorStore((s) => s.gizmoSpace);
  const setGizmoSpace = useEditorStore((s) => s.setGizmoSpace);
  const particlePreview = useEditorStore((s) => s.particlePreview);
  const setParticlePreview = useEditorStore((s) => s.setParticlePreview);

  // Leave prefab-edit mode: reload the scene the prefab was opened from (it
  // re-instantiates every instance from the now-saved prefab file), then clear
  // the edit-mode state. Falls back to the last scene if no return path.
  const exitPrefabEdit = useCallback(async () => {
    const { prefabReturnScenePath, closePrefabEditor } = useEditorStore.getState();
    const target = prefabReturnScenePath ?? localStorage.getItem('modoki-last-scene');
    if (target) await loadScene(target);
    closePrefabEditor();
  }, []);
  // ── 2D mode viewport zoom/pan ──
  const viewportRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef({ zoom: 1, panX: 0, panY: 0 });
  const panDragRef = useRef<{ startX: number; startY: number; startPanX: number; startPanY: number } | null>(null);
  const [viewTransform, setViewTransform] = useState('none');
  const [viewZoom, setViewZoom] = useState(1);

  const updateViewTransform = useCallback(() => {
    const v = viewRef.current;
    setViewTransform(v.zoom === 1 && v.panX === 0 && v.panY === 0
      ? 'none'
      : `scale(${v.zoom}) translate(${v.panX}px, ${v.panY}px)`);
    setViewZoom(v.zoom);
  }, []);

  // Reset zoom/pan when leaving 2D mode
  useEffect(() => {
    if (mode !== 'ui') {
      viewRef.current = { zoom: 1, panX: 0, panY: 0 };
      setViewTransform('none');
      setViewZoom(1);
    }
  }, [mode]);

  // Wheel zoom + middle-mouse/alt pan handlers
  useEffect(() => {
    const container = viewportRef.current;
    if (!container || mode !== 'ui') return;

    function onWheel(e: WheelEvent) {
      e.preventDefault();
      e.stopPropagation();
      const rect = container!.getBoundingClientRect();
      const v = viewRef.current;
      // Cursor position relative to container (0..1)
      const cx = (e.clientX - rect.left) / rect.width;
      const cy = (e.clientY - rect.top) / rect.height;
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      const newZoom = Math.min(Math.max(v.zoom * factor, 1), 10);
      // Zoom toward cursor: keep cursor's content point fixed
      // Before: contentX = cx * containerW / oldZoom - panX
      // After:  contentX = cx * containerW / newZoom - newPanX
      // Set equal: newPanX = panX + cx * containerW * (1/newZoom - 1/oldZoom)
      const cW = rect.width, cH = rect.height;
      v.panX += cx * cW * (1 / newZoom - 1 / v.zoom);
      v.panY += cy * cH * (1 / newZoom - 1 / v.zoom);
      v.zoom = newZoom;
      // Reset pan when fully zoomed out
      if (newZoom === 1) { v.panX = 0; v.panY = 0; }
      updateViewTransform();
    }

    function onPointerDown(e: PointerEvent) {
      if (e.button === 2 && viewRef.current.zoom > 1) {
        const v = viewRef.current;
        panDragRef.current = { startX: e.clientX, startY: e.clientY, startPanX: v.panX, startPanY: v.panY };
        e.preventDefault();
        e.stopPropagation();
      }
    }
    function onPointerMove(e: PointerEvent) {
      if (!panDragRef.current) return;
      const v = viewRef.current;
      // Divide delta by zoom so pan speed matches content
      v.panX = panDragRef.current.startPanX + (e.clientX - panDragRef.current.startX) / v.zoom;
      v.panY = panDragRef.current.startPanY + (e.clientY - panDragRef.current.startY) / v.zoom;
      e.preventDefault();
      e.stopPropagation();
      updateViewTransform();
    }
    function onPointerUp(e: PointerEvent) {
      if (!panDragRef.current) return;
      panDragRef.current = null;
      e.preventDefault();
      e.stopPropagation();
    }

    container.addEventListener('wheel', onWheel, { passive: false });
    container.addEventListener('pointerdown', onPointerDown, { capture: true });
    container.addEventListener('pointermove', onPointerMove, { capture: true });
    container.addEventListener('pointerup', onPointerUp, { capture: true });
    return () => {
      container.removeEventListener('wheel', onWheel);
      container.removeEventListener('pointerdown', onPointerDown, { capture: true });
      container.removeEventListener('pointermove', onPointerMove, { capture: true });
      container.removeEventListener('pointerup', onPointerUp, { capture: true });
    };
  }, [mode, updateViewTransform]);

  // Show 2D overlay when a Canvas2D / Renderable2D entity is selected
  const selected2D = (() => {
    if (selectedId === null) return false;
    const entity = findEntity(selectedId);
    if (!entity) return false;
    if (entity.has(EntityAttributes)) {
      const layer = entity.get(EntityAttributes).layer;
      if (layer === '2d') return true;
    }
    // Also check Canvas2D entities (parent containers)
    const c2d = getAllTraits().find(t => t.name === 'Canvas2D');
    return !!(c2d && entity.has(c2d.trait));
  })();

  // Keyboard shortcuts (Unity convention: W=translate, E=rotate, R=scale, X=space)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      // These are BARE-key tools (W/E/R/X/F/P/…). A Cmd/Ctrl/Alt combo is an app or
      // OS accelerator (Cmd+R reload, Cmd+Shift+R force-reload, Cmd+W close, …) — let
      // it fall through instead of matching 'r'→scale and preventDefault-ing reload.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'x') { e.preventDefault(); setGizmoSpace(gizmoSpace === 'world' ? 'local' : 'world'); return; }
      if (k === 'f') {
        // Frame the selected entity in the orbit camera (3D mode only).
        if (mode === 'ui') return;
        const sel = useEditorStore.getState().selectedEntityId;
        if (sel === null) return;
        e.preventDefault();
        focusEntityInSceneView(sel);
        return;
      }
      if (k === 'p') { e.preventDefault(); setParticlePreview(!useEditorStore.getState().particlePreview); return; }
      if (k === 'g') { e.preventDefault(); setShowGrid((v) => !v); return; }
      if (k === 'c') { e.preventDefault(); setShowColliders((v) => !v); return; }
      if (k === 'home' || k === '0') {
        e.preventDefault();
        viewRef.current = { zoom: 1, panX: 0, panY: 0 };
        updateViewTransform();
        return;
      }
      const match = gizmoModes.find((m) => m.key === k);
      if (match) { e.preventDefault(); setGizmoMode(match.value); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [setGizmoMode, setGizmoSpace, gizmoSpace, setParticlePreview, mode, updateViewTransform]);

  const handleViewportContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
  }, []);

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Toolbar */}
      <div style={{
        height: 32, background: '#1e1e30', borderBottom: '1px solid #333',
        display: 'flex', alignItems: 'center', padding: '0 6px', flexShrink: 0,
        fontFamily: 'monospace', fontSize: '13px', gap: 3,
      }}>
        <SceneBreadcrumb onExitPrefab={exitPrefabEdit} />
        <div style={{ width: 1, height: 18, background: '#444', margin: '0 6px' }} />
        <select value={mode} onChange={(e) => setMode(e.target.value as '3d' | 'ui')} style={{
          background: '#1e1e30', color: '#ccc', border: '1px solid #555', borderRadius: 3,
          padding: '2px 6px', fontSize: '12px', fontFamily: 'monospace', fontWeight: 'bold', cursor: 'pointer',
        }}>
          <option value="3d">3D</option>
          <option value="ui">2D</option>
        </select>
        {/* Gizmo mode + space toggle (shared between 3D and 2D modes) */}
        <GizmoToolbar gizmoModes={gizmoModes} gizmoMode={gizmoMode} setGizmoMode={setGizmoMode} gizmoSpace={gizmoSpace} setGizmoSpace={setGizmoSpace} />
        <ColliderEditButton />
        {mode === '3d' && <>
          <FXButton particlePreview={particlePreview} setParticlePreview={setParticlePreview} />
          <GridButton showGrid={showGrid} setShowGrid={setShowGrid} />
          <ColliderButton showColliders={showColliders} setShowColliders={setShowColliders} />
        </>}
        {mode === 'ui' && <>
          <FXButton particlePreview={particlePreview} setParticlePreview={setParticlePreview} />
          <FocusGraphButton />
          <div style={{ width: 1, height: 18, background: '#444', margin: '0 6px' }} />
          {(['show3D', 'show2D', 'showUI'] as const).map((key, i) => {
            const colors = ['#3498db', '#2ecc71', '#f39c12'];
            const labels = ['3D', '2D', 'UI'];
            const c = layers[key] ? colors[i] : '#444';
            return (
              <button key={key} onClick={() => toggleLayer(key)} style={{
                width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: layers[key] ? `${c}22` : 'none',
                border: `1px solid ${c}`,
                borderRadius: 3, color: c, fontSize: '9px', cursor: 'pointer', padding: 0, lineHeight: 1,
                fontWeight: 'bold', fontFamily: 'monospace',
              }}>{labels[i]}</button>
            );
          })}
        </>}
      </div>
      {/* Viewport */}
      <div ref={viewportRef} onContextMenu={handleViewportContextMenu} style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <div style={{
          width: '100%', height: '100%',
          transform: viewTransform,
          transformOrigin: '0 0',
        }}>
          <ThreeJSViewport mode={mode} layers={layers} showGrid={showGrid} showColliders={showColliders} viewZoom={viewZoom} />
          {mode === 'ui' && (layers.showUI || layers.show2D) && <UIEditorOverlay viewZoom={viewZoom} showUI={layers.showUI} show2D={layers.show2D} selected2D={selected2D} />}
        </div>
      </div>
    </div>
  );
}



// ── 2D Canvas Overlay (DOM-based, replaces Three.js texture plane) ──

function useLetterboxBounds() {
  const gameRect = useEditorStore((s) => s.gameRect);
  const gameViewSize = useEditorStore((s) => s.gameViewSize);
  const [bounds, setBounds] = useState({ x: 0, y: 0, w: 0, h: 0 });

  useEffect(() => {
    // F15: resolve the viewport container ONCE per effect run (it's a stable DOM
    // node) instead of re-querying inside every `update` tick. The effect only
    // re-runs on gameRect/gameViewSize change; the ResizeObserver handles layout
    // changes via the cached `container` (reads clientWidth/Height, no requery).
    const container = document.querySelector('[data-scene-viewport]') as HTMLElement | null;
    if (!container) return;
    const update = () => {
      const cW = container.clientWidth;
      const cH = container.clientHeight;
      const fallback = (gameViewSize.width || 390) / (gameViewSize.height || 844);
      const gameAspect = gameAspectFromRect(gameRect, fallback);
      // Same letterbox math + integer rounding as the render-side scissor (F11).
      const { vpX, vpY, vpW, vpH } = computeLetterbox(cW, cH, gameAspect, /* round */ true);
      setBounds({ x: vpX, y: vpY, w: vpW, h: vpH });
    };
    update();
    // Defer observer-driven updates to the next frame: measuring + setBounds
    // synchronously inside the RO callback can re-lay-out within the same RO
    // cycle ("ResizeObserver loop completed with undelivered notifications").
    let pending = false;
    const observer = new ResizeObserver(() => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; update(); });
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [gameRect, gameViewSize]);

  return bounds;
}


/** Build a entityId→parentId map and the set of Canvas2D entity IDs for the
 *  current world. Used to route each Renderable2D to its owning Canvas2D. */
function buildCanvas2DRouting(): { parentOf: Map<number, number>; sortOrderOf: Map<number, number>; orderInLayerOf: Map<number, number>; canvasIds: Set<number> } {
  const allTraits = getAllTraits();
  const eaMeta = allTraits.find(t => t.name === 'EntityAttributes');
  const c2dMeta = allTraits.find(t => t.name === 'Canvas2D');
  const r2dMeta = allTraits.find(t => t.name === 'Renderable2D');
  const parentOf = new Map<number, number>();
  const sortOrderOf = new Map<number, number>();
  const orderInLayerOf = new Map<number, number>();
  const canvasIds = new Set<number>();
  if (eaMeta) {
    getCurrentWorld().query(eaMeta.trait).updateEach(([ea]: any[], entity: any) => {
      parentOf.set(entity.id(), ea.parentId || 0);
      sortOrderOf.set(entity.id(), ea.sortOrder || 0);
    });
  }
  if (r2dMeta) {
    getCurrentWorld().query(r2dMeta.trait).updateEach(([r]: any[], entity: any) => {
      if (r.orderInLayer) orderInLayerOf.set(entity.id(), r.orderInLayer);
    });
  }
  if (c2dMeta) {
    getCurrentWorld().query(c2dMeta.trait).updateEach((_: any, entity: any) => {
      canvasIds.add(entity.id());
    });
  }
  return { parentOf, sortOrderOf, orderInLayerOf, canvasIds };
}

// The routing only depends on the scene graph (parentId/sortOrder/Canvas2D set),
// which always bumps the 2D dirty version (any ECS write fires addDirtyListener →
// mark2DDirty; world swap does too). So memoize it by that version: the per-frame
// draw and — crucially — the per-`pointermove` HOVER hit-test reuse one build
// instead of allocating fresh maps every event over a static scene. (gizmos F3)
let _routingCache: { version: number; routing: ReturnType<typeof buildCanvas2DRouting> } | null = null;
function getCanvas2DRouting(): ReturnType<typeof buildCanvas2DRouting> {
  const version = get2DDirtyVersion();
  if (_routingCache && _routingCache.version === version) return _routingCache.routing;
  const routing = buildCanvas2DRouting();
  _routingCache = { version, routing };
  return routing;
}

// Paint order is a pure function of the routing (sortOrder DFS over the hierarchy), so it's
// invariant across sim-running redraws of a static scene — cache it by the same 2D dirty
// version instead of re-running the O(n) DFS every frame per Canvas2D layer (P4).
let _paintOrderCache: { version: number; order: Map<number, number> } | null = null;
function getPaintOrder(): Map<number, number> {
  const version = get2DDirtyVersion();
  if (_paintOrderCache && _paintOrderCache.version === version) return _paintOrderCache.order;
  const { sortOrderOf, parentOf, orderInLayerOf } = getCanvas2DRouting();
  const order = computePaintOrder(sortOrderOf, parentOf, orderInLayerOf.size ? orderInLayerOf : undefined);
  _paintOrderCache = { version, order };
  return order;
}

/** With every 2D pointer surface temporarily click-through, find the UI entity
 *  (if any) directly beneath a screen point. The 2D surfaces have
 *  `pointerEvents:'auto'` and sit ABOVE the DOM UI layer, so a transparent one
 *  swallows clicks meant for a UI element showing through it. When a 2D
 *  hit-test misses we re-resolve the element underneath and select that UI node,
 *  mirroring UINode's own `data-entity-id` click-to-select. Returns null when
 *  the point is over empty space (so the event still falls through to Three.js).
 *  Must neutralize BOTH the legacy DOM canvas (`data-2d-overlay`) AND the Pixi
 *  pick overlay div (`data-2d-pick`, Phase 2) — otherwise elementFromPoint returns
 *  the overlay itself, whose ancestor is the Canvas2D UINode wrapper (which carries
 *  `data-entity-id`), and every 2D miss would mis-select the Canvas2D root instead
 *  of falling through to deselect / Three.js / the true underlying UI child. */
function pickUnderlyingUIEntity(clientX: number, clientY: number): number | null {
  const surfaces = Array.from(document.querySelectorAll<HTMLElement>('canvas[data-2d-overlay], [data-2d-pick], [data-canvas2d-mount]'));
  const prev = surfaces.map((c) => c.style.pointerEvents);
  surfaces.forEach((c) => { c.style.pointerEvents = 'none'; });
  let el: Element | null = null;
  try { el = document.elementFromPoint(clientX, clientY); }
  finally { surfaces.forEach((c, i) => { c.style.pointerEvents = prev[i]; }); }
  const uiEl = el?.closest('[data-entity-id]') as HTMLElement | null;
  if (!uiEl) return null;
  const id = Number(uiEl.getAttribute('data-entity-id'));
  return Number.isFinite(id) ? id : null;
}

/** The editor's per-Canvas2D drawing surface. Inline-mounted INSIDE its UI-node
 *  div (via UINode's renderCanvas2D injection), so it fills that div and stacks
 *  by hierarchy/zIndex exactly like the runtime's Canvas2DMount — no separate
 *  overlay, no letterbox math, no z-index of its own. Still owns 2D entity
 *  drawing, picking, and the 2D transform gizmo. */
// ── 2D SceneView interaction (picking + gizmo/collider/paint drag) ──
// Extracted from Canvas2DLayer so BOTH the legacy DOM canvas AND the Pixi-migration pick overlay
// (Scene2DPickOverlay) install the SAME capture-phase handlers. The pick math is renderer-independent
// (ECS-driven); only the coordinate source differs (DOM draw-loop refs vs on-demand compute over the
// pooled Pixi canvas). See the 2D rendering section of docs/rendering.md.
type Gizmo2DDragState = {
  handle: GizmoHandle;
  entityId: number;
  startGamePos: { x: number; y: number };
  startTransform: { x: number; y: number; rz: number; sx: number; sy: number };
  localStart: { x: number; y: number; rz: number; sx: number; sy: number };
  parentWorld: { x: number; y: number; rz: number; sx: number; sy: number } | null;
  entityCenter: { x: number; y: number };
};
type Collider2DVertexDrag = { entityId: number; index: number; min: number; beforePoints: string; dirtied: boolean };
type SkinPaintStrokeState = { rigPath: string; beforeIdx: number[]; beforeW: number[] };
type PaintCursorState = { rootId: number; lx: number; ly: number; radius: number };
interface Scene2DInteractionRefs {
  dragRef: { current: Gizmo2DDragState | null };
  hoveredRef: { current: GizmoHandle | null };
  vertexDragRef: { current: Collider2DVertexDrag | null };
  skinPaintStrokeRef: { current: SkinPaintStrokeState | null };
  paintCursorRef: { current: PaintCursorState | null };
  lastEditClickRef: { current: { t: number; x: number; y: number } };
}
interface Scene2DInteractionScale { cs: ReturnType<typeof computeCanvasScale>; gizmoScreenScale: number; backingW: number; backingH: number }
interface Scene2DInteractionOpts {
  /** Element the capture-phase pointer listeners attach to + measure (DOM canvas or Pixi pick div). */
  getTargetEl: () => HTMLElement | null;
  /** Reference→backing scale + screen scale + backing pixel size, resolved per pointer event. */
  getScale: () => Scene2DInteractionScale;
  /** Interaction state refs (also read by the overlay draw path). */
  refs: Scene2DInteractionRefs;
  /** Wake the owning renderer's dirty gate after a live ECS write. */
  markDirty: () => void;
}

// Compute a Canvas2D's reference→backing scale from its Canvas2D trait + backing pixel size.
// Mirrors Canvas2DLayer's draw-loop scale computation, for the Pixi pick overlay (which has no draw
// loop feeding canvasScaleRef).
// A Canvas2D's reference resolution + scale mode (trait defaults), independent of any renderer.
// Used by computeScale2DFor AND the chrome overlay's boundary rect (which needs refW/refH).
function readCanvas2DRefDims(canvasEntityId: number, fallbackW: number, fallbackH: number): { refW: number; refH: number; scaleMode: 'fitW' | 'fitH' | 'fill' | 'none' } {
  let refW = fallbackW || 1, refH = fallbackH || 1;
  let scaleMode: 'fitW' | 'fitH' | 'fill' | 'none' = 'fitH';
  const c2dMeta = getAllTraits().find((t) => t.name === 'Canvas2D');
  const canvasEntity = findEntity(canvasEntityId);
  if (c2dMeta && canvasEntity?.has(c2dMeta.trait)) {
    const c2d = canvasEntity.get(c2dMeta.trait) as { referenceWidth?: number; referenceHeight?: number; scaleMode?: 'fitW' | 'fitH' | 'fill' | 'none' };
    refW = c2d.referenceWidth || 1080;
    refH = c2d.referenceHeight || 1920;
    scaleMode = c2d.scaleMode || 'fitH';
  }
  return { refW, refH, scaleMode };
}

// Install the capture-phase 2D pointer handlers on opts.getTargetEl(). Returns a cleanup fn.
// The body below is the interaction pipeline moved verbatim from Canvas2DLayer; the shims let it keep
// reading `canvasRef.current` / `canvasScaleRef.current` / `gizmoScreenScaleRef.current` unchanged.
function installScene2DInteraction(canvasEntityId: number, opts: Scene2DInteractionOpts): () => void {
  const { getScale, getTargetEl, refs, markDirty } = opts;
  const { dragRef, hoveredRef, vertexDragRef, skinPaintStrokeRef, paintCursorRef, lastEditClickRef } = refs;
  const selectEntity = useEditorStore.getState().selectEntity;
  const mark2DDirty = markDirty;
  const canvasRef = { get current(): HTMLElement | null { return getTargetEl(); } };
  const canvasScaleRef = { get current() { return getScale().cs; } };
  const gizmoScreenScaleRef = { get current() { return getScale().gizmoScreenScale; } };

  const container = getTargetEl();
  if (!container) return () => {};

    // Empty-canvas click → deselect, but a drag (e.g. a pan) keeps the selection. Same
    // deferred gesture as the 3D handler. The 2D canvas sits ABOVE the Three.js canvas, so
    // an empty click here does NOT bubble to the 3D onPointerDown that would otherwise
    // deselect — this canvas must clear the selection itself. (Armed only on a total miss
    // below; a gizmo/collider/paint interaction leaves it disarmed, so release() is a no-op.)
    const deselectGesture = createSelectGesture();

    function toGame(clientX: number, clientY: number) {
      const c = canvasRef.current;
      if (!c) return { x: 0, y: 0 };
      // Live backing size (DOM: draw loop keeps it current; Pixi: pooled canvas backing).
      const { cs, backingW, backingH } = getScale();
      return screenToReference2D(clientX, clientY, c.getBoundingClientRect(), backingW, backingH, cs);
    }

    // ── Collider-mesh editing (Phase 4.3) helpers ──
    // Resolve the selected entity's editable collider context (polygon/mesh), or null.
    function selectedColliderCtx() {
      const store = useEditorStore.getState();
      const selId = store.selectedEntityId;
      if (!store.colliderEditMode || selId === null) return null;
      const allTraits = getAllTraits();
      const transformMeta = allTraits.find((t) => t.name === 'Transform');
      const colMeta = allTraits.find((t) => t.name === 'Collider2D');
      if (!transformMeta || !colMeta) return null;
      const { parentOf, canvasIds } = getCanvas2DRouting();
      if (findCanvasAncestor(selId, parentOf, canvasIds) !== canvasEntityId) return null;
      const ent = findEntity(selId);
      if (!ent || !ent.has(colMeta.trait) || !ent.has(transformMeta.trait)) return null;
      const cdata = ent.get(colMeta.trait) as { shape: string; points: string };
      const info = colliderEditInfo(cdata);
      if (!info) return null;
      const wt = getWorldTransform2D(selId, ent.get(transformMeta.trait) as any);
      return { selId, colMeta, info, wt, currentPoints: cdata.points };
    }
    // Write a point list to the collider live (no undo entry) — used mid-drag + as the
    // apply step of a committed edit.
    function setPointsLive(entityId: number, colMeta: { trait: unknown }, str: string) {
      const ent = findEntity(entityId);
      if (!ent) return;
      ent.set(colMeta.trait as any, { ...(ent.get(colMeta.trait as any) as object), points: str });
      mark2DDirty();
    }
    // Commit a points edit (before→after) as one undo entry, applying `after` now.
    function commitPoints(entityId: number, colMeta: { trait: unknown }, beforeStr: string, afterPts: Pt[]) {
      const afterStr = serializeColliderPoints(afterPts);
      if (afterStr === beforeStr) { setPointsLive(entityId, colMeta, beforeStr); return; }
      setPointsLive(entityId, colMeta, afterStr);
      markOverrideIfInstance(entityId, 'Collider2D', 'points');
      notifyFieldEdited(entityId, 'Collider2D', 'points', afterStr);
      const ref = entityRef(entityId);
      pushAction({
        label: 'Edit Collider2D.points',
        undo: () => { const id = ref.resolve(); if (id != null) setPointsLive(id, colMeta, beforeStr); },
        redo: () => { const id = ref.resolve(); if (id != null) { setPointsLive(id, colMeta, afterStr); markOverrideIfInstance(id, 'Collider2D', 'points'); } },
      });
    }

    // ── Weight-paint brush (skin authoring) ──
    // Resolve the paint target: paint mode ON + a Bone2D selected + its rig-owner
    // SkinnedSprite2D uses the rig OPEN in the Skin panel. Returns the data to turn a
    // pointer position into a mesh-local brush + the bone index to paint.
    function resolveSkinPaint(): { rootId: number; rigPath: string; boneIndex: number; wt: { x: number; y: number; rz: number; sx: number; sy: number }; comp: { x: number; y: number }; flipX: boolean; flipY: boolean; bonePositions: number[][] } | null {
      const st = useEditorStore.getState();
      if (st.skinMode !== 'weights' || !st.editingSkinDef || !st.editingSkinAsset || st.selectedEntityId == null) return null;
      const allT = getAllTraits();
      const boneMeta = allT.find((t) => t.name === 'Bone2D');
      const ssM = allT.find((t) => t.name === 'SkinnedSprite2D');
      const eaM = allT.find((t) => t.name === 'EntityAttributes');
      const tfM = allT.find((t) => t.name === 'Transform');
      if (!boneMeta || !ssM || !eaM || !tfM) return null;
      const sel = findEntity(st.selectedEntityId);
      if (!sel?.has(boneMeta.trait)) return null;
      const boneName = (sel.get(boneMeta.trait) as { name: string }).name;
      let rootId = 0, cur = st.selectedEntityId;
      for (let g = 0; cur && g < 4096; g++) {
        const ent = findEntity(cur); if (!ent) break;
        if (ent.has(ssM.trait)) { rootId = cur; break; }
        cur = ent.has(eaM.trait) ? ((ent.get(eaM.trait) as { parentId: number }).parentId) : 0;
      }
      if (!rootId) return null;
      const rootEnt = findEntity(rootId)!;
      const ss = rootEnt.get(ssM.trait) as { rig: string; flipX: boolean; flipY: boolean };
      const openGuid = getGuidForPath(st.editingSkinAsset.path) ?? st.editingSkinDef.id;
      if (!openGuid || ss.rig !== openGuid) return null; // only paint the rig that's open
      const rig = getRig2D(ss.rig);
      const boneIndex = rig?.boneIndexByName.get(boneName);
      if (rig == null || boneIndex == null || boneIndex < 0) return null;
      const wt = getWorldTransform2D(rootId, rootEnt.get(tfM.trait) as never);
      const cs = canvasScaleRef.current;
      const bonePositions = deriveBindMatrices(rig.bones).rootLocal.map((m) => [m.e, m.f]);
      return { rootId, rigPath: st.editingSkinAsset.path, boneIndex, wt: { x: wt.x, y: wt.y, rz: wt.rz, sx: wt.sx, sy: wt.sy }, comp: { x: cs.compensateX || 1, y: cs.compensateY || 1 }, flipX: !!ss.flipX, flipY: !!ss.flipY, bonePositions };
    }

    // Pointer (game coords) → mesh-local (texture space): inverse of the entity draw transform.
    function paintLocalPos(px: number, py: number, target: NonNullable<ReturnType<typeof resolveSkinPaint>>): { x: number; y: number } | null {
      const dx = px - target.wt.x, dy = py - target.wt.y;
      const c = Math.cos(target.wt.rz), s = Math.sin(target.wt.rz);
      const rx = dx * c + dy * s, ry = -dx * s + dy * c;
      const sxTot = target.comp.x * target.wt.sx * (target.flipX ? -1 : 1);
      const syTot = target.comp.y * target.wt.sy * (target.flipY ? -1 : 1);
      if (!sxTot || !syTot) return null;
      return { x: rx / sxTot, y: ry / syTot };
    }

    function applyPaintStroke(px: number, py: number, target: ReturnType<typeof resolveSkinPaint>, brushMode: 'add' | 'subtract' | 'set') {
      if (!target) return;
      const lp = paintLocalPos(px, py, target);
      if (!lp) return;
      const lx = lp.x, ly = lp.y;
      const st = useEditorStore.getState();
      paintCursorRef.current = { rootId: target.rootId, lx, ly, radius: st.skinPaint.radius };
      const def = st.editingSkinDef;
      if (!def?.mesh?.verts?.length) return;
      const pb = getSkin2DBuffer(target.rootId)?.parts[0];
      const n = def.mesh.verts.length;
      const verts: number[][] = new Array(n);
      for (let v = 0; v < n; v++) verts[v] = pb ? [pb.positions[v * 2], pb.positions[v * 2 + 1]] : def.mesh.verts[v];
      const result = paintWeights({
        verts, skinIndices: def.skinIndices ?? [], skinWeights: def.skinWeights ?? [],
        boneIndex: target.boneIndex, center: [lx, ly], radius: st.skinPaint.radius, strength: st.skinPaint.strength,
        falloff: 'smooth', mode: brushMode, bonePositions: target.bonePositions,
      });
      st.applySkinDef(target.rigPath, { ...def, skinIndices: result.skinIndices, skinWeights: result.skinWeights });
      mark2DDirty();
    }

    function onPointerDown(e: PointerEvent) {
      deselectGesture.reset(); // a fresh press supersedes any stale pending deselect
      if (e.button !== 0) return;
      const { x: px, y: py } = toGame(e.clientX, e.clientY);

      // Weight-paint brush takes precedence when active (before collider/gizmo/selection).
      const paintTarget = resolveSkinPaint();
      if (paintTarget) {
        const def = useEditorStore.getState().editingSkinDef!;
        skinPaintStrokeRef.current = { rigPath: paintTarget.rigPath, beforeIdx: [...(def.skinIndices ?? [])], beforeW: [...(def.skinWeights ?? [])] };
        applyPaintStroke(px, py, paintTarget, e.altKey ? 'subtract' : useEditorStore.getState().skinPaint.brush);
        e.stopPropagation(); e.preventDefault(); return;
      }

      // Collider vertex editing takes precedence over gizmo/selection when active.
      const cc = selectedColliderCtx();
      if (cc) {
        const local = worldPointToLocal(px, py, cc.wt);
        const ss = gizmoScreenScaleRef.current;
        const threshold = 8 * ss / (Math.abs(cc.wt.sx) || 1); // ~8 screen px grab radius, in local units
        const hitIdx = pickVertex(local, cc.info.points, threshold);
        // Alt/Cmd-click a handle → delete that vertex (kept above the shape minimum).
        if (hitIdx >= 0 && (e.altKey || e.metaKey)) {
          commitPoints(cc.selId, cc.colMeta, cc.currentPoints, removeVertex(cc.info.points, hitIdx, cc.info.min));
          e.stopPropagation(); e.preventDefault(); return;
        }
        // Press on a handle → begin dragging it.
        if (hitIdx >= 0) {
          vertexDragRef.current = { entityId: cc.selId, index: hitIdx, min: cc.info.min, beforePoints: cc.currentPoints, dirtied: false };
          e.stopPropagation(); e.preventDefault(); return;
        }
        // Not on a handle. A click NEAR an edge is an edit interaction: a DOUBLE-click
        // (detected manually — see lastEditClickRef) inserts a vertex on that edge; the
        // single first click is swallowed so it can't deselect (edit mode stays sticky).
        // Clicks FAR from the shape fall through to normal selection.
        const near = nearestEdgeInsertion(cc.info.points, local.x, local.y, cc.info.closed);
        const localPerScreenPx = ss / (Math.abs(cc.wt.sx) || 1);
        if (near && near.distSq <= (40 * localPerScreenPx) ** 2) {
          const now = performance.now();
          const last = lastEditClickRef.current;
          const isDouble = now - last.t < 400 && Math.hypot(px - last.x, py - last.y) < 14 * localPerScreenPx;
          if (isDouble) {
            commitPoints(cc.selId, cc.colMeta, cc.currentPoints,
              insertVertex(cc.info.points, near.index, near.point.x, near.point.y));
            lastEditClickRef.current = { t: 0, x: 0, y: 0 }; // reset so a 3rd click isn't a new double
          } else {
            lastEditClickRef.current = { t: now, x: px, y: py };
          }
          e.stopPropagation(); e.preventDefault(); return;
        }
        // else fall through to normal selection
      }

      const allTraits = getAllTraits();
      const transformMeta = allTraits.find((t) => t.name === 'Transform');
      const r2dMeta = allTraits.find((t) => t.name === 'Renderable2D');
      const eaMeta2D = allTraits.find((t) => t.name === 'EntityAttributes');
      if (!transformMeta || !r2dMeta || !eaMeta2D) return;

      // Hit-testing uses THIS layer's coordinate transform, so only consider
      // entities routed to this Canvas2D.
      const { parentOf, canvasIds } = getCanvas2DRouting();
      const paintOrder = getPaintOrder();
      const ownedByThisCanvas = (id: number) => findCanvasAncestor(id, parentOf, canvasIds) === canvasEntityId;

      // First: try gizmo hit test on selected entity
      const selectedId = useEditorStore.getState().selectedEntityId;
      if (selectedId !== null && ownedByThisCanvas(selectedId)) {
        const entity = findEntity(selectedId);
        if (entity && entity.has(transformMeta.trait)) {
          // Gizmo works on any Transform target: Renderable2D (box), SkinnedSprite2D
          // (deformed-mesh AABB), or Bone2D (a point — rotate/translate to pose it).
          const ssMetaG = allTraits.find((t) => t.name === 'SkinnedSprite2D');
          const boneMetaG = allTraits.find((t) => t.name === 'Bone2D');
          let gw = 0, gh = 0, canGizmo = false;
          if (entity.has(r2dMeta.trait)) {
            const rend = entity.get(r2dMeta.trait); gw = rend.width; gh = rend.height; canGizmo = true;
          } else if (ssMetaG && entity.has(ssMetaG.trait)) {
            const buf = getSkin2DBuffer(entity.id());
            if (buf) for (const part of buf.parts) for (let i = 0; i < part.positions.length; i += 2) { gw = Math.max(gw, Math.abs(part.positions[i])); gh = Math.max(gh, Math.abs(part.positions[i + 1])); }
            canGizmo = true;
          } else if (boneMetaG && entity.has(boneMetaG.trait)) {
            gw = 4; gh = 4; canGizmo = true;
          } else {
            const tbox = text2DGizmoBox(entity, allTraits.find((t) => t.name === 'Text2D'));
            if (tbox) { gw = tbox.halfW; gh = tbox.halfH; canGizmo = true; }
          }
          if (canGizmo) {
            const tf = entity.get(transformMeta.trait);
            const { x: wx, y: wy, rz: wrz, sx: wsx, sy: wsy } = getWorldTransform2D(entity.id(), tf);
            const { gizmoMode, gizmoSpace } = useEditorStore.getState();
            const handle = hitTestGizmo2D(
              px, py,
              wx, wy, wrz, wsx, wsy,
              gw, gh, gizmoMode, gizmoSpace,
              gizmoScreenScaleRef.current,
            );
            if (handle) {
              // Parent's WORLD 2D transform (null at root) so the world-space drag
              // result can be mapped back to local (gizmos F1). worldTransforms holds
              // composed transforms for both 2D and 3D entities.
              const parentId = entity.has(eaMeta2D.trait) ? (entity.get(eaMeta2D.trait).parentId as number) : 0;
              const pwt = parentId ? worldTransforms.get(parentId) : null;
              dragRef.current = {
                handle,
                entityId: selectedId,
                startGamePos: { x: px, y: py },
                // WORLD start (gizmo math runs in world space); LOCAL start for undo.
                startTransform: { x: wx, y: wy, rz: wrz, sx: wsx, sy: wsy },
                localStart: { x: tf.x, y: tf.y, rz: tf.rz, sx: tf.sx, sy: tf.sy },
                parentWorld: pwt ? { x: pwt.x, y: pwt.y, rz: pwt.rz, sx: pwt.sx, sy: pwt.sy } : null,
                entityCenter: { x: wx, y: wy },
              };
              e.stopPropagation();
              e.preventDefault();
              return;
            }
          }
        }
      }

      // Bone2D handle pick — small screen-constant dots, tested BEFORE body picking so a
      // bone joint on top of its skinned mesh selects the bone, not the mesh.
      {
        const boneMetaP = allTraits.find((t) => t.name === 'Bone2D');
        if (boneMetaP) {
          const rGame = 7 * gizmoScreenScaleRef.current; // handle radius + slop, in game units
          let bestBone: number | null = null, bestBoneD = Infinity;
          getCurrentWorld().query(transformMeta.trait, boneMetaP.trait).updateEach(([tf]: any, entity: any) => {
            const eid = entity.id();
            if (deactivatedEntities.has(eid) || !ownedByThisCanvas(eid)) return;
            const { x: wx, y: wy } = getWorldTransform2D(eid, tf);
            const d = Math.hypot(px - wx, py - wy);
            if (d <= rGame && d < bestBoneD) { bestBoneD = d; bestBone = eid; }
          });
          if (bestBone !== null) { selectEntity(bestBone); e.stopPropagation(); e.preventDefault(); return; }
        }
      }

      // Second: entity selection hit test (axis-aligned bounding box)
      const colMetaPick = getAllTraits().find((t) => t.name === 'Collider2D');
      const candidates: Pick2DCandidate[] = [];
      getCurrentWorld().query(transformMeta.trait, r2dMeta.trait).updateEach(([tf, rend], entity) => {
        if (!rend.isVisible || deactivatedEntities.has(entity.id())) return;
        if (!ownedByThisCanvas(entity.id())) return;
        const { x: wx, y: wy, sx: wsx, sy: wsy } = getWorldTransform2D(entity.id(), tf);
        // Default: pick by the Renderable2D box (unchanged for image/primitive sprites).
        let width = rend.width, height = rend.height;
        let pivotX = rend.pivotX ?? 0.5, pivotY = rend.pivotY ?? 0.5;
        // Collider-fill entities have no meaningful Renderable2D box — the visible shape is
        // the collider — so pick by the collider's AABB instead. ONLY when sprite='collider'
        // AND a Collider2D is present; every other sprite is untouched.
        if (rend.sprite === COLLIDER_SPRITE && colMetaPick && entity.has(colMetaPick.trait)) {
          const b = colliderPickHalfExtents(entity.get(colMetaPick.trait) as never);
          if (b) { width = b.halfW; height = b.halfH; pivotX = 0.5; pivotY = 0.5; }
        }
        candidates.push({
          id: entity.id(),
          wx, wy, wsx, wsy,
          width, height, pivotX, pivotY,
          order: paintOrder.get(entity.id()) ?? 0,
        });
      });
      // SkinnedSprite2D bodies pick by their deformed-mesh AABB (they carry no Renderable2D).
      const ssMetaPick = allTraits.find((t) => t.name === 'SkinnedSprite2D');
      if (ssMetaPick) {
        getCurrentWorld().query(transformMeta.trait, ssMetaPick.trait).updateEach(([tf, ss]: any, entity: any) => {
          if (!ss.isVisible || deactivatedEntities.has(entity.id()) || !ownedByThisCanvas(entity.id())) return;
          const buf = getSkin2DBuffer(entity.id());
          if (!buf || !buf.parts[0]?.positions.length) return;
          const { x: wx, y: wy, sx: wsx, sy: wsy } = getWorldTransform2D(entity.id(), tf);
          // True AABB (matches the selection outline), not a symmetric ±max|·| — union all parts.
          let mnX = Infinity, mnY = Infinity, mxX = -Infinity, mxY = -Infinity;
          for (const part of buf.parts) for (let i = 0; i < part.positions.length; i += 2) {
            const vx = part.positions[i], vy = part.positions[i + 1];
            if (vx < mnX) mnX = vx; if (vx > mxX) mxX = vx;
            if (vy < mnY) mnY = vy; if (vy > mxY) mxY = vy;
          }
          const bw = mxX - mnX, bh = mxY - mnY;
          candidates.push({ id: entity.id(), wx, wy, wsx, wsy, width: bw / 2 || 20, height: bh / 2 || 20, pivotX: bw > 1e-6 ? -mnX / bw : 0.5, pivotY: bh > 1e-6 ? -mnY / bh : 0.5, order: paintOrder.get(entity.id()) ?? 0 });
        });
      }
      // Text2D bodies pick by their laid-out text block (they carry no Renderable2D) —
      // same box the gizmo/outline uses, so click-to-select matches what's drawn.
      const text2dMetaPick = allTraits.find((t) => t.name === 'Text2D');
      if (text2dMetaPick) {
        getCurrentWorld().query(transformMeta.trait, text2dMetaPick.trait).updateEach(([tf]: any, entity: any) => {
          const eid = entity.id();
          if (deactivatedEntities.has(eid) || !ownedByThisCanvas(eid)) return;
          const tbox = text2DGizmoBox(entity, text2dMetaPick);
          if (!tbox) return;
          const { x: wx, y: wy, sx: wsx, sy: wsy } = getWorldTransform2D(eid, tf);
          candidates.push({ id: eid, wx, wy, wsx, wsy, width: tbox.halfW, height: tbox.halfH, pivotX: tbox.pivotX, pivotY: tbox.pivotY, order: paintOrder.get(eid) ?? 0 });
        });
      }
      const bestId = pick2D(px, py, candidates);

      if (bestId !== null) {
        selectEntity(bestId);
        e.stopPropagation();
        e.preventDefault();
        return;
      }

      // No 2D entity here — but a 2.5D billboard (SkinnedSprite2D + Billboard3D) renders via the
      // 3D game camera even in 2D mode, so its screen hit is a raycast our AABB pick2D can't do.
      // This overlay sits ABOVE the 3D canvas, so the click never reaches the viewport's own
      // pick3D — ask the 3D viewport to raycast just the billboards under this game-cam ray.
      const bbId = _pickBillboardInUI?.(e.clientX, e.clientY);
      if (bbId != null) {
        selectEntity(bbId);
        e.stopPropagation();
        e.preventDefault();
        return;
      }

      // No 2D entity here. This canvas (pointerEvents:'auto') sits above the DOM
      // UI layer, so without this it would swallow clicks meant for a UI element
      // showing through the transparent canvas. Select the UI node beneath, if any.
      const uiId = pickUnderlyingUIEntity(e.clientX, e.clientY);
      if (uiId !== null) {
        selectEntity(uiId);
        e.stopPropagation();
        e.preventDefault();
        return;
      }
      // Nothing hit anywhere: arm a deferred deselect. A plain click clears the selection
      // on pointer-up; a drag (past the threshold) cancels it so a pan keeps the selection.
      deselectGesture.arm(e.clientX, e.clientY, null);
    }

    function onPointerMove(e: PointerEvent) {
      deselectGesture.move(e.clientX, e.clientY); // a drag past the threshold cancels a pending deselect
      const { x: px, y: py } = toGame(e.clientX, e.clientY);

      // Active weight-paint stroke — paint the selected bone's influence at the cursor.
      if (skinPaintStrokeRef.current) {
        e.stopPropagation(); e.preventDefault();
        applyPaintStroke(px, py, resolveSkinPaint(), e.altKey ? 'subtract' : useEditorStore.getState().skinPaint.brush);
        return;
      }
      // Paint-mode hover: track the brush cursor for the SceneView overlay (no paint yet).
      if (useEditorStore.getState().skinMode === 'weights') {
        const target = resolveSkinPaint();
        const lp = target ? paintLocalPos(px, py, target) : null;
        if (lp && target) { paintCursorRef.current = { rootId: target.rootId, lx: lp.x, ly: lp.y, radius: useEditorStore.getState().skinPaint.radius }; mark2DDirty(); }
        else if (paintCursorRef.current) { paintCursorRef.current = null; mark2DDirty(); }
      }

      // Active collider-vertex drag — move the vertex to the cursor (in collider-local
      // space) and preview live; the undo entry is pushed on pointer-up.
      if (vertexDragRef.current) {
        e.stopPropagation();
        e.preventDefault();
        const cc = selectedColliderCtx();
        const vd = vertexDragRef.current;
        if (cc && cc.selId === vd.entityId) {
          const local = worldPointToLocal(px, py, cc.wt);
          const next = moveVertex(cc.info.points, vd.index, local.x, local.y);
          setPointsLive(vd.entityId, cc.colMeta, serializeColliderPoints(next));
          vd.dirtied = true;
        }
        return;
      }

      if (dragRef.current) {
        e.stopPropagation();
        e.preventDefault();
        // Active drag — update transform. The gizmo math runs in WORLD space
        // (startTransform + entityCenter are world), then the world result is mapped
        // back into the parent's LOCAL frame so a PARENTED entity moves correctly
        // (gizmos F1). For a root entity (parentWorld null) world == local.
        const { handle, entityId, startGamePos, startTransform, parentWorld, entityCenter } = dragRef.current;
        const entity = findEntity(entityId);
        if (!entity || !entity.has(Transform)) return;

        const { gizmoSpace } = useEditorStore.getState();
        let worldDelta = applyGizmoDrag2D(
          handle, px, py, startGamePos.x, startGamePos.y, startTransform, entityCenter, gizmoSpace,
        );
        // Hold Shift to snap (F7): grid-snap translate / 15° rotate / 0.1 scale. Snapped
        // in WORLD space before the local conversion so the on-screen result lands on the
        // grid; an unmodified drag is unchanged.
        if (e.shiftKey) worldDelta = snapDragResult(worldDelta, DEFAULT_GIZMO_SNAP);
        const worldNew = { ...startTransform, ...worldDelta };
        const localNew = worldToLocal2D(worldNew, parentWorld);
        // Write only the fields this drag changed, taken from the localized result.
        const localDelta: Record<string, number> = {};
        for (const k of Object.keys(worldDelta) as (keyof typeof worldDelta)[]) localDelta[k] = localNew[k];
        entity.set(Transform, { ...entity.get(Transform), ...localDelta });
        mark2DDirty(); // Direct ECS write bypasses writeTraitField
        return;
      }

      // Not dragging — hover hit test for cursor (only for a selection this canvas owns)
      const selectedId = useEditorStore.getState().selectedEntityId;
      if (selectedId !== null) {
        const allTraits = getAllTraits();
        const transformMeta = allTraits.find((t) => t.name === 'Transform');
        const r2dMeta = allTraits.find((t) => t.name === 'Renderable2D');
        const { parentOf, canvasIds } = getCanvas2DRouting();
        if (transformMeta && r2dMeta && findCanvasAncestor(selectedId, parentOf, canvasIds) === canvasEntityId) {
          const entity = findEntity(selectedId);
          if (entity && entity.has(transformMeta.trait)) {
            const tf = entity.get(transformMeta.trait);
            let ghw = 0, ghh = 0, ok = false;
            if (entity.has(r2dMeta.trait)) { const rend = entity.get(r2dMeta.trait); ghw = rend.width; ghh = rend.height; ok = true; }
            else { const tbox = text2DGizmoBox(entity, allTraits.find((t) => t.name === 'Text2D')); if (tbox) { ghw = tbox.halfW; ghh = tbox.halfH; ok = true; } }
            if (ok) {
              const { gizmoMode, gizmoSpace } = useEditorStore.getState();
              const handle = hitTestGizmo2D(
                px, py, tf.x, tf.y, tf.rz, tf.sx, tf.sy,
                ghw, ghh, gizmoMode, gizmoSpace,
                gizmoScreenScaleRef.current,
              );
              hoveredRef.current = handle;
              if (canvasRef.current) canvasRef.current.style.cursor = cursorForHandle(handle);
              return;
            }
          }
        }
      }
      hoveredRef.current = null;
      if (canvasRef.current) canvasRef.current.style.cursor = 'default';
    }

    function onPointerUp(e: PointerEvent) {
      // Empty-canvas click (armed on a total miss, not cancelled by a drag) → deselect.
      // Only true when nothing else claimed this gesture, so it can't fire mid-drag/paint.
      if (deselectGesture.release().clicked) { selectEntity(null); return; }

      // Finish a weight-paint stroke → one undo entry (before→after weights).
      if (skinPaintStrokeRef.current) {
        e.stopPropagation(); e.preventDefault();
        const stroke = skinPaintStrokeRef.current;
        skinPaintStrokeRef.current = null;
        const def = useEditorStore.getState().editingSkinDef;
        if (def) {
          const afterIdx = [...(def.skinIndices ?? [])], afterW = [...(def.skinWeights ?? [])];
          const { rigPath, beforeIdx, beforeW } = stroke;
          const changed = afterW.length !== beforeW.length || afterW.some((w, i) => w !== beforeW[i]) || afterIdx.some((v, i) => v !== beforeIdx[i]);
          if (changed) pushAction({
            label: 'Paint weights',
            undo: () => { const d = useEditorStore.getState().editingSkinDef; if (d) useEditorStore.getState().applySkinDef(rigPath, { ...d, skinIndices: beforeIdx, skinWeights: beforeW }); },
            redo: () => { const d = useEditorStore.getState().editingSkinDef; if (d) useEditorStore.getState().applySkinDef(rigPath, { ...d, skinIndices: afterIdx, skinWeights: afterW }); },
          });
        }
        return;
      }

      // Finish a collider-vertex drag → one coalesced undo entry (before→after).
      if (vertexDragRef.current) {
        e.stopPropagation();
        e.preventDefault();
        const vd = vertexDragRef.current;
        vertexDragRef.current = null;
        if (vd.dirtied) {
          const colMeta = getAllTraits().find((t) => t.name === 'Collider2D');
          const ent = findEntity(vd.entityId);
          if (colMeta && ent?.has(colMeta.trait)) {
            const afterStr = (ent.get(colMeta.trait) as { points: string }).points;
            commitPoints(vd.entityId, colMeta, vd.beforePoints, parseColliderPoints(afterStr));
          }
        }
        return;
      }
      if (!dragRef.current) return;
      e.stopPropagation();
      e.preventDefault();
      const { entityId, localStart } = dragRef.current;
      const entity = findEntity(entityId);
      if (entity && entity.has(Transform)) {
        const tf = entity.get(Transform);
        const after = { x: tf.x, y: tf.y, rz: tf.rz, sx: tf.sx, sy: tf.sy };
        // before = the LOCAL transform at drag start (startTransform is world now).
        const before = { ...localStart };
        const eid = entityId;
        // Capture a guid-based ref and re-resolve inside the closures: a captured
        // koota handle (or raw id) goes stale if the entity is deleted/restored or
        // the world is rebuilt (Play→Stop). The ref tolerates all three.
        const ref = entityRef(eid);
        pushAction(buildTransformUndoAction({
          label: `Transform "${entity.name || `Entity ${eid}`}"`,
          trait: Transform, resolve: () => ref.resolve(), findEntity, before, after,
          entityGuid: ref.guid || String(eid),
        }));
        // Record mode: a gizmo drag writes Transform via direct entity.set (above),
        // which bypasses writeTraitField → the animation record hook never sees it.
        // Notify it for the fields that actually moved (no-op when not recording).
        for (const k of Object.keys(after) as (keyof typeof after)[]) {
          if (!Object.is(before[k], after[k])) {
            notifyFieldEdited(eid, 'Transform', k, after[k]);
            // Record a deliberate override on a prefab-instance member, same as an
            // inspector edit — otherwise override capture can't tell this gizmo edit
            // from a stale-inherited field and (post-fix) would drop it on save.
            markOverrideIfInstance(eid, 'Transform', k);
          }
        }
      }
      dragRef.current = null;
    }

    container.addEventListener('pointerdown', onPointerDown, { capture: true });
    container.addEventListener('pointermove', onPointerMove, { capture: true });
    container.addEventListener('pointerup', onPointerUp, { capture: true });
    return () => {
      container.removeEventListener('pointerdown', onPointerDown, { capture: true });
      container.removeEventListener('pointermove', onPointerMove, { capture: true });
      container.removeEventListener('pointerup', onPointerUp, { capture: true });
    };
}

interface Scene2DDrawOpts {
  cs: ReturnType<typeof computeCanvasScale>;
  refW: number; refH: number;
  gizmoScreenScaleRef: { current: number };
  showBoundaryRef: { current: boolean };
  paintCursorRef: { current: PaintCursorState | null };
  hoveredRef: { current: GizmoHandle | null };
  gizmo2DHandleStateRef: { current: { tf: { x: number; y: number; rz: number; sx: number; sy: number }; w: number; h: number; mode: 'translate' | 'rotate' | 'scale'; space: 'world' | 'local'; s: number } | null };
}

// Draw one Canvas2D's editor OVERLAYS (boundary, bones, selection outline, gizmo, collider outline/
// handles, skin-debug wireframe/heatmap/paint-cursor) into a ctx already sized to backing + cleared.
// The 2D CONTENT (sprites, skinned mesh) is drawn by the Pixi Scene2DRenderer underneath; this chrome
// canvas stacks the editor-only overlays on top. (Was shared with the now-deleted DOM Canvas2DLayer.)
function drawScene2D(ctx: CanvasRenderingContext2D, canvasEntityId: number, o: Scene2DDrawOpts): void {
  const { cs, refW, refH, gizmoScreenScaleRef, showBoundaryRef, paintCursorRef, hoveredRef, gizmo2DHandleStateRef } = o;
  const allTraits = getAllTraits();
  const transformMeta = allTraits.find((t) => t.name === 'Transform');
  const r2dMeta = allTraits.find((t) => t.name === 'Renderable2D');
  const colMetaDraw = allTraits.find((t) => t.name === 'Collider2D');
  if (!transformMeta || !r2dMeta) return;
  const { parentOf, canvasIds } = getCanvas2DRouting();
  const paintOrder = getPaintOrder();
      ctx.save();
      ctx.translate(cs.offsetX, cs.offsetY);
      ctx.scale(cs.scaleX, cs.scaleY);

      // Draw canvas boundary rectangle when a 2D entity belonging to THIS canvas
      // is selected, so the highlight lands on the right region.
      const selForBoundary = useEditorStore.getState().selectedEntityId;
      const boundaryOwned = selForBoundary !== null
        && findCanvasAncestor(selForBoundary, parentOf, canvasIds) === canvasEntityId;
      if (showBoundaryRef.current && boundaryOwned) {
        const bs = gizmoScreenScaleRef.current;
        ctx.strokeStyle = '#4a9eff';
        ctx.lineWidth = 2 * bs;
        ctx.setLineDash([6 * bs, 4 * bs]);
        ctx.strokeRect(0, 0, refW, refH);
        ctx.setLineDash([]);
      }

      const currentSelectedId = useEditorStore.getState().selectedEntityId;
      let selectedTf: { x: number; y: number; rz: number; sx: number; sy: number } | null = null as any;
      let selectedW = 20, selectedH = 20;
      let selectedPivotX = 0.5, selectedPivotY = 0.5;

      // Collect this canvas's entities, then paint in hierarchy order (sortOrder
      // DFS) so the editor stacks 2D exactly like the runtime PixiJS layer.
      const drawOrder: number[] = [];
      getCurrentWorld().query(transformMeta.trait, r2dMeta.trait).updateEach(([, rend]: any, entity: any) => {
        if (!rend.isVisible || deactivatedEntities.has(entity.id())) return;
        if (findCanvasAncestor(entity.id(), parentOf, canvasIds) !== canvasEntityId) return;
        drawOrder.push(entity.id());
      });
      drawOrder.sort((a, b) => (paintOrder.get(a) ?? 0) - (paintOrder.get(b) ?? 0));
      for (const eid of drawOrder) {
        const entity = findEntity(eid);
        if (!entity) continue;
        const tf = entity.get(transformMeta.trait) as any;
        const rend = entity.get(r2dMeta.trait) as any;
        const { x, y, rz, sx, sy } = getWorldTransform2D(eid, tf);
        // The Renderable2D CONTENT is drawn by the Pixi renderer (Scene2DRenderer); this chrome pass
        // only needs the selection-target capture below so the gizmo + outline resolve for a selection.
        if (eid === currentSelectedId) {
          selectedTf = { x, y, rz, sx, sy };
          selectedW = rend.width;
          selectedH = rend.height;
          selectedPivotX = rend.pivotX ?? 0.5;
          selectedPivotY = rend.pivotY ?? 0.5;
        }
      }

      // ── Zone2D editor wireframe — an editor-ONLY dashed outline of every 2D trigger area
      //    (Zone2D) in THIS canvas, so a human can see + position it with the transform gizmo.
      //    Never drawn in the built game (the zone2D trigger system reads the Transform). Draws
      //    ALL zones (not just the selected one), mirroring the Zone3D SceneView gizmo. The
      //    outline matches the zone2DSystem containment exactly: circle radius = sx; box full
      //    size = scale (half-extents sx/2, sy/2); capsule = vertical pill radius sx, height sy. ──
      const zone2dMeta = allTraits.find((t) => t.name === 'Zone2D');
      if (zone2dMeta) {
        const ss = gizmoScreenScaleRef.current;
        getCurrentWorld().query(zone2dMeta.trait, transformMeta.trait).updateEach(([zone]: any, entity: any) => {
          const eid = entity.id();
          if (deactivatedEntities.has(eid)) return;
          if (findCanvasAncestor(eid, parentOf, canvasIds) !== canvasEntityId) return;
          const wt = getWorldTransform2D(eid, entity.get(transformMeta.trait) as any);
          const r = Math.abs(wt.sx) || 1e-3;                 // radius (circle/capsule) = |sx|
          const hx = Math.abs(wt.sx) / 2, hy = Math.abs(wt.sy) / 2;
          ctx.save();
          ctx.translate(wt.x, wt.y);
          ctx.rotate(wt.rz);
          ctx.strokeStyle = '#' + ((zone.color & 0xffffff) >>> 0).toString(16).padStart(6, '0');
          ctx.globalAlpha = 0.8;
          ctx.lineWidth = 1.5 * ss;
          ctx.setLineDash([5 * ss, 4 * ss]);
          ctx.beginPath();
          if (zone.shape === 'box') {
            ctx.rect(-hx, -hy, hx * 2, hy * 2);
          } else if (zone.shape === 'capsule') {
            const seg = Math.max(0, hy - r);                 // segment half-length (caps add r each end)
            ctx.moveTo(r, -seg);
            ctx.lineTo(r, seg);
            ctx.arc(0, seg, r, 0, Math.PI, false);           // bottom cap
            ctx.lineTo(-r, -seg);
            ctx.arc(0, -seg, r, Math.PI, Math.PI * 2, false); // top cap
            ctx.closePath();
          } else {
            ctx.arc(0, 0, r, 0, Math.PI * 2);                // circle
          }
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.restore();
        });
      }

      // ── SkinnedSprite2D deformable-mesh preview. Mirrors the runtime GameView mesh
      //    pass but drawn with Canvas2D affine texture-mapped triangles, reading the SAME
      //    live buffer skin2DSystem wrote (the editor runs the pipeline too). ──
      const ssMeta = allTraits.find((t) => t.name === 'SkinnedSprite2D');
      const bone2dMeta = allTraits.find((t) => t.name === 'Bone2D');
      // Which SkinnedSprite2D (if any) shows its mesh wireframe: the selected rig root, or
      // the rig owning the selected Bone2D — an authoring aid so tessellation density +
      // deformation are visible while editing the rig.
      let wireframeRootId: number | null = null;
      if (ssMeta && currentSelectedId !== null) {
        let cur = currentSelectedId;
        for (let g = 0; cur && g < 4096; g++) {
          const ent = findEntity(cur);
          if (!ent) break;
          if (ent.has(ssMeta.trait)) { wireframeRootId = cur; break; }
          cur = ent.has(EntityAttributes) ? (ent.get(EntityAttributes).parentId as number) : 0;
        }
      }
      // When a Bone2D is selected, overlay ITS influence as a weight heatmap on its rig.
      let heatmapBoneName: string | null = null;
      if (bone2dMeta && currentSelectedId !== null) {
        const sel = findEntity(currentSelectedId);
        if (sel?.has(bone2dMeta.trait)) heatmapBoneName = (sel.get(bone2dMeta.trait) as { name: string }).name || null;
      }
      if (ssMeta) {
        getCurrentWorld().query(transformMeta.trait, ssMeta.trait).updateEach(([tf, ss]: any, entity: any) => {
          const eid = entity.id();
          if (!ss.isVisible || deactivatedEntities.has(eid)) return;
          if (findCanvasAncestor(eid, parentOf, canvasIds) !== canvasEntityId) return;
          const buf = getSkin2DBuffer(eid);
          const p0 = buf?.parts[0];
          if (!buf || !p0 || p0.positions.length === 0) return;
          const wt = getWorldTransform2D(eid, tf);
          const color = '#' + (ss.color & 0xffffff).toString(16).padStart(6, '0');
          ctx.save();
          ctx.globalAlpha = typeof ss.opacity === 'number' ? Math.min(1, Math.max(0, ss.opacity)) : 1;
          ctx.translate(wt.x, wt.y);
          ctx.rotate(wt.rz);
          ctx.scale(cs.compensateX * wt.sx * (ss.flipX ? -1 : 1), cs.compensateY * wt.sy * (ss.flipY ? -1 : 1));
          const weightView = eid === wireframeRootId && useEditorStore.getState().skinWeightView;
          if (weightView) {
            // Weight view: opaque heatmap (selected bone) / dominant-bone map (no bone),
            // NO texture — the clear way to read weights. Authoring aid on the primary part
            // (multi-part per-part weight editing is a follow-up).
            const rig = getRig2D(ss.rig);
            if (rig && rig.vertCount > 0) {
              const bi = heatmapBoneName ? rig.boneIndexByName.get(heatmapBoneName) : undefined;
              if (bi != null && bi >= 0) {
                drawWeightHeatmap2D(ctx, p0.positions, p0.indices, boneWeightFieldCached(rig, bi), 1);
              } else {
                drawDominantBoneMap2D(ctx, p0.positions, p0.indices, dominantBoneFieldCached(rig), 1);
              }
            } else {
              drawSkinnedMeshFlat2D(ctx, p0.positions, p0.indices, color);
            }
          } else {
            // The textured mesh is drawn by the Pixi renderer; this chrome pass draws only the overlays.
            // Semi-transparent heatmap overlay for the selected bone (over the primary part).
            if (eid === wireframeRootId && heatmapBoneName) {
              const rig = getRig2D(ss.rig);
              const bi = rig?.boneIndexByName.get(heatmapBoneName);
              if (rig && bi != null && bi >= 0) {
                drawWeightHeatmap2D(ctx, p0.positions, p0.indices, boneWeightFieldCached(rig, bi));
              }
            }
          }
          if (eid === wireframeRootId) {
            const lw = gizmoScreenScaleRef.current / Math.max(0.01, Math.abs(cs.compensateX * wt.sx));
            // Magenta wireframe — deliberately NOT the spring-green (#2effa6) used by the
            // collider outline and, crucially, distinct from the rotate gizmo's teal ring
            // (#1abc9c), which is near-identical in hue and made the two hard to tell apart.
            for (const part of buf.parts) drawSkinnedMeshWireframe2D(ctx, part.positions, part.indices, 'rgba(255,64,180,0.85)', lw);
          }
          // Weight-paint brush cursor (in mesh-local space, so it scales with the mesh).
          const pc = paintCursorRef.current;
          if (pc && pc.rootId === eid) {
            ctx.save();
            ctx.globalAlpha = 1;
            ctx.beginPath();
            ctx.arc(pc.lx, pc.ly, pc.radius, 0, Math.PI * 2);
            ctx.lineWidth = gizmoScreenScaleRef.current / Math.max(0.01, Math.abs(cs.compensateX * wt.sx));
            ctx.strokeStyle = 'rgba(255,255,255,0.9)';
            ctx.stroke();
            ctx.restore();
          }
          ctx.restore();
          if (eid === currentSelectedId) {
            let mnX = Infinity, mnY = Infinity, mxX = -Infinity, mxY = -Infinity;
            for (const part of buf.parts) for (let i = 0; i < part.positions.length; i += 2) {
              const vx = part.positions[i], vy = part.positions[i + 1];
              if (vx < mnX) mnX = vx; if (vx > mxX) mxX = vx;
              if (vy < mnY) mnY = vy; if (vy > mxY) mxY = vy;
            }
            // TRUE AABB of the deformed mesh — NOT a symmetric ±max|·|, which grew the box
            // in BOTH directions when a bone was posed asymmetrically (moving `base` down
            // made the box taller upward too). Express [mn,mx] via the pivot: the outline
            // draws [ox, ox+2w] with ox = -w·2·pivot (computePivotOffset), so w = (mx-mn)/2
            // and pivot = -mn/(mx-mn) place its edges exactly on mn and mx.
            if (mxX >= mnX) {
              const bw = mxX - mnX, bh = mxY - mnY;
              selectedTf = { x: wt.x, y: wt.y, rz: wt.rz, sx: wt.sx, sy: wt.sy };
              selectedW = bw / 2 || 20; selectedH = bh / 2 || 20;
              selectedPivotX = bw > 1e-6 ? -mnX / bw : 0.5;
              selectedPivotY = bh > 1e-6 ? -mnY / bh : 0.5;
            }
          }
        });
      }

      // ── Bone2D overlay: child→parent connecting lines + joint handles, so the 2D
      //    skeleton is visible + click-selectable in SceneView. Screen-constant sizing. ──
      if (bone2dMeta) {
        const bss = gizmoScreenScaleRef.current;
        const bonePos = new Map<number, { x: number; y: number; rz: number; sx: number; sy: number }>();
        getCurrentWorld().query(transformMeta.trait, bone2dMeta.trait).updateEach(([tf]: any, entity: any) => {
          const eid = entity.id();
          if (deactivatedEntities.has(eid)) return;
          if (findCanvasAncestor(eid, parentOf, canvasIds) !== canvasEntityId) return;
          const wt = getWorldTransform2D(eid, tf);
          bonePos.set(eid, { x: wt.x, y: wt.y, rz: wt.rz, sx: wt.sx, sy: wt.sy });
        });
        if (bonePos.size) {
          ctx.save();
          ctx.strokeStyle = 'rgba(120,200,255,0.75)';
          ctx.lineWidth = 1.5 * bss;
          ctx.setLineDash([]);
          for (const [eid, p] of bonePos) {
            const ent = findEntity(eid);
            const pid = ent?.has(EntityAttributes) ? (ent.get(EntityAttributes).parentId as number) : 0;
            const pp = pid ? bonePos.get(pid) : undefined;
            if (pp) { ctx.beginPath(); ctx.moveTo(pp.x, pp.y); ctx.lineTo(p.x, p.y); ctx.stroke(); }
          }
          const r = 5 * bss;
          for (const [eid, p] of bonePos) {
            const sel = eid === currentSelectedId;
            ctx.beginPath();
            ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
            ctx.fillStyle = sel ? '#f1c40f' : '#4a9eff';
            ctx.fill();
            ctx.lineWidth = 1.5 * bss;
            ctx.strokeStyle = '#0a0a0a';
            ctx.stroke();
            if (sel) {
              selectedTf = { x: p.x, y: p.y, rz: p.rz, sx: p.sx, sy: p.sy };
              selectedW = 4; selectedH = 4; selectedPivotX = 0.5; selectedPivotY = 0.5;
            }
          }
          ctx.restore();
        }
      }

      // Text2D has a Transform but no Renderable2D box, so the query loop above never
      // captures it — resolve its gizmo target from the laid-out text block here.
      if (!selectedTf && currentSelectedId !== null) {
        const t2dMeta = allTraits.find((t) => t.name === 'Text2D');
        const selEnt = t2dMeta ? findEntity(currentSelectedId) : null;
        if (selEnt && selEnt.has(transformMeta.trait)
            && findCanvasAncestor(currentSelectedId, parentOf, canvasIds) === canvasEntityId) {
          const tbox = text2DGizmoBox(selEnt, t2dMeta);
          if (tbox) {
            const wt = getWorldTransform2D(currentSelectedId, selEnt.get(transformMeta.trait) as never);
            selectedTf = { x: wt.x, y: wt.y, rz: wt.rz, sx: wt.sx, sy: wt.sy };
            selectedW = tbox.halfW; selectedH = tbox.halfH;
            selectedPivotX = tbox.pivotX; selectedPivotY = tbox.pivotY;
          }
        }
      }

      // Draw selection outline + 2D gizmo for selected entity.
      // Both are drawn in canvas-scale space (not entity-local), so they
      // stay constant screen-size regardless of zoom and entity scale.
      if (currentSelectedId !== null && selectedTf) {
        const ss = gizmoScreenScaleRef.current;
        const { x: ex, y: ey, rz: erz, sx: esx, sy: esy } = selectedTf;
        const { ox, oy } = computePivotOffset(selectedW, selectedH, selectedPivotX, selectedPivotY);
        ctx.save();
        ctx.translate(ex, ey);
        ctx.rotate(erz);
        ctx.scale(esx, esy);
        const lw = ss / Math.abs(esx || 1);
        ctx.strokeStyle = '#f1c40f';
        ctx.lineWidth = 2 * lw;
        const pad = 3 * lw;
        ctx.strokeRect(ox - pad, oy - pad, selectedW * 2 + pad * 2, selectedH * 2 + pad * 2);
        ctx.restore();
      }

      // Gizmo + editable-collider handles are hidden while editing collider vertices.
      const colliderEditing = useEditorStore.getState().colliderEditMode;

      // ── Collider outline for the selected entity (ANY shape) — a read-only green
      //    silhouette so collision-vs-visual is visible on selection. Drawn with the
      //    entity's world position+rotation but NO scale (colliders are unscaled world
      //    units). colliderEditMode draws its own outline+handles below for editable
      //    shapes, so skip then to avoid a double draw. ──
      if (currentSelectedId !== null && !colliderEditing && colMetaDraw
          && findCanvasAncestor(currentSelectedId, parentOf, canvasIds) === canvasEntityId) {
        const selEnt = findEntity(currentSelectedId);
        if (selEnt?.has(colMetaDraw.trait) && selEnt.has(transformMeta.trait)) {
          const wt = getWorldTransform2D(currentSelectedId, selEnt.get(transformMeta.trait) as any);
          const ss = gizmoScreenScaleRef.current;
          ctx.save();
          ctx.translate(wt.x, wt.y);
          ctx.rotate(wt.rz);   // position + rotation only (colliders are unscaled)
          drawColliderOutline(ctx, selEnt.get(colMetaDraw.trait) as never,
            { color: '#2effa6', width: 1.5 * ss, dash: [5 * ss, 4 * ss] });
          ctx.restore();
        }
      }

      // Gizmo is hidden while editing collider vertices (they share the canvas + drags).
      if (currentSelectedId !== null && selectedTf && !colliderEditing) {
        const { gizmoMode, gizmoSpace } = useEditorStore.getState();
        drawGizmo2D(
          ctx,
          selectedTf.x, selectedTf.y, selectedTf.rz, selectedTf.sx, selectedTf.sy,
          selectedW, selectedH,
          gizmoMode, gizmoSpace,
          hoveredRef.current,
          gizmoScreenScaleRef.current,
        );
        // Enact: snapshot the drawn gizmo's geometry for the handle provider (below).
        gizmo2DHandleStateRef.current = { tf: { ...selectedTf }, w: selectedW, h: selectedH, mode: gizmoMode, space: gizmoSpace, s: gizmoScreenScaleRef.current };
      } else {
        gizmo2DHandleStateRef.current = null;
      }

      // ── Collider-mesh vertex handles (Phase 4.3) — draw the polygon/mesh outline of the
      //    selected entity + a square handle per vertex, screen-constant size. ──
      if (currentSelectedId !== null && colliderEditing
          && findCanvasAncestor(currentSelectedId, parentOf, canvasIds) === canvasEntityId) {
        const colMeta = allTraits.find((t) => t.name === 'Collider2D');
        const selEnt = findEntity(currentSelectedId);
        if (colMeta && selEnt?.has(colMeta.trait) && selEnt.has(transformMeta.trait)) {
          const info = colliderEditInfo(selEnt.get(colMeta.trait) as { shape: string; points: string });
          if (info) {
            const wt = getWorldTransform2D(currentSelectedId, selEnt.get(transformMeta.trait) as any);
            const ss = gizmoScreenScaleRef.current;
            const worldPts = info.points.map((p) => localToWorld(p, wt));
            ctx.save();
            ctx.strokeStyle = '#2effa6';
            ctx.lineWidth = 1.5 * ss;
            ctx.setLineDash([]);
            ctx.beginPath();
            worldPts.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
            if (info.closed && worldPts.length > 1) ctx.closePath();
            ctx.stroke();
            const hs = 5 * ss;
            for (const p of worldPts) {
              ctx.fillStyle = '#2effa6';
              ctx.fillRect(p.x - hs, p.y - hs, hs * 2, hs * 2);
              ctx.strokeStyle = '#0a0a0a';
              ctx.lineWidth = ss;
              ctx.strokeRect(p.x - hs, p.y - hs, hs * 2, hs * 2);
            }
            ctx.restore();
          }
        }
      }

      ctx.restore(); // pop canvas scale transform
}

// ── Enact: Collider2D vertex handles ── expose each editable collider vertex of the selected
// entity as a viewport-CSS-px point (modoki_handles / modoki_drag_handle). Mirrors the vertex DRAW
// math (localToWorld → canvas-scale → backing px → client). Shared by the DOM Canvas2DLayer AND the
// Pixi chrome overlay. Empty unless collider-edit mode is on and this canvas owns the selection.
function registerScene2DColliderHandles(canvasEntityId: number, getCanvas: () => HTMLCanvasElement | null, canvasScaleRef: { current: ReturnType<typeof computeCanvasScale> }): () => void {
  return registerHandleProvider((): InteractionHandle[] => {
    const canvas = getCanvas();
    if (!canvas) return [];
    const store = useEditorStore.getState();
    const selId = store.selectedEntityId;
    if (!store.colliderEditMode || selId === null) return [];
    const allTraits = getAllTraits();
    const transformMeta = allTraits.find((t) => t.name === 'Transform');
    const colMeta = allTraits.find((t) => t.name === 'Collider2D');
    if (!transformMeta || !colMeta) return [];
    const { parentOf, canvasIds } = getCanvas2DRouting();
    if (findCanvasAncestor(selId, parentOf, canvasIds) !== canvasEntityId) return [];
    const ent = findEntity(selId);
    if (!ent || !ent.has(colMeta.trait) || !ent.has(transformMeta.trait)) return [];
    const info = colliderEditInfo(ent.get(colMeta.trait) as { shape: string; points: string });
    if (!info) return [];
    const wt = getWorldTransform2D(selId, ent.get(transformMeta.trait) as any);
    const cs = canvasScaleRef.current;
    const rect = canvas.getBoundingClientRect();
    const pw = canvas.width, ph = canvas.height;
    if (!pw || !ph) return []; // draw loop hasn't sized the backing store yet
    return info.points.map((p, i) => {
      const w = localToWorld(p, wt);
      const backingX = cs.offsetX + cs.scaleX * w.x;
      const backingY = cs.offsetY + cs.scaleY * w.y;
      return {
        id: `collider:vert:${i}`,
        kind: 'collider-vertex',
        editor: 'collider2d',
        x: rect.left + (backingX / pw) * rect.width,
        y: rect.top + (backingY / ph) * rect.height,
        label: `vertex ${i}`,
        meta: { entityId: selId, index: i, local: [p.x, p.y] },
      };
    });
  });
}

// ── Enact: 2D transform-gizmo axis handles ── expose the selected entity's gizmo grab points as
// viewport-CSS-px points. Reproduces drawGizmo2D's local offsets EXACTLY from the per-frame snapshot
// `gizmo2DHandleStateRef` (so it can't drift from what's drawn), then world → backing → client via
// the same ratio the collider provider + toGame use. Shared by Canvas2DLayer + the chrome overlay.
function registerScene2DGizmoHandles(getCanvas: () => HTMLCanvasElement | null, canvasScaleRef: { current: ReturnType<typeof computeCanvasScale> }, gizmo2DHandleStateRef: Scene2DDrawOpts['gizmo2DHandleStateRef']): () => void {
  const rot = (ox: number, oy: number, a: number) => {
    const c = Math.cos(a), s = Math.sin(a);
    return { x: ox * c - oy * s, y: ox * s + oy * c };
  };
  return registerHandleProvider((): InteractionHandle[] => {
    const canvas = getCanvas();
    if (!canvas) return [];
    const st = gizmo2DHandleStateRef.current;
    if (!st) return [];
    const { tf, w, h, mode, space, s } = st;
    const AXIS = 60 * s; // BASE_AXIS_LEN * screenScale — matches Gizmo2D.ts
    const items: Array<{ handle: string; off: { x: number; y: number } }> = [];
    if (mode === 'translate') {
      const loc = space === 'local';
      items.push({ handle: 'x-axis', off: loc ? rot(AXIS, 0, tf.rz) : { x: AXIS, y: 0 } });
      items.push({ handle: 'y-axis', off: loc ? rot(0, AXIS, tf.rz) : { x: 0, y: AXIS } });
      items.push({ handle: 'free', off: { x: 0, y: 0 } });
    } else if (mode === 'rotate') {
      items.push({ handle: 'rotate', off: { x: AXIS * Math.cos(tf.rz), y: AXIS * Math.sin(tf.rz) } });
    } else {
      const hw = w * Math.abs(tf.sx), hh = h * Math.abs(tf.sy);
      items.push({ handle: 'scale-tl', off: rot(-hw, -hh, tf.rz) });
      items.push({ handle: 'scale-tr', off: rot(hw, -hh, tf.rz) });
      items.push({ handle: 'scale-bl', off: rot(-hw, hh, tf.rz) });
      items.push({ handle: 'scale-br', off: rot(hw, hh, tf.rz) });
      items.push({ handle: 'scale-uniform', off: { x: 0, y: 0 } });
    }
    const cs = canvasScaleRef.current;
    const rect = canvas.getBoundingClientRect();
    const pw = canvas.width, ph = canvas.height;
    if (!pw || !ph) return [];
    return items.map(({ handle, off }) => {
      const wx = tf.x + off.x, wy = tf.y + off.y;
      const backingX = cs.offsetX + cs.scaleX * wx;
      const backingY = cs.offsetY + cs.scaleY * wy;
      return {
        id: `gizmo2d:${handle}`,
        kind: 'gizmo-axis',
        editor: 'gizmo2d',
        x: rect.left + (backingX / pw) * rect.width,
        y: rect.top + (backingY / ph) * rect.height,
        label: `${mode} ${handle}`,
        meta: { handle, mode, space, world: [wx, wy] },
      };
    });
  });
}

// ── UI Editor Preview ──────────────────────────────────

/** UI mode overlay — renders UIRenderer on top of the 3D viewport with a device frame.
 *  Clicks on UI entities are handled here; clicks that miss UI elements pass through to the canvas. */
// Phase 3 (SceneView-Pixi migration): a chrome CANVAS over the Pixi Canvas2DMount. It (1) DRAWS the
// editor overlays — boundary, bones, selection outline, gizmo, collider outline/handles, and the
// skin-debug views — via the SHARED drawScene2D with drawContent:false (Pixi owns the content), and
// (2) CAPTURES 2D picking + gizmo/collider/paint interaction (installScene2DInteraction, same handlers
// as the DOM Canvas2DLayer). Its backing tracks the pooled Pixi canvas so overlays pixel-align with
// content, and it registers the SAME Enact handle providers so modoki_handles keeps resolving.
function Scene2DChromeOverlay({ canvasEntityId, showBoundary = false, viewZoom = 1 }: { canvasEntityId: number; showBoundary?: boolean; viewZoom?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<Gizmo2DDragState | null>(null);
  const hoveredRef = useRef<GizmoHandle | null>(null);
  const vertexDragRef = useRef<Collider2DVertexDrag | null>(null);
  const skinPaintStrokeRef = useRef<SkinPaintStrokeState | null>(null);
  const paintCursorRef = useRef<PaintCursorState | null>(null);
  const lastEditClickRef = useRef<{ t: number; x: number; y: number }>({ t: 0, x: 0, y: 0 });
  const gizmo2DHandleStateRef = useRef<Scene2DDrawOpts['gizmo2DHandleStateRef']['current']>(null);
  const canvasScaleRef = useRef(computeCanvasScale(1080, 1920, 1080, 1920, 'fitH'));
  const gizmoScreenScaleRef = useRef(1);
  const showBoundaryRef = useRef(showBoundary);
  showBoundaryRef.current = showBoundary;

  // Redraw when selection / editor state that affects overlays changes (mirrors Canvas2DLayer's
  // mark2DDirty effects — bumping the SAME shared dirty version the chrome draw gate reads).
  const selectedEntityId = useEditorStore((s) => s.selectedEntityId);
  const colliderEditMode = useEditorStore((s) => s.colliderEditMode);
  const skinWeightView = useEditorStore((s) => s.skinWeightView);
  useEffect(() => { mark2DDirty(); }, [selectedEntityId, colliderEditMode, skinWeightView, showBoundary, viewZoom]);

  // Chrome draw loop — overlays only (Pixi draws content). Backing = the pooled Pixi canvas backing,
  // so overlays pixel-align with the Pixi content regardless of DPR/zoom.
  useEffect(() => {
    ensureCanvas2DListeners();
    mark2DDirty();
    const frameKey = editor2DChromeFrameKey(canvasEntityId);
    let lastVersion = -1;
    let lastBackingKey = -1;
    const draw = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const simRunning = isSimRunning();
      const version = get2DDirtyVersion();
      const slot = editorCanvas2DPool.getSlot(canvasEntityId);
      const pw = slot?.canvas.width ?? 0, ph = slot?.canvas.height ?? 0;
      const backingKey = pw * 100003 + ph;
      // Redraw on a DOM dirty bump, a sim tick, OR a Pixi backing resize (a panel drag marks the Pixi
      // renderer dirty, not this DOM version) — so overlays never desync from the content underneath.
      if (!simRunning && version === lastVersion && backingKey === lastBackingKey) return;
      // Do NOT latch lastVersion until we actually draw. The Pixi surface can be unsized on the first
      // idle frame after mount; latching there would freeze this version and never retry (the bug that
      // left bones/overlays invisible in Pixi mode until an unrelated dirty bump).
      if (!pw || !ph) return; // Pixi surface not sized yet — retry next frame
      lastVersion = version;
      lastBackingKey = backingKey;
      if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, pw, ph);
      const { refW, refH, scaleMode } = readCanvas2DRefDims(canvasEntityId, pw, ph);
      const cs = computeCanvasScale(refW, refH, pw, ph, scaleMode);
      canvasScaleRef.current = cs;
      const rectW = canvas.getBoundingClientRect().width;
      gizmoScreenScaleRef.current = (rectW > 0 && cs.scale > 0) ? pw / (cs.scale * rectW) : 1;
      drawScene2D(ctx, canvasEntityId, {
        cs, refW, refH,
        gizmoScreenScaleRef, showBoundaryRef, paintCursorRef, hoveredRef, gizmo2DHandleStateRef,
      });
    };
    registerFrameCallback(frameKey, draw, PRIORITY_EDITOR_2D);
    startFrameDriver();
    return () => { unregisterFrameCallback(frameKey); stopFrameDriver(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasEntityId]);

  // Enact handle providers (collider vertices + gizmo axes) — shared with Canvas2DLayer.
  useEffect(() => registerScene2DColliderHandles(canvasEntityId, () => canvasRef.current, canvasScaleRef), [canvasEntityId]);
  useEffect(() => registerScene2DGizmoHandles(() => canvasRef.current, canvasScaleRef, gizmo2DHandleStateRef), [canvasEntityId]);

  // Pick + gizmo/collider/paint interaction — same handlers, now targeting this chrome canvas.
  useEffect(() => {
    const refs: Scene2DInteractionRefs = { dragRef, hoveredRef, vertexDragRef, skinPaintStrokeRef, paintCursorRef, lastEditClickRef };
    return installScene2DInteraction(canvasEntityId, {
      getTargetEl: () => canvasRef.current,
      getScale: () => {
        const slot = editorCanvas2DPool.getSlot(canvasEntityId);
        const backingW = slot?.canvas.width ?? 0, backingH = slot?.canvas.height ?? 0;
        return { cs: canvasScaleRef.current, gizmoScreenScale: gizmoScreenScaleRef.current, backingW, backingH };
      },
      refs,
      // Interaction redraws (gizmo/collider/paint drags do direct ECS .set writes) must wake BOTH gates:
      // mark2DDirty bumps get2DDirtyVersion — the channel THIS chrome overlay's own draw gate reads (so
      // the overlays follow the drag) — and editorMarkScene2DDirty wakes the Pixi renderer (so the CONTENT
      // follows). Passing only the latter froze the overlays mid-drag until an unrelated dirty bump.
      markDirty: () => { mark2DDirty(); editorMarkScene2DDirty(); },
    });
  }, [canvasEntityId]);

  return <canvas ref={canvasRef} data-2d-pick data-canvas-entity-id={canvasEntityId}
    style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'auto' }} />;
}

function UIEditorOverlay({ viewZoom = 1, showUI = true, show2D = false, selected2D = false }: { viewZoom?: number; showUI?: boolean; show2D?: boolean; selected2D?: boolean }) {
  const selectEntity = useEditorStore((s) => s.selectEntity);
  const selectedId = useEditorStore((s) => s.selectedEntityId);
  const gameViewSize = useEditorStore((s) => s.gameViewSize);
  const showFocusGraph = useEditorStore((s) => s.showFocusGraph);
  const bounds = useLetterboxBounds();
  // Render the UI at the LOGICAL device resolution and visually fit it with
  // transform: scale(), so --ui-vmin (measured from the container) matches the
  // device — not the letterboxed on-screen size. Without this, vmin-sized UI
  // scales with the panel-fit rect and drifts out of proportion with fixed-px
  // text (the GameView/SceneView "buttons too big/small" mismatch).
  const logW = gameViewSize.width || 390;
  const logH = gameViewSize.height || 844;
  const uiScale = logW > 0 && bounds.w > 0 ? bounds.w / logW : 1;

  // 2D canvases are mounted INLINE in the UI tree (renderCanvas2D injection) so 2D and UI stack by
  // hierarchy, matching the runtime. The tree always renders (it hosts the canvases); the layer toggles
  // act per node-type: renderCanvas2D returns null when the 2D layer is off, uiVisualsHidden hides UI.
  // Drive the editor's PixiJS Scene2DRenderer (its own pool) + mount its pooled Pixi canvas per Canvas2D
  // via Canvas2DMount — the SAME renderer the runtime GameView uses — plus a Scene2DChromeOverlay that
  // draws the editor overlays + captures picks. Lazy: only started while the 2D layer is visible, so no
  // GPU context is held in 3D mode or when the 2D layer is toggled off (context-budget hygiene).
  useEffect(() => {
    if (!show2D) return;
    editorScene2DRenderer.start();
    startFrameDriver();
    editorScene2DRenderer.markDirty();
    return () => { editorScene2DRenderer.stop(); stopFrameDriver(); };
  }, [show2D]);

  const renderCanvas2D = show2D
    ? (id: number) => <><Canvas2DMount entityId={id} pool={editorCanvas2DPool} markDirty={editorMarkScene2DDirty} viewZoom={viewZoom} /><Scene2DChromeOverlay canvasEntityId={id} showBoundary={selected2D} viewZoom={viewZoom} /></>
    : () => null;

  return (
    <div data-ui-preview-frame style={{
      position: 'absolute',
      left: bounds.x, top: bounds.y,
      width: logW, height: logH,
      transform: `scale(${uiScale})`, transformOrigin: 'top left',
      zIndex: 10,
      overflow: 'hidden',
      pointerEvents: 'none',
    }}>
      <UIRenderer
        onSelectEntity={(id) => selectEntity(id)}
        renderCanvas2D={renderCanvas2D}
        uiVisualsHidden={!showUI}
      />
      {showUI && showFocusGraph && <UIFocusGraphOverlay />}
      {selectedId !== null && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 100000, pointerEvents: 'none' }}>
          <UIResizeOverlay entityId={selectedId} />
        </div>
      )}
    </div>
  );
}

/* UISelectionOverlay replaced by UIResizeOverlay (UIResizeOverlay.tsx) */

// ── Three.js Viewport (extracted from original SceneView) ──

function ThreeJSViewport({ mode, layers, showGrid = true, showColliders = false, viewZoom = 1 }: { mode: '3d' | 'ui'; layers: { show3D: boolean; show2D: boolean; showUI: boolean }; showGrid?: boolean; showColliders?: boolean; viewZoom?: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const initedRef = useRef(false);
  const rendererRef = useRef<WebGPURenderer | null>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const layersRef = useRef(layers);
  layersRef.current = layers;
  const showGridRef = useRef(showGrid);
  showGridRef.current = showGrid;
  const showCollidersRef = useRef(showColliders);
  showCollidersRef.current = showColliders;
  // Idle render gate (see viewportDirtyGate) — one instance shared by the animate loop and
  // the mode/layer re-arm effect, so a re-arm before async renderer init still counts.
  const gateRef = useRef(createViewportDirtyGate());

  // Update renderer pixel ratio when zoom changes for sharper rendering
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    const dpr = Math.min(window.devicePixelRatio, 2);
    renderer.setPixelRatio(Math.min(dpr * viewZoom, 4));
  }, [viewZoom]);

  // View mode (3D ↔ 2D/UI) + layer toggles are component-local props, not editor-store
  // fields, so they bypass useEditorStore.subscribe(markViewportDirty). Re-arm explicitly
  // so a mode switch on an idle scene actually redraws (see useRearmDirtyOnChange docs).
  useRearmDirtyOnChange(() => gateRef.current.markDirty(), [mode, layers, showGrid, showColliders]);

  useEffect(() => {
    if (initedRef.current || !containerRef.current) return;
    initedRef.current = true;

    const container = containerRef.current;

    // Renderer setup is gated on async WebGPU detection so we can pick the
    // backend (native WebGPU vs WebGL2) BEFORE creating the single renderer.
    // `renderer.domElement` is bound to OrbitControls/TransformControls and
    // pointer listeners synchronously below, so swapping the renderer after the
    // fact isn't viable — we must know the backend up front.
    let outerDisposed = false;
    let cleanup: (() => void) | undefined;

    const setup = async () => {
    // Three.js r183 WebGPU's node system warns 'Light node not found' for
    // dynamically-added lights (they still work — a Three.js internal issue). It's
    // emitted at render time, so it's suppressed via the SCOPED `withWarnFilter`
    // wrapped around the per-frame `renderer.render` (F9) — NOT a lifetime-long
    // global `console.warn` patch that would swallow every other warning in the app.

    // ── Renderer (WebGPU when available, else WebGL2 via forceWebGL — matches
    //    the game renderer, including the WebGPU-init-failure → WebGL2 fallback) ──
    // makeWebGPURenderer creates + inits the renderer (and appends its canvas),
    // so the backend is fully settled BEFORE we bind OrbitControls /
    // TransformControls and pointer listeners to renderer.domElement below.
    let renderer: WebGPURenderer;
    try {
      renderer = await makeWebGPURenderer(container);
    } catch (e) {
      console.warn('[SceneView] renderer init failed (no WebGPU or WebGL2):', e);
      initedRef.current = false;
      return;
    }
    // The component may have unmounted while init was in flight.
    if (outerDisposed) {
      renderer.dispose();
      renderer.domElement.remove();
      return;
    }
    setActiveRenderer(renderer); // KTX2Loader GPU-format detection
    rendererRef.current = renderer;

    let disposed = false;

    // ── Scene ───────────────────────────────────────────
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1e1e2e);

    // ── Editor Camera ───────────────────────────────────
    const camera = new THREE.PerspectiveCamera(
      50, container.clientWidth / container.clientHeight, 0.1, 500,
    );
    camera.position.set(12, 15, 20);
    camera.lookAt(0, 0, 0);
    camera.layers.enable(PARTICLE_LAYER); // particles live on a dedicated layer

    // ── OrbitControls ───────────────────────────────────
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    controls.target.set(0, 0, 0);

    setEditorViewportCamera(camera); // Inspector's "Copy from Editor Camera" reads this

    // ── Idle render gate (F2) ──────────────────────────────────────────────
    // The 3D viewport used to re-sync the full ECS world + submit a GPU frame
    // every rAF, even on a static idle scene. Gate it on a dirty signal.
    //
    // Marking is deliberately GENEROUS — a missed source shows a visibly stale
    // viewport, which is far worse than a few wasted frames: any ECS trait write
    // (incl. gizmo drags, which call fireDirtyListeners), any structural change
    // (create/delete/reparent), world swaps, play-state edges, and ANY editor-
    // store change (selection, gizmo mode/space, view mode, layer toggles,
    // particlePreview, gameRect) all re-arm it. OrbitControls motion and the
    // running sim / particle preview force redraws live (handled in animate()).
    //
    // We use a frame COUNTDOWN, not a boolean: several async resource loaders in
    // scene3DSync poll "not ready — retry next frame" (mesh templates, streamed
    // textures) with no completion callback, so a single post-dirty frame can
    // miss them. Rendering for DIRTY_GRACE frames after the last event lets them
    // converge; a truly static viewport then settles to 0 GPU submits.
    const gate = gateRef.current; // shared gate (created at mount; see gateRef above)
    const markViewportDirty = () => { gate.markDirty(); };
    controls.addEventListener('change', markViewportDirty);
    const dirtyUnsubs = [
      addDirtyListener(markViewportDirty),         // trait writes (incl. gizmo fireDirtyListeners)
      onStructureDirty(markViewportDirty),         // entity create / delete / reparent
      onWorldSwap(markViewportDirty),              // scene load/reload, Play/Stop world rebuild
      onPlayStateChange(markViewportDirty),        // Play ↔ Stop ↔ Pause edges
      onTextDirty(markViewportDirty),              // dynamic-font glyph gen / async atlas load (not an ECS write)
      useEditorStore.subscribe(markViewportDirty), // selection, gizmo mode/space, view mode, layers, particlePreview, gameRect …
    ];

    // ── Transform Gizmo ─────────────────────────────────
    const gizmo = new TransformControls(camera, renderer.domElement);
    gizmo.setSize(1.5);
    (gizmo as any).visible = false;

    // Add the gizmo helper (visual gizmo) to the scene
    const gizmoHelper = gizmo.getHelper();
    scene.add(gizmoHelper);

    // ── Enact Phase 3: 3D transform-gizmo axis aim-points ── TransformControls owns its
    //    own (internal, version-dependent) pickable geometry, so we can't report its exact
    //    handle rects. Instead we project BEST-EFFORT aim points: the attached object's
    //    world origin, projected to screen, plus a fixed screen-pixel offset along each
    //    axis's on-screen direction — enough to press-drag the correct axis. World vs local
    //    axis basis follows gizmoSpace. Skips an axis pointing ~at/away from the camera
    //    (un-aimable) and returns [] when nothing's attached. meta.approximate flags these
    //    as aim aids, not exact handle centres.
    const unregGizmo3DHandles = registerHandleProvider((): InteractionHandle[] => {
      const obj = gizmo.object;
      if (!obj || !gizmo.enabled || !(gizmo as { visible?: boolean }).visible) return [];
      const r = renderer.domElement.getBoundingClientRect();
      if (!r.width || !r.height) return [];
      const { gizmoMode, gizmoSpace } = useEditorStore.getState();
      const project = (p: THREE.Vector3) => {
        const n = p.clone().project(camera);
        return { x: r.left + (n.x * 0.5 + 0.5) * r.width, y: r.top + (-n.y * 0.5 + 0.5) * r.height, z: n.z };
      };
      const origin = obj.getWorldPosition(new THREE.Vector3());
      const oC = project(origin);
      if (oC.z > 1 || oC.z < -1) return []; // origin behind camera / clipped
      const q = obj.getWorldQuaternion(new THREE.Quaternion());
      // three.js TransformControls ALWAYS orients SCALE handles to the object's local
      // axes regardless of setSpace() (TransformControls.js: space = mode==='scale' ?
      // 'local' : this.space). So force local basis for scale, else honor gizmoSpace.
      const localBasis = gizmoSpace === 'local' || gizmoMode === 'scale';
      const axisDir = (ax: 'x' | 'y' | 'z') => {
        const base = ax === 'x' ? new THREE.Vector3(1, 0, 0) : ax === 'y' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
        return localBasis ? base.applyQuaternion(q) : base;
      };
      // On-screen unit direction of a world axis at the origin (null if ~parallel to view).
      const screenDir = (dir: THREE.Vector3) => {
        const sC = project(origin.clone().addScaledVector(dir, 0.001));
        if (sC.z > 1) return null; // stepped behind camera
        const dxs = sC.x - oC.x, dys = sC.y - oC.y;
        const len = Math.hypot(dxs, dys);
        if (len < 1e-4) return null; // axis points ~at/away from camera → un-aimable
        return { x: dxs / len, y: dys / len };
      };
      const out: InteractionHandle[] = [];
      const push = (id: string, label: string, px: number, dir: THREE.Vector3, axis: string) => {
        const sd = screenDir(dir);
        if (!sd) return;
        out.push({ id, kind: 'gizmo-axis', editor: 'gizmo3d', x: oC.x + sd.x * px, y: oC.y + sd.y * px, label, meta: { axis, mode: gizmoMode, space: gizmoSpace, approximate: true } });
      };
      const PX = 52, RING_PX = 66;
      if (gizmoMode === 'translate' || gizmoMode === 'scale') {
        for (const ax of ['x', 'y', 'z'] as const) push(`gizmo3d:${gizmoMode}:${ax}`, `${gizmoMode} ${ax}`, PX, axisDir(ax), ax);
        // Centre = screen-space plane move / uniform scale (grab at the origin itself).
        out.push({ id: `gizmo3d:${gizmoMode}:center`, kind: 'gizmo-axis', editor: 'gizmo3d', x: oC.x, y: oC.y, label: `${gizmoMode} center`, meta: { axis: 'center', mode: gizmoMode, space: gizmoSpace, approximate: true } });
      } else if (gizmoMode === 'rotate') {
        // Each rotation ring lies perpendicular to its axis — aim a point ON the ring by
        // offsetting along a perpendicular axis (x-ring↔y dir, y-ring↔z, z-ring↔x).
        const perp: Record<'x' | 'y' | 'z', 'x' | 'y' | 'z'> = { x: 'y', y: 'z', z: 'x' };
        for (const ax of ['x', 'y', 'z'] as const) push(`gizmo3d:rotate:${ax}`, `rotate ${ax}`, RING_PX, axisDir(perp[ax]), ax);
      }
      return out;
    });

    // Disable orbit when gizmo is actively dragging
    const onGizmoDraggingChanged = (event: any) => {
      controls.enabled = !event.value;
    };
    gizmo.addEventListener('dragging-changed', onGizmoDraggingChanged);

    // F7: hold Shift → snap. TransformControls snaps whenever a snap value is set, so
    // toggle the snaps with the Shift key (translate 0.5 units, rotate 15°, scale 0.1) —
    // matching the 2D gizmo's DEFAULT_GIZMO_SNAP. Cleared on keyup so a normal drag is free.
    const onSnapKey = (ev: KeyboardEvent) => {
      const on = ev.shiftKey;
      gizmo.setTranslationSnap(on ? DEFAULT_GIZMO_SNAP.translate! : null);
      gizmo.setRotationSnap(on ? DEFAULT_GIZMO_SNAP.rotateRad! : null);
      gizmo.setScaleSnap(on ? DEFAULT_GIZMO_SNAP.scale! : null);
    };
    window.addEventListener('keydown', onSnapKey);
    window.addEventListener('keyup', onSnapKey);

    // ── Selection raycasting on pointer down ──
    const raycaster = new THREE.Raycaster();
    const gizmoRaycaster = new THREE.Raycaster();
    const gizmoMouse = new THREE.Vector2();

    // Track which entity the gizmo is attached to (for ECS sync skip)
    let gizmoEntityId: number | null = null;
    let gizmoDragStart: { x: number; y: number; z: number; rx: number; ry: number; rz: number; sx: number; sy: number; sz: number } | null = null;

    // ── 2.5D billboard bone posing ──
    // A Bone2D of a billboarded rig has NO Three object of its own — its only on-screen
    // presence is the deformed billboard mesh (built in scene3DSync). To pose it with the
    // 3D gizmo we park this proxy at the bone INSIDE its billboard `flip` group (the same
    // frame the mesh vertices live in: rig pixel space, Y flipped, scaled by 1/ppu). The
    // proxy's LOCAL transform round-trips to the bone's 2D Transform (see onGizmoChange).
    // `boneGizmo` is non-null only while such a bone is the selection.
    const boneProxy = new THREE.Object3D();
    boneProxy.name = 'billboardBoneProxy';
    let boneGizmo: { boneId: number; spriteId: number } | null = null;
    const _boneWt = { x: 0, y: 0, rz: 0, sx: 1, sy: 1 };
    const _spriteWt = { x: 0, y: 0, rz: 0, sx: 1, sy: 1 };
    const _parentWt = { x: 0, y: 0, rz: 0, sx: 1, sy: 1 };

    // Capture transform before drag starts
    const onGizmoMouseDown = () => {
      if (gizmoEntityId === null) return;
      const entity = findEntity(gizmoEntityId);
      if (!entity || !entity.has(Transform)) return;
      const tf = entity.get(Transform);
      gizmoDragStart = { x: tf.x, y: tf.y, z: tf.z, rx: tf.rx, ry: tf.ry, rz: tf.rz, sx: tf.sx, sy: tf.sy, sz: tf.sz };
    };
    gizmo.addEventListener('mouseDown', onGizmoMouseDown);

    // Sync gizmo transform changes back to ECS (only during active drag).
    // The mesh lives in world space, so we must convert back to local space
    // by inverting the parent's world transform for child entities. The pure
    // conversion lives in `worldToLocalTransform` (gizmoTransform.ts) so the
    // parented-gizmo round-trip is unit-tested (engine-review C2 / sceneview F4).
    const worldToLocal = (obj: THREE.Object3D, parentId: number) =>
      worldToLocalTransform(obj, parentId ? worldTransforms.get(parentId) : null);

    const onGizmoChange = () => {
      if (!(gizmo as any).dragging) return;
      const obj = gizmo.object;
      if (!obj || gizmoEntityId === null) return;

      // Billboard bone: the proxy is a child of the billboard `flip` group, so its LOCAL
      // transform is in the rig's pixel space with Y flipped and rotation negated (the
      // reflection buildBillboardGeometry bakes in). Undo that to recover the bone's 2D
      // WORLD transform relative to the sprite, then convert to parent-bone-LOCAL via the
      // same worldToLocal2D the Canvas2D bone gizmo uses. This is handled FIRST and returns
      // unconditionally: if the proxy is attached but `boneGizmo` is momentarily null (e.g.
      // the view flipped out of `ui` mid-drag), do nothing rather than fall through to the
      // 3D-decompose path below, which would stamp x/y/z/rx/ry/rz onto a 2D bone Transform.
      if (obj === boneProxy) {
        if (!boneGizmo) return;
        const entity = findEntity(gizmoEntityId);
        if (!entity || !entity.has(Transform)) return;
        const mode = gizmo.getMode();
        const pid = entity.has(EntityAttributes) ? (entity.get(EntityAttributes).parentId as number) : 0;
        let parentRel: { x: number; y: number; rz: number; sx: number; sy: number } | null = null;
        if (pid && pid !== boneGizmo.spriteId) {
          const pEnt = findEntity(pid);
          const sEnt = findEntity(boneGizmo.spriteId);
          if (pEnt?.has(Transform) && sEnt?.has(Transform)) {
            const pw = getWorldTransform2DInto(_parentWt, pid, pEnt.get(Transform) as never);
            const sw = getWorldTransform2DInto(_spriteWt, boneGizmo.spriteId, sEnt.get(Transform) as never);
            parentRel = worldToLocal2D(pw, sw);
          }
        }
        const localTf = proxyLocalToBoneLocal(
          { x: boneProxy.position.x, y: boneProxy.position.y, rz: boneProxy.rotation.z, sx: boneProxy.scale.x, sy: boneProxy.scale.y },
          parentRel,
        );
        const cur = entity.get(Transform);
        if (mode === 'translate') entity.set(Transform, { ...cur, x: localTf.x, y: localTf.y });
        else if (mode === 'rotate') entity.set(Transform, { ...cur, rz: clampAngle(localTf.rz) });
        else if (mode === 'scale') entity.set(Transform, { ...cur, sx: localTf.sx, sy: localTf.sy });
        fireDirtyListeners();
        return;
      }

      const entity = findEntity(gizmoEntityId);
      if (!entity || !entity.has(Transform)) return;
      const parentId = entity.has(EntityAttributes) ? entity.get(EntityAttributes).parentId : 0;
      const local = worldToLocal(obj, parentId);
      const mode = gizmo.getMode();
      const current = entity.get(Transform);
      if (mode === 'translate') {
        entity.set(Transform, { ...current, x: local.x, y: local.y, z: local.z });
      } else if (mode === 'rotate') {
        entity.set(Transform, { ...current, rx: clampAngle(local.rx), ry: clampAngle(local.ry), rz: clampAngle(local.rz) });
      } else if (mode === 'scale') {
        entity.set(Transform, { ...current, sx: local.sx, sy: local.sy, sz: local.sz });
      }
      // Bulk entity.set bypasses writeTraitField, which is what normally
      // fires the dirty broadcast. Notify subscribers (Inspector, Canvas2D
      // overlay, etc.) so they re-read live values during the drag.
      fireDirtyListeners();
    };
    gizmo.addEventListener('change', onGizmoChange);

    // On drag end, push undo action
    const onGizmoMouseUp = () => {
      if (gizmoEntityId === null || !gizmoDragStart) return;
      const entity = findEntity(gizmoEntityId);
      if (!entity || !entity.has(Transform)) return;
      const tf = entity.get(Transform);
      const after = { x: tf.x, y: tf.y, z: tf.z, rx: tf.rx, ry: tf.ry, rz: tf.rz, sx: tf.sx, sy: tf.sy, sz: tf.sz };
      const before = { ...gizmoDragStart };
      const eid = gizmoEntityId;
      const mode = gizmo.getMode();
      // Capture a guid-based ref and re-resolve inside the closures — a captured
      // handle/raw id goes stale on delete/restore or a world rebuild (Play→Stop).
      const ref = entityRef(eid);
      pushAction(buildTransformUndoAction({
        label: `Transform "${entity.name || `Entity ${eid}`}"`,
        trait: Transform, resolve: () => ref.resolve(), findEntity, before, after,
        entityGuid: ref.guid || String(eid),
      }));
      // Record mode: the gizmo writes Transform via direct entity.set, bypassing
      // writeTraitField → the animation record hook never sees it. Notify it for
      // the fields this drag mode affects (no-op when not recording). Mode-gated
      // rather than diffed so decompose float-noise doesn't spawn spurious tracks.
      const recFields = mode === 'translate' ? ['x', 'y', 'z'] : mode === 'rotate' ? ['rx', 'ry', 'rz'] : ['sx', 'sy', 'sz'];
      for (const k of recFields) {
        notifyFieldEdited(eid, 'Transform', k, (after as Record<string, number>)[k]);
        // Record a deliberate override on a prefab-instance member (e.g. hand-posing
        // a bone), same as an inspector edit — so override capture keeps this edit
        // and doesn't confuse it with a stale-inherited field (rigged-reimport bug).
        markOverrideIfInstance(eid, 'Transform', k);
      }
      gizmoDragStart = null;
    };
    gizmo.addEventListener('mouseUp', onGizmoMouseUp);

    // Capture-phase: route events manually to avoid OrbitControls/gizmo conflict
    function onPointerDownCapture(event: PointerEvent) {
      if (!(gizmo as any).enabled || !(gizmo as any).visible) return;

      const r = renderer.domElement.getBoundingClientRect();
      const ptr = {
        x: ((event.clientX - r.left) / r.width) * 2 - 1,
        y: -((event.clientY - r.top) / r.height) * 2 + 1,
        button: event.button,
      };
      gizmoMouse.set(ptr.x, ptr.y);
      // Hit-test with the SAME camera the gizmo renders under (`gizmo.camera`): the editor
      // orbit cam in 3D view, the game cam in 2D (`ui`) view — else the handle raycast in
      // 2D view uses the wrong camera and the gizmo (e.g. a billboard bone) can't be grabbed.
      gizmoRaycaster.setFromCamera(gizmoMouse, modeRef.current === 'ui' ? gameActiveCam : camera);
      const mode = useEditorStore.getState().gizmoMode;
      const picker = (gizmo as any)._gizmo?.picker?.[mode];
      const hit = picker && gizmoRaycaster.intersectObject(picker, true).length > 0;
      if (hit) {
        // Call pointerHover then pointerDown directly (avoids _onPointerDown re-raycasting with potentially different coords)
        (gizmo as any).pointerHover(ptr);
        (gizmo as any).pointerDown(ptr);
        // Manually register move/up listeners for the drag session
        renderer.domElement.setPointerCapture?.(event.pointerId);
        event.stopImmediatePropagation();
      }
    }

    function onPointerMoveCapture(event: PointerEvent) {
      if ((gizmo as any).dragging) {
        const r = renderer.domElement.getBoundingClientRect();
        const ptr = {
          x: ((event.clientX - r.left) / r.width) * 2 - 1,
          y: -((event.clientY - r.top) / r.height) * 2 + 1,
          button: event.button,
        };
        (gizmo as any).pointerMove(ptr);
        event.stopImmediatePropagation();
      }
    }

    function onPointerUpCapture(event: PointerEvent) {
      if ((gizmo as any).dragging) {
        (gizmo as any).pointerUp(null);
        event.stopImmediatePropagation();
      }
    }

    // Capture handlers fire FIRST — block OrbitControls when gizmo is active
    renderer.domElement.addEventListener('pointerdown', onPointerDownCapture, true);
    renderer.domElement.addEventListener('pointermove', onPointerMoveCapture, true);
    renderer.domElement.addEventListener('pointerup', onPointerUpCapture, true);
    // Bubble handlers fire after TransformControls/OrbitControls native handlers
    renderer.domElement.addEventListener('pointerdown', onPointerDown);

    // Empty-space DESELECT is deferred to pointer-up so a camera pan/orbit that STARTS on
    // empty space OR off an entity (left-drag) doesn't change the current selection. The
    // gesture arms on press with the picked id (null = deselect), cancels once the pointer
    // travels past the drag threshold (= a camera move), and commits only on a release that
    // was still a plain click. Window-level move/up so a drag that leaves the canvas still
    // cancels. (2D empty clicks fall through to this same handler — see the 2D onPointerDown.)
    const selectGesture = createSelectGesture();
    const onSelectMove = (ev: PointerEvent) => selectGesture.move(ev.clientX, ev.clientY);
    const onSelectUp = () => {
      const { clicked, entityId } = selectGesture.release();
      if (clicked) useEditorStore.getState().selectEntity(entityId);
    };
    window.addEventListener('pointermove', onSelectMove);
    window.addEventListener('pointerup', onSelectUp);

    // Selection raycast on pointer down (runs after TransformControls/OrbitControls native handlers)
    function onPointerDown(event: PointerEvent) {
      selectGesture.reset(); // a fresh press supersedes any stale pending selection
      if ((gizmo as any).dragging) return; // Don't reselect/deselect during gizmo drag
      if (event.button !== 0) return;

      // Raycast for entity selection
      const r = renderer.domElement.getBoundingClientRect();
      const isUI = modeRef.current === 'ui';
      // In UI mode the 3D render is letterboxed to the game aspect ratio, so NDC is
      // computed relative to the letterboxed viewport, not the full canvas. The aspect
      // comes from the SAME source as the render-side scissor + gameCam projection
      // (gameRect, F11) so picking can't drift from what's drawn.
      const { x: mx, y: my } = isUI
        ? computeUIModeNDC(event.clientX, event.clientY, r,
            gameAspectFromRect(useEditorStore.getState().gameRect, getGameAspect()))
        : computeFullNDC(event.clientX, event.clientY, r);
      const activeCam = isUI ? gameActiveCam : camera;
      const { show3D } = layersRef.current;
      // Meshes listed before gizmos so a mesh wins the tie at a shared ancestor.
      const entries: Pick3DEntry[] = [
        ...(show3D ? Array.from(renderState.ecsObjects, ([id, object]) => ({ id, object })) : []),
        // Flame meshes render on the particle layer (not in ecsObjects); add them so they're
        // click-selectable in the viewport like any other object.
        ...(show3D ? Array.from(flameState.recs, ([id, rec]) => ({ id, object: rec.group as THREE.Object3D })) : []),
        // 2.5D billboards (SkinnedSprite2D + Billboard3D) render as camera-facing THREE meshes
        // but live in neither ecsObjects nor ecsGizmos — add their group so the character is
        // click-selectable in the 3D view. A hit on a part-mesh resolves up to the group's id.
        // Gate on group.visible so picking matches what's actually drawn.
        ...Array.from(renderState.billboards)
          .filter(([, entry]) => entry.group.visible)
          .map(([id, entry]) => ({ id, object: entry.group as THREE.Object3D })),
        // SDF text meshes (Text3D) live in their own map, not ecsObjects — add them so
        // they're click-selectable like any other object.
        ...(show3D ? Array.from(renderState.textMeshes)
          .filter(([, entry]) => entry.group.visible)
          .map(([id, entry]) => ({ id, object: entry.group as THREE.Object3D })) : []),
        ...Array.from(ecsGizmos, ([id, object]) => ({ id, object })),
      ];
      const hitId = pick3D(mx, my, activeCam, entries, raycaster);
      // Defer the selection change to pointer-up (committed by onSelectUp iff the gesture
      // stayed a click). A press is only a pick once we know it wasn't an orbit/pan — and
      // that's true whether it landed on an entity (hitId) or on empty space (null).
      selectGesture.arm(event.clientX, event.clientY, hitId);
    }

    // ── ECS Light sync ──────────────────────────────────
    const ecsLights = new Map<number, THREE.Light>();

    // ── Grid ────────────────────────────────────────────
    const grid = new THREE.GridHelper(20, 20, 0x444466, 0x333355);
    scene.add(grid);

    // ── Axes Helper ─────────────────────────────────────
    const axes = new THREE.AxesHelper(2);
    scene.add(axes);

    // (2D content is rendered by the editor's PixiJS Scene2DRenderer via Canvas2DMount, inline in the
    //  UI tree; editor overlays + picking ride the Scene2DChromeOverlay above it — see UIEditorOverlay.)


    // ── Resolve traits from registry (no direct trait imports) ──
    const allTraits = getAllTraits();
    const transformMeta = allTraits.find((t) => t.name === 'Transform');
    const cameraMeta = allTraits.find((t) => t.role === 'camera');
    const lightMeta = allTraits.find((t) => t.name === 'Light');

    // ── Game Camera Gizmo (icon-only) ────────────────────
    // Previously also drew a THREE.CameraHelper frustum when a Camera entity
    // was selected. CameraHelper builds a LineSegments with LineBasicMaterial,
    // and three.js's WebGPU NodeMaterial wrapper warns
    // `THREE.AttributeNode: Vertex attribute "position" not found on geometry`
    // every frame against it (a known interaction between helper line
    // materials and WGSL attribute resolution). The cone icon below already
    // shows the camera's position + orientation; FOV/near/far live in the
    // Inspector. Dropping the frustum is a clean cost for a quiet console.
    const getGameAspect = () => {
      const { width, height } = useEditorStore.getState().gameViewSize;
      return width / height || 16 / 9;
    };
    const ghostCam = new THREE.PerspectiveCamera(30, getGameAspect(), 0.1, 30);

    // Game camera clone for UI mode rendering (uses real far, not clamped like ghostCam)
    const gameCam = new THREE.PerspectiveCamera(30, getGameAspect(), 0.1, 500);
    gameCam.layers.enable(PARTICLE_LAYER); // particles live on a dedicated layer

    // Orthographic sibling — driven + swapped-to when the game Camera's projection is
    // 'orthographic', mirroring Scene3D's persp/ortho pair so 2D mode previews the real
    // projection (not always perspective). `gameActiveCam` is whichever projection selects;
    // it's what the UI-mode render, picking, gizmo raycast, and billboard orientation all
    // use, so they agree with what's drawn. Reassigned each frame in the camera-drive block.
    const gameOrthoCam = new THREE.OrthographicCamera(-8, 8, 4.5, -4.5, 0.1, 500);
    gameOrthoCam.layers.enable(PARTICLE_LAYER);
    let gameActiveCam: THREE.PerspectiveCamera | THREE.OrthographicCamera = gameCam;

    // Publish the game-camera billboard raycast for the 2D overlay's pointer handler. Uses the
    // SAME letterboxed NDC + gameCam as the in-viewport pick3D (line ~2263) so 2D-mode picking
    // can't drift from what's drawn. Only billboards — 3D meshes aren't the target in 2D mode.
    _pickBillboardInUI = (clientX, clientY) => {
      const r = renderer.domElement.getBoundingClientRect();
      const { x, y } = computeUIModeNDC(clientX, clientY, r,
        gameAspectFromRect(useEditorStore.getState().gameRect, getGameAspect()));
      const entries: Pick3DEntry[] = Array.from(renderState.billboards)
        .filter(([, entry]) => entry.group.visible)
        .map(([id, entry]) => ({ id, object: entry.group as THREE.Object3D }));
      return pick3D(x, y, gameActiveCam, entries, raycaster);
    };

    // Camera icon — small wireframe pyramid (child of camGizmoPivot)
    // Cone default points +Y, rotate to point -Z (camera forward)
    const iconGeo = new THREE.ConeGeometry(0.15, 0.3, 4);
    const iconMat = new THREE.MeshBasicMaterial({ color: 0xe74c3c, wireframe: true });
    const camIcon = new THREE.Mesh(iconGeo, iconMat);
    camIcon.rotation.x = Math.PI / 2; // point along -Z in local space

    // Invisible pivot object for camera gizmo — uses ECS Transform rotation directly
    // (camIcon.lookAt() produces a different quaternion, causing misalignment)
    const camGizmoPivot = new THREE.Object3D();
    camGizmoPivot.add(camIcon);
    scene.add(camGizmoPivot);
    camIcon.position.set(0, 0, 0); // local to pivot

    // Hand-rolled view-frustum lines (child of pivot, visible only while the
    // Camera entity is selected). THREE.CameraHelper would do this but its
    // internal LineSegments are wrapped by WebGPU's NodeMaterial in a way that
    // spams "AttributeNode: Vertex attribute 'position' not found" every frame
    // here, so we own the geometry. 8 frustum corners → 12 edges + 4 apex rays
    // to the near plane = 16 segments × 2 verts.
    const camFrustumGeo = new THREE.BufferGeometry();
    const camFrustumPositions = new Float32Array(16 * 2 * 3);
    camFrustumGeo.setAttribute('position', new THREE.BufferAttribute(camFrustumPositions, 3));
    const camFrustumMat = new THREE.LineBasicMaterial({ color: 0xe74c3c, transparent: true, opacity: 0.6 });
    const camFrustumLines = new THREE.LineSegments(camFrustumGeo, camFrustumMat);
    camFrustumLines.visible = false;
    // The frustum is a non-interactive visualization: select the camera via its
    // icon (cone), not its frustum. intersectObjects() ignores `visible` and
    // only tests `layers`, so a hidden frustum is still raycast — and its lines
    // (with Line.threshold pick radius) span to the far plane, blanketing the
    // viewport and intercepting clicks meant for models behind it. No-op raycast
    // removes it from picking entirely while keeping it rendered when selected.
    camFrustumLines.raycast = () => {};
    camGizmoPivot.add(camFrustumLines);

    // Updated each frame from the Camera trait's fov/aspect/near/far. Writes
    // into camFrustumPositions in local space (pivot already carries world
    // position/rotation). -Z is forward in three.js camera convention.
    function updateCamFrustum(fovDeg: number, aspect: number, near: number, far: number) {
      computeCamFrustumPositions(fovDeg, aspect, near, far, camFrustumPositions);
      camFrustumGeo.attributes.position.needsUpdate = true;
    }

    // ── Shadow-camera frustum gizmo (directional lights) ──────────
    // Wireframe box outlining a directional light's shadow ortho-camera coverage,
    // so you can see whether the scene fits inside `shadowCameraSize`. Same
    // hand-rolled-LineSegments approach as the camera frustum above (THREE.
    // CameraHelper spams WGSL 'attribute position not found' under WebGPU). A box
    // is 8 corners → 12 edges × 2 verts; built in WORLD space from the light's
    // real shadow camera, gated on Light.showShadowFrustum below.
    const shadowFrustumGeo = new THREE.BufferGeometry();
    const shadowFrustumPositions = new Float32Array(12 * 2 * 3);
    shadowFrustumGeo.setAttribute('position', new THREE.BufferAttribute(shadowFrustumPositions, 3));
    const shadowFrustumMat = new THREE.LineBasicMaterial({ color: 0xffc021, transparent: true, opacity: 0.95 });
    const shadowFrustumLines = new THREE.LineSegments(shadowFrustumGeo, shadowFrustumMat);
    shadowFrustumLines.visible = false;
    shadowFrustumLines.raycast = () => {}; // non-interactive viz — never steal clicks
    scene.add(shadowFrustumLines);
    const _sfLocal = new THREE.Vector3();
    const _sfCorners = Array.from({ length: 8 }, () => new THREE.Vector3());
    const SF_XY = [[-1, -1], [1, -1], [1, 1], [-1, 1]]; // quad corner order
    const SF_EDGES = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];

    // Rebuild the box from a directional light's shadow camera. Uses the real
    // cam.matrixWorld (position + orientation) and the trait's shadowCameraSize
    // as ±half-extent; near=0.1. The engine sets the shadow far to 200, which
    // would bury the field in a giant box — cap the DRAWN depth to comfortably
    // past the light so the ±size cross-section stays readable near the ground.
    function updateShadowFrustum(dl: THREE.DirectionalLight, halfExtent: number) {
      dl.shadow.updateMatrices(dl);
      const cam = dl.shadow.camera as THREE.OrthographicCamera;
      cam.updateMatrixWorld(true);
      const c = halfExtent;
      const near = 0.1;
      const far = Math.min(cam.far, dl.position.length() + halfExtent * 2 + 4);
      // 8 camera-local corners (three cameras look down -Z): near quad then far quad
      const zs = [-near, -far];
      for (let q = 0; q < 2; q++) {
        for (let k = 0; k < 4; k++) {
          _sfLocal.set(SF_XY[k][0] * c, SF_XY[k][1] * c, zs[q]).applyMatrix4(cam.matrixWorld);
          _sfCorners[q * 4 + k].copy(_sfLocal);
        }
      }
      for (let e = 0; e < SF_EDGES.length; e++) {
        const v = _sfCorners[SF_EDGES[e]];
        shadowFrustumPositions[e * 3] = v.x;
        shadowFrustumPositions[e * 3 + 1] = v.y;
        shadowFrustumPositions[e * 3 + 2] = v.z;
      }
      shadowFrustumGeo.attributes.position.needsUpdate = true;
    }

    // Shared gizmo geometries (reused across entities)
    const GIZMO_SHAPES = {
      light: new THREE.OctahedronGeometry(0.25),
      environment: new THREE.SphereGeometry(0.2, 12, 12),
      particle: new THREE.ConeGeometry(0.18, 0.4, 8),
      // Generic marker for mesh-less 3D-space entities (prefab roots, empty
      // grouping/pivot nodes) so they're clickable and can show the gizmo.
      empty: new THREE.BoxGeometry(0.3, 0.3, 0.3),
      // Unit box for the CameraFrame framing volume — scaled by the entity's
      // world scale to outline the box (wireframe, gated by showGizmo).
      frameBox: new THREE.BoxGeometry(1, 1, 1),
      // Zone3D unit volumes (wireframe, scaled by the entity's world scale). `circle`
      // and `plane` are pre-rotated to lie in the ground (XZ) plane so the entity's own
      // rotation composes on top normally. sphere/box reuse existing unit shapes.
      zoneSphere: new THREE.SphereGeometry(1, 20, 14),
      zoneCircle: new THREE.TorusGeometry(1, 0.015, 6, 64).rotateX(-Math.PI / 2),
      zonePlane: new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      zoneCylinder: new THREE.CylinderGeometry(1, 1, 1, 24, 1, true),
      // NOTE: no shared capsule — a Zone3D capsule gizmo needs a PER-ZONE CapsuleGeometry
      // (radius + segment length vary independently; a shared unit + non-uniform scale distorts
      // the caps and gets the height ~3× wrong). Built per zone in the Zone3D gizmo block below.
    };

    // Mesh templates loaded in initWorld — SceneView reads from shared cache

    // ── ECS Entity Meshes (3D only) ─────────────────────
    const renderState = createRenderState();
    const unsubInvalidation = attachInvalidationListener(renderState, scene);
    // Publish this editor surface to the material broker so MaterialInstance drives
    // materials in the SceneView too (keeps it in sync with GameView).
    const unregisterSurface = registerRenderSurface(getCurrentWorld, renderState);

    // Percept (V5b): editor-viewport bounds provider. The runtime Scene3D provider only
    // reports where the GAME renderer is active (a shipped game / a configured GameView),
    // so in the editor AUTHORING view 3D `screen`/`worldAABB` never surfaced. Project the
    // SAME ecsObjects this SceneView renders, through the EDITOR orbit camera, so
    // get_scene_state?bounds / get_layout_bounds work while authoring. Editor-only (this
    // whole file is stripped from game builds); if both this and the game provider report
    // the same id, agentBridge's boundsById Map keeps the last (worldAABB is identical;
    // screen is a valid projection either way).
    const _svBoundsBox = new THREE.Box3();
    const _svSize = new THREE.Vector3(), _svCenter = new THREE.Vector3();
    const unregBounds = registerBoundsProvider((ids) => {
      const out: EntityScreenBounds[] = [];
      const r = renderer.domElement.getBoundingClientRect();
      const vp = { left: r.left, top: r.top, width: r.width, height: r.height };
      const projectOne = (id: number, obj: THREE.Object3D) => {
        if (ids && !ids.has(id)) return;
        obj.updateWorldMatrix(true, true);
        _svBoundsBox.setFromObject(obj);
        const { screen, onScreen } = projectAABBToScreen(_svBoundsBox, camera, vp);
        let worldAABB: EntityScreenBounds['worldAABB'];
        if (!_svBoundsBox.isEmpty()) {
          _svBoundsBox.getSize(_svSize); _svBoundsBox.getCenter(_svCenter);
          worldAABB = { size: [_svSize.x, _svSize.y, _svSize.z], center: [_svCenter.x, _svCenter.y, _svCenter.z] };
        }
        out.push({ id, layer: '3d', screen, onScreen, ...(worldAABB ? { worldAABB } : {}) });
      };
      for (const [id, obj] of renderState.ecsObjects) projectOne(id, obj);
      // Skinned meshes (SkinnedMeshRenderer) live in `skinned`, keyed by entity id, with
      // their cloned hierarchy at `entry.root` — the whole point of this provider for a
      // skeletal scene. (The runtime Scene3D provider covers only ecsObjects; skinned
      // parity there is a possible follow-up.) setFromObject uses the bind-pose bounds.
      for (const [id, entry] of renderState.skinned) projectOne(id, entry.root);
      return out;
    });

    const ecsGizmos = new Map<number, THREE.Object3D>();
    const outlineMeshes = new Map<number, THREE.LineSegments>();
    // Dimmer secondary outlines for the selected entity's descendants (children,
    // grandchildren, deeper) — keyed by descendant id, following each one's baked world TRS.
    const descOutlineMeshes = new Map<number, THREE.LineSegments>();
    // Collider3D wireframe gizmo for the selected entity (green LineSegments matching the
    // collider shape/dims), rebuilt only when its shape signature changes.
    const colliderWires = new Map<number, THREE.LineSegments>();
    const colliderWireSigs = new Map<number, string>();
    const disposeColliderWire = (id: number) => {
      const w = colliderWires.get(id);
      if (w) { scene.remove(w); w.geometry.dispose(); (w.material as THREE.Material).dispose(); colliderWires.delete(id); colliderWireSigs.delete(id); }
    };

    // ── Focus / frame selected entity (Unity's F) ───────
    // Frames an entity's bounding box in the orbit camera, preserving the
    // current viewing direction. Registered on the sceneViewBus so the Hierarchy
    // panel's "Focus" menu item and the SceneView F-key can both invoke it —
    // renderState/controls are closure-scoped here.
    const focusEntityInView = (entityId: number) => {
      // Renderables are added to the scene ROOT with baked world transforms — the THREE
      // graph is flat, so an entity's children are NOT its object's children and
      // Box3.setFromObject can't see them. Walk the ECS parent links instead, and frame
      // the whole subtree. (See resolveFocusTarget for the mesh → gizmo → default tiers.)
      const subtree = subtreeIds(getAllEntities(), entityId);
      const meshObjects: THREE.Object3D[] = [];
      const gizmoObjects: THREE.Object3D[] = [];
      for (const id of subtree) {
        const mesh = renderState.ecsObjects.get(id)
          || renderState.textMeshes.get(id)?.group
          || renderState.billboards.get(id)?.group
          || flameState.recs.get(id)?.group;
        if (mesh) meshObjects.push(mesh);
        const giz = ecsGizmos.get(id);
        if (giz) gizmoObjects.push(giz);
      }
      for (const o of meshObjects) o.updateWorldMatrix(true, true);
      for (const o of gizmoObjects) o.updateWorldMatrix(true, true);

      // A mesh-less, gizmo-less empty still has a world position to fly to.
      const wt = worldTransforms.get(entityId);
      const fallback = wt ? new THREE.Vector3(wt.x, wt.y, wt.z) : null;

      const target = resolveFocusTarget(meshObjects, gizmoObjects, fallback);
      if (!target) return;
      frameCameraToBox(camera, controls.target, target.center, target.radius);
      controls.update();
    };
    const unregisterFocusHandler = setFocusEntityHandler(focusEntityInView);
    // Particle emitter gizmo icons + opt-in in-scene effect preview.
    const particleState = createParticleSyncState();
    const flameState = createFlameMeshSyncState();
    // F10: persistent "seen this frame" / "seen last frame" Set pairs, swapped
    // each frame instead of allocating a fresh Set per pass per frame (GC churn
    // that scaled with frame count). Each pass fills `*ScratchIds`, reaps gizmos
    // for ids in `*GizmoIds` (last frame) not seen, then swaps so this frame's
    // seen becomes next frame's previous.
    let particleGizmoIds = new Set<number>();
    let particleScratchIds = new Set<number>();
    let emptyGizmoIds = new Set<number>();
    let emptyScratchIds = new Set<number>();
    let frameGizmoIds = new Set<number>();     // CameraFrame boxes shown last frame
    let frameScratchIds = new Set<number>();
    let zoneGizmoIds = new Set<number>();      // Zone3D wireframe volumes shown last frame
    let zoneScratchIds = new Set<number>();
    const preSyncLightIds = new Set<number>(); // reused; refilled before each syncLights
    let lastPreviewT = 0;

    // On world swap (scene change), drop all cached objects so they rebuild from new entities
    const unsubSwap = onWorldSwap(() => {
      // disposeRenderState tears down the billboard entries (incl. their `flip` groups);
      // detach the shared bone proxy first so it isn't left dangling under a disposed
      // group across the swap (mirrors the effect-cleanup detach at teardown).
      if (boneProxy.parent) boneProxy.parent.remove(boneProxy);
      disposeRenderState(renderState, scene, true);
      for (const [, outline] of outlineMeshes) { scene.remove(outline); outline.geometry.dispose(); (outline.material as THREE.Material).dispose(); }
      outlineMeshes.clear();
      for (const [id] of colliderWires) disposeColliderWire(id);
      // Skip the persistent camGizmoPivot — it's added to scene once at init
      // and reused across world swaps. Removing it here would orphan it and
      // make TransformControls warn every frame on next Camera select.
      for (const [, g] of ecsGizmos) {
        if (g === camGizmoPivot) continue;
        scene.remove(g);
        ((g as THREE.Mesh).material as THREE.Material)?.dispose();
      }
      ecsGizmos.clear();
      particleGizmoIds.clear();
      particleScratchIds.clear();
      emptyGizmoIds.clear();
      emptyScratchIds.clear();
      frameGizmoIds.clear();
      frameScratchIds.clear();
      disposeParticleSyncState(particleState, scene);
      disposeFlameMeshSyncState(flameState, scene);
      lastPreviewT = 0;
      for (const [, l] of ecsLights) { scene.remove(l); l.dispose(); }
      ecsLights.clear();
      if (scene.environment) { scene.environment = null; }
    });

    const _editorBgColor = new THREE.Color(0x1e1e2e);
    // UI-mode background = the active Camera's clearColor, mirroring GameView
    // (runtime syncCamera). Captured each frame from the synced camera entity,
    // applied just before the UI-mode render so the editor preview backdrop
    // matches the shipped game instead of the dark 3D-editor bg (F3 / clearColor).
    let _svCamClearColor: number | null = null;
    const _uiBgColor = new THREE.Color();

    // ── Render Loop (registered with frame driver) ─────
    const editorFrameKey = mintEditor3DFrameKey();
    // Tracks scene.environmentIntensity across frames so we can trip the material
    // observer only when it actually changes (see refreshEnvIntensityObserver).
    let prevEnvIntensity = NaN;

    function animate() {
      // Skip if container is not visible (tab hidden)
      if (container.clientWidth === 0 || container.clientHeight === 0) return;

      // Always step controls so OrbitControls damping keeps settling (and keeps
      // dispatching its 'change' event → markViewportDirty). update() returns
      // true while the camera is still moving — cheap, no GPU work.
      const controlsMoving = controls.update();

      // Idle gate: skip the whole ECS→Three sync + GPU submit when nothing that
      // affects the rendered image changed. Sim, particle preview, and Animation-
      // editor skeletal preview are presumed continuous; controls motion and the
      // dirty grace-window force redraws.
      const previewSkeletal = useEditorStore.getState().isPreviewPlaying;
      const live = isSimRunning() || useEditorStore.getState().particlePreview || previewSkeletal;
      if (!gate.shouldDraw(live, controlsMoving)) return;

      // Animation-editor preview is scoped to the EDITED clip only (a keyframe
      // `.anim.json` Animator clip — the only thing this editor opens). The clip is
      // posed by AnimationEditor's own `pose()` loop (keyframe sampler), and its
      // bone Transforms deform the mesh via syncBones' divergence-gated write-back —
      // exactly the path a scrub already uses, no mixer needed. So we deliberately
      // DON'T drive the global skeletal mixer during preview: doing so (the old
      // behaviour) made every OTHER rig's baked skeletal clip animate while the game
      // was stopped, and made syncBones treat preview as "playing" → its layer pass
      // re-posed the clip's bones from the stale ECS `Animator.time` (0), clobbering
      // the keyframe pose back to frame 0. The runtime preview flag stays hard-off
      // (cleared on unmount); only real Play drives skeletal mixers.


      // Sync game camera gizmo + PixiJS near plane
      _svCamClearColor = null;
      // F1: track whether an ACTIVE Camera entity drove gameCam this frame. If none
      // does (no Camera entity, or all deactivated), gameCam would keep its origin-
      // looking-down-(-Z) construction defaults → UI-mode 3D render + picking break.
      let cameraMatched = false;
      if (transformMeta && cameraMeta) {
        getCurrentWorld().query(transformMeta.trait, cameraMeta.trait).updateEach(([tf, cam], entity) => {
          const id = entity.id();
          if (deactivatedEntities.has(id)) return; // a deactivated camera is not active
          cameraMatched = true;
          // World-space pose (respects parenting), matching runtime
          // Scene3D.syncCamera — NOT the local tf. A parented Camera entity was
          // previously placed at its LOCAL transform here, so the editor's
          // ghost/game camera (and frustum gizmo) drifted from where GameView
          // actually renders it (F3). Fall back to local tf before
          // transformPropagation has run (first frame), like syncCamera.
          const wt = worldTransforms.get(id);
          const px = wt ? wt.x : tf.x, py = wt ? wt.y : tf.y, pz = wt ? wt.z : tf.z;
          const rx = wt ? wt.rx : tf.rx, ry = wt ? wt.ry : tf.ry, rz = wt ? wt.rz : tf.rz;
          _svCamPos.set(px, py, pz);
          _svCamClearColor = cam.clearColor ?? 0x000000;

          // Apply the entity's Euler directly (rotation.set). Earlier this
          // derived a forward vector and called ghostCam.lookAt — but lookAt
          // re-orients against the camera's up=(0,1,0), dropping any roll baked
          // into the rotation. That made "Copy from Editor Camera" visibly
          // drift the game-camera orientation. Direct set preserves it 1:1.

          ghostCam.fov = cam.fov;
          ghostCam.near = cam.near;
          ghostCam.far = Math.min(cam.far, 30);
          ghostCam.aspect = getGameAspect();
          ghostCam.updateProjectionMatrix();
          ghostCam.position.copy(_svCamPos);
          ghostCam.rotation.set(rx, ry, rz);
          ghostCam.updateMatrixWorld(true);

          // Update game camera for UI mode rendering
          gameCam.fov = cam.fov;
          gameCam.near = cam.near;
          gameCam.far = cam.far;
          gameCam.aspect = gameAspectFromRect(useEditorStore.getState().gameRect, getGameAspect());
          gameCam.updateProjectionMatrix();
          gameCam.position.copy(_svCamPos);
          gameCam.rotation.set(rx, ry, rz);

          // Drive the ortho sibling from the same pose + the Camera's orthoSize, then let
          // `projection` pick which camera 2D mode uses (matches Scene3D.syncCamera).
          gameOrthoCam.near = cam.near;
          gameOrthoCam.far = cam.far;
          gameOrthoCam.position.copy(_svCamPos);
          gameOrthoCam.rotation.set(rx, ry, rz);
          applyOrthoFrustum(gameOrthoCam, cam.orthoSize, gameCam.aspect);
          gameActiveCam = cam.projection === 'orthographic' ? gameOrthoCam : gameCam;

          // Sync pivot position + rotation from ECS Transform.
          // Re-parent to scene if a prior teardown (onWorldSwap) detached it —
          // otherwise the gizmo would attach to a parentless object and
          // TransformControls would warn every frame.
          if (camGizmoPivot.parent !== scene) scene.add(camGizmoPivot);
          camGizmoPivot.position.copy(_svCamPos);
          const isDraggingCam = gizmoEntityId === id && (gizmo as any).dragging;
          if (!isDraggingCam) {
            camGizmoPivot.rotation.set(rx, ry, rz);
          }
          // Refresh frustum geometry from the current Camera params; clamp far
          // so the visualization stays a usable size in the editor viewport.
          // Visibility is owned by the selection block below — hidden by default.
          updateCamFrustum(cam.fov, getGameAspect(), cam.near, Math.min(cam.far, 20));
          ecsGizmos.set(id, camGizmoPivot);

        });
      }

      // F1 fallback: no active Camera entity → drive gameCam from the editor orbit
      // camera so the UI-mode 3D render (renderer.render at the bottom) and UI-mode
      // picking (pick3D uses gameCam) work instead of rendering/raycasting from the
      // origin. Keep the game aspect for the letterboxed preview; take pose + lens
      // from the editor camera.
      if (!cameraMatched) {
        camera.updateMatrixWorld(true);
        gameCam.position.setFromMatrixPosition(camera.matrixWorld);
        gameCam.quaternion.setFromRotationMatrix(camera.matrixWorld);
        gameCam.fov = camera.fov;
        gameCam.near = camera.near;
        gameCam.far = camera.far;
        gameCam.aspect = gameAspectFromRect(useEditorStore.getState().gameRect, getGameAspect());
        gameCam.updateProjectionMatrix();
        gameCam.updateMatrixWorld(true);
        gameActiveCam = gameCam; // orbit fallback is perspective
      }

      // CameraFrame fit for the 2D-mode preview. gameCam is posed from the authored
      // Camera Transform above, but the game camera at RUNTIME is dollied/recentered by
      // the active CameraFrame (Scene3D.applyFraming). Mirror that here so 2D mode frames
      // the scene exactly like GameView instead of showing the raw authored pose (which
      // reads as "zoomed wrong"). Only when an authored Camera drove gameCam — the
      // no-camera fallback follows the editor orbit and must not be dollied. gameCam is a
      // PerspectiveCamera, so fit perspective (ortho=false); computeActiveFrameFit reads
      // gameCam's orientation + authored position and returns the framed position. A
      // continuous/edited frame re-fits every drawn frame (cheap: one query + 8 corners).
      if (cameraMatched) {
        const isOrtho = gameActiveCam === gameOrthoCam;
        const gAspect = gameCam.aspect; // both cams share the letterbox aspect
        const fit = computeActiveFrameFit(getCurrentWorld(), gameActiveCam, gAspect, isOrtho);
        if (fit) {
          gameActiveCam.position.copy(fit.position);
          if (isOrtho) applyOrthoFrustum(gameOrthoCam, fit.orthoSize, gAspect);
          gameActiveCam.updateMatrixWorld(true);
        }
      }

      // Sync ECS environment (shared runtime logic)
      syncEnvironment(getCurrentWorld(), scene);
      // WebGPU render-on-demand: a change to scene.environmentIntensity isn't monitored
      // by three's NodeMaterialObserver, so on this static-camera surface the env uniform
      // stays stale on some meshes until the camera moves. When it changes, trip the
      // observer so every mesh re-uploads it. See refreshEnvIntensityObserver's docs.
      if (scene.environmentIntensity !== prevEnvIntensity) {
        prevEnvIntensity = scene.environmentIntensity;
        refreshEnvIntensityObserver(scene);
      }
      // Editor-specific: environment gizmo icons + background fallback
      const envMeta = allTraits.find((t) => t.name === 'Environment');
      if (envMeta) {
        let envActive = false;
        getCurrentWorld().query(envMeta.trait).updateEach(([env], entity) => {
          if (deactivatedEntities.has(entity.id())) return;
          envActive = true;
          const envId = entity.id();
          // Environment gizmo icon
          if (transformMeta && entity.has(transformMeta.trait) && !ecsGizmos.has(envId)) {
            const mat = new THREE.MeshBasicMaterial({ color: 0x00cccc, wireframe: true });
            const g = new THREE.Mesh(GIZMO_SHAPES.environment, mat);
            scene.add(g);
            ecsGizmos.set(envId, g);
          }
          if (ecsGizmos.has(envId)) {
            const wt = worldTransforms.get(envId);
            if (wt) ecsGizmos.get(envId)!.position.set(wt.x, wt.y, wt.z);
          }
          // Editor background: show editor bg color when env doesn't show as background
          if (scene.environment && !env.showAsBackground) {
            scene.background = _editorBgColor;
          }
        });
        if (!envActive) {
          scene.background = _editorBgColor;
        }
      }

      // Sync ECS lights (shared runtime logic handles creation, update, and removal)
      // Snapshot light IDs before sync to detect removals for gizmo cleanup
      // (reuses the persistent preSyncLightIds Set — refilled, not reallocated).
      preSyncLightIds.clear();
      for (const id of ecsLights.keys()) preSyncLightIds.add(id);
      syncLights(getCurrentWorld(), scene, ecsLights);
      // Editor-specific: light gizmo icons + shadow-frustum coverage box
      let sfShown = false; // first directional light with showShadowFrustum wins the (single) box
      if (lightMeta) {
        getCurrentWorld().query(lightMeta.trait).updateEach(([light], entity) => {
          if (deactivatedEntities.has(entity.id())) return;
          const id = entity.id();
          if (!ecsGizmos.has(id)) {
            const mat = new THREE.MeshBasicMaterial({ color: light.color, wireframe: true });
            const g = new THREE.Mesh(GIZMO_SHAPES.light, mat);
            scene.add(g);
            ecsGizmos.set(id, g);
          }
          const g = ecsGizmos.get(id)!;
          ((g as THREE.Mesh).material as THREE.MeshBasicMaterial).color.setHex(light.color);
          const wt = worldTransforms.get(id);
          if (wt) g.position.set(wt.x, wt.y, wt.z);
          // Shadow-frustum viz: outline the shadow-camera coverage for a flagged
          // directional shadow-caster (single reusable box — one key light is typical).
          if (!sfShown && light.lightType === 'directional' && light.castShadow && light.showShadowFrustum) {
            const dl = ecsLights.get(id);
            if (dl instanceof THREE.DirectionalLight) {
              updateShadowFrustum(dl, light.shadowCameraSize || 16);
              sfShown = true;
            }
          }
        });
        // Clean up gizmos for lights that syncLights removed
        for (const id of preSyncLightIds) {
          if (!ecsLights.has(id)) {
            const g = ecsGizmos.get(id);
            if (g) { scene.remove(g); ((g as THREE.Mesh).material as THREE.Material | undefined)?.dispose(); ecsGizmos.delete(id); }
          }
        }
      }
      shadowFrustumLines.visible = sfShown;

      // Editor-specific: particle emitter gizmo icons (selectable/movable; the optional
      // in-scene effect preview is driven below, gated on the toolbar toggle).
      const peMeta = allTraits.find((t) => t.name === 'ParticleEmitter');
      if (peMeta && transformMeta) {
        const seenPe = particleScratchIds;
        seenPe.clear();
        getCurrentWorld().query(transformMeta.trait, peMeta.trait).updateEach((_vals, entity) => {
          if (deactivatedEntities.has(entity.id())) return;
          const id = entity.id();
          seenPe.add(id);
          if (!ecsGizmos.has(id)) {
            const mat = new THREE.MeshBasicMaterial({ color: 0xffaa33, wireframe: true });
            const g = new THREE.Mesh(GIZMO_SHAPES.particle, mat);
            scene.add(g);
            ecsGizmos.set(id, g);
          }
          const wt = worldTransforms.get(id);
          if (wt) ecsGizmos.get(id)!.position.set(wt.x, wt.y, wt.z);
        });
        // Remove icons for emitters deleted within the current scene.
        for (const id of particleGizmoIds) {
          if (!seenPe.has(id)) {
            const g = ecsGizmos.get(id);
            if (g) { scene.remove(g); ((g as THREE.Mesh).material as THREE.Material | undefined)?.dispose(); ecsGizmos.delete(id); }
          }
        }
        // Swap: this frame's seen becomes next frame's "previous"; the old
        // previous becomes the scratch we'll clear+refill next frame.
        particleScratchIds = particleGizmoIds;
        particleGizmoIds = seenPe;
      }

      // Sync ECS 3D renderables + skeletal rigs (shared runtime core +
      // editor gizmo callbacks). syncSceneRenderables3D runs the same
      // renderables→skinned→bones→boneAttachments sequence the runtime
      // Scene3D.renderFrame and the offscreen capture run, so the editor
      // viewport can't drift out of step with GameView (T2 / F3). The editor's
      // gizmo-aware callbacks ride along: skip transform sync only WHILE the
      // gizmo is actively being dragged on this entity (otherwise gizmo and ECS
      // fight per-frame); when merely attached, external ECS writes propagate.
      syncSceneRenderables3D(getCurrentWorld(), scene, renderState, {
        renderables: {
          shouldUpdateTransform: (id) => id !== gizmoEntityId || !(gizmo as { dragging?: boolean }).dragging,
          onMeshRemoved: (id) => {
            const outline = outlineMeshes.get(id);
            if (outline) {
              scene.remove(outline);
              outline.geometry.dispose();
              (outline.material as THREE.Material).dispose();
              outlineMeshes.delete(id);
            }
          },
        },
        skinned: {
          shouldUpdateTransform: (id) => id !== gizmoEntityId || !(gizmo as { dragging?: boolean }).dragging,
        },
      });

      // Editor-specific: CameraFrame framing-box gizmo. When `showGizmo` is on we
      // draw the oriented box (wireframe, world position/rotation/scale) and put
      // it in ecsGizmos so it's pickable + gizmo-editable (resize the framing
      // volume). When off it's reaped — so the (often large) box never steals
      // selection clicks; the entity then falls through to the small empty marker
      // below and stays selectable. Runs BEFORE the empty block so that block sees
      // it already in ecsGizmos (and skips it) when shown.
      {
        const seenFrame = frameScratchIds;
        seenFrame.clear();
        const gizmoShown = useEditorStore.getState().cameraGizmoShown;
        getCurrentWorld().query(CameraFrame, Transform).updateEach((_t: unknown[], entity) => {
          const id = entity.id();
          // Gate on the editor-persistent per-frame preference (by guid), NOT a scene trait —
          // so toggling the box survives reloads/hot-reloads without a Cmd+S and never ships.
          const guid = entity.get(EntityAttributes)?.guid ?? '';
          if (deactivatedEntities.has(id) || !guid || !gizmoShown.has(guid)) return;
          seenFrame.add(id);
          let g = ecsGizmos.get(id) as THREE.Mesh | undefined;
          // Take over a slot that held a different gizmo (e.g. the small empty
          // marker from the frame before showGizmo was toggled on).
          if (g && g.geometry !== GIZMO_SHAPES.frameBox) {
            scene.remove(g); (g.material as THREE.Material | undefined)?.dispose(); ecsGizmos.delete(id); g = undefined;
          }
          if (!g) {
            const mat = new THREE.MeshBasicMaterial({ color: 0x38bdf8, wireframe: true, transparent: true, opacity: 0.6 });
            g = new THREE.Mesh(GIZMO_SHAPES.frameBox, mat);
            scene.add(g);
            ecsGizmos.set(id, g);
          }
          // Don't fight the transform gizmo while this box is being dragged.
          const isDragging = gizmoEntityId === id && (gizmo as unknown as { dragging?: boolean }).dragging;
          const wt = worldTransforms.get(id);
          if (wt && !isDragging) {
            g.position.set(wt.x, wt.y, wt.z);
            g.rotation.set(wt.rx, wt.ry, wt.rz);
            g.scale.set(wt.sx || 1, wt.sy || 1, wt.sz || 1);
          }
        });
        // Reap boxes whose entity no longer shows the gizmo (toggled off, deleted,
        // deactivated) → they revert to the small empty marker + stop stealing clicks.
        for (const id of frameGizmoIds) {
          if (seenFrame.has(id)) continue;
          const g = ecsGizmos.get(id);
          if (g) { scene.remove(g); ((g as THREE.Mesh).material as THREE.Material | undefined)?.dispose(); ecsGizmos.delete(id); }
        }
        frameScratchIds = frameGizmoIds;
        frameGizmoIds = seenFrame;
      }

      // Editor-specific: Zone3D volume gizmo. A game-logic zone (fish swim area, spawn
      // region, trigger) drawn as a wireframe volume so it's positionable + resizable
      // with the standard transform gizmo, and pickable. Editor-ONLY (never in the built
      // game). Mirrors the CameraFrame box block: put it in ecsGizmos (pickable + gizmo-
      // editable), skip while dragging, reap when the trait/entity goes away. Runs BEFORE
      // the empty block so that block sees it in ecsGizmos and skips it.
      {
        const seenZone = zoneScratchIds;
        seenZone.clear();
        getCurrentWorld().query(Zone3D, Transform).updateEach(([zone], entity) => {
          const id = entity.id();
          if (deactivatedEntities.has(id)) return;
          seenZone.add(id);
          const wt = worldTransforms.get(id);
          const sx = wt?.sx || 1, sy = wt?.sy || 1, sz = wt?.sz || 1;
          // A capsule needs a PER-ZONE geometry: its radius (sx) and segment length (sy − 2·sx)
          // are independent, so a shared unit capsule + non-uniform scale can't reproduce it (the
          // caps distort and the drawn height comes out ~3× off — the unit capsule's intrinsic
          // height is 2·r+len=3, not 1). Build it sized to match zone3DSystem containment exactly:
          // radius = |sx|, total height = |sy| (cylindrical segment len = |sy| − 2·|sx|, clamped).
          const isCapsule = zone.shape === 'capsule';
          const capR = Math.abs(sx) || 1e-3;
          const capLen = Math.max(0, Math.abs(sy) - 2 * capR);
          const capSig = isCapsule ? `${capR.toFixed(4)}:${capLen.toFixed(4)}` : '';
          const wantGeo = zone.shape === 'circle' ? GIZMO_SHAPES.zoneCircle
            : zone.shape === 'plane' ? GIZMO_SHAPES.zonePlane
            : zone.shape === 'cylinder' ? GIZMO_SHAPES.zoneCylinder
            : zone.shape === 'box' ? GIZMO_SHAPES.frameBox
            : isCapsule ? null   // per-zone geometry, built/rebuilt below by size signature
            : GIZMO_SHAPES.zoneSphere;
          let g = ecsGizmos.get(id) as THREE.Mesh | undefined;
          // Rebuild if the slot held a different SHARED shape, if a capsule's size signature
          // changed, or if switching between capsule (per-zone geo) and a shared shape. Dispose
          // the per-zone capsule geometry (but NEVER a shared GIZMO_SHAPES geometry) on teardown.
          const hadCapGeo = !!(g?.userData as { zoneCapSig?: string } | undefined)?.zoneCapSig;
          const stale = g && ((wantGeo && g.geometry !== wantGeo) || (isCapsule && (g.userData as { zoneCapSig?: string }).zoneCapSig !== capSig) || (!isCapsule && hadCapGeo));
          if (g && stale) {
            scene.remove(g); (g.material as THREE.Material | undefined)?.dispose();
            if (hadCapGeo) g.geometry.dispose();
            ecsGizmos.delete(id); g = undefined;
          }
          if (!g) {
            const geo = isCapsule ? new THREE.CapsuleGeometry(capR, capLen, 6, 16) : wantGeo!;
            const mat = new THREE.MeshBasicMaterial({ color: zone.color, wireframe: true, transparent: true, opacity: 0.6 });
            g = new THREE.Mesh(geo, mat);
            if (isCapsule) (g.userData as { zoneCapSig?: string }).zoneCapSig = capSig;
            scene.add(g);
            ecsGizmos.set(id, g);
          }
          (g.material as THREE.MeshBasicMaterial).color.set(zone.color);
          const isDragging = gizmoEntityId === id && (gizmo as unknown as { dragging?: boolean }).dragging;
          if (wt && !isDragging) {
            g.position.set(wt.x, wt.y, wt.z);
            g.rotation.set(wt.rx, wt.ry, wt.rz);
            // Radius-based shapes are uniform in XZ (radius = sx); box/plane use full scale; the
            // capsule bakes its size into its per-zone geometry (drawn 1:1, no scale).
            if (zone.shape === 'box') g.scale.set(sx, sy, sz);
            else if (zone.shape === 'plane') g.scale.set(sx, 1, sz);
            else if (zone.shape === 'cylinder') g.scale.set(sx, sy, sx);
            else if (isCapsule) g.scale.set(1, 1, 1);
            else g.scale.set(sx, sx, sx); // sphere / circle
          }
        });
        for (const id of zoneGizmoIds) {
          if (seenZone.has(id)) continue;
          const g = ecsGizmos.get(id) as THREE.Mesh | undefined;
          if (g) {
            scene.remove(g); (g.material as THREE.Material | undefined)?.dispose();
            if ((g.userData as { zoneCapSig?: string }).zoneCapSig) g.geometry.dispose(); // per-zone capsule geo
            ecsGizmos.delete(id);
          }
        }
        zoneScratchIds = zoneGizmoIds;
        zoneGizmoIds = seenZone;
      }

      // Editor-specific: generic gizmo icons for mesh-less 3D-space entities
      // (prefab roots, empty grouping/pivot nodes). Without these, an entity
      // that has only a Transform has no Three.js object to raycast against or
      // attach the gizmo to, so it can't be selected in the viewport. Runs
      // after syncRenderables + the camera/light/env/particle gizmo blocks so
      // ecsObjects and ecsGizmos are populated: anything already handled there
      // (has a mesh, or is a camera/light/env/particle) is skipped.
      {
        const seenEmpty = emptyScratchIds;
        seenEmpty.clear();
        // Fresh selection (the render loop reads it via getState below too) — a mesh-less
        // 3d group only gets an empty gizmo when IT is selected (see the layer check).
        const selForEmpty = useEditorStore.getState().selectedEntityId;
        getCurrentWorld().query(Transform).updateEach((_vals, entity) => {
          const id = entity.id();
          if (deactivatedEntities.has(id)) return;
          if (frameGizmoIds.has(id)) return; // a shown CameraFrame box owns this id
          if (zoneGizmoIds.has(id)) return;  // a Zone3D volume gizmo owns this id
          // Only entities with no renderable layer ('' = no Renderable trait).
          // Excludes 3d meshes (own object), 2d/ui entities (not in this view).
          // EXCEPTION: a Billboard3D entity is a SkinnedSprite2D (layer '2d') PROMOTED
          // into the 3D scene as a camera-facing mesh — it has a genuine 3D world
          // Transform but no ecsObjects mesh, so give it a 3D-space gizmo (move/scale
          // the whole billboard as a 3D object). Its bones are posed separately in 2D.
          const layer = entity.has(EntityAttributes) ? (entity.get(EntityAttributes)?.layer ?? '') : '';
          if ((layer === '2d' && !entity.has(Billboard3D)) || layer === 'ui') return;
          // A layer-'3d' entity normally owns a mesh (skipped by the ecsObjects check
          // below). But a mesh-LESS 3d group / pivot (e.g. the sling "Field" or "Game
          // Field" root, a prefab-instance root) has no Three object for the gizmo to
          // attach to. Give it an empty gizmo ONLY when it's the current selection — so
          // it's gizmo-editable from the Hierarchy WITHOUT spawning a pickable proxy box
          // for every mesh-less group (there can be hundreds, e.g. generated field tiles).
          if (layer === '3d' && id !== selForEmpty) return;
          // Skip entities that have a real mesh, or a specialized gizmo
          // (camera/light/env/particle add to ecsGizmos before this block).
          // Our own empty gizmos are in ecsGizmos too, but also in emptyGizmoIds,
          // so they fall through to be re-marked as seen and repositioned —
          // otherwise they'd be reaped by the cleanup loop and recreated every
          // frame (flicker).
          if (renderState.ecsObjects.has(id)) return;
          if (renderState.textMeshes.has(id)) return; // has a text mesh → not an "empty"
          if (ecsGizmos.has(id) && !emptyGizmoIds.has(id)) return;
          seenEmpty.add(id);
          let g = ecsGizmos.get(id);
          if (!g) {
            const mat = new THREE.MeshBasicMaterial({ color: 0x9aa7b4, wireframe: true });
            g = new THREE.Mesh(GIZMO_SHAPES.empty, mat);
            scene.add(g);
            ecsGizmos.set(id, g);
          }
          const wt = worldTransforms.get(id);
          if (wt) {
            g.position.set(wt.x, wt.y, wt.z);
            // Size the marker by the entity's WORLD scale, so a heavily-scaled rig's
            // bones (model root ~0.0005 × armature 100× ≈ 0.05) get small joint markers
            // instead of fixed 0.3-unit boxes that dwarf the whole model. Plain empties
            // (prefab roots, pivots) keep ~unit scale → the original 0.3 box.
            // EXCEPTION: a CameraFrame's scale IS its framing VOLUME (e.g. 11×3×17), not a
            // marker size — inheriting it would blow the "small empty marker" up to the full
            // frame box (the very box showGizmo=off is meant to hide). Keep it fixed-small so
            // the entity stays selectable without drawing a second frame-sized box.
            if (entity.has(CameraFrame)) {
              g.scale.set(1, 1, 1);
            } else {
              g.scale.set(Math.abs(wt.sx) || 1, Math.abs(wt.sy) || 1, Math.abs(wt.sz) || 1);
            }
          }
        });
        // Remove empty gizmos whose entity no longer qualifies (deleted,
        // deactivated, or gained a mesh — now in ecsObjects, not in seenEmpty).
        for (const id of emptyGizmoIds) {
          if (seenEmpty.has(id)) continue;
          // On a showGizmo OFF→ON toggle this frame's frame block already took over
          // this id (created the box + set frameGizmoIds); emptyGizmoIds is still
          // stale from last frame. Skip so we don't reap the just-created frame box.
          if (frameGizmoIds.has(id)) continue;
          if (zoneGizmoIds.has(id)) continue; // a Zone3D volume gizmo owns this id
          const g = ecsGizmos.get(id);
          if (g) { scene.remove(g); ((g as THREE.Mesh).material as THREE.Material | undefined)?.dispose(); ecsGizmos.delete(id); }
        }
        emptyScratchIds = emptyGizmoIds;
        emptyGizmoIds = seenEmpty;
      }

      // Update selection outline (3D meshes, gizmos, and 2D entities)
      const selectedId = useEditorStore.getState().selectedEntityId;

      // Sync gizmo mode from editor store
      const gizmoMode = useEditorStore.getState().gizmoMode;
      gizmo.setMode(gizmoMode);
      const gizmoSpace = useEditorStore.getState().gizmoSpace;
      gizmo.setSpace(gizmoSpace);

      // Detach if the currently-attached object isn't reachable from the
      // scene anymore (e.g. a model re-import destroyed + recreated
      // entities, leaving the gizmo pointing into a disposed sub-tree).
      // TransformControls walks the chain during render and warns
      // "The attached 3D object must be a part of the scene graph" on
      // every frame until we drop the dangling reference. Walking the full
      // chain (rather than just checking `parent === null`) catches both
      // direct orphans and grand-orphans whose immediate parent still
      // exists but is itself outside the scene tree.
      if (gizmo.object && !objectReachesScene(gizmo.object, scene)) {
        gizmo.detach();
        gizmoEntityId = null;
      }

      // Camera-frustum visibility: only when the camera entity (= the entity
      // whose gizmo *is* camGizmoPivot) is selected. Identifying by pivot
      // pointer avoids re-querying the world for the Camera trait here.
      camFrustumLines.visible = selectedId !== null &&
        ecsGizmos.get(selectedId) === camGizmoPivot;

      // ── 2.5D billboard bone gizmo target ──
      // If a Bone2D of a billboarded rig is selected, park `boneProxy` at the bone inside
      // its billboard `flip` group so the gizmo can pose it. ONLY in 2D (`ui`) view: a 2D
      // rig's bones are posed against the flat, camera-facing sprite there (the 3D view is
      // for placing the whole billboard as a 3D object). Falls through to the normal
      // ecsObjects/ecsGizmos target below for any other selection.
      boneGizmo = null;
      if (selectedId !== null && modeRef.current === 'ui') {
        const selEnt = findEntity(selectedId);
        if (selEnt?.has(Bone2D) && selEnt.has(Transform)) {
          // Walk up to the billboard entry (keyed by the SkinnedSprite2D entity id).
          let anc = selectedId, spriteId = 0; const seenAnc = new Set<number>();
          while (anc > 0 && !seenAnc.has(anc)) {
            if (renderState.billboards.has(anc)) { spriteId = anc; break; }
            seenAnc.add(anc);
            const e = findEntity(anc);
            anc = e?.has(EntityAttributes) ? (e.get(EntityAttributes).parentId as number) : 0;
          }
          const entry = spriteId ? renderState.billboards.get(spriteId) : undefined;
          const sEnt = spriteId ? findEntity(spriteId) : null;
          if (entry && sEnt?.has(Transform)) {
            // Bone position relative to the sprite (rig pixel space), mapped into the
            // billboard's `flip`-local frame (Y flipped, rotation negated — see geometry).
            const bw = getWorldTransform2DInto(_boneWt, selectedId, selEnt.get(Transform) as never);
            const sw = getWorldTransform2DInto(_spriteWt, spriteId, sEnt.get(Transform) as never);
            const rel = worldToLocal2D(bw, sw);
            if (boneProxy.parent !== entry.flip) entry.flip.add(boneProxy);
            // Don't fight an in-progress drag of this proxy (the gizmo owns it then).
            if (!((gizmo as any).dragging && gizmo.object === boneProxy)) {
              const pl = boneRelToProxyLocal(rel);
              boneProxy.position.set(pl.x, pl.y, pl.z);
              boneProxy.rotation.set(0, 0, pl.rz);
              boneProxy.scale.set(pl.sx || 1, pl.sy || 1, 1);
            }
            boneGizmo = { boneId: selectedId, spriteId };
          }
        }
      }
      if (!boneGizmo && boneProxy.parent) boneProxy.parent.remove(boneProxy);

      // Attach gizmo to selected entity.
      // A Billboard3D root is a 2D-layer rig PROMOTED into the 3D scene: pose it as a real
      // 3D object by driving its billboard `group` DIRECTLY — so the visible sprite tracks
      // the drag live (attaching to the mesh-less empty proxy instead froze it until
      // mouse-up). Shown in BOTH 3D and 2D view: the gizmo renders via the active camera
      // (gameCam in 2D), and it only appears when the ROOT is selected — posing a BONE
      // switches selection (→ boneGizmo) and uses the bone proxy instead, so the two never
      // conflict. (Was 3D-only; 2D-mode billboards were selectable but had no gizmo.)
      const selBbEntry = (selectedId !== null && !boneGizmo)
        ? renderState.billboards.get(selectedId) : undefined;
      const selObj = boneGizmo ? boneProxy
        : selBbEntry ? selBbEntry.group
        : (selectedId !== null
            ? (renderState.ecsObjects.get(selectedId) || renderState.textMeshes.get(selectedId)?.group || ecsGizmos.get(selectedId) || flameState.recs.get(selectedId)?.group)
            : null);
      if (selectedId !== null && selObj) {
        if (gizmo.object !== selObj) gizmo.attach(selObj);
        // Keep the write-back identity in sync with the SELECTION every frame, not just
        // when `gizmo.object` changes: all bones of one rig share `boneProxy`, so a
        // bone→bone switch leaves `gizmo.object` unchanged — without this, gizmoEntityId
        // would stay on the first bone and a drag would pose/undo the WRONG bone.
        gizmoEntityId = selectedId;
        // Bone gizmo acts as a 2D pose control IN the billboard plane: local space, and
        // only the in-plane handles (translate/scale = X+Y in the plane; rotate = Z about
        // the facing normal = the bone's rz). Restore all axes for any normal target.
        if (boneGizmo) {
          gizmo.setSpace('local');
          gizmo.showX = gizmoMode !== 'rotate';
          gizmo.showY = gizmoMode !== 'rotate';
          gizmo.showZ = gizmoMode === 'rotate';
        } else if (selBbEntry) {
          gizmo.setSpace('world');
          // A flat (ground-plane) sprite keeps its OWN Transform rotation (heading yaw),
          // so a rotate drag writes back through worldToLocal — offer all handles. A
          // camera-facing billboard's rotation is owned by orientBillboards, so a rotate
          // handle would be a silent no-op — offer only translate + scale there.
          gizmo.showX = gizmo.showY = gizmo.showZ = selBbEntry.mode === 'flat' || gizmoMode !== 'rotate';
        } else {
          gizmo.showX = gizmo.showY = gizmo.showZ = true;
        }
        (gizmo as any).visible = true;
        gizmo.enabled = true;
      } else {
        if (gizmo.object) {
          gizmo.detach();
        }
        gizmoEntityId = null;
        (gizmo as any).visible = false;
        gizmo.enabled = false;
      }

      if (selectedId !== null) {
        const outline = outlineMeshes.get(selectedId);

        // A CameraFrame owns its own on-screen representation: the teal frameBox
        // wireframe when showGizmo is on, or the small empty marker when off — and the
        // transform gizmo is attached to it either way. A yellow EdgesGeometry outline
        // on top is redundant (a second box). It's also buggy: `selObj` here is that
        // gizmo mesh, and the outline geometry is cached from whatever the gizmo slot
        // held when it was first built, never rebuilt when the slot swaps marker↔frameBox
        // — so the two boxes end up different sizes. Skip the outline for CameraFrame
        // entities entirely and drop any stale one.
        const selEnt = findEntity(selectedId);
        const isCameraFrame = !!selEnt && selEnt.isAlive() && selEnt.has(CameraFrame);
        if (isCameraFrame && outline) {
          outline.removeFromParent();
          outline.geometry.dispose();
          (outline.material as THREE.Material).dispose();
          outlineMeshes.delete(selectedId);
        }

        // Only build an outline for objects that actually have geometry.
        // Camera/Light/Environment gizmos resolve to bare Object3D pivots; passing
        // their (undefined) geometry to EdgesGeometry yields a positionless
        // BufferGeometry that makes WebGPU's NodeMaterial spam "AttributeNode:
        // Vertex attribute 'position' not found" every frame. A LOD-baked model is
        // the other shape here — see outlineSourceGeometry.
        const selGeo = outlineSourceGeometry(selObj);
        if (selObj && !isCameraFrame && !outline && selGeo) {
          const edges = new THREE.EdgesGeometry(selGeo);
          const newOutline = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0xf1c40f }));
          scene.add(newOutline);
          outlineMeshes.set(selectedId, newOutline);
        }
        if (selObj && outline && !isCameraFrame) {
          outline.position.copy(selObj.position);
          outline.rotation.copy(selObj.rotation);
          outline.scale.copy(selObj.scale);
        }

        // 2D entity selection outline is drawn by the Scene2DChromeOverlay (drawScene2D)
      }
      for (const [id, outline] of outlineMeshes) {
        if (id !== selectedId) {
          outline.removeFromParent();
          outline.geometry.dispose();
          (outline.material as THREE.Material).dispose();
          outlineMeshes.delete(id);
        }
      }

      // ── Descendants of the selected entity: dimmer secondary outline ──
      // Every mesh in the selected subtree gets a low-opacity yellow edges overlay, so a
      // group selection reads as one unit while the bright primary outline above still marks
      // the actual selection. The THREE graph is FLAT (world transforms baked onto scene-root
      // objects), so walk the ECS parent links via subtreeIds — an entity's children are NOT
      // its object's children. Same geometry filter as the primary outline: only real-geometry
      // meshes (ecsObjects / baked LODs) produce edges; mesh-less empties, gizmos, billboard
      // and text groups resolve to geometry-less pivots and are skipped. Edges are cached per
      // id (not rebuilt on a mid-selection mesh swap) — matches the primary outline's behavior;
      // a re-select refreshes them.
      const descOutlineIds = new Set<number>();
      if (selectedId !== null) {
        const subtree = subtreeIds(getAllEntities(), selectedId);
        for (let i = 1; i < subtree.length; i++) { // skip index 0 = the selected root
          const id = subtree[i];
          const obj = renderState.ecsObjects.get(id)
            || renderState.textMeshes.get(id)?.group
            || renderState.billboards.get(id)?.group
            || flameState.recs.get(id)?.group;
          const geo = obj ? outlineSourceGeometry(obj) : undefined;
          if (!obj || !geo) continue;
          descOutlineIds.add(id);
          let o = descOutlineMeshes.get(id);
          if (!o) {
            const edges = new THREE.EdgesGeometry(geo);
            o = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0xf1c40f, transparent: true, opacity: 0.35 }));
            scene.add(o);
            descOutlineMeshes.set(id, o);
          }
          o.position.copy(obj.position);
          o.rotation.copy(obj.rotation);
          o.scale.copy(obj.scale);
        }
      }
      for (const [id, o] of descOutlineMeshes) {
        if (!descOutlineIds.has(id)) {
          o.removeFromParent();
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
          descOutlineMeshes.delete(id);
        }
      }

      // ── Collider3D wireframe gizmos (3D mode) ──
      // The SELECTED entity's collider is always outlined (green). With the "Colliders" toggle
      // on, EVERY Collider3D is outlined too (amber) — so generated/child colliders (field rim
      // walls, fences, enemy bodies) are visible for debugging without selecting each. Edges
      // match the collider shape/dims and follow the entity's WORLD pose; primitive colliders
      // ignore Transform.scale (dims are absolute) → scale=1, mesh (convex/trimesh) colliders
      // bake scale → follow world scale. Rebuilt only when the shape/colour signature changes.
      if (modeRef.current !== 'ui') {
        const wantCollider = new Set<number>();
        const drawCollider = (id: number, color: number) => {
          const cEnt = findEntity(id);
          if (!cEnt || !cEnt.isAlive() || !cEnt.has(Collider3D) || deactivatedEntities.has(id)) return;
          wantCollider.add(id);
          const c = cEnt.get(Collider3D) as unknown as ColliderOutline3DParams;
          const isMesh = c.shape === 'convex' || c.shape === 'trimesh';
          // Mesh-collider outline geometry: prefer the explicit Collider3D.mesh GUID (a
          // collider-ONLY entity — e.g. the field ramp back-wall — has no rendered object to
          // edge; this mirrors physics3DSystem's resolveColliderGeometry), else fall back to
          // edging this entity's own rendered Renderable3D mesh.
          const meshGuid = isMesh ? ((c as unknown as { mesh?: string }).mesh || '') : '';
          const meshGeo = isMesh
            ? ((meshGuid ? resolveMeshTemplate(meshGuid)?.geometry : undefined)
               ?? outlineSourceGeometry(renderState.ecsObjects.get(id)))
            : undefined;
          const sig = `${colliderOutlineSig3D(c)}:${color}` + (isMesh ? `:${meshGeo?.uuid ?? 'nomesh'}` : '');
          let wire = colliderWires.get(id);
          if (!wire || colliderWireSigs.get(id) !== sig) {
            disposeColliderWire(id);
            const geo = colliderWireframeGeometry(c, meshGeo ?? null);
            if (!geo) return;
            wire = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color }));
            scene.add(wire);
            colliderWires.set(id, wire);
            colliderWireSigs.set(id, sig);
          }
          const wt = worldTransforms.get(id);
          if (wt) {
            wire.position.set(wt.x, wt.y, wt.z);
            wire.rotation.set(wt.rx, wt.ry, wt.rz);
            wire.scale.set(isMesh ? (wt.sx || 1) : 1, isMesh ? (wt.sy || 1) : 1, isMesh ? (wt.sz || 1) : 1);
          }
        };
        // Bulk set first (amber); the selected entity overrides to green (drawn last so it wins).
        if (showCollidersRef.current) {
          getCurrentWorld().query(Collider3D).updateEach((_t: unknown[], entity) => {
            const id = entity.id();
            if (id !== selectedId) drawCollider(id, 0xe0a030);
          });
        }
        if (selectedId !== null) drawCollider(selectedId, 0x2ecc71);
        for (const [id] of colliderWires) if (!wantCollider.has(id)) disposeColliderWire(id);
      } else {
        for (const [id] of colliderWires) disposeColliderWire(id);
      }

      // Mode + layer visibility
      const isUI = modeRef.current === 'ui';
      const { show3D } = layersRef.current;

      // Switch gizmo camera to match the active viewport camera
      const activeGizmoCam = isUI ? gameActiveCam : camera;
      if (gizmo.camera !== activeGizmoCam) gizmo.camera = activeGizmoCam;

      // Editor helpers: visible in 3D mode only
      grid.visible = !isUI && showGridRef.current;
      axes.visible = !isUI;
      camGizmoPivot.visible = !isUI;
      // CameraFrame framing boxes stay visible in 2D mode too (still gated by showGizmo)
      // so the framing volume can be seen + tuned against the letterboxed device preview;
      // every other gizmo (empty markers, camera icons) stays 3D-only.
      for (const [id, g] of ecsGizmos) g.visible = !isUI || frameGizmoIds.has(id);
      controls.enabled = !isUI;

      // Opt-in: simulate + render emitter effects live in the scene. Uses its own backend
      // handles (independent of GameView) and a local wall-clock delta, since the editor's
      // Time trait isn't advancing here. Toggled off → tear the preview handles back down.
      // Works in both 3D mode (orbit `camera`) and 2D mode (`gameCam`, letterboxed) — both
      // cameras enable PARTICLE_LAYER, so particles preview correctly in either viewport.
      // Particles render in two situations: (a) the `+FX` authoring toggle while stopped, and (b)
      // inside the timeline PREVIEW envelope (scrub/preview). In the envelope the TIMELINE owns
      // emission (control restart/pause + playOnStart), so `+FX` is SUPPRESSED — forcePlay only
      // blanket-plays as the stopped-mode authoring aid (preview-mode-refactor §2.0 / Phase 5).
      const fxOn = useEditorStore.getState().particlePreview;
      const inPreview = inPreviewSession();
      if (fxOn || inPreview) {
        const now = performance.now();
        const dt = lastPreviewT ? Math.min((now - lastPreviewT) / 1000, 0.05) : 0;
        lastPreviewT = now;
        syncParticles(getCurrentWorld(), scene, particleState, dt, { forcePlay: fxOn && !inPreview });
      } else if (particleState.recs.size) {
        disposeParticleSyncState(particleState, scene);
        lastPreviewT = 0;
      }

      // Flame meshes are persistent scene geometry (not a simulated effect), so render
      // them always — gated only by 3D mode — so they're visible for positioning.
      if (!isUI) syncFlameMeshes(getCurrentWorld(), scene, flameState);
      else if (flameState.recs.size) disposeFlameMeshSyncState(flameState, scene);

      // Layer visibility
      for (const [, mesh] of renderState.ecsObjects) mesh.visible = show3D;

      // UI-mode backdrop = the Camera's clearColor, matching GameView's
      // syncCamera (F3). The env block above leaves a dark editor bg
      // (_editorBgColor) for authoring; in UI mode we want the shipped game's
      // background instead. Leave a TEXTURE background (env shown as backdrop)
      // alone — that's the game's real backdrop too.
      if (isUI && _svCamClearColor != null) {
        const bg = scene.background as THREE.Color | THREE.Texture | null;
        if (bg == null || (bg as THREE.Color).isColor) {
          if (_uiBgColor.getHex() !== _svCamClearColor) _uiBgColor.setHex(_svCamClearColor);
          scene.background = _uiBgColor;
        }
      }

      // 2D mode: letterbox viewport to match game aspect
      if (isUI) {
        const gameAspect = gameAspectFromRect(useEditorStore.getState().gameRect, getGameAspect());
        const cW = container.clientWidth;
        const cH = container.clientHeight;
        const { vpX, vpY, vpW, vpH } = computeLetterbox(cW, cH, gameAspect, /* round */ true);
        renderer.setScissorTest(false);
        renderer.setViewport(0, 0, cW, cH);
        renderer.clear();
        renderer.setScissorTest(true);
        renderer.setScissor(vpX, vpY, vpW, vpH);
        renderer.setViewport(vpX, vpY, vpW, vpH);
      } else {
        renderer.setScissorTest(false);
        renderer.setViewport(0, 0, container.clientWidth, container.clientHeight);
      }

      // Face any 2.5D billboards toward the camera actually being rendered
      // (UI-mode uses the game cam, otherwise the editor orbit cam).
      orientBillboards(renderState, isUI ? gameActiveCam : camera);

      // Scoped suppression of Three.js's spurious 'Light node not found' warning
      // (F9) — patched only for this synchronous render call, then restored.
      withWarnFilter(() => renderer.render(scene, isUI ? gameActiveCam : camera));
    }
    // Renderer is already inited by makeWebGPURenderer — start the frame loop.
    if (!disposed) {
      registerFrameCallback(editorFrameKey, animate, PRIORITY_EDITOR_3D);
      startFrameDriver();
    }

    // ── Resize (using ResizeObserver for panel resizing) ──
    const resizeObserver = new ResizeObserver(() => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w === 0 || h === 0) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });
    resizeObserver.observe(container);

    cleanup = () => {
      disposed = true;
      _pickBillboardInUI = null; // drop the 2D-overlay picking bridge into the disposed viewport
      unregisterFocusHandler();
      setEditorViewportCamera(null); // drop the dangling reference to the disposed camera
      unsubSwap();
      unsubInvalidation();
      unregisterSurface();
      unregBounds();
      unregGizmo3DHandles();
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onPointerDownCapture, true);
      renderer.domElement.removeEventListener('pointermove', onPointerMoveCapture, true);
      renderer.domElement.removeEventListener('pointerup', onPointerUpCapture, true);
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onSelectMove);
      window.removeEventListener('pointerup', onSelectUp);
      unregisterFrameCallback(editorFrameKey);
      stopFrameDriver();
      controls.removeEventListener('change', markViewportDirty);
      for (const unsub of dirtyUnsubs) unsub();
      setSkeletalPreview(false, 0); // don't leave the runtime preview flag stuck on
      clearSkeletalSeeks(); // drop any timeline scrub-preview seek so a rig isn't pinned to a scrubbed frame
      controls.dispose();
      gizmo.removeEventListener('dragging-changed', onGizmoDraggingChanged);
      window.removeEventListener('keydown', onSnapKey);
      window.removeEventListener('keyup', onSnapKey);
      gizmo.removeEventListener('mouseDown', onGizmoMouseDown);
      gizmo.removeEventListener('change', onGizmoChange);
      gizmo.removeEventListener('mouseUp', onGizmoMouseUp);
      if (boneProxy.parent) boneProxy.parent.remove(boneProxy); // billboard bone-gizmo proxy
      scene.remove(gizmoHelper); // F5: explicit detach, independent of scene.clear() below
      gizmo.dispose();
      disposeRenderState(renderState, scene, true);
      disposeParticleSyncState(particleState, scene);
      disposeFlameMeshSyncState(flameState, scene);
      for (const [, outline] of outlineMeshes) {
        outline.geometry.dispose();
        (outline.material as THREE.Material).dispose();
      }
      for (const [, gizmo] of ecsGizmos) {
        // Some gizmos are THREE.Group containers (no material) — the onWorldSwap
        // teardown above already uses `?.dispose()` defensively; mirror that here.
        ((gizmo as THREE.Mesh).material as THREE.Material | undefined)?.dispose();
      }
      grid.geometry.dispose(); (grid.material as THREE.Material).dispose();
      axes.geometry.dispose(); (axes.material as THREE.Material).dispose();
      scene.environment = null; // detach shared env — cache owns the texture
      iconGeo.dispose();
      iconMat.dispose();
      camFrustumGeo.dispose();
      camFrustumMat.dispose();
      GIZMO_SHAPES.light.dispose();
      GIZMO_SHAPES.environment.dispose();
      GIZMO_SHAPES.particle.dispose();
      GIZMO_SHAPES.empty.dispose();
      GIZMO_SHAPES.frameBox.dispose();
      scene.clear();
      renderer.dispose();
      renderer.domElement.remove();
      initedRef.current = false;
    };
    }; // end setup

    // Fire-and-forget; the async body guards on `outerDisposed` after its await.
    void setup();

    return () => {
      outerDisposed = true;
      cleanup?.();
      initedRef.current = false;
    };
  }, []);

  return (
    <div
      ref={containerRef}
      data-scene-viewport
      style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}
    />
  );
}

import React from 'react';
