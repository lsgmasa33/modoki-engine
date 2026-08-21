/** Zod shapes shared by more than one tool.
 *
 *  These exist as ONE definition on purpose: `entity` aiming, point aiming and the `save` param
 *  must mean the SAME thing in every tool that accepts them. A per-tool copy is exactly how a
 *  surface drifts into "one tool works one way, another works another way".
 *
 *  Side-effect-free — see `context.ts` for why that matters.
 */

import { z } from 'zod';

/* `SAVE_PARAM` was here. REMOVED 2026-08-22 (owner decision).
 *
 *  It sat on 13 mutating tools reading "IGNORED… Do not pass it", reserved for a
 *  `mcp-persistence-unification.md` Phase 2/3 that no longer exists — the mode knob it was waiting
 *  for was DELETED instead, and `docs/mcp-persistence.md` has said "treat it as removed" since.
 *  Two sources, two statuses, and an advertised parameter that did nothing.
 *
 *  The kept-for-compatibility argument does not apply on an agent surface: there are no legacy
 *  callers, only a model reading the schema fresh each session. And with `.strict()` armed,
 *  REMOVING it is strictly better than keeping it — a passed `save` is now a refusal naming the
 *  tool's real parameters (§1/§5) instead of being silently accepted and ignored. Persistence is
 *  manual-only: `modoki_save_all` is the one route to disk. */

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
export const ALLOW_OCCLUDED_BASE =
  'Aim there even though something covers the target (default false = REFUSED, naming the cover). '
  + 'A covered press lands on the covering element, so reporting ok would be a false success — the '
  + 'worst outcome on this surface. Applies to `entity` and `selector` aims; raw {x,y} is never '
  + 'refused, because a coordinate is exactly what you asked for';
export const allowOccludedParam = z.boolean().optional().describe(`${ALLOW_OCCLUDED_BASE}.`);

/** The shared half of every `modifiers` description. A tool that needs to say more CONCATENATES —
 *  `${MODIFIERS_BASE}, e.g. …` — rather than replacing, so the rule reads identically everywhere
 *  and the tool-specific nuance sits after it. Enforced: `mcpRegistry.test.ts` requires every
 *  variant of a 3+-tool param to CONTAIN the shortest one. */
export const MODIFIERS_BASE = 'Held modifier keys';

/** The FLAT half of entity addressing, shared by the tools that take `guid`/`id` at top level.
 *
 *  Two shapes coexist on this surface: aimed-input tools nest (`entity:{guid|name|id}`, because
 *  they also accept a selector or a raw point and the aim modes must stay distinguishable), while
 *  the editor-op tools take a flat `guid`. There IS a latent rule there, but it was written nowhere
 *  and it does not hold cleanly — `set_transform` nests without being an input tool, `play_clip` is
 *  flat despite declaring `aim:'entity'` — so `qa/knowledge.md` records the mix-up as a recurring
 *  trap. Post-§1 it costs a refusal and a retry rather than a wrong answer, but it costs it EVERY
 *  time.
 *
 *  Owner decision (2026-08-22): ACCEPT BOTH everywhere rather than document the rule or unify on
 *  one shape. It is purely additive, breaks no existing call, and REMOVES the failure mode instead
 *  of explaining it — which is what §0 says an inconsistency deserves, since the cost of an
 *  inconsistency is the guess it forces.
 *
 *  `entity` is resolved server-side to the same `{guid|id}` the flat params carry, so there is one
 *  meaning and two spellings — not two behaviours. */
export const flatEntityAlias = z.object({
  guid: z.string().optional(),
  id: z.number().optional(),
}).strict('an entity ref here accepts only: guid, id')
  .optional().describe(
    'Alternative to this tool\'s flat `guid`/`id`: the same nested ref shape the aimed-input tools '
    + 'take, accepted here so one addressing form works across the surface. Prefer guid — runtime '
    + 'ids are reassigned on every scene reload. NO `name` HERE, unlike the aimed-input tools: the '
    + 'ops behind these tools address by guid/id and have no name resolver, so accepting one would '
    + 'advertise a capability that does not exist (it reaches the op as an empty ref and comes back '
    + 'as a misleading "this ref is stale"). Look the guid up with modoki_get_scene_state {name} '
    + 'first. Passing both this and a flat `guid`/`id` is refused rather than silently preferring '
    + 'one.',
  );

/** Fold a nested `entity` ref into the flat `{guid, id}` a tool's handler already passes on.
 *
 *  Refuses BOTH-at-once rather than picking: a caller who sent two addresses does not know which
 *  one this tool uses, and choosing for them is exactly the silent-wrong-target class §0 ranks
 *  first. Returns the flat pair, or a message for the caller to refuse with.
 *
 *  ⚠️ `flatEntityAlias` is `.strict()` and carries no `name` ON PURPOSE — both halves matter.
 *  Without `name` but not strict, zod STRIPS the key (a nested `z.object` is not strict just
 *  because its parent is), so `entity:{name:'Crate'}` would arrive here as `{}`, fold to the empty
 *  flat ref, and surface as "entity ref matched no live entity — it may be stale": a §0 rank-4
 *  unclear failure pointing at the wrong cause. That is the §1 silent-key-strip bug one level down,
 *  and it is why `mutateOpSchema`'s entity ref is strict too. */
