# Connect Claude Code — one-click agent wiring for the shipped editor

**Design & rationale for a shipped feature** (landed on `editor-shipping`; source cites this doc
by section — C5 sticky port, C6 instance token — for the "why", so it stays as a design doc rather
than being deleted). The **AI → Connect Claude Code…** flow wires the user's *own* Claude Code to
the running desktop editor — the `modoki` MCP **and** `chrome-devtools` over CDP — with zero manual
config, so a DMG/exe user gets the same Claude-friendly authoring-and-verify loop that previously
only worked from a cloned repo.

It is the **cheap alternative** to the cloud embed (`docs/cloud-editor-embedded-claude.md`): rather
than host Claude server-side, the user's own Claude Code connects to the running editor — ~1% of the
cloud effort, ~90% of the value, for the audience that already has Claude Code. The MCP *tool
behavior* it exposes (the failure-reporting contract, addressing, Percept/Enact/Watch/Journal) is
documented in **[debug-tools-mcp.md](./debug-tools-mcp.md)**; this doc is the *wiring*.

## The gap this closes

Modoki's whole pitch is **Claude-friendly**: the `modoki` MCP (67 tools), **Percept**
(read-by-data), **Enact** (trusted input), and **CDP** (drop into the live renderer)
let Claude author scenes and *verify its own work*. Today that loop **only works from a
cloned git repo** — the repo's `.mcp.json` hardcodes `npx tsx
engine/tools/modoki-mcp/src/index.ts`, guesses the backend port, and points
`chrome-devtools` at a fixed CDP port that only the dev launcher opens.

A user who installs the **DMG / `.exe`** has the MCP server sitting right there on disk
(`app.asar.unpacked/engine/tools/modoki-mcp/`) but **no way to reach it** — and no CDP
port at all — because only the Electron main process knows the three missing facts:
**which port the editor bound**, **where the unpacked MCP lives on this machine**, and
**whether a renderer-debugging port is open**. Shipping the tooling but not the wiring
"defeats the purpose of the engine."

**Goal.** An **AI** dockable panel + a menu action — **AI → Connect Claude Code…** —
that, against the currently open project, makes `claude` (run in that project dir) able
to drive the live editor through the `modoki` MCP **and** the `chrome-devtools` MCP
(over CDP), with **zero manual config**. The user clicks once, then runs `claude` in
their project and starts chatting; scenes hot-reload as Claude edits them, and Claude
can drop to the live renderer when data isn't enough.

Non-goals: an in-editor chat panel (that's the cloud embed), bundling/authing Claude for
the user (they bring their own), macOS terminal-launch polish (v1 gives a copy-paste
path everywhere).

## Why this is small (grounded in the current build)

| Fact | Source | Consequence |
|---|---|---|
| Packaged app unpacks the whole engine tree + `node_modules` to `app.asar.unpacked/` (real files, "Vite runs in prod") | `electron-builder.yml` `asarUnpack: **/engine/**` + `**/node_modules/**`, `files: engine/**/*` | The MCP source AND the starter template already sit on the user's disk — no npm publish, no separate binary |
| `REPO_ROOT = app.isPackaged ? <resourcesPath>/app.asar.unpacked : <repo>` | `main.ts:273` | Main can compute the **absolute** path to the MCP entry + the template on *this* machine |
| Backend port is `backendHandle.port` (default 5179, ephemeral fallback on clash) | `main.ts` | Main knows the exact `MODOKI_BACKEND` URL to bake; the user never could |
| Open project root is `state.root` | `main.ts` | Main knows where to write `.mcp.json` |
| MCP reads `MODOKI_BACKEND` (default `http://localhost:5173`) + logs a start banner | `modoki-mcp/src/index.ts:23` | The written env var is the only wiring the MCP needs |
| Dev CDP is an electron CLI arg (`--remote-debugging-port`) the launcher sets; Chromium binds it 127.0.0.1-only. **On by default** in dev too now: an explicit `MODOKI_CDP_PORT` wins, else the launcher derives a per-clone-safe default `9222 + (backend − 5179)` (5179→9222, 5180→9223, 5181→9224) whenever the backend port is pinned; only an AUTO backend port (MULTI mode) leaves it off | `launch-editor.sh` | The packaged app (OS double-click, no CLI arg) `appendSwitch`es the port itself — also **on by default** (opt-out), so a plain launch opens it unless the user disabled it |
| The repo `.mcp.json` already runs three servers (`modoki`, `game-debug`, `chrome-devtools --browser-url`) | repo `.mcp.json` | Multi-server merge is the proven shape; `chrome-devtools` attaches to a renderer over CDP by URL |
| Menus merge renderer items via `rendererMenuSpec` + `modoki:bridge-menu-action`; main↔renderer over the preload bridge | `projects.ts`, `preload.ts`, `main.ts` | A new menu item + a dockable panel slot into existing patterns |
| Editor already writes project files (`project.config.json`, `.modoki/layouts/`) | `projects.ts` | Writing `.mcp.json` is an established capability, not a new trust boundary |
| Starter template ships a project `CLAUDE.md`, copied recursively by BOTH scaffold paths | `templates/starter/CLAUDE.md`, `scaffold-project.mjs:56`, `newProject.ts:68`, `main.ts:356` | New projects are already primed — the CLAUDE.md is in the DMG/exe; only its *content* needs upgrading |

## The core problem → solution

**Problem.** A hand-written `.mcp.json` like the repo's —
`command: "npx", args: ["tsx", "engine/tools/modoki-mcp/src/index.ts"]` — is **wrong on
an end-user machine**: that repo-relative path doesn't exist in their game project,
`MODOKI_BACKEND` must be the *actual* bound port, and `chrome-devtools --browser-url`
must point at a CDP port that the packaged app doesn't even open.

**Solution.** Main writes a machine-correct `.mcp.json` at connect time, choosing
command/args by `app.isPackaged` and including a `chrome-devtools` server **only when
CDP is enabled**:

- **Packaged** — self-contained runner, no `tsx`, no dep resolution:
  ```json
  {
    "mcpServers": {
      "modoki": {
        "command": "node",
        "args": ["<REPO_ROOT>/engine/tools/modoki-mcp/dist/index.js"],
        "env": { "MODOKI_BACKEND": "http://127.0.0.1:5179" }
      },
      "chrome-devtools": {
        "command": "npx",
        "args": ["-y", "chrome-devtools-mcp@latest", "--browser-url=http://127.0.0.1:9222"]
      }
    }
  }
  ```
  `node` is safe to assume (Claude Code is a Node CLI). `<REPO_ROOT>` is the absolute
  `app.asar.unpacked` path; the backend port is the **live** `backendHandle.port`; the
  CDP port is the **live** remote-debugging port.

- **Dev (`!app.isPackaged`)** — deps present, run from source:
  ```json
  { "command": "npx", "args": ["tsx", "<repo>/engine/tools/modoki-mcp/src/index.ts"],
    "env": { "MODOKI_BACKEND": "http://127.0.0.1:<port>" } }
  ```

Both bake **absolute** paths and the **literal** current ports, so the user exports
nothing.

### Packaging prerequisite — bundle the MCP

