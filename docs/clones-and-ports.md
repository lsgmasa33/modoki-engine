# Clones & ports

The full multi-clone/multi-machine setup — the clone table, the sync recipes, and the reasoning
behind the two rules that make several independent clones share one machine without colliding.
`CLAUDE.md` keeps only the compact clone table and the two rule headlines; this doc carries the
setup recipe and the "why" behind each rule.

## The setup

Multiple **independent clones** of the same GitHub repo, each pinned to its own branch — four on
this Mac plus one on a Windows machine. They are NOT git worktrees — each has its own `.git`, its
own object store, and its own history. Handoff between them goes **through the remote**
(`origin` = `https://github.com/lsgmasa33/modoki.git`), not through a shared `.git`.
`~/Projects/modoki` is the **integration hub**: it stays on `main` and merges the worker branches
in (little direct dev happens here).

| Directory | Branch | Role |
|-----------|--------|------|
| `~/Projects/modoki` (Mac) | `main` | **Integration hub** — merges the worker branches into `main` |
| `~/Projects/modoki-ai` (Mac) | `work-ai` | AI workspace (standalone clone) |
| `~/Projects/modoki-ai2` (Mac) | `work-ai2` | AI workspace (standalone clone) |
| `~/Projects/modoki-ai3` (Mac) | `work-ai3` | AI workspace (standalone clone) |
| `~/Projects/modoki-qa` (Mac) | `work-qa` | **QA workspace** — owns `qa/cases/**` and the Modoki Testboard (repo `modoki-testboard`, deployed to Cloud Run) |
| Windows machine | `win` | Windows workspace (standalone clone) |

Set up a fresh second clone:
```bash
git clone https://github.com/lsgmasa33/modoki.git ~/Projects/modoki-ai
cd ~/Projects/modoki-ai && git checkout work-ai && npm install
```
(`node_modules` is gitignored, built per-clone — see RULE 1.)

## Sync commands (via the remote — the deliberate handoff point)

The remote branch IS the "it's ready" signal. Only pushed commits cross between clones — never
reach into the sibling directory's working tree.

**Publish this clone's finished work:**
```bash
# From ~/Projects/modoki-ai (work-ai) — push when a commit is done + tested
git push origin work-ai
```

**Pull the other clone's published work:**
```bash
# From ~/Projects/modoki (the main hub): integrate a worker branch after it's pushed.
# ONLY these five are mergeable: work-ai · work-ai2 · work-ai3 · work-qa · win.
# Any other remote branch is a stray — ask the owner before touching it.
git fetch origin && git merge origin/work-ai      # or origin/work-ai2, origin/work-ai3,
                                                  #    origin/work-qa, origin/win

# From a worker clone (e.g. ~/Projects/modoki-ai on work-ai): pull main updates
git fetch origin && git merge origin/main
```

### Who resolves a conflict — the worker, before it pushes

**A conflict belongs to whoever has the context.** Measured 2026-09-01 over the last 40 hub merges:
**24 needed manual resolution**, and every one was resolved on `main` by the clone that wrote
neither side. The top conflict sources were `.agent-memory/MEMORY.md` (10 — now generated, so this
class is gone), `games/court/runtime/systems.ts` (6) and `engine/app/debug/agentBridge.ts` (3).

The cause is drift: workers were running far behind main (`work-ai` 52 commits, `work-ai2` 25,
`win` 475), so every worker's `npm run verify` was green against a stale engine, and the first time
the two sides met was on `main` in front of the person least able to judge them.

So the last step before a push is:

```bash
# From a worker clone, immediately before pushing:
git fetch origin && git merge origin/main
npm run verify          # ← NOT optional: see below
git push origin <branch>
```

⚠️ **For a worker, merging main IS re-testing.** `CLAUDE.md`'s "merging is not re-testing" is about
the HUB receiving work a worker already verified. It inverts here: pulling main in runs *your* tests
against everyone else's engine changes for the first time, and that combination has never been
tested by anyone. Merge at **push time** only — `/close-out` is already the push trigger, and five
clones re-verifying on every main update is a real cost multiplier.

