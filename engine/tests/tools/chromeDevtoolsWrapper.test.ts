import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { cdpPortFromEnv, chromeDevtoolsArgs } from '../../scripts/chrome-devtools-mcp.mjs';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

/**
 * #1894 — `engine/scripts/chrome-devtools-mcp.mjs`, the chrome-devtools server as the committed
 * `.mcp.json` starts it. It reads MODOKI_CDP_PORT at spawn so the config carries no `${...}`, and
 * it must be TRANSPARENT: the child's exit code is its own, a signal sent to it reaches the child,
 * and a child killed by a signal kills it the same way. Driven against a stub child, not `npx`.
 */
const WRAPPER = pathToFileURL(path.resolve(__dirname, '..', '..', 'scripts', 'chrome-devtools-mcp.mjs')).href;
const posixOnly = process.platform === 'win32' ? it.skip : it;
/** Every spawn is bounded: a wrapper that stops forwarding or exiting must FAIL these tests, not
 *  hang them and leak its processes (a mutation check did exactly that before the bounds). */
const BOUND_MS = 10_000;
/** Stub children end themselves after the bound too, so nothing outlives a failed test. */
const selfExit = `setTimeout(() => process.exit(99), ${BOUND_MS}).unref();`;

/** A node process that runs `childSrc` through the wrapper's `runTransparent`, exactly as its CLI
 *  runs `npx`. */
function driverArgs(childSrc: string): string[] {
  const driver = `import { runTransparent } from ${JSON.stringify(WRAPPER)};
runTransparent({ command: process.execPath, args: ['-e', ${JSON.stringify(selfExit + childSrc)}] });`;
  return ['--input-type=module', '-e', driver];
}

describe('chrome-devtools-mcp.mjs arguments (#1894)', () => {
  it('MODOKI_CDP_PORT picks the port; unset or EMPTY falls back to 9222, as `${MODOKI_CDP_PORT:-9222}` did', () => {
    expect(cdpPortFromEnv({ MODOKI_CDP_PORT: '9325' })).toBe('9325');
    expect(cdpPortFromEnv({})).toBe('9222');
    expect(cdpPortFromEnv({ MODOKI_CDP_PORT: '' })).toBe('9222');
  });

  it('builds the exact npx line .mcp.json used to carry, extra arguments appended', () => {
    expect(chromeDevtoolsArgs({ MODOKI_CDP_PORT: '9325' }, ['--isolated'])).toEqual(
      ['-y', 'chrome-devtools-mcp@latest', '--browser-url=http://127.0.0.1:9325', '--isolated'],
    );
  });
});

describe('runTransparent (#1894)', () => {
  it('exits with the child\'s exit code', () => {
    const r = spawnSync(process.execPath, driverArgs('process.exit(7)'), { encoding: 'utf8', timeout: BOUND_MS });
    expect(r.status).toBe(7);
  });

  it('passes stdio straight through (the MCP protocol flows over it)', () => {
    const r = spawnSync(process.execPath, driverArgs('process.stdin.pipe(process.stdout)'), { input: 'ping', encoding: 'utf8', timeout: BOUND_MS });
    expect(r.stdout).toBe('ping');
  });

  posixOnly('forwards SIGTERM to the child', { timeout: BOUND_MS * 2 }, async () => {
    const dir = makeScratchDir('modoki-cdp-wrap-');
    const marker = path.join(dir, 'got-sigterm');
    try {
      // The child says it is ready on stderr, then records the signal it receives and exits 0.
      const child = `process.on('SIGTERM', () => { require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); process.exit(0); });
process.stderr.write('ready\\n'); setInterval(() => {}, 1000);`;
      const p = spawn(process.execPath, driverArgs(child), { stdio: ['ignore', 'ignore', 'pipe'], timeout: BOUND_MS });
      await new Promise<void>((res) => p.stderr!.on('data', (d) => { if (String(d).includes('ready')) res(); }));
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => p.on('exit', (code, signal) => res({ code, signal })));
      p.kill('SIGTERM');
      expect(await exited).toEqual({ code: 0, signal: null }); // the child's clean exit, not our death
      expect(fs.existsSync(marker)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  posixOnly('a child killed BY a signal kills the wrapper by the same signal', { timeout: BOUND_MS * 2 }, async () => {
    const p = spawn(process.execPath, driverArgs(`process.kill(process.pid, 'SIGTERM')`), { stdio: 'ignore', timeout: BOUND_MS });
    const r = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => p.on('exit', (code, signal) => res({ code, signal })));
    expect(r).toEqual({ code: null, signal: 'SIGTERM' });
  });
});
