# __GAME_NAME__ — a Modoki game project

This is a **Modoki** game project. Modoki is a Claude-friendly game engine: you,
Claude, author the game — scene data, game logic (TypeScript), and asset wiring —
while the human directs and reviews. The visual editor is for the things agents are
bad at (pixel-level layout, final polish).

You were wired to this project by **AI → Connect Claude Code** in the editor, which wrote
an `.mcp.json` for it (the AI panel shows exactly where). When the desktop editor has this
project open, it exposes the tools below. **Prefer them over screenshots** — they read and
mutate the *live* running engine, so they prove your edits actually took effect.

## The verification loop (do this every time)

1. **Read** the live world with `modoki_get_scene_state` before changing anything.
2. **Mutate** with `modoki_mutate_scene` (or `modoki_set_transform` / entity ops).
3. **Verify the data** with `modoki_get_scene_state` again — exact, cheap,
   deterministic. *This is your primary check* (use a tolerance for floats, not `===`).
4. **Verify pixels** with `modoki_render_scene` / `modoki_capture_viewport` only when you
   genuinely need to see the render (catches "numbers right, renders black/NaN").

## Tools

**Author & inspect (the core loop)**
- `modoki_get_scene_state` — dump the LIVE ECS world (entities, traits) as JSON. Called
  bare it's a cheap index (names + trait names); target with `trait=`/`name=`/`where=` for
  values. Address entities by `guid` — ids churn on hot-reload.
- `modoki_mutate_scene` — validated `setTrait`/`removeTrait`/`addEntity`/`removeEntity`;
  writes the scene file atomically, the editor hot-reloads. Never hand-write scene JSON.
- `modoki_set_transform` — one-call place/rotate/scale (prefab-instance aware).
- `modoki_validate_scene`, `modoki_list_traits`, `modoki_list_assets` — the schema you can
  set + the project's assets (every asset ref MUST be a GUID from here).
- `modoki_create_entity` / `duplicate` / `delete` / `reparent` / `prefab` — undoable, like
  the Hierarchy menus. `modoki_load_scene` / `new_scene` / `save_all` / `list_scenes`.

**Test it like a human (Enact — trusted input)**
- `modoki_play_control` — play / stop / pause / resume / step the game.
- `modoki_tap` / `drag` / `hover` / `scroll` / `press_key` / `type_text` — real trusted
  input; aim with a CSS `selector` or page `x,y`. `modoki_handles` + `tap_handle` /
  `drag_handle` drive the DOM-less Canvas2D/SVG editors (bones, keyframes, collider verts).

**Verify by DATA, not vibes (Percept)**
- `modoki_journal` / `modoki_editor_journal` — the game's tick-stamped semantic events and
  the editor-activity stream (what the human is doing). Assert on these instead of
  screenshots. `modoki_get_editor_state` reads the whole editor UI state in one call.

**Drop into the live renderer (CDP / chrome-devtools)** — when the data isn't enough:
read React/Three state via `evaluate_script`, validate WGSL, or grab the TRUE framebuffer
with `take_screenshot`/`Page.captureScreenshot` (unlike `capture_viewport`, it doesn't
force a render, so it exposes render-on-demand / stale-frame bugs). The `chrome-devtools`
MCP is wired to THIS editor's renderer only when you enabled **Renderer debugging (CDP)**
in the AI panel.

## Rules

- **Asset references are GUIDs, never literal paths.** Any `mesh` / `material` / `texture`
  / `imageSrc` / `source` field takes a GUID from `modoki_list_assets`. (Exceptions:
  `http(s)://` / `data:` URLs, the primitive sprite keywords `circle` / `square` /
  `triangle`, and `UIElement.fontFamily`.)
- **Scenes are the source of truth.** Persist via `modoki_mutate_scene`, not imperative
  setup, for anything that should survive a reload.
- **Keep changes incremental.** One mechanic at a time; verify with
  `modoki_get_scene_state` before moving on.

## Layout

```
__GAME_NAME__/
├── game.ts                              # exports `game: GameDefinition` (entry point)
├── project.config.json                  # app id/name, default game, build settings
├── package.json                         # this project's own npm root
└── runtime/                             # your game code + assets
    ├── config.ts                        # GameConfig (points at the starting scene)
    ├── setup.ts                         # register your ECS systems here
    └── assets/                          # asset root → served at /assets/...
        ├── scenes/main.json             # the starting scene (edit via modoki_mutate_scene)
        └── models/  textures/  materials/  prefabs/   # drop assets here
```

The starting scene's URL is `/assets/scenes/main.json` — pass that as `path` to
`modoki_mutate_scene` / `modoki_validate_scene`.

Start by inspecting the current scene with `modoki_get_scene_state`, then ask the human
what game to build.