⚠️ **Being fully current with main is NOT a precondition for pushing.** With six clones, main can
move between your merge and your push. The hub merge is still there as the fallback, which makes a
stale merge base harmless rather than a race nobody can win — do not loop trying to win it.

Two things this also buys, beyond cheaper conflicts:
- **A worker receives a privacy scrub instead of re-leaking around it.** A branch forked before a
  scrub still carries the real value, and git presents it as the newer side; merging main in takes
  the scrubbed version.
- **It manufactures the fast-forwards** that let the hub skip `verify` (next section).

### The hub skips `verify` on a fast-forward — but never `verify:publish`

```bash
# From the hub, before merging:
git fetch origin
git merge-base --is-ancestor HEAD origin/work-ai && echo "fast-forward — verify can be skipped"
```

A fast-forward means main's HEAD was already an ancestor of the branch tip, so the merged tree is
**byte-identical** to the tree the worker verified at close-out — nothing of main's is new to the
branch, so there is no untested combination and `verify` would re-test the same bytes.

⚠️ **`npm run verify:publish` still runs EVERY time, fast-forward or not.** A worker never runs it,
so the hub is the *only* place a private value (Apple Team ID, real device UDID, internal `gs://`
bucket) is caught before it reaches a PUBLIC repo — twice a leak has ridden a worker branch this
far. A fast-forward carries a leak exactly as happily as a merge commit. It scans the WORKING TREE,
so it answers about what you are about to push, not about HEAD.

Three bounds on the saving, so it is not oversold:
- **Only the FIRST merge of a batch can be a fast-forward.** Once it lands, main has moved and the
  next branch is behind again.
- **It fires only because of the rule above.** With workers never merging main in, **0 of the last
  9 hub merges were fast-forwards** — the skip would have applied zero times.
- **A fast-forward proves the trees match, not that the tip was verified.** It cannot tell that a
  commit was pushed *after* a green close-out. That is the worker's discipline, not something the
  hub can check.

## The two concrete rules (everything else follows from these)

Each clone is a fully independent repo that happens to share one machine. Nothing in git
collides — separate `.git`, separate working trees, separate branches. Only two classes of
**machine** state collide: **build state** (`node_modules` + gitignored `dist/`, built
per-clone) and **ports** (the editor backend + Vite). Follow these two rules and running several
clones at once just works.

### RULE 1 — Each clone installs AND builds its own deps

After `git clone`, or after any pull/merge that touches a `package.json` / lockfile, run:
```bash
npm install                                          # does the FULL setup (see below)
```
The root `postinstall` chains the whole setup, in this order: `build:plugins` (engine native
plugins → gitignored `dist/`), then **`bootstrap-mcp-deps.mjs`** (the sole owner of
`engine/tools/*` — the MCP servers), then **`bootstrap-game-deps.mjs`**, which for every project
that owns sub-packages to LINK (`workspaces`) **or declares dependencies to INSTALL** runs
`npm install` AND its `build:plugins` (when it defines one — projects with no native plugins are
skipped). So a plain `npm install` is now sufficient; you do NOT run per-game `ci`/`build:plugins`
by hand anymore.

⚠️ Neither bootstrap script skips a folder because its `node_modules` already exists. That
shortcut reads as free idempotence and is the **#215 failure**: a folder present but STALE (a
dependency added since the last install) makes "already installed" true and wrong. Measured on
one clone — both MCP tools had drifted from their committed lockfiles behind exactly that skip.
npm is cheap when the tree is satisfied, so re-running it is the honest check.

⚠️ That second condition (declares dependencies to install, even with no `workspaces`) is #215,
and it covered **14 more projects** (6 → 20). The test used to be `workspaces` alone, which
silently skipped every project with real deps but no sub-packages — so a fresh clone got no
`node_modules` for `games/court`, `games/sling`, every demo, and 11 others, and their native
builds died at package resolution on a `Package.swift` that correctly points at the project's OWN
`node_modules`. It is also why `cap sync` was seen rewriting that file into a portability
violation: with the package missing locally, Capacitor resolves it to the repo root and writes an
escaping path. The selection rule lives in `engine/scripts/projectNeedsInstall.mjs`, guarded by
a test that sweeps every real project — a project added later with deps and no `workspaces`
cannot reintroduce it silently.

