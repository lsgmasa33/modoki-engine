# Modoki engine docs

The categorized index of every engine doc. `README.md` (repo root) is the high-level overview;
`CLAUDE.md` (repo root) is the authoritative source for build commands, conventions, and known
issues. Start with **[engine-concepts.md](./engine-concepts.md)** for the core vocabulary.

**[doc-conventions.md](./doc-conventions.md)** defines how these docs are organized and kept in
sync with the code — read it before adding, moving, or retiring a doc. In-flight trackers live
under **[plans/](./plans/)**; point-in-time reviews in **[reviews/](./reviews/)**.

## Concepts & Architecture

| Doc | What it is |
|---|---|
| [engine-concepts.md](./engine-concepts.md) | The core ECS vocabulary — entity, trait, system, projection, manager, store, service — and when to reach for each |
| [architecture.md](./architecture.md) | Core engine architecture — koota world registry, traits, three render layers, frame driver, Zustand bridge, game decoupling |
| [managers-and-systems.md](./managers-and-systems.md) | The engine's five logic roles — System, Manager, Projection, Store, Trait — and the first-class Manager primitive |

## Rendering & Assets

| Doc | What it is |
|---|---|
| [rendering.md](./rendering.md) | The three rendering layers (3d/2d/ui), the WebGPU renderer, and the NPR outline post-process pipeline |
| [textures.md](./textures.md) | Per-texture import — `.meta.json` settings, KTX2/WebP conversion, content cache, GPU-aware runtime variant resolution |
| [model-pipeline.md](./model-pipeline.md) | GLB model import — postprocessor fixups, two-stage LOD baking, caching, runtime `THREE.LOD` |
| [scene-loading.md](./scene-loading.md) | Scene loading — two-world staging swap, refcounted resource cache, manifest/migrations, `SceneManager`, persistent entities |
| [prefabs.md](./prefabs.md) | The prefab system — `.prefab.json`, `PrefabInstance` trait, override capture, edit mode, nested (v2) prefabs |
| [prefab-structural-overrides.md](./prefab-structural-overrides.md) | How prefab instances add/remove child entities and traits, round-trip on save, and push back via Apply-to-Prefab |
| [animation.md](./animation.md) | Animation runtime — keyframe clips (`.anim.json`), 3D skeletal + mixer, hand-posable bones, `SkinnedMeshRenderer`, animsets, 2D flipbook |
| [2d-skinning.md](./2d-skinning.md) | 2D sprite skinning — `Bone2D` rigs, `.rig2d.json` meshes, CPU LBS deform, 2.5D billboard/flat rendering, auto-rig |
| [particles.md](./particles.md) | Particle runtime — `.particle.json` schema, CPU/TSL + GPU-compute Three.js backends, PixiJS 2D backend, shared sim math |

## Gameplay Systems

| Doc | What it is |
|---|---|
| [physics-2d.md](./physics-2d.md) | Rapier physics (2D **and** 3D) — traits, reconciler systems, coordinate conversion, collision layers, joints, character controllers, scene queries |
| [zones.md](./zones.md) | Zone triggers — physics-free `Zone2D`/`Zone3D` enter/exit volumes over `ZoneOccupant` containment; journal + event bus + declarative `OnZone` action |
| [timeline.md](./timeline.md) | Timeline / cutscene sequencer — reusable `.timeline.json` asset + `Director` trait; animation/signal/audio/activation tracks; deterministic sim-delta playhead; journal + event bus + declarative `OnSequence` |
| [audio-plan.md](./audio-plan.md) | The engine-native Web Audio subsystem — `AudioSource`/`AudioListener` traits, cue bus, converter, declarative `audio.*` actions |
| [input.md](./input.md) | The input system — `Input` trait + action vocabulary, keyboard/gamepad/pointer(tap+drag) sources, `inputSystem` frame bridge, character-controller bridges, device prompts |
| [ui-system.md](./ui-system.md) | The ECS-driven UI system — `UIElement`/binding/action/anchor traits, the DOM `UIRenderer`, focus nav, text animation, nine-slice, per-game custom React UI |
| [player-prefs.md](./player-prefs.md) | Runtime persistence — the Unity-`PlayerPrefs`-style atomic per-key JSON store (localStorage / `@capacitor/preferences`), flush-on-background, per-game namespace |
| [verification-harness.md](./verification-harness.md) | The deterministic headless logic-verification harness — injectable clock, `timeScale`, seeded RNG, event journal (Phase 4 scene-file loading open) |

