/** The wire contract for `resolve-entity-point`, shared by the renderer that produces it
 *  (`entityResolve.ts`) and the Electron main process that consumes it (`inputRoutes.ts`).
 *
 *  Types only, and DOM-free on purpose — same rule as `domPointContract.ts`: the electron
 *  tsconfig has no `dom` lib, so main cannot import the resolver itself, and a re-declared
 *  copy of a wire shape drifts the moment one side gains a field.
 *
 *  WHY THIS EXISTS. Aimed input had three target surfaces and covered two:
 *
 *    - editor chrome (DOM)          → `selector`, resolved server-side       ✅
 *    - canvas editor handles        → `modoki_handles` + `tap_handle` by id  ✅
 *    - SCENE ENTITIES in a viewport → `{x,y}` read in a PRIOR call           ❌
 *
 *  That last row is the read-then-act race the whole Enact design exists to kill: coordinates
 *  fetched in one round-trip and clicked in the next are aiming at where the entity WAS. This
 *  contract closes it — `{guid}`/`{name}` resolves to the entity's live screen rect INSIDE the
 *  same call that dispatches the click. See `docs/enact.md`. */

// Type-only, and DOM-free like the rest of this file — `mcpResult.ts` is dependency-free
// (`docs/mcp-tool-conventions.md` §9), so pulling just the `ErrorCode` union in does not
// smuggle any MCP/DOM/node surface into the main-process program that consumes this contract.
import type { ErrorCode } from '../../tools/shared/mcpResult';

/** Which entity to aim at. Exactly one field is used, in the order guid → name → id.
 *
 *  Prefer `guid`. Runtime `id`s are REASSIGNED on every scene reload (and a scene mutate
 *  triggers one), so an id captured a moment ago can name a different entity by the time it is
 *  used — the same trap `docs/debug-tools-mcp.md` warns about for every other addressed tool. */
export interface EntityPointSpec {
  guid?: string;
  name?: string;
  id?: number;
  /** Which on-screen surface to aim in — `'game-3d'` | `'game-2d'` | `'scene-view'` | `'game-ui'`.
   *
   *  **REQUIRED for a 2D/3D entity; for a UI entity, required only when it is mounted more than
   *  once.** Not a style preference:
   *
   *  - A 2D/3D entity can be measured by several viewports at once, and in the editor usually is
   *    (Scene + Game panels open ⇒ a rect in each, through different cameras). It is a genuine
   *    fork — author it in the SceneView vs play it in the GameView — so only the caller knows.
   *  - It is required even when only ONE surface has the entity. Accepting the aim there would
   *    succeed without the caller ever stating what it meant, so nothing could check the intent:
   *    an agent that believed it was clicking the GameView, while only the SceneView had the
   *    entity aimable, would get a success and a wrong belief. Refusing and naming what is
   *    actually on screen corrects the belief instead of confirming the wrong one.
   *  - A UI entity is NOT necessarily a single DOM node (independent review, 2026-07-30). The
   *    editor mounts a UIRenderer in both SceneView's `[data-ui-preview-frame]` and GameView's
   *    `[data-game-view-area]`, so with both panels open each UI entity has TWO live nodes. This
   *    used to be documented as "one node, nothing to choose" and `surface` was REFUSED on that
   *    ground, while the aim silently took the first match in document order. It is now accepted
   *    and REQUIRED when the entity really does resolve to more than one node — but, unlike 2D/3D,
   *    NOT required when there is only one: a shipped game (and an editor with a single host
   *    mounted) has exactly one node, so demanding it there would break correct calls to buy
   *    nothing. The response always echoes the surface actually aimed at. */
  surface?: string;
  /** Aim at the entity even when the surface's own hit-test says something else is in front of
   *  it, and report what was actually hit. Default `false`.
   *
   *  WHY THE DEFAULT REFUSES. An `entity` aim expresses intent about an ENTITY — "click the
   *  character" — so if the game would not select that character, the intent has FAILED. Quietly
   *  dispatching lands a click that either does nothing or selects the wall, and reports success
   *  either way. Refusing is the same refuse-don't-approximate rule the rest of this file
   *  follows (owner: *"it should fail if the game is not allowing to select a human behind the
   *  wall"*, 2026-07-29).
   *
   *  This flag is the legitimate "click it regardless and see what happens" escape hatch — the
   *  capability stays intact, it just is not the default. It has no effect on surfaces without a
   *  pick provider (nothing to be occluded BY, as far as anything can tell), and none on the
   *  `selector` path, which expresses intent about a POINT rather than an entity. */
  allowOccluded?: boolean;
}

