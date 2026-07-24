/** Bundle-manifest hashing (docs/plans/mobile-ota-updates-plan.md, Phase 0). */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildManifestFiles } from '../../../scripts/ota/buildManifest.mjs';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe('buildManifestFiles', () => {
  it('hashes every file with correct relative path, hash, and size', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'modoki-ota-test-'));
    writeFileSync(path.join(dir, 'index.html'), '<html></html>');
    mkdirSync(path.join(dir, 'assets'));
    writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log(1)');

    const files = await buildManifestFiles(dir);

    expect(Object.keys(files).sort()).toEqual(['assets/app.js', 'index.html']);
    expect(files['index.html'].hash).toBe(sha256('<html></html>'));
    expect(files['index.html'].size).toBe(Buffer.byteLength('<html></html>'));
    expect(files['assets/app.js'].hash).toBe(sha256('console.log(1)'));
  });

  it('uses forward-slash relative paths on every platform', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'modoki-ota-test-'));
    mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
    writeFileSync(path.join(dir, 'a', 'b', 'c.txt'), 'x');

    const files = await buildManifestFiles(dir);
    expect(Object.keys(files)).toEqual(['a/b/c.txt']);
  });

  it('two byte-identical files hash the same (the basis for content addressing)', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'modoki-ota-test-'));
    writeFileSync(path.join(dir, 'one.js'), 'shared content');
    writeFileSync(path.join(dir, 'two.js'), 'shared content');

    const files = await buildManifestFiles(dir);
    expect(files['one.js'].hash).toBe(files['two.js'].hash);
  });

  it('returns an empty map for an empty directory', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'modoki-ota-test-'));
    const files = await buildManifestFiles(dir);
    expect(files).toEqual({});
  });
});
