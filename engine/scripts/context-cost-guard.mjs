#!/usr/bin/env node
/**
 * The context-cost guard — a Claude Code `PreToolUse` hook that WARNS (never blocks) on a `Read` or
 * `Bash` call likely to dump an unbounded amount of text into the model's context.
 *
 * ── Why a hook, and not just memory/CLAUDE.md ──
 * A 2026-08-30 token audit found `Read`/`Bash` dominate per-session context growth by an order of
 * magnitude over MCP tool traffic, with a single unbounded `Read` costing ~50k tokens in one
 * observed session. CLAUDE.md's "mechanical triggers" (search → Explore, edit → sonnet-implementer)
 * already tell an agent to route around this, but that guidance only fires if the agent remembers to
 * apply it on THIS call, under THIS pressure — a hook runs unconditionally, on the actual tool input,
 * every time. See docs/agent-context-cost.md for the full audit and the threshold justification.
 *
 * ── This NEVER blocks ──
 * Unlike `claim-guard.mjs` (which denies a destructive device command outright), this hook only ever
 * returns an ALLOW with an advisory `systemMessage`/`additionalContext` — reading a big file or
 * running a verbose command is not wrong, it just may cost more than the caller expects. The message
 * says so explicitly: "if you genuinely need the whole file, proceed."
 *
 * ── Fail-open AND fail-silent ──
 * Any error here is swallowed and the hook exits 0 with no output — same fail-open shape as
 * `claim-guard.mjs`, but doubly so: since this hook never blocks, a caller cannot distinguish "this
 * call was cheap" from "the guard crashed/mis-detected and said nothing." Its silence is NOT evidence
 * a call was cheap.
 *
 * ── Cost ──
 * `PreToolUse` spawns this process for every `Read`/`Bash` call. The Read path stats the file first
 * (`fs.statSync`) and only reads its head in-process (`headByteCount`, no shell/subprocess) when the
 * file is at or above the size floor. The Bash path is string/regex work PLUS, for the chain rule,
 * a bounded 64 KiB tail read of the session transcript to identify the current turn — one `open` +
 * one `read`, not a walk of the file. Both are cheap relative to the call they are guarding
 * against.
 */

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { canonicalPath } from './pathIdentity.mjs';

/** Below this, Read's own truncation (or the file simply being small) means the call is cheap enough
 *  not to warn about. Matches the ~50k-token outlier measured in the 2026-08-30 audit scaled down to
 *  a floor that catches "large doc/log" without nagging on ordinary source files. See
 *  docs/agent-context-cost.md for the reasoning. */
const SIZE_FLOOR_BYTES = 40000;
/** Read charges roughly the first 2000 lines of a file, not the whole thing — so the pre-gate on
 *  total file size can still let through a file that is small in its first 2000 lines but huge
 *  overall (rare) or refuse one that's huge overall but bounded in its head (common: a huge file with
 *  short lines). This mirrors what Read actually spends. */
const READ_HEAD_LINES = 2000;
/** Bytes per ~1000 tokens (~4 bytes/token) — good enough for a nudge, not a bill. */
const BYTES_PER_KTOKEN = 4000;

const BINARY_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|pdf|glb|gltf|ktx2|basis|hdr|exr|ttf|otf|woff2?|mp[34]|wav|m4a|mov|zip|so|dylib|a|node)$/i;

/** Anti-nag state — best-effort, session-scoped. Any fs error here just means we warn more than the
 *  cap intends; it must never be a reason to block or crash. */
/** ⚠️ Keyed on the session AND the transcript, because those are different scopes and conflating
 *  them defeated the whole chain rule. **A subagent's hook payload carries the PARENT's
 *  `session_id` but its OWN transcript**, so a single sid-keyed file made the parent and every
 *  concurrent subagent share one `lastBash` slot while drawing turn ids from disjoint message-id
 *  namespaces — `sameTurn` could then never be true across them, each clobbered the other's
 *  `prev.turn`, and an already-batched parallel call got nudged again. Observed in a live session:
 *  one state file holding a subagent's message id with `chain: 49` against a cap of 3. This repo
 *  MANDATES subagents (the `Explore` trigger, `/close-out` § 2), so that was the normal case, not
 *  an edge. One file per agent also gives each its own nag budget, which is what "per session"
 *  was always meant to mean. */
