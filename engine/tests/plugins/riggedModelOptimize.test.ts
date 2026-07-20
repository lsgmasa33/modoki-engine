/** rigged-model-optimize — pure-helper coverage: KTX2 command mapping, cache-key
 *  invalidation (flags + tool versions + toktx presence — C2/C3), and the GLB
 *  extensionsUsed parser that guards KHR_texture_basisu survival (C1). No real CLI
 *  is invoked. */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ktxCommandFor, ktxFlags, riggedHash, glbExtensionsUsed, meshoptDroppedBasisu } from '../../plugins/rigged-model-optimize';
import type { TextureImportSettings } from '../../packages/modoki/src/runtime/loaders/textureSettings';

const baseSettings = (over: Partial<TextureImportSettings> = {}): TextureImportSettings => ({
  format: 'ktx2-uastc', maxSize: 2048, mipmaps: true,
  wrapS: 'repeat', wrapT: 'repeat', colorspace: 'srgb',
  ...over,
} as TextureImportSettings);

const TOOLS = { gltfTransform: '4.0.0', toktx: '4.3.0' };
const SRC = Buffer.from('GLB-SOURCE-BYTES');

describe('ktxCommandFor', () => {
  it('maps formats to the gltf-transform KTX2 command (astc→uastc, none for webp/png)', () => {
    expect(ktxCommandFor('ktx2-etc1s')).toBe('etc1s');
    expect(ktxCommandFor('ktx2-uastc')).toBe('uastc');
    expect(ktxCommandFor('ktx2-astc')).toBe('uastc'); // no embedded-GLB ASTC; transcodes anyway
    expect(ktxCommandFor('webp')).toBeNull();
    expect(ktxCommandFor('png')).toBeNull();
  });
});

describe('ktxFlags — reconciled UASTC knobs (shared with the texture converter)', () => {
  it('uastc default uses the shared RDO-lambda 1.0 (reconciled from the former hardcoded 4)', () => {
    const f = ktxFlags('uastc', baseSettings());
    expect(f[f.indexOf('--level') + 1]).toBe('2');
    expect(f[f.indexOf('--rdo-lambda') + 1]).toBe('1'); // was hardcoded '4'
    expect(f).toContain('--rdo');
    expect(f[f.indexOf('--zstd') + 1]).toBe('18');
  });

  it('honors uastcLevel + uastcRdoLambda from settings', () => {
    const f = ktxFlags('uastc', baseSettings({ uastcLevel: 4, uastcRdoLambda: 3 }));
    expect(f[f.indexOf('--level') + 1]).toBe('4');
    expect(f[f.indexOf('--rdo-lambda') + 1]).toBe('3');
  });

  it('uastcRdoLambda 0 disables RDO (omits --rdo/--rdo-lambda)', () => {
    const f = ktxFlags('uastc', baseSettings({ uastcRdoLambda: 0 }));
    expect(f).not.toContain('--rdo');
    expect(f).not.toContain('--rdo-lambda');
    expect(f).toContain('--level'); // still UASTC-encoded
  });

  it('etc1s ignores the uastc knobs (quality 255)', () => {
    const f = ktxFlags('etc1s', baseSettings({ uastcLevel: 4 }));
    expect(f[f.indexOf('--quality') + 1]).toBe('255');
    expect(f).not.toContain('--level');
  });
});