The packaged `command` points at `dist/index.js`, which must be a **single
self-contained bundle** so it needs neither `tsx` nor
`engine/tools/modoki-mcp/node_modules` (that tool is *not* a root workspace — its
`node_modules` may not be installed/shipped). Add an esbuild step to the electron build:

```
esbuild engine/tools/modoki-mcp/src/index.ts --bundle --platform=node \
  --format=esm --packages=bundle --outfile=engine/tools/modoki-mcp/dist/index.js
```

Wire it into `engine/scripts/build-electron.mjs` (it already runs esbuild for
`main.ts`/`preload.ts`, and runs on every `npm run dist` before electron-builder). The
output under `engine/tools/modoki-mcp/dist/` ships via `files: engine/**/*` and unpacks
via `asarUnpack: **/engine/**`. **Verify** `node dist/index.js` starts and logs
`[modoki-mcp] started …`. *Dev path is unaffected — it keeps using `tsx` from source.*

### CDP prerequisite — open a renderer-debugging port in the packaged app

CDP is what lets Claude reach the **live renderer** when data isn't enough: read React
fiber state and CSS-animation clocks, validate WGSL, and capture the **true framebuffer**
via `Page.captureScreenshot` (which — unlike `capture_viewport` — does *not* force a
render, so it exposes render-on-demand / stale-frame bugs). It is **on by default** in
both surfaces now — the dev launcher derives a per-clone port (see the table above) and
the packaged app opens it via the opt-out pref below.

Chromium requires `--remote-debugging-port` **at startup, before `app.ready`** — it
can't be toggled at runtime. So in `main.ts`, early:

```ts
if (getPref('cdpEnabled')) app.commandLine.appendSwitch('remote-debugging-port', String(CDP_PORT));
```

