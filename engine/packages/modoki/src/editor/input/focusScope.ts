// HMR: the overlay `stack` below is a registry written by overlay components and read by
// the long-lived dispatcher — the same shape that forks keymap.ts in two. Reload rather
// than hot-swap; see input/keymap.ts for the measurement.
if (import.meta.hot) import.meta.hot.accept(() => { window.location.reload(); });

/** focusScope — what currently owns keyboard input.
 *
 *  Two pieces the keymap dispatcher needs but that are NOT the keymap's business:
 *  the overlay stack, and the "is the user typing?" predicate.
 *
 *  Contract: docs/editor-input.md. Pure module — the DOM is only touched
 *  through an explicitly passed element, never read from a global, so it unit-tests
 *  without jsdom.
 *
 *  NOTE ON WHERE FOCUS LIVES: the focused PANEL is store state
 *  (`editorStore.focusedPanel`), deliberately NOT derived from `document.activeElement`.
 *  Clicking a Hierarchy row is a click on a plain <div>, so DOM focus stays on <body> —
 *  measured in P0, where every captured keypress reported target=BODY after clicking a
 *  Hierarchy row. Deriving focus from activeElement would report "nothing focused" for
 *  the panel the user is plainly working in, which is the bug Hierarchy.tsx:860 already
 *  works around by hand. */

/** Elements that mean "the user is typing", so bare keys and panel shortcuts must not fire.
 *
 *  Deliberately NARROWER than "any form control": `editor-multi-select.spec.ts:52` presses
 *  Cmd+Z while a CHECKBOX has focus and expects the scene undo to run. A blunt
 *  tagName === 'INPUT' test would swallow it. Only text-entry controls count.
 *
 *  Kept in the same shape as the runtime's `keyboardSource.editing()` and its duplicate at
 *  rendererOps.ts (the Enact "an editable field will swallow this key" warning) — if these
 *  drift, that warning starts lying. */
const TEXT_INPUT_TYPES = new Set([
  'text', 'search', 'url', 'tel', 'email', 'password', 'number', 'date', 'datetime-local',
  'month', 'week', 'time',
]);

export function isTextEditable(el: Element | null | undefined): boolean {
  if (!el) return false;
  const e = el as HTMLElement & { type?: string; readOnly?: boolean; disabled?: boolean; isContentEditable?: boolean };
  if (e.isContentEditable) return true;
  const tag = e.tagName;
  // readOnly/disabled apply to BOTH text controls, not just INPUT. The asymmetry was a real
  // bug: a readOnly <textarea> reported editable and suppressed every editor shortcut while
  // rejecting each character typed into it. (`disabled` is belt-and-braces — a disabled
  // control cannot take focus in a real browser, so it should never be activeElement.)
  if (e.readOnly || e.disabled) return false;
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') {
    // AssetRefField renders a readOnly input and binds Backspace to clear the ref — it must
    // not read as "the user is typing", which is what the check above is for.
    return TEXT_INPUT_TYPES.has((e.type || 'text').toLowerCase());
  }
  return false;
}

// ── Overlay stack ───────────────────────────────────────────────────────────
//
// Escape is claimed by FOUR independent components today (ContextMenu, treeChrome,
// DevicePicker, SpritePicker) — none stops propagation, so one Escape closes every
// open overlay at once. A stack gives Escape a single, top-most owner. Nested
// submenus push their own entry, so closing is innermost-first.

const stack: string[] = [];

/** Push an overlay and get its disposer. Call on open; the disposer on close.
 *  Idempotent per id: re-pushing an already-open id moves it to the top rather than
 *  duplicating it, so a re-render can't corrupt the stack. */
export function pushOverlay(id: string): () => void {
  const existing = stack.indexOf(id);
  if (existing >= 0) stack.splice(existing, 1);
  stack.push(id);
  return () => popOverlay(id);
}

/** Remove an overlay by id — NOT "pop the top". Overlays can close out of order (a
 *  picker closing while its parent menu stays open), and blindly popping the top
 *  would evict the wrong one. */
export function popOverlay(id: string): void {
  const i = stack.lastIndexOf(id);
  if (i >= 0) stack.splice(i, 1);
}

/** The overlay that currently owns input, or null. */
export function topOverlay(): string | null {
  return stack.length ? stack[stack.length - 1] : null;
}

export function overlayDepth(): number { return stack.length; }
/** Test/teardown hook. */
export function clearOverlays(): void { stack.length = 0; }
