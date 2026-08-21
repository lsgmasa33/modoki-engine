# Repo structure

The full annotated repo tree. `CLAUDE.md` keeps a compact version; this doc keeps every inline
comment for when the shape of a directory (not just its name) matters.

NOTE: almost everything lives under `engine/` (the reorg that turned the repo into a standalone
engine). Only `docs/`, `games/`, and a few root resource dirs sit at the top.

```
modoki/                          # Git root (this clone: the integration hub on main). npm package: "modoki-app"
├── README.md · docs/            # High-level overview + detailed per-feature engine docs
├── engine/                      # The Modoki engine, editor, build pipeline, and desktop app
│   ├── app/                     # Editor + game-runtime app shell
│   │   │                        #   main.tsx, App.tsx, projectGames.ts
│   │   ├── ecs/                 #   App-level ECS (pipeline, trait registration, loaders)
│   │   ├── editor/ · ui/        #   Editor setup + editor UI
│   │   └── debug/               #   Debug bridge (native TCP on device, WebSocket on web)
│   ├── packages/                # Workspace packages (root `workspaces` = engine/packages/*)
│   │   ├── modoki/              #   @modoki/engine — ECS engine + visual editor
│   │   │   └── src/
│   │   │       ├── runtime/     #     core/ traits/ + per-feature subsystems + loaders/scene/managers
│   │   │       │                #     (layered L0-L3, see docs/architecture-layers.md; ships in production)
│   │   │       ├── editor/      #     panels/ scene/ store/ (dev-only, not shipped)
│   │   │       └── three/       #     Three.js integration (Light, Environment traits)
│   │   ├── capacitor-game-debug/#   Native debug bridge (TCP server + Modoki lease handshake)
│   │   └── capacitor-litert-lm/ #   On-device LLM plugin (LiteRT) — used by llm-test
│   ├── electron/                # Desktop editor app (electron-builder + autoUpdate self-update)
│   ├── plugins/                 # Vite/build plugins (asset scanner, texture convert, vendor,
│   │                            #   heal native config, add native target, reimport registry, …)
│   ├── scripts/                 # launch-editor.sh, stop-dev.sh, build-web.mjs, bootstrap-game-deps.mjs
│   ├── tests/                   # Vitest: framework/ game/ editor/ ecs/ plugins/ ui/ electron/ assets/ e2e/
│   └── tools/                   # MCP servers: game-debug-mcp, modoki-mcp
├── games/                       # Flat game projects — ONE PROJECT = ONE GAME (#29).
│   │                            # Each is fully self-contained: game.ts (exports a single
│   │                            # `game: GameDefinition`) + project.config.json (identity/build/
│   │                            # postprocessors) + runtime/ + assets + its OWN ios/ android/
│   │                            # capacitor.config.json + packages/ (per-game native plugins, e.g.
│   │                            # capacitor-applovin-max / capacitor-adjust). Opened standalone via
│   │                            # the editor's Open Project or MODOKI_PROJECT=games/<id>. No registry/hub.
│   ├── 3d-test/                 # Tropical Island (com.modokiengine.tropicalisland) — has iOS+Android native
│   ├── alien-animal/            # skeletal-animation showcase (com.modokiengine.alienanimal)
│   ├── sling/                   # 3D physics gameplay (Rapier3D) — the single-source-of-truth worked example
│   ├── audio-demo/              # declarative audio · particle/ · text_demo/ · skin-test/
│   ├── space-console/           # planet scene + camera manager
│   └── chess/ · llm-test/       # other flat projects
├── demos/                       # SAME project format as games/ — the CURATED, PUBLISHABLE set.
│   │                            # A project lives here iff we intend to publish it: owned/CC0
│   │                            # assets, web-only SNAPSHOT, public README + ATTRIBUTION.md. IS
│   │                            # the curation. Published to its own public repo by snapshot
│   │                            # (never a submodule). See docs/plans/public-demos-plan.md.
│   ├── 3d-physics-demo/         # Rapier3D showcase — demo #1
│   └── 2d-physics-demo/         # Rapier2D showcase — demo #2 (one of 3 demos keeping ios/+android/)
├── build/                       # electron-builder resources (icons, entitlements) — tracked
└── server/ · layouts/ · site/ · tools-scratch/
                                 # static-backend (CDN) notes; saved editor layouts; docs site; scratch
```

The scaffolder template is `engine/templates/starter` — there is NO `games/starter`.

NOTE (#29 teardown): there is NO shared repo-root `ios/`/`android/`/`capacitor.config.*` anymore
— the repo root is not a buildable *game* (it's the engine + Electron editor). Each `games/<id>`
is a fully self-contained Capacitor app with its OWN native folders + config. A bare
`npm run build` (no `MODOKI_PROJECT`) fails fast by design.

See [projects.md](./projects.md) for the full per-project roster (both `games/` and `demos/`,
including every test fixture) and [clones-and-ports.md](./clones-and-ports.md) for how the
multi-clone setup uses this tree.
