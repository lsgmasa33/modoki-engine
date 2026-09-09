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

- **Binary tools** (`toktx`, `msdf-atlas-gen`, `npm`, `xcodebuild`, `cocoapods`, `gltf-transform-cli`, `gltfpack`, `ffmpeg`, `ffprobe`, `go-ios`) —
  resolved from an **env override** → **extra candidates** (a userData install location) → **PATH**,
  each validated by a `--version` probe. Results are **cached** (the probe spawn is expensive and its
  inputs are fixed at startup).
- **Directory tools** (`android-sdk`, `java`) — resolved from **our provisioned install** →
  **env vars** → **well-known dirs**, validated by a `marker` sub-path (`platform-tools` for the SDK,
  `bin/java` for a JDK), plus an optional `validate(dir)` hook. **Not cached** — their inputs
  (`ANDROID_HOME`, `JAVA_HOME`) legitimately differ per project, so a stale cache would resolve the
  wrong one. Our own install is probed **first**, so a stray `JAVA_HOME`/`ANDROID_HOME` can't shadow
  the SDK you just installed from the dialog.

### PATH resolution is explicit (`whichSync`) — the Windows PATHEXT trap

A bare tool name is resolved to an **absolute path** by `whichSync()` before it's probed or spawned,
because `execFile`/`spawn` **without a shell do no PATHEXT lookup on Windows**: they look for a file
named exactly `npm`, while npm ships `npm.cmd` (plus a `npm` *bash* script Windows can't run). Probing
by bare name therefore threw `ENOENT`, and Build Support reported an installed npm — and any
PATH-resolved `toktx`/`gltfpack`/`java` — as **"✗ not found"**, even with the system-tools toggle ON.
`whichSync` walks `PATH` × `PATHEXT` (never the extension-less shim) and requires the execute bit on
POSIX; the absolute result also gives every PATH-found tool a usable `path`/`dir` for `withToolOnPath`.

`spawnable(command, args)` is the companion: it decides whether a resolved command needs
`{shell:true}` (a `.cmd`/`.bat` shim — see `needsWinShell`) and **quotes the command AND its args**
when it does. Node concatenates argv into one command line for `shell:true`, so an unquoted
`C:\Program Files\…\gltf-transform.cmd` (or an asset under `My Games\`) was split by cmd.exe. **Every
spawn of a toolchain-resolved command should go through `spawnable`.**

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

### A Finder-launched app gets a minimal PATH — provisioned Node must be prepended, not just set as an env var

A macOS app launched from Finder (as opposed to a Terminal shell) starts with a **minimal PATH**
(`/usr/bin:/bin:…`, no Homebrew, no nvm). `gltf-transform-cli`/`gltfpack` are `#!/usr/bin/env node`
shebang scripts, so both **detecting and running** them needs `node` resolvable on PATH — but the
editor's provisioning only ever set `MODOKI_NODE`/`MODOKI_NPM_CLI` env vars, never PATH itself, so
the `--version` probe silently failed even right after a successful install and Build Support kept
reporting "not found." (Native binaries like `ffmpeg`/`ffprobe` were unaffected — no shebang, no
Node needed to run them.) Fixed two ways:

1. **`main.ts`'s `ensureNodeProvisioned()` prepends the provisioned Node's bin dir to
   `process.env.PATH`.** The Vite child (spawned afterward) inherits it, so both detection (main
   process) and reimport/build (Vite child) resolve `node`. Prepending — not appending — means a
   shebang always resolves to the editor's own Node, never a stray system one.
2. **In bundled-only mode** (packaged default, `!systemToolchainAllowed`), `detectBinary` does
   **not** add the system-PATH candidate for `INSTALLABLE` tools at all — it resolves only from our
   own env/toolchain install, else reports "not found" (prompting an install). This is what makes
   the "never fall back to system tool versions" promise real rather than aspirational; the "Use
   system SDKs" toggle (or a dev checkout) restores the PATH candidate.

Verified on the packaged app launched with a genuinely minimal PATH (no system Node on it):
`gltf-transform-cli` detects present at its pinned version (readable only by running it through the
provisioned Node), and the dialog no longer says "not found."

## Provisioning — `install(id)` / `guide(id)`

`install(id, {toolchainDir, onLog})` provisions an `INSTALLABLE` tool into the per-user toolchain dir
(`<userData>/toolchain`), streaming progress via `onLog`. `guide(id)` returns human setup steps for a
tool that must be installed by hand. The dialog shows an **Install** button for installable tools and a
**How to…** for guided ones (`canAutoInstall` distinguishes them).

| Tool | How it's provisioned | Pin |
|---|---|---|
| **Node** | `nodeProvision.ts` `ensureNode()` — downloaded from nodejs.org, **sha256**-verified, `tar`-extracted. Always used (dev opt-in via `MODOKI_PROVISION_NODE=1`; automatic when packaged), so npm never depends on a user install. | `v24.18.1` — Active LTS, and matched by CI `setup-node` 24, `@types/node` ^24, and the root `engines`. Node 22 went maintenance-only 2025-10-21, so the packaged editor was provisioning a security-fixes-only runtime. Keep those four in lockstep: `@types/node` above the provisioned runtime typechecks clean and then fails at RUNTIME here, where nothing else is watching. |
| **`gltf-transform-cli`**, **`gltfpack`** | `installNpmTool()` — npm-installed into a shared `<toolchainDir>/npm-tools`, exposing `.bin/<name>`. Both are npm/WASM CLIs (no native binary). | `4.4.1` / `1.2.0` |
| **`java`** | `jdkProvision.ts` `ensureJdk()` — a pinned **Temurin JDK 21** downloaded from Adoptium, **sha256**-verified, extracted. `discoverJavaHome()` is layout-robust (macOS `Contents/Home` vs plain `bin/java`). | Temurin `21.0.11+10` |
| **`android-sdk`** | `androidSdkProvision.ts` — bootstrap the pinned **cmdline-tools** zip (**sha1** from Google's `repository2-3.xml`) → run `sdkmanager` for the games' packages (`platform-tools`, `platforms;android-36`, `build-tools;36.0.0` — matching every game's `variables.gradle` compileSdk 36) with non-interactive license accept. **Ensures the pinned Temurin JDK first** (sdkmanager is a Java program — the chicken-and-egg), NEVER an arbitrary system JDK, so provisioning is reproducible. | cmdline-tools `15641748` |
| **`xcodebuild` (Xcode)** | **Guided only** — multi-GB, App-Store-gated, macOS-only. `guide('xcodebuild')` gives the App Store link + `xcode-select`/license/Apple-ID steps. | — |
| **`cocoapods`** | **Auto-installed on macOS** (`isInstallable` returns true on `darwin`, guided elsewhere) — `installCocoapods()` provisions an **isolated portable Ruby** into `<toolchainDir>/ruby` (`rubyProvision.ts`), then `gem install cocoapods` into an isolated `GEM_HOME` (`<toolchainDir>/cocoapods-gems`) — no Homebrew, no system Ruby. Native gem extensions compile against Xcode's clang (already required for iOS). `guide('cocoapods')` points at the one-click Install button. Not a `preflight('ios')` blocker — most iOS games are SPM-only and never need it. | `1.17.0` |
| **`webdriveragent`** | **Auto-installed on macOS** — `wdaProvision.ts` `ensureWda()` fetches the pinned Appium WDA source via `npm pack`, re-namespaces its bundle ids, and `xcodebuild build-for-testing`s it into `<toolchainDir>/wda`. Enables **trusted iOS device input** (#32 Phase 2); absent, `device_*` input falls back to synthetic DOM events and says so. Never a build blocker. See § "WebDriverAgent — the one BUILT tool" below. | `appium-webdriveragent@16.1.1` |
| **`go-ios`** | **Installable on macOS, but NOT auto-installed** (#217) — `goIosProvision.ts` `ensureGoIos()` downloads the pinned GitHub release zip (a single universal x86_64+arm64 Mach-O, not the npm package, which bundles all 5 platforms' binaries: 16.8 MB vs 60 MB down), **sha256**-verified, extracted to `<toolchainDir>/go-ios/<version>/ios`. Deliberately kept out of `AUTO_INSTALL` — it's only useful for deploying to an iOS ≤16 device (a devicectl-reachable iOS 17+ device never needs it), so most editors would pay its size for nothing; `/api/build` provisions it itself, on demand, the moment a build actually targets such a device, and a provisioning failure there falls back to the Xcode ⌘R handoff rather than failing the build. | `1.3.2` |

⚠️ **`tar` does NOT mean bsdtar on Windows — never spawn a bare `tar`.** Every provisioner above
extracts through one shared `extractArchive()`, and that one code path only works because **bsdtar**
(libarchive) reads both `.tar.gz` and `.zip`. Windows 10 1803+ ships bsdtar at `System32\tar.exe`,
but Git for Windows ships **GNU tar** at `/usr/bin/tar`, so a bare `tar` resolves by PATH order —
and GNU tar breaks this two ways: it cannot read a zip at all (`This does not look like a tar
archive`), and it parses an archive argument containing a colon as a remote `host:path`, so any
absolute Windows path fails with `Cannot connect to E: resolve failed` on **every** drive letter.
Measured 2026-08-02: on a PATH favouring Git, the packaged editor provisioned *nothing* — Node,
JDK, Android SDK and Ruby all — and fell back to a system npm that the no-toolchain user it targets
does not have. `extractArchive` therefore names `System32\tar.exe` via `tarBin()` and passes the
archive as a bare filename with `cwd` set to its directory. Guarded by real-extraction tests in
`engine/tests/plugins/nodeProvision.test.ts`.

The failure was invisible twice over, which is the part worth remembering: `ensureNodeProvisioned()`
catches and degrades to system npm, so **`smoke:packaged` reported PASS** throughout; and macOS is
immune (its `tar` is bsdtar, and there are no drive letters), so no Mac clone could ever reproduce it.

Each installable-into-userData tool (`java`, `android-sdk`, `gltf-transform-cli`, `gltfpack`) also has
a **userData candidate** in its registry entry keyed off `MODOKI_TOOLCHAIN_DIR`, so `detect()` finds the
just-installed copy first — before any system tool — which is how the packaged editor (with no system
toolchain) resolves them.

An `install()` of an npm CLI **verifies with the same `--version` probe `detect()` uses**, not just
`existsSync(bin)`, and **self-heals** when it fails: it wipes `npm-tools/node_modules` + the lockfile
and installs once more from scratch. An interrupted install can leave a tree where the `.bin` shim
exists but a dependency is half-written (seen in the wild: `@gltf-transform/core` with no
`package.json` → `ERR_MODULE_NOT_FOUND`). With the old existsSync check that install "succeeded" while
detection said missing, and clicking **Install** again was a no-op because npm saw the dependency
already satisfied — an unbreakable "not found" loop.

### WebDriverAgent — the one BUILT tool, and the three rules it breaks

Every other provisioned tool downloads a pinned artifact and verifies it against a checksum, so
`dev == packaged` byte for byte. WDA cannot: it is **compiled and code-signed on the user's machine**,
so no two developers' builds are identical and there is no hash to pin. It is worth understanding
exactly which invariants that costs, because each one is load-bearing elsewhere.

**1. The pin is on the SOURCE, not the artifact.** Appium publishes WDA to npm, so
`npm pack appium-webdriveragent@<version>` gets a version-pinned, registry-integrity-checked source
tree — the same reproducibility level `ffmpeg`/`gltfpack` already rely on. `npm pack`, not
`npm install`: we want a tree to compile, so pulling WDA's dependency graph would be cost with no
benefit.

**2. Bundle ids are rewritten in the SOURCE; the team is passed on the COMMAND LINE.** WDA ships its
targets under `com.facebook.*`, which no other team can sign. Each target needs a *distinct* id, so a
single `xcodebuild PRODUCT_BUNDLE_IDENTIFIER=` override cannot do it — one value would collapse every
target onto one id. Hence `renamespaceBundleIds()` (scoped to `PRODUCT_BUNDLE_IDENTIFIER` assignments
— a blanket `com.facebook.` replace would corrupt unrelated project references). `DEVELOPMENT_TEAM`
goes on the command line instead, precisely so the extracted tree stays team-agnostic.

**3. Signed PER MACHINE, not per project.** WDA is a separate app from the game under test and needs
only *a* valid identity to install on the phone — it does **not** have to share the game's team. So
one build serves every project, `install()` keeps the signature every other installer has (no project
context threaded through the toolchain contract), and switching projects never forces a rebuild. The
team lives in `ToolchainSettings.wdaTeamId`, seeded from the open project's `build.appleTeamId` by the
`/api/toolchain/install` route — the seeding happens *there* because that is where project context
already exists. This **amends** plan Decision 3 ("signed with the project's own `build.appleTeamId`"),
which was recorded before the contract cost was weighed.

⚠️ **"Present" does not mean "usable" — a signed build EXPIRES.** A provisioning profile dies after a
year on a paid team (about a week on a free one), and an expired WDA sits on disk looking installed
while failing to install on the device. A plain existence check would therefore report it healthy
while every iOS input op silently degraded to synthetic — the exact class of lie #32 exists to remove.
So `detect('webdriveragent')` is custom: it reads the built runner's embedded `ExpirationDate` and
reports an expired build as **ABSENT**, and `ensureWda()` rebuilds rather than returning it. An
unreadable profile is treated as *unknown*, never as valid.

**One step no CLI can perform**: iOS requires UI Automation to be enabled and a passcode/Face ID
prompt accepted **on the phone**, once per device. It is in `guide('webdriveragent')` so it surfaces
in the dialog at the moment the user installs, rather than in a doc they would have to know to open.

**It auto-installs — but only when it can succeed.** A from-scratch install measured **15.3s**
(npm pack + a full `xcodebuild build-for-testing`) on a warm Xcode, which is cheap enough to do
unasked. So `autoInstallable()` splits the question `isInstallable()` used to answer alone: *can the
user install this* vs *should we do it for them*. WDA is installable on any Mac, but auto-installing
it without Xcode or a signing team would produce a failing install, on every dialog open, for a tool
that only affects agent input fidelity on iOS. It therefore auto-installs only once `xcodebuild` is
present **and** a team is available — either `ToolchainSettings.wdaTeamId` or, reported by the
`/api/toolchain` route, the open project's `build.appleTeamId`. That second source matters: the
machine setting only exists after the first install seeds it, so without it a fresh machine could
never auto-install WDA even with a perfectly good team configured. Which tools auto-install is now
decided **server-side** (`ToolStatus.autoInstall`) rather than by a list in the dialog, because only
the backend can see those preconditions.

Building it is all this module does. **Launching** WDA against a device (`xcodebuild
test-without-building`, whose HTTP server lives only while that process runs) is a per-lease,
per-device lifecycle owned by the device code — see
[docs/trusted-device-input.md](trusted-device-input.md) Decisions 1–2. Every
other toolchain item conflates "provisioned" with "usable"; WDA genuinely has two lifecycles, and
keeping them apart is deliberate.

## Bundled-only vs system tools — the "Use system-installed tools" toggle

A **packaged** editor defaults to **bundled-only**: it builds with the tools it ships or provisioned
itself, so a build doesn't depend on whatever happens to be on the machine. The Build Support checkbox
(persisted to `<toolchainDir>/settings.json`, overridable with `MODOKI_ALLOW_SYSTEM_TOOLCHAIN=1`) opts
into system fallback; `systemToolchainAllowed()` reads it **live** in both processes that resolve tools.

With the toggle OFF, *every* system source is refused for a tool the editor can supply — not just the
PATH probe, but `JAVA_HOME`/`ANDROID_HOME` and the well-known Android-Studio/Homebrew SDK dirs, plus
the `npx --no-install @gltf-transform/cli` / bare-`gltfpack` fallbacks (which are the machine's npm).
The tool then reads "not found", which is the honest answer: it prompts an install instead of silently
building on a system copy.

The gate is `systemFallbackAllowed(id)` = the toggle **OR** `!editorCanProvide(id)` — because refusing
a fallback for a tool the editor *can't* supply here would report a working tool as missing with no way
to fix it:

| Tool | Gated when toggle is OFF? |
|---|---|
| `java`, `android-sdk`, `gltf-transform-cli`, `gltfpack`, `ffmpeg`, `ffprobe`, `go-ios` | **Yes** — installable into the toolchain dir |
| `toktx`, `msdf-atlas-gen` | Yes, **when bundled** (their `MODOKI_*` env var is set by the packaged host); a dev checkout has no bundle, so PATH stays usable |
| `npm` | Yes, **when the editor provisions Node** (packaged, or `MODOKI_PROVISION_NODE=1`); a plain dev checkout keeps its PATH npm |
| `xcodebuild` | **No** — Apple-supplied and multi-GB; it can never be bundled, so it always resolves from the system |

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

**Testing gotcha: CDP `Page.reload` on a packaged app corrupts the userData Vite dep-cache** — it
reproduces the same crash class as #21/#110 above (see [build.md](build.md) "Two packaged-boot
flakes"). To test the packaged app over CDP, always launch **fresh** (no reload):
```
MODOKI_NO_AUTOUPDATE=1 MODOKI_TOOLCHAIN_DIR=<tmp> \
  "…/Modoki Editor.app/Contents/MacOS/Modoki Editor" \
  --user-data-dir=<tmp> --remote-debugging-port=<port>
```
then attach a CDP client (Node's global `WebSocket` works with no extra dependency). To force a
clean reinstall of one provisioned tool: `rm -rf "~/Library/Application Support/Modoki Editor/toolchain/<sub>"`.

### Removing tools — and why the safety guard asks about CONTENTS, not the NAME

`POST /api/toolchain/uninstall {id}` removes one provisioned tool; `{id:'all'}` calls `uninstallAll()`,
which deletes the **entire** toolchain root (settings.json included) — Build Support's "Remove all
tools". Both go through `forceRemoveDir`, so both refuse rather than misreport when a recursive delete
would not do what it says: a link at the root, a link nested below it, a mount, or a filesystem root
(`findDeleteBoundaries`, see [build.md](build.md) and #883/#989/#990/#1004).

`uninstallAll()` carries **one more** guard on top of that walk, and #1005 is the story of it asking
the wrong question. It used to be:

```ts
if (path.basename(toolchainDir) !== 'toolchain') throw …   // WRONG — do not restore this
```

That is a question about the **name**, and the property it needed was the **contents**. It was wrong in
both directions at once:

- it **rejected** every legitimate `MODOKI_TOOLCHAIN_DIR` whose basename is not literally `toolchain`.
  Nothing constrains the override to that name — this doc, [windows.md](windows.md) and
  [build.md](build.md) all describe it as a free path — so on any machine that redirects it (the `win`
  clone's is named `modoki-toolchain`) **"Remove all tools" threw on every click and the feature was
  simply dead**;
- it **accepted** any unrelated directory that happened to be named `toolchain`, which is the direction
  a safety guard is supposedly there for.

⚠️ **The obvious replacement is vacuous — do not reach for it.** Comparing the argument against
`process.env.MODOKI_TOOLCHAIN_DIR` looks like the right identity test, but `uninstallAll()`'s only
production caller is the `/api/toolchain/uninstall` route, which passes **exactly that value** in. The
check would compare the value with itself and could never fire. A guard that cannot fire is worse than
the wrong guard it replaces, because it reads as protection.

**What the guard is left protecting is narrow, and that is what makes a contents test sufficient.**
Once the boundary walk has taken the links, the mounts and the drive roots, **two** cases remain that
it cannot see:

1. **an ordinary, self-contained directory that is simply not a toolchain** — `MODOKI_TOOLCHAIN_DIR`
   aimed at a home directory or a repo root. Nothing about such a tree is malformed; a recursive
   delete would remove it accurately and report success;
2. **a plain file.** ⚠️ This one is easy to miss and was: `findDeleteBoundaries` bails at
   `if (!rootStat.isDirectory()) return out` because a file has no subtree, so nothing downstream
   objects and `rmSync(file, {recursive:true, force:true})` deletes it. The first version of this
   guard accepted it too — `readdirSync` throws `ENOTDIR`, the `catch` returned "no foreign
   entries", and that meant accept. Measured: `unexpectedEntries = []`, `boundaries = []`, file
   gone. The `basename` guard being replaced happened to REJECT this, so the rewrite briefly traded
   a false-reject class for a false-**accept** class on a destructive path. Found by close-out
   review, not by either caller's tests — which is why the predicate now has a direct table test
   (`engine/tests/architecture/toolchainRoot.test.ts`).

So the guard asks `toolchainRootRefusal(dir)` (`engine/scripts/toolchainRoot.mjs`), which returns
`null` when the directory may be removed, or a reason: `not-a-directory`, or `foreign` with the
top-level entries the toolchain does not own — `node`, `jdk`, `android-sdk`, `cocoapods-gems`,
`ruby`, `wda`, `go-ios`, `npm-tools`, `settings.json`, ignoring OS junk like `.DS_Store`. A
`describeToolchainRootRefusal(dir, r)` beside it renders the message, mirroring
`findDeleteBoundaries`/`describeBoundary` — the two refusal kinds carry different remedies and must
not share a sentence. ⚠️ **The message never tells the user to delete the subject**: the realistic
subject is their home directory, and `deleteBoundary.mjs` already records what a careless remedy
line cost here (#883's text "lost a user their provision AND left them still blocked").

An **empty** dir is accepted — nothing to orphan, and `uninstallAll` is idempotent. **Absent** and
**unreadable** are accepted too: absence is not evidence of a foreign directory, and the unreadable
case belongs to `findDeleteBoundaries`, which refuses the run rather than naming a foreign entry
nobody could have seen.

⚠️ **The owned-entry set is a code constant describing disk written by a possibly-different editor
version.** `adoptLegacyToolchain` renames an older editor's whole toolchain root in, and an older
clone's `clean:packaged-cache` can run against a newer provision. The mirror test guards drift
*within* one tree only; cross-version drift surfaces as "refuses a real toolchain root" and aborts
the run. Inherent to asking about contents at all — the remedy is to add the new entry to the set,
not to loosen the check.

**Two callers, one predicate.** `clean-packaged-cache.mjs --toolchain` deletes the same directory
recursively and had **no** such check at all — the asymmetry that let this class live. It has one now,
scoped to the toolchain candidates only (the script's other candidates — packaged userData, the
Chromium cache, the install dir — are paths it derives itself, not a user-supplied free path).

⚠️ **The predicate lives in `engine/scripts/toolchainRoot.mjs`, not in `engine/toolchain/index.ts`,**
because the cache cleaner is plain-node `.mjs` and cannot import a `.ts`; the dependency already runs
that way (`index.ts` imports `deleteBoundary.mjs` and `pathIdentity.mjs`). That puts the owned-entry
set in a second place, mirroring `toolOwnedDirs()`. It is **not** trusted to stay in step by hand:
`toolchainResolve.test.ts` enumerates `TOOL_IDS`, calls the real `toolOwnedDirs`, and asserts every
basename it can return appears in the set — so **adding a tool with a new top-level directory turns
that test red**. Without it the drift is silent and lands the worst way round: the guard would start
refusing a real toolchain root, re-creating the exact defect above.

⚠️ **A fixture for either delete site must be toolchain-SHAPED.** `cleanPackagedCacheLinkGuard.test.ts`
built its payloads as a bare `<payload>/big.bin`; a contents check correctly calls that a foreign
entry, so three link cases stopped reaching the code they exist to test the moment this guard landed.
Payloads are `<payload>/node/big.bin` now.

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
checkout. Those fallbacks are the **machine's** npm, so they're refused in bundled-only mode — the
invocation throws the tool's actionable "install it from Build Support" message instead. Every spawn
goes through `spawnable()` so a `.cmd` shim and a path with spaces both survive.

## Adding a new tool

1. Add the id to `ToolId` and a descriptor to `REGISTRY` (binary or directory; give installable ones an
   `extraCandidates`/userData candidate keyed off `MODOKI_TOOLCHAIN_DIR`).
2. If installable: add it to `INSTALLABLE` (or a dynamic branch in `isInstallable` when it is
   platform- or precondition-gated, like `cocoapods`/`webdriveragent`) and an `install()` branch
   (reuse `installNpmTool` for an npm CLI, or a `*Provision.ts` module for a
   download+verify+extract). Pin the version + checksum.
3. Decide **separately** whether it should install UNASKED — `autoInstallable()`, not `isInstallable`.
   Only add it to `AUTO_INSTALL` if it cannot fail for environmental reasons; anything needing a
   toolchain, a signing identity, or a specific OS gets a precondition branch instead, or it will
   fail on every dialog open for users who never wanted it.
4. If guided: add a `guide()` branch. Put any step the user must do OUTSIDE the editor here (WDA's
   on-device UI Automation prompt), not only in a doc — this is what the dialog shows.
5. Surface it in `BuildSupportDialog`'s `GROUPS` + `TOOL_LABEL`, and in `preflight()` if it's a hard
   build requirement (an agent/tooling nicety is NOT — it must never block a build).
6. Deterministic tests mock the network (see `nodeProvision.test.ts` / `jdkProvision.test.ts` /
   `androidSdkProvision.test.ts`), or inject a command runner when the tool is BUILT rather than
   downloaded (`wdaProvision.test.ts`). **Also assert the REGISTRY wiring**, not just the module:
   the dialog reaches a tool through `TOOL_IDS`/`detect()`/`guide()`, and that indirection is where
   a new tool silently fails to appear. Validate the real install manually.

## Platform scope

Two shipping targets: **macOS arm64** (`dmg` + `zip`) and **Windows x64** (`nsis`, per-user) — see
`electron-builder.yml`. Every pinned download in the on-demand provisioners is keyed by
`<platform>-<arch>`; the `*Provision.ts` modules already carry Windows URLs + checksums, and the
`.exe`/`.cmd` path handling lives in `index.ts` (`whichSync` does the PATHEXT lookup, `npmToolBin` picks
the `.cmd` shim, `spawnable()`/`needsWinShell()` force + quote `{shell:true}`,
`ffmpegToolBin`/`ffprobeToolBin` append `.exe`). So the packaged Windows editor
provisions its own Android toolchain (Node + JDK 21 + sdkmanager all exist there) and can build Android —
but **never iOS** (`xcodebuild` is macOS-only).

The two **bundled** tools (`toktx`, `msdf-atlas-gen`) ship on BOTH platforms, staged into `build/bin` by
the `beforePack` stage hooks (`engine/scripts/stage-*.cjs`), which branch per platform and copy whatever
the build machine has installed (macOS: relocate the Homebrew binary + its dylibs; Windows: copy the
installed `.exe` + sibling DLL) — so a local `dist:mac` AND `dist:win` both bundle. CI additionally
pre-stages the Windows release via a verified download in the public repo's
`oss/.github/workflows/release-windows.yml` (there is no `.github/workflows/release-windows.yml`
in this private repo anymore — it was deleted 2026-08-03, releases are cut from the public repo
per the `/release-version` runbook; see docs/engine-oss-publishing.md) (a runner has nothing
installed); the `win32` stager branch is idempotent and no-ops there.
The playbook for adding a new tool on both is [bundle-new-tools.md](./bundle-new-tools.md).
Remaining Windows gap: **code signing** (Azure Trusted Signing) is not yet wired, so SmartScreen warns.
An Intel-mac (`x64`) target would still need its own prebuilt binaries + pins added to each provisioner.
