/** engine/plugins/backend/gcloud.ts — pure helpers shared by the Vite middleware and
 *  editorBackendRouter.ts for OTA Phase 5a publish/status/keygen. Both `resolveGcloudDir`
 *  and `deriveGcsBucketFromBaseUrl` are explicitly annotated "exported for unit testing"
 *  in their doc comments but had zero test coverage — this file closes that gap. The two
 *  safety regexes (OTA_SAFE_TOKEN / OTA_SAFE_BUCKET) guard shell-interpolated values
 *  (buildStepShell.ts), so a regression here is a shell-injection risk, not just a bug. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  resolveGcloudDir,
  deriveGcsBucketFromBaseUrl,
  OTA_SAFE_TOKEN,
  OTA_SAFE_BUCKET,
  isGcsObjectMissing,
  withGcloudOnPath,
  execGcloudSync,
} from '../../plugins/backend/gcloud';
import { prependPathEntry, withPathEntry } from '../../toolchain';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

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
    tmpDir = makeScratchDir('modoki-gcloud-test-');
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

  // #1444: on Windows the CLI is `gcloud.cmd`, and Browse… (pathMode 'file') picks exactly that
  // file — which the name check used to refuse, so a picked binary was never resolved.
  it('accepts a bin dir holding only gcloud.cmd, and the gcloud.cmd binary itself (any case)', () => {
    fs.writeFileSync(path.join(tmpDir, 'gcloud.cmd'), '@echo off\r\n');
    expect(resolveGcloudDir(tmpDir)).toBe(tmpDir);
    expect(resolveGcloudDir(path.join(tmpDir, 'gcloud.cmd'))).toBe(tmpDir);
    const upper = path.join(tmpDir, 'GCLOUD.CMD');
    fs.renameSync(path.join(tmpDir, 'gcloud.cmd'), upper);
    expect(resolveGcloudDir(upper)).toBe(tmpDir);
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

describe('isGcsObjectMissing — "nothing published" vs "could not look"', () => {
  // /api/ota/status used to swallow EVERY gcloud failure and answer
  // {ok:true, release:null, note:'No release.json published yet'}. An agent then believes a fact
  // about PRODUCTION and acts on it — re-publishing, or telling the human the rollout never
  // landed. Only a genuinely absent object is an empty answer (conventions §5).
  it('recognises the absent-object messages gcloud actually emits', () => {
    for (const stderr of [
      'ERROR: (gcloud.storage.cat) The following URLs matched no objects or files: gs://b/release.json',
      'ERROR: (gcloud.storage.cat) NOT_FOUND: The specified key does not exist.',
      'ERROR: (gcloud.storage.cat) HTTPError 404: No such object: b/release.json',
    ]) expect(isGcsObjectMissing(stderr), stderr).toBe(true);
  });

  it('does NOT mistake a could-not-look failure for an empty bucket', () => {
    for (const stderr of [
      'ERROR: (gcloud.storage.cat) You do not currently have an active account selected.',
      'ERROR: (gcloud.storage.cat) Reauthentication required. Please run: gcloud auth login',
      'ERROR: (gcloud.storage.cat) HTTPError 403: does not have storage.objects.get access',
      'ERROR: (gcloud.storage.cat) Unable to connect to the server. Check your network.',
      // The one that caught a real bug in the predicate: a broad /not found/ matched this, i.e.
      // gcloud is not INSTALLED — reported as a confident statement about production.
      'gcloud: command not found',
      '',
    ]) expect(isGcsObjectMissing(stderr), stderr).toBe(false);
  });

  it('is wrong only in the SAFE direction — an unrecognised failure is never "nothing there"', () => {
    // The predicate is deliberately specific rather than broad: a message it does not recognise
    // must fall through to "could not look", because that error is recoverable and a false
    // "nothing is published" is not.
    expect(isGcsObjectMissing('ERROR: something nobody has seen before')).toBe(false);
  });
});

// #1444: the three gcloud PATH prepends were hand-written with a literal `:`. On win32 that glues
// the gcloud dir onto the first entry — one bogus entry — so gcloud is never found AND the old
// first entry is lost.
describe('gcloud on PATH — platform delimiter', () => {
  it('prependPathEntry uses ; on win32 and : elsewhere', () => {
    expect(prependPathEntry('C:/sdk/bin', 'C:\\Windows;C:\\Tools', 'win32')).toBe('C:/sdk/bin;C:\\Windows;C:\\Tools');
    expect(prependPathEntry('/sdk/bin', '/usr/bin:/bin', 'darwin')).toBe('/sdk/bin:/usr/bin:/bin');
    expect(prependPathEntry('/sdk/bin', undefined, 'linux')).toBe('/sdk/bin:');
  });

  it('withGcloudOnPath puts the dir first as its OWN entry and keeps the rest', () => {
    const env = withGcloudOnPath({ PATH: ['/a', '/b'].join(path.delimiter), KEEP: '1' }, '/gc');
    expect(env.PATH!.split(path.delimiter)).toEqual(['/gc', '/a', '/b']);
    expect(env.KEEP).toBe('1');
  });

  // #1444 close-out, observed: an editor launched from Explorer/PowerShell spreads process.env into
  // an object keyed `Path`. Reading `.PATH` off that copy is undefined, and writing `PATH` beside
  // `Path` leaves the child with the prepended dir ALONE — `'node' is not recognized`.
  it('withPathEntry reads a win32 `Path` key and leaves ONE PATH key holding everything', () => {
    const env = withPathEntry<NodeJS.ProcessEnv>({ Path:'C:\\Windows;C:\\Tools', KEEP: '1' }, 'C:/gc', 'win32');
    expect(Object.keys(env).filter((k) => k.toUpperCase() === 'PATH')).toEqual(['PATH']);
    expect(env.PATH).toBe('C:/gc;C:\\Windows;C:\\Tools');
    expect(env.KEEP).toBe('1');
  });

  it('withPathEntry leaves a differently-cased name alone on POSIX, where it is a different variable', () => {
    const env = withPathEntry({ PATH: '/usr/bin', Path: 'other' }, '/gc', 'linux');
    expect(env).toEqual({ PATH: '/gc:/usr/bin', Path: 'other' });
  });
});

// Real spawn, no mocks: a fake gcloud on a scratch PATH echoes its args. On win32 it is a
// `gcloud.cmd`, which a bare `execFileSync('gcloud')` can neither find (no PATHEXT without a
// shell) nor run (EINVAL without shell:true — CVE-2024-27980). docs/windows.md § PATHEXT.
describe('execGcloudSync', () => {
  let dir: string;
  beforeEach(() => { dir = makeScratchDir('modoki-gcloud-exec-'); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  // The env is shaped like production's: a COPY of process.env, keyed `Path` on win32 as it is in an
  // editor launched from Explorer/PowerShell (a Git Bash parent says `PATH`, which hides the bug).
  // The fake prints each argv slot separately, so an unquoted `with space.json` split in two by
  // cmd.exe fails, and it proves the system PATH survived by finding a system tool.
  it('runs the gcloud found on env.PATH with argv intact and the system PATH kept', () => {
    const win = process.platform === 'win32';
    if (win) {
      fs.writeFileSync(path.join(dir, 'gcloud.cmd'),
        '@echo off\r\necho [%1][%2][%~3]\r\nwhere /q where.exe && echo SYSTEM-PATH-KEPT\r\n');
    } else {
      fs.writeFileSync(path.join(dir, 'gcloud'),
        '#!/bin/sh\nprintf \'[%s]\' "$@"; echo\ncommand -v ls >/dev/null && echo SYSTEM-PATH-KEPT\n', { mode: 0o755 });
    }
    const copy: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== 'PATH'));
    copy[win ? 'Path' : 'PATH'] = process.env.PATH;
    const env = withGcloudOnPath(copy, dir);
    const out = String(execGcloudSync(['storage', 'cat', 'gs://b/with space.json'], { env, encoding: 'utf8' }));
    expect(out).toContain('[storage][cat][gs://b/with space.json]');
    expect(out).toContain('SYSTEM-PATH-KEPT');
  });
});
