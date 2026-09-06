# Windows

Modoki builds and runs on Windows — the editor ships as an NSIS installer, and the repo's own
dev loop (editor, tests, native Android builds) works there. This doc collects the traps that
are **Windows-only**, because they share a property that makes them expensive: a macOS or Linux
machine cannot reproduce any of them, and several have shipped green gates while broken.

The recurring shape is not "Windows is different" — it is **a probe that asks the wrong
question and gets a confident wrong answer**. Read the first section even if you skip the rest.

## Resolve tools through the toolchain, never through PATH

The single most repeated mistake. Modoki **provisions its own toolchain** so a packaged editor
can build with zero user-installed SDKs, so a tool being absent from `PATH` says nothing about
whether Modoki has it.

`detect()` in [engine/toolchain/index.ts](../engine/toolchain/index.ts) resolves in a fixed
order, and PATH is *last*:

1. **`bundled()`** — the provisioned copy under `MODOKI_TOOLCHAIN_DIR`. In a packaged editor
   this is the only one that exists.
2. **`envVars`** — the tool's own override (`ANDROID_HOME`, `MODOKI_TOKTX`, …).
3. **`candidates()`** — well-known per-platform install dirs.
4. **PATH.**

So the correct probe for "do we have adb?" is the toolchain, not the shell:

```bash
# WRONG — answers a different question, and answers it confidently
command -v adb            # empty on a perfectly working machine

# RIGHT — adb is DERIVED from the resolved SDK, <sdk>/platform-tools/adb(.exe)
echo "$MODOKI_TOOLCHAIN_DIR"     # a provisioned dir — NOT necessarily %LOCALAPPDATA%\Android\Sdk
"$MODOKI_TOOLCHAIN_DIR/android-sdk/platform-tools/adb.exe" devices -l
```

`adbBinary()` / `detectAdb()` ([engine/plugins/backend/androidDevices.ts](../engine/plugins/backend/androidDevices.ts))
exist precisely so nothing reads a bare `adb`. Concluding "adb is not installed, this is blocked"
from an empty `command -v` is a **false blocker** — the editor bundles it.

### PATHEXT: `spawn` without a shell does not find `npm.cmd`

`execFile`/`spawn` with no shell do **no PATHEXT resolution on Windows**. Probing a bare tool
name whose real file is `npm.cmd` / `toktx.exe` throws `ENOENT`, which reads as "not found" —
this is exactly how Build Support reported "Node / npm — not found" on a machine that had both.

Use `whichSync()` (resolves a bare name over PATH × PATHEXT to an absolute path *before*
probing) and `spawnable()` (decides `{shell}` and quotes accordingly), both in
[engine/toolchain/index.ts](../engine/toolchain/index.ts). Never hand a bare name to `execFile`.

⚠️ Node throws `EINVAL` on spawning a `.cmd`/`.bat` without `shell:true` (the CVE-2024-27980
fix), so "just add a `.cmd` shim" is not a workaround for an unexecutable stub either.

## A probed tool can be present and still lie about itself

