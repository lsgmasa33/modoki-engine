/**
 * Modoki MCP server (ELECTRON_PLAN Phase 5) — the Claude-friendly authoring
 * surface. A thin, transport-agnostic wrapper over the editor backend HTTP API
 * (the Phase-1 router, served by either the Vite dev server or the Electron main
 * process). The user's own Claude Code connects to this over stdio and edits the
 * project's scenes/assets through validated tools, then verifies its own work.
 *
 * Backend base: MODOKI_BACKEND env (e.g. http://127.0.0.1:<port> for the Electron
 * editor) — defaults to the Vite dev server at http://localhost:5173.
 *
 * Scope: the data-first core (the verification loop the plan calls PRIMARY).
 * Visual capture (capture_viewport / render_scene) + input emulation (tap/drag)
 * are renderer/Electron-bound and land in a follow-up.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { identityMismatch, tokenMismatchWarning, describeIdentity, type BackendIdentity } from './identity.js';
import { createFormatter, isFailureBody, type ToolResult } from './result.js';
import { summarizeAssets, summarizeTraits, type AssetEntry, type TraitSchema } from './summarize.js';

const BACKEND = (process.env.MODOKI_BACKEND || 'http://localhost:5173').replace(/\/$/, '');

/** C6 — the instance token identifying WHICH editor+project this config was written for.
 *  Baked into `.mcp.json` by AI → Connect Claude Code. A port names a socket, not an
 *  editor: if another editor now holds our port, the backend refuses these requests (403)
 *  instead of silently applying them to the wrong project. Absent ⇒ send nothing; the
 *  backend validates if-present, so a hand-written config still works. */
const TOKEN = process.env.MODOKI_TOKEN || '';
const AUTH_HEADERS: Record<string, string> = TOKEN ? { 'X-Modoki-Token': TOKEN } : {};

/** Set once the backend has been identified as a DIFFERENT checkout than ours. Prepended
 *  to every tool result, because a mismatch makes every other result a lie — the calls
 *  succeed, they just land in the other clone's editor. */
let identityWarning: string | null = null;

/** Compact, size-capped result formatting for all 64 tools — see `result.ts`. */
const { ok, err } = createFormatter(() => identityWarning);

/** Default per-request timeout. A wedged renderer (or a half-open socket) would
 *  otherwise hang the user's Claude session forever with no error. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Call the editor backend. Returns parsed JSON (or raw text) + HTTP status.
 *  Aborts after `timeoutMs` so the MCP tool can't hang indefinitely. */
