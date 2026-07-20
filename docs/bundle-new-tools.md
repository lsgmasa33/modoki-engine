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
whatever the build machine has **installed** — so a LOCAL `dist:mac` AND a local `dist:win` both bundle:

- **macOS (`darwin`)** → relocate the Homebrew/`/usr/local` binary + its non-system dylib closure into
  `build/bin/` (`install_name_tool` → `@loader_path/<name>`, ad-hoc re-sign).
- **Windows (`win32`)** → copy the installed `.exe` (+ any sibling DLL) into `build/bin/`. No relocation
  (Windows resolves a sibling DLL from the `.exe`'s own dir). Install the tool once, like `brew install`
  on mac (e.g. `winget install KhronosGroup.KTX-Software`).
- **other platforms** → no-op.

**CI is the exception that still downloads.** A CI runner has nothing installed, so
`.github/workflows/release-windows.yml` pre-stages `build/bin/` via a pinned, sha256-verified DOWNLOAD
of each tool's Windows release BEFORE `npm run dist:win`. The stager's `win32` branch is **idempotent**
(it skips when `build/bin/<tool>` already exists), so it no-ops on top of the CI download. Two fill
mechanisms — local: copy-installed · CI: verified-download — one destination.

Runtime resolution is shared: `engine/electron/main.ts` `resolveBundled(envVar, name)` (only when
`app.isPackaged`) points `MODOKI_<TOOL>` at `resources/bin/<name>`, appending `.exe` on `win32`.

### Checklist for a new bundled tool `foo`

1. **Register it in the toolchain** — `engine/toolchain/index.ts`:
   - Add `'foo'` to the `ToolId` union.
   - Add a `REGISTRY` entry: `envVar: 'MODOKI_FOO'`, `bin: 'foo'`, `versionArgs` (match the tool's real
     flag — `msdf-atlas-gen` uses `['-version']`, not `--version`; verify the exit code is 0), a
     `missingHint`. Do **not** add it to `INSTALLABLE` (it's bundled, not downloaded).
   - Give it a `userData`/extraCandidate keyed off `MODOKI_TOOLCHAIN_DIR` only if a dev override is wanted.

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
   - **`win32`** → `stageFooWin32()`: resolve the INSTALLED binary (`MODOKI_FOO` env → PATH via `where`
     → the standard install dir, e.g. `%ProgramFiles%\Foo\bin`), copy `foo.exe` (+ any sibling DLL) into
     `build/bin/`. Make it **idempotent** — skip when `build/bin/foo.exe` already exists (CI pre-stages
     it). Sanity-run the staged copy (mind that some tools print `--version` to stderr on Windows).
   - **`darwin`** (or undefined) → resolve `MODOKI_FOO` → `which foo` → the standard install path; copy
     the binary (+ dylib closure) into `build/bin/`, relocate absolute load paths to `@loader_path/<name>`
     (`install_name_tool`), ad-hoc re-sign (`codesign --sign -`), then sanity-run `--version`.
   - **other platforms** → return.
   - Be **graceful** on every branch: missing binary → `console.warn` + `return`, never throw (a build
     machine without `foo` must still build; the app degrades to a manual-install hint).
   - Register it in `engine/scripts/before-pack.cjs` (`await stageFoo(context)`).

5. **Add the CI download step** — a `Stage foo` step in `.github/workflows/release-windows.yml`, before
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
   - Windows: `npm run dist:win` LOCALLY (bundles the tool you installed) — confirm `foo.exe` lands in
     `release\win-unpacked\resources\bin` and runs; OR push a `v*` tag / run `release-windows.yml` manually
     for the CI-downloaded release artifact.
   - Extend `engine/tests/plugins/toolchainResolve.test.ts` for the per-platform `.exe` resolution and
     `engine/tests/electron/packagingManifest.test.ts` for the extraResources manifest.

## Current bundled tools (reference)

| Tool | Env var | macOS stager | Windows source (pinned) | Sibling files |
|---|---|---|---|---|
| **toktx** (KTX2 encode) | `MODOKI_TOKTX` | `stage-toktx.cjs` (+ `libktx.4.dylib`) | KTX-Software NSIS `.exe`, v4.4.2, 7z-extracted | `ktx.dll` (win), `libktx.4.dylib` (mac) |
| **msdf-atlas-gen** (MTSDF font atlas) | `MODOKI_MSDF_ATLAS_GEN` | `stage-msdf.cjs` (+ libpng16/libtinyxml2/libfreetype) | Chlumsky win64 `.zip`, v1.4 | none on win (statically linked) |

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

- **The stagers branch per-platform — they are NOT "macOS-only."** Each stager stages the tool the build
  machine has installed on BOTH `darwin` (relocate Homebrew + dylibs) and `win32` (copy the `.exe` + DLL);
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
  the macOS path: it **copies an INSTALLED tool** off the build machine — `toktx.exe` + its sibling
  `ktx.dll` (resolved from `MODOKI_TOKTX` → PATH → `%ProgramFiles%\KTX-Software\bin`), and
  `msdf-atlas-gen.exe` (from `MODOKI_MSDF_ATLAS_GEN` → PATH; single static exe, no siblings). No
  download / no 7z / no NSIS extraction in the build. So a Windows dev installs the tools ONCE
  (`winget install KhronosGroup.KTX-Software`; for msdf-atlas-gen, unzip Chlumsky's `-win64.zip` and
  set `MODOKI_MSDF_ATLAS_GEN`) — exactly symmetric to `brew install …` before `dist:mac`. The macOS
  code path is untouched (Mac never enters the branch), so this is safe on `main` for both platforms.
  - **Idempotent, so CI is unaffected.** The branch skips when `build/bin/<tool>` already exists.
    `release-windows.yml` still pre-stages via its verified **download** steps (a CI runner has nothing
    installed), and the beforePack branch then no-ops. CI keeps downloading (reproducible, pinned +
    sha256); a local dev box copies what it installed. Two fill mechanisms, one destination.
  - Not installed on the dev box → the branch warns + skips (source-texture / install-hint fallback),
    exactly like a Mac without the Homebrew tool. `build/bin/` is gitignored.
