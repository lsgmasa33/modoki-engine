/**
 * The context-cost guard, end to end — `engine/scripts/context-cost-guard.mjs` as Claude Code
 * actually runs it: a real process, a real `PreToolUse` payload on stdin.
 *
 * Driven by SPAWNING the script rather than importing it, for the same reason as
 * `claimGuard.test.ts`: a hook that returns the wrong SHAPE fails OPEN (Claude Code treats
 * malformed hook output as non-blocking), so only the real stdout proves the shape is right.
 *
 * This guard NEVER blocks — every assertion below checks `continue !== false` and that
 * `hookSpecificOutput.permissionDecision` is absent, on every path, warning or silent.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasAgentSettings } from '../helpers/repoLayout';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..', '..');
const guard = path.join(repoRoot, 'engine/scripts/context-cost-guard.mjs');

let tmpDir: string;
let sidCounter = 0;
/** A fresh session id per call so the anti-nag cap in the guard's own tmp-state file never bleeds
 *  between assertions — the guard's cap is a deliberate per-session behavior, tested separately. */
function freshSid(): string {
  sidCounter += 1;
  return `ctxguard-test-${process.pid}-${sidCounter}`;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-ctxguard-fixtures-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** The guard writes a `modoki-ctxguard-<sid>.json` anti-nag state file per session id into
 *  `os.tmpdir()` (see `statePath()` in context-cost-guard.mjs) and never cleans it up itself — that
 *  is the guard's own responsibility to skip (best-effort, session-scoped). This test suite mints a
 *  fresh sid per assertion via `freshSid()`, so it can otherwise leak one state file per test run
 *  forever. Sweep every state file this run created, matched by the `freshSid()` prefix. */
afterAll(() => {
  const prefix = `modoki-ctxguard-ctxguard-test-${process.pid}-`;
  let entries: string[];
  try {
    entries = fs.readdirSync(os.tmpdir());
  } catch {
    return;
  }
  for (const name of entries) {
    if (name.startsWith(prefix) && name.endsWith('.json')) {
      try {
        fs.unlinkSync(path.join(os.tmpdir(), name));
      } catch {
        // best-effort cleanup — never fail the suite over a stray temp file
      }
    }
  }
});

interface GuardResult {
  status: number;
  stdout: string;
  parsed: Record<string, unknown> | null;
}

function runGuard(toolName: string, toolInput: Record<string, unknown>, sid = freshSid(), transcriptPath?: string): GuardResult {
  const payload = JSON.stringify({
    session_id: sid,
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput,
    ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
  });
  const res = spawnSync(process.execPath, [guard], { input: payload, encoding: 'utf8' });
  const out = (res.stdout ?? '').trim();
  return { status: res.status ?? -1, stdout: out, parsed: out ? JSON.parse(out) : null };
}

function runGuardRaw(stdin: string): GuardResult {
  const res = spawnSync(process.execPath, [guard], { input: stdin, encoding: 'utf8' });
  const out = (res.stdout ?? '').trim();
  return { status: res.status ?? -1, stdout: out, parsed: out ? JSON.parse(out) : null };
}

/** Every path must go through this — the guard's entire contract is "never block". */
function expectNeverBlocks(r: GuardResult) {
  expect(r.status).toBe(0);
  if (r.parsed) {
    expect(r.parsed.continue).not.toBe(false);
    const hso = r.parsed.hookSpecificOutput as Record<string, unknown> | undefined;
    expect(hso?.permissionDecision).toBeUndefined();
  }
}

describe('context-cost-guard — Read path', () => {
  it('says nothing about a small file', () => {
    const r = runGuard('Read', { file_path: path.join(repoRoot, 'package.json') });
    expectNeverBlocks(r);
    expect(r.stdout).toBe('');
  });

  it('says nothing when offset/limit already bound the call', () => {
    const big = path.join(tmpDir, 'big.txt');
    fs.writeFileSync(big, 'x'.repeat(60000));
    const r = runGuard('Read', { file_path: big, offset: 1, limit: 50 });
    expectNeverBlocks(r);
    expect(r.stdout).toBe('');
  });

  it('warns on a large unbounded read, without blocking', () => {
    const big = path.join(tmpDir, 'big.txt');
    fs.writeFileSync(big, 'x'.repeat(60000));
    const r = runGuard('Read', { file_path: big });
    expectNeverBlocks(r);
    expect(r.parsed).not.toBeNull();
    expect(r.parsed?.systemMessage).toMatch(/Large Read/);
    const hso = r.parsed?.hookSpecificOutput as Record<string, unknown>;
    expect(hso.additionalContext).toMatch(/nudge, not a refusal/);
  });

  it('says nothing about a nonexistent file', () => {
    const r = runGuard('Read', { file_path: path.join(tmpDir, 'does-not-exist.txt') });
    expectNeverBlocks(r);
    expect(r.stdout).toBe('');
  });

  it('says nothing about a binary/media extension even when large', () => {
    const png = path.join(tmpDir, 'huge.png');
    fs.writeFileSync(png, Buffer.alloc(60000));
    const r = runGuard('Read', { file_path: png });
    expectNeverBlocks(r);
    expect(r.stdout).toBe('');
  });

  it('charges the HEAD of the file, not its total size — a large tail must not trigger a warning', () => {
    // Short first 2000 lines (well under the floor), then a huge tail. Read effectively charges the
    // head, so a guard that measured TOTAL file size (not the head) would warn here — and that is
    // exactly the distinction this test exists to prove.
    const p = path.join(tmpDir, 'short-head-long-tail.txt');
    const head = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n') + '\n';
    const tail = 'y'.repeat(200000);
    fs.writeFileSync(p, head + tail);
    expect(fs.statSync(p).size).toBeGreaterThan(40000); // total size clears the pre-gate floor
    const r = runGuard('Read', { file_path: p });
    expectNeverBlocks(r);
    expect(r.stdout).toBe(''); // but the guard is silent — it measured the head, not the total
  });

  it('warns when the head itself is large even if the file is not enormous', () => {
    const p = path.join(tmpDir, 'long-head.txt');
    fs.writeFileSync(p, 'z'.repeat(50000));
    const r = runGuard('Read', { file_path: p });
    expectNeverBlocks(r);
    expect(r.parsed?.systemMessage).toMatch(/Large Read/);
  });

  it('does not execute shell metacharacters embedded in the file PATH (command injection PoC)', () => {
    // The old implementation shelled out with `/bin/sh -c "head -n N \"<path>\" | wc -c"` and only
    // escaped `"` in the path — `$(...)`/backticks inside a double-quoted shell string are still
    // expanded by the shell, so a malicious FILENAME executed arbitrary commands. This is a real
    // discriminating PoC: the marker name is deliberately slash-free (a literal `/` cannot appear in
    // a single filename component on any POSIX filesystem, so a path-embedded slash could never be
    // used to construct the malicious file in the first place) and the guard is spawned with `cwd`
    // pinned to `tmpDir` so a `touch <relative-name>` from the OLD vulnerable code would land in a
    // location this test can observe and clean up.
    const markerName = 'PWNED_marker_ctxguard';
    const evilName = 'evil_$(touch ' + markerName + ')`touch ' + markerName + '`.md';
    const p = path.join(tmpDir, evilName);
    fs.writeFileSync(p, 'x'.repeat(50000));

    const payload = JSON.stringify({
      session_id: freshSid(),
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: p },
    });
    const res = spawnSync(process.execPath, [guard], { input: payload, encoding: 'utf8', cwd: tmpDir });
    const out = (res.stdout ?? '').trim();
    const r: GuardResult = { status: res.status ?? -1, stdout: out, parsed: out ? JSON.parse(out) : null };

    expectNeverBlocks(r);
    expect(fs.existsSync(path.join(tmpDir, markerName))).toBe(false);
    // Content still clears the size floor within the first 2000 lines, so the guard should still warn.
    expect(r.parsed?.systemMessage).toMatch(/Large Read/);
  });

  it('reads large-file-A twice (2nd warns, cap default 2), a 3rd read of A is silent, but a different large-file-B still warns', () => {
    const sid = freshSid();
    const a = path.join(tmpDir, 'file-a.txt');
    const b = path.join(tmpDir, 'file-b.txt');
    fs.writeFileSync(a, 'a'.repeat(50000));
    fs.writeFileSync(b, 'b'.repeat(50000));

    const a1 = runGuard('Read', { file_path: a }, sid);
    const a2 = runGuard('Read', { file_path: a }, sid);
    const a3 = runGuard('Read', { file_path: a }, sid);
    const b1 = runGuard('Read', { file_path: b }, sid);

    expectNeverBlocks(a1);
    expectNeverBlocks(a2);
    expectNeverBlocks(a3);
    expectNeverBlocks(b1);

    expect(a1.stdout).not.toBe(''); // 1st read of A: warns
    expect(a2.stdout).not.toBe(''); // 2nd read of A: warns (cap is 2)
    expect(a3.stdout).toBe(''); // 3rd read of A: anti-nag cap hit for A specifically
    expect(b1.stdout).not.toBe(''); // different file: must still warn — its own cap, not shared with A
  });

  it('shares the per-file anti-nag budget across different spellings of the same path', () => {
    const sid = freshSid();
    const abs = path.join(tmpDir, 'spelled.txt');
    fs.writeFileSync(abs, 'x'.repeat(50000));
    // Built with string concatenation, not path.join — path.join would collapse the "/./" away and
    // silently make this identical to `abs`, defeating the point of the test.
    const dotted = `${tmpDir}/./spelled.txt`;
    expect(dotted).not.toBe(abs); // sanity: this test is worthless if the two strings match

    const r1 = runGuard('Read', { file_path: abs }, sid);
    const r2 = runGuard('Read', { file_path: dotted }, sid);
    const r3 = runGuard('Read', { file_path: abs }, sid);

    expectNeverBlocks(r1);
    expectNeverBlocks(r2);
    expectNeverBlocks(r3);

    expect(r1.stdout).not.toBe(''); // 1st spelling: warns
    expect(r2.stdout).not.toBe(''); // different spelling, same real file: still counts against the cap
    expect(r3.stdout).toBe(''); // 3rd read of the same real file (any spelling): cap hit
  });
});

