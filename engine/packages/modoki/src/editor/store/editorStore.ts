/** Editor state — separate from game state. Tracks selection, mode, etc. */

import { create } from 'zustand';
import { pushSelectionChange, isExecutingUndoRedo } from '../undo/undoManager';
import { entityRef, buildGuidIndex, resolveWith, type EntityRef } from '../undo/entityRef';
import { setParticleEffect } from '../../runtime/loaders/particleCache';
import { setSpriteAnim, type SpriteAnimDef } from '../../runtime/loaders/spriteAnimCache';
import { setRig2D, type Rig2DFile } from '../../runtime/loaders/rig2dCache';
import { mark2DDirty } from './canvas2DDirty';
import { editorEmit } from '../editorJournal';
import type { ParticleEffectDef } from '../../runtime/particles/types';
import { setAnimationClip } from '../../runtime/loaders/animationClipCache';
import type { AnimationClipDef } from '../../runtime/animation/types';
import { setTimeline } from '../../runtime/loaders/timelineCache';
import type { TimelineDef } from '../../runtime/timeline/types';

// Toast auto-dismiss state, module-scoped (F5): a newer toast clears the prior
// timer so N rapid toasts don't leave N zombie timers, and the id is a monotonic
// counter (not derived from current state) so two non-overlapping toasts can't
// collide on id===1 and defeat the dismiss guard.
let _toastTimer: ReturnType<typeof setTimeout> | null = null;
let _toastSeq = 0;

// CameraFrame "show gizmo" is an EDITOR-ONLY display preference, not scene/gameplay data —
// so it lives here (per-frame, by guid), persisted to localStorage, NOT serialized into the
// scene. That's what makes it survive reloads without a Cmd+S (a scene trait edit doesn't) and
// keeps editor chrome out of the shipped game. Membership = the gizmo is shown for that guid.
const CAM_GIZMO_LS_KEY = 'editor-camframe-gizmo';
function loadCamGizmoShown(): Set<string> {
  try { const a = JSON.parse(localStorage.getItem(CAM_GIZMO_LS_KEY) || '[]'); return new Set(Array.isArray(a) ? (a as string[]) : []); }
  catch { return new Set(); }
}
function saveCamGizmoShown(s: Set<string>): void {
  try { localStorage.setItem(CAM_GIZMO_LS_KEY, JSON.stringify([...s])); } catch { /* storage full/blocked */ }
}

export interface SelectedAsset {
  path: string;
  type: string;
  name: string;
}

/** Skin editor canvas mode. The canvas is modal (Spine/Unity style): each mode carries
 *  its own on-canvas tools — 'parts' places/moves each part's mesh, 'rig' adds/edits bones,
 *  'weights' paints per-vertex influence (heatmap + brush + test-pose). */
export type SkinMode = 'parts' | 'rig' | 'weights';

