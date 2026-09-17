/** Asset conversion runs ONLY the pinned, provisioned ffmpeg/ffprobe (#1297).
 *
 *  The defect: the conversion cache key names no binary, and three separate routes let a PATH
 *  ffmpeg do the converting — `resolveTool`'s own bare-name fallback, `detect()` offering PATH
 *  whenever `MODOKI_TOOLCHAIN_DIR` is unset (every `npm run build` / `vite` / vitest process), and
 *  the "Use system-installed SDKs" toggle. Two builds produced different bytes under one hash (4 of
 *  26 wordweave clips, Homebrew 8.1.1 vs ffmpeg-static 6.0). Each route has its own test below,
 *  because deleting any one guard reopens the leak on its own.
 *
 *  Every case puts a WRONG ffmpeg on PATH, so "it found a binary" is never mistaken for "it found
 *  the pinned one". The machine default dir is sandboxed through HOME / XDG_CONFIG_HOME / APPDATA
 *  (the inputs `appSupportRoot` reads on each platform), so the real provisioned copy on a dev box
 *  can neither satisfy nor break a case.
 *
 *  Skipped on Windows: the fakes are `#!/bin/sh` scripts, and ffmpeg-static's payload is a real
 *  `.exe` spawned without a shell. The `.exe` path logic is covered in toolchainResolve.test.ts. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';
import {
  resetToolchainCache, detect, ffmpegToolBin, ffprobeToolBin, conversionToolchainDir, NPM_BINARY_PINS,
} from '../../toolchain';
import { defaultToolchainDir } from '../../scripts/toolchainHome.mjs';
import { ensureFfmpeg, ensureFfprobe, withFfprobe } from '../../plugins/ffmpeg-tool';
import { AUDIO_ENCODER_VERSION } from '../../plugins/audio-cache';
import { VIDEO_ENCODER_VERSION } from '../../plugins/video-cache';

const ENV_KEYS = [
  'PATH', 'HOME', 'XDG_CONFIG_HOME', 'APPDATA',
  'MODOKI_TOOLCHAIN_DIR', 'MODOKI_ALLOW_SYSTEM_TOOLCHAIN', 'MODOKI_FFMPEG', 'MODOKI_FFPROBE',
] as const;

function stub(file: string, versionLine: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\necho "${versionLine}"\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

/** A provisioned copy as `install()` leaves it: the payload binary plus the package.json whose
 *  version the stale check reads. */
function provision(tc: string, id: 'ffmpeg' | 'ffprobe', pkgVersion: string = NPM_BINARY_PINS[id].version): string {
  const bin = id === 'ffmpeg' ? ffmpegToolBin(tc) : ffprobeToolBin(tc);
  stub(bin, `${id} version pinned`);
  const pkgJson = path.join(tc, 'npm-tools', 'node_modules', NPM_BINARY_PINS[id].pkg, 'package.json');
  fs.mkdirSync(path.dirname(pkgJson), { recursive: true });
  fs.writeFileSync(pkgJson, JSON.stringify({ name: NPM_BINARY_PINS[id].pkg, version: pkgVersion }));
  return bin;
}