describe('riggedHash invalidation', () => {
  it('changes when the UASTC knobs change for a uastc format; inert for etc1s', () => {
    const base = riggedHash(SRC, baseSettings(), TOOLS);
    expect(base).not.toBe(riggedHash(SRC, baseSettings({ uastcLevel: 4 }), TOOLS));
    expect(base).not.toBe(riggedHash(SRC, baseSettings({ uastcRdoLambda: 3 }), TOOLS));
    // For an ETC1S format the uastc knobs don't feed the flags → hash unchanged.
    const etc = riggedHash(SRC, baseSettings({ format: 'ktx2-etc1s' }), TOOLS);
    expect(etc).toBe(riggedHash(SRC, baseSettings({ format: 'ktx2-etc1s', uastcLevel: 4 }), TOOLS));
    // Raw (png/webp) has no KTX2 signature at all → a stale uastcRdoLambda can't thrash it.
    const png = riggedHash(SRC, baseSettings({ format: 'png' }), TOOLS);
    expect(png).toBe(riggedHash(SRC, baseSettings({ format: 'png', uastcRdoLambda: 3 }), TOOLS));
  });

  it('is stable for identical source + settings + tools', () => {
    expect(riggedHash(SRC, baseSettings(), TOOLS)).toBe(riggedHash(SRC, baseSettings(), TOOLS));
  });

  it('changes when source bytes change', () => {
    expect(riggedHash(SRC, baseSettings(), TOOLS)).not.toBe(riggedHash(Buffer.from('OTHER'), baseSettings(), TOOLS));
  });

  it('changes when texture settings change (maxSize / format / mipmaps)', () => {
    const h = riggedHash(SRC, baseSettings(), TOOLS);
    expect(h).not.toBe(riggedHash(SRC, baseSettings({ maxSize: 1024 }), TOOLS));
    expect(h).not.toBe(riggedHash(SRC, baseSettings({ format: 'ktx2-etc1s' }), TOOLS));
    expect(h).not.toBe(riggedHash(SRC, baseSettings({ mipmaps: false }), TOOLS));
  });

  it('changes when the gltf-transform tool version changes (C2)', () => {
    expect(riggedHash(SRC, baseSettings(), TOOLS))
      .not.toBe(riggedHash(SRC, baseSettings(), { ...TOOLS, gltfTransform: '5.0.0' }));
  });

  it('changes when the toktx version changes for a KTX2 format (C2)', () => {
    expect(riggedHash(SRC, baseSettings(), TOOLS))
      .not.toBe(riggedHash(SRC, baseSettings(), { ...TOOLS, toktx: '4.4.0' }));
  });

  it('toktx absent vs present yields different keys for a KTX2 format (C3 — no cross-machine poisoning)', () => {
    const present = riggedHash(SRC, baseSettings(), { ...TOOLS, toktx: '4.3.0' });
    const absent = riggedHash(SRC, baseSettings(), { ...TOOLS, toktx: '' });
    expect(present).not.toBe(absent);
  });

  it('toktx version is IRRELEVANT for a non-KTX2 format (webp uses toktx:n/a)', () => {
    const a = riggedHash(SRC, baseSettings({ format: 'webp' }), { ...TOOLS, toktx: '4.3.0' });
    const b = riggedHash(SRC, baseSettings({ format: 'webp' }), { ...TOOLS, toktx: '' });
    expect(a).toBe(b);
  });
});

describe('glbExtensionsUsed (C1 guard)', () => {
  /** Build a minimal binary GLB whose JSON chunk has the given glTF object. */
  function writeGlb(gltf: object): string {
    const json = Buffer.from(JSON.stringify(gltf), 'utf8');
    const pad = (4 - (json.length % 4)) % 4;
    const jsonChunk = Buffer.concat([json, Buffer.alloc(pad, 0x20)]);
    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x46546c67, 0); // 'glTF'
    header.writeUInt32LE(2, 4); // version
    header.writeUInt32LE(12 + 8 + jsonChunk.length, 8); // total length
    const chunkHeader = Buffer.alloc(8);
    chunkHeader.writeUInt32LE(jsonChunk.length, 0);
    chunkHeader.writeUInt32LE(0x4e4f534a, 4); // 'JSON'
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-glb-')), 'm.glb');
    fs.writeFileSync(p, Buffer.concat([header, chunkHeader, jsonChunk]));
    return p;
  }

  it('returns the extensionsUsed array', () => {
    const p = writeGlb({ asset: { version: '2.0' }, extensionsUsed: ['KHR_texture_basisu', 'EXT_meshopt_compression'] });
    expect(glbExtensionsUsed(p)).toContain('KHR_texture_basisu');
    expect(glbExtensionsUsed(p)).toContain('EXT_meshopt_compression');
  });

  it('returns [] when no extensions declared (so the C1 guard fires)', () => {
    const p = writeGlb({ asset: { version: '2.0' } });
    expect(glbExtensionsUsed(p)).toEqual([]);
  });

  it('returns [] for a non-GLB file', () => {
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-glb-')), 'x.bin');
    fs.writeFileSync(p, Buffer.from('not a glb at all'));
    expect(glbExtensionsUsed(p)).toEqual([]);
  });
});

describe('meshoptDroppedBasisu (graceful-degradation decision)', () => {
  it('fires only when basisu was present before meshopt AND the output lost it', () => {
    // The failure the fallback recovers from: meshopt stripped basisu post-KTX2.
    expect(meshoptDroppedBasisu(true, ['EXT_meshopt_compression'])).toBe(true);
  });

  it('does not fire when meshopt preserved basisu', () => {
    expect(meshoptDroppedBasisu(true, ['KHR_texture_basisu', 'EXT_meshopt_compression'])).toBe(false);
  });

  it('does not fire when there was no basisu before meshopt (raw OR textureless rig)', () => {
    // toktx missing / webp|png format → no KTX2; OR a textureless rig where the
    // KTX2 command ran but encoded nothing → no basisu to "drop". Both → false,
    // so the C1 guard never fires spuriously (the skinned-test cylinder regression).
    expect(meshoptDroppedBasisu(false, ['EXT_meshopt_compression'])).toBe(false);
    expect(meshoptDroppedBasisu(false, [])).toBe(false);
  });
});
