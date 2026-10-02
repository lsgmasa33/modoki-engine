/** #2064: the packaged-deps signature must move with every input of the packaged editor's
 *  pre-bundled Vite deps that Vite itself does not key on there — the root lockfiles (a registry-dep
 *  bump) and the source of every workspace package the lockfile LINKS (which electron-builder copies
 *  into node_modules unpinned) — and must not move otherwise — a signature that changes on every
 *  build would cold-re-optimize the packaged editor on every boot, which is #21.
 *
 *  Built against a scratch repo (a lockfile + linked package dirs), so each case varies exactly one
 *  input. The wiring into main.cjs and main.ts's `buildSig` is guarded in
 *  tests/architecture/viteCacheBustSignature.test.ts. */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';
import { packagedDepsSignature, linkedPackages } from '../../scripts/packagedDepsSignature.mjs';
import { repoRoot } from '../../scripts/electronBuildOpts.mjs';

let root: string;

function write(rel: string, body: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
}

function lockfile(packages: Record<string, unknown>): void {
  write('package-lock.json', JSON.stringify({ name: 'x', lockfileVersion: 3, packages: { '': { name: 'x' }, ...packages } }));
}

beforeEach(() => {
  root = makeScratchDir('modoki-linkedsig-');
  lockfile({
    'node_modules/@modoki/engine': { resolved: 'engine/packages/modoki', link: true },
    'node_modules/capacitor-x': { resolved: 'engine/packages/capacitor-x', link: true },
    'engine/packages/modoki': { name: '@modoki/engine', version: '0.0.0' },
    'node_modules/three': { version: '0.185.0', resolved: 'https://registry.npmjs.org/three/-/three-0.185.0.tgz' },
  });
  write('engine/packages/modoki/package.json', '{"name":"@modoki/engine"}');
  write('engine/packages/modoki/src/editor/index.ts', 'export const a = 1;\n');
  write('engine/packages/modoki/src/runtime/index.ts', 'export const r = 1;\n');
  write('engine/packages/capacitor-x/dist/esm/index.js', 'export const p = 1;\n');
});

describe('packagedDepsSignature (#2064)', () => {
  /** Every case below runs on a scratch lockfile, so this is the one place the REAL lockfile is
   *  read. A lockfile that stopped marking workspaces `link: true` would make the signature blind to
   *  engine source again, while every scratch case stayed green. */
  it('the real lockfile links @modoki/engine', () => {
    expect(linkedPackages(repoRoot).map(([k]) => k)).toContain('node_modules/@modoki/engine');
  });

  it('lists exactly the lockfile entries marked link:true, derived rather than named', () => {
    expect(linkedPackages(root).map(([k]) => k)).toEqual(['node_modules/@modoki/engine', 'node_modules/capacitor-x']);
  });

  it('is stable for an unchanged tree', () => {
    expect(packagedDepsSignature(root)).toBe(packagedDepsSignature(root));
    expect(packagedDepsSignature(root)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('moves when a nested source file of a linked package changes content — the observed case: a new editor export', () => {
    const before = packagedDepsSignature(root);
    write('engine/packages/modoki/src/editor/index.ts', 'export const a = 1;\nexport const added = 2;\n');
    expect(packagedDepsSignature(root)).not.toBe(before);
  });

  it('moves on a same-length content change (it hashes bytes, not sizes)', () => {
    const before = packagedDepsSignature(root);
    write('engine/packages/modoki/src/runtime/index.ts', 'export const r = 2;\n');
    expect(packagedDepsSignature(root)).not.toBe(before);
  });

  /** A rename that keeps the file's place in the sort order, so only the PATH changes — the hash of
   *  bytes alone, in the same order, cannot see it. */
  it('moves on a rename that keeps the sort order', () => {
    write('engine/packages/modoki/src/editor/b1.ts', 'export {};\n');
    const before = packagedDepsSignature(root);
    fs.renameSync(path.join(root, 'engine/packages/modoki/src/editor/b1.ts'), path.join(root, 'engine/packages/modoki/src/editor/b2.ts'));
    expect(packagedDepsSignature(root)).not.toBe(before);
  });

  /** Packaged, Vite's own key has no lockfile in it (the app ships none, so it records the hash of
   *  ''), so a registry-dep bump reaches the bust only through these bytes. */
  it('moves on a registry-dep bump in package-lock.json, with no linked package touched', () => {
    const before = packagedDepsSignature(root);
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    lock.packages['node_modules/three'].version = '0.185.1';
    fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify(lock));
    expect(packagedDepsSignature(root)).not.toBe(before);
  });

  it("moves when npm's installed-tree record (node_modules/.package-lock.json) appears or changes", () => {
    const absent = packagedDepsSignature(root);
    write('node_modules/.package-lock.json', '{"v":1}');
    const v1 = packagedDepsSignature(root);
    expect(v1).not.toBe(absent);
    write('node_modules/.package-lock.json', '{"v":2}');
    expect(packagedDepsSignature(root)).not.toBe(v1);
  });

  it('moves when a file is added, removed or renamed', () => {
    const base = packagedDepsSignature(root);
    write('engine/packages/modoki/src/editor/extra.ts', 'export {};\n');
    const added = packagedDepsSignature(root);
    expect(added).not.toBe(base);
    fs.renameSync(path.join(root, 'engine/packages/modoki/src/editor/extra.ts'), path.join(root, 'engine/packages/modoki/src/editor/moved.ts'));
    expect(packagedDepsSignature(root)).not.toBe(added);
    fs.rmSync(path.join(root, 'engine/packages/modoki/src/editor/moved.ts'));
    expect(packagedDepsSignature(root)).toBe(base);
  });

  it('covers EVERY linked package, a gitignored dist/ included — a plugin rebuild is the same hazard', () => {
    const before = packagedDepsSignature(root);
    write('engine/packages/capacitor-x/dist/esm/index.js', 'export const p = 2;\n');
    expect(packagedDepsSignature(root)).not.toBe(before);
  });

  it('picks up a newly linked workspace package with no edit to the signature code', () => {
    const before = packagedDepsSignature(root);
    write('engine/packages/new-pkg/index.js', 'export {};\n');
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    lock.packages['node_modules/new-pkg'] = { resolved: 'engine/packages/new-pkg', link: true };
    fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify(lock));
    expect(packagedDepsSignature(root)).not.toBe(before);
  });

  it('does not move for what it deliberately skips: nested node_modules, dot-dir tool state, unlinked dirs', () => {
    const before = packagedDepsSignature(root);
    write('engine/packages/modoki/node_modules/dep/index.js', 'x');
    write('engine/packages/capacitor-x/.build/index-build/store', 'x');
    write('engine/packages/capacitor-x/core/.swiftpm/state', 'x');
    write('engine/packages/unlinked/index.js', 'x');
    write('engine/app/editor/whatever.ts', 'x');
    expect(packagedDepsSignature(root)).toBe(before);
  });

  it('throws when the lockfile links a package dir that does not exist', () => {
    fs.rmSync(path.join(root, 'engine/packages/capacitor-x'), { recursive: true });
    expect(() => packagedDepsSignature(root)).toThrow(/capacitor-x .*does not exist/);
  });
});