Two more instances of the doc's opening pattern — a probe answering confidently, and wrong —
found 2026-08-22 checking every toolchain tool through the packaged editor's actual `/api/toolchain`
route (the same `detect()` calls Build Support makes, in the packaged process's own env).

- **`toktx --version` writes to STDERR, not stdout, and exits 0.** `probeVersion()` in
  [engine/toolchain/index.ts](../engine/toolchain/index.ts) used to capture only
  `execFileSync`'s return value (stdout). So `detect('toktx')` reported `present: true,
  version: ""` — toktx genuinely runs (KTX2 encoding is unaffected; that goes through a
  separate PATH-injected spawn), but Build Support could never show its version. `java
  -version` has the same quirk and was already handled (`javaMajorMatches` reads both
  streams) — `probeVersion` now does too, via `spawnSync` concatenating stdout+stderr. Verified
  live: `toktx --version` → stderr `"toktx v4.4.2"`, stdout empty; every OTHER tool in the
  registry (ffmpeg, ffprobe, npm, gltf-transform-cli, gltfpack) already had real content on
  stdout, confirmed unaffected by an A/B git-stash comparison of the pre- and post-fix probe.
- **Two versions of the same native N-API addon load into one process and corrupt each
  other's global state.** `@gltf-transform/cli` depends on `sharp ~0.34.5` directly;
  `@gltf-transform/functions` unconditionally `require`s `ndarray-pixels` (even when a `sharp`
  encoder is supplied), which depends on `sharp ^0.35.0` — genuinely non-overlapping ranges, so
  npm correctly nests TWO native `sharp`/libvips builds in the shared `npm-tools` tree. On
  Windows, loading both into one process corrupts libvips' shared GObject type registry: any
  subsequent texture resize crashes —
  `GLib-GObject-CRITICAL: value "32" of type 'gint' is invalid or out of range for property
  'space' of type 'VipsInterpretation'` / `colourspace: parameter space not set` — which
  `rigged-model-optimize.ts` surfaces as "gltf-transform resize failed" and falls back to
  shipping the raw, unoptimized GLB, failing the build's "no unoptimized production assets"
  gate. Reproduced on a real rigged model (`char_Ranger.glb`, `demos/forest-camp`) via a full
  `Build → Android` from the packaged editor; not observed on macOS. Fixed by pinning `sharp`
  to one version across the whole `npm-tools` tree via an npm `overrides` entry
  (`npmToolsInstall`), so only one native copy ever loads — and `isToolStale` now also flags an
  *existing* install that predates the pin (file present, override missing), so a machine that
  already hit this self-heals the next time Build Support checks status rather than needing a
  manual "Reinstall".
- **The general lesson**: a shared npm-installed tool tree is the one place in the toolchain
  where two independently-versioned native addons can end up loaded together. Everything else
  provisioned here (Android SDK, JDK, CocoaPods' isolated `GEM_HOME`, go-ios, WebDriverAgent) is
  either not Node-based or runs as its own separate process — this bug class needs BOTH "shares
  one `node_modules` tree with another native addon" AND "gets `require()`'d into the SAME
  running process," which only the `npm-tools` tree satisfies today.

## Line endings

**`adb` on Windows returns CRLF, and `\r` is a JS line terminator.** So `.` does not match it and
`$` anchors before it — a trailing `(.*)$` capture fails on every single line.

This was a real production bug, not a test artifact: `parseLogcatLine` returned `null` for every
line, `parseCrashBuffer` returned `[]`, and **`device_crash_reports` answered "no crashes" about a
phone that had just crashed** (fixed in `5fb7f3b1`; the `trimEnd()` in
[engine/plugins/backend/deviceAndroidDiag.ts](../engine/plugins/backend/deviceAndroidDiag.ts) is
load-bearing and commented as such).

- **Normalize once, at the boundary.** Three separate places in the Android diagnostics know
  about line endings; that is two too many. Prefer trimming where the subprocess output enters.
- **Keep captured-device fixtures byte-faithful** — [.gitattributes](../.gitattributes) pins
  `*.txt text eol=lf` so real logcat captures are not rewritten into a shape no device emits.
- A test proving the parser handles a `\r` *you typed* is weaker evidence than one real phone.
  Both are worth having; only the phone proves adb's actual output shape.

## Paths

- **A drive letter is a colon, and a colon means "remote host" to some tools.** GNU tar reads
  `C:\path\x.zip` as `host:path` and dies with `Cannot connect to C:`. Every drive letter, not
  just non-`C`.
- **MSYS/Git-Bash hands native `.exe`s a MIXED-mode path** (`E:/a/b`), *not* the backslash form
  `cygpath -w` returns. Code matching process command lines must handle both spellings.
- Vite `/@fs/` URLs, `:`-joined PATH assumptions, and `chmod 0600` are the other members of this
  family. The repo has had a steady trickle of these; they are readable from any machine once you
  know to look, unlike the process-behaviour class below.
- **A guard keyed by a hand-authored POSIX path will not match `node:path` output.** `relative()`
  and `join()` return `\`-separated on Windows, so an allowlist entry like
  `runtime/loaders/textureResolver.ts` — or a `split('/')` over a relative path — silently stops
  matching. Two guards broke exactly this way (2026-08-20): every one of the 187 QA cases reported
  `area "animation" does not match directory "animation\<file>.md"`, and `render3dBoundary`
  reported every **gated** edge as an offender because `skipEdges` matched nothing. Normalise where
  the path leaves `node:path` — `.replace(/\\/g, '/')` or `.split(path.sep).join('/')`. Most of the
  repo already does, which is what makes these two omissions rather than a missing convention.
  - ⚠️ **The loud failure is the lucky one.** The dominant guard shape here collects offenders and
    asserts the list is empty — and that shape goes **green** on Windows when its matching breaks,
    because nothing matches. `render3dBoundary` failed loudly only because it independently pins
    non-vacuity (`visited.length > 100`) *and* asserts its own allowlist is load-bearing. Without
    those, a path-keyed guard is simply switched off on Windows and says nothing about it. When you
    write one, pin non-vacuity in the same commit.
  - A third instance landed 2026-08-21 (`materialCloneStamp`, from the #318 close-out): its
    `EXEMPT` keys and its known-clone-sites `Set` were both hand-authored POSIX, so both assertions
    failed on `ci/main` while the Mac gate stayed green. **The prescription above is what caught
    it** — the negative assertion alone would have gone quietly green on Windows; the companion
    "the scan is not vacuously passing" test is what made the breakage loud.
  - A fourth instance landed 2026-09-03 (`consoleRingOptionsWiring`, from the #633/#626 close-out):
    both of its offender lists are `path.relative()` output compared against forward-slash literals,
    so `ci/main`'s `check (windows-latest)` went red on the merge that carried it while the authoring
    clone's Mac gate — the only gate a worker runs — was structurally unable to see it. This one
    failed LOUDLY for the reverse of the usual reason: it asserts the offender list EQUALS a named
    set rather than that it is empty, so broken matching over-reports instead of going quiet. The
    sweep that followed found `updateEachFanoutGuard`'s `ALLOWLIST` keyed the same way — latent only
    because that list is empty today, fixed in the same commit.
  - Instances 7 and 8 landed 2026-09-06 on the `win` clone, found in a sweep the same day `main`
    fixed instances 5-6 (`f5e40a1e9` chromeTagging, `2ed8b6035` formatVersionFromConstant):
    `textDirtyAttribution.test.ts`'s definition-site exemption (`rel.endsWith('text/textDirty.ts')`
    against `path.relative()` output) never fired on Windows, so the guard silently fell through
    into the callers-only assertion instead of skipping; and `show-refs.mjs`'s
    `full.includes('/scenes/')` never matched, so `--all` printed no scene sections at all despite
    scene files existing. (The `entries: 0` line it also prints is the MANIFEST count, a
    separate and NOT Windows-specific defect — issue #805, where the same file's walk root also
    turns out to reach 2 of ~226 candidate files. It reads 0 before and after this fix.) Both fixed with the same normaliser,
    and the guard got a non-vacuity companion assertion
    per the prescription above (`textDirtyAttribution.test.ts` now separately asserts the scan
    reaches the definition file AND that the skip predicate matches it).
  - **SSOT note, which the four entries above do not say and is the reason this class keeps
    recurring**: the normalisation itself was hand-rolled FIVE times in THREE spellings before
    instances 7/8 — `importClosure.ts`'s exported `toPosix` (`split(/[\\/]/)`, the only one
    previously exported — and reachable from `engine/tests/`, so that was never the barrier; the
    real one is that it is a `.ts` helper and the plain-`.mjs` scripts cannot import it, which is
    why a second copy had to exist at all), `materialCloneStamp.test.ts`'s local `toPosix`
    (`split(sep)`), `consoleRingOptionsWiring.test.ts`'s `relPosix` (`split(path.sep)`), and
    `qaCaseReferences.test.ts` / `skillReferences.test.ts`'s local `toPosix`es (both
    `replace(/\\/g,'/')`) — plus roughly 60 more inline copies across the repo. ⚠️ Only the
    `split(path.sep)` spelling actually MISBEHAVES (it is separator-dependent, so it leaves a
    Windows-shaped path unnormalised on POSIX); the other two are extensionally identical, so
    "three spellings" is a duplication problem, not three behaviours.
    `engine/scripts/pathPosix.mjs` (`toPosix`) is now the shared one for **new** code; the existing
    ~66 sites were deliberately left as-is — they're churn with no defect behind them, not a
    backlog to migrate.

## Never shell out to a platform binary whose shape you assumed

`extractArchive()` used to call `tar`, which made one subprocess the single OS dependency of the
whole provisioning chain — and it was broken two independent ways on Windows for an unknown
length of time. Windows ships **bsdtar** at `System32\tar.exe`, but Git for Windows ships **GNU
tar** at `/usr/bin/tar`, so *which binary answered was decided by PATH order*.

It now extracts **in-process** (`tar` + `yauzl`, the libraries npm itself uses) — see the long
rationale comment in [engine/toolchain/nodeProvision.ts](../engine/toolchain/nodeProvision.ts).
⚠️ An older fix introduced a `tarBin()` helper; that is **gone**, superseded by in-process
extraction. Do not reintroduce a `tar` subprocess.

**The part worth internalising is how it hid.** `ensureNodeProvisioned()` catches the failure and
degrades to system npm, so a dev machine boots fine and `smoke:packaged` reported **PASS** while
its own log said `Node provisioning failed`. When testing an extractor, do not build the fixture
with the same tool — GNU tar's `-a -cf x.zip` writes a *tar* named `.zip` that extracts happily
and proves nothing. Assert the `PK` magic bytes instead.

## Packaged-app bugs found on real Windows hardware

Five bugs, all invisible to `npm run dev` on macOS, found testing the packaged NSIS installer on
real Windows hardware:

- **`/tmp` hardcoded** (`devServer.ts`'s Vite log path) → `ENOENT` → the open flow's catch handler
  → `app.quit()` — read as "crashes on a new folder," but it was every first-open crashing on
  Windows, where `/tmp` isn't a real path. Fixed with `os.tmpdir()`.
- **Missing `.exe` suffix** — the `ffmpeg-static`/`@ffprobe-installer` payloads are
  `ffmpeg.exe`/`ffprobe.exe` on Windows, but the resolver checked for the bare name, so a
  successfully-installed tool reported "Installed … but its executable is missing."
- **Launch splash + file logging added** — `splash.ts` (packaged-only, a `data:` URL window with a
  live status line) replaces what used to be a silent ~1-minute black window on first launch (Node
  provisioning + Vite's cold dep-optimize); `fileLog.ts` writes to `<userData>/logs/main.log` with
  timestamps, since a Windows user cannot easily copy text out of a crashed app to report an error.
- **Android `local.properties` backslash-escaping bug** — a new-project Android build failed with
  `java.io.IOException: The filename, directory name, or volume label syntax is incorrect`.
  `local.properties` is a Java `.properties` file, where `\` is an ESCAPE character — but the raw
  Windows SDK path was written verbatim (`sdk.dir=C:\Users\…\toolchain\android-sdk`), so `\t`
  (inside `…\toolchain`) became a literal TAB and `\U`/`\A`/`\R` were dropped, handing Gradle a
  garbage SDK path. `JAVA_HOME`/`ANDROID_HOME` were unaffected — they're passed via env vars, never
  `.properties`-parsed, and `gradlew.bat` is used on Windows regardless. Fixed by
  `androidSdkDirValue()` forward-slashing the path (Gradle accepts `/` on Windows). This is a
  **second, independent path-bug class** from the repo's `\` vs `/` path-sink audits (see "Paths"
  above): those swept path→URL/import sinks but skipped file writes, so this one went unnoticed
  until it broke a real build. A follow-up audit for the escaping-sensitive-file class (native
  path → `.properties`/gradle/script) came back clean otherwise — `sdk.dir` was the only offender.
- **A real Build press from a `Program Files` install EPERM'd TWICE, independently, and both
  are now fixed — but the two fixes are shaped completely differently, which is the point of
  recording this.** A packaged install's `engine/` is the app's own install directory —
  writable only during an admin-elevated install (the NSIS per-machine default, `C:\Program
  Files\...`), never by the running, unelevated app. A `Program Files` install is common, not
  an edge case — it's what "Install for all users" produces — and both causes were silent
  until the first Build press, so a clean-install smoke test that never presses Build
  (QA-PKG-0001 does not) won't catch either. Confirmed fixed end-to-end: a real Android build
  from a real `C:\Program Files\Modoki Editor` install now completes (web build → gradle
  assemble → install → launch on device).
  1. The scripts wrote `engine/tsconfig.app.scoped.json` unconditionally, before checking
     whether `tsc` would even run. A packaged app ships no `typescript` (the typecheck is
     dev-only), so the write was pure waste there. **Fixed by not writing at all**: deferred
     into the `existsSync(tscBin)` branch that already gates the typecheck, so a packaged
     build never attempts it. This is the fix to prefer whenever a write genuinely can be
     avoided — no install-time step, no ongoing exception to maintain.
  2. Fixing (1) surfaced a second, independent EPERM one step later: the actual `vite build`
     call used Vite's default `bundle` config loader, which esbuild-bundles `vite.config.ts`
     and WRITES it to `node_modules/.vite-temp/…mjs` — the same read-only install tree, on
     every single build (not avoidable the way (1) was — Vite hardcodes this path with no CLI
     flag or env var override, read straight from `loadConfigFromBundledFile` in
     `node_modules/vite/dist/node/chunks/node.js`). Two loader-flag alternatives were tried
     and reverted before landing on the real fix:
     - `--configLoader runner` (already used by `devServer.ts`'s OWN vite spawn — the dev
       server the editor UI runs on — which is why the editor launches and renders fine while
       every Build still crashed: two different `vite` invocations, only one had the flag)
       DOES stop the `.vite-temp` write, but its module runner is torn down once
       config-loading finishes, so ANY plugin hook doing a dynamic `import()` LATER in the
       build (`writeBundle`/`generateBundle` — exactly what `rigged-model-optimize.ts`'s
       `@gltf-transform/*` imports and the SSR-postprocessor loader in `vite-asset-scanner.ts`
       both do) throws `Vite module runner has been closed` instead — confirmed with a
       two-line repro (a plugin doing `await import('node:fs/promises')` from `writeBundle`
       fails under `runner`, succeeds under the default loader). Worse trade than the bug it
       fixed: the EPERM only hits an admin-elevated install; the broken dynamic import hits
       every build, everywhere, the moment a project has a rigged (skinned) model.
     - `--configLoader native` sidesteps that (no bundle-to-disk step, no runner to close) but
       requires every relative import under `engine/` to carry a real extension for Node's
       native ESM resolution — this repo's plugin tree does not, so `native` fails to even
       load `vite.config.ts`.
     - **A mitigation shipped for a while — an installer-time ACL grant on just that one
       subfolder — and has since been REMOVED (#326, 2026-08-27): the write it was
       compensating for is gone at the source, on both platforms.** Vite's default `bundle`
       config loader (`loadConfigFromBundledFile` in
       `node_modules/vite/dist/node/chunks/node.js`) only takes the disk-write path — bundle,
       write to `.vite-temp/…mjs`, import, unlink — for an ESM config; a `.cjs` config is
       hooked into `require.extensions` and compiled in memory, writing nothing at all.
       `engine/scripts/stage-vite-config.cjs` (invoked from the `beforePack` fan-out
       `engine/scripts/before-pack.cjs`) esbuild-bundles `engine/vite.config.ts` to a
       gitignored `engine/vite.config.cjs` at pack time; `engine/scripts/viteConfigChoice.mjs`
       exports `chooseViteConfig(engineDir)`, which prefers the `.cjs` when present, and
       `engine/scripts/build-web.mjs` calls it. A packaged editor therefore never hits the ESM
       branch and never writes `.vite-temp` — verified on a packaged, ad-hoc-resealed macOS
       `.app`: Build → Web from its own menu, then `codesign --verify --deep --strict` exit 0,
       zero files added to the bundle, no `.vite-temp` anywhere.
     - **Confirmed on Windows too, with the grant actually removed (not just theorized).**
       `build/installer.nsh`'s `customInstall` macro (`CreateDirectory` +
       `icacls … /grant *S-1-5-32-545:(OI)(CI)M`) was emptied and the installer rebuilt; a
       fresh install to `C:\Program Files\Modoki Editor` (an admin-elevated per-machine path —
       the discriminating one) launched pointed at `demos/forest-camp` (chosen for its rigged
       model, the exact case `--configLoader runner` breaks) and pressed a real Build → Web:
       the compile completed (rigged GLB optimized, no runner-closed error), `.vite-temp` was
       never created at all, and no EPERM anywhere. `installer.nsh` now ships with an
       intentionally empty `customInstall` — kept as a stub, not deleted, because
       `nsis.include`'s implicit default pickup of this exact path is itself worth guarding
       against going stale (`packagingManifest.test.ts`).

## Process control

**`pkill -f` does not work on Windows.** It matches the command *line*, which MSYS/Git-Bash
cannot see for native Windows processes — `ps -W` lists `electron.exe` by executable path with
zero argument text. `launch-editor.sh` used it for single-instance cleanup with `|| true`, so it
silently no-opped and every relaunch hit a modal "port already in use".

Match on `Get-CimInstance Win32_Process` `CommandLine` instead, and:

- **Exclude the querying PowerShell's own PID**, or the query matches itself.
- **Anchor the match to an absolute path** (this repo's). Every clone shares a relative fragment
  like `engine/electron/dist/main.cjs`, so a loose pattern kills a sibling clone's editor.
  Enforced by [engine/tests/architecture/reapScoping.test.ts](../engine/tests/architecture/reapScoping.test.ts),
  which fails any `pkill -f` pattern in `engine/scripts/**` not anchored to `/` or `$`.
- Killing a process does not kill its children — stopping Vite must take its build tree with it.

## Shell dependence

**11 of 49 root npm scripts shell out to bash** (`editor*`, `dev:stop`, `editor:stop`,
`test:packaged`, `smoke:packaged`, `dist:notarized`, `verify:publish`). They need `bash.exe`
resolvable, which it is not from cmd/PowerShell by default.

Adding `C:\Program Files\Git\bin` to PATH is enough — it holds only `bash.exe`, `git.exe`,
`sh.exe`. ⚠️ **Do not add `C:\Program Files\Git\usr\bin`**: 365 files, six of which shadow
Windows commands (`echo`, `expand`, `find`, `sort`, `tar`, `timeout`) — including the `tar`
shadowing described above. That is also why launching the agent *from* Git Bash is a bad idea:
it drags `usr\bin` onto every child process's PATH.

`npm run verify:publish` is bash + rsync and is deliberately hub-only — it is not part of the
Windows gate.

**A launcher shim avoids typing the bash path every time.** Two thin scripts outside the repo
(so they never dirty the branch), on PATH: `editor.cmd` for PowerShell/cmd — invokes Git Bash via
its **absolute** path (`%ProgramFiles%\Git\bin\bash.exe`), since `bash` itself is not resolvable
from those shells — and a plain `editor` script for Git Bash. Both just forward to
`engine/scripts/launch-editor.sh` with a repo path + optional game id
(`MODOKI_REPO`/`MODOKI_BACKEND_PORT` override the defaults; a missing repo exits 1 with a clear
error) — nothing this pair does is more than a convenience wrapper around the existing launcher.

**`engine/packages/capacitor-adjust` and `capacitor-applovin-max` were not deleted — they moved**
to `games/3d-test/packages/`, and 3d-test still ships both Adjust and AppLovin. Their absence from
the old `engine/packages/` path is a relocation, not a dropped SDK; only the lockfile's
`engine/packages/…` path reference is stale.

## Tests, gates and timings

- **Windows caps vitest workers at HALF `availableParallelism()`** — `perfCoreWorkers()`
  ([engine/testWorkers.ts](../engine/testWorkers.ts)) returns `{maxWorkers: ceil(n/2)}` on `win32`,
  because these boxes are SMT and vitest's `availableParallelism() - 1` counts hyperthreads as
  cores. **Never quote a Mac timing as if it were Windows'.** Expect a long run rather than reading
  one as a hang, and re-measure rather than trusting any number written down, this doc included.
  (This bullet said the opposite until 2026-08-20 — "Windows does not get the cap, and that is
  correct for a homogeneous CPU". It was wrong: see the measurement below.)
- **Do not run the two vitest suites concurrently by hand.** Under contention a file reads far
  slower, and the first casualties are the tests sitting closest to `testTimeout` — they fail as
  *timeouts*, not assertions, which is indistinguishable from a real regression until you re-run
  idle. `npm run verify` already handles this: two lanes, the engine suite chained behind
  typecheck and given a budgeted `MODOKI_TEST_MAX_WORKERS`
  ([engine/scripts/verify.mjs](../engine/scripts/verify.mjs)). Use it rather than hand-rolling
  parallelism; use `MODOKI_TEST_MAX_WORKERS` to bisect a contention problem.
  - ⚠️ **That budget covers the ENGINE lane only — the app lane sizes itself from the whole
    machine, and on an SMT box that alone was enough to fail the gate.** This is why the `win32`
    cap above exists. Measured 2026-08-20 on this clone (i5-11400, 6 physical / 12 logical),
    one commit (`566d2af19`), both lanes:

    | workers | app lane | engine lane | outcome |
    |---|---|---|---|
    | 6 (capped) | 489.2s | 308.6s | **green** |
    | 11 (vitest default) | 493.0s | 443.7s | **red** — 3 failures |

    Uncapped is *slower and red*: `qaCaseReferences` and `barrelImportOrder` time out at 20s
    (they need 4.6s and 8.4s alone) and `rampProbeRunner`'s 5 ms budget measures 74.5 ms. The extra
    workers buy nothing — so there was no tradeoff to tune, which is what made wiring the cap in an
    easy call. `verify:serial` fails the same way, so this was never lane contention and
    serialising does not fix it.
  - **Why `ceil(n/2)` and not a physical-core probe.** On an SMT box half IS the physical count; on
    a non-SMT box it over-halves, but the table shows halving costs ~0 wall-clock, so that downside
    is empirically nil. `os.cpus().length` cannot answer (it reports LOGICAL cores), and the
    PowerShell `Get-CimInstance Win32_Processor` query that can costs ~1.9s per vitest launch —
    noise inside `verify`, but it would double a single-file run.
- **`testTimeout` is 60s on Windows, 20s everywhere else — in BOTH vitest configs**
  ([engine/vite.config.ts](../engine/vite.config.ts) for the app lane,
  [engine/packages/modoki/vitest.config.ts](../engine/packages/modoki/vitest.config.ts) for the
  engine lane). There are exactly two, they run CONCURRENTLY as verify.mjs's two lanes, and a
  ceiling raised in only one of them just moves which lane goes red — the engine config holds the
  larger share of the repo's test files. (Per-leg counts deliberately not quoted here; they live in
  `engine/scripts/verify.mjs`'s header, and copying them is how the old figure went stale.) Raising
  one config and grepping only the file you edited is how the second gets missed; sweep repo-wide
  for `testTimeout:`. The 20s ceiling was itself a Windows
  accommodation (cold esbuild transforms of the three.js + engine graph); it stopped being enough.
  The worker cap above removed the *contention* that made `qaCaseReferences` time out, but not the
  margin: measured 2026-08-28 on the `win` clone it runs **8.1s idle** — up from the 4.6s in the
  table above — and still exceeded **35s** inside the app lane, failing 2 of 3 `npm run verify`
  runs. It walks the whole QA corpus off disk, so it grows with the suite it checks; a budget set
  on faster hardware was always going to be the binding constraint here first.
  - Deliberately **not** a global raise. On a machine where 20s is generous, a 60s ceiling turns a
    real hang into a long wait instead of a failure — and the cost of that is paid on the boxes
    most likely to notice a hang at all.
  - This is the contention bullet above *acted on* rather than restated: tests nearest the ceiling
    fail as timeouts, which is indistinguishable from a regression until somebody re-runs idle.
    Raising the Windows ceiling is what stops that re-run being the routine cost of the gate.
- **A PowerShell CIM query costs SECONDS — never run one you can prove will match nothing.**
  `Win32_Processor` above is ~1.9s; `Get-CimInstance Win32_Process` is worse, because it is a cold
  PowerShell start *plus* a full enumeration of every process on the box. Worked example (#313):
  `forceRemoveDir` (`engine/toolchain/index.ts`) swept for processes running out of the doomed
  directory before every delete, and that timed out `uninstall('java')` at 20s on a loaded CI runner
  — against a freshly-created **empty** temp dir, where the sweep could not possibly match anything.
  The fix is a `shouldSweepProcesses` guard, and the reason it is safe generalises: the sweep's
  predicate is `ExecutablePath -like '<dir>\*'`, so with no process image under `dir` the query
  provably returns nothing and skipping it is **semantics-preserving rather than a heuristic**. Look
  for that property before optimising a query away — an equivalence you can state beats a guess that
  usually holds. The Mac gate cannot see any of this: the whole path is behind `platform === 'win32'`,
  which is why the guard is platform-injectable and unit-tested from any host.
  - **Measured on the `win` clone** (2026-08-21), which is the only place these numbers exist:
    the sweep costs **398–1079 ms per call**, and `rmSync`'s retry budget on a freshly-created empty
    dir costs **0 ms, three times out of three**. The second number is the load-bearing one — it
    confirms the retries never fire for an empty dir, so the sweep really was the whole cost and the
    guard removes exactly it. Until that was measured it was only *inferred from reading the code*,
    which is not the same thing.
  - **What is still inference: how 1 s becomes 20 s.** No one has observed a 20 s sweep; the CI
    timeout is explained by cold start, not by the steady-state cost. `uninstall('java')` is the
    FIRST test in its describe block, so it alone pays PowerShell startup *plus* WMI service
    spin-up. The corroboration is the neighbour: `uninstall('cocoapods')` removes TWO dirs and so
    sweeps **twice**, and it did not time out — which fits "the first sweep in a process is the
    expensive one" and rules out "every sweep costs ~20 s". One failure sample, so treat that as the
    best-supported reading rather than a settled fact.
- **Size time budgets from the slowest machine.** A budget tuned on a Mac is not a budget. An
  isolated timing is worth roughly a quarter of the real under-load cost. Worked example
  (2026-08-20): `rampProbeRunner.test.ts`'s `expect(performance.now() - started).toBeLessThan(5)`
  measured **13.9 ms** inside a loaded `verify` on this clone and passes 3/3 when run alone — a
  wall-clock assertion standing in for a behavioural one (`reading.bound === 'none'`, asserted on
  the line above, is the claim that actually matters). A hard millisecond budget on shared
  hardware is a flake with a countdown on it; assert the behaviour, not the clock.
- Toolchain env vars set with `setx` are **not** picked up by an already-running editor or an
  already-running shell — env is read at process start. Pass them inline until the shell restarts.

## Diagnosing a Windows-only failure

Split the failure into one of two classes before doing anything:

- **Path / separator / CRLF / string-shape** — readable from any machine. Fix it wherever you are.
- **Live process / OS behaviour** (process trees, signals, stdio pipes, session teardown) — **not**
  diagnosable remotely. Shipping mechanism-guesses for CI to adjudicate burns rounds and lands
  wrong fixes; CI is a pass/fail **oracle, never a diagnosis**. Report the evidence, name the
  competing theories, and let a real Windows box measure it.

A worked example of the second class: an orphaned child inherits `cmd.exe`'s stdio pipes, so a
`close` event cannot fire until the orphan dies — making an assertion unsatisfiable *by
construction* rather than environment-dependent. No amount of reasoning from macOS produced that;
one measurement on Windows did.

## Devices

A debug APK built on one machine will **not** install over one built on another —
`INSTALL_FAILED_UPDATE_INCOMPATIBLE: signatures do not match`, because the debug keystore is one per
MACHINE (`~/.android/debug.keystore`; no project sets a `signingConfig`) — so this is a Mac-vs-Windows
split, not a per-clone one. Uninstalling first destroys that app's on-device data, so ask before you
do. The
gradle step succeeds and only the install step fails, which reads like a Windows build bug and is
not one.

### A Windows clone can drive an Android device it has no cable to

adb over TCP works from here, so a phone physically attached to another machine — or to nothing —
is still reachable, and every host-side device tool works over it: `device_crash_reports`,
`device_native_logs source:'system'`, and the `adb logcat` paths behind them. Verified 2026-08-20
against a phone bootstrapped from a Mac; a `shell` round trip measured ~250 ms, slower than USB and
entirely usable for diagnostics.

Two things make this harder to set up than it should be:

- **`adb mdns services` will NOT find it.** `adb tcpip <port>` does not advertise over mDNS — only
  Android 11+ *Wireless debugging* (the pairing-code flow, `adb pair`) does. An empty mDNS listing
  therefore says nothing about whether the port is open, and reading it as "the phone is not
  reachable" is a false blocker. Either connect straight to a known `ip:port`, or find it by
  scanning the subnet for the open port.
- **Confirm WHICH phone by `ro.serialno`, not by `ro.product.model`.** The model string cannot
  distinguish two handsets of the same kind, and this repo's fleet has several. A wireless target
  is named by an IP that any DHCP lease can move, so the serial is the only address that means
  anything.

**What still serialises across machines, and what does not.** The two mechanisms have different
enforcement points, and only one of them is a file:

- **The socket lease is enforced ON THE DEVICE** — the app refuses a second client by dropping the
  socket ([deviceConnection.ts](../engine/plugins/backend/deviceConnection.ts)). That exclusion
  costs nothing to extend over TCP: a clone on another machine holding the lease refuses this one
  exactly as a sibling clone would. Every tool that needs the lease is therefore already safe.
- **The hardware claim is machine-local, by design and by necessity.** It exists for what "the
  socket lease cannot arbitrate — adb, one machine-wide daemon a sibling clone shares" (#149), and
  claims live in `~/.modoki/device-claims.json` on the claiming host. Two machines keep two files
  and neither sees the other's.

So over TCP the uncoordinated surface is the **adb-level** work — install, `am crash`, logcat and
crash-report reads — not the lease. Reads collide harmlessly; the one that actually bites is two
machines installing to the same phone at once. `device_list` on either host will show it as free.

⚠️ **Do not "fix" this by pointing both machines at a shared claims file.** `isClaimDead` checks
pid liveness FIRST (`process.kill(pid, 0)`, in [deviceClaims.ts](../engine/plugins/backend/deviceClaims.ts)),
and that is a question only the claiming OS can answer. A foreign claim's pid is either absent —
so a LIVE claim reads as dead and the phone is taken anyway, failing open — or coincidentally in
use, so a DEAD claim is honoured for the full 12h TTL. There is no `host` field to scope the check
by. Making it work needs a real change (record the host, apply the pid check only to local claims,
and give foreign claims a short heartbeat-refreshed TTL), not a relocated file.

## Related

- [build.md](./build.md) — the build pipeline, the packaged-editor loop, and the per-target recipes.
- [editor-toolchain.md](./editor-toolchain.md) — what the editor provisions, and Build Support.
- [bundle-new-tools.md](./bundle-new-tools.md) — adding a new provisioned tool.
- [debug-tools-mcp.md](./debug-tools-mcp.md) — the device surface these adb notes belong to.