describe('context-cost-guard — Bash path', () => {
  it('says nothing about a bounded command', () => {
    const r = runGuard('Bash', { command: 'git log -n 20 --oneline' });
    expectNeverBlocks(r);
    expect(r.stdout).toBe('');
  });

  it('warns on an unbounded git log without blocking', () => {
    const r = runGuard('Bash', { command: 'git log --oneline' });
    expectNeverBlocks(r);
    expect(r.parsed?.systemMessage).toMatch(/gitlog/);
  });

  it('sees an unbounded segment in the second half of a && chain', () => {
    const r = runGuard('Bash', { command: 'wc -l foo | head -3 && git log' });
    expectNeverBlocks(r);
    expect(r.parsed?.systemMessage).toMatch(/gitlog/);
  });

  it('does not warn on npm test / npm run verify / vitest — deliberately excluded', () => {
    for (const cmd of ['npm test', 'npm run verify', 'npm run verify:all', 'npx vitest run', 'npm run coverage']) {
      const r = runGuard('Bash', { command: cmd });
      expectNeverBlocks(r);
      expect(r.stdout, cmd).toBe('');
    }
  });

  it('warns on other unbounded rule shapes', () => {
    const cases: Array<[string, RegExp]> = [
      ['cat some/big/file.txt', /cat/],
      ['git diff', /gitdiff/],
      ['ls -laR /', /lsr/],
      ['npm install', /install/],
      ['npm run build', /build/],
      ['adb logcat', /logcat/],
      ['ccusage --help', /help/],
      ['man git', /help/],
    ];
    for (const [cmd, expected] of cases) {
      const r = runGuard('Bash', { command: cmd });
      expectNeverBlocks(r);
      expect(r.parsed?.systemMessage, cmd).toMatch(expected);
    }
  });

  it('does not treat -h as --help — too many tools overload it for human-readable output', () => {
    for (const cmd of ['ls -h', 'du -sh .', 'sort -h']) {
      const r = runGuard('Bash', { command: cmd });
      expectNeverBlocks(r);
      expect(r.stdout, cmd).toBe('');
    }
  });

  it('anchors `man` to the segment start so the plain word does not false-positive mid-sentence', () => {
    // Regression: an earlier version matched bare `man` anywhere in the segment, so a quoted
    // sentence merely CONTAINING the English word "man" (a commit message, an echoed string)
    // wrongly tripped the rule. `man` is only ever a command name, never a flag, so it must be
    // anchored like `cat` is.
    for (const cmd of ['git commit -m "see man bash for details"', 'echo "run man page if confused"', 'man']) {
      const r = runGuard('Bash', { command: cmd });
      expectNeverBlocks(r);
      expect(r.stdout, cmd).toBe('');
    }
    for (const cmd of ['man git', 'sudo man ls']) {
      const r = runGuard('Bash', { command: cmd });
      expectNeverBlocks(r);
      expect(r.parsed?.systemMessage, cmd).toMatch(/help/);
    }
  });

  it('does not loosen `man` to a bare word boundary — words merely containing "man" stay silent', () => {
    // Guards against the tempting-but-wrong "simplification" `(^|\s)man\b` or `\bman\b`, which
    // would pass every OTHER test in this file while making `manifest`/`human`/`find -name man*`
    // all warn. This is deliberately a word list, not a regex-shape assertion, so it fails if
    // the implementation regex changes in a way that reintroduces the false positive.
    for (const cmd of ['npm run manifest', 'echo manifest.json', 'ls -la human/', "find . -name 'man*'"]) {
      const r = runGuard('Bash', { command: cmd });
      expectNeverBlocks(r);
      expect(r.stdout, cmd).toBe('');
    }
  });

  it('checks `help` before `gitlog`/`gitdiff`/`install` — their advice does not apply to a help dump', () => {
    // `git log --help` / `git diff --help` / `npm install --help` are all more specifically
    // "print --help text" than "an unbounded git log/diff/install" — the earlier rules' fixes
    // (`-n 20`, `--stat`, `| tail -20`) are nonsense advice for a command that never touches
    // history/diff/registry output at all.
    for (const cmd of ['git log --help', 'git diff --help', 'npm install --help']) {
      const r = runGuard('Bash', { command: cmd });
      expectNeverBlocks(r);
      expect(r.parsed?.systemMessage, cmd).toMatch(/help/);
    }
  });

  it('does not warn when the same command is piped through a bounding filter', () => {
    for (const cmd of ['cat some/big/file.txt | head -100', 'git log | wc -l', 'ls -laR / | head -50', 'ccusage --help | head -40']) {
      const r = runGuard('Bash', { command: cmd });
      expectNeverBlocks(r);
      expect(r.stdout, cmd).toBe('');
    }
  });

  it('does not let a dash-digit ANYWHERE later in the command (e.g. a date) fake a bound on git log', () => {
    // Regression: the old lookahead `(?!.*(-n\s*\d|-\d|--max-count))` matched `-\d` anywhere in the
    // rest of the string, so a dash-digit inside a date/grep/pathspec wrongly looked like a count flag.
    const cases = ['git log --since=2026-08-01', 'git log --after=2026-01-01 --pretty=full', 'git log -- src/foo-2.ts', 'git log --grep=-5'];
    for (const cmd of cases) {
      const r = runGuard('Bash', { command: cmd });
      expectNeverBlocks(r);
      expect(r.parsed?.systemMessage, cmd).toMatch(/gitlog/);
    }
  });

  it('still recognizes real count flags as bounding git log', () => {
    for (const cmd of ['git log -n 20', 'git log -5']) {
      const r = runGuard('Bash', { command: cmd });
      expectNeverBlocks(r);
      expect(r.stdout, cmd).toBe('');
    }
  });

  it('does not flag "cat" appearing mid-sentence, only as the command itself', () => {
    const r = runGuard('Bash', { command: 'echo "please cat this file"' });
    expectNeverBlocks(r);
    expect(r.stdout).toBe('');
  });

  it('does not flag a "cat" mention inside a heredoc body line', () => {
    const r = runGuard('Bash', { command: 'cat > /tmp/f <<EOF\nhello cat world\nEOF' });
    expectNeverBlocks(r);
    // The `cat > /tmp/f <<EOF` segment itself is redirect-bounded (matches BOUNDED); the heredoc body
    // line `hello cat world` must not separately trip the `cat` rule after the newline split.
    expect(r.stdout).toBe('');
  });

  it('still flags an unbounded cat command as the true positive', () => {
    const r = runGuard('Bash', { command: 'cat some/huge/file.log' });
    expectNeverBlocks(r);
    expect(r.parsed?.systemMessage).toMatch(/cat/);
  });

  it('still flags cat behind sudo/time/env or a leading VAR= assignment', () => {
    for (const cmd of ['sudo cat foo', 'time cat foo', 'env cat foo', 'FOO=1 cat foo']) {
      const r = runGuard('Bash', { command: cmd });
      expectNeverBlocks(r);
      expect(r.parsed?.systemMessage, cmd).toMatch(/cat/);
    }
  });

  it('flags the cat segment in a chain even when an earlier segment also matches', () => {
    const r = runGuard('Bash', { command: 'git log && cat foo' });
    expectNeverBlocks(r);
    expect(r.stdout).not.toBe('');
    // The loop reports the FIRST matching segment (git log, per the gitlog rule) since segments are
    // walked in order and the guard returns on the first hit.
    expect(r.parsed?.systemMessage).toMatch(/gitlog/);
  });

  it('caps repeated warnings for the same rule within one session', () => {
    const sid = freshSid();
    // ⚠️ The `npm test` between each probe is LOAD-BEARING, not filler. `git log` is a read-only
    // probe, so three in a row is a chain (#1107) — and the chain rule is checked FIRST, so it
    // would answer calls 2 and 3 and this test would never observe the `gitlog` rule's own cap at
    // all. Breaking the run keeps each `git log` a fresh probe #1, which is the only way the
    // per-rule cap stays visible. Do not "simplify" this by removing the interleave.
    const breakRun = () => runGuard('Bash', { command: 'npm test' }, sid);
    const r1 = runGuard('Bash', { command: 'git log --oneline' }, sid);
    breakRun();
    const r2 = runGuard('Bash', { command: 'git log --oneline' }, sid);
    breakRun();
    const r3 = runGuard('Bash', { command: 'git log --oneline' }, sid);
    expectNeverBlocks(r1);
    expectNeverBlocks(r2);
    expectNeverBlocks(r3);
    expect(r1.stdout).not.toBe('');
    expect(r2.stdout).not.toBe('');
    expect(r3.stdout).toBe(''); // anti-nag: silent after the 2nd warning for this rule id
  });
});

