/** The sentinel guids a prefab-edit world stamps on the edited prefab's own rows (see prefabEdit.ts, where
 *  the scheme is explained). Its own module so the prefab capture can recognise one without importing the
 *  prefab-edit session, which imports it. */
export const PREFAB_EDIT_LOCAL_GUID_PREFIX = '__prefab_edit_local__';

/** Is `guid` a prefab-edit world's stamp on one of the edited prefab's own ROWS? */
export function isPrefabEditRowGuid(guid: string | undefined): boolean {
  return !!guid && guid.startsWith(PREFAB_EDIT_LOCAL_GUID_PREFIX);
}