## Editor & Authoring

| Doc | What it is |
|---|---|
| [editor.md](./editor.md) | The Unity-like Electron visual editor — shell, panels, SceneView modes, GameView, ECS-as-truth, undo/redo |
| [debug-menu.md](./debug-menu.md) | The extensible in-game debug menu (F12 / 3-finger tap) — built-in tabs, floating stat widgets, registration API |
| [asset-inspector-plan.md](./asset-inspector-plan.md) | The asset-Inspector overhaul — previews, editor-launch buttons, converter params, HDR conversion (mostly landed) |

## Agent / MCP Tooling

| Doc | What it is |
|---|---|
| [debug-tools-mcp.md](./debug-tools-mcp.md) | The agent-facing debug surface — `game-debug`/`modoki`/Chrome MCPs, the tool catalog, dev-server `curl` API, Electron CDP |
| [percept-plan.md](./percept-plan.md) | Percept, the agent-perception layer (Snapshot/Journal/Watch over game and editor) — design, rollout, v2 backlog |
| [enact.md](./enact.md) | Enact — the trusted-input layer making editor chrome agent-addressable via `data-ui-id` handles, selector input, identity checks |
| [mcp-response-budget.md](./mcp-response-budget.md) | The MCP response-budget reference — compact JSON, summary-first defaults, boundary summarization, token-not-char accounting |
| [connect-claude-code.md](./connect-claude-code.md) | Design + rationale for the shipped **AI → Connect Claude Code** flow — the dockable AI panel that one-click wires the user's own Claude Code to the running editor's `modoki` MCP **and** CDP (chrome-devtools) in the DMG/exe, plus the MCP tool-quality re-audit decisions (§15) |
| [vscode-debugging.md](./vscode-debugging.md) | Setting VS Code breakpoints in the Electron editor's main (Node) and renderer (Chromium) processes |

## Native & Build

| Doc | What it is |
|---|---|
| [build.md](./build.md) | Build & deploy — `MODOKI_PROJECT` steering, per-game Capacitor native, the `/api/build` pipeline + auto-scaffold, iOS/Android CLI recipes |
| [editor-toolchain.md](./editor-toolchain.md) | Toolchain resolution & provisioning — `engine/toolchain/` detection (version-strict JDK), on-demand install of pinned Node/JDK/Android SDK/gltf tools, guided Xcode/CocoaPods, the `/api/toolchain` surface + Build Support dialog |
| [bundle-new-tools.md](./bundle-new-tools.md) | Playbook — bundle a new external CLI tool into the editor for BOTH platforms: the `beforePack` stager's per-platform branches (mac relocate / win32 copy of the installed tool) + the `release-windows.yml` CI download; the bundle-vs-provision decision + step checklist |
| [native-and-sdks.md](./native-and-sdks.md) | Capacitor native integration — standalone SPM plugin pattern, SDK plugins, AppLovin mediation, debug bridge, per-game signing, app-service registry |
| [playable-export.md](./playable-export.md) | The `VITE_PLAYABLE` single-file "playable ad" build — asset profile + single-chunk inliner (gzip/base64 + fflate fallback → `__PLAYABLE_ASSETS__` blob map), MRAID gate + CTA overlay, buffer-audio, the hard-won gotchas, and `npm run smoke:playable` |
| [electron-signing-optimization.md](./plans/electron-signing-optimization.md) | Proposal to cut Electron-editor codesign time by shipping Vite's dep cache inside one asar |

## Plans & Trackers (active)