async function call(path: string, init?: RequestInit, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<{ status: number; body: unknown }> {
  const res = await fetch(BACKEND + path, {
    ...init,
    // Every call carries the token (C6) — merged UNDER the caller's headers so an explicit
    // Content-Type still wins. Callers only ever pass plain-object headers.
    headers: { ...AUTH_HEADERS, ...(init?.headers as Record<string, string> | undefined) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let body: unknown = text;
  try { body = text ? JSON.parse(text) : undefined; } catch { /* keep raw text */ }
  return { status: res.status, body };
}

function unreachable(e: unknown): ToolResult {
  const msg = e instanceof Error && e.name === 'TimeoutError'
    ? `Modoki backend at ${BACKEND} did not respond in time — the editor may be busy or the renderer wedged.`
    : `cannot reach Modoki backend at ${BACKEND} — is the editor running? (${e instanceof Error ? e.message : e})`;
  return err(msg);
}

/** Ask the backend who it is, once per process, and arm `identityWarning` if it turns out
 *  to be the sibling clone's editor. Best-effort: a backend too old to have the route, or
 *  one that is down, must not break the tool being called — the tool's own error is the
 *  more useful message. Awaited before the first real request so the warning lands on it.
 *  `_identityProbe` is the in-flight promise, so concurrent tool calls share one probe. */
let _identityProbe: Promise<void> | null = null;
async function ensureIdentity(): Promise<void> {
  if (_identityProbe) return _identityProbe;
  _identityProbe = (async () => {
    try {
      const { status, body } = await call('/api/identity', undefined, 5_000);
      if (status !== 200 || !body || typeof body !== 'object') return;
      const id = body as BackendIdentity;
      if (typeof id.repoRoot !== 'string') return; // an older backend, or a proxy
      // The editor's OWN verdict beats our cwd heuristic: a token mismatch is authoritative
      // (and means every other call is already 403ing), so it wins when both would fire.
      identityWarning = tokenMismatchWarning(id, BACKEND) ?? identityMismatch(id, process.cwd(), BACKEND);
      console.error(identityWarning ?? describeIdentity(id, BACKEND));
    } catch { /* editor down / route absent — let the real call report it */ }
  })();
  return _identityProbe;
}

async function getJson(path: string, timeoutMs?: number): Promise<ToolResult> {
  try {
    await ensureIdentity();
    const { status, body } = await call(path, undefined, timeoutMs);
    if (status >= 400) return err(`backend ${status}: ${JSON.stringify(body)}`);
    return ok(body);
  } catch (e) {
    return unreachable(e);
  }
}

async function postJson(path: string, payload: unknown, timeoutMs?: number): Promise<ToolResult> {
  try {
    await ensureIdentity();
    const { status, body } = await call(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, timeoutMs);
    // Render endpoints return a 504 with a partial `{paths}` on a mid-sequence
    // failure — surface those frames (not just an error) so the agent keeps what
    // was rendered. The body already carries the error message.
    if (status >= 400) {
      if (body && typeof body === 'object' && Array.isArray((body as { paths?: unknown }).paths)) return ok(body);
      return err(`backend ${status}: ${JSON.stringify(body)}`);
    }
    // A 200 whose body says the op didn't happen is a FAILURE — surface it as one (C7).
    const failure = isFailureBody(body);
    return failure ? err(failure) : ok(body);
  } catch (e) {
    return unreachable(e);
  }
}


/** POST an editor action to the relay. `action` is the op name; `params` is the
 *  rest of the body. Editor actions can touch scenes/resources, so allow generous
 *  time. */
async function editorAction(action: string, params: Record<string, unknown> = {}, timeoutMs = 65_000): Promise<ToolResult> {
  return postJson('/api/editor-action', { action, ...params }, timeoutMs);
}

/** Refuse-reason when the editor has live-world work that is NOT on disk, else null. (C7)
 *  Best-effort: a backend that can't answer (headless / no editor) must not block a build —
 *  there is no unsaved editor to be stale against. */
async function unsavedChangesWarning(): Promise<string | null> {
  try {
    const { status, body } = await call('/api/editor-state', undefined, 5_000);
    if (status !== 200 || !body || typeof body !== 'object') return null;
    const st = body as { unsavedChanges?: unknown; scenePath?: unknown };
    if (st.unsavedChanges !== true) return null;
    return (
      `REFUSED: the editor has UNSAVED changes, and a build reads the scene FILE — the ` +
      `artifact would be missing them (create_entity / duplicate_entity / prefab edit the ` +
      `live world and do NOT save). Run modoki_save_all first, or pass force:true to build ` +
      `the on-disk scene deliberately.`
    );
  } catch { return null; }
}

/** Consume a build-family SSE stream (/api/build, /api/add-native-target) to
 *  completion. The server emits `event: step|status|message` frames; `status`
 *  carries DONE | FAILED:<tail> | <progress>. Returns the final outcome + a log
 *  tail so the agent sees WHY a build failed, not just THAT it did. */
async function consumeBuildStream(path: string, timeoutMs: number): Promise<ToolResult> {
  // Like the JSON tools: identify the editor FIRST, so a wrong-editor warning lands on this
  // result too. A build can plausibly be the session's first call, and it's the LAST tool
  // whose target you want to be guessing about.
  await ensureIdentity();
  let res: Response;
  try {
    res = await fetch(BACKEND + path, { headers: { ...AUTH_HEADERS, Accept: 'text/event-stream' }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    return unreachable(e);
  }
  if (!res.ok || !res.body) {
    // Surface the BODY, not just the status. A 403 here carries the actionable wrong-editor
    // explanation (C6); reporting a bare "build stream did not open" would turn the one
    // message that names the cause into a generic build failure the agent would then go and
    // "debug" against the wrong editor.
    const detail = await res.text().catch(() => '');
    let msg = detail;
    try { msg = (JSON.parse(detail) as { error?: string }).error ?? detail; } catch { /* raw text */ }
    return err(`backend ${res.status}: ${msg || 'build stream did not open'}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const log: string[] = [];
  let buf = '';
  let outcome: { ok: boolean; step?: string; error?: string } | null = null;
  const pushLog = (line: string) => { log.push(line); if (log.length > 200) log.shift(); };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line.
      let sep: number;
      while ((sep = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        let event = 'message';
        let data = '';
        for (const raw of frame.split('\n')) {
          if (raw.startsWith('event:')) event = raw.slice(6).trim();
          else if (raw.startsWith('data:')) data += raw.slice(5).trim();
        }
        let parsed: unknown = data;
        try { parsed = JSON.parse(data); } catch { /* keep raw */ }
        if (event === 'message') { if (parsed) pushLog(String(parsed)); }
        else if (event === 'status') {
          const status = String(parsed);
          if (status === 'DONE') { outcome = { ok: true }; }
          else if (status.startsWith('FAILED')) {
            const details = status.slice('FAILED:'.length).trim();
            outcome = { ok: false, step: details.split('\n')[0] || 'unknown step', error: details.split('\n').slice(1).join('\n') };
          } else { pushLog(status); }
        }
      }
      if (outcome) break;
    }
  } catch (e) {
    return err(`build stream error: ${e instanceof Error ? e.message : e}\n${log.slice(-40).join('\n')}`);
  } finally {
    try { await reader.cancel(); } catch { /* ignore */ }
  }
  if (!outcome) return err(`build stream ended without a final status\n${log.slice(-40).join('\n')}`);
  if (!outcome.ok) return err(`build FAILED at: ${outcome.step}\n${outcome.error || ''}\n--- log tail ---\n${log.slice(-40).join('\n')}`);
  return ok({ ok: true, log: log.slice(-40) });
}

const server = new McpServer({ name: 'modoki', version: '1.0.0' });

// ── get_scene_state — PRIMARY verification tool ──
server.tool(
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
    precision: z.number().int().nonnegative().optional().describe('Significant digits for float values. Default 9 — trims float64 mantissa noise (247.13061935179246 -> 247.130619), saving ~17-29% of the response with a max error of 3.5e-7. Verify edits with a TOLERANCE, not string/=== equality. Pass precision=0 for exact float64.'),
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

// ── mutate_scene — the validated way to edit scene structure ──
server.tool(
  'modoki_mutate_scene',
  'Apply validated ops to a scene FILE (setTrait / removeTrait / addEntity / removeEntity), ' +
    'then atomically write it; the editor hot-reloads. GUIDs are minted as needed. This is ' +
    'how you edit scene structure — do NOT hand-write scene JSON. The entity ref is an ' +
    'OBJECT {id} | {name} | {guid}; setTrait carries the changed values under "fields". ' +
    'Returns {ok, changed, errors, warnings} — deliberately NOT the scene (echoing the whole ' +
    'file on every edit cost ~10k tokens for data nobody read, and it was the pre-expansion ' +
    'file, not the live world). After mutating, verify with modoki_get_scene_state, which ' +
    'reads the running engine.',
  {
    path: z.string().describe('Asset-root URL of the scene, e.g. /games/x/assets/scenes/main.json'),
    ops: z.array(z.record(z.any())).describe(
      'Ops. setTrait: {"op":"setTrait","entity":{"name":"Title"},"trait":"UIElement","fields":{"fontSize":56}}. ' +
      'removeTrait (remove a component; core Transform/EntityAttributes refused): {"op":"removeTrait","entity":{"id":7},"trait":"Light"}. ' +
      'addEntity: {"op":"addEntity","name":"Box","parentId":0,"traits":{"Transform":{...},"EntityAttributes":{"layer":"3d"}}}. ' +
      'removeEntity: {"op":"removeEntity","entity":{"id":11}}.'),
  },
  async ({ path, ops }) => postJson('/api/scene-mutate', { path, ops }),
);

// ── set_transform — one-call place/rotate/scale (prefab-instance aware) ──
server.tool(
  'modoki_set_transform',
  "Set an entity's Transform (position / rotation / scale) in ONE call — the fast " +
    'path for placing, scaling, or rotating an entity without hand-building a ' +
    'mutate_scene op. Only the components you pass are changed (partial merge). ' +
    'Handles prefab INSTANCES correctly (routes the edit into the instance overrides, ' +
    'where a plain setTrait would be silently ignored). Writes the scene file and the ' +
    'editor hot-reloads. `path` defaults to the active scene. Verify with ' +
    'modoki_get_scene_state.',
  {
    entity: z.object({
      id: z.number().optional(),
      name: z.string().optional(),
      guid: z.string().optional(),
    }).describe('Entity ref — one of {id} | {name} | {guid}.'),
    position: z.array(z.number()).length(3).optional().describe('World position [x, y, z].'),
    rotation: z.array(z.number()).length(3).optional().describe('Euler rotation in RADIANS [rx, ry, rz].'),
    scale: z.union([z.number(), z.array(z.number()).length(3)]).optional()
      .describe('Uniform scale (a single number) or per-axis [sx, sy, sz].'),
    path: z.string().optional().describe('Scene file URL. Defaults to the active scene.'),
  },
  async ({ entity, position, rotation, scale, path }) => {
    const fields: Record<string, number> = {};
    if (position) { fields.x = position[0]; fields.y = position[1]; fields.z = position[2]; }
    if (rotation) { fields.rx = rotation[0]; fields.ry = rotation[1]; fields.rz = rotation[2]; }
    if (scale != null) {
      const s = typeof scale === 'number' ? [scale, scale, scale] : scale;
      fields.sx = s[0]; fields.sy = s[1]; fields.sz = s[2];
    }
    if (Object.keys(fields).length === 0) {
      return err('set_transform: pass at least one of position / rotation / scale.');
    }
    let scenePath = path;
    if (!scenePath) {
      try {
        const { status, body } = await call('/api/editor-state');
        if (status < 400 && body && typeof body === 'object') {
          scenePath = (body as { scenePath?: string }).scenePath;
        }
      } catch (e) { return unreachable(e); }
      if (!scenePath) return err('set_transform: could not resolve the active scene — pass `path` explicitly.');
    }
    return postJson('/api/scene-mutate', {
      path: scenePath,
      ops: [{ op: 'setTrait', entity, trait: 'Transform', fields }],
    });
  },
);

// ── validate_scene ──
server.tool(
  'modoki_validate_scene',
  'Validate a scene file against the live trait schema (warn-but-load): unknown ' +
    'trait/field, type mismatch, and literal-asset-path-instead-of-GUID mistakes. ' +
    'schemaAvailable:false means no editor renderer is connected (ref checks still run).',
  { path: z.string().describe('Asset-root URL of the scene file.') },
  async ({ path }) => getJson(`/api/validate-scene?path=${encodeURIComponent(path)}`),
);

// ── list_traits ──
server.tool(
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
    const { status, body } = await call('/api/trait-schema');
    if (status >= 400) return err(`backend ${status}: ${JSON.stringify(body)}`);
    const b = body as { schemaAvailable?: boolean; traits?: Record<string, TraitSchema> };
    const result = summarizeTraits(b.traits ?? {}, b.schemaAvailable, { name, all });
    return 'error' in result ? err(result.error) : ok(result);
  },
);

// ── list_assets ──
server.tool(
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
    const { status, body } = await call('/api/scan-assets');
    if (status >= 400) return err(`backend ${status}: ${JSON.stringify(body)}`);
    const assets = (body as { assets?: AssetEntry[] }).assets ?? [];
    return ok(summarizeAssets(assets, { type, folder, name, all, limit }));
  },
);

// ── get_asset_meta ──
server.tool(
  'modoki_get_asset_meta',
  'Read an asset\'s .meta.json sidecar (import settings for textures/models, etc.). ' +
    'Returns {} if there is no sidecar.',
  { path: z.string().describe('Asset-root URL of the asset.') },
  async ({ path }) => getJson(`/api/read-meta?path=${encodeURIComponent(path)}`),
);

// ── reimport_asset ──
server.tool(
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

// ── capture_viewport — "does it actually render?" (Electron editor only) ──
server.tool(
  'modoki_capture_viewport',
  'Screenshot the live editor window to a downscaled JPEG file and return its PATH ' +
    '(read it with your file tool). Use AFTER verifying data with get_scene_state, to ' +
    'catch the "numbers right, renders black/NaN" class of bug. A single screenshot ' +
    'shows STATIC correctness only — never judge motion/timing from one frame. The result ' +
    'also reports `cssWidth`/`cssHeight` (the window size tap/drag coordinates live in) and ' +
    '`scale` = width/cssWidth: image px ÷ scale = CSS px. Do NOT eyeball tap coordinates off ' +
    'the image — prefer a `selector` (modoki_tap) or entity bounds (get_scene_state). ' +
    'Requires the Electron editor (MODOKI_BACKEND must point at it, not the Vite dev server).',
  {
    maxSide: z.number().optional().describe('Longest-side cap in px (default 1568).'),
    quality: z.number().optional().describe('JPEG quality 1-100 (default 70).'),
  },
  async ({ maxSide, quality }) => postJson('/api/capture-viewport', { maxSide, quality }, 60_000),
);

// ── render_scene — deterministic offscreen render (any backend with a 3D view) ──
server.tool(
  'modoki_render_scene',
  'Deterministically render the LIVE scene offscreen to a JPEG file and return its ' +
    'PATH. Unlike capture_viewport (a screenshot of the editor WINDOW — final ' +
    'composited pixels incl. NPR, but tied to window size/layout), this is ' +
    'reproducible and window-independent: pick the size and camera, get the same ' +
    'framing every time — ideal for before/after geometry, material, lighting, and ' +
    'camera checks. Renders the forward pass only (NPR/post-FX is window-bound — use ' +
    'capture_viewport for the final stylized look). Needs a mounted 3D view.',
  {
    width: z.number().optional().describe('Output width px (default: live viewport; ≤4096).'),
    height: z.number().optional().describe('Output height px (default: live viewport; ≤4096).'),
    quality: z.number().optional().describe('JPEG quality 0..1 (default 0.85).'),
    camera: z.object({
      position: z.array(z.number()).length(3).optional().describe('World camera position [x,y,z].'),
      target: z.array(z.number()).length(3).optional().describe('Look-at target [x,y,z].'),
      fov: z.number().optional().describe('Vertical FOV degrees.'),
    }).optional().describe('Camera override (omit to use the live camera pose).'),
  },
  async (args) => postJson('/api/render-scene', args, 60_000),
);

// ── render_sequence — sampled frames for motion checks ──
server.tool(
  'modoki_render_sequence',
  'Render N offscreen frames sampled over wall-clock at `fps` (the live animation ' +
    'advances between them) and return their PATHS — for judging MOTION/timing, ' +
    'which a single frame cannot show. Same camera/size options as render_scene. ' +
    'Read a few of the returned frames in order to see the temporal progression.',
  {
    frames: z.number().optional().describe('Frame count (default 8, ≤120).'),
    fps: z.number().optional().describe('Sampling rate (default 10, ≤60).'),
    width: z.number().optional(),
    height: z.number().optional(),
    quality: z.number().optional(),
    camera: z.object({
      position: z.array(z.number()).length(3).optional(),
      target: z.array(z.number()).length(3).optional(),
      fov: z.number().optional(),
    }).optional(),
  },
  async (args) => {
    // Allow enough wall-clock for the whole sequence: frames sampled at fps, each
    // with its own backend render budget, plus headroom — so the MCP-side timeout
    // never fires before the backend's own per-frame timeout would.
    const frames = Math.min(args.frames ?? 8, 120);
    const fps = Math.max(args.fps ?? 10, 1);
    const timeoutMs = Math.ceil((frames / fps) * 1000) + frames * 16_000 + 5_000;
    return postJson('/api/render-sequence', args, timeoutMs);
  },
);

// Chromium input modifiers, shared by the trusted-input tools below.
const modifierEnum = z.enum(['shift', 'control', 'alt', 'meta', 'cmd', 'command']);

/** A point to aim trusted input at: page CSS coordinates, or a CSS selector resolved to
 *  the element's center inside the same call (no read-then-tap race). */
const pointSpec = z.object({
  x: z.number().optional(),
  y: z.number().optional(),
  selector: z.string().optional(),
});

// ── tap — trusted input (Electron editor only) ──
server.tool(
  'modoki_tap',
  'Inject a REAL trusted click — flows through Chromium hit-testing so PixiJS and ' +
    'Three.js both receive it. Aim with `selector` (a CSS selector, resolved to the ' +
    "element's center in the SAME call — no read-then-tap race; prefer this for editor " +
    'chrome) or page CSS `x,y` (for canvas/entity targets, from get_scene_state bounds). ' +
    'The response reports `matched` (what the selector found), `hitTarget` (the topmost ' +
    'element at that point) and `occluded` — if occluded is true something covered your ' +
    'target and the click went elsewhere. Then verify with get_scene_state. ' +
    "`button:'right'` opens a context menu; `clickCount:2` double-clicks; " +
    "`modifiers:['shift'|'meta']` multi-select on canvas. Requires the Electron editor.",
  {
    x: z.number().optional().describe('Page CSS x. Required unless `selector` is given.'),
    y: z.number().optional().describe('Page CSS y. Required unless `selector` is given.'),
    selector: z.string().optional().describe("CSS selector to aim at, e.g. '[data-ui-id=\"inspector.header.kebab\"]'. Overrides x/y."),
    button: z.enum(['left', 'right', 'middle']).optional().describe("Mouse button (default 'left')."),
    clickCount: z.number().optional().describe('1 = single (default), 2 = double-click.'),
    modifiers: z.array(modifierEnum).optional().describe('Held modifier keys.'),
  },
  async ({ x, y, selector, button, clickCount, modifiers }) => postJson('/api/input/tap', { x, y, selector, button, clickCount, modifiers }),
);

// ── drag — trusted gesture (Electron editor only) ──
server.tool(
  'modoki_drag',
  'Inject a REAL trusted drag with intermediate moves (gesture thresholds like match-3 ' +
    'swaps / gizmo drags need them). Each endpoint is page CSS `{x,y}` OR `{selector}` ' +
    "(resolved to the element's center in the same call). `button:'middle'`/'right' = " +
    "orbit-pan the 3D viewport; `modifiers:['shift']` = gizmo snap. For HTML5 drag-and-drop " +
    '(asset→slot, reparent) use modoki_dnd, NOT this. Requires the Electron editor.',
  {
    from: pointSpec.describe('Drag origin: {x,y} or {selector}.'),
    to: pointSpec.describe('Drag destination: {x,y} or {selector}.'),
    steps: z.number().optional().describe('Intermediate move count (default 10).'),
    button: z.enum(['left', 'right', 'middle']).optional().describe("Mouse button (default 'left')."),
    modifiers: z.array(modifierEnum).optional().describe('Held modifier keys.'),
  },
  async ({ from, to, steps, button, modifiers }) => postJson('/api/input/drag', { from, to, steps, button, modifiers }),
);

// ── hover — trusted bare mouse-move (Electron editor only) ──
server.tool(
  'modoki_hover',
  'Move the mouse with NO button held — triggers hover states, tooltips, and ' +
    'hover-to-open submenus that a click or drag-move cannot. Aim with page CSS `x,y` or ' +
    'a CSS `selector`. Requires the Electron editor.',
  {
    x: z.number().optional().describe('Page CSS x. Required unless `selector` is given.'),
    y: z.number().optional().describe('Page CSS y. Required unless `selector` is given.'),
    selector: z.string().optional().describe('CSS selector to aim at. Overrides x/y.'),
    modifiers: z.array(modifierEnum).optional().describe('Held modifier keys.'),
  },
  async ({ x, y, selector, modifiers }) => postJson('/api/input/hover', { x, y, selector, modifiers }),
);

// ── scroll — trusted mouse-wheel (Electron editor only) ──
server.tool(
  'modoki_scroll',
  'Inject a trusted mouse-wheel. deltaY > 0 scrolls the content DOWN (wheel ' +
    'toward you); deltaX scrolls horizontally. Unlocks orbit-cam wheel-zoom, scrolling a ' +
    'long list/panel (aim it with a `selector` for that panel), and cursor-anchored zoom ' +
    'in the Canvas2D editors (Skin/Slicer/Particle). ~120 units ≈ one wheel tick. ' +
    'Requires the Electron editor.',
  {
    x: z.number().optional().describe('Page CSS x. Required unless `selector` is given.'),
    y: z.number().optional().describe('Page CSS y. Required unless `selector` is given.'),
    selector: z.string().optional().describe('CSS selector to aim at. Overrides x/y.'),
    deltaX: z.number().optional().describe('Horizontal wheel delta (default 0).'),
    deltaY: z.number().optional().describe('Vertical wheel delta; positive = content down.'),
  },
  async ({ x, y, selector, deltaX, deltaY }) => postJson('/api/input/scroll', { x, y, selector, deltaX, deltaY }),
);

// ── press_key — standalone trusted key chord (Electron editor only) ──
server.tool(
  'modoki_press_key',
  'Press a single trusted key chord (keyDown+keyUp) into the focused element — the ' +
    'standalone keys typeText can only send as a terminal submitKey: Escape (close modal/' +
    'picker), Delete/Backspace, arrows (nudge), and editor hotkeys (W/E/R gizmo mode, F ' +
    "frame, X space, Cmd+Z undo). `key` is an Electron keyCode ('Escape', 'Delete', " +
    "'ArrowUp', 'w'). The key is HELD ~3 frames so per-frame game input sampling (nav/jump/" +
    'confirm) registers the edge. If keys do not reach the GAME, a DOM text field is likely ' +
    'focused (Console filter, inspector) — call modoki_focus (no selector) first to blur it. ' +
    'Requires the Electron editor.',
  {
    key: z.string().describe("Electron keyCode, e.g. 'Escape', 'Delete', 'ArrowLeft', 'w', 'z'."),
    modifiers: z.array(modifierEnum).optional().describe("Held modifiers, e.g. ['meta'] for Cmd+key."),
  },
  async ({ key, modifiers }) => postJson('/api/input/key', { key, modifiers }),
);

// ── focus — move keyboard focus / blur a text field (Electron editor only) ──
server.tool(
  'modoki_focus',
  'Move keyboard focus in the editor window: focus the element matching `selector`, or — ' +
    'with NO selector — blur the currently-focused element (focus falls back to <body>). ' +
    'General-purpose (focus any panel/canvas/input, or defocus a text field). The common ' +
    "use is unblocking trusted key input for the GAME: the game's input sampler drops keys " +
    'while a DOM text field (Console filter, inspector) holds focus, and a viewport click ' +
    'does NOT blur it — so call this (no selector) before modoki_press_key to drive ' +
    'nav/jump/confirm. A non-focusable target (canvas/div) is given tabindex=-1 so it can ' +
    'take focus. Returns {focused, blurred, ok}. Requires the Electron editor.',
  {
    selector: z.string().optional().describe('CSS selector to focus. Omit to blur the active element.'),
  },
  async ({ selector }) => postJson('/api/input/focus', { selector }),
);

// ── dnd — HTML5 drag-and-drop synthesis (dev + DMG) ──
server.tool(
  'modoki_dnd',
  'Synthesize an HTML5 drag-and-drop (dragstart→dragover→drop) — the DnD interactions a ' +
    'trusted pointer-drag CANNOT emit: Hierarchy reparent/reorder, Assets file-move & ' +
    'prefab-instantiate, Skin sprite-onto-part / part-reorder / bone-reparent. Address ' +
    'each endpoint by CSS `selector` (targets its center) OR viewport `{x,y}`. Lets the ' +
    "app's own dragstart handler fill the DataTransfer (never fabricated). Returns the " +
    'MIME `types` written (empty ⇒ wrong source element) and `accepted` (target took the ' +
    'drop). Works in dev AND the DMG.',
  {
    from: z.object({ selector: z.string().optional(), x: z.number().optional(), y: z.number().optional() }),
    to: z.object({ selector: z.string().optional(), x: z.number().optional(), y: z.number().optional() }),
  },
  async ({ from, to }) => editorAction('dom-dnd', { from, to }),
);

// ── handles — numeric handle geometry for the Canvas2D/SVG editors (dev + DMG) ──
server.tool(
  'modoki_handles',
  'List the draggable/clickable HANDLES the authoring editors offer RIGHT NOW, in ' +
    'viewport CSS px — the input twin of get_layout_bounds. Canvas2D/SVG editors (Skin ' +
    'bones, Dopesheet/Curves keyframes, Collider2D vertices, gizmo axes) have no DOM ' +
    'accessibility tree, so this is how you discover WHERE to aim before drag_handle/' +
    'tap_handle. CALLED BARE it returns COUNTS — `byEditor` and `byKind` (plus the viewport ' +
    'and the occlusion/offScreen/disabled counters) — which answers "what can I aim at right ' +
    'now?". Pass `editor` (collider2d/dopesheet/curves/skin), `kind`, or `ids` for the ' +
    'geometry: each handle then has a stable `id`, `x`,`y`, optional `label`/`meta`. The full ' +
    'list is opt-in because a Dopesheet enumerates every key of every track (~374 bytes each, ' +
    'so 2,000 keys ≈ 187k tokens). Counts of 0 ⇒ open the right editor and enter its sub-mode ' +
    '(e.g. Collider-edit) first. Works in dev AND the DMG.',
  {
    editor: z.string().optional().describe('Filter to one editor, e.g. "collider2d", "dopesheet", "skin".'),
    kind: z.string().optional().describe('Filter to one handle kind, e.g. "collider-vertex", "keyframe", "bone-joint".'),
    ids: z.string().optional().describe('Comma-separated handle ids to restrict to.'),
  },
  async ({ editor, kind, ids }) => {
    const qs = new URLSearchParams();
    if (editor) qs.set('editor', editor);
    if (kind) qs.set('kind', kind);
    if (ids) qs.set('ids', ids);
    const q = qs.toString();
    return getJson(`/api/enact-handles${q ? `?${q}` : ''}`);
  },
);

// ── tap_handle — trusted click on a named handle (Electron editor only) ──
server.tool(
  'modoki_tap_handle',
  'Click a handle by its `id` (from modoki_handles) — resolves the handle\'s live CSS ' +
    'coords in the renderer, then issues a trusted click there. Use to select a keyframe/' +
    'vertex/bone without eyeballing pixels. `button`/`clickCount`/`modifiers` as in ' +
    'modoki_tap (e.g. clickCount:2 to insert/rename, modifiers:["shift"] to add to a ' +
    'marquee selection). Requires the Electron editor.',
  {
    id: z.string().describe('Handle id from modoki_handles.'),
    button: z.enum(['left', 'right', 'middle']).optional(),
    clickCount: z.number().optional(),
    modifiers: z.array(modifierEnum).optional(),
  },
  async ({ id, button, clickCount, modifiers }) => postJson('/api/input/tap-handle', { id, button, clickCount, modifiers }),
);

// ── drag_handle — trusted drag of a named handle (Electron editor only) ──
server.tool(
  'modoki_drag_handle',
  'Drag a handle by its `id` (from modoki_handles) to a destination — the aimed-input ' +
    'primitive for the Canvas2D/SVG editors (move a Collider2D vertex, slide a keyframe in ' +
    'time, pose a bone). Destination is ONE of: `to:{x,y}` (absolute CSS px), `toId` ' +
    '(another handle\'s position — e.g. snap one vertex onto another), or `delta:{dx,dy}` ' +
    '(offset from the handle\'s current position). Resolves live coords server-side so ' +
    'there is no query→drag race. `modifiers:["shift"]` = gizmo/snap. Requires the ' +
    'Electron editor.',
  {
    id: z.string().describe('Handle id to drag (from modoki_handles).'),
    to: z.object({ x: z.number(), y: z.number() }).optional().describe('Absolute destination in viewport CSS px.'),
    toId: z.string().optional().describe('Drag onto another handle by its id.'),
    delta: z.object({ dx: z.number(), dy: z.number() }).optional().describe('Offset from the handle\'s current position.'),
    steps: z.number().optional().describe('Intermediate move count (default 10).'),
    button: z.enum(['left', 'right', 'middle']).optional(),
    modifiers: z.array(modifierEnum).optional(),
  },
  async ({ id, to, toId, delta, steps, button, modifiers }) => postJson('/api/input/drag-handle', { id, to, toId, delta, steps, button, modifiers }),
);

// ── type — trusted keyboard input into the focused element (Electron editor only) ──
server.tool(
  'modoki_type_text',
  'Type text into the CURRENTLY-FOCUSED element via trusted keyboard events (real ' +
    'Chromium input, so a React controlled input like the Inspector fires its onChange). ' +
    'FOCUS THE TARGET FIRST with modoki_tap on the input. `clearFirst` selects-all + ' +
    'deletes so the field is replaced rather than appended. `submitKey` presses a ' +
    "terminal key: 'Tab'/'Escape' BLUR the field (use to verify commit-on-blur), " +
    "'Enter' submits. Requires the Electron editor.",
  {
    text: z.string().describe('Text to type into the focused input.'),
    clearFirst: z.boolean().optional().describe('Select-all + delete before typing (replace vs append).'),
    submitKey: z.string().optional().describe("Terminal key after typing: 'Enter', 'Tab', or 'Escape'."),
  },
  async ({ text, clearFirst, submitKey }) => postJson('/api/input/type', { text, clearFirst, submitKey }),
);

// ── get_editor_state — "see everything a human sees" ──
server.tool(
  'modoki_get_editor_state',
  'Read the WHOLE editor UI state in one call: current scene path, play state ' +
    '(stopped/playing/paused), gizmo mode/space, FPS, entity count, current selection ' +
    '(entity ids + selected asset), the editor viewport camera pose, and undo/redo ' +
    'availability + labels. The companion to get_scene_state (which reads the ECS world): ' +
    'this reads the EDITOR. Requires a connected editor renderer.',
  {},
  async () => getJson('/api/editor-state'),
);

// ── editor_journal — the human-activity stream (Editor Percept) ──
server.tool(
  'modoki_editor_journal',
  'Read the EDITOR-ACTIVITY stream — what is being done in the editor session (Editor Percept). ' +
    'Event TYPES: !edit, !select, !create, !delete, !duplicate, !reparent, !transform, !undo, !redo, ' +
    '!play, !pause, !stop, !scene-load, !save, !gizmo. Structural events carry guids: !create/!duplicate ' +
    '`{entity, parent, source?}`, !delete `{entities:[guid]}`, !reparent `{entity, from, to, reorder}` ' +
    '(from/to are parent guids, "root" for scene root), !transform `{entity, before, after}` (a gizmo ' +
    'drag — before/after hold only the TRS fields that moved, e.g. {x,y,z}). !scene-load `{path, ' +
    'entityCount}`, !save `{path, entities}`, !gizmo `{mode|space}`. ' +
    'A trait-field !edit ALSO carries a structured `detail: {trait, field, entities[guid], old[], ' +
    'new[]}` (index-aligned arrays; length-1 for a single edit, N for a multi-select — so "zeroed ' +
    'gravityScale on 3 crates" is machine-readable, not just a label). !undo/!redo echo the ' +
    'detail/payload of the action they traversed. `detail.new` is the value at the edit\'s first commit — exact for discrete edits ' +
    '(text-blur/checkbox/dropdown, which commit once); a continuous drag reports its first frame, ' +
    'so read the FINAL value live from get_scene_state. Compound multi-field edits (e.g. SpriteAnimator ' +
    'clip/track ops) are label-only (no detail). Each event has a ' +
    '`source`: "human" (the person) or "agent" (YOUR own edits via these MCP ops) — filter to see ' +
    'only what the human did, so you don\'t attribute your own edits to them. Captured at COMMIT ' +
    'points (not per drag frame); wall-clock + monotonic `seq` stamped — pass the last `seq` as ' +
    '`since` to poll only new EDITOR events. `merged:true` also returns the game journal under ' +
    '`game` (raw, tick-stamped) AND a `timeline`: a SINGLE-AXIS interleave of editor + game events ' +
    'ordered by a shared `cap` capture counter, each tagged `stream:"editor"|"game"` — the one ' +
    'ordered story ("pressed Play → set timeScale 0.3 → @match on tick 84 → paused"). `type`/`source`/' +
    '`since` shape ONLY the `editor` array; the `timeline` is the full correlated story, windowed by ' +
    'its own `sinceCap` cursor — poll it incrementally by passing the returned `nextCap` as `sinceCap` ' +
    '(a cursored poll returns the OLDEST events after the cursor, so it is contiguous and never skips). ' +
    'Every stream returns the LAST 100 events by default plus `byType`/`gameByType` counts over the ' +
    'whole ring (a busy session is ~54–126k tokens of editor events, and the game ring far more); ' +
    'raise limit=N, or cursor precisely with since=/sinceCap=. ' +
    'Editor-only. This is how you PAIR: see the human\'s edits and line them up against what the game did.',
  {
    type: z.string().optional().describe('Only editor events of this type: !edit | !select | !create | !delete | !duplicate | !reparent | !transform | !undo | !redo | !play | !pause | !stop | !scene-load | !save | !gizmo. (Filters the `editor` array only.)'),
    source: z.enum(['human', 'agent']).optional().describe('Only events by the human at the keyboard, or by the agent (your MCP ops). Omit for both. (Filters the `editor` array only.)'),
    since: z.number().optional().describe('Forward cursor for the `editor` array: returns the OLDEST events with seq greater than this (contiguous, oldest-first) + a `nextSeq` when truncated. Advance with `nextSeq` each poll — a cursored poll NEVER skips events (unlike the bare newest-last call). Does NOT window the merged timeline (use sinceCap).'),
    sinceCap: z.number().optional().describe('Forward cursor for the merged `timeline`: returns the OLDEST interleaved events with cap greater than this (contiguous, oldest-first) + a `nextCap` when truncated. Advance with `nextCap` each poll to fetch newer events with no gap.'),
    merged: z.boolean().optional().describe('Also include the game journal under `game` (raw) AND the interleaved `timeline`. Both are tailed too — cursor with sinceCap for a precise incremental slice.'),
    limit: z.number().optional().describe('Return the last N events per stream (default 100). An explicit limit always wins.'),
    clear: z.boolean().optional().describe('Clear the editor-activity buffer after reading.'),
  },
  async ({ type, source, since, sinceCap, merged, limit, clear }) => {
    const q = new URLSearchParams();
    if (type) q.set('type', type);
    if (source) q.set('source', source);
    if (since != null) q.set('since', String(since));
    if (sinceCap != null) q.set('sinceCap', String(sinceCap));
    if (merged) q.set('merged', '1');
    if (limit != null) q.set('limit', String(limit));
    if (clear) q.set('clear', '1');
    const qs = q.toString();
    return getJson(`/api/editor-journal${qs ? `?${qs}` : ''}`);
  },
);

// ── set_selection ──
server.tool(
  'modoki_set_selection',
  'Set the editor selection (what the Inspector/gizmo act on). Select entities by guid ' +
    '(PREFER — stable) or id, OR select an asset. A ref that matches no live entity is skipped ' +
    '(reported in `skipped`); if NONE resolve the call fails, so selection is never silently ' +
    'confirmed on a stale id. No refs at all = clear. Does NOT push an undo entry. Returns the new editor state.',
  {
    entityId: z.number().nullable().optional().describe('Primary entity id to select (null clears). Prefer guid.'),
    entityIds: z.array(z.number()).optional().describe('Multi-selection set by id. Prefer guids.'),
    guid: z.string().optional().describe('Entity guid to select (preferred — stable across hot-reloads).'),
    guids: z.array(z.string()).optional().describe('Multi-selection set by guid (preferred).'),
    asset: z.object({ path: z.string(), type: z.string(), name: z.string() }).nullable().optional()
      .describe('Select an asset instead of entities.'),
  },
  async (p) => editorAction('set-selection', p),
);

// ── play_control — Play/Stop/Pause/Resume/Step the live game ──
server.tool(
  'modoki_play_control',
  'Drive the editor transport bar: play (snapshot + run), stop (revert to the authored ' +
    'snapshot), pause (freeze), resume, or step (advance exactly one frame while paused). ' +
    'This is how you TEST the game like a human pressing Play. After play, exercise it with ' +
    'modoki_tap/drag, read modoki_get_scene_state, then stop to revert. Returns editor state.',
  { action: z.enum(['play', 'stop', 'pause', 'resume', 'step']) },
  async ({ action }) => editorAction(action),
);

// ── history — undo / redo ──
server.tool(
  'modoki_history',
  'Undo or redo the last editor action (same stack as Cmd+Z / Cmd+Shift+Z). Your own ' +
    'create/duplicate/delete/reparent edits are undoable; selection changes are not. ' +
    'Returns {did, ...editorState} — did=false means the stack end was reached.',
  { action: z.enum(['undo', 'redo']) },
  async ({ action }) => editorAction(action),
);

// ── scene management ──
server.tool(
  'modoki_list_scenes',
  'List the project\'s scene assets (path + guid) so you know what to load.',
  {},
  async () => getJson('/api/scenes'),
);
server.tool(
  'modoki_load_scene',
  'Switch the editor to a scene (returns to Stopped first, like opening a scene). Verify ' +
    'with modoki_get_editor_state / modoki_get_scene_state afterwards. REFUSES when the ' +
    'editor has unsaved live-world changes (it swaps the world, destroying them) — save_all ' +
    'first, or pass force:true.',
  {
    force: z.boolean().optional().describe('Discard unsaved live-world changes (they are destroyed — from the world, the file, AND the undo stack).'),
    path: z.string().describe('Asset-root URL of the scene file.') },
  async ({ path, force }) => editorAction('load-scene', { path, ...(force ? { force } : {}) }),
);
server.tool(
  'modoki_new_scene',
  'Start a fresh untitled scene (clears all entities, spawns a default Camera). Unsaved ' +
    'until you modoki_save_all({path}) — it has no path yet, so save_all REQUIRES one. ' +
    'WARNING: this DISCARDS the live world; anything created and not saved is gone (it ' +
    'refuses if there are unsaved changes — pass force:true to discard them deliberately).',
  { force: z.boolean().optional().describe('Discard unsaved live-world changes deliberately.') },
  async ({ force }) => editorAction('new-scene', force ? { force } : {}),
);
server.tool(
  'modoki_save_all',
  'Save the current scene to disk (File → Save All). Blocked during Play. REQUIRED before ' +
    'any tool that edits the scene FILE (set_transform / mutate_scene) can see entities made ' +
    'by the live-world tools (create_entity / duplicate_entity / prefab) — those do NOT save. ' +
    'FAILS LOUDLY if the write does not land, so a success here really means it is on disk. ' +
    'After new_scene there is no path yet: pass `path` (the Save-As panel needs a human and ' +
    'would hang an agent call).',
  {
    path: z.string().optional().describe(
      'Save to this path instead of the current one, e.g. "/assets/scenes/my-scene.json". ' +
      'Required for a scene from new_scene (which has no path yet); the scene keeps it for later saves.',
    ),
  },
  async ({ path }) => editorAction('save-all', path ? { path } : {}),
);

// ── entity create / duplicate / delete / reparent (undoable, like the menus) ──
server.tool(
  'modoki_create_entity',
  'Create an entity exactly like the Hierarchy "Create ▸" menu (undoable). Kinds: empty, ' +
    'primitive (mesh: sphere/cylinder/cone/plane/…), 2d (shape: square/circle/triangle), ' +
    'canvas2d (full-screen 2D canvas host for Renderable2D children), ui ' +
    '(preset: view/text/image/button/input/slider), camera, light (light: ambient/directional/' +
    'point/spot), particle. Returns {id, name, guid} — carry the GUID (runtime ids are ' +
    'reassigned on every hot-reload). LIVE-world only: NOT saved to disk — run modoki_save_all ' +
    'to persist (a file tool like set_transform/mutate_scene/build can\'t see it until you do).',
  {
    kind: z.enum(['empty', 'primitive', '2d', 'canvas2d', 'ui', 'camera', 'light', 'particle']),
    parentId: z.number().optional().describe('Parent entity id (default 0 = root).'),
    parentGuid: z.string().optional().describe('Parent entity guid — PREFER over parentId (stable across hot-reloads). Wins when both are given.'),
    mesh: z.string().optional().describe('For kind=primitive.'),
    shape: z.string().optional().describe('For kind=2d.'),
    preset: z.enum(['view', 'text', 'image', 'button', 'input', 'slider']).optional().describe('For kind=ui.'),
    light: z.enum(['ambient', 'directional', 'point', 'spot']).optional().describe('For kind=light.'),
  },
  async ({ kind, parentId, parentGuid, mesh, shape, preset, light }) => {
    // Build the discriminated CreateEntitySpec the renderer op expects.
    let spec: Record<string, unknown>;
    switch (kind) {
      case 'primitive': spec = { kind, mesh: mesh ?? 'sphere' }; break;
      case '2d': spec = { kind, shape: shape ?? 'square' }; break;
      case 'ui': spec = { kind, preset: preset ?? 'view' }; break;
      case 'light': spec = { kind, light: light ?? 'point' }; break;
      default: spec = { kind };
    }
    return editorAction('create-entity', { spec, parentId, parentGuid });
  },
);
server.tool(
  'modoki_duplicate_entity',
  'Duplicate an entity and its subtree (undoable, like Cmd+D). Address it by `guid` (PREFER — ' +
    'stable) or `id`. Returns {id, guid} of the new copy — carry the guid. LIVE-world only: NOT ' +
    'saved to disk (run modoki_save_all to persist).',
  { id: z.number().optional().describe('Runtime id — reassigned on hot-reload. Prefer guid.'), guid: z.string().optional().describe('Stable entity guid (preferred). Wins over id.') },
  async ({ id, guid }) => editorAction('duplicate-entity', { id, guid }),
);
server.tool(
  'modoki_delete_entities',
  'Delete one or more entities and their subtrees (undoable). Address them by `guids` (PREFER — ' +
    'stable) or `ids`. A recycled id after a hot-reload can hit the WRONG entity, so pass guids ' +
    'when you have them. LIVE-world only: NOT saved to disk (run modoki_save_all to persist).',
  {
    ids: z.array(z.number()).optional().describe('Runtime ids — reassigned on hot-reload; a recycled id deletes the wrong entity. Prefer guids.'),
    id: z.number().optional(),
    guids: z.array(z.string()).optional().describe('Stable entity guids (preferred).'),
    guid: z.string().optional(),
  },
  async ({ ids, id, guids, guid }) => editorAction('delete-entities', { ids, id, guids, guid }),
);
server.tool(
  'modoki_reparent_entity',
  'Move an entity under a new parent (0 = root), optionally setting sortOrder. Preserves ' +
    'world transform (undoable). Address the entity AND the parent by `guid`/`parentGuid` ' +
    '(PREFER — stable) or `id`/`parentId`. LIVE-world only: NOT saved to disk (run modoki_save_all).',
  {
    id: z.number().optional().describe('Runtime id of the entity to move. Prefer guid.'),
    guid: z.string().optional().describe('Stable guid of the entity to move (preferred). Wins over id.'),
    parentId: z.number().optional().describe('New parent runtime id (0 or omitted = root). Prefer parentGuid.'),
    parentGuid: z.string().optional().describe('New parent guid (preferred). Wins over parentId.'),
    sortOrder: z.number().optional(),
  },
  async ({ id, guid, parentId, parentGuid, sortOrder }) => editorAction('reparent-entity', { id, guid, parentId, parentGuid, sortOrder }),
);

// ── prefab ops ──
server.tool(
  'modoki_prefab',
  'Prefab actions: instantiate a .prefab.json into the scene (path + optional parent), ' +
    'create a prefab FROM an entity (entity + destination path), or detach an instance (entity, ' +
    '"unpack completely"). detach FAILS if the entity is not a prefab instance (nothing to unpack). ' +
    'Persistence: instantiate/detach are LIVE-world only. create writes the .prefab.json to disk ' +
    'AND tags the source entities as a PrefabInstance in the LIVE world (unsaved) — run ' +
    'modoki_save_all to persist that linkage into the scene, or a reload discards it. ' +
    'Address the entity/parent by guid (PREFER — stable) or id.',
  {
    action: z.enum(['instantiate', 'create', 'detach']),
    path: z.string().optional().describe('instantiate: prefab asset path. create: destination .prefab.json path.'),
    parentId: z.number().optional().describe('instantiate: parent entity id (default root). Prefer parentGuid.'),
    parentGuid: z.string().optional().describe('instantiate: parent entity guid (preferred; wins over parentId).'),
    entityId: z.number().optional().describe('create/detach: the entity id. Prefer entityGuid.'),
    entityGuid: z.string().optional().describe('create/detach: the entity guid (preferred; wins over entityId).'),
  },
  async (p) => editorAction('prefab', p),
);

// ── gizmo / focus ──
server.tool(
  'modoki_gizmo',
  'Set the SceneView transform gizmo mode (translate/rotate/scale) and/or space (world/local).',
  {
    mode: z.enum(['translate', 'rotate', 'scale']).optional(),
    space: z.enum(['world', 'local']).optional(),
  },
  async (p) => editorAction('set-gizmo', p),
);
server.tool(
  'modoki_scene_view_mode',
  "Set the SceneView viewport mode: '3d' (Three.js) or 'ui' (the 2D/UI overlay). The " +
    "toolbar selector is a native <select> that trusted input can't drive, so use this. " +
    "'ui' mode is REQUIRED to edit Collider2D vertices (with set-collider-edit) and to see " +
    'their interaction handles (modoki_handles editor=collider2d). Returns editor state.',
  { mode: z.enum(['3d', 'ui']) },
  async ({ mode }) => editorAction('set-scene-view-mode', { mode }),
);
server.tool(
  'modoki_collider_edit',
  'Toggle Collider2D vertex-edit mode (the toolbar "Points" button) for the selected ' +
    "entity. Pair with modoki_scene_view_mode 'ui' + a selected entity that has an editable " +
    'collider (polygon/polyline/concave); then modoki_handles editor=collider2d lists its ' +
    'draggable vertices. Returns editor state.',
  { on: z.boolean() },
  async ({ on }) => editorAction('set-collider-edit', { on }),
);
server.tool(
  'modoki_open_particle_editor',
  'Open the Particle Editor dock panel on a .particle.json asset (normally a double-click ' +
    'in Assets). This MOUNTS the Size/Opacity curve editors + the color/alpha gradient editor, ' +
    'so their interaction handles then appear (modoki_handles editor=particle — kinds ' +
    "'curve-point' / 'gradient-stop'). Pass the asset's served path (e.g. " +
    "'/assets/particles/fire.particle.json'). Returns editor state.",
  { path: z.string(), name: z.string().optional() },
  async ({ path, name }) => editorAction('open-particle-editor', { path, name }),
);
server.tool(
  'modoki_open_sprite_editor',
  'Open the Sprite slicer modal on a texture (the Texture Inspector "Sprite Editor" button). ' +
    'Selects the texture + opens the modal, so its slice-handle providers appear ' +
    "(modoki_handles editor=sprite — the selected sprite's 8 corner/edge handles + pivot). " +
    "Pass the texture's served path (e.g. '/assets/textures/sheet.png'). Returns editor state.",
  { path: z.string(), name: z.string().optional() },
  async ({ path, name }) => editorAction('open-sprite-editor', { path, name }),
);
server.tool(
  'modoki_open_nine_slice_editor',
  'Open the 9-slice border editor modal on a UI texture (the Texture Inspector "Edit ' +
    'visually…" button — only for type=ui textures). Its 4 guide knobs then appear ' +
    '(modoki_handles editor=nineslice). Pass the texture\'s served path. Returns editor state.',
  { path: z.string(), name: z.string().optional() },
  async ({ path, name }) => editorAction('open-nine-slice-editor', { path, name }),
);
server.tool(
  'modoki_focus_entity',
  'Frame an entity in the SceneView orbit camera (the F-key / "Focus" action). Address it by ' +
    '`guid` (PREFER — stable) or `id`. Fails if the entity does not resolve, or if no SceneView ' +
    'is mounted to frame it in (so a "framed it" report always means the camera moved).',
  { id: z.number().optional().describe('Runtime id. Prefer guid.'), guid: z.string().optional().describe('Stable entity guid (preferred). Wins over id.') },
  async ({ id, guid }) => editorAction('focus-entity', { id, guid }),
);

// ── identity — WHICH editor is MODOKI_BACKEND pointing at? ──
server.tool(
  'modoki_identity',
  'Report which checkout, project and process the configured MODOKI_BACKEND is actually ' +
    'serving: {repoRoot, projectRoot, backendPort, pid, branch, packaged}. Call this FIRST ' +
    'when editor calls "succeed" but nothing you expect changes — with two clones of the ' +
    'repo on one machine it is easy to be driving the sibling clone\'s editor, which fails ' +
    'silently. A mismatch against this session\'s working directory is also warned about ' +
    'automatically on every tool result.',
  {},
  () => getJson('/api/identity'),
);

// ── console logs (endpoint already existed; this exposes it as a tool) ──
server.tool(
  'modoki_get_console_logs',
  'Read the editor renderer\'s recent console output (errors/warns/logs + uncaught errors ' +
    'and unhandled rejections). Use to diagnose a failed scene/mesh load or a runtime throw ' +
    'without a devtools attach. Returns the LAST 50 entries by default plus `byLevel` counts ' +
    'over the whole 500-entry ring (error entries carry full stacks, so the ring can exceed ' +
    '20k tokens). Raise limit=N for more, or narrow with level=/since=.',
  {
    level: z.enum(['log', 'warn', 'error']).optional().describe('Filter to one level.'),
    limit: z.number().optional().describe('Return the last N entries (default 50). An explicit limit always wins; pass a large one for the whole ring.'),
    since: z.number().optional().describe('Only entries with ts > this (ms epoch).'),
  },
  async ({ level, limit, since }) => {
    const q = new URLSearchParams();
    if (level) q.set('level', level);
    if (limit != null) q.set('limit', String(limit));
    if (since != null) q.set('since', String(since));
    const qs = q.toString();
    return getJson(`/api/console-logs${qs ? `?${qs}` : ''}`);
  },
);

// ── project settings ──
server.tool(
  'modoki_project_settings',
  'Read or write project.config.json (app identity, build pipeline, default game). ' +
    'action=get returns the resolved config; action=set merges + persists `values`.',
  {
    action: z.enum(['get', 'set']),
    values: z.record(z.any()).optional().describe('For action=set: the config fields to merge (e.g. {"app":{"appName":"X"}}).'),
  },
  async ({ action, values }) =>
    action === 'get' ? getJson('/api/project-settings') : postJson('/api/project-settings', values ?? {}),
);

// ── import a new asset from disk ──
server.tool(
  'modoki_import_file',
  'Import a NEW file from anywhere on disk into the project (the human "drag from Finder" ' +
    'path): copies it under destFolder, assigns a fresh GUID, and runs the asset-type import ' +
    'pipeline (texture→KTX2/WebP, model→GLB) unless reimport=false. Returns {path, guid, type}.',
  {
    srcPath: z.string().describe('Absolute path of the source file on disk.'),
    destFolder: z.string().describe('Asset-root URL of the destination folder, e.g. /games/x/assets/textures'),
    reimport: z.boolean().optional().describe('Run the import pipeline after copy (default true).'),
  },
  async ({ srcPath, destFolder, reimport }) => postJson('/api/import-file', { srcPath, destFolder, reimport }, 120_000),
);

// ── build / deploy (SSE consumed to completion) ──
server.tool(
  'modoki_build',
  'Run a build + deploy exactly like the editor Build menu (web / iOS device / Android ' +
    'device / playable ad). Consumes the build stream to completion and returns {ok, log} or ' +
    'the failure tail. HEAVY: native builds run xcodebuild/gradle and install on a device — ' +
    'minutes long. playable = a single self-contained HTML at games/<id>/ads/index.html.',
  {
    platform: z.enum(['web', 'ios', 'android', 'playable']),
    force: z.boolean().optional().describe('Build even with unsaved editor changes (the artifact will NOT contain them).'),
  },
  async ({ platform, force }) => {
    // A build reads the scene FILE. The live-world tools (create_entity / duplicate / prefab)
    // do NOT save — so an unsaved editor builds a world that is missing exactly the work the
    // agent just did, reports ok:true, and the deployed web build / device install is stale
    // with nothing anywhere saying why. For a native build that is MINUTES of xcodebuild or
    // gradle producing the wrong artifact. Refuse instead. (C7)
    if (!force) {
      const stale = await unsavedChangesWarning();
      if (stale) return err(stale);
    }
    return consumeBuildStream(`/api/build?platform=${platform}`, 30 * 60_000);
  },
);
server.tool(
  'modoki_add_native_target',
  'Scaffold a native target (cap add + deps + config + heal) like Build → "Add iOS/Android ' +
    'Target…". Consumes the stream to completion.',
  { platform: z.enum(['ios', 'android']) },
  async ({ platform }) => consumeBuildStream(`/api/add-native-target?platform=${platform}`, 15 * 60_000),
);

// ════════════════════════════════════════════════════════════════════════════
// Enable-Claude-more tools (semantic verification, numeric layout, asset authoring,
// particle/anim editing, time, diagnostics, input feel). All relay through the same
// backend → renderer bridge, so they work in dev AND the packaged DMG.
// ════════════════════════════════════════════════════════════════════════════

// ── Phase A: semantic verification ──
server.tool(
  'modoki_journal',
  'Read the tick-stamped game-event trace (events a game emits: match/score/win/…). The ' +
    'screenshot-free way to verify game LOGIC — assert on events, not pixels. Returns the ' +
    'LAST 100 events by default plus `byType` counts over the whole 10,000-event ring and ' +
    '`captures` (Tier-2 diagnostic state). Narrow with type=, raise limit=N, pair with ' +
    'modoki_dispatch_action to drive the game.\n' +
    'TIERS: lean events (semantic + @collision/@sensor/@zone transitions) are always recorded. ' +
    'High-frequency DIAGNOSTIC events (@contact) are WATCH-GATED — they record NOTHING until you ' +
    'open a capture and only from that point forward (this keeps the journal from being dominated ' +
    'by @contact). Open/close with action:"start"/"stop" + type:"@contact" BEFORE the moment you ' +
    'want to trace, then read, then stop.',
  {
    type: z.string().optional().describe('Read: only events of this type. With action: the watch-gated type to start/stop (e.g. "@contact").'),
    action: z.enum(['start', 'stop']).optional().describe('Open ("start") or close ("stop") a Tier-2 capture window for type=. Omit to just read.'),
    limit: z.number().optional().describe('Return the last N events (default 100). An explicit limit always wins.'),
    clear: z.boolean().optional().describe('Clear the journal after reading.'),
  },
  async ({ type, action, limit, clear }) => {
    const q = new URLSearchParams();
    if (type) q.set('type', type);
    if (action) q.set('action', action);
    if (limit != null) q.set('limit', String(limit));
    if (clear) q.set('clear', '1');
    const qs = q.toString();
    return getJson(`/api/journal${qs ? `?${qs}` : ''}`);
  },
);
server.tool(
  'modoki_resolve_refs',
  'Resolve journal/contact refs (GUIDs and/or numeric ids from @contact/@collision/@sensor/@zone ' +
    'payloads) to entity display NAMES — the deliberate second hop that keeps names OUT of the ' +
    'journal stream (which is dominated by high-frequency contact events). Batch every ref you care ' +
    'about into one call. Names resolve even for entities that have since DESPAWNED (captured at emit ' +
    'time), which a live get_scene_state lookup cannot. Returns { resolved: { ref: {name, alive} }, ' +
    'unresolved: [...] }.',
  {
    refs: z.array(z.union([z.string(), z.number()])).describe('Refs to resolve — GUIDs and/or numeric ids.'),
  },
  async ({ refs }) => {
    const q = new URLSearchParams();
    q.set('refs', refs.map((r) => String(r)).join(','));
    return getJson(`/api/resolve-refs?${q.toString()}`);
  },
);
server.tool(
  'modoki_list_actions',
  'Discover what the game exposes: dispatchable UI/game action names (+ their param schemas) ' +
    'and live named read-values (e.g. canGoBack, timeSinceGameStart). Use before modoki_dispatch_action.',
  {},
  async () => getJson('/api/game-introspect'),
);
server.tool(
  'modoki_dispatch_action',
  'Trigger a game intent directly by name (no pixel-hunting a button) — e.g. a UIAction a button ' +
    'would fire. Only works while Playing (use modoki_play_control play first); returns ' +
    '{dispatched:false, reason} otherwise. Verify the effect with modoki_journal / modoki_get_scene_state.',
  {
    name: z.string().describe('Action name (from modoki_list_actions).'),
    payload: z.union([z.string(), z.number()]).optional(),
    params: z.record(z.any()).optional(),
    targetGuid: z.string().optional().describe('GUID of the entity the action targets.'),
  },
  async (p) => editorAction('dispatch-action', p),
);
server.tool(
  'modoki_play_clip',
  'Switch an entity\'s active animation clip BY NAME — the unified engine.playClip action, which ' +
    'drives whichever animator the entity carries (keyframe Animator, 2D SpriteAnimator, or GLB ' +
    'SkeletalAnimator). Only while Playing (modoki_play_control play first). This switches WHICH ' +
    'clip plays; it does NOT edit clip data — that is modoki_anim_set_clip. Discover the valid ' +
    'names from the `clipNames` field on the animator trait in modoki_get_scene_state; verify the ' +
    'switch with get_scene_state (the trait\'s activeClip / clip).',
  {
    guid: z.string().describe('GUID of the animator entity.'),
    clip: z.string().describe('Clip NAME to play (one of the target\'s clipNames).'),
  },
  async ({ guid, clip }) => editorAction('dispatch-action', { name: 'engine.playClip', targetGuid: guid, params: { clip } }),
);

// ── Phase B: numeric layout/bounds ──
server.tool(
  'modoki_get_layout_bounds',
  'Numeric screen-space layout (viewport CSS px) — UI (true DOM/flexbox rects), 2D, and 3D ' +
    '(world AABB projected through the game camera). Use this INSTEAD of eyeballing a screenshot ' +
    'to check alignment, spacing, overlap, or clipping. CALLED BARE it returns COUNTS — count, ' +
    'layerCounts, overlapsCount — plus the cheap `offScreen` and `zeroSize` id lists. Those ids ' +
    'are usually the whole answer ("what is invisible / collapsed?"). For per-entity rects pass ' +
    '`ids` or `layer`; for the same-layer overlapping PAIRS (ancestor pairs excluded) pass ' +
    '`overlaps:true` — the pair list is O(n²) and was ~105k chars on a 241-entity scene, so it is ' +
    'opt-in. Cross-check against modoki_capture_viewport when unsure.',
  {
    layer: z.enum(['ui', '2d', '3d']).optional().describe('Limit to one layer. Implies per-entity rects.'),
    ids: z.array(z.number()).optional().describe('Limit to these entity ids. Implies per-entity rects.'),
    entities: z.boolean().optional().describe('Force the per-entity rect list on an untargeted call. Large — prefer ids/layer.'),
    overlaps: z.boolean().optional().describe('Materialize the overlapping-pair list. Default false (only overlapsCount is reported) because it is O(n²) and dominated the response.'),
    limit: z.number().int().positive().optional().describe('Cap the returned per-entity rects; sets truncated + totalCount. Useful with layer= on a big scene.'),
    precision: z.number().int().nonnegative().optional().describe('Significant digits for float values. Default 9 — trims float64 mantissa noise (247.13061935179246 -> 247.130619), saving ~17-29% of the response with a max error of 3.5e-7. Verify edits with a TOLERANCE, not string/=== equality. Pass precision=0 for exact float64.'),
  },
  async ({ layer, ids, entities, overlaps, limit, precision }) => {
    const q = new URLSearchParams();
    if (layer) q.set('layer', layer);
    if (ids?.length) q.set('ids', ids.join(','));
    if (entities) q.set('entities', '1');
    if (overlaps) q.set('overlaps', '1');
    if (limit != null) q.set('limit', String(limit));
    if (precision != null) q.set('precision', String(precision));
    const qs = q.toString();
    return getJson(`/api/layout-bounds${qs ? `?${qs}` : ''}`);
  },
);

// ── Phase E: time-scale ──
server.tool(
  'modoki_set_timescale',
  'Set the simulation time scale: 0 = pause, 0.3 = slow-motion, 1 = normal, 2 = fast-forward. ' +
    'Pair with modoki_render_sequence to inspect fast animations/particles frame-by-frame.',
  { scale: z.number().describe('Time scale (>= 0).') },
  async ({ scale }) => editorAction('set-timescale', { scale }),
);

// ── Phase F: render/scene health diagnose ──
server.tool(
  'modoki_diagnose',
  'Structured render/scene health report — turns "it renders black / looks wrong" into concrete ' +
    'causes: dangling/illegal asset refs, NaN or zero-scale transforms, missing camera, off-screen ' +
    'entities, and recent console errors. Run this FIRST when something is visually broken (before ' +
    'capture_viewport). Returns {ok, summary, refs, transforms, camera, offScreen, consoleErrors}.',
  {},
  async () => getJson('/api/diagnose'),
);

// ── Percept Watch: numeric time-series over the live world ──
server.tool(
  'modoki_watch',
  'Percept WATCH — a standing, change-detected numeric time-series over the live world. The way ' +
    'to see how a NUMBER moved over time (jump overshoot, spring settle, velocity decay, a bone ' +
    'trajectory) — the animation/physics feel questions you cannot judge from a screenshot. ' +
    'action:start opens a focused watch (one component, optional guid/NAME/field subset); a value ' +
    'is recorded only when it moves > epsilon (settled things record nothing). ' +
    'SCOPE by `names` (case-insensitive substrings) for a runtime-spawned, short-lived entity whose ' +
    'GUID changes every spawn (e.g. a projectile re-instantiated each launch): new matches AUTO-JOIN ' +
    'by name, so you do not need a stable guid, and the series cardinality cap is spent only on ' +
    'matches. `guids` scopes to exact guids (fails if all are stale). Neither = every entity with the ' +
    'component (movers are prioritized over static entities if the cap is hit). ' +
    'action:read returns per-field summary STATS (first/last/min/max/delta/settled) + each series\' ' +
    'entity `name` — usually the whole answer. Pass samples=true for the raw series when you need the ' +
    'curve shape; narrow a broad watch at read time with name=/guids=/limit=. ' +
    'action:list / action:clear manage them. Editor-only; press Play, watch, read, then clear.',
  {
    action: z.enum(['start', 'read', 'list', 'clear']).describe('start a watch | read its series+stats | list active watches | clear one/all'),
    component: z.string().optional().describe('(start) Component whose numeric fields to sample, e.g. Transform, RigidBody2D, SkeletalAnimator.'),
    guids: z.array(z.string()).optional().describe('(start) Restrict to these entity GUIDs (start FAILS if all are stale). (read) Filter the returned series to these guids. Omit both guids+names at start to watch EVERY entity with the component.'),
    names: z.array(z.string()).optional().describe('(start) Scope to entities whose authored NAME contains any of these (case-insensitive). New spawns matching a name AUTO-JOIN — the handle for a runtime-spawned entity whose GUID changes every launch (a fresh-guid projectile/puck). Does NOT fail on zero current matches (they may spawn later); the reply reports matchedNow.'),
    fields: z.array(z.string()).optional().describe('(start) Restrict to these numeric fields; omit for all numeric fields of the component.'),
    epsilon: z.number().optional().describe('(start) Change threshold — record only when a value moves more than this. Default 1e-4.'),
    everyNFrames: z.number().int().positive().optional().describe('(start) Sample every Nth frame (decimation). Default 1.'),
    maxSamples: z.number().int().positive().optional().describe('(start) Ring cap per series. Default 600.'),
    maxSeries: z.number().int().positive().optional().describe('(start) Cap on MOVING series — max distinct (entity,field) series that record movement. Default 512, max 4096. A static/never-moved entity does NOT consume this budget (its baseline is kept cheaply), so a screen of static tiles can\'t crowd out a late-joining mover (e.g. a projectile spawned mid-scene).'),
    expireFrames: z.number().int().nonnegative().optional().describe('(start) Auto-remove the watch after N observed frames (0 = never). Default 0.'),
    id: z.string().optional().describe('(read/clear) Watch id from start/list. Omit on clear to clear ALL.'),
    name: z.string().optional().describe('(read) Filter the returned series to entities whose name contains this (case-insensitive) — isolate one entity in a broad watch. `seriesTotal` still reports the full match count.'),
    limit: z.number().int().nonnegative().optional().describe('(read) Cap the number of series returned (sets seriesTruncated when it drops some). Pair with name=/guids= on a broad watch so the response does not blow the cap.'),
    clear: z.boolean().optional().describe('(read) Clear the recorded series after reading.'),
    samples: z.boolean().optional().describe('(read) Include the RAW time-series per field. Default false — read returns stats only. A full read is ~40 chars/sample and the caps allow 512 series x 5000 samples, so ask for samples only when the stats are not enough (e.g. plotting the curve shape).'),
    precision: z.number().int().nonnegative().optional().describe('Significant digits for float values. Default 9 — trims float64 mantissa noise (247.13061935179246 -> 247.130619), saving ~17-29% of the response with a max error of 3.5e-7. Verify edits with a TOLERANCE, not string/=== equality. Pass precision=0 for exact float64.'),
  },
  async ({ action, component, guids, names, fields, epsilon, everyNFrames, maxSamples, maxSeries, expireFrames, id, name, limit, clear, samples, precision }) => {
    if (action === 'start') return postJson('/api/watch/start', { component, guids, names, fields, epsilon, everyNFrames, maxSamples, maxSeries, expireFrames });
    if (action === 'read') {
      const q = new URLSearchParams({ id: id ?? '' });
      if (clear) q.set('clear', '1');
      if (samples) q.set('samples', '1');
      if (name) q.set('name', name);
      if (guids?.length) q.set('guids', guids.join(','));
      if (limit != null) q.set('limit', String(limit));
      if (precision != null) q.set('precision', String(precision));
      return getJson(`/api/watch/read?${q.toString()}`);
    }
    if (action === 'list') return getJson('/api/watch/list');
    return postJson('/api/watch/clear', { id });
  },
);

// ── Phase C: asset schema introspection + validated authoring ──
server.tool(
  'modoki_asset_schema',
  'Get the field schema (types, defaults, ranges, enums) + a valid example for an asset type ' +
    '(material / particle / animation), so you can author the JSON correctly. Read this BEFORE ' +
    'modoki_write_asset. Texture/effect refs must be GUIDs (use modoki_list_assets).',
  { type: z.enum(['material', 'particle', 'animation']) },
  async ({ type }) => getJson(`/api/asset-schema?type=${type}`),
);
server.tool(
  'modoki_create_asset',
  'Scaffold a new asset (material/particle/animation) with sensible defaults + a fresh GUID at ' +
    'the given path. Then edit it with modoki_write_asset or (for live preview) the particle/anim ops.',
  {
    type: z.enum(['material', 'particle', 'animation']),
    path: z.string().describe('Asset-root URL, e.g. /games/x/assets/fx/spark.particle.json'),
  },
  async ({ type, path }) => postJson('/api/create-asset', { type, path }),
);
server.tool(
  'modoki_write_asset',
  'Write an asset JSON file (material/particle/animation) with validation (warn-but-write — hard ' +
    'errors block, warnings are returned). Preserves the existing file\'s id if `data` omits one. ' +
    'For a LIVE particle/animation preview while tuning, prefer modoki_particle_set / modoki_anim_set_clip.',
  {
    path: z.string(),
    type: z.enum(['material', 'particle', 'animation']),
    data: z.record(z.any()).describe('The asset document (see modoki_asset_schema for the shape).'),
  },
  async ({ path, type, data }) => postJson('/api/asset-write', { path, type, data }),
);

// ── Phase D: particle / animation first-pass editing (live + persisted) ──
server.tool(
  'modoki_set_playhead',
  'Move the animation playhead (scrub) to a time in seconds — drives the live preview and the ' +
    'insertion point. Pair with modoki_render_sequence / modoki_capture_viewport to see the pose.',
  { t: z.number().describe('Playhead time in seconds.') },
  async ({ t }) => editorAction('set-playhead', { t }),
);
server.tool(
  'modoki_particle_set',
  'Replace a particle effect definition — applies LIVE (you see it immediately) AND saves the ' +
    '.particle.json. Get the shape from modoki_asset_schema particle. Tune emission/lifetime/size, ' +
    'then judge motion with modoki_render_sequence (the human refines the final feel).',
  {
    path: z.string().describe('Asset-root URL of the .particle.json'),
    def: z.record(z.any()).describe('Full ParticleEffectDef (see modoki_asset_schema particle).'),
  },
  async ({ path, def }) => editorAction('particle-set', { path, def }),
);
server.tool(
  'modoki_anim_set_clip',
  'Replace a whole animation clip — normalized, applied LIVE, and saved to the .anim.json.',
  {
    clipPath: z.string(),
    clip: z.record(z.any()).describe('Full AnimationClipDef (see modoki_asset_schema animation).'),
  },
  async ({ clipPath, clip }) => editorAction('anim-set-clip', { clipPath, clip }),
);
server.tool(
  'modoki_anim_add_key',
  'Add/update ONE keyframe on a clip track (creates the track if absent) — the granular way to ' +
    'rough-in timing. Applies live + saves. `path` is the relative entity name-path from the ' +
    'Animator root ("" = root). `type` defaults to number (use color/boolean/enum for those fields).',
  {
    clipPath: z.string(),
    trait: z.string().describe('e.g. "Transform"'),
    field: z.string().describe('e.g. "y" or "rz"'),
    time: z.number().describe('Key time in seconds.'),
    value: z.union([z.number(), z.string(), z.boolean()]).describe('Value (encoded per track type).'),
    path: z.string().optional().describe('Relative name-path from the Animator root (default "").'),
    type: z.enum(['number', 'color', 'boolean', 'enum']).optional(),
  },
  async (p) => editorAction('anim-add-key', p),
);
server.tool(
  'modoki_timeline_set',
  'Replace a whole timeline sequence — normalized, applied LIVE (panel + runtime), and saved to the ' +
    '.timeline.json. Tracks target descendants of the Director root by relative name-path.',
  {
    timelinePath: z.string(),
    timeline: z.record(z.any()).describe('Full TimelineDef (see modoki_asset_schema timeline).'),
  },
  async ({ timelinePath, timeline }) => editorAction('timeline-set', { timelinePath, timeline }),
);
server.tool(
  'modoki_timeline_add_clip',
  'Add ONE item to a timeline track (creates the track if absent) — the granular way to build a ' +
    'cutscene. `trackType` picks the lane; `item` is the per-kind body: animation → ' +
    '{start,duration?,clip(NAME in the target animator bank),scrub?} · signal → {t,action(UIAction),params?} · ' +
    'audio → {t,clip(audio GUID),bus?,volume?,pitch?} · activation → {start,end}. Applies live + saves.',
  {
    timelinePath: z.string(),
    trackType: z.enum(['animation', 'signal', 'audio', 'activation']),
    target: z.string().optional().describe('Relative name-path from the Director root (default "" = root).'),
    item: z.record(z.any()).describe('The per-kind item body (see description).'),
  },
  async (p) => editorAction('timeline-add-clip', p),
);

// ── Phase G: input-feel capture (Electron editor only) ──
server.tool(
  'modoki_capture_gesture',
  'Run a trusted drag from→to while SAMPLING an entity\'s Transform each frame, returning the ' +
    'trajectory (position over time). Use to tune input FEEL numerically — drag a draggable object ' +
    'and see how it tracks/eases/lags, then adjust thresholds/damping. Requires the Electron editor ' +
    'and the game Playing (so the drag drives game logic). Prefer sampleGuid (stable across ' +
    'hot-reloads). For sampling ANY component over time WITHOUT a drag, use modoki_watch instead.',
  {
    from: z.object({ x: z.number(), y: z.number() }),
    to: z.object({ x: z.number(), y: z.number() }),
    sampleGuid: z.string().optional().describe('Entity GUID whose Transform is sampled each frame (preferred — survives hot-reloads).'),
    sampleEntityId: z.number().optional().describe('Entity numeric id to sample (fallback; churns across hot-reloads — prefer sampleGuid).'),
    steps: z.number().optional().describe('Intermediate sample count (default 12).'),
  },
  async ({ from, to, sampleGuid, sampleEntityId, steps }) => postJson('/api/capture-gesture', { from, to, sampleGuid, sampleEntityId, steps }, 60_000),
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[modoki-mcp] started — backend ${BACKEND}\n`);
}

main().catch((e) => {
  process.stderr.write(`[modoki-mcp] fatal: ${e}\n`);
  process.exit(1);
});
