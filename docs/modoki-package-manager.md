# Modoki Package Manager — design discussion

Status: **proposal / discussion** (not started). Captures the design for a
Unity-UPM-style package manager inside the Modoki editor, and why it is the
correct frame for three problems we hit while packaging the editor (C4c-3b "run
Vite in prod"). No code yet.

## Why this exists — it collapses three problems into one

While packaging the editor as a desktop app we found the C4c-3b "run Vite in
prod" build ships the **full dev `node_modules` unpacked** so the bundled Vite
server can read/exec real files. Result: `Modoki Editor.app` = **977 MB**,
**~19,000 loose files**, and code-signing is impractically slow — the cost is
**file count** (codesign hashes every file into the bundle seal), not native
binaries (there were only 6). The single biggest contributor is **firebase +
@firebase ≈ 7,942 files (~23% of all node_modules files)** — and the editor does
not even import it (only the mobile Capacitor plugins reference Firebase).

A package manager solves all three threads at once:

1. **Signing / size.** The editor ships only its **toolchain + platform runtime**.
   Every game dependency (firebase, physics, gif decoders, …) becomes a *package*
   installed per-project into a **writable cache**, not baked into the signed app.
   The bundled `node_modules` shrinks permanently → fast signing.
2. **Dev ≡ prod (no divergence).** The PM works **identically** in dev and packaged
   — a project genuinely owns its dependencies (you would `npm install` it to
   develop it anyway). There is no packaged-only code path, so it does **not**
   reintroduce the "works in dev, breaks in the released product" risk that the
   "run Vite in prod" decision was made to avoid. This is the key advantage over a
   CDN / import-map hack, which *would* make the packaged resolution differ from dev.
3. **Ecosystem.** UPM is not just for third-party libs; it is how Unity ships
   first-party + community **modules**. A Modoki PM could distribute engine plugins
   (the `capacitor-*` packages, editor extensions, postprocessors), game templates,
   and asset packs — a real lever for Modoki as a Unity alternative.

## UPM → Modoki mapping

You are not inventing a packaging system — you are putting a Unity-shaped UI on npm.

| Unity UPM | Modoki |
|---|---|
| `Packages/manifest.json` | project `package.json` (`dependencies`) |
| `packages-lock.json` | `package-lock.json` (integrity hashes come free) |
| Unity registry / OpenUPM / git / local path | npm registry / a Modoki scoped registry / git URL / local path |
| `Library/PackageCache` | a **writable** per-project (or shared) install cache |
| Package Manager window | a new editor panel, sibling to the Assets panel |

## Architecture — editor toolchain vs project dependencies

- **The editor ships its own toolchain + platform runtime**: Vite/Rolldown +
  esbuild, plus the shared render/runtime libs it needs to host any project —
  `three` (SceneView, 36 import sites), `pixi.js` (GameView preview, 3 sites),
  `react`, `koota` (ECS, 50 sites), `zustand`, `@modoki/engine`.
- **The project owns everything else.** An external Modoki project is a real npm
  package: its own `package.json` + `node_modules`. Opening it ensures its deps are
  installed (the editor runs the install if `node_modules` is missing). Vite (rooted
  at the project) resolves **game deps from the project's `node_modules`** and
  **shared/toolchain deps from the editor's** (deduped).
- This is why it is not divergence: the same resolution happens in dev and in the
  packaged app. The in-repo example games only blur this because they share the
  repo's root `node_modules`.

## The hard part — shared singletons (the load-bearing constraint)

Today everything resolves from one `node_modules`, and `resolve.dedupe:
['three','react','koota',…]` keeps them as single instances. The moment a *project*
has its own `node_modules` with its own `three`, you get **two `three` instances** →
broken WebGPU renderer, split koota world identity, dead React hooks. Classic and
painful.

So the PM model **requires a platform / peer split**, exactly like Unity packages
declaring a dependency on the Unity runtime instead of bundling their own engine:

- The editor defines a fixed **runtime API surface** it *provides*: `three`,
  `react`, `react-dom`, `koota`, `zustand`, `pixi.js`, `@modoki/engine`, `gsap`.
- Project packages depend on these as **peers** — they must never install their own
  copies.
- The PM only installs deps **outside** that surface (firebase, rapier, gif
  decoders, plugins). The installer must **reject or dedupe** platform deps so a
  project can't smuggle in a second `three`.

Getting this enforcement right is what makes or breaks the feature.

## Design decisions to make

- **Install mechanism.** The packaged app cannot assume the `npm` CLI exists.
  Options: bundle a programmatic installer (`pacote` fetches + extracts a single
  `name@version`; small) or ship a package manager binary. Affects offline behavior,
  speed, and lockfile fidelity.
- **Cache location.** Per-project `node_modules` (standard, simple, duplicates
  across projects) vs a pnpm-style content-addressed shared store (dedup, more
  complex) vs UPM-style global PackageCache + per-project resolution (the middle
  path). Must be a **writable** dir (not inside the signed `.app` bundle).
- **Native vs runtime deps.** The firebase *web* SDK is JS → installable and
  editor-relevant. Native Capacitor plugins only matter at *mobile build time* — the
  PM should mark those **build-only** (not fetched into the running editor).
- **Registries.** npm only, or also a Modoki scoped registry for engine plugins +
  git/local sources for development?
- **Offline / first-run UX.** Opening a project with un-cached deps needs network;
  needs a clear "installing…" state and a graceful offline failure.
- **Integrity / security.** Pin to lockfile hashes (npm gives this for free; a
  hand-rolled CDN would not). Downloaded JS is not Apple-notarized — hash-pin + HTTPS.

## Staged roadmap

This is a meaningful feature; stage it and **do not block the signing fix on it**.

1. **Now — trim by hand.** Exclude firebase / `@firebase` / `@grpc` / `protobufjs` /
   `@mediapipe` / `@dimforge` / `gifuct` from the editor bundle. Free (zero editor
   imports), no network, fixes signing today. This is literally step 1 of the PM
   principle — "the editor does not bundle game deps" — done manually. Pre-check:
   confirm a game *previewed in the editor* doesn't hit the analytics service
   expecting firebase at runtime (stub analytics to no-op in the editor if so).
2. **v0 PM — Dependencies panel.** Reads/writes the project `package.json`, installs
   via a bundled installer into a writable cache, points Vite there. **Enforce the
   platform/peer split from day one** (the load-bearing part).
3. **v1 PM — full window.** Registry browse, version/update management, a Modoki
   plugin registry, git/local sources, asset/template packs.

## Open questions

- Exact platform runtime surface (which libs are "provided" vs "installable")?
- Shared cache vs per-project — and how Vite dedupe interacts with a shared store.
- How Modoki **engine plugins** (editor extensions, postprocessors, native
  Capacitor plugins) are described as packages, and how build-only deps are flagged.
- Relationship to the **Assets** panel (Assets = content; Packages = code/plugins).
- Does this subsume the `virtual:modoki-games` / `loadProjectGames()` path, or sit
  beside it?

## Relationship to existing work

- **External projects** (the shipped engine/games split — see the flat-project
  notes in `CLAUDE.md`): the PM is the natural completion of "the editor is a tool
  you point at a project folder." It makes the editor permanently small.
- **C4c-3b packaging** (`electron-builder.yml`): the trim (step 1) directly reduces
  the unpacked file count that makes signing slow; the PM removes the need to bundle
  game deps at all.
- **Signing measurement** (this session): 977 MB / ~19k files; firebase ≈ 23% of
  files and not editor-imported.
