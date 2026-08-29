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

function runGuard(toolName: string, toolInput: Record<string, unknown>, sid = freshSid()): GuardResult {
  const payload = JSON.stringify({
    session_id: sid,
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput,
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
    ];
    for (const [cmd, expected] of cases) {
      const r = runGuard('Bash', { command: cmd });
      expectNeverBlocks(r);
      expect(r.parsed?.systemMessage, cmd).toMatch(expected);
    }
  });

  it('does not warn when the same command is piped through a bounding filter', () => {
    for (const cmd of ['cat some/big/file.txt | head -100', 'git log | wc -l', 'ls -laR / | head -50']) {
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
    const r1 = runGuard('Bash', { command: 'git log --oneline' }, sid);
    const r2 = runGuard('Bash', { command: 'git log --oneline' }, sid);
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
  it('is registered on both Bash and Read, and claim-guard.mjs is still registered on Bash', () => {
    const settings = JSON.parse(fs.readFileSync(path.join(repoRoot, '.claude/settings.json'), 'utf8'));
    const preToolUse = settings.hooks.PreToolUse as Array<{ matcher: string; hooks: Array<{ command: string }> }>;

    const bashEntry = preToolUse.find((e) => e.matcher === 'Bash');
    expect(bashEntry).toBeDefined();
    const bashCommands = bashEntry!.hooks.map((h) => h.command);
    expect(bashCommands.some((c) => c.includes('claim-guard.mjs'))).toBe(true);
    expect(bashCommands.some((c) => c.includes('context-cost-guard.mjs'))).toBe(true);

    const readEntry = preToolUse.find((e) => e.matcher === 'Read');
    expect(readEntry).toBeDefined();
    expect(readEntry!.hooks.some((h) => h.command.includes('context-cost-guard.mjs'))).toBe(true);
  });
});
