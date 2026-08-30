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
 * file is at or above the size floor; the Bash path is pure string/regex work. Both are cheap
 * relative to the call they are guarding against.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
function statePath(sid) {
  return path.join(os.tmpdir(), `modoki-ctxguard-${String(sid).replace(/[^\w-]/g, '')}.json`);
}

function loadState(sid) {
  try {
    return JSON.parse(fs.readFileSync(statePath(sid), 'utf8'));
  } catch {
    return {};
  }
}

function bumpAndCheck(sid, ruleId, max = 2) {
  let state;
  try {
    state = loadState(sid);
    const count = (state[ruleId] || 0) + 1;
    state[ruleId] = count;
    fs.writeFileSync(statePath(sid), JSON.stringify(state));
    return count <= max;
  } catch {
    // State tracking failed — fail toward warning rather than silently disabling the nudge.
    return true;
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

const { tool_name: tool, tool_input: input = {}, session_id: sid = 'nosid' } = payload || {};

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
  let normalizedPath = p;
  try {
    normalizedPath = fs.realpathSync(p);
  } catch {
    // Fall back to the raw path — the cap just becomes spelling-sensitive again, never a crash.
  }
  if (!bumpAndCheck(sid, `read-large:${normalizedPath}`)) return quiet();

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

function handleBash() {
  const command = input.command;
  if (typeof command !== 'string' || !command) return quiet();

  const segments = splitSegments(command);
  for (const seg of segments) {
    if (BOUNDED.test(seg)) continue;
    for (const rule of BASH_RULES) {
      if (!rule.re.test(seg)) continue;
      if (!bumpAndCheck(sid, rule.id)) return quiet(); // hit the anti-nag cap for this rule
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
