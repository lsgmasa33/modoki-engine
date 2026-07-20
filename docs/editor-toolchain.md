# Editor toolchain resolution & provisioning

How the packaged editor finds — and, when missing, **downloads** — the external CLI tools a
build needs, so a consumer who installed only the DMG can still build native iOS + Android apps.
This is the layer behind the **Build → Build Support…** dialog. The everyday build *commands* live
in [build.md](./build.md); this doc is the reference for *where the tools come from*.

Governing principle: **bundle nothing that can be downloaded.** Electron's own Node bootstraps the
editor; everything else is either **resolved** from the machine, **installed on demand** into a
per-user dir, or **guided** (Xcode — nobody can auto-install it). The design keeps dev == packaged:
the same resolver runs in the dev editor and the DMG, so a "works on my machine" gap is a dev-time
bug, not a post-ship surprise.

## The resolver — `engine/toolchain/`

A **relative-imported source module** (NOT a `@modoki/*` npm package): `build-electron.mjs` marks
packages `external` but bundles relative imports, so the toolchain ships inline in `main.cjs` with no
dist step, and Vite/vitest compile it as source. It reads **only env vars** (never Electron APIs), so
it runs identically in the Vite-plugin process, the Electron main backend, and headless CI/tests.

`detect(id)` / `resolve(id)` locate a tool without / with throwing. Two kinds:

- **Binary tools** (`toktx`, `msdf-atlas-gen`, `npm`, `xcodebuild`, `cocoapods`, `gltf-transform-cli`, `gltfpack`, `ffmpeg`, `ffprobe`) —
  resolved from an **env override** → **extra candidates** (a userData install location) → **PATH**,
  each validated by a `--version` probe. Results are **cached** (the probe spawn is expensive and its
  inputs are fixed at startup).
- **Directory tools** (`android-sdk`, `java`) — resolved from **env vars** → **well-known dirs**,
  validated by a `marker` sub-path (`platform-tools` for the SDK, `bin/java` for a JDK), plus an
  optional `validate(dir)` hook. **Not cached** — their inputs (`ANDROID_HOME`, `JAVA_HOME`) legitimately
  differ per project, so a stale cache would resolve the wrong one.

Related helpers: `withToolOnPath(id, env)` prepends a resolved tool's dir to a child's PATH (so a tool
that shells another by bare name — e.g. `@gltf-transform/cli` calling `toktx` — finds our copy);
`detectAdb()` derives `<sdk>/platform-tools/adb`; `preflight(target)` reports whether a build target's
required tools are present; `toolchainStatus()` assembles the whole picture for the dialog.

`resetToolchainCache()` clears the binary + java-version caches — called by every `install()` on
success and by `toolchainStatus()` (a status read is always "current truth").

### `detect('java')` is version-strict

Android/AGP needs **JDK 21 specifically** — Gradle can't read newer bytecode. So `detect('java')`
doesn't just check that `bin/java` exists; its `validate` hook runs `java -version` and requires major
`REQUIRED_JAVA_MAJOR` (21). A present-but-wrong JDK (an unversioned Homebrew `openjdk` that's 25, a
`JAVA_HOME` pointing at 17, `/usr/libexec/java_home -v 21` misreporting on some boxes) is **skipped** —
it falls through to the next candidate, or to "absent," so the dialog offers the pinned Temurin 21
instead of silently building on the wrong JDK. The per-dir version probe is cached (a JDK's version is
stable). This is the single guard against a whole class of "works on my machine" Android failures.

## Provisioning — `install(id)` / `guide(id)`

`install(id, {toolchainDir, onLog})` provisions an `INSTALLABLE` tool into the per-user toolchain dir
(`<userData>/toolchain`), streaming progress via `onLog`. `guide(id)` returns human setup steps for a
tool that must be installed by hand. The dialog shows an **Install** button for installable tools and a
**How to…** for guided ones (`canAutoInstall` distinguishes them).

