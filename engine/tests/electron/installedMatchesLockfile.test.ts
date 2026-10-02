/** #2066 item 3: `build-electron.mjs` re-installs the modoki-mcp deps when the installed tree
 *  stops matching the tool's package-lock.json. Before, it skipped whenever the sdk's package.json
 *  merely existed, so an sdk/zod bump bundled the OLD deps into the shipped MCP server.
 *
 *  Built against a scratch tool dir, so each case varies exactly one input. The wiring into
 *  build-electron was checked live. In the post-pull state (`npm install zod@3.25.75 --no-save`,
 *  lockfile still pinning 3.25.76), `npm run build:electron` re-installed and restored 3.25.76,
 *  where the old existence check skipped. With node_modules/zod/package.json hand-edited (#685's
 *  state, which npm reports "up to date" over), it refused with exit 1 instead of bundling. */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';
import { staleAgainstLockfile, ensureInstalledMatchesLockfile } from '../../scripts/installedMatchesLockfile.mjs';

let dir: string;

function write(rel: string, body: unknown): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(body));
}

beforeEach(() => {
  dir = makeScratchDir('modoki-lockmatch-');
  write('package.json', { name: 'tool', dependencies: { sdk: '^1.0.0' }, devDependencies: { tsx: '^4.0.0' } });
  write('package-lock.json', {
    lockfileVersion: 3,
    packages: {
      '': { name: 'tool', dependencies: { sdk: '^1.0.0' }, devDependencies: { tsx: '^4.0.0' } },
      'node_modules/sdk': { version: '1.2.0' },
      'node_modules/tsx': { version: '4.1.0', dev: true },
      'node_modules/sdk/node_modules/zod': { version: '3.0.0' },
      'node_modules/@esbuild/win32-x64': { version: '0.25.0', optional: true },
      'node_modules/linked': { resolved: '../linked', link: true },
    },
  });
  write('node_modules/sdk/package.json', { name: 'sdk', version: '1.2.0' });
  write('node_modules/tsx/package.json', { name: 'tsx', version: '4.1.0' });
  write('node_modules/sdk/node_modules/zod/package.json', { name: 'zod', version: '3.0.0' });
});

describe('staleAgainstLockfile', () => {
  it('a tree matching the lockfile is current — absent optional (other-platform) and link entries included', () => {
    expect(staleAgainstLockfile(dir)).toEqual([]);
  });

  it('an installed package at a version the lockfile no longer pins is stale (the sdk bump)', () => {
    write('node_modules/sdk/package.json', { name: 'sdk', version: '1.1.0' });
    expect(staleAgainstLockfile(dir)).toEqual(['sdk: installed 1.1.0, lockfile pins 1.2.0']);
  });

  it('a nested pinned package counts too', () => {
    write('node_modules/sdk/node_modules/zod/package.json', { name: 'zod', version: '2.9.0' });
    expect(staleAgainstLockfile(dir)).toEqual(['sdk/node_modules/zod: installed 2.9.0, lockfile pins 3.0.0']);
  });

  it('a non-optional pinned package that is missing is stale; a missing optional one is not', () => {
    fs.rmSync(path.join(dir, 'node_modules/tsx'), { recursive: true });
    expect(staleAgainstLockfile(dir)).toEqual(['tsx: not installed (lockfile pins 4.1.0)']);
  });

  it('a package.json spec the lockfile has not caught up with is stale', () => {
    write('package.json', { name: 'tool', dependencies: { sdk: '^1.3.0' }, devDependencies: { tsx: '^4.0.0' } });
    expect(staleAgainstLockfile(dir)).toEqual(['dependencies.sdk: package.json ^1.3.0 vs lockfile ^1.0.0']);
  });

  it('no lockfile means install, never a crash', () => {
    fs.rmSync(path.join(dir, 'package-lock.json'));
    expect(staleAgainstLockfile(dir)).toEqual(['no readable package-lock.json (v2+)']);
  });
});

describe('ensureInstalledMatchesLockfile — the sequence build-electron runs', () => {
  const io = (install: () => void) => { const logs: string[] = []; let calls = 0; return { logs, calls: () => calls, io: { install: () => { calls++; install(); }, log: (m: string) => { logs.push(m); } } }; };

  it('a current tree installs nothing', () => {
    const t = io(() => {});
    expect(ensureInstalledMatchesLockfile(dir, 'tool', t.io)).toEqual([]);
    expect(t.calls()).toBe(0);
  });

  it('a stale tree installs once, and an install that heals it returns why it ran', () => {
    write('node_modules/sdk/package.json', { name: 'sdk', version: '1.1.0' });
    const t = io(() => write('node_modules/sdk/package.json', { name: 'sdk', version: '1.2.0' }));
    expect(ensureInstalledMatchesLockfile(dir, 'tool', t.io)).toEqual(['sdk: installed 1.1.0, lockfile pins 1.2.0']);
    expect(t.calls()).toBe(1);
    expect(t.logs).toEqual(['tool deps stale (sdk: installed 1.1.0, lockfile pins 1.2.0) → npm install in tool']);
  });

  it("an install that leaves it stale (npm's 'up to date' over #685's state) throws instead of letting the bundle build", () => {
    write('node_modules/sdk/package.json', { name: 'sdk', version: '1.1.0' });
    const t = io(() => {});
    expect(() => ensureInstalledMatchesLockfile(dir, 'tool', t.io)).toThrow(/still stale after npm install \(sdk: installed 1\.1\.0/);
    expect(t.calls()).toBe(1);
  });
});
