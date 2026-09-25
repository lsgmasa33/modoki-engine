/** Editor agent ops — the renderer-side handlers that give an AI agent (or any
 *  tooling) parity with what a human can DO and SEE in the editor.
 *
 *  These are registered into the agent-bridge op registry (engine/app/debug/
 *  agentBridge.ts) at EDITOR startup only — `registerEditorAgentOps()` is called
 *  from `createGameEditor` (the lazy, React.lazy-loaded editor path). That keeps
 *  all `@modoki/engine/editor` imports out of the shipped game web bundle while
 *  making every op work identically in dev (relayed over Vite HMR) and the
 *  packaged DMG (relayed over Electron IPC) — the bridge transport is the same.
 *
 *  Convention: each op returns a JSON-serializable result (the backend forwards
 *  it verbatim). Selection/gizmo writes go through RAW store setState so they do
 *  NOT push selection-undo entries — the agent must not pollute the human's undo
 *  stack just by looking around. Structural edits (create/delete/duplicate/
 *  reparent) DO go through the undoable actions, exactly like the menus, so the
 *  agent's edits are undoable too. */

import * as THREE from 'three';
import type { ErrorCode } from '../../tools/shared/mcpResult';
import { histogram } from '../../tools/shared/filterDisclosure';
import { OpRefusal } from '../debug/opRefusal';
import { liveGuidOf } from '../debug/liveLifecycle';
import {
  resolveEntityAddress, guidListFields, descendantsOf, alsoDeletedFields, ALSO_DELETED_CAP,
  type EntityAddress, type EntityAddressKey,
} from '../debug/entityRef';
import { describeEditorCamera, type EditorCameraInfo } from './editorCameraInfo';
import { registerAgentOp as _registerAgentOp, agentOpHandler, type AgentOpHandler, setSceneReloadSuppressor, setWorldReloadedFromDiskHook, replaySuppressedSceneReloads, setPrefabSourceRefresher, resolveAssetDefKind, runtimeWaitReaders, runWaitFor } from '../debug/agentBridge';
import type { WaitReaders } from '../debug/waitFor';
import { performDomDnd, type DomDndParams } from '../debug/domDnd';
import { getHmrStatus } from '../debug/hmrStaleness';
import { getGameBootFaults } from './gameBootFaults';
import { handleEval, clampEvalTimeout, EVAL_ASYNC_TIMEOUT_MS, EDITOR_EVAL_MAX_TIMEOUT_MS } from '../debug/bridgeHelpers';
import { makeEvalApi } from './evalApi';
import {
  useEditorStore, type SelectedAsset, GIZMO_MODES, GIZMO_SPACES, SCENE_VIEW_MODES,
  type AssetEditorKind, type AssetEditorMount, colliderEditBlocker,
  enterPlay, stopPlay, pausePlay, type PlayOutcome, type StopOutcome,
  undoStep, canUndo, canRedo, undoLabel, redoLabel, getEditVersion, getUndoVersion, getDirtyAssetsVersion,
  loadScene, saveAll, newScene, getCurrentScenePath, hasUnsavedChanges, unsavedChangeCauses, adoptWorldReloadedFromDisk,
  SCENE_EXT, correctedScenePath, isAcceptableScenePath,
  getPendingBaseScenePaths, discardPendingBaseScenes,
  getLastSceneLoadFailureMessage, getLastSceneLoadStartupErrors,
  isEditingPrefab, isPrefabEditWorld, prefabSessionWorldPath, openPrefabForEditing, savePrefabEditReport, exitPrefabEditing,
  createEntityWithUndo, duplicateEntity, deleteEntitiesWithUndo, ensureGuid, type TraitSpec,
  planReparent, applyReparent, type ReparentPlan, preflightSceneMove, formatSceneMoveConfirm,
  buildEntityCreateSpecs, type CreateEntitySpec,
  writeTraitFieldWithUndo, removeTraitFromEntitiesWithUndo, addTraitToEntitiesWithUndo,
  runAsCompositeAction, markAssetDirty, getDirtyAssetPaths, discardDirtyAssets,
  applyAssetPathMoves, type PathMove,
  getPrefabSource, instantiatePrefabInstance, serializePrefab, writePrefabFile, warnInertPrefabSizes,
  runtimeExcludedMessage,
  preloadNestedPrefabsForSubtree,
  classifyExistingPrefabId, tagEntityTreeAsInstance, untagEntityTreeAsInstance, unstampMemberGuids,
  detachPrefabInstance, reattachPrefabInstance,
  applyToPrefabWithUndo, revertOverridesSelective, staleInstanceRefusal, rebuildInstance, resolveInstanceContext,
  collectInstanceOverrideFields, collectInstanceOverrideKeys, canonicalOverrideKey,
  pushAction, makePrefabInstantiateAction, entityRef,
  getEditorViewportCamera, focusEntityInSceneView,
  upsertKey, findTrack, encodeValue,
  poseClipAtTime, exitPoseEnvelope, resolveAnimatorRootForClip,
  getCreatableAssets, createRegisteredAsset,
  readEditorJournal, editorJournalSeq, editorJournalDroppedThrough, editorJournalEpoch, resolveEditorJournalCursor, withEditorActor, openActorLease, closeActorLease,
  waitForEditorJournal, EDITOR_JOURNAL_SOURCES, isEditorJournalSource, EDITOR_JOURNAL_TYPES, isEditorJournalType,
  readMetaPreferringPark, peekPendingMeta, discardPendingMeta, getPendingMetaPaths,
  getResolvedRender3d,
  probeKeyReach,
  DEVICE_PRESETS, findPresetByName, makeCustomPreset, validateCustomSize,
  describeDeviceSelection, presetDpr, resolveLogicalSize, resolvePhysicalSize, resolveSafeArea,
  type DevicePreset, type Orientation,
  type PrefabFile,
  causeSpecs, flushParked, getModeOwner, envelopeExitOptions, lastRestoreFailed, hasTimelinePreviewSession, onAuthoringSettled, isWorldReplacementInFlight, refreshPrefabSourceForPath, whyWorldNotAuthored,
  dirtyAssetEditorHolds,
} from '@modoki/engine/editor';
import { tailWithCounts, takeTail, takeHead, tailHint, JOURNAL_TAIL_DEFAULT, EDITOR_JOURNAL_TAIL_DEFAULT } from '../debug/streamSummary';
import {
  getPlayState, setPlayState, getRunMode, canEdit, isAdvancing, getCurrentFPS, getFrameLoopHealth, getRendererGateHealth, getGpuFaultState, stepOneFrame, getAllEntities, findEntity, deleteEntity, findUnrenderable2D,
  getAnimationClip, normalizeAnimationClip, validateAssetData, journalEvents, currentCaptureSeq, resolveCapCursor, journalDroppedThroughCap, journalGapNote, getParticleEffect, mountedSurfaces,
  getTimeline, normalizeTimeline, getGuidForPath, getAssetEntry, getPresentationScale,
  getSpriteAnim, getRig2D, getRig2DSource,
  getAnimSet, getSpriteMaterialProgram, isGuid,
  getAllTraits, resolveCreateEntitySpec, parentRefusal, isResourceEntity, traitRemoveRefusal, traitWriteRefusal, type MutateOp, type MutateEntityRef,
  Transform, getWorldTransform3D, getParentWorldMatrix3D, getCurrentWorld, ensurePhysicsReady, pendingPhysics, mergeTrs, worldToLocalTrs, matrixToTrs, persistedTrsKeys, collapsedParentAxes,
  type AnimationClipDef, type TrackValueType, type TimelineDef, type TrackDef, type TrackKind,
  sceneManager, assetUrl, type AssetSchemaType, collectHandles, alsoDeletedTally, guidOfEntityId, type AlsoDeletedFields,
} from '@modoki/engine/runtime';

// ── Reads ─────────────────────────────────────────────────────────────────

/** The live editor orbit camera pose, or null when no viewport is mounted — enough to
 *  reconstruct framing or feed render-scene's camera override. The projection-aware shaping
 *  (fov for perspective, orthoSize for ortho) is the pure {@link describeEditorCamera}. */
function readEditorCamera(): EditorCameraInfo | null {
  return describeEditorCamera(getEditorViewportCamera());
}

/** HMR staleness, kept OFF the payload when there is nothing to report — an editor that
 *  has had zero updates is by definition not stale. Silence here means "this build is what
 *  booted". (Applies to the packaged editor too: it runs a real Vite dev server, so it has
 *  HMR — see engine/app/debug/hmrStaleness.ts.) */
function hmrFields(): { hmrUpdates?: number; staleGameCode?: true; discardedUnsavedEdits?: true } {
  const h = getHmrStatus();
  const out: { hmrUpdates?: number; staleGameCode?: true; discardedUnsavedEdits?: true } = {};
  if (h.updates > 0) out.hmrUpdates = h.updates;
  if (h.staleGameCode) { out.staleGameCode = true; out.hmrUpdates = h.updates; }
  // Sticky for the life of the page: the human may not have seen the banner, and an agent
  // reading state later still needs to know work was dropped under it.
  if (h.discardedUnsavedEdits) out.discardedUnsavedEdits = true;
  return out;
}

/** Frame-loop liveness, included only when it is NOT plainly healthy — a running loop is
 *  the norm and needs no words. `hidden` is reported too: it is benign (the OS window is
 *  occluded/minimised, so the browser throttles rAF) but it explains an `fps: 0` reading
 *  and a failing `capture_viewport`, which otherwise look identical to a real wedge. */
function frameLoopFields(): { frameLoop?: ReturnType<typeof getFrameLoopHealth> } {
  const h = getFrameLoopHealth();
  if (h.status === 'running' && h.recovered === 0) return {};
  return { frameLoop: h };
}

/** Renderer-gate health, included only when the renderer is NOT ready. `pending` is normal
 *  for the first seconds of a cold start; `failed` never self-recovers and means every
 *  scene-dependent reading here is meaningless until the editor is relaunched.
 *
 *  `render3d` is the resolved `build.modules.render3d` fact (`createEditor.tsx`'s
 *  `getResolvedRender3d`) — `undefined` while the boot fetch is still in flight, `true`/`false`
 *  once resolved. It explains WHY the no-viewport watchdog warning is (or isn't) firing: a
 *  `'pending'` gate with `render3d: false` is an expected, silent state for a 2D/UI-only
 *  project, not a stall to chase. */
function rendererGateFields(): {
  rendererGate?: ReturnType<typeof getRendererGateHealth> & { render3d?: boolean };
} {
  const g = getRendererGateHealth();
  if (g.status === 'ready') return {};
  const render3d = getResolvedRender3d();
  return { rendererGate: render3d === undefined ? g : { ...g, render3d } };
}

/** GPU device-loss / uncaptured-error state, included only when something has actually gone
 *  wrong — the healthy case (`getGpuFaultState()` returning null) needs no words, same
 *  convention as `frameLoopFields`/`rendererGateFields`. This is the CAUSE `frameLoop.status:
 *  'stalled'` is often only the SYMPTOM of: a lost GPU device stops the compositor from ever
 *  producing a frame, which the stall watchdog reports as a wedge with no idea why. */
function gpuFields(): { gpu?: ReturnType<typeof getGpuFaultState> } {
  const g = getGpuFaultState();
  return g ? { gpu: g } : {};
}

/** The whole editor UI state in one read — the "get all UI state" payload. */
/** The Game panel's selected screen, plus the two editor-session facts the preset itself cannot
 *  know. Both were review findings on #367, and BOTH were got wrong on the first attempt — the
 *  wrong versions are recorded here because each looked obviously right:
 *
 *  - **`panelMounted`** — read from `gameViewMounted`, which GameView sets from its own mount
 *    effect. It was first DERIVED from `openPanels.includes('game')`, which is wrong: `openPanels`
 *    is every tab NODE in the FlexLayout model with no selection test, and FlexLayout defaults
 *    `tabEnableRenderOnDemand: true`, so a Game tab that shares a tabset and has never been
 *    clicked exists without mounting. That version answered `mounted: true` for exactly the case
 *    the field exists to catch — asserting the panel was live, with authority, while none of the
 *    derived values had moved. Worse than not reporting it at all.
 *
 *    Why it matters: `gameViewSize`/`gameViewSafeArea`/`gameRect` are written ONLY by GameView's
 *    effects. Unmounted, the store's device changes and NOTHING derived follows, so a measurement
 *    attributed to the new screen was taken at the old one.
 *
 *  - **`panelSize`** — read from `gameAreaSize`, measured by an always-on ResizeObserver. It first
 *    read `gameViewSize`, which means something different: while a FIXED device is selected that
 *    holds the DEVICE's logical size. So `iPhone 16 Pro` then `Free` answered `panelSize:
 *    {402, 874}` — the phone just left, presented as the panel's size — and a cold editor answered
 *    the fabricated `{800, 450}` default. Stale in precisely the transition it was added for.
 *
 *    Reported only when `free`, because a fixed device's `logical` IS the answer; and only when
 *    mounted, because nothing has measured the area otherwise.
 *
 *  - **`panelSize` when COLLAPSED** (#688) — and the same mistake once more, from a third side.
 *    `gameAreaSize` is adopted by an always-on observer with no zero test, while its own sibling
 *    observer 26 lines below in `GameView.tsx` DOES guard `width <= 0 || height <= 0`. So a
 *    mounted-but-collapsed panel answered `panelSize: {0, 0}` with `panelMounted: true` and no
 *    note — the exact shape the `mounted` bullet above calls "worse than not reporting it at all".
 *
 *    ⚠️ The fix is deliberately NOT the sibling's guard. Skipping a zero there keeps the LAST GOOD
 *    size, which trades a degenerate answer for a stale one — and by this doc block's own standard
 *    (the `panelSize` bullet: "Stale in precisely the transition it was added for") stale presented
 *    as live is the worse of the two. Omitting the field plus a note reuses the shape already
 *    proven for the unmounted case: absence an agent can see, with prose saying why.
 */
function describeGameView() {
  const s = useEditorStore.getState();
  const sel = describeDeviceSelection(s.gameViewDevice, s.gameViewOrientation);
  const panelMounted = s.gameViewMounted;
  // COLLAPSED IS NOT UNMOUNTED (#688). A Game panel dragged to a zero-height splitter, or one
  // whose tabset is squeezed flat by maximising another panel, stays mounted and keeps rendering
  // — so `panelMounted` is honestly `true` — while `gameAreaSize` goes to {0,0}. See the note
  // below on why this is omitted rather than floored to the last good value.
  const panelCollapsed = panelMounted && (s.gameAreaSize.width <= 0 || s.gameAreaSize.height <= 0);
  return {
    ...sel,
    ...(sel.free && panelMounted && !panelCollapsed
      ? { panelSize: { w: s.gameAreaSize.width, h: s.gameAreaSize.height } }
      : {}),
    panelMounted,
    ...(!panelMounted ? {
      panelNote: 'The Game panel is NOT mounted, so nothing derived from this selection has moved — '
        + 'the preview size, safe-area insets and letterbox rect all still describe the previous '
        + 'state. Open AND SELECT the Game tab before attributing any layout measurement to this '
        + 'screen: a tab that has never been opened — or one that was closed and re-added — does '
        + 'not mount until it is selected once.',
    } : panelCollapsed ? {
      panelNote: 'The Game panel is mounted but COLLAPSED to zero area. Anything derived from its '
        + 'extent — a capture size, a letterbox rect, an aim inside the preview — is unusable until '
        + 'the panel is given room: drag its splitter open, or un-maximise whichever panel is '
        + 'squeezing it — or, if the editor has only just started, the panel has MOUNTED but not '
        + 'yet been measured (the store seeds this size to zero), in which case simply read again. '
        + 'On a FREE screen `panelSize` is omitted for this reason rather than '
        + 'reported as {0, 0}; on a fixed device `logical` is still the screen being emulated and '
        + 'stays correct, but it no longer describes anything visible. This is NOT the same as '
        + 'unmounted: the panel is live and still rendering.',
    } : {}),
  };
}

/** What the Animation panel is SHOWING, with the two qualifiers an empty handle list needs.
 *
 *  `mode` alone is not enough to explain `modoki_handles editor=curves` coming back empty, and
 *  reporting it alone repeats the mistake `describeGameView` above had to fix one commit earlier:
 *
 *  - **`panelMounted`** — a tab that has never been opened this session is not mounted (see
 *    docs/editor.md § Tab mounting latches; mounting LATCHES, so this is about never-opened, not
 *    about currently-unselected), so neither view's handle provider is registered until the
 *    Animation tab is clicked once. `mode` would still read 'curves'.
 *  - **`tangentsNeedActiveTrack`** — CurvesView publishes tangent handles for the ACTIVE track
 *    only (`CurvesView.tsx`), and `activeTi` resolves with no selection ONLY when exactly one
 *    curve is visible. So on a clip with two or more numeric tracks, switching to Curves is
 *    necessary and NOT sufficient, and the empty list reads as "this clip has no tangents".
 *    Measured, not reasoned: 1-track clip -> 2 keyframe + 2 tangent; 2-track clip, same view,
 *    nothing selected -> 5 keyframe + 0 tangent.
 */
function describeAnimationView() {
  const s = useEditorStore.getState();
  const mounted = s.editorMounts.animation !== undefined;
  return {
    mode: s.animationViewMode,
    panelMounted: mounted,
    ...(mounted ? {} : {
      panelNote: 'The Animation panel is NOT mounted, so neither view is showing and NEITHER '
        + "publishes handles — modoki_handles editor=dopesheet|curves is empty for that reason, "
        + 'not because the clip is empty. A tab that has never been OPENED this session is not '
        + 'mounted, so open AND '
        + 'select the Animation tab (modoki_open_animation_editor does both when it opens a clip).',
    }),
    ...(s.animationViewMode === 'curves' ? {
      tangentsNeedActiveTrack: 'Tangent handles (curves:tan:in|out:*) are published for the ACTIVE '
        + 'track only. With no track selected that resolves only when exactly ONE numeric curve is '
        + 'visible — so on a multi-track clip kind:tangent is empty until you select a track: '
        + 'modoki_handles {editor:"chrome", kind:"row"} lists animation.trackList.row.<i> '
        + '(data-ui-state "selected" marks the active one), then modoki_tap_handle it.',
    } : {}),
  };
}

function readEditorState() {
  const s = useEditorStore.getState();
  const all = getAllEntities();
  // ⚠️ ONE reading of the unsaved-work state, projected into every field below (#972 P10). This
  // used to call `hasUnsavedChanges()` twice, `getDirtyAssetPaths()` twice,
  // `getPendingBaseScenePaths()` twice AND `unsavedChangeCauses()` once — four probes of one fact
  // inside the function whose whole job is REPORTING that fact, which is #972's mechanism at its
  // most literal. The registries are read between the calls by nothing here, so the old form was
  // not wrong; it was simply two answers where one was needed, and two answers can drift.
  //
  // The top-level `dirtyAssetPaths`/`pendingBaseScenes` fields STAY (they are not folded into
  // `unsavedCauses`): `modoki_persistence`'s tool text points agents at them, and removing them
  // would be a wire break for no benefit. Same bytes on the wire as before, one computation behind
  // them. `unsavedChanges` is derived from the same table, so it cannot disagree with `unsavedCauses`.
  const _causes = unsavedChangeCauses();
  const _unsavedAny = hasUnsavedChanges();
  const _prefabEditWorld = prefabSessionWorldPath(s.editingPrefab);
  return {
    scenePath: getCurrentScenePath(),
    // The synthetic `/__prefab-edit__/<guid>` world while one is loaded, omitted otherwise (#1254). `scenePath` is
    // null there on purpose (a normal scene save must not target a real file), which left the scene-edit tools with
    // no way to address the world `modoki_prefab edit-open` tells an agent to edit: `/api/scene-mutate` goes live
    // for exactly this handle, and `activeScenePath` falls back to it. The WORLD and the SESSION must agree: a world with no
    // edit session (an exit whose reload failed) cannot be persisted by any route, so it is not offered as editable.
    ...(_prefabEditWorld ? { prefabEditWorld: _prefabEditWorld } : {}),
    // Live-world work not on disk. Anything reading the scene FILE (set_transform,
    // mutate_scene, build) is looking at a DIFFERENT world while this is true. (C7)
    // Also true while a dirty asset (below) is pending — see hasUnsavedChanges()'s own comment.
    unsavedChanges: _unsavedAny,
    // Pending 'manual'-mode writes to any ASSET_SCHEMA_TYPES doc (mcp-persistence.md
    // Phase 3) — omitted when empty (nothing pending has nothing to show). A dirty asset an
    // agent can't SEE is the same silent-loss trap `unsavedChanges` already exists to close.
    ...(_causes.dirtyAssetPaths.length ? { dirtyAssetPaths: _causes.dirtyAssetPaths } : {}),
    // #844 — ADDITIVE, alongside `unsavedChanges`/`dirtyAssetPaths` above, never replacing them:
    // `modoki_persistence`'s tool text points agents at `dirtyAssetPaths` for wire compatibility,
    // and `guardUnsaved` (load-scene/new-scene, below) already has its own cause-naming logic. This
    // is the SAME `unsavedChangeCauses()` surfaced for the two OTHER refusal sites that used to
    // blame a fixed "create_entity / duplicate_entity / prefab" string regardless of the real
    // cause (editorBackendRouter.ts's `/api/scene-mutate` guard, and modoki_build's
    // `unsavedChangesWarning`) — both read `get_editor_state` and had no cause to name until now.
    // Omitted when clean, matching `dirtyAssetPaths`'s omit-when-empty convention above.
    ...(_unsavedAny ? { unsavedCauses: _causes } : {}),
    // Pending `baseScene` refs set in the Scene inspector on a scene the editor has NOT loaded
    // (#831) — omitted when empty, same rule. Reported separately from `dirtyAssetPaths` because
    // they are a different KIND of pending write (a single-field scene mutation, not a document)
    // and `discard_asset_edits` does not reach them.
    ...(_causes.pendingBaseScenes.length ? { pendingBaseScenes: _causes.pendingBaseScenes } : {}),
    playState: getPlayState(),
    runMode: getRunMode(),   // 'stopped' | 'scrub' | 'preview' | 'playing' (preview-mode-refactor)
    advancing: isAdvancing(), // false = a frozen frame (Play paused, or a paused preview)
    // WHICH panel owns a scrub/preview envelope ('timeline' | 'animation'), omitted when none does
    // — the same pair `saveCommand.ts` already reports as `mode` on a refused save. It is here so a
    // refusal can name the RIGHT exit: `modoki_exit_pose_envelope` ends an animation-owned envelope
    // and deliberately refuses a timeline-owned one, so without the owner a refusal can only offer
    // an exit that may not work. Read by `/api/scene-mutate`'s envelope 409 (#1122).
    ...(getModeOwner() ? { modeOwner: getModeOwner() } : {}),
    gizmoMode: s.gizmoMode,
    gizmoSpace: s.gizmoSpace,
    sceneViewMode: s.sceneViewMode,
    // Which view the Animation editor is showing ('dopesheet' | 'curves'). Reported because the
    // two views publish DIFFERENT interaction handles, so without it "why does modoki_handles
    // editor=curves return nothing" is answerable only from a screenshot — an empty list is
    // otherwise indistinguishable from a clip with no tangents (#369). Set with
    // modoki_set_animation_view_mode. Kept as a FLAT scalar as well as inside `animationView` below:
    // it is the single most-read field here, and every caller written against it stays correct.
    animationViewMode: s.animationViewMode,
    // The same answer WITH its qualifiers — see describeAnimationView. `animationViewMode` alone
    // cannot explain an empty handle list; this can.
    animationView: describeAnimationView(),
    // Which screen the Game panel is previewing at. Reported so a layout measurement can be
    // ATTRIBUTED to a screen size — without it, "the HUD overlaps the notch" is unfalsifiable,
    // since the reader cannot tell which device produced it (#367). Set with
    // modoki_set_game_view_device; the full catalog is modoki_game_view_devices.
    gameView: describeGameView(),
    // Which panel owns the KEYBOARD ('scene' | 'hierarchy' | 'animation-editor' | …), or null.
    // Readable as DATA on purpose: the focus ring is a CSS box-shadow, so without this the
    // question "which panel would this key go to?" would only be answerable from a screenshot —
    // exactly what docs/debug-tools-mcp.md forbids. (focus-scope refactor P2)
    focusedPanel: s.focusedPanel,
    // The panel ids that currently have an open tab. Reported so an agent refused by
    // `set-focus-scope` can see what it may focus instead, without a second round trip (#301).
    openPanels: s.openPanels,
    // HMR staleness. `staleGameCode: true` means game code changed on disk but the editor
    // could NOT reload (unsaved work of any kind, not only scene edits — #850), so this world
    // is running the OLD build —
    // every measurement taken here is suspect until it reloads. `hmrUpdates` is how many
    // hot updates have landed since boot; 0 means "nothing has changed under me". Exposed
    // as DATA because the failure mode is otherwise SILENT — neither a human nor an agent
    // can tell a stale editor from a working one by looking. (docs/editor-hmr.md)
    ...hmrFields(),
    colliderEditMode: s.colliderEditMode,
    // Which slice is selected in the open Sprite Editor (guid, or null). The editor's
    // resize/pivot handles only exist for the selected slice, so without this an empty
    // `modoki_handles editor=sprite` list is indistinguishable from "no slices" (#373). Set with
    // `select-sprite-slice`, reset to null on every `open-sprite-editor` call and by the modal's
    // own mount/unmount. `select-sprite-slice` refuses unless the modal is open and holds the
    // slice (#1213), so a non-null value now names a slice of `openEditors.sprite`.
    spriteEditorSelection: s.spriteEditorSelection,
    // Which asset editors are MOUNTED, and on what — each editor publishes this from its own mount
    // effect (#1213). The ops that act on an editor refuse when its entry is absent, so this is
    // what to read before calling them; `editingSkinAsset` below names an asset, not a showing panel.
    // Only editors SHOWING an asset are listed — a panel mounted with nothing loaded is left out,
    // so `'skin' in openEditors` agrees with what `requireEditorOpen('skin')` accepts.
    // ⚠️ A DIRTY editor reports `{path, dirty:true}` rather than a bare path (#1362). Without it the
    // diagnostic picture after the fix was the same one that made the bug invisible: a move refused
    // with 423 HELD_BY_ASSET_EDITOR and nothing on this surface could confirm the hold, because
    // `openAssetEditor` is not an `unsavedChangeCauses()` cause so `unsavedChanges` stays false.
    // A clean editor keeps the plain-string shape every existing reader expects.
    openEditors: Object.fromEntries(Object.entries(s.editorMounts)
      .filter(([, m]) => m?.path != null)
      .map(([k, m]) => [k, m!.dirty ? { path: m!.path, dirty: true } : m!.path])),
    // Which .rig2d.json is open in the Skin editor (null = none), and which of its three
    // modes (rig/parts/weights) is active — 'parts' hides every `skin:bone:*` handle. Set
    // with `open-skin-editor` / `set-skin-mode` (#373).
    editingSkinAsset: s.editingSkinAsset,
    skinMode: s.skinMode,
    fps: Math.round(getCurrentFPS()),
    // Liveness, NOT run mode. `playState`/`runMode`/`advancing` above only say what the
    // editor INTENDS to do; they read "playing"/true even when the rAF chain is dead and
    // nothing has ticked for minutes. `frameLoop.status` is the only field here that
    // answers "are frames actually being pumped right now?" — omitted while healthy so
    // the common payload stays small, present (with a `detail` string) the moment it is
    // not, because a wedge that an agent has to INFER from `fps: 0` is what made this
    // failure cost four debugging sessions.
    ...(frameLoopFields()),
    // Renderer-gate liveness — the INDEPENDENT twin of `frameLoop`. Measured: a viewport whose
    // renderer failed to init leaves the frame loop at a healthy 61fps while nothing renders and
    // the scene never loads, so `fps` cannot speak for this. Omitted once the renderer is ready.
    ...(rendererGateFields()),
    // GPU device loss / uncaptured errors — the cause a `frameLoop.status: 'stalled'` reading
    // is often only the symptom of. See `gpuFields`.
    ...(gpuFields()),
    // Game code that threw while the editor booted. The project is loaded DEGRADED — its
    // systems/traits are partly unregistered — so anything measured here may be wrong for
    // reasons that have nothing to do with the scene. Omitted when the project booted clean.
    ...(getGameBootFaults().length ? { gameBootFaults: getGameBootFaults() } : {}),
    // Every entity in the world, resources included (§2, #1223 D3) — not get_scene_state's rows.
    worldEntityTotal: all.length,
    selection: {
      entityId: s.selectedEntityId,
      entityIds: s.selectedEntityIds,
      // The guids beside the ids (#1223): `set_selection` refuses an `{id}` for an entity that has a
      // guid, so a read → restore round trip must be able to hand back what it accepts.
      // Read per entity, not from `getAllEntities()`, which drops a parked pool row and its subtree.
      guid: s.selectedEntityId != null ? liveGuidOf(s.selectedEntityId) : null,
      guids: s.selectedEntityIds.map((id) => liveGuidOf(id)),
      asset: s.selectedAsset,
    },
    camera: readEditorCamera(),
    undo: { canUndo: canUndo(), canRedo: canRedo(), undoLabel: undoLabel(), redoLabel: redoLabel() },
    // Viewport + UI zoom, exposed as DATA so "what's the current zoom / viewport size" has a
    // Percept surface (previously answerable only via a raw CDP eval of window.*). `zoomFactor`
    // is the VS Code–style whole-app UI zoom (getPresentationScale is editor-calibrated to
    // webContents.getZoomFactor); `devicePixelRatio` is the raw backing-store ratio (display
    // scale × zoom). See docs/debug-tools-mcp.md.
    viewport: readViewport(),
    // Which on-screen surfaces have a bounds provider mounted RIGHT NOW. A 2D/3D entity aim
    // REQUIRES a `surface` (docs/enact.md), so without this a caller had to guess at exactly the
    // thing the requirement exists to stop it guessing about — and a batch, which cannot read a
    // response to recover from a refusal, would lose the whole batch to the guess. Cheap: it reads
    // the provider registry, not the scene.
    surfaces: mountedSurfaces(),
  };
}

type EditorState = ReturnType<typeof readEditorState>;

/**
 * An ACTION op's reply: the editor-state fields that action changed, READ BACK from the stores
 * after it ran (#1553). The whole `readEditorState()` used to be spread into 17 action replies —
 * ~1.7k chars a call, 10% of all MCP result tax on `play_control` alone, and over batch's
 * verbatim cap so a batch elided the one field the step was run to see. The full state stays one
 * `modoki_get_editor_state` away. Read back rather than echoed from the args, so the reply is
 * still evidence of the post-state (§11), not a restatement of the request.
 * A key the state omits (the optional-when-healthy/empty ones) stays omitted here.
 */
function editorStateFields<K extends keyof EditorState>(...keys: K[]): Pick<EditorState, K> {
  const s = readEditorState();
  const out = {} as Pick<EditorState, K>;
  for (const k of keys) if (k in s) out[k] = s[k];
  for (const k of ACTION_HEALTH_KEYS) if (k in s && isActionFault(k, s)) (out as Record<string, unknown>)[k] = s[k];
  return out;
}

/** A health field is a FAULT on an action reply only in its failing states. `get_editor_state`
 *  reports `frameLoop` for a hidden window or after a recovered re-arm and `rendererGate` while
 *  `pending` — useful there, expected here: a hidden window is "not a fault" by frameDriver's own
 *  word, and a 2D/UI-only project sits in `pending` for its whole session, so reporting them would
 *  hang a false alarm (and the bytes #1553 removed) on every action (#1553 second review). */
function isActionFault(k: typeof ACTION_HEALTH_KEYS[number], s: EditorState): boolean {
  if (k === 'frameLoop') return s.frameLoop?.status === 'stalled';
  if (k === 'rendererGate') return s.rendererGate?.status === 'failed';
  return true;
}

/** The HEALTH fields every action reply still carries — each only while FAULTED ({@link isActionFault}),
 *  so a healthy editor pays nothing for them. An agent that presses Play on a stale editor must still hear
 *  `staleGameCode:true` in that reply (CLAUDE.md § Hot reload: measurements from it are suspect);
 *  #1553 dropped these with the rest of the state until review caught it. `hmrUpdates` is NOT here:
 *  it is present on any editor that ever hot-reloaded, i.e. a count, not a fault. */
export const ACTION_HEALTH_KEYS = [
  'staleGameCode', 'discardedUnsavedEdits', 'frameLoop', 'rendererGate', 'gpu', 'gameBootFaults',
] as const satisfies ReadonlyArray<keyof EditorState>;

/** The play-state trio every play_control transition reports (+ the health fields, when unhealthy). */
const playStateFields = () => editorStateFields('playState', 'runMode', 'advancing');

/** CSS viewport size + zoom, read live from the renderer window. Guarded for the
 *  headless/SSR case (no `window`) so this stays safe if ever called off the renderer. */
function readViewport() {
  if (typeof window === 'undefined') return null;
  return {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio || 1,
    zoomFactor: getPresentationScale(),
  };
}

// ── Param shapes ───────────────────────────────────────────────────────────

interface SetSelectionParams { entityId?: number | null; entityIds?: number[]; guid?: string; guids?: string[]; asset?: SelectedAsset | null }
interface CreateEntityParams { spec: CreateEntitySpec; parentId?: number; parentGuid?: string; name?: unknown }
/** The prefab operations. The three `edit-*` actions drive PREFAB-EDIT MODE — opening a
 *  `.prefab.json` in isolation, saving the edited template back, and returning to the scene
 *  it was opened from. They are the only route that re-serializes a prefab file, which is why
 *  the bulk re-save sweep (#125, engine/scripts/resave-prefabs.sh) is built on them. */
type PrefabAction =
  | 'instantiate' | 'create' | 'detach'
  // ── override discovery/apply/revert (#2Tkw8CiWRATmHck2ze7q) — the ONLY route by which
  // an agent can drive the human "Apply to Prefab" / "Revert Overrides" dialogs, which
  // previously had no agent path at all despite this contract claiming one existed. ──
  | 'overrides' | 'apply' | 'revert'
  | 'edit-open' | 'edit-save' | 'edit-exit';