| Tool | How it's provisioned | Pin |
|---|---|---|
| **Node** | `nodeProvision.ts` `ensureNode()` — downloaded from nodejs.org, **sha256**-verified, `tar`-extracted. Always used (dev opt-in via `MODOKI_PROVISION_NODE=1`; automatic when packaged), so npm never depends on a user install. | `v22.23.1` (matches CI setup-node 22) |
| **`gltf-transform-cli`**, **`gltfpack`** | `installNpmTool()` — npm-installed into a shared `<toolchainDir>/npm-tools`, exposing `.bin/<name>`. Both are npm/WASM CLIs (no native binary). | `4.4.1` / `1.2.0` |
| **`java`** | `jdkProvision.ts` `ensureJdk()` — a pinned **Temurin JDK 21** downloaded from Adoptium, **sha256**-verified, extracted. `discoverJavaHome()` is layout-robust (macOS `Contents/Home` vs plain `bin/java`). | Temurin `21.0.11+10` |
| **`android-sdk`** | `androidSdkProvision.ts` — bootstrap the pinned **cmdline-tools** zip (**sha1** from Google's `repository2-3.xml`) → run `sdkmanager` for the games' packages (`platform-tools`, `platforms;android-36`, `build-tools;36.0.0` — matching every game's `variables.gradle` compileSdk 36) with non-interactive license accept. **Ensures the pinned Temurin JDK first** (sdkmanager is a Java program — the chicken-and-egg), NEVER an arbitrary system JDK, so provisioning is reproducible. | cmdline-tools `15641748` |
| **`xcodebuild` (Xcode)** | **Guided only** — multi-GB, App-Store-gated, macOS-only. `guide('xcodebuild')` gives the App Store link + `xcode-select`/license/Apple-ID steps. | — |
| **`cocoapods`** | **Auto-installed on macOS** (`isInstallable` returns true on `darwin`, guided elsewhere) — `installCocoapods()` provisions an **isolated portable Ruby** into `<toolchainDir>/ruby` (`rubyProvision.ts`), then `gem install cocoapods` into an isolated `GEM_HOME` (`<toolchainDir>/cocoapods-gems`) — no Homebrew, no system Ruby. Native gem extensions compile against Xcode's clang (already required for iOS). `guide('cocoapods')` points at the one-click Install button. Not a `preflight('ios')` blocker — most iOS games are SPM-only and never need it. | `1.17.0` |

Each installable-into-userData tool (`java`, `android-sdk`, `gltf-transform-cli`, `gltfpack`) also has
a **userData candidate** in its registry entry keyed off `MODOKI_TOOLCHAIN_DIR`, so `detect()` finds the
just-installed copy first — before any system tool — which is how the packaged editor (with no system
toolchain) resolves them.

## The `/api/toolchain` surface & the Build Support dialog

- **`GET /api/toolchain`** (transport-agnostic backend router) → `toolchainStatus()`: every tool's
  detection + install/guide affordance, derived `adb`, and a `preflight` per target. Works in both the
  Vite-plugin process and the Electron main backend.
- **`GET /api/toolchain/install?id=<tool>`** (host-owned SSE in `vite-asset-scanner.ts`, proxied by
  `backendServer.ts` like `/api/build`) → runs `install()`, streaming the log; provisions Node first so
  npm-based installs run on it.
- **Build Support dialog** (`editor/panels/BuildSupportDialog.tsx`, opened from **Build → Build
  Support…**) groups tools into Android / iOS (macOS-gated) / Model / Text / Audio / Core boxes; a missing installable
  tool gets an **Install** button that drives the SSE stream and re-checks on completion; a guided tool
  gets an expandable **How to…**.

**Cross-process cache note:** an `install()` runs in the Vite-plugin process and resets *its* cache, but
`GET /api/toolchain` is served by the Electron main process, whose cache is separate. `toolchainStatus()`
therefore re-probes on every call, so the dialog's post-install re-check reflects the just-installed tool.

## How a build consumes the toolchain

`/api/build` (Android/iOS) does two toolchain things:

1. **Preflight gate** — `preflight(target)` fails **friendly** before any step runs when a required tool
   is missing (a `user.sdk` override in Project Settings satisfies the tool it points at), so a missing
   `xcodebuild`/`java`/`adb` surfaces as an actionable message instead of a cryptic mid-stream
   "command not found."
2. **Env** — Node is provisioned once via `buildStepEnv()` (every step's `npm`/`npx`/`node` runs on it);
   the Android gradle step exports `JAVA_HOME`/`ANDROID_HOME` **purely from the shared detection**
   (`detect('java')`/`detect('android-sdk')`, or an explicit `user.sdk` override). There is deliberately
   **no inline bash fallback** — a second, looser probe would *shadow* the version-strict detection (the
   single-source-of-truth trap). If detection is somehow unresolved (unreachable post-preflight), the step
   fails loudly pointing at the Build Support dialog.

The model-import pipeline (`model-convert.ts`, `rigged-model-optimize.ts`) resolves its CLIs the same way
via `gltfTransformInvocation()` / `gltfpackInvocation()`: prefer the resolved binary (packaged userData
install), else fall back to `npx --no-install @gltf-transform/cli` / a bare PATH `gltfpack` for a dev
checkout — byte-identical to the pre-layer calls.

## Adding a new tool

1. Add the id to `ToolId` and a descriptor to `REGISTRY` (binary or directory; give installable ones an
   `extraCandidates`/userData candidate keyed off `MODOKI_TOOLCHAIN_DIR`).
2. If auto-installable: add it to `INSTALLABLE` and an `install()` branch (reuse `installNpmTool` for an
   npm CLI, or a `*Provision.ts` module for a download+verify+extract). Pin the version + checksum.
3. If guided: add a `guide()` branch.
4. Surface it in `BuildSupportDialog`'s `GROUPS`, and in `preflight()` if it's a hard build requirement.
5. Deterministic tests mock the network (see `nodeProvision.test.ts` / `jdkProvision.test.ts` /
   `androidSdkProvision.test.ts`); validate the real download/install manually.

## Platform scope

Two shipping targets: **macOS arm64** (`dmg` + `zip`) and **Windows x64** (`nsis`, per-user) — see
`electron-builder.yml`. Every pinned download in the on-demand provisioners is keyed by
`<platform>-<arch>`; the `*Provision.ts` modules already carry Windows URLs + checksums, and the
`.exe`/`.cmd` path handling lives in `index.ts` (`npmToolBin` picks the `.cmd` shim, `needsWinShell()`
forces `{shell:true}`, `ffmpegToolBin`/`ffprobeToolBin` append `.exe`). So the packaged Windows editor
provisions its own Android toolchain (Node + JDK 21 + sdkmanager all exist there) and can build Android —
but **never iOS** (`xcodebuild` is macOS-only).

The two **bundled** tools (`toktx`, `msdf-atlas-gen`) ship on BOTH platforms, staged into `build/bin` by
the `beforePack` stage hooks (`engine/scripts/stage-*.cjs`), which branch per platform and copy whatever
the build machine has installed (macOS: relocate the Homebrew binary + its dylibs; Windows: copy the
installed `.exe` + sibling DLL) — so a local `dist:mac` AND `dist:win` both bundle. CI additionally
pre-stages the Windows release via a verified download in `release-windows.yml` (a runner has nothing
installed); the `win32` stager branch is idempotent and no-ops there.
The playbook for adding a new tool on both is [bundle-new-tools.md](./bundle-new-tools.md).
Remaining Windows gap: **code signing** (Azure Trusted Signing) is not yet wired, so SmartScreen warns.
An Intel-mac (`x64`) target would still need its own prebuilt binaries + pins added to each provisioner.