**Why this matters:** the engine plugins and each game's capacitor plugins ship their JS only in
a **gitignored `dist/`**. A missing `dist/` is exactly what makes `npm test` / the editor fail
with `Failed to resolve import "capacitor-adjust"` — the `file:` deps are linked but their
`dist/` isn't built yet (commit `1a22a9f`). The per-game build is safe inside `postinstall`
because each game's `npm install` runs as a *completed child process* before its `build:plugins`
is invoked, so the `.bin` (incl. rollup) is already linked — sidestepping npm #4828, which only
bites a build run from the *same* install's postinstall.

### RULE 2 — Each clone gets a fixed, distinct editor backend port

The Vite and CDP ports are DERIVED from it so every clone runs in its own lane. The launcher pins
the backend (the MCP target) so it's stable per session, then sets Vite to
`5173 + (backend − 5179)` and CDP to `9222 + (backend − 5179)`.

**You no longer pass the port — the launcher derives it from the CLONE DIRECTORY** (#349).
`engine/scripts/launch-editor.sh <project>` gives you *this* clone's lane in every clone; the
`MODOKI_BACKEND_PORT=…` prefix still works and still wins, but it is an override, not a
requirement. The table is authored in **`engine/scripts/editorPorts.mjs`**, which is the single
source of truth every launch path reads — this table is checked against it by
`engine/tests/architecture/editorPorts.test.ts`, so the two cannot drift.

| Clone | Backend port | Vite | CDP | Launch command |
|----------|-------------|------|------|----------------|
| `~/Projects/modoki` (main) | 5179 | 5173 | 9222 | `engine/scripts/launch-editor.sh games/3d-test` |
| `~/Projects/modoki-ai` (work-ai) | 5180 | 5174 | 9223 | `engine/scripts/launch-editor.sh games/3d-test` |
| `~/Projects/modoki-ai2` (work-ai2) | 5181 | 5175 | 9224 | `engine/scripts/launch-editor.sh games/3d-test` |
| `~/Projects/modoki-ai3` (work-ai3) | 5182 | 5176 | 9225 | `engine/scripts/launch-editor.sh games/3d-test` |
| `~/Projects/modoki-qa` (work-qa) | 5183 | 5177 | 9226 | `engine/scripts/launch-editor.sh games/3d-test` |

⚠️ **A KNOWN clone reached by a second spelling used to land here too, which is a bug and not the
deliberate part** (#881). `backendPortForClone` took `path.basename(path.resolve(root))` and looked
it up case-SENSITIVELY, so `E:/Projects/MODOKI`, a `subst`ed drive, or a clone reached through a
symlink or junction found no key, returned `null`, and fell into the auto-port path below —
producing #349's symptom from a different cause, and producing it **silently**, since a clone
legitimately absent from the table looks identical from here. It now canonicalises with
`canonicalPath` and falls back to a `pathCaseKey` lookup; both halves are needed, because `.native`
cannot normalise a directory that does not exist yet. See docs/windows.md § Paths.

⚠️ **A clone directory not in that table gets AUTO ports, not a pinned one** — deliberately. Any
hardcoded fallback is correct on exactly one clone and silently wrong on the rest, which was the
#349 bug: `launch-editor.sh` defaulted to **5179, the hub's port**, so a bare launch from a worker
clone aimed at `main`'s lane. Auto ports can't collide with anyone's pinned lane; the launcher
warns on stderr and the banner tells you what it actually bound. A scratch clone that wants a
stable MCP target should pass `MODOKI_BACKEND_PORT` explicitly. **CDP stays ON** for such a launch,
on a port HASHED from the repo path via `clonePort.mjs` (9240–9279 — clear of the 9222–9226 human
lane and of the `chrome-devtools` MCP). Not 9222: that is the *hub's* CDP port, so beside a live hub
the banner would advertise a port the scratch clone could not bind and an agent aiming there would
drive the hub's renderer — #349 relocated from the backend port to CDP. Only `MODOKI_MULTI` turns
CDP off, because there several editors of one clone would race a single port.

**The Windows machine is not in the table and does not need to be** — it holds exactly ONE clone
(owner, 2026-08-26), so nothing there can collide whatever the directory is called. If its directory
is `modoki` (the default `git clone` name) it simply reads as the hub row; otherwise it takes the
unknown-clone path above — no pinned backend, `main.ts`'s sticky-then-scan settles on 5179, and CDP
lands in the hashed block. Either way it keeps a working editor and a working CDP.

The CDP column is the launcher's DERIVED default. On the main Mac the `editor-*` shell functions
in `~/.zshrc` override it to the **932x** series (main 9322 / ai 9323 / ai2 9324 / ai3 9325 / qa
9326) so an attached CDP client can't land on 9222/9223, which the `chrome-devtools` MCP already
uses. A clone's `.claude/settings.local.json` sets the same value, so both launch paths agree —
when they disagree, whichever launched the editor wins, so read the launch banner.

**Only the BACKEND port is a fail-loud contract** (it's the MCP target). The Vite port is a
PREFERENCE: if it's taken the editor still boots on an ephemeral port and the launch banner tells
you (`Editor page: … (wanted 5173 — it was taken)`) — so trust the banner, not the table, when
they disagree. Why the derivation exists, and why a "free-looking" port may not be:
[editor.md](./editor.md) § "Port selection".

(`npm run editor:dev` is the npm shortcut, in **every** clone — it derives the port like the launcher
does. The clone-named `editor:main` / `editor:ai` / `:packaged` twins were DELETED in #349: once the
directory decides the port they all did the same thing, and a script named after one clone in a repo
every clone shares is the same category of mistake as the port default they used to carry.
`npm run editor` adds branch reporting and a project-dir default. The `editor-main`/`editor-ai`/
`editor-ai2`/`editor-ai3`/`editor-qa` shell functions in `~/.zshrc` are unaffected — they invoke
`launch-editor.sh` directly, and additionally pin CDP to the 932x series so it cannot collide with
the `chrome-devtools` MCP's 9222.)

Then point that session's MCP at its own backend: `MODOKI_BACKEND=http://127.0.0.1:<port>`.
`launch-editor.sh` / `stop-dev.sh` are **repo-scoped** — they match THIS repo's absolute paths
and never touch the sibling clone's editor (commit `afed79f`). To run SEVERAL editors inside ONE
clone, use `MODOKI_MULTI=1 engine/scripts/launch-editor.sh` (auto-picks every port, skips the
single-instance cleanup).

Point that session's MCP at its own backend via `MODOKI_BACKEND` in the gitignored
`.claude/settings.local.json` — **`.mcp.json` is COMMITTED, so hardcoding a port there re-aims
every other clone at yours.**

## Rules

- Keep each clone on its own pinned branch by convention (modoki → `main` (the hub), modoki-ai →
  `work-ai`, modoki-ai2 → `work-ai2`, modoki-ai3 → `work-ai3`, modoki-qa → `work-qa`, Windows →
  `win`). Nothing enforces this now — they're independent repos — so don't rely on git to stop a
  mistaken checkout the way it did with worktrees.
- Both can work simultaneously; **commits only cross between clones via the remote**
  (`git push` then `git fetch`/`merge`). A local commit in one clone is invisible to the other
  until pushed — this is the deliberate handoff, not a limitation.
- Conflicts are resolved at merge time, after a fetch.
- **Never run a bare `pkill -f vite` / `pkill -f electron` or `/api/exit` on a shared port** — it
  kills the other clone's editor too (same machine). Use the repo-scoped `launch-editor.sh` /
  `stop-editor.sh` (`npm run editor:stop`) / `npm run dev:stop` only. The same rule binds
  SCRIPTS: any reap must match an **absolute** path (this repo's, or the app dir it was handed),
  never a product name or a relative fragment like `engine/electron/dist/main.cjs` — every clone
  shares those. `test-packaged.sh` violated this until #69, which is why it's now **enforced**
  rather than merely written down: `engine/tests/architecture/reapScoping.test.ts` fails any
  `pkill -f` pattern in `engine/scripts/**` that isn't anchored to `/` or `$`.
  ⚠️ **An absolute path is not the same as THE path, and #908 is that gap.** A repo-scoped reap
  compares a marker it built from its own spelling of the clone root against the command line a
  running process was LAUNCHED with — and only one of those two sides is ours. `path.resolve` does
  not resolve symlinks, so a clone reached through a link built a marker with the link spelling
  while the server's command line carried the target spelling, and `dev:stop` matched nothing.
  So: **build the marker through `engine/scripts/pathIdentity.mjs`** (`canonicalPath`), and match
  on BOTH spellings, because canonicalising our side alone breaks the case that already worked.
  ⚠️ **Even then it covers one direction only.** Every spelling a reap holds comes from its own
  invocation, so stopping through the link while the server was launched by the real path is still
  a miss — closing that means canonicalising a path extracted from a foreign `argv`, a
  quoting-sensitive parse over a path that may contain a space. Which is why the second half of the
  rule matters more than the first: **a reap that matched nothing must SAY so.** `dev:stop` printed
  the same `Done.` and exit 0 for "killed it" and "found nothing", so a miss read as success and the
  failure presented as *the app is broken* rather than *nothing was stopped* (#129's framing,
  #908's instance). Pinned by `engine/tests/architecture/devStopPathIdentity.test.ts`, which drives
  the real script against a FAKE repo root in a tmpdir — pointing it at a real checkout would reap
  a developer's own dev server as a side effect of testing it.

  ⚠️ **Since #961 `launch-editor.sh` LAUNCHES canonical** — `$REPO` is `pwd -P`, so everything it
  spawns carries the physical spelling in its `pwd` and its argv, and any stopper matches whatever
  spelling it derived. `stop-editor.sh` is unchanged; the two are asymmetric on purpose, because
  only one of them spawns anything.

  ⚠️ **But the launcher's own REAP PATTERNS are still built from the LOGICAL root, and that is
  load-bearing — do not "tidy" them to `$REPO`.** `reap_alt_pattern` DERIVES the second spelling,
  and it can only do so for a pattern under the root it was registered with (`case "$1" in
  "${MODOKI_REAP_ROOT}"/*`). Hand it a physical pattern against a logical registered root and it
  prints nothing: the second reap is skipped, and an editor still running with the LOGICAL spelling
  in its argv survives the pre-launch sweep, keeps the pinned backend port, and the launch then
  times out. #961's first version did exactly that and every gate stayed green, because the two
  spellings are equal on an ordinary clone. The split to hold in your head: **what we SPAWN is
  canonical; what we MATCH starts from the logical root**, because a reap matches a foreign
  process's argv — a string we do not control, which may carry either spelling. Pinned by
  `editorPorts.test.ts` § "builds its reap patterns from the LOGICAL root".

  Two things that look like consequences of that change and are not:
  - **No pinned port moves.** `backendPortForClone` has canonicalised with `fs.realpathSync.native`
    before taking the basename since #881, so a clone reached through a link named anything at all
    still answers the port its REAL directory name is pinned to in the table above — pinned by
    `editorPorts.test.ts` § "resolves a clone reached through a SYMLINK". **The fear that it would
    is what deferred #961 for a month; it was never true.**
    ⚠️ Deliberately phrased without a `~/Projects/<clone>` + port pair: the guard that keeps this
    file honest parses any such line as a RULE 2 table row, and an earlier draft of this very
    paragraph reddened it. Prose about the table must not look like the table.
  - **The HASHED lane converges rather than moving.** `defaultRepoRoot()` is already physical (Node
    realpaths `import.meta.url`), so the launcher passing bash's logical `pwd` DISAGREED with every
    other caller of that hash (measured through a symlinked clone: 9249 from the launcher, 9254
    everywhere else). Passing the physical spelling removes that divergence. `clonePort.mjs` may
    import nothing but `node:` builtins, and that restriction still holds.

    ⚠️ **On Windows the physical spelling was not enough, and `clonePort` now normalises.** Git Bash
    hands `$REPO` to `node` as an argv token and MSYS rewrites the drive in transit
    (`/e/Projects/modoki` → `E:/Projects/modoki`) while leaving the separators — so the launcher
    hashed `E:/…` and every in-process caller `E:\…`. Measured on `win`: **9268** from the argv
    spelling, **9254** from the native one — one directory, two keys, depending which side of the
    bash→`node` seam you asked. `clonePortOffset` therefore hashes
    `path.normalize`'d input (trailing separator folded, never past the root). On POSIX that is a
    no-op for a clean absolute path, so no Mac/Linux port moved. It deliberately does NOT map
    `/e/…` → `E:\…`: that needs MSYS's mount table, and `/e/Projects` is an ordinary directory on a
    real POSIX box.

    ⚠️ **Latent, not live — and the first version of this entry got that wrong.** It said the launch
    banner advertised a debug port no tool would aim at. It did not. `unpinnedCdpPort` has exactly
    one caller (`launch-editor.sh`'s `cdp-unpinned`), reached only when `BACKEND_PORT` is empty —
    never on a clone whose basename is a row in the table above, which `modoki` is — and even in the
    unpinned case the same `$CDP_PORT` is handed to Chromium AND printed, so the banner cannot
    disagree with what binds. The 9268 was produced by running the CLI by hand, and the consequence
    was narrated rather than observed. Every hashed lane (9240, 38600, 38900, 38800, 38173) derives
    on only ONE side of its seam today. The fix is worth having because the next consumer to read
    both sides is then correct by construction — not because anything was broken.

    ⚠️ **The guard could not have caught this, and that is the transferable part.** It hashed
    bash's string IN-PROCESS, skipping the argv rewrite the launcher actually goes through — so it
    agreed with the product on macOS by coincidence. It now drives the real CLI. Re-typing the
    normalisation into the test instead would have been worse: the test would assert its own copy,
    and `clonePort` could lose the fix and stay green.

  ⚠️ The launch banner therefore prints the PHYSICAL path and `CLONE_NAME` is the physical
  basename. Deliberate: that is the name the port table keys on, so banner and port derivation now
  name the same directory.

  **Where the shared helper cannot reach, the two spellings are written OUT — and that is
  deliberate, not laziness** (#959). `lib/repo-reap.sh` registers the clone's logical and physical
  roots once (`reap_repo_register_roots`) and every caller inherits them, so most reaps never think
  about this. Two sites cannot use it: `packagedAppPaths.killPackaged`, whose pattern is built from
  a **caller-supplied** app dir (five callers), and `test-packaged.sh`, which reaps a fragment of
  the clone root directly.
  - `killPackaged` canonicalises its argument **inside** the function (`altPathSpelling`, which is
    `reap_alt_pattern`'s contract in JS — `realpathSync.native`, never the JS walk, per #881) and
    issues one `pkill` per spelling. Inside rather than at the callers, because a missed caller is
    a silent partial fix — the same reasoning that made the bash helper inherit rather than take an
    argument.
  - `test-packaged.sh` spells both patterns **inline**, as two `${VAR:?}`-led literal lines.
  - **A third site joined them in #988**: `engine/toolchain/index.ts`'s `forceRemoveDir` sweep, whose
    dir is likewise caller-supplied. Rather than a fourth copy of the alternate-spelling contract,
    `altPathSpelling` moved to `engine/scripts/pathIdentity.mjs` (the path-identity SSOT);
    `packagedAppPaths.mjs` re-exports it, so nothing there changed.
    ⚠️ **`engine/toolchain/` cannot import `packagedAppPaths.mjs` at all** — that module evaluates
    `fileURLToPath(import.meta.url)` at module scope, and esbuild emits `import_meta = {}` in the
    bundled Electron main, so the import would throw at load. A leaf shared with the toolchain must
    have no `import.meta.url` and no module-scope side effects.
    ⚠️ **The width guard stays the CALLER's** and `altPathSpelling` deliberately does not apply one:
    a long path can be a link to a very short real one, and an unchecked alternate widened a kill to
    `StartsWith('C:\')` once (#958 row 3). `killPackaged` requires `>= 10`; `forceRemoveDir` mirrors
    it in `sweepAlt`, which exists as a named function precisely so a test can reach the guard.
    ⚠️ **It must not route through `reap_alt_pattern`**, which is the obvious move:
    `reapScoping.test.ts` rule 3 rejects a variable-led `pkill` pattern that is not `${VAR:?}`
    -guarded, and `${ALT:?}` is *wrong* here because an EMPTY alternate is the normal case (no
    symlink) and would abort the gate on every ordinary run. Migrating would also delete the one
    line rule 1 can see and move the safety inside a helper the guard cannot resolve — a coverage
    loss disguised as a refactor.

  **Two `pkill` calls, never `pkill -f "$A|$B"`.** The pattern is an ERE, so an alternation with
  either side empty matches every process on the machine — #69's disaster reintroduced by the fix
  meant to prevent it. Guarding the operands is not enough; the shape has to be incapable of it.

  **And the reap says which of THREE things happened.** `pkill` exits 0 (signalled), 1 (no match)
  or ≥2 (usage/fatal), and `killPackaged` used to flatten all three into one silent `catch` — so a
  usage error read as "nothing was running", which is why every bash caller's `|| true` became
  structural (#944). It now returns `killed`/`none`/`error`; `exit 0` stays right for all three,
  but the caller can tell. On Windows `Stop-Process -EA SilentlyContinue` always exits 0, so
  `winKillCommand` emits the matched **count** on stdout to carry the same distinction.
  ⚠️ **A verdict nobody can hear is not a verdict — and the first version of this shipped one.**
  The ERROR line went to STDERR while all five bash callers invoke the CLI as
  `node "$PATHS" kill … 2>/dev/null || true`, so the two harmless outcomes printed and the alarm
  was discarded by every consumer that exists. It goes to **stdout**. Before adding a third
  outcome anywhere, check which stream the callers actually read.

  ⚠️ **The two platforms have incompatible exit-code vocabularies, so they decode separately.**
  `pkill` exits 1 for "no match"; `powershell.exe -Command` exits 1 for a TERMINATING error. One
  shared catch mapped both to "nothing running", which put #944's silence back on the Windows
  branch. The win32 path decodes its own count and treats any non-zero exit — and any unparseable
  count — as an ERROR.

  ⚠️ **A caller that discards the outcome re-creates the bug one level up**, and two did:
  `assert-app-csp` (where a reap that did not run IS the cause of the silent CDP-bind failure the
  file exists to avoid) and `clean-packaged-cache` (which then wiped a LIVE app's userData). Both
  now read it.

  Pinned by `killPackagedGuard.test.ts` (a manufactured symlink, each `altPathSpelling`
  precondition yielding NOTHING rather than something wider, the alternate clearing the same width
  guard as the argument, the ERROR stream, and the win32 decode) and by `reapScoping.test.ts`
  rule 4, which fails any fragment reaped under only one root variable.
- **Serialize on-device builds** — only one clone at a time should install/launch on a given
  physical device (iPhone Air, Samsung); they share the hardware. **Now ENFORCED, not merely
  written down** (#149): a device is claimed machine-wide in `~/.modoki/device-claims.json`
  (beside `editor-launches.log`, and machine-wide for the same reason) by the lease and by the
  WebDriverAgent launch, and a second clone is refused with the holder NAMED — clone, branch,
  pid, since when. Claims expire on pid-death OR a 12h TTL — either alone is sufficient, so a
  crashed session never holds hardware hostage. `device_list` shows what is attached and who has
  it (read IT, never the raw claims file — #225).
  ⚠️ **That enforcement covered the MCP path ONLY, and #285 extended it to the CLI.** `adb`,
  `xcrun devicectl`, `xcodebuild -destination`, `ideviceinstaller` and go-ios never consulted the
  claim, so the rule ("claim first, even for raw adb work") had no enforcement — and it lapsed
  exactly as #18's `git add -A` hazard did, once device work became routine. Two things now hold
  it up: **`npm run device:claim|release|list|run`** (`engine/scripts/device.mjs`), which takes
  the same machine-wide claim from any terminal or agent CLI, and a **Claude Code `PreToolUse`
  hook** (`engine/scripts/claim-guard.mjs`, registered in the committed `.claude/settings.json`)
  that refuses a **destructive** raw device command unless this clone holds the device —
  including when NOTHING holds it. Read-only calls stay allowed. The hook reaches only a Claude
  session's Bash tool in this repo, and **fails OPEN if its path breaks**, so it is a backstop for
  the discipline, not a replacement for it.
  ⚠️ **"Is this claim mine?" is ONE comparison, `sameClone` — and it was four copies until #865.**
  `foreignClaimFor`, `ownAdbClaim`, `claim-guard.mjs`'s `heldByThisClone` and `device.mjs`'s
  WiFi-claim filter each hand-rolled it, in three different normalisations, and none of them
  checked that the STORED path was rooted in a way `path.resolve` could finish without consulting
  `process.cwd()`. On win32 `path.isAbsolute('/Projects/modoki')` is `true` and `resolve` re-roots
  it onto the cwd's drive, so a stored `"."`, `""` or another platform's `/Projects/...` silently
  became THIS clone. `foreignClaimFor` returns `null` for *"not foreign, it's mine"*, so that
  failed **OPEN**: the clone proceeded against a phone a sibling held, and `claim-guard.mjs` — the
  backstop — failed the same way at the same moment. **Polarity is now REFUSE** (owner,
  2026-09-07): an unrecognisable stored path matches nothing. The accepted cost is that a corrupt
  `~/.modoki/device-claims.json` can block this clone's own builds until it is deleted by hand.
  ⚠️ **The second half of #865 is NOT Windows-only, and it fails the other way.** `device.mjs`
  records `clone: repoRoot` with `findRepoRoot` **realpathing** it, while `vite-asset-scanner.ts`
  calls `foreignClaimFor`/`ownAdbClaim` with no `clone` at all — so the own side was a bare
  `process.cwd()`. Through a symlinked, junctioned or `subst`ed checkout the two spell one directory two ways
  and the editor's build path refuses this clone its OWN phone. `canonicalClonePath` now carries
  the realpath for every caller — via **`fs.realpathSync.native`**, which is load-bearing and not
  a detail: see `docs/windows.md` § Paths, the JS walk resolves neither `subst` nor drive-letter
  case. `claim-guard.mjs` had documented that reasoning and done the
  realpath; the two it pointed at had not, which is the drift that got #865 filed.
  ⚠️ **#865 left a residue, closed by #869: `sameClone` kept comparing with `===`.** The
  canonicaliser was right and the COMPARATOR was not — `.native` throws for a path that does not
  exist, so the fallback was bare `path.resolve`, which folds no case at all. **A stale claim
  entry naming a deleted directory is precisely that case**, and it is the case this predicate is
  most often asked about. It now compares through `samePath`
  (`engine/scripts/pathIdentity.mjs`), the ONE "same directory?" implementation — which the repo
  had hand-rolled **eight** times in four inconsistent recipes.
  ⚠️ That residue had **no test**: a mutation check reverting the comparison stayed green,
  because every existing case used a path that EXISTS, where `.native` already repairs the drive
  letter. Pinned now. The lesson generalises — when a fix has a "…except when the path is
  missing" clause, the test set almost certainly only covers paths that exist.
  Detail: [debug-tools-mcp.md](./debug-tools-mcp.md) § "Several phones attached".
- **Several phones of the SAME platform? Say which one.** Every adb call on the device surface is
  now `-s <serial>`-targeted, resolved ONCE when the lease opens and reused by the CDP tunnel and
  the screenshot — so `device_connect {useAdb:true, serial:"…"}` (or the AI panel's device
  picker) is how you pick, and an ambiguous choice is refused with every candidate named rather
  than driving whichever phone adb lists first. `MODOKI_ANDROID_SERIAL` pins it. Same doc section.
- **MCP approval is per-clone** — `.claude/settings.local.json` is gitignored, so each clone's
  Claude gets a fresh `modoki` pending-approval prompt on first run.
