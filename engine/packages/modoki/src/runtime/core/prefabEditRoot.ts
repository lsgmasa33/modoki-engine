/** Sentinel guid stamped on the prefab root in the synthetic edit scene so the save path can locate it after the loader
 *  reassigns ECS ids. Lives only in the throwaway edit world; serializePrefab clears guids in the written file. Here, in
 *  core, so the override-mark store can tell an edit world's entities from a scene's (F7, `overrideMarks.ts`); the editor
 *  re-exports it from `prefabEditGuids.ts`. */
export const PREFAB_EDIT_ROOT_GUID = '__prefab_edit_root__';
