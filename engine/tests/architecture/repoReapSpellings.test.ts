/** #913 — a reap matches a string we do NOT control, so it must match a SET of spellings.
 *
 *  `repo-reap.sh` is the shared matcher behind `launch-editor.sh` and `stop-editor.sh`. Its
 *  operand is the command line a FOREIGN process was launched with, so there is nothing to
 *  canonicalise on the other side and canonicalising only ours is strictly worse — it breaks the
 *  ordinary case that works today while fixing the symlinked one. #908 landed this shape for
 *  `dev:stop` in JS; these cases bring it to the bash reaps.
 *
 *  ⚠️ **The symlink is MANUFACTURED.** No clone on this machine is reached through one today
 *  (`pwd` == `pwd -P` in every checkout), so a test using ordinary paths would pass with the
 *  mechanism deleted — this repo's dominant defect class. The condition has to be built.
 *
 *  ⚠️ **Safe by construction.** Every pattern below carries an absolute path inside a fresh
 *  `mkdtemp` directory, so no matcher here can reach a real clone's editor or dev server.
 *
 *  ⚠️ **THE PATTERN MUST NEVER APPEAR IN THIS HARNESS'S OWN ARGV** — see `sh()`. This file got
 *  that wrong first time round and was green anyway, on this Mac only.
 *
 *  ⚠️ The CONTROLS matter more than the positive cases: a reap that matched EVERYTHING would
 *  satisfy every positive assertion here. #69 is the disaster this helper exists to prevent. */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REAP = path.resolve(__dirname, '..', '..', 'scripts', 'lib', 'repo-reap.sh');

/** Windows without Developer Mode / SeCreateSymbolicLinkPrivilege cannot create one at all. Skip
 *  rather than redden a leg for a privilege — the mechanism is unreachable there anyway, and the
 *  Windows spellings are their own issue (a junction, not a symlink). */
const CAN_SYMLINK = (() => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'symcap-'));
  try { fs.mkdirSync(path.join(d, 't')); fs.symlinkSync(path.join(d, 't'), path.join(d, 'l'), 'dir'); return true; }
  catch { return false; }
  finally { fs.rmSync(d, { recursive: true, force: true }); }
})();

const kids: ChildProcess[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const k of kids.splice(0)) { try { k.kill('SIGKILL'); } catch { /* already gone */ } }
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function symlinkedClone() {
  const root = tmp('reap-');
  const real = path.join(root, 'modoki-qa');
  const link = path.join(root, 'clone-link');
  fs.mkdirSync(path.join(real, 'engine', 'electron', 'dist'), { recursive: true });
  fs.symlinkSync(real, link, 'dir');
  return { root, real, link, marker: (base: string) => path.join(base, 'engine/electron/dist/main.cjs') };
}

/** A live process whose argv literally contains `marker` — what `pkill -f` matches on. */
function sleeper(marker: string): void {
  const p = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)', marker], { stdio: 'ignore' });
  kids.push(p);
  execFileSync('bash', ['-c', 'sleep 0.4']);
}

/** Source the REAL helper and run one command against it. Nothing is re-implemented here.
 *
 *  ⚠️ **The script goes in a temp FILE, never in `bash -c`.** `pgrep -f` / `pkill -f` match on the
 *  whole command line, so passing the pattern inline puts the exact string being searched for into
 *  a LIVE process — and the matcher finds itself. That is not theoretical: measured here, a bash
 *  carrying the marker in its argv IS matched by `pgrep -f`. The first version of this file did
 *  exactly that and passed anyway, because BSD `pgrep` skips its own ancestor chain — a macOS
 *  accident. `procps` `pgrep` (ubuntu-latest) skips only its own pid, and the Windows CIM branch
 *  filters only `$PID`, so on BOTH CI legs the self-match would invert every CONTROL and make every
 *  positive case pass unconditionally — the tests would measure nothing on the platforms the gate
 *  actually runs. A file's CONTENTS are not argv, so nothing here is matchable. */
function sh(script: string, roots?: { logical: string; physical: string }): { status: number; out: string } {
  const reg = roots ? `reap_repo_register_roots '${roots.logical}' '${roots.physical}'` : ':';
  const dir = tmp('reapsh-');
  const f = path.join(dir, 'run.sh');
  fs.writeFileSync(f, `. '${REAP}'\n${reg}\n${script}\necho "STATUS=$?"\n`);
  const r = execFileSync('bash', [f], { encoding: 'utf8' });
  return { status: Number(/STATUS=(\d+)/.exec(r)?.[1] ?? -1), out: r.replace(/STATUS=\d+\s*$/, '') };
}