- **On by default (opt-OUT).** The packaged editor is agent-first, so CDP is enabled on
  a plain launch; the AI panel's toggle only records an explicit *opt-out* (`{enabled:false}`),
  which persists the pref and `app.relaunch()`es. See "Should CDP be on by default?" below
  for the tradeoff. (The switch is startup-only, so "default on" lands at launch — and the
  packaged app auto-reopens your last project, so in practice it's "on whenever you're in
  a project".)
- **127.0.0.1-only** — Chromium binds the port to localhost, the same trust surface as
  the existing localhost HTTP backend.
- The live CDP port is surfaced to main so the panel + `.mcp.json` writer can use it.

## UX — the **AI** dockable panel

Per the editor-surface convention, a **session/connection surface is dockable**, not a
modal. **AI → Connect Claude Code…** opens (or focuses) an **AI** panel in the
FlexLayout dock. It live-polls `modoki:connect-claude-status` and shows:

- **Ports & status** — one row each, with a reachable ✓/✗ dot:
  - **Backend / HTTP** (`MODOKI_BACKEND` target — the `modoki` MCP surface)
  - **Vite** (serves the renderer + the open game)
  - **CDP** (the renderer-debugging port, or "disabled")
- **Claude** — `claude` on PATH ✓/✗; `.mcp.json` **written** ✓; a **stale-port warning**
  when the baked port in the project's `.mcp.json` no longer matches the live port.
- **Actions**:
  - **Connect / Reconnect** → writes/refreshes `.mcp.json`, ensures a `.gitignore` entry,
    shows the one next step:
    > Open a terminal in **`<projectRoot>`** and run **`claude`**. Approve the
    > **modoki** (and **chrome-devtools**) MCP server when prompted.
  - **Enable renderer debugging (CDP)** toggle → persists the pref + relaunches.
  - Copy buttons for the project path and the `claude` command. (macOS **Open Terminal
    here** is a later nicety; Windows gets the copy-paste path.)
  - If `claude` is **not** found: swap the instruction for the install-docs link; still
    write the config so it's ready.

That's the whole surface. No streaming, no credentials.

## Implementation

### Main process — `engine/electron/connectClaude.ts` (new module)

Pure helpers (unit-testable, no Electron), consumed by IPC handlers:

```ts
// buildMcpServerEntry(repoRoot, isPackaged) -> { command, args }         // the `modoki` entry
// buildChromeDevtoolsEntry(cdpPort) -> { command, args }                 // `npx -y chrome-devtools-mcp@latest --browser-url=http://127.0.0.1:<cdpPort>`
// mergeMcpConfig(existingJsonText|null, { modoki, chromeDevtools? }, backendUrl) -> string
//   - JSON.parse existing or start {}; set mcpServers.modoki; set mcpServers['chrome-devtools'] IFF chromeDevtools given;
//   - PRESERVE every other server (repo .mcp.json has game-debug); stable 2-space formatting.
// ensureGitignored(projectRoot, ".mcp.json")   // append if a .gitignore exists and lacks it
// detectClaudeCli() -> { found, path? }         // `command -v claude` / `where claude`
```

IPC handlers (registered by `main.ts` alongside the existing bridge handlers, same
frame-guard):

```ts
ipcMain.handle('modoki:connect-claude', async () => {
  const projectRoot = state.root;
  const backendUrl  = `http://127.0.0.1:${backendHandle.port}`;
  const entry       = buildMcpServerEntry(REPO_ROOT, app.isPackaged);
  const chrome      = cdpEnabled ? buildChromeDevtoolsEntry(CDP_PORT) : undefined;
  const mcpPath     = path.join(projectRoot, '.mcp.json');
  const existing    = fs.existsSync(mcpPath) ? fs.readFileSync(mcpPath, 'utf8') : null;
  fs.writeFileSync(mcpPath, mergeMcpConfig(existing, { modoki: entry, chromeDevtools: chrome }, backendUrl));
  ensureGitignored(projectRoot, '.mcp.json');
  return { ok: true, projectRoot, backendUrl, mcpPath, claude: detectClaudeCli() };
});

// status-only sibling — powers the panel without writing anything:
ipcMain.handle('modoki:connect-claude-status', async () => ({
  backendPort, vitePort, cdpPort: cdpEnabled ? CDP_PORT : null, cdpEnabled,
  backendReachable, viteReachable, claude: detectClaudeCli(),
  mcpWritten, mcpStale,   // mcpStale = baked port in .mcp.json !== live port
}));
```

`backendHandle`, `state`, `REPO_ROOT`, and the CDP port are already in `main.ts` scope —
no new plumbing.

### Renderer — the AI panel + menu

- **Menu:** add `{ name: 'AI', items: [{ id: 'connect-claude', label: 'Connect Claude Code…' }] }`
  to the `rendererMenuSpec` the renderer pushes; handle the `modoki:bridge-menu-action`
  id by opening/focusing the AI dock panel.
- **Panel:** an engine-level React component registered as a FlexLayout dockable tab. On
  mount + on an interval → `invoke('modoki:connect-claude-status')`; **Connect** →
  `invoke('modoki:connect-claude')`; **CDP toggle** → `invoke('modoki:set-cdp-enabled', on)`
  (persists + relaunches). Copy buttons use `clipboard.writeText`.
- Expose the `invoke`s on the preload bridge (add an `invoke(channel, payload)`
  passthrough to `ipcRenderer.invoke`, matching the existing `send`/`on` shape).

### Template `CLAUDE.md` — cover the FULL agent surface

The starter template's `CLAUDE.md` already ships in the installer but is
**modoki-MCP-only**. Rewrite it (keep it tight — a per-project primer, not a manual) to
also cover:

- **Enact** (trusted input): `modoki_tap`/`drag`/`type_text`/`press_key`, aim by
  `selector`, `handles`/`tap_handle`/`drag_handle` for the Canvas2D/SVG editors.
- **CDP / chrome-devtools**: when to drop to the renderer (true framebuffer via
  `Page.captureScreenshot`, WGSL validation, live fiber/clocks) — and that
  data-first `modoki_get_scene_state` comes first.
- **Play/test transport** (`modoki_play_control`) and **journals/Percept**
  (`modoki_journal` / `modoki_editor_journal`) for verify-by-data.
- A one-liner: "you were wired up via **AI → Connect Claude Code**."

On **Connect**, if an *opened existing* project has **no** `CLAUDE.md`, copy this primer
in (never overwrite). Default on when absent.

> `ensureProjectClaudeMd` (`connectClaude.ts`) copies the
> template into `<projectRoot>/CLAUDE.md` **only when absent** — a project's own `CLAUDE.md`
> is the human's instructions and is untouchable; a lost template is a quiet no-op, never a
> thrown Connect. Writes to the PROJECT ROOT (CLAUDE.md is project-scoped — claude reads it
> from cwd upward, but unlike `.mcp.json` there's no single-owner collision to resolve), so
> it never fires for an in-repo game (those already carry one) and lands where a standalone
> project's `claude` runs. The panel reports it (`claudeMdWritten`). The template rewrite
> itself shipped in C4.
>
> Review (12 agents, 7 raised / **3 confirmed**, all LOW, all fixed): (1) a **dangling-symlink**
> `CLAUDE.md` read as absent under `existsSync` (which follows the link) and the atomic
> temp+rename would replace the LINK — a real NEVER-overwrite violation; now `lstatSync`, so any
> directory entry counts as present. (2) the template said Connect "wrote `.mcp.json` **here**",
> false when the config is adopted into an ancestor (C9) — reworded to "the AI panel shows
> exactly where". (3) the composition test omitted the primer's projectRoot-scoping — pinned
> (config at an ancestor, primer in the game folder, proven to differ).

## Edge cases & decisions

- **Never clobber existing servers.** `mergeMcpConfig` sets only `mcpServers.modoki`
  (+ `chrome-devtools` when CDP on); the repo's own multi-server `.mcp.json` proves the
  shape. Merge, don't overwrite.
- **Stale port** — see C5. The baked port goes stale when the editor rebinds onto a
  different port. The panel always shows the *current* port + a **stale-port warning** and
  a **Reconnect** button; the MCP's own error text already says "is the editor running?",
  which points the user back to the panel. C5 makes the port *sticky* so this is rare, and
  auto-heals the config when it does change.
- **Don't commit machine paths.** The packaged `.mcp.json` has absolute app-bundle paths
  → `ensureGitignored` keeps it out of the user's repo.
- **CDP is a real capability, but ON by default (opt-out).** Opened on every packaged
  launch, 127.0.0.1-only; a user who wants it closed unchecks it in the AI panel (a
  relaunch applies the change).
- **Worktree / multi-editor.** Uses the live `backendHandle.port` + live CDP port, so
  5180-pinned worktrees and `MODOKI_MULTI=1` auto-picked ports just work. *Known
  dev-only gap (deferred):* unlike Vite/backend, `launch-editor.sh` does not auto-pick a
  free CDP port in `MODOKI_MULTI=1` — it uses the fixed `MODOKI_CDP_PORT`, so two
  co-running editors that both export the same value collide (only the first binds). The
  per-clone `editor-*` alias pinning avoids this in the common case; a free-port pick is
  a follow-up. (The packaged app is single-instance, so it's unaffected.)
- **MCP approval.** Claude Code prompts once to approve the project's MCP servers; the
  instruction text says "approve modoki (and chrome-devtools) when prompted."
- **Claude absent.** Write the config anyway; show the install link. Idempotent + safe to
  run before `claude` exists.

## C5 — stale-port hardening

**The problem, observed live.** The 0.2.12 DMG bound backend port **62681**, not 5179:
`findFreePort(5179, allowFallback)` prefers 5179 but falls back to a **random ephemeral**
port when it's taken (here, by the dev editors on 5179/5180/5181). Every relaunch draws a
new random port → the project's `.mcp.json` goes stale → Claude Code silently talks to
nothing. Claude bakes `MODOKI_BACKEND` at MCP-spawn time, so a changed port **always**
needs a Claude restart. The fix therefore has two halves: make the port stop changing, and
heal + announce it when it genuinely does.

**1. Sticky, deterministic port** (kills ~all the churn). Persist the last-bound backend
port in `userData`; on launch prefer this ladder:

```
pinned MODOKI_BACKEND_PORT  →  last-used port  →  5179  →  deterministic scan 5180..5188  →  ephemeral (last resort)
```

Each candidate is probed strictly (no ephemeral fallback) until one binds; the bound port
is then persisted. A relaunch reuses the same port whenever it's free, so `.mcp.json`
**stays valid and no restart is needed** in the common case. A random ephemeral port is
now only the last resort, not the first fallback. (Pinned `MODOKI_BACKEND_PORT` keeps its
strict refuse-to-drift behaviour — the MCP target must stay stable.)

**2. Auto-heal `.mcp.json` on open.** If the opened project already has *our* `modoki`
server in its `.mcp.json` and the baked port ≠ the bound port, rewrite it with the live
port (reusing `mergeMcpConfig`, so other servers survive). Scoped deliberately: only
projects that previously connected are touched — we never create a `.mcp.json` unprompted.
This mirrors the editor's existing heal-native-config-on-open behaviour.

**3. Announce it.** The AI panel already flags `mcpStale` + offers Reconnect, but it may
not be open — so when the heal fires, show a one-time dialog: *"The editor's port changed
— restart Claude Code to reconnect."* Rare, because of (1).

**What can't be removed:** the Claude restart itself. Claude Code reads `.mcp.json` and
bakes the env at spawn, so a port change always requires restarting `claude`. C5 makes it
rare and loud instead of frequent and silent.

## C6 — instance token (the port is not an identity)

**The hole C5 leaves.** A port identifies a *socket*, not an *editor*. If a stale
`.mcp.json` targets port X and a DIFFERENT editor now holds X, every MCP call **succeeds
while driving the wrong editor** — the silent failure CLAUDE.md already warns about for
the two-clone setup, and which `modoki_identity` only catches if the agent thinks to ask.
Sticky ports make this rarer; they don't make it impossible (ports get recycled).

**Design.** A GUID that keys on **(install, project root)** — not per-launch (that would
invalidate the config on every restart and defeat C5's stickiness) and not committed
per-project (two clones of the same project would share it, which is exactly the case we
must catch).

- Minted at **Connect**, stored in `userData` keyed by project root, written into
  `.mcp.json` as `env.MODOKI_TOKEN`. Stable across relaunches.

> **Where `userData` is** (as of the userData section, which FIXED this — the table below is current, not
> historical):
>
> | Editor | userData |
> |---|---|
> | Dev, **per clone** | `appData/Modoki Editor (dev)/<clone-id>` |
> | Packaged (DMG) | `appData/Modoki Editor` |
>
> **Consequence for C6: the token distinguishes dev from the DMG and clone from clone**,
> because each has its own store. Editors sharing ONE userData still share one
> `instance-tokens.json` — `MODOKI_MULTI` inside a single clone is that case — which is why
> `ensureToken` re-reads before its read-modify-write.
>
> *(Pre-the userData section this read: dev → `appData/Electron` shared by ALL clones; packaged →
> `appData/modoki-app`. If you are reading an older comment that says so, it is describing
> the world before the userData section.)*
- The MCP sends it on every request (`X-Modoki-Token`).
- The backend **validates if present**: a request whose token is present but doesn't match
  the currently-open project's token gets a loud **403** with an actionable message
  ("this .mcp.json was written for a different editor/project — re-run AI → Connect Claude
  Code, then restart claude"). A request with **no** token is still accepted.

**Why validate-if-present, not require.** Requiring a token would break the documented
`curl /api/scene-state` API, the `game-debug` MCP, and chrome-devtools. Validate-if-present
fully solves the mis-targeting problem (our MCP always sends one) at zero compatibility
cost.

**Honest scope: this is CORRECTNESS, not security.** An attacker simply omits the header.
A `requireToken` mode would be genuine hardening for the localhost backend, but it's a
separate decision with real compatibility cost — track it, don't smuggle it in here.

### Should CDP be on by default? (revised: YES — opt-out)

Originally decided *no* (opt-in), on the reasoning that CDP is **unauthenticated arbitrary
code execution** in the renderer, reachable by any local process — strictly more powerful
than the backend's curated op set, which is why Chrome and Electron never default it on.

**Revised to on-by-default (opt-out)** at the owner's call: this editor is agent-first and
single-user, so the renderer-inspection capability is the common case, not the exception,
and the every-launch relaunch-to-enable friction outweighed the marginal exposure of a
**localhost-only** port on a developer's own machine. So now: **a plain packaged launch opens
the port**; `readCdpEnabled` is on unless the user writes an explicit `{enabled:false}` via the
AI panel toggle (which relaunches). The trust surface is unchanged (127.0.0.1-only, same as the
backend). The port-collision worry that motivated opt-in is handled independently by the sticky
ladder (§12.2 item 5): the editor never fights for 9222 — it advances to a free port in the band
and heals `.mcp.json` to match — so default-on just exercises that path every launch. DEV is
unaffected (the launcher owns the CLI arg; `main` never opens the switch in dev).

## C7 — MCP save-state consistency audit

**The audit** (32 agents, 25 raised / **18 confirmed**). It found **one disease, not 18
bugs**: *tools report SUCCESS for things that silently did nothing.*

| Tool | Reports | Reality |
|---|---|---|
| `save_all` | `ok:true` | also on **cancel** and on **write failure** |
| `particle_set`/`anim_set_clip`/`anim_add_key` | `ok:true` | `persistAsset` never checks the response — **the disk write was rejected** |
| `play_clip` / `dispatch_action` | `dispatched:true` | guid resolves to **no entity**; clip doesn't exist |
| `capture_gesture` | `ok:true` | empty trajectory (unresolvable `sampleGuid`) |
| `history` (undo) | `did:true` | undid **nothing**, and burned the entry onto the redo stack |
| `build` | `ok:true` | built **stale** content — no save, no warning |
| `mutate_scene`/`set_transform` | *successful tool call* | body says `{ok:false}` |
| `write_asset` | *(promises to preserve)* | **destroys** an animation asset's GUID when `data` omits `id` |
| `anim_add_key` after `write_asset` | applied | silently **REVERTS** the file (stale clip cache; `invalidateAnimationClip` has **zero callers**) |

That is this doc's own recurring bug class — **INTENDED reported as OBSERVED** — in the one
surface agents actually read. For an agent-first engine it is the worst failure mode: the
agent cannot see the failure, so it builds on it.

### C7a — the structural fix

- **One seam fixed once**: `postJson` only failed on `status >= 400`, but our routes answer
  "I refused / nothing matched" with **HTTP 200 + `{ok:false, errors:[…]}`**.
  `isFailureBody` (`result.ts`) turns those into real tool errors. `ok` is a success FLAG
  everywhere and never an answer — `validate_scene` reports findings in `warnings` — so a
  legitimate negative RESULT is untouched. Covers scene-mutate, set_transform, and the
  persistAsset family at a stroke.
- **The compose gap + the lying error.** Reproduced live (same guid, same instant:
  `scene-mutate` → *no entity matching* while `scene-state` → *1 live entity "Sphere"*).
  **C7's original plan was wrong**: it said "the resolver knows both". It does not and
  cannot — `sceneMutate.ts` is a pure function over the FILE. So `applyOps` now reports
  `unresolved: EntityRef[]`, and `/api/scene-mutate` (which already reaches the renderer for
  its play-state guard) asks the live world and answers with the truth: *"…DO exist in the
  live editor world right now but are not in the scene file yet … Run modoki_save_all, then
  retry."* One probe, only on failure; headless curl gets no hint and the plain error stands.
- **`create_entity`/`duplicate_entity` return the GUID.** `createEntityWithUndo` already
  minted one and threw it away — so the tool that creates entities could not hand back the
  one identifier CLAUDE.md mandates. (Ids are reassigned on every hot-reload, and the file's
  id space is a *different* namespace, so a stale id can resolve to the **wrong** file entity.)
- **`path` is validated** by `/api/scene-mutate` (it validated `ops` but not `path`, so the
  curl API CLAUDE.md advertises answered a missing path with a raw TypeError).

**The policy** (plan item 3), decided: **fail with an actionable message, never auto-save.**
An implicit save would commit the human collaborator's unrelated unsaved work — the editor is
a shared surface, and a surprise write is worse than a clear error. The hint makes the
required step obvious and one call away.

### C7b — the follow-up fixes

1. **`write_asset` GUID destroyer** — preserve branch was `out.id == null`, but normalize sets
   `id: ''` and `'' == null` is false, so it never fired: the watcher then healed a NEW guid
   and every scene ref dangled. Now `!out.id`.
2. **`anim_add_key` reverting the file** — `invalidateAnimationClip` had **zero** callers, so
   the clip cache served the pre-edit clip forever and the read-modify-write put it back.
   `classifySceneChange` now returns `'animation'`, delivered by **both** watchers.
3. **`save_all`** — returned void, swallowing cancel AND write-failure behind `{ok:true}`. Now
   `SaveResult`; takes `path` (the panel needs a human); **actually blocked during Play**, as
   its description always claimed.
4. **`load_scene`/`new_scene`** refuse to destroy unsaved live work (`force:true` to discard).
5. **`build`** refuses on unsaved changes; `dispatch_action`/`play_clip`/`capture_gesture`
   reject phantom guids; `delete_entities`/`reparent_entity` report what happened;
   `list_traits` distinguishes "registry empty" from "unknown trait".
6. **Matrix published** in `docs/debug-tools-mcp.md`.

**Review (17 agents, 12 raised / 8 confirmed) — all fixed.** Four HIGH, every one a bug the
fixes themselves introduced or missed:
- **The clip-cache fix was DEAD in Electron.** `assetBackend.ts` DUPLICATED
  `classifySceneChange`'s logic instead of calling it, so the fix landed only on the Vite
  path — working in a browser, dead in the dev editor AND the DMG, i.e. every surface the MCP
  targets. It now calls the shared classifier. (The commit message warned about exactly this
  class.)
- **`save_all {path}` could clobber a real scene with the prefab-edit world.** Prefab-edit
  nulls the scene path so a normal save can't hit a real file; the human paths honour it via
  `isEditingPrefab()`, the new agent `path` bypassed it — and the `needs-path` error *steered
  agents into it*. Now guarded.
- **The compose hint could lie in a new way.** It probed a BARE `scene-state`, which drops
  resource entities and caps at `DEFAULT_INDEX_LIMIT` — so "really is absent" was wrong for a
  resource or a big scene. Now one TARGETED probe per ref (uncapped, resource-inclusive).
- **The matrix itself was wrong**: `particle_set`/`anim_set_clip`/`anim_add_key` call
  `persistAsset` (live **and** asset-file) and `prefab create` writes a file — all were listed
  as "RAM. Not saved."
Plus: `isFailureBody` failed a PARTIAL `reimport` (its `errors[]` is a normal field of a 200 —
an explicit `ok:true` now wins); Cmd+S showed a green "Scene saved" on cancel/failure.

**Known, accepted:** `history` undo still pops an entry whose target a hot-reload destroyed —
verify with `get_scene_state`, not `did`.

## C8 — Vite / CDP port discovery + access verification

### Expose the ports on `modoki_identity` (not a new tool)

Today `/api/identity` reports `{repoRoot, projectRoot, backendPort, pid, branch,
packaged}` — the **backend** port only. So an agent has no way to learn the **Vite** or
**CDP** port from inside the MCP, even though CLAUDE.md tells it to drop to raw CDP for the
render-on-demand / stale-frame / WGSL class of bug. (Observed: during the 0.2.12 smoke the
only reason the CDP port was known was that we'd just written the code.)

Add `vitePort`, `cdpPort`, `cdpEnabled` to `/api/identity` — all already in `main.ts` scope
(`DEV_URL`, `CDP`). `modoki_identity` is a straight passthrough, so this needs no new tool:

- **Deliberately NOT a new tool.** There are already 65; a 66th that reports two numbers is
  poor economy against the response-budget rules. `identity` is *already* the "what am I
  actually talking to?" call, and already the one you're told to make first when calls
  "succeed" but nothing changes — so it's where a port belongs.
- **Why it matters**: makes the documented raw-CDP escape hatch self-service, and turns a
  dead chrome-devtools connection into a diagnosable state (`cdpEnabled:false` → "enable
  Renderer debugging in the AI panel, then restart me") instead of silent flailing.
- **No new exposure**: identity is localhost-only, and anything that can reach it can probe
  9222 itself.
- Pairs with C6: identity is also where the token mismatch surfaces.

### Report VERIFIED state, not INTENDED state (found live on 0.2.13)

**The bug, caught on a real install.** The AI panel showed `CDP (renderer debug) 9222` in
GREEN. It was a lie: 9222 was owned by a **sibling clone's dev editor** (pid 29457, project
`games/sling`); the packaged editor (pid 2154) held **no CDP port at all**. Its CDP pref had
carried over, Chromium found 9222 taken, **failed to bind silently**, and we reported the
*pref* as if it were live.

Worse than a wrong label: `.mcp.json` pointed `chrome-devtools` at 9222, so Claude would
have attached to **another project's renderer** and every call would have succeeded against
the wrong editor — the same silent-wrong-target class as C6, but CDP is Chromium's own
protocol, so a token can't be added to it.

This is a **Percept doctrine violation**: the status surface reported CONFIGURED state
(`cdpEnabled` = a pref) as OBSERVED state, without probing. Percept's whole premise is
"verify by data — report what IS."

**The work:**

1. **Verify the endpoint, don't trust the pref.** Status gains `cdpReachable` (does
   `http://127.0.0.1:<cdpPort>/json/list` answer?) and `cdpOurs` (does a page target's URL
   match OUR `DEV_URL` origin?). The page URL is the available discriminator — in the
   observed case ours was Vite `63297` while 9222's page reported `5173`, which is provable.
