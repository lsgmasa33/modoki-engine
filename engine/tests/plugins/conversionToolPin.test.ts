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
import { hasOssOverlay } from '../helpers/repoLayout';
import {
  resetToolchainCache, detect, ffmpegToolBin, ffprobeToolBin, conversionToolchainDir, NPM_BINARY_PINS,
} from '../../toolchain';
import { defaultToolchainDir } from '../../scripts/toolchainHome.mjs';
import { ensureFfmpeg, ensureFfprobe, withFfprobe } from '../../plugins/ffmpeg-tool';
import { AUDIO_ENCODER_VERSION } from '../../plugins/audio-cache';
import { VIDEO_ENCODER_VERSION } from '../../plugins/video-cache';
import { conversionCliBin, conversionCliDir, CONVERSION_CLI_PINS, isPinnedConversionTool } from '../../toolchain';
import { ensureKtxCli } from '../../plugins/texture-convert';
import { ensureMsdfAtlasGen } from '../../plugins/font-convert';
import { __probeRiggedToktx, __resetRiggedCliChecks } from '../../plugins/rigged-model-optimize';
import { ENCODER_VERSION as TEXTURE_ENCODER_VERSION } from '../../plugins/texture-cache';
import { ATLAS_ENCODER_VERSION } from '../../plugins/atlas-cache';
import { FONT_ENCODER_VERSION } from '../../plugins/font-cache';

const ENV_KEYS = [
  'PATH', 'HOME', 'XDG_CONFIG_HOME', 'APPDATA',
  'MODOKI_TOOLCHAIN_DIR', 'MODOKI_ALLOW_SYSTEM_TOOLCHAIN', 'MODOKI_FFMPEG', 'MODOKI_FFPROBE',
  'MODOKI_TOKTX', 'MODOKI_MSDF_ATLAS_GEN',
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

/** The same three routes for the NATIVE conversion CLIs (#1327): KTX2 textures and atlases go
 *  through `ensureKtxCli` (rigged GLBs through `detect('toktx')`, the same registry entry), MTSDF
 *  fonts through `ensureMsdfAtlasGen`. Before #1327 both resolved `MODOKI_* || <bare name>`, so a
 *  PATH build did the converting whenever no override was set — every dev machine. */
describe.skipIf(process.platform === 'win32')('toktx and msdf-atlas-gen are pinned (#1327)', () => {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
  let sandbox: string;
  const TOOLS = [
    { id: 'toktx', ensure: ensureKtxCli, env: 'MODOKI_TOKTX' },
    { id: 'msdf-atlas-gen', ensure: ensureMsdfAtlasGen, env: 'MODOKI_MSDF_ATLAS_GEN' },
  ] as const;

  /** A pinned copy where `install()` leaves one: `<toolchain>/<id>/<version>/<id>`. */
  const provisionNative = (tc: string, id: 'toktx' | 'msdf-atlas-gen') => stub(conversionCliBin(tc, id), `${id} pinned`);

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    sandbox = makeScratchDir('modoki-nativepin-');
    for (const k of ['HOME', 'XDG_CONFIG_HOME', 'APPDATA'] as const) process.env[k] = sandbox;
    const pathDir = path.join(sandbox, 'bin');
    stub(path.join(pathDir, 'toktx'), 'toktx v4.1.0 (the PATH build)');
    stub(path.join(pathDir, 'msdf-atlas-gen'), 'MSDF-Atlas-Gen v1.3.0 (the PATH build)');
    process.env.PATH = `${pathDir}${path.delimiter}/usr/bin${path.delimiter}/bin`;
    for (const k of ['MODOKI_TOOLCHAIN_DIR', 'MODOKI_ALLOW_SYSTEM_TOOLCHAIN', 'MODOKI_TOKTX', 'MODOKI_MSDF_ATLAS_GEN'] as const) {
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
  });

  for (const t of TOOLS) {
    it(`${t.id}: nothing provisioned REFUSES the PATH build, with the install command`, () => {
      expect(() => t.ensure()).toThrow(new RegExp(`${t.id} is not provisioned[\\s\\S]*toolchain:install -- toktx msdf-atlas-gen`));
      expect(detect(t.id).present).toBe(false); // the rigged-GLB route asks detect() directly
    });

    it(`${t.id}: the machine default's pinned copy is used with no toolchain dir set`, () => {
      const pinned = provisionNative(defaultToolchainDir(), t.id);
      expect(t.ensure()).toBe(pinned);
      expect(detect(t.id)).toMatchObject({ present: true, command: pinned, source: 'probe' });
    });

    it(`${t.id}: "Use system-installed SDKs" does not reopen PATH`, () => {
      process.env.MODOKI_TOOLCHAIN_DIR = path.join(sandbox, 'empty-tc');
      process.env.MODOKI_ALLOW_SYSTEM_TOOLCHAIN = '1';
      expect(() => t.ensure()).toThrow(/is not provisioned/);
    });

    it(`${t.id}: the bundled/explicit ${t.env} wins — the packaged editor's route`, () => {
      provisionNative(defaultToolchainDir(), t.id);
      const bundled = stub(path.join(sandbox, 'Resources', 'bin', t.id), `${t.id} bundled`);
      process.env[t.env] = bundled;
      expect(t.ensure()).toBe(bundled);
    });

    it(`${t.id}: a copy from ANOTHER pin version is not a candidate`, () => {
      const other = path.join(path.dirname(conversionCliDir(defaultToolchainDir(), t.id)), '0.0.1', t.id);
      stub(other, `${t.id} old pin`);
      expect(() => t.ensure()).toThrow(/is not provisioned/);
    });

    it(`${t.id}: installs into the conversion dir even in a plain dev editor`, () => {
      expect(isPinnedConversionTool(t.id)).toBe(true);
    });
  }

  it('the rigged-GLB probe does not cache a miss — a toktx installed mid-session is picked up', () => {
    __resetRiggedCliChecks();
    expect(__probeRiggedToktx()).toBe(false); // the PATH decoy is not taken
    provisionNative(defaultToolchainDir(), 'toktx'); // installed by "the other process"
    expect(__probeRiggedToktx()).toBe(true);
    __resetRiggedCliChecks();
  });

  it("the rigged probe's FIRST answer is fresh even when another caller left a miss in the shared cache", () => {
    __resetRiggedCliChecks();
    expect(() => ensureKtxCli()).toThrow(/not provisioned/); // leaves a miss cached, as a failed conversion does
    provisionNative(defaultToolchainDir(), 'toktx');
    expect(__probeRiggedToktx()).toBe(true);
    __resetRiggedCliChecks();
  });

  it('the predicate is not a blanket yes — a PATH-resolved SDK tool is not pinned', () => {
    expect(isPinnedConversionTool('gltfpack')).toBe(false);
    expect(isPinnedConversionTool('java')).toBe(false);
    expect(isPinnedConversionTool('not-a-tool')).toBe(false);
  });
});

