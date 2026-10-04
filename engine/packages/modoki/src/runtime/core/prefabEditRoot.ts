/** Sentinel guid stamped on the prefab root in the synthetic edit scene so the save path can locate it after the loader
 *  reassigns ECS ids. Lives only in the throwaway edit world; serializePrefab clears guids in the written file. Here, in
 *  core, so the override-mark store can tell an edit world's entities from a scene's (F7, `overrideMarks.ts`); the editor
 *  re-exports it from `prefabEditGuids.ts`. */
export const PREFAB_EDIT_ROOT_GUID = '__prefab_edit_root__';

/** The sentinel guid prefix a prefab-edit world stamps on the edited prefab's own rows (`editor/scene/prefabEdit.ts`
 *  explains the scheme). Here beside the root's, so the load can tell such a row from a node a scene hangs into an
 *  instance (#2001 S8b, `instanceLoad.ts`); the editor re-exports both from `prefabEditGuids.ts`. */
export const PREFAB_EDIT_LOCAL_GUID_PREFIX = '__prefab_edit_local__';

/** Is `guid` a prefab-edit world's stamp on one of the edited prefab's own ROWS? */
export function isPrefabEditRowGuid(guid: string | undefined): boolean {
  return !!guid && guid.startsWith(PREFAB_EDIT_LOCAL_GUID_PREFIX);
}
