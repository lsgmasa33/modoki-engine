/** @modoki/editor — Visual editor, dev-only. Not shipped in production builds. */

export { backendFetch, backendPostJson, backendEventSource, backendBase, backendUrl } from './backend/editorBackend';
export { createEditor, setExtraMenus, type EditorOptions, type ExtraMenuItem, getResolvedRender3d } from './createEditor';
export {
  pushAction, undo, redo, canUndo, canRedo, clearHistory, undoLabel, redoLabel, getEditVersion,
  beginActionCapture, endActionCapture, isCapturingActions, type UndoAction,
} from './undo/undoManager';
export { runAsCompositeAction, composeUndoActions, type CompositeActionOptions } from './undo/compositeAction';
export {
  writeTraitFieldWithUndo, deleteEntityWithUndo, deleteEntitiesWithUndo, duplicateEntity,
  reparentEntity, setActionCallback, createEntityWithUndo,
  addTraitToEntitiesWithUndo, removeTraitFromEntitiesWithUndo, type TraitSpec,
} from './undo/entityActions';
export {
  emptySpecs, primitiveSpecs, shape2DSpecs, canvas2DSpecs, uiSpecs, cameraSpecs, lightSpecs, environmentSpecs, particleSpecs,
  buildEntityCreateSpecs, type CreateEntitySpec, type CreateSpecs, type LightKind,
} from '../runtime/scene/entityCreateSpecs';
export { buildUiCreateSpecs, type UiPreset } from '../runtime/ui/uiAuthoring';
export { enterPlay, stopPlay, pausePlay, resetPlayMode } from './scene/playMode';
export {
  editorEmit, readEditorJournal, clearEditorJournal, setEditorJournalEnabled,
  withEditorActor, openActorLease, closeActorLease, ACTOR_LEASE_TTL_MS, ACTOR_LEASE_GRACE_MS,
  waitForEditorJournal, type EditorEvent, type WaitForEditResult,
} from './editorJournal';
export {
  getEditorViewportCamera, setEditorViewportCamera, focusEntityInSceneView,
} from './scene/sceneViewBus';
export {
  useBufferedValue, BufferedTextInput, BufferedNumberInput, parseNumber, parseString,
  applyWheelStep, useWheelStep,
} from './panels/fields';
export { useDebouncedSave } from './panels/useDebouncedSave';
// Device listing — shared by the AI panel's connect picker and the app shell's Build-menu target
// picker (#170), which is why it leaves the package rather than staying panel-private.
export {
  fetchDeviceList, androidRowLabel, androidRowNote,
  type DeviceListReply, type AndroidDeviceRow, type IosDeviceRow, type DeviceClaim,
} from './panels/deviceConnectModel';
export {
  serializePrefab, instantiatePrefab, instantiatePrefabAsync, setPrefabSource,
  getPrefabSource, setPrefabCache, getOverrides, getOverrideValues,
  captureInstanceOverrides, applyOverridesByRootInstance,
  applyToPrefab, applyToPrefabSelective,
  revertOverridesSelective, rebuildInstance,
  writePrefabFile, resolveExistingPrefabId,
  tagEntityTreeAsInstance, untagEntityTreeAsInstance,
  detachPrefabInstance, reattachPrefabInstance,
  captureInstanceStructure, resolveInstanceContext,
  type PrefabFile, type RevertResult,
} from './scene/prefab';
// Shared override-key enumeration for the Apply-to-Prefab / Revert-Overrides surfaces —
// the dialog (ApplyPrefabDialog.tsx) and the `modoki_prefab {prefabAction:'overrides'}`
// agent op both build their checkbox/discovery list from this ONE walk, so they cannot
// silently drift from each other (see prefabOverrideKeys.ts's header comment).
export {
  fieldKey, addedKey, removedEntityKey, removedTraitKey,
  collectInstanceOverrideFields, collectInstanceOverrideKeys,
  type FieldNode, type TraitNode, type EntityOverrideNode, type InstanceOverrideKeys,
} from './scene/prefabOverrideKeys';
// `applyToPrefabWithUndo` is the ONLY way to apply overrides that also records undo —
// `applyToPrefabSelective` above is the raw mutation the dialog/agent-op undo wrapper
// calls into, kept exported too for callers that manage their own undo entry.
export { applyToPrefabWithUndo } from './undo/applyPrefabUndo';
export {
  saveScene, saveAll, serializeScene, loadScene, newScene,
  getCurrentScenePath, setCurrentScenePath, isTraitDefault, type SceneFile,
} from './scene/serialize';
export {
  markAssetDirty, hasDirtyAssets, getDirtyAssetPaths, peekDirtyAsset, clearDirtyAssets,
  discardDirtyAssets, flushDirtyAssets, type FlushResult,
} from './scene/dirtyAssets';
export { importModel } from './scene/modelImport';
export { useEditorStore } from './store/editorStore';
export type { SelectedAsset } from './store/editorStore';
export { upsertKey, findTrack, encodeValue, relativeEntityPath } from './animation/recording';
export {
  registerCreatableAsset, unregisterCreatableAsset, getCreatableAssets, type CreatableAssetDef,
} from './panels/creatableAssets';

// C7: agents must address entities by GUID (runtime ids are reassigned on every scene
// hot-reload), so the ops that CREATE entities have to be able to hand one back.
export { ensureGuid, entityRef, type EntityRef } from './undo/entityRef';

// The agent prefab ops (engine/app/editor/agentEditorOps.ts) must push the SAME undo
// entries as the Hierarchy/Assets/Inspector paths — otherwise an agent-instantiated
// prefab is live-only AND invisible to `hasUnsavedChanges()`, so the unsaved-work
// guards let a later load_scene / scene-mutate hot-reload silently destroy it.
export { makePrefabInstantiateAction } from './undo/prefabInstantiateUndo';

// C7: agent ops must refuse to DESTROY unsaved live work (load_scene/new_scene swap the world).
export { hasUnsavedChanges, unsavedChangeCauses, markSceneSaved, type SaveResult } from './scene/serialize';

// C7: the agent save-all path must honour prefab-edit mode like the human paths do —
// otherwise an explicit `path` writes the SYNTHETIC prefab-edit world over a real scene.
// #125: prefab-edit is also the only round-trip that re-serializes a .prefab.json, so the
// bulk re-save sweep (engine/scripts/resave-prefabs.sh) drives these three as agent ops.
export { isEditingPrefab, openPrefabForEditing, savePrefabEdit, exitPrefabEditing } from './scene/prefabEdit';
