import { trait } from 'koota';

/** GroupAlpha — fade an entity AND everything under it in the 2D layer (#211).
 *
 *  `Scene2D` renders a flat PixiJS tree: every display object goes straight onto its Canvas2D
 *  slot container, so a parent's alpha does not reach its children the way nested DOM/CSS
 *  opacity does for UI. Fading a whole canvas is already solved (CSS opacity on the `2D Canvas`
 *  UI node composites all of PixiJS at once). This trait is for fading PART of a 2D scene —
 *  one actor and its attachments, a tray but not the board, a group flashing on hit.
 *
 *  Semantics follow Unity's CanvasGroup and a PixiJS container: the value multiplies this
 *  entity and every descendant, and nested groups multiply together. It COMPOSES with
 *  `Renderable2D.opacity` rather than replacing it — the drawn alpha is `opacity × group` — so
 *  a game that already drives per-entity opacity for its own reasons (drag ghosts, dimming a
 *  used item) keeps doing that while a group fade rides on top.
 *
 *  Put it on any entity, including a bare hierarchy node that renders nothing itself; the
 *  group applies to the subtree either way. Every 2D renderable kind honours it — sprites,
 *  primitives, 2D materials, skinned rigs, MTSDF text, and particle emitters.
 *
 *  This is a pure SCALAR trait (see the `traitScalarFields` guard) — it carries one authored
 *  number and no resource handles. */
export const GroupAlpha = trait({
  /** 0 = fully transparent, 1 = unchanged. Clamped to 0..1 per level, so an authored value
   *  above 1 cannot brighten a subtree back up through an ancestor's fade. */
  alpha: 1 as number,
});
