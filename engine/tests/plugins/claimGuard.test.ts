/**
 * The device-claim guard, end to end (#285) — `engine/scripts/claim-guard.mjs` as Claude Code
 * actually runs it: a real process, a real `PreToolUse` payload on stdin, the real claims file.
 *
 * Driven by SPAWNING the script rather than importing it, because the things most likely to break
 * are the things an import would skip: reading fd 0, the exact deny JSON the harness parses, and
 * exiting 0 on the allow path. A hook that returns the wrong SHAPE fails OPEN — Claude Code treats
 * malformed hook output as non-blocking and runs the command anyway — so "it denied" and "it printed
 * something" are different claims, and only the payload shape proves the first.
 *
 * MODOKI_HOME is a fresh temp dir for every test: this suite writes claim records, and a claim
 * written into the developer's real `~/.modoki` would refuse their own phone in their own editor.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..', '..');
const guard = path.join(repoRoot, 'engine/scripts/claim-guard.mjs');

let home: string;
/** The clone the guard should believe it is running in. A temp dir, not the real repo, so a test
 *  cannot accidentally agree with a real claim someone is holding right now. */
let clone: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-guard-home-'));
  clone = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-guard-clone-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(clone, { recursive: true, force: true });
});

interface GuardResult {
  status: number;
  /** The parsed deny payload, or null when the guard allowed (it prints nothing to allow). */
  decision: { permissionDecision: string; permissionDecisionReason: string } | null;
  reason: string;
}

function runGuard(command: string, opts: { cwd?: string } = {}): GuardResult {
  const payload = JSON.stringify({
    session_id: 'test',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    cwd: opts.cwd ?? clone,
    tool_input: { command },
  });
  const res = spawnSync(process.execPath, [guard], {
    input: payload,
    encoding: 'utf8',
    env: {
      ...process.env,
      MODOKI_HOME: home,
      // The harness sets this in a real session and the guard prefers it. Pin it to the test's
      // clone so the result does not depend on whether the suite itself was launched by Claude.
      CLAUDE_PROJECT_DIR: opts.cwd ?? clone,
    },
  });
  const out = (res.stdout ?? '').trim();
  const parsed = out ? JSON.parse(out).hookSpecificOutput : null;
  return { status: res.status ?? -1, decision: parsed ?? null, reason: parsed?.permissionDecisionReason ?? '' };
}

function writeClaim(claim: Record<string, unknown>): void {
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, 'device-claims.json');
  const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).claims : [];
  fs.writeFileSync(file, JSON.stringify({ claims: [...existing, claim] }, null, 2));
}

/** A claim held by somebody else, alive right now. `pid` is this test process precisely because it
 *  must be a LIVE pid — a dead one is stale and would be filtered out before the guard ever sees
 *  it, so the test would pass for the wrong reason. */
function foreignClaim(deviceId: string, extra: Record<string, unknown> = {}) {
  return {
    deviceId,
    clone: '/Users/somebody/Projects/modoki-ai2',
    branch: 'work-ai2',
    pid: process.pid,
    at: Date.now(),
    label: 'Galaxy S22',
    purpose: 'holding a device lease over USB',
    ...extra,
  };
}

const INSTALL = 'adb -s RFTESTSERIAL1 install -r court.apk';

describe('claim-guard — the allow path', () => {
  it('says nothing at all about a command that names no device tool', () => {
    const r = runGuard('npm run verify && git status');
    expect(r.status).toBe(0);
    expect(r.decision).toBeNull();
  });

  it('allows a read-only device command even when another clone holds the phone', () => {
    writeClaim(foreignClaim('adb:RFTESTSERIAL1'));
    // Reading a log cannot install over anyone or kill their process. The claim arbitrates
    // interference, not curiosity — and a guard that refused listings would be routed around.
    for (const cmd of ['adb devices -l', 'adb -s RFTESTSERIAL1 logcat -d', 'adb -s RFTESTSERIAL1 shell getprop']) {
      expect(runGuard(cmd).decision, cmd).toBeNull();
    }
  });

  it('allows a destructive command against a device THIS clone holds', () => {
    writeClaim({ ...foreignClaim('adb:RFTESTSERIAL1'), clone, branch: 'work-ai3' });
    expect(runGuard(INSTALL).decision).toBeNull();
  });

  it('allows when the holder is this clone reached by a different but equivalent path', () => {
    writeClaim({ ...foreignClaim('adb:RFTESTSERIAL1'), clone: `${clone}/`, branch: 'work-ai3' });
    // A trailing slash must not make this clone look like a stranger and refuse its own phone.
    expect(runGuard(INSTALL).decision).toBeNull();
  });
});

