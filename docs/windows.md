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

- ⚠️ **`fs.realpathSync` is NOT the canonicaliser you want on Windows — `fs.realpathSync.native`
  is.** The JS lstat-walk resolves symlinks and junctions but neither `subst` drive mappings nor
  drive-letter CASE, both of which are ordinary ways one directory acquires two spellings here.
  Measured on `win` 2026-09-07 (#865 close-out):

  | input | `realpathSync` | `realpathSync.native` |
  |---|---|---|
  | `Y:\` (a `subst` of another dir) | `Y:\` — unresolved | the real target |
  | `e:\Projects\modoki` | `e:\Projects\modoki` | `E:\Projects\modoki` |
  | `C:\Users\RUNNER~1\…` (an 8.3 SHORT path) | left short | expanded to the long form |

  So a comparison that canonicalises with the JS walk still fails on a `subst`ed checkout or a
  lower-cased drive letter. `path.resolve` repairs neither.

  ⚠️ **#881 migrated nine call sites onto `.native` on darwin evidence alone; #893 drove all three
  rows on `win` and they hold.** Measured 2026-09-08 against `backendPortForClone`, with the
  pre-#881 lookup key (`path.basename(path.resolve(p))`) computed alongside as the control:

  | case | pre-#881 key | JS walk | `.native` |
  |---|---|---|---|
  | `subst X: E:\Projects\modoki`, then `X:\` | `""` → **auto ports** | `""` — unresolved | `E:\Projects\modoki` ✓ |
  | `E:\Projects\MODOKI` (case-flipped NAME) | `"MODOKI"` → **auto ports** | `"MODOKI"` — unresolved | `E:\Projects\modoki` ✓ |
  | a junction whose own name is not a clone name | `"NOTACLONE"` → **auto ports** | resolves ✓ | resolves ✓ |
  | `C:\Users\…\MODOKI~2` (a real dir, 8.3 alias) | `"MODOKI~2"` | **left SHORT** | `modoki83probe` ✓ |

  Three things this pins that reading the table above does **not** tell you:
  - **Row 2 of THIS table is about the directory NAME, not the drive letter** (row 2 of the
    three-row table above *is* the drive-letter one — the two rows do not correspond). `e:\` vs
    `E:\` never reached `backendPortForClone` at all: `path.basename` is drive-letter-independent,
    so that lookup was always right, and no input shape changes it — `e:\Projects\modoki`,
    `E:\Projects\modoki` and the drive-relative `e:` all key `"modoki"`. Drive case is a hazard for
    **comparisons**, and its pre-#869 instances were the electron `resolve`+`===` guards;
    `samePath` is what CLOSES it, via the `pathCaseKey` fold. #893's checklist expected it to move
    the port and was looking at the wrong half.
  - **The junction row needs *a* realpath, not specifically `.native`** — the JS walk resolves it.
    The rows where `.native` is genuinely load-bearing are `subst`, case-flipped names, and 8.3.
  - **8.3 is the one that would have shipped.** `samePath('…\MODOKI~2', '…\modoki83probe')` is
    `true` under `.native` and the old JS-walk comparison returned **`false`** — #878's exact
    failure, now measured rather than inferred.
- ⚠️ **The `win` clone's `E:` is ReFS — so no path under the clone, or under its `%TEMP%`
  (`E:\dev-temp`), can have an 8.3 short form at all.** The observation that establishes this is
  `Get-Volume` (`E  ReFS`, `C  NTFS`, `D  NTFS`), **not** the two `fsutil` outputs it is tempting to
  cite: `fsutil 8dot3name query E:` reporting creation DISABLED and `fsutil file setshortname`
  failing *"A local NTFS volume is required"* together establish only "8.3 creation is off" and "not
  local NTFS" — and on NTFS, disabling *creation* leaves pre-existing short names intact, so neither
  supports the "cannot, structurally" claim. ReFS is what does. (The owner reports `E:` is a Dev
  Drive; that designation needs elevated `fsutil devdrv query` to confirm and is immaterial here —
  ReFS is the operative fact.) `C:` is NTFS with 8.3 **enabled**, so the short-path case IS drivable
  on this machine — on `C:`, and with no elevation, because generation there is automatic.

  This matters beyond one probe: it is a second, structural reason a short-path bug is invisible from
  the `win` clone, on top of the account-name reason #878 recorded. A test that reaches for
  `os.tmpdir()` to build one gets a ReFS path and silently measures nothing.
- ⚠️ **`.native` only normalises a path that EXISTS**, and throws otherwise. That is why the
  canonicaliser alone is not enough, and it is where #865's fix still had a hole: callers fall
  back to `path.resolve`, which folds nothing, and **a persisted path naming a directory that is
  gone — a stale recents entry, a stale device claim — is exactly that case.**

  ⚠️ **This does NOT mean such a comparison is unfixable**, which an earlier version of this
  section claimed. The residue belonged to the COMPARATOR, not the canonicaliser — and case-folding
  at the comparison closed only HALF of it. The sentence that used to stand here — *"case-fold at the
  comparison and two spellings of a missing path match again"* — was an over-claim (#892). It closes
  the **case** half. `path.resolve` follows no symlinks either, so two spellings of a missing path
  reached through a symlinked ancestor still compared unequal after the fold. Measured on darwin,
  where it is not exotic: `os.tmpdir()` is `/var/…`, a symlink to `/private/var/…`.

  The comparator needs **both** halves, and the shape is `canonicalWithMissingTail` — canonicalise
  the longest ANCESTOR that exists, re-append the missing tail literally, then fold:

  | | resolves links for a MISSING path | folds case |
  |---|---|---|
  | `path.resolve` | no | no |
  | `canonicalPath` | no (falls back to `resolve`) | no — it returns a spelling, not a key |
  | `canonicalWithMissingTail` + `pathCaseKey` | **yes** | **yes** |

  ✅ **Both halves have landed** (#892, closed): `samePath` is now
  `pathCaseKey(canonicalWithMissingTail(a)) === pathCaseKey(canonicalWithMissingTail(b))`. The table
  below is the PRE-FIX measurement, kept because it is the only Windows evidence that exists and
  because its third row names a trigger #892 never did.

  **Measured on `win` 2026-09-08 (#893), `samePath` on a path that does NOT exist — before #892:**

  | spelling of the missing path | `samePath` (pre-fix) | `isUnderOrSame` |
  |---|---|---|
  | through a `subst`ed drive | **false** ✗ | true |
  | through a junction | **false** ✗ | true |
  | under an 8.3 SHORT ancestor | **false** ✗ | true |
  | drive-letter case / case-flipped name | true | true |

  The last row is the case-fold working; the first three are what it could not reach, because
  `.native` throws on a missing path and the fallback resolves no links. **#892 listed
  `subst`/junction as *inferred* and never named the 8.3 row at all** — `win` found it by measuring.
  The `isUnderOrSame` column is #881's `canonicalWithMissingTail` handling all four, which is exactly
  the shape #892 then borrowed.

  ⚠️ **The post-fix Windows behaviour is EXPECTED, not measured.** `samePath` now calls the same
  helper that produced the `true` column above, so all four rows should pass — but nobody has re-run
  the table on Windows since #892 landed, and #893 (the verification ticket) closed before it. Worth
  one run on `win`.

  ⚠️ **This over-claim reached its SECOND retraction before it died.** #881 retracted it inside
  `pathIdentity.mjs` and left the copy here standing, so #892 was diagnosed against a doc that said
  the hole was already closed. **A retraction has to sweep every copy of the claim** — and note the
  fold itself over-matches on a case-SENSITIVE volume — raised as #905 and **ruled accepted by the
  owner on 2026-09-08**, on cost/benefit rather than on the (dead) "a stat per comparison" reason.
  The standing rationale lives in `CASE_INSENSITIVE`'s docblock in `pathIdentity.mjs`; do not
  restate it here.

- **Use `samePath` / `canonicalPath` / `pathCaseKey` / `isUnderOrSame` from
  `engine/scripts/pathIdentity.mjs`** — the one implementation (#869, #881), reachable from
  electron TS, `engine/plugins/**` TS and the bare-node `.mjs` CLIs alike. Before it existed the
  repo had hand-rolled this **eight** times in four mutually inconsistent recipes.
  `engine/tests/architecture/pathIdentityIsShared.test.ts` bans a new `path.resolve(x) === y`; it
  found the eighth site itself, which a hand-written census grep had missed because the call was
  `path.resolve(path.join(...))` and nested parens defeated the pattern.

  | export | answers |
  |---|---|
  | `canonicalPath(p)` | the canonical SPELLING — `resolve` + `.native`, falling back to `resolve` |
  | `samePath(a, b)` | same directory or file? |
  | `pathCaseKey(s)` | the platform's comparison KEY for a canonical path or one segment — for a **lookup** rather than a comparison |
  | `isUnderOrSame(parent, child)` | same path, or inside it? |

  ⚠️ **The module has TWO canonicalisers and only one of them is exported** (#892). Know which
  question you are asking:

  - **`canonicalPath` — a spelling you KEEP.** A human reads it (`deviceClaimsStore`'s refusal
    message names the holding clone), a record stores it. Its `resolve` fallback for a missing
    path is deliberate and pinned by a #865 test.
  - **`canonicalWithMissingTail` — a space you COMPARE in.** Module-private, and **every predicate
    here uses it**: `samePath` and `isUnderOrSame` both. It is not exported precisely because a
    caller wanting sameness wants `samePath` and a caller wanting a value wants `canonicalPath`.

  Getting this backwards is what both #881 and #892 were: a predicate built on the SPELLING
  canonicaliser, inheriting `resolve`'s blindness to links for every path that is gone or not yet
  created. They were found a fix apart, in the two predicates, for the same reason.

  ⚠️ **The guard also bans a bare `fs.realpathSync(...)` in those roots (#881).** The census that
  decided it found **nine** calls in **six** files still using the JS walk. (Seven is the count of
  files the fix TOUCHED — it also edits `editorBackendRouter.ts`, which had no realpath.) `.native` is NOT
  banned — the regex requires the paren to follow immediately, so `realpathSync.native(x)` does not
  match — and that asymmetry is pinned in the guard's own table, because a version banning both
  would make deleting `canonicalPath`'s realpath the cheapest way to go green.

  ⚠️ **`.native` MASKS the case-fold on a path that exists, which makes a test for the fold easy to
  write and impossible to fail.** A flipped spelling of an existing directory is resolved back to
  its on-disk name by `.native` alone, so the fold contributes nothing there. The fold's only
  load-bearing case is a path that is **gone or not yet created** — `.native` throws, the fallback
  is bare `resolve`, and folding is all that is left. Two tests were written the wrong way here and
  both stayed green with the mechanism deleted (#881 mutation checks M2 and M3); the fix is to
  assert on a NON-EXISTENT path, and on a **symlinked** one where the link's own basename is not a
  match in any casing.

  Two things that are deliberately NOT that shape and must stay as they are:
  - **`isUnderRepo` (`electron/projects.ts`) is correct** — `path.relative` **is case-insensitive
    on win32**, so a containment check already folds. Measured:
    `relative('E:\Projects\modoki', 'e:/Projects/MODOKI/games/sling')` is `'games\sling'`. This
    asymmetry is exactly why #869's two guards were wrong and this one was not: they used `===`
    on two absolute paths, which folds nothing.
  - **`context-cost-guard.mjs`'s dedup key and `projectPaths.ts`'s `realDir` were migrated
    anyway** (#881) even though neither compares two clone roots: any bare walk in these roots is
    now a guard failure, and both are strictly better on `.native`. `realDir` keeps its deliberate
    shape — it canonicalises the CONTAINING directory only, so a symlink inside the project is not
    followed out to its target.
  - **`userDataDir.cloneId`, `userDataDir.multiProfileKey` and `instanceToken.rootKey` were
    EXEMPTED here, and the exemption was wrong** (#899, fixed 2026-09-08). This entry used to say
    they HASH the path into a persisted identity, so re-normalising them "relocates every existing
    user's profile (prefs silently reset) and 403s them against their own editor" — and therefore
    that their omission of realpath was "arguably right for a stable identity: a `subst` mapping
    can vanish and take the identity with it."

    ⚠️ **The relocation claim is measurably false, and it parked three live defects.** Measured
    over the six real clone and project roots on a developer machine, the key is BYTE-IDENTICAL
    under the old and new recipes for every one. The only paths that move are those traversing a
    symlink — precisely the ones that already had TWO identities, which was the bug: a clone opened
    through a symlink got a second profile ("prefs randomly reset"), and a project opened through
    one got a second token, so `checkToken` returned `mismatch` and the user was 403'd "WRONG
    EDITOR" against their own editor. Both driven end to end before the fix.

    All three now go through the SSOT. The two halves get **opposite** migration answers, and the
    asymmetry is deliberate:
    - **`instanceToken` keeps a legacy-key read-through.** `readToken` consults the pre-#899 key on
      a miss, and `ensureToken` ADOPTS that entry under the new key rather than minting a rival —
      so Connect is a write-forward that converges the two spellings. ⚠️ **One case IS still a 403,
      and an earlier draft of this bullet said "nobody is 403'd meanwhile"** (close-out review): a
      user who had connected pre-#899 through BOTH spellings has two entries, and after the
      migration `rootKey(link)` collides with `legacyRootKey(real)`, so one of the two tokens must
      lose and an `.mcp.json` carrying the other gets `mismatch`. That is inherent to unifying two
      identities — the cost is ONE 403, and the remedy is the one the error already prints.
    - **`userDataDir` has NONE, and a symlink-reached clone loses its prefs once.** There is no
      write-forward moment for a directory, and both keyings are broken: keyed on the RAW spelling
      it adopts a different old dir per spelling, so the profiles never converge and the fix does
      nothing for the only people who need it; keyed on the CANONICAL spelling it is byte-identical
      to the new id — dead code that can never fire. Both measured. Renaming is worse: that dir is a
      live Chromium profile holding a LevelDB lock.

    ⚠️ **The `multiProfileKey` "already drifted" note is NARROWED, not retired.** It said the
    missing trailing-slash trim meant `MODOKI_PROJECT=…/x/` and `…/x` mint two profiles, and called
    it "a real defect needing a migration decision". For ordinary paths that is false — `path.resolve`
    strips a trailing separator, so the trim its siblings carried was dead code, and
    `userDataDir.test.ts`'s *"a trailing slash is the SAME project (stable key)"* had been green on
    exactly that point the whole time. ⚠️ **But an earlier draft of this bullet retracted it FLAT,
    from a Mac, and that over-reached** (close-out review): `path.win32.resolve('C:\')` returns
    `'C:\'` — the separator SURVIVES for a drive root — so on Windows the trim did fire and the
    drift was real, if unreachably narrow (nobody opens a drive root as a project). Retracting a
    Windows claim from a Mac is the mistake this section keeps repeating.

    ⚠️ **Windows is INFERRED for all of the above.** Every measurement here is darwin/APFS with a
    symlink. On win32 the fold half already worked (these recipes folded on `win32||darwin`), and
    the half that was broken — junction, `subst`, 8.3 — is not driven. Same shape as #893, and it
    wants the `win` clone.
- ⚠️ **A test must seed its expected value with the SAME canonicaliser as its subject**, or the
  baseline quietly encodes a second claim nobody meant to assert.

  **The discriminator, derived while sweeping for siblings of this in #881 — the hazard is narrower
  than "the test used the wrong realpath".** It bites only when the seed is used to BUILD AN
  EXPECTED VALUE. When the seed is merely an INPUT that the subject canonicalises on both sides,
  the mismatch is normalised away before any comparison and the test is safe. Worked both ways:
  - **Divergent** — `projectPaths.test.ts` seeded `tmp` with the JS walk and built every expected
    relative path from it, while `realDir` returned `.native` output. Short-vs-long would have
    reddened `ci/main`'s windows leg and nothing a Mac runs. Fixed in #881.
  - **NOT divergent** — `deviceClaimBuildGuard.test.ts`'s two `#865` cases (*"matches when the
    stored side is the real path and the own side is reached through a link"* and *"re-claims a CLI
    owner-claim when the requester spells the same clone differently"*) also seed with the JS walk, but
    hand both spellings to `sameClone`, which `.native`s each side before comparing. Checked
    explicitly rather than swept in; a fix there would have been churn.

  ⚠️ **That is the same FILE as the #878 failure below, and a different case in it.** #878 was its
  drive-CASE baseline, which built an expected value from the seed and died on short-vs-long; the
  two cases named above feed the seed in as an input and are safe. Same file, opposite verdicts,
  and the discriminator above is what tells them apart — which is exactly why the rule is not
  "grep the file for the wrong realpath".

  So the check is *"does an assertion compare subject output against something built from the
  seed?"* — not *"which realpath did the seed use?"* The two forms also disagree on an
  **8.3 short path** (row 3 above), so `deviceClaimBuildGuard.test.ts` — seeding a drive-CASE
  baseline with the JS walk against a `.native` subject — died on short-vs-long, which is not the
  property it exists to pin (#878, fixed in `1307b2c1f`).
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
  - **The corpus producer made this class RARE, not unreachable — this bullet claimed the latter
    for about 16 hours, and instance 9 disproved it** (#799/#771/#805; corrected under #847). Guards did
    not get better at normalising — they stopped producing paths that need it.
    `engine/scripts/repoCorpus.mjs` returns **git's own repo-relative POSIX `rel`**, so a consumer
    that KEEPS that `rel` and compares against `'a/b.ts'` never touches `node:path` and has no
    backslash to forget. ⚠️ Keeping it is the consumer's CHOICE, which is the whole of limit 1
    below. ~70 producers were migrated onto it and
    `corpusProducerIsShared.test.ts` enforces it; the shape is documented in
    [verify-and-ci.md](verify-and-ci.md) § "Corpus production". Instances **3, 5 and 7** above
    (`materialCloneStamp`, `chromeTagging`, `textDirtyAttribution`) each carried a hand-rolled
    normaliser, and all three are now dead code that `noUnusedLocals` deleted — `materialCloneStamp`
    is the one that mattered most, since its `split(sep)` was the one genuinely broken spelling.
    ⚠️ Four limits, so this is not read as more than it is:
    - ⚠️ **Instance 9 (`livenessTokenIsShared`, #847) landed INSIDE this supposedly-covered
      region** — not in the #814 gap below, where this bullet predicted the next one. The
      producer's guarantee is **opt-out**: `repoFiles` returns `{ rel, abs }`, and a consumer
      writing `.map(({ abs }) => abs)` throws the safe `rel` away, after which any
      `path.relative(REPO, abs)` reconstructs the backslash the producer had removed. That is
      what #847's guard did, and `corpusProducerIsShared.test.ts` cannot see it — the producer
      IS shared; the consumer discarded its output. Measured 2026-09-07, repo-wide: **39 call
      sites across 36 files** spell that `.map` (an earlier pass scoped to `engine/tests/**` alone
      found 30 across 28 files, but `engine/packages/modoki/tests/**` is not out of scope — it
      runs as the second half of `verify`, per `package.json`'s `verify` script — and
      `engine/scripts/**` adds a few more), and a sweep found every other one benign — they
      normalise before comparing, or never compare at all. ~~So the exposed population is one, not
      thirty-nine.~~
      ✅ **Now GUARDED — #866 closed on `win`, 2026-09-07.** `corpusConsumerPins.test.ts` enforces
      the pin rule below over the **30** consumers that discard `rel`: a `.ts`/`.tsx`/`.mjs` under
      `engine/tests`, `engine/packages/modoki/tests` or `engine/scripts` that spells either `.map`
      must carry a non-vacuity assertion. `corpusProducerIsShared` enforces that you *use*
      `repoFiles`; this enforces what you do with its output, which is where instance 9 and all
      nine of #849's landed. The census when it landed: of 32 rel-discarding files, **29 already
      had a pin**, 2 are migration scripts that assert nothing (a vacuous migration is a no-op,
      not a false green — they sit in `NOT_A_GUARD`), and **1** was a real guard with none
      (`inputSourceGuard.test.ts`, now pinned).
      ⚠️ **What this deliberately does NOT do is detect the defect**, because #866 measured that
      and it does not work: of the 32 files that still discard `rel`, **24** also derive their own
      repo root, so "two derivations in one file" flags 24 benign files and does not
      discriminate. The rule chosen instead (owner, 2026-09-07) makes the class **loud, not
      absent** — it can still be written; it can no longer pass green having matched nothing. The
      alternative considered and declined was making `rel` hard to drop at the `repoFiles` API,
      which prevents it at authoring time on any platform but costs a 32-site migration; it stays
      on the table if a tenth instance lands. Detection is not left to a human: a push to `main`
      auto-runs the free public CI, whose `windows-latest` leg is where a vacuous guard goes red,
      so it surfaces within one merge cycle.
      **The underlying fix remains to thread `{ rel, abs }` through and compare on `rel`**, as
      `abandonmentIsShared.test.ts` and (since #847) `livenessTokenIsShared.test.ts` do.
      ⚠️ **Re-deriving the census: append `-- ":!*.md"` to both queries.** Run verbatim they also
      match this file — `§ Paths` quotes both patterns in order to describe them, and one of those
      lines is matched by BOTH spellings at once — so a naive re-run reads 36 sites / 33 files and
      looks like the class growing. It is not: code-only it is **34 sites / 32 files, unchanged
      since `a2ddf60f6`**. A session re-running them without the pathspec drew the wrong
      conclusion first, and nearly published it.
      - ⚠️ **"Exposed population is one" was wrong, and the reason is worth more than the number
        (#849, measured on the `win` clone 2026-09-07).** That census counted only the shape it had
        just been burned by — `path.relative()` output compared against a forward-slash literal.
        The other half of the class never involves a separator at all: **`abs` compared against a
        separately-derived ABSOLUTE path** (`path.join(REPO_ROOT, …)` from `fileURLToPath`, a
        `path.resolve`d TypeScript `fileNames` entry, `__filename`). Re-swept for both shapes, the
        exposed population is **nine files**, not one — including a `urlFor` body copied into four
        asset suites whose `startsWith` is case-SENSITIVE while `repoCorpus.mjs`'s own
        `toUnderPrefix` compares the same directory to the git root case-INSENSITIVELY.
        - ⚠️ **And the DENOMINATOR above ("39 call sites across 36 files") is also one spelling.**
          It counts `.map(({ abs }) => abs)` only; `.map((f) => f.abs)` adds **4 sites across 4
          files**, for a true population of **43 sites across 40 files** (re-derived at
          `ac546c720`, both `git grep -cE` queries). Caught by the close-out review of the very
          commit that added the correction above — i.e. the paragraph retracting a
          one-spelling census published a new one. The lesson generalises past this class: **a
          count over source is a claim about the QUERY, and the query belongs next to the
          number.** The four extra files — `migrate-anchor-zindex.mjs`, `docCitations.test.ts`,
          `projectDocs.test.ts`, `anchorZIndexMigrated.test.ts` — were swept and are all benign
          (a `.filter` on `rel` before the map, the safe `split(path.sep).join('/')` spelling,
          `path.basename` only, and a report-only string respectively).
      - ✅ **And the prescription above is WORKING — measured, after I first claimed the opposite.**
        Mutation-checking all nine (force the comparison to match nothing, i.e. reproduce a
        derivation split) gives **seven LOUD, two OPEN** — not the seven-open I asserted before
        measuring. The seven are loud for exactly the reason this section already gives: they pin
        non-vacuity. `codeAssetRefs` is the clearest case — its main assertion DOES go vacuous, and
        its reverse pin ("every PENDING_MIGRATION guid still fires") catches it anyway. The two that
        failed open, `mcpErrorCodes` and `editorStoreActionsReachable`, were exactly the two with no
        such pin; both now have one. **The lesson is not a new rule but the cost of asserting a
        blast radius from code-reading**: "fails open" is a claim about behaviour, and behaviour has
        to be run.
      - ⚠️ **`path.resolve` is not the escape hatch it looks like.** It normalises separators and
        trailing slashes but **not drive-letter case** — measured, `path.resolve('e:\\x') !==
        path.resolve('E:\\x')`. Comparing on `rel` sidesteps the whole question because no absolute
        path is in play; re-resolving an absolute one does not.
    - **Instance 4 is the exception.** `consoleRingOptionsWiring`'s `relPosix` SURVIVES and is live.
      Its two offender lists — the actual defect — now take `rel` from git, but the helper still
      serves individually-named fixed files and a BFS trail, which are not corpus enumeration. It
      is correct (the safe spelling, applied to `node:path` output), just not deleted.
    - The ~66 inline sites elsewhere are untouched **by design** — the ruling two bullets up.
    - ~~The guard covers only `engine/tests/**` + `engine/scripts/**`~~ — **CLOSED by #814
      (2026-09-06).** `corpusProducerIsShared` now enumerates the WHOLE REPO, with a per-root
      non-vacuity pin for each of `engine/tests/`, `engine/scripts/`, `engine/packages/modoki/tests/`,
      `engine/plugins/`, `engine/electron/`, `games/`, `site/` and `scripts/`, so a narrowing
      enumeration goes red instead of quiet. The widening reportedly found **18** producers
      outside the old scope (that figure is `corpusProducerIsShared.test.ts`'s own docblock, a
      point-in-time #814 count — carried here, not re-derived),
      not the 15 the issue estimated, and disproved one of its two headline examples:
      `scripts/scan-publish-safety.mjs` is **not** a rival corpus definition — it runs downstream of
      its own `git ls-files` manifest. ⚠️ **This bullet predicted the next instance would land in
      that gap. It did not** — instance 9 landed inside the region the bullet above called covered,
      and this one sent the #849 reader looking in a gap that no longer exists.

- **A path-valued field on a PERSISTED record is normalised by the module that owns the record, on
  READ as well as on write — never by each caller** (#849). `deviceClaimsStore.mjs` does this
  (`foreignClaimFor`, `ownAdbClaim`: `path.resolve(held.clone) === clone`); `buildClaimsStore.mjs`
  did not, and compared its stored `projectRoot` raw against a resolved argument, so an equivalent
  root spelled differently found no conflict and the build claim was granted twice. #847 patched
  that at the four test seed sites and left a comment asking the next author to remember
  `path.resolve` — which is the "fix that can be un-fixed" shape; the store now resolves both sides
  and there is nothing to remember. The two stores are otherwise deliberate twins, and
  `buildClaimsStore.mjs`'s header enumerates its three intended divergences — this was not one of
  them, which is exactly why it went unnoticed.

### Comparing two paths and MATCHING a foreign process's argv are different problems

Both look like "does this path equal that path", and the same fix does not serve them. Getting this
wrong is what #913 was.

**Comparing two paths we both produced** — `identityMismatch` against `process.cwd()`, a persisted
project root against a `__dirname` repo root. Both operands are ours, so canonicalise BOTH sides
and compare. That is what `pathIdentity.mjs` exists for, and `isUnderOrSame` / `samePath` are the
entry points.

**Matching a foreign process's argv** — every reap in `repo-reap.sh`, `stopDevServer`,
`packagedAppPaths`. One operand is the command line some other process was LAUNCHED with, and we
do not control its spelling. There is nothing to canonicalise on that side, so:

⚠️ **Canonicalising only our own side is strictly WORSE than doing nothing.** It fixes the
symlinked spelling and breaks the ordinary one that works today. The only correct shape is to
match a **set** of spellings — the clone's logical root (bash `pwd`) and its physical one
(`pwd -P`). `reap_repo_register_roots` registers both once and every reap in that file inherits it.

⚠️ **How far `pwd -P` gets you on Windows is UNMEASURED.** It is the right pair on POSIX (a symlink,
and `/var` → `/private/var` on macOS). Under Git Bash it resolves the MSYS path namespace, which is
not obviously the same thing as resolving a junction or a `subst`ed drive — those are
object-manager mappings Windows resolves at a different layer. Do not assume this pair covers them;
that is the `win` clone's to settle, and the Windows spellings are tracked separately.

⚠️ **Two sequential invocations, never an alternation.** `pkill -f` takes an ERE, so a pattern
built as `"$A|$B"` with either side empty collapses into one that matches **every process on the
machine** — the #69 disaster, reintroduced by the fix meant to prevent it. `reap_alt_pattern`
therefore prints *nothing* rather than a fallback, and refuses unless both roots are set, they
differ, the physical one is absolute, and the pattern is genuinely under the logical root (a bare
prefix test would rewrite a SIBLING clone's path — clone names here are prefixes of each other).

**This closes one direction only.** Both spellings are still ours, so stop-via-link/launched-real
is covered and a process launched by something that derived a third spelling is not. The
structurally complete fix is to export the physical root at launch so every child carries the
canonical spelling — ⚠️ **not done on purpose**: `editorPorts`' `backendPortForClone` keys off the
clone DIRECTORY NAME, so a link whose basename differs from its target's would silently move the
clone to auto ports (#349's class).

**And the identity refusal is two properties, not one.** `identity.ts` declines the SSOT with a
correct argument about case-FOLDING (`/a/B` must not sit inside `/a/b` on case-sensitive Linux).
That says nothing about REALPATH, which `canonicalPath` does without folding. Do not read the one
refusal as covering both — and do not "simplify" the result to `samePath`, which reintroduces the
fold. ⚠️ Order matters: normalise separators and the drive case FIRST, then canonicalise, then
normalise again — `path.resolve` is platform-specific, so on POSIX a Windows-shaped
`E:\Projects\x` is not absolute and gets anchored under the cwd, after which the drive letter is
no longer leading and cannot be folded.

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

### `powershell -Command "<script>" a b` does NOT pass `a b` as arguments

It **appends them to the command line as more source**. `$args` is empty, and the trailing items
are re-parsed by the PowerShell parser. This is not a quoting bug you can escape your way out of;
it is the wrong channel. Measured on `win` (#875):

| invocation | `$args` |
|---|---|
| `-Command <script> p1 p2` | **empty** — and `p1 p2` are executed as statements |
| `-Command "& { <script> }" p1 p2` | binds — but see below |

`moveToTrash` shipped the first form for months. Three consequences, in the order they bite:

1. **`foreach ($p in $args)` iterated zero times**, so the editor's "move to Recycle Bin" recycled
   *nothing* on Windows, ever.
2. **A path with a space splits.** `…\a file.json` became `…\a` + `file.json`, so the `& { }`
   "fix" would have deleted `…\a` — a path the user never selected. **Binding `$args` is not the
   fix**; it converts a no-op into a wrong-target delete.
3. **A FILENAME can execute.** A legal NTFS name containing `; <statement>` ran that statement
   (verified with an inert payload, exit 0, no error). The name need not be typed by anyone — it
   can arrive in a downloaded asset pack or a cloned project.

**The rule: data never travels on a PowerShell command line.** Put it on **stdin** (or an env
var) and read it inside the script. `osascript -e … p1 p2` genuinely does bind argv (`on run
argv`), which is why the macOS branch was correct and the comment claiming both were safe was
half wrong — do not generalise from the mac side.

Two traps in the replacement, both of which cost a measurement here:

- ⚠️ **A .NET exception inside a PowerShell loop is NON-terminating: the script keeps going and
  still EXITS 0.** So `execFileSync` does not throw and the caller reports success for work that
  did not happen. This bit twice in one change — the fixed `moveToTrash` recycled the good paths,
  wrote nothing for the bad one, and `/api/delete-asset` returned `{ok:true}`, unbound the asset
  in the renderer and rebuilt the manifest for a file still on disk. Measured: one bad path among
  two good ones exited 0.

  **Count failures and `exit` non-zero.** ⚠️ Do *not* reach for `$ErrorActionPreference = 'Stop'`
  instead — it reports the failure but abandons every remaining path, converting one bad file
  into a half-applied batch. `try`/`catch` per item keeps the batch going *and* reports:

  ```powershell
  $failed = 0
  foreach ($p in $paths) { try { … } catch { $failed++; [Console]::Error.WriteLine("FAILED $p") } }
  if ($failed -gt 0) { exit $failed }
  ```

  The general form of the trap: **the loud failure is the lucky one.** The broken version of this
  code failed loudly *by accident* (the path ran as a command and exited 1); fixing the real bug
  removed the accident and left a silent one behind. When a fix removes an incidental error path,
  check what was relying on it.
- ⚠️ **`[Console]::In` decodes through the console's CODE PAGE.** On a dev box already at 65001
  everything works and the guard looks like dead code; on a default en-US (437) or ja-JP (932)
  console the UTF-8 bytes are mangled, the path matches nothing, and the file **silently
  survives** — exit 0, nothing thrown. Set `[Console]::InputEncoding` to UTF-8 *before* the read.
  A mutation check on a 65001 machine will tell you the line is unnecessary; it is lying to you,
  and the only way to see it is to force a legacy code page (`GetEncoding(437)`) in the test.
- **`[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile` throws `Could not find file` on a
  directory.** Folders need `DeleteDirectory`. Branch on `Test-Path -PathType Container`.

⚠️ **This was a singleton, not a class** — a sweep found the repo's four other PowerShell call
sites (`packagedAppPaths.mjs`, `stopDevServer.mjs`, `toolchain/index.ts`, `buildStepShell.test.ts`)
all interpolate their values into the script string and pass no trailing args. Do not "fix" them.

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

Then ask **which Windows**. The hosted runner and a real dev box differ in ways that decide tests:
the runner's `%TEMP%` arrives **8.3-shortened** (`C:\Users\RUNNER~1\…`), because the account name
`runneradmin` exceeds 8 characters, while a box whose account name fits (`C:\Users\dev\…`) is
already the long form. A canonicalisation test can therefore be red on `ci/main` and green on the `win` clone
forever. ⚠️ **"Green on the win clone" is not evidence about CI, and the reverse holds too** — #878
was invisible on real Windows hardware and reproduced on every runner.

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
