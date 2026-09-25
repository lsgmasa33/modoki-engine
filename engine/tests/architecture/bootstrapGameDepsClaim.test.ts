/** `bootstrap-game-deps.mjs` (the root `postinstall`) writes every project's `node_modules`, lockfile
 *  and `plugins/`, so it runs each project under that project's build claim, and SKIPS a project a
 *  build holds rather than racing it or failing the root install (#1160).
 *
 *  Behavioural, not a source match: the real script runs in a scratch repo shaped like this one
 *  (`engine/scripts/` + `games/<id>`), with a fake `npm` first on PATH that records each call. No
 *  `engine/plugins/`, so the vendor loader degrades to null and vendoring is skipped, which is the
 *  documented tarball-snapshot path. The claim is held by THIS test process in a private
 *  `MODOKI_HOME`, and the token env var is stripped from the child's env: an inherited token would
 *  be a pass-through grant, which would make the "held" case pass for the wrong reason. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquireBuildClaim, resetBuildClaimsForTests, BUILD_CLAIM_ENV_VAR } from '../../scripts/buildClaimsStore.mjs';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

const scriptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts');
const SCRIPTS = [
  'bootstrap-game-deps.mjs', 'projectRoots.mjs', 'projectNeedsInstall.mjs', 'loadVendorPlugins.mjs',
  'buildClaimsStore.mjs', 'deviceClaimsStore.mjs', 'pathIdentity.mjs', 'winSpawn.mjs',
];

let repo: string;
let home: string;
let bin: string;
let npmLog: string;
let prevHome: string | undefined;

function addGame(id: string) {
  const dir = path.join(repo, 'games', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: id, dependencies: { 'left-pad': '1.3.0' } }));
  return dir;
}

function run() {
  const env: NodeJS.ProcessEnv = { ...process.env, MODOKI_HOME: home, NPM_LOG: npmLog, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` };
  delete env[BUILD_CLAIM_ENV_VAR];
  return spawnSync(process.execPath, [path.join(repo, 'engine', 'scripts', 'bootstrap-game-deps.mjs')], { cwd: repo, env, encoding: 'utf8' });
}

/** The directories the fake npm was invoked in, one per call. Split on `\r?\n`: the `.cmd` twin's
 *  `echo` writes CRLF, so a bare `\n` split leaves `free\r` on Windows. */
const npmCwds = () => (fs.existsSync(npmLog) ? fs.readFileSync(npmLog, 'utf8').split(/\r?\n/).filter(Boolean) : []);

beforeEach(() => {
  repo = makeScratchDir('modoki-bootstrap-claim-');
  home = makeScratchDir('modoki-bootstrap-home-');
  bin = makeScratchDir('modoki-bootstrap-bin-');
  npmLog = path.join(bin, 'calls.log');
  fs.mkdirSync(path.join(repo, 'engine', 'scripts'), { recursive: true });
  for (const f of SCRIPTS) fs.copyFileSync(path.join(scriptsDir, f), path.join(repo, 'engine', 'scripts', f));
  // Records the cwd, succeeds, installs nothing. The `.cmd` twin is what the Windows shell resolves.
  fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\npwd >> "$NPM_LOG"\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'npm.cmd'), '@echo off\r\necho %CD%>> "%NPM_LOG%"\r\nexit /b 0\r\n');
  prevHome = process.env.MODOKI_HOME;
  process.env.MODOKI_HOME = home;
});

afterEach(() => {
  resetBuildClaimsForTests();
  if (prevHome === undefined) delete process.env.MODOKI_HOME;
  else process.env.MODOKI_HOME = prevHome;
  for (const d of [repo, home, bin]) fs.rmSync(d, { recursive: true, force: true });
});

describe('bootstrap-game-deps.mjs runs each project under its build claim (#1160)', () => {
  it('installs every project when nothing holds a claim (the accept side)', () => {
    addGame('a');
    addGame('b');
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(npmCwds().map((d) => path.basename(d)).sort()).toEqual(['a', 'b']);
    expect(r.stderr).not.toMatch(/skipped/);
  });

  it('SKIPS a project a build holds, naming it, installs the rest, and still exits 0', () => {
    const held = addGame('held');
    addGame('free');
    const claim = acquireBuildClaim(held, 'ios build (test)', { kind: 'cli' });
    if (!claim.ok) throw new Error(claim.message);
    try {
      const r = run();
      expect(r.status, r.stderr).toBe(0);
      expect(npmCwds().map((d) => path.basename(d))).toEqual(['free']);
      expect(r.stderr).toMatch(/skipped games\/held, its deps were NOT installed/);
      expect(r.stderr).toMatch(/ios build \(test\)/);
      expect(r.stderr).toMatch(/1 project\(s\) skipped because their build claim could not be taken: games\/held/);
    } finally {
      claim.release();
    }
  });
});
