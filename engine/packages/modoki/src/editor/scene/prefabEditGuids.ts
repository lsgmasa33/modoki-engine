/** The sentinel guids a prefab-edit world stamps on the edited prefab's own rows (see prefabEdit.ts, where
 *  the scheme is explained), defined in the runtime (`prefabEditRoot.ts`). Its own module so the prefab capture can
 *  recognise one without importing the prefab-edit session, which imports it. */
export { PREFAB_EDIT_ROOT_GUID, PREFAB_EDIT_LOCAL_GUID_PREFIX, isPrefabEditRowGuid } from '../../runtime/core/prefabEditRoot';

/** Name prefix marking the edit world's transient scaffolding (the lights, the HDR environment, the 2D stage). Here, in
 *  the leaf, so the prefab-edit refusal can recognise a copied scaffold without importing the session. */
export const SCAFFOLD_PREFIX = '__PrefabEdit';
