# Modoki MCP Server

The Claude-friendly authoring surface. A thin MCP wrapper
over the editor backend HTTP API (the shared `editorBackendRouter` served by the
Vite dev server **or** the Electron main process), so a user's own **Claude Code** can build
games by editing scenes/assets through validated tools — and verify its own work
without a screenshot.

## Connect

Add to the project's `.mcp.json` (already wired in this repo):

```json
{
  "mcpServers": {
    "modoki": {
      "command": "npx",
      "args": ["tsx", "engine/tools/modoki-mcp/src/index.ts"],
      "env": { "MODOKI_BACKEND": "${MODOKI_BACKEND:-http://127.0.0.1:5179}" }
    }
  }
}
```

`MODOKI_BACKEND` points at the running editor backend — the Vite dev server
(`http://localhost:5173`) or the Electron editor's port. The editor must be open.

## Tools

| Tool | Purpose |
|------|---------|
| `modoki_get_scene_state` | Read the **live ECS world** (not the file) — the PRIMARY way to verify an edit took effect. A **bare call is a names-only INDEX** (`{id,guid,name,parentId,layer,traits:[NAMES]}`, default `limit` 200); any target (`trait`/`id`/`name`/`where`) or enricher (`full`/`world`/`bounds`/`contacts`) returns trait **values**. |
| `modoki_mutate_scene` | Validated `setTrait`/`addEntity`/`removeEntity` on a scene file (GUID-minting). The way to edit structure — never hand-write scene JSON. Returns `{ok, changed, errors, warnings}`, **not** the scene; verify with `get_scene_state`. |
| `modoki_validate_scene` | Warn-but-load validation against the live trait schema (unknown trait/field, type mismatch, literal-path-instead-of-GUID). |
| `modoki_list_traits` | Registered traits (valid `setTrait` targets). Bare = names by category; `name=<Trait>` for one trait's field schema, `all=true` for every schema. |
| `modoki_list_assets` | Manifest assets (guid/path/type/name). Refs must be GUIDs from here. Bare = per-type counts; narrow with `type`/`folder`/`name`/`limit`, or `all=true`. |
| `modoki_get_asset_meta` | An asset's `.meta.json` import settings. |
| `modoki_reimport_asset` | Re-run the import pipeline (texture → KTX2/WebP, model → LOD + bake). |
| `modoki_capture_viewport` | Screenshot the live editor window → downscaled JPEG path (≤1568px, q70). Final composited pixels (incl. NPR). "Does it render?" *(Electron editor only.)* |
| `modoki_render_scene` | **Deterministic** offscreen render (caller size + camera) → JPEG path. Window-independent + reproducible — before/after geometry, material, lighting, camera-framing checks. Forward pass only (NPR is window-bound). |
| `modoki_render_sequence` | N offscreen frames sampled over wall-clock at `fps` → paths. For MOTION/timing, which a single frame can't show. |
| `modoki_tap` / `modoki_drag` | **Trusted** OS-level input via `sendInputEvent` — reaches PixiJS + Three.js hit-testing. Exercise the game. *(Electron editor only.)* |
| `modoki_type_text` | **Trusted** keyboard input into the focused element (tap the input first). Real Chromium `char` events → React controlled inputs fire `onChange`. `clearFirst` replaces vs appends; `submitKey` `'Tab'`/`'Escape'` blurs, `'Enter'` submits. Author text fields headlessly. *(Electron editor only.)* |

## The verification loop (data-first, pixels-second)

Claude Code can't see a screen — it reads data. The loop the tool descriptions steer toward:

1. **mutate** — `modoki_mutate_scene`.
2. **verify the data** — `modoki_get_scene_state` (exact, deterministic, cheap). *Primary.*
3. **visual sanity** — `modoki_capture_viewport` (window screenshot) or
   `modoki_render_scene` / `modoki_render_sequence` (deterministic offscreen render).
   *Secondary, static only.*

## Scope

Implemented (64 tools): the data-first core + `capture_viewport` (window
screenshot) + `render_scene` / `render_sequence` (deterministic, window-independent
offscreen render + motion sampling) + trusted input (`tap`/`drag`/`type_text`/…) + the
Percept read tools + Enact handles/DnD + the editor-parity ops. `capture_viewport`,
`tap`, and `drag` require the **Electron** editor (the Vite dev backend can't reach the
window) — point `MODOKI_BACKEND` at the Electron port. `render_scene`/`render_sequence`
work against any backend with a mounted 3D view.

The full agent loop is complete: **mutate → get_scene_state (data) → render_scene /
capture_viewport (pixels) → tap/drag (exercise)**.
