/** engine/scripts/ota/buildStamp.mjs — the build stamp that records which source tree built an
 *  OTA-publishable dist, and the publish decision taken from it (#906). The git reads run against a
 *  real throwaway repository, because what they must get right is git's own answer. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import path from 'node:path';
import {
  BUILD_STAMP_FILENAME, otaBuildProvenance, readGitProvenance, readHeadCommit, settleBuildStamp, writeBuildStamp,
} from '../../../scripts/ota/buildStamp.mjs';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

const SHA = 'f'.repeat(40);

describe('otaBuildProvenance (the publish decision)', () => {
  const stamp = (value: unknown) => JSON.stringify(value);

  it('publishes a known clean commit unforced', () => {
    expect(otaBuildProvenance({ stampText: stamp({ commit: SHA, dirty: false }), allowUnclean: false }))
      .toEqual({ build: { commit: SHA, dirty: false, forced: false } });
  });

  it('refuses every stamp that is not provably clean, each with its own reason', () => {
    const cases: [string | null, string][] = [
      [null, 'no-stamp'],
      ['{not json', 'bad-stamp'],
      [stamp([]), 'bad-stamp'],
      [stamp({ commit: 'abc', dirty: false }), 'bad-stamp'],
      [stamp({ commit: SHA, dirty: 'no' }), 'bad-stamp'],
      [stamp({ commit: SHA }), 'bad-stamp'],
      [stamp({ commit: null, dirty: null }), 'unknown-tree'],
      [stamp({ commit: SHA, dirty: null }), 'unknown-tree'],
      [stamp({ commit: SHA, dirty: true }), 'dirty'],
    ];
    for (const [stampText, refusal] of cases) {
      expect(otaBuildProvenance({ stampText, allowUnclean: false }), String(stampText)).toEqual({ refusal });
    }
  });

  it('with the override, publishes each of those forced — recording what the stamp did establish', () => {
    expect(otaBuildProvenance({ stampText: stamp({ commit: SHA, dirty: true }), allowUnclean: true }))
      .toEqual({ build: { commit: SHA, dirty: true, forced: true } });
    expect(otaBuildProvenance({ stampText: stamp({ commit: SHA, dirty: null }), allowUnclean: true }))
      .toEqual({ build: { commit: SHA, dirty: null, forced: true } });
    expect(otaBuildProvenance({ stampText: null, allowUnclean: true }))
      .toEqual({ build: { commit: null, dirty: null, forced: true } });
    // A malformed stamp establishes nothing, so it must not leak its bad values into the manifest.
    expect(otaBuildProvenance({ stampText: stamp({ commit: 'abc', dirty: 'yes' }), allowUnclean: true }))
      .toEqual({ build: { commit: null, dirty: null, forced: true } });
  });

  it('the override on a clean build overrides nothing, so it is not recorded as forced', () => {
    expect(otaBuildProvenance({ stampText: stamp({ commit: SHA, dirty: false }), allowUnclean: true }))
      .toEqual({ build: { commit: SHA, dirty: false, forced: false } });
  });
});

describe('settleBuildStamp (start reading + HEAD at the end)', () => {
  it('keeps the start reading when HEAD did not move', () => {
    expect(settleBuildStamp({ commit: SHA, dirty: false }, SHA)).toEqual({ commit: SHA, dirty: false });
    expect(settleBuildStamp({ commit: SHA, dirty: true }, SHA)).toEqual({ commit: SHA, dirty: true });
    expect(settleBuildStamp({ commit: SHA, dirty: null }, SHA)).toEqual({ commit: SHA, dirty: null });
  });

  it('a HEAD that moved during the build makes it dirty, even from a clean start', () => {
    expect(settleBuildStamp({ commit: SHA, dirty: false }, 'e'.repeat(40))).toEqual({ commit: SHA, dirty: true });
    expect(settleBuildStamp({ commit: SHA, dirty: false }, null)).toEqual({ commit: SHA, dirty: true });
  });

  it('an unknown start commit stays wholly unknown', () => {
    expect(settleBuildStamp({ commit: null, dirty: null }, SHA)).toEqual({ commit: null, dirty: null });
  });
});

describe('readGitProvenance against a real repository', () => {
  let dir: string;
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

  beforeEach(() => {
    dir = makeScratchDir('modoki-build-stamp-');
    git('init', '-q');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'test');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(path.join(dir, 'tracked.txt'), 'one');
    writeFileSync(path.join(dir, '.gitignore'), 'dist/\n');
    git('add', 'tracked.txt', '.gitignore');
    git('commit', '-q', '-m', 'init');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a committed tree is its HEAD and clean', () => {
    expect(readGitProvenance(dir)).toEqual({ commit: git('rev-parse', 'HEAD'), dirty: false });
    expect(readHeadCommit(dir)).toBe(git('rev-parse', 'HEAD'));
  });

  it('a modified tracked file is dirty', () => {
    writeFileSync(path.join(dir, 'tracked.txt'), 'two');
    expect(readGitProvenance(dir).dirty).toBe(true);
  });

  it('an untracked file is dirty — it can reach the bundle as easily as a modified one', () => {
    writeFileSync(path.join(dir, 'new-source.ts'), 'export {}');
    expect(readGitProvenance(dir).dirty).toBe(true);
  });

  it('an ignored file (the dist the build writes) is not dirt', () => {
    mkdirSync(path.join(dir, 'dist'), { recursive: true });
    writeFileSync(path.join(dir, 'dist', 'index.html'), '<html>');
    expect(readGitProvenance(dir).dirty).toBe(false);
  });

  it('edits under a native ios/ or android/ folder are not dirt — a native build rewrites them itself', () => {
    for (const rel of ['games/g/ios/App/Contents.json', 'games/g/android/app/res/icon.png', 'engine/packages/p/ios/Plugin.swift']) {
      mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      writeFileSync(path.join(dir, rel), 'x');
    }
    expect(readGitProvenance(dir).dirty).toBe(false);
  });

  it('the native exclusion is exact: a web source beside it still counts, and so does a folder merely NAMED like one', () => {
    mkdirSync(path.join(dir, 'games', 'g', 'ios'), { recursive: true });
    writeFileSync(path.join(dir, 'games', 'g', 'ios', 'x.txt'), 'x');
    writeFileSync(path.join(dir, 'games', 'g', 'game.ts'), 'export {}');
    expect(readGitProvenance(dir).dirty).toBe(true);
    rmSync(path.join(dir, 'games', 'g', 'game.ts'));
    mkdirSync(path.join(dir, 'games', 'g', 'iosish'), { recursive: true });
    writeFileSync(path.join(dir, 'games', 'g', 'iosish', 'y.ts'), 'export {}');
    expect(readGitProvenance(dir).dirty).toBe(true);
  });

  it('dirt is repo-wide even when asked from a subfolder — :(top) does not narrow to it', () => {
    const sub = path.join(dir, 'games', 'g');
    mkdirSync(sub, { recursive: true });
    writeFileSync(path.join(sub, '.keep'), '');
    git('add', 'games/g/.keep');
    git('commit', '-q', '-m', 'sub');
    writeFileSync(path.join(dir, 'tracked.txt'), 'changed outside the subfolder');
    expect(readGitProvenance(sub).dirty).toBe(true);
  });

  it('a directory that is not in a repository is unknown, never clean', () => {
    const outside = makeScratchDir('modoki-build-stamp-nogit-');
    try {
      expect(readGitProvenance(outside)).toEqual({ commit: null, dirty: null });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('writeBuildStamp writes exactly what otaBuildProvenance reads back', () => {
    const dist = path.join(dir, 'dist');
    mkdirSync(dist, { recursive: true });
    const start = readGitProvenance(dir);
    writeBuildStamp(dist, settleBuildStamp(start, readHeadCommit(dir)));
    const stampText = readFileSync(path.join(dist, BUILD_STAMP_FILENAME), 'utf8');
    expect(otaBuildProvenance({ stampText, allowUnclean: false })).toEqual({ build: { commit: start.commit, dirty: false, forced: false } });
  });
});
