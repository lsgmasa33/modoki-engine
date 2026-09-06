# __GAME_NAME__ — a Modoki game project

This is a **Modoki** game project. Modoki is a Claude-friendly game engine: you,
Claude, author the game — scene data, game logic (TypeScript), and asset wiring —
while the human directs and reviews. The visual editor is for the things agents are
bad at (pixel-level layout, final polish).

You were wired to this project by **AI → Connect Claude Code** in the editor, which wrote
an `.mcp.json` for it (the AI panel shows exactly where). When the desktop editor has this
project open, it exposes the tools below. **Prefer them over screenshots** — they read and
mutate the *live* running engine, so they prove your edits actually took effect.

## The engine's own source is on this machine — read it when you need to

This project depends on `@modoki/engine`, served live by the running **Modoki Editor** from
its own install — the engine's actual TypeScript source (`engine/packages/modoki/src/`) is
sitting on disk, unpacked and readable, not hidden in a compiled bundle. **Don't guess the
path** — call `modoki_identity`; its `repoRoot` field IS this path.

## Observe the running game — don't infer it from source

The files in this project (`game.ts`, `setup.ts`, the scene JSON) tell you what the game is
*designed* to do. They do **NOT** tell you what it's *actually doing right now* — where an
entity is this frame, which scene is loaded, what the human just changed, whether an event
fired. Any claim about live state that you got by **reading files is a guess.**

Before you answer "did it work / what's happening / why does it look wrong," ask yourself:
*am I inferring this, or did I observe it?* If inferring → call a tool
(`modoki_get_scene_state` / `modoki_journal` / `modoki_editor_journal`) and **cite what it
returned.** "Did you check?" should never be a question the human has to ask you.

## The verification loop (do this every time)

1. **Read** the live world with `modoki_get_scene_state` before changing anything.
2. **Mutate** with `modoki_mutate_scene` (or `modoki_set_transform` / entity ops).
3. **Verify the data** with `modoki_get_scene_state` again — exact, cheap,
   deterministic. *This is your primary check* (use a tolerance for floats, not `===`).
4. **Verify pixels** with `modoki_render_scene` / `modoki_capture_viewport` only when you
   genuinely need to see the render (catches "numbers right, renders black/NaN").

## Tools

Modoki names its two tool families:
- **Percept** — verify by data, not vibes: `modoki_get_scene_state`, `modoki_journal`
  (tick-stamped game events), `modoki_diagnose` (NaN transforms, broken refs, orphaned
  entities in one call), `modoki_watch` (a live time-series on chosen entities/traits).
- **Enact** — trusted input, like a human tester: `modoki_play_control` (play/stop/pause/
  step), `modoki_tap`/`drag`/`hover`/`scroll`/`press_key`/`type_text` aimed by CSS
  `selector` or `x,y`.

When the data isn't enough, the `chrome-devtools` MCP (**CDP**) reads live React/Three state or
grabs the true framebuffer — wired to this editor's renderer only when you enabled **Renderer
debugging (CDP)** in the AI panel. The full tool catalog, conventions, and engine concepts:
**https://modoki-engine.com**.

## Rules

- **Asset references are GUIDs, never literal paths.** Any `mesh` / `material` / `texture`
  / `imageSrc` / `source` field takes a GUID from `modoki_list_assets`. (Exceptions:
  `http(s)://` / `data:` URLs, the primitive sprite keywords `circle` / `square` / `triangle`
  (plus `collider`). `UIElement.fontFamily` is a font GUID too since #231 —
  a CSS family name goes in `UIElement.systemFont`.)
- **Scenes are the source of truth.** Persist via `modoki_mutate_scene`, not imperative
  setup, for anything that should survive a reload.
- **Keep changes incremental.** One mechanic at a time; verify with
  `modoki_get_scene_state` before moving on.

## Layout

`game.ts` is the entry point (exports `game: GameDefinition`); the starting scene is
`runtime/assets/scenes/main.scene.json` (`/assets/scenes/main.scene.json` as the `path` for
`modoki_mutate_scene` / `modoki_validate_scene`).

Start by inspecting the current scene with `modoki_get_scene_state`, then ask the human
what game to build.
