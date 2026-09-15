/** ModalShell — the React form of the editor's one full-screen modal shell. The mechanism and why
 *  it exists: `modalBackdrop.ts`.
 *
 *  Render it only while the dialog is showing: mounting pushes a MODAL overlay (the editor underneath
 *  stops resolving keys and the relayed menu refuses), takes DOM focus into the dialog and portals it
 *  to `document.body`; unmounting undoes all three.
 *
 *  `onDismiss` is the backdrop dismiss. Leave it out for a dialog holding unsaved work, where a stray
 *  click outside must not discard it (`modalDismissScope.test.ts` pins which ones), and for progress
 *  modals that cannot be cancelled. Pass `undefined` to switch it off for a while (a publish in
 *  flight). */

import { useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { pushOverlay } from '../input/focusScope';
import { holdFocus, MODAL_BACKDROP_LAYOUT, MODAL_SCRIM, MODAL_Z_INDEX, scrimDismissHandlers } from './modalBackdrop';

export function ModalShell({ kind, id, onDismiss, zIndex = MODAL_Z_INDEX, scrim = MODAL_SCRIM, children }: {
  /** Short label for the overlay id, e.g. 'project-settings'. */
  kind: string;
  /** The overlay id, when the dialog needs it before this mounts — as the `owner` of its own
   *  overlay-scope bindings (SpriteEditor's ⌘Z). Otherwise derived from `kind`. */
  id?: string;
  onDismiss?: () => void;
  zIndex?: number;
  scrim?: string;
  children: ReactNode;
}) {
  const reactId = useId();
  const overlayId = id ?? `${kind}${reactId}`;
  // Read the LATEST onDismiss, and keep one handler pair across renders: a re-render between the
  // press and the release would otherwise forget that the press started on the scrim.
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const handlers = useRef(scrimDismissHandlers(() => dismissRef.current?.())).current;
  const rootRef = useRef<HTMLDivElement>(null);
  // Captured in RENDER, not in the effect: a child's `autoFocus` runs first and would otherwise be
  // the only "previous" focus this ever sees. Read once per mount, guarded by the ref.
  const beforeRef = useRef<Element | null | undefined>(undefined);
  if (beforeRef.current === undefined) beforeRef.current = document.activeElement;
  // ONE layout effect, so the two halves cannot interleave — and layout, not passive, because a key
  // pressed between paint and a passive effect would still reach the editor underneath.
  //   open:  block first, then take focus.
  //   close: unblock first, then give focus back — the reverse. Restoring focus to the Assets list
  //          while the modal was still on the stack would hand its element-level ⌘⌫ a live window,
  //          which is the very thing this shell exists to close.
  // A child's `autoFocus` has already run by the time this does, and holdFocus leaves it alone.
  useLayoutEffect(() => {
    const pop = pushOverlay(overlayId, { modal: true });
    const restoreFocus = rootRef.current ? holdFocus(rootRef.current, beforeRef.current ?? null) : () => {};
    return () => { pop(); restoreFocus(); };
  }, [overlayId]);
  // Portalled to <body>: see modalBackdrop.ts — a shell inside a hidden FlexLayout tab would block
  // the editor with nothing on screen. React events still bubble through the component tree.
  return createPortal(
    <div
      ref={rootRef}
      data-modal-shell={kind}
      tabIndex={-1}
      style={{ ...MODAL_BACKDROP_LAYOUT, zIndex, background: scrim, outline: 'none' }}
      onMouseDown={handlers.onMouseDown}
      onClick={handlers.onClick}
    >
      {children}
    </div>,
    document.body,
  );
}
