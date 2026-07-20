/** meta-sidecar — atomic JSON sidecar writes (tmp + rename). */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readMetaSidecar, writeMetaSidecar } from '../../plugins/meta-sidecar';

let tmpRoot: string;
let absPath: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-meta-'));
  absPath = path.join(tmpRoot, 'asset.glb');
});
afterEach(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

describe('readMetaSidecar', () => {
  it('returns {} when the sidecar does not exist', () => {
    expect(readMetaSidecar(absPath)).toEqual({});
  });

  it('returns {} when the sidecar contains malformed JSON (caller never sees a throw)', () => {
    fs.writeFileSync(absPath + '.meta.json', '{ "id": "broken');
    expect(readMetaSidecar(absPath)).toEqual({});
  });

  it('parses a well-formed sidecar', () => {
    fs.writeFileSync(absPath + '.meta.json', JSON.stringify({ id: 'x', version: 2 }));
    expect(readMetaSidecar(absPath)).toEqual({ id: 'x', version: 2 });
  });
});

describe('writeMetaSidecar — atomic write', () => {
  it('persists the JSON contents at <absPath>.meta.json', () => {
    writeMetaSidecar(absPath, { id: 'guid-1', version: 2 });
    const raw = fs.readFileSync(absPath + '.meta.json', 'utf-8');
    expect(JSON.parse(raw)).toEqual({ id: 'guid-1', version: 2 });
  });

  it('replaces an existing sidecar (no stale data)', () => {
    fs.writeFileSync(absPath + '.meta.json', JSON.stringify({ id: 'old', version: 1 }));
    writeMetaSidecar(absPath, { id: 'new', version: 2 });
    expect(readMetaSidecar(absPath)).toEqual({ id: 'new', version: 2 });
  });

  it('does not leave the .tmp file on disk after a successful write', () => {
    writeMetaSidecar(absPath, { id: 'x' });
    expect(fs.existsSync(absPath + '.meta.json')).toBe(true);
    expect(fs.existsSync(absPath + '.meta.json.tmp')).toBe(false);
  });

  it('preserves the prior sidecar if the write throws (rename is atomic)', () => {
    // Seed an existing sidecar that must survive a failed write.
    const existing = { id: 'survivor', version: 2 };
    fs.writeFileSync(absPath + '.meta.json', JSON.stringify(existing));

    // Force a write failure by passing a non-serializable value (circular ref).
    const bad: Record<string, unknown> = {};
    bad.self = bad;
    expect(() => writeMetaSidecar(absPath, bad)).toThrow();

    // Original sidecar is untouched — atomic guarantee.
    expect(readMetaSidecar(absPath)).toEqual(existing);
  });

  it('round-trips correctly (write then read returns the same shape)', () => {
    const meta = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      version: 2,
      texture: { format: 'ktx2-uastc', maxSize: 1024 },
      generated: { meshes: ['/m/a.mesh.json'] },
    };
    writeMetaSidecar(absPath, meta);
    expect(readMetaSidecar(absPath)).toEqual(meta);
  });
});

describe('writeMetaSidecar — committed / machine-local byte-stat split', () => {
  const metaWithStats = () => ({
    id: 'g', version: 2,
    modelCache: { hash: 'h1', lodPaths: ['/a.processed.glb'], lodDistances: [0], triCounts: [150775], lodBytes: [3628528] },
    textureCache: { hash: 'h2', variants: ['uastc'], width: 512, height: 512, variantBytes: { uastc: 223651 } },
    fontCache: { hash: 'h3', atlasWidth: 2048, glyphCount: 95, bytes: 627701 },
  });

  it('keeps structural fields committed but peels byte-stats into <asset>.meta.local.json', () => {
    writeMetaSidecar(absPath, metaWithStats());
    const committed = JSON.parse(fs.readFileSync(absPath + '.meta.json', 'utf-8'));
    // hash + structural fields stay in the committed sidecar…
    expect(committed.modelCache.hash).toBe('h1');
    expect(committed.modelCache.lodDistances).toEqual([0]);
    expect(committed.textureCache.variants).toEqual(['uastc']);
    expect(committed.fontCache.glyphCount).toBe(95);
    // …byte-size stats do NOT.
    expect(committed.modelCache).not.toHaveProperty('lodBytes');
    expect(committed.modelCache).not.toHaveProperty('triCounts');
    expect(committed.textureCache).not.toHaveProperty('variantBytes');
    expect(committed.fontCache).not.toHaveProperty('bytes');
    // The stats live in the gitignored local sidecar.
    const local = JSON.parse(fs.readFileSync(absPath + '.meta.local.json', 'utf-8'));
    expect(local).toEqual({
      modelCache: { triCounts: [150775], lodBytes: [3628528] },
      textureCache: { variantBytes: { uastc: 223651 } },
      fontCache: { bytes: 627701 },
    });
  });

  it('readMetaSidecar merges the local byte-stats back (inspector sees live sizes)', () => {
    const meta = metaWithStats();
    writeMetaSidecar(absPath, meta);
    expect(readMetaSidecar(absPath)).toEqual(meta);
  });

  it('local byte-stats WIN over a stale committed value', () => {
    // Simulate a sidecar committed on another host (bytes=627701) + this host's local stat.
    fs.writeFileSync(absPath + '.meta.json', JSON.stringify({ id: 'g', fontCache: { hash: 'h3', bytes: 627701 } }));
    fs.writeFileSync(absPath + '.meta.local.json', JSON.stringify({ fontCache: { bytes: 623901 } }));
    expect((readMetaSidecar(absPath).fontCache as { bytes: number }).bytes).toBe(623901);
  });

  it('drops a stale local sidecar when the new write has no byte-stats', () => {
    writeMetaSidecar(absPath, metaWithStats());
    expect(fs.existsSync(absPath + '.meta.local.json')).toBe(true);
    writeMetaSidecar(absPath, { id: 'g', version: 2 }); // settings-only, no cache blocks
    expect(fs.existsSync(absPath + '.meta.local.json')).toBe(false);
  });
});
