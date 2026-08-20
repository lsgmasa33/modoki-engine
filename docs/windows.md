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

## Tests, gates and timings

- **Windows does not get the performance-core worker cap.** `perfCoreWorkers()`
  ([engine/testWorkers.ts](../engine/testWorkers.ts)) reads an Apple-Silicon-only sysctl and
  returns `{}` everywhere else, so vitest keeps its own default. **Never quote a Mac timing as if
  it were Windows'** — the doc comment there says so explicitly. Expect a long run rather than
  reading one as a hang, and re-measure rather than trusting any number written down, this
  doc included.
- **Do not run the two vitest suites concurrently by hand.** Under contention a file reads far
  slower, and the first casualties are the tests sitting closest to `testTimeout` — they fail as
  *timeouts*, not assertions, which is indistinguishable from a real regression until you re-run
  idle. `npm run verify` already handles this: two lanes, the engine suite chained behind
  typecheck and given a budgeted `MODOKI_TEST_MAX_WORKERS`
  ([engine/scripts/verify.mjs](../engine/scripts/verify.mjs)). Use it rather than hand-rolling
  parallelism; use `MODOKI_TEST_MAX_WORKERS` to bisect a contention problem.
  - ⚠️ **That budget covers the ENGINE lane only — the app lane still sizes itself from the whole
    machine, and on a hyperthreaded box that is enough to fail the gate on its own.** Measured
    2026-08-20 on this clone (i5-11400, 6 physical / 12 logical): vitest's default of
    `availableParallelism() - 1` = **11 workers on 6 cores**, and `npm run verify` came back red
    with `qaCaseReferences` and `barrelImportOrder` failing as 20s **timeouts** — tests that need
    4.6s and 8.4s when run alone. `verify:serial` failed the same way, so this is not lane
    contention and serialising the lanes does not fix it. `MODOKI_TEST_MAX_WORKERS=6` (physical
    cores) made the app suite fully green at **211.3s vs 198-210s red** — the oversubscription was
    buying no throughput at all, only latency. Until that cap is wired in, **export
    `MODOKI_TEST_MAX_WORKERS=<physical cores>` on a Windows clone** or the gate is unreliable.
    ⚠️ Do NOT derive it from `os.cpus().length`, which reports LOGICAL cores; the PowerShell
    `Get-CimInstance Win32_Processor` query that answers correctly costs ~1.9s per call, which is
    why this is an env var rather than an automatic probe like the Mac's sysctl.
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
`INSTALL_FAILED_UPDATE_INCOMPATIBLE: signatures do not match`, because each clone generates its own
debug keystore. Uninstalling first destroys that app's on-device data, so ask before you do. The
gradle step succeeds and only the install step fails, which reads like a Windows build bug and is
not one.

## Related

- [build.md](./build.md) — the build pipeline, the packaged-editor loop, and the per-target recipes.
- [editor-toolchain.md](./editor-toolchain.md) — what the editor provisions, and Build Support.
- [bundle-new-tools.md](./bundle-new-tools.md) — adding a new provisioned tool.
- [debug-tools-mcp.md](./debug-tools-mcp.md) — the device surface these adb notes belong to.
