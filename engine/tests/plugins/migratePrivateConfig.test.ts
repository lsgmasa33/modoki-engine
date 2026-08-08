/** End-to-end tests for engine/scripts/migrate-private-config.mjs (#172).
 *
 *  Runs the REAL script as a subprocess (`node`) against a throwaway temp "repo" —
 *  `MODOKI_MIGRATE_REPO_ROOT` (a test-only override the script honours) points it at
 *  a directory with its own `games/`/`demos/` + a copy of `engine/project-config.ts`
 *  (so its `loadEnginePluginModule`/esbuild seam has something to bundle), instead of
 *  the real repo. Never touches this repo's own committed project.config.json files —
 *  the brief for #172 is explicit that the migration must not run against the real
 *  repo from a test. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const SCRIPT = path.resolve(__dirname, '../../scripts/migrate-private-config.mjs');
const REAL_PROJECT_CONFIG_TS = path.resolve(__dirname, '../../project-config.ts');

let tmpRepo: string;

beforeEach(() => {
  tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-migrate-private-'));
  fs.mkdirSync(path.join(tmpRepo, 'engine'), { recursive: true });
  fs.copyFileSync(REAL_PROJECT_CONFIG_TS, path.join(tmpRepo, 'engine', 'project-config.ts'));
});

afterEach(() => {
  fs.rmSync(tmpRepo, { recursive: true, force: true });
});

function makeProject(root: 'games' | 'demos', id: string, cfg: Record<string, unknown>) {
  const dir = path.join(tmpRepo, root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project.config.json'), JSON.stringify(cfg, null, 2) + '\n');
  return dir;
}

function run(extraArgs: string[] = []): string {
  return execFileSync('node', [SCRIPT, ...extraArgs], {
    encoding: 'utf-8',
    env: { ...process.env, MODOKI_MIGRATE_REPO_ROOT: tmpRepo },
  });
}

/** Run allowing a NON-ZERO exit, capturing both streams. The skip paths below must exit 1,
 *  so `run()` (which throws on a non-zero status) cannot express them. */
