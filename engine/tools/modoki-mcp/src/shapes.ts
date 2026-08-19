/** Zod shapes shared by more than one tool.
 *
 *  These exist as ONE definition on purpose: `entity` aiming, point aiming and the `save` param
 *  must mean the SAME thing in every tool that accepts them. A per-tool copy is exactly how a
 *  surface drifts into "one tool works one way, another works another way".
 *
 *  Side-effect-free — see `context.ts` for why that matters.
 */

import { z } from 'zod';

/** Reserved for the persistence-mode Phase 2/3 per-call override (mcp-persistence-
 *  unification.md) — NOT YET HONORED. Every mutating tool accepts it now so its schema
 *  doesn't need to change again once Phase 2/3 wire it up; every tool's `saved` field in its
 *  result reflects what it ACTUALLY did today, regardless of this param. */
export const SAVE_PARAM = z.boolean().optional().describe(
  'IGNORED. Persistence is manual-only: a live edit stays in the live world (undoable) and ' +
  'reaches disk only via modoki_save_all. Accepted so existing callers do not break; every ' +
  "tool's `saved` field reflects what actually happened. Do not pass it.",
);

// Chromium input modifiers, shared by the trusted-input tools below.
export const modifierEnum = z.enum(['shift', 'control', 'alt', 'meta', 'cmd', 'command']);

/** A point to aim trusted input at: page CSS coordinates, or a CSS selector resolved to
 *  the element's center inside the same call (no read-then-tap race). */
export const entitySpec = z.object({
  guid: z.string().optional(),
  name: z.string().optional(),
  id: z.number().optional(),
  surface: z.enum(['game-3d', 'game-2d', 'scene-view', 'game-ui']).optional()
    .describe("Which on-screen surface to aim in. REQUIRED for a 2D/3D entity — including when " +
      'only one viewport has it. For a UI entity it is OPTIONAL but becomes REQUIRED when the ' +
      "entity resolves to more than one DOM node: the editor mounts a UI renderer in BOTH the " +
      "Scene panel's preview frame ('scene-view') and the Game panel ('game-ui'), so with both " +
      'open every full-screen overlay, modal and HUD button has two live nodes and the aim is ' +
      'refused until you say which. A shipped game (and an editor with one host mounted) has ' +
      'exactly one node, where it stays optional. A 2D/3D entity is often on screen TWICE: with the Scene and Game panels both ' +
      'open, each measures it through its own camera. "Author it in the SceneView" and "play it ' +
      'in the GameView" are different intents, so stating which is how a call keeps meaning the ' +
      'same thing when the layout changes — and how a wrong assumption becomes a refusal that ' +
      "names the real surfaces instead of a success on the wrong viewport. 'scene-view' = the " +
      "editor authoring viewport (3D/2D authoring AND the UI preview frame); 'game-3d'/'game-2d' " +
      "= the running game's canvases; 'game-ui' = the running game's DOM UI layer."),
  allowOccluded: z.boolean().optional()
    .describe('Aim at the entity even when the surface\'s own hit-test says something else is ' +
      'in front of it, and report what was actually hit. Default false: an occluded `entity` ' +
      'aim on a surface with a pick provider (`occlusionScope:\'entity\'`) is a REFUSAL, not a ' +
      'flag — "click the character" failed if the game would not select that character (the ' +
      'character-behind-a-wall case). Pass true as the "click it anyway and see what happens" ' +
      'escape hatch. It applies on EVERY scope: a covered aim is refused whether the cover is ' +
      'another entity (the picker saw it) or a DOM element over the viewport — a modal, a menu, ' +
      'a panel — because the press lands on that either way. What the scope still tells you is ' +
      'how far the check could SEE: on `occlusionScope:\'canvas\'` only DOM covering was ' +
      'checked, so a mesh in front of the target is not detected at all.'),
}).describe(
  'Aim at a SCENE ENTITY by {guid} | {name} | {id} — resolved to its live screen rect INSIDE ' +
  'this call, so there is no read-then-tap race. Prefer guid: runtime ids are reassigned on ' +
  'every scene reload. A name matching several entities is REFUSED (not first-match). A 2D/3D ' +
  'entity additionally REQUIRES `surface`, and a UI entity requires it whenever it is mounted ' +
  'in more than one panel. The response reports ' +
  '`entity` (who resolved), `surface` (WHICH on-screen copy was aimed at), `occluded`, and ' +
  '`occlusionScope`: "element" for a UI entity (a real DOM comparison — trustworthy); "entity" ' +
  'for a 2D/3D entity on a surface with a registered pick provider, where the surface\'s own ' +
  'hit-test was asked what a click would actually select — a mesh in front of the target IS ' +
  'detected, and by default REFUSES the aim (see `allowOccluded`); "canvas" for a 2D/3D entity ' +
  'with no pick provider registered, where only DOM-level covering is detected and a mesh in ' +
  'front of the target is NOT. The response also reports `aimedAt` ("centre" | "sampled" — ' +
  'whether the projected rect\'s centre picked the target or a concave/hollow shape needed a ' +
  'sampled point instead) and `occludedByEntity` (who is actually there) on the "entity" scope. ' +
  'Overrides `selector` and x/y.');

