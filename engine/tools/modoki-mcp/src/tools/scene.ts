/** Scene + asset READ/WRITE: scene state, mutate, transforms, validation, trait/asset listing.
 *
 *  Registered by `registerAllTools` (`../registerAll.ts`). Side-effect-free on import:
 *  nothing here runs until the register function is called, which is what lets a test
 *  build a context against a stub backend and call these handlers. See `../context.ts`.
 */

import { z } from 'zod';
import type { ToolDef } from '../toolDef.js';
import type { ToolContext } from '../context.js';
import { type ToolResult } from '../result.js';
import { summarizeAssets, summarizeTraits, type AssetEntry, type TraitSchema } from '../summarize.js';
import { mutateOpSchema, precisionParam } from '../shapes.js';
import { describeShape } from '../../../shared/mcpResult.js';

export function registerSceneTools(tool: ToolDef, ctx: ToolContext): void {
  const { ok, fail, httpFailure, call, getJson, postJson, unreachable, htmlFallthrough, noSuchRoute } = ctx;

  // ── get_scene_state — PRIMARY verification tool ──
  tool(
    'modoki_get_scene_state',
    'Read the LIVE ECS world. This reads the running engine, NOT the scene file — so it ' +
      'PROVES an edit actually took effect. The primary, deterministic, cheap way to verify ' +
      'your work after a mutate (prefer it over a screenshot for "did the data change?"). ' +
      'CALLED BARE it returns an INDEX: each entity\'s id, guid, name, parentId, layer and its ' +
      'trait NAMES — no field values. That is the cheap "what exists?" question; ask it first. ' +
      'To get VALUES, target or enrich: trait=<Trait> | id=<n> | name=<substr> | ' +
      'where="Transform.y>3" | full=true (every field, incl. AoS/object fields the compact dump ' +
      'omits) | world/bounds/contacts. Address entities by `guid` — runtime ids are reassigned ' +
      'on every scene hot-reload. The index applies a default limit (see `hint`/`truncated`); a ' +
      'targeted query is never silently capped. A bad `where` returns a `warnings` array rather ' +
      'than silently ignoring the filter.',
    {
      trait: z.string().optional().describe('Only include this trait\'s data (still lists all entities).'),
      id: z.number().int().optional().describe('Only include this single entity id (returned even if it is a resource).'),
      guid: z.string().optional().describe('Only include the entity with this stable guid — PREFER this over id for addressing (runtime ids are reassigned on every scene hot-reload). A guid that matches nothing returns an empty set + a `warnings` note.'),
      name: z.string().optional().describe('Filter to entities whose name contains this (case-insensitive).'),
      where: z.string().optional().describe('Filter by predicate "Trait.field op value", op ∈ = != > >= < <= ~ (~=contains). E.g. "Transform.y>5". Unparseable/unknown-trait/unknown-field → a `warnings` entry, not a silent full dump.'),
      full: z.boolean().optional().describe('Include EVERY persistent trait field (AoS/object fields like animSets/materials/onClickSet), not just the curated Inspector subset. Default false (bare = a names-only index). NOTE: an UNTARGETED full=1 on a real scene exceeds the response cap and comes back as an elision envelope — combine it with trait=/id=/name=/where= or limit=.'),
      resources: z.boolean().optional().describe('Force-include resource entities (mesh/material/prefab/env holders + config singletons Time/Physics/NPRPostFX). Excluded from the DEFAULT untargeted listing only — any id/trait/name/where filter already includes them.'),
      limit: z.number().int().nonnegative().optional().describe('Cap the number of entities returned; response sets truncated:true + totalCount when hit. The untargeted INDEX applies a default cap; an explicit limit always wins, and a targeted query is never capped unless you pass one.'),
      world: z.boolean().optional().describe('Add each entity\'s RESOLVED world transform (position/rotation/scale after parent-chain propagation) + activeInHierarchy flag. Default false (local Transform only). Saves composing the parent chain by hand.'),
      bounds: z.boolean().optional().describe('Add each entity\'s screen-space rect (screen {x,y,w,h} CSS px) + onScreen flag, plus (3D only) worldAABB {size:[x,y,z], center:[x,y,z]} — the TRUE geometric extent in world units (distinct from the authored scale). Geometry without a separate get_layout_bounds call. Default false. Needs the renderer.'),
      contacts: z.boolean().optional().describe('Add each body\'s CURRENT physics contacts as GUID arrays (rolled up to bodies): `contacts` (solid, load-bearing — resting on the ground) + `overlaps` (sensor/trigger — inside a zone). The STATE view ("what is it touching NOW"), vs the @contact/@sensor journal EVENTS ("when did they touch"). Present only on bodies currently touching something. Default false.'),
      precision: precisionParam(),
    },
    async ({ trait, id, guid, name, where, full, resources, limit, world, bounds, contacts, precision }) => {
      const q = new URLSearchParams();
      if (trait) q.set('trait', trait);
      if (id != null) q.set('id', String(id));
      if (guid) q.set('guid', guid);
      if (name) q.set('name', name);
      if (where) q.set('where', where);
      if (full) q.set('full', '1');
      if (resources) q.set('resources', '1');
      if (limit != null) q.set('limit', String(limit));
      if (world) q.set('world', '1');
      if (bounds) q.set('bounds', '1');
      if (contacts) q.set('contacts', '1');
      if (precision != null) q.set('precision', String(precision));
      const qs = q.toString();
      return getJson(`/api/scene-state${qs ? `?${qs}` : ''}`);
    },
  );

  /** Resolve the scene an edit should apply to: the caller's `path`, else the ACTIVE scene.
   *
   *  Every scene-editing tool needs this, and getting it wrong is silent-ish but total: the field
   *  MUST be `scenePathRef` (the asset-root form), never `scenePath` (Vite's `/@fs/<abs>` URL),
   *  because `/api/scene-mutate` 403s anything outside the asset roots. `set_transform`'s
   *  documented `path` default was broken on every call for exactly that reason, so this lives in
   *  ONE place now rather than being re-derived per tool.
   *
   *  Returns the path, or an already-formed error ToolResult to return as-is. */
  async function activeScenePath(path: string | undefined, toolName: string): Promise<string | ToolResult> {
    if (path) return path;
    let ref: string | undefined;
    try {
      const { status, body } = await call('/api/editor-state');
      if (status < 400 && body && typeof body === 'object') ref = (body as { scenePathRef?: string }).scenePathRef;
    } catch (e) { return unreachable(e); }
    if (!ref) {
      return fail({
        code: 'NOT_FOUND',
        tool: toolName,
        what: 'resolve the ACTIVE scene as an editable path, because `path` was omitted',
        why: "the editor reported no editable scene path. Either no scene is open, or the open scene lives outside the project's asset roots and so has no asset-root URL.",
        expected: 'an asset-root URL like /assets/scenes/main.scene.json',
        options: [
          'pass `path` explicitly — get the valid values from modoki_list_scenes',
          'open a scene in the editor first (modoki_load_scene)',
        ],
      });
    }
    return ref;
  }

  // ── mutate_scene — the validated way to edit scene structure ──
  tool(
    'modoki_mutate_scene',
    'Apply validated ops (setTrait / removeTrait / addEntity / removeEntity / setBaseScene) to a scene. ' +
      'GUIDs are minted as needed. This is how you edit scene structure — do NOT hand-write scene JSON. ' +
      'The entity ref is an OBJECT {id} | {name} | {guid}; setTrait carries the changed values under ' +
      '"fields". Returns {ok, changed, errors, warnings, saved, mode} — deliberately NOT the scene ' +
      '(echoing the whole file on every edit cost ~10k tokens for data nobody read). An addEntity op ' +
      'also reports `created:[{op, id, guid, name}]`, so you address what you just made by GUID ' +
      'instead of re-finding it by name (which is refused when the name is ambiguous). After ' +
      'mutating, verify with modoki_get_scene_state, which reads the running engine. ' +
      'PERSISTENCE (mcp-persistence.md): when the editor has this exact scene open, the ' +
      'whole call applies to the LIVE world as ONE undoable step (a human can Cmd-Z it) and stays ' +
      'live-only until modoki_save_all — persistence is MANUAL-only, so `saved:false` is the normal ' +
      'answer, not a failure. `setBaseScene` has no live equivalent and always goes straight to the ' +
      'FILE. With no editor connected, or targeting a scene that ISN\'T the one open ' +
      'live, this falls back to writing the scene FILE directly (the browser-free curl-editing path).',
    {
      path: z.string().optional().describe(
        'Asset-root URL of the scene, e.g. /games/x/assets/scenes/main.scene.json. Defaults to the ' +
        'ACTIVE scene — omit it unless you mean a scene that is not the open one.'),
      ops: z.array(mutateOpSchema).describe(
        'Ops. setTrait: {"op":"setTrait","entity":{"name":"Title"},"trait":"UIElement","fields":{"fontSize":56}}. ' +
        'removeTrait (remove a component; core Transform/EntityAttributes refused): {"op":"removeTrait","entity":{"id":7},"trait":"Light"}. ' +
        'addEntity: {"op":"addEntity","name":"Box","parentId":0,"traits":{"Transform":{...},"EntityAttributes":{"layer":"3d"}}}. ' +
        'removeEntity: {"op":"removeEntity","entity":{"id":11}}. ' +
        'setBaseScene (base-scene persistence — scene-level, no entity ref; guid of a base scene to load additively, or null to clear): ' +
        '{"op":"setBaseScene","baseScene":"<scene guid>"}.'),
    },
    async ({ path, ops }) => {
      const resolved = await activeScenePath(path, 'modoki_mutate_scene');
      if (typeof resolved !== 'string') return resolved;
      // Label the failure in the caller's terms (§5) — "apply 3 op(s) to …" beats "POST
      // /api/scene-mutate", which describes our plumbing rather than what was asked for.
      // 45s, not the 30s default: the backend's own worst case for this route is a 2s
      // editor-state probe PLUS a 30s live apply, so an MCP timeout of 30s could fire while the
      // edit was still succeeding — reporting "the backend did not respond in time" for a change
      // that LANDED. A client deadline must exceed the server budget it is waiting on.
      return postJson('/api/scene-mutate', { path: resolved, ops }, 45_000,
        `apply ${ops.length} scene op(s) (${[...new Set(ops.map((o) => o.op))].join(', ')}) to ${resolved}`);
    },
  );

  // ── set_transform — one-call place/rotate/scale (prefab-instance aware) ──
  tool(
    'modoki_set_transform',
    "Set an entity's Transform (position / rotation / scale) in ONE call — the fast " +
      'path for placing, scaling, or rotating an entity without hand-building a ' +
      'mutate_scene op. Only the components you pass are changed (partial merge). ' +
      'Handles prefab INSTANCES correctly (routes the edit into the instance overrides, ' +
      'where a plain setTrait would be silently ignored). Goes through modoki_mutate_scene under ' +
      'the hood, so the same persistence behaviour applies (see its description): live + undoable ' +
      'when the editor has this scene open, file-direct otherwise. `path` defaults to the active ' +
      'scene. Verify with modoki_get_scene_state.\n\n' +
      '`space` IS REQUIRED — state which coordinate space your numbers are in. There is no default ' +
      'on purpose: it used to be documented as "world" while writing LOCAL fields, so asking for a ' +
      'parented entity\'s OWN CURRENT world position moved it by the parent offset and reported ' +
      'success. A default would just relocate that mistake into the caller\'s head. For a ROOT ' +
      'entity the two spaces are identical, so either value is correct and cheap to state.',
    {
      entity: z.object({
        id: z.number().optional(),
        name: z.string().optional(),
        guid: z.string().optional(),
      }).describe('Entity ref — one of {id} | {name} | {guid}.'),
      // It said "World position" and wrote Transform.x/y/z, which is LOCAL. Measured on a parented
      // entity: asking for its OWN current world position moved it by the parent offset
      // (623,679 local / 823,926 world → set to 823,926 → now 1022,1173 world). A parameter whose
      // description names the wrong coordinate space is worse than an undocumented one, because the
      // caller acts on it confidently.
      space: z.enum(['local', 'world']).describe(
        "REQUIRED — which space position/rotation/scale are given in. 'local' = relative to the " +
        "parent, i.e. the Transform fields exactly as stored. 'world' = absolute, converted against " +
        'the parent chain before writing (use this for coordinates you read from ' +
        'modoki_get_scene_state {world:1}). Identical for a ROOT entity; they diverge the moment ' +
        'the entity has a parent.',
      ),
      position: z.array(z.number()).length(3).optional().describe('Position [x, y, z], in `space`.'),
      rotation: z.array(z.number()).length(3).optional().describe('Euler rotation in RADIANS [rx, ry, rz], in `space`.'),
      scale: z.union([z.number(), z.array(z.number()).length(3)]).optional()
        .describe('Scale — uniform (a single number) or per-axis [sx, sy, sz], in `space`.'),
      path: z.string().optional().describe('Scene file URL. Defaults to the active scene.'),
    },
    async ({ entity, space, position, rotation, scale, path }) => {
      const fields: Record<string, number> = {};
      if (position) { fields.x = position[0]; fields.y = position[1]; fields.z = position[2]; }
      if (rotation) { fields.rx = rotation[0]; fields.ry = rotation[1]; fields.rz = rotation[2]; }
      if (scale != null) {
        const s = typeof scale === 'number' ? [scale, scale, scale] : scale;
        fields.sx = s[0]; fields.sy = s[1]; fields.sz = s[2];
      }
      if (Object.keys(fields).length === 0) {
        return fail({
          code: 'REFUSED_BY_OP',
          what: 'set a transform with no component specified',
          why: 'none of position / rotation / scale was passed, so there is nothing to write. Applying an empty change would report success while doing nothing.',
          expected: 'at least one of position:[x,y,z] / rotation:[rx,ry,rz] / scale:number|[sx,sy,sz]',
        });
      }
      const resolved = await activeScenePath(path, 'modoki_set_transform');
      if (typeof resolved !== 'string') return resolved;
      return postJson('/api/scene-mutate', {
        path: resolved,
        ops: [{ op: 'setTrait', entity, trait: 'Transform', fields, space }],
      }, 45_000, `set the ${space}-space Transform (${Object.keys(fields).join(',')}) of ${JSON.stringify(entity)} in ${resolved}`);
    },
  );

  // ── validate_scene ──
  tool(
    'modoki_validate_scene',
    'Validate a scene file against the live trait schema (warn-but-load): unknown ' +
      'trait/field, type mismatch, literal-asset-path-instead-of-GUID mistakes, and ' +
      'asset refs whose GUID names nothing in the manifest (a deleted asset — the ref ' +
      'will not resolve at load). schemaAvailable:false means no editor renderer is ' +
      'connected (ref checks still run).',
    { path: z.string().describe('Asset-root URL of the scene file.') },
    async ({ path }) => getJson(`/api/validate-scene?path=${encodeURIComponent(path)}`),
  );

  // ── list_traits ──
  tool(
    'modoki_list_traits',
    'The registered ECS traits — the valid targets for mutate_scene setTrait. Sourced from the ' +
      'live trait registry. CALLED BARE it lists trait NAMES grouped by category (no field ' +
      'schemas). Pass name=<Trait> for that one trait\'s full field schema — which is what you ' +
      'need before a setTrait. Nobody needs all 60 schemas at once.',
    {
      name: z.string().optional().describe('Return this single trait\'s full field schema (e.g. "Transform"). Case-sensitive.'),
      all: z.boolean().optional().describe('Return EVERY trait\'s full field schema. Large — prefer name=.'),
    },
    async ({ name, all }) => {
      // try/catch, because `call()` does NOT catch fetch rejections — every other transport path
      // wraps it (getJson/postJson/evalRenderer/activeScenePath) and returns `unreachable(e)`. An
      // uncaught throw is turned by the SDK into a bare free-text isError ("fetch failed"), i.e.
      // exactly the "it didn't work" shape §5 exists to eliminate, with none of the recovery
      // information every other tool gives.
      try {
      const { status, body } = await call('/api/trait-schema');
      if (status >= 400) return httpFailure('read the live trait registry', status, body);
      // #648 — raw `call()` skips `getJson`'s SPA-fallthrough guard: a missing /api/trait-schema
      // route on the dev server falls through to index.html, 200. Undetected, `.traits` on that
      // string is `undefined`, `?? {}` swallows it, and summarizeTraits reports a clean empty
      // registry — "this project has zero traits", never a true answer.
      if (htmlFallthrough(body)) return noSuchRoute('/api/trait-schema');
      const traitsField = body && typeof body === 'object' ? (body as { traits?: unknown }).traits : undefined;
      const traitsShapeOk = traitsField !== null && typeof traitsField === 'object' && !Array.isArray(traitsField);
      if (!body || typeof body !== 'object' || !traitsShapeOk) {
        return fail({
          code: 'NOT_AVAILABLE_HERE',
          what: 'read the live trait registry',
          why: `the backend answered 200, but the body was ${describeShape(body)} — not the ` +
            `{traits:{...}} shape /api/trait-schema is supposed to answer with. This is NOT ` +
            `"this project has no traits"; it is a reply this build cannot read.`,
          options: [
            'this editor build may be from a DIFFERENT checkout than this MCP server — relaunch the editor from this checkout',
            'check the editor is actually running: modoki_identity',
          ],
        });
      }
      const b = body as { schemaAvailable?: boolean; traits?: Record<string, TraitSchema> };
      const result = summarizeTraits(b.traits ?? {}, b.schemaAvailable, { name, all });
      return 'error' in result ? fail(result.error) : ok(result);
      } catch (e) { return unreachable(e); }
    },
  );

  // ── list_assets ──
  tool(
    'modoki_list_assets',
    'Project assets from the manifest (guid, path, type, name). Every scene/trait asset ' +
      'reference must be a GUID from here — never a literal path. CALLED BARE it returns per-type ' +
      'COUNTS, not the whole manifest (a real project has hundreds of assets, most of them fonts ' +
      'and meshes you did not ask about). Narrow with type=, folder=<path prefix>, or ' +
      'name=<substring> to get entries.',
    {
      type: z.string().optional().describe('Filter to one asset type (scene, prefab, mesh, material, texture, model, particle, animation, …).'),
      folder: z.string().optional().describe('Filter to assets whose path starts with this prefix, e.g. "/assets/scenes".'),
      name: z.string().optional().describe('Filter to assets whose name or path contains this substring (case-insensitive).'),
      all: z.boolean().optional().describe('Return every asset entry. Large — prefer a filter.'),
      limit: z.number().int().positive().optional().describe('Cap the returned entries; sets truncated + totalCount. Passing limit alone also switches the response from per-type counts to entries.'),
    },
    async ({ type, folder, name, all, limit }) => {
      try {
      const { status, body } = await call('/api/scan-assets');
      if (status >= 400) return httpFailure('read the project asset manifest', status, body);
      // #648 — raw `call()` skips `getJson`'s SPA-fallthrough guard: a missing /api/scan-assets
      // route on the dev server falls through to index.html, 200. Undetected, `.assets` on that
      // string is `undefined`, `?? []` swallows it, and summarizeAssets reports a clean empty
      // manifest — "this project has no assets", never a true answer.
      if (htmlFallthrough(body)) return noSuchRoute('/api/scan-assets');
      const assetsField = body && typeof body === 'object' ? (body as { assets?: unknown }).assets : undefined;
      if (!body || typeof body !== 'object' || !Array.isArray(assetsField)) {
        return fail({
          code: 'NOT_AVAILABLE_HERE',
          what: 'read the project asset manifest',
          why: `the backend answered 200, but the body was ${describeShape(body)} — not the ` +
            `{assets:[...]} shape /api/scan-assets is supposed to answer with. This is NOT ` +
            `"this project has no assets"; it is a reply this build cannot read.`,
          options: [
            'this editor build may be from a DIFFERENT checkout than this MCP server — relaunch the editor from this checkout',
            'check the editor is actually running: modoki_identity',
          ],
        });
      }
      const assets = assetsField as AssetEntry[];
      return ok(summarizeAssets(assets, { type, folder, name, all, limit }));
      } catch (e) { return unreachable(e); }
    },
  );

  // ── get_asset_meta ──
  tool(
    'modoki_get_asset_meta',
    'Read an asset\'s .meta.json sidecar (import settings for textures/models, etc.). ' +
      'Returns {} if there is no sidecar.',
    { path: z.string().describe('Asset-root URL of the asset.') },
    async ({ path }) => getJson(`/api/read-meta?path=${encodeURIComponent(path)}`),
  );

  // ── reimport_asset ──
  tool(
    'modoki_reimport_asset',
    'Re-run the import pipeline for a source asset (texture → KTX2/WebP, model → LOD ' +
      'GLB + postprocessor bake), or every asset under a folder (recursive). Returns ' +
      '{converted, skipped, errors}.',
    {
      path: z.string().describe('Asset-root URL of the asset or folder.'),
      recursive: z.boolean().optional().describe('Reimport every asset under the path.'),
    },
    // A reimport re-encodes textures (toktx KTX2) and models (LOD GLB) SEQUENTIALLY in a
    // non-streaming handler. On the 30s default a recursive folder reimport aborted mid-bake and
    // reported a spurious "backend did not respond" while the bake kept running and DID land on
    // disk. Give it real headroom (a single import_file already gets 120s). (C7 re-audit.)
    async ({ path, recursive }) => postJson('/api/reimport', { path, recursive: !!recursive }, recursive ? 10 * 60_000 : 120_000),
  );
}
