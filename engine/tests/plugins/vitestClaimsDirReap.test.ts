/** #1117: the claims store's vitest fallback dirs (`modoki-claims-vitest-<pid>`) are removed.
 *
 *  `engine/tests/globalSetup.ts`'s teardown reaps all three producers: vitest WORKERS (dead by
 *  teardown, since the default pool gives each file a fresh one), the vitest MAIN process (the editor
 *  backend plugin sweeps claims when vitest builds its Vite server), and CHILD processes a test spawns. The end-to-end case runs a real engine-config vitest into a private TMPDIR, because
 *  whether the global setup is wired at all is exactly what a unit test cannot see. */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';
import { reapVitestClaimsDirs } from '../../scripts/deviceClaimsStore.mjs';

const ENGINE = path.resolve(__dirname, '../..');
const DEAD = 999_999_991;
const ALIVE = 999_999_992;
const OLD_DEAD = 999_999_993;

describe('reapVitestClaimsDirs', () => {
  it("removes this process's own dir and this run's dead-pid dirs, and nothing else", () => {
    const tmp = makeScratchDir('modoki-reap-');
    const mk = (name: string) => { const d = path.join(tmp, name); fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'build-claims.json'), '{"claims":[]}'); return d; };
    const own = mk(`modoki-claims-vitest-${process.pid}`);
    const dead = mk(`modoki-claims-vitest-${DEAD}`);
    const alive = mk(`modoki-claims-vitest-${ALIVE}`);
    const oldDead = mk(`modoki-claims-vitest-${OLD_DEAD}`);
    const unrelated = mk('modoki-claims-vitest-notapid');
    const sibling = mk('modoki-recents-abc123');
    const sinceMs = Date.now() - 1_000;
    // Historical debris: older than the run, so not this run's to delete. That includes the OWN dir,
    // which is removed anyway because its pid is this process.
    const past = new Date(sinceMs - 60_000);
    fs.utimesSync(oldDead, past, past);
    fs.utimesSync(own, past, past);

    const removed = reapVitestClaimsDirs({ sinceMs, tmp, alive: (pid) => pid === ALIVE || pid === process.pid });

    expect(removed.sort()).toEqual([dead, own].sort());
    expect([own, dead].filter((d) => fs.existsSync(d))).toEqual([]);
    expect([alive, oldDead, unrelated, sibling].filter((d) => !fs.existsSync(d))).toEqual([]);
  });
});

describe('an engine-config vitest run leaves no claims fallback dir behind', () => {
  it('reaps the main process dir that the backend plugin sweep creates', () => {
    const tmp = makeScratchDir('modoki-reap-e2e-', { canonical: true });
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('VITEST')));
    const vitestBin = path.resolve(ENGINE, '../node_modules/vitest/vitest.mjs');
    const run = spawnSync(process.execPath, [vitestBin, 'run', '--config', 'vite.config.ts', 'tests/ecs/animatorClipPreload.test.ts'], {
      cwd: ENGINE,
      env: { ...env, TMPDIR: `${tmp}/`, TMP: tmp, TEMP: tmp },
      encoding: 'utf8',
      timeout: 180_000,
    });
    const output = `${run.stdout}\n${run.stderr}`;
    // Non-vacuity: the child really ran a suite, inside this TMPDIR.
    expect(run.status, output).toBe(0);
    expect(output).toMatch(/Tests\s+\d+ passed/);
    expect(fs.readdirSync(tmp).filter((n) => n.startsWith('modoki-claims-vitest-'))).toEqual([]);
  });
});
