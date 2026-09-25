# Bundling a new external CLI tool (macOS DMG + Windows)

The repeatable playbook for adding a new external command-line tool to the packaged editor so it
works out of the box on **both** the macOS `.dmg` and the Windows `nsis` installer. Companion to
[editor-toolchain.md](./editor-toolchain.md) (the resolver/provisioner reference) — this doc is
the cross-platform **bundle** checklist, the part that has bitten us twice with stale comments.

## Step 0 — decide the mechanism: BUNDLE vs PROVISION

Governing rule (from `before-pack.cjs` + `editor-toolchain.md`): **"bundle nothing that can be
downloaded."** Pick by whether the tool has a clean download path:

| | **Provision on-demand** (preferred) | **Bundle into the app** |
|---|---|---|
| When | Tool has an npm package or a stable, checksummed cross-platform download (Node, JDK, ffmpeg, ffprobe, gltf-transform, gltfpack, android-sdk) | Tool has **no npm distribution** and is small + core to a common import path (`toktx`, `msdf-atlas-gen`) |
| Where it lands | `<userData>/toolchain` on first use, via the Build Support dialog | Inside the app: `Contents/Resources/bin` (mac) / `resources\bin` (win) |
| Ships in installer? | No — keeps the base app lean | Yes — `+~3 MB` each |
| Playbook | "Adding a new tool" in [editor-toolchain.md](./editor-toolchain.md) (`REGISTRY` + `INSTALLABLE` + `install()` branch + `*Provision.ts`) | **This doc** |

If provisioning fits, use that path and stop here. The rest of this doc is the **bundle** path.

## The bundle path — one stager, per-platform branches, one destination

Every stager stages its binary into **`build/bin/`**, which `electron-builder.yml` ships verbatim as
`extraResources: from build/bin → to bin`. The `beforePack` stage hooks (`engine/scripts/stage-*.cjs`,
fanned out from `engine/scripts/before-pack.cjs`) branch on `context.electronPlatformName` and stage
the tool's **pinned** build — so a LOCAL `dist:mac` AND a local `dist:win` both bundle it.