2. **The panel must not show green for enabled-but-not-ours** — red/amber with
   "port 9222 is in use by another editor — CDP unavailable; free it or pick another port."
3. **Connect must REFUSE to write the `chrome-devtools` entry** unless CDP is verifiably
   ours. Handing Claude a `--browser-url` we haven't verified is worse than omitting it.
4. **Same verification belongs on `/api/identity`** (C8): `cdpPort` must mean "a CDP
   endpoint that is OURS", never "a port we hoped to bind".
5. **CDP port collision needs a real answer.** Chromium takes the switch pre-`app.ready`, so
   we can't probe-then-bind the way C5's backend ladder does. Minimum: detect the failed
   bind after ready and report honestly (above). Better: a sticky/deterministic CDP port
   with its own reserved band, mirroring C5.

   > MEASURED first (isolated Electron): `--remote-debugging-port`
   > must be appended **synchronously at module load** — after even one `await`, Chromium has
   > already read the switch and does NOT bind. So there is no probe-then-bind; the choice is a
   > PURE synchronous decision from a persisted memo. `resolveStickyCdpPort({memo})`
   > (`cdp.ts`): no memo → 9222; last was **ours** → STICK on it; last was **not ours** →
   > ADVANCE to the next port in the band `[9222, 9222+CDP_SCAN_SPAN)`, wrapping. `main.ts`
   > persists `{port, ours}` (`writeCdpPortMemo`) from the nonce probe — but only **after the
   > renderer mounts** (a pre-window probe is always not-ours and would wrongly advance), only
   > packaged, and only on a change. So a persistent 9222 collision self-heals in one relaunch
   > instead of dead-ending. No reserved band: dev CDP is launcher-pinned per clone and the
   > packaged app is single-instance, so there's no fixed dev band to protect — the
   > advance-past-collision ladder is the whole mechanism.
   >
   > Review (14 agents, 9 raised / **2 confirmed** — the same LOW bug via two lenses, fixed):
   > `probeCdp` collapses a real collision (`reachable && !ours`) and a **transient** 800ms
   > `/json/list` timeout into the same `ours:false`. Advancing on the transient would churn
   > the port next launch — re-heal `.mcp.json` and nag "restart Claude Code" for a collision
   > that never happened. Fixed with `cdpMemoVerdict(probe)`: only `reachable && !ours`
   > advances; an **unreachable** probe returns null (keep the prior memo). Mutation-pinned.
   > Also clamped `resolveStickyCdpPort`'s band so a high `base` can't produce an
   > out-of-range port (defensive — the sole production caller is always 9222).

