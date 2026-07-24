/** Minimal ZIP writer for OTA bundle zips (docs/plans/mobile-ota-updates-plan.md, Phase 1).
 *  Cross-verified elsewhere against the system `unzip`/`zipinfo` CLI and a from-scratch
 *  Swift reader (OtaZip.swift) — see the plan doc. These tests cover structural
 *  correctness the way the repo's other unit tests do (no shelling out to `unzip` here,
 *  to keep the suite portable/fast); the cross-tool checks are a one-time verification,
 *  not something to run per-CI-invocation. */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildZip } from '../../../scripts/ota/zip.mjs';

describe('buildZip', () => {
  it('produces a zip the system unzip CLI accepts and extracts correctly', () => {
    const entries = [
      { path: 'index.html', data: Buffer.from('<html>hi</html>') },
      { path: 'assets/app.js', data: Buffer.from('console.log(1)'.repeat(50)) }, // compressible -> deflate
      { path: 'assets/tiny.txt', data: Buffer.from('x') }, // too small to benefit -> stored
      { path: 'empty.txt', data: Buffer.alloc(0) },
    ];
    const zip = buildZip(entries);

    const dir = mkdtempSync(path.join(tmpdir(), 'modoki-ota-zip-test-'));
    const zipPath = path.join(dir, 'test.zip');
    writeFileSync(zipPath, zip);
    try {
      const listing = execFileSync('unzip', ['-l', zipPath], { encoding: 'utf8' });
      expect(listing).toContain('index.html');
      expect(listing).toContain('assets/app.js');
      expect(listing).toContain('4 file'); // "4 files" summary line

      for (const entry of entries) {
        const extracted = execFileSync('unzip', ['-p', zipPath, entry.path]);
        expect(extracted.equals(entry.data)).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is deterministic for the same input', () => {
    const entries = [{ path: 'a.txt', data: Buffer.from('hello') }];
    expect(buildZip(entries).equals(buildZip(entries))).toBe(true);
  });

  it('produces different bytes when content differs', () => {
    const a = buildZip([{ path: 'a.txt', data: Buffer.from('hello') }]);
    const b = buildZip([{ path: 'a.txt', data: Buffer.from('world') }]);
    expect(a.equals(b)).toBe(false);
  });
});
