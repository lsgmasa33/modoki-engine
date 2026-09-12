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
trigger** — a second read-only search in a row routes to `Explore` — but that guidance only fires if
the agent remembers to apply it, under pressure, on this specific call. (At the time of this audit a
second trigger routed a decided edit to `sonnet-implementer`; that one was **repealed on 2026-09-07**
when implementation delegation ended — see [model-routing.md](model-routing.md) — which puts those
edits' reads back in-session and makes bounding `Read`/`Bash` matter more, not less.) A hook runs unconditionally on the actual tool
input every time, so it backstops the guidance rather than replacing it.

## The 2026-09-12 measurement — the premise holds, the Bash half is aimed wrong

The finding above was a token audit "of recent sessions". It has now been measured across the whole
corpus — **635 sessions, 94,450 assistant turns, all five Mac clones** — with
`engine/scripts/token-spend-report.mjs` (#1104), which reads Claude Code's own per-turn usage blocks
out of `~/.claude/projects/**/*.jsonl`. Re-run it rather than trusting these numbers after a few
months; they are a snapshot of how the owner works, not a constant.

**The premise is confirmed, and by a wider margin than "an order of magnitude":**

| | share of context growth |
|---|---|
| `Bash` | **71.3%** |
| `Read` | 7.4% |
| `Edit` | 3.7% |
| every `modoki_*` + `device_*` tool combined | **~7%** |

**Why context growth is the thing worth guarding at all** — the number that reframes it: each token
written into the cached prefix is read back **113.8 times** on average. At 1.25x to write and 0.1x
per read, **one context token costs ~12.6x a base input token**, so 1,000 tokens of tool output is
~12,600 base-input-token equivalents, not 1,250. Cache *reads* are 80.6% of all spend. Context is
not a budget you fill, it is a rent you pay every turn.

⚠️ **Both figures below are in base-input-token EQUIVALENTS. Never compare one against a raw token
count** — that mistake is why the first version of this section claimed the size rules guard "3%"
of a `Bash` call and the `chain` rule "97%". The real split is ~28/72 (worked below), and the error
reached `CLAUDE.md` before review caught it.

⚠️ **But the Bash rules are shaped for a tail that does not exist.** The measured distribution:

| tool | median | p90 | worst 10% of calls | calls over 5k |
|---|---|---|---|---|
| `Bash` | 647 | 1,886 | 33% of its growth | **214 of 23,768** |
| `Read` | 1,154 | 2,471 | **49%** of its growth | 51 of 1,173 (23 over 20k) |

⚠️ **The growth table above is measured over SINGLE-TOOL turns only.** `attributeGrowth` skips any
turn whose predecessor made more than one tool call, because there is no non-guessing way to split
one `cache_creation` figure between two calls. The script prints that qualifier ("over N
single-tool turns") and this doc must not drop it — it also means a successful `chain` rule pushes
growth into the unmeasured multi-tool bucket, so the shares are **not** comparable across a
re-measurement that follows a behaviour change. Compare the raw per-turn context and the
consecutive-run count instead.

`Read`'s cost really is a tail — half of it sits in the worst tenth, which is exactly what a
40 KB threshold catches, and the ~50k-token outlier that motivated this doc is a real member of
that tail. **`Bash`'s is not.** Its 71.3% is 23,768 calls averaging 947 tokens; the worst 1% is
only 7.8% of the total. Every rule in the table above fires on an unusually *fat* call, and only
~1% of `Bash` **calls** are fat enough to trip one.

**What this does NOT mean.** The rules are still worth keeping — they are cheap, they never block,
and a 105k-token `Bash` result did happen. It means the Bash path cannot be *improved* by adding
rules or lowering thresholds, because there is no fat tail left to catch. A future session tempted
to tune these thresholds should re-run the script first and check whether the shape has changed.

## The `chain` rule — guarding the turn instead of the result (#1107)

**A turn is the unit of cost.** The average turn re-reads **307,986 tokens** of cached prefix, so
at the 0.1x read rate it costs **~30,800 base-input-token equivalents before it emits anything**.
The average `Bash` result is 947 raw tokens, which at 12.6x is **~11,960 equivalents**. So one
`Bash` call costs roughly **30,800 (the turn) + 11,960 (its output) = ~42,800**, i.e. the size
rules above guard ~**28%** of it and the `chain` rule the other ~**72%** — the turn is ~2.6x the
output, not 30x.

⚠️ **The decision to batch does not rest on that ratio at all**, which is why the correction does
not weaken the rule. Merging two independent probes into one call prints exactly the same bytes;
it removes one whole prefix read and nothing else. The saving is the turn, in full, every time.

**What it does.** Fires when this call is a read-only probe, the previous `Bash` call was one, and
the two were issued **in different turns** — reporting the run length.

⚠️ **"In different turns" is load-bearing and was missing from the first version.** Parallel tool
calls share one assistant message and therefore cost ZERO extra turns, so nudging them is not
merely noise — it tells their author to do the thing they just did, and contradicts the harness's
own instruction to issue independent calls in one block. Measured against the real hook before the
fix: 8 parallel `ls` calls produced **5** nudges; after, **0**. The turn is identified by the last
assistant message id in the tail of `transcript_path`, and when that cannot be read the rule stays
**silent** rather than guessing — a missed nudge costs nothing, a wrong one costs the behaviour the
rule exists to produce. Read-only probes are the case with the least dependency risk — two
"what does this look like" questions are usually one call that got split — and they are what
CLAUDE.md's `Explore` trigger already names. Measured size of the target: 4,760 runs of consecutive
single-`Bash` turns (median 2, longest 31) covering 12,364 turns; collapsing each to one call would
remove 7,604 turns, **8.1% of all turns**.

⚠️ **That 8.1% is an upper bound and must never be quoted as a saving.** Many consecutive probes
are genuinely dependent — the second command is chosen after reading the first one's answer — and
those are not batchable at any price. Nothing measures the independent subset.

**Three deliberate narrownesses**, each of which looks like an omission until you know why:

- **The probe classifier errs toward silence.** A command wrongly left out costs a missed nudge;
  one wrongly let in nags about a chain that was never batchable. So no `node -e`/`python3 -c`
  (arbitrary code, frequently a write), no `git config` (its `--get` reads, its two-argument form
  writes), and `git`/`gh` matched as PAIRS rather than by head — `git commit` is one word from
  `git status`. ⚠️ It did NOT err that way at first: because `splitSegments` keeps pipes inside one
  segment, the segment HEAD decided the whole pipeline, so `cat patch.diff | git apply`,
  `grep -rl foo . | xargs sed -i`, `ls | tee f`, `sed -i`, `find -delete` and `sort -o` all passed
  as read-only — and a chain containing a write is precisely where the later command depends on the
  earlier. Writes are now rejected wherever they appear in the segment, and the redirect test no
  longer requires whitespace before `>` (so `ls 2> log` counts).
- **`echo` is neutral rather than disqualifying.** A compound probe is routinely
  `cmd && echo "===" && cmd`; treating the label as a non-probe would miss exactly the calls the
  rule is aimed at.
- **Checked BEFORE the size rules**, because when a call is both a fat result and a redundant turn,
  the turn is the larger share (~72% against ~28%). Its cap (3/session, against 2 for the size
  rules) then hands the floor
  back, so a noisy stretch of probes cannot silence the size rules for the rest of the session —
  pinned by a test, since that starvation is the obvious failure of putting it first.

⚠️ **Known blind spot.** The hook is registered on `Bash` and `Read` only, so an intervening
`Edit`/`Grep`/MCP call is invisible: "consecutive" means consecutive *as this hook sees them*, and
a probe either side of an `Edit` counts as a run. A wildcard matcher would see everything and was
rejected — it spawns a node process on every tool call in the session for a nudge, and the
precision does not change the advice (two probes either side of an `Edit` are still two turns).

### How to tell whether this rule earns its place

⚠️ **This is the rare guard whose effect is measurable after the fact, so it must actually be
measured.** Re-run `token-spend-report.mjs` and compare the consecutive-run counts per session
against the 2026-09-12 baseline above. **If the number has not moved, delete the rule rather than
tuning it** — a nudge nobody acts on is a line of advisory text on every probe, and "tune the
threshold" is how a guard that never worked acquires a second decade.

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