> The origin+UA discriminator was the first cut; it was then replaced by the stronger nonce below
> (the C8 nonce). The nonce makes a foreign endpoint provably not-ours, so a collision surfaces as
> "in use by another editor" instead of a silent green. The sticky CDP port (item 5) also landed.

#### The per-launch NONCE

C8's "is this endpoint ours?" stacked two HEURISTICS, each with a documented false edge: an
origin match (a Vite **ephemeral `:5173x`** port prefix-collides) plus a `/json/version`
User-Agent sniff for `Electron/` (to reject a **Chrome tab** sitting on our origin). The
"stronger future option" flagged at the time is now shipped and replaces both:

- **Mint a per-launch nonce** (`randomUUID`, `newCdpNonce()`), bake it into the renderer URL
  as a **query param before the hash** — `${pageOrigin}/?cdpNonce=<uuid>#/editor` — and have
  `probeCdp(port, nonce)` report `ours` iff a page target carries `?cdpNonce=<ourNonce>`.
- **Why it's exact, not heuristic**: a random UUID minted THIS launch cannot appear in a
  sibling editor's URL, a stray Chrome tab, or an ephemeral-port origin collision. One check
  with **neither false edge**, and **one fewer round-trip** (the `/json/version` fetch is gone).
- **Fails CLOSED**: an empty/absent nonce never matches, so the pre-mount window (no page yet)
  and any non-ours endpoint read as not-ours — the pref-distrust posture is preserved.
