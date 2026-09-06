/** #293 — makeTexture2D is the "Make 2D" fix action: it flips a texture's type to
 *  2D and re-imports it so the asset scanner mints the whole-image sprite. Writing
 *  `type: '2d'` into the meta alone would not do that — the sprite is minted by the
 *  re-import, so these tests pin that the action does BOTH, in order, and bails
 *  cleanly when either step fails. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/editor/backend/editorBackend', () => ({ backendFetch: vi.fn() }));
vi.mock('../../src/editor/panels/assetViews/widgets', () => ({ writeMetaOrWarn: vi.fn() }));
vi.mock('../../src/runtime/loaders/textureResolver', () => ({ invalidateTexture: vi.fn() }));

import { backendFetch } from '../../src/editor/backend/editorBackend';
import { writeMetaOrWarn } from '../../src/editor/panels/assetViews/widgets';
import { invalidateTexture } from '../../src/runtime/loaders/textureResolver';
import { makeTexture2D, textureRefCount } from '../../src/editor/panels/makeTexture2D';
import { deriveSettingsForType } from '../../src/runtime/loaders/textureSettings';

const mockedBackendFetch = vi.mocked(backendFetch);
const mockedWriteMetaOrWarn = vi.mocked(writeMetaOrWarn);
const mockedInvalidateTexture = vi.mocked(invalidateTexture);

const jsonRes = (body: unknown, ok = true) => ({ ok, json: () => Promise.resolve(body) } as Response);

beforeEach(() => {
  mockedBackendFetch.mockReset();
  mockedWriteMetaOrWarn.mockReset();
  mockedInvalidateTexture.mockReset();
});

describe('makeTexture2D', () => {
  it('reads meta, writes it typed 2D, re-imports, invalidates, and returns true', async () => {
    mockedBackendFetch.mockImplementation((path: string, ..._init: unknown[]) => {
      if (path.startsWith('/api/read-meta')) return Promise.resolve(jsonRes({ id: 'g', textureCache: { a: 1 } }));
      if (path === '/api/reimport') return Promise.resolve(jsonRes({}));
      throw new Error(`unexpected fetch: ${path}`);
    });
    mockedWriteMetaOrWarn.mockResolvedValue(true);

    const ok = await makeTexture2D('/assets/rock.png');

    expect(ok).toBe(true);
    // No `version` in the payload: `writeMetaSidecar` stamps the sidecar's format
    // version server-side (#734), so a client-side writer must not supply one.
    expect(mockedWriteMetaOrWarn).toHaveBeenCalledWith('/assets/rock.png', {
      id: 'g',
      textureCache: { a: 1 },
      type: '2d',
      texture: deriveSettingsForType('2d'),
    });
    const reimportCall = mockedBackendFetch.mock.calls.find((c) => c[0] === '/api/reimport')!;
    expect(JSON.parse((reimportCall[1] as RequestInit).body as string)).toEqual({ path: '/assets/rock.png' });
    expect(mockedInvalidateTexture).toHaveBeenCalledWith('/assets/rock.png');
  });

  // ⚠️ THIS TEST USED TO ASSERT THE OPPOSITE, and the behaviour it blessed destroyed data.
  // `/api/write-meta` overwrites the sidecar WHOLESALE, so continuing from a failed read
  // (which fell back to `{}`) wrote a sidecar with no `id` — and the scanner's heal pass
  // then MINTED A NEW GUID, orphaning every scene/prefab ref to the texture. The old test
  // only checked that `type:'2d'` was written, so it passed while the asset lost its
  // identity. A failed read must abort before touching the disk.
  it('ABORTS without writing when read-meta fails — a wholesale overwrite would discard the GUID', async () => {
    mockedBackendFetch.mockImplementation((path: string, ..._init: unknown[]) => {
      if (path.startsWith('/api/read-meta')) return Promise.resolve(jsonRes({ error: 'boom' }, false));
      throw new Error(`unexpected fetch: ${path}`);
    });
    mockedWriteMetaOrWarn.mockResolvedValue(true);

    const ok = await makeTexture2D('/assets/rock.png');

    expect(ok).toBe(false);
    expect(mockedWriteMetaOrWarn).not.toHaveBeenCalled();
    expect(mockedInvalidateTexture).not.toHaveBeenCalled();
  });

  it('ABORTS when read-meta succeeds but the body is not an object', async () => {
    mockedBackendFetch.mockImplementation((path: string, ..._init: unknown[]) => {
      if (path.startsWith('/api/read-meta')) return Promise.resolve(jsonRes([1, 2, 3] as unknown as Record<string, unknown>));
      throw new Error(`unexpected fetch: ${path}`);
    });
    mockedWriteMetaOrWarn.mockResolvedValue(true);

    expect(await makeTexture2D('/assets/rock.png')).toBe(false);
    expect(mockedWriteMetaOrWarn).not.toHaveBeenCalled();
  });

  it('preserves the GUID and the sliced/cache blocks it does not own', async () => {
    mockedBackendFetch.mockImplementation((path: string, ..._init: unknown[]) => {
      if (path.startsWith('/api/read-meta')) return Promise.resolve(jsonRes({
        id: 'aaaaaaaabbbbccccddddeeeeeeeeeeee', textureCache: { hash: 'h1', variants: ['uastc'] },
        sprites: [{ guid: 'g1', name: 'slice' }], border: { l: 2, r: 2, t: 2, b: 2 },
      }));
      if (path === '/api/reimport') return Promise.resolve(jsonRes({}));
      throw new Error(`unexpected fetch: ${path}`);
    });
    mockedWriteMetaOrWarn.mockResolvedValue(true);

    expect(await makeTexture2D('/assets/rock.png')).toBe(true);
    const written = mockedWriteMetaOrWarn.mock.calls[0][1] as Record<string, unknown>;
    expect(written.id).toBe('aaaaaaaabbbbccccddddeeeeeeeeeeee');
    expect(written.textureCache).toEqual({ hash: 'h1', variants: ['uastc'] });
    expect(written.sprites).toEqual([{ guid: 'g1', name: 'slice' }]);
    expect(written.border).toEqual({ l: 2, r: 2, t: 2, b: 2 });
  });

  // The type decides format/mipmaps/wrap; everything else in the block is authored intent
  // that 2d-vs-3d says nothing about. Resetting it wholesale (what `changeType` does in the
  // Inspector) would force a normal map's `colorspace:'linear'` back to `'srgb'` — gamma-
  // decoded data, i.e. wrong lighting, with no error anywhere.
  it('carries authored settings that are not derived from the type, and drops the four that are', async () => {
    mockedBackendFetch.mockImplementation((path: string, ..._init: unknown[]) => {
      if (path.startsWith('/api/read-meta')) return Promise.resolve(jsonRes({
        id: 'aaaaaaaabbbbccccddddeeeeeeeeeeee',
        texture: {
          format: 'ktx2-astc', mipmaps: true, wrapS: 'repeat', wrapT: 'repeat',
          colorspace: 'linear', flipGreen: true, maxSize: 1024, uastcLevel: 4,
        },
      }));
      if (path === '/api/reimport') return Promise.resolve(jsonRes({}));
      throw new Error(`unexpected fetch: ${path}`);
    });
    mockedWriteMetaOrWarn.mockResolvedValue(true);

    expect(await makeTexture2D('/assets/rock_normal.png')).toBe(true);
    const tex = (mockedWriteMetaOrWarn.mock.calls[0][1] as { texture: Record<string, unknown> }).texture;
    // carried
    expect(tex.colorspace).toBe('linear');
    expect(tex.flipGreen).toBe(true);
    expect(tex.maxSize).toBe(1024);
    expect(tex.uastcLevel).toBe(4);
    // type-derived — the four the '2d' type owns
    expect(tex.mipmaps).toBe(false);
    expect(tex.wrapS).toBe('clamp');
    expect(tex.wrapT).toBe('clamp');
    expect(tex.format).toBe('ktx2-uastc');
  });

  it('returns false and never re-imports when writeMetaOrWarn resolves false', async () => {
    mockedBackendFetch.mockImplementation((path: string, ..._init: unknown[]) => {
      if (path.startsWith('/api/read-meta')) return Promise.resolve(jsonRes({}));
      throw new Error(`unexpected fetch: ${path}`);
    });
    mockedWriteMetaOrWarn.mockResolvedValue(false);

    const ok = await makeTexture2D('/assets/rock.png');

    expect(ok).toBe(false);
    expect(mockedBackendFetch).not.toHaveBeenCalledWith('/api/reimport', expect.anything());
    expect(mockedInvalidateTexture).not.toHaveBeenCalled();
  });

  it('returns false and does not invalidate when reimport reports errors', async () => {
    mockedBackendFetch.mockImplementation((path: string, ..._init: unknown[]) => {
      if (path.startsWith('/api/read-meta')) return Promise.resolve(jsonRes({}));
      if (path === '/api/reimport') return Promise.resolve(jsonRes({ errors: ['boom'] }));
      throw new Error(`unexpected fetch: ${path}`);
    });
    mockedWriteMetaOrWarn.mockResolvedValue(true);

    const ok = await makeTexture2D('/assets/rock.png');

    expect(ok).toBe(false);
    expect(mockedInvalidateTexture).not.toHaveBeenCalled();
  });
});

describe('textureRefCount', () => {
  beforeEach(() => { mockedBackendFetch.mockReset(); });

  it('returns the reverse-reference total for the target', async () => {
    mockedBackendFetch.mockResolvedValue(jsonRes({ totalCount: 4, unreferenced: false }));
    expect(await textureRefCount('aaaaaaaabbbbccccddddeeeeeeeeeeee')).toBe(4);
  });

  it('returns 0 for a genuinely unreferenced texture', async () => {
    mockedBackendFetch.mockResolvedValue(jsonRes({ totalCount: 0, unreferenced: true }));
    expect(await textureRefCount('aaaaaaaabbbbccccddddeeeeeeeeeeee')).toBe(0);
  });

  // `null` must stay distinct from `0`. "unused" is what makes a user click through a
  // destructive confirm, and a failed lookup must never be able to say it.
  it('returns null — NOT 0 — when the lookup fails, errors, or returns a malformed body', async () => {
    mockedBackendFetch.mockResolvedValue(jsonRes({ error: 'nope' }, false));
    expect(await textureRefCount('t')).toBeNull();

    mockedBackendFetch.mockResolvedValue(jsonRes({ error: 'nope' }));
    expect(await textureRefCount('t')).toBeNull();

    mockedBackendFetch.mockResolvedValue(jsonRes({ notTheField: 3 }));
    expect(await textureRefCount('t')).toBeNull();

    mockedBackendFetch.mockRejectedValue(new Error('network down'));
    expect(await textureRefCount('t')).toBeNull();
  });
});
