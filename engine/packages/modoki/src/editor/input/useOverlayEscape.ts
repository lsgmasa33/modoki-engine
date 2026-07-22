/** useOverlayEscape — give a transient overlay a single, ordered claim on Escape
 * . Contract: docs/editor-input.md.
 *
 *  THE BUG THIS FIXES: Escape was claimed by four independent components — ContextMenu
 *  (one listener per mounted menu, INCLUDING each nested submenu), treeChrome,
 *  DevicePicker and SpritePicker. None called stopPropagation, so a single Escape closed
 *  every open overlay at once: dismissing a submenu also tore down its parent menu and
 *  any picker behind it.
 *
 *  Escape needs a STACK, not a flat map. Each overlay pushes itself while open and
 *  registers its binding against its own instance id; `resolve()` only matches an
 *  overlay binding whose owner is on TOP, so exactly one Escape closes exactly one
 *  overlay, innermost first.
 *
 *  Instance-scoped by `useId()` rather than by kind, because several instances of the
 *  same component are open simultaneously in the nested-submenu case — a shared owner
 *  id would collapse them back into the original bug. */

import { useEffect, useId, useRef } from 'react';
import { register } from './keymap';
import { pushOverlay } from './focusScope';
import { useHmrEpoch } from './hmrEpoch';

/**
 * @param open  whether the overlay is currently showing (pass `true` for overlays that
 *              are simply unmounted when closed)
 * @param onClose  invoked on Escape; may change identity between renders
 * @param kind  short label for debugging/introspection, e.g. 'context-menu'
 */
export function useOverlayEscape(open: boolean, onClose: () => void, kind: string): string {
  const hmrEpoch = useHmrEpoch();
  const id = useOverlay(open, kind);
  // Read the LATEST onClose without re-registering on every render — a menu whose
  // handler is an inline arrow would otherwise churn the overlay stack each frame.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    return register({
      id: `overlay.escape.${id}`,
      keys: 'Escape',
      scope: 'overlay',
      owner: id,
      run: () => closeRef.current(),
    });
  }, [open, id, hmrEpoch]);

  return id;
}

/** Push an overlay onto the stack while `open`, WITHOUT binding Escape, and return its
 *  instance id for use as a binding `owner`.
 *
 *  For overlays that own other chords (the SpriteEditor modal claims Cmd+Z so the global
 *  undo can't unmount it mid-edit) or that deliberately have no Escape-to-close. Keeping
 *  this separate means adopting the stack never silently ADDS an Escape behaviour a
 *  component didn't already have. */
export function useOverlay(open: boolean, kind: string): string {
  const reactId = useId();
  const id = `${kind}${reactId}`;
  useEffect(() => {
    if (!open) return;
    return pushOverlay(id);
  }, [open, id]);
  return id;
}