function statePath(sid, transcript) {
  const agent = transcript
    ? '-' + createHash('sha1').update(String(transcript)).digest('hex').slice(0, 10)
    : '';
  return path.join(os.tmpdir(), `modoki-ctxguard-${String(sid).replace(/[^\w-]/g, '')}${agent}.json`);
}

function loadState(sid, tr) {
  try {
    return JSON.parse(fs.readFileSync(statePath(sid, tr), 'utf8'));
  } catch {
    return {};
  }
}

/** Write the state file atomically — temp file then rename, which is atomic on POSIX and Windows
 *  alike, so a reader can no longer catch a HALF-WRITTEN file — which `loadState`'s catch would
 *  turn into `{}`, silently re-arming every rule's counter rather than just the one being written.
 *
 *  ⚠️ **This fixes torn reads and NOT lost updates, and an earlier version of this docblock claimed
 *  otherwise.** The read-modify-write in `bumpAndCheck`/`updateState` is still unsynchronised, so
 *  genuinely concurrent invocations can each read the same counter and overwrite one another —
 *  measured at 5 warns against a cap of 2 before the per-agent split above. That split removes the
 *  common cause (a subagent racing the parent), and same-turn parallel calls now return before
 *  reaching the counter at all, so what remains is rarer but real: **the cap is best-effort, not a
 *  guarantee.** Closing it needs a lock file or an `O_EXCL` retry, which is a failure mode this
 *  never-blocking hook does not want for an advisory nudge. */
function saveState(sid, tr, state) {
  const target = statePath(sid, tr);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, target);
}

function bumpAndCheck(sid, tr, ruleId, max = 2) {
  let state;
  try {
    state = loadState(sid, tr);
    const count = (state[ruleId] || 0) + 1;
    state[ruleId] = count;
    saveState(sid, tr, state);
    return count <= max;
  } catch {
    // State tracking failed — fail toward warning rather than silently disabling the nudge.
    return true;
  }
}

/** Read-modify-write one field of the session state. Separate from `bumpAndCheck` because the chain
 *  rule has to RECORD on every Bash call (including the ones it stays silent about) — folding that
 *  into the counter would make every recorded call also consume the anti-nag budget. */
function updateState(sid, tr, mutate) {
  try {
    const state = loadState(sid, tr);
    mutate(state);
    saveState(sid, tr, state);
  } catch {
    // Best-effort: losing the chain state costs a missed nudge, never a blocked call.
  }
}

/** Count bytes in the first `maxLines` lines of a file (or the whole file if shorter), without
 *  spawning a shell — avoids interpolating an attacker-influenceable file path into a shell string,
 *  and works on Windows (no `head`/`wc` dependency). Mirrors what `head -n N file | wc -c` would
 *  return. */
function headByteCount(filePath, maxLines) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return null;
  }
  try {
    const CHUNK = 65536;
    const buf = Buffer.alloc(CHUNK);
    let total = 0;
    let lines = 0;
    let bytesRead;
    while ((bytesRead = fs.readSync(fd, buf, 0, CHUNK, null)) > 0) {
      for (let i = 0; i < bytesRead; i++) {
        if (buf[i] === 10) { // '\n'
          lines++;
          if (lines >= maxLines) {
            return total + i + 1;
          }
        }
      }
      total += bytesRead;
      if (bytesRead < CHUNK) break; // reached EOF this read
    }
    return total;
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

function quiet() {
  process.exit(0);
}

function warn(systemMessage, additionalContext) {
  process.stdout.write(JSON.stringify({
    continue: true,
    systemMessage,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext,
    },
  }));
  process.exit(0);
}

let payload;
try {
  payload = JSON.parse(fs.readFileSync(0, 'utf8'));
} catch {
  quiet();
}

const { tool_name: tool, tool_input: input = {}, session_id: sid = 'nosid',
  transcript_path: transcriptPath } = payload || {};

/** The id of the assistant message this tool call belongs to — i.e. THIS TURN.
 *
 *  ⚠️ **Without this the chain rule counts CALLS and calls itself turns, which makes it punish the
 *  exact batching it asks for.** Measured during the #1107 review: 8 PARALLEL `ls` calls in ONE
 *  turn produced 5 nudges, each advising "put them in ONE call" about calls that already were in
 *  one call. Parallel calls cost ZERO extra turns — the whole premise of the rule — so they must
 *  not count, and `session_id` cannot separate them because it is constant across the session.
 *
 *  Reads only the TAIL of the transcript (64 KiB), newest record last, so cost does not grow with
 *  a long session. Returns null when it cannot tell. */
