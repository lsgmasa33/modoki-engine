# __GAME_NAME__

A game project built with **Modoki** + Claude Code.

1. Open this folder in the Modoki editor (**File → Open Project**). It was created
   by **File → New Project**, which copied the starter template here.
2. Fill in identity/build info under **Project Settings** (bundle id, app name, and
   — for device builds — Apple Team ID, device ids, and CDN buckets).
3. Let Claude Code author the game through the Modoki MCP tools. See **CLAUDE.md**
   for the workflow.

## Layout

This is the flat one-project-per-game layout: `game.ts` is the entry point,
`runtime/assets/` holds your scenes/assets (served at `/assets/...`). No native
folders yet — add them with the editor's **Build → Add Native Target** (iOS /
Android) when you're ready to build for a device.
