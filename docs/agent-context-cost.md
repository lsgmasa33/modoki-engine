# Agent context cost — the Read/Bash hook

A `PreToolUse` hook that warns (never blocks) when a `Read` or `Bash` call is likely to dump an
unbounded amount of text into the model's context. Companion to `claim-guard.mjs`, documented in
[docs/debug-tools-mcp.md](./debug-tools-mcp.md) — same fail-open shape, opposite decision: that
hook can DENY, this one only ever ADVISES.

## The 2026-08-30 finding

A token audit of recent sessions found `Read` and `Bash` tool calls dominate per-turn context
growth by roughly an order of magnitude over MCP tool traffic (`modoki_*`, `device_*`) — the MCP
surface is summary-first and token-budgeted by design (see `docs/mcp-response-budget.md`), while
`Read` and `Bash` have no such budget of their own. One observed session spent roughly 50k tokens
on a single unbounded `Read` of a large doc file. CLAUDE.md already names the fix as a **mechanical
trigger** — a second read-only search in a row routes to `Explore`, an edit after the plan is
decided routes to `sonnet-implementer` — but that guidance only fires if the agent remembers to
apply it, under pressure, on this specific call. A hook runs unconditionally on the actual tool
input every time, so it backstops the guidance rather than replacing it.

## Why this hook, when a pre-commit hook was declined for a similar discipline problem