interface PrefabParams {
  /** Which prefab operation. Callers reaching this op DIRECTLY (`runAgentOp`, `modoki_eval`) may
   *  use `action`; anything arriving via `POST /api/editor-action` MUST use `prefabAction`.
   *
   *  Why the second name exists: that route takes the OP NAME in `action` and strips it before
   *  relaying (`const { action: _omit, ...params }`), so a param called `action` is structurally
   *  unreachable through it — and `modoki_prefab`, which spread its args over the routing key,
   *  sent `action:'instantiate'` as the op name and got a 400 listing the valid ops. Every
   *  prefab call through the MCP failed that way. */
  prefabAction?: PrefabAction;
  action?: PrefabAction;
  /** instantiate / edit-open: prefab asset path. create: destination path to write. */
  path?: string;
  /** edit-open: discard unsaved live work instead of refusing (mirrors load-scene). */
  force?: boolean;
  /** instantiate: parent entity id (default root). */
  parentId?: number;
  /** instantiate: parent entity guid. Given with ANY `parentId` (0 included), the call is refused (#1223 D1). */
  parentGuid?: string;
  /** create/detach/overrides/apply/revert: the entity to make a prefab from / detach /
   *  inspect-or-mutate overrides on. For overrides/apply/revert this must be a prefab
   *  INSTANCE ROOT (or any member — resolution walks to the instance the entity belongs to
   *  the same way the human dialogs do: via the entity's own PrefabInstance trait). */
  entityId?: number;
  /** create/detach/overrides/apply/revert: the entity guid. Given together with `entityId`, the call is refused (#1223 D1). */
  entityGuid?: string;
  /** apply/revert: the override keys to act on (see `overrides`'s `keys.all` for the exact
   *  strings — `"<member>.trait.field"` / `"+added.<guid>"` / `"-removed.<member>"` /
   *  `"-trait.<member>.<name>"` / `"+trait.<member>.<tag>"` / `"~moved.<member>"`, `<member>` a nodeGuid or, for a pre-v5
   *  template, a localId; `prefabOverrideKeys.ts`). Omitted ⇒ ALL current overrides on the instance. */
  keys?: string[];
}

/** Raw selection write — no undo entry (the agent shouldn't pollute the human's
 *  undo stack just by selecting). Mirrors deleteEntitiesWithUndo's setState path. */
function setSelectionRaw(entityId: number | null, entityIds: number[]): void {
  useEditorStore.setState({ selectedEntityId: entityId, selectedEntityIds: entityIds, selectedAsset: null });
}

/** Throw a shared-resolver refusal as the op's own: a coded one as `OpRefusal`, carrying its `options`
 *  and `stale`; an uncoded one (no address at all) as a plain `Error`. */
/** The `type` filter on the two journal reads matches EXACTLY, so a type outside the table matches
 *  nothing: `editor-journal` answered an empty read under a filtered framing, and `wait-for-edit`
 *  parked its whole timeout — "the human did nothing" for `'edit'` typed without its `!` (#1213). */
/** An op that owns a vocabulary refuses a value outside it, with the table as `options` — never
 *  stores it, drops it or answers ok (#1072, #1213). `undefined` means "not given" and passes; the
 *  caller decides whether an absent value is itself a refusal. */
function refuseUnknownValue<T extends string>(op: string, field: string, value: unknown, table: readonly T[], nothingDone: string): asserts value is T | undefined {
  if (value === undefined || (table as readonly unknown[]).includes(value)) return;
  throw new OpRefusal('REFUSED_BY_OP',
    `${op}: unknown ${field} ${JSON.stringify(value)} — ${nothingDone}. Valid: ${table.join(', ')}.`,
    { options: [...table] });
}

/** What each asset editor is called, and the call that opens it — the `options` of every "not open"
 *  refusal below. */
const ASSET_EDITORS: Record<AssetEditorKind, { name: string; opener: string }> = {
  animation: { name: 'Animation editor', opener: 'modoki_open_animation_editor {path}' },
  particle: { name: 'Particle editor', opener: 'modoki_open_particle_editor {path}' },
  skin: { name: 'Skin editor', opener: 'modoki_open_skin_editor {path}' },
  sprite: { name: 'Sprite Editor', opener: 'modoki_open_sprite_editor {path}' },
  nineslice: { name: 'Nine-slice editor', opener: 'modoki_open_nine_slice_editor {path}' },
};

/** An op that acts ON an editor refuses when that editor is not showing anything (#1213). The store
 *  naming an asset is not enough — that is what `select-sprite-slice` and `set-skin-mode` read, and
 *  both answered ok with no editor on screen. Reads the mount the editor itself publishes. */
function requireEditorOpen(kind: AssetEditorKind, op: string): AssetEditorMount & { path: string } {
  const mount = useEditorStore.getState().editorMounts[kind];
  if (mount && mount.path != null) return mount as AssetEditorMount & { path: string };
  const { name, opener } = ASSET_EDITORS[kind];
  throw new OpRefusal('NOT_FOUND',
    `${op}: the ${name} is not open${mount ? ' (its panel is mounted with nothing loaded)' : ''}, so there is nothing for this to act on — nothing was changed.`,
    { options: [`${opener} opens it — then retry`, 'modoki_get_editor_state.openEditors shows which editors are open'] });
}

const EDITOR_MOUNT_WAIT_MS = 3000;

/** An opener waits for its editor to MOUNT on the asset it named, rather than answering once the
 *  store is pointed (#1213) — the same readiness rule `open-animation-editor` already follows. The
 *  store field is not the editor: a dockable tab never opened this session does not mount, and a
 *  texture modal opens only if the texture's Inspector view is on screen to consume the request. */