function currentTurnKey() {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return null;
  let fd;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 65536);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    // Drop the first line: a tail read almost always starts mid-record.
    const lines = buf.toString('utf8').split('\n').slice(1);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i]) continue;
      try {
        const rec = JSON.parse(lines[i]);
        if (rec?.type === 'assistant' && rec?.message?.id) return String(rec.message.id);
      } catch { /* a partial or non-JSON line — keep walking back */ }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

function handleRead() {
  if (input.offset != null || input.limit != null) return quiet(); // already bounded by the caller
  const p = input.file_path;
  if (typeof p !== 'string' || !p) return quiet();
  if (BINARY_EXT.test(p)) return quiet();

  let stat;
  try {
    stat = fs.statSync(p);
  } catch {
    return quiet(); // doesn't exist — not ours to comment on
  }
  if (!stat.isFile()) return quiet(); // directory or other — Read will error on its own
  if (stat.size < SIZE_FLOOR_BYTES) return quiet();

  // Measure what Read actually charges: roughly its own head, not the whole file.
  const headBytes = headByteCount(p, READ_HEAD_LINES);
  if (!Number.isFinite(headBytes) || headBytes < SIZE_FLOOR_BYTES) return quiet();

  // Normalize the key so `foo.md`, `./foo.md` and an absolute path to the same file share one
  // budget instead of each getting their own 2-warning allowance.
  // #881: was the JS `fs.realpathSync` walk, falling back to the RAW path on throw. `canonicalPath`
  // uses `.native` and falls back to `path.resolve`, so `./foo.md` and `foo.md` still share one
  // budget for a file that has since been deleted — the old fallback gave those two keys.
  const normalizedPath = canonicalPath(p);
  if (!bumpAndCheck(sid, transcriptPath, `read-large:${normalizedPath}`)) return quiet();

  const kb = Math.round(headBytes / 1024);
  const tok = Math.round(headBytes / BYTES_PER_KTOKEN);
  warn(
    `Large Read: ~${kb} KB / ~${tok}k tokens of ${path.basename(p)}`,
    `This Read looks like it will cost roughly ${kb} KB (~${tok}k tokens) of context. Consider `
      + 'Grep to find the relevant section first, then Read with offset/limit — or delegate to '
      + "Explore for a broad search. If you genuinely need the whole file, proceed — this is a "
      + 'nudge, not a refusal.',
  );
}

/** Segments split on shell separators that end a "chain" — pipes are deliberately kept INSIDE a
 *  segment, since `git log | wc -l` is bounded by the pipe even though `git log` alone is not. */
function splitSegments(command) {
  return command.split(/\s*(?:&&|\|\||;|\n)\s*/).filter(Boolean);
}

const BOUNDED = /\|\s*(head|tail|wc|grep|rg|jq|less|awk|sed|cut|sort|uniq|column|xargs)\b|>\s*\/dev\/null|(^|\s)>>?\s*\S/;