/** The one description of the occlusion escape hatch, shared by every aimed input tool — a rule
 *  worded differently per tool is a rule an agent reads as two rules (mcp-tool-conventions.md §2). */
export const allowOccludedParam = z.boolean().optional().describe(
  'Aim there even though something covers the target (default false = REFUSED, naming the cover). '
  + 'A covered press lands on the covering element, so reporting ok would be a false success — the '
  + 'worst outcome on this surface. Applies to `entity` and `selector` aims; raw {x,y} is never '
  + 'refused, because a coordinate is exactly what you asked for.',
);

export const pointSpec = z.object({
  x: z.number().optional(),
  y: z.number().optional(),
  selector: z.string().optional(),
  entity: entitySpec.optional(),
  allowOccluded: allowOccludedParam,
});

/** The `mutate_scene` op vocabulary as a REAL schema, not `z.record(z.any())`.
 *
 *  `modoki_batch`'s headline guarantee is that every step's args are "validated against its real
 *  schema before ANY step runs". That was only ever ONE LEVEL deep: `.strict()` applies to the top
 *  level, and `ops` was an array of free records — so a typo INSIDE an op passed pre-flight
 *  untouched. `{op:'setTrait', entity:{…}, trait:'Light', feilds:{…}}` validated, then `applyOps`
 *  took the no-fields branch (a re-tag of an existing trait, a genuine no-op), and under
 *  `resultDefault:'none'` the step was suppressed into `quiet` with the batch reporting ok:true.
 *  The misspelling was invisible at every layer.
 *
 *  The vocabulary is fixed and small, so there is no reason for it to be untyped. A discriminated
 *  union also makes the refusal name the op it could not parse. */
const entityRef = z.object({
  id: z.number().int().optional(),
  name: z.string().optional(),
  guid: z.string().optional(),
}).strict('an entity ref accepts only: id, name, guid');

export const mutateOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('setTrait'),
    entity: entityRef,
    trait: z.string(),
    fields: z.record(z.any()).optional(),
    space: z.enum(['local', 'world']).optional(),
  }).strict("setTrait accepts: op, entity, trait, fields, space (note `fields`, not `feilds`)"),
  z.object({
    op: z.literal('removeTrait'),
    entity: entityRef,
    trait: z.string(),
  }).strict('removeTrait accepts: op, entity, trait'),
  z.object({
    op: z.literal('addEntity'),
    name: z.string().optional(),
    parentId: z.union([z.number(), z.string()]).optional(),
    traits: z.record(z.union([z.record(z.any()), z.boolean()])).optional(),
  }).strict('addEntity accepts: op, name, parentId, traits'),
  z.object({
    op: z.literal('removeEntity'),
    entity: entityRef,
  }).strict('removeEntity accepts: op, entity'),
  z.object({
    op: z.literal('setBaseScene'),
    baseScene: z.string().nullable(),
  }).strict('setBaseScene accepts: op, baseScene'),
]);
