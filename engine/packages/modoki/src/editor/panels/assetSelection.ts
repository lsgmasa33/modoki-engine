/** Mouse-selection policy for the Assets panel — what a click and a drag MEAN.
 *
 *  Extracted from `Assets.tsx` (#105 Phase 3). The keyboard twin lives in
 *  `assetKeyCommands.ts`; both were trapped in the panel with no unit cover.
 *
 *  The rule worth pinning is the anchor's: a Shift-click ranges from the anchor
 *  and LEAVES IT ALONE, so a second Shift-click re-ranges from the same origin
 *  rather than from the previous click. Plain and toggle clicks move it. Getting
 *  that backwards makes a range walk instead of grow, which looks like the panel
 *  losing the user's selection. */

import { rangeBetween } from './hierarchySelection';

export interface ClickSelection {
  /** The new selection. */
  paths: Set<string>;
  /** The anchor to store back. ABSENT ⇒ leave it where it is. */
  anchor?: string;
}

/** Resolve a row click against the current selection.
 *
 *  - **Shift** (with a live anchor): select the visible range between anchor and
 *    target. An anchor that has scrolled out of the visible order yields no range,
 *    and the click degrades to selecting just the clicked row — never an empty
 *    selection.
 *  - **Cmd/Ctrl**: toggle this row in or out, keeping the rest.
 *  - **Plain**: replace the selection with this row.
 */
export function resolveClickSelection(opts: {
  path: string;
  current: ReadonlySet<string>;
  anchor: string | null;
  order: ReadonlyArray<string>;
  toggle: boolean;
  range: boolean;
}): ClickSelection {
  const { path, current, anchor, order, toggle, range } = opts;

  if (range && anchor) {
    const span = rangeBetween([...order], anchor, path);
    // No `anchor` key ⇒ unchanged, so the next Shift-click ranges from the same origin.
    return { paths: new Set(span ?? [path]) };
  }

  if (toggle) {
    const next = new Set(current);
    if (next.has(path)) next.delete(path); else next.add(path);
    return { paths: next, anchor: path };
  }

  return { paths: new Set([path]), anchor: path };
}

/** The paths a drag carries: the whole selection when the dragged row is part of a
 *  MULTI-selection, otherwise just that row.
 *
 *  The `size > 1` guard matters — without it, dragging the single selected row
 *  would still take the "whole selection" branch, which is the same thing but
 *  allocates a copy; with a row OUTSIDE the selection it must take only that row,
 *  so dragging an unselected asset cannot silently move the selected ones. */
export function dragPathsFor(path: string, selection: ReadonlySet<string>): string[] {
  return selection.has(path) && selection.size > 1 ? [...selection] : [path];
}
