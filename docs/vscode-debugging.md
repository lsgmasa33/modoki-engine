# Debugging the Electron Editor with VS Code

VS Code can set real breakpoints — step, inspect variables, watch expressions — in
both halves of the Electron editor. Electron is just Node (the **main** process) plus
Chromium (the **renderer**), and VS Code debugs each over a different transport.

| Process  | What it is                                                        | Runs        | Debug transport            |
|----------|-------------------------------------------------------------------|-------------|----------------------------|
| **Main** | Node — window mgmt, backend server, IPC, autoUpdate, native dialogs | `engine/electron/dist/main.cjs` (esbuild-bundled from `main.ts`) | `--inspect` (Node)         |
| **Renderer** | Chromium — the React / Pixi / Three editor UI                 | loads `http://127.0.0.1:5173/#/editor` | `--remote-debugging-port` (CDP) |

**Breakpoints go in the `.ts` / `.tsx` source, not the compiled output** — both
processes ship source maps:

- **Main** — `engine/scripts/build-electron.mjs` runs esbuild with `sourcemap: true`,
  emitting `engine/electron/dist/main.cjs.map` next to `main.cjs`. That map lets VS Code
  translate a breakpoint in `main.ts` (and any bundled TS under `engine/plugins/` or
  `engine/packages/modoki/src/`) back to the running `main.cjs`.
- **Renderer** — Vite serves per-module source maps in dev, so breakpoints in the
  React/editor sources Just Work once the Chrome-attach config connects.

## Setup

Create `.vscode/launch.json` at the repo root:

```jsonc
{
  "version": "0.2.0",
  "configurations": [
    {
      // MAIN process — breakpoints in main.ts / backendServer.ts / autoUpdate.ts, etc.
      "name": "Electron: Main",
      "type": "node",
      "request": "launch",
      "cwd": "${workspaceFolder}",
      "runtimeExecutable": "${workspaceFolder}/node_modules/.bin/electron",
      "runtimeArgs": [
        "--remote-debugging-port=9223",           // also opens the renderer's CDP port
        "${workspaceFolder}/engine/electron/dist/main.cjs"
      ],
      "env": { "MODOKI_DEV_URL": "http://127.0.0.1:5173" },
      "outFiles": ["${workspaceFolder}/engine/electron/dist/**/*.cjs"],
      "sourceMaps": true,
      "console": "integratedTerminal"
    },
    {
      // RENDERER — breakpoints in the React/editor TS. Attaches to the CDP port above.
      "name": "Electron: Renderer (attach)",
      "type": "chrome",
      "request": "attach",
      "port": 9223,
      "webRoot": "${workspaceFolder}",
      "timeout": 30000
    }
  ],
  "compounds": [
    {
      "name": "Electron: Main + Renderer",
      "configurations": ["Electron: Main", "Electron: Renderer (attach)"]
    }
  ]
}
```

## Workflow

1. **Start Vite** (the renderer needs a server to load):
   ```bash
   npm run dev
   ```
   It serves on `5173` by default. If it auto-picks a different port, pin it via
   `MODOKI_DEV_URL` in the launch config above.

2. **Build the main bundle once** (and after any `main.ts` edit):
   ```bash
   npm run electron:build
   ```
   VS Code launches `main.cjs`, not `main.ts`, so it must be compiled first — the
   source map maps your breakpoints back to the `.ts`.

3. In the **Run and Debug** panel, pick **"Electron: Main + Renderer"** and hit **F5**.
   Electron launches with `--remote-debugging-port=9223`; the Chrome-attach config
   hooks the renderer over the same port. Open `main.ts`, click the gutter, and it
   pauses there.

## Gotchas

- **Don't use `launch-editor.sh` for debugging.** That script rebuilds and
  `nohup`-spawns Electron detached (for the MCP flow) — VS Code needs to *own* the
  process to attach. Run Vite manually and let F5 launch Electron.

- **The main-process map is build-time, not live.** If you edit `main.ts` without
  rebuilding, breakpoints drift to the wrong line (the map still describes the old
  code). Either re-run `npm run electron:build` before each F5, or keep a rebuild
  watcher running:
  ```bash
  node engine/scripts/build-electron.mjs --watch   # rebuilds main.cjs + .map on every edit
  ```
  The renderer needs none of this — Vite HMR keeps its maps fresh live.

## Alternative: CDP without VS Code

For breakpoint-free inspection you don't need VS Code at all — launch Electron with
`--remote-debugging-port` and point the `chrome-devtools` MCP (or any CDP client) at
the window; `--inspect` debugs the main process. But for set-a-breakpoint-and-step
debugging, the VS Code compound above is the nicer loop.
