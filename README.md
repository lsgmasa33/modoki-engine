# Modoki Engine

[![Website](https://img.shields.io/badge/website-modoki--engine.com-2b6cb0.svg)](https://modoki-engine.com)
[![CI](https://github.com/lsgmasa33/modoki-engine/actions/workflows/ci.yml/badge.svg)](https://github.com/lsgmasa33/modoki-engine/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/lsgmasa33/modoki-engine?sort=semver)](https://github.com/lsgmasa33/modoki-engine/releases/latest)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)

**[modoki-engine.com](https://modoki-engine.com)** · [Documentation](https://modoki-engine.com/docs)

![Modoki editor](https://modoki-engine.com/screenshots/editor-hero.jpg)

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

## Demos

Playable, open-source showcases built with the engine — click a screenshot to play, or open the
repo to see the scene/prefab data behind it.

| | | |
|---|---|---|
| [![3D Physics Demo](https://modoki-engine.com/screenshots/demo-3d-physics.jpg)](https://modoki-engine.com/3d-physics-demo/)<br>**[3D Physics Demo](https://modoki-engine.com/3d-physics-demo/)** — [source](https://github.com/lsgmasa33/modoki-3d-physics-demo) | [![2D Physics Demo](https://modoki-engine.com/screenshots/demo-2d-physics.jpg)](https://modoki-engine.com/2d-physics-demo/)<br>**[2D Physics Demo](https://modoki-engine.com/2d-physics-demo/)** — [source](https://github.com/lsgmasa33/modoki-2d-physics-demo) | [![Forest Camp](https://modoki-engine.com/screenshots/demo-forest-camp.jpg)](https://modoki-engine.com/forest-camp/)<br>**[Forest Camp](https://modoki-engine.com/forest-camp/)** — [source](https://github.com/lsgmasa33/modoki-forest-camp) |

## Status

This repository is a **public, Apache-2.0 snapshot** of the Modoki engine + editor, published
from a private development repository. Releases (the signed desktop editor) are cut here. This
snapshot ships the engine and editor only — not the demo games from the private repo.

## Quick start

Prefer not to build from source? Grab the signed desktop editor from
**[Releases](https://github.com/lsgmasa33/modoki-engine/releases/latest)** (macOS `.dmg` /
Windows `.exe`) — it bundles its own Node (via Electron) plus `toktx`/`msdf-atlas-gen`, and can
provision JDK/Android SDK for you from **Build → Build Support…**, so none of the below is
needed. The Requirements section is for running this repo from source.

### Requirements

- **Node.js 22+** and npm — required to run the editor and build games from this source checkout.
- **[KTX-Software](https://github.com/KhronosGroup/KTX-Software/releases) (`toktx`)** — encodes
  textures to KTX2. Without it on `PATH`, imports silently fall back to shipping source
  PNG/JPG (bigger builds, no compression) instead of failing, so install it up front.
  - macOS: **not on Homebrew** — install the `.pkg` from the GitHub releases page.
  - Windows: `winget install KhronosGroup.KTX-Software`.
  - Linux: download the release tarball and put `toktx` on `PATH`.
- **[msdf-atlas-gen](https://github.com/Chlumsky/msdf-atlas-gen/releases)** — bakes MTSDF font
  atlases for the text/UI system. Download the prebuilt binary for your platform and put it on
  `PATH` (or point `MODOKI_MSDF_ATLAS_GEN` at it directly).
- **JDK 21 + Android SDK** — only needed to build the Android target. The **editor can provision
  both for you**: open **Build → Build Support…** and click Install (downloads a pinned Temurin
  21 + the `cmdline-tools`/platform/build-tools the games need, no manual `JAVA_HOME`/
  `ANDROID_HOME` setup). To install by hand instead, see
  [docs/build.md](https://modoki-engine.com/docs) — Android needs `JAVA_HOME` pointed at a JDK
  21 specifically (Gradle rejects newer bytecode).
- **Xcode** — only needed to build the iOS target (macOS only). Install from the App Store, then
  `xcode-select --install` and accept the license once.
- If a tool is missing, `toktx`/`msdf-atlas-gen` can also be pointed at explicitly via the
  `MODOKI_TOKTX` / `MODOKI_MSDF_ATLAS_GEN` env vars — useful if you don't want them on `PATH`.

### Windows: use a Dev Drive

`npm install` and Vite's dev-server file watching are **several times slower on a regular NTFS
volume** than on macOS/Linux, largely from Windows Defender scanning every file write and
`CreateProcess` overhead on `fork()`-heavy tooling. Cloning into a **[Dev
Drive](https://learn.microsoft.com/en-us/windows/dev-drive/)** (a ReFS volume with Defender
exclusions, Windows 11 22H2+) closes most of that gap:

1. Settings → System → Storage → Advanced storage settings → Disks & volumes → **Create dev
   drive** (a VHD-backed dev drive works fine if you don't have a spare partition).
2. Clone and work from the dev drive, e.g. `D:\Projects\modoki-engine`, not `C:\Users\<you>\...`.
3. **Move the npm cache onto the dev drive too** — by default it lives under
   `%AppData%`/`%LocalAppData%` on `C:`, so every install still round-trips through the slow,
   Defender-scanned volume even with the repo itself on `D:`:
   ```
   mkdir D:\npm-cache
   npm config set cache "D:\npm-cache" --global
   ```
4. Continue with `npm install` / `npm run dev` as below from that path.

### Get running

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
