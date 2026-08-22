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
`5173 + (backend − 5179)` and CDP to `9222 + (backend − 5179)`. Use the port assigned to the
clone:

| Clone | Backend port | Vite | CDP | Launch command |
|----------|-------------|------|------|----------------|
| `~/Projects/modoki` (main) | 5179 (default) | 5173 | 9222 | `engine/scripts/launch-editor.sh games/3d-test` |
| `~/Projects/modoki-ai` (work-ai) | 5180 | 5174 | 9223 | `MODOKI_BACKEND_PORT=5180 engine/scripts/launch-editor.sh games/3d-test` |
| `~/Projects/modoki-ai2` (work-ai2) | 5181 | 5175 | 9224 | `MODOKI_BACKEND_PORT=5181 engine/scripts/launch-editor.sh games/3d-test` |
| `~/Projects/modoki-ai3` (work-ai3) | 5182 | 5176 | 9225 | `MODOKI_BACKEND_PORT=5182 engine/scripts/launch-editor.sh games/3d-test` |
| `~/Projects/modoki-qa` (work-qa) | 5183 | 5177 | 9226 | `MODOKI_BACKEND_PORT=5183 engine/scripts/launch-editor.sh games/3d-test` |

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

(`npm run editor:main` / `editor:ai` are shortcuts for the first two; the `ai2`/`ai3` clones have
no npm shortcut — pass `MODOKI_BACKEND_PORT=5181` / `5182` explicitly, or use the `editor-ai2` /
`editor-ai3` shell functions.)

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
  Detail: [debug-tools-mcp.md](./debug-tools-mcp.md) § "Several phones attached".
- **Several phones of the SAME platform? Say which one.** Every adb call on the device surface is
  now `-s <serial>`-targeted, resolved ONCE when the lease opens and reused by the CDP tunnel and
  the screenshot — so `device_connect {useAdb:true, serial:"…"}` (or the AI panel's device
  picker) is how you pick, and an ambiguous choice is refused with every candidate named rather
  than driving whichever phone adb lists first. `MODOKI_ANDROID_SERIAL` pins it. Same doc section.
- **MCP approval is per-clone** — `.claude/settings.local.json` is gitignored, so each clone's
  Claude gets a fresh `modoki` pending-approval prompt on first run.