describe('context-cost-guard — failure modes', () => {
  it('allows rather than crashes on an unreadable payload', () => {
    const r = runGuardRaw('not json at all');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('says nothing about a tool it does not cover', () => {
    const r = runGuard('Edit', { file_path: '/some/file.ts' });
    expectNeverBlocks(r);
    expect(r.stdout).toBe('');
  });
});

describe('context-cost-guard — settings registration', () => {
  // `.claude/` is deliberately excluded from the public OSS snapshot (see
  // engine/scripts/claim-guard.mjs), so this file is absent there — skip rather than crash, through
  // the predicate rather than a hand-rolled `existsSync` (#1071).
  const settingsPath = path.join(repoRoot, '.claude/settings.json');
  it.skipIf(!hasAgentSettings())(
    'is registered on both Bash and Read, and claim-guard.mjs is still registered on Bash',
    () => {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const preToolUse = settings.hooks.PreToolUse as Array<{ matcher: string; hooks: Array<{ command: string }> }>;

    const bashEntry = preToolUse.find((e) => e.matcher === 'Bash');
    expect(bashEntry).toBeDefined();
    const bashCommands = bashEntry!.hooks.map((h) => h.command);
    expect(bashCommands.some((c) => c.includes('claim-guard.mjs'))).toBe(true);
    expect(bashCommands.some((c) => c.includes('context-cost-guard.mjs'))).toBe(true);

    const readEntry = preToolUse.find((e) => e.matcher === 'Read');
    expect(readEntry).toBeDefined();
    expect(readEntry!.hooks.some((h) => h.command.includes('context-cost-guard.mjs'))).toBe(true);
    },
  );
});


describe('context-cost-guard — chain rule (#1107)', () => {
  /** The chain rule is the ONLY rule here whose subject is the TURN rather than the command, so
   *  these share one sid AND supply a real transcript — `freshSid()` per call resets the run, and
   *  without a transcript the rule cannot tell a batched call from a wasted turn and stays silent
   *  by design. Both omissions make every assertion below vacuous, which is what this suite is most
   *  at risk of. */

  /** A minimal Claude Code transcript whose LAST assistant record carries `turnId` — the hook reads
   *  its tail to identify the turn a tool call belongs to.
   *
   *  ⚠️ ONE FILE PER AGENT, appended to — not a new file per turn. A real agent has a single
   *  transcript whose last assistant record changes as it works, and the hook now keys its state on
   *  that path. A fixture that minted a fresh file per turn gave every turn its own state, so runs
   *  never accumulated and most of this suite went red for a reason that existed only in the test. */
  function transcriptAtTurn(turnId: string, agent = 'main'): string {
    const file = path.join(tmpDir, `transcript-${agent}.jsonl`);
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, JSON.stringify({ type: 'user', message: { role: 'user', content: 'x' } }) + '\n');
    }
    fs.appendFileSync(file, JSON.stringify({ type: 'assistant', message: { id: turnId, role: 'assistant', content: [] } }) + '\n');
    return file;
  }

  const inTurn = (cmd: string, sid: string, turnId: string, agent = 'main') =>
    runGuard('Bash', { command: cmd }, sid, transcriptAtTurn(turnId, agent));

  it('stays silent on the FIRST read-only probe', () => {
    const r = inTurn('git status --porcelain', freshSid(), 'msg_a');
    expectNeverBlocks(r);
    expect(r.stdout).toBe('');
  });

  it('warns on the SECOND consecutive read-only probe in a SEPARATE turn', () => {
    const sid = freshSid();
    const first = inTurn('git status --porcelain', sid, 'msg_1');
    const second = inTurn('ls engine/scripts', sid, 'msg_2');
    expectNeverBlocks(first);
    expectNeverBlocks(second);
    expect(first.stdout).toBe('');
    expect(second.parsed?.systemMessage).toMatch(/2 read-only shell probes in separate turns/);
    const ctx = (second.parsed?.hookSpecificOutput as Record<string, unknown>)?.additionalContext;
    expect(String(ctx)).toMatch(/ONE call/);
  });

  /** ⚠️ THE ONE THE REVIEW FOUND. Parallel tool calls share an assistant message, so they cost ZERO
   *  extra turns — and the pre-fix rule nudged them anyway, telling their author to "put them in ONE
   *  call" about calls that were already in one call. That is the harness's own batching instruction
   *  being punished by a rule whose whole premise is turn count. Measured before the fix: 8 parallel
   *  `ls` calls produced 5 nudges. */
  it('says NOTHING about parallel calls in the SAME turn, however many there are', () => {
    const sid = freshSid();
    const outs = ['ls', 'pwd', 'git status', 'ls engine', 'wc -l package.json']
      .map((c) => inTurn(c, sid, 'msg_same'));
    outs.forEach(expectNeverBlocks);
    expect(outs.map((r) => r.stdout)).toEqual(['', '', '', '', '']);
  });

  /** ⚠️ The case that makes the two same-turn mechanisms separately testable — and the reason this
   *  test exists at all. Every other parallel case here starts from run=1, where SUPPRESSING the
   *  warn and CARRYING the run length are indistinguishable: either alone keeps the batch quiet, so
   *  neither mutation bites and the tests vouch for code they cannot check. Entering the batch with
   *  a run ALREADY at 2 separates them — drop the suppression and the batch re-warns; drop the
   *  carry and the run resets, so the probe after it reports 2 instead of 3. */
  it('a parallel batch advances the run by exactly ONE, however many calls it holds', () => {
    const sid = freshSid();
    inTurn('ls', sid, 'r1');
    expect(inTurn('pwd', sid, 'r2').stdout).not.toBe('');          // run 2, warned
    // A batch's FIRST call is a genuine new turn, so it counts — and warns as run 3.
    expect(inTurn('git status', sid, 'r3batch').parsed?.systemMessage).toMatch(/3 read-only shell probes/);
    // Its SECOND call shares that turn: free, and silent.
    expect(inTurn('wc -l package.json', sid, 'r3batch').stdout).toBe('');
    expect(inTurn('file package.json', sid, 'r3batch').stdout).toBe('');
    // …and the run was CARRIED across the batch rather than reset, so the next turn is 4, not 2.
    expect(inTurn('ls engine', sid, 'r4').parsed?.systemMessage).toMatch(/4 read-only shell probes/);
  });

  it('still warns on the next SEQUENTIAL probe after a parallel batch', () => {
    const sid = freshSid();
    inTurn('ls', sid, 'msg_batch');
    inTurn('pwd', sid, 'msg_batch');          // same turn — free
    const later = inTurn('git status', sid, 'msg_next');   // a real extra turn
    expect(later.parsed?.systemMessage).toMatch(/read-only shell probes in separate turns/);
  });

  /** ⚠️ THE SUBAGENT SEAM — the defect the turn fix shipped with, found by the §2d review and
   *  reproduced in a live session. A subagent's hook payload carries the PARENT's `session_id` but
   *  its OWN transcript. With state keyed on the sid alone, parent and subagent shared one
   *  `lastBash` slot while drawing turn ids from disjoint namespaces, so `sameTurn` could never be
   *  true across them and each clobbered the other's `prev.turn` — an already-batched parent call
   *  got nudged anyway, which is verbatim the defect the fix exists to remove. This repo MANDATES
   *  subagents, so it was the normal case. Two transcripts, one sid, interleaved. */
  it('does not let a concurrent SUBAGENT break the parent\'s same-turn batching', () => {
    const sid = freshSid();
    inTurn('ls', sid, 'msg_parent', 'parent');            // parent probe #1
    inTurn('git status', sid, 'msg_sub', 'subagent');     // a subagent probes in between
    // The parent's SECOND call shares its first turn, so it costs no extra turn and must be silent.
    const parent2 = runGuard('Bash', { command: 'pwd' }, sid,
      path.join(tmpDir, 'transcript-parent.jsonl'));
    expectNeverBlocks(parent2);
    expect(parent2.stdout).toBe('');
  });

  it('gives a subagent its own nag budget rather than spending the parent\'s', () => {
    const sid = freshSid();
    // Burn the subagent's chain budget entirely.
    for (let i = 0; i < 6; i++) {
      inTurn('npm test', sid, `msg_s${i}x`, 'subagent');
      inTurn('ls', sid, `msg_s${i}a`, 'subagent');
      inTurn('pwd', sid, `msg_s${i}b`, 'subagent');
    }
    // The parent's own first run must still be able to warn — its budget is not the subagent's.
    inTurn('ls', sid, 'msg_p1', 'parent');
    expect(inTurn('pwd', sid, 'msg_p2', 'parent').stdout).not.toBe('');
  });

  it('stays silent when it cannot identify the turn — a wrong nudge is worse than none', () => {
    const sid = freshSid();
    runGuard('Bash', { command: 'ls' }, sid);       // no transcript_path
    const second = runGuard('Bash', { command: 'pwd' }, sid);
    expect(second.stdout).toBe('');
  });

  it('counts the run UP, so the third probe reports 3 rather than repeating 2', () => {
    const sid = freshSid();
    inTurn('ls', sid, 'm1');
    inTurn('pwd', sid, 'm2');
    const third = inTurn('git log -n 5 --oneline', sid, 'm3');
    expect(third.parsed?.systemMessage).toMatch(/3 read-only shell probes in separate turns/);
  });

  it('BREAKS the run on a non-probe command, so the probe after it is a fresh first', () => {
    const sid = freshSid();
    inTurn('ls', sid, 'm1');
    const mutating = inTurn('npm test', sid, 'm2');
    const after = inTurn('ls', sid, 'm3');
    expectNeverBlocks(mutating);
    expect(after.stdout).toBe('');
  });

  it('treats a write redirection as mutating even behind a read-only head', () => {
    const sid = freshSid();
    inTurn('ls', sid, 'm1');
    inTurn('ls engine > /tmp/manifest.txt', sid, 'm2');
    const after = inTurn('ls', sid, 'm3');
    expect(after.stdout).toBe('');
  });

  /** ⚠️ Review finding: the old redirect guard required WHITESPACE before `>`, so a stderr redirect
   *  slipped through as read-only and the chain kept counting across a command that wrote a file. */
  it('treats `2> file` as mutating too — the redirect needs no space in front of it', () => {
    const sid = freshSid();
    inTurn('ls', sid, 'm1');
    inTurn('ls engine 2> /tmp/err.log', sid, 'm2');
    const after = inTurn('ls', sid, 'm3');
    expect(after.stdout).toBe('');
  });

  /** ⚠️ Review finding: `splitSegments` keeps pipes inside one segment, so the HEAD decided the whole
   *  pipeline and `cat patch.diff | git apply` classified as a read-only probe. A chain containing a
   *  write is precisely where the later command DOES depend on the earlier, so the nudge was wrong. */
  it.each([
    ["sed -i '' 's/a/b/' src/foo.ts", 'in-place sed'],
    ['find . -name "*.tmp" -delete', 'find -delete'],
    ['grep -rl foo . | xargs sed -i \'\' \'s/foo/bar/\'', 'xargs into a write'],
    ['ls engine | tee /tmp/manifest.txt', 'tee'],
    ['cat patch.diff | git apply', 'git apply behind a cat'],
    ['sort -o data.txt data.txt', 'sort -o'],
  ])('does not treat a WRITE as a read-only probe: %s', (cmd) => {
    const sid = freshSid();
    inTurn('ls', sid, 'm1');
    inTurn(cmd, sid, 'm2');
    const after = inTurn('ls', sid, 'm3');
    expect(after.stdout).toBe('');
  });

  /** ⚠️ `2>&1` DUPLICATES a descriptor and creates no file, so the redirect guard's rationale
   *  ("produces a file a later command can depend on") does not apply. The first version of the
   *  digit fix broke this — and it is the commonest stderr idiom in this repo's own commands. */
  it('does NOT let `2>&1` break the chain — it duplicates a descriptor, it writes nothing', () => {
    const sid = freshSid();
    inTurn('ls', sid, 'm1');
    const second = inTurn('git status 2>&1', sid, 'm2');
    expect(second.parsed?.systemMessage).toMatch(/read-only shell probes in separate turns/);
  });

  it('treats `sed --in-place` as a write, not just the short `-i`', () => {
    const sid = freshSid();
    inTurn('ls', sid, 'm1');
    inTurn("sed --in-place 's/a/b/' engine/foo.ts", sid, 'm2');
    const after = inTurn('ls', sid, 'm3');
    expect(after.stdout).toBe('');
  });

  it('does NOT let `> /dev/null` break the chain — it discards output rather than producing a file', () => {
    const sid = freshSid();
    inTurn('ls', sid, 'm1');
    const second = inTurn('grep -q foo docs/README.md > /dev/null', sid, 'm2');
    expect(second.parsed?.systemMessage).toMatch(/read-only shell probes in separate turns/);
  });

  it('keeps `echo` labels neutral, so a compound probe still counts as one', () => {
    const sid = freshSid();
    inTurn('ls', sid, 'm1');
    const second = inTurn('git status && echo "===" && git log -n 3', sid, 'm2');
    expect(second.parsed?.systemMessage).toMatch(/read-only shell probes in separate turns/);
  });

  /** ⚠️ Review finding: the global CLAUDE.md MANDATES `git -C <path>` for a repo outside the cwd, and
   *  the pair builder blanked the flag, so every such call fell out of the probe list — the rule was
   *  blind to the spelling the rules require. */
  it('recognises `git -C <path> status` as a probe', () => {
    const sid = freshSid();
    inTurn('ls', sid, 'm1');
    const second = inTurn('git -C /tmp/other status --porcelain', sid, 'm2');
    expect(second.parsed?.systemMessage).toMatch(/read-only shell probes in separate turns/);
  });

  it('does not treat a git WRITE subcommand as a probe, though `git` heads several probes', () => {
    const sid = freshSid();
    inTurn('git status', sid, 'm1');
    inTurn('git commit -m wip', sid, 'm2');
    const after = inTurn('git status', sid, 'm3');
    expect(after.stdout).toBe('');
  });

  it('does not treat `node -e` as a probe — it can write, and reads nothing predictable', () => {
    const sid = freshSid();
    inTurn('ls', sid, 'm1');
    inTurn('node -e "console.log(1)"', sid, 'm2');
    const after = inTurn('ls', sid, 'm3');
    expect(after.stdout).toBe('');
  });

  it('caps the nudge so a long session is not nagged on every run', () => {
    const sid = freshSid();
    const warned: boolean[] = [];
    let t = 0;
    for (let i = 0; i < 4; i++) {
      inTurn('npm test', sid, `b${t++}`);   // break the previous run
      inTurn('ls', sid, `b${t++}`);
      warned.push(inTurn('pwd', sid, `b${t++}`).stdout !== '');
    }
    expect(warned).toEqual([true, true, true, false]);
  });

  it('takes precedence over a size rule, because the turn is the larger share', () => {
    const sid = freshSid();
    inTurn('ls', sid, 'm1');
    const second = inTurn('git log', sid, 'm2');
    expect(second.parsed?.systemMessage).toMatch(/read-only shell probes in separate turns/);
    expect(second.parsed?.systemMessage).not.toMatch(/Unbounded command/);
  });

  it('hands the floor back to the size rules once the chain cap is spent', () => {
    const sid = freshSid();
    let t = 0;
    for (let i = 0; i < 3; i++) {
      inTurn('npm test', sid, `c${t++}`);
      inTurn('ls', sid, `c${t++}`);
      expect(inTurn('pwd', sid, `c${t++}`).stdout).not.toBe('');
    }
    inTurn('ls', sid, 'c98');
    const sized = inTurn('git log', sid, 'c99');
    expectNeverBlocks(sized);
    expect(sized.parsed?.systemMessage).toMatch(/gitlog/);
  });
});
