/** Guard: `dev:stop` finds this repo's dev server through EVERY spelling of the repo root, and
 *  says so when it finds nothing (#908).
 *
 *  `stopDevServer.mjs` decides what to kill by substring-matching `<repoRoot>/node_modules/`
 *  against a running process's command line. That is a path-identity comparison with only ONE side
 *  under our control — the other side is the spelling a foreign process was *launched* with — and
 *  neither side was canonicalised. So a clone reached through a symlink matched nothing, killed
 *  nothing, and printed the same `Done.` and exit 0 as a successful kill.
 *
 *  ⚠️ **Every case here runs against a FAKE repo root in a tmpdir, never against this checkout.**
 *  The script's whole job is to kill processes, and pointing it at the real repo would reap the
 *  developer's own running dev server (or another clone's, mid-`verify`) as a side effect of
 *  testing it. The markers are built from `argv[2]`, so a tmpdir root is a complete substitute. */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { makeDirLink } from '../helpers/linkFixture';

const REPO = path.resolve(__dirname, '../../..');
const SCRIPT = path.join(REPO, 'engine/scripts/stopDevServer.mjs');

const kids: ChildProcess[] = [];
const tmps: string[] = [];

afterEach(() => {
  for (const k of kids.splice(0)) { try { k.kill('SIGKILL'); } catch { /* already gone */ } }
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A tmpdir whose path is already REAL — `os.tmpdir()` is `/var/folders/…` on darwin and `/var` is
 *  itself a symlink to `/private/var`, so an un-realpath'd base would make the control case below
 *  differ from the real spelling too and stop being a control. */
function realTmp(): string {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-devstop-')));
  tmps.push(d);
  return d;
}

/** A live process whose command line carries `<repoRoot>/node_modules/vite/bin/vite.js` — what the
 *  reap looks for. It is a plain `node`, not a vite: the script matches on the command line, so the
 *  argument is the whole fixture. `--configLoader runner` is deliberately absent, which is what
 *  makes it a target rather than the editor-owned carve-out. */
function fakeDevServer(repoRoot: string, extra: string[] = []): ChildProcess {
  const vite = path.join(repoRoot, 'node_modules/vite/bin/vite.js');
  const kid = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)', vite, ...extra], {
    stdio: 'ignore',
  });
  kids.push(kid);
  return kid;
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Give `ps` a moment to see the child, then run the reap and report what it printed. */
function stop(repoRootArg: string): { out: string; status: number | null } {
  const r = spawnSync(process.execPath, [SCRIPT, repoRootArg], { encoding: 'utf8' });
  return { out: `${r.stdout}${r.stderr}`, status: r.status };
}

const settle = async () => { await new Promise((r) => setTimeout(r, 300)); };

describe('dev:stop matches the repo through any spelling of its root (#908)', () => {
  it('stops the server when the clone is reached through a SYMLINK', async () => {
    const base = realTmp();
    const real = path.join(base, 'repo');
    fs.mkdirSync(real);
    const link = path.join(base, 'link');
    makeDirLink(real, link);

    // Launched with the REAL spelling…
    const kid = fakeDevServer(real);
    await settle();
    // …stopped through the LINK. Before the fix the marker was the link spelling, `includes()`
    // missed, and this printed `Done.` with the process still running.
    const { out } = stop(link);

    await settle();
    expect(alive(kid.pid!), `nothing was stopped, and the script said:\n${out}`).toBe(false);
  });

  it('CONTROL: still stops it when reached through the real path', async () => {
    // The bug was a miss, so the case that already worked has to be shown still working — a marker
    // set that resolved only OUR side would have broken exactly this one.
    const base = realTmp();
    const real = path.join(base, 'repo');
    fs.mkdirSync(real);

    const kid = fakeDevServer(real);
    await settle();
    const { out } = stop(real);

    await settle();
    expect(alive(kid.pid!), `the control failed, so the harness is suspect:\n${out}`).toBe(false);
  });

  it('leaves a DIFFERENT repo root alone — the scoping the marker exists for', async () => {
    // The other direction of the same comparison: canonicalising must not widen the match. A
    // sibling clone's dev server is what this script has always promised never to touch.
    const base = realTmp();
    const mine = path.join(base, 'mine');
    const theirs = path.join(base, 'theirs');
    fs.mkdirSync(mine); fs.mkdirSync(theirs);

    const kid = fakeDevServer(theirs);
    await settle();
    const { out } = stop(mine);

    await settle();
    expect(alive(kid.pid!), `a sibling clone's dev server was reaped:\n${out}`).toBe(true);
    expect(out).toMatch(/nothing to stop/i);
  });
});

describe('dev:stop says when it stopped NOTHING (#908)', () => {
  it('an empty match set is distinguishable from a kill', async () => {
    // ⚠️ This is the half that makes every remaining miss legible. `Done.` was printed for BOTH
    // outcomes, so "the server is still running" and "the server was stopped" read identically —
    // and the failure then presents as *the app is broken*, not as *nothing was stopped* (#129).
    const base = realTmp();
    const empty = path.join(base, 'nobody-here');
    fs.mkdirSync(empty);

    const { out, status } = stop(empty);
    expect(status).toBe(0); // stopping stays best-effort; it must not fail the caller
    expect(out).toMatch(/no dev server running for this repo/i);
    expect(out).not.toMatch(/^Done\.$/m);
  });

  it('a kill still reports what it stopped', async () => {
    const base = realTmp();
    const real = path.join(base, 'repo');
    fs.mkdirSync(real);
    const kid = fakeDevServer(real);
    await settle();

    const { out } = stop(real);
    expect(out).toMatch(new RegExp(`Stopping this repo's dev server: ${kid.pid}`));
    expect(out).toMatch(/^Done\.$/m);
  });

  it("names the editor's own server as the reason nothing was stopped", async () => {
    // Third outcome that used to share the one `Done.`: everything matched was the editor's, so
    // there was nothing left to reap. Regression cover for #129's carve-out at the same time.
    const base = realTmp();
    const real = path.join(base, 'repo');
    fs.mkdirSync(real);
    const kid = fakeDevServer(real, ['--configLoader', 'runner']);
    await settle();

    const { out } = stop(real);

    await settle();
    expect(alive(kid.pid!), `the editor's own dev server was reaped (#129):\n${out}`).toBe(true);
    expect(out).toMatch(/Leaving the editor's own dev server alone/);
    expect(out).toMatch(/only match is the editor's own dev server/i);
  });
});