CLAUDE.md declines a pre-commit hook for `git add -A` sweeping a stray file into a commit (#18) —
"the discipline IS the guard" there, deliberately. The difference is **decidability**, not "warn
vs. block" on its own. Whether `git add -A` swept something unwanted is undecidable from the commit
alone — the hook would have to guess intent. Whether a file is over 40 KB, or a `git log` has no
`-n`, is a **measured fact** available at the moment of the call — no guessing required. This hook
also never blocks, so even a wrong measurement costs nothing but a line of advisory text.

## What it does

**Script:** `engine/scripts/context-cost-guard.mjs` — Node ESM, styled like `claim-guard.mjs`.
Registered in `.claude/settings.json` as a `PreToolUse` hook on both the `Bash` and `Read`
matchers, appended alongside the existing `claim-guard.mjs` Bash entry.

### Read path

- Skipped entirely when the call already passes `offset`/`limit` — the caller has already bounded
  it.
- Skipped for binary/media extensions (images, fonts, audio/video, archives, native binaries) —
  Read's own handling of those doesn't scale with byte count the way text does.
- **Threshold: 40 KB, measured over the first 2000 lines of the file** (not the file's total size).
  Read effectively charges roughly its own head, not the whole file, so a guard keyed on total size
  would warn on a huge file with a short head (rare) and miss a file that's short overall but reads
  as "large" in its charged portion. 40 KB at ~4 bytes per token (dividing by `BYTES_PER_KTOKEN`,
  4000, gives a kilotoken count) is roughly a 10k-token nudge point — well under the ~50k-token
  outlier that motivated this doc, but high enough that ordinary source files (a few hundred lines)
  never trip it. A cheap `fs.statSync` pre-gate on total file size avoids measuring the head on the
  common small-file case; the head itself is counted in pure Node (no shell, no `head`/`wc`
  subprocess), so no shell ever sees the file path or its content.
- On trip: a `systemMessage` + `additionalContext` naming the approximate KB/token cost and
  suggesting Grep + offset/limit, or delegating to `Explore` — explicitly framed as "if you
  genuinely need the whole file, proceed. This is a nudge, not a refusal." `PreToolUse` fires
  alongside the tool result in the same turn, so by the time the model sees this warning the Read has
  already happened — the nudge shapes the NEXT call, not a choice to abort the one that already ran.

### Bash path

The command is split into segments on `&&`, `||`, `;`, and newlines — deliberately **not** on `|`,
so `git log | wc -l` is one bounded segment even though `git log` alone would trip a rule. A
segment already piped through a bounding filter (`head`, `tail`, `wc`, `grep`/`rg`, `jq`, `less`,
`awk`, `sed`, `cut`, `sort`, `uniq`, `column`, `xargs`), redirected to `/dev/null`, or redirected to
a file, is treated as bounded regardless of which rule below would otherwise match.

Each segment is checked against a fixed rule set, **in this order** — a segment is reported under
the first rule that matches, so order matters whenever two rules could both match the same segment:

| id | trips on | suggested fix |
|---|---|---|
| `help` | `--help` (any CLI) or `man <topic>` | pipe through `head -40`/`grep` for the flag you need |
| `cat` | `cat <file>` with no pipe | pipe through `head -100` / `sed -n`, or use Read with offset/limit |
| `gitlog` | `git log` with no `-n`/`-<N>`/`--max-count` | add `-n 20` (`--oneline` where the body isn't needed) |
| `gitdiff` | `git diff`/`git show` with no `--stat`/`--name-only`/`--name-status`/`--shortstat` | scope with `--stat`/`--name-only` first |
| `lsr` | `ls -R` (any order/combo with `-R`) or `tree` | narrow the path, or pipe through `head -50` |
| `install` | `npm ci/install/i`, `yarn install`, `pnpm i(nstall)` | pipe through `tail -20` |
| `build` | `npm run build` | pipe through `tail -40` |
| `logcat` | `adb … logcat` with no `-t <N>`/`-d` | add `-d -t 200` |

`help` is checked FIRST, ahead of `gitlog`/`gitdiff`/`install`, because it is strictly more
specific and its advice is the only one that fits a help dump — without this, `git log --help`
would report under `gitlog` and nudge `-n 20`, which is meaningless for a command that never
prints history at all.

`help`'s `man` half is anchored to the START of the segment (like `cat` above) — `man` is only
ever an invoked command, never a flag, so anchoring it avoids matching the plain English word
"man" inside an unrelated quoted string (a commit message, an echoed sentence). Its `--help` half
deliberately matches only the long form, never bare `-h` — too many tools overload `-h` for
"human-readable" (`ls -h`, `du -h`, `sort -h`), which would false-positive on ordinary usage
constantly.

⚠️ **`help` still has two known, accepted false-positive edges — not worth a regex fight given the
hook only ever warns.** (1) Unlike `man`, `--help` genuinely can appear anywhere in a real
invocation (`npm run build --help`), so it can't be start-anchored the way `man` is — a quoted
sentence that merely *mentions* `--help` (`git commit -m "add --help output"`) still trips it. (2)
`splitSegments` splits on newline too, so a heredoc commit body makes every line its own "segment
start" — a `man`-anchored line inside a `git commit -F- <<EOF … EOF` body (e.g. a body line reading
"man pages were wrong") still trips the anchor, same as it always could for the `cat` rule above.
Worst case either way: at most two spurious nudges, which also spend the `help` rule's per-session
anti-nag budget, so a later genuine `--help`/`man` call in the same session may go unwarned.

**Deliberately excluded: `npm test`, `npm run verify` (and its `verify:*` variants), and
`npx vitest run`/`vitest run`.** These are the sanctioned gate commands (CLAUDE.md § Tests) — they
are run to completion and their pass/fail plus failure detail is exactly what the agent needs to
see, unlike a `git log` or `cat` whose FULL output is rarely the useful part. Excluding them avoids
training an agent to routinely truncate the one command whose output correctness depends on being
read in full.

**Anti-nag cap:** each Bash rule id warns at most twice per session (tracked in a best-effort
temp-file keyed by `session_id`, under `os.tmpdir()`). A caller who has already seen the `gitlog`
nudge twice this session does not see it a third time — the guidance has been delivered, and a
hook that keeps repeating itself gets ignored or routed around. **The Read path's cap is scoped
per FILE, not per session** — `read-large:<path>` — so re-reading the same large file is capped
at two warnings, but reading N different large files each get their own budget. There is no
session-wide ceiling on Read warnings; a session that reads many distinct large files gets a
nudge for each one.

## Fail-open, and fail-silent — read this before trusting a quiet call

Like `claim-guard.mjs`, any unexpected error inside this script is caught and turned into a silent
exit 0 — a crashing hook must not wedge the session. But this hook goes one step further than
`claim-guard.mjs`'s fail-open: because it **never blocks** even on a real match, a caller cannot
distinguish "this Read/Bash call was actually cheap" from "the guard crashed, mis-detected, or the
anti-nag cap had already been hit." **Its silence is not evidence a call was cheap.** Treat the
mechanical triggers in CLAUDE.md as primary; this hook is a backstop, not a replacement for judgment
about whether a call is bounded.

## Verification status

Pipe-tested directly (raw stdin → script, all cases exit 0, warning cases pass a `jq -e` check for
`continue == true` and no `hookSpecificOutput.permissionDecision`) and covered by
`engine/tests/plugins/contextCostGuard.test.ts` (spawns the real script against real stdin,
including the head-vs-total-size charge model and the `npm test`/`verify`/`vitest` exclusion).

**Verified live, in-session (2026-08-30).** A temporary sentinel string (`CTXGUARD-SENTINEL-93f7a1`)
was inserted into the Read branch's `additionalContext`, a real `Read` was issued against an
oversized file with no `offset`/`limit`, and the sentinel arrived as a `PreToolUse:Read hook
additional context` system-reminder in the calling session — confirming `additionalContext` on a
`PreToolUse` hook does reach the model's context, not just the hook's stdout. The sentinel was then
manually removed from the script and the script's current content was re-read to confirm it was
gone (the script is untracked, so `git diff` on it is trivially clean regardless of content and
proves nothing by itself).

## Open question: subagent session id

It's unverified whether a subagent spawned from a parent session shares the parent's `session_id`
for hook purposes — if it does, the anti-nag budget above is shared across the parent and every
subagent it spawns, and could exhaust faster than a single-session mental model suggests. Documented
open question, not something fixed here.