/** How far the occlusion check can actually see. Reported so `occluded: false` is never read
 *  as a stronger guarantee than it is.
 *
 *  - `element` — UI-layer entities. The entity IS a DOM node (`[data-entity-id]`), so this is
 *    the same element-level comparison the `selector` path makes: anything covering it,
 *    including another UI entity, is detected.
 *  - `entity` — 2D/3D entities on a surface that has a PICK PROVIDER registered
 *    (`registerPickProvider`, `runtime/core/screenPick.ts`). The surface's own hit-test was
 *    asked what a click at the aim point would select, so entity-vs-entity occlusion inside
 *    the canvas IS checked: a mesh in front of the target is detected and the aim is refused.
 *    This is a PREDICTION of that surface's picking, not a second opinion about it — see the
 *    rule in `screenPick.ts`.
 *  - `canvas`  — 2D/3D entities on a surface with NO pick provider. They are pixels inside a
 *    canvas, not DOM nodes, so the check can only answer "does something cover the CANVAS at
 *    this point" (a panel, a dialog, an overlay). **Entity-vs-entity occlusion inside the
 *    canvas is NOT checked** — a mesh directly in front of the target reports
 *    `occluded: false`. This is the honest fallback, not a bug: the engine deliberately ships
 *    no default picker for the runtime GameView surfaces, because selection policy is game
 *    code. A game opts in by registering a provider, which promotes its aims to `'entity'`. */
export type OcclusionScope = 'element' | 'canvas' | 'entity';

/** How the aim point inside the entity's projected rect was chosen. Only meaningful on the
 *  `'entity'` scope — without a picker there is nothing to validate the centre against.
 *
 *  - `centre`  — the centre of the projected rect picked the target. The clean case.
 *  - `sampled` — the centre did NOT pick the target (a torus, an L-shape, a crescent: any
 *    concave or hollow mesh whose AABB centre is not ON it), so the rect was sampled and the
 *    first point that picked the target was used. Reported so a sampled aim is never mistaken
 *    for a clean centre hit. */
export type AimedAt = 'centre' | 'sampled';

export interface EntityPointResolution {
  ok: boolean;
  /** Present when `ok` is false — why the entity could not be aimed at. */
  error?: string;
  /** Machine-readable twin of `error`, for the FOUR refusals this resolver can name precisely
   *  (`docs/mcp-tool-conventions.md` §5): `NOT_FOUND` (guid/id/name matched nothing), `AMBIGUOUS`
   *  (a `name` matched more than one entity), `AMBIGUOUS_SURFACE` (mounted in several on-screen
   *  surfaces and `surface` was not given), `OCCLUDED` (a default, non-`allowOccluded` aim was
   *  refused because something else is in front). Every other refusal here stays uncoded — the
   *  caller's generic `REFUSED_BY_OP` fallback is the honest answer for those. */
  code?: ErrorCode;
  x?: number;
  y?: number;
  /** Who resolved. Echoed back so a `{name}` aim can be checked against the entity actually
   *  hit, and so a guid-addressed call still reports the (volatile) id it resolved to. */
  entity?: { id: number; name: string; guid?: string; layer?: string | null };
  /** Short descriptor of the resolved entity, mirroring the selector path's `matched`. */
  matched?: string | null;
  /** Which surface the aim point was measured in — 2D/3D AND ui. Reported ALWAYS, not just when
   *  ambiguous: "I clicked the cube" is only checkable if the answer says which cube-on-screen
   *  it clicked, and the same is true of a HUD button that exists in two panels at once. */
  surface?: string;
  /** Descriptor of the TOPMOST DOM element at (x,y) — who will actually receive the click. */
  hitTarget?: string | null;
  /** True when something covers the aim point. Read together with `occlusionScope`.
   *
   *  On the `'entity'` scope an occluded ENTITY aim is normally a REFUSAL (`ok: false`), so a
   *  successful resolution carries `occluded: true` only when `allowOccluded` was passed. */
  occluded?: boolean;
  occlusionScope?: OcclusionScope;
  /** Which entity the surface's own hit-test says is actually at the aim point — `null` for
   *  empty space. Only set on the `'entity'` scope. This is what names the covering mesh in a
   *  refusal, the way `hitTarget` names a covering DOM element. */
  occludedByEntity?: { id: number; name: string; guid?: string } | null;
  /** How the aim point was chosen — see `AimedAt`. Only set on the `'entity'` scope. */
  aimedAt?: AimedAt;
  /** How many points were tried before giving up, when the centre missed and the rect was
   *  sampled. Reported whenever sampling ran — an unreported cap reads as "we looked
   *  everywhere", so the budget is always visible rather than silently truncating the search. */
  samplesTried?: number;
}
