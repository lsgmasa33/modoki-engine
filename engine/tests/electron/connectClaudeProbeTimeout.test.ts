import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';
import { spawnSync } from 'node:child_process';
import {
  detectClaudeCli,
  _resetClaudeMemo,
  CLAUDE_PROBE_TIMEOUT_MS,
  CLAUDE_TIMED_OUT_MEMO_TTL_MS,
} from '../../electron/connectClaude';

/**
 * #1448 — `detectClaudeCli` runs synchronously in the Electron MAIN process, so every probe
 * it spawns must be bounded: an unbounded `where claude` took ~10s on a loaded CI runner,
 * and for all of it IPC, menus and window events stall. The spy passes through to the real
 * spawnSync; the tests only read what each probe was ASKED for, or replace its answer.
 */
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return { ...real, spawnSync: vi.fn(real.spawnSync) };
});

const spy = vi.mocked(spawnSync);
const { spawnSync: realSpawnSync } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
const FINDER = process.platform === 'win32' ? 'where' : 'which';
const ENV = { PATH: '/x', SHELL: '/bin/sh' } as NodeJS.ProcessEnv;

/** What spawnSync returns when `timeout` kills the child (observed on Windows with a killed
 *  `ping`): status null, an ETIMEDOUT error on the result (NOT thrown), and whatever stdout
 *  arrived before the kill — which can be a TRUNCATED path. */
const TIMED_OUT = {
  pid: 0, output: [null, 'C:/Users/x/App', ''], stdout: 'C:/Users/x/App', stderr: '', status: null, signal: 'SIGTERM',
  error: Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }),
};
/** A real, fast miss: the finder ran to completion and said no. */
const MISS = { pid: 0, output: [null, '', ''], stdout: '', stderr: '', status: 1, signal: null };

function answerEvery(probe: object): void {
  spy.mockImplementation((() => probe) as unknown as typeof spawnSync);
}

afterEach(() => {
  spy.mockImplementation(realSpawnSync);
  spy.mockClear();
  vi.restoreAllMocks();
  _resetClaudeMemo();
});

