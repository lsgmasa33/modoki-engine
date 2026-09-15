/** The editor's ONE full-screen modal shell (#1270): the scrim, the backdrop dismiss, and the modal
 *  overlay entry that blocks the editor underneath.
 *
 *  Two forms, one mechanism. `ModalShell.tsx` is the React form every panel dialog renders;
 *  `openDomModalShell` below is the plain-DOM form for `utils/saveDialog.ts`, which deliberately has
 *  no React. Both push a MODAL onto the overlay stack while open (focusScope), so the keymap resolves
 *  nothing below the overlay tier and the relayed menu refuses (menuSpec.handleMenuAction).
 *
 *  Both forms also take DOM focus into the modal (`holdFocus`) — element-level key handlers under it
 *  never see the window dispatcher — and the React form PORTALS to `document.body`, so a dialog
 *  opened inside a panel stays on screen when that panel's tab is hidden. Without the portal it sat
 *  inside FlexLayout's `display:none` tab, invisible, with its modal entry still blocking every
 *  shortcut and greying the whole menu.
 *
 *  WHY ONE SHELL (owner, 2026-09-16). Seventeen dialogs each drew their own `position:fixed; inset:0`
 *  backdrop, and none of them told the keymap it was there: Delete or ⌘Z pressed under a Replace
 *  prompt edited the scene the prompt was about to write. A registration each dialog must remember is
 *  the shape that produced that, so the registration lives in the only place a backdrop is drawn.
 *  `modalShellCoverage.test.ts` fails on a full-screen backdrop drawn anywhere else. */

import { isTextEditable, pushOverlay } from '../input/focusScope';

export const MODAL_Z_INDEX = 9999;
export const MODAL_SCRIM = 'rgba(0,0,0,0.5)';

/** The backdrop's layout, shared by both forms. */
export const MODAL_BACKDROP_LAYOUT = { position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' } as const;

type PressEvent = { target: unknown; currentTarget: unknown };

/** A backdrop dismiss fires only for a press that STARTS and ENDS on the scrim itself.
 *
 *  A plain `onClick` on the backdrop also fires for a drag-select that starts inside a text field and
 *  is released over the scrim — the click lands on the common ancestor — and closed Project Settings
 *  mid-edit (its old onMouseDown rule was the fix for exactly that). Checking only the mousedown would
 *  close the dialog before the mouseup, so the release then lands on whatever sat underneath it.
 *  Tracking both keeps the click semantics and the drag-select fix. */
export function scrimDismissHandlers(onDismiss: () => void): { onMouseDown: (e: PressEvent) => void; onClick: (e: PressEvent) => void } {
  let pressedScrim = false;
  return {
    onMouseDown: (e) => { pressedScrim = e.target === e.currentTarget; },
    onClick: (e) => {
      const onScrim = pressedScrim && e.target === e.currentTarget;
      pressedScrim = false;
      if (onScrim) onDismiss();
    },
  };
}

/** Take DOM focus into a modal that just opened, and give it back when it closes.
 *
 *  Blocking the window dispatcher is not enough on its own: an element-level `onKeyDown` fires for
 *  whatever holds DOM focus, and no dialog took focus when it opened. The Assets list keeps focus
 *  after a click, handles ⌘⌫/⌘D/Enter itself and stops propagation, so ⌘⌫ under Project Settings
 *  trashed the selected asset (#1270 review). Taking focus into the modal removes the key from
 *  every such handler at once.
 *
 *  Focus is taken only when it is OUTSIDE the modal and NOT in a text field:
 *  - inside already — a dialog that `autoFocus`es its own field placed it, and taking it back would
 *    break typing;
 *  - a text field — three modals (import, scene load, build) open with NO user gesture, and this
 *    repo commits several fields on `blur` (the Skin Editor's bone name, the sprite-animator rename).
 *    Stealing focus from a half-typed field would commit it at a moment nobody chose, which is the
 *    "never make a commit depend on a focus EVENT" rule in docs/editor-input.md arriving by the back
 *    door. A focused field already swallows the keys this exists to intercept; the handlers that
 *    bypass the keymap (the Assets list's ⌘⌫) live on plain elements, and those we still take.
 *
 *  Restoring runs whoever placed the focus, so closing a dialog that `autoFocus`ed its own field
 *  still returns the keyboard rather than stranding it on `<body>` — but only while focus is still
 *  the modal's (or nowhere), never over a focus the user has since moved on. */
export function holdFocus(root: HTMLElement, before: Element | null = root.ownerDocument.activeElement): () => void {
  const doc = root.ownerDocument;
  const current = doc.activeElement;
  if (!root.contains(current) && !isTextEditable(current)) root.focus({ preventScroll: true });
  return () => {
    // `before` is where focus was BEFORE the dialog existed — which the caller must capture, because
    // by the time this runs a child's `autoFocus` may already have moved it INTO the dialog, and
    // restoring to that is restoring to something about to be unmounted.
    if (!(before instanceof HTMLElement) || !before.isConnected || root.contains(before)) return;
    const now = doc.activeElement;
    if (now && now !== doc.body && !root.contains(now)) return; // focus already moved on by itself
    before.focus({ preventScroll: true });
  };
}

let domSeq = 0;

/** Open the plain-DOM shell: an empty backdrop appended to `document.body`, already registered as a
 *  modal. The caller fills `root` and must call `close()` exactly when the dialog ends — it removes
 *  the backdrop and the overlay entry together, and is safe to call twice. */
export function openDomModalShell(kind: string, opts: { onDismiss?: () => void; zIndex?: number; scrim?: string } = {}): { root: HTMLDivElement; close: () => void } {
  const root = document.createElement('div');
  Object.assign(root.style, MODAL_BACKDROP_LAYOUT, {
    inset: '0', zIndex: String(opts.zIndex ?? MODAL_Z_INDEX), background: opts.scrim ?? MODAL_SCRIM, outline: 'none',
  });
  root.tabIndex = -1;
  if (opts.onDismiss) {
    const h = scrimDismissHandlers(opts.onDismiss);
    root.addEventListener('mousedown', h.onMouseDown);
    root.addEventListener('click', h.onClick);
  }
  document.body.append(root);
  const pop = pushOverlay(`${kind}#dom${++domSeq}`, { modal: true });
  const restoreFocus = holdFocus(root);
  let open = true;
  return {
    root,
    close: () => {
      if (!open) return;
      open = false;
      pop();
      restoreFocus();
      root.remove();
    },
  };
}