describe.skipIf(!CAN_SYMLINK)('repo-reap.sh matches a set of spellings (#913)', () => {
  it('finds a process launched with the REAL path when asked about the LINK path', () => {
    const c = symlinkedClone();
    sleeper(c.marker(c.real));
    expect(sh(`reap_repo_alive '${c.marker(c.link)}'`, { logical: c.link, physical: c.real }).status).toBe(0);
  });

  it('and REAPS it — not merely detects it', () => {
    const c = symlinkedClone();
    sleeper(c.marker(c.real));
    expect(sh(`reap_repo_alive '${c.marker(c.link)}'`, { logical: c.link, physical: c.real }).status).toBe(0);
    sh(`reap_repo_process '${c.marker(c.link)}'`, { logical: c.link, physical: c.real });
    execFileSync('bash', ['-c', 'sleep 0.5']);
    expect(sh(`reap_repo_alive '${c.marker(c.link)}'`, { logical: c.link, physical: c.real }).status).not.toBe(0);
  });

  it('CONTROL: the un-symlinked case that already worked still works', () => {
    // #908's warning in one assertion: canonicalising our own side ALONE would fix the symlink
    // case and break this one. Registering identical roots must change nothing.
    const c = symlinkedClone();
    sleeper(c.marker(c.real));
    expect(sh(`reap_repo_alive '${c.marker(c.real)}'`, { logical: c.real, physical: c.real }).status).toBe(0);
  });

  it('CONTROL: with no roots registered at all, the plain match still works', () => {
    const c = symlinkedClone();
    sleeper(c.marker(c.real));
    expect(sh(`reap_repo_alive '${c.marker(c.real)}'`).status).toBe(0);
  });

  it('CONTROL: a SIBLING clone whose name is a prefix is never matched (#69)', () => {
    // The disaster this helper exists to prevent. `~/Projects/modoki` is a prefix of
    // `~/Projects/modoki-qa` on the real machine; a fix that widened into a prefix match would
    // kill every clone's editor and would still pass every positive assertion above.
    const c = symlinkedClone();
    const sibling = path.join(c.root, 'modoki-qa-2');
    fs.mkdirSync(path.join(sibling, 'engine', 'electron', 'dist'), { recursive: true });
    sleeper(c.marker(sibling));
    expect(sh(`reap_repo_alive '${c.marker(c.link)}'`, { logical: c.link, physical: c.real }).status).not.toBe(0);
  });

  it('an EMPTY physical root yields NOTHING — not merely something different', () => {
    // ⚠️ Asserting `not.toContain(root)` here was VACUOUS, and a mutation proved it: with the
    // guards removed the helper prints `/engine/electron/dist/main.cjs` — the pattern that reaps
    // every clone on the machine — and that string contains no temp root, so the old assertion
    // passed on the exact disaster it was named after. The property is that NOTHING is printed.
    const c = symlinkedClone();
    expect(sh(`reap_alt_pattern '${c.marker(c.link)}'`, { logical: c.link, physical: '' }).out.trim()).toBe('');
  });

  it('a RELATIVE physical root yields nothing — it could not name an absolute process path', () => {
    const c = symlinkedClone();
    expect(sh(`reap_alt_pattern '${c.marker(c.link)}'`, { logical: c.link, physical: 'relative/path' }).out.trim()).toBe('');
  });

  it('CONTROL: a pattern that merely STARTS WITH the root gets no second spelling (#69)', () => {
    // The gap a mutation check found in this very file: every other case passes a pattern
    // genuinely UNDER the registered root, so relaxing the guard from "${ROOT}/*" to a bare
    // "${ROOT}*" left the whole suite green. `<root>-2/…` starts with the root as a STRING and is
    // not under it — a prefix-shaped guard rewrites it to `<physical>-2/…`, a real SIBLING CLONE's
    // path, and reaps that clone's editor.
    const c = symlinkedClone();
    expect(sh(`reap_alt_pattern '${c.link}-2/engine/electron/dist/main.cjs'`,
      { logical: c.link, physical: c.real }).out.trim()).toBe('');
  });

  it('a pattern OUTSIDE the registered root gets no second spelling', () => {
    const c = symlinkedClone();
    expect(sh(`reap_alt_pattern '/somewhere/else/main.cjs'`, { logical: c.link, physical: c.real }).out.trim()).toBe('');
  });
});