- **Placement was MEASURED, not assumed** (this workstream's rule): against a real isolated
  Chromium `BrowserWindow`, CDP `/json/list` reports the full URL **including** the `?cdpNonce`
  query before the `#` fragment, and `new URL(u).searchParams.get('cdpNonce')` round-trips it.
  Query-before-hash keeps the hash router (`#/editor`), the origin (will-navigate/CSP), and
  `waitForServer` unchanged, and coexists with the runtime's own `?scene=` param (read by name).
- **Consistency**: the nonce is minted ONCE at module scope and used by BOTH `loadURL` and
  `cdpStatus()`'s probe, so they can't drift. `loadURL` is called once (Open Project re-roots
  Vite without reloading), so the nonce persists for the window's life.

Review (7 agents, 2 raised / **2 confirmed**, both LOW, both fixed — the security/timing/URL/
consistency lenses found NOTHING): both were the workstream's "invariant verified over a
NARROWER surface than the code enforces" class. (1) The fail-closed test served a *non-empty*
page nonce, so dropping the `nonce ?` guard wouldn't fail it — the real fail-open is a page
with a present-but-empty `?cdpNonce=` (`cdpNonceOf` → `''`) probed with `''`; now pinned with
that exact page (mutation-verified). (2) The load-bearing query-before-hash placement was a
bare string literal in `main.ts` (unit-untestable, imports electron); extracted into
`buildRendererUrl` (used by `main.ts`, pinned by a round-trip test + a "fragment placement is
unreadable" test), so a reorder that would silently kill the feature now fails a test.

**Related (lower priority): the Vite port has C5's old disease.** It still uses
`findFreePort(5173, allowFallback)` → a RANDOM ephemeral port when 5173 is taken (observed:
63297). It isn't the MCP target so nothing silently breaks, but it's the same churn the
backend ladder fixed, and it's a probe-then-bind TOCTOU (Vite binds it later, `--strictPort`).

### Scripted three-surface smoke

The three surfaces the feature promises must all be provable on a real installer, not just
the MCP. Verified manually against the signed 0.2.12 DMG:

| Surface | Check | Result |
|---|---|---|
| MCP | bundled server → `tools/list` + `get_scene_state` | 67 tools, live scene ✅ |
| Vite | `GET http://127.0.0.1:<vitePort>/` | HTTP 200, serves the shell ✅ |
| CDP | `/json/list` → `Runtime.evaluate` on the page target | `Modoki`, `__3d present` ✅ |

**The work:** fold this into a scripted smoke (`engine/scripts/`) so a packaged build
proves all three, not just that the app renders — and so a regression in any surface fails
a gate instead of a user's session.

## C9 — write the config where `claude` will actually READ it (in-repo games)

**The hole.** Connect writes `.mcp.json` into the **project root** — for a standalone
project (the shipped-DMG case: `~/Desktop/moge`) that's exactly where the user runs
`claude`, so it's correct. But an **in-repo game** (`games/3d-test` inside this monorepo)
is opened as the project root while the developer runs `claude` at the **repo root** —
where CLAUDE.md lives and the npm scripts run. Claude Code only searches from cwd
**upward**, so a config written *down* in `games/3d-test/` is **never loaded**. Connect
reports success, the panel goes green, and nothing is wired: the same
silently-succeeds-and-does-nothing class this whole workstream exists to kill.

> `resolveMcpTarget` + `ensureMcpGitignored` (`connectClaude.ts`), routed through
> all three call sites; the panel reports the OBSERVED config path. Re-measured against
> `claude 2.1.212` before implementing — **the git-root row was the surprise**: discovery
> does NOT stop there, which splits the design in two (see "The design" below).

**Measured resolution rules** (docs are ambiguous on all three — these were established
empirically against the installed `claude`, not read; re-measure before relying on them):

| Question | Answer |
|---|---|
| Does `.mcp.json` discovery walk UP from cwd? | **Yes** — a repo-root config loads from a 2-deep subdir. |
| Multiple `.mcp.json` along the path? | **Merged**, not nearest-wins-all. |
| Same server NAME in two of them? | **Nearest wins** (the deeper file shadows the ancestor). |
| Does it stop at the git root? | **No** — it walked up a non-git tree too. |

Two consequences: (1) writing into the game folder is *harmless but invisible* to a
repo-root `claude`; (2) if BOTH exist, which editor a `modoki` call reaches depends on the
directory the user happened to launch `claude` in — a **cwd-dependent silent mis-target**,
which is C6's bug with a new cause.

**The design.** Connect targets the file `claude` will actually load, and says which one.

**Searching and writing are NOT the same walk** — the measured "doesn't stop at the git
root" row forces the split. Discovery is unbounded (so `shadowing` must be too, or the panel
would hide a config claude merges), but **writing** must be bounded, or a stray
`$HOME/.mcp.json` becomes an adoptable target and our server hijacks every project on the
machine.

- **Discover, don't assume**: take the **nearest existing `.mcp.json` at-or-above the
  project root, searching only within the project's OWN git repo**. None found ⇒ write into
  the project root (today's behaviour; right for a standalone project).

  *Why bounded by the project's own repo, rather than "nearest existing ancestor anywhere"*
  — the plan's original wording. That rule adopts a coincidence: a standalone
  `~/Desktop/moge` next to an unrelated `~/Desktop/.mcp.json` would get our `modoki` server
  written into that **shared** file, changing every other project on the Desktop. And it's
  not even necessary: **nearest-wins means the project's own file always beats an ancestor
  for a `claude` run in the project**, which is the standalone case by definition. So an
  ancestor is adopted only on real evidence that the user runs `claude` up there — a repo,
  with a config already in it — never on directory layout alone. `~/Desktop` isn't a repo ⇒
  no adoption.
- **Report the OBSERVED path** in the AI panel ("Config: `~/Projects/modoki-ai/.mcp.json`
  — a parent of this project"). The panel must never imply a file it isn't using; per C8
  that's the doctrine, and here the path is precisely the thing the user can't infer.
- **Warn on a shadowing pair**: if a `.mcp.json` exists BOTH at the project root and at an
  ancestor, the effective one depends on the user's cwd. Surface it rather than pick
  silently.
- **The token (C6) still keys on the PROJECT root**, not the config's location — it names
  which editor+project the config drives. So a repo-root config whose editor switches from
  `games/3d-test` to `games/sling` is a token drift, and heal repairs it exactly as today.

**C9b — the review (21 agents, 15 raised / 11 confirmed).** Every confirmed finding was in
the C9 fix itself, and the top one was this workstream's signature bug again — *an invariant
verified over a NARROWER surface than the code enforces*:

- **The unattended heal rewrote a git-TRACKED config.** Trap 1 below was implemented and
  tested for the `.gitignore` half ONLY, while C9 simultaneously pointed `healMcpPort` at
  the adopted ancestor — which for an in-repo game is the repo root's **committed** file.
  Reproduced: every launch dirtied the tree with no user action, and since CLAUDE.md pins
  5179/5180/5181 per clone and the file merges via `origin`, each clone would rewrite it to
  its own port **forever**. Now `healMcpPort` refuses a tracked target (`reason:'tracked'`);
  an explicit **Connect** may still write it (the user asked; git shows the diff) but warns.
- **`Connect` would have destroyed this repo's own config.** The committed `.mcp.json` is
  deliberately generic — `"MODOKI_BACKEND": "${MODOKI_BACKEND:-http://127.0.0.1:5179}"` plus
  relative paths — so ONE tracked file serves every clone. But `mcpOurs` answered "is this
  ours?" with `mcpBackendPort() != null`, and `new URL('${MODOKI_BACKEND:-…}')` throws ⇒ the
  panel called a working config *"not a usable Modoki config"* and pushed the user to
  overwrite the very mechanism it provides. `mcpOurs` is now the modoki server's PRESENCE;
  a deferred backend gets its own honest state ("Claude will reach whatever your shell
  resolves — not necessarily this editor").
- **`isGitTracked` failed OPEN.** It returned `r.status === 0`, mapping THREE outcomes onto
  two: `spawnSync` reports a missing `git` as `status: null` **without throwing**, so
  "couldn't run" silently became "untracked" — on the one surface dev can't test (a
  Finder-launched DMG has a minimal PATH). Now tri-state, and the common shipped case
  (no `.git` anywhere above the project) answers from the filesystem with **no `git` at all**.
- **The `$HOME` boundary was `===` on a raw `os.homedir()`** — a symlinked (`/var` →
  `/private/var`), differently-cased, or trailing-slashed home turned the only anti-hijack
  guard off silently. Now canonicalized (realpath + case-fold).
- **Both boundary guards were UNPINNED**: the review deleted `if (d === repo) break` and all
  135 tests still passed. Pinned now by the mutations that broke them.
- **The heal dialog named the project root**, not the config it healed — telling the in-repo
  developer to restart `claude` in `games/3d-test`, a folder they've never had a session in.
- **The shadowing warning cried wolf**: it flagged ANY other `.mcp.json`, but only a rival
  **`modoki`** entry can mis-target (claude merges configs and resolves name collisions
  nearest-first). An unrelated `weather` server left the panel permanently amber.

**Two traps this must not spring:**
- **A tracked ancestor config.** This repo's own root `.mcp.json` is **committed**. Writing
  to it dirties the working tree, and `ensureGitignored` must NOT add a tracked file to
  `.gitignore` (git would keep tracking it and the entry is just a lie). Check
  `git ls-files --error-unmatch` before ignoring, and never ignore an ancestor config we
  didn't create.
- **Walking too far.** Stop at the git root, `$HOME`, or the filesystem root — whichever
  comes first. Writing into `$HOME/.mcp.json` because a stray one exists there would hijack
  every project on the machine.

**Known, accepted gap: an in-repo game with NO `.mcp.json` anywhere in the repo.** We write
the project root — and per the measured rules that file is invisible to a `claude` run at the
repo root. We don't fix it by writing the repo root unprompted: creating a config in the root
of someone's game monorepo on a Connect click is presumptuous, and we have **no evidence**
where they run `claude` (the whole point of the "existing ancestor" signal). The panel names
the file it wrote, so the user can see it and move it. The motivating case — this repo —
doesn't hit it: its root `.mcp.json` is committed, so the ancestor is always found.

*Gate: unit tests for the upward search (found at an ancestor / none / stop boundaries /
tracked-file ignore refusal) + the shadowing-pair warning, plus an integration test that a
repo-root config is the one healed for an in-repo game. Then an ultracode review.*

## userData: the shipped app's profile moved, and dev clones shared one (FIXED)

**Two bugs, both measured on real launches (`lsof` + dir contents), both invisible in dev.**

### The shipped editor's profile silently relocated — a regression from today

Electron **resolves and caches `userData` on the FIRST read**, so whoever reads first wins.
`main.ts` had `app.setName('Modoki Editor')` at line 269 to give the shipped app a product
dir. Then `initFileLog()` landed at **line 28** (commit `ff364b47`, "Windows editor crash on
open") — and it reads `userData`. From that day the rename was a **no-op**: userData fell
back to the package.json name, and the shipped editor's whole profile — the **1.2 GB**
toolchain, prefs, caches — moved from `Modoki Editor` to `modoki-app`. Nothing threw,
nothing logged; the directory just moved.

Proof: a Jul-16 packaged build (zero `initFileLog`) still writes to `Modoki Editor`; every
build after `ff364b47` writes to `modoki-app`, and `Modoki Editor` was left holding a stray
`.DS_Store` + `.updaterId`.

> This was diagnosed wrong twice first — as "setName can never work" (it can; it just has to
> precede every reader), and before that as "dev and packaged share modoki-app" (they never
> did: dev is `appData/Electron`). Both claims were asserted without measuring. `lsof -p
> <pid> | grep "Application Support"` answers it in one command.

### Every dev clone shared ONE Chromium profile

Dev runs `electron main.cjs`, so **all clones** resolved userData to `appData/Electron` —
while CLAUDE.md RULE 2 has several running at once. Measured with two live editors:

| Shared thing | Consequence |
|---|---|
| `Local Storage` (LevelDB) | **single-writer**: the FIRST editor takes the lock, later ones get NOTHING. `editor:sceneViewMode`, `modoki-last-scene`, `modoki.anim.trackListW`, `modoki.buildSupportDismissed` silently stop persisting — no error anywhere |
| `GPUCache` / `DawnWebGPUCache` | both processes hold `data_0..3` + `index` open; Chromium's disk_cache expects one process (suspicious for a WebGPU/TSL engine, not proven to cause a specific failure) |
| `logs/main.log` | interleaved across clones |
| `backend-port.json` (C5 sticky port) | `MODOKI_MULTI` does **not** pin a port (`launch-editor.sh:32`), so MULTI editors read/write one file and the sticky port degrades to whoever launched last |

### The fix (shipped)

`engine/electron/userDataDir.ts` — pure resolvers, plus **ordering**, which is the part no
unit test of a resolver could have caught:

- **`setPath`, not `setName`** (it overrides the resolved entry), placed **above
  `initFileLog()`** — above the first reader, not merely "before ready".
- **packaged → `appData/Modoki Editor`**; **dev → `appData/Modoki Editor (dev)/<clone-id>`**
  (keyed on the clone PATH, so branch switches keep the profile — matching how `projects.ts`
  scopes recents).
- **Toolchain pinned to `appData/Modoki/toolchain`** — MACHINE-level, outside userData. This
  makes `projects.ts:40`'s existing claim ("the toolchain is machine-shared") true and
  de-dupes it (`npm-tools` was duplicated across dev and packaged).
- **`adoptLegacyToolchain` renames an existing toolchain into that dir on first run.**
  Pinning alone moved where we LOOK, not the data — the first cut therefore **did**
  re-download ~1.2 GB (JDK 336M + Android SDK 527M + Node + Ruby) and would have left
  Android/iOS builds failing until it finished, while the original 1.2 GB sat orphaned
  (~2.4 GB peak). It runs at module scope **before any provisioning**, because
  `ensureNodeProvisioned()` creates `<toolchain>/node` and the adopt no-ops once the target
  exists — a late adopt silently loses the SDKs.
- A **source-order guard test** fails if any `app.getPath('userData')` appears above the
  `setPath`, or if `setName` returns — the exact regression `ff364b47` shipped.

**Verified on a real packaged launch:** the profile (`Cache`, `Local Storage`, `GPUCache`,
`instance-tokens.json`) lands in `Modoki Editor`; `Modoki/toolchain` is created outside it;
no toolchain leaks into userData.

**Upgrade cost:** old *profile* state in `modoki-app`/`Electron` is orphaned — the CDP pref
and sticky port reset once, and re-minted tokens make connected projects drift into one
"restart Claude Code" dialog. The **toolchain is adopted, not re-downloaded** (see above) —
but that is true only because of `adoptLegacyToolchain`; **do not "just delete" the old dir
before first launch**, it holds the only JDK/Android SDK until the rename runs.

### `MODOKI_MULTI` within ONE clone (FIXED)

Dev userData is keyed on the **clone path**, so several `MODOKI_MULTI` editors inside the
*same* clone shared one profile, and the userData section's LevelDB single-writer problem persisted for them.

**Fixed by keying on the opened PROJECT — the one candidate that isn't wrong.** A per-launch id
(pid/port) hands each launch a fresh EMPTY profile (worse than sharing — prefs reset every
time); a `MODOKI_MULTI` editor is launched to open a SPECIFIC project (that's the point of
running several), so the project is both **stable across relaunches** and **distinct between
co-running editors**. `multiProfileKey(project)` (`userDataDir.ts`) → `<slug>-<8-hex hash of
the resolved path>` (readable + collision-safe for same-named projects in different repos);
`resolveUserDataDir` nests it under the clone dir. Gated on `MODOKI_MULTI` **and** a known
`MODOKI_PROJECT`, so the normal single-editor case is byte-identical, and the packaged
(single-instance) app never nests. As a bonus, each MULTI editor's `backend-port.json` and
instance-token store are now separate too, so the userData section's sticky-port-degradation across MULTI
editors is fixed by the same change.

**Residual (accepted):** MULTI with no `MODOKI_PROJECT` (auto-reopen last) still falls back to
the shared clone profile — there's nothing stable to key on at launch; and two MULTI editors
opening the *same* project still share (a genuinely odd thing to do). Both are documented
degenerate cases, not silent.

## MCP tool-quality re-audit — the design decisions

An independent adversarial re-audit (false-success, auto-save consistency, response size,
Percept/Enact/Watch/Journal correctness, dev↔DMG parity) found the earlier save-state pass (C7)
hardened the entity/**target** layer but left the **payload** and **interactive-tool** layers
exposed. Response-size came back clean — the summary-first design ([debug-tools-mcp.md](./debug-tools-mcp.md)
"Response budget") holds. The resulting *tool behavior* lives in debug-tools-mcp.md; recorded here
are the non-obvious DECISIONS and the roads not taken.

- **The earlier guard hardened the target, not the payload.** The phantom-guid check rejected a bad
  entity ref but not a bad payload — so `play_clip` with a typo'd clip name and `mutate_scene` with an
  unknown field both dispatched/wrote and reported success. The fix validates the payload too, but
  narrowly (below).

- **`mutate_scene` unknown-field fails only when the schema is available.** A universal hard-error
  would break the engine's deliberate *warn-but-load* (forward-compat) AND every cold-start/headless
  edit — `ctx.getSchema()` is `undefined` until the renderer connects, so every field would look
  "unknown". So it fails only when the schema IS present and the field is unknown on a KNOWN trait (a
  certain typo); unknown-TRAIT and no-schema stay warn-but-load.

- **`diagnose` gates the camera check on 3D content.** A pure 2D/UI scene (chess) legitimately has no
  Camera, so an unconditional "no Camera → 3D renders black" was a false alarm; the check now fires
  only when the scene has a 3D renderable. Zero-scale stays a SOFT signal (an entity can be
  intentionally scaled to 0) — surfaced in the summary, not gated into `ok`.

- **`editor_journal` cursors are forward, so a cursored poll returns the OLDEST-after-cursor window**
  (+ `nextSeq`/`nextCap`), not the newest tail — the tail permanently dropped the middle when >limit
  events accrued between polls. The cursor-less "what just happened" call keeps the newest tail.

- **`watch` prioritizes movers via a MOVER cap, not eviction.** Name-scoping (`names[]`, auto-joining
  fresh-guid spawns) is the headline fix for a runtime-spawned entity like the sling puck. For the
  un-scoped "watch all" case, `maxSeries` caps MOVING series only (a static baseline is cheap and
  doesn't consume it) — an eviction scheme was rejected because at a small cap it thrashes and can drop
  a just-baselined mover before it records its first movement.

- **The DMG config-refresh trap (a road not taken).** `project_settings` writes reach the Electron
  backend, but the child Vite serves the renderer and caches the config module. The naive fix — watch
  `project.config.json` in the child Vite — triggered a full page reload (Vite's default for a watched
  non-module file), which discards unsaved work AND broke the packaged CSP smoke (the reload killed an
  in-flight CDP eval). Reverted. The landed fix is a cross-process signal:
  `POST /api/invalidate-project-config` on the shared router → the Vite's reload-free
  `moduleGraph.invalidateModule`, which `main.ts` fire-and-forgets a POST to. Module-only, no reload —
  and the reason the packaged smoke (`verify:packaged`) is REQUIRED for any `engine/plugins/**` change.

Repro: open `games/sling`, Play, `watch start component=Transform names=["Puck"]`, launch a shot,
`watch read` → expect the puck's y/z series (`name:"Puck"`), not 512 fish series.