interface EditorState {
  /** Primary (anchor) selection — last-clicked entity. Drives the SceneView
   *  gizmo and all single-entity consumers. Always either null or a member of
   *  selectedEntityIds. */
  selectedEntityId: number | null;
  /** Full multi-selection set. [] when nothing selected, [id] for a single
   *  selection. The Inspector renders common traits across all of these. */
  selectedEntityIds: number[];
  /** Primary (lead) selected asset — drives the single-asset Inspector detail. */
  selectedAsset: SelectedAsset | null;
  /** Full multi-selection set of assets. [] when none, [asset] for a single
   *  selection. When length > 1 and all share a type, the Inspector renders a
   *  batch editor (edit import settings across all at once). */
  selectedAssets: SelectedAsset[];
  gizmoMode: 'translate' | 'rotate' | 'scale';
  /** Coordinate space for gizmo transforms */
  gizmoSpace: 'world' | 'local';
  /** On-canvas collider-mesh editing: when true, the selected entity's polygon/mesh
   *  Collider2D shows draggable vertex handles in the 2D SceneView (Phase 4.3). */
  colliderEditMode: boolean;
  /** Overlay the UIFocusable navigation graph in the 2D SceneView: arrows between
   *  focusables (solid = explicit navUp/Down/Left/Right link, dashed = the spatial
   *  fallback the runtime would pick), focusOrder badges, autoFocus marker. Purely a
   *  visualization — no editing. Off by default; toggled from the UI-mode toolbar. */
  showFocusGraph: boolean;
  /** SceneView viewport mode: '3d' (Three.js) or 'ui' (2D/UI overlay). Lifted from
   *  SceneView-local state into the store so it's agent-drivable (set-scene-view-mode)
   *  — the mode selector is a native <select> that trusted input can't operate. */
  sceneViewMode: '3d' | 'ui';
  /** Opt-in: simulate + render ParticleEmitter effects live in the 3D SceneView */
  particlePreview: boolean;
  gameViewSize: { width: number; height: number };
  /** Valid game rendering area within the Game panel (excludes letterbox strips) */
  gameRect: { left: number; top: number; width: number; height: number };
  /** Incremented to trigger Assets panel refresh */
  assetsVersion: number;
  /** Import progress modal state. step/totalSteps render a determinate bar
   *  when both > 0; otherwise the modal shows an indeterminate animation. */
  importStatus: { active: boolean; message: string; step: number; totalSteps: number; failed?: boolean };
  /** Build progress state. `errorDetail` holds the failing step's output tail
   *  (populated on failure) so the modal can show WHY, not just THAT, it failed. */
  buildStatus: { active: boolean; message: string; step: number; totalSteps: number; failed: boolean; errorDetail?: string };
  /** Transient toast notice (e.g. save succeeded / blocked). Auto-clears. */
  toast: { id: number; message: string; kind: 'info' | 'warn' | 'success' } | null;
  /** Selective Apply-to-Prefab dialog state */
  applyPrefabDialog: { active: boolean; rootInstanceId: number | null };
  /** Selective Revert-to-Prefab dialog state */
  revertPrefabDialog: { active: boolean; rootInstanceId: number | null };
  /** Project Settings window open state */
  projectSettingsOpen: boolean;
  /** "Clean Up Unused Assets" dialog open state */
  cleanupAssetsOpen: boolean;
  /** "Build Support" dialog open state (toolchain detection + install/guide). */
  buildSupportOpen: boolean;
  /** Particle asset currently open in the Particle Editor panel (null = none). */
  editingParticleAsset: SelectedAsset | null;
  /** Live def for the open particle asset. The single source of truth the editor form
   *  renders and the global undo stack mutates — kept here (not in the panel's React
   *  state) so undo/redo applies even when the panel is unfocused or on another tab. */
  editingParticleDef: ParticleEffectDef | null;
  /** Bumped on every openParticleEditor so the panel/tab re-focuses even if reopened. */
  particleEditNonce: number;
  /** A request to dock/focus a panel by its component id — the generic open-panel
   *  channel (EditorApp watches this and calls dockPanel). Drives the Inspector's
   *  asset-ref "Open" button for game panels (FieldHint.editorPanel), so game code
   *  can surface its editor without reaching into the FlexLayout model. `nonce`
   *  makes a repeat open of the SAME panel re-focus it. */
  panelOpenRequest: { id: string; nonce: number } | null;
  /** GUIDs of CameraFrame entities whose framing-box gizmo is shown in the SceneView — an
   *  editor-only, localStorage-persisted display preference (see CAM_GIZMO_LS_KEY). The
   *  SceneView reads this (not a trait) to gate the box; toggled from the Inspector. */
  cameraGizmoShown: Set<string>;
  /** A request to open a Texture-Inspector modal (Sprite slicer / 9-slice editor) on a
   *  texture. Those modals are local to TextureAssetView, which only mounts when the
   *  texture is the selected asset — so `requestTextureEditor` selects the asset AND sets
   *  this; TextureAssetView opens the matching modal when its `path` matches, then clears
   *  it. Enables headless open (agent parity), same rationale as openParticleEditor. */
  textureEditorRequest: { path: string; kind: 'sprite' | 'nineslice'; nonce: number } | null;

  /** .spriteanim asset currently open in the SpriteAnim Editor (null = none). */
  editingSpriteAnimAsset: SelectedAsset | null;
  /** Live def for the open sprite-anim set — single source of truth the panel renders
   *  and the global undo stack mutates (kept here, not in panel state, so undo applies
   *  cross-tab). */
  editingSpriteAnimDef: SpriteAnimDef | null;
  /** Bumped on every openSpriteAnimEditor so the panel/tab re-focuses even if reopened. */
  spriteAnimEditNonce: number;

  /** .rig2d asset currently open in the Skin Editor (null = none). */
  editingSkinAsset: SelectedAsset | null;
  /** Live rig def (raw JSON form) for the open .rig2d asset — single source of truth. */
  editingSkinDef: Rig2DFile | null;
  /** Bumped on every openSkinEditor so the panel/tab re-focuses even if reopened. */
  skinEditNonce: number;
  /** Active part index for a multi-part (v2) rig — the part the Skin editor's canvas +
   *  mesh/weight edits operate on. Bones are shared across parts. 0 for a v1 rig. */
  activeSkinPart: number;
  /** Part indices hidden in the Skin editor's CANVAS PREVIEW only — an editor-local
   *  focus aid. It does NOT touch the asset's runtime `visible` field, so hiding a part
   *  while authoring never affects SceneView / GameView. Reset when a new rig opens. */
  skinPreviewHidden: number[];
  /** Active Skin-editor canvas mode (parts placement / bone rigging / weight painting). */
  skinMode: SkinMode;
  /** Rig-mode sub-tool (canvas): select/move joints vs click-to-add a bone. In the store so
   *  the toolbar (SkinEditor) and the canvas pointer handling (SkinCanvas) share it. */
  skinBoneTool: 'select' | 'add';
  /** Weights-mode sub-tool (canvas): paint the brush vs test-pose the bone (preview). */
  skinWeightTool: 'paint' | 'transform';
  /** SceneView weight-view mode: render the skinned mesh as an opaque weight heatmap
   *  (selected bone) / dominant-bone map (no bone) instead of the sprite texture. */
  skinWeightView: boolean;
  skinHideTexture: boolean; // Weights mode: hide the sprite backdrop, show only the weight heatmap
  /** Weight-paint brush: drag on the mesh in SceneView to paint the SELECTED bone's
   *  influence into nearby vertices of the open rig. */
  skinPaint: { radius: number; strength: number; brush: 'add' | 'subtract' | 'set' };

