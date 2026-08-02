/** Which on-screen SURFACE a UI DOM node belongs to.
 *
 *  WHY THIS EXISTS (independent review, 2026-07-30). A UI entity was treated as "one DOM node, so
 *  there is nothing to choose between" — `entityResolve.ts` aimed with a bare
 *  `document.querySelector('[data-entity-id=…]')` (first match in document order) and REFUSED a
 *  `surface` argument on that stated ground, while `layoutDump.ts` pushed one unlabelled entry per
 *  node.
 *
 *  It is not one node. The editor mounts a `UIRenderer` TWICE — inside `[data-ui-preview-frame]`
 *  (SceneView's device-sized UI preview) and inside `[data-game-view-area]` (GameView) — and every
 *  `UINode` stamps `data-entity-id`. So with both panels open each UI entity has two live nodes,
 *  and:
 *    - an aim picked one of them by document order and reported success, so a tap meant for the
 *      running game could land in the SceneView preview (or vice versa) with nothing saying so;
 *    - `get_scene_state?bounds=1` kept only the LAST rect per id, because `agentBridge`'s dedupe
 *      records `otherSurfaces` only when the previous entry HAS a surface — and for UI it was
 *      always `undefined`, reinstating the very "keep the last, drop the rest" behaviour the
 *      comment above it claims to have fixed.
 *
 *  The 2D/3D branch was hardened for exactly this (enumerate, label, choose deliberately). This is
 *  the same treatment for UI, sharing the vocabulary so `surface` means one thing everywhere.
 *
 *  ASYMMETRY WITH 2D/3D, deliberate: a 2D/3D aim requires `surface` even when only one viewport has
 *  the entity, because every mounted viewport measures every entity — multi-surface is the norm
 *  there, so a bare call is a belief with nothing to check it against. A UI entity has exactly one
 *  node in a shipped game and in an editor with a single host mounted, so requiring it always would
 *  break every correct existing call to buy nothing. Here `surface` is required only when the
 *  entity really does resolve to more than one node — the ambiguity is refused, never first-matched.
 */

/** Surface names for the two UI hosts, matching the 2D/3D vocabulary in `collectScreenBounds`. */
export const UI_SURFACE_SCENE_VIEW = 'scene-view';
export const UI_SURFACE_GAME = 'game-ui';

/** The surface a UI node is rendered in, or null when it is in neither known host (a shipped game,
 *  or a host that has not been taught to identify itself — treated as unlabelled rather than
 *  guessed at). */
export function uiSurfaceOf(el: Element): string | null {
  if (el.closest('[data-ui-preview-frame]')) return UI_SURFACE_SCENE_VIEW;
  if (el.closest('[data-game-view-area]')) return UI_SURFACE_GAME;
  return null;
}

/** Every live DOM node for a UI entity, each labelled with its surface. Plural on purpose — see
 *  the module comment. Empty when the entity is not currently rendered. */
export function uiNodesFor(id: number): Array<{ el: Element; surface: string | null }> {
  if (typeof document === 'undefined') return [];
  return [...document.querySelectorAll(`[data-entity-id="${id}"]`)]
    .map((el) => ({ el, surface: uiSurfaceOf(el) }));
}

/** A node's surface for display and selection — the same `unlabelled-<layer>` fallback shape the
 *  2D/3D branch uses, so a caller sees one naming convention. */
export function namedUiSurface(surface: string | null): string {
  return surface ?? 'unlabelled-ui';
}
