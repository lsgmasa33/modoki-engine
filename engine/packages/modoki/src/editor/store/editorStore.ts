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
import { FREE_PRESET, type DevicePreset, type Orientation } from '../scene/devicePresets';
import { panelMayStopPreview } from '../scene/previewOwnership';

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

// Small typed readers for the `editor:*`-prefixed localStorage prefs below (gizmo mode/space/
// pivot, particle preview) — same "editor-only display preference, not scene data" rationale as
// CAM_GIZMO_LS_KEY above, just for values that aren't a per-guid set.
// Exported (not just module-scope) so the "restores from localStorage / falls back for a
// foreign value" logic — the actual READ half of the persistence fix — is directly
// unit-testable. The store's initial-state block below only runs ONCE at module load, before
// any test can install a localStorage stub, so testing it via the constructed store would
// need `vi.resetModules()` — which desyncs this file's OTHER dynamic re-imports (spriteAnim/
// particle/animation/timeline caches) from the statically-imported singletons editorStore.ts
// itself uses, corrupting unrelated tests. Testing the pure functions directly avoids that.
export function lsBool(key: string, fallback: boolean): boolean {
  if (typeof localStorage === 'undefined') return fallback;
  const v = localStorage.getItem(key);
  return v === null ? fallback : v === '1';
}
export function lsEnum<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  if (typeof localStorage === 'undefined') return fallback;
  const v = localStorage.getItem(key);
  return v !== null && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
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
  /** Multi-select rotation/scale pivot (Unity's Pivot/Center toggle). Only matters when >1
   *  entity is selected — it chooses WHERE the single pivot point sits; the group rotates/scales
   *  rigidly around it either way. 'pivot' = the active (last-selected) entity's origin (that
   *  entity stays put, the rest orbit it); 'center' = the selection centroid. Move is identical
   *  either way. */
  gizmoPivot: 'pivot' | 'center';
  /** Phase 13 (scene-loading.md): which exact selection (a
   *  comma-joined entity-id key, matching the Inspector's own `selKey`) is unlocked
   *  for in-place editing of a ghosted (base-origin) entity. Store-backed (not
   *  component-local state) so BOTH the Inspector (field pointer-events gate) and
   *  the SceneView gizmo (Phase 9's `isGhostedEntity` handle gate) read the SAME
   *  unlock — a selection change naturally re-locks, since the stored key stops
   *  matching the new selKey. null = nothing unlocked. */
  unlockedGhostSelKey: string | null;
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
  /** Which view the Animation editor's timeline area is showing: the Dopesheet (keyframe
   *  TIMING, diamonds) or Curves (keyframe VALUES + easing, a graph). Lifted from
   *  AnimationEditor-local state into the store so it is agent-drivable
   *  (`set-animation-view-mode` / `modoki_set_animation_view_mode`, #369) — the same move
   *  `sceneViewMode` above records.
   *
   *  It is not cosmetic: exactly ONE of the two views is mounted, and each publishes its own
   *  interaction handles. `curves:tan:in|out:*` (kind 'tangent') exist ONLY in Curves, so with
   *  no way to set this, tangent editing was unreachable unless the human happened to have left
   *  the panel in Curves — and the default is 'dopesheet'. `modoki_handles editor=curves`
   *  correctly returned nothing, which reads as "this clip has no tangents".
   *
   *  Deliberately NOT persisted to localStorage, unlike `sceneViewMode`: it reset to
   *  'dopesheet' on every panel mount before it moved here, and restoring a view days later
   *  would change what a fresh editor shows. Lifting it DOES make the choice survive the panel
   *  being unmounted/reselected within a session, which the local `useState` did not — that is
   *  the same continuity `sceneViewMode` has, and the better behaviour. */
  animationViewMode: 'dopesheet' | 'curves';
  /** Whether the Animation panel is actually MOUNTED and running its effects.
   *
   *  Same requirement, and the same reason, as `gameViewMounted` below: FlexLayout defaults
   *  `tabEnableRenderOnDemand: true`, so an Animation tab that EXISTS in the layout but has never
   *  been selected does not mount — and `openPanels` reports it anyway, which is exactly the
   *  derivation #367 rejected as wrong. Without this the agent surface answers
   *  `animationViewMode:'curves'` for an editor showing no Animation view at all, and neither
   *  view's handle provider is registered, so `modoki_handles editor=curves` is empty for a
   *  reason the payload cannot express. Written by AnimationEditor's mount effect; nothing else
   *  may set it. */
  animationPanelMounted: boolean;
  /** Which FlexLayout panel owns the keyboard ('scene' | 'hierarchy' | 'animation-editor' | …),
   *  or null when nothing has been engaged yet. Set on capture-phase mousedown (click-to-focus).
   *
   *  STORE-BACKED ON PURPOSE, not derived from `document.activeElement`: clicking a Hierarchy row
   *  is a click on a plain <div>, so DOM focus stays on <body> (measured — every captured
   *  keypress reported target=BODY after clicking a row). Deriving it would report "nothing
   *  focused" for the panel the user is visibly working in.
   *
   *  Deliberately NOT in the FlexLayout model and NOT persisted: onModelChange debounce-saves the
   *  layout and re-IPCs the native menu, so model-resident focus would rewrite the autosave on
   *  every click. Resets to null on launch. See docs/editor-input.md. */
  focusedPanel: string | null;
  /** Component ids of every panel with an OPEN TAB in the current layout, custom panels
   *  included. Written by EditorApp from the one FlexLayout model walk it already does for
   *  the Window menu; nothing else may set it.
   *
   *  It exists so the AGENT surface can refuse a panel it cannot focus. `setFocusedPanel` is
   *  a bare setter by design (the human paths hand it a live tab component), so the
   *  `set-focus-scope` op used to store any string it was given and echo it straight back —
   *  making `/api/input/key`'s "could not focus panel" guard a tautology that could never
   *  fire. A miscased `"Game"` then reported ok while the input gate stayed shut, and every
   *  following keypress reached nothing. See #301. */
  openPanels: string[];
  /** Opt-in: simulate + render ParticleEmitter effects live in the 3D SceneView */
  particlePreview: boolean;
  /** The Game panel's selected device preset, and the orientation it is viewed in. Lifted from
   *  GameView-local state into the store so they are agent-drivable (`set-game-view-device` /
   *  `modoki_set_game_view_device`, #367) — the same move `sceneViewMode` above records, and for the
   *  same reason: the device picker is a popup an agent's trusted input cannot operate, so any
   *  layout check a session runs used to measure whatever device the human last left selected.
   *
   *  These two are the SOURCE OF TRUTH. `gameViewSize`/`gameViewSafeArea`/`gameRect` below stay
   *  DERIVED — GameView resolves them from this pair and publishes them downward for SceneView.
   *  Writing them from the setter as well would give each two writers to keep in sync by hand.
   *
   *  A custom resolution (no catalog entry) is carried as a synthetic preset named 'Custom' with
   *  `NO_SAFE_AREA`, so every `resolve*` helper and every GameView consumer works on it unbranched.
   *
   *  Deliberately NOT persisted to localStorage, unlike `sceneViewMode`: this reset to `Free` on
   *  every mount before it moved here, and a custom resolution silently restored days later is a
   *  measurement taken at a size nobody chose. */
  gameViewDevice: DevicePreset;
  gameViewOrientation: Orientation;
  /** Whether the GameView component is actually MOUNTED and running its effects.
   *
   *  ⚠️ **Not derivable from `openPanels`, and the first attempt at this got it wrong.**
   *  `openPanels` is every TAB NODE in the FlexLayout model, with no selection test — and
   *  FlexLayout defaults `tabEnableRenderOnDemand: true`, so a Game tab sharing a tabset with
   *  another panel and never clicked EXISTS without ever mounting. Inferring mountedness from the
   *  layout therefore reported `true` for exactly the case the flag was added to catch, which is
   *  worse than not reporting it: `set-game-view-device` would answer a complete iPhone 16 Pro
   *  read-back, assert the panel was live, and none of the derived values below would have moved.
   *
   *  So GameView publishes it itself, from an effect with cleanup — the only place the fact is
   *  actually known. */
  gameViewMounted: boolean;
  /** The Game panel's game AREA in real CSS px, measured whether or not a device is selected.
   *
   *  Deliberately NOT `gameViewSize`, which means something different: while a FIXED device is
   *  selected GameView writes the DEVICE's logical size there, so reading it as "how big is the
   *  panel" answers with the phone. That is stale in precisely the transition it would be consulted
   *  for — switching iPhone 16 Pro -> Free returned 402x874 as the panel size, and on a cold editor
   *  it returned the fabricated `{800, 450}` default. This one is always the panel. */
  gameAreaSize: { width: number; height: number };
  gameViewSize: { width: number; height: number };
  /** Safe-area insets (logical px) of the Game panel's selected device preset. Written by
   *  GameView, which owns the device picker; read by SceneView's UI preview frame so BOTH
   *  viewports inset UI the same way. Zeros for `Free` and the abstract aspect presets —
   *  and zeros are also what a desktop `env(safe-area-inset-*)` reports, so an unset value
   *  degrades to today's behaviour rather than to something wrong. See #271. */
  gameViewSafeArea: { top: number; right: number; bottom: number; left: number };
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
  /** Scene-load progress. `active` spans a `loadScene` call; `loaded`/`total`
   *  count resources acquired (each `total` entry is one fetch that, on a cold
   *  asset cache, triggers an on-demand bake — so the bar tracks real bake work).
   *  The modal only renders after a ~400ms delay, so warm loads never flash it. */
  sceneLoadStatus: { active: boolean; loaded: number; total: number };
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
  /** "Find References" dialog target (#284) — an asset GUID/path or entity GUID plus
   *  a display label. null = dialog closed. */
  findReferencesTarget: { target: string; label: string } | null;
  /** "Build Support" dialog open state (toolchain detection + install/guide). */
  buildSupportOpen: boolean;
  /** "Publish OTA Update…" dialog open state (docs/ota-updates.md). */
  otaPublishOpen: boolean;
  /** "OTA Keys…" dialog open state (generate/inspect the OTA signing keypair). */
  otaKeysOpen: boolean;
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

  /** Which slice is selected in the currently-open Sprite Editor (guid, or null = none).
   *  Was component-local `useState` in SpriteEditor.tsx with no store field and no agent op —
   *  since the modal's resize/pivot handles only exist for the SELECTED slice, and it opens
   *  fresh with nothing selected, `modoki_handles editor=sprite` returned an empty list in the
   *  NORMAL case, indistinguishable from "no slices" (#373). Set with `select-sprite-slice`;
   *  reset to null by SpriteEditor itself on mount/unmount, matching the modal's own lifetime. */
  spriteEditorSelection: string | null;

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
  /** WHICH panel the ▶ was pressed in, or null when nobody claimed it (#810 follow-up).
   *  `isPreviewPlaying` is ONE flag both the Timeline and Animation panels read, so without
   *  this both panels' preview effects run on a single press and each takes the single-valued
   *  `RunMode` from the other — after #810 gave displacement real teeth, the loser's loop is
   *  stopped, and the Timeline always lands second (its entry is behind an await), so pressing
   *  ▶ in the Animation panel played nothing at all. A panel drives the preview only when it
   *  owns it. NULL means unclaimed — a programmatic `setPreviewPlaying(true)` (the e2e path)
   *  keeps the pre-existing any-panel-may-drive behaviour rather than silently doing nothing. */
  previewOwner: 'timeline' | 'animation' | null;

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
  openFindReferences: (target: string, label: string) => void;
  closeFindReferences: () => void;
  openBuildSupport: () => void;
  closeBuildSupport: () => void;
  openOtaPublish: () => void;
  closeOtaPublish: () => void;
  openOtaKeys: () => void;
  closeOtaKeys: () => void;
  setGizmoMode: (mode: 'translate' | 'rotate' | 'scale') => void;
  setColliderEditMode: (on: boolean) => void;
  setSpriteEditorSelection: (guid: string | null) => void;
  setShowFocusGraph: (on: boolean) => void;
  setSceneViewMode: (mode: '3d' | 'ui') => void;
  /** Set the Animation editor's timeline view. No-ops (and does not journal) on a re-set. */
  setAnimationViewMode: (mode: 'dopesheet' | 'curves') => void;
  /** Set from AnimationEditor's mount effect + its cleanup. Nothing else may call it. */
  setAnimationPanelMounted: (mounted: boolean) => void;
  setFocusedPanel: (panel: string | null) => void;
  setOpenPanels: (ids: string[]) => void;
  setGizmoSpace: (space: 'local' | 'world') => void;
  setGizmoPivot: (pivot: 'pivot' | 'center') => void;
  setUnlockedGhostSelKey: (key: string | null) => void;
  setParticlePreview: (on: boolean) => void;
  /** Set the Game panel's device preset and/or its orientation. Omitting either leaves it alone,
   *  so the orientation toggle and the picker are one setter. No-ops (and does not journal) when
   *  neither actually changes. */
  setGameViewDevice: (device?: DevicePreset, orientation?: Orientation) => void;
  /** Set from GameView's mount effect + its cleanup. Nothing else may call it. */
  setGameViewMounted: (mounted: boolean) => void;
  setGameAreaSize: (width: number, height: number) => void;
  setGameViewSize: (width: number, height: number) => void;
  setGameViewSafeArea: (insets: EditorState['gameViewSafeArea']) => void;
  setGameRect: (rect: EditorState['gameRect']) => void;
  refreshAssets: () => void;
  setImportStatus: (active: boolean, message?: string, step?: number, totalSteps?: number) => void;
  /** Put the import modal into a failed state with a message + OK button. Use
   *  when an import/convert throws so the user sees why instead of an unhandled
   *  rejection in the console. */
  setImportError: (message: string) => void;
  setBuildStatus: (status: Partial<EditorState['buildStatus']>) => void;
  setSceneLoadStatus: (status: Partial<EditorState['sceneLoadStatus']>) => void;
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
  /** Repoint an open asset editor at a new PATH after its file was renamed/moved, WITHOUT
   *  reloading it (#186). Deliberately not `open<X>Editor(newPath)`: that re-fetches from
   *  disk and would discard the in-memory doc, which after a rename is the newer of the
   *  two. The doc is the truth here — only its location changed. A no-op if that editor is
   *  unbound, so a stale move can never conjure a binding out of nothing. */
  remapEditingAssetPath: (
    field: 'editingParticleAsset' | 'editingSpriteAnimAsset' | 'editingSkinAsset'
      | 'editingAnimationAsset' | 'editingTimelineAsset',
    path: string,
    name?: string,
  ) => void;
  /** Seed the open clip from a freshly-loaded asset (updates the live cache, no undo). */
  loadAnimationClip: (clip: AnimationClipDef) => void;
  /** Apply a clip to an asset by path: refreshes the runtime cache + the editor form when
   *  that path is the one open. Used by live edits and undo/redo closures. */
  applyAnimationClip: (path: string, clip: AnimationClipDef) => void;
  setPlayhead: (t: number) => void;
  setRecording: (on: boolean) => void;
  setPreviewPlaying: (on: boolean, owner?: 'timeline' | 'animation') => void;
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
  gizmoMode: lsEnum('editor:gizmoMode', ['translate', 'rotate', 'scale'] as const, 'translate'),
  gizmoSpace: lsEnum('editor:gizmoSpace', ['world', 'local'] as const, 'world'),
  gizmoPivot: lsEnum('editor:gizmoPivot', ['pivot', 'center'] as const, 'pivot'),
  unlockedGhostSelKey: null,
  colliderEditMode: false,
  spriteEditorSelection: null,
  showFocusGraph: (typeof localStorage !== 'undefined' && localStorage.getItem('editor:showFocusGraph') === '1'),
  sceneViewMode: (typeof localStorage !== 'undefined' && localStorage.getItem('editor:sceneViewMode') === 'ui') ? 'ui' : '3d',
  animationViewMode: 'dopesheet',
  animationPanelMounted: false,
  focusedPanel: null,
  openPanels: [],
  particlePreview: lsBool('editor:particlePreview', false),
  gameViewDevice: FREE_PRESET,
  gameViewOrientation: 'portrait',
  gameViewMounted: false,
  gameAreaSize: { width: 0, height: 0 },
  gameViewSize: { width: 800, height: 450 },
  gameViewSafeArea: { top: 0, right: 0, bottom: 0, left: 0 },
  gameRect: { left: 0, top: 0, width: 800, height: 450 },
  assetsVersion: 0,
  importStatus: { active: false, message: '', step: 0, totalSteps: 0 },
  buildStatus: { active: false, message: '', step: 0, totalSteps: 5, failed: false },
  sceneLoadStatus: { active: false, loaded: 0, total: 0 },
  toast: null,
  applyPrefabDialog: { active: false, rootInstanceId: null },
  revertPrefabDialog: { active: false, rootInstanceId: null },
  projectSettingsOpen: false,
  cleanupAssetsOpen: false,
  findReferencesTarget: null,
  buildSupportOpen: false,
  otaPublishOpen: false,
  otaKeysOpen: false,
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
  isPreviewPlaying: false, previewOwner: null,

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
  setGizmoMode: (mode) => {
    if (get().gizmoMode !== mode) editorEmit('!gizmo', { mode });
    set({ gizmoMode: mode });
    if (typeof localStorage !== 'undefined') localStorage.setItem('editor:gizmoMode', mode);
    mark2DDirty();
  },
  setColliderEditMode: (on) => set({ colliderEditMode: on }),
  setSpriteEditorSelection: (guid) => {
    if (get().spriteEditorSelection === guid) return;
    editorEmit('!spriteeditorselection', { guid });
    set({ spriteEditorSelection: guid });
  },
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
  setAnimationViewMode: (mode) => {
    if (get().animationViewMode === mode) return;
    editorEmit('!animationviewmode', { mode });
    set({ animationViewMode: mode });
  },
  setAnimationPanelMounted: (mounted) => { if (get().animationPanelMounted !== mounted) set({ animationPanelMounted: mounted }); },
  /** Click-to-focus. Journals `!focus` on a real SCOPE CHANGE only — a commit point, so the
   *  stream stays sparse (never per-keystroke), and it is what makes "why did my key go there?"
   *  answerable from data instead of a re-run. Focus is NOT undoable: it is transient chrome, and
   *  recording it would flood the stack AND create a routing loop (undo moves focus → the next
   *  Cmd+Z resolves in a different scope). Hence no pushAction here. */
  setFocusedPanel: (panel: string | null) => {
    const from = get().focusedPanel;
    if (from === panel) return;
    editorEmit('!focus', { panel, from });
    set({ focusedPanel: panel });
  },
  /** Replace the open-panel set. Compares before setting so a layout change that did not
   *  open/close anything (a resize, a drag within a tabset) does not re-render every
   *  subscriber. Not journalled: it mirrors the layout, which already journals. */
  setOpenPanels: (ids: string[]) => {
    // Sorted + de-duplicated: FlexLayout permits two tabs of the same component, and tab
    // ORDER is a layout detail. Neither should reach the agent-facing list, where the only
    // question is "may I focus this id".
    const next = [...new Set(ids)].sort();
    const prev = get().openPanels;
    if (prev.length === next.length && prev.every((id, i) => id === next[i])) return;
    set({ openPanels: next });
  },
  setGizmoSpace: (space: 'local' | 'world') => {
    if (get().gizmoSpace !== space) editorEmit('!gizmo', { space });
    set({ gizmoSpace: space });
    if (typeof localStorage !== 'undefined') localStorage.setItem('editor:gizmoSpace', space);
    mark2DDirty();
  },
  setGizmoPivot: (pivot: 'pivot' | 'center') => {
    if (get().gizmoPivot !== pivot) editorEmit('!gizmo', { pivot });
    set({ gizmoPivot: pivot });
    if (typeof localStorage !== 'undefined') localStorage.setItem('editor:gizmoPivot', pivot);
    mark2DDirty();
  },
  setUnlockedGhostSelKey: (key: string | null) => set({ unlockedGhostSelKey: key }),
  setParticlePreview: (on: boolean) => {
    set({ particlePreview: on });
    if (typeof localStorage !== 'undefined') localStorage.setItem('editor:particlePreview', on ? '1' : '0');
  },
  setGameViewDevice: (device, orientation) => {
    const cur = get();
    // Compare the preset by VALUE, not by identity: a custom size arrives as a freshly built
    // synthetic preset every call, so an identity check would journal + re-render on a no-op.
    const nextDevice = device ?? cur.gameViewDevice;
    const nextOrientation = orientation ?? cur.gameViewOrientation;
    const sameDevice = nextDevice === cur.gameViewDevice
      || (nextDevice.name === cur.gameViewDevice.name
        && nextDevice.logicalW === cur.gameViewDevice.logicalW
        && nextDevice.logicalH === cur.gameViewDevice.logicalH
        && nextDevice.physicalW === cur.gameViewDevice.physicalW
        && nextDevice.physicalH === cur.gameViewDevice.physicalH);
    if (sameDevice && nextOrientation === cur.gameViewOrientation) return;
    editorEmit('!gameviewdevice', { device: nextDevice.name, orientation: nextOrientation });
    set({ gameViewDevice: nextDevice, gameViewOrientation: nextOrientation });
  },
  setGameViewMounted: (mounted) => { if (get().gameViewMounted !== mounted) set({ gameViewMounted: mounted }); },
  // Identity-compared: written from a ResizeObserver, so a fresh object per callback would
  // re-notify every subscriber on frames where nothing moved.
  setGameAreaSize: (width, height) => {
    const cur = get().gameAreaSize;
    if (cur.width === width && cur.height === height) return;
    set({ gameAreaSize: { width, height } });
  },
  setGameViewSize: (width, height) => set({ gameViewSize: { width, height } }),
  // Identity-compared before writing: this is set from a render-time value in GameView, and
  // a fresh object every render would re-notify every subscriber (SceneView's preview frame
  // among them) on frames where the device did not change.
  setGameViewSafeArea: (insets) => {
    const cur = get().gameViewSafeArea;
    if (cur.top === insets.top && cur.right === insets.right
      && cur.bottom === insets.bottom && cur.left === insets.left) return;
    set({ gameViewSafeArea: { ...insets } });
  },
  setGameRect: (rect) => set({ gameRect: rect }),
  refreshAssets: () => set((s) => ({ assetsVersion: s.assetsVersion + 1 })),
  setImportStatus: (active, message = '', step = 0, totalSteps = 0) =>
    set({ importStatus: { active, message, step, totalSteps, failed: false } }),
  setImportError: (message) =>
    set({ importStatus: { active: true, message, step: 0, totalSteps: 0, failed: true } }),
  setBuildStatus: (status) => set((s) => ({ buildStatus: { ...s.buildStatus, ...status } })),
  setSceneLoadStatus: (status) => set((s) => ({ sceneLoadStatus: { ...s.sceneLoadStatus, ...status } })),
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
  openFindReferences: (target, label) => set({ findReferencesTarget: { target, label } }),
  closeFindReferences: () => set({ findReferencesTarget: null }),
  openBuildSupport: () => set({ buildSupportOpen: true }),
  closeBuildSupport: () => set({ buildSupportOpen: false }),
  openOtaPublish: () => set({ otaPublishOpen: true }),
  closeOtaPublish: () => set({ otaPublishOpen: false }),
  openOtaKeys: () => set({ otaKeysOpen: true }),
  closeOtaKeys: () => set({ otaKeysOpen: false }),
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
  setSkinMode: (mode) => {
    if (get().skinMode === mode) return;
    editorEmit('!skinmode', { mode });
    set({ skinMode: mode });
  },
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
    isPreviewPlaying: false, previewOwner: null,
  })),
  // Same ownership guard as `closeTimelineEditor` below — see its comment. `isRecording` is NOT
  // gated: it is this panel's own flag, not shared with the Timeline.
  closeAnimationEditor: () => set((s) => ({
    editingAnimationAsset: null, editingAnimationClip: null, animatorRootEntityId: null, isRecording: false,
    ...(panelMayStopPreview(s.previewOwner, 'animation') ? { isPreviewPlaying: false, previewOwner: null } : {}),
  })),
  remapEditingAssetPath: (field, path, name) => set((s) => {
    const cur = s[field];
    if (!cur) return {}; // unbound → nothing to repoint
    return { [field]: { ...cur, path, name: name ?? cur.name } } as Partial<EditorState>;
  }),
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
  setPreviewPlaying: (on, owner) => {
    // DEV-only: an untagged start drives NEITHER panel (see `panelDrivesPreview` — the permissive
    // fallback was #810 re-armed). Silence would look exactly like a broken ▶, so say which call
    // is at fault rather than leaving the next reader to find it.
    if (on && !owner && import.meta.env?.DEV) {
      console.warn('[editorStore] setPreviewPlaying(true) with no owner — no panel will drive this ' +
        "preview. Pass 'timeline' or 'animation'.");
    }
    set({ isPreviewPlaying: on, previewOwner: on ? (owner ?? null) : null });
  },
  setAnimatorRoot: (id) => set({ animatorRootEntityId: id }),

  openTimelineEditor: (asset, rootEntityId) => set((s) => ({
    editingTimelineAsset: asset,
    editingTimelineDoc: null,
    directorRootEntityId: rootEntityId,
    timelineEditNonce: s.timelineEditNonce + 1,
    playheadTime: 0,
    isPreviewPlaying: false, previewOwner: null,
  })),
  // ⚠️ Clear the shared preview flag ONLY if this panel owns it (or nobody does). `isPreviewPlaying`
  // is read by BOTH preview panels, so an unconditional clear here stops a RUNNING Animation
  // preview when an idle Timeline tab is merely closed — the same defect as #810, on the store
  // action behind the panel rather than in the panel. The panels' unmount cleanups were guarded
  // first and these two actions were missed; the #810 E2E is what caught it.
  closeTimelineEditor: () => set((s) => ({
    editingTimelineAsset: null, editingTimelineDoc: null, directorRootEntityId: null,
    ...(panelMayStopPreview(s.previewOwner, 'timeline') ? { isPreviewPlaying: false, previewOwner: null } : {}),
  })),
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
