/** Texture conversion tests — exact toktx flag vectors per format + the
 *  missing-CLI error. execFileSync is mocked so the CLI check is deterministic
 *  regardless of whether KTX-Software is installed on the test machine. */

import { describe, it, expect, vi } from 'vitest';

vi.mock('child_process', () => {
  const execFileSync = vi.fn(() => { throw new Error('command not found'); });
  return { execFileSync, default: { execFileSync } };
});

import { buildToktxArgs, ensureKtxCli, __resetKtxCheck } from '../../plugins/texture-convert';
import { DEFAULT_TEXTURE_SETTINGS } from '../../packages/modoki/src/runtime/loaders/textureSettings';

describe('buildToktxArgs', () => {
  it('UASTC: RDO + Zstd + mipmaps + sRGB, output before input', () => {
    const args = buildToktxArgs('uastc', DEFAULT_TEXTURE_SETTINGS, 'in.png', 'out.ktx2');
    expect(args).toContain('--t2');
    expect(args).toContain('--uastc');
    expect(args).toContain('--uastc_rdo_l');
    expect(args).toContain('--zcmp');
    expect(args).toContain('--genmipmap');
    expect(args[args.indexOf('--assign_oetf') + 1]).toBe('srgb');
    expect(args.slice(-2)).toEqual(['out.ktx2', 'in.png']);
  });

  it('ETC1S uses --bcmp, not --uastc', () => {
    const args = buildToktxArgs('etc1s', DEFAULT_TEXTURE_SETTINGS, 'i', 'o');
    expect(args).toContain('--bcmp');
    expect(args).not.toContain('--uastc');
  });

  it('native ASTC uses --encode astc with a 4x4 block', () => {
    const args = buildToktxArgs('astc', DEFAULT_TEXTURE_SETTINGS, 'i', 'o');
    expect(args).toContain('--encode');
    expect(args).toContain('astc');
    expect(args[args.indexOf('--astc_blk_d') + 1]).toBe('4x4');
  });

  it('linear colorspace assigns linear OETF', () => {
    const args = buildToktxArgs('uastc', { ...DEFAULT_TEXTURE_SETTINGS, colorspace: 'linear' }, 'i', 'o');
    expect(args[args.indexOf('--assign_oetf') + 1]).toBe('linear');
  });

  it('mipmaps off omits --genmipmap', () => {
    const args = buildToktxArgs('uastc', { ...DEFAULT_TEXTURE_SETTINGS, mipmaps: false }, 'i', 'o');
    expect(args).not.toContain('--genmipmap');
  });

  it('honors uastcLevel + uastcRdoLambda', () => {
    const args = buildToktxArgs('uastc', { ...DEFAULT_TEXTURE_SETTINGS, uastcLevel: 4, uastcRdoLambda: 2.5 }, 'i', 'o');
    expect(args[args.indexOf('--uastc') + 1]).toBe('4');
    expect(args[args.indexOf('--uastc_rdo_l') + 1]).toBe('2.5');
  });

  it('uastcRdoLambda 0 disables RDO (omits --uastc_rdo_l)', () => {
    const args = buildToktxArgs('uastc', { ...DEFAULT_TEXTURE_SETTINGS, uastcRdoLambda: 0 }, 'i', 'o');
    expect(args).not.toContain('--uastc_rdo_l');
    expect(args).toContain('--uastc'); // still UASTC-encoded
  });
});

describe('ensureKtxCli', () => {
  it('throws a clear install hint when the CLI is absent', () => {
    __resetKtxCheck();
    expect(() => ensureKtxCli()).toThrow(/KTX-Software/);
  });
});