async function awaitEditorMount(kind: AssetEditorKind, path: string, op: string, why: string): Promise<void> {
  const deadline = Date.now() + EDITOR_MOUNT_WAIT_MS;
  while (useEditorStore.getState().editorMounts[kind]?.path !== path && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const now = useEditorStore.getState().editorMounts[kind];
  if (now?.path === path) return;
  const { name } = ASSET_EDITORS[kind];
  throw new OpRefusal('NOT_AVAILABLE_HERE',
    `${op}: the ${name} did not open on ${path} within ${EDITOR_MOUNT_WAIT_MS / 1000}s`
    + `${now?.path ? ` — it is showing ${now.path}` : ''}. ${why}`,
    { options: [
      'modoki_get_editor_state.openPanels / openEditors show what is on screen',
      `retry ${ASSET_EDITORS[kind].opener.replace('{path}', `{path:"${path}"}`)} once the panel is showing`,
    ] });
}

function refuseUnknownJournalType(op: string, type: unknown, nothingDone: string): void {
  if (type === undefined || isEditorJournalType(type)) return;
  throw new OpRefusal('REFUSED_BY_OP',
    `${op}: unknown type ${JSON.stringify(type)} — ${nothingDone}. Editor event types all start with '!'; valid: ${EDITOR_JOURNAL_TYPES.join(', ')}.`,
    { options: [...EDITOR_JOURNAL_TYPES] });
}

function throwAddressRefusal(r: { code?: ErrorCode; error: string; options?: string[]; stale?: string }): never {
  if (r.code) throw new OpRefusal(r.code, r.error, { options: r.options, stale: r.stale });
  throw new Error(r.error);
}

/** A SET member (`set-selection`/`delete-entities`): its live id, or null when it matched nothing, so
 *  the op can skip it and say so. Any OTHER refusal throws, and refuses the whole call: an `{id}` naming
 *  an entity that has a guid (#1223 D2), or a guid given beside an id (D1), is a wrong address, and
 *  skipping one quietly would act on the rest of a set the caller did not mean. */
function resolveLiveIdOrSkip(ref: EntityAddress, op: string, miss: { stale?: string } = {}): number | null {
  const r = resolveEntityAddress(ref, { label: op, accept: ['guid', 'id'] });
  if (r.ok) return r.id;
  // `miss` collects the first skipped ref's `stale`, so an all-miss refusal still says why (#1223 D4).
  if (r.code === 'NOT_FOUND') { miss.stale ??= r.stale; return null; }
  return throwAddressRefusal(r);
}

/** Validate that `path` names a real asset of `expected` type before opening an editor on it.
 *  The open-*-editor ops used to mount a panel at ANY string path and return editor state
 *  (success), so a typo'd/wrong-type path silently produced a panel with no handles and no
 *  error — indistinguishable from "not mounted". Now a bad path is an actionable failure. (C7 re-audit.)
 *
 *  ⚠️ The type check here used to call `getAssetType(path)`, but that function is
 *  guid-KEYED (`guidToEntry.get(guid)`) — a path is never a key in that map, so `type` was
 *  ALWAYS undefined and the mismatch branch could never throw (#373 close-out review: caught
 *  because `modoki_open_skin_editor {path:'/assets/textures/ui.png'}` opened the Skin editor on
 *  a PNG with a clean success). `getAssetEntry` indexes BOTH guid and path, so it actually
 *  resolves what this asserts against. */
function requireAssetPath(path: string | undefined, expected: string, op: string): void {
  if (typeof path !== 'string' || !path) throw new Error(`${op} requires { path } — the asset's served URL (see modoki_list_assets).`);
  if (!getGuidForPath(path)) throw new OpRefusal('NOT_FOUND', `${op}: no asset found at "${path}" — it resolves to no manifest entry (typo, or wrong path). Find it with modoki_list_assets.`);
  const type = getAssetEntry(path)?.type;
  if (type && type !== expected) throw new Error(`${op}: "${path}" is a ${type}, not a ${expected} — this editor only opens ${expected} assets.`);
}

/** Resolve a required entity ref for a structural op through the shared resolver
 *  (`app/debug/entityRef.ts`, #1223), throwing its refusal — so a stale guid, an ambiguous pair or an
 *  `{id}` for an entity that has a guid is a visible failure, never a silent wrong target. */
function requireLiveId(ref: EntityAddress | undefined, op: string, accept: readonly EntityAddressKey[] = ['guid', 'id']): number {
  const r = resolveEntityAddress(ref, { label: op, accept });
  return r.ok ? r.id : throwAddressRefusal(r);
}

/** A loaded scene as a person knows it: its file name. `''` is the primary. */
function loadedSceneName(sceneGuid: string): string {
  for (const s of sceneManager.getLoadedScenes().values()) {
    if ((s.role === 'primary' ? '' : s.guid) === sceneGuid) return s.path.split('/').pop() || s.path;
  }
  return sceneGuid || 'primary';
}

/** Why `planReparent` refused, in words an agent can act on (#1429). */
function reparentRefusalText(reason: Extract<ReparentPlan, { kind: 'refused' }>['reason'], id: number, parentId: number): string {
  switch (reason) {
    case 'resource': return `reparent-entity: refused to move ${id} under ${parentId} — a resource entity (Time, Input, a config singleton) stays at the root and holds no children (#1248).`;
    case 'instance-member': return `reparent-entity: refused to move ${id} under ${parentId} — ${parentId} belongs to another scene, and something in ${id}'s subtree (${id} itself, or an entity under it) belongs to a prefab instance that would stay behind, splitting it across two scene files. Move that instance's root instead, or unpack that instance first.`;
    default: return `reparent-entity: refused to move ${id} under ${parentId} — the move is illegal (${reason === 'self-parent' ? 'an entity cannot be its own parent' : `${parentId} is a descendant of ${id}`}).`;
  }
}

/** The parent an entity should be created under / moved to, VALIDATED.
 *
 *  `parentGuid` was checked and `parentId` was not, so a stale or invented id sailed through as a
 *  literal. Measured 2026-07-30: `create-entity {spec:{kind:'primitive',mesh:'cube'}, parentId:99999}`
 *  returned `{id:141, name:'Cube', guid:…}` — a clean success — and produced an entity whose
 *  `EntityAttributes.parentId` pointed at nothing. An ORPHAN: it is in the world, it has a parent
 *  that does not exist, and nothing said so. Runtime ids are reassigned on every scene reload, so a
 *  stale `parentId` is not an exotic input — it is what an agent holds after any hot-reload.
 *
 *  `0` stays literal: it means ROOT, not "entity 0", and must never be resolved. */
function resolveParentId(p: { parentId?: number; parentGuid?: string }, op: string, opts: { move?: boolean } = {}): number {
  // Root only when NOTHING else is given: `parentGuid` beside `parentId: 0` is two addresses, and the
  // shared resolver refuses the pair rather than letting either win (#1223 D1).
  const rootOnly = !p.parentGuid && (p.parentId == null || p.parentId === 0);
  const id = rootOnly ? 0 : requireLiveId({ guid: p.parentGuid, id: p.parentId }, op);
  // A MOVE is judged by `reparentRefusal`, which lets a reorder under the current parent through; only a
  // path that CREATES the link refuses a resource parent outright.
  if (!opts.move) refuseResourceParent(id, op);
  return id; // 0: omitted, or an explicit 0 → root
}

/** Refuse a resource entity as a parent (#1248 — `parentRefusal`, shared by every parent-creating path). */
function refuseResourceParent(parentId: number, op: string): void {
  if (parentRefusal(parentId)) {
    throw new Error(`${op}: entity ${parentId} is a resource (Time, Input, a config singleton) and holds no children — a child under the Transient Time/Input singleton is dropped from every save. Parent it elsewhere, or omit the parent for the scene root.`);
  }
}

/** Make an agent asset-def edit UNDOABLE, the way the equivalent panel edit already is.
 *
 *  The five asset-authoring ops (`particle-set`, `anim-set-clip`, `anim-add-key`, `timeline-set`,
 *  `timeline-add-clip`) applied their change and pushed NOTHING, while `ParticleEditor` pushes a
 *  before/after entry to the SAME global `undoManager` for the identical edit. Two consequences,
 *  and the second is the damaging one: the agent's edit could not be undone at all, and a human
 *  pressing Cmd-Z after it silently unwound THEIR OWN earlier action — one they had no reason to
 *  think was next on the stack. (Audit S2.27; owner decision 2026-07-30 to close the asymmetry.)
 *
 *  `_isFileDirect` is load-bearing, not decoration. Without it, pushing the entry ALSO bumps
 *  `notifyEdited()`, so `hasUnsavedChanges()` reports the SCENE dirty for an asset-only edit — and
 *  the dirty-asset registry already tracks the asset's own pending write separately. That bump is
 *  what `dirtyAssets.test.ts` guards, and it is a real defect, not a technicality: a falsely-dirty
 *  scene self-blocks the file-direct routes that refuse when live work is unsaved.
 *
 *  `apply` is the same store call the op itself uses, so undo/redo replay the exact path the edit
 *  took rather than a reconstruction of it.
 *
 *  BOTH DIRECTIONS MUST MOVE THE PARKED WRITE, not just the live cache (independent review,
 *  2026-07-30). Persistence is manual-only, so the op parks its result in the dirty-asset registry
 *  and `save_all` is what commits it. When undo only re-applied the old def to the CACHE, the
 *  registry still held the new one — so the next `save_all` wrote to disk exactly the value the
 *  caller had just undone, and the undo silently un-did itself at save time.
 *
 *  Which way undo moves the registry depends on whether a write was ALREADY parked for this path
 *  before this edit (captured here, before the op's own `persistOrMarkDirty` runs):
 *   - already pending → the parked doc WAS `before`, so re-park `before`: state restored exactly.
 *   - not pending → disk already holds `before`, so DISCARD the parked write instead of re-parking.
 *     Re-parking would leave the asset dirty forever after an undo, and `hasUnsavedChanges()` would
 *     then block the file-direct routes over an edit that no longer exists. */
function pushAssetUndo<T>(
  label: string, before: T | null | undefined, after: T, apply: (def: T) => void,
  path: string, type: AssetSchemaType,
): void {
  // No prior def means this is the FIRST write to that asset — there is no state to revert TO, so
  // an entry would be a lie about what undo can do. The write itself still stands.
  //
  // `== null` catches BOTH, deliberately: every asset cache getter returns `null` for a miss
  // (`getParticleEffect`, `getAnimationClip`, `getTimeline`), so a strict `=== undefined` check
  // never fired and we pushed an entry whose `undo()` applied `null` — restoring nothing while
  // consuming the human's Cmd-Z, which is worse than the missing entry it was meant to prevent.
  if (before == null) return;
  const wasPending = getDirtyAssetPaths().includes(path);
  pushAction({
    label,
    undo: () => {
      apply(before);
      if (wasPending) markAssetDirty(path, type, before);
      else discardDirtyAssets([path]);
    },
    redo: () => {
      apply(after);
      markAssetDirty(path, type, after);
    },
    kind: '!asset-edit',
    _isFileDirect: true,
  });
}

/** Refuse an asset-editing op whose `path` names no asset that exists.
 *
 *  `particle-set` / `anim-set-clip` / `timeline-set` REPLACE a def by path and, under manual
 *  persistence, park the write for `save_all` to flush. None of them checked that the path was a
 *  real asset — so a typo (or a file nothing has loaded) was applied to nothing, reported
 *  `{ok:true}`, and `save_all` later MATERIALISED it as a brand-new file. The agent believes it
 *  edited an existing effect; what it actually did was create a second one with a slightly wrong
 *  name, leaving the original untouched. Their granular siblings (`anim-add-key`,
 *  `timeline-add-clip`) already resolve the asset first — this brings the wholesale ops in line.
 *
 *  Returns a refusal object, or null when the path is fine. */
function requireExistingAsset(path: string, op: string, kind: string): { ok: false; error: string; hint: string } | null {
  if (getGuidForPath(path)) return null;
  return {
    ok: false,
    error:
      `${op}: no ${kind} asset exists at ${JSON.stringify(path)} — nothing was applied and nothing was parked. ` +
      'This op REPLACES an existing def; it does not create one, and a save would otherwise have ' +
      'written a brand-new file under this name while the asset you meant stayed untouched.',
    hint: `Check the path with modoki_list_assets (type=${kind}), or create it first with modoki_create_asset.`,
  };
}

/** WORLD-space Transform fields → the LOCAL fields actually stored, against the LIVE world.
 *
 *  The live twin of `sceneMutate.ts`'s `worldFieldsToLocal`, and it converts the WHOLE POSE for
 *  the same reason: with a rotated parent a world X depends on the child's world Y and Z, so
 *  converting one field against zeros would silently move the other axes.
 *
 *  TRS IS THE PARENT CONVENTION — deliberately, and it is why this no longer calls `worldToLocal3D`
 *  (owner decision, 2026-07-31; independent review, 2026-07-30).
 *
 *  A hierarchy in Modoki is TRS at every level, the way Unity's `Transform` is; a sheared parent
 *  (non-uniform scale ABOVE a rotation) is not a legal state. `worldToLocal3D` inverts the RAW
 *  composed matrix, so it is exact even under shear — and that made it the OUTLIER: the file path
 *  (`parentWorldTrs` → `worldToLocalTrs`) and the human 3D gizmo
 *  (`gizmoTransform.worldToLocalTransform`, fed the render cache's decomposed parent) both compose
 *  the chain and decompose ONCE. So the same `{space:'world'}` op landed the entity in a different
 *  place depending on whether an editor happened to be open, and neither answer matched a gizmo
 *  drag. Measured on a 2-level chain: requesting world (10,0,0) put it at (10,0,0) live and
 *  (12.638, 0.270, 0) headless. Authoring now speaks one language across all three.
 *
 *  SCOPE, also deliberate: `worldToLocal3D` itself is UNCHANGED. Physics uses it every frame to
 *  write a stepped body's world pose back into a parented local Transform, as do `games/sling`
 *  (fish steering) and `demos/forest-camp` (arrow attach) — simulation wants the exact inverse and
 *  a per-frame decompose is a cost with no authoring benefit. The split is authoring vs simulation,
 *  which is a real line, not two accidental conventions.
 *
 *  A ROOT entity's parent matrix is the identity, so this is an exact no-op there. */
/** Scratch for the parent-chain composition — this runs per set_transform op, not per frame,
 *  but allocating a Matrix4 per call for no reason is still noise. */
const _parentM = new THREE.Matrix4();

function worldFieldsToLocalLive(id: number, fields: Record<string, unknown>): { fields: Record<string, unknown> } | { error: string } {
  const entity = findEntity(id);
  const cur = entity?.get(Transform) as Record<string, number> | undefined;
  if (!cur) return { fields };
  const local = {
    x: cur.x ?? 0, y: cur.y ?? 0, z: cur.z ?? 0,
    rx: cur.rx ?? 0, ry: cur.ry ?? 0, rz: cur.rz ?? 0,
    sx: cur.sx ?? 1, sy: cur.sy ?? 1, sz: cur.sz ?? 1,
  };
  const w = getWorldTransform3D(id);
  const world = { x: w.x, y: w.y, z: w.z, rx: w.rx, ry: w.ry, rz: w.rz, sx: w.sx, sy: w.sy, sz: w.sz };
  // Root: world == local already, so no conversion is needed (and none is safe to apply — the
  // decompose round-trip would introduce float noise on untouched axes).
  const isRoot = (['x', 'y', 'z', 'rx', 'ry', 'rz', 'sx', 'sy', 'sz'] as const)
    .every((k) => Math.abs(world[k] - local[k]) < 1e-9);
  if (isRoot) return { fields };

  const wantWorld = mergeTrs(world, fields);
  // Compose the parent chain exactly, then decompose ONCE — byte-for-byte what `parentWorldTrs`
  // does on the file side, and what the render cache hands the gizmo. `getParentWorldMatrix3D` is
  // the composition; the decompose is what makes this the TRS convention rather than the exact one.
  const parentTrs = matrixToTrs(getParentWorldMatrix3D(id, getCurrentWorld(), _parentM));
  // Same refusal as the file path: a zero-scaled ancestor collapses every descendant onto its
  // origin, so the request has no solution and `decompose` would silently substitute an identity
  // parent. See `collapsedParentAxes`.
  const collapsed = collapsedParentAxes(parentTrs);
  if (collapsed) {
    return { error:
      `space:'world' is not solvable here: an ancestor has ZERO scale on ${collapsed.join('/')}, which `
      + 'collapses every descendant onto its origin, so no local transform can place this entity at the '
      + "requested world point. Give the ancestor a non-zero scale, or write space:'local'." };
  }
  const next = worldToLocalTrs(wantWorld, parentTrs);
  const all: Record<string, number> = {
    x: next.x, y: next.y, z: next.z, rx: next.rx, ry: next.ry, rz: next.rz, sx: next.sx, sy: next.sy, sz: next.sz,
  };
  // Write back the whole GROUP each named axis belongs to — see `persistedTrsKeys`, shared with
  // the file path so the two cannot diverge.
  const out: Record<string, unknown> = {};
  for (const k of persistedTrsKeys(fields)) out[k] = all[k];
  return { fields: out };
}

/** Resolve a `mutate_scene`-shaped entity ref ({id}|{name}|{guid}) against the LIVE world —
 *  the live-path twin of sceneMutate.ts's `resolveEntity` (which resolves against the FILE). Unlike
 *  `requireLiveId` it accepts `name`, for parity with the file-direct op vocabulary.
 *
 *  An AMBIGUOUS `name` is an error, not a first-match. It used to be `.find()`, and duplicate
 *  names are ordinary (three entities called "Enemy") — MEASURED on `games/3d-test`: with two
 *  entities named `DUP_probe`, `set_transform {name:'DUP_probe'}` moved ONE of them and returned
 *  `{ok:true, changed:1, errors:[], warnings:[]}`. The other was untouched and nothing said so.
 *  Inside a batch there is no intermediate response in which to notice, and the entity-aimed input
 *  path already refuses exactly this (see `entityResolve.ts`) — so the two halves of the agent
 *  surface disagreed about whether an ambiguous name is addressable. It is not. */
function resolveLiveEntityRef(ref: MutateEntityRef | undefined): { id: number } | { error: string; code?: ErrorCode; options?: string[]; stale?: string } {
  // The shared resolver (#1223): exactly one address, an ambiguous name refused with its guids, `{id}`
  // only for a guid-less entity, and a stale runtime guid named as such.
  const r = resolveEntityAddress(ref, { label: 'entity' });
  return r.ok ? { id: r.id } : r;
}

/** The live-world twin of sceneMutate.ts's `applyOps` — same {@link MutateOp} vocabulary
 *  (setTrait / removeTrait / addEntity / removeEntity), applied to the running ECS world via
 *  the existing undoable `*WithUndo` helpers instead of a scene-file JSON object, wrapped in
 *  ONE composite undo entry (compositeAction.ts) so an N-op tool call is one Cmd-Z.
 *
 *  `setBaseScene` has NO live-world equivalent — it changes what the scene *loads*, not any
 *  live entity's state — so it is refused here entirely; the caller (the `/api/scene-mutate`
 *  route) keeps any call containing it on the file-direct path regardless of persistence mode
 *  (mcp-persistence.md Phase 2 "setBaseScene" caveat).
 *
 *  Deliberately NOT at full parity with `applyOps`: it does not detect unknown-field typos
 *  against the trait schema, and removeEntity does not scan for now-dangling UIAction
 *  references. Both are diagnostic niceties on the file-direct path (schema/warnings live
 *  there), not correctness requirements for the live world — a follow-up can port them if an
 *  agent actually hits one live. */
async function applySceneOpsLive(ops: MutateOp[]): Promise<{
  changed: number; errors: string[]; warnings: string[]; unresolved: MutateEntityRef[];
  created: Array<{ op: number; id: number; guid: string; name: string }>;
  addedTraits?: Array<{ op: number; id: number; guid: string; trait: string }>;
  code?: ErrorCode; options?: string[]; stale?: string;
} & AlsoDeletedFields> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const unresolved: MutateEntityRef[] = [];
  // What each addEntity op created, in op order (S3.12) — the live twin of applyOps' `created`.
  // Without it `changed:N` was the whole answer, so an agent had to re-find its own entity by
  // name, which this surface refuses when the name is ambiguous.
  const created: Array<{ op: number; id: number; guid: string; name: string }> = [];
  /** #1216 C-12 / D6 — see `ApplyResult.addedTraits` (sceneMutate.ts), the file path's twin. */
  const addedTraits: Array<{ op: number; id: number; guid: string; trait: string }> = [];
  /** #1262 — what each removeEntity's cascade took, for the whole call; the file path's twin. */
  const alsoDeleted = alsoDeletedTally();
  let changed = 0;
  // FIRST resolveLiveEntityRef failure's machine code, if it had one (NOT_FOUND/AMBIGUOUS) — a
  // single-op call (the common case: modoki_set_transform/tap) needs its refusal's code to
  // survive to the HTTP boundary, and the first one is the one that actually blocked the op the
  // caller most likely cares about.
  let code: ErrorCode | undefined;
  // …and that failure's `options`/`stale`, which travel with the code (#1223 D4).
  let first: { options?: string[]; stale?: string } | undefined;
  const allTraitsList = getAllTraits();

  await runAsCompositeAction({ label: `Mutate Scene (${ops.length} op${ops.length === 1 ? '' : 's'})`, kind: '!mutate' }, () => {
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      const where = `op[${i}] (${op?.op ?? 'unknown'})`;
      try {
        if (op.op === 'setTrait') {
          const resolved = resolveLiveEntityRef(op.entity);
          if ('error' in resolved) { errors.push(`${where}: ${resolved.error}`); unresolved.push(op.entity); if (code === undefined) { code = resolved.code; first = resolved; } continue; }
          const id = resolved.id;
          if (!op.trait) { errors.push(`${where}: missing 'trait'`); continue; }
          const writeRefused = traitWriteRefusal(op.trait); // the file path's refusal, live (#1454)
          if (writeRefused) { errors.push(`${where}: ${writeRefused}`); continue; }
          const meta = allTraitsList.find((t) => t.name === op.trait);
          if (!meta) { errors.push(`${where}: unknown trait '${op.trait}' — list traits with modoki_list_traits`); continue; }
          if (op.space && op.trait !== 'Transform') {
            // Never silently ignore a parameter (§6) — mirrors the file path.
            errors.push(`${where}: 'space' applies only to trait 'Transform' (got '${op.trait}').`);
            continue;
          }
          let fields = op.fields ?? {};
          if (op.space === 'world') {
            const converted = worldFieldsToLocalLive(id, fields);
            if ('error' in converted) { errors.push(`${where}: ${converted.error}`); continue; }
            fields = converted.fields;
          }
          const entity = findEntity(id);
          if (Object.keys(fields).length === 0) {
            // No fields → tag presence, mirroring sceneMutate.ts (don't clobber existing data;
            // re-tagging an existing trait is a genuine no-op, not a change).
            if (entity && !entity.has(meta.trait)) { addTraitToEntitiesWithUndo([id], meta); changed++; }
          } else if (entity && !entity.has(meta.trait)) {
            // The entity doesn't have this trait yet — ADD it seeded with `fields`, mirroring
            // sceneMutate.ts's setTrait (merge onto an empty base when absent). Without this,
            // writeTraitFieldWithUndo below silently no-ops on a missing trait (it requires the
            // entity to already have it) while still reporting changed:1 and pushing an inert
            // undo entry — a live-path-only regression from file-direct parity, found while
            // testing the composite-batch removeTrait+removeEntity case.
            addTraitToEntitiesWithUndo([id], meta, fields);
            // Already durable here: the undo action's `entityRef` minted it (a test pins that). ensureGuid reads it
            // back typed non-null; it is not what makes it durable.
            addedTraits.push({ op: i, id, guid: ensureGuid(id), trait: meta.name });
            changed++;
          } else {
            // writeTraitFieldWithUndo already routes into prefab-INSTANCE overrides
            // (markFieldOverrideIfInstance) — the live-world equivalent of sceneMutate.ts's
            // traitWriteContainer comes for free from the existing helper, not reimplemented here.
            // A parentId write is a reparent in all but name, so it answers to the same rule (#1248). It
            // used to go straight to the trait, past the resource AND the cycle check.
            const rawParent = meta.name === 'EntityAttributes' ? (fields as Record<string, unknown>).parentId : undefined;
            let newParent = rawParent;
            const shown = typeof rawParent === 'string' ? `"${rawParent}"` : String(rawParent); // the caller's own input, in errors
            // A string parent is a guid, as in addEntity. Unlike addEntity, a parent that matches nothing is
            // refused rather than re-rooted: this moves an EXISTING entity, and a string written raw into the
            // numeric field skipped every check below (#1434 review).
            if (newParent !== undefined && typeof newParent !== 'string' && typeof newParent !== 'number') {
              errors.push(`${where}: EntityAttributes.parentId must be a guid string or an entity id (got ${JSON.stringify(newParent)}) — nothing was applied to entity ${id}`);
              continue;
            }
            if (typeof newParent === 'string') {
              const pr = resolveLiveEntityRef({ guid: newParent });
              if (!('id' in pr)) {
                errors.push(`${where}: EntityAttributes.parentId ${shown} matched no live entity (${pr.error}) — nothing was applied to entity ${id}`);
                unresolved.push({ guid: newParent }); if (code === undefined) { code = pr.code; first = pr; }
                continue;
              }
              newParent = pr.id;
            }
            if (typeof newParent === 'number' && newParent !== 0 && !findEntity(newParent)) {
              errors.push(`${where}: EntityAttributes.parentId ${newParent} matched no live entity (runtime ids are reassigned on every scene reload — prefer a guid) — nothing was applied to entity ${id}`);
              continue;
            }
            // Judged by the same plan as reparent-entity (#1429). A parent from another scene is a scene move,
            // and a batch has no step to confirm one, so it is refused here with the op that can.
            const plan = typeof newParent === 'number' ? planReparent(id, newParent) : null;
            if (plan?.kind === 'refused') { errors.push(`${where}: EntityAttributes.parentId ${shown} refused (${plan.reason}) for entity ${id} — nothing was applied to it`); continue; }
            if (plan?.kind === 'scene-move') { errors.push(`${where}: EntityAttributes.parentId ${shown} belongs to another scene (${loadedSceneName(plan.to)}), so this parent change is a scene move — use reparent-entity with moveToScene: true. Nothing was applied to entity ${id}`); continue; }
            // A same-scene parent change goes through reparentEntity, like every other reparent (#1434). A bare
            // field write skipped its unpack on move, so a prefab member moved out of its instance stayed linked
            // and the next save dropped it; it also skipped the world-position compensation and the folder clear.
            // A parent equal to the current one moves nothing, and is not counted as a change.
            const moved = plan ? applyReparent(id, newParent as number).ok : false;
            const rest = Object.entries(fields).filter(([field]) => !(plan && field === 'parentId'));
            for (const [field, value] of rest) writeTraitFieldWithUndo(id, meta, field, value);
            if (moved || rest.length) changed++;
          }
        } else if (op.op === 'removeTrait') {
          const resolved = resolveLiveEntityRef(op.entity);
          if ('error' in resolved) { errors.push(`${where}: ${resolved.error}`); unresolved.push(op.entity); if (code === undefined) { code = resolved.code; first = resolved; } continue; }
          const id = resolved.id;
          if (!op.trait) { errors.push(`${where}: missing 'trait'`); continue; }
          const removeRefused = traitRemoveRefusal(op.trait);
          if (removeRefused) { errors.push(`${where}: ${removeRefused}`); continue; }
          const meta = allTraitsList.find((t) => t.name === op.trait);
          if (!meta) { errors.push(`${where}: unknown trait '${op.trait}'`); continue; }
          const entity = findEntity(id);
          if (entity?.has(meta.trait)) { removeTraitFromEntitiesWithUndo([id], meta); changed++; }
          // Removing an absent trait is a genuine no-op, not an error (mirrors sceneMutate.ts).
        } else if (op.op === 'addEntity') {
          // A new entity cannot carry a hand-made prefab link either (#1454): it would name a root and a row
          // nothing derived. Refused whole, before anything is created.
          const linkRefused = Object.keys(op.traits ?? {}).map(traitWriteRefusal).find((r) => r);
          if (linkRefused) { errors.push(`${where}: ${linkRefused}`); continue; }
          // The parent may arrive as `op.parentId` OR inside the authored EntityAttributes; both are
          // resolved and judged here, and the result is written back into the trait data below. Taking
          // only `op.parentId` let an authored `EntityAttributes.parentId` reach the entity unchecked (#1248).
          const authoredEa = op.traits?.EntityAttributes;
          const authoredParent = authoredEa && typeof authoredEa === 'object' ? (authoredEa as { parentId?: unknown }).parentId : undefined;
          const parentRaw = op.parentId ?? (typeof authoredParent === 'number' || typeof authoredParent === 'string' ? authoredParent : undefined);
          // A string parentId is a GUID. An unresolvable one falls back to the root (0) — the
          // pre-existing behaviour, kept deliberately: a missing parent is not worth failing the
          // whole op over, and the entity is still created somewhere visible.
          let parentId = 0;
          if (typeof parentRaw === 'number') {
            // A NUMERIC parent was taken literally with no check, while the string/guid form below
            // was resolved and warned about — so the same mistake was loud one way and silent the
            // other, and a stale id (they are reassigned on every scene reload) produced an ORPHAN:
            // an entity whose parentId points at nothing, reported as a clean success. Same
            // treatment for both now: resolve, else warn and fall back to the root.
            // An id naming an entity that HAS a guid is refused outright (#1223 D2), not re-rooted: the
            // caller named a real parent by the wrong key, so creating the entity anywhere else is a
            // wrong-place success.
            const pr = parentRaw === 0 ? null : resolveEntityAddress({ id: parentRaw }, { label: `${where}: parent` });
            if (!pr) parentId = 0;
            else if (pr.ok) parentId = pr.id;
            else if (pr.code === 'NOT_FOUND') warnings.push(`${where}: parent id ${parentRaw} matched no live entity (runtime ids are reassigned on every scene reload — prefer a guid) — parented to the scene root instead`);
            else { errors.push(pr.error); if (code === undefined) { code = pr.code; first = pr; } continue; }
          } else if (typeof parentRaw === 'string') {
            const pr = resolveLiveEntityRef({ guid: parentRaw });
            if ('id' in pr) parentId = pr.id;
            else warnings.push(`${where}: parent guid ${JSON.stringify(parentRaw)} did not resolve (${pr.error}) — parented to the scene root instead`);
          }
          if (parentRefusal(parentId)) {
            // Same fallback as an unresolvable parent: the entity is still created, somewhere that is saved (#1248).
            warnings.push(`${where}: parent ${parentId} is a resource (Time, Input, a config singleton) and holds no children — parented to the scene root instead`);
            parentId = 0;
          }
          const specs: TraitSpec[] = Object.entries(op.traits ?? {}).map(([name, data]) => ({
            name, data: data === true ? undefined : data as Record<string, unknown>,
          }));
          if (!specs.some((s) => s.name === 'EntityAttributes')) {
            specs.push({ name: 'EntityAttributes', data: { name: op.name ?? 'New Entity', parentId } });
          } else {
            // Always write the RESOLVED parent: the authored data may hold an unresolved guid, a stale id,
            // or a resource the check above re-rooted — and `op.parentId` must win over it either way.
            const attrs = specs.find((s) => s.name === 'EntityAttributes')!;
            attrs.data = { ...(attrs.data ?? {}), ...(op.name ? { name: op.name } : {}), parentId };
          }
          const newId = createEntityWithUndo(op.name ?? 'Add Entity', parentId, specs, () => {});
          if (newId == null) { errors.push(`${where}: nothing was created (an unregistered trait in ${JSON.stringify(Object.keys(op.traits ?? {}))}?)`); continue; }
          changed++;
          created.push({ op: i, id: newId, guid: ensureGuid(newId), name: op.name ?? 'New Entity' });
        } else if (op.op === 'removeEntity') {
          const resolved = resolveLiveEntityRef(op.entity);
          if ('error' in resolved) { errors.push(`${where}: ${resolved.error}`); unresolved.push(op.entity); if (code === undefined) { code = resolved.code; first = resolved; } continue; }
          const id = resolved.id;
          // The delete takes the subtree; name the rest BEFORE it runs (#1262), minted durable first for
          // delete-entities' reason: the guid named here must be the one undo brings back.
          const descendants = descendantsOf([id]);
          for (const d of descendants.slice(0, alsoDeleted.room())) ensureGuid(d);
          alsoDeleted.add(descendants, guidOfEntityId);
          deleteEntitiesWithUndo([id]);
          changed++;
        } else {
          errors.push(`${where}: '${(op as { op?: string }).op}' has no live-world equivalent`);
        }
      } catch (e) {
        errors.push(`${where}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  });

  return { changed, errors, warnings, unresolved, created, ...(addedTraits.length ? { addedTraits } : {}), ...alsoDeleted.fields(), ...(code ? { code } : {}),
    ...(code && first?.options?.length ? { options: first.options } : {}), ...(code && first?.stale ? { stale: first.stale } : {}) };
}

// ── Registration ─────────────────────────────────────────────────────────────

let registered = false;

/** `wait-for-edit` (#28) timeout bounds. Exported so the backend relay
 *  (`editorBackendRouter.ts`) and the MCP tool (`modoki-mcp/src/tools/editor.ts`) can give
 *  their OWN transport timeouts generous headroom over this op's internal deadline — a
 *  relay/HTTP timeout shorter than the op's own wait would kill a legitimate long park and
 *  report it as a dead backend rather than the normal `timedOut:true` answer. */
export const WAIT_FOR_EDIT_DEFAULT_MS = 30_000;
/** Upper bound on a single park. Long enough for a human to look away and make one edit;
 *  short enough that a wedged/disconnected renderer doesn't hold an HTTP request open
 *  indefinitely (this is a blocking long-poll, not an SSE stream — see the #28 brief for why
 *  SSE was passed over). A caller that wants to keep watching just calls again with the
 *  returned `nextSeq`. */
export const WAIT_FOR_EDIT_MAX_MS = 120_000;
/** Floor — guards against a 0/negative timeoutMs turning this into a busy-poll. */
export const WAIT_FOR_EDIT_MIN_MS = 50;

/** Total item count across a timeline's tracks (clips / markers / cues / spans), tolerant of both a
 *  raw partial doc and a normalized one — so timeline-set can compare pre/post normalization and detect
 *  silently-dropped malformed items. Exported for the F12 regression test. (F12) */
export function countTimelineItems(t: Partial<TimelineDef> | undefined): number {
  const tracks = (t?.tracks ?? []) as unknown as Array<Record<string, unknown>>;
  let n = 0;
  for (const tr of tracks) {
    for (const key of ['clips', 'markers', 'cues', 'spans']) {
      const arr = tr[key];
      if (Array.isArray(arr)) n += arr.length;
    }
  }
  return n;
}

/** The exits for a world that is not authored, picked by WHICH condition holds (§5: name real exits
 *  only). An envelope in scrub/preview has its owner's exits. A session held with the mode already
 *  'stopped' has no ⏹ to press, but Stop takes a held session down. The known way into that state (a
 *  begin that seated after its panel left the mode) was closed by #1569, so this branch is a backstop
 *  for one nobody has found yet. A failed restore clears on the next world swap; a restore still landing clears
 *  on its own. */
function posedWorldExits(): { options: string[]; hint?: string; owner: string | null } {
  const mode = getRunMode();
  const owner = getModeOwner();
  if (mode === 'scrub' || mode === 'preview') return { ...envelopeExitOptions(owner), owner };
  if (hasTimelinePreviewSession()) {
    return { owner, options: ["modoki_play_control {action:'stop'} — ends the held preview session (restoring the snapshot it took), then retry"] };
  }
  if (lastRestoreFailed()) {
    return { owner, options: ['modoki_load_scene — reload the scene from disk (the failed-restore guard clears on the next world swap), then retry'] };
  }
  return { owner, options: ['retry in a moment — the restore is still landing and clears on its own'] };
}

/** Refuse a live-world edit the world will not keep (#1552): inside a scrub/preview envelope the world
 *  is snapshotted and reverts on Exit, and while a restore is still landing (or after one FAILED) the
 *  world is about to be replaced. These ops replied `ok` and the edit then vanished — the same hole
 *  `/api/scene-mutate` closed for the file-shaped path in #1122, and the same exits.
 *
 *  Asks `whyWorldNotAuthored()`, the one question every disk writer asks (#1548), not the run mode:
 *  an Exit reads 'stopped' before its restore has swapped the posed world out.
 *  ⚠️ Play is exempt ON PURPOSE. Editing the play world is how an agent exercises a running game, and
 *  Stop discarding it is Play's documented contract, not a silent loss.
 *  `consequence` replaces the default "why this edit would be lost" for a caller whose risk differs. */
function refuseEditOfPosedWorld(op: string, consequence?: string): void {
  if (getRunMode() === 'playing') return;
  const why = whyWorldNotAuthored();
  if (!why) return;
  const { options, hint, owner } = posedWorldExits();
  const envelope = getRunMode() === 'scrub' || getRunMode() === 'preview';
  const lost = consequence ?? (envelope
    ? 'the live world reverts when the envelope ends, so this edit would reply ok and then be silently discarded'
    : 'the live world may still hold a pose and is about to be replaced, so this edit could be lost');
  throw new OpRefusal('REFUSED_BY_OP',
    `${op} refused: ${why}${owner ? ` (owned by the ${owner} panel)` : ''} — ${lost}. Nothing was changed.`
    + (hint ? ` ${hint}` : ''),
    { options });
}

/** PlayerPrefs is put back only by a held preview SESSION (#1551, `previewSideState.ts`), so only a held
 *  session refuses — not every "world not authored" reason. A Stop restore landing, or a failed one,
 *  leaves PlayerPrefs alone, and refusing there sent the agent to reload the scene for a write that
 *  was never at risk (#1551 re-review). */
function refusePrefsWriteInSession(): void {
  if (!hasTimelinePreviewSession()) return;
  const { options, hint, owner } = posedWorldExits();
  throw new OpRefusal('REFUSED_BY_OP',
    `player-prefs-write refused: a preview session is open${owner ? ` (owned by the ${owner} panel)` : ''} — `
    + 'ending it puts PlayerPrefs back to its state when the session opened, whoever wrote it, so this '
    + 'write would reply ok and then be undone. Nothing was changed.' + (hint ? ` ${hint}` : ''),
    { options });
}

export function registerEditorAgentOps(): void {
  // Every op registered here is the AGENT acting (human actions come through the UI,
  // not these ops). Shadow registerAgentOp so any editor-activity events an op emits
  // are tagged source:'agent' — so Claude can tell its own edits from the human's in
  // the editor-journal (Phase 7 review). Reads emit nothing, so wrapping them is inert.
  const registerAgentOp = (name: string, handler: AgentOpHandler): void =>
    _registerAgentOp(name, (params) => withEditorActor('agent', () => handler(params)));
  if (registered) return;
  registered = true;

  // Suppress scene hot-reload whenever the live world is not the authored one: Play/Pause (Stop
  // reverts to the Play-press snapshot) AND a scrub/preview envelope (Exit reverts to the envelope's
  // snapshot). A reload there rebuilds the world the snapshot belongs to — and inside an envelope it
  // tears the human's preview down mid-pose.
  // ⚠️ `canEdit()`, NOT `getPlayState()` (#1148): the 3-value shim reads a preview as 'stopped', so
  // this used to let the reload through inside every envelope — #1122's mechanism, one gate over.
  // #1409: a hot reload replaces the world from disk outside `loadScene`, so it owes the same
  // undo-history and clean-baseline rules — see `adoptWorldReloadedFromDisk`.
  setWorldReloadedFromDiskHook(adoptWorldReloadedFromDisk);
  setSceneReloadSuppressor(() => {
    // Stopped, but a snapshot restore, a scene open or a save cycle is still swapping the world
    // (#1164 review): a reload now supersedes that load — a scene open silently fails, or a Stop's
    // restore is cut short. Defer it; the token's release settles and replays it.
    if (canEdit()) {
      return isWorldReplacementInFlight()
        ? 'a scene load or restore is still landing — the reload replays once it has'
        : null;
    }
    const mode = getRunMode();
    return mode === 'playing'
      ? `game is ${getPlayState()} — stop the game (Stop) before editing the scene`
      : `the editor is in ${mode} mode (a preview envelope) — exit the preview before editing the scene`;
  });
  // …and what that gate held back replays once authoring SETTLES (#1164): stopped, with no snapshot
  // restore or scene open still loading. Not `onRunModeChange` — Stop flips the mode BEFORE its
  // restore loads, so a replay there races the restore and is lost again (`authoringSettle.ts`).
  onAuthoringSettled(() => { void replaySuppressedSceneReloads(); });
  // The editor's own prefab copy (the override diff base) is re-read with the runtime cache on an
  // external prefab write (#1169 review) — see `refreshPrefabSourceForPath`.
  setPrefabSourceRefresher(refreshPrefabSourceForPath);

  // ── State read ──
  registerAgentOp('editor-state', () => readEditorState());

  // Editor-renderer JS eval — the editor twin of device_eval (game-debug MCP). Runs `code`
  // as a function body (so `return x` yields a value) and safe-stringifies the result IN the
  // renderer, so nothing non-cloneable (a DOM node, a fiber, window) has to cross the M→R IPC
  // bridge — a JSON string always does. Unblocks reading/poking live renderer state (a global,
  // window.innerWidth, devicePixelRatio, dispatching a bridge event) without a raw CDP client.
  // Editor-only: this whole module is stripped from shipped game builds.
  // Registered UNWRAPPED (_registerAgentOp) on purpose. The shadow above holds ambient
  // actor='agent' for a handler's whole lifetime, and an eval body runs LONG — it can loop, await,
  // or call modoki.waitForEdit() and park. Holding the ambient actor across that would tag every
  // concurrent HUMAN edit as 'agent'. Attribution is instead applied PER CALL inside makeEvalApi(),
  // which is both accurate and bounded.
  //
  // `timeoutMs` bounds the WHOLE body (since #145 made `await` parse, the body is what runs), not
  // just a returned promise. The route sizes the relay deadline from the same number — see
  // `/api/eval` in editorBackendRouter.ts; the two must stay ordered or the relay wins the race
  // and reports a dead backend instead of this op's own message.
  //
  // ⚠️ "UNBOUNDED … park for two minutes", as this comment used to read, was never true and is
  // still not. An eval body has ALWAYS been raced against a deadline; what changed is that the
  // deadline is now reachable and adjustable. The ceiling is EDITOR_EVAL_MAX_TIMEOUT_MS (25s), so a
  // `modoki.waitForEdit({timeoutMs: 120_000})` nested in an eval CANNOT run its full park — budget
  // the inner op under the outer one, or call waitForEdit as its own tool.
  _registerAgentOp('eval', (params) => {
    const p = (params ?? {}) as { code?: string; timeoutMs?: unknown };
    return handleEval(p.code ?? '', makeEvalApi(), clampEvalTimeout(p.timeoutMs, EVAL_ASYNC_TIMEOUT_MS, EDITOR_EVAL_MAX_TIMEOUT_MS));
  });

  // Discovery for `eval`: lists the generated `modoki` scripting surface (op list + camelCase
  // method names + the fixed call/ops/api/composite helpers) so an agent never has to read
  // source to find what modoki_eval can call. A pure sync read — still goes through the local
  // registerAgentOp shadow above like every other op here, which is inert on a read.
  registerAgentOp('eval-api', () => ({
    ops: makeEvalApi().ops(),
    usage: [
      'modoki.call(op, params) — invoke any op by its raw kebab-case name',
      'modoki.<camelCaseName>(params) — generated shortcut for each op above',
      'modoki.ops() — same {op, method} listing as this discovery call, from inside eval code',
      'modoki.api(path, init) — fetch() a host route with no matching op (list_assets, write_asset, import_file, build, add_native_target, the OTA tools, mutate_scene\'s file-direct path, …), routed through backendFetch',
      'modoki.composite(label, fn) — collapse every mutation fn() makes into ONE undo entry',
      'modoki.import(path) — import a module AS THE APP HOLDS IT (repo-relative path, absolute path or module URL). A hand-written import(\'/@fs/…\') of an engine file, or any ?query variant, is a SECOND instance whose module-level state the app never sees',
    ],
    note: 'Call modoki_eval_api (or GET /api/eval-api) any time to see this listing again.',
  }));

  // Editor Percept (Phase 7 + V3): the human-activity stream (`!`-prefixed). `merged`
  // also returns the game journal AND a single-axis `timeline` that interleaves both by
  // the shared `cap` capture counter — so Claude reads one ordered story ("pressed Play
  // → set timeScale 0.3 → @match on tick 84 → paused").
  registerAgentOp('editor-journal', (params) => {
    const p = (params ?? {}) as { type?: string; source?: 'human' | 'agent'; since?: number; epoch?: string; sinceCap?: number; clear?: unknown; merged?: boolean; limit?: number };
    // `clear` is RETIRED (#1561): it made this read delete the buffer it read (§7). Refused, never
    // ignored — a caller that meant "start clean" would otherwise read a full buffer believing it empty.
    if (p.clear !== undefined) {
      throw new OpRefusal('UNKNOWN_PARAM',
        'editor-journal: clear was removed — a journal read no longer deletes anything. For a clean baseline, '
        + 'read once (limit:0 is enough) and pass the returned nextSeq as since (with its epoch): that read '
        + 'returns only the events after it. Nothing was read and nothing was cleared.',
        { options: ['since', 'epoch'] });
    }
    // An unknown `source` matched nothing, so the read came back EMPTY under a filtered framing —
    // "the agent did nothing" for a typo. Refused with the options instead (#1072); the route used to
    // drop the value before it got here, and forwards it raw now so this can fire.
    if (p.source !== undefined && !isEditorJournalSource(p.source)) {
      throw new OpRefusal('REFUSED_BY_OP',
        `editor-journal: unknown source ${JSON.stringify(p.source)} — nothing was read. Valid: ${EDITOR_JOURNAL_SOURCES.join(', ')}.`,
        { options: [...EDITOR_JOURNAL_SOURCES] });
    }
    refuseUnknownJournalType('editor-journal', p.type, 'nothing was read');
    // `editor` is the editor-only view: filtered by type/source and cursored by the
    // editor-local `since` (a `seq`). `timeline` is the single-axis merged view.
    //
    // Tail + histogram at the OP, not in `readEditorJournal` — the producer stays whole for
    // any in-process reader. The 2,000-event ring runs ~130–253 bytes/event (transform and
    // trait-edit events carry old→new values), so an unbounded read is ~54–126k tokens.
    // Cursor semantics (C7 re-audit): `since`/`sinceCap` are FORWARD cursors, so a CURSORED poll
    // returns the OLDEST events after the cursor (takeHead) + a nextSeq/nextCap to advance
    // contiguously — NOT the newest tail (takeTail), which permanently drops the oldest-after-
    // cursor block when >limit events accrue between polls (they have a lower seq/cap than the
    // returned window, so no forward cursor can ever reach them). The cursor-LESS "what just
    // happened" call keeps the newest tail.
    // #1214 B-3: a cursor from before a renderer reload is ahead of every event this life has, so it
    // would filter them all out. Reset it (and say so) rather than answer an empty stream.
    const cursor = resolveEditorJournalCursor(p.since, p.epoch);
    const since = cursor.since;
    const editorAll = readEditorJournal({ type: p.type, source: p.source, since });
    // #1214: `byType` used to be built over `editorAll` — the FILTERED list — so `type:'!transform'`
    // answered `{editorTotal:0, byType:{}}`, which reads as an empty ring. It now describes the WHOLE
    // ring (filter ignored) beside `ringTotal`, the same three-number contract `journal-events` and
    // `console-logs` answer (docs/mcp-tool-conventions.md §2); `editorTotal` stays the filtered count.
    const editorRing = p.type || p.source || since != null ? readEditorJournal() : editorAll;
    const edCursored = since != null;
    const ed = (edCursored ? takeHead : takeTail)(editorAll, p.limit, EDITOR_JOURNAL_TAIL_DEFAULT);
    const result: {
      editor: unknown[]; editorTotal: number; ringTotal: number; byType: Record<string, number>; epoch: string; cursorReset?: string;
      truncated?: boolean; hint?: string; nextSeq?: number;
      game?: unknown[]; gameTotal?: number; gameByType?: Record<string, number>;
      timeline?: unknown[]; timelineTotal?: number; nextCap?: number; droppedThroughCap?: number; timelineGapNote?: string; droppedThroughSeq?: number; gapNote?: string;
    } = {
      editor: ed.items, editorTotal: editorAll.length,
      ringTotal: editorRing.length, byType: histogram(editorRing, (e) => String(e.type ?? '?')),
      epoch: editorJournalEpoch(),
      ...(cursor.cursorReset ? { cursorReset: cursor.cursorReset } : {}),
    };
    // The editor ring keeps the newest 2,000: a `since` below what it has lost has a gap the returned
    // seqs cannot show — say so rather than promise "no gap" (#1561 re-review).
    const edDropped = editorJournalDroppedThrough();
    const seqGap = since != null && since < edDropped.seq;
    if (seqGap) {
      result.droppedThroughSeq = edDropped.seq;
      result.gapNote = `editor events after since=${since} up to seq ${edDropped.seq} were lost from the editor ring before this read (it keeps the newest 2,000, or it was cleared). Poll more often.`;
    }
    if (ed.truncated) {
      result.truncated = true;
      if (edCursored) {
        const lastSeq = (ed.items[ed.items.length - 1] as { seq?: number } | undefined)?.seq;
        // A cut-short read that returned nothing (limit:0) read nothing, so the cursor stays put.
        result.nextSeq = lastSeq ?? since;
        result.hint = `Showing the OLDEST ${ed.items.length} of ${editorAll.length} editor events after since=${since} (oldest first). Poll again with since=${result.nextSeq} to continue contiguously${seqGap ? ' from here (see gapNote: earlier editor events were already lost)' : ' with no gap'}; raise limit=N to fetch more per poll.`;
      } else {
        result.hint = tailHint('editor events', ed.items.length, editorAll.length, ', or narrow with type=/source=/since=');
      }
    }
    if (p.merged) {
      const game = journalEvents();
      // `merged` was the worst payload on this surface: BOTH full rings, twice over (the raw
      // `game` array AND the same events again inside `timeline`). A busy Play session is
      // ~582k tokens of `@contact`. Both are tailed; `sinceCap` remains the precise cursor.
      const g = tailWithCounts(game, (e) => String(e.type ?? '?'), { limit: p.limit, defaultLimit: JOURNAL_TAIL_DEFAULT });
      result.game = g.items; // raw game stream (tick-stamped), kept for back-compat
      result.gameTotal = g.total;
      result.gameByType = g.byType;
      // Single axis: BOTH streams windowed by the SAME `sinceCap` cursor (a `cap`),
      // then interleaved by the globally-unique shared cap counter — so incremental
      // polling (pass the last timeline cap as sinceCap) yields a coherent slice, not
      // (a few new editor events) + (the entire game journal). The editor `type`/
      // `source`/`since` filters shape only the `editor` array, NOT the timeline (which
      // is the full correlated story). cap is unique ⇒ no ties ⇒ a total order.
      // The `cap` counter restarts on a reload too (#1214 close-out review): a pre-reload `sinceCap`
      // sent with its epoch replays this life's timeline instead of filtering all of it out. It is
      // checked by the SAME resolver as `modoki_journal`'s cursor, against the capture part of the
      // epoch, so a baseline taken there is valid here (#1561 review: two epochs for one counter
      // reported a reload that never happened).
      const capCursor = resolveCapCursor(p.sinceCap, p.epoch);
      if (capCursor.cursorReset) {
        result.cursorReset = capCursor.cursorReset + (result.cursorReset ? ` ${result.cursorReset}` : '');
      }
      const capFloor = capCursor.sinceCap ?? -Infinity;
      // The timeline reads the same game ring as `modoki_journal` with the same cursor, so it owes the
      // same disclosure when that ring lost events after the cursor (#1561 re-review).
      // The timeline interleaves BOTH rings, so the gap is the later of what either has lost.
      const dropped = Math.max(journalDroppedThroughCap(), editorJournalDroppedThrough().cap);
      const capGap = capCursor.sinceCap != null && capCursor.sinceCap < dropped;
      if (capGap) { result.droppedThroughCap = dropped; result.timelineGapNote = journalGapNote(capCursor.sinceCap!, dropped); }
      const edAll = readEditorJournal(); // unfiltered — the timeline shows everything
      const timeline = [
        ...edAll.filter((e) => e.cap > capFloor).map((e) => ({ stream: 'editor' as const, ...e })),
        ...game.filter((e) => (e.cap ?? 0) > capFloor).map((e) => ({ stream: 'game' as const, ...e })),
      ].sort((a, b) => (a.cap ?? 0) - (b.cap ?? 0));
      // Window the interleaved axis: HEAD (oldest-after-cursor) when sinceCap is set so an
      // incremental poll is lossless + contiguous; the newest TAIL for a bare "what just
      // happened" call. Both via the shared helpers (a hand-rolled slice re-created the
      // `slice(-0)` whole-array bug on limit=0, and swallowed a NaN limit too).
      result.timelineTotal = timeline.length;
      const tlCursored = p.sinceCap != null;
      const tl = (tlCursored ? takeHead : takeTail)(timeline, p.limit, EDITOR_JOURNAL_TAIL_DEFAULT);
      result.timeline = tl.items;
      if (tl.truncated) {
        result.truncated = true;
        if (tlCursored) {
          const lastCap = (tl.items[tl.items.length - 1] as { cap?: number } | undefined)?.cap;
          // A cut-short read that returned nothing (limit:0) read nothing, so the cursor stays put.
          result.nextCap = lastCap ?? capCursor.sinceCap;
          result.hint = `Showing the OLDEST ${tl.items.length} of ${timeline.length} timeline events after sinceCap=${p.sinceCap} (oldest first). Poll again with sinceCap=${result.nextCap} to continue contiguously${capGap ? ' from here (see timelineGapNote: earlier events were already lost)' : ' with no gap'}; raise limit=N for more per poll.`;
        } else {
          result.hint = tailHint('timeline events', tl.items.length, timeline.length, ', or cursor with sinceCap=<last cap>');
        }
      }
      // Every merged reply says where the next timeline read starts (#1561), so a `limit:0` merged
      // read is a baseline for `sinceCap` just as it is on `modoki_journal`.
      if (result.nextCap == null) result.nextCap = currentCaptureSeq();
    }
    // Every reply says where the next read starts, so a bare `limit:0` read is a baseline (#1561).
    // A cursored read cut short set it above, to its last returned event; otherwise it is the tip.
    if (result.nextSeq == null) result.nextSeq = editorJournalSeq();
    return result;
  });

  // ── HTML5 drag-and-drop (Enact Phase 1) ── synthesize the dragstart→drop
  // sequence the trusted pointer-drag can't emit (Hierarchy reparent, Assets
  // file-move, Skin sprite-onto-part). Renderer-DOM, so dev + DMG both work.
  // ── Actor lease ── the trusted-input seam declaring itself, so injected input is
  // journaled as `agent` instead of masquerading as the human (measured: modoki_tap's
  // !select said source:"human"). Registered as a plain renderer op rather than through
  // the wrapper above, because it MANAGES attribution and must not be attributed itself.
  _registerAgentOp('actor-lease', (params) => {
    const p = (params ?? {}) as { open?: boolean; id?: number; ttlMs?: number };
    if (p.open) return { id: openActorLease('agent', p.ttlMs) };
    if (typeof p.id === 'number') closeActorLease(p.id);
    return { ok: true };
  });

  // ── wait-for (#1154) ── park until a CONDITION holds (a chrome control, an entity, a console
  // line, an editor field) instead of sleeping a guessed number of ms. The decisions live in
  // `debug/waitFor.ts`; this binds its readers to the resolvers the matching READ tools use.
  // Unwrapped for wait-for-edit's reason below: it parks, and the agent wrapper would attribute
  // every human edit made during the park to 'agent'. Listed in evalApi.ts's ATTRIBUTION_OPS too.
  //
  // #1559 C-12: the runtime registers `wait-for` itself with the `entity`/`console` readers, so a device
  // has it too (§9); the editor REPLACES that registration with the same readers plus the two only it
  // can answer, `chrome` and `editor`.
  const waitReaders: WaitReaders = {
    ...runtimeWaitReaders,
    chrome: ({ label, id }) => collectHandles({ editor: 'chrome', ...(label ? { label } : {}), ...(id ? { ids: [id] } : {}) })
      .map((h) => ({ id: h.id, label: h.label, meta: h.meta as Record<string, unknown> | undefined })),
    editorState: () => readEditorState() as unknown as Record<string, unknown>,
    chromeLabels: () => collectHandles({ editor: 'chrome' }).map((h) => h.label ?? '').filter(Boolean),
    chromeIds: () => collectHandles({ editor: 'chrome' }).map((h) => h.id),
  };
  _registerAgentOp('wait-for', (params) => runWaitFor(params, waitReaders));

  // ── wait-for-edit (#28) ── long-poll twin of editor-journal: park until the human does
  // something instead of the agent polling in a loop. Registered as a plain renderer op
  // (bypassing the `registerAgentOp` wrapper above) DELIBERATELY: that wrapper holds the
  // ambient actor='agent' for the whole lifetime of an async handler (see withEditorActor's
  // own doc — "the window spans the await"), and this handler can legitimately park for up
  // to WAIT_FOR_EDIT_MAX_MS. Wrapping it would mis-attribute any HUMAN edit committed
  // anywhere in the editor during that entire window as source:'agent' — silently defeating
  // the one thing this tool exists to report. Same reasoning as 'actor-lease' above: this op
  // manages/observes attribution, so it must not itself be attributed.
  _registerAgentOp('wait-for-edit', (params) => {
    const p = (params ?? {}) as { type?: string; source?: 'human' | 'agent'; since?: number; epoch?: string; timeoutMs?: number };
    // Refused BEFORE parking (#1072): an unknown source matches no event, so this would sit out the
    // whole timeout and answer `timedOut:true` — indistinguishable from "the human did nothing".
    if (p.source !== undefined && !isEditorJournalSource(p.source)) {
      throw new OpRefusal('REFUSED_BY_OP',
        `wait-for-edit: unknown source ${JSON.stringify(p.source)} — nothing was waited for. Valid: ${EDITOR_JOURNAL_SOURCES.join(', ')}.`,
        { options: [...EDITOR_JOURNAL_SOURCES] });
    }
    refuseUnknownJournalType('wait-for-edit', p.type, 'nothing was waited for');
    const requested = typeof p.timeoutMs === 'number' && Number.isFinite(p.timeoutMs) ? p.timeoutMs : WAIT_FOR_EDIT_DEFAULT_MS;
    const timeoutMs = Math.max(WAIT_FOR_EDIT_MIN_MS, Math.min(WAIT_FOR_EDIT_MAX_MS, requested));
    // #1214 B-3: a pre-reload cursor would park for the whole timeout while the human edits.
    const cursor = resolveEditorJournalCursor(p.since, p.epoch);
    return waitForEditorJournal({ type: p.type, source: p.source ?? 'human', since: cursor.since }, timeoutMs)
      .then((r) => {
        // EVERY reply is head-capped like a cursored editor-journal poll (contiguous: `nextSeq` is the
        // last one RETURNED). A reset replays this whole life — up to the 2,000-event ring — and so
        // does any far-behind cursor; capping only the reset moved the flood to the next call
        // (#1214 close-out review). The cursor fields go FIRST, so a transport text cap cannot cut
        // the fields that say where to resume.
        const head = takeHead(r.events, undefined, EDITOR_JOURNAL_TAIL_DEFAULT);
        const { events: _all, ...rest } = r;
        const nextSeq = head.items.length ? head.items[head.items.length - 1].seq : r.nextSeq;
        return {
          ...(cursor.cursorReset ? { cursorReset: cursor.cursorReset } : {}),
          ...rest,
          nextSeq,
          ...(head.truncated ? {
            truncated: true,
            totalCount: r.events.length,
            hint: `Showing the OLDEST ${head.items.length} of ${r.events.length} matching events. Call again with since=${nextSeq} (and epoch) right away — the rest are already there, so it returns at once.`,
          } : {}),
          events: head.items,
        };
      });
  });

  // The witness lets the op distinguish "the target ACCEPTED this payload type" from
  // "the handler actually did something" — measured: a texture dropped on a Hierarchy entity
  // row reported ok:true/accepted:true and made no edit at all.
  registerAgentOp('dom-dnd', (params) => performDomDnd((params ?? {}) as DomDndParams, {
    witness: () => ({ stack: getUndoVersion(), assets: getDirtyAssetsVersion(), world: getEditVersion() }),
  }));

  // ── Selection ──
  registerAgentOp('set-selection', (params) => {
    const p = (params ?? {}) as SetSelectionParams;
    if (p.asset !== undefined) {
      useEditorStore.setState({ selectedAsset: p.asset, selectedEntityId: null, selectedEntityIds: [] });
      return { ok: true, ...editorStateFields('selection') };
    }
    // Resolve every requested ref to a LIVE id through the shared resolver, keeping only ids that resolve.
    // Selecting a nonexistent/stale id used to "succeed" and echo it back as selected, so a
    // following gizmo / collider-edit / focus silently acted on nothing. Now a fully-unresolved
    // request fails, and a partial one reports what was skipped. No refs at all = clear. (C7 re-audit.)
    const requested: Array<{ id?: number; guid?: string }> = [
      ...(p.guids ?? []).map((guid) => ({ guid })),
      ...(p.guid != null ? [{ guid: p.guid }] : []),
      ...(p.entityIds ?? []).map((id) => ({ id })),
      ...(p.entityId != null ? [{ id: p.entityId }] : []),
    ];
    const resolved: number[] = [];
    const missing: Array<{ id?: number; guid?: string }> = [];
    const miss: { stale?: string } = {};
    for (const r of requested) {
      const id = resolveLiveIdOrSkip(r, 'set-selection', miss);
      if (id == null) missing.push(r);
      else if (!resolved.includes(id)) resolved.push(id);
    }
    if (requested.length && resolved.length === 0) {
      throw new OpRefusal('NOT_FOUND', 'set-selection: none of the requested entities resolve to a live entity (ids are reassigned on scene reload — prefer guid). Re-read them with get_scene_state.', { stale: miss.stale });
    }
    setSelectionRaw(resolved.length ? resolved[resolved.length - 1] : null, resolved);
    // An explicit request to select IS a request to see it: re-selecting the entity already
    // selected changes no value, so without this a row collapsed since stays hidden (#1156).
    if (resolved.length) useEditorStore.getState().requestEntityReveal();
    const state = { ok: true, ...editorStateFields('selection') };
    return missing.length
      ? { ...state, skipped: missing, warning: `${missing.length} requested entity ref(s) matched no live entity and were skipped` }
      : state;
  });

  // ── Gizmo ──
  registerAgentOp('set-gizmo', (params) => {
    const p = (params ?? {}) as { mode?: unknown; space?: unknown };
    // Both checked before either is applied, so a bad `space` does not leave a good `mode` half-set.
    // A typo used to be STORED and persisted to localStorage (a truthiness check, #1213 B-8).
    refuseUnknownValue('set-gizmo', 'mode', p.mode, GIZMO_MODES, 'nothing was changed');
    refuseUnknownValue('set-gizmo', 'space', p.space, GIZMO_SPACES, 'nothing was changed');
    if (p.mode === undefined && p.space === undefined) {
      // B-9: an empty call answered ok for a no-op — `set-game-view-device` refuses the same shape.
      throw new OpRefusal('REFUSED_BY_OP',
        `set-gizmo: nothing to set — pass mode (${GIZMO_MODES.join('/')}) and/or space (${GIZMO_SPACES.join('/')}). `
        + 'A call with neither would report success for a no-op. The current values are gizmoMode/gizmoSpace in modoki_get_editor_state.');
    }
    const store = useEditorStore.getState();
    if (p.mode !== undefined) store.setGizmoMode(p.mode);
    if (p.space !== undefined) store.setGizmoSpace(p.space);
    return { ok: true, ...editorStateFields('gizmoMode', 'gizmoSpace') };
  });

  // ── SceneView mode + collider-edit ── the toolbar's native <select> ('3d'|'ui')
  // and the Collider-edit toggle can't be driven by trusted input (native popup),
  // so expose them as ops. 'ui' mode mounts the 2D overlay where Collider2D vertex
  // editing (and its interaction-handle provider) lives.
  registerAgentOp('set-scene-view-mode', (params) => {
    const p = (params ?? {}) as { mode?: unknown };
    // A bad or missing mode used to be dropped and answered with a state read that looked like
    // success (#1213 B-7) — the precedent `set-animation-view-mode` below was written against.
    refuseUnknownValue('set-scene-view-mode', 'mode', p.mode ?? null, SCENE_VIEW_MODES, 'the view was not changed');
    useEditorStore.getState().setSceneViewMode(p.mode as typeof SCENE_VIEW_MODES[number]);
    return { ok: true, ...editorStateFields('sceneViewMode') };
  });

  // ── Animation editor: Dopesheet vs Curves (#369) ──
  // The SAME defect one panel over from `set-scene-view-mode`, and for the same reason: exactly one
  // of the two views is mounted, and they do NOT publish the same interaction handles. `curves:key:*`
  // and `curves:tan:in|out:*` (kind 'tangent') exist in CurvesView alone, so while the view lived in
  // AnimationEditor-local `useState` — defaulting to 'dopesheet' — tangent editing was reachable only
  // if the human happened to have left the panel in Curves. `modoki_handles editor=curves` then
  // returned nothing, which reads as "this clip has no tangents" rather than "wrong view".
  //
  // A SEPARATE op rather than a `view` param on `open-animation-editor`, which was the cheaper
  // option on the issue: `openAnimationEditor` nulls `editingAnimationClip` and resets the playhead
  // to 0, so re-opening to switch view would throw away the loaded document and the scrub position
  // an agent had just set. Switching views mid-inspection is a real intent, not a sub-step of
  // opening, so it gets its own call. Setting it BEFORE opening a clip is fine — the store holds it
  // and the panel mounts into it.
  registerAgentOp('set-animation-view-mode', (params) => {
    const p = (params ?? {}) as { mode?: unknown };
    if (p.mode !== 'dopesheet' && p.mode !== 'curves') {
      // Refused, not ignored: `set-scene-view-mode` above used to silently drop a bad mode and return
      // a state read that looked like success, which is §0's readiness lie (fixed in #1213). An agent that typo'd
      // 'curve' would be told nothing and then read an empty handle list as "no tangents".
      return {
        ok: false,
        error: `mode must be 'dopesheet' or 'curves' — got ${JSON.stringify(p.mode)}`,
        options: ['dopesheet', 'curves'],
        // The CURRENT view rides along: a refusal that omits it makes the caller spend a second
        // call to learn the state it did not change.
        animationViewMode: useEditorStore.getState().animationViewMode,
      };
    }
    useEditorStore.getState().setAnimationViewMode(p.mode);
    return { ok: true, ...editorStateFields('animationViewMode', 'animationView') };
  });

  // ── GameView device simulation (#367) ──
  // The device picker is a popup that trusted input cannot operate, and the orientation toggle is
  // a toolbar button in a panel an agent may not even have on screen — so before these ops the one
  // knob deciding WHAT SIZE the game is previewed at was human-only, and every layout check a
  // session ran measured whatever device the human last left selected. The per-device bug class
  // (#271/#272 safe-area insets, Court's panel-fit budget #358) is precisely the class that needs
  // the device changed, repeatedly, to be checked at all.
  //
  // Two ops, not one, and deliberately so: `game-view-devices` ANSWERS a question and
  // `set-game-view-device` DOES something. docs/mcp-tool-conventions.md §4 — a mutating op reached
  // by GET has its refusal read as a success, because `getJson` does not run `isFailureBody`.
  registerAgentOp('game-view-devices', () => {
    const s = useEditorStore.getState();
    return {
      ok: true,
      current: describeDeviceSelection(s.gameViewDevice, s.gameViewOrientation),
      // The catalog itself, resolved in PORTRAIT (how the table is authored) — landscape is a flip
      // applied at selection time, not a second set of entries, so listing both would double the
      // payload to say the same thing. `orientation` on the setter is what chooses.
      presets: DEVICE_PRESETS.map((p) => ({
        name: p.name,
        category: p.category,
        logical: resolveLogicalSize(p, 'portrait'),
        physical: resolvePhysicalSize(p, 'portrait'),
        dpr: presetDpr(p),
        safeArea: { portrait: resolveSafeArea(p, 'portrait'), landscape: resolveSafeArea(p, 'landscape') },
        // Where each quartet came from (#786) — this row relayed the numbers with no provenance at
        // all, so a reasoned tablet zero read exactly like a measured one.
        safeAreaBasis: p.safeArea.basis,
        free: p.logicalW <= 0,
      })),
      note: "Sizes are LOGICAL (CSS points) unless named physical; layout math runs in logical space. "
        + "Set one with modoki_set_game_view_device {device, orientation}, or give an explicit "
        + '{logicalWidth, logicalHeight} for a size the catalog does not carry.',
    };
  });

  registerAgentOp('set-game-view-device', (params) => {
    const p = (params ?? {}) as {
      device?: unknown; orientation?: unknown;
      logicalWidth?: unknown; logicalHeight?: unknown; dpr?: unknown;
    };
    const store = useEditorStore.getState();
    const names = DEVICE_PRESETS.map((d) => d.name);

    let orientation: Orientation | undefined;
    if (p.orientation !== undefined) {
      if (p.orientation !== 'portrait' && p.orientation !== 'landscape') {
        return {
          ok: false,
          error: `orientation must be 'portrait' or 'landscape' — got ${JSON.stringify(p.orientation)}`,
          options: ['portrait', 'landscape'],
        };
      }
      orientation = p.orientation;
    }

    const wantsCustom = p.logicalWidth !== undefined || p.logicalHeight !== undefined || p.dpr !== undefined;
    // Both addresses at once is AMBIGUOUS, not resolved by precedence: a caller who gave two
    // answers does not know which screen they got, and picking for them is §0's rank-1 class.
    if (wantsCustom && p.device !== undefined) {
      return {
        ok: false,
        code: 'AMBIGUOUS',
        error: 'give EITHER device (a catalog preset by name) OR logicalWidth+logicalHeight (an '
          + 'explicit size) — not both. Which screen you meant cannot be inferred from the pair.',
      };
    }

    let device: DevicePreset | undefined;
    if (wantsCustom) {
      const bad = validateCustomSize(p.logicalWidth, p.logicalHeight, p.dpr);
      if (bad) return { ok: false, error: `custom size refused: ${bad}` };
      device = makeCustomPreset(p.logicalWidth as number, p.logicalHeight as number, (p.dpr as number | undefined) ?? 1);
      // An explicit size is taken LITERALLY: default it to portrait so the numbers asked for are
      // the numbers previewed. Presets are authored portrait and flipped by the orientation, and
      // orientation is sticky — so without this, `{logicalWidth:640, logicalHeight:480}` sent while
      // the panel happened to be in landscape previews 480x640. The read-back would say so
      // honestly, but "I asked for 640 wide and got 480" is a trap worth not setting. Passing
      // `orientation` alongside a custom size still rotates it — that is an explicit request.
      orientation ??= 'portrait';
    } else if (p.device !== undefined) {
      if (typeof p.device !== 'string') {
        return { ok: false, error: `device must be a preset NAME (a string) — got ${typeof p.device}`, options: names };
      }
      // No fuzzy match, by rule (§5): previewing a DIFFERENT screen than the one named is worse
      // than failing, because every measurement taken after it is attributed to the wrong device.
      device = findPresetByName(p.device);
      if (!device) {
        return {
          ok: false,
          code: 'NOT_FOUND',
          error: `no device preset named ${JSON.stringify(p.device)}. Names are matched exactly `
            + '(case-insensitively) and NOT fuzzy-matched — a near miss would silently preview a '
            + 'different screen. Use "Free" to fill the panel, or pass logicalWidth+logicalHeight '
            + 'for a size the catalog does not carry.',
          options: names,
        };
      }
    }

    if (device === undefined && orientation === undefined) {
      return {
        ok: false,
        error: 'nothing to set: pass device (a preset name), or logicalWidth+logicalHeight for an '
          + 'explicit size, or orientation. A call with none of them would report success for a '
          + 'no-op. Read the current selection with modoki_get_editor_state (gameView) or '
          + 'modoki_game_view_devices.',
      };
    }

    store.setGameViewDevice(device, orientation);
    return {
      ok: true,
      ...describeGameView(),
      // §8: persistence is stated, never guessed. This is EDITOR-SESSION state — it is not scene
      // data, nothing is written to disk, and it resets to Free when the editor restarts.
      saved: false,
      note: 'Preview-only editor state — the project is unchanged and nothing was written to disk. '
        + 'A real device is unaffected (device_* drives hardware, which already IS its resolution).',
    };
  });
  // Set the KEYBOARD SCOPE — which panel the keymap dispatcher resolves chords against
  // (focus-scope refactor P7). Without this, an agent's only way to steer a keypress was
  // to tap something first and hope the click landed in the right panel; after scoping
  // landed, a bare `w` sent with the wrong panel focused simply does nothing, silently.
  //
  // Deliberately separate from `focus-element` (DOM focus): clicking a Hierarchy ROW moves
  // the keyboard scope but NOT document.activeElement, so the two are genuinely different
  // questions. Returns the resulting scope so the caller can confirm rather than assume.
  //
  // A named panel is REFUSED unless it currently has an open tab (#301). This op used to
  // store whatever string it was handed — `setFocusedPanel` is a bare setter, correctly, since
  // the human paths feed it a live tab component — and echo it straight back. That made the
  // caller-side guard in `/api/input/key` (`focusedPanel !== panel`) a tautology: it could only
  // fire if the renderer changed the value, which it never did. So `{panel:"Game"}` answered
  // ok:true with focusedPanel:"Game", while the input gate (which compares against 'game')
  // stayed SHUT and every following keypress reached nothing — each also reporting ok. That is
  // the QA-PHYS-0003 symptom reached by a second route: there the panel was forgotten, here a
  // wrong value is accepted. Miscasing is not contrived — this repo's prose calls them "the
  // Game panel" / "the Inspector" and nothing types the ids.
  //
  // Refusing on OPEN-NESS rather than on a vocabulary list is deliberate: it subsumes the
  // typo case, it is what the route's error message already promised, and games can register
  // custom panels — so any fixed list would be wrong by construction. `null` (clear the scope)
  // is always allowed; it names no panel.
  registerAgentOp('set-focus-scope', (params) => {
    const p = (params ?? {}) as { panel?: unknown };
    const openPanels = useEditorStore.getState().openPanels;
    // Reject a non-string BEFORE the open-ness test, or it falls straight through to the bare
    // setter. Reachable, not theoretical: `set-focus-scope` is on the `/api/editor-action`
    // allowlist, so `{action:'set-focus-scope', panel:12345}` used to answer ok:true and leave
    // `focusedPanel` holding the NUMBER 12345 — reported by get_editor_state as truth, and
    // permanently suppressing game input via the gate's `p !== null && p !== 'game'`, with no
    // panel to blame. Same defect class as the miscased id, one type further out.
    if (p.panel !== undefined && p.panel !== null && typeof p.panel !== 'string') {
      return {
        ok: false,
        error: `panel must be a string (an open panel's id) or null to clear — got ${typeof p.panel}`,
        focusedPanel: useEditorStore.getState().focusedPanel,
        openPanels,
      };
    }
    if (typeof p.panel === 'string' && !openPanels.includes(p.panel)) {
      // Do NOT move the scope on a refusal — a half-applied focus is worse than none, and
      // the caller would have no way to tell which it got.
      return {
        ok: false,
        error: `no open panel "${p.panel}" — panel ids are the FlexLayout tab ids and are case-sensitive`,
        focusedPanel: useEditorStore.getState().focusedPanel,
        openPanels,
      };
    }
    if (p.panel !== undefined) useEditorStore.getState().setFocusedPanel(p.panel);
    return { ok: true, focusedPanel: useEditorStore.getState().focusedPanel, openPanels };
  });
  // Would this key reach anything? Read-only twin of set-focus-scope, asked by
  // `/api/input/key` BEFORE it presses — see editor/input/keyReach.ts for why both gates
  // have to be answered together. Never mutates: a probe that moved the scope it is
  // reporting on would be the measurement changing the thing measured.
  registerAgentOp('probe-key-reach', (params) => {
    const p = (params ?? {}) as { key?: string; modifiers?: string[] };
    if (typeof p.key !== 'string' || !p.key) return { ok: false, error: 'key is required' };
    return { ok: true, ...probeKeyReach(p.key, p.modifiers) };
  });
  registerAgentOp('set-collider-edit', (params) => {
    const p = (params ?? {}) as { on?: unknown };
    if (typeof p.on !== 'boolean') {
      // A missing or non-boolean `on` used to be dropped, answered with a plain state read (#1213).
      throw new OpRefusal('REFUSED_BY_OP', `set-collider-edit: on must be true or false — got ${JSON.stringify(p.on)}. Nothing was changed.`,
        { options: ['true', 'false'] });
    }
    if (p.on) {
      // B-2: SceneView's toolbar button turns the mode straight back off when the selection is not
      // editable, so setting it here answered `colliderEditMode:true` for a mode that lasted one render.
      const blocker = colliderEditBlocker(useEditorStore.getState().selectedEntityId);
      if (blocker) {
        throw new OpRefusal('REFUSED_BY_OP',
          `set-collider-edit: cannot enter collider-edit mode — ${blocker}. Only a Collider2D with a point list (polygon, concave, polyline) is vertex-editable.`,
          { options: ['modoki_set_selection an entity whose Collider2D shape is polygon/concave/polyline, then retry'] });
      }
    }
    useEditorStore.getState().setColliderEditMode(p.on);
    return { ok: true, ...editorStateFields('colliderEditMode') };
  });
  // Open the Particle Editor dock panel on a .particle.json (normally a double-click in
  // Assets). Mounts CurveEditor/GradientEditor, whose interaction-handle providers then
  // register — so the agent can reach the size/opacity curve points + gradient stops.
  // No `displayName` here, unlike its four siblings (#1266): `editingParticleAsset.name` is read
  // only as the unreachable `|| asset.name` arm of two `fileName=` fallbacks in ParticleEditor, so
  // a caller-supplied one had no observable effect. The stem is still computed, because
  // `SelectedAsset` requires a name.
  registerAgentOp('open-particle-editor', async (params) => {
    const p = (params ?? {}) as { path?: string };
    requireAssetPath(p.path, 'particle', 'open-particle-editor');
    const name = p.path!.split('/').pop()?.replace(/\.particle\.json$/, '') ?? p.path!;
    useEditorStore.getState().openParticleEditor({ path: p.path!, type: 'particle', name });
    const path = p.path!;
    await awaitEditorMount('particle', path, 'open-particle-editor',
      'The store now names this asset, but the Particle editor tab did not mount to show it.');
    return { ok: true, ...editorStateFields('openEditors') };
  });
  // Open the Sprite slicer / 9-slice modal on a texture (normally the Texture-Inspector
  // buttons). Selects the texture + requests the modal → its handle providers mount.
  /** The texture modals open when the texture's Inspector view consumes `textureEditorRequest`. When
   *  nothing consumes it, the request is WITHDRAWN on refusal — left pending, it would pop the modal
   *  open whenever the human next selected that texture, long after this call reported failure. */
  const awaitTextureModal = async (kind: 'sprite' | 'nineslice', path: string, op: string): Promise<void> => {
    try {
      await awaitEditorMount(kind, path, op,
        'The modal opens from the texture\'s Inspector view, which must be showing to consume the request.');
    } catch (e) {
      const st = useEditorStore.getState();
      // Only a request still PENDING is withdrawn — and only then does the refusal say so. One the
      // Inspector already consumed is not "withdrawn": the modal may be up on a slow load.
      if (!(e instanceof OpRefusal) || st.textureEditorRequest?.path !== path || st.textureEditorRequest.kind !== kind) throw e;
      st.clearTextureEditorRequest();
      throw new OpRefusal(e.code, `${e.message} The pending request was withdrawn, so the modal will not pop up later.`, { options: e.options });
    }
  };
  registerAgentOp('open-sprite-editor', async (params) => {
    const p = (params ?? {}) as { path?: string; displayName?: string };
    requireAssetPath(p.path, 'texture', 'open-sprite-editor');
    // The modal's own mount effect resets `spriteEditorSelection` to null, but a call on a path
    // that is ALREADY open re-triggers no mount (TextureAssetView's `setSpriteEditorOpen(true)`
    // is a no-op on an already-true boolean) — so without this, joining a session the human
    // already had open would report whatever THEY had selected as if this call selected it.
    useEditorStore.getState().setSpriteEditorSelection(null);
    useEditorStore.getState().requestTextureEditor(p.path!, 'sprite', p.displayName);
    const path = p.path!;
    await awaitTextureModal('sprite', path, 'open-sprite-editor');
    return { ok: true, ...editorStateFields('openEditors', 'spriteEditorSelection') };
  });
  registerAgentOp('open-nine-slice-editor', async (params) => {
    const p = (params ?? {}) as { path?: string; displayName?: string };
    requireAssetPath(p.path, 'texture', 'open-nine-slice-editor');
    useEditorStore.getState().requestTextureEditor(p.path!, 'nineslice', p.displayName);
    const path = p.path!;
    await awaitTextureModal('nineslice', path, 'open-nine-slice-editor');
    return { ok: true, ...editorStateFields('openEditors') };
  });
  // Select a slice in the currently-open Sprite Editor, so its 8 resize handles + pivot
  // register (`spriteEditorSelection` — #373: the modal opens with nothing selected, and
  // there was no route to change that). `guid: null` (or omitted) deselects.
  registerAgentOp('select-sprite-slice', (params) => {
    const p = (params ?? {}) as { guid?: unknown };
    // Deselecting needs no open editor — there is nothing it could select wrongly.
    if (p.guid === undefined || p.guid === null) {
      useEditorStore.getState().setSpriteEditorSelection(null);
      return { ok: true, ...editorStateFields('spriteEditorSelection') };
    }
    // #1213 B-1: any string used to be stored as the selection, with or without a Sprite Editor on
    // screen — then `modoki_handles editor=sprite` came back empty, which reads as "no slices".
    const mount = requireEditorOpen('sprite', 'select-sprite-slice');
    const slices = mount.slices ?? [];
    if (typeof p.guid !== 'string' || !slices.includes(p.guid)) {
      throw new OpRefusal('REFUSED_BY_OP',
        `select-sprite-slice: ${JSON.stringify(p.guid)} is not a slice of ${mount.path}, which holds `
        + `${slices.length ? `${slices.length} slice${slices.length === 1 ? '' : 's'}` : 'no slices'} — nothing was selected.`,
        { options: [...slices] });
    }
    useEditorStore.getState().setSpriteEditorSelection(p.guid);
    return { ok: true, ...editorStateFields('spriteEditorSelection') };
  });
  // Open the Skin (2D rig) editor on a .rig2d.json — normally reached from the Assets panel
  // double-click or the Texture Inspector's "Auto Rig". Neither `editingSkinAsset` (which
  // asset is open) nor `skinMode` (rig/parts/weights — `bone-joint` handles are gone in
  // 'parts') had an agent route at all (#373); this is the missing "open the panel" half —
  // once open, the mode buttons carry `data-ui-id="skin.mode.*"` and are chrome-tappable.
  registerAgentOp('open-skin-editor', async (params) => {
    const p = (params ?? {}) as { path?: string; displayName?: string };
    requireAssetPath(p.path, 'rig2d', 'open-skin-editor');
    const name = p.displayName ?? p.path!.split('/').pop()?.replace(/\.rig2d\.json$/i, '') ?? p.path!;
    useEditorStore.getState().openSkinEditor({ path: p.path!, type: 'rig2d', name });
    const path = p.path!;
    await awaitEditorMount('skin', path, 'open-skin-editor',
      'The store now names this rig, but the Skin editor tab did not mount to show it.');
    return { ok: true, ...editorStateFields('openEditors', 'editingSkinAsset', 'skinMode') };
  });
  registerAgentOp('set-skin-mode', (params) => {
    const p = (params ?? {}) as { mode?: unknown };
    if (p.mode !== 'parts' && p.mode !== 'rig' && p.mode !== 'weights') {
      // Refused, not ignored (the set-animation-view-mode precedent, NOT set-scene-view-mode's
      // silent drop): a typo'd mode here would otherwise read as ok:true with nothing changed,
      // and the caller would go on to read an empty/wrong bone-joint handle list as "no rig",
      // not "the mode never switched". Current mode rides along so a refusal costs no 2nd call.
      return {
        ok: false,
        error: `mode must be 'parts', 'rig', or 'weights' — got ${JSON.stringify(p.mode)}`,
        options: ['parts', 'rig', 'weights'],
        skinMode: useEditorStore.getState().skinMode,
      };
    }
    // #1213 B-10: the mode is a setting OF the open Skin editor — with none showing, the call
    // answered ok and the caller read the empty `bone-joint` handle list as "no rig".
    requireEditorOpen('skin', 'set-skin-mode');
    useEditorStore.getState().setSkinMode(p.mode);
    return { ok: true, ...editorStateFields('skinMode') };
  });

  // Open a .anim.json in the Animation editor and BIND it to an entity, exactly as a
  // double-click in the Assets panel does (`openAssetInEditor`'s `animation` branch).
  //
  // WHY THIS EXISTS (#288 Phase 4): without it `modoki_pose_clip` and `modoki_set_playhead` are
  // tools that can never be driven. Both need `editingAnimationClip` set, and nothing on the agent
  // surface could set it — `set-selection {asset}` selects the asset in the Assets panel and does
  // NOT open its editor (measured). So the clip-authoring loop was reachable only if the human
  // happened to have opened the clip by hand. This is the one call the panel path already uses,
  // including its bind-root resolution, rather than a second way of opening a clip.
  registerAgentOp('open-animation-editor', async (params) => {
    const p = (params ?? {}) as { path?: string; displayName?: string };
    requireAssetPath(p.path, 'animation', 'open-animation-editor');
    const name = p.displayName ?? p.path!.split('/').pop()?.replace(/\.anim\.json$/, '') ?? p.path!;
    // Captured BEFORE the switch (#1212 A-13): the store is re-pointed immediately, so a refusal
    // below reports an editor that has ALREADY left whatever clip was open, and must say so.
    const previousPath = useEditorStore.getState().editingAnimationAsset?.path ?? null;
    const prevField = previousPath && previousPath !== p.path ? { previousPath } : {};
    // Described from what is open AT REPLY TIME, never from what this call did: a human or a
    // concurrent call can re-point the single-slot editor during the wait, and a note written
    // before it ("switched to X, Y is gone") is then false in both halves. And a re-open of the
    // SAME clip is not "nothing happened" — the store reset the playhead, any pose and the preview.
    const describeNow = (openNow: string | null | undefined): string =>
      openNow === p.path
        ? (previousPath == null
          ? `the Animation editor is now on ${p.path} (nothing was open before)`
          : previousPath !== p.path
            ? `the switch is NOT undone: the Animation editor is on ${p.path}, and ${previousPath} is no longer open`
            : `${p.path} was re-opened, which reset the playhead, any pose and the preview`)
        : `the Animation editor is now on ${openNow ?? 'no clip'}${openNow && openNow === previousPath
          ? ' (the clip that was open before this call)'
          : ' (something else re-pointed it during the wait)'}`;
    useEditorStore.getState().openAnimationEditor({ path: p.path!, type: 'animation', name }, resolveAnimatorRootForClip(p.path!));

    // ⚠️ `openAnimationEditor` sets the open ASSET; it does not load the clip DOCUMENT. That is
    // done by the Animation panel's own effect, which reconciles a parked unsaved write against a
    // `fetch` of the file — a path carrying two separately-fixed bugs in its comments, so this op
    // WAITS for it rather than growing a second copy of it.
    //
    // Waiting is also the only way to be honest. Returning as soon as the store's asset field is
    // set reported `openedClip` + `bound:true` while `editingAnimationClip` was still null, so a
    // `pose-clip` issued immediately after — the documented next step — failed with "no animation
    // clip is open". Measured, and it is the readiness lie §0 ranks worst: everything said ready.
    const deadline = Date.now() + 3000;
    while (useEditorStore.getState().editingAnimationClip == null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const st = useEditorStore.getState();
    const clip = st.editingAnimationClip as { name?: string } | null;
    // ⚠️ The poll reads a GLOBAL, so a clip appearing is not proof it is OURS. Both the store
    // fields and the panel's load effect are single-slot: if a human double-clicks a different
    // clip (or a second call lands) while this one is polling, the other open wins and BOTH
    // callers see a non-null clip at the same instant. Without this check the call for A returns
    // ok:true describing B, and a `pose-clip` issued next poses the wrong rig believing it
    // addressed A. Compare the ASSET path, which is what the caller actually named.
    const openPath = st.editingAnimationAsset?.path;
    if (clip && openPath !== p.path) {
      return {
        ok: false, code: 'REFUSED_BY_OP', path: p.path, openPath, ...prevField, editorNow: describeNow(openPath),
        error: `another clip (${openPath}) was opened while this call was waiting for ${p.path}, so the editor is not showing what was asked for.`,
        options: [
          `retry modoki_open_animation_editor {path:"${p.path}"} — the editor holds ONE open clip, and something else (the human, or a concurrent call) re-pointed it mid-call`,
          'modoki_get_editor_state shows which clip is open now',
        ],
      };
    }
    if (!clip) {
      // The realistic cause, named precisely: an Animation panel that has never been opened this
      // session is not mounted, so it never runs the load effect. ⚠️ Mounting LATCHES — a panel
      // opened earlier and since switched away from IS still mounted — see
      // docs/editor.md § Tab mounting latches.
      return {
        ok: false, code: 'NOT_AVAILABLE_HERE', path: p.path, ...prevField,
        error: `the Animation editor was pointed at ${p.path} but no clip document loaded within 3s — `
          + `${describeNow(st.editingAnimationAsset?.path)}. `
          + 'The clip DOCUMENT is fetched by the Animation panel, and a tab never OPENED this session is not mounted.',
        options: [
          'modoki_get_editor_state.openPanels — if the Animation tab is absent, it has never been opened; a human opens AND selects it once, then retry',
          `retry modoki_open_animation_editor {path:"${p.path}"} once the panel is mounted — the pose itself needs no panel, only this load step does`,
        ],
      };
    }
    // Report the BIND separately from the open. They fail independently — a clip can load
    // perfectly and bind to nothing (no entity in the scene carries a matching Animator), and a
    // caller told only "opened" would then get a NOT_FOUND from pose_clip with no idea why.
    return {
      ok: true,
      ...editorStateFields('openEditors', 'animationViewMode', 'animationView'),
      openedClip: clip.name ?? name,
      animatorRootEntityId: st.animatorRootEntityId,
      animatorRootGuid: st.animatorRootEntityId != null ? liveGuidOf(st.animatorRootEntityId) : null,
      bound: st.animatorRootEntityId != null,
      ...(st.animatorRootEntityId == null
        ? { hint: 'The clip is open but bound to NO entity, so modoki_pose_clip has nothing to pose. Binding resolves by matching the clip against entities carrying an Animator trait — check one exists in the OPEN scene and lists this clip.' }
        : {}),
    };
  });

  registerAgentOp('focus-entity', (params) => {
    // Accept guid (stable) or id; validate it resolves before claiming success. Report whether a
    // SceneView was actually mounted to frame it — the op used to return {ok:true} for a
    // nonexistent id AND when no viewport was open, so the camera didn't move either way. (C7 re-audit.)
    const p = (params ?? {}) as { id?: number; guid?: string };
    const id = requireLiveId(p, 'focus-entity');
    const framed = focusEntityInSceneView(id);
    if (!framed) return { ok: false, framed: false, reason: 'no SceneView viewport is mounted, so there is nothing to frame the entity in (open/focus the 3D SceneView first).' };
    return { ok: true, framed: true };
  });

  // ── Play control ── matches the GameView transport bar.
  // Physics readiness (#1175): `play`, `resume` and `step` never let a tick run before the Rapier
  // WASM the world's bodies need has instantiated. From STOPPED, `play` gets that from enterPlay
  // itself, which awaits it INSIDE its `_entering` window — an op-level await in front of enterPlay
  // would sit OUTSIDE that window, where a Stop hits stopPlay's plain stopped branch and is dropped
  // instead of queued (#470). So from stopped a PERMANENT init failure cannot be refused up front;
  // Play starts (as a human's would) and the op REPORTS it as `physicsError`. Everywhere else —
  // `play` from paused (enterPlay's paused branch awaits nothing), `resume`, `step` — the op awaits
  // first, refuses on a permanent failure, then re-reads the state, because a Stop landing during the
  // WASM fetch changed what the op would mean.
  const physicsFailure = async (): Promise<string | null> => {
    if (pendingPhysics(getCurrentWorld()).length === 0) return null;
    const r = await ensurePhysicsReady(getCurrentWorld());
    return r.ok ? null : r.error;
  };
  const physicsRefused = (op: string, error: string) => ({
    ok: false,
    error: `${op} refused — physics failed to initialize, so the world would advance with NO physics: ${error}`,
    playState: getPlayState(),
  });
  // `enterPlay` DECLINES without throwing, so the reply is built from what it says it did — never from
  // the state re-read afterwards, which reads 'stopped' for a refused Play and a Play nobody asked for
  // alike (#1574). A refusal is coded (§5) and carries the same message the toolbar's console warn does.
  const playOutcomeRefusal = (o: PlayOutcome) =>
    o.kind === 'refused' || o.kind === 'stopped-during-startup'
      ? { ok: false, code: 'REFUSED_BY_OP', error: o.message, ...(o.kind === 'refused' ? { reason: o.reason } : { reason: o.kind, reverted: o.reverted }), ...playStateFields() }
      : null;
  registerAgentOp('play', async () => {
    let physicsError: string | null = null;
    if (getPlayState() === 'paused') {
      // enterPlay's PAUSED branch just flips to playing — it awaits nothing — so from paused the op
      // waits here, like `resume`. There is no `_entering` latch on this path to drop a Stop past,
      // but a Stop landing during the wait still changed what Play would mean: from stopped this op
      // would run a full snapshot + Play the caller never asked for AFTER stopping, so refuse.
      const pausedError = await physicsFailure();
      if (pausedError) return physicsRefused('play', pausedError);
      if (getPlayState() !== 'paused') return { ok: false, error: 'play from PAUSED — the play state changed while physics was loading', playState: getPlayState() };
      const refused = playOutcomeRefusal(await enterPlay());
      if (refused) return refused;
    } else {
      const refused = playOutcomeRefusal(await enterPlay());
      if (refused) return refused;
      // From stopped, enterPlay awaited readiness inside `_entering`, so anything still pending here
      // is a permanent failure (the loader memoises the rejection) — this await settles immediately.
      physicsError = getPlayState() === 'playing' ? await physicsFailure() : null;
    }
    return physicsError
      ? { ok: true, ...playStateFields(), physicsError: `Play started, but physics failed to initialize — bodies will not simulate: ${physicsError}` }
      : { ok: true, ...playStateFields() };
  });
  // `resume` and `pause` are TRANSITIONS, and both used to accept any state and report the editor
  // state back as a success. From STOPPED, `resume` ran a full `enterPlay()` — a snapshot + run,
  // i.e. the thing `play` does — so an agent that meant "carry on from where we paused" silently
  // restarted the game from the authored snapshot and lost the state it was inspecting. `pause`
  // from stopped was a plain no-op reported as done. `step` has guarded its precondition since it
  // was written; these two now match it (§8: a no-op the caller asked for as a change is a failure).
  registerAgentOp('resume', async () => {
    const st = getPlayState();
    if (st !== 'paused') {
      return {
        ok: false,
        error: `resume requires the PAUSED state (currently: ${st}). From '${st}' this would run a full Play — a fresh snapshot + run — which discards whatever you were inspecting, so it is refused rather than done silently.`,
        playState: st,
        hint: st === 'stopped' ? "Use action:'play' to start the game." : "Already running — action:'pause' first if you meant to freeze it.",
      };
    }
    const resumeError = await physicsFailure();
    if (resumeError) return physicsRefused('resume', resumeError);
    // Re-read after the await: from anything but paused, enterPlay would run a full Play — the very
    // outcome this op exists to refuse.
    if (getPlayState() !== 'paused') return { ok: false, error: 'resume requires the PAUSED state — the play state changed while physics was loading', playState: getPlayState() };
    const refused = playOutcomeRefusal(await enterPlay());
    if (refused) return refused;
    return { ok: true, ...playStateFields() };
  });
  // Stop's reply says whether the revert happened (#1574): `reverted:false` + `reason` when Stop
  // deliberately skipped it, `queued` while a Play is still starting. A restore that THROWS is a coded
  // refusal rather than an escaped throw, which the relay turns into NOT_AVAILABLE_HERE ("relaunch") —
  // the mode already reads 'stopped' then, and the live world may still be the Play world.
  registerAgentOp('stop', async () => {
    let o: StopOutcome;
    try {
      o = await stopPlay();
    } catch (e) {
      return {
        ok: false,
        code: 'REFUSED_BY_OP',
        error: `Stopped, but restoring the authored world FAILED (${e instanceof Error ? e.message : String(e)}) — the live world may still be the Play or posed world. Reload the scene before saving or pressing Play.`,
        ...playStateFields(),
      };
    }
    if (o.kind === 'queued') return { ok: true, queued: true, ...playStateFields(), note: 'A Play startup is still in flight — this Stop is queued behind it, and that startup performs the revert (read the play reply, or playState, for how it ended).' };
    if (o.kind === 'stopped' || o.kind === 'preview-exited') {
      return { ok: true, ...playStateFields(), ...('reverted' in o ? { reverted: o.reverted } : {}), ...('reason' in o && o.reason ? { reason: o.reason } : {}) };
    }
    return { ok: true, ...playStateFields() };
  });
  registerAgentOp('pause', () => {
    const st = getPlayState();
    if (st !== 'playing') {
      return {
        ok: false,
        error: `pause requires the PLAYING state (currently: ${st}) — nothing to freeze, so this would be a no-op reported as success.`,
        playState: st,
        hint: st === 'stopped' ? "Use action:'play' first." : 'Already paused.',
      };
    }
    pausePlay();
    return { ok: true, ...playStateFields() };
  });
  // Step one frame while Paused: flip to 'playing' around a single synchronous
  // frame, then freeze again (exactly GameView's stepOnce).
  registerAgentOp('step', async () => {
    if (getPlayState() !== 'paused') return { ok: false, error: 'step requires paused state', playState: getPlayState() };
    const stepError = await physicsFailure();
    if (stepError) return physicsRefused('step', stepError);
    // Re-read after the await: a Stop (or Resume) landing during the WASM fetch changed what a
    // step would mean, and flipping to 'playing' below would clobber it.
    if (getPlayState() !== 'paused') return { ok: false, error: 'step requires paused state — the play state changed while physics was loading', playState: getPlayState() };
    setPlayState('playing');
    stepOneFrame();
    setPlayState('paused');
    return { ok: true, ...playStateFields() };
  });

  // ── Undo / redo ── (async — undo/redo may run async undo closures).
  // `did:false` means the stack was empty. It is REPORTED, not thrown: "nothing to undo" is a
  // legitimate answer, and the state below shows what actually happened. (C7 note: an undo
  // whose target entity was destroyed by a scene hot-reload still pops the entry — see the C7
  // save-state audit in docs/connect-claude-code.md; verify with get_scene_state, not `did`.)
  //
  // ⚠️ REFUSED where `undoRefusedReason` refuses (#1148): Play/Pause, and a SCENE edit inside a
  // scrub/preview envelope. These ops had no run-state gate at all before — not even Play. The
  // refusal is read from `undoStep` itself rather than pre-checked, because a step is decided when
  // it runs: a pre-check races a queued step (a clip undo ahead of it re-poses and opens an
  // envelope) and would report that refusal as `did:false`, i.e. "the stack was empty".
  const undoOrRefuse = async (op: 'undo' | 'redo') => {
    const { did, refused } = await undoStep(op);
    if (refused !== null) throw new OpRefusal('REFUSED_BY_OP', `${op}: ${refused} Nothing was undone or redone, and the stack is untouched.`);
    return { did, ...editorStateFields('undo', 'unsavedChanges') };
  };
  registerAgentOp('undo', () => undoOrRefuse('undo'));
  registerAgentOp('redo', () => undoOrRefuse('redo'));

  // ── Scene management ──
  // load-scene / new-scene SWAP THE WORLD, so anything created live and not saved is gone —
  // from the world, the file, AND the undo stack (swapHistory rebinds). They used to report
  // {ok:true, entityCount:12} (now `worldEntityTotal`), which looks perfectly healthy while the entity you just made
  // no longer exists anywhere. Refuse by default; `discardUnsaved` discards deliberately. (C7)
  //
  // RENAMED from `force` (2026-08-22, owner). §2: one name, one meaning. `force` still means
  // "proceed even though there is unsaved work" on build / add_native_target / ota_publish, where
  // NOTHING is destroyed and the work is merely left out of the artifact. Here it DESTROYED that
  // work — and the tool's own name (`load_scene`, `new_scene`) does not tell you which flavour you
  // are getting, so an agent that learned the harmless one from a build could lose the human's
  // work with it. The new name states the consequence instead of inviting the habit.
  //
  // The OLD name is still honoured on the wire: these ops are reachable by modoki_eval and the
  // curl API, where there is no strict schema to turn a stale spelling into a refusal. At the TOOL
  // boundary it IS refused by name (§1), which is where a caller actually learns.
  /** One agent-facing sentence per cause, or `null` when that cause is clean.
   *
   *  ⚠️ **`satisfies Record<keyof UnsavedCauses, …>` is the load-bearing part (#972 P2).** These
   *  used to be five hand-written `if` pushes over a five-name destructure, so a sixth cause left
   *  the refusal with an EMPTY list — `"load-scene: the editor has UNSAVED work — ."` — which is
   *  S3.11's exact failure (a refusal naming the wrong cause, or none) one population later. Now a
   *  sixth cause cannot compile until it has a sentence.
   *
   *  ⚠️ These are NOT `CAUSE_SPECS[k].label`, and the difference is deliberate. Those labels are
   *  short human phrases for a BANNER read under a 5s countdown; these are for an AGENT deciding
   *  what `discardUnsaved:true` would destroy, so they name the ops that produce the work and list
   *  the actual paths. Same population, different audience — the table carries the population, each
   *  consumer carries its own phrasing, and `satisfies` is what keeps the two in step. */
  const CAUSE_REFUSALS = {
    sceneDirty: (v) => (v
      ? 'LIVE-WORLD scene edits (e.g. from create_entity / duplicate_entity / prefab / mutate_scene, which do NOT save)'
      : null),
    dirtyAssetPaths: (v) => (v.length
      ? `${v.length} pending ASSET edit(s) awaiting a save: ${v.join(', ')}` : null),
    // A loaded BASE scene still dirty. Without it a refusal driven by this alone would name no
    // cause. #1420: this once DIAGNOSED a failed save_all, the only way to leave a base dirty before
    // #1417; since a load keeps a shared base's flag, the usual cause is an ordinary base edit, and
    // a reader sent after a failure that never happened wastes the turn. Mirrored in the MCP's
    // `CAUSE_PHRASES` (engine/tools/modoki-mcp/src/context.ts), which cannot import this.
    dirtyScenes: (v) => (v.length
      ? `${v.length} loaded base scene(s) with edits not yet saved (guid(s): ${v.join(', ')}) — usually an edit made to that base; a save_all that failed to write it leaves the same state`
      : null),
    // #831: a `baseScene` ref set in the Scene inspector on a scene the editor has not loaded.
    // Neither a live-world edit nor an asset document, so before this row a refusal driven by it
    // alone named no cause at all.
    pendingBaseScenes: (v) => (v.length
      ? `${v.length} pending base-scene ref(s) awaiting a save: ${v.join(', ')}` : null),
    // #845: an Inspector import-settings edit (a `.meta.json` field) parked instead of written
    // immediately. Same reasoning as the row above.
    pendingImportSettings: (v) => (v.length
      ? `${v.length} pending import-setting edit(s) awaiting a save: ${v.join(', ')}` : null),
  } as const satisfies { [K in keyof UnsavedCauses]: (v: UnsavedCauses[K]) => string | null };

  const guardUnsaved = (op: string, discardUnsaved: boolean | undefined) => {
    if (discardUnsaved || !hasUnsavedChanges()) return;
    // S3.11 — name the ACTUAL cause. The refusal used to build one fixed string blaming
    // create_entity/duplicate_entity/prefab, so an agent whose pending work was a dirty
    // particle/anim/timeline doc was sent looking for live entities it had never created. Every
    // cause clears with save_all; the difference is what `discardUnsaved:true` would discard.
    const c = unsavedChangeCauses();
    const causes = (Object.keys(CAUSE_REFUSALS) as (keyof UnsavedCauses)[])
      .map((k) => (CAUSE_REFUSALS[k] as (v: UnsavedCauses[typeof k]) => string | null)(c[k]))
      .filter((m): m is string => m !== null);
    // ⚠️ The CONSEQUENCE clause is a cause-shaped claim too, and it was the last hand-branch here
    // (found by close-out's own sweep of #972's pattern). It read
    // `sceneDirty ? … : 'the pending asset writes would be lost'`, so a refusal driven ONLY by a
    // pending base-scene ref or a parked import-settings edit told the caller its ASSET writes were
    // at risk — naming the wrong KIND of work, which is S3.11 again in the one sentence the fix
    // above did not touch. The non-scene branch now points at the list rather than guessing a kind.
    // ⚠️ **`discardUnsaved:true` does NOT drop parked work, and saying it does is a false
    // instruction — the worst outcome on this surface (§0).** `guardUnsaved` is a pure gate
    // (`if (discardUnsaved || !hasUnsavedChanges()) return;`) and nothing downstream discards:
    // `clearDirtyAssets`/`clearPendingMeta`/`clearPendingBaseScenes` have ZERO production callers,
    // so the parked registries are path-keyed module state that SURVIVES every world swap. An
    // agent told otherwise passes `discardUnsaved:true`, believes it abandoned the edit, and the
    // next gated op refuses for the identical cause with the identical advice — a loop.
    //
    // Three rounds of close-out review got the NOUN right and left the VERB wrong: "the pending
    // asset writes" (wrong kind), then "the parked work" (wrong kind), then "the work named above"
    // (right kind, still not true of what the remedy does). So the sentence is now split by what
    // the swap actually destroys, and each half names an exit that exists.
    const liveHalf = c.sceneDirty || c.dirtyScenes.length > 0;
    const parkedHalf = (Object.entries(causeSpecs()) as Array<[keyof UnsavedCauses, { writtenBy: unknown }]>)
      .some(([cause, spec]) => {
        if (spec.writtenBy === 'scene-write') return false;
        const v = c[cause];
        return Array.isArray(v) ? v.length > 0 : Boolean(v);
      });
    // ⚠️ Except a scene loaded AS A BASE that the TARGET chain shares (#1417 review): SceneManager
    // keeps it and carries its entities from the live world, so its edits and its dirty flag
    // survive. Not the open scene itself: an old PRIMARY is never kept, even when the target names
    // it as its base. Not a base whose file changed on disk either: a pending hot reload of it forces
    // the next load to reload it, whoever issues that load (#1422). This guard never sees the target
    // chain, so the qualifier lives in the words. Saying
    // "destroyed" there sends the agent into the same loop as the parked half below.
    const consequence = liveHalf
      ? ' The live-world scene edits would be DESTROYED (gone from the world, the file, and the undo stack),'
        + ' except edits to a scene currently loaded AS A BASE (not the open scene itself) that the target also uses:'
        + ' that base is carried across live and stays unsaved, unless its FILE changed on disk since it loaded'
        + ' (a pending hot reload of it): then disk wins and its edits go too.'
      : '';
    // The parked half is the honest surprise: it is why this refusal exists at all for a
    // parked-only cause, and it is the opposite of "would be lost".
    const survives = parkedHalf
      ? ' The parked entries are keyed by PATH and SURVIVE the swap — they stay pending either way.'
      : '';
    // Inside prefab-edit mode the remedy is split BY CAUSE (#1424). The live half is the prefab
    // world, and only `edit-save` writes it — save_all refuses the scene half there. The parked half
    // is the opposite: `edit-save` does not touch it, and save_all DOES write it in prefab-edit mode
    // (it flushes both parked phases, then refuses only the scene half). Naming edit-save for
    // parked work sent the agent round a save → same refusal loop, towards the discard tools.
    const remedy = (isEditingPrefab()
      ? (liveHalf ? " Run modoki_prefab {action:'edit-save'} to write the prefab-world edits (modoki_save_all refuses the scene half in prefab-edit mode)." : '')
        + (parkedHalf ? ' Run modoki_save_all to write the parked entries (in prefab-edit mode it writes them and refuses only the scene half).' : '')
      : ' Run modoki_save_all to write all of it.')
      + (liveHalf ? ' `discardUnsaved:true` deliberately discards the LIVE-WORLD edits (not those of a loaded base the target shares).' : '')
      + (parkedHalf
        ? ' ⚠️ `discardUnsaved:true` does NOT drop the parked entries — use'
          + ' modoki_discard_asset_edits (parked asset documents),'
          + ' modoki_write_asset_meta {discardUnsaved:true} (the import-settings park for the path it writes),'
          + ' or modoki_persistence {op:"resolve-unsaved"} (discard by registry).'
        : '');
    throw new OpRefusal(
      'REQUIRES_SAVE',
      `${op}: the editor has UNSAVED work — ${causes.join(' AND ')}. ${op} swaps the world.`
      + `${consequence}${survives}${remedy}`,
    );
  };
  registerAgentOp('load-scene', async (params) => {
    const p = (params ?? {}) as { path: string; discardUnsaved?: boolean; force?: boolean };
    const { path } = p;
    if (!path) throw new Error('load-scene requires { path }');
    guardUnsaved('load-scene', p.discardUnsaved ?? p.force);
    // Read BEFORE the load — `loadScene()` never gets far enough to change this on a
    // refusal/failure, but capturing it up front (mirrors `agentBridge.ts`'s runtime twin,
    // #486 finding A) lets the message say whether the PREVIOUS scene is still what's loaded,
    // rather than assuming it.
    const before = getCurrentScenePath();
    const outcome = await loadScene(path);
    if (outcome === 'refused' || outcome === 'failed') {
      // Carry the ACTUAL reason (docs/format-versioning.md § 2b-bis / #784 phase C3) instead of
      // guessing one — a too-new/unreadable scene is a REFUSAL, not a missing path, and the old
      // hard-coded "does the path exist?" message was a wrong diagnosis for a right symptom.
      const reason = getLastSceneLoadFailureMessage();
      const cur = getCurrentScenePath();
      const verb = outcome === 'refused' ? 'REFUSED' : 'FAILED';
      const why = reason ?? (outcome === 'failed' ? 'the scene was not loaded (does the path exist?)' : 'its format version is not supported by this build');
      const stillPrevious = cur === before;
      throw new Error(
        `load-scene ${verb} for "${path}": ${why}. ` +
        (stillPrevious
          ? `The previous scene is still loaded.`
          : `The active scene is now "${cur ?? 'null'}" — the previous scene is NOT what is loaded, because another load swapped it in while this one was failing.`),
      );
    }
    if (outcome === 'superseded') {
      // A LATER load won the swap while ours was in flight (SceneManager.loadScene's step-11 tail guard) — our own
      // load did not fail, and this says nothing about whether `path` exists. Mirrors the
      // runtime twin's wording (agentBridge.ts's `load-scene`, #486 finding A).
      return {
        ok: false,
        superseded: true,
        // `sceneManager.getCurrent()`, NOT `getCurrentScenePath()`. The editor's tracked path is
        // written by the WINNING load's own tail, so at this instant it can still hold the
        // pre-swap value — and naming a scene that is not the live world is the same class of
        // untruth this reply exists to correct. The scene manager is the authority on which world
        // is actually active.
        error: `load-scene for "${path}" was superseded — a LATER scene load won the swap, and `
          + `"${sceneManager.getCurrent()?.path ?? 'null'}" is now the active scene. This op's own `
          + `load did not fail; this says nothing about whether "${path}" exists.`,
        // The health faults, then the WINNER's path from the scene manager, for the reason above — not
        // `editorStateFields('scenePath')`, which reads the tracked path this comment says may still be
        // pre-swap (#1553 review).
        ...editorStateFields(),
        scenePath: sceneManager.getCurrent()?.path ?? null,
      };
    }
    // #1425: the scene loaded, but a manager failed to start. Say so rather than a bare ok.
    const startupErrors = getLastSceneLoadStartupErrors();
    return {
      ok: true,
      ...(startupErrors.length ? { warnings: startupErrors.map((e) => `manager failed to start (the scene is still loaded): ${e}`) } : {}),
      ...editorStateFields('scenePath', 'worldEntityTotal', 'unsavedChanges'),
    };
  });
  registerAgentOp('new-scene', async (params) => {
    const p = (params ?? {}) as { discardUnsaved?: boolean; force?: boolean };
    // In prefab-edit, `newScene` refuses whatever is dirty (below), so the unsaved-work refusal would
    // only send the caller to save and then hit that one anyway (#1424 review). Let it speak first.
    if (!isEditingPrefab()) guardUnsaved('new-scene', p.discardUnsaved ?? p.force);
    // Async since #853 — `newScene` now swaps the world through SceneManager instead of
    // respawning in place, so `onWorldSwap` fires and every id-keyed cache clears. It also
    // REFUSES during prefab edit; that throw carries its own message and propagates as this
    // op's error, the same shape `guardUnsaved` above uses.
    await newScene();
    setSelectionRaw(null, []);
    return { ok: true, ...editorStateFields('scenePath', 'worldEntityTotal', 'unsavedChanges') };
  });
  // save_all is the tool the whole "create live, then edit the file" story depends on, so it
  // must never claim a write that didn't happen. It used to hardcode {ok:true} over a
  // void saveAll() that swallowed BOTH a user cancel and a failed write — reproducing the
  // exact bug save_all exists to fix, with the fix confirming it had worked. (C7)
  //
  // allowDialog:false is load-bearing: with no path yet (after new_scene) the human path
  // opens a NATIVE Save panel, which is modal and only a human can dismiss — an agent call
  // hung ~60s to a 504 AND blocked every later renderer-bound call until someone clicked
  // Cancel. Take an explicit `path` instead, and say so when we need one.
  /** Refuse `save-all`'s SCENE half after writing every parked doc anyway (#259), and name what
   *  landed: `PARTIAL` when something did, `REFUSED_BY_OP` when nothing did. Shared by the exits
   *  that never reach `saveAll` (where the flush otherwise lives). */
  async function refuseSceneHalfAfterFlush(message: string): Promise<never> {
    const before = await flushParked('before-scene');
    const after = await flushParked('after-scene');
    const flushedAll = [
      ...before.dirtyAssetPaths.saved.map((pth) => `asset ${pth}`),
      ...before.pendingImportSettings.saved.map((pth) => `import settings for ${pth}`),
      ...after.pendingBaseScenes.saved.map((pth) => `base-scene ref on ${pth}`),
    ];
    const note = flushedAll.length
      ? ` (${flushedAll.length} parked item(s) WERE written: ${flushedAll.join(', ')})`
      : '';
    throw new OpRefusal(flushedAll.length ? 'PARTIAL' : 'REFUSED_BY_OP', `${message}${note}`);
  }
  registerAgentOp('save-all', async (params) => {
    const { path: savePath } = (params ?? {}) as { path?: string };
    // Prefab-edit mode deliberately NULLS the scene path so a normal save can't target a real
    // file (prefabEdit.ts) — the human paths honour that via isEditingPrefab(). The agent path
    // must too, and MORE so now that it takes an explicit `path`: without this the op would
    // serialize the SYNTHETIC prefab-edit world (the prefab's entities, expanded, plus the
    // throwaway __PrefabEdit* light/HDR scaffolding) straight over a real scene file, then
    // re-point the scene path and clear the dirty flag — reporting {ok:true}. Worse, the
    // needs-path error below actively STEERS an agent into it ("pass an explicit path"), which
    // is exactly what it hits when the human simply happens to be editing a prefab. (C7)
    if (isEditingPrefab()) {
      // Flush the parked ASSET docs even here (#259). They are documents a panel or an agent op
      // owns and have nothing to do with which world is loaded — and this branch never reaches
      // `saveAll`, which is where the flush lives. Then refuse the SCENE half, naming what did
      // happen: an error that hides completed work is as misleading as a success that hides a
      // failure.
      // ⚠️ EVERY parked flush, derived — this branch was the FIFTH save site spelling the set by
      // hand, and it was short by two (#972 P12's own defect, found in close-out round three).
      // `flushDirtyAssets()` alone left a parked import-settings edit and a pending base-scene ref
      // unwritten here, while a human pressing Cmd+S in the same state wrote all three
      // (`saveCommand.ts` was migrated in P12; its guard scans that file only, so nothing saw this).
      // Both phases run back to back because this branch writes no scene — same shape as the
      // preview fast path.
      await refuseSceneHalfAfterFlush(
        'save-all: the editor is in PREFAB-EDIT mode — its world is a synthetic prefab scene, ' +
        'not a real one, so saving it to a scene path would overwrite that scene with prefab ' +
        'scaffolding. Use the prefab editor\'s own save (Save Prefab), or leave prefab-edit mode first.');
    }
    // A new scene file is `<name>.scene.json` — the suffix the manifest classifies scenes by (#1413).
    // Refused, never silently renamed (owner 2026-09-18): the agent asked for this path, and a file
    // landing somewhere else is worse than one round-trip. The open scene and a file the manifest
    // already types `scene` (a legacy `/scenes/*.json`) stay re-savable under their own names.
    // Like the prefab-edit refusal above, the parked docs are flushed FIRST (#259) — they have
    // nothing to do with the scene's file name, and every other exit of this op writes them.
    if (savePath && !isAcceptableScenePath(savePath, { currentPath: getCurrentScenePath(), existingType: getAssetEntry(savePath)?.type })) {
      await refuseSceneHalfAfterFlush(
        `save-all: "${savePath}" is not a scene file name — a scene is saved as <name>${SCENE_EXT}, which is how the ` +
        `asset manifest recognises it (a plain .json is a scene only inside a /scenes/ folder, by a legacy rule, and a ` +
        `.prefab.json/.mat.json name would be read as that kind). The scene was NOT written. Use "${correctedScenePath(savePath)}".`);
    }
    const r = await saveAll({ path: savePath, allowDialog: false });
    // Every parked item this save DID write, for the exits below. ⚠️ Named at ALL of them, not
    // just the terminal throw: `playing` and `needs-path` each reported only `r.assets.saved` (or
    // nothing), so an agent read them as "nothing was saved" and re-parked work already on disk —
    // which is the reason the `playing` branch's own comment gives for having a note at all, then
    // applied to one channel of three. (Close-out round three.)
    // Computed BEFORE the first exit so every refusal below can take its §5 code from it: `PARTIAL`
    // exactly when something was written, decided from this list rather than from the prose (#1012).
    const landed = [
      // A Save As writes the loaded bases BEFORE its copy (#1414), so they can land on a failed save —
      // or on one whose copy was not reopened, which exits through a refusal below too.
      ...(r.saved && !(r.savedAs && !r.savedAs.reopened) ? [] : (r.extraSaved ?? []).map((e) => `scene ${e.path}`)),
      ...(r.assets?.saved ?? []).map((pth) => `asset ${pth}`),
      ...(r.importSettings?.saved ?? []).map((pth) => `import settings for ${pth}`),
      ...(r.baseScenes?.saved ?? []).map((pth) => `base-scene ref on ${pth}`),
    ];
    const landedNote = landed.length
      ? ` ${landed.length} parked item(s) DID land and are on disk: ${landed.join(', ')}.`
      : '';
    const partialOr = (code: ErrorCode): ErrorCode => (r.saved || landed.length ? 'PARTIAL' : code);
    // PARTIAL IS A FAILURE (conventions §5). The primary scene saving does not mean Save All
    // succeeded: a dirty BASE scene that could not be serialized or written was previously just a
    // `console.error` + `continue`, and this returned `{ok:true}`. The edit then lived only in
    // memory, and a later build — which reads FILES — shipped without it, with nothing saying why.
    // THREE independent partial-failure channels, and the op reported ok:true through all of
    // them at one time or another: other loaded SCENES (`r.failed`), parked ASSET writes
    // (`r.assets.failed`, e.g. a particle/anim def whose disk write was rejected — it stays
    // pending and hasUnsavedChanges() stays true, but the agent was told the save succeeded), and
    // — since #831 — pending base-scene refs (`r.baseScenes.failed`), which `/api/scene-mutate`
    // can refuse on its own run-mode or unsaved-work guard and which are then RE-PARKED. The
    // third was added with the field and not with the check, which is how the second one got here.
    //
    // ⚠️ **And it happened a FOURTH time** (#972 close-out review): `importSettings.failed` (#845)
    // was added to `SaveResult` and to the TOAST, and never to this check — so a rejected
    // `.meta.json` write returned `{ok:true}` to an agent while the edit stayed parked. The comment
    // above narrated this exact mechanism about the third channel while the fourth was already
    // missing from the line below it. Reading a warning is not the same as applying it.
    const sceneFails = (r.failed ?? []).map((f) => `scene ${f.path} (${f.reason})`);
    const assetFails = (r.assets?.failed ?? []).map((f) => `asset ${f.path} (${f.error})`);
    const baseSceneFails = (r.baseScenes?.failed ?? []).map((f) => `base-scene ref on ${f.path} (${f.error})`);
    const metaFails = (r.importSettings?.failed ?? []).map((f) => `import settings for ${f.path} (${f.error})`);
    const allFails = [...sceneFails, ...assetFails, ...baseSceneFails, ...metaFails];
    if (allFails.length) {
      throw new OpRefusal(
        partialOr('REFUSED_BY_OP'),
        `save-all PARTIALLY failed: the primary scene ${r.saved ? `saved to ${r.path}` : 'did not save'}, but ` +
        `${allFails.length} item(s) did NOT: ${allFails.join('; ')}. Those changes are still in the ` +
        `live world / pending only, and stay marked dirty — a build reads FILES and would ship ` +
        `WITHOUT them. Fix the cause and call save_all again.${r.saved ? '' : landedNote}`,
      );
    }
    // A Save As whose copy landed but could not be reopened (#1414): the copy is on disk under a
    // fresh id, and the editor is still on the ORIGINAL with its edits unsaved. Not a success —
    // the tool promises the scene moves to the new path — and not "nothing written" either.
    if (r.saved && r.savedAs && !r.savedAs.reopened) {
      throw new OpRefusal('PARTIAL',
        `save-all: the scene WAS written to ${r.path} as a copy with a fresh scene id, but ${r.savedAs.note ?? 'it could not be reopened'}. ` +
        `${r.savedAs.from} itself was not written.${landedNote}`);
    }
    if (r.saved) {
      return {
        ok: true, scenePath: r.path,
        // A Save As (#1414): name what the copy was made from, and that it carries its own id.
        ...(r.savedAs ? { savedAsCopyOf: r.savedAs.from, freshSceneId: true } : {}),
        ...(r.extraSaved?.length ? { extraSaved: r.extraSaved } : {}),
        // Name the asset docs this save wrote. They are the half a caller cannot otherwise see —
        // `saved:false` was the answer when the edit was parked, and this is where that promise
        // is kept.
        ...(r.assets?.saved.length ? { savedAssets: r.assets.saved } : {}),
        // Same promise for the base-scene refs: `setBaseScene` through the Inspector answers
        // "parked, not written", and this is where that is squared.
        ...(r.baseScenes?.saved.length ? { savedBaseScenes: r.baseScenes.saved } : {}),
        // …and for parked import-settings edits (#845), the fourth channel — reported for the same
        // reason as the two above, and missing for the same reason they each once were.
        ...(r.importSettings?.saved.length ? { savedImportSettings: r.importSettings.saved } : {}),
      };
    }
    if (r.reason === 'target-loaded') {
      throw new OpRefusal(
        partialOr('REFUSED_BY_OP'),
        `save-all: "${r.path}" is another scene loaded under the open one (a base scene in its chain). Saving the ` +
        'open scene over it would replace a file the live world is built from. The scene was NOT written. Choose another path.'
        + landedNote,
      );
    }
    if (r.reason === 'needs-path') {
      throw new OpRefusal(
        partialOr('REFUSED_BY_OP'),
        'save-all: this scene has no path yet (new_scene never saved), and the Save-As panel ' +
        'needs a human. Pass an explicit path, e.g. save_all { path: "/assets/scenes/my-scene.scene.json" }.'
        + landedNote,
      );
    }
    if (r.reason === 'playing') {
      // The SCENE half only. Parked asset docs already flushed above (#259) — say so, or an agent
      // reads this as "nothing was saved" and re-parks work that is already on disk.
      // ⚠️ All three channels, not just asset docs. `flushPendingMeta` carries no run-mode refusal
      // (unlike `/api/scene-mutate`), so an import-settings edit really does land while the editor
      // is playing — and this note existed precisely so an agent would not re-park what is already
      // on disk.
      const note = landed.length
        ? ` The ${landed.length} parked item(s) WERE written (${landed.join(', ')}) — those are authored documents and are not affected by run mode.`
        : '';
      // The REASON, not a fixed "stop the editor" (#1548 close-out review): a preview restore still
      // landing is cleared by retrying, not by Stop, which is a no-op there.
      const why = whyWorldNotAuthored() ?? 'the live world is not authored';
      throw new OpRefusal(partialOr('REFUSED_BY_OP'), `save-all: the SCENE was NOT saved — blocked while the editor is playing/previewing (${why}). Saving now would bake the runtime world (physics-settled positions, spawned entities, a preview pose) over your authored scene. Stop Play (modoki_play_control {action:"stop"}), exit a preview (modoki_exit_pose_envelope), or — if a restore is landing — retry in a moment.${note}`);
    }
    // ⚠️ "NOTHING was written" was a claim about the WHOLE save, and a failed scene write does not
    // undo the parked flushes — so with anything in `landed` it was a real write reported as a
    // no-op, the same defect the toast had. ("before it" is deliberately NOT said: the base-scene
    // flush is `writtenBy:{flush:'after-scene'}` and runs AFTER the scene write, so two of the
    // three lists land on the far side of it.)
    throw new OpRefusal(
      partialOr('REFUSED_BY_OP'),
      `save-all FAILED (${r.reason}) for ${r.path ?? '(no path)'} — the SCENE was not written to disk.`
      + (landed.length ? landedNote : ' Nothing was written.'),
    );
  });

  /** The counterpart to `save-all` for PARKED ASSET WRITES: drop them instead of persisting them.
   *
   *  Manual persistence shipped with only one exit from the dirty-asset registry — a save — so an
   *  exploratory particle/anim/timeline edit could not be abandoned. Re-applying the previous def
   *  looks like an undo and is not one: it re-parks a write (still dirty, still committed by the
   *  next save) and it writes back the MIGRATED def, so a legacy `gravity: 6` returns as
   *  `[0,-6,0]`. Measured on `confetti.particle.json` — the live smoke suite reported that it had
   *  restored the asset while leaving exactly that residue.
   *
   *  A BARE CALL IS REFUSED. Discarding every pending write is the destructive default that
   *  `set_selection` taught us not to ship: there, a bare call cleared the selection, so one
   *  misspelled argument key silently became "clear everything". The caller must name `paths`, or
   *  say `all:true` and mean it. The refusal lists what is pending, so the naming is a copy-paste. */
  registerAgentOp('discard-asset-edits', (params) => {
    const p = (params ?? {}) as { paths?: string[]; all?: boolean };
    const pending = getDirtyAssetPaths();
    // Coded refusals with the choices in `options` (#1212 A-20): these were plain throws — the relay
    // calls those REFUSED_BY_OP with NO options — and the pending list sat in the prose.
    // Capped like liveMutate's AMBIGUOUS list: options are not size-bounded by the formatter, and
    // the error prose already names every pending path. JSON-quoted so a path is pasteable as is.
    const choices = pending.length
      ? [...pending.slice(0, 20).map((x) => `paths:${JSON.stringify([x])}`), 'all:true — drops every pending asset write, unrecoverably']
      : [];
    if (p.paths !== undefined && !Array.isArray(p.paths)) {
      throw new OpRefusal('REFUSED_BY_OP', 'discard-asset-edits: `paths` must be an array of asset paths.', { options: choices.length ? choices : ['paths:["/assets/…"]'] });
    }
    if (!p.paths?.length && !p.all) {
      throw new OpRefusal('REFUSED_BY_OP',
        'discard-asset-edits: say WHAT to discard — pass `paths:[…]`, or `all:true` to drop every '
        + `pending asset write. A bare call is refused because dropping them all is unrecoverable. ${
          pending.length ? `Pending now (${pending.length}): ${pending.join(', ')}` : 'Nothing is pending right now.'}`,
        // Nothing pending → no options: there is nothing to choose, and the prose says so.
        choices.length ? { options: choices } : {},
      );
    }
    if (p.paths?.length && p.all) {
      throw new OpRefusal('AMBIGUOUS', 'discard-asset-edits: pass `paths` OR `all:true`, not both — they disagree about the scope.', {
        options: ['keep `paths` and drop `all` — discards only those', 'keep `all:true` and drop `paths` — discards everything pending'],
      });
    }
    // #1213 A-12: named paths that match NOTHING pending, while other writes ARE pending, used to
    // answer ok:true "Nothing was pending" — false while `remaining` in the same reply listed them,
    // and the next save_all then committed the write the caller meant to drop (a typo'd path).
    // Refused up front, before anything is dropped, with the real pending paths as the choices.
    if (p.paths?.length && pending.length && !p.paths.some((x) => pending.includes(x))) {
      throw new OpRefusal('NOT_FOUND',
        `discard-asset-edits: none of ${p.paths.map((x) => JSON.stringify(x)).join(', ')} has a pending write — nothing was discarded. `
        + `Pending now (${pending.length}): ${pending.join(', ')}. Paths match exactly (asset-root URLs, e.g. /assets/fx/a.particle.json).`,
        { options: choices });
    }
    const r = discardDirtyAssets(p.all ? undefined : p.paths);
    // ⚠️ This op owns the DIRTY-ASSET registry and not the sidecar one, and `all:true` reads as if
    // it owned both. A parked `.meta.json` import-settings edit survives it untouched, so an agent
    // that discards "everything" and then re-imports still bakes against the human's unsaved
    // settings (#882). Say so rather than letting `all:true` imply a clean slate it did not
    // deliver — §0 ranks a false success as the worst outcome on this surface. Reporting, NOT
    // discarding: widening what this op destroys would be a blast-radius change nobody asked for,
    // and `modoki_write_asset_meta {discardUnsaved:true}` is the named exit for a park.
    // ⚠️ Every other PARKED cause, derived — not a hand-read of `pendingMeta` alone (#972). The
    // report named parked import settings and said nothing about pending baseScene refs, so
    // `all:true` implied a clean slate while leaving a whole registry pending and unmentioned.
    // A sixth PARKED cause is disclosed the day it is added; a sixth `scene-write` one is not, and
    // deliberately so — see the filter below. (The first version of this comment claimed "every
    // cause this op does not own", which the filter directly beneath it had already stopped being
    // true.)
    const parkedMeta = getPendingMetaPaths();
    const parkedBaseScenes = getPendingBaseScenePaths();
    const after = unsavedChangeCauses();
    const leftBehind = (Object.entries(causeSpecs()) as Array<[keyof UnsavedCauses, { label: { bool?: string; noun?: string }; writtenBy: unknown }]>)
      // PARKED work only — the registries this op could be mistaken for owning. A live-world scene
      // edit (`writtenBy: 'scene-write'`) is a different KIND of pending work, is already reported
      // by `unsavedChanges`, and is not discardable here at all — naming it would fire on nearly
      // every call (an agent edit leaves `sceneDirty` true) and, worse, the advice below would be
      // pointing at an exit that REFUSES it: `resolve-unsaved` excludes `liveScene` from
      // `DiscardableRegistry` and throws. Listing an exit that does not exist costs the agent a
      // turn, which is the failure the router calls out in as many words. (Close-out review.)
      .filter(([cause, spec]) => cause !== 'dirtyAssetPaths' && spec.writtenBy !== 'scene-write')
      .map(([cause, spec]) => {
        const v = after[cause];
        const n = Array.isArray(v) ? v.length : (v ? 1 : 0);
        if (!n) return null;
        const what = spec.label.noun ? `${n} ${spec.label.noun}(s)` : spec.label.bool;
        return Array.isArray(v) ? `${what} — ${v.join(', ')}` : what;
      })
      .filter((m): m is string => m !== null);
    return {
      ok: true,
      ...r,
      remaining: getDirtyAssetPaths(),
      ...(parkedMeta.length ? { remainingImportSettings: parkedMeta } : {}),
      ...(parkedBaseScenes.length ? { remainingBaseScenes: parkedBaseScenes } : {}),
      // Say plainly what was NOT undone. The parked write is gone; the value the editor is showing
      // is not, and an agent that reads the def back and sees its own edit must not conclude the
      // discard failed.
      note: (r.discarded.length
        ? 'The pending WRITE(s) were dropped — nothing will reach disk on the next save. The live '
          + 'editor cache still holds the edited def until the asset is reloaded; apply the previous '
          + 'def first if you need the value reverted too.'
        : 'Nothing was pending, so nothing changed.')
        + (leftBehind.length
          ? ` NOT covered by this call — this op owns the dirty-ASSET registry only, and these `
            + `parked edits are STILL pending: ${leftBehind.join('; ')}. modoki_save_all writes `
            + 'them; modoki_write_asset_meta {discardUnsaved:true} drops the import-settings park '
            + 'for the path it writes, and modoki_persistence {op:"resolve-unsaved"} can discard '
            + 'these registries by name.'
          : ''),
    };
  });

  // ── PlayerPrefs writes refuse an envelope too (#1551 review) ──
  // Ending a preview puts PlayerPrefs back to its state when the envelope opened, whoever wrote it — it
  // cannot tell a ▶ action's write from an agent's. So an agent write made inside one replied ok and
  // was deleted at ⏹/Stop/Play. The op itself lives in the shared bridge (the device runs it too, and
  // has no envelope), so the editor wraps it here instead of copying it. `flush` changes no value.
  const bridgePrefsWrite = agentOpHandler('player-prefs-write');
  if (bridgePrefsWrite) {
    registerAgentOp('player-prefs-write', (params) => {
      if ((params as { action?: string } | null)?.action !== 'flush') {
        refusePrefsWriteInSession();
      }
      return bridgePrefsWrite(params);
    });
  }

  // ── Entity create / duplicate / delete / reparent ── (undoable, like the menus).
  // Each refuses inside a scrub/preview envelope, or while its restore is landing (#1552) — see
  // `refuseEditOfPosedWorld`.
  registerAgentOp('create-entity', (params) => {
    refuseEditOfPosedWorld('create-entity');
    const p = (params ?? {}) as CreateEntityParams;
    if (!p.spec) throw new Error('create-entity requires { spec }');
    // The ONE vocabulary check both create-entity ops share (#1070) — `resolveCreateEntitySpec`
    // applies the per-kind defaults and checks kind, mesh, shape, light and preset. Two scars live
    // in it: `{kind:'primitive', mesh:'pyramid'}` once returned a clean success for an entity whose
    // renderer resolves to nothing, and defaults that lived in tools/editor.ts let a direct op call
    // (§9: the curl surface is not exempt) reach `cap(undefined)` and die with a raw TypeError.
    // ⚠️ An `OpRefusal`, not a plain throw: a plain throw reached the agent as a generic
    // REFUSED_BY_OP whose valid values existed only inside the prose; this carries them as `options`.
    const resolved = resolveCreateEntitySpec(p.spec);
    if (!resolved.ok) {
      throw new OpRefusal('REFUSED_BY_OP', `create-entity: ${resolved.error} Valid: ${resolved.options.join(', ')}.`, { options: resolved.options });
    }
    // parentGuid and parentId are ONE address (both given → refused, #1223); 0 alone = root stays literal.
    const parentId = resolveParentId(p, 'create-entity parent');
    if (p.name !== undefined && (typeof p.name !== 'string' || !p.name.trim())) {
      throw new OpRefusal('REFUSED_BY_OP', `create-entity: name must be a non-empty string (got ${JSON.stringify(p.name)}) — nothing was created.`);
    }
    const { name, specs } = buildEntityCreateSpecs(resolved.spec, parentId, p.name as string | undefined);
    const id = createEntityWithUndo(`Create ${name}`, parentId, specs as TraitSpec[], (i) => setSelectionRaw(i, i != null ? [i] : []));
    // null = nothing was created. Reporting {id:null} as a success let an agent proceed as
    // if the entity existed — say so instead. (C7)
    if (id == null) throw new Error(`create-entity: nothing was created for spec ${JSON.stringify(resolved.spec)} (parentId ${parentId})`);
    // Return the GUID, not just the live id. CLAUDE.md's rule is "address entities by
    // {guid}, NEVER {id}" — runtime ids are reassigned on every scene hot-reload, and the
    // file's id space is a DIFFERENT namespace (loadSceneFile remaps them), so a stale id
    // can even resolve to the WRONG entity in a scene file. This path already mints a guid
    // internally and threw it away, leaving the one identifier the docs mandate
    // unobtainable from the tool that creates the entity. (C7)
    // `saved: false` — this is a Path B (live-world) op; nothing reaches disk until
    // modoki_save_all (mcp-persistence.md). Explicit rather than implied so an
    // agent never has to infer persistence from the tool description alone.
    return { id, name, guid: ensureGuid(id), saved: false };
  });
  registerAgentOp('duplicate-entity', (params) => {
    refuseEditOfPosedWorld('duplicate-entity');
    const p = (params ?? {}) as { id?: number; guid?: string };
    const id = requireLiveId(p, 'duplicate-entity'); // throws on a stale, ambiguous or id-for-a-guid ref (#1223)
    if (isResourceEntity(id)) {
      // The Hierarchy disables Duplicate on a resource row; the agent path refuses the same thing (#1248).
      // A copy is a second world singleton: getTime/getInput read one, the systems write both.
      throw new Error(`duplicate-entity: entity ${id} is a resource (Time, Input, a config singleton) — a world holds one, so it is not duplicated.`);
    }
    const newId = duplicateEntity(id, (i) => setSelectionRaw(i, i != null ? [i] : []));
    if (newId == null) throw new Error(`duplicate-entity: nothing was duplicated for entity ${id} (does it exist?)`); // C7
    return { id: newId, guid: ensureGuid(newId), saved: false }; // stable handle — see create-entity (C7)
  });
  registerAgentOp('delete-entities', (params) => {
    refuseEditOfPosedWorld('delete-entities');
    // Accept guids (stable) and/or ids, resolving each to a LIVE id. This closes the C7 residual:
    // a numeric id recycled by a hot-reload passed the old findEntity() guard and deleted a
    // DIFFERENT valid entity (data loss reported as success). A guid resolves to the RIGHT entity
    // or fails — so guid callers can no longer hit the wrong subtree. (C7 re-audit.)
    const p = (params ?? {}) as { ids?: number[]; id?: number; guids?: string[]; guid?: string };
    const refs: Array<{ id?: number; guid?: string }> = [
      ...(p.guids ?? []).map((guid) => ({ guid })),
      ...(p.guid != null ? [{ guid: p.guid }] : []),
      ...(p.ids ?? []).map((id) => ({ id })),
      ...(p.id != null ? [{ id: p.id }] : []),
    ];
    if (!refs.length) throw new Error('delete-entities requires { ids } / { id } or { guids } / { guid }');
    const deleted: number[] = [];
    const missing: Array<{ id?: number; guid?: string }> = [];
    const miss: { stale?: string } = {};
    for (const r of refs) {
      const id = resolveLiveIdOrSkip(r, 'delete-entities', miss);
      if (id == null) missing.push(r);
      else if (!deleted.includes(id)) deleted.push(id);
    }
    if (deleted.length === 0) {
      throw new OpRefusal('NOT_FOUND', 'delete-entities: none of the requested entities exist — nothing was deleted. Runtime ids are reassigned on every scene reload; re-read them with get_scene_state, or address entities by guid.', { stale: miss.stale });
    }
    // Name them by guid BEFORE deleting (#1223 P2): the delete cascades, so a child also listed reads
    // no guid afterwards. The ids would be dead addresses the moment this returns.
    // Mint the durable guids FIRST. `deleteEntitiesWithUndo` writes one over a runtime guid before it
    // snapshots, and that is the guid its journal event and its undo use — named before the mint, the
    // reply handed out a runtime guid the journal never mentioned and undo never restored (close-out
    // review). Every listed id, not only the roots it snapshots: a listed child's guid rides in its
    // ancestor's snapshot, so a durable one written now is the one an undo brings back.
    for (const id of deleted) ensureGuid(id);
    const named = guidListFields('deleted', deleted);
    // The descendants the cascade takes too, which the reply never mentioned (#1216 C-6) — minted durable
    // for the same reason as the listed ids: the guid named here must be the one undo brings back.
    const descendants = descendantsOf(deleted);
    for (const id of descendants.slice(0, ALSO_DELETED_CAP)) ensureGuid(id);
    const also = alsoDeletedFields(descendants);
    deleteEntitiesWithUndo(deleted, (sel) => setSelectionRaw(sel[0] ?? null, sel));
    return { ok: true, ...named, ...also, saved: false, ...(missing.length ? { skipped: missing, warning: `${missing.length} ref(s) matched no live entity and were skipped (ids are reassigned on scene reload — prefer guid)` } : {}) };
  });
  registerAgentOp('reparent-entity', async (params) => {
    refuseEditOfPosedWorld('reparent-entity');
    // Both the moved entity and the new parent resolve through the shared resolver (#1223): one address
    // each, `{id}` only for a guid-less entity — a recycled id would silently move the wrong node.
    const p = (params ?? {}) as { id?: number; guid?: string; parentId?: number; parentGuid?: string; sortOrder?: number; moveToScene?: boolean };
    const id = requireLiveId(p, 'reparent-entity');
    const parentId = resolveParentId(p, 'reparent-entity parent', { move: true });
    // The one decision every reparent entry point asks (#1429), so the refusal can name its rule.
    const plan = planReparent(id, parentId);
    if (plan.kind === 'refused') throw new OpRefusal('REFUSED_BY_OP', reparentRefusalText(plan.reason, id, parentId));
    // A parent from another scene makes this a SCENE MOVE. A human answers the Hierarchy's prompt; the
    // agent answers it with `moveToScene: true`, after reading the same text the human reads. Refusing
    // first, rather than moving and reporting, is deliberate: the move changes what every level using
    // that base shows, so it has to be chosen knowingly (the discardUnsaved shape, #1429 design).
    if (plan.kind === 'scene-move' && p.moveToScene !== true) {
      const pre = await preflightSceneMove(id, plan.to);
      const parentName = getAllEntities().find((e) => e.id === parentId)?.name || `Entity ${parentId}`;
      const text = formatSceneMoveConfirm(pre, plan.to, { parentName, sceneName: loadedSceneName(plan.to) });
      throw new OpRefusal('REFUSED_BY_OP',
        `reparent-entity: nothing was applied — the new parent belongs to another scene, so this reparent moves the entity into that scene. `
        + `The editor asks a person first; re-send with moveToScene: true to make the move. What it would do:\n${text}`);
    }
    const res = applyReparent(id, parentId, p.sortOrder);
    // After a successful plan the only `false` left is a no-op: same parent, same sortOrder. (C7)
    if (!res.ok) {
      throw new OpRefusal('REFUSED_BY_OP', `reparent-entity: nothing changed — ${id} is already under ${parentId || 'the root'}${p.sortOrder !== undefined ? ` at sortOrder ${p.sortOrder}` : ''}.`);
    }
    const move = res.sceneMove && res.plan.kind === 'scene-move'
      ? { movedToScene: { from: loadedSceneName(res.plan.from), to: loadedSceneName(res.plan.to), count: res.sceneMove.movedIds.length } }
      : {};
    return { ok: true, saved: false, ...move };
  });

  // ── Live-world scene mutation (mcp-persistence.md Phase 2) ──
  // The live-world twin of /api/scene-mutate's file-based applyOps — same MutateOp
  // vocabulary (setTrait/removeTrait/addEntity/removeEntity), one composite undo entry
  // per call. `setBaseScene` has no live equivalent; the backend route keeps any call
  // containing it on the file-direct path instead of reaching this op at all.
  registerAgentOp('apply-scene-ops', async (params) => {
    const p = (params ?? {}) as { ops?: MutateOp[] };
    if (!Array.isArray(p.ops) || p.ops.length === 0) throw new Error('apply-scene-ops requires a non-empty { ops } array');
    const { changed, errors, warnings, unresolved, created, addedTraits, alsoDeleted, alsoDeletedNoGuidIds, alsoDeletedTotal, code, options, stale } = await applySceneOpsLive(p.ops);
    return { ok: errors.length === 0, changed, errors, warnings, unresolved, saved: false,
      ...(created.length ? { created } : {}), ...(addedTraits ? { addedTraits } : {}),
      ...(alsoDeleted ? { alsoDeleted } : {}), ...(alsoDeletedNoGuidIds ? { alsoDeletedNoGuidIds } : {}), ...(alsoDeletedTotal ? { alsoDeletedTotal } : {}),
      ...(code ? { code } : {}), ...(options ? { options } : {}), ...(stale ? { stale } : {}) };
  });

  // ── Prefab ops ──
  //  All three actions mutate the LIVE world (instantiate spawns entities; create/detach
  //  tag or strip PrefabInstance traits) and must therefore push an undo entry — not just
  //  so the human can Cmd-Z the agent's work, but because `pushAction` is the ONLY thing
  //  that bumps `_editVersion`, i.e. the only thing that makes `hasUnsavedChanges()` true.
  //  Without it these ops were live-only yet reported `unsavedChanges: false`, so neither
  //  `guardUnsaved` (load_scene / new_scene) nor the /api/scene-mutate 409 fired, and the
  //  next file-write hot-reload silently DESTROYED the agent's prefab work while every tool
  //  had reported ok:true. Mirrors Hierarchy.tsx / Assets.tsx / Inspector.tsx.
  registerAgentOp('prefab', async (params) => {
    const p = (params ?? {}) as PrefabParams;
    const which = p.prefabAction ?? p.action;
    if (which === 'instantiate') {
      refuseEditOfPosedWorld('prefab instantiate');
      if (!p.path) throw new Error('prefab instantiate requires { path }');
      const path = p.path;
      const prefab = await getPrefabSource(path);
      if (!prefab) throw new Error(`prefab not found: ${path}`);
      // Track the parent by guid: `redo` can run after a world rebuild (Play→Stop), where a
      // raw parent id would resolve to a DIFFERENT entity and reparent the instance silently.
      // Validated like every other parent now (#1223): a stale or invented `parentId` used to pass through raw.
      const parentId = resolveParentId(p, 'prefab instantiate parent');
      const parentRef = parentId ? entityRef(parentId) : null;
      // Shares the human paths' helper (#1295): instantiate + setPrefabSource + leave the
      // editor cache keyed by what the instance CARRIES. Without the last part the tree is
      // linked but the cache is keyed by `path` while the instance carries the resolved GUID,
      // so every sync reader treats this instance as "not a prefab" and drops it silently.
      const rootId = await instantiatePrefabInstance(prefab as PrefabFile, path, parentId);
      setSelectionRaw(rootId, [rootId]);
      pushAction(makePrefabInstantiateAction({
        label: `Instantiate "${(prefab as PrefabFile).name ?? path}"`,
        initialId: rootId,
        respawn: async () => {
          const again = await getPrefabSource(path);
          if (!again) return null;
          const id = await instantiatePrefabInstance(again as PrefabFile, path, parentRef ? (parentRef.resolve() ?? 0) : 0);
          return id;
        },
        remove: (id) => { deleteEntity(id); },
      }));
      // A 2D entity outside every Canvas2D is drawn by nothing, and used to come back as a
      // bare ok:true — the caller then found screen:null with no idea why (QA-ASSET-0014).
      // The tool's own default parent (world root) is exactly where that happens, so the
      // answer belongs in THIS response, not only in the console a frame later.
      const unrenderable = findUnrenderable2D(getAllEntities(), rootId);
      const warnings = unrenderable.length === 0 ? [] : [
        `${unrenderable.map((e) => `"${e.name}" (id ${e.id})`).join(', ')}: 2D entit`
        + `${unrenderable.length === 1 ? 'y has' : 'ies have'} no Canvas2D ancestor and will not `
        + 'render. Reparent under the scene\'s Canvas2D host (modoki_reparent_entity), or pass '
        + 'parentGuid on instantiate.',
      ];
      return { ok: true, rootId, guid: ensureGuid(rootId), saved: false,
        ...(warnings.length ? { warnings } : {}) };
    }
    if (which === 'create') {
      if ((p.entityId == null && !p.entityGuid) || !p.path) throw new Error('prefab create requires { entityId | entityGuid, path }');
      const path = p.path;
      const entityId = requireLiveId({ id: p.entityId, guid: p.entityGuid }, 'prefab create'); // both given → refused (#1223 D1)
      // The live subtree is what gets written — refuse a posed/played one (#1548), as the human path does.
      // Unlike the live-world edits, Play is NOT exempt here: this writes a FILE, and a played subtree
      // would be baked into the template.
      if (getRunMode() === 'playing') {
        throw new OpRefusal('REFUSED_BY_OP', `prefab create refused: ${whyWorldNotAuthored()} — stop Play first, or the played pose is written into the prefab.`,
          { options: ["modoki_play_control {action:'stop'} — returns to the authored world, then retry"] });
      }
      refuseEditOfPosedWorld('prefab create', 'the subtree may carry a pose, which would be written into the prefab file');
      const existing = await classifyExistingPrefabId(path);
      // ⚠️ Refuse rather than mint a fresh file guid over a prefab that is THERE and unreadable — a
      // 500, corrupt bytes, or one a newer build wrote (#1468, #896's class). The agent asked to
      // create a prefab at a path, not to re-identify the asset already sitting on it, and every
      // scene referencing the old id would dangle with the old bytes still on disk. Thrown, because
      // this op's contract is that a refusal reaches the caller rather than the renderer console.
      if (existing.kind === 'refuse') throw new Error(`prefab create refused: ${existing.reason}`);
      const existingId = existing.kind === 'known' ? existing.id : undefined;
      // Same cold-cache flatten as the human path (#1284) — classifyExistingPrefabId fetches
      // raw and never touches the editor prefab cache, so nothing here warms it.
      await preloadNestedPrefabsForSubtree(entityId);
      let runtimeExcluded = 0;
      const prefab = serializePrefab(entityId, existingId, { onRuntimeExcluded: (n) => { runtimeExcluded = n; } });
      if (!prefab) throw new Error(`could not serialize prefab from entity ${entityId}`);
      // An authoring write (it can overwrite an existing template), so it reports an inert size like
      // the human Save-as-Prefab does (#42, #1251) — in THIS response too, because the agent that
      // authored it does not read the renderer console (the instantiate op's QA-ASSET-0014 rule above).
      const warnings = warnInertPrefabSizes(prefab, path);
      // Runtime entities under the selection (pooled UIEntries rows, timeline scrub/control spawns)
      // are excluded from the file (#1306) — and the agent does not read the renderer console, so it
      // is told here or not at all. Same reasoning as the inert-size warnings above (#1258).
      if (runtimeExcluded > 0) warnings.push(runtimeExcludedMessage(runtimeExcluded));
      const ok = await writePrefabFile(path, prefab);
      if (ok) {
        // Snapshot the links the tree already had, so undo can put them back (#1278). Tagging
        // deliberately leaves a held nested instance linked to its OWN prefab, but the untag
        // below strips the WHOLE tree — without this the agent path's undo left that instance
        // permanently unlinked, with nothing recorded to restore it. Mirrors the human flow.
        // ⚠️ Mint the root's guid BEFORE the tag: it is the ANCHOR every member's derived guid comes
        // from (#1461), and `entityRef` is what mints it. Taken after, the stamp has nothing to derive
        // from and leaves the create window open. (Its other job — resolving the subtree across a world
        // rebuild — is unchanged.)
        const ref = entityRef(entityId);
        const priorLinks = detachPrefabInstance(entityId, { strip: false });
        // The rename the tag stamped onto the members (old guid → new), for undo to reverse.
        let guidRemap = tagEntityTreeAsInstance(entityId, path, prefab);
        // Undo reverts the LIVE tagging only — deliberately NOT the file write. Deleting the
        // .prefab.json on undo (as the human path does for a brand-new prefab) is wrong here:
        // this op also OVERWRITES an existing prefab (`existingId` preserves its GUID), and
        // undoing an overwrite by deleting the file would destroy an asset the agent never
        // created. File-direct writes are not undoable anywhere else in the MCP surface either.
        pushAction({
          label: `Create prefab "${prefab.name ?? path}" (link only)`,
          undo: () => {
            const id = ref.resolve(); if (id == null) return;
            // Put the members' ORIGINAL guids back FIRST, and every ref with them: `priorLinks` was
            // snapshotted one line before the tag and addresses each member by the guid it held then,
            // so reattaching ahead of this would resolve nothing (#1461).
            unstampMemberGuids(guidRemap);
            // Scoped to THIS prefab (#1272): a held nested instance keeps its own link rather
            // than being stripped and restored from a guid that a Play→Stop may have re-minted.
            untagEntityTreeAsInstance(id, path);
            const unresolved = reattachPrefabInstance(priorLinks, { rootEcsId: id });
            if (unresolved > 0) console.warn(`[prefab create] undo: ${unresolved} prior prefab link(s) could not be put back — no longer addressable.`);
          },
          redo: async () => {
            const id = ref.resolve(); if (id == null) return;
            // tagEntityTreeAsInstance re-runs planPrefabRows, the FLATTEN reader (#1284): cold,
            // the re-planned rows drop the nested instance, planMatchesFile then disagrees with
            // the file written warm, and the redo tags nothing at all.
            await preloadNestedPrefabsForSubtree(id);
            const after = ref.resolve(); if (after == null) return;
            guidRemap = tagEntityTreeAsInstance(after, path, prefab); // undo reverses THIS run's rename

          },
        });
      }
      // `saved` describes the .prefab.json FILE write (ok). The live-world PrefabInstance
      // TAG on the source entity is separate and unsaved until modoki_save_all — reported so
      // an agent doesn't conflate "the asset file landed" with "the scene linkage did too".
      return { ok, source: path, saved: ok, sceneLinkageSaved: false, ...(warnings.length ? { warnings } : {}) };
    }
    if (which === 'detach') {
      refuseEditOfPosedWorld('prefab detach');
      if (p.entityId == null && !p.entityGuid) throw new Error('prefab detach requires { entityId | entityGuid }');
      const entityId = requireLiveId({ id: p.entityId, guid: p.entityGuid }, 'prefab detach'); // both given → refused (#1223 D1)
      const snapshot = detachPrefabInstance(entityId);
      // detachPrefabInstance returns [] for a plain (non-instance) entity. Reporting {ok:true,
      // detached:0} let an agent believe it had unpacked a prefab it hadn't — now a hard failure,
      // matching the other structural ops. (C7 re-audit.)
      if (!snapshot.links.length) {
        throw new Error(`prefab detach: entity ${entityId} is not a prefab instance (nothing to unpack). Only an instantiated prefab can be detached.`);
      }
      // Same entry the Hierarchy "Detach Prefab" menu pushes: undo re-attaches from the
      // snapshot, redo re-resolves by guid (the raw id is stale after a world rebuild).
      const name = getAllEntities().find(e => e.id === entityId)?.name ?? String(entityId);
      const ref = entityRef(entityId);
      pushAction({
        label: `Detach prefab "${name}"`,
        undo: () => {
          // Detach leaves plain entities, whose guids ARE serialized, so these survive a
          // Play→Stop where Create Prefab's do not (#1272). Reported, never discarded.
          const unresolved = reattachPrefabInstance(snapshot);
          if (unresolved > 0) console.warn(`[prefab detach] undo: ${unresolved} prefab link(s) could not be put back — no longer addressable.`);
        },
        redo: () => { const id = ref.resolve(); if (id != null) detachPrefabInstance(id); },
      });
      return { ok: true, detached: snapshot.links.length, saved: false };
    }
    // ── Override discovery/apply/revert (#2Tkw8CiWRATmHck2ze7q) ──
    // The human "Apply to Prefab" / "Revert Overrides" dialogs (ApplyPrefabDialog.tsx) were
    // the ONLY caller of applyToPrefabWithUndo/revertOverridesSelective, so an agent had no way
    // to reach them at all — a checkbox tree isn't something a tool call can click. `overrides`
    // is the read-only discovery call that stands in for the dialog's tree (built from the SAME
    // collectInstanceOverrideKeys/collectInstanceOverrideFields walk, so the keys it hands back
    // are exactly the keys `apply`/`revert` accept); `apply`/`revert` mirror the dialog's confirm
    // handlers, keys and all.
    if (which === 'overrides') {
      if (p.entityId == null && !p.entityGuid) throw new Error('prefab overrides requires { entityId | entityGuid }');
      const entityId = requireLiveId({ id: p.entityId, guid: p.entityGuid }, 'prefab overrides');
      const ctx = resolveInstanceContext(entityId);
      if (!ctx) {
        throw new Error(`prefab overrides: entity ${entityId} is not a prefab instance — it carries no PrefabInstance trait, so it has no overrides to discover.`);
      }
      const prefab = await getPrefabSource(ctx.source);
      if (!prefab) throw new Error(`prefab overrides: could not load prefab source "${ctx.source}" for entity ${entityId}.`);
      // collectInstanceOverrideKeys -> captureInstanceStructure reads nested children from the
      // editor cache SYNCHRONOUSLY; cold, a user-added nested instance is missing from `keys`
      // and the caller cannot address what it cannot see (#1284).
      await preloadNestedPrefabsForSubtree(ctx.rootInstanceId);
      const entities = collectInstanceOverrideFields(ctx.rootInstanceId, prefab);
      const keys = collectInstanceOverrideKeys(ctx.rootInstanceId, prefab);
      // Flatten the per-entity/trait tree into one list an agent can scan for a key without
      // guessing the string shape — the whole point of this action existing.
      const fields = entities.flatMap((e) => e.traits.flatMap((t) => t.fields.map((f) => ({
        localId: e.localId, entityName: e.name, trait: t.trait, field: f.field,
        current: f.current, base: f.base, key: f.key,
      }))));
      return {
        ok: true, source: ctx.source, rootInstanceId: ctx.rootInstanceId, guid: ensureGuid(ctx.rootInstanceId),
        keys, fields,
        // Say out loud what `keys` deliberately does NOT contain, so the omission is data rather
        // than a discrepancy the caller only notices by counting. `unaddressableAdded` are added
        // subtrees whose entity has no guid yet (minted lazily — save the scene and they become
        // addressable); `applyExcluded` are revertable-but-not-applyable fields.
        ...(keys.unaddressableAdded > 0
          ? { note: `${keys.unaddressableAdded} added subtree(s) have no guid yet and are NOT listed in keys.added — save the scene (modoki_save_all) to make them addressable.` }
          : {}),
      };
    }
    if (which === 'apply' || which === 'revert') {
      const verb = which; // 'apply' | 'revert'
      // Revert edits THIS instance in the live world (#1552 review); apply writes the template and is
      // refused further down by `applyToPrefabSelective`'s own gate.
      if (verb === 'revert') refuseEditOfPosedWorld('prefab revert');
      if (p.entityId == null && !p.entityGuid) throw new Error(`prefab ${verb} requires { entityId | entityGuid }`);
      const entityId = requireLiveId({ id: p.entityId, guid: p.entityGuid }, `prefab ${verb}`);
      const ctx = resolveInstanceContext(entityId);
      if (!ctx) {
        throw new Error(`prefab ${verb}: entity ${entityId} is not a prefab instance — nothing to ${verb}.`);
      }
      const prefab = await getPrefabSource(ctx.source);
      if (!prefab) throw new Error(`prefab ${verb}: could not load prefab source "${ctx.source}" for entity ${entityId}.`);
      // Same cold read as `overrides` above (#1284) — and here it decides what an explicit
      // `keys` list is validated against, so a cold miss turns a legitimate key into a refusal.
      await preloadNestedPrefabsForSubtree(ctx.rootInstanceId);
      const available = collectInstanceOverrideKeys(ctx.rootInstanceId, prefab);
      if (available.all.length === 0) {
        throw new Error(`prefab ${verb}: instance rooted at entity ${ctx.rootInstanceId} has no overrides — nothing to ${verb}.`);
      }
      let keySet: Set<string>;
      // An EXPLICIT empty array is refused, not treated as "omitted". They are opposite
      // intents and the fallthrough picks the destructive one: a caller that built `keys` by
      // filtering `overrides.keys.all` and matched nothing means "act on NOTHING", and would
      // instead have had every override on the instance applied to the shared prefab (or
      // reverted away). `keys` being absent is the only thing that means "all".
      if (p.keys && p.keys.length === 0) {
        throw new OpRefusal(
          'AMBIGUOUS',
          `prefab ${verb}: \`keys\` was given as an EMPTY array, which is ambiguous — omit \`keys\` ` +
          `entirely to ${verb} ALL ${available.all.length} override(s), or pass the ones you mean. ` +
          'Refusing rather than guessing: an empty selection computed by a filter means "nothing", ' +
          'while the omitted-keys default means "everything", and acting on the wrong one here is ' +
          `${verb === 'apply' ? 'a write to the shared prefab every other instance inherits' : 'a teardown of every override on this instance'}.`,
        );
      }
      if (p.keys && p.keys.length > 0) {
        // EVERY key must match, not merely one of them. A silent no-op is the class of failure
        // the Percept/Enact contract exists to remove — and the PARTIAL version is the nastier
        // half: dropping the unmatched keys and applying the rest returns {ok:true} having done
        // most of what was asked, so the caller has no reason to look. One typo in a list of
        // five would then leave a field un-applied, and the next reader would conclude the
        // apply is flaky rather than that they mistyped a key.
        // Compared in ONE spelling (#1468 Phase 4): a key names its member by `nodeGuid` where it can, and
        // a caller holding the localId spelling of the same key is asking for the same thing.
        const listed = new Set(available.all.map((k) => canonicalOverrideKey(k, prefab)));
        const unknown = new Set(p.keys.filter((k) => !listed.has(canonicalOverrideKey(k, prefab))));
        if (unknown.size > 0) {
          const sample = available.all.slice(0, 5).join(', ');
          throw new OpRefusal(
            'NOT_FOUND',
            `prefab ${verb}: ${unknown.size} of the ${p.keys.length} given key(s) match no override on this ` +
            `instance — ${[...unknown].slice(0, 5).join(', ')}${unknown.size > 5 ? ', …' : ''}. NOTHING was ` +
            `${verb === 'apply' ? 'applied' : 'reverted'} (a partial ${verb} would look like a success). Valid ` +
            `keys (${available.all.length} total) include: ${sample}${available.all.length > 5 ? ', …' : ''}. ` +
            "Call prefabAction:'overrides' for the exact set.",
            { options: available.all },
          );
        }
        keySet = new Set(p.keys);
      } else {
        keySet = new Set(available.all); // omitted ⇒ act on everything
      }

      if (which === 'apply') {
        // Some override keys are REVERTABLE but not APPLYABLE: a field kept out of a written
        // template (a runtime read-back, or the scene-only EntityAttributes.editorFolder)
        // is `continue`d past by applyToPrefabSelective WITHOUT being counted, so the overall
        // `applied` flag can be true while a specific requested key was never written.
        // Echoing the request back as `appliedKeys` would report that key as applied.
        // In the CALLER's spelling, so the refusal and `skippedKeys` name what they passed.
        const excludedCanon = new Set(available.applyExcluded.map((k) => canonicalOverrideKey(k, prefab)));
        const excluded = [...keySet].filter((k) => excludedCanon.has(canonicalOverrideKey(k, prefab)));
        if (p.keys && excluded.length > 0) {
          // Explicitly asked for by name → refuse, rather than do less than was asked.
          throw new Error(
            `prefab apply: ${excluded.length} requested key(s) cannot be written into a prefab ` +
            `template — ${excluded.join(', ')}. These are scene-only or runtime-only fields ` +
            "(EntityAttributes.editorFolder, runtime read-backs); apply would silently skip them. " +
            "They ARE revertable — prefabAction:'revert' resets them on this instance. Drop them " +
            'from `keys` to apply the rest.',
          );
        }
        // applyToPrefabWithUndo pushes its OWN undo entry (before/after prefab + scene
        // snapshot — see applyPrefabUndo.ts) — do NOT push a second one here.
        const result = await applyToPrefabWithUndo(ctx.rootInstanceId, keySet);
        // A move the prefab cannot express (#1437) is named with its reason, not echoed back as applied.
        const notWritten = result.skipped ?? [];
        if (!result.applied) {
          // A REFUSAL states its own cause; leading with the "may have stopped being a prefab
          // instance" guess before appending the real reason sends the reader down the wrong path
          // (#1468 close-out review F4). That guess is right only when nothing else explains it.
          if (result.refused) throw new Error(`prefab apply refused: ${result.refused}`);
          const why = notWritten.length ? ` Not applied: ${notWritten.map((x) => `${x.key} (${x.reason})`).join('; ')}.` : '';
          throw new Error(`prefab apply: nothing was written — the apply produced no change for entity ${entityId} (it may have stopped being a prefab instance mid-call).${why}`);
        }
        // apply WRITES the .prefab.json — say so honestly, mirroring how `create` reports `saved`.
        // `appliedKeys` excludes what the template cannot carry; `skippedKeys` names it rather
        // than leaving the caller to diff a second `overrides` call to notice. `warnings` carries the
        // prefab validation warnings for the written template, as `create` does (#1258).
        const skippedKeys = [...excluded, ...notWritten.map((x) => x.key)];
        const applied = [...keySet].filter((k) => !skippedKeys.includes(k));
        return {
          ok: true, source: result.source, appliedKeys: applied,
          // skippedReason speaks for the excluded FIELDS only; every other key Apply did not write (a move it
          // cannot express, a tag it cannot add — #1491) carries its own reason in notWritten.
          ...(skippedKeys.length > 0 ? { skippedKeys } : {}),
          ...(excluded.length > 0 ? { skippedReason: `fields ${excluded.join(', ')}: not representable in a prefab template (scene-only / runtime-only field)` } : {}),
          ...(notWritten.length > 0 ? { notWritten } : {}),
          promotedAdditions: result.promotedAdditions, saved: true,
          // An applied move changed member paths (#1437): which other files had their refs repaired, and which not.
          ...(result.memberPathsChanged ? { fileRepair: result.fileRepair ?? { failed: true } } : {}),
          ...(result.warnings?.length ? { warnings: result.warnings } : {}),
        };
      }

      // which === 'revert' — mirrors ApplyPrefabDialog.handleRevert EXACTLY: revert itself
      // pushes NO undo entry (rebuildInstance is a raw teardown+rebuild), so the caller must,
      // with the same before/after rebuild-from-snapshot undo/redo the dialog wires.
      // A refusal states its own cause (#1483) — Revert's bare null would be reported below as a lost instance.
      const refusal = staleInstanceRefusal(ctx.rootInstanceId);
      if (refusal) throw new Error(`prefab revert refused: ${refusal}`);
      const result = await revertOverridesSelective(ctx.rootInstanceId, keySet);
      if (!result) {
        throw new Error(`prefab revert: revertOverridesSelective returned nothing for entity ${entityId} — it stopped being a prefab instance, or the prefab source could not be re-loaded for the rebuild (see the editor console for the [Prefab] warning).`);
      }
      const ref = entityRef(result.newRootId);
      useEditorStore.getState().selectEntity(result.newRootId);
      const { source, prefab: revertedPrefab, fullOverrides, fullStructure, reducedOverrides, reducedStructure, affectedScenes } = result;
      pushAction({
        label: 'Revert prefab overrides',
        affectedScenes,
        undo: async () => {
          const cur = ref.resolve(); if (cur == null) return;
          // Same cold read as the dialog's closures (#1284); undoManager awaits undo/redo.
          await preloadNestedPrefabsForSubtree(cur);
          const after = ref.resolve(); if (after == null) return;
          const id = rebuildInstance(after, source, revertedPrefab, fullOverrides, fullStructure);
          useEditorStore.getState().selectEntity(id);
        },
        redo: async () => {
          const cur = ref.resolve(); if (cur == null) return;
          // Same cold read as the dialog's closures (#1284); undoManager awaits undo/redo.
          await preloadNestedPrefabsForSubtree(cur);
          const after = ref.resolve(); if (after == null) return;
          const id = rebuildInstance(after, source, revertedPrefab, reducedOverrides, reducedStructure);
          useEditorStore.getState().selectEntity(id);
        },
      });
      // revert is live-only — the prefab FILE is untouched, matching instantiate/detach.
      return { ok: true, newRootId: result.newRootId, guid: ensureGuid(result.newRootId), revertedKeys: [...keySet], saved: false };
    }
    // ── Prefab-edit mode (#125) ──
    // The only path that re-SERIALIZES an existing .prefab.json. `create` writes a prefab FROM a
    // scene entity; these open the template itself in an isolated synthetic world, so a save
    // round-trips the file through the current serializer. That is what makes a bulk format
    // migration possible (engine/scripts/resave-prefabs.sh) — and what makes an agent able to
    // edit a prefab at all without instantiating, mutating and re-applying it.
    if (which === 'edit-open') {
      if (!p.path) throw new Error("prefab edit-open requires { path } — the prefab's served path, e.g. '/assets/prefabs/tree.prefab.json'.");
      // Opening SWAPS the world exactly as load-scene does, so it destroys unsaved live work the
      // same way and must refuse for the same reason. It additionally SAVES the current scene on
      // the way in (prefabEdit.ts does this deliberately, so the return trip's reload-from-disk
      // is non-destructive) — which is a write the caller should not discover afterwards.
      guardUnsaved('prefab edit-open', (p as { discardUnsaved?: boolean }).discardUnsaved ?? p.force);
      const scenePathBefore = getCurrentScenePath();
      const name = p.path.split('/').pop()?.replace(/\.prefab\.json$/, '') ?? p.path;
      await openPrefabForEditing({ path: p.path, name });
      // openPrefabForEditing reports failure by console.error + early return (it is a UI path).
      // An agent needs it to FAIL, not to report ok:true having done nothing — a bad path would
      // otherwise leave the editor in the previous scene and the next edit-save would write the
      // WRONG prefab, or nothing at all.
      const editing = useEditorStore.getState().editingPrefab;
      if (!editing || !isEditingPrefab()) {
        throw new Error(
          `prefab edit-open FAILED for ${p.path} — the editor is not in prefab-edit mode. The file was ` +
          'not fetched or not parseable as a prefab (check the served path exists and is a .prefab.json). ' +
          'See the editor console for the [PrefabEdit] error.',
        );
      }
      return {
        ok: true,
        editing: { path: editing.path, guid: editing.guid, name: editing.name },
        /** The scene saved + remembered on the way in; 'edit-exit' reloads it. */
        returnScene: scenePathBefore,
        savedReturnScene: scenePathBefore != null,
        ...editorStateFields('scenePath', 'prefabEditWorld', 'worldEntityTotal'),
      };
    }
    if (which === 'edit-save') {
      if (!isEditingPrefab()) {
        throw new Error(
          "prefab edit-save: the editor is NOT in prefab-edit mode, so there is no prefab to write. " +
          "Open one first (prefabAction:'edit-open' with the .prefab.json path).",
        );
      }
      const editing = useEditorStore.getState().editingPrefab!;
      const { saved, warnings } = await savePrefabEditReport();
      if (!saved) {
        // ⚠️ `warnings` carries the backend's own REASON on a failure now (#1468) — the format gate
        // answers 409 with why, and without this the agent got three guesses and a pointer to a
        // console it cannot read. A produced reason nobody reads is this repo's #1 defect class, and
        // it shipped here once already (close-out review R2).
        const why = warnings.length ? ` Reason: ${warnings.join('; ')}` : '';
        throw new Error(
          `prefab edit-save FAILED for ${editing.path} — NOTHING was written. Either the prefab root ` +
          'was not found in the edit world, serialization produced no prefab, or the file write was ' +
          `rejected.${why || ' See the editor console for the [PrefabEdit] error.'}`,
        );
      }
      // `warnings`: the prefab validation warnings for the written template, as `create` answers them (#1258).
      return { ok: true, path: editing.path, guid: editing.guid, saved: true, ...(warnings.length ? { warnings } : {}) };
    }
    if (which === 'edit-exit') {
      // Report not-editing rather than throwing: leaving a mode you are not in is a legitimate no-op.
      if (!isEditingPrefab()) return { ok: true, wasEditing: false, ...editorStateFields('scenePath') };
      // Exiting reloads the return scene, which DISCARDS the prefab world — so it refuses on unsaved
      // work exactly as edit-open and load-scene do (#1424: it answered ok:true over an unsaved
      // delete, with the undo stack gone). This deliberately ends "call it blindly after a failed
      // edit-save": after a failed save the edits ARE unsaved, and dropping them must be a choice
      // the caller makes with discardUnsaved:true, not a side effect of tidying up.
      guardUnsaved('prefab edit-exit', (p as { discardUnsaved?: boolean }).discardUnsaved ?? p.force);
      const returned = await exitPrefabEditing();
      return { ok: true, wasEditing: true, returnedTo: returned, ...editorStateFields('scenePath', 'worldEntityTotal', 'unsavedChanges') };
    }
    throw new Error(
      `unknown prefab action '${which}' — pass prefabAction: 'instantiate' | 'create' | 'detach' ` +
      "| 'overrides' | 'apply' | 'revert' | 'edit-open' | 'edit-save' | 'edit-exit' " +
      "(the name is `prefabAction`, not `action`: /api/editor-action spends `action` on the op name).",
    );
  });

  // ── Phase D: particle / animation first-pass editing (Claude scaffolds, human refines) ──

  // Move the animation playhead (scrub) — drives preview + record insertion point.
  registerAgentOp('set-playhead', (params) => {
    // This op writes the playhead NUMBER and nothing else. The human scrub path
    // (AnimationEditor `scrub`) additionally clamps to the clip, leaves preview-playing, enters
    // scrub mode, opens a revert snapshot, and POSES the rig — so the description's promise that
    // this "drives the live preview" was false: a render taken after it shows the unchanged pose.
    // Say what actually happened instead of implying the rest (§5), and at least clamp the number
    // so it means the same thing it does on the human path.
    const { t } = (params ?? {}) as { t?: unknown };
    // A non-number used to become 0 (`Number(t) || 0`) and answer ok — `pose-clip` refuses the same input.
    if (typeof t !== 'number' || !Number.isFinite(t)) {
      throw new OpRefusal('REFUSED_BY_OP', `set-playhead: t must be a finite number of seconds — got ${JSON.stringify(t)}. The playhead did not move.`);
    }
    const st = useEditorStore.getState();
    const clip = st.editingAnimationClip as { duration?: number; name?: string } | null | undefined;
    // The playhead is SHARED: the Animation editor and the Timeline editor both read it. So "nothing
    // to drive" means neither has a document loaded.
    const timeline = st.editingTimelineDoc ? st.editingTimelineAsset?.path ?? '(unsaved timeline)' : null;
    // #1213: with nothing loaded the value drove nothing, and the op still answered ok (with a note
    // naming the wrong opener). Refused now, the way `pose-clip` refuses the same state.
    if (!clip && !timeline) {
      throw new OpRefusal('NOT_FOUND',
        'set-playhead: no animation clip or timeline is open in the editor, so the playhead drives nothing — it did not move.',
        { options: [`${ASSET_EDITORS.animation.opener} opens a clip — then retry`, 'open a timeline in the Timeline editor (a Director\'s timeline field in the Inspector) — then retry'] });
    }
    const asked = t;
    const clamped = clip?.duration != null ? Math.max(0, Math.min(clip.duration, asked)) : Math.max(0, asked);
    st.setPlayhead(clamped);
    return {
      ok: true,
      playhead: useEditorStore.getState().playheadTime,
      ...(clamped !== asked ? { clampedFrom: asked, duration: clip?.duration } : {}),
      /** Did anything get POSED? No — this moves the editor's playhead value only. */
      posed: false,
      boundClip: clip?.name ?? null,
      ...(timeline ? { boundTimeline: timeline } : {}),
      note: `Playhead moved to ${clamped}s for ${clip ? `clip "${clip.name ?? '(unnamed)'}"` : `timeline ${timeline}`}. This does NOT pose anything — the value moved, the viewport did not. A render/capture taken now shows the UNCHANGED pose.`,
    };
  });

  // ── pose-clip (#288 gap 2) — the pose `set-playhead` deliberately does NOT do ──
  //
  // Registered HERE and not in agentBridge, correctly under §9: the handler reaches the editor
  // store for the bound clip/root and the editor's preview envelope. There is no device analogue,
  // and that absence is deliberate rather than a gap — a device build has no Animation panel, no
  // preview session, and nothing to revert a pose to.
  registerAgentOp('pose-clip', async (params) => {
    const { t } = (params ?? {}) as { t?: number };
    if (typeof t !== 'number' || !Number.isFinite(t)) {
      return {
        ok: false, code: 'REFUSED_BY_OP', error: `pose-clip requires a finite t (seconds); got ${JSON.stringify(t)}`,
        options: ['pass t as a number of seconds, e.g. {t: 0.5}'],
      };
    }
    const st = useEditorStore.getState();
    const clip = st.editingAnimationClip as (AnimationClipDef & { name?: string }) | null | undefined;
    const rootId = st.animatorRootEntityId;
    // Two DIFFERENT missing preconditions, and collapsing them would send the caller to the wrong
    // fix — "open a clip" versus "bind it to an entity".
    if (!clip) {
      return {
        ok: false, code: 'NOT_FOUND',
        error: 'no animation clip is open in the editor, so there is nothing to sample a pose from.',
        options: ['modoki_open_animation_editor {path:"/assets/…/x.anim.json"} opens a clip — then retry'],
      };
    }
    if (rootId == null) {
      return {
        ok: false, code: 'NOT_FOUND', boundClip: clip.name ?? null,
        error: `the clip "${clip.name ?? '(unnamed)'}" is open but is not BOUND to an entity, so there is nothing to pose.`,
        // Named in AGENT tools (#1212 A-14): the bind resolves at OPEN time, from an Animator whose
        // `clips` bank lists this clip, else from a selected entity carrying an Animator.
        options: [
          'modoki_set_selection an entity that carries an Animator, then modoki_open_animation_editor again — the bind resolves when the clip is opened (re-opening resets the playhead and any pose)',
          'or add this clip to an Animator\'s `clips` bank with modoki_mutate_scene, then reopen it',
        ],
      };
    }
    const duration = clip.duration;
    const clamped = duration != null ? Math.max(0, Math.min(duration, t)) : Math.max(0, t);
    st.setPlayhead(clamped);
    // Await it: the session begin serializes the authored world, so a first pose lands a tick
    // later. Replying before that would report a pose the caller's next read cannot see — and the
    // natural next call after posing is exactly such a read.
    const { applied, openedSession, refused } = await poseClipAtTime(clip, rootId, clamped, 'animation');
    if (refused) {
      return {
        ok: false, code: 'REFUSED_BY_OP', playhead: clamped, boundClip: clip.name ?? null,
        ...(clamped !== t ? { clampedFrom: t, duration } : {}),
        error: 'the scene was being restored (a preview closing, or Play stopping) or the envelope was '
          + 'exited when this pose tried to open its session, so nothing was posed.',
        options: ['pose again once the restore has landed (it takes one scene reload)'],
      };
    }
    if (applied === 0) {
      // The pose ran and moved NOTHING. §5: a no-op is a failure when the caller asked for a
      // change. Reporting ok here would be the false success the whole envelope exists to avoid —
      // and the likeliest causes are both actionable.
      return {
        ok: false, code: 'REFUSED_BY_OP', playhead: clamped, boundClip: clip.name ?? null,
        // The clamp is reported on the FAILURE path too. The caller asked for a `t` and the
        // playhead now holds a different number; leaving that unexplained on the one path where
        // they are already debugging is the worst place to drop it.
        ...(clamped !== t ? { clampedFrom: t, duration } : {}),
        error: `the pose applied 0 channels at t=${clamped}s — nothing in the live world moved.`,
        options: [
          'the clip may have no tracks that resolve against the bound entity (check the track paths)',
          'the bound root may have been destroyed by a scene reload — re-bind it',
        ],
      };
    }
    return {
      ok: true, posed: true, applied, playhead: clamped, openedSession,
      boundClip: clip.name ?? null,
      ...(clamped !== t ? { clampedFrom: t, duration } : {}),
      saved: false,
      // Two envelopes, two ways out (#1546): during Play the pose goes into the PLAY world and opens
      // no preview session, so ⏹ Exit Preview / exit-pose-envelope have nothing to revert — Stop does.
      note: getRunMode() === 'playing'
        ? 'The rig is posed inside PLAY (no preview session opens while playing): Stop reverts it with '
          + 'the rest of the play session, and a scene save is refused until then. It is NOT an undo-stack entry.'
        : 'The rig is posed INSIDE the preview envelope, so this is revertible (⏹ Exit Preview) '
          + 'and a scene save cannot bake it. It is NOT an undo-stack entry — Cmd-Z does not reach it.',
    };
  });

  // The way OUT of the envelope `pose-clip` opens. Not optional scope: the envelope pins the
  // run-mode at `scrub`, which is exactly what blocks the human's Cmd+S — so an agent that could
  // pose and not un-pose would wedge the editor with no way back but the ⏹ button it cannot press.
  //
  // ⚠️ IT ALWAYS RESTORES, and there is deliberately no `restore:false`. An earlier cut of this op
  // exposed one, mirroring `endTimelinePreviewSession`'s parameter. But EVERY human path passes
  // `restore:true` — verified, all five call sites in AnimationEditor plus all three in
  // TimelineEditor — so the flag would have handed an agent a capability the editor's own UI has
  // no way to reach, and the only thing that capability does is BAKE a preview pose into the
  // authored world. That is the exact damage the envelope exists to prevent, and the damage that
  // actually cost the owner data (2026-08-19). An agent that genuinely wants those values authored
  // has the ordinary, undoable route: read them back and write them with modoki_set_transform /
  // modoki_mutate_scene. Adding a second, weaker way to do a dangerous thing is the §2/§7 failure
  // this workstream already refused once, for `create_registered_asset {kind:'scene'}`.
  registerAgentOp('exit-pose-envelope', async () => {
    const { exited, rebound } = await exitPoseEnvelope(true);
    if (!exited) {
      // Ownership-guarded: the session and the run-mode are globals shared with the Timeline
      // panel, and ending ITS session here would revert its world mid-run. Say WHICH it is (#1212
      // A-11): the two causes used to share one NOT_AVAILABLE_HERE — "could not look, relaunch" —
      // with the discriminator in prose, and they have different next steps. `exitPoseEnvelope`
      // changes nothing when it does not exit, so the owner read here is the one it refused on.
      const owner = getModeOwner();
      if (owner && owner !== 'animation') {
        return {
          ok: false, code: 'REFUSED_BY_OP', modeOwner: owner,
          error: `the ${owner} panel owns the preview envelope, not the Animation side — this op `
            + 'deliberately will not end it, because reverting its world mid-run is worse than refusing.',
          // ⚠️ A timeline envelope DOES have an agent exit. The same text as `/api/scene-mutate`'s
          // timeline arm (editorBackendRouter.ts) — keep the two in step; that arm's comments carry
          // the history of denying this exit once already.
          options: owner === 'timeline'
            ? [
              "modoki_play_control {action:'stop'} — ends the Timeline preview session and returns the run-mode to stopped. ⚠️ DESTRUCTIVE: it restores the snapshot taken when the envelope opened, discarding anything the human authored inside it. Prefer asking them if they are at the screen",
              'modoki_get_editor_state.modeOwner says who holds the envelope now',
            ]
            : [`⏹ Exit Preview in the ${owner} panel (a human action) — then retry`],
        };
      }
      // No owner is not "stopped": Play holds no owner (enterScrub/PreviewMode are no-ops while
      // playing), and a restore in flight briefly leaves the run-mode set with the owner cleared.
      // "The authored world is already showing" is false in both.
      const runMode = getRunMode();
      if (runMode !== 'stopped') {
        return {
          ok: false, code: 'REFUSED_BY_OP', runMode,
          error: `no preview envelope is open, but the editor is ${runMode === 'playing' ? 'PLAYING' : `in ${runMode} with no owner (an envelope is closing or seating)`} — so the authored world is not what is showing, and a scene save is still refused.`,
          options: runMode === 'playing'
            ? ["modoki_play_control {action:'stop'} — ends Play and restores the authored world"]
            : ['retry in a moment — the run-mode settles once the restore lands', 'modoki_get_editor_state.runMode shows when it has'],
        };
      }
      return {
        ok: false, code: 'NOT_FOUND',
        error: 'no preview envelope is open, so there was nothing to exit — the authored world is already showing.',
        options: [
          'nothing to do: a scene save works as it is',
          'modoki_pose_clip opens an Animation envelope, if a pose was what you expected to find',
        ],
      };
    }
    return {
      ok: true, exited: true, restored: true,
      ...(rebound != null ? { reboundRootEntityId: rebound, reboundRootGuid: liveGuidOf(rebound) } : {}),
      note: 'Envelope closed and the authored world restored. The run-mode is back to stopped, so a scene save works again.',
    };
  });

  // ── creatable assets (#288 gap 5) — the Assets panel's "New X" surface ──
  //
  // Two ops, not one mode-switched op. §7 forbids a `list` MODE on a mutating tool; it does not
  // forbid a SIBLING read, and this surface already has four (list_traits/actions/assets/scenes).
  // The case for discovery being its own read is stronger than usual here: the registry is
  // dynamic, game-extensible, and COMES AND GOES WITH THE OPEN PROJECT, so it is precisely what
  // an agent cannot know a priori — and discovery-by-refusal would mean the only way to learn the
  // kinds is to deliberately issue a failing mutating call.
  registerAgentOp('list-creatable-assets', () => {
    const defs = getCreatableAssets();
    return {
      ok: true,
      totalCount: defs.length,
      kinds: defs.map((d) => ({
        kind: d.id,
        label: d.label,
        ext: d.ext,
        assetType: d.assetType,
        defaultFolder: d.defaultFolder ?? null,
        // Say WHICH ones the create op refuses, here, rather than only in the refusal. A caller
        // planning a batch needs to know before it runs, not after a step fails.
        agentCreatable: !d.create,
        ...(d.create ? { refusedBecause: 'a full create OVERRIDE that runs editor code (for scene: it DISCARDS the live world). Use modoki_new_scene, or the Assets panel.' } : {}),
      })),
    };
  });

  registerAgentOp('create-registered-asset', async (params) => {
    const p = (params ?? {}) as { kind?: string; path?: string };
    if (!p.kind || typeof p.kind !== 'string') {
      return { ok: false, code: 'REFUSED_BY_OP', error: 'create-registered-asset requires { kind, path }', options: getCreatableAssets().map((d) => d.id) };
    }
    if (!p.path || typeof p.path !== 'string') {
      return { ok: false, code: 'REFUSED_BY_OP', error: 'create-registered-asset requires a `path` (an asset-root URL, e.g. /assets/materials/new.mat.json). This op deliberately takes an explicit path instead of opening the native save dialog, which is a BLOCKING osascript panel on macOS.' };
    }
    const r = await createRegisteredAsset(p.kind, p.path);
    if (!r.ok) return r;
    // Run the def's own post-create hook, exactly as the panel does — it is what opens the new
    // asset in its editor / selects it. Skipping it would make the agent path quietly different
    // from the human one, which is the divergence sharing `createRegisteredAsset` exists to avoid.
    try { r.def.onCreated?.({ path: r.path, name: r.name, guid: r.guid }); }
    catch (e) { console.debug('[create-registered-asset] onCreated hook failed', e); }
    return {
      ok: true, saved: true, kind: p.kind, path: r.path, name: r.name, guid: r.guid,
      manifestRebuilt: r.manifestRebuilt,
      // Derived from the flag beside it (#1214 A-15): a fixed sentence said "rebuilt" while
      // `manifestRebuilt:false` said the opposite.
      note: 'The file is written and its GUID registered. Verify with modoki_list_assets (filter by name) — '
        + (r.manifestRebuilt
          ? 'the backend manifest was rebuilt BEFORE this reply, so a check issued straight after sees it. '
          : 'the backend manifest rebuild did NOT run (/api/rescan-assets failed), so a check issued straight after may not see it yet; the file watcher catches up within a few seconds. ')
        + 'NOT modoki_resolve_refs, which resolves ENTITY refs and never answers about an asset guid.',
    };
  });

  // Replace a particle effect def — applies LIVE (cache) AND persists to disk (or, in
  // 'manual' mode, parks the write in the dirty-asset registry — Phase 3).
  registerAgentOp('particle-set', async (params) => {
    const { path, def } = (params ?? {}) as { path?: string; def?: unknown };
    if (!path || !def) throw new Error('particle-set requires { path, def }');
    const missing = requireExistingAsset(path, 'particle-set', 'particle');
    if (missing) return missing;
    const { errors, warnings } = validateAssetData('particle', def);
    if (errors.length) return { ok: false, errors, warnings };
    type ParticleDef = Parameters<ReturnType<typeof useEditorStore.getState>['applyParticleDef']>[1];
    const applyParticle = (d: ParticleDef) => useEditorStore.getState().applyParticleDef(path, d);
    const prevParticle = getParticleEffect(path) as ParticleDef | undefined;
    applyParticle(def as ParticleDef);
    pushAssetUndo(`Edit particle ${path.split('/').pop()}`, prevParticle, def as ParticleDef, applyParticle, path, 'particle');
    const saved = await persistOrMarkDirty(path, 'particle', def);
    return { ok: true, saved, warnings };
  });

  // Replace an animation clip — normalize, apply LIVE, persist (or park — Phase 3).
  registerAgentOp('anim-set-clip', async (params) => {
    const { clipPath, clip } = (params ?? {}) as { clipPath?: string; clip?: unknown };
    if (!clipPath || !clip) throw new Error('anim-set-clip requires { clipPath, clip }');
    const missingClip = requireExistingAsset(clipPath, 'anim-set-clip', 'animation');
    if (missingClip) return missingClip;
    const norm = normalizeAnimationClip(clip as Partial<AnimationClipDef>);
    const applyClip = (c: typeof norm) => useEditorStore.getState().applyAnimationClip(clipPath, c);
    const prevClip = getAnimationClip(clipPath) as typeof norm | undefined;
    applyClip(norm);
    pushAssetUndo(`Edit clip ${clipPath.split('/').pop()}`, prevClip, norm, applyClip, clipPath, 'animation');
    const saved = await persistOrMarkDirty(clipPath, 'animation', norm);
    return { ok: true, saved, tracks: norm.tracks.length };
  });

  // Add/update one keyframe at a time — the granular "first-pass timing" primitive.
  // Creates the track if absent. Applies LIVE + persists (or parks — Phase 3).
  registerAgentOp('anim-add-key', async (params) => {
    const p = (params ?? {}) as { clipPath?: string; path?: string; trait?: string; field?: string; time?: number; value?: unknown; type?: TrackValueType };
    if (!p.clipPath || !p.trait || !p.field || p.time == null) {
      throw new Error('anim-add-key requires { clipPath, trait, field, time, value }');
    }
    let clip = getAnimationClip(p.clipPath) as AnimationClipDef | null;
    if (!clip) {
      // Route through `assetUrl` like every other asset reader (`animationClipCache.ts` included) —
      // a raw `fetch(path)` resolves to the wrong URL under a non-"/" BASE_URL (sub-path hosting,
      // the packaged editor's custom scheme). Catch a REJECTING fetch (network error, dev server
      // down) the same as a `!res.ok` one: either way it unwinds past the live-cache peek below,
      // and the fetch is only a cache-miss fallback — the panel opening this clip, or a concurrent
      // agent op for the same path landing mid-flight, can populate the live cache with content
      // that is NEWER than (or simply present despite) whatever this fetch did or didn't get. #521.
      const res = await fetch(assetUrl(p.clipPath), { cache: 'no-store' }).catch(() => null);
      const live = getAnimationClip(p.clipPath) as AnimationClipDef | null;
      if (!res?.ok && !live) throw new Error(`cannot load clip ${p.clipPath}`);
      clip = live ?? normalizeAnimationClip(await res!.json());
    }
    // Deep-copy tracks/keys so we don't mutate the cached clip in place.
    const next: AnimationClipDef = { ...clip, tracks: clip.tracks.map((t) => ({ ...t, keys: [...t.keys] })) };
    const relPath = p.path ?? '';
    let track = findTrack(next.tracks, relPath, p.trait, p.field);
    if (!track) { track = { path: relPath, trait: p.trait, field: p.field, type: p.type ?? 'number', keys: [] }; next.tracks.push(track); }
    track.keys = upsertKey(track.keys, Number(p.time), encodeValue(track.type, p.value));
    const keyClipPath = String(p.clipPath);
    const applyKeyClip = (c: typeof next) => useEditorStore.getState().applyAnimationClip(keyClipPath, c);
    const prevKeyClip = getAnimationClip(keyClipPath) as typeof next | undefined;
    applyKeyClip(next);
    pushAssetUndo(`Add key ${keyClipPath.split('/').pop()}`, prevKeyClip, next, applyKeyClip, keyClipPath, 'animation');
    const saved = await persistOrMarkDirty(p.clipPath, 'animation', next);
    return { ok: true, saved, tracks: next.tracks.length, keys: track.keys.length };
  });

  // Replace a whole timeline — normalize, apply LIVE (the panel + runtime cache), persist
  // (or park — Phase 3).
  registerAgentOp('timeline-set', async (params) => {
    const { timelinePath, timeline } = (params ?? {}) as { timelinePath?: string; timeline?: unknown };
    if (!timelinePath || !timeline) throw new Error('timeline-set requires { timelinePath, timeline }');
    const missingTl = requireExistingAsset(timelinePath, 'timeline-set', 'timeline');
    if (missingTl) return missingTl;
    const before = countTimelineItems(timeline as Partial<TimelineDef>);
    const norm = normalizeTimeline(timeline as Partial<TimelineDef>);
    const after = countTimelineItems(norm);
    // normalizeTimeline silently DROPS malformed items WITHIN a track (span end<=start, empty clip/
    // action name, missing audio GUID). Counting surviving TRACKS hid that — a set that lost half its
    // items reported {ok:true, tracks:N}. Mirror timeline-add-clip's pre/post guard so a rejected item
    // is a visible failure, and DON'T persist a lossy write. (F12)
    if (after < before) {
      throw new Error(`timeline-set: ${before - after} of ${before} item(s) rejected by normalization (malformed — span end<=start, empty clip/action name, or missing audio clip GUID). Nothing was saved; fix the items and retry.`);
    }
    const applyTl = (t: typeof norm) => useEditorStore.getState().applyTimelineDoc(timelinePath, t);
    const prevTl = getTimeline(timelinePath) as typeof norm | undefined;
    applyTl(norm);
    pushAssetUndo(`Edit timeline ${timelinePath.split('/').pop()}`, prevTl, norm, applyTl, timelinePath, 'timeline');
    const saved = await persistOrMarkDirty(timelinePath, 'timeline', norm);
    return { ok: true, saved, tracks: norm.tracks.length, items: after };
  });

  // Add ONE item (clip / marker / cue / span) to a timeline track (creating the track if absent).
  // Applies LIVE + persists. `item` is the raw per-kind body; normalization drops it if malformed.
  registerAgentOp('timeline-add-clip', async (params) => {
    const p = (params ?? {}) as { timelinePath?: string; trackType?: TrackKind; target?: string; item?: Record<string, unknown> };
    if (!p.timelinePath || !p.trackType || !p.item) {
      throw new Error('timeline-add-clip requires { timelinePath, trackType, item }');
    }
    let def = getTimeline(p.timelinePath) as TimelineDef | null;
    if (!def) {
      // Route through `assetUrl` like every other asset reader (`timelineCache.ts` included) — a
      // raw `fetch(path)` resolves to the wrong URL under a non-"/" BASE_URL (sub-path hosting, the
      // packaged editor's custom scheme). Catch a REJECTING fetch (network error, dev server down)
      // the same as a `!res.ok` one: either way it unwinds past the live-cache peek below, and the
      // fetch is only a cache-miss fallback — the panel opening this timeline, or a concurrent agent
      // op for the same path landing mid-flight, can populate the live cache with content that is
      // NEWER than (or simply present despite) whatever this fetch did or didn't get. #521.
      const res = await fetch(assetUrl(p.timelinePath), { cache: 'no-store' }).catch(() => null);
      const live = getTimeline(p.timelinePath) as TimelineDef | null;
      if (!res?.ok && !live) throw new Error(`cannot load timeline ${p.timelinePath}`);
      def = live ?? normalizeTimeline(await res!.json());
    }
    const target = p.target ?? '';
    const clone = JSON.parse(JSON.stringify(def)) as TimelineDef;
    let track = clone.tracks.find((t) => t.type === p.trackType && (t.target ?? '') === target);
    if (!track) {
      const base = { id: `track-${clone.tracks.length}`, name: p.trackType, target } as const;
      track = (p.trackType === 'animation' ? { ...base, type: 'animation', clips: [] }
        : p.trackType === 'signal' ? { ...base, type: 'signal', markers: [] }
        : p.trackType === 'audio' ? { ...base, type: 'audio', cues: [] }
        : p.trackType === 'control' ? { ...base, type: 'control', clips: [] }
        : p.trackType === 'video' ? { ...base, type: 'video', clips: [] }
        : { ...base, type: 'activation', spans: [] }) as TrackDef;
      clone.tracks.push(track);
    }
    // Push the item into the track's per-kind array.
    const arrKey = p.trackType === 'animation' || p.trackType === 'control' || p.trackType === 'video' ? 'clips' : p.trackType === 'signal' ? 'markers' : p.trackType === 'audio' ? 'cues' : 'spans';
    if (track.type === 'animation') track.clips.push(p.item as unknown as (typeof track.clips)[number]);
    else if (track.type === 'signal') track.markers.push(p.item as unknown as (typeof track.markers)[number]);
    else if (track.type === 'audio') track.cues.push(p.item as unknown as (typeof track.cues)[number]);
    else if (track.type === 'control') track.clips.push(p.item as unknown as (typeof track.clips)[number]);
    else if (track.type === 'video') track.clips.push(p.item as unknown as (typeof track.clips)[number]);
    else track.spans.push(p.item as unknown as (typeof track.spans)[number]);
    const wantCount = (track as unknown as Record<string, unknown[]>)[arrKey].length;
    const norm = normalizeTimeline(clone);
    // normalizeTimeline DROPS malformed items (span end<=start, empty clip/action) — so verify the
    // pushed item actually survived instead of reporting a false success the agent can't detect.
    const normTrack = norm.tracks.find((t) => t.type === p.trackType && (t.target ?? '') === target);
    const gotCount = normTrack ? (normTrack as unknown as Record<string, unknown[]>)[arrKey].length : 0;
    if (gotCount < wantCount) {
      throw new Error('timeline-add-clip: item rejected by normalization — malformed for a ' + p.trackType + ' track (need: animation clip name non-empty · signal action non-empty · audio clip GUID non-empty · activation end > start · control prefab GUID non-empty OR particle:true OR subdirector:true \u00b7 video clip GUID non-empty)');
    }
    const tlClipPath = String(p.timelinePath);
    const applyTlClip = (t: typeof norm) => useEditorStore.getState().applyTimelineDoc(tlClipPath, t);
    const prevTlClip = getTimeline(tlClipPath) as typeof norm | undefined;
    applyTlClip(norm);
    pushAssetUndo(`Add timeline clip ${tlClipPath.split('/').pop()}`, prevTlClip, norm, applyTlClip, tlClipPath, 'timeline');
    const saved = await persistOrMarkDirty(p.timelinePath, 'timeline', norm);
    return { ok: true, saved, tracks: norm.tracks.length, items: gotCount };
  });

  /** Read an asset definition back — the READ half of the asset-editor surface.
   *
   *  Why it exists: `particle-set` / `anim-set-clip` / `timeline-set` all require the FULL
   *  definition, and until now nothing in the agent surface returned one. Two consequences,
   *  both found running batch use case 6:
   *
   *  1. To change ONE field you had to obtain the def from outside the tool surface (read the
   *     `.particle.json` off disk and map an asset-root URL to a filesystem path by hand) — which
   *     a packaged or remote editor cannot do at all.
   *  2. You could not VERIFY an asset edit. The write returned `{ok:true}` and the only suggested
   *     check was `render_sequence`, i.e. judging by PIXELS — exactly what
   *     `docs/debug-tools-mcp.md` tells an agent not to do.
   *
   *  Reads the LIVE cache, not the file, and that distinction is the point: persistence is manual,
   *  so an unsaved edit exists ONLY live. A file read would report the pre-edit value and make a
   *  successful edit look like it did nothing. `source` says which the answer came from. */
  /** Repair the renderer's path-keyed state after a move the RENDERER did not perform (#867).
   *
   *  `POST /api/move-file` is the one place a move happens, and until now the repair
   *  (`applyAssetPathMoves`) was wired to the thirteen client-side CALL SITES instead — so a move
   *  from anywhere else silently repaired nothing. `modoki_move_asset` is exactly that case, and
   *  it is not a forgotten line: the MCP server is a different PROCESS from the renderer, so the
   *  repair was never reachable from there at all.
   *
   *  The route calls this back through `requestBrowser`, the same server→renderer RPC ~20 other
   *  routes use, which is already abstracted over both transports (Vite HMR and Electron IPC).
   *
   *  Applying a move twice is a no-op — `applyMove` matches on `from`, and after the first pass
   *  nothing is at `from` any more — so the panel keeping its own synchronous call is safe. It
   *  keeps it because ORDER matters there: the registry must be repaired before the selection
   *  moves, since `AtlasAssetView`'s load effect keys on the selected path for its CAS baseline.
   *  This op is the backstop for every caller that is not the panel. */
  registerAgentOp('apply-asset-path-moves', (params) => {
    const { moves } = (params ?? {}) as { moves?: PathMove[] };
    if (!Array.isArray(moves) || moves.length === 0) {
      throw new Error('apply-asset-path-moves requires { moves: [{from, to, prefix?}] }');
    }
    for (const m of moves) {
      if (typeof m?.from !== 'string' || (typeof m?.to !== 'string' && m?.to !== null)) {
        throw new Error('apply-asset-path-moves: each move needs { from: string, to: string | null }');
      }
    }
    // The notes are the repair's own account of what it touched — empty when the move hit nothing
    // bound, parked or selected, which is the overwhelmingly common case.
    return { ok: true, notes: applyAssetPathMoves(moves) };
  });

  registerAgentOp('read-asset-def', (params) => {
    const { path, type } = (params ?? {}) as { path?: string; type?: string };
    if (!path) throw new Error('read-asset-def requires { path }');
    const resolved = resolveAssetDefKind(path, type);
    if (!('kind' in resolved)) throw new OpRefusal(resolved.code, resolved.error, { options: resolved.options });
    const { kind } = resolved;
    if (kind === 'material') {
      // material is NOT genuinely peekable — `materialCache` (meshTemplateCache.ts) holds only the
      // BUILT `THREE.Material` once `fetchMaterial` parses the `.mat.json`; the raw JSON itself is
      // never retained anywhere live (the panel's `invalidateMaterialFile` only invalidates the
      // compiled material for a lazy recompile; it does not re-seed a JSON doc the way
      // `invalidateAnimSetFile` does for animset). Refuse explicitly, matching the device surface's
      // wording, rather than falling through to the generic "not in the live cache" refusal below.
      throw new Error(
        "read-asset-def: material defs are not readable from the live cache — only the compiled THREE.Material is retained, the authored .mat.json is discarded once built. Read the file directly (it is the authoritative copy; a parked edit shows in modoki_get_editor_state's dirtyAssetPaths).",
      );
    }
    // PEEK, don't load. This op reports what is in the LIVE cache — it has no business fetching.
    // The plain getters treat a miss as "not loaded YET" and kick off a background fetch, so asking
    // about an asset that does not exist queued a load that could only fail and logged
    // `[particleCache] failed to load …` into the human's console — for a question this op then
    // answered with a refusal anyway. The MCP live sweep reads a deliberately-absent probe path on
    // every run, so it did that on every run.
    const peek = { load: false } as const;
    const def =
      kind === 'particle' ? getParticleEffect(path, peek)
      : kind === 'animation' ? getAnimationClip(path, peek)
      : kind === 'timeline' ? getTimeline(path, peek)
      : kind === 'spriteanim' ? getSpriteAnim(path, peek)
      // rig2d reports the AUTHORED doc, not the parsed runtime rig. Every other kind's cache
      // holds the file's own JSON; rig2d's holds packed Float32Arrays with the weights already
      // renormalized, so this op used to answer a question about the ASSET with the deform
      // driver's input — float32 weights, v1 rigs silently promoted to v2 parts. A QA run read
      // those numbers as the editor corrupting the rig on load (QA-ASSET-0015). `?? getRig2D`
      // keeps the "is it in the live cache at all?" answer identical for a rig seeded by an
      // older path that never recorded a source.
      : kind === 'rig2d' ? (getRig2DSource(path) ?? getRig2D(path, peek))
      // shader (#842b) — `getSpriteMaterialProgram` is a bare `Map.get`, no fetch side effect on a
      // miss, so it's exactly as peekable as the `{load:false}` getters above despite the different
      // signature. It's keyed by GUID (whatever `Renderable.material` carried when the program
      // compiled), not by path, so a path-shaped `path` (the common case — `inferAssetDefType`
      // only recognizes the `.shader.json` suffix, never a bare guid) has to be turned into a guid
      // first via the manifest's reverse lookup. `.manifest` is the authored `.shader.json` doc
      // itself (`PixiShaderProgram.manifest: ShaderManifest`) — the compiled GL/GPU program
      // alongside it is not part of the answer.
      : kind === 'shader' ? (() => {
          const guid = isGuid(path) ? path : getGuidForPath(path);
          const program = guid ? getSpriteMaterialProgram(guid) : undefined;
          return program ? program.manifest : null;
        })()
      // animset (#842b) — `getAnimSet` now takes the same `{load:false}` peek option as its
      // siblings above, so a miss reports null without fetching or sticky-poisoning `failed`.
      : kind === 'animset' ? getAnimSet(path, peek)
      : undefined;
    if (def === undefined) {
      throw new Error(
        `read-asset-def: unsupported type '${kind}' (particle | animation | spriteanim | ` +
        'timeline | rig2d | shader | animset).',
      );
    }
    if (def === null) {
      // NOT an empty answer: nothing has loaded this asset into the live cache, so there is no
      // live def to report. Saying so beats returning null, which reads as "the asset is empty".
      throw new Error(
        `read-asset-def: '${path}' is not in the live ${kind} cache — nothing in the open scene ` +
        'has loaded it yet. Load a scene that uses it (or open its editor panel) first.',
      );
    }
    const dirty = getDirtyAssetPaths().includes(path);
    return { ok: true, path, type: kind, source: 'live', unsaved: dirty, def };
  });

  /** Read an asset's `.meta.json` sidecar, PREFERRING a parked Inspector edit over disk (#872).
   *
   *  The sidecar twin of `read-asset-def` above, and it exists for the same reason one layer over:
   *  since #845 an Inspector import-settings change PARKS instead of writing, so the file on disk
   *  is the PRE-EDIT document for as long as the park is unflushed. `modoki_get_asset_meta` was a
   *  plain `/api/read-meta` GET straight to the Node backend — no `op:`, so it never reached the
   *  renderer at all — and an agent therefore read a stale value with no way to know a newer one
   *  existed. It then reasoned from it, or wrote it back.
   *
   *  ⚠️ The sibling registry has a safety net this one structurally cannot have. An agent
   *  `modoki_write_asset` is reconciled by the watcher (`dropParkedWriteFor` in `agentBridge.ts`),
   *  but `.meta.json` is invisible to `detectType` (`vite-asset-scanner.ts`), so no broadcast
   *  fires for a sidecar and nothing reconciles anything. That is why the READ being honest
   *  matters more here than it does for an asset doc.
   *
   *  `readMetaPreferringPark` is deliberately the same helper the panels use — it prefers the
   *  park — but it is called `passive`, so it records NOTHING.
   *
   *  ⚠️ **That is a correction to this op's first version, which let the read seed the baseline on
   *  the grounds that it was "a genuine read by this editor and correct to record". The inference
   *  does not hold.** A baseline is a claim about the bytes a PANEL's displayed document came
   *  from, and the flush conditions the human's next save on it; this read feeds no panel. Before
   *  #872 the tool ran in the Node process and could not touch that map at all, so seeding here
   *  was a new fail-open introduced by the fix: panel reads V1 → something external rewrites the
   *  sidecar → the agent reads (baseline → EXTERNAL) → the human's parked edit, built on the
   *  stale in-memory doc, is now ACCEPTED and overwrites the external change, where without the
   *  agent's read it was correctly refused. An observer must not disarm the guard it observes.
   *
   *  `source` is computed BEFORE the read, from the registry, so it describes where the answer
   *  came from rather than being inferred from its shape ({} is ambiguous — see `readMetaSidecar`,
   *  which returns it for an absent sidecar AND an unparsable one, #778). */
  registerAgentOp('read-asset-meta', async (params) => {
    const { path } = (params ?? {}) as { path?: string };
    if (!path) throw new Error('read-asset-meta requires { path } (an asset-root URL, e.g. /assets/textures/rock.png)');
    const parked = peekPendingMeta(path) !== undefined;
    const r = await readMetaPreferringPark(path, { passive: true });
    return {
      ok: true,
      path,
      meta: r.meta,
      source: parked ? 'parked' : 'disk',
      unsaved: parked,
      // ⚠️ `ok:false` from the helper means the GET FAILED and `meta` is a `{}` FALLBACK — NOT an
      // empty sidecar. An agent about to write this document back wholesale must abort on it, or
      // it posts a sidecar with no `id` and the scanner's heal pass mints a NEW guid, orphaning
      // every scene ref to the asset. Same warning `PreferredMetaRead.ok` carries; surfaced here
      // because across the relay the caller cannot see the helper's own return.
      read: r.ok ? 'ok' : 'failed',
      ...(parked
        ? { note: 'A parked Inspector import-settings edit for this path has NOT reached disk. This is that edit, not the file. modoki_save_all flushes it; modoki_get_editor_state lists it under pendingImportSettings.' }
        : {}),
      ...(r.ok ? {} : { note: 'The /api/read-meta GET FAILED — `meta` is an empty FALLBACK, not an empty sidecar. Do NOT write this document back: a wholesale write built on it drops the asset GUID and the scanner then mints a new one, orphaning every reference.' }),
    };
  });

  /** The four kinds of unsaved state a Node route can be blind to (#889).
   *
   *  This is the vocabulary the Node side speaks; `CAUSE_REGISTRY` below is what ties it to the
   *  renderer's own accounting so the two cannot drift. */
  type UnsavedRegistry = 'dirtyAsset' | 'pendingMeta' | 'pendingBaseScene' | 'liveScene' | 'openAssetEditor';
  /** ⚠️ `liveScene` is absent BY TYPE, not by a runtime check — see the op's header. So is
   *  `openAssetEditor` (#1362): there is nothing to discard, because the Sprite and 9-slice editors
   *  hold their edits in component state with Save and Cancel as the only exits (owner,
   *  2026-08-18). A discard here could only mean "throw the modal's work away", which is the
   *  behaviour the move refusal exists to prevent. */
  type DiscardableRegistry = Exclude<UnsavedRegistry, 'liveScene' | 'openAssetEditor'>;
  const ALL_REGISTRIES: readonly UnsavedRegistry[] =
    ['dirtyAsset', 'pendingMeta', 'pendingBaseScene', 'liveScene', 'openAssetEditor'];

  /** Reported as the `path` of a dirty live world that has no file — a never-saved scene, or a
   *  prefab-edit world whose guid resolves to no manifest entry. Deliberately NOT a path shape: a
   *  path-scoped caller must not match it, and a reader must not mistake it for a file. */
  const PATHLESS_DIRTY_WORLD = '(unsaved live world — no file on disk)';

  type UnsavedCauses = ReturnType<typeof unsavedChangeCauses>;

  /** Every cause `unsavedChangeCauses()` reports → the registry name it answers under.
   *
   *  ⚠️ **`satisfies Record<keyof UnsavedCauses, …>` is the load-bearing part.** Add a sixth cause
   *  in `serialize.ts` and this fails to compile until it is mapped, which is the only thing
   *  standing between this probe and the silent under-coverage that made #889 a class rather than
   *  a bug. Two causes deliberately share `liveScene`: `sceneDirty` is the PRIMARY scene (a bare
   *  boolean, no path) and `dirtyScenes` is the loaded BASES (guids). One row for both, because
   *  "does this file back a scene with unsaved live edits?" is one question to a caller. */
  const CAUSE_REGISTRY = {
    dirtyAssetPaths: 'dirtyAsset',
    pendingImportSettings: 'pendingMeta',
    pendingBaseScenes: 'pendingBaseScene',
    sceneDirty: 'liveScene',
    dirtyScenes: 'liveScene',
  } as const satisfies Record<keyof UnsavedCauses, UnsavedRegistry>;

  /** Where the dirty LIVE WORLD lives, as a path a Node route can match.
   *
   *  ⚠️ **Always a string.** This said "or `null` when it genuinely has no file yet" and no branch
   *  ever returned one — each ends in a path or `PATHLESS_DIRTY_WORLD`, which is what the marker is
   *  FOR. The prose made two guards below dead and invited a later `=== null` branch that cannot
   *  fire. (Caught in close-out review — and the commit that claimed to fix it did not: its edit
   *  script threw before writing, so the message described work that was not in the tree.)
   *
   *  ⚠️ **`getCurrentScenePath()` alone is NOT the answer, and taking it for one made this probe
   *  report a FALSE CLEAR** (#889 phases 2+3). `sceneDirty` is the live world's edit-version
   *  compared against its saved baseline — and TWO states hold that world with no scene path at
   *  all: **prefab-edit** (`serialize.ts` nulls `_currentScenePath` on purpose, so a normal save
   *  cannot target the prefab world) and a **new scene** that has never been written. Both leave
   *  `sceneDirty` true, and the old code answered `[]` for a missing path — so the reply was
   *  `holds: []` with `covers` listing all four registries, i.e. "I looked everywhere and nothing
   *  is held" while the human's prefab edits sat in memory. That is the exact fail-open this whole
   *  probe exists to close, one level in from where it was closed.
   *
   *  Measured 2026-09-09, before the fix: dirty world + `setCurrentScenePath(null)` → `holds: []`,
   *  where the same world WITH a path reports one `liveScene` row.
   *
   *  The pathless case is reported under a MARKER rather than dropped, on the rule `dirtyScenes`
   *  already follows for a guid that resolves to nothing: an unsaved new scene still changes what
   *  `/api/unused-assets` computes (its entity refs are not in the graph, so its assets look like
   *  orphans and the cleanup dialog pre-selects them), and silently omitting it would be "could not
   *  look" reported as "nothing is there". */
  const dirtyWorldTarget = (): { path: string; detail: string } => {
    const scenePath = getCurrentScenePath();
    if (scenePath) return { path: scenePath, detail: 'unsaved live-world edits in the OPEN scene' };
    // ⚠️ `isPrefabEditWorld()`, NOT `isEditingPrefab()`. This op's header says every read is a
    // PEEK — "an observer must not disarm the guard it observes" — and `isEditingPrefab()`
    // SELF-HEALS a stale flag as a side effect (it calls `closePrefabEditor()`, clearing both
    // `editingPrefab` and `prefabReturnScenePath`). `prefabEditWorld.ts` says so in as many words:
    // "unsafe to call from a probe or a guard that must not mutate editor state" — and I called it
    // from a probe anyway. It is also the GROUND TRUTH: the store flag can be set while a real
    // scene is loaded, so the pure predicate is the more correct question as well as the safe one.
    // Found in close-out review; no trigger was demonstrated, but the pure form costs nothing.
    if (isPrefabEditWorld()) {
      const editing = useEditorStore.getState().editingPrefab;
      // ⚠️ The STORE's own `path` first — it is the asset-root path `openPrefabForEditing` was
      // handed, i.e. the same spelling a Node route asks about, with no lookup to go stale. The
      // manifest is the fallback for a store entry that somehow carries only a guid, and the guid
      // itself is the last resort: reported UNDER THE GUID rather than dropped, the rule
      // `dirtyScenes` already follows, because "could not translate it" is not "nothing is held".
      const path = editing?.path ?? (editing?.guid ? getAssetEntry(editing.guid)?.path : undefined);
      // ⚠️ THREE outcomes, not two, and the third only became reachable when this branch started
      // asking the WORLD instead of the store flag. `serialize.ts` documents the state: an exit
      // whose scene reload failed leaves the world synthetic with `editingPrefab` cleared. Then
      // there is no guid either, and the old two-way detail claimed "reported by guid" when
      // nothing had been. Say which of the three actually happened.
      if (path) return { path, detail: 'unsaved live-world edits in the PREFAB open for editing' };
      if (editing?.guid) {
        return {
          path: editing.guid,
          detail: 'unsaved live-world edits in the PREFAB open for editing (reported by guid — it '
            + 'resolves to no manifest entry)',
        };
      }
      return {
        path: PATHLESS_DIRTY_WORLD,
        detail: 'unsaved live-world edits in a PREFAB-EDIT world whose editor flag is already '
          + 'cleared — the prefab cannot be named, but the world is dirty and would be written',
      };
    }
    return {
      path: PATHLESS_DIRTY_WORLD,
      detail: 'unsaved live-world edits in a scene that has never been saved (it has no file yet, '
        + 'so no route can read it — but its entities are missing from every graph computed from disk)',
    };
  };

  /** Does this cause hold something for `path`? Returns a `detail` string, `''` for "held, nothing
   *  more to say", or `null` for "not held".
   *
   *  ⚠️ **`null` vs `''` is the distinction, not truthiness.** A verdict string is always truthy
   *  and an empty one is always falsy — branching on the return value rather than on `!== null`
   *  is how a "held" row with no detail would silently vanish.
   *
   *  Same exhaustiveness contract as `CAUSE_REGISTRY`: a new cause must be given a matcher here
   *  too, or this does not compile. Mapping it in one table and forgetting the other would be a
   *  probe that names a registry it never actually inspects. */
  type CauseMatcher = (
    path: string, causes: UnsavedCauses, ctx: { dirtyWorld: { path: string; detail: string } },
  ) => string | null;
  const CAUSE_HOLDS = {
    dirtyAssetPaths: (p, c) => (c.dirtyAssetPaths.includes(p) ? 'an unsaved asset document' : null),
    pendingImportSettings: (p, c) => (c.pendingImportSettings.includes(p) ? 'unsaved import settings' : null),
    // ⚠️ Tri-state upstream: `peekBaseSceneEdit` returns `undefined` for "not pending" and `null`
    // for "pending a CLEAR". The paths list flattens that correctly — presence IS pendingness —
    // which is why this asks the list and not the peek.
    pendingBaseScenes: (p, c) => (c.pendingBaseScenes.includes(p) ? 'an unsaved baseScene ref' : null),
    // ⚠️ Matches the RESOLVED dirty-world path, not `getCurrentScenePath()` — in prefab-edit
    // that is the prefab's own path, and asking about it is exactly what `/api/validate-prefab`
    // does. Keyed off the same resolver as the global half so the two modes cannot disagree.
    sceneDirty: (p, c, x) => (
      c.sceneDirty && x.dirtyWorld.path === p ? x.dirtyWorld.detail : null),
    dirtyScenes: (p, c) => {
      // Path→guid, renderer-side, through the manifest the renderer already owns. A path that
      // resolves to no guid simply is not a scene this registry could be holding.
      const guid = getGuidForPath(p);
      return guid !== undefined && c.dirtyScenes.includes(guid)
        ? 'unsaved live-world edits in a loaded base scene' : null;
    },
  } as const satisfies Record<keyof UnsavedCauses, CauseMatcher>;

  /** The registries a caller may ask this op to DROP, and how.
   *
   *  ⚠️ Keyed by registry so `Object.keys` is the honest answer to "what can be discarded" in the
   *  refusal below — a hand-written second list there would drift from this one. `liveScene` is
   *  absent because it is not discardable at all (see the op header), and its absence from
   *  `DiscardableRegistry` is what makes that a type error rather than a runtime surprise. */
  const DISCARDERS = {
    dirtyAsset: (paths: string[]) => discardDirtyAssets(paths),
    pendingMeta: (paths: string[]) => discardPendingMeta(paths),
    pendingBaseScene: (paths: string[]) => discardPendingBaseScenes(paths),
  } as const satisfies Record<DiscardableRegistry, (paths: string[]) => { discarded: string[] }>;

  /** Every (path, detail) this cause is holding right now — the GLOBAL half of the probe.
   *
   *  ⚠️ Keyed off the same `CAUSE_*` tables as the per-path matchers, so the two modes cannot
   *  answer differently about the same state. Two causes need translating rather than listing:
   *  `sceneDirty` is a pathless boolean and gets the primary scene's own path, and `dirtyScenes`
   *  holds GUIDs, which are resolved back to paths through the manifest — a guid handed to a Node
   *  route as if it were a path would name a file that does not exist.
   *
   *  A guid that resolves to nothing is reported UNDER THE GUID rather than dropped: it still means
   *  a scene has unsaved live edits, and silently omitting it would be "could not look" reported as
   *  "nothing is there" inside the very probe written to stop that. */
  const heldPathsFor = (
    cause: keyof UnsavedCauses, causes: UnsavedCauses,
    dirtyWorld: { path: string; detail: string },
  ): Array<[string, string]> => {
    switch (cause) {
      case 'dirtyAssetPaths':
        return causes.dirtyAssetPaths.map((p) => [p, 'an unsaved asset document']);
      case 'pendingImportSettings':
        return causes.pendingImportSettings.map((p) => [p, 'unsaved import settings']);
      case 'pendingBaseScenes':
        return causes.pendingBaseScenes.map((p) => [p, 'an unsaved baseScene ref']);
      case 'sceneDirty':
        // ⚠️ NO `&& path` term. That conjunction is what made prefab-edit and a never-saved scene
        // report as CLEAR — `dirtyWorldTarget` always yields a path or the marker, so a dirty
        // world is always one row.
        return causes.sceneDirty ? [[dirtyWorld.path, dirtyWorld.detail]] : [];
      case 'dirtyScenes':
        return causes.dirtyScenes.map((guid) => {
          const path = getAssetEntry(guid)?.path;
          return path
            ? [path, 'unsaved live-world edits in a loaded base scene']
            : [guid, 'unsaved live-world edits in a loaded base scene (reported by guid — it '
              + 'resolves to no manifest entry)'];
        });
    }
  };

  /** For the argument-error message only — what is held right now, so a caller that mis-shaped its
   *  params still learns whether anything was in the way. */
  const describeHeldNow = (): string => {
    // ⚠️ Built from `heldPathsFor` + `CAUSE_REGISTRY`, NOT a hand list of the five causes (#972 P9).
    // It was one — sitting twelve lines below the `satisfies` tables that exist to forbid exactly
    // that, written by the pass that had just fixed an instance of it. Two computations of one
    // fact: the reply and this error message could describe the same state differently, and once
    // did (in prefab-edit the reply named the prefab while this said "the open scene"). Reusing the
    // resolver means a sixth cause reaches this message the day it is mapped, and means the two can
    // no longer disagree.
    const c = unsavedChangeCauses();
    const dirtyWorld = dirtyWorldTarget();
    const parts = (Object.keys(CAUSE_REGISTRY) as (keyof UnsavedCauses)[])
      .flatMap((cause) => heldPathsFor(cause, c, dirtyWorld)
        .map(([path]) => `${path} (${CAUSE_REGISTRY[cause]})`));
    return parts.join(', ') || '(nothing)';
  };

  /** **What unsaved state does this renderer hold for these paths?** The ONE probe every Node
   *  backend route uses before it treats a file's bytes as current (#889).
   *
   *  ## The mechanism this answers
   *
   *  While an editor is open, DISK IS NOT THE SOURCE OF TRUTH for asset content — the renderer is.
   *  Any Node-side decision that reads a file is wrong for exactly as long as the renderer holds a
   *  newer copy, and the Node process has no way to notice. That arrived one route at a time:
   *  `/api/write-meta` destroyed a park, `/api/reimport` baked pre-edit values, `/api/duplicate-
   *  asset` copied a pre-edit sidecar (#872/#882) and then, in its OTHER branch, a pre-edit
   *  DOCUMENT. Fixing each with its own registry probe is the shape #889 exists to prevent.
   *
   *  ## ⚠️ There are FIVE sources, and one of them is not a registry
   *
   *  The obvious list — the four modules in `editor/scene/` — is missing the most commonly edited
   *  thing in the editor. `sceneDirty.ts` tracks BASE scenes only (its own header says so); the
   *  PRIMARY scene's unsaved live-world state is `getEditVersion() !== _savedAtEditVersion`, a bare
   *  pathless boolean in `serialize.ts`. A probe built by enumerating registry modules is VACUOUS
   *  for the open scene, and nothing goes red. The name collision is what hides it: the CAUSE
   *  called `sceneDirty` is the primary, while the MODULE called `sceneDirty.ts` supplies
   *  `dirtyScenes` (the bases).
   *
   *  So the registry list is **derived from `unsavedChangeCauses()`**, which is already the
   *  single-source-of-truth total. `CAUSE_HOLDS` below `satisfies` a record over its keys, so
   *  adding a sixth cause is a COMPILE ERROR until it is mapped — rather than a probe that silently
   *  stops covering it. A hand-written list here would be `CLAUDE.md`'s "hand-maintained list of
   *  fields we read", and it would already be wrong by one.
   *
   *  ## Why the guid/path mismatch is reconciled HERE
   *
   *  `dirtyScenes` is keyed by scene GUID, the other three by asset-root URL. Node could map
   *  path→guid through the manifest, but only the renderer knows which scenes are LOADED and which
   *  is primary — and the primary's term is a boolean Node cannot compute at any key. Answering
   *  here lets Node keep paths end to end, which is what every route already holds, and avoids a
   *  second path→guid implementation beside `SceneManager`'s. Both scene cases report as one
   *  `liveScene` row.
   *
   *  ⚠️ **`liveScene` is PROBE-ONLY.** Discarding live-world edits means reloading the scene, which
   *  is `load_scene {discardUnsaved}`'s job; a second way to do it does not belong here. Encoded in
   *  the type (`DISCARDABLE`), not in prose.
   *
   *  ⚠️ **Every read is a PEEK.** `unsavedChangeCauses()` reads the registries and records nothing —
   *  the correction `read-asset-meta` carries as `passive`, and `resolve-meta-park` carried as
   *  "`peekPendingMeta`, deliberately NOT `readMetaPreferringPark`". An observer must not disarm
   *  the guard it observes, and a WRITE gate has more power to corrupt what it consults, not less.
   *
   *  ⚠️ **Probe and discard stay ONE op.** Two round trips leave a window in which a human's park
   *  lands between "is anything held?" and the write that was cleared to proceed.
   *
   *  ⚠️ **`covers` is MANDATORY in the reply.** Without it a gate talking to a SKEWED renderer —
   *  one that answers but does not implement a registry the caller asked about — is indistinguish-
   *  able from "everything is clean". Node treats a short `covers` as `unknown`, not as clear.
   *
   *  Replaces `resolve-meta-park` outright rather than sitting beside it: two ops answering one
   *  question is the parity problem in `docs/mcp-tool-conventions.md` §9, and it would leave the
   *  next author the same choice that produced #889. Version skew fails in the SAFE direction — a
   *  new backend against a stale tab gets `unknown agent op`, which Node classifies as `unknown`
   *  and refuses on. */
  registerAgentOp('resolve-unsaved', (params) => {
    const { paths, registries, discard } = (params ?? {}) as {
      paths?: unknown; registries?: unknown; discard?: unknown;
    };
    // ⚠️ `paths` OMITTED means "everything you hold", and that is a real mode rather than a
    // convenience. `/api/unused-assets` and `/api/find-references` compute over the WHOLE project
    // graph, so ANY unsaved document can change their answer — a dirty material adds a texture
    // reference, a dirty scene adds or removes one. A path-scoped probe would under-report there
    // and hand back a disclosure that looked precise and was incomplete. An EMPTY ARRAY is still
    // an error: that is a caller who meant to name paths and computed none, and answering "nothing
    // is held" to it is the fail-open this op exists to close.
    const global = paths === undefined || paths === null;
    if (!global && (!Array.isArray(paths) || !paths.length || paths.some((p) => typeof p !== 'string' || !p))) {
      throw new Error(
        'resolve-unsaved requires { paths: [assetRootUrl, …] } — one or more non-empty asset-root '
        + 'URLs (e.g. /assets/textures/rock.png) — or `paths` omitted entirely to ask about ALL '
        + `unsaved state. Held now: ${describeHeldNow()}`,
      );
    }
    const list = global ? [] : paths as string[];
    // An unknown registry name used to be FILTERED OUT, so `['bogus']` asked about nothing and
    // answered `{holds:[]}` — "nothing is held", the fail-open this op exists to close (#1213).
    if (registries !== undefined && registries !== null) {
      if (!Array.isArray(registries)) {
        throw new OpRefusal('REFUSED_BY_OP',
          `resolve-unsaved: registries must be a LIST of registry names — got ${JSON.stringify(registries)}. Nothing was checked.`,
          { options: [...ALL_REGISTRIES] });
      }
      const bad = (registries as unknown[]).filter((r) => !(ALL_REGISTRIES as readonly unknown[]).includes(r));
      if (bad.length) {
        throw new OpRefusal('REFUSED_BY_OP',
          `resolve-unsaved: unknown registr${bad.length === 1 ? 'y' : 'ies'} ${bad.map((r) => JSON.stringify(r)).join(', ')} — nothing was checked. `
          + `Valid: ${ALL_REGISTRIES.join(', ')}; omit registries to check all of them.`,
          { options: [...ALL_REGISTRIES] });
      }
    }
    const asked = new Set<UnsavedRegistry>(
      Array.isArray(registries) && registries.length
        ? (registries as unknown[]).filter((r): r is UnsavedRegistry =>
          (ALL_REGISTRIES as readonly string[]).includes(r as string))
        : ALL_REGISTRIES,
    );

    const causes = unsavedChangeCauses();
    // ⚠️ Resolved ONCE per call and shared by both modes: the global list and the per-path
    // matchers must not answer differently about the same world.
    const dirtyWorld = dirtyWorldTarget();

    const holds: Array<{ path: string; registry: UnsavedRegistry; detail?: string }> = [];
    const push = (path: string, registry: UnsavedRegistry, detail: string) => {
      // Two causes map to `liveScene`; a scene that is both primary-dirty and a dirty base must not
      // produce two rows for one path, or every count downstream is doubled.
      if (holds.some((h) => h.path === path && h.registry === registry)) return;
      holds.push({ path, registry, ...(detail ? { detail } : {}) });
    };
    if (global) {
      for (const [cause, registry] of Object.entries(CAUSE_REGISTRY) as Array<
        [keyof UnsavedCauses, UnsavedRegistry]
      >) {
        if (!asked.has(registry)) continue;
        for (const [path, detail] of heldPathsFor(cause, causes, dirtyWorld)) push(path, registry, detail);
      }
    }
    for (const path of list) {
      // ⚠️ Binds the KEY and indexes the table, rather than destructuring the matcher into a
      // callable binding. Both spellings work; this one is not shaped like a listener fan-out, so
      // it does not trip #888's guard — whose docblock says a fifth exemption is a decision rather
      // than an append, and it is right. Restructuring costs nothing here.
      for (const cause of Object.keys(CAUSE_HOLDS) as Array<keyof UnsavedCauses>) {
        const registry = CAUSE_REGISTRY[cause];
        if (!asked.has(registry)) continue;
        // ⚠️ `!== null`, never truthiness — a matcher returns '' for "held, nothing more to say",
        // and an empty string is falsy. Branching on the value would silently drop those rows.
        const detail = CAUSE_HOLDS[cause](path, causes, { dirtyWorld });
        if (detail !== null) push(path, registry, detail);
      }
    }

    // ⚠️ `openAssetEditor` is deliberately NOT a row in `CAUSE_REGISTRY`: it is not one of
    // `unsavedChangeCauses()`'s causes, because the Sprite and 9-slice editors park nothing and the
    // fact lives only in their mount entry (#1362). That is why it is filled in here rather than by
    // the cause walk above — and why it is absent from `DISCARDERS`: there is nothing to discard,
    // the only ways out of those modals are Save and Cancel (owner, 2026-08-18).
    if (asked.has('openAssetEditor')) {
      for (const { kind, path: held } of dirtyAssetEditorHolds()) {
        const matches = global || list.some((p) => p === held || held.startsWith(`${p}/`));
        if (matches) push(held, 'openAssetEditor', `unsaved edits in the open ${kind} editor`);
      }
    }

    // Scoped discard. A bare boolean would let `discardUnsaved` on a sidecar route throw away a
    // dirty particle document it never asked about — the over-reach `metaParkGate`'s single-
    // registry scope hid by accident and a shared probe would expose for real.
    const wantDiscard = new Set<string>(
      Array.isArray(discard) ? (discard as unknown[]).filter((d): d is string => typeof d === 'string') : [],
    );
    const refusedDiscard = [...wantDiscard].filter((d) => !(d in DISCARDERS));
    if (refusedDiscard.length) {
      throw new Error(
        `resolve-unsaved cannot discard ${refusedDiscard.join(', ')} — discardable registries are `
        + `${Object.keys(DISCARDERS).join(', ')}. Live-world scene edits are dropped by reloading `
        + 'the scene (load_scene with discardUnsaved), never by this probe.',
      );
    }
    const discarded: Array<{ path: string; registry: UnsavedRegistry }> = [];
    for (const registry of Object.keys(DISCARDERS) as DiscardableRegistry[]) {
      if (!wantDiscard.has(registry)) continue;
      const targets = holds.filter((h) => h.registry === registry).map((h) => h.path);
      if (!targets.length) continue;
      for (const path of DISCARDERS[registry](targets).discarded) discarded.push({ path, registry });
    }

    // `covers` is what the caller checks BEFORE reading `holds` as an answer — see the header.
    return { ok: true, holds, discarded, covers: [...asked] };
  });
}


/** Park an asset edit in the dirty-asset registry. Applied LIVE by the caller; reaches disk only
 *  via `save-all`.
 *
 *  Persistence is MANUAL-ONLY (owner decision 2026-07-30 — see PERSISTENCE_MODE in
 *  `editorBackendRouter.ts`). This used to branch on `params._persistenceMode`, writing straight to
 *  disk in `auto` mode and parking only in `manual`. The branch is gone along with `auto`.
 *
 *  The removed default mattered: an undefined `mode` — every in-process caller that did not come
 *  through the relay — fell into the WRITE branch. Keeping the parameter after removing `auto`
 *  would have left that path silently saving while every relayed call parked, which is precisely
 *  the "same call, different effect" confusion the removal exists to end. So the parameter is gone
 *  too, not merely defaulted.
 *
 *  Always returns false (nothing reached disk) for the op's `saved` field. */
async function persistOrMarkDirty(
  path: string, type: AssetSchemaType, data: unknown,
): Promise<boolean> {
  markAssetDirty(path, type, data);
  return false;
}
