/** The editor's open modals, read from the DOM — the one reading both `modoki_dnd`'s `pendingModal`
 *  and `get_editor_state.modal` use, so the two cannot disagree about what a modal looks like to an
 *  agent (#1594).
 *
 *  Both forms of the editor's one modal shell (`components/modalBackdrop.ts` and `ModalShell.tsx`)
 *  stamp `data-modal-shell=<kind>` on their root and append it to <body>, so document order is stack
 *  order: the LAST shell is the top-most, the one that takes input. A native `window.confirm`/`alert`
 *  sheet is invisible here by construction — which is why the editor must not open one
 *  (`tests/architecture/noNativeDialogs.test.ts`). */

/** How many of a modal's named buttons `controls` lists. A confirm has two; the cap is for a list
 *  dialog that names a button per row. */
export const MODAL_CONTROL_CAP = 8;

export interface ModalDescription {
  /** The shell's `data-modal-shell` kind — `save-dialog`, `unsaved-changes`, … */
  kind: string;
  /** The named buttons inside it (`button[data-ui-id]`), capped at {@link MODAL_CONTROL_CAP} — what to aim at next. */
  controls: string[];
  /** The uncapped count of named buttons. */
  controlCount: number;
}

/** Every open modal shell, React or plain-DOM, in stack order (last = top-most). Empty with no DOM
 *  at all — `get_editor_state` is read by node-environment suites, and a headless world has no modal. */
export const openModalShells = (): Element[] =>
  typeof document === 'undefined' ? [] : Array.from(document.querySelectorAll('[data-modal-shell]'));

export function describeModalShell(el: Element): ModalDescription {
  const ids = Array.from(el.querySelectorAll('button[data-ui-id]'), (b) => b.getAttribute('data-ui-id')!);
  return { kind: el.getAttribute('data-modal-shell') ?? '', controls: ids.slice(0, MODAL_CONTROL_CAP), controlCount: ids.length };
}

/** The top-most open modal, or null when none is open. */
export function describeTopModal(): ModalDescription | null {
  const top = openModalShells().pop();
  return top ? describeModalShell(top) : null;
}
