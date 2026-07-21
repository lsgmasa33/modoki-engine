# Modoki Engine

[![Website](https://img.shields.io/badge/website-modoki--engine.com-2b6cb0.svg)](https://modoki-engine.com)
[![CI](https://github.com/lsgmasa33/modoki-engine/actions/workflows/ci.yml/badge.svg)](https://github.com/lsgmasa33/modoki-engine/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/lsgmasa33/modoki-engine?sort=semver)](https://github.com/lsgmasa33/modoki-engine/releases/latest)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)

**[modoki-engine.com](https://modoki-engine.com)** · [Documentation](https://modoki-engine.com/docs)

**Modoki** is a Claude-friendly ECS game engine and visual editor. You author games —
scene data, gameplay logic (TypeScript), and asset wiring — with an AI collaborator, while
a visual editor handles the things AI is bad at (pixel-level layout, final polish). It ships
as a desktop editor (Electron) and builds each game to web and native iOS/Android via Capacitor.

- **ECS core** — a [koota](https://github.com/pmndrs/koota) world with a priority-ordered
  system pipeline, projections, managers, and a deterministic, headlessly-verifiable frame driver.
- **Rendering** — Three.js (WebGPU/WebGL, 3D + NPR outline post-FX) and PixiJS (2D), driven by a
  single `Renderable.layer`, plus an ECS-driven DOM UI layer.
- **Gameplay systems** — Rapier 2D/3D physics, zones, a timeline/sequencer, keyframe + skeletal +
  2D flipbook animation, particles (CPU/GPU), Web Audio, input, and persistence.
- **Editor** — a dockable visual editor with SceneView/GameView, gizmos, undo/redo, and dedicated
  asset editors (animation, particles, sprites, skinning).
- **Agent-native** — the engine is built so an AI agent can read the live world *by data* and
  drive trusted input, and verify game logic headlessly and deterministically (no renderer, no
  wall-clock).

## Status

This repository is a **public, Apache-2.0 snapshot** of the Modoki engine + editor, published
from a private development repository. Releases (the signed desktop editor) are cut here. This
snapshot ships the engine and editor only — not the demo games from the private repo.

## Quick start

Requirements: Node.js 22+, npm.

```bash
git clone https://github.com/lsgmasa33/modoki-engine.git
cd modoki-engine
npm install            # installs + builds workspace plugins (postinstall)
npm run dev            # Vite dev server; the editor opens your last / a new project
```

- **Editor:** http://localhost:5173/#/editor
- **New project:** File → New Project scaffolds a runnable hello-world from the built-in starter
  template (`engine/templates/starter`).
- **Build a game to web:** `MODOKI_PROJECT=path/to/project npm run build`
- **Native iOS/Android** builds run from a project directory via the editor's Build menu.

Full documentation: **https://modoki-engine.com/docs**

## Contributing

Contributions are welcome — please read [CONTRIBUTING.md](./CONTRIBUTING.md) first. All
contributors must agree to the [Contributor License Agreement](./CLA.md) before a pull request
can be merged.

## License

Apache License 2.0 — see [LICENSE](./LICENSE). Third-party dependencies are listed in
[THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md). "Modoki" and the Modoki logo are trademarks
of the project owner and are not licensed under Apache-2.0 (see LICENSE §6).