const BASH_RULES = [
  {
    id: 'help',
    // `--help` (any CLI, anywhere in the segment — it's a flag, not a command name) or `man <topic>`
    // (anchored to the START of the segment, like `cat` below — `man` is only ever the invoked
    // command itself, never a flag, so anchoring it avoids matching the plain English word "man" in
    // an unrelated quoted string, e.g. `echo "see the man page"` or a commit message mentioning one).
    // Both print a fixed, often long, reference dump that's rarely read in full. Deliberately NOT
    // matching `-h` alone: too many tools overload it for "human-readable" (`ls -h`, `du -h`,
    // `sort -h`), which would false-positive constantly.
    // Checked FIRST (before gitlog/gitdiff/install below): `--help` is strictly more specific than
    // any of those shapes, and only this rule's advice ("pipe to head/grep") actually applies to a
    // help dump — `git log --help` matching `gitlog` instead would nudge `-n 20`, which is nonsense
    // for a command that isn't printing history.
    re: /(^|\s)--help\b|^\s*(?:(?:sudo|time|env)\s+|\w+=\S+\s+)*man\s+\S/,
    fix: 'pipe through `| head -40` or `| grep` for the flag you need',
  },
  {
    id: 'cat',
    // Anchored to the start of the segment (optionally after `sudo`/`time`/`env` or a leading
    // `VAR=val` assignment) so `echo "please cat this file"` doesn't false-positive on `cat`
    // appearing mid-sentence, while `sudo cat foo` / `FOO=1 cat foo` / `time cat foo` still trip.
    re: /^\s*(?:(?:sudo|time|env)\s+|\w+=\S+\s+)*cat\s+(?!<)/,
    fix: "pipe through `| head -100` / `| sed -n 'A,Bp'`, or use Read with offset/limit",
  },
  {
    id: 'gitlog',
    re: /(^|\s)git\s+(-C\s+\S+\s+)?log\b(?!.*(\s-n\s*\d|\s-\d+(\s|$)|--max-count))/,
    fix: 'add `-n 20` (and `--oneline` where the body isn\'t needed)',
  },
  {
    id: 'gitdiff',
    re: /(^|\s)git\s+(-C\s+\S+\s+)?(diff|show)\b(?!.*(--stat|--name-only|--name-status|--shortstat))/,
    fix: 'add `--stat`/`--name-only` first, then diff only the files you need',
  },
  {
    id: 'lsr',
    re: /(^|\s)(ls\s+(-\w*R\w*)|tree)(\s|$)/,
    fix: 'narrow the path, or `| head -50`',
  },
  {
    id: 'install',
    re: /(^|\s)(npm\s+(ci|install|i)\b|yarn\s+install\b|pnpm\s+i(nstall)?\b)/,
    fix: 'pipe through `| tail -20`',
  },
  {
    id: 'build',
    re: /(^|\s)npm\s+run\s+build\b/,
    fix: 'pipe through `| tail -40`',
  },
  {
    id: 'logcat',
    re: /(^|\s)adb\b.*\blogcat\b(?!.*(-t\s*\d|-d\b))/,
    fix: 'add `-d -t 200`',
  },
];

/** Commands that only LOOK at things. A run of these is the case with the least dependency risk —
 *  two probes in a row are usually two questions that could have been one call, which is exactly
 *  what CLAUDE.md's `Explore` trigger is about.
 *
 *  ⚠️ Deliberately narrow, and narrow in ONE direction: a command wrongly left out costs a missed
 *  nudge, while one wrongly let in nags about a chain that was never batchable. So no `node -e` /
 *  `python3 -c` (arbitrary code, frequently a write), no `git config` (its `--get` form reads and
 *  its two-argument form writes), and no test/build runner — `npm test` is not a probe however
 *  read-only its effect on the repo. */
const PROBE_HEADS = new Set([
  'ls', 'find', 'grep', 'rg', 'cat', 'head', 'tail', 'wc', 'file', 'stat', 'du', 'df',
  'pwd', 'which', 'basename', 'dirname', 'realpath', 'diff', 'sed', 'awk', 'jq', 'sort',
  'uniq', 'cut', 'tr', 'column', 'date', 'printenv',
]);
/** Read-only subcommands of the two multiplexers worth covering — both are overwhelmingly the
 *  read half in practice, and both have write subcommands one word away (`git commit`, `gh issue
 *  create`), so they are matched as PAIRS rather than by head alone. */
const PROBE_PAIRS = new Set([
  'git status', 'git log', 'git diff', 'git show', 'git branch', 'git blame', 'git rev-parse',
  'git rev-list', 'git merge-base', 'git describe', 'git shortlog', 'git cat-file',
  'gh issue view', 'gh issue list', 'gh pr view', 'gh pr list', 'gh label list', 'gh run list',
]);
// ⚠️ `git ls` + `-files` is deliberately NOT in that set, and must not be "helpfully" added back.
// `corpusProducerIsShared.test.ts` rule 1 scans every file's source for that literal to catch a
// second corpus enumeration, and it matches a STRING as readily as a spawn (comments are stripped
// first, which is why this note is safe where the entry was not). Listing it here costs an
// exemption on somebody else's guard to buy a nudge on a command this repo barely runs — and the
// classifier is documented as erring toward silence, so leaving it out is the consistent call.
/** Neither a probe nor a reason to disqualify one. `echo` is the common case by far — a compound
 *  probe is routinely `cmd && echo "===" && cmd`, and treating the label as a non-probe would make
 *  the whole chain rule miss exactly the calls it is aimed at. */
const NEUTRAL_HEADS = new Set(['echo', 'true', ':', 'cd']);