describe.skipIf(process.platform === 'win32')('conversion CLIs are pinned (#1297)', () => {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
  let sandbox: string;
  let wrongFfmpeg: string;

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    sandbox = makeScratchDir('modoki-convpin-');
    for (const k of ['HOME', 'XDG_CONFIG_HOME', 'APPDATA'] as const) process.env[k] = sandbox;
    const pathDir = path.join(sandbox, 'bin');
    wrongFfmpeg = stub(path.join(pathDir, 'ffmpeg'), 'ffmpeg version 8.1.1 (the PATH build)');
    stub(path.join(pathDir, 'ffprobe'), 'ffprobe version 8.1.1 (the PATH build)');
    process.env.PATH = `${pathDir}${path.delimiter}/usr/bin${path.delimiter}/bin`;
    for (const k of ['MODOKI_TOOLCHAIN_DIR', 'MODOKI_ALLOW_SYSTEM_TOOLCHAIN', 'MODOKI_FFMPEG', 'MODOKI_FFPROBE'] as const) {
      delete process.env[k];
    }
    resetToolchainCache();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(sandbox, { recursive: true, force: true });
    resetToolchainCache();
    vi.restoreAllMocks();
  });

  it('the sandbox moved the machine default (else every case below reads the real one)', () => {
    expect(defaultToolchainDir().startsWith(sandbox)).toBe(true);
    expect(conversionToolchainDir()).toBe(defaultToolchainDir());
  });

  it('no toolchain dir set and nothing provisioned: REFUSES the PATH ffmpeg rather than using it', () => {
    // The `npm run build` case. Before #1297 detect() offered PATH here (system tools are allowed
    // when MODOKI_TOOLCHAIN_DIR is unset) and resolveTool fell back to the bare name besides.
    expect(() => ensureFfmpeg()).toThrow(/ffmpeg is not provisioned[\s\S]*toolchain:install/);
    expect(detect('ffmpeg').present).toBe(false);
  });

  it('no toolchain dir set, but the machine default holds a provisioned copy: that copy is used', () => {
    const pinned = provision(defaultToolchainDir(), 'ffmpeg');
    expect(ensureFfmpeg()).toBe(pinned);
    expect(ensureFfmpeg()).not.toBe(wrongFfmpeg);
  });

  it('"Use system-installed SDKs" does not reopen PATH for a conversion CLI', () => {
    process.env.MODOKI_TOOLCHAIN_DIR = path.join(sandbox, 'empty-tc');
    process.env.MODOKI_ALLOW_SYSTEM_TOOLCHAIN = '1';
    expect(() => ensureFfmpeg()).toThrow(/ffmpeg is not provisioned/);
    expect(() => ensureFfprobe()).toThrow(/ffprobe is not provisioned/);
  });

  it('an explicit MODOKI_FFMPEG override wins over the provisioned copy — a deliberate act', () => {
    provision(defaultToolchainDir(), 'ffmpeg');
    const chosen = stub(path.join(sandbox, 'chosen', 'ffmpeg'), 'ffmpeg version 7.0');
    process.env.MODOKI_FFMPEG = chosen;
    expect(ensureFfmpeg()).toBe(chosen);
  });

  it('a provisioned copy that is not the pinned npm version is refused, not used', () => {
    provision(defaultToolchainDir(), 'ffmpeg', '5.2.0');
    expect(() => ensureFfmpeg()).toThrow(/not the pinned ffmpeg-static@5\.3\.0/);
  });

  it('a copy installed AFTER a miss is found without a restart (the install may run in another process)', () => {
    expect(() => ensureFfmpeg()).toThrow(/not provisioned/);
    // Installed by "the other process": nothing here calls resetToolchainCache().
    const pinned = provision(defaultToolchainDir(), 'ffmpeg');
    expect(ensureFfmpeg()).toBe(pinned);
  });

  it('a missing ffprobe yields no stats and warns once — it does not throw (owner, #1300) and does not use PATH', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const probe = vi.fn(() => ({ durationSec: 1 }));
    expect(withFfprobe(probe)).toEqual({});
    expect(withFfprobe(probe)).toEqual({});
    expect(probe).not.toHaveBeenCalled();
    const ours = warn.mock.calls.filter((c) => String(c[0]).includes('no stats probe'));
    expect(ours).toHaveLength(1);
  });

  it('with the pinned ffprobe provisioned, the probe runs against THAT binary', () => {
    const pinned = provision(defaultToolchainDir(), 'ffprobe');
    const probe = vi.fn((cli: string) => ({ cli }));
    expect(withFfprobe(probe)).toEqual({ cli: pinned });
  });

  it('a probe that throws on one file yields no stats rather than failing the conversion', () => {
    provision(defaultToolchainDir(), 'ffprobe');
    expect(withFfprobe(() => { throw new Error('moov atom not found'); })).toEqual({});
  });
});

/** The encoder tags are the ONLY thing that evicts a converted file when the pinned build changes:
 *  the cache key names no binary, and a cache hit returns before ffmpeg is even resolved. So a pin
 *  bump without a tag bump reopens #1297 on every warm cache (review finding on #1297's close-out).
 *
 *  Each row is one pin generation and the tags that were current for it. Bumping a pin makes the
 *  lookup miss → add a row, with NEW tags, and bump the constants to match. Reusing a previous row's
 *  tag fails the distinctness check. A tag bump WITHOUT a pin change (new ffmpeg arguments) edits
 *  the current row's tag instead. Runs on every platform: it reads constants, spawns nothing. */
const PIN_GENERATIONS: ReadonlyArray<{ ffmpeg: string; ffprobe: string; audio: string; video: string }> = [
  { ffmpeg: '5.3.0', ffprobe: '2.1.2', audio: 'aud-3', video: 'vid-2' },
];

describe('the pin and the encoder tags move together (#1297)', () => {
  it('the current pin has a row, and its tags are the ones in force', () => {
    const row = PIN_GENERATIONS.find((r) => r.ffmpeg === NPM_BINARY_PINS.ffmpeg.version && r.ffprobe === NPM_BINARY_PINS.ffprobe.version);
    expect(row, 'NPM_BINARY_PINS changed: add a PIN_GENERATIONS row and bump AUDIO_/VIDEO_ENCODER_VERSION to NEW tags').toBeDefined();
    expect({ audio: AUDIO_ENCODER_VERSION, video: VIDEO_ENCODER_VERSION }).toEqual({ audio: row!.audio, video: row!.video });
  });

  it('no two pin generations share an encoder tag', () => {
    expect(new Set(PIN_GENERATIONS.map((r) => r.audio)).size).toBe(PIN_GENERATIONS.length);
    expect(new Set(PIN_GENERATIONS.map((r) => r.video)).size).toBe(PIN_GENERATIONS.length);
  });
});
