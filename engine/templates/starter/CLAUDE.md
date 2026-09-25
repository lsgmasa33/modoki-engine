# __GAME_NAME__ — a Modoki game project

This is a **Modoki** game project. Modoki is a Claude-friendly game engine: you,
Claude, author the game — scene data, game logic (TypeScript), and asset wiring —
while the human directs and reviews. The visual editor is for the things agents are
bad at (pixel-level layout, final polish).

You were wired to this project by **AI → Connect Claude Code** in the editor, which wrote
an `.mcp.json` for it. When the desktop editor has this project open, it exposes the
`modoki_*` tools. **Prefer them over screenshots** — they read and mutate the *live* engine,
so they prove your edits took effect.

## The engine's own source is on this machine — read it when you need to

`@modoki/engine` is served by the running **Modoki Editor** from its own install, as readable
TypeScript at `<repoRoot>/engine/packages/modoki/src/`. **Don't guess `repoRoot`** — call
`modoki_identity`, which reports it.

## Observe the running game — don't infer it from source

Project files say what the game is *designed* to do, not what it is doing *right now*. Any
claim about live state you got by **reading files is a guess.** Before answering "did it work /
why does it look wrong", call a tool (`modoki_get_scene_state` / `modoki_journal` /
`modoki_editor_journal`) and **cite what it returned.**

## The verification loop (do this every time)

1. **Read** the live world with `modoki_get_scene_state`. A bare call is a names-only index;
   narrow with `name` / `guid` / `trait`, and ask for `full` only on what you need.
2. **Stop play first** (`modoki_play_control`) — while the game runs, edits and saves are
   refused, and Stop reverts the live world anyway.
3. **Mutate** with `modoki_mutate_scene` (or `modoki_set_transform` / entity ops).
4. **Verify the data** with `modoki_get_scene_state` — your primary check (floats are
   rounded: compare with a tolerance, never `===`).
5. **Save** with `modoki_save_all`. A live edit answers `saved:false` and is lost on reload
   until you do — it is not "done" before this.
6. **Pixels** only when needed: `modoki_render_scene` forces a fresh render.
   `modoki_capture_viewport` grabs the LAST frame drawn, which can be stale.

## Tools

- **Percept** (read): `modoki_get_scene_state`, `modoki_journal` (tick-stamped game events),
  `modoki_diagnose` (NaN transforms, broken refs, orphans), `modoki_watch` (live time-series).
- **Enact** (input like a human tester): `modoki_play_control`, `modoki_tap`/`drag`/`hover`/
  `scroll`/`press_key`/`type_text`. **Aim by name**: `entity:{guid|name, surface}` for a game
  object, `selector`/`label` for editor UI. Raw `x,y` is a last resort — it can go stale.
- `modoki_batch` runs several tools in order in one call.

When the data isn't enough, the `chrome-devtools` MCP (**CDP**) reads live React/Three state —
only when **Renderer debugging (CDP)** is enabled in the AI panel. Full catalog and concepts:
**https://modoki-engine.com**.

## Rules

- **Address entities by `guid`**, never `id` — ids are reassigned on every reload.
- **Asset references are GUIDs, never literal paths.** Any `mesh` / `material` / `texture`
  / `imageSrc` / `source` / `fontFamily` field takes a GUID from `modoki_list_assets`
  (exceptions: `http(s)://` / `data:` URLs, and the sprite keywords `circle` / `square` /
  `triangle` / `collider`). A CSS font family name goes in `UIElement.systemFont`.
- **`discardUnsaved` destroys the human's unsaved work** — ask before passing it.
- **Edits seem to vanish?** Call `modoki_identity` — you may be driving another editor.
- **Scenes are the source of truth.** Anything that should survive a reload goes in the
  scene (via `modoki_mutate_scene`), not in imperative setup code.
- **Keep changes incremental.** One mechanic at a time; verify before moving on.

## Layout

`game.ts` is the entry point (exports `game: GameDefinition`); the starting scene is
`runtime/assets/scenes/main.scene.json` (`/assets/scenes/main.scene.json` as the `path` for
`modoki_mutate_scene` / `modoki_validate_scene`).

Start by inspecting the current scene with `modoki_get_scene_state`, then ask the human
what game to build.