/** Commands that WRITE, wherever they appear. `splitSegments` deliberately keeps pipes inside one
 *  segment, so the segment HEAD decides the whole pipeline — which made `cat patch.diff | git apply`
 *  and `grep -rl foo . | xargs sed -i ...` classify as read-only probes. A chain containing a write
 *  is the one case where the later command genuinely depends on the earlier, so nudging "put them
 *  in ONE call" is actively wrong advice. Scanned across the whole segment, not just its head. */
const WRITES_ANYWHERE = /(^|[\s|])(sed\s+--?i|perl\s+-[^\s]*i|tee\b|xargs\b|git\s+apply\b|patch\b|install\b|mv\b|cp\b|rm\b|mkdir\b|touch\b|truncate\b|dd\b|chmod\b|chown\b|ln\b)|(^|\s)-delete\b|(^|\s)-exec\b|\bsort\b[^|]*\s-o\s/;

/** Strip the prefixes that sit in front of the real command word. Mirrors the `cat`/`help` rules'
 *  own allowance for `sudo`/`time`/`env`/`VAR=val`. */
function commandHead(segment) {
  const bare = segment.replace(/^\s*(?:(?:sudo|time|env)\s+|\w+=\S+\s+)*/, '').trim();
  const words = bare.split(/\s+/);
  const head = (words[0] ?? '').replace(/^.*\//, '');   // `/usr/bin/grep` -> `grep`
  // ⚠️ Skip `-C <path>` before taking the subcommand. The global CLAUDE.md MANDATES `git -C` for any
  // repo outside the cwd, so without this every such call fell out of PROBE_PAIRS — the guard was
  // blind to the spelling the rules require.
  let rest = words.slice(1);
  while (rest[0] === '-C' && rest.length > 1) rest = rest.slice(2);
  const pair = `${head} ${(rest[0] ?? '').replace(/^-.*/, '')}`.trim();
  return { head, pair };
}

/** True when EVERY segment only looks at things, and at least one actually looks. A write
 *  redirection disqualifies the whole command however read-only its head is — `ls > manifest.txt`
 *  produces a file, so a later call may legitimately depend on it. */
function isReadOnlyProbe(segments) {
  let sawProbe = false;
  for (const seg of segments) {
    // A redirect to anything but /dev/null produces a file a later command can depend on, so it is
    // not a pure probe. ⚠️ Three corrections review made to this line, each worth keeping:
    //  • `(^|\s|\d)` not `(^|\s)` — the old guard needed whitespace, so `ls 2> log` slipped through.
    //  • `2>&1` DUPLICATES a descriptor and creates no file, so it must not disqualify. It is the
    //    commonest stderr idiom here and the first version of this fix broke it.
    //  • `cmd>out` with no space at all is still NOT caught, and the comment used to claim it was.
    //    Left as a known gap rather than a silently false claim: it errs toward a missed nudge.
    if (/(^|\s|\d)>>?\s*(?!\/dev\/null|&\d)\S/.test(seg)) return false;
    if (WRITES_ANYWHERE.test(seg)) return false;
    const { head, pair } = commandHead(seg);
    if (PROBE_PAIRS.has(pair) || PROBE_HEADS.has(head)) { sawProbe = true; continue; }
    if (NEUTRAL_HEADS.has(head)) continue;
    return false;
  }
  return sawProbe;
}

/** How long a gap still counts as the same burst. Two probes seconds apart were plausibly one
 *  batch; two an hour apart were two decisions, and merging them was never available. Generous on
 *  purpose — over-warning here is a nudge, and the anti-nag cap bounds it either way. */
const CHAIN_WINDOW_MS = 180_000;

/** The chain rule (#1107) — the one aimed at what a Bash call actually costs.
 *
 *  ⚠️ **The size rules guard the smaller share of what a Bash call costs; this one guards the
 *  larger.** The measured split and every figure behind it live in `docs/agent-context-cost.md` —
 *  deliberately NOT restated here, because an earlier version of this docblock carried its own copy
 *  of the numbers, got the units wrong (comparing token-equivalents against raw tokens, a ~12x
 *  error) and then disagreed with the doc about the session count. One fact, one doc.
 *
 *  ⚠️ **Known blind spot, stated rather than papered over:** the hook is registered on `Bash` and
 *  `Read` only, so an intervening `Edit`/`Grep`/MCP call is invisible and "consecutive" means
 *  consecutive *as this hook sees them*. A wildcard matcher would see everything and was rejected:
 *  it spawns a node process on every tool call in the session, and the precision it buys does not
 *  change the advice (two probes either side of an `Edit` are still two turns).
 *
 *  Returns the `[systemMessage, additionalContext]` pair to warn with, or null to stay silent. It
 *  does NOT call `warn()` itself: `warn()` exits the process, so warning from in here would make
 *  every line after the call site dead code and hide that fact from the reader. */
function checkChain(sid, tr, segments) {
  const probe = isReadOnlyProbe(segments);
  const now = Date.now();
  const turn = currentTurnKey();
  let runLength = 1;
  let sameTurn = false;
  updateState(sid, tr, (state) => {
    const prev = state.lastBash;
    // ⚠️ SAME TURN = parallel calls = ZERO extra turns. The rule's entire premise is that an extra
    // TURN costs a whole prefix re-read; calls issued together in one assistant message cost one
    // turn between them, and telling their author to "put them in ONE call" describes what they
    // already did. Record, never count.
    sameTurn = !!(turn && prev?.turn && prev.turn === turn);
    const continues = probe && prev?.probe && (now - (prev.at ?? 0)) < CHAIN_WINDOW_MS;
    runLength = continues ? (prev.run ?? 1) + 1 : 1;
    // ⚠️ ONE guard, not two. A parallel batch neither advances the run (it costs no extra turn) nor
    // RESETS it (the run it sits inside is still real), so the length is simply carried. An earlier
    // version also excluded `sameTurn` from `continues` above — belt and braces that no mutation
    // could distinguish, since either line alone suppressed the nudge and the test could not tell
    // which was load-bearing. Removing one makes the other testable.
    if (sameTurn) runLength = prev?.run ?? 1;
    state.lastBash = { at: now, probe, run: runLength, turn: turn ?? prev?.turn ?? null };
  });
  if (sameTurn) return null;
  // ⚠️ No turn id, no nudge. Without one this rule cannot tell a batched call from a wasted turn,
  // and a nudge that fires on correct batching teaches the opposite of what it means to teach. A
  // missed nudge costs nothing; a wrong one costs the behaviour the rule exists to produce.
  if (!turn) return null;
  if (runLength < 2) return null;
  // A slightly wider budget than the size rules: this is the rule worth hearing, and a session
  // makes ~7 such runs. Still capped — a nudge that fires every time stops being read.
  if (!bumpAndCheck(sid, tr, 'chain', 3)) return null;
  return [
    `${runLength} read-only shell probes in separate turns — a turn re-reads the whole conversation`,
    `This is read-only probe #${runLength} in a row, each in its own turn. A turn re-reads the ENTIRE `
      + 'conversation before it does anything, which on a long session is the single largest line '
      + 'in the bill — larger than the output it prints (docs/agent-context-cost.md has the '
      + 'measured split). If these probes do '
      + 'not depend on each other, put them in ONE call — that is a real saving and it costs '
      + 'nothing. If this is a search across files, delegate to `Explore` (CLAUDE.md\'s mechanical '
      + 'trigger). If each command genuinely needed the previous answer, proceed — that is not '
      + 'batchable, and this nudge is wrong about you.',
  ];
}

function handleBash() {
  const command = input.command;
  if (typeof command !== 'string' || !command) return quiet();

  const segments = splitSegments(command);
  // Checked BEFORE the size rules: a redundant turn costs ~30x what a fat result does, so when a
  // call is both, the chain advice is the one worth spending the turn's attention on. `warn()`
  // exits, so a chain warning suppresses the size rule for this call only — the size rules keep
  // their own per-session budget for the next call that trips one.
  const chain = checkChain(sid, transcriptPath, segments);
  if (chain) return warn(chain[0], chain[1]);
  for (const seg of segments) {
    if (BOUNDED.test(seg)) continue;
    for (const rule of BASH_RULES) {
      if (!rule.re.test(seg)) continue;
      if (!bumpAndCheck(sid, transcriptPath, rule.id)) return quiet(); // hit the anti-nag cap for this rule
      const msg = `Unbounded command (${rule.id}): ${rule.fix}`;
      warn(
        msg,
        `${msg} — this is a heuristic — if you know the output is short, proceed.`,
      );
      return; // warn() already exits
    }
  }
  return quiet();
}

try {
  if (tool === 'Read') handleRead();
  else if (tool === 'Bash') handleBash();
  else quiet();
} catch {
  // A guard that throws must not wedge the session — fail open and silent.
  quiet();
}
