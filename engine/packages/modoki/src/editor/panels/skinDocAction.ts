/** The undo entry for a `.rig2d.json` edit — every rig site (SkinEditor, SkinCanvas, SkinBoneList) pushes this one
 *  shape. An asset-DOCUMENT edit (`_isFileDirect`): parked in the dirty-asset registry, not scene state, so it must not
 *  bump the scene edit-version (a falsely-dirty scene self-blocks the file-direct routes, makes modoki_build refuse, and
 *  makes Cmd+S interrupt a preview to save a scene nothing changed). Its undo/redo check the rig still holds their side
 *  before moving it and park the result themselves (#1710, `assetDocUndo.ts`). */

import { useEditorStore } from '../store/editorStore';
import { assetDocAction, captureAssetDocBaseline, type AssetDocBaseline } from '../undo/assetDocUndo';
import type { UndoAction } from '../undo/undoManager';
import type { Rig2DFile } from '../../runtime/loaders/rig2dCache';

export function skinDocAction(
  label: string, path: string, before: Rig2DFile, after: Rig2DFile, baseline?: AssetDocBaseline | null,
): UndoAction {
  return assetDocAction<Rig2DFile>({
    label, path, type: 'rig2d', before, after: () => after, baseline,
    apply: (d) => useEditorStore.getState().applySkinDef(path, d),
  });
}

/** The baseline for a canvas GESTURE, taken at its start: the gesture moves the live rig on every pointer move, so the
 *  panel has parked it long before the entry is pushed at pointer-up (see `assetDocAction`'s `baseline`). */
export function skinGestureBaseline(before: Rig2DFile | null): AssetDocBaseline | null {
  const path = useEditorStore.getState().editingSkinAsset?.path;
  return path && before ? captureAssetDocBaseline(path, before) : null;
}
