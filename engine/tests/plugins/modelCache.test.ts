/** Model content-cache tests — hash key determinism + LOD path scheme. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  hashKey, cacheDirFor, processedCachePath, lodCachePath, cacheHit, pruneStaleCacheDirs,
} from '../../plugins/model-cache';
import { DEFAULT_MODEL_SETTINGS } from '../../packages/modoki/src/runtime/loaders/modelSettings';

describe('model-cache hashKey', () => {
  it('is deterministic for the same bytes + settings + loader + recipe', () => {
    const a = hashKey(Buffer.from('glb-bytes'), DEFAULT_MODEL_SETTINGS, 'island', 1);
    const b = hashKey(Buffer.from('glb-bytes'), DEFAULT_MODEL_SETTINGS, 'island', 1);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it('changes when source bytes change', () => {
    expect(hashKey(Buffer.from('abc'), DEFAULT_MODEL_SETTINGS, 'default', 0))
      .not.toBe(hashKey(Buffer.from('abd'), DEFAULT_MODEL_SETTINGS, 'default', 0));
  });

  it('changes when settings change', () => {
    expect(hashKey(Buffer.from('abc'), DEFAULT_MODEL_SETTINGS, 'default', 0))
      .not.toBe(hashKey(Buffer.from('abc'), { ...DEFAULT_MODEL_SETTINGS, lodCount: 2 }, 'default', 0));
  });

  it('changes when the loader id changes', () => {
    expect(hashKey(Buffer.from('x'), DEFAULT_MODEL_SETTINGS, 'default', 0))
      .not.toBe(hashKey(Buffer.from('x'), DEFAULT_MODEL_SETTINGS, 'island', 0));
  });

  it('changes when the recipe version is bumped', () => {
    expect(hashKey(Buffer.from('x'), DEFAULT_MODEL_SETTINGS, 'island', 1))
      .not.toBe(hashKey(Buffer.from('x'), DEFAULT_MODEL_SETTINGS, 'island', 2));
  });
});

describe('model-cache paths', () => {
  it('mirrors the url path under a per-hash dir', () => {
    // Normalize separators — filesystem paths (path.join), backslash-delimited on Windows.
    expect(cacheDirFor('/cache', '/games/g/island.glb', 'deadbeef').replace(/\\/g, '/'))
      .toBe('/cache/games/g/island.glb/deadbeef');
  });

  it('processed is LOD0', () => {
    expect(processedCachePath('/c', '/x.glb', 'h').replace(/\\/g, '/'))
      .toBe('/c/x.glb/h/processed.glb');
    expect(lodCachePath('/c', '/x.glb', 'h', 0).replace(/\\/g, '/'))
      .toBe('/c/x.glb/h/processed.glb');
  });

  it('lod1+ has level suffix', () => {
    // `[\\/]` accepts either separator (backslash on Windows).
    expect(lodCachePath('/c', '/x.glb', 'h', 1)).toMatch(/[\\/]lod1\.glb$/);
    expect(lodCachePath('/c', '/x.glb', 'h', 2)).toMatch(/[\\/]lod2\.glb$/);
  });
});

describe('cacheHit — file integrity validation', () => {
  // Real fs round-trip — a stub-fs mock would hide the very bug we're guarding
  // against (statSync + openSync + readSync working together).
  let tmpRoot: string;
  let cacheDir: string;
  const urlPath = '/games/g/foo.glb';
  const hash = 'abc1234567890123';
  // GLB header: "glTF" magic + 2.0 version + minimal length. The header is
  // 12 bytes; we don't need a parseable JSON chunk for the magic-only check.
  const glbHeader = Buffer.concat([
    Buffer.from('glTF', 'ascii'),
    Buffer.from([0x02, 0x00, 0x00, 0x00]), // version 2
    Buffer.from([0x0c, 0x00, 0x00, 0x00]), // total length (12)
  ]);

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-cache-hit-'));
    cacheDir = path.join(tmpRoot, 'cache');
    fs.mkdirSync(cacheDirFor(cacheDir, urlPath, hash), { recursive: true });
  });
  afterEach(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

  it('returns true when every LOD exists with a valid GLB magic header', () => {
    fs.writeFileSync(lodCachePath(cacheDir, urlPath, hash, 0), glbHeader);
    fs.writeFileSync(lodCachePath(cacheDir, urlPath, hash, 1), glbHeader);
    expect(cacheHit(cacheDir, urlPath, hash, 2)).toBe(true);
  });

  it('returns false when a LOD file is missing', () => {
    fs.writeFileSync(lodCachePath(cacheDir, urlPath, hash, 0), glbHeader);
    // LOD1 not written
    expect(cacheHit(cacheDir, urlPath, hash, 2)).toBe(false);
  });

  it('returns false when a LOD file is 0 bytes (crash mid-write)', () => {
    fs.writeFileSync(lodCachePath(cacheDir, urlPath, hash, 0), glbHeader);
    fs.writeFileSync(lodCachePath(cacheDir, urlPath, hash, 1), Buffer.alloc(0));
    expect(cacheHit(cacheDir, urlPath, hash, 2)).toBe(false);
  });

  it('returns false when a LOD file is too short to contain a GLB header', () => {
    fs.writeFileSync(lodCachePath(cacheDir, urlPath, hash, 0), Buffer.from('glT', 'ascii')); // 3 bytes
    expect(cacheHit(cacheDir, urlPath, hash, 1)).toBe(false);
  });

  it('returns false when a LOD file has wrong magic bytes (truncated header from partial write)', () => {
    // Right size, wrong magic — common after a `cp` of an unrelated file or
    // a partial write that landed something else in the header region.
    fs.writeFileSync(lodCachePath(cacheDir, urlPath, hash, 0), Buffer.alloc(64, 0));
    expect(cacheHit(cacheDir, urlPath, hash, 1)).toBe(false);
  });

  it('returns false when a LOD path is a directory (not a file)', () => {
    fs.mkdirSync(lodCachePath(cacheDir, urlPath, hash, 0));
    expect(cacheHit(cacheDir, urlPath, hash, 1)).toBe(false);
  });
});

describe('pruneStaleCacheDirs — bounds per-source cache growth', () => {
  let tmpRoot: string;
  let cacheDir: string;
  const urlPath = '/games/g/island.glb';
  const hex = (s: string) => s.padEnd(16, '0').slice(0, 16);
  const mkHashDir = (h: string) => {
    const d = cacheDirFor(cacheDir, urlPath, h);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'processed.glb'), 'GLB');
    return d;
  };

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-prune-'));
    cacheDir = path.join(tmpRoot, 'cache');
  });
  afterEach(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

  it('removes every sibling hash dir except the current one', () => {
    const current = hex('aaaa1111');
    mkHashDir(current);
    mkHashDir(hex('bbbb2222'));
    mkHashDir(hex('cccc3333'));
    const pruned = pruneStaleCacheDirs(cacheDir, urlPath, current);
    expect(pruned).toBe(2);
    expect(fs.existsSync(cacheDirFor(cacheDir, urlPath, current))).toBe(true);
    expect(fs.existsSync(cacheDirFor(cacheDir, urlPath, hex('bbbb2222')))).toBe(false);
    expect(fs.existsSync(cacheDirFor(cacheDir, urlPath, hex('cccc3333')))).toBe(false);
  });

  it('never touches non-hash siblings (e.g. a leftover .tmp staging dir)', () => {
    const current = hex('aaaa1111');
    mkHashDir(current);
    const parent = path.join(cacheDir, urlPath.replace(/^\/+/, ''));
    const staging = path.join(parent, `${hex('dddd4444')}.tmp-123-abc`);
    fs.mkdirSync(staging, { recursive: true });
    const pruned = pruneStaleCacheDirs(cacheDir, urlPath, current);
    expect(pruned).toBe(0);
    expect(fs.existsSync(staging)).toBe(true); // staging left for the converter's own cleanup
  });

  it('is a safe no-op when the source has no cache parent yet', () => {
    expect(pruneStaleCacheDirs(cacheDir, '/games/g/never-baked.glb', hex('aaaa1111'))).toBe(0);
  });
});