/** The native pins and their encoder tags move together, for the reason the ffmpeg table above
 *  gives: a cache hit returns before the CLI is resolved, so only a tag bump evicts an entry an
 *  older build converted. The first row is every conversion before #1327 (whatever each machine
 *  had); the tags it used may never come back. */
const NATIVE_PIN_GENERATIONS: ReadonlyArray<{ toktx: string; msdf: string; tex: string; atlas: string; font: string }> = [
  { toktx: 'unpinned', msdf: 'unpinned', tex: 'tex-2', atlas: 'atlas-1', font: 'font-5' },
  { toktx: '4.4.2', msdf: '1.4', tex: 'tex-3', atlas: 'atlas-2', font: 'font-6' },
];

describe('the native pins and the texture/atlas/font tags move together (#1327)', () => {
  it('the current pins have a row, and its tags are the ones in force', () => {
    const row = NATIVE_PIN_GENERATIONS.find((r) =>
      r.toktx === CONVERSION_CLI_PINS.toktx.version && r.msdf === CONVERSION_CLI_PINS['msdf-atlas-gen'].version);
    expect(row, 'CONVERSION_CLI_PINS changed: add a NATIVE_PIN_GENERATIONS row and bump the tex-/atlas-/font- tags').toBeDefined();
    expect({ tex: TEXTURE_ENCODER_VERSION, atlas: ATLAS_ENCODER_VERSION, font: FONT_ENCODER_VERSION })
      .toEqual({ tex: row!.tex, atlas: row!.atlas, font: row!.font });
  });

  it('no two generations share a tag', () => {
    for (const k of ['tex', 'atlas', 'font'] as const) {
      expect(new Set(NATIVE_PIN_GENERATIONS.map((r) => r[k])).size, k).toBe(NATIVE_PIN_GENERATIONS.length);
    }
  });
});

/** The release workflows carry what a runner needs BEFORE any of this code runs, so they are held
 *  to the pin table here. Windows downloads the upstream assets itself (hashes restated); macOS
 *  provisions through `toolchain:install` and must not fall back to the unpinned installs. */
// Gated on the overlay: the public snapshot ships `oss/.github/` AS its `.github/`, and no `oss/`.
describe.skipIf(!hasOssOverlay())('the release workflows agree with the pin table (#1327)', () => {
  const repo = path.resolve(__dirname, '../../..');
  const read = (rel: string) => fs.readFileSync(path.join(repo, rel), 'utf8');
  const shellVar = (src: string, name: string) => src.match(new RegExp(`^\\s*${name}=(\\S+)\\s*$`, 'm'))?.[1];

  it('release-windows.yml downloads exactly the pinned win32-x64 assets', () => {
    const win = read('oss/.github/workflows/release-windows.yml');
    const toktx = CONVERSION_CLI_PINS.toktx.dist['win32-x64'];
    const msdf = CONVERSION_CLI_PINS['msdf-atlas-gen'].dist['win32-x64'];
    expect({ ver: shellVar(win, 'KTX_VER'), sha: shellVar(win, 'KTX_SHA') })
      .toEqual({ ver: CONVERSION_CLI_PINS.toktx.version, sha: toktx.sha256 });
    expect({ ver: shellVar(win, 'MSDF_VER'), sha: shellVar(win, 'MSDF_SHA') })
      .toEqual({ ver: CONVERSION_CLI_PINS['msdf-atlas-gen'].version, sha: msdf.sha256 });
    // The URLs the workflow assembles are the pin's, not merely the same version.
    expect(toktx.url).toContain(`v${shellVar(win, 'KTX_VER')}/KTX-Software-`);
    expect(msdf.url).toContain(`v${shellVar(win, 'MSDF_VER')}/msdf-atlas-gen-`);
  });

  for (const rel of ['.github/workflows/release.yml', 'oss/.github/workflows/release.yml']) {
    it(`${rel} provisions the pinned pair and never installs an unpinned one`, () => {
      const mac = read(rel);
      expect(mac).toMatch(/^\s*run: npm run toolchain:install -- toktx msdf-atlas-gen\s*$/m);
      expect(mac).not.toMatch(/brew install msdf-atlas-gen/);
      expect(mac).not.toMatch(/installer -pkg/);
    });
  }
});
