/** #1580 — the editor must get exactly ONE SIGTERM from `reap_repo_signal_editor_once`.
 *
 *  `launch-editor.sh` starts Electron through the npm `electron` wrapper (`node_modules/.bin/
 *  electron` → `electron/cli.js`), which forwards a SIGTERM to its child. Both processes carry the
 *  `main.cjs` path in argv, so a `pkill -f` signalled both, and the Electron main process got two
 *  SIGTERMs microseconds apart. Chromium starts a clean quit on the first and restores the default
 *  action, so the second killed the editor before its localStorage was committed. The live
 *  measurement is in docs/player-prefs.md § Gotchas. These cases pin the shell side: the fixture is
 *  a real forwarding wrapper and a child that COUNTS what it receives.
 *
 *  ⚠️ The CONTROL is load-bearing: `reap_repo_process` against the same fixture must deliver TWO.
 *  Without it, a fixture whose wrapper never forwarded would pass the "exactly one" case with the
 *  mechanism deleted.
 *
 *  POSIX only: on Windows the helper deliberately falls back to the forced shared reap. */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { makeDirLink, canMakeDirLink, cloneRootSpellings, makeFixtureRoot } from '../helpers/linkFixture';

const REAP = path.resolve(__dirname, '..', '..', 'scripts', 'lib', 'repo-reap.sh');

const kids: ChildProcess[] = [];
const pids: number[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const p of pids.splice(0)) { try { process.kill(p, 'SIGKILL'); } catch { /* already gone */ } }
  for (const k of kids.splice(0)) { try { k.kill('SIGKILL'); } catch { /* already gone */ } }
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = makeFixtureRoot(prefix);
  dirs.push(d);
  return d;
}

const pause = (s: number) => execFileSync('bash', ['-c', `sleep ${s}`]);

/** The "Electron main": counts SIGTERMs into `out` and never exits on one. Its argv carries every
 *  `markers` entry, which is what `pgrep -f` matches. */
const CHILD = `const fs=require('fs');const out=process.argv[1];let n=0;fs.writeFileSync(out+'.pid',String(process.pid));process.on('SIGTERM',()=>{n++;fs.writeFileSync(out,String(n));});setInterval(()=>{},1e9);`;

/** The npm wrapper: spawns CHILD and forwards SIGTERM to it, as `electron/cli.js` does. Its argv
 *  carries `<root>/node_modules/.bin/electron <marker>`, the shape launch-editor.sh produces.
 *  ⚠️ It forwards after a 100 ms DELAY, on purpose. Forwarded at once, the second SIGTERM lands
 *  while the child's first is still PENDING, and the kernel merges two pending standard signals
 *  into one — so the CONTROL counted 1, not 2, on public CI (ubuntu AND macos-14, 2026-09-25,
 *  release 0.7.3 rc). The delay keeps the two deliveries distinct; the question every case asks is
 *  WHICH processes were signalled, and that is unchanged by when the wrapper passes one on. */
const WRAPPER = `const {spawn}=require('child_process');const [code,out,...rest]=process.argv.slice(1);const c=spawn(process.execPath,['-e',code,out,...rest.slice(1)],{stdio:'ignore'});process.on('SIGTERM',()=>setTimeout(()=>c.kill('SIGTERM'),100));setInterval(()=>{},1e9);`;

/** `wrapper: false` is an Electron main started with no forwarding parent (a direct launch, as a
 *  Playwright or IDE launch does): the child alone carries the markers. */
function editorFixture(markers: string[], root: string, { wrapper = true } = {}): { count: () => number } {
  const out = path.join(root, 'sigterms');
  const w = wrapper
    ? spawn(process.execPath, ['-e', WRAPPER, CHILD, out, path.join(root, 'node_modules/.bin/electron'), ...markers], { stdio: 'ignore' })
    : spawn(process.execPath, ['-e', CHILD, out, ...markers], { stdio: 'ignore' });
  kids.push(w);
  for (let i = 0; i < 40 && !fs.existsSync(out + '.pid'); i++) pause(0.05);
  pids.push(Number(fs.readFileSync(out + '.pid', 'utf8')));
  return { count: () => (fs.existsSync(out) ? Number(fs.readFileSync(out, 'utf8')) : 0) };
}

