/** Agent addressing for the dock's TABS (#1152, #1153).
 *
 *  FlexLayout renders its own tab buttons, so no `data-ui-id` ever reached them: `modoki_handles
 *  {editor:'chrome'}` could not see a single tab, and "which panel is showing" / "click the Console
 *  tab" cost an agent a DOM walk in `modoki_eval` — 227 reads and most of the 213 text-clicks
 *  measured in #1152/#1153 were tabs.
 *
 *  FlexLayout does not let a caller put attributes on the tab BUTTON, but its `onRenderTab` hook
 *  replaces the tab's CONTENT. So the tab's title is wrapped in a span carrying the ordinary chrome
 *  tagging attributes, and the existing `[data-ui-id]` walker picks it up with no second provider:
 *  its label is the tab's text, and a trusted press on it bubbles to the button's own handler
 *  (verified live 2026-09-13 — a trusted tap on a tab DOES switch it).
 *
 *  A plain `.ts` so the decision is unit-testable without mounting the layout (docs/editor.md
 *  § Panels). */

export const LAYOUT_TAB_ID_PREFIX = 'layout.tab.';

/** The slice of FlexLayout's `TabNode` this needs — structural, so a test needs no Model. */
export interface TaggableTab {
  getComponent(): string | undefined;
  isSelected(): boolean;
}

/** The attributes for one tab's content span, or null for a tab with no component (nothing an
 *  agent could name it by). The id is the COMPONENT, not FlexLayout's node id: node ids are
 *  generated per layout load, and `openPanels` / `modoki_focus {panel}` already speak components. */
export function layoutTabTagAttrs(tab: TaggableTab): Record<string, string> | null {
  const component = tab.getComponent();
  if (!component) return null;
  return {
    'data-ui-id': `${LAYOUT_TAB_ID_PREFIX}${component}`,
    'data-ui-kind': 'tab',
    'data-ui-state': tab.isSelected() ? 'selected' : 'unselected',
  };
}