describe('claim-guard — the refusal that #285 is about', () => {
  it('refuses a destructive command against a phone another clone holds, and names the holder', () => {
    writeClaim(foreignClaim('adb:RFTESTSERIAL1'));
    const r = runGuard(INSTALL);
    expect(r.decision?.permissionDecision).toBe('deny');
    expect(r.reason).toContain('modoki-ai2');
    expect(r.reason).toContain('work-ai2');
    expect(r.reason).toContain('Galaxy S22');
  });

  it('refuses each destructive shape from the incident report', () => {
    writeClaim(foreignClaim('adb:RFTESTSERIAL1'));
    for (const cmd of [
      'adb -s RFTESTSERIAL1 install -r court.apk',
      'adb -s RFTESTSERIAL1 shell am force-stop com.apiary.court',
      'adb -s RFTESTSERIAL1 logcat -c',
      'adb -s RFTESTSERIAL1 uninstall com.apiary.court',
    ]) {
      expect(runGuard(cmd).decision?.permissionDecision, cmd).toBe('deny');
    }
  });

  it('refuses a destructive command against an UNCLAIMED device, and says how to claim it', () => {
    const r = runGuard(INSTALL);
    expect(r.decision?.permissionDecision).toBe('deny');
    // The deny reason is delivered to the model, so it is the one place a refusal can carry its own
    // remedy. A refusal that does not name a runnable command is a scolding.
    expect(r.reason).toContain('npm run device:claim adb:RFTESTSERIAL1');
  });

  it('refuses a destructive command that names no device at all', () => {
    const r = runGuard('adb install court.apk');
    expect(r.decision?.permissionDecision).toBe('deny');
    expect(r.reason).toContain('no device named');
  });

  it('sees through a shell wrapper', () => {
    writeClaim(foreignClaim('adb:RFTESTSERIAL1'));
    const r = runGuard(`bash -c "${INSTALL}"`);
    expect(r.decision?.permissionDecision).toBe('deny');
  });

  it('sees an adb call in the second half of a real && chain', () => {
    writeClaim(foreignClaim('adb:RFTESTSERIAL1'));
    const r = runGuard(`cd /tmp && ${INSTALL}`);
    expect(r.decision?.permissionDecision).toBe('deny');
  });
});

describe('claim-guard — false positives that make a guard get routed around', () => {
  it('does not refuse a command that merely CONTAINS device-command text in a quoted argument', () => {
    writeClaim(foreignClaim('adb:RFTESTSERIAL1'));
    // Measured when this hook first went live: a naive splitter cut inside the quotes and the tail
    // looked like a command, so the guard refused the command that was testing it — and then the
    // patch fixing that. Writing ABOUT a device command is not running one.
    const r = runGuard(`echo "cd /tmp && ${INSTALL}"`);
    expect(r.decision).toBeNull();
  });

  it('does not refuse a heredoc whose BODY contains a device command', () => {
    writeClaim(foreignClaim('adb:RFTESTSERIAL1'));
    const r = runGuard(`cat > deploy.sh <<'EOF'\n${INSTALL}\nEOF`);
    expect(r.decision).toBeNull();
  });

  it('does not refuse xcodebuild invocations that name no destination', () => {
    for (const cmd of ['xcodebuild -list', 'xcodebuild clean -scheme App', 'xcodebuild -showBuildSettings']) {
      expect(runGuard(cmd).decision, cmd).toBeNull();
    }
  });

  it('does not refuse a simulator build', () => {
    const r = runGuard("xcodebuild -destination 'platform=iOS Simulator,name=iPhone 15' -scheme App build");
    expect(r.decision).toBeNull();
  });
});

describe('claim-guard — failure modes', () => {
  it('allows rather than crashes on an unreadable payload', () => {
    // Claude Code treats a crashing hook as non-blocking, so a guard that throws does not fail
    // closed — it fails open AND spams a hook-error notice. Exiting cleanly is the honest version.
    const res = spawnSync(process.execPath, [guard], {
      input: 'not json at all',
      encoding: 'utf8',
      env: { ...process.env, MODOKI_HOME: home, CLAUDE_PROJECT_DIR: clone },
    });
    expect(res.status).toBe(0);
    expect((res.stdout ?? '').trim()).toBe('');
  });

  it('ignores a stale foreign claim rather than refusing on a corpse', () => {
    // pid 999999 is not running, so the claim is expired on read. A guard that refused on it would
    // block hardware nobody holds — the #225 failure, one layer up.
    writeClaim(foreignClaim('adb:RFTESTSERIAL1', { pid: 999999 }));
    const r = runGuard(INSTALL);
    expect(r.decision?.permissionDecision).toBe('deny');
    // ...but for the UNCLAIMED reason, not the cross-clone one: nobody holds it.
    expect(r.reason).toContain('Nothing holds');
    expect(r.reason).not.toContain('modoki-ai2');
  });
});
