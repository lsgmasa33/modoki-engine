/** Name an open editor modal as the cause of an agent's refused or inert input (#1270).
 *
 *  A modal dialog blocks every editor shortcut and greys every renderer-built menu item. Both
 *  agent surfaces then answered in a way that hid it: `/api/menu` said only `menu item "Save All" is
 *  disabled`, and `/api/input/key` said `ok:true` for a press that reached nothing — the
 *  `family/refusal-not-surfaced` shape (#1032). Pure, so both are unit-tested without Electron. */

export const MODAL_CAUSE = 'a modal dialog is open in the editor, and nothing underneath it takes keys or menu commands until it is closed';

/** Append the cause to a `triggerMenuItem` refusal of a greyed item while the renderer reported a
 *  modal. Any other result is returned as is. */
export function explainMenuRefusal<T extends { ok: boolean; error?: string }>(res: T, modalOpen: boolean): T {
  if (res.ok || !modalOpen || !res.error || !/ is disabled$/.test(res.error)) return res;
  return { ...res, error: `${res.error} — ${MODAL_CAUSE}` };
}

/** The warning for a key press made while a modal is open and no binding of the modal's own claimed
 *  it, or null. A key the modal binds (SpriteEditor's slice ⌘Z) worked and gets no warning. */
export function modalKeyWarning(reach: { modalOpen?: boolean; editorBinding?: string | null } | null): string | null {
  if (!reach?.modalOpen || reach.editorBinding) return null;
  return `${MODAL_CAUSE}: no editor shortcut ran and the running game did not receive this key. An element inside the dialog (its text field, its buttons) may still have handled it. Close the dialog first if you meant the editor.`;
}
