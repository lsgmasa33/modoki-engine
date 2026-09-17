/** What an ASYNC Skin editor operation was computed from, and whether it still applies.
 *
 *  Re-tessellate, auto-rig and assign-sprite read the rig document, then await an image (the sprite's
 *  dims or its alpha mask) before committing a copy of that document with their change applied. The
 *  commit writes to whatever rig is open WHEN IT LANDS. If the editor was retargeted to another rig in
 *  between, the old rig's whole document — bones included — replaced the new one; if the same rig was
 *  edited in between, that edit was silently overwritten. Observed: re-tessellate on `bar`, open a
 *  second rig while the alpha mask loads, and the second rig came out with `bar`'s bones.
 *
 *  So each such operation captures its basis up front and the commit refuses when the editor no
 *  longer holds exactly that document. Identity, not equality: `applySkinDef` replaces the document
 *  object on every edit, so "the same object" is precisely "nothing changed since". */

export interface SkinOpBasis {
  path: string;
  def: object;
}

interface SkinEditingState {
  editingSkinAsset: { path: string } | null;
  editingSkinDef: object | null;
}

/** The basis to capture at the start of an async operation (`null` = nothing open, do nothing). */
export function captureSkinOpBasis(state: SkinEditingState): SkinOpBasis | null {
  const path = state.editingSkinAsset?.path;
  return path && state.editingSkinDef ? { path, def: state.editingSkinDef } : null;
}

/** Whether a result computed from `basis` may still be committed. */
export function isSkinOpBasisCurrent(basis: SkinOpBasis, state: SkinEditingState): boolean {
  return state.editingSkinAsset?.path === basis.path && state.editingSkinDef === basis.def;
}