⚠️ **Pinned, never "whatever is installed"** (#1327). A bundled tool is one the packaged editor RUNS,
and both current ones are converters whose output ships under a cache key that names no binary — so
the bundle must be the same build every dev machine converts with. The stagers ask
`pinnedToolForStaging.cjs`: the `MODOKI_<TOOL>` override, else `npm run toolchain:install -- <tool>`
(which provisions the pin if it is missing). They never look on PATH or in Homebrew.

- **macOS (`darwin`)** → copy the pinned binary (+ any non-system dylib closure, relocated to
  `@loader_path/<name>` and ad-hoc re-signed) into `build/bin/`.
- **Windows (`win32`)** → copy the pinned `.exe` (+ any sibling DLL) into `build/bin/`. No relocation
  (Windows resolves a sibling DLL from the `.exe`'s own dir).
- **other platforms** → no-op.

**CI is the exception that still downloads.** A CI runner has nothing installed, so
`oss/.github/workflows/release-windows.yml` (the public repo's release workflow, authored here and
shipped by `scripts/publish-engine-oss.sh` — the private `.github/workflows/release-windows.yml`
was deleted 2026-08-03, see docs/engine-oss-publishing.md) pre-stages `build/bin/` via a pinned, sha256-verified DOWNLOAD
of each tool's Windows release BEFORE `npm run dist:win`. The stager's `win32` branch is **idempotent**
(it skips when `build/bin/<tool>` already exists), so it no-ops on top of the CI download. Two fill
mechanisms — local: the pinned provisioned copy · CI: a verified download of the same assets (held equal
to the pin table by `conversionToolPin.test.ts`) — one destination.

Runtime resolution is shared: `engine/electron/main.ts` `resolveBundled(envVar, name)` (only when
`app.isPackaged`) points `MODOKI_<TOOL>` at `resources/bin/<name>`, appending `.exe` on `win32`.

### Checklist for a new bundled tool `foo`

1. **Register it in the toolchain** — `engine/toolchain/index.ts`:
   - Add `'foo'` to the `ToolId` union.
   - Add a `REGISTRY` entry: `envVar: 'MODOKI_FOO'`, `bin: 'foo'`, `versionArgs` (match the tool's real
     flag — `msdf-atlas-gen` uses `['-version']`, not `--version`; verify the exit code is 0), a
     `missingHint`.
   - **If its output ships, pin it** (#1327): `pinnedOnly: true`, an `extraCandidates` under
     `conversionToolchainDir()`, a `CONVERSION_CLI_PINS` entry (`conversionCliProvision.ts`) with a
     sha256 per `<platform>-<arch>`, and add it to `INSTALLABLE` so dev machines and the stager can
     provision exactly that build. Bundling alone pins only the packaged editor.

2. **Surface it in Build Support** — `engine/.../editor/panels/BuildSupportDialog.tsx`: add it to a
   `GROUPS` entry (+ a new group label if needed). Grouping is curated — a registered-but-ungrouped tool
   will NOT render.

3. **Wire runtime resolution** — `engine/electron/main.ts`: add
   `resolveBundled('MODOKI_FOO', 'foo')` beside the toktx/msdf calls. `.exe` + `resources/bin` are handled
   for you. If `foo` needs sibling DLLs/dylibs, stage them next to the binary (OS same-dir search resolves
   them); note it in the stage scripts.

4. **Write the stager** — `engine/scripts/stage-foo.cjs` (copy `stage-toktx.cjs` for a single-sibling
   tool, `stage-msdf.cjs` for a full dylib-closure tool). Branch on `context.electronPlatformName`
   (do NOT use a blanket `!== 'darwin'` early-return — that skips Windows):
   - **`win32`** → `stageFooWin32()`: resolve the pinned binary (`pinnedToolForStaging('foo')`), copy
     `foo.exe` (+ any sibling DLL) into `build/bin/`. Make it **idempotent** — skip when `build/bin/foo.exe` already exists (CI pre-stages
     it). Sanity-run the staged copy (mind that some tools print `--version` to stderr on Windows).
   - **`darwin`** (or undefined) → resolve `pinnedToolForStaging('foo')`; copy
     the binary (+ dylib closure) into `build/bin/`, relocate absolute load paths to `@loader_path/<name>`
     (`install_name_tool`), ad-hoc re-sign (`codesign --sign -`), then sanity-run `--version`.
   - **other platforms** → return.
   - Be **graceful** on every branch: missing binary → `console.warn` + `return`, never throw (a build
     machine without `foo` must still build; the app degrades to a manual-install hint).
   - **A skip CLEARS what an earlier pack staged** (macOS) — remove your own files from `build/bin/`
     before the `return`. Nothing else empties that dir and electron-builder ships all of it, so a skip
     that leaves last run's copy behind ships a binary this pack could not provision, under a log line
     saying it was skipped. `stage-msdf`'s skip lacked this until #1571; both existing stagers are
     pinned by `engine/tests/electron/stagerSkipClearsItsSet.test.ts` — add yours to it.
   - Register it in `engine/scripts/before-pack.cjs` (`await stageFoo(context)`).

5. **Add the CI download step** — a `Stage foo` step in `oss/.github/workflows/release-windows.yml`
   (the public repo's workflow — there is no `.github/workflows/release-windows.yml` in this repo
   anymore, it was deleted 2026-08-03), before
   the build step, mirroring `Stage toktx` / `Stage msdf-atlas-gen`. A CI runner has nothing installed,
   so it DOWNLOADS the Windows release (the `win32` stager branch above then no-ops via idempotency):
   ```yaml
   - name: Stage foo for bundling
     shell: bash
     run: |
       FOO_VER=1.2.3
       FOO_SHA=<sha256 of the pinned win64 asset>   # never install unverified bytes
       mkdir -p build/bin
       url="https://github.com/<org>/foo/releases/download/v${FOO_VER}/foo-${FOO_VER}-win64.zip"
       if curl -fsSL "$url" -o foo.zip && echo "${FOO_SHA} *foo.zip" | sha256sum -c -; then
         7z x -y foo.zip -ofoo-extract >/dev/null    # 7-Zip preinstalled on windows-latest
         cp foo-extract/**/foo.exe build/bin/ || echo "[stage-foo] WARN: layout unexpected — no bundle"
       else
         echo "[stage-foo] WARN: download/verify failed — building WITHOUT bundled foo"
       fi
   ```
   - If upstream ships **only** an NSIS installer (like KTX), download the `.exe` installer and 7z-extract
     it (do NOT run it) — that's the `Stage toktx` pattern. If it ships a portable zip (like msdf), just
     extract. Compute the sha256 from the actual pinned asset and hard-code it.
   - Ship any sibling DLLs too (KTX needs `ktx.dll`; msdf is statically linked → exe only).
   - Keep it **graceful** — a failed stage leaves `build/bin/` as-is so the build still succeeds.

6. **Update the docs in the SAME change** (doc-conventions rule — a fact lives in one place):
   - The bundled-tools note in `electron-builder.yml` (the `win:` comment block) if the tool set changes.
   - The bundled-tools line in [editor-toolchain.md](./editor-toolchain.md) "Platform scope".
   - Add a row to the table below.

7. **Verify**:
   - macOS: `npm run dist:mac`, mount the DMG, confirm `Contents/Resources/bin/foo` runs and Build Support
     shows it present. (`npm run verify:packaged` covers the mac `--dir` smoke.)
   - Windows: `npm run dist:win` LOCALLY (bundles the pinned tool) — confirm `foo.exe` lands in
     `release\win-unpacked\resources\bin` and runs; OR, on the PUBLIC repo (`lsgmasa33/modoki-engine`,
     where releases are cut per the `/release-version` runbook), push a `v*` tag / run
     `oss/.github/workflows/release-windows.yml` manually for the CI-downloaded release artifact.
   - Extend `engine/tests/plugins/toolchainResolve.test.ts` for the per-platform `.exe` resolution and
     `engine/tests/electron/packagingManifest.test.ts` for the extraResources manifest.

## Current bundled tools (reference)

| Tool | Env var | macOS stager (pinned source) | Windows source (pinned) | Sibling files |
|---|---|---|---|---|
| **toktx** (KTX2 encode) | `MODOKI_TOKTX` | `stage-toktx.cjs` — KTX-Software `.pkg` v4.4.2, unpacked | KTX-Software NSIS `.exe`, v4.4.2, 7z-extracted | `ktx`/`ktx.exe` (gltf-transform's encoder, found on PATH beside toktx — #1351), `ktx.dll` (win), `libktx.4.dylib` (mac) |
| **msdf-atlas-gen** (MTSDF font atlas) | `MODOKI_MSDF_ATLAS_GEN` | `stage-msdf.cjs` — our static v1.4 Skia build (`build-msdf-atlas-gen-macos.sh`) | Chlumsky win64 `.zip`, v1.4 | none (both statically linked) |

## Did the playable-ad build add a new bundled tool? — NO (recorded 2026-07-19)

The playable-ad export (`docs/plans/advideo-playable-export-plan.md`) is the reason this playbook was
written, but it added **zero** new external CLI tools. Recorded here so it isn't re-investigated:

- **The single-file inliner** (`engine/plugins/inlinePlayable.ts`) is pure Node (`zlib`/`fs`) — it gzips
  the built `dist/` into one self-extracting `index.html`. No binary to bundle.
- **The playable asset profile** (`engine/plugins/playable-profile.ts`) doesn't add a converter — it
  layers aggressive overrides on the EXISTING pipeline: textures → WebP (the already-bundled `sharp`
  native module, `asarUnpack`ed), HDR → downscaled Radiance (Node), GLB → meshopt (already-provisioned
  `gltfpack`/`gltf-transform`). It deliberately **skips** the KTX2 transcoders (WebP-only), so it needs
  *fewer* tools than a normal build, not more.
- **The one hard tool dependency it introduces is `msdf-atlas-gen`** — a playable build STUBS runtime
  MSDF (`engine/plugins/playable-msdf-stub.ts`; the `@zappar/msdf-generator` worker can't fold into a
  single file), so a text playable MUST ship a **pre-baked** MTSDF atlas (Font Inspector → Apply). That
  bake shells out to `msdf-atlas-gen` — which is **already bundled** (row above), on both platforms.

Net: nothing to add to the bundle for the playable feature. If a FUTURE feature needs a genuinely new
tool, follow the checklist above.

## Gotchas learned the hard way

- **The stagers branch per-platform — they are NOT "macOS-only."** Each stager stages the pinned tool on
  BOTH `darwin` (copy + relocate any dylibs) and `win32` (copy the `.exe` + DLL);
  only `linux`/other return early. A comment claiming "macOS-only" or "Windows unsupported" is stale — this
  exact confusion has misled reviews. (See the `win32` branch note below.)
- **`versionArgs` are per-tool.** `msdf-atlas-gen` prints its version on `-version` (single dash) and exits
  0; a wrong flag makes the resolver's probe fail and the tool reads as "absent."
- **Never run an upstream `.exe` installer in CI to get the payload** — 7z-extract it. Running it needs
  admin/elevation and pollutes the runner.
- **Always pin + sha256-verify the download.** An unpinned `@latest` or unverified byte stream is a supply-
  chain hole; every existing stager verifies before copying.
- **Graceful-degrade, always.** Every stage path (mac hook + win step) must survive a missing/failed tool
  by leaving `build/bin/` without it — the runtime resolver already falls back to source assets or a
  manual-install hint. A hard failure would break unrelated dev builds.
- **Local `dist:win` staging (the `win32` stager branch).** The beforePack stagers now have a
  `win32` branch (`stage-toktx.cjs` `stageToktxWin32`, `stage-msdf.cjs` `stageMsdfWin32`) that mirrors
  the macOS path: it **copies the PINNED tool** — `toktx.exe` + its sibling `ktx.dll`, and
  `msdf-atlas-gen.exe` (single static exe, no siblings) — from `MODOKI_*` or the copy
  `toolchain:install` provisions (#1327; the KTX installer needs a 7-Zip on the machine to unpack).
  - **Idempotent, so CI is unaffected.** The branch skips when `build/bin/<tool>` already exists.
    `oss/.github/workflows/release-windows.yml` (public repo) still pre-stages via its verified **download** steps (a CI runner has nothing
    installed), and the beforePack branch then no-ops. CI keeps downloading (reproducible, pinned +
    sha256); a local dev box copies the same pin from its toolchain dir. Two fill mechanisms, one destination.
  - Cannot be provisioned on the dev box (offline, no 7-Zip) → the branch warns + skips (source-texture /
    install-hint fallback), exactly like macOS. `build/bin/` is gitignored.