describe('detectClaudeCli — every probe is bounded (#1448)', () => {
  it('the which/where probe carries the timeout', () => {
    detectClaudeCli();
    const call = spy.mock.calls.find(([cmd]) => cmd === FINDER);
    expect(call, `${FINDER} was never spawned`).toBeDefined();
    expect((call![2] as { timeout?: number } | undefined)?.timeout).toBe(CLAUDE_PROBE_TIMEOUT_MS);
  });

  it('the bound is small enough to be worth having', () => {
    // Pinned by size, not by name: raising it to 60s would still "carry the timeout".
    expect(CLAUDE_PROBE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(CLAUDE_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(5000);
  });

  // win32 has no login-shell fallback (it returns before spawning anything), so this
  // probe only exists on macOS/Linux — the CI matrix's other two legs run it.
  it.skipIf(process.platform === 'win32')('the login-shell probe carries the timeout too', () => {
    answerEvery(MISS); // the finder misses, so the login shell is the next probe
    detectClaudeCli(ENV);
    const call = spy.mock.calls.find(([cmd]) => cmd === ENV.SHELL);
    expect(call, 'the login shell was never spawned').toBeDefined();
    expect((call![2] as { timeout?: number } | undefined)?.timeout).toBe(CLAUDE_PROBE_TIMEOUT_MS);
  });
});

describe('detectClaudeCli — a timed-out check is not a miss (#1448)', () => {
  it('reports probeTimedOut, and ignores the truncated stdout', () => {
    answerEvery(TIMED_OUT);
    expect(detectClaudeCli(ENV)).toEqual({ found: false, probeTimedOut: true });
  });

  it('ETIMEDOUT on a process that exited by itself is its answer, not a timeout (#1449)', () => {
    // Observed on macOS: the shell said "no" in ~10ms, a grandchild held the pipe, and libuv
    // reported ETIMEDOUT beside the shell's own status 1.
    answerEvery({ ...MISS, error: TIMED_OUT.error });
    expect(detectClaudeCli(ENV)).toEqual({ found: false });
  });

  it('a real miss reports plain not-found', () => {
    answerEvery(MISS);
    expect(detectClaudeCli(ENV)).toEqual({ found: false });
  });

  it('holds a timed-out result past the 15s not-found TTL, and re-probes after its own', () => {
    let clock = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    answerEvery(TIMED_OUT);
    detectClaudeCli(ENV);
    const probes = spy.mock.calls.length;
    expect(probes).toBeGreaterThan(0);

    clock += 60_000; // well past a plain miss's 15s — re-probing here would freeze the editor again
    detectClaudeCli(ENV);
    expect(spy.mock.calls.length).toBe(probes);

    clock += CLAUDE_TIMED_OUT_MEMO_TTL_MS; // past its own TTL: transient load may have cleared
    detectClaudeCli(ENV);
    expect(spy.mock.calls.length).toBeGreaterThan(probes);
  });

  it('a plain miss is still re-checked after 15s', () => {
    let clock = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    answerEvery(MISS);
    detectClaudeCli(ENV);
    const probes = spy.mock.calls.length;
    clock += 16_000;
    detectClaudeCli(ENV);
    expect(spy.mock.calls.length).toBeGreaterThan(probes);
  });
});

/**
 * #1449 — the login-shell probe runs the USER's profile, so the bound has to survive what a
 * profile does. These spawn a real bash against a fixture HOME: a spawnSync mock cannot tell
 * SIGTERM from SIGKILL, or a pipe from a file. Timings are generous against load; each broken
 * shape misses its budget by a wide margin (measured: 20s and 4s).
 */
describe.skipIf(process.platform === 'win32')('detectClaudeCli — the login-shell bound holds against the profile (#1449)', () => {
  /** A HOME whose bash login profile is `profile`, plus a bin dir the profile may put on PATH. */
  function fixtureEnv(profile: string): NodeJS.ProcessEnv {
    const home = makeScratchDir('modoki-1449-');
    fs.writeFileSync(path.join(home, '.bash_profile'), profile);
    return { HOME: home, PATH: '/usr/bin:/bin', SHELL: '/bin/bash' };
  }

  function timed(env: NodeJS.ProcessEnv): { result: ReturnType<typeof detectClaudeCli>; ms: number } {
    const t = performance.now();
    const result = detectClaudeCli(env);
    return { result, ms: performance.now() - t };
  }

  it('a profile that ignores SIGTERM is still cut off at the bound', () => {
    // An interactive bash ignores SIGTERM, so the default killSignal waited out all 20s.
    const { result, ms } = timed(fixtureEnv('sleep 20\n'));
    expect(result).toEqual({ found: false, probeTimedOut: true });
    expect(ms).toBeLessThan(CLAUDE_PROBE_TIMEOUT_MS + 6000);
  }, 30_000);

  it('a profile that backgrounds a child answers a miss at once, and not as timed out', () => {
    // The child inherits the shell's stdio; on a stdout pipe the probe waited the full bound.
    // PATH is re-pinned AFTER /etc/profile: macOS's path_helper puts /usr/local/bin back, where
    // an npm-global claude would turn this miss into a hit.
    const { result, ms } = timed(fixtureEnv('(sleep 20 &)\nexport PATH=/usr/bin:/bin\n'));
    expect(result).toEqual({ found: false });
    expect(ms).toBeLessThan(CLAUDE_PROBE_TIMEOUT_MS - 1000);
  }, 30_000);

  it('a timeout kills the profile\'s foreground child with the shell, instead of orphaning it', async () => {
    const env = fixtureEnv('');
    const pidFile = path.join(env.HOME!, 'pid');
    fs.writeFileSync(path.join(env.HOME!, '.bash_profile'), `sh -c 'echo $$ > "${pidFile}"; exec sleep 20'\n`);
    expect(detectClaudeCli(env)).toEqual({ found: false, probeTimedOut: true });
    expect(fs.existsSync(pidFile), 'the profile never reached its child inside the bound (machine load?)').toBe(true);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(pid).toBeGreaterThan(0);
    const alive = (): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (let i = 0; i < 40 && alive(); i++) await new Promise((r) => setTimeout(r, 50));
    expect(alive(), `the profile's sleep (pid ${pid}) outlived the probe`).toBe(false);
  }, 30_000);

  it('a hit behind the same profile comes back from the file', () => {
    const env = fixtureEnv('');
    const bin = path.join(env.HOME!, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(env.HOME!, '.bash_profile'), `(sleep 20 &)\necho noise\nexport PATH="${bin}:$PATH"\n`);
    const { result, ms } = timed(env);
    expect(result).toEqual({ found: true, path: path.join(bin, 'claude') });
    expect(ms).toBeLessThan(CLAUDE_PROBE_TIMEOUT_MS - 1000);
  }, 30_000);
});