  /** Animation clip asset currently open in the Animation Editor (null = none). */
  editingAnimationAsset: SelectedAsset | null;
  /** Live def for the open clip — single source of truth the timeline renders and the
   *  global undo stack mutates (kept here, not in panel state, so undo applies cross-tab). */
  editingAnimationClip: AnimationClipDef | null;
  /** Entity carrying the Animator that binds this clip (the relative-path root). */
  animatorRootEntityId: number | null;
  /** Bumped on every openAnimationEditor so the panel/tab re-focuses even if reopened. */
  animationEditNonce: number;

  /** Timeline asset currently open in the Timeline Editor (null = none). */
  editingTimelineAsset: SelectedAsset | null;
  /** Live def for the open timeline — single source of truth the panel renders + the
   *  global undo stack mutates (kept here, not panel state, so undo applies cross-tab). */
  editingTimelineDoc: TimelineDef | null;
  /** Entity carrying the Director that binds this timeline (the relative-path root). */
  directorRootEntityId: number | null;
  /** Bumped on every openTimelineEditor so the panel/tab re-focuses even if reopened. */
  timelineEditNonce: number;
  /** Prefab currently open in isolated prefab-edit mode (null = editing a normal
   *  scene). `guid` is the prefab's stable asset GUID, `path` its file path. */
  editingPrefab: { path: string; guid: string; name: string } | null;
  /** Scene path to restore when leaving prefab-edit mode (the scene the user was
   *  in when they opened the prefab). Null ⇒ fall back to the last scene. */
  prefabReturnScenePath: string | null;

  /** Current playhead position in seconds (drives scrub/preview + record insertion). */
  playheadTime: number;
  /** Record mode: editing a trait field inserts/updates a key at the playhead. */
  isRecording: boolean;
  /** Preview playback running (advances the playhead each frame). */
  isPreviewPlaying: boolean;

  selectEntity: (id: number | null) => void;
  /** Replace the whole selection set. `primary` becomes the anchor (defaults to
   *  the last id). Used by Shift-range selection. */
  setSelectedEntities: (ids: number[], primary?: number | null) => void;
  /** Cmd/Ctrl-click: toggle one entity in/out of the current set. The toggled
   *  (or, on removal, the remaining last) entity becomes the primary. */
  toggleEntitySelection: (id: number) => void;
  selectAsset: (asset: SelectedAsset | null) => void;
  /** Replace the whole asset selection set (Cmd/Shift multi-select in the Assets
   *  panel). `primary` becomes the lead (defaults to the last). Clears entities. */
  setSelectedAssets: (assets: SelectedAsset[], primary?: SelectedAsset | null) => void;
  openApplyPrefabDialog: (rootInstanceId: number) => void;
  closeApplyPrefabDialog: () => void;
  openRevertPrefabDialog: (rootInstanceId: number) => void;
  closeRevertPrefabDialog: () => void;
  openProjectSettings: () => void;
  closeProjectSettings: () => void;
  openCleanupAssets: () => void;
  closeCleanupAssets: () => void;
  openBuildSupport: () => void;
  closeBuildSupport: () => void;
  setGizmoMode: (mode: 'translate' | 'rotate' | 'scale') => void;
  setColliderEditMode: (on: boolean) => void;
  setShowFocusGraph: (on: boolean) => void;
  setSceneViewMode: (mode: '3d' | 'ui') => void;
  setGizmoSpace: (space: 'local' | 'world') => void;
  setParticlePreview: (on: boolean) => void;
  setGameViewSize: (width: number, height: number) => void;
  setGameRect: (rect: EditorState['gameRect']) => void;
  refreshAssets: () => void;
  setImportStatus: (active: boolean, message?: string, step?: number, totalSteps?: number) => void;
  /** Put the import modal into a failed state with a message + OK button. Use
   *  when an import/convert throws so the user sees why instead of an unhandled
   *  rejection in the console. */
  setImportError: (message: string) => void;
  setBuildStatus: (status: Partial<EditorState['buildStatus']>) => void;
  /** Show a transient toast notice; auto-clears after ~3.5s (kind tints it). */
  showToast: (message: string, kind?: 'info' | 'warn' | 'success') => void;
  openParticleEditor: (asset: SelectedAsset) => void;
  /** Dock/focus a registered editor panel by its component id (see panelOpenRequest). */
  openPanel: (id: string) => void;
  /** Toggle whether a CameraFrame's framing-box gizmo shows (by guid). Editor-persistent. */
  setCameraGizmoShown: (guid: string, on: boolean) => void;
  closeParticleEditor: () => void;
  /** Select a texture asset and request its Sprite slicer / 9-slice modal to open. */
  requestTextureEditor: (path: string, kind: 'sprite' | 'nineslice', name?: string) => void;
  /** Clear a consumed texture-editor request (called by TextureAssetView after it opens). */
  clearTextureEditorRequest: () => void;
  /** Seed the open def from a freshly-loaded asset (updates the live cache, no undo entry). */
  loadParticleDef: (def: ParticleEffectDef) => void;
  /** Apply a def to a particle asset by path: refreshes the runtime cache (so GameView /
   *  preview reflect it) and the editor form when that path is the one currently open.
   *  Used by both live edits and undo/redo closures. */
  applyParticleDef: (path: string, def: ParticleEffectDef) => void;

