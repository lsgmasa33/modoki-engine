/** @modoki/editor — Visual editor, dev-only. Not shipped in production builds. */

export { backendFetch, backendPostJson, backendEventSource, backendBase, backendUrl } from './backend/editorBackend';
export { createEditor, type EditorOptions } from './createEditor';
export { pushAction, undo, redo, canUndo, canRedo, clearHistory, undoLabel, redoLabel, getEditVersion } from './undo/undoManager';
export {
  writeTraitFieldWithUndo, deleteEntityWithUndo, deleteEntitiesWithUndo, duplicateEntity,
  reparentEntity, setActionCallback, createEntityWithUndo,
  addTraitToEntitiesWithUndo, removeTraitFromEntitiesWithUndo, type TraitSpec,
} from './undo/entityActions';
export {
  emptySpecs, primitiveSpecs, shape2DSpecs, canvas2DSpecs, uiSpecs, cameraSpecs, lightSpecs, environmentSpecs, particleSpecs,
  buildEntityCreateSpecs, type CreateEntitySpec, type CreateSpecs, type LightKind,
} from './entityCreateSpecs';
export { buildUiCreateSpecs, type UiPreset } from './uiAuthoring';
export { enterPlay, stopPlay, pausePlay, resetPlayMode } from './scene/playMode';
export { editorEmit, readEditorJournal, clearEditorJournal, setEditorJournalEnabled, withEditorActor, openActorLease, closeActorLease, ACTOR_LEASE_TTL_MS } from './editorJournal';
export {
  getEditorViewportCamera, setEditorViewportCamera, focusEntityInSceneView,
} from './scene/sceneViewBus';
export {
  useBufferedValue, BufferedTextInput, BufferedNumberInput, parseNumber, parseString,
  applyWheelStep, useWheelStep,
} from './panels/fields';
export { useDebouncedSave } from './panels/useDebouncedSave';
export {
  serializePrefab, instantiatePrefab, instantiatePrefabAsync, setPrefabSource,
  getPrefabSource, setPrefabCache, getOverrides, getOverrideValues,
  captureInstanceOverrides, applyOverridesByRootInstance,
  applyToPrefab, applyToPrefabSelective,
  revertOverridesSelective, rebuildInstance,
  writePrefabFile, resolveExistingPrefabId,
  tagEntityTreeAsInstance, untagEntityTreeAsInstance,
  detachPrefabInstance, reattachPrefabInstance,
  type PrefabFile, type RevertResult,
} from './scene/prefab';
export {
  saveScene, saveAll, serializeScene, loadScene, newScene,
  getCurrentScenePath, setCurrentScenePath, type SceneFile,
} from './scene/serialize';
export { importModel } from './scene/modelImport';
export { useEditorStore } from './store/editorStore';
export type { SelectedAsset } from './store/editorStore';
export { upsertKey, findTrack, encodeValue, relativeEntityPath } from './animation/recording';

// C7: agents must address entities by GUID (runtime ids are reassigned on every scene
// hot-reload), so the ops that CREATE entities have to be able to hand one back.
export { ensureGuid } from './undo/entityRef';

// C7: agent ops must refuse to DESTROY unsaved live work (load_scene/new_scene swap the world).
export { hasUnsavedChanges, markSceneSaved, type SaveResult } from './scene/serialize';

// C7: the agent save-all path must honour prefab-edit mode like the human paths do —
// otherwise an explicit `path` writes the SYNTHETIC prefab-edit world over a real scene.
export { isEditingPrefab } from './scene/prefabEdit';
