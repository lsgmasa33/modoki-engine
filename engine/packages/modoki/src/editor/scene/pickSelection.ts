/** What a viewport PICK means for the selection — the shared 2D + 3D rule.
 *
 *  Extracted from `SceneView.tsx` (#105 Phase 2), where it was a store-coupled
 *  function called from both the 2D pointer path and the 3D raycast path. It
 *  mirrors the Hierarchy panel deliberately, so picking in a viewport and clicking
 *  in the tree behave the same.
 *
 *  The rule that is easy to get wrong, and the reason this is worth its own module:
 *  **an empty-space click only clears the selection when it is UNMODIFIED.** A
 *  Shift- or Ctrl-click that happens to miss everything must leave the selection
 *  alone — otherwise a mis-aimed modifier click, or the press that begins a marquee
 *  drag, destroys the multi-selection the user was building. */

export interface PickModifiers {
  /** Shift — add the picked entity and make it primary. */
  additive: boolean;
  /** Ctrl/Cmd — toggle the picked entity in or out. */
  toggle: boolean;
}

export type PickSelectionCommand =
  /** Leave the selection exactly as it is. */
  | { kind: 'keep' }
  /** Clear it — only ever from an unmodified empty-space click. */
  | { kind: 'clear' }
  | { kind: 'toggle'; id: number }
  /** Replace the whole set. The store dedupes, so re-adding a selected entity is
   *  idempotent and simply makes it primary. */
  | { kind: 'set'; ids: number[]; primary: number }
  | { kind: 'select'; id: number };

/** Resolve a pick against the current selection.
 *
 *  `entityId` is null when the pick hit nothing. `current` is only consulted for
 *  the additive case; the store owns the actual set. */
export function resolvePickSelection(
  entityId: number | null,
  mods: PickModifiers,
  current: ReadonlyArray<number>,
): PickSelectionCommand {
  if (entityId === null) {
    // Modified empty-space click preserves the selection — see the module note.
    return mods.additive || mods.toggle ? { kind: 'keep' } : { kind: 'clear' };
  }
  if (mods.toggle) return { kind: 'toggle', id: entityId };
  if (mods.additive) return { kind: 'set', ids: [...current, entityId], primary: entityId };
  return { kind: 'select', id: entityId };
}