export function foldEntityRef(
  flat: { guid?: string; id?: number },
  entity: { guid?: string; id?: number } | undefined,
): { guid?: string; id?: number } | { conflict: string } {
  if (!entity || Object.keys(entity).length === 0) return flat;
  // `!== undefined`, not truthiness: `id: 0` is the ROOT entity, and a truthiness test would read
  // it as "no address given" and silently fall through to the other branch.
  const flatKeys = Object.entries(flat).filter(([, v]) => v !== undefined).map(([k]) => k);
  if (flatKeys.length) {
    return { conflict: `both \`entity\` and the flat ${flatKeys.join('/')} were given — they are two ways to say the same thing, and sending both leaves it ambiguous which target you meant. Pass exactly one.` };
  }
  return entity;
}


/** `precision`, in ONE wording (§2).
 *
 *  It said the same thing four ways across seven tools — the long form, a terse "(read)" form, a
 *  per-tool field list, and a scene-query variant. Nothing was wrong with any of them, which is the
 *  point: a param an agent has to re-read per tool to check it still means what it meant is the
 *  cost §2 is about, and every one of these drifted by being restated rather than shared.
 *
 *  `fields` keeps the one genuinely per-tool part — WHICH floats get rounded — without forking the
 *  rule that governs them. */
export const PRECISION_BASE =
  'Significant digits for the returned floats. Default 9 — trims float64 mantissa noise '
  + '(247.13061935179246 -> 247.130619), saving ~17-29% of the response with a max error of '
  + '3.5e-7. Verify a value with a TOLERANCE, never string/=== equality. Pass 0 for exact float64';
export const precisionParam = (fields?: string) => z.number().int().nonnegative().optional()
  .describe(`${PRECISION_BASE}.${fields ? ` Rounded fields: ${fields}.` : ''}`);

/** `force` — "proceed even though the editor has unsaved work", in ONE wording.
 *
 *  Shared by the three tools that build an artifact FROM THE FILES while the live world holds edits
 *  the files do not have (§8's REQUIRES_SAVE rule), around one identical and load-bearing
 *  consequence: the thing you ship does not contain your work.
 *
 *  NO PER-TOOL VERB any more. It used to interpolate "Build"/"Scaffold"/"Publish", which reads
 *  nicely and cost the surface its guard: §2's containment check requires every variant of a
 *  3+-tool param to contain the shortest, and three strings differing in their FIRST word contain
 *  none of each other — so `force` could only stay green by sitting in `PER_TOOL_MEANING`, the
 *  exemption that let a genuine two-meanings violation hide until it was found by hand. One
 *  identical string is worth more than three pretty ones.
 *
 *  With the destructive half renamed to `discardUnsaved`, `force` now means exactly one thing
 *  everywhere it appears, and the guard polices it instead of an exemption list. */
export const unsavedForceParam = z.boolean().optional().describe(
  'Proceed even though the editor has unsaved live-world changes. The artifact is built from the '
  + 'FILES, so it will NOT contain them — this proceeds anyway rather than refusing. Prefer '
  + 'modoki_save_all first; use this only when you mean to ship the last saved state. '
  + 'NON-DESTRUCTIVE: your unsaved work is left alone, merely not included — which is why THIS one '
  + 'keeps the name `force`. The world-swapping tools that destroy it call theirs `discardUnsaved`.',
);

/** `discardUnsaved` — shared by the three tools that SWAP THE WORLD and destroy live work.
 *
 *  RENAMED from `force` (2026-08-22, owner). §2: one name, one meaning. `force` carried two
 *  consequences and the tool's own name did not tell you which — harmless on `build` /
 *  `add_native_target` / `ota_publish` (your work is left alone, merely not in the artifact),
 *  IRREVERSIBLE here.
 *
 *  The failure that made the rename worth a breaking change: an agent uses `force` on a build
 *  (safe, nothing lost), learns "force = proceed despite unsaved work", then meets `load_scene`'s
 *  REQUIRES_SAVE refusal and passes it on the same understanding — destroying the human's
 *  live-world changes from the world, the file AND the undo stack. Naming the consequence instead
 *  of the verb removes the habit rather than warning about it, and `.strict()` (§1) turns the old
 *  spelling into a refusal that lists the real params, so a stale caller is TOLD rather than
 *  silently doing the destructive thing.
 *
 *  Found by the close-out sweep after `modoki_render_sequence.force` was renamed for the same
 *  rule — the sibling, and the one with the worse consequence.
 *  `docs/mcp-tool-conventions.md` §2. */
export const DISCARD_UNSAVED_BASE =
  'Swap the world even though it has unsaved live-world changes. ⚠️ DESTRUCTIVE and IRREVERSIBLE: '
  + 'those changes are gone — from the world, from the file, AND from the undo stack. Prefer '
  + 'modoki_save_all first. This is the param that used to be called `force`; it was renamed '
  + 'because `force` on modoki_build / modoki_add_native_target / modoki_ota_publish destroys '
  + 'NOTHING, and one word cannot mean both';
export const discardUnsavedParam = z.boolean().optional().describe(`${DISCARD_UNSAVED_BASE}.`);

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