function runAllowFail(extraArgs: string[] = []): { status: number; out: string } {
  const r = spawnSync('node', [SCRIPT, ...extraArgs], {
    encoding: 'utf-8',
    env: { ...process.env, MODOKI_MIGRATE_REPO_ROOT: tmpRepo },
  });
  return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf-8'));

describe('migrate-private-config', () => {
  it('moves a private field into project.user.json and blanks it in project.config.json', () => {
    const dir = makeProject('games', 'testgame', {
      app: { appId: 'com.example.test' },
      build: { appleTeamId: 'LEGACY99999', debugBuild: true },
    });

    const out = run();
    expect(out).toContain('games/testgame: build.appleTeamId');

    expect(readJson(path.join(dir, 'project.config.json')).build.appleTeamId).toBe('');
    // debugBuild is NOT private — untouched.
    expect(readJson(path.join(dir, 'project.config.json')).build.debugBuild).toBe(true);
    expect(readJson(path.join(dir, 'project.user.json')).build.appleTeamId).toBe('LEGACY99999');
  });

  it('preserves an existing device/sdk section in project.user.json (merges, does not clobber)', () => {
    const dir = makeProject('demos', 'testdemo', { build: { webBucket: 'gs://legacy/bucket' } });
    fs.writeFileSync(path.join(dir, 'project.user.json'), JSON.stringify({
      device: { iosDeviceId: 'PRE-EXISTING-UDID' },
    }, null, 2) + '\n');

    run();

    const user = readJson(path.join(dir, 'project.user.json'));
    expect(user.device.iosDeviceId).toBe('PRE-EXISTING-UDID');
    expect(user.build.webBucket).toBe('gs://legacy/bucket');
  });

  it('is idempotent — a second run finds nothing to move', () => {
    const dir = makeProject('games', 'testgame', { build: { appleTeamId: 'LEGACY99999' } });
    run();
    const afterFirst = fs.readFileSync(path.join(dir, 'project.config.json'), 'utf-8');
    const afterFirstUser = fs.readFileSync(path.join(dir, 'project.user.json'), 'utf-8');

    const out = run();
    expect(out).toContain('Nothing to migrate');
    expect(fs.readFileSync(path.join(dir, 'project.config.json'), 'utf-8')).toBe(afterFirst);
    expect(fs.readFileSync(path.join(dir, 'project.user.json'), 'utf-8')).toBe(afterFirstUser);
  });

  it('--dry-run reports but writes nothing', () => {
    const dir = makeProject('games', 'testgame', { build: { appleTeamId: 'LEGACY99999' } });
    const before = fs.readFileSync(path.join(dir, 'project.config.json'), 'utf-8');

    const out = run(['--dry-run']);
    expect(out).toContain('[dry-run] would move');
    expect(out).toContain('Would move');
    expect(fs.readFileSync(path.join(dir, 'project.config.json'), 'utf-8')).toBe(before);
    expect(fs.existsSync(path.join(dir, 'project.user.json'))).toBe(false);

    // The real (non-dry) run afterward still finds something to do — proves dry-run
    // genuinely wrote nothing rather than silently no-oping for some other reason.
    const realOut = run();
    expect(realOut).toContain('build.appleTeamId');
    expect(readJson(path.join(dir, 'project.config.json')).build.appleTeamId).toBe('');
  });

  it('an unreadable project.user.json is a LOUD failure, not a clean run (exit 1)', () => {
    // The migration must never leave a secret committed and report success. Before the fix this
    // printed "Nothing to migrate — every project is already clean." and exited 0, over the top of
    // a project whose real Team ID was still in project.config.json.
    const dir = makeProject('games', 'broken', { build: { appleTeamId: 'LEGACY99999' } });
    fs.writeFileSync(path.join(dir, 'project.user.json'), '{ not json');

    const { status, out } = runAllowFail();
    expect(status).toBe(1);
    expect(out).toContain('could NOT be migrated');
    expect(out).toContain('left COMMITTED');
    expect(out).not.toContain('Nothing to migrate');
    // and the committed value is untouched — the file we could not parse was not clobbered either
    expect(readJson(path.join(dir, 'project.config.json')).build.appleTeamId).toBe('LEGACY99999');
    expect(fs.readFileSync(path.join(dir, 'project.user.json'), 'utf-8')).toBe('{ not json');
  });

  it('a failed WRITE is reported against that project, and the others still migrate', () => {
    // Order matters here: the value must never be destroyed. The user file is written first, so a
    // crash on the committed write leaves the value in BOTH places (recoverable) rather than
    // neither. The other project must not be held hostage by one project's permissions.
    const bad = makeProject('games', 'readonly', { build: { appleTeamId: 'LEGACY99999' } });
    const good = makeProject('games', 'fine', { build: { appleTeamId: 'OTHERTEAM1' } });
    fs.chmodSync(path.join(bad, 'project.config.json'), 0o444);
    try {
      const { status, out } = runAllowFail();
      expect(status).toBe(1);
      expect(out).toContain('write failed');
      // NOT reported as moved — the log line follows the write rather than preceding it
      expect(out).not.toContain('moved games/readonly');
      // the value survived in the user file, so a re-run can finish the job
      expect(readJson(path.join(bad, 'project.user.json')).build.appleTeamId).toBe('LEGACY99999');
      // the independent project completed
      expect(readJson(path.join(good, 'project.config.json')).build.appleTeamId).toBe('');
      expect(readJson(path.join(good, 'project.user.json')).build.appleTeamId).toBe('OTHERTEAM1');
    } finally {
      fs.chmodSync(path.join(bad, 'project.config.json'), 0o644);
    }
  });

  it('leaves a project with no private fields set alone', () => {
    const dir = makeProject('games', 'clean', { app: { appId: 'com.example.clean' } });
    const out = run();
    expect(out).toContain('Nothing to migrate');
    expect(fs.existsSync(path.join(dir, 'project.user.json'))).toBe(false);
  });
});
