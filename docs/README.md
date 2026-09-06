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
| [architecture-layers.md](./architecture-layers.md) | The runtime's L0–L3 layer contract — what each layer may import, why ESM cycles make it a correctness rule, the registration-inversion pattern, and how to add a subsystem without breaking it |
| [async-lifetime.md](./async-lifetime.md) | **Normative** — post-await liveness: capture a token before the first DEFERRAL (an `await`, but equally a `.then`, a `queueMicrotask`, a `setTimeout`, a callback) and re-check it before every write that follows one. The five sanctioned tokens and when each applies, the latch rule, why an identity token can wear a number, why a check crosses a call boundary as a check and never as a counter, the `runtime/core/liveness.ts` helper for the epoch/generation pair, and the deliberate gaps |
| [format-versioning.md](./format-versioning.md) | **Normative** — one design for every versioned persisted document (scene, prefab, sidecar, manifests, OTA, saves). The three KINDS of version (format vs data-identity vs compatibility) and why conflating them picks the wrong failure behaviour; the rule that a build must never overwrite a document it cannot read; the four contracts — the VERDICT and the stamp are shared, the DISPOSITION is a bounded per-document choice (REFUSE vs PRESERVE), and only the refusal channel is local, because fusing verdict with disposition is what produced five different shapes; the decision table listing every versioned document, its disposition, whether anything reads it, and what it does on too-new; and the three ways a guard in this area steers a fix wrong |
| [repo-structure.md](./repo-structure.md) | The full annotated repo tree — every top-level and `engine/` subdirectory with its inline comments |
| [cross-game-infrastructure.md](./cross-game-infrastructure.md) | What gets shared across games and what deliberately does not — the behaviour/glue/art split, the three distribution mechanisms (`@modoki/engine` for TS, tarball vendoring for native plugins, git-URL and registry both rejected and why), the roads not taken with the condition that reopens each, and why neither an import-graph check nor a string-literal sweep can tell you a file is game-agnostic |

## Rendering & Assets

| Doc | What it is |
|---|---|
| [rendering.md](./rendering.md) | The three rendering layers (3d/2d/ui), the WebGPU renderer, lights & shadows incl. rendering-layer light masks, and the NPR outline post-process pipeline |
| [textures.md](./textures.md) | Per-texture import — `.meta.json` settings, KTX2/WebP conversion, content cache, GPU-aware runtime variant resolution |
| [fonts.md](./fonts.md) | Fonts & SDF text — every Font Inspector and `Text2D`/`Text3D` knob, which path honours it, and the interactions (`pxRange`/`size` is the budget for weight, outline, glow and shadow alike) |
| [model-pipeline.md](./model-pipeline.md) | GLB model import — postprocessor fixups, two-stage LOD baking, caching, runtime `THREE.LOD` |
| [art-tools-3daistudio.md](./art-tools-3daistudio.md) | External art generation via 3D AI Studio — the 2D Image Studio (models, inpainting, style converters, **style reference + character sheet** for set consistency), the 3D/texturing/mesh tools, the OAuth **MCP connector** Claude Code can drive, credits, and the three things to verify before relying on it |
| [scene-loading.md](./scene-loading.md) | Scene loading — two-world staging swap, refcounted resource cache, manifest/migrations, `SceneManager`, persistent entities, nestable base scenes (cross-scene persistence), entity-id stability on disk |
| [prefabs.md](./prefabs.md) | The prefab system — `.prefab.json`, `PrefabInstance` trait, override capture, edit mode, nested (v2) prefabs |
| [prefab-structural-overrides.md](./prefab-structural-overrides.md) | How prefab instances add/remove child entities and traits, round-trip on save, and push back via Apply-to-Prefab |
| [animation.md](./animation.md) | Animation runtime — keyframe clips (`.anim.json`), 3D skeletal + mixer, hand-posable bones, `SkinnedMeshRenderer`, animsets, 2D flipbook |
| [2d-skinning.md](./2d-skinning.md) | 2D sprite skinning — `Bone2D` rigs, `.rig2d.json` meshes, CPU LBS deform, 2.5D billboard/flat rendering, auto-rig |
| [particles.md](./particles.md) | Particle runtime — `.particle.json` schema, CPU/TSL + GPU-compute Three.js backends, PixiJS 2D backend, shared sim math |
| [video.md](./video.md) | Video playback — H.264/mp4 asset kind, 3D/2D/fullscreen surfaces, `timeScale` coupling, remote delivery + LRU cache, Timeline video track |