/** Source the REAL helper and run one command. The script goes in a FILE, never `bash -c`, so the
 *  pattern never sits in a live argv where `pgrep -f` would match the harness itself
 *  (repoReapSpellings.test.ts § sh() has the measured reason). */
function sh(script: string, roots?: { logical: string; physical: string }): boolean {
  const reg = roots ? `reap_repo_register_roots '${roots.logical}' '${roots.physical}'` : ':';
  const f = path.join(tmp('reapsh-'), 'run.sh');
  // Under the callers' own options: launch-editor.sh and stop-editor.sh run `set -euo pipefail`,
  // and a helper that is fine without them can end the caller silently with them.
  fs.writeFileSync(f, `set -euo pipefail\n. '${REAP}'\n${reg}\n${script}\necho REACHED\n`);
  return execFileSync('bash', [f], { encoding: 'utf8' }).includes('REACHED');
}

describe.skipIf(process.platform === 'win32')('reap_repo_signal_editor_once sends the editor ONE SIGTERM (#1580)', () => {
  it('the Electron main process gets exactly one, although the wrapper matches the pattern too', () => {
    const root = tmp('sigonce-');
    const marker = path.join(root, 'engine/electron/dist/main.cjs');
    const ed = editorFixture([marker], root);
    sh(`reap_repo_signal_editor_once '${marker}'`);
    pause(0.5);
    expect(ed.count()).toBe(1);
  });

  it('CONTROL: the plain pkill reap double-signals this same fixture — the defect it replaces', () => {
    const root = tmp('sigonce-');
    const marker = path.join(root, 'engine/electron/dist/main.cjs');
    const ed = editorFixture([marker], root);
    sh(`reap_repo_process '${marker}'`);
    pause(0.5);
    expect(ed.count()).toBe(2);
  });

  it('CONTROL: no match, no signal — an unrelated path reaches nothing', () => {
    const root = tmp('sigonce-');
    const ed = editorFixture([path.join(root, 'engine/electron/dist/main.cjs')], root);
    sh(`reap_repo_signal_editor_once '${path.join(tmp('elsewhere-'), 'engine/electron/dist/main.cjs')}'`);
    pause(0.5);
    expect(ed.count()).toBe(0);
  });

  it('an editor with NO wrapper is signalled directly — the filter drops only the wrapper', () => {
    // With the wrapper in the fixture, signalling ONLY the wrapper also counts 1 (it forwards), so
    // the case above cannot tell a filter that keeps the main process from one that inverted.
    const root = tmp('sigonce-');
    const marker = path.join(root, 'engine/electron/dist/main.cjs');
    const ed = editorFixture([marker], root, { wrapper: false });
    sh(`reap_repo_signal_editor_once '${marker}'`);
    pause(0.5);
    expect(ed.count()).toBe(1);
  });

  it.skipIf(!canMakeDirLink())('finds an editor launched under the PHYSICAL root when asked with the LOGICAL one', () => {
    // The production layout of a symlinked clone: launch-editor.sh spawns with the physical path
    // (#961), stop-editor.sh asks with its logical `$REPO`. Only the second-spelling pgrep finds it;
    // without it the editor gets no SIGTERM and is SIGKILLed 15 s later — #1580's loss again.
    const root = tmp('sigonce-');
    const real = path.join(root, 'modoki-qa');
    const link = path.join(root, 'clone-link');
    fs.mkdirSync(path.join(real, 'engine', 'electron', 'dist'), { recursive: true });
    makeDirLink(real, link);
    const roots = cloneRootSpellings(link);
    const rel = 'engine/electron/dist/main.cjs';
    const ed = editorFixture([path.join(roots.physical, rel)], root);
    sh(`reap_repo_signal_editor_once '${roots.logical}/${rel}'`, roots);
    pause(0.5);
    expect(ed.count()).toBe(1);
  });

  it('no editor running is not an error — the caller carries on under set -euo pipefail', () => {
    // The first version ended launch-editor.sh here, silently, whenever no editor was running:
    // `pgrep` exits 1 on no match and `pipefail` turned that into a failed assignment.
    expect(sh(`reap_repo_signal_editor_once '${path.join(tmp('none-'), 'engine/electron/dist/main.cjs')}'`)).toBe(true);
  });
});
