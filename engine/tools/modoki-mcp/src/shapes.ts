/** Zod shapes shared by more than one tool.
 *
 *  These exist as ONE definition on purpose: `entity` aiming, point aiming and the `save` param
 *  must mean the SAME thing in every tool that accepts them. A per-tool copy is exactly how a
 *  surface drifts into "one tool works one way, another works another way".
 *
 *  Side-effect-free — see `context.ts` for why that matters.
 */

import { z } from 'zod';
import { EDITOR_INPUT_MODIFIERS } from '../../shared/inputVocabulary.js';
import { ALLOW_OCCLUDED_BASE, ALLOW_OCCLUDED_NESTED, ENTITY_AIM_BASE, SURFACE_AIM_BASE, sameAs } from '../../shared/aimVocabulary.js';
import { nestedUnknownKeyMessage } from '../../shared/unknownParam.js';

/** The refusal for a NESTED strict object: its fixed "X accepts only: …" sentence, prefixed with
 *  the key(s) the caller actually sent (`shared/unknownParam.ts`). An `errorMap` rather than
 *  `.strict(message)`, because a fixed string cannot see `issue.keys` — and the SDK reports only
 *  the message plus the path. Any other issue on the object keeps zod's own text. */
export const unknownKeysErrorMap = (accepts: string): z.ZodErrorMap => (issue, ctx) => ({
  message: issue.code === 'unrecognized_keys' ? nestedUnknownKeyMessage(accepts, issue.keys) : ctx.defaultError,
});

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

// Chromium input modifiers, shared by the trusted-input tools below. Derived from the table the
// `/api/input/*` routes refuse against (#1076), so the advertised enum and the enforced one are one list.
export const modifierEnum = z.enum(EDITOR_INPUT_MODIFIERS);

/** A point to aim trusted input at: page CSS coordinates, or a CSS selector resolved to
 *  the element's center inside the same call (no read-then-tap race).
 *
 *  A FACTORY, not a shared const: `zod-to-json-schema` dedupes a schema reused BY REFERENCE
 *  within one tool's shape into a `$ref` in the advertised inputSchema (measured against
 *  `modoki_drag`, whose `from`/`to` both carried this object — `to.entity` came out as a bare
 *  `{"$ref": "#/properties/from/properties/entity"}`, no `type` at that node). A client that does
 *  not resolve JSON Schema `$ref` sees an untyped field and can mis-encode it — the exact failure
 *  mode that broke `modoki_dnd` (see `makeDndEndpoint` in `tools/input.ts`). Every call site making
 *  its own instance keeps each one a plain inline object in the schema, no `$ref` involved.
 *
 *  `brief` builds the SECOND copy inside one tool (drag's `to`): the structure still has to be a
 *  fresh inline object, but every description becomes a pointer at the same field under `sameAs`
 *  (#1555) — the prose was 2.5 KB per copy and said nothing the first copy did not. */
export const makeEntitySpec = (brief?: { sameAs: string }) => z.object({
  guid: z.string().optional(),
  name: z.string().optional(),
  id: z.number().int().optional(),
  surface: z.enum(['game-3d', 'game-2d', 'scene-view', 'game-ui']).optional()
    .describe(brief ? sameAs(`${brief.sameAs}.surface`) : `${SURFACE_AIM_BASE}. 'scene-view' = the editor ` +
      'authoring viewport, incl. its UI preview frame (the editor mounts a UI host in BOTH the Scene and ' +
      "Game panels); 'game-3d'/'game-2d' = the running game's canvases; 'game-ui' = its DOM UI layer."),
  allowOccluded: z.boolean().optional().describe(ALLOW_OCCLUDED_NESTED),
}, { errorMap: unknownKeysErrorMap('an entity aim accepts only: guid, name, id, surface, allowOccluded') }).strict().describe(
  brief ? sameAs(brief.sameAs) : `${ENTITY_AIM_BASE}. The reply's \`occlusionScope\` says how far the cover ` +
  'check could see: "element" (UI, a real DOM comparison), "entity" (the surface\'s hit-test ran, so a ' +
  'mesh in front is detected and refused), or "canvas" (DOM covering only — a mesh in front is NOT ' +
  'detected, so a clear result proves less). Detail: docs/debug-tools-mcp.md § Aiming.');

/** The one description of the occlusion escape hatch now lives in `tools/shared/aimVocabulary.ts`,
 *  shared with the device server; re-exported so the input tools keep one import site. */
export { ALLOW_OCCLUDED_BASE };
export const allowOccludedParam = z.boolean().optional().describe(`${ALLOW_OCCLUDED_BASE}.`);

