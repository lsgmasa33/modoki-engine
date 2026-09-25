/** The prose of an ENTITY AIM, stated once for both MCP servers (#1555).
 *
 *  Every aimed input tool carries its own copy of the aim STRUCTURE — the §1 no-`$ref` rule forces
 *  that, because a schema reused by reference is emitted as a `$ref` a client may not resolve (see
 *  `makeEntitySpec` in `modoki-mcp/src/shapes.ts`). The structure has to repeat; the prose did not,
 *  and it rode along: measured 2026-09-25, description strings over 80 B repeated three or more
 *  times came to 26.8 KB across the two servers, with `allowOccluded` alone in ten wordings. A loaded
 *  schema is paid for once and then re-read on every later turn, so each copy is a recurring cost.
 *
 *  So the rule, stated once and checked by `mcpDescriptionProse.test.ts`:
 *  - each concept has ONE base wording here, and a server or tool that must say more APPENDS to it;
 *  - a NESTED restatement of a rule the same tool already states points at that statement instead
 *    (`ALLOW_OCCLUDED_NESTED`, `sameAs`). It points WITHIN the tool, never at another tool: under
 *    deferral a cross-tool pointer costs a whole schema load, which is the cost being cut.
 *
 *  STRINGS, not schemas: the editor server is on zod 3 and the device server on zod 4, so neither
 *  can import the other's factories — which is how the two wordings drifted apart in the first
 *  place. Dependency-free like `inputVocabulary.ts`. */

/** An entity aim's call contract. Each server appends what differs: the editor, what `occlusionScope`
 *  values mean; the device, its stale-guid refusal and the missing mesh picker. */
export const ENTITY_AIM_BASE =
  'Aim at a SCENE ENTITY by exactly one of {guid} | {name} | {id}, resolved to its live screen rect '
  + 'inside this call — no read-then-tap race. {id} only for an entity with no guid: runtime ids '
  + 'change on every reload. A name matching several entities is REFUSED, never first-match. A 2D/3D '
  + 'entity REQUIRES `surface`. Overrides `selector` and x/y';

/** `entity.surface`. Each server appends what its enum values mean — the editor has `scene-view` and
 *  mounts every UI entity in two panels; a shipped game has neither. */
export const SURFACE_AIM_BASE =
  'Which on-screen copy of the entity to aim at. REQUIRED for a 2D/3D entity, even when only one '
  + 'surface shows it; for a UI entity, only once it is mounted more than once';

/** The occlusion escape hatch, for a tool's TOP-LEVEL `allowOccluded`. A tool appends what differs
 *  (drag: both endpoints; pointer: the down only; a handle tool: a covered handle reads as inert).
 *
 *  ⚠️ The scope clause names what the flag ACTUALLY governs — any aim the tool RESOLVES — rather than
 *  listing modes. It named only `entity` and `selector` until #1218's close-out, which was wrong in
 *  both directions: a `label` aim rides the selector path and IS refused, and `tap_handle`/
 *  `drag_handle` have neither mode — their only aim is a handle id — so an agent reading it literally
 *  concluded the flag was inert there. */
export const ALLOW_OCCLUDED_BASE =
  'Aim there even though something covers the target. Default false = REFUSED as OCCLUDED, naming '
  + 'the cover — a covered press lands on the cover, so ok would be a false success. Applies to every '
  + 'aim this tool resolves (entity, selector, label, handle id — whichever it takes); a raw {x,y} is '
  + 'never refused';

/** A nested `allowOccluded` (on `entity`, or on a drag endpoint): the same flag scoped to one aim. */
export const ALLOW_OCCLUDED_NESTED = 'The top-level `allowOccluded` rule, for this aim only.';

/** A field whose sibling in the same tool already says everything — drag's `to` against `from`. */
export const sameAs = (path: string): string => `As \`${path}\`.`;