## Gameplay Systems

| Doc | What it is |
|---|---|
| [physics-2d.md](./physics-2d.md) | Rapier physics (2D **and** 3D) — traits, reconciler systems, coordinate conversion, collision layers, joints, character controllers, scene queries |
| [zones.md](./zones.md) | Zone triggers — physics-free `Zone2D`/`Zone3D` enter/exit volumes over `ZoneOccupant` containment; journal + event bus + declarative `OnZone` action |
| [timeline.md](./timeline.md) | Timeline / cutscene sequencer — reusable `.timeline.json` asset + `Director` trait; animation/signal/audio/activation tracks; deterministic sim-delta playhead; journal + event bus + declarative `OnSequence` |
| [audio-plan.md](./audio-plan.md) | The engine-native Web Audio subsystem — `AudioSource`/`AudioListener` traits, cue bus, converter, declarative `audio.*` actions, the `@audio` journal event, the `AudioSettings` sfx voice cap, and the iOS `AVAudioSession` category attempt (#548, won't-do — the plugin was removed once device testing showed it inert; see the doc) |
| [input.md](./input.md) | The input system — `Input` trait + action vocabulary, keyboard/gamepad/pointer(tap+drag)/gesture(pan+pinch+tap) sources, `inputSystem` frame bridge, character-controller bridges, device prompts |
| [ui-system.md](./ui-system.md) | The ECS-driven UI system — `UIElement`/binding/action/anchor traits, the DOM `UIRenderer`, focus nav, text animation, nine-slice, scroll views with recycled entries (`UIScrollView`/`UIEntries`), pushing live values onto scene-authored chrome (`sceneChrome`), per-game custom React UI |
| [haptics.md](./haptics.md) | Device haptics — named preset patterns (engine defaults + game-registered), `HapticSettings`, declarative `haptics.*` actions, journal event; why presets rather than a custom-waveform plugin |
| [cloud-sync.md](./cloud-sync.md) | The per-group cloud-save protocol — `SyncGroupSpec`'s declaration surface, single-key vs multi-key atomicity, the four-case decide table, the CAS re-decide loop, fork resolution and fork policies |
| [iap.md](./iap.md) | In-app purchases & subscriptions — the two invariants (grant durably THEN finish; every grant idempotent by transaction id) and the crash matrix they prove, the `StoreBackend` port, product-kind-decides-who-owns-truth, local on-device verification and what it costs, the first-party `capacitor-modoki-iap` plugin and why an off-the-shelf one cannot work, why an empty `Product.products(for:)` means incomplete product metadata rather than the account state or a missing submission (and how a device can keep answering from a deleted StoreKit catalog), Play Billing gotchas, and the on-device interruption harness that makes the force-quit test performable |
| [player-prefs.md](./player-prefs.md) | Runtime persistence — the Unity-`PlayerPrefs`-style atomic per-key JSON store (localStorage / `@capacitor/preferences`), flush-on-background, per-game namespace |
| [verification-harness.md](./verification-harness.md) | The deterministic headless logic-verification harness — injectable clock, `timeScale`, seeded RNG, event journal (Phase 4 scene-file loading open) |

## Editor & Authoring

| Doc | What it is |
|---|---|
| [editor.md](./editor.md) | The Unity-like Electron visual editor — shell, panels, SceneView modes, GameView, ECS-as-truth, undo/redo |
| [editor-input.md](./editor-input.md) | Editor keyboard input — the focus-scoped keymap registry, the five scope tiers, the `preventDefault` claim/yield contract that arbitrates with the Electron menu, and the runtime input gate |
| [editor-hmr.md](./editor-hmr.md) | Editor hot reload — what Fast Refreshes, what force-reloads (game code, the input registries), why `[]`-deps effects never re-run, and how to tell a stale editor from a working one |
| [scene-view-gizmo.md](./scene-view-gizmo.md) | The SceneView orientation gizmo + orthographic editor camera — animated 6-axis snap, independent persp↔ortho toggle, and the spiked ortho risk analysis future ortho work reuses |
| [debug-menu.md](./debug-menu.md) | The extensible in-game debug menu (F12 / 3-finger tap) — built-in tabs, floating stat widgets, registration API |

## Agent / MCP Tooling

| Doc | What it is |
|---|---|
| [debug-tools-mcp.md](./debug-tools-mcp.md) | The agent-facing debug surface — `game-debug`/`modoki`/Chrome MCPs, the tool catalog, dev-server `curl` API, Electron CDP |
| [agent-context-cost.md](./agent-context-cost.md) | The `PreToolUse` hook (`context-cost-guard.mjs`) that warns — never blocks — on a large unbounded `Read` or an unbounded verbose `Bash` call; the 2026-08-30 token audit finding, the 40 KB/2000-line threshold, the Bash rule set, and the deliberate `npm test`/`verify`/`vitest` exclusion |
| [agent-tools.md](./agent-tools.md) | **Game-registered MCP tools** — how a game puts its OWN tools on the `modoki` surface beside `modoki_*` (`registerAgentTool`), the declaration format and why params are JSON not zod, `<gameId>_` namespacing, the release-build gate, why the server POLLS for them, and what guards a surface that has no `contracts.ts` entry. Also the **guard-completeness trap** a tool that DRIVES gameplay falls into — the state function is not the whole operation, and the guards live in its callers at more than one layer |
| [mcp-tool-conventions.md](./mcp-tool-conventions.md) | **Normative** rules every agent tool obeys across all three surfaces (`modoki_*`, `device_*`, the `curl` API) — validation, one-name-one-meaning, aim, the GET/POST C7 split, the error envelope, read purity, mutation/undo/persistence, cross-surface parity, and the three-tier coverage bar. Machine-readable companion: `src/contracts.ts` |
| [mcp-persistence.md](./mcp-persistence.md) | MCP persistence is **manual-only** — a live edit reaches disk only via `save_all`. The composite undo primitive, the dirty-asset registry, why `mutate_scene`/`set_transform` still fall back to file-direct writes (headless, wrong scene, `setBaseScene`), and the gates that key off `unsavedChanges` |
| [enact.md](./enact.md) | Enact — the trusted-input layer making editor chrome agent-addressable via `data-ui-id` handles, selector input, identity checks |
| [trusted-device-input.md](./trusted-device-input.md) | `device_*` input FIDELITY (#32) — which ops are OS-level trusted per platform (Android CDP, iOS WebDriverAgent) and which stay synthetic by design, the loud fallback, WDA provisioning + lazy launch, the WDA **out-of-app screenshot** (`source:'wda'` — a system dialog / springboard the app's own capture cannot see, and why its pixels are not aimable), and the measured facts/traps (identity coordinates, HTTP-200-with-an-error, the mock-drift that shipped a dead trusted path) |
| [mcp-response-budget.md](./mcp-response-budget.md) | The MCP response-budget reference — compact JSON, summary-first defaults, boundary summarization, token-not-char accounting |
| [pairing-mode.md](./pairing-mode.md) | Pairing mode — parking on `modoki_wait_for_edit` to be woken by the human's editor activity instead of polling `editor_journal`, what the wake event does/doesn't tell you, and the gotchas (unsaved-edit reload, guid-not-id) it inherits |
| [connect-claude-code.md](./connect-claude-code.md) | Design + rationale for the shipped **AI → Connect Claude Code** flow — the dockable AI panel that one-click wires the user's own Claude Code to the running editor's `modoki` MCP **and** CDP (chrome-devtools) in the DMG/exe, plus the MCP tool-quality re-audit decisions (§15) |
| [vscode-debugging.md](./vscode-debugging.md) | Setting VS Code breakpoints in the Electron editor's main (Node) and renderer (Chromium) processes |

## Native & Build

| Doc | What it is |
|---|---|
| [build.md](./build.md) | Build & deploy — `MODOKI_PROJECT` steering, per-game Capacitor native, the `/api/build` pipeline + auto-scaffold, iOS/Android CLI recipes |
| [editor-toolchain.md](./editor-toolchain.md) | Toolchain resolution & provisioning — `engine/toolchain/` detection (version-strict JDK), on-demand install of pinned Node/JDK/Android SDK/gltf tools, guided Xcode/CocoaPods, the `/api/toolchain` surface + Build Support dialog |
| [bundle-new-tools.md](./bundle-new-tools.md) | Playbook — bundle a new external CLI tool into the editor for BOTH platforms: the `beforePack` stager's per-platform branches (mac relocate / win32 copy of the installed tool) + the `release-windows.yml` CI download; the bundle-vs-provision decision + step checklist |
| [windows.md](./windows.md) | Windows-only traps — resolve tools through `MODOKI_TOOLCHAIN_DIR`/`detect()` rather than PATH (and the PATHEXT `ENOENT` that reads as "not found"), adb CRLF breaking every logcat line, drive-letter/MSYS path shapes, why `pkill -f` silently no-ops, the bash-dependent npm scripts, test timings that do NOT transfer from a Mac, and how to tell a remotely-fixable path bug from a live-process one that needs a real Windows box |
| [verify-and-ci.md](./verify-and-ci.md) | The measured history behind `npm run verify` and CI — the worker-cap/sharding/concurrent-lanes speedups, the Windows measurement, the free public-runner mechanism (#96), and the e2e suite's serial/rot/autosave history |
| [clones-and-ports.md](./clones-and-ports.md) | The multi-clone/multi-machine setup — the clone table, sync recipes, and the full reasoning behind RULE 1 (per-clone install/build, #215) and RULE 2 (the per-clone backend port, derived from the clone directory, with Vite/CDP derived from it) |
| [native-and-sdks.md](./native-and-sdks.md) | Capacitor native integration — standalone SPM plugin pattern, SDK plugins, AppLovin mediation, debug bridge, per-game signing, app-service registry, and the engine's ungated global JS error capture (why it is a side-effect import, the console→issue/breadcrumb split, and the rate-limit ordering) |
| [ota-updates.md](./ota-updates.md) | Over-the-air updates — signed content-addressed publish format, the native client + two-boot rollback watchdog, quarantine of proven-bad versions, delta transfer (incl. from the embedded bundle), the mandatory blocking gate + progress UI, the publish pipeline (editor UI + MCP tools), and the silent-failure gotchas |
| [ota-subgame-modules.md](./ota-subgame-modules.md) | Sub-game modules — `globalThis` shared-singleton registry (not import maps), per-sub-game Vite build target, dynamic `GAMES` discovery, `ENGINE_API_VERSION` contract |
| [playable-export.md](./playable-export.md) | The `VITE_PLAYABLE` single-file "playable ad" build — asset profile + single-chunk inliner (gzip/base64 + fflate fallback → `__PLAYABLE_ASSETS__` blob map), MRAID gate + CTA overlay, buffer-audio, the hard-won gotchas, and `npm run smoke:playable` |
| [electron-signing-optimization.md](./plans/electron-signing-optimization.md) | Proposal to cut Electron-editor codesign time by shipping Vite's dep cache inside one asar |
| [api-reference.md](./api-reference.md) | The generated TypeDoc API reference — kind-subgrouped sidebar, manager interfaces documenting their methods, and an editorial "Essential" whitelist that ranks the 877-symbol surface without hiding any of it |
| [site-hosting.md](./site-hosting.md) | How modoki-engine.com is served — the Cloudflare Worker in front of the public GCS bucket, why it replaced a GCP load balancer (~$18.25/mo → ~$0.02/mo), the legacy redirects it must keep working, caching/TTL behavior, and DNS/email gotchas |

## Plans & Trackers (active)

| Doc | What it is |
|---|---|
| [ios-rendering-update-wedge.md](./plans/ios-rendering-update-wedge.md) | **#590** — `com.apple.WebKit.GPU` (a separate XPC service owning every GL context) is jetsammed at its ~300 MB per-process highwater limit, so the game never paints again while JS, timers and the Capacitor bridge stay perfectly alive — which masquerades as a main-thread lockup and defeated the first diagnosis. ⚠️ This kill writes NO crash report; only a live `idevicesyslog` capture sees it. Carries the kernel evidence, the six `frameDriver`/`activeRenderer` defects it exposed (including a stall message that defeats Crashlytics dedupe and blinds crash reporting for the rest of the session), what has been RULED OUT, and the phases: defect fixes, the native restart alert, GPU-memory accounting, and the still-open hunt for the ~306 MB no JS-side accounting can see |
| [gpu-resource-ownership-plan.md](./plans/gpu-resource-ownership-plan.md) | **#695**, DESIGN, not started — explicit ownership for procedural GPU resources. ⚠️ Argues AGAINST the ticket's original Tier 1 ("one release helper per resource kind"): `releaseGeometry` is a workaround for one PixiJS destroy-ORDER quirk, by its own doc, and its 370-line static guard explicitly fences itself against being extended. The shape that actually recurs in #590 and #739 is a DERIVED resource with no back-reference to its owner — in #739 the deriving code is three.js itself, so there is no call site of ours to route through a helper. Proposes an owner-keyed derived-resource registry, a RUNTIME release assertion instead of a sixth scanner, and records why `meshTemplateCache`'s count-based INVARIANT does not fire |
| [texture-lod-by-tier.md](./plans/texture-lod-by-tier.md) | Carries the unstarted remainder of the low-end-device-support workstream (superseded plan in git at `4fc02890`; its landed rationale — the three-layer GPU resolver, the boot ramp probe, the `cpuLimited` promotion licence — is folded into [rendering.md](./rendering.md) § "Quality tiers"). Goal 4 (texture LOD by tier, real LOD chains) has never started and is where the frame rate actually is; also tracks authoring the tiers still on their seed values and the two unmet acceptance gates |
| [profiler.md](./plans/profiler.md) | **Carries the #238 boot-stall investigation** (Phase 2, "⇥ HANDOFF") — the eight instances of the one defect, in the order they were found and retracted, the probe scripts, and the traps that have cost time. #238 itself is CLOSED; what is left lives in #322/#323/#324, and the durable RULE is [rendering.md](./rendering.md) § "Shader prewarm and the first-frame compile", not here. The Modoki Profiler — answer "where did the frame go?" for a human at a panel AND for Claude over MCP, from ONE data model, on desktop and on a phone. Marker hierarchy + engine instrumentation + aggregation (the spine), then the agent surface, the Profiler panel, frame capture, GPU timestamp queries and memory. Compared against Unity's Profiler; deliberately does NOT copy deep profiling or a multi-thread flame chart |
| [editor-shipping-plan.md](./plans/editor-shipping-plan.md) | Ship the editor as a consumer DMG/Windows installer — keep bundled Vite, end users build iOS+Android via a Unity-Hub-style Build Support dialog, dev/prod toolchain parity, phased roadmap (5 demos published, Windows NSIS installer built + tested; native-prebuild audit + code signing still open) |
| [engine-oss-publishing.md](./engine-oss-publishing.md) | Reference (graduated, private) — how the engine is published as the Apache-2.0 `modoki-engine` public mirror: curated one-way snapshots, the blocking secret/brand safety scan, Harmony CLA, signed mac/Windows release CI. Cited by `publish-engine-oss.sh`, `scan-publish-safety.mjs`, `vite.config.ts` |
| [apple-signing.md](./apple-signing.md) | Reference (private) — Apple Team ID history — the three team ids and who they belong to, the #172 private-build-fields flow, the two incidents where the wrong conclusion was drawn, and the `security find-certificate` diagnostic recipe |
| [devices.md](./devices.md) | Reference (private) — the physical device inventory — iOS/Android serials + SoC/GPU detail, the iPhone 8 synthetic-input situation, the go-ios vs `ideviceinstaller` investigation, and deploy/relaunch recipes |
| [2d-particles-plan.md](./plans/2d-particles-plan.md) | Phased plan for a PixiJS 2D particle backend sharing the 3D particle schema and editor (Phases 0-2 shipped; editor SceneView 2D preview open, blocked on a design decision) |
| [public-demos-plan.md](./plans/public-demos-plan.md) | Curated public demo projects in a new `demos/` root (CC0 assets, web-only, snapshot-published per demo) + the Windows conformance sweep over every existing project (5 demos shipped; the full sweep + per-demo doc checklist still open) |
| [modoki-package-manager.md](./modoki-package-manager.md) | Proposal for a Unity-UPM-style editor package manager to unbundle game deps and shrink the signed app |
| [custom-editor-windows-inspectors-plan.md](./plans/custom-editor-windows-inspectors-plan.md) | Plan to let games register custom editor windows, inspector/asset-view overrides, and field widgets (Tier 2 not yet built) |
| [mobile-ota-updates-plan.md](./plans/mobile-ota-updates-plan.md) | Open items only — all phases shipped (see [ota-updates.md](./ota-updates.md) / [ota-subgame-modules.md](./ota-subgame-modules.md)): two open design conversations, known-but-unfixed edge cases, the private device-test loop |
| [preview-mode-refactor.md](./plans/preview-mode-refactor.md) | Plan to unify the fragmented "in an editor preview?" signals into one `RunMode` + a serialization-transience rule so no preview/scrub mutation reaches disk |
| [entity-id-guard-game-traits-plan.md](./plans/entity-id-guard-game-traits-plan.md) | Extend Phase 15's entity-id remap guard from engine-only tests to a registration-time check covering GAME traits too (`notEntityId` hint + dev warning), and fix the one live offender — sling's `Enemy.hpBarId`; also adds a click-to-copy entity-GUID chip to the Inspector header |
| [ad-video-pipeline-plan.md](./plans/ad-video-pipeline-plan.md) | **NOT STARTED** — render ad/marketing videos with Modoki as the footage generator and DaVinci Resolve as compositor/finisher, so an ad is a re-renderable JSON timeline rather than dead pixels (native 9:16 / 1:1 / 16:9, free re-renders after art changes, speed ramps without optical flow). Carries the structural finding that capture MUST be compositor-sourced (CDP) because the WebGPU canvas reads back transparent black and the 2D layer is N pooled canvases inside UI divs — so `modoki_render_sequence` (3D forward pass only, wall-clock, 120-frame cap) is the wrong tool. Phase 0 is two unproven assumptions; targets Court + Wordweave (2D) first, then sling/3D |
| [todo.md](./todo.md) | **Not** a task list (open work is GitHub Issues) — the capability roadmap (what a mature engine has that Modoki doesn't) and the declined decisions, each with its trigger to revisit |

## Background & Evaluations

| Doc | What it is |
|---|---|
| [projects.md](./projects.md) | **Private** (excluded from the OSS snapshot) — the full per-project roster of `games/` + `demos/`, every test fixture included, with what each one is and which natives it carries. CLAUDE.md keeps the `games/`-vs-`demos/` *rule*; this is the catalog |
| [task-claiming.md](./task-claiming.md) | **Normative** — how concurrent Claude sessions across the six clones claim work without duplicating it: open work is GitHub Issues (a live query, no push/fetch delay), one `wip/*` label per clone, release-on-abandon, correcting an issue your work disproves, closing it yourself once done + verified (`Fixes #N` is the link, not the trigger), filing a defect issue with its validation outcome declared on the first line (whatever label it carries), and what stays in `todo.md` instead |
| [model-routing.md](./model-routing.md) | **Private** (excluded from the OSS snapshot — carries per-clone usage metrics) — the full detail behind CLAUDE.md § "Model routing": the Opus/Sonnet split, `sonnet-implementer`/`Explore`, the 2026-08-29 token-usage audit that turned "delegate freely" into two mechanical triggers, and the three-times flip history with the reasons behind each |
| [unity-vs-react-pixijs.md](./unity-vs-react-pixijs.md) | Point-in-time evaluation comparing Unity against a React + PixiJS/Three.js web stack for 2D puzzle games |
| [reviews/](./reviews/) | Dated point-in-time architecture/code reviews — incl. the [2026-07-30 MCP tool-quality audit](./reviews/2026-07-30-mcp-tool-audit.md) (**78 findings, all closed**; the appendices at the END are the useful part — what was measured, and several self-corrections), and the [carried-instance-overrides investigation](./reviews/a9-carried-instance-overrides-investigation.md) (resolved 2026-07-26) |