/** The shared half of every `timeoutMs` description (#1154 made it three tools). Each tool
 *  CONCATENATES its own default and ceiling, which really do differ. */
export const TIMEOUT_MS_BASE = 'How long to wait before giving up, in ms';

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
}, { errorMap: unknownKeysErrorMap('an entity ref here accepts only: guid, id') }).strict()
  .optional().describe(
    'Alternative to this tool\'s flat `guid`/`id`: the same nested ref shape the aimed-input tools '
    + 'take, accepted here so one addressing form works across the surface. {id} only for an entity '
    + 'with no guid — runtime ids are reassigned on every scene reload. NO `name` HERE, unlike the aimed-input tools: the '
    + 'ops behind these tools address by guid/id and have no name resolver, so accepting one would '
    + 'advertise a capability that does not exist (it reaches the op as an empty ref and comes back '
    + 'as a misleading "this ref is stale"). Look the guid up with modoki_get_scene_state {name} '
    + 'first. Passing both this and a flat `guid`/`id` is refused rather than silently preferring '
    + 'one.',
  );

/** `flatEntityAlias` for a tool whose op addresses by GUID ONLY (`modoki_play_clip`). Sharing the
 *  guid/id alias advertised an `id` the op refuses — and #1545's refusals quote a param's
 *  description, so `play_clip {id:3}` was told "`entity` has a field of that name (entity:
 *  Alternative to this tool's flat `guid`/`id`…)" and sent to a shape that is refused too. */
