# Multi-AI-CLI support

Modoki's agent-facing tooling — instructions files and MCP servers — isn't Claude-Code-specific.
This doc records how **Cursor**, **Codex CLI**, and **Antigravity CLI** (Google's successor to
Gemini CLI) are wired up alongside Claude Code, and why.

## Instructions: one new file, generated

Cursor, Codex CLI, and Antigravity CLI all natively read **`AGENTS.md`** (root + nested — a
project's `AGENTS.md` combines with any in a subdirectory, closer-to-cwd taking precedence), which
is the same layering model this repo already uses for nested `CLAUDE.md` (root → `games/<id>` /
`demos/<id>`). So a single new filename covers all three tools.

Rather than hand-maintaining a second copy of every `CLAUDE.md`, `AGENTS.md` is **generated** from
it — a byte-for-byte copy (plus a one-line generated-file header) — by
`engine/scripts/sync-agent-configs.mjs`. **Never hand-edit an `AGENTS.md`; edit the sibling
`CLAUDE.md` and run:**
```bash
npm run sync:agent-configs
```
`engine/tests/assets/agentConfigSync.test.ts` fails `npm test` if any generated file is stale, so
drift is caught by CI, not left to memory.

**Why generate instead of a git-tracked symlink** (`AGENTS.md` → `CLAUDE.md`, which would keep the
two identical for free)? This repo actively runs on Windows (the `win` clone — see the Clones
section of the root `CLAUDE.md`), and a git-checked-out symlink silently degrades to a placeholder
text file containing the target path unless the checkout has Developer Mode or admin rights
enabled. That's a real, previously-unhit risk for a convention meant to be invisible. Instead this
follows the precedent already established in this repo for exactly this "two files can't literally
share one source" problem: `engine/scripts/projectRoots.mjs`'s `PROJECT_ROOT_DIRS`, kept in sync
with `engine/tsconfig.app.json` / `engine/vite.config.ts` via explicit regeneration and a pointer
comment rather than an import.

`AGENTS.md` is generated everywhere a `CLAUDE.md` exists: the repo root, every `games/<id>` and
`demos/<id>` project, and the scaffolder template (`engine/templates/starter/`) — new scaffolded
projects get one automatically since `scaffold-project.mjs` / `newProject.ts`'s token-substitution
walker is driven by file extension (`.md` already included), not a hardcoded file list. Published
demos (`scripts/publish-demo.sh`) need no changes for this: the publish pipeline exports every
*committed* file under `demos/<id>` via `git archive` (no include-allowlist), so a committed
`demos/<id>/AGENTS.md` ships automatically, exactly like `CLAUDE.md` does today.

**Legacy Gemini CLI** (being deprecated by Google for free/Pro/Ultra tiers on 2026-06-18 in favor
of Antigravity CLI) is intentionally **not** given its own `GEMINI.md` — `AGENTS.md` is the
successor convention and covers Antigravity CLI, which is what actually matters going forward.

## MCP servers: generated for Cursor and Codex, manual for Antigravity

The root `.mcp.json` (three servers: `modoki`, `game-debug`, `chrome-devtools`) is the single
source of truth for MCP wiring. Note MCP config only ever exists at the **repo root** — there's no
per-game `.mcp.json` anywhere, since it wires up `engine/tools/*-mcp`, which is monorepo
infrastructure, not per-project. So the generated configs below are root-only.

`sync-agent-configs.mjs` also generates, from `.mcp.json`:
- **`.cursor/mcp.json`** — Cursor reads the identical JSON shape (key `mcpServers`), so this is a
  direct copy.
- **`.codex/config.toml`** — Codex CLI stores MCP config as TOML (`[mcp_servers.<name>]` /
  `[mcp_servers.<name>.env]` sections). The script hand-rolls a minimal TOML serializer for this —
  no TOML library needed given how flat the `.mcp.json` shape is.

**Antigravity CLI's `mcp_config.json` is deliberately NOT auto-generated.** As of 2026-07 its
schema and file locations are still new and reported to differ between the Antigravity CLI and the
Antigravity IDE. Auto-generating against an unstable target risks producing a file that's
confidently wrong. Until the format settles, Antigravity users get manual setup instructions
instead (see the public guide page, `site/docs/guide/ai-assistants.md`). Revisit auto-generation
once the schema is documented and stable.

**One thing to verify empirically, not assume:** `.mcp.json`'s env values use Claude-Code-style
shell-expansion syntax (`${MODOKI_BACKEND:-http://127.0.0.1:5179}`). Whether Cursor's and Codex's
own MCP env handling resolves that same fallback syntax, or needs a literal default instead,
hasn't been confirmed — check by actually launching each tool against this repo and confirming its
MCP servers connect.

## Known gap: no per-project "Connect Cursor/Codex" (verified 2026-07-25)

Everything above is about developing **this engine monorepo** — root `.mcp.json` +
generated `.cursor/mcp.json`/`.codex/config.toml` are for working on `engine/` itself. A real
end-user **game project** (`games/<id>`, scaffolded via File → New Project) is a different story:
only `CLAUDE.md`/`AGENTS.md` are scaffolded upfront. MCP tool access to a *game project* is wired
up per-project, per-machine (absolute paths to `engine/tools/modoki-mcp/dist/index.js`), and today
**only Claude Code has an automated flow for this** — **AI → Connect Claude Code** in the editor
writes a correct `.mcp.json` into the open project. There is no equivalent "Connect Cursor" /
"Connect Codex" / "Connect Antigravity" — a user has to hand-write `.cursor/mcp.json` /
`.codex/config.toml` / `mcp_config.json` themselves, by copying `.mcp.json`'s server definition.

This was confirmed by a real shakedown test using two throwaway scaffolds, `games/agy`
(Antigravity CLI) and `games/codex` (Codex CLI). **Both have since been deleted** — they were
shakedown projects, not games we keep — so the findings below are the durable record; the
projects themselves are in git history (added in `1be8ac38`, removed 2026-08-05) if either is
ever wanted back.

- **Antigravity** built a complete game from `AGENTS.md` alone with no MCP config at all — fine,
  since Antigravity doesn't need MCP to be useful.
- **Codex** had a hand-authored `.codex/config.toml` mirroring `.mcp.json`'s absolute-path pattern
  correctly (schema verified against Codex's current config reference), yet "struggled to
  connect" — the likely cause is **Codex's per-project trust prompt**: it will not activate a
  project-scoped `.codex/config.toml`'s MCP servers until the human explicitly trusts that
  directory, and skips them silently (no error) until then.
- Both projects made **zero changes outside their own `games/<id>` folder** — the
  self-containment guard held.

Decision (2026-07-25): **documentation only for now** — the public guide
(`site/docs/guide/ai-assistants.md`) spells out the manual per-project MCP setup and the Codex
trust-prompt gotcha. Building an actual "Connect Cursor/Codex" flow (extending
`engine/electron/connectClaude.ts`'s pattern to other tools) is a real feature, deliberately
deferred rather than done ad hoc.

## File map

| Tool | Instructions | MCP config | Generated by |
|---|---|---|---|
| Claude Code | `CLAUDE.md` | `.mcp.json` | (hand-authored — the source of truth) |
| Cursor | `AGENTS.md` | `.cursor/mcp.json` | `sync-agent-configs.mjs` |
| Codex CLI | `AGENTS.md` | `.codex/config.toml` | `sync-agent-configs.mjs` |
| Antigravity CLI | `AGENTS.md` | `mcp_config.json` (manual) | `sync-agent-configs.mjs` (instructions only) |
