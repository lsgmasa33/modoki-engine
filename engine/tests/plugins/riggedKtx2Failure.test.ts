/** rigged-model-optimize (#1337) — a KTX2 encode that FAILS while toktx is present must not publish
 *  the raw-texture GLB under the with-toktx cache key, and a toktx-missing result must say so
 *  (`ktx2Skipped`) — on a fresh encode AND on a cache hit — so the build's strict gate can refuse it.
 *
 *  The gltf-transform CLI and the toktx probe are faked (a pass-through copy per CLI step); the
 *  in-process submesh merge runs for real on a generated GLB, and the cache publication is real. */
import fs from 'fs';
import path from 'path';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { makeTestGlb } from './fixtures/makeTestGlb';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';
import { readScannedSource } from '@modoki/engine/testing';

const fake = vi.hoisted(() => ({ toktxPresent: true, toktxDir: '', encodeFails: false, encodes: 0 }));

vi.mock('child_process', async (orig) => {
  const actual = await orig<typeof import('child_process')>();
  const fsm = await import('fs');
  return {
    ...actual,
    execFileSync: vi.fn((_cmd: string, args: string[]) => {
      if (args.includes('--version')) return Buffer.from('gt-fake 1.0.0');
      const [step, input, output] = args;
      if (step === 'uastc' || step === 'etc1s') {
        fake.encodes++;
        if (fake.encodeFails) throw Object.assign(new Error('toktx crashed'), { stderr: Buffer.from('toktx: crashed on texture 0') });
      }
      fsm.copyFileSync(input, output);
      return Buffer.alloc(0);
    }),
  };
});

vi.mock('../../toolchain', async (orig) => {
  const actual = await orig<typeof import('../../toolchain')>();
  return {
    ...actual,
    detect: vi.fn((id: string) => (id === 'toktx'
      ? { present: fake.toktxPresent, version: fake.toktxPresent ? '4.4.0' : undefined, dir: fake.toktxPresent ? fake.toktxDir : undefined }
      : actual.detect(id as never))),
    forgetDetection: vi.fn(),
    gltfTransformInvocation: vi.fn(() => ({ command: 'gltf-transform', prefixArgs: [] })),
    spawnable: vi.fn((command: string, args: string[]) => ({ command, args, shell: false })),
    withToolOnPath: vi.fn(() => process.env),
  };
});

const { convertRiggedModel, __resetRiggedCliChecks, riggedConversionFailure } = await import('../../plugins/rigged-model-optimize');
const { cacheDirFor, getModelCacheDir } = await import('../../plugins/model-cache');
const { DEFAULT_TEXTURE_SETTINGS } = await import('../../packages/modoki/src/runtime/loaders/textureSettings');

const SRC_URL = '/assets/models/rig.glb';
const settings = { ...DEFAULT_TEXTURE_SETTINGS, format: 'ktx2-uastc' as const };
let root: string;
let absSource: string;
let pinnedDir: string;

beforeAll(async () => {
  root = makeScratchDir('modoki-rigged-ktx2-');
  absSource = (await makeTestGlb({ dir: root, fileName: 'rig.glb', gridSegments: 2 })).glbPath;
  // The "pinned toktx" dir, with the `ktx` gltf-transform actually runs beside it (#1351).
  pinnedDir = path.join(root, 'pinned');
  fs.mkdirSync(pinnedDir);
  fs.writeFileSync(path.join(pinnedDir, process.platform === 'win32' ? 'ktx.exe' : 'ktx'), '');
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  fs.rmSync(getModelCacheDir(root), { recursive: true, force: true });
  __resetRiggedCliChecks();
  Object.assign(fake, { toktxPresent: true, toktxDir: pinnedDir, encodeFails: false, encodes: 0 });
});

const convert = () => convertRiggedModel({ projectRoot: root, sourceUrlPath: SRC_URL, absSource, settings });
/** Every entry the cache holds for this source — published hash dirs AND any staging leftovers. */
const cacheEntries = () => {
  const dir = path.dirname(cacheDirFor(getModelCacheDir(root), SRC_URL, 'x'));
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
};

describe('rigged KTX2 failure is never published (#1337)', () => {
  it('an encode that fails with toktx present throws and publishes nothing', async () => {
    fake.encodeFails = true;
    await expect(convert()).rejects.toThrow(/toktx: crashed/);
    expect(fake.encodes).toBe(1);
    expect(cacheEntries()).toEqual([]);

    // The next import with a working encoder must ENCODE, not hit a poisoned entry.
    fake.encodeFails = false;
    const ok = await convert();
    expect(ok.cached).toBe(false);
    expect(fake.encodes).toBe(2);
    expect(ok.ktx2Skipped).toBeUndefined();
  });

  it('toktx missing: publishes under its own key and reports ktx2Skipped, on the hit too', async () => {
    fake.toktxPresent = false;
    const first = await convert();
    expect(first.cached).toBe(false);
    expect(fake.encodes).toBe(0);
    expect(first.ktx2Skipped).toMatch(/toktx/);

    const hit = await convert();
    expect(hit.cached).toBe(true);
    expect(hit.hash).toBe(first.hash);
    expect(hit.ktx2Skipped).toMatch(/toktx/);
  });

  it('a successful encode reports nothing skipped, fresh or cached', async () => {
    const first = await convert();
    expect(first.ktx2Skipped).toBeUndefined();
    const hit = await convert();
    expect(hit.cached).toBe(true);
    expect(hit.ktx2Skipped).toBeUndefined();
  });

  it('toktx present but no ktx beside it: refuses before encoding, publishes nothing (#1351)', async () => {
    fake.toktxDir = path.join(root, 'no-ktx-here');
    await expect(convert()).rejects.toThrow(/`ktx` is not provisioned beside toktx/);
    expect(fake.encodes).toBe(0);
    expect(cacheEntries()).toEqual([]);
  });

  it('a textureless rig is not a skip — there was nothing to encode', async () => {
    fake.toktxPresent = false;
    const bare = (await makeTestGlb({ dir: root, fileName: 'bare-rig.glb', gridSegments: 2, withTexture: false })).glbPath;
    const r = await convertRiggedModel({ projectRoot: root, sourceUrlPath: '/assets/models/bare-rig.glb', absSource: bare, settings });
    expect(r.ktx2Skipped).toBeUndefined();
  });

  it('the build turns a skip into a strict-gate failure, and nothing else', () => {
    expect(riggedConversionFailure('/a.glb', { ktx2Skipped: 'toktx missing' }))
      .toEqual({ virtualPath: '/a.glb', kind: 'rigged model', error: 'KTX2 skipped — toktx missing' });
    expect(riggedConversionFailure('/a.glb', {})).toBeNull();
  });

  it('the production build actually pushes that failure — the scanner call site is the fix', () => {
    // The scanner's rigged branch is a Vite plugin hook with no seam a unit test can drive, so pin
    // the two lines by source: deleting the push keeps every behavioural test green (#1337 review).
    const scanner = readScannedSource(path.join(__dirname, '../../plugins/vite-asset-scanner.ts')).code;
    expect(scanner).toMatch(/const skipped = riggedConversionFailure\(virtualPath, conv\);\s*if \(skipped\) conversionFailures\.push\(skipped\);/);
  });

  it('a non-KTX2 format is not a skip', async () => {
    fake.toktxPresent = false;
    const r = await convertRiggedModel({ projectRoot: root, sourceUrlPath: SRC_URL, absSource, settings: { ...settings, format: 'webp' } });
    expect(r.ktx2Skipped).toBeUndefined();
  });
});