export const guidOnlyEntityAlias = z.object({
  guid: z.string().optional(),
}, { errorMap: unknownKeysErrorMap('an entity ref here accepts only: guid') }).strict()
  .optional().describe(
    'Alternative to this tool\'s flat `guid`, in the nested shape the aimed-input tools take. GUID '
    + 'only — this op has no id or name resolver; look the guid up with modoki_get_scene_state {name}.',
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
  // An empty string is ABSENT, as in the live resolver (`app/debug/entityRef.ts`, #1223).
  const flatKeys = Object.entries(flat).filter(([, v]) => v !== undefined && v !== '').map(([k]) => k);
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
  'Significant digits for the returned floats (default 9; 0 = exact float64). Verify a value with '
  + 'a TOLERANCE, never string/=== equality';
export const precisionParam = (fields?: string) => z.number().int().nonnegative().optional()
  .describe(`${PRECISION_BASE}.${fields ? ` Rounded fields: ${fields}.` : ''}`);

/** `displayName` — the name the EDITOR records for an opened asset, in ONE wording (#1266).
 *
 *  Shared by four of the `open_*_editor` tools. It was `name` on all five, which is the word that
 *  addresses an ENTITY everywhere else on this surface — so passing an entity name here succeeded,
 *  labelled something with it, and reported ok. Renamed rather than excused, because a param that
 *  silently accepts the wrong thing is §0's rank-1 failure.
 *
 *  ⚠️ Two things the first version of this constant got WRONG, both found by review, and both worth
 *  stating because a shared wording makes a false claim five times instead of once:
 *
 *  1. It said "the editor TAB". No tool sets a tab name — `EditorApp`'s docking effect adds each
 *     panel with `Actions.addNode({name: '<Editor> Editor'})`, a hard-coded literal this never
 *     reaches.
 *  2. It then said "the panel's HEADER", which is true only of the Skin editor. So the base is now
 *     the one thing that IS true of all four — it sets `SelectedAsset.name`, the name the editor
 *     holds for that open asset — and `extra` carries where each one surfaces it, because on two of
 *     them it is consumed as DATA rather than shown: the Animation editor uses it as the CLIP NAME
 *     for a scaffolded clip, and the Skin editor's "Make Prefab" uses it as the ROOT ENTITY NAME
 *     written into a `.prefab.json`. A caller told "label" would not expect either.
 *
 *  ⚠️ `modoki_open_particle_editor` takes NO `displayName`, deliberately. `editingParticleAsset.name`
 *  is read in exactly two places, both `fileName={asset.path.split('/').pop() || asset.name}` — and
 *  `requireAssetPath` guarantees a non-empty path, so that fallback arm is unreachable and the value
 *  had no observable effect anywhere. CLAUDE.md: an unwired field is a lie with a tooltip, so it was
 *  dropped rather than advertised.
 *
 *  `extra` APPENDS. It does not substitute into the sentence, because §2's containment check reds
 *  unless every longer wording contains the shortest VERBATIM — a variant that rewrites the tail is
 *  a second wording, which is exactly what this constant exists to prevent. */
export const DISPLAY_NAME_BASE =
  'The name the editor records for this opened asset (`SelectedAsset.name`) — NOT the dock tab, '
  + 'whose name is fixed. WHERE it then surfaces differs by editor: a panel header, the Inspector\'s '
  + 'asset label (echoed by modoki_get_editor_state as selection.asset.name), or a clip name. '
  + 'Defaults to the filename stem';
export const displayNameParam = (extra?: string) => z.string().optional()
  .describe(`${DISPLAY_NAME_BASE}.${extra ? ` ${extra}` : ''}`);

/** `t` — a time along the open animation clip, in seconds: ONE word and one wording on every tool
 *  that takes it (#1560), matching the clip file's own keyframe field (`Keyframe.t`). */
export const CLIP_TIME_BASE = 'Clip time in seconds (`t`, the clip file\'s own keyframe field)';
export const clipTimeParam = (extra?: string) => z.number().describe(`${CLIP_TIME_BASE}.${extra ? ` ${extra}` : ''}`);

/** `force` — "proceed even though the editor has unsaved work", in ONE wording.
 *
 *  Shared by the five tools that work FROM THE FILES while the editor holds edits the files do not
 *  have (§8's REQUIRES_SAVE rule), around one identical and load-bearing consequence: the thing
 *  you produce does not contain your work.
 *
 *  ⚠️ **The wording was ARTIFACT-SPECIFIC and is no longer** (#872/#882). It said "the artifact is
 *  built from the FILES", which was true of the original three (`build`/`add_native_target`/
 *  `ota_publish`) and false of the two that joined them: `modoki_reimport_asset` bakes an asset
 *  from a `.meta.json` it reads off disk, and `modoki_duplicate_asset` copies one. Same rule, same
 *  consequence, no artifact — so the shared string now names the CAUSE (this reads disk) rather
 *  than one family's output. Widening the wording was the alternative to five tools stating one
 *  rule two ways, which is exactly the drift §2's containment guard exists to catch.
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
  'Proceed even though the editor has unsaved work this operation cannot see. It works from DISK, '
  + 'so your unsaved changes are NOT included. NON-DESTRUCTIVE: that work is left alone, merely not '
  + 'used — prefer modoki_save_all first. The tools that DESTROY it take `discardUnsaved` instead.',
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
/** ⚠️ **The base was WORLD-SWAP-SPECIFIC and is no longer** (#872). It opened "Swap the world even
 *  though…" and ended "…AND from the undo stack" — true of the three world-swapping tools, false of
 *  `modoki_write_asset_meta`, which swaps nothing and destroys a parked `.meta.json` edit that was
 *  never on the undo stack in the first place.
 *
 *  §2's containment guard is what forces the resolution, and it forces the RIGHT one: every variant
 *  of a 3+-tool param must contain the shortest verbatim, so a fourth tool cannot quietly restate
 *  the rule its own way, and it cannot be given a different NAME either — same consequence, same
 *  name. The base therefore states the CONSEQUENCE (unsaved editor work is destroyed) and each tool
 *  appends what that work is for it.
 *
 *  ⚠️ **That fix was HALF-APPLIED until #1218's close-out.** The opening sentence was rewritten and
 *  the undo-stack clause — the specific thing this comment says was false for `write_asset_meta` —
 *  was left in the string, so three more tools inherited it as they adopted the base. It now states
 *  what is true of every member: the discarded work's undo entries go with it (#1409 — a world
 *  swap drops a DIRTY scene's history; a clean one is parked per scene), and a parked sidecar or
 *  document edit was never ON it, so in both cases undo is not the way back. The containment guard
 *  could never have caught this: all six wordings contained the base verbatim, wrong clause and
 *  all. A shared constant makes one wrong clause wrong N times, silently. */
export const DISCARD_UNSAVED_BASE =
  'Proceed even though this DESTROYS unsaved editor work. ⚠️ DESTRUCTIVE and IRREVERSIBLE: what '
  + 'it destroys is gone from the editor and from the file, and undo is not the way back — its '
  + 'undo entries go with it, and a parked edit was never on it. It destroys '
  + 'only what THIS operation overwrites or replaces, NOT everything the editor is holding: a '
  + 'world swap leaves a parked .meta.json import-settings edit untouched, and a sidecar write '
  + 'leaves the live world untouched — so this is never a way to clear an unrelated '
  + 'REQUIRES_SAVE. Prefer modoki_save_all first. Not `force`: that is the NON-destructive flag '
  + 'on modoki_build / modoki_add_native_target / modoki_ota_publish, which destroys nothing';
export const discardUnsavedParam = z.boolean().optional().describe(`${DISCARD_UNSAVED_BASE}.`);

/** The `label` aim (#1153): editor chrome by its visible label. Factories, not shared consts, for
 *  the `$ref`-dedup reason `makePointSpec` documents below — drag's `from`/`to` both carry them. */
export const makeLabelAimParam = () => z.string().optional().describe(
  'Editor chrome (data-ui-id control or dock tab) by its WHOLE label, e.g. "Console"; case-insensitive. '
  + 'Refused unless exactly one on-screen match. Not with selector, entity or x/y.',
);
export const makeWithinParam = () => z.string().optional().describe(
  'CSS selector scoping `label`, e.g. \'[data-panel-scope="assets"]\'.',
);

/** A factory for the same `$ref`-dedup reason as `makeEntitySpec` above — `modoki_drag` uses this
 *  twice (`from`/`to`) in one shape, so a shared instance would dedupe the same way.
 *
 *  ⚠️ EVERY field must be built FRESH inside this factory, not read from a shared module-level
 *  const — `allowOccluded` used to reference the shared `allowOccludedParam` here, and because
 *  `zod-to-json-schema` dedupes by REFERENCE (not by structural shape), `to.allowOccluded` still
 *  came back as `{"$ref": "#/properties/from/properties/allowOccluded"}` even after `from`/`to`
 *  themselves stopped sharing an object (close-out review caught this: the dedup just moved one
 *  level deeper, into the one field this factory forgot to freshen). A client that doesn't
 *  resolve `$ref` reads that field as untyped and can encode `true`/`false` as a string — the
 *  exact `modoki_dnd` failure this factory exists to prevent, one field short of covering it. */
export const makePointSpec = (brief?: { sameAs: string }) => z.object({
  x: z.number().optional(),
  y: z.number().optional(),
  selector: z.string().optional(),
  // The SAME factories either way — `brief` swaps only the prose, so a constraint added to the label
  // param later reaches both endpoints instead of silently skipping `to` (#1555 review).
  label: brief ? makeLabelAimParam().describe(sameAs(`${brief.sameAs}.label`)) : makeLabelAimParam(),
  within: brief ? makeWithinParam().describe(sameAs(`${brief.sameAs}.within`)) : makeWithinParam(),
  entity: makeEntitySpec(brief && { sameAs: `${brief.sameAs}.entity` }).optional(),
  allowOccluded: z.boolean().optional().describe(ALLOW_OCCLUDED_NESTED),
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
// A FACTORY, not a shared const — three `mutateOpSchema` variants (setTrait/removeTrait/
// removeEntity) each need their own `entity` schema INSTANCE. Found by the close-out $ref sweep
// (mcpSchemaNoRef.test.ts): `mutateOpSchema` is itself an array-element schema, so all 5 variants
// live in ONE root tree, and the old shared `entityRef` const dedupe'd into removeTrait/
// removeEntity's `entity` field coming back as a bare `$ref` — the same class of bug as
// `modoki_dnd`'s `to`, just one level inside `modoki_mutate_scene`'s `ops` array.
const makeEntityRef = () => z.object({
  id: z.number().int().optional(),
  name: z.string().optional(),
  guid: z.string().optional(),
}, { errorMap: unknownKeysErrorMap('an entity ref accepts only: id, name, guid') }).strict();

export const mutateOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('setTrait'),
    entity: makeEntityRef(),
    trait: z.string(),
    fields: z.record(z.any()).optional(),
    space: z.enum(['local', 'world']).optional(),
  }, { errorMap: unknownKeysErrorMap("setTrait accepts: op, entity, trait, fields, space (note `fields`, not `feilds`)") }).strict(),
  z.object({
    op: z.literal('removeTrait'),
    entity: makeEntityRef(),
    trait: z.string(),
  }, { errorMap: unknownKeysErrorMap('removeTrait accepts: op, entity, trait') }).strict(),
  z.object({
    op: z.literal('addEntity'),
    name: z.string().optional(),
    parentId: z.union([z.number(), z.string()]).optional(),
    traits: z.record(z.union([z.record(z.any()), z.boolean()])).optional(),
  }, { errorMap: unknownKeysErrorMap('addEntity accepts: op, name, parentId, traits') }).strict(),
  z.object({
    op: z.literal('removeEntity'),
    entity: makeEntityRef(),
  }, { errorMap: unknownKeysErrorMap('removeEntity accepts: op, entity') }).strict(),
  z.object({
    op: z.literal('setBaseScene'),
    baseScene: z.string().nullable(),
  }, { errorMap: unknownKeysErrorMap('setBaseScene accepts: op, baseScene') }).strict(),
]);