| Doc | What it is |
|---|---|
| [editor-shipping-plan.md](./plans/editor-shipping-plan.md) | Ship the editor as a consumer DMG/Windows installer — keep bundled Vite, end users build iOS+Android via a Unity-Hub-style Build Support dialog, dev/prod toolchain parity, phased roadmap |
| [editor-toolchain-layer-plan.md](./plans/editor-toolchain-layer-plan.md) | Tracker — the `engine/toolchain/` resolution layer (Phases A–E LANDED; the shipped reference is [editor-toolchain.md](../editor-toolchain.md)). Remaining: Windows port + clean-machine DMG native-build validation |
| [2d-particles-plan.md](./plans/2d-particles-plan.md) | Phased plan for a PixiJS 2D particle backend sharing the 3D particle schema and editor |
| [debug-menu-plan.md](./debug-menu-plan.md) | Design/tracker for the runtime-only in-game debug menu (all phases complete) |
| [cloud-teardown-and-migration-plan.md](./plans/cloud-teardown-and-migration-plan.md) | Plan to cancel the cloud editor, salvage its good commits to `main`, and tear down GCP |
| [modoki-package-manager.md](./modoki-package-manager.md) | Proposal for a Unity-UPM-style editor package manager to unbundle game deps and shrink the signed app |
| [custom-editor-windows-inspectors-plan.md](./plans/custom-editor-windows-inspectors-plan.md) | Plan to let games register custom editor windows, inspector/asset-view overrides, and field widgets (Tier 2 not yet built) |
| [animation-window-review-plan.md](./plans/animation-window-review-plan.md) | Animation Window review-findings remediation tracker — correctness, perf, refactor, test gaps (nearly all done) |
| [sling-field-editor-plan.md](./plans/sling-field-editor-plan.md) | Grid-painted arena editor for sling — paint floor, autotile the existing kit into walls/corners/colliders, regenerate a scene `Field` group |
| [sling-slopes-ramps-plan.md](./plans/sling-slopes-ramps-plan.md) | Phase 2/7.2 plan (not started) — ramps let the puck jump off a slope lip to clear a hole or land on a platform, building on the fake-Y model + height layers |
| [sling-enemy-nav-plan.md](./plans/sling-enemy-nav-plan.md) | Overarching plan — game-level enemy navigation, 3 decoupled layers (walkability → movement → crowd) ALL LANDED + live-verified; flow-field routing, directional ramps, tight-gap threading, no overlap. Remaining: warps/ziplines + continuous-mover mode. Decision record for no-engine-subsystem / no-nav-lib |
| [sling-enemy-nav-layer1-plan.md](./plans/sling-enemy-nav-layer1-plan.md) | Layer 1 detail (LANDED) — `walkable` (standing) + `canStep` (directional traversal, body clearance) + `buildNavField`/`flowAt` (Dijkstra-to-goal flow field, steer-to-centre) over the field level; 32 unit tests |
| [preview-mode-refactor.md](./plans/preview-mode-refactor.md) | Plan to unify the fragmented "in an editor preview?" signals into one `RunMode` + a serialization-transience rule so no preview/scrub mutation reaches disk |
| [timeline-v2-tracks.md](./plans/timeline-v2-tracks.md) | Three Timeline follow-ups — camera-as-Animation-track, clip crossfade, and a Control track — each a separate tested phase atop the shipped sequencer |
| [todo.md](./todo.md) | Open task checklist — editor, rendering/materials (`MaterialModifier`, custom shader lighting, HDR import settings), native/build |

## Background & Evaluations

| Doc | What it is |
|---|---|
| [unity-vs-react-pixijs.md](./unity-vs-react-pixijs.md) | Point-in-time evaluation comparing Unity against a React + PixiJS/Three.js web stack for 2D puzzle games |
| [reviews/](./reviews/) | Dated point-in-time architecture/code reviews — incl. [2026-07-02 Rapier2D subsystem review](./reviews/2026-07-02-physics-2d-subsystem-review.md) (22 findings, all resolved) and [2026-06-15 architecture review](./reviews/2026-06-15-architecture-review.md) |