  /** Open the SpriteAnim Editor on a .spriteanim asset. Clears the live def so the
   *  panel re-fetches. */
  openSpriteAnimEditor: (asset: SelectedAsset) => void;
  closeSpriteAnimEditor: () => void;
  /** Seed the open def from a freshly-loaded asset (updates the live cache, no undo entry). */
  loadSpriteAnimDef: (def: SpriteAnimDef) => void;
  /** Apply a def to a .spriteanim asset by path: refreshes the runtime cache (so live
   *  SpriteAnimators reflect it) and the editor panel when that path is open. Used by
   *  live edits and undo/redo closures. */
  applySpriteAnimDef: (path: string, def: SpriteAnimDef) => void;

  /** Open the Skin Editor on a .rig2d asset. Clears the live def so the panel re-fetches. */
  openSkinEditor: (asset: SelectedAsset) => void;
  closeSkinEditor: () => void;
  /** Seed the open rig def from a freshly-loaded asset (updates the runtime cache, no undo). */
  loadSkinDef: (def: Rig2DFile) => void;
  /** Apply a rig def to a .rig2d asset by path: refreshes the runtime rig2dCache (so live
   *  SkinnedSprite2D entities re-skin) and the editor panel when that path is open. */
  applySkinDef: (path: string, def: Rig2DFile) => void;
  setActiveSkinPart: (idx: number) => void;
  /** Toggle a part's CANVAS-PREVIEW visibility (editor-only; never persisted). */
  toggleSkinPreviewPart: (idx: number) => void;
  /** Replace the canvas-preview hidden set (e.g. show-all = [], hide-all = every idx). */
  setSkinPreviewHidden: (indices: number[]) => void;
  /** Switch the Skin canvas mode (parts / rig / weights). */
  setSkinMode: (mode: SkinMode) => void;
  setSkinBoneTool: (tool: 'select' | 'add') => void;
  setSkinWeightTool: (tool: 'paint' | 'transform') => void;
  setSkinWeightView: (on: boolean) => void;
  setSkinHideTexture: (on: boolean) => void;
  setSkinPaint: (patch: Partial<{ radius: number; strength: number; brush: 'add' | 'subtract' | 'set' }>) => void;

  /** Open the Animation Editor on a clip asset, bound to `rootEntityId` (the Animator
   *  entity). Clears the live clip so the panel re-fetches. */
  openAnimationEditor: (asset: SelectedAsset, rootEntityId: number | null) => void;
  closeAnimationEditor: () => void;
  /** Seed the open clip from a freshly-loaded asset (updates the live cache, no undo). */
  loadAnimationClip: (clip: AnimationClipDef) => void;
  /** Apply a clip to an asset by path: refreshes the runtime cache + the editor form when
   *  that path is the one open. Used by live edits and undo/redo closures. */
  applyAnimationClip: (path: string, clip: AnimationClipDef) => void;
  setPlayhead: (t: number) => void;
  setRecording: (on: boolean) => void;
  setPreviewPlaying: (on: boolean) => void;
  setAnimatorRoot: (id: number | null) => void;

  /** Open the Timeline Editor on a `.timeline.json` asset, bound to `rootEntityId` (the
   *  Director entity). Clears the live doc so the panel re-fetches. */
  openTimelineEditor: (asset: SelectedAsset, rootEntityId: number | null) => void;
  closeTimelineEditor: () => void;
  /** Seed the open timeline from a freshly-loaded asset (updates the live cache, no undo). */
  loadTimelineDoc: (doc: TimelineDef) => void;
  /** Apply a timeline to an asset by path: refreshes the runtime cache + the editor form
   *  when that path is the one open. Used by live edits and undo/redo closures. */
  applyTimelineDoc: (path: string, doc: TimelineDef) => void;
  setDirectorRoot: (id: number | null) => void;

