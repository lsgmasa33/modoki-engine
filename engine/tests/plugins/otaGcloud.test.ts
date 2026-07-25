/** engine/plugins/backend/gcloud.ts — pure helpers shared by the Vite middleware and
 *  editorBackendRouter.ts for OTA Phase 5a publish/status/keygen. Both `resolveGcloudDir`
 *  and `deriveGcsBucketFromBaseUrl` are explicitly annotated "exported for unit testing"
 *  in their doc comments but had zero test coverage — this file closes that gap. The two
 *  safety regexes (OTA_SAFE_TOKEN / OTA_SAFE_BUCKET) guard shell-interpolated values
 *  (buildStepShell.ts), so a regression here is a shell-injection risk, not just a bug. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  resolveGcloudDir,
  deriveGcsBucketFromBaseUrl,
  OTA_SAFE_TOKEN,
  OTA_SAFE_BUCKET,
} from '../../plugins/backend/gcloud';

describe('deriveGcsBucketFromBaseUrl', () => {
  it('derives gs:// from a plain storage.googleapis.com URL', () => {
    expect(deriveGcsBucketFromBaseUrl('https://storage.googleapis.com/modoki-ota'))
      .toBe('gs://modoki-ota');
  });

  it('preserves a path prefix after the bucket name', () => {
    expect(deriveGcsBucketFromBaseUrl('https://storage.googleapis.com/modoki-ota/sling'))
      .toBe('gs://modoki-ota/sling');
  });

  it('strips a trailing slash', () => {
    expect(deriveGcsBucketFromBaseUrl('https://storage.googleapis.com/modoki-ota/'))
      .toBe('gs://modoki-ota');
  });

  it('strips query/hash before deriving', () => {
    expect(deriveGcsBucketFromBaseUrl('https://storage.googleapis.com/modoki-ota?x=1#y'))
      .toBe('gs://modoki-ota');
  });

  it('returns null for a custom CDN domain fronting the bucket (cannot be reverse-derived)', () => {
    expect(deriveGcsBucketFromBaseUrl('https://cdn.example.com/ota')).toBeNull();
  });

  it('returns null for a non-https URL', () => {
    expect(deriveGcsBucketFromBaseUrl('http://storage.googleapis.com/modoki-ota')).toBeNull();
  });

  it('returns null for a storage.googleapis.com URL with no bucket path', () => {
    // No trailing path segment at all — the regex requires at least one non-slash char.
    expect(deriveGcsBucketFromBaseUrl('https://storage.googleapis.com')).toBeNull();
  });
});

describe('OTA_SAFE_TOKEN', () => {
  it('accepts a normal version/bundle/key name', () => {
    for (const ok of ['v18', 'shell', 'sling', 'default', 'my-key_2.0']) {
      expect(OTA_SAFE_TOKEN.test(ok)).toBe(true);
    }
  });

  it('rejects shell metacharacters that would escape a bash -c interpolation', () => {
    for (const bad of ['v18; rm -rf /', '$(whoami)', '`id`', 'a b', 'a"b', "a'b", 'a|b', 'a&b', 'a\nb']) {
      expect(OTA_SAFE_TOKEN.test(bad)).toBe(false);
    }
  });

  it('rejects an empty string and an over-length token', () => {
    expect(OTA_SAFE_TOKEN.test('')).toBe(false);
    expect(OTA_SAFE_TOKEN.test('a'.repeat(65))).toBe(false);
    expect(OTA_SAFE_TOKEN.test('a'.repeat(64))).toBe(true);
  });
});

describe('OTA_SAFE_BUCKET', () => {
  it('accepts a bare gs:// bucket and a gs:// bucket with a prefix path', () => {
    expect(OTA_SAFE_BUCKET.test('gs://modoki-ota')).toBe(true);
    expect(OTA_SAFE_BUCKET.test('gs://modoki-ota/sling/v2')).toBe(true);
  });

  it('rejects shell metacharacters embedded in the bucket string', () => {
    for (const bad of ['gs://modoki-ota; rm -rf /', 'gs://modoki-ota`id`', 'gs://modoki-ota $(id)', 'gs://modoki ota']) {
      expect(OTA_SAFE_BUCKET.test(bad)).toBe(false);
    }
  });

  it('rejects a non-gs:// URL', () => {
    expect(OTA_SAFE_BUCKET.test('https://storage.googleapis.com/modoki-ota')).toBe(false);
    expect(OTA_SAFE_BUCKET.test('s3://modoki-ota')).toBe(false);
  });
});

describe('resolveGcloudDir', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-gcloud-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('accepts an override that is already the bin directory containing gcloud', () => {
    fs.writeFileSync(path.join(tmpDir, 'gcloud'), '#!/bin/sh\n');
    expect(resolveGcloudDir(tmpDir)).toBe(tmpDir);
  });

  it('accepts an override that IS the gcloud binary itself, returning its parent dir', () => {
    const binPath = path.join(tmpDir, 'gcloud');
    fs.writeFileSync(binPath, '#!/bin/sh\n');
    expect(resolveGcloudDir(binPath)).toBe(tmpDir);
  });

  it('falls through to auto-discovery when the override path does not contain gcloud', () => {
    // An override pointing at an empty dir with no `gcloud` binary must not be trusted
    // blindly — it should fall back to the normal probing, not silently return a dir
    // that doesn't actually have the CLI in it.
    const result = resolveGcloudDir(tmpDir);
    expect(result).not.toBe(tmpDir);
  });

  it('returns null on win32 regardless of override (web deploy steps are posix-only)', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      expect(resolveGcloudDir()).toBeNull();
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });
});
