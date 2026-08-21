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

## Packaged-app bugs found on real Windows hardware

Four bugs, all invisible to `npm run dev` on macOS, found testing the packaged NSIS installer on
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
