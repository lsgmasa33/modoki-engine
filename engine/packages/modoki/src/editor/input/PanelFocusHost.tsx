/** PanelFocusHost — click-to-focus wrapper applied by EditorApp's FlexLayout factory
 * . Contract: docs/editor-input.md.
 *
 *  Wrapping at the FACTORY is the whole point: one seam stamps every panel — including
 *  game-registered custom panels (`sling-field`) that no hand-edit would have covered —
 *  instead of touching 12 panel files and missing the 13th.
 *
 *  THIS PHASE IS DELIBERATELY INERT. It records which panel was last clicked and paints
 *  a ring. Nothing reads `focusedPanel` to gate a shortcut yet; that starts in P3.
 *
 *  TWO CHOICES THAT LOOK ODD AND ARE LOAD-BEARING:
 *
 *  1. `display: contents` — the wrapper contributes NO box. Panels are laid out by
 *     FlexLayout's sized tab container and many assume they are its direct child
 *     (height:100%, absolutely-positioned overlays, canvas sizing). A real wrapper div
 *     would risk a subtle layout regression in ~13 panels for zero benefit; the element
 *     still exists in the DOM tree, so `closest()` and event propagation are unaffected.
 *
 *  2. `data-panel-scope`, NOT `data-editor-panel` — the legacy attribute is READ by
 *     Hierarchy's document-level keydown (`Hierarchy.tsx:860`) to decide whether to yield.
 *     Stamping it on every panel now would silently change that guard's behaviour
 *     (Hierarchy would start bailing where it previously ran) — a real change smuggled
 *     into a phase that is supposed to be revertable on its own. The legacy attribute and
 *     its reader are both deleted in P6; the two mechanisms do not interact until then.
 *
 *  Focus is set on capture-phase mousedown and does NOT consume the event — the click
 *  must still reach the panel. Mouse is never focus-FILTERED (DOM hit-testing already
 *  routes it); it only SETS focus. */

import type { ReactNode } from 'react';
import { useEditorStore } from '../store/editorStore';

export function PanelFocusHost({ id, children }: { id: string; children: ReactNode }) {
  const focused = useEditorStore((s) => s.focusedPanel) === id;
  return (
    <div
      style={{ display: 'contents' }}
      data-panel-scope={id}
      data-panel-focused={focused ? 'true' : undefined}
      // POINTERdown, not mousedown. Verified live: clicking the SceneView canvas set no
      // focus at all with a mousedown handler, because the canvas's pointer handlers
      // preventDefault() and that SUPPRESSES the compatibility mouse events. pointerdown
      // is the primary event and covers mouse/pen/touch uniformly. mousedown is kept as a
      // belt-and-braces fallback for anything that only emits legacy mouse events;
      // setFocusedPanel early-returns when the scope is unchanged, so a double fire is a
      // no-op and never double-journals.
      //
      // Capture phase so focus is recorded before any panel handler runs — several
      // stopPropagation() their own pointerdown, and one canvas handler calls
      // stopImmediatePropagation(). Read via getState(): this must not re-subscribe.
      onPointerDownCapture={() => useEditorStore.getState().setFocusedPanel(id)}
      onMouseDownCapture={() => useEditorStore.getState().setFocusedPanel(id)}
    >
      {children}
    </div>
  );
}