  /** Enter isolated prefab-edit mode. `returnScenePath` is the scene to restore
   *  on exit. Pure state — the caller orchestrates the synthetic-scene swap. */
  openPrefabEditor: (prefab: { path: string; guid: string; name: string }, returnScenePath: string | null) => void;
  /** Leave prefab-edit mode (clears both fields). The caller reloads the return
   *  scene before calling this. */
  closePrefabEditor: () => void;
}

/** A selection snapshot — the fields that together define what's selected. */
type SelectionSnapshot = Pick<EditorState, 'selectedEntityId' | 'selectedEntityIds' | 'selectedAsset' | 'selectedAssets'>;

export const useEditorStore = create<EditorState>((set, get) => {
  /** Apply a new selection and (unless inside undo/redo) push a single selection
   *  undo entry that restores the previous snapshot. Centralizes the
   *  prev-capture / pushSelectionChange boilerplate shared by every selection
   *  action so single- and multi-select stay consistent. */
  // Capture a selection snapshot as guid-based refs (non-minting — see entityRef)
  // so selection undo/redo re-resolve to current ids after a world rebuild
  // (Play→Stop) instead of restoring stale numeric ids. Asset selection is
  // path-based and needs no resolution.
  type SelectionRefs = { primary: EntityRef | null; ids: EntityRef[]; asset: SelectionSnapshot['selectedAsset']; assets: SelectionSnapshot['selectedAssets'] };
  const captureRefs = (snap: SelectionSnapshot): SelectionRefs => ({
    primary: snap.selectedEntityId != null ? entityRef(snap.selectedEntityId, false) : null,
    ids: snap.selectedEntityIds.map((id) => entityRef(id, false)),
    asset: snap.selectedAsset,
    assets: snap.selectedAssets,
  });
  const resolveSnap = (r: SelectionRefs): SelectionSnapshot => {
    const idx = buildGuidIndex();
    // Fall back to the captured raw id when a ref can't be guid-resolved (a
    // guid-less entity, or no backing world) — preserves the prior raw-id
    // restore behavior; selectionRestore handles live remap on the next swap.
    const ids = r.ids.map((ref) => resolveWith(ref, idx) ?? ref.rawId);
    const primary = r.primary ? (resolveWith(r.primary, idx) ?? r.primary.rawId) : null;
    // Asset selection is path-based — no guid resolution needed, just restore verbatim.
    return { selectedEntityId: primary, selectedEntityIds: ids, selectedAsset: r.asset, selectedAssets: r.assets };
  };

  const applySelection = (label: string, next: SelectionSnapshot) => {
    const prev = get();
    const prevSnap: SelectionSnapshot = {
      selectedEntityId: prev.selectedEntityId,
      selectedEntityIds: prev.selectedEntityIds,
      selectedAsset: prev.selectedAsset,
      selectedAssets: prev.selectedAssets,
    };
    set(next);
    if (!isExecutingUndoRedo()) {
      const prevRefs = captureRefs(prevSnap);
      const nextRefs = captureRefs(next);
      pushSelectionChange(label, () => set(resolveSnap(prevRefs)), () => set(resolveSnap(nextRefs)));
    }
  };

  return {
  selectedEntityId: null,
  selectedEntityIds: [],
  selectedAsset: null,
  selectedAssets: [],
  gizmoMode: 'translate',
  gizmoSpace: 'world',
  colliderEditMode: false,
  showFocusGraph: (typeof localStorage !== 'undefined' && localStorage.getItem('editor:showFocusGraph') === '1'),
  sceneViewMode: (typeof localStorage !== 'undefined' && localStorage.getItem('editor:sceneViewMode') === 'ui') ? 'ui' : '3d',
  particlePreview: false,
  gameViewSize: { width: 800, height: 450 },
  gameRect: { left: 0, top: 0, width: 800, height: 450 },
  assetsVersion: 0,
  importStatus: { active: false, message: '', step: 0, totalSteps: 0 },
  buildStatus: { active: false, message: '', step: 0, totalSteps: 5, failed: false },
  toast: null,
  applyPrefabDialog: { active: false, rootInstanceId: null },
  revertPrefabDialog: { active: false, rootInstanceId: null },
  projectSettingsOpen: false,
  cleanupAssetsOpen: false,
  buildSupportOpen: false,
  editingParticleAsset: null,
  textureEditorRequest: null,
  editingParticleDef: null,
  particleEditNonce: 0,
  panelOpenRequest: null,
  cameraGizmoShown: loadCamGizmoShown(),
  editingSpriteAnimAsset: null,
  editingSpriteAnimDef: null,
  spriteAnimEditNonce: 0,
  editingSkinAsset: null,
  editingSkinDef: null,
  skinEditNonce: 0,
  activeSkinPart: 0,
  skinPreviewHidden: [],
  skinMode: 'rig',
  skinBoneTool: 'select',
  skinWeightTool: 'paint',
  skinWeightView: false,
  skinHideTexture: false,
  skinPaint: { radius: 40, strength: 0.5, brush: 'add' },
  editingAnimationAsset: null,
  editingAnimationClip: null,
  animatorRootEntityId: null,
  animationEditNonce: 0,
  editingTimelineAsset: null,
  editingTimelineDoc: null,
  directorRootEntityId: null,
  timelineEditNonce: 0,
  editingPrefab: null,
  prefabReturnScenePath: null,
  playheadTime: 0,
  isRecording: false,
  isPreviewPlaying: false,

  selectEntity: (id) => {
    const prev = get();
    // No change: same primary AND not currently a multi-selection collapsing to it.
    if (prev.selectedEntityId === id && prev.selectedEntityIds.length <= 1) return;
    applySelection(id !== null ? `Select entity` : 'Deselect', {
      selectedEntityId: id,
      selectedEntityIds: id === null ? [] : [id],
      selectedAsset: null,
      selectedAssets: [],
    });
  },

  setSelectedEntities: (ids, primary) => {
    const unique = Array.from(new Set(ids));
    const anchor = primary !== undefined && primary !== null && unique.includes(primary)
      ? primary
      : (unique.length > 0 ? unique[unique.length - 1] : null);
    const prev = get();
    // No-op if the set is identical (order-independent) and the anchor unchanged.
    if (prev.selectedEntityId === anchor &&
        prev.selectedEntityIds.length === unique.length &&
        unique.every((x) => prev.selectedEntityIds.includes(x))) return;
    applySelection(
      unique.length > 1 ? `Select ${unique.length} entities` : (anchor !== null ? 'Select entity' : 'Deselect'),
      { selectedEntityId: anchor, selectedEntityIds: unique, selectedAsset: null, selectedAssets: [] },
    );
  },

  toggleEntitySelection: (id) => {
    const prev = get();
    const has = prev.selectedEntityIds.includes(id);
    const nextIds = has
      ? prev.selectedEntityIds.filter((x) => x !== id)
      : [...prev.selectedEntityIds, id];
    // Primary: the toggled entity when adding; when removing the current primary,
    // fall back to the last remaining member (or null).
    const nextPrimary = has
      ? (prev.selectedEntityId === id ? (nextIds[nextIds.length - 1] ?? null) : prev.selectedEntityId)
      : id;
    applySelection(
      has ? 'Deselect entity' : 'Add to selection',
      { selectedEntityId: nextPrimary, selectedEntityIds: nextIds, selectedAsset: null, selectedAssets: [] },
    );
  },

  selectAsset: (asset) => {
    const prev = get();
    // No change: same lead AND not collapsing a multi-asset selection to it.
    if (prev.selectedAsset?.path === asset?.path && prev.selectedAssets.length <= 1) return;
    applySelection(asset ? `Select ${asset.name}` : 'Deselect', {
      selectedEntityId: null,
      selectedEntityIds: [],
      selectedAsset: asset,
      selectedAssets: asset ? [asset] : [],
    });
  },

  setSelectedAssets: (assets, primary) => {
    // Dedupe by path, preserving first occurrence order.
    const seen = new Set<string>();
    const unique = assets.filter((a) => (seen.has(a.path) ? false : (seen.add(a.path), true)));
    const anchor = (primary && unique.some((a) => a.path === primary.path))
      ? primary
      : (unique.length > 0 ? unique[unique.length - 1] : null);
    const prev = get();
    // No-op if the set is identical (order-independent) and the lead unchanged.
    if (prev.selectedAsset?.path === (anchor?.path ?? undefined) &&
        prev.selectedAssets.length === unique.length &&
        unique.every((a) => prev.selectedAssets.some((p) => p.path === a.path))) return;
    applySelection(
      unique.length > 1 ? `Select ${unique.length} assets` : (anchor ? `Select ${anchor.name}` : 'Deselect'),
      { selectedEntityId: null, selectedEntityIds: [], selectedAsset: anchor, selectedAssets: unique },
    );
  },

  // Gizmo mode/space are editor-only state (not ECS writes), so they don't flow through
  // addDirtyListener → mark2DDirty like a trait edit does. The 2D SceneView overlay is
  // version-gated (redraws only when the 2D dirty version bumps), so without this an idle
  // 2D scene keeps drawing the PREVIOUS gizmo until some unrelated redraw fires — the mode
  // toggle looked like a no-op. Mark dirty here so translate/rotate/scale (and world/local)
  // repaint immediately. 3D uses its own gate (useEditorStore.subscribe(markViewportDirty)).
  setGizmoMode: (mode) => { if (get().gizmoMode !== mode) editorEmit('!gizmo', { mode }); set({ gizmoMode: mode }); mark2DDirty(); },
  setColliderEditMode: (on) => set({ colliderEditMode: on }),
  setShowFocusGraph: (on) => {
    if (typeof localStorage !== 'undefined') localStorage.setItem('editor:showFocusGraph', on ? '1' : '0');
    set({ showFocusGraph: on });
  },
  setSceneViewMode: (mode) => {
    if (get().sceneViewMode === mode) return;
    editorEmit('!sceneviewmode', { mode });
    set({ sceneViewMode: mode });
    if (typeof localStorage !== 'undefined') localStorage.setItem('editor:sceneViewMode', mode);
    mark2DDirty();
  },
  setGizmoSpace: (space: 'local' | 'world') => { if (get().gizmoSpace !== space) editorEmit('!gizmo', { space }); set({ gizmoSpace: space }); mark2DDirty(); },
  setParticlePreview: (on: boolean) => set({ particlePreview: on }),
  setGameViewSize: (width, height) => set({ gameViewSize: { width, height } }),
  setGameRect: (rect) => set({ gameRect: rect }),
  refreshAssets: () => set((s) => ({ assetsVersion: s.assetsVersion + 1 })),
  setImportStatus: (active, message = '', step = 0, totalSteps = 0) =>
    set({ importStatus: { active, message, step, totalSteps, failed: false } }),
  setImportError: (message) =>
    set({ importStatus: { active: true, message, step: 0, totalSteps: 0, failed: true } }),
  setBuildStatus: (status) => set((s) => ({ buildStatus: { ...s.buildStatus, ...status } })),
  showToast: (message, kind = 'info') => {
    if (_toastTimer !== null) clearTimeout(_toastTimer); // clear the prior toast's timer
    const id = ++_toastSeq;
    set({ toast: { id, message, kind } });
    _toastTimer = setTimeout(() => {
      _toastTimer = null;
      if (get().toast?.id === id) set({ toast: null });
    }, 3500);
  },
  openApplyPrefabDialog: (rootInstanceId) => set({ applyPrefabDialog: { active: true, rootInstanceId } }),
  closeApplyPrefabDialog: () => set({ applyPrefabDialog: { active: false, rootInstanceId: null } }),
  openRevertPrefabDialog: (rootInstanceId) => set({ revertPrefabDialog: { active: true, rootInstanceId } }),
  closeRevertPrefabDialog: () => set({ revertPrefabDialog: { active: false, rootInstanceId: null } }),
  openProjectSettings: () => set({ projectSettingsOpen: true }),
  closeProjectSettings: () => set({ projectSettingsOpen: false }),
  openCleanupAssets: () => set({ cleanupAssetsOpen: true }),
  closeCleanupAssets: () => set({ cleanupAssetsOpen: false }),
  openBuildSupport: () => set({ buildSupportOpen: true }),
  closeBuildSupport: () => set({ buildSupportOpen: false }),
  openParticleEditor: (asset) => set((s) => ({ editingParticleAsset: asset, editingParticleDef: null, particleEditNonce: s.particleEditNonce + 1 })),
  openPanel: (id) => set((s) => ({ panelOpenRequest: { id, nonce: (s.panelOpenRequest?.nonce ?? 0) + 1 } })),
  setCameraGizmoShown: (guid, on) => set((s) => {
    if (!guid) return {};
    const next = new Set(s.cameraGizmoShown);
    if (on) next.add(guid); else next.delete(guid);
    saveCamGizmoShown(next);
    return { cameraGizmoShown: next };
  }),
  requestTextureEditor: (path, kind, name) => set((s) => ({
    selectedAsset: { path, type: 'texture', name: name ?? path.split('/').pop() ?? path },
    selectedEntityId: null, selectedEntityIds: [],
    textureEditorRequest: { path, kind, nonce: (s.textureEditorRequest?.nonce ?? 0) + 1 },
  })),
  clearTextureEditorRequest: () => set({ textureEditorRequest: null }),
  closeParticleEditor: () => set({ editingParticleAsset: null, editingParticleDef: null }),
  loadParticleDef: (def) => {
    const { editingParticleAsset } = get();
    if (editingParticleAsset) setParticleEffect(editingParticleAsset.path, def);
    set({ editingParticleDef: def });
  },
  applyParticleDef: (path, def) => {
    setParticleEffect(path, def);
    set((s) => (s.editingParticleAsset?.path === path ? { editingParticleDef: def } : {}));
  },

  openSpriteAnimEditor: (asset) => set((s) => ({ editingSpriteAnimAsset: asset, editingSpriteAnimDef: null, spriteAnimEditNonce: s.spriteAnimEditNonce + 1 })),
  closeSpriteAnimEditor: () => set({ editingSpriteAnimAsset: null, editingSpriteAnimDef: null }),
  loadSpriteAnimDef: (def) => {
    const { editingSpriteAnimAsset } = get();
    if (editingSpriteAnimAsset) setSpriteAnim(editingSpriteAnimAsset.path, def);
    set({ editingSpriteAnimDef: def });
  },
  applySpriteAnimDef: (path, def) => {
    setSpriteAnim(path, def);
    set((s) => (s.editingSpriteAnimAsset?.path === path ? { editingSpriteAnimDef: def } : {}));
  },
  openSkinEditor: (asset) => set((s) => ({ editingSkinAsset: asset, editingSkinDef: null, skinEditNonce: s.skinEditNonce + 1, activeSkinPart: 0, skinPreviewHidden: [] })),
  closeSkinEditor: () => set({ editingSkinAsset: null, editingSkinDef: null }),
  loadSkinDef: (def) => {
    const { editingSkinAsset } = get();
    if (editingSkinAsset) setRig2D(editingSkinAsset.path, def);
    set({ editingSkinDef: def });
  },
  applySkinDef: (path, def) => {
    setRig2D(path, def);
    // Redraw the SceneView: weight edits (auto-weight/paint) change the heatmap even when
    // the bind-pose mesh positions don't, so nothing else would trigger a repaint until the
    // next pointer event. Cheap flag set (no React re-render), safe to call per paint move.
    mark2DDirty();
    set((s) => (s.editingSkinAsset?.path === path ? { editingSkinDef: def } : {}));
  },
  setSkinWeightView: (on) => set({ skinWeightView: on }),
  setSkinHideTexture: (on) => set({ skinHideTexture: on }),
  setActiveSkinPart: (idx) => set({ activeSkinPart: Math.max(-1, idx | 0) }), // -1 = none selected
  toggleSkinPreviewPart: (idx) => set((s) => ({ skinPreviewHidden: s.skinPreviewHidden.includes(idx) ? s.skinPreviewHidden.filter((i) => i !== idx) : [...s.skinPreviewHidden, idx] })),
  setSkinPreviewHidden: (indices) => set({ skinPreviewHidden: indices }),
  setSkinMode: (mode) => set({ skinMode: mode }),
  setSkinBoneTool: (tool) => set({ skinBoneTool: tool }),
  setSkinWeightTool: (tool) => set({ skinWeightTool: tool }),
  setSkinPaint: (patch) => set((s) => ({ skinPaint: { ...s.skinPaint, ...patch } })),

  openAnimationEditor: (asset, rootEntityId) => set((s) => ({
    editingAnimationAsset: asset,
    editingAnimationClip: null,
    animatorRootEntityId: rootEntityId,
    animationEditNonce: s.animationEditNonce + 1,
    playheadTime: 0,
    isRecording: false,
    isPreviewPlaying: false,
  })),
  closeAnimationEditor: () => set({ editingAnimationAsset: null, editingAnimationClip: null, animatorRootEntityId: null, isRecording: false, isPreviewPlaying: false }),
  loadAnimationClip: (clip) => {
    const { editingAnimationAsset } = get();
    if (editingAnimationAsset) setAnimationClip(editingAnimationAsset.path, clip);
    set({ editingAnimationClip: clip });
  },
  applyAnimationClip: (path, clip) => {
    setAnimationClip(path, clip);
    set((s) => (s.editingAnimationAsset?.path === path ? { editingAnimationClip: clip } : {}));
  },
  setPlayhead: (t) => set({ playheadTime: Math.max(0, t) }),
  setRecording: (on) => set({ isRecording: on }),
  setPreviewPlaying: (on) => set({ isPreviewPlaying: on }),
  setAnimatorRoot: (id) => set({ animatorRootEntityId: id }),

  openTimelineEditor: (asset, rootEntityId) => set((s) => ({
    editingTimelineAsset: asset,
    editingTimelineDoc: null,
    directorRootEntityId: rootEntityId,
    timelineEditNonce: s.timelineEditNonce + 1,
    playheadTime: 0,
    isPreviewPlaying: false,
  })),
  closeTimelineEditor: () => set({ editingTimelineAsset: null, editingTimelineDoc: null, directorRootEntityId: null, isPreviewPlaying: false }),
  loadTimelineDoc: (doc) => {
    const { editingTimelineAsset } = get();
    if (editingTimelineAsset) setTimeline(editingTimelineAsset.path, doc);
    set({ editingTimelineDoc: doc });
  },
  applyTimelineDoc: (path, doc) => {
    setTimeline(path, doc);
    set((s) => (s.editingTimelineAsset?.path === path ? { editingTimelineDoc: doc } : {}));
  },
  setDirectorRoot: (id) => set({ directorRootEntityId: id }),

  openPrefabEditor: (prefab, returnScenePath) => set({ editingPrefab: prefab, prefabReturnScenePath: returnScenePath }),
  closePrefabEditor: () => set({ editingPrefab: null, prefabReturnScenePath: null }),
  };
});

// Dev-only debug handle (mirrors window.__3d) — lets tooling drive editor state.
if (import.meta.env?.DEV && typeof window !== 'undefined') {
  (window as unknown as { __editorStore?: typeof useEditorStore }).__editorStore = useEditorStore;
}
