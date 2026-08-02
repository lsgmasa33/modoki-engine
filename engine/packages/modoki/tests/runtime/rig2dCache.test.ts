/** rig2dCache — resolves `.rig2d.json` 2D skinning rigs by GUID/path, lazy-fetch on a
 *  cold miss, seedable for editor live-preview. Mirrors the spriteAnimCache tests: fetch
 *  is stubbed so a cold lookup is deterministic. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getRig2D, setRig2D, invalidateRig2D, clearRig2DCache, type Rig2DFile,
} from '../../src/runtime/loaders/rig2dCache';

const MINIMAL_RIG: Rig2DFile = {
  bones: [{ name: 'root', parent: -1, x: 0, y: 0, rot: 0 }],
  sprite: 'sp1',
  mesh: { verts: [[0, 0]], uvs: [[0, 0]], tris: [] },
  skinIndices: [0],
  skinWeights: [1],
};

beforeEach(() => {
  clearRig2DCache();
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no network in test'))));
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearRig2DCache();
});

describe('rig2dCache', () => {
  it('returns null for an empty ref', () => {
    expect(getRig2D('')).toBeNull();
  });

  it('returns null on a cold miss (not yet loaded) — caller retries next frame', () => {
    // Not a GUID → key is the path itself; nothing cached → null.
    expect(getRig2D('foo.rig2d.json')).toBeNull();
  });

  it('{load:false} PEEKS a cold miss without starting a fetch', () => {
    // The `read-asset-def` agent op's contract: report what is in the live cache right
    // now, never kick off a background load for a question it is about to refuse anyway.
    expect(getRig2D('peek.rig2d.json', { load: false })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('resolves a seeded rig', () => {
    setRig2D('a.rig2d.json', MINIMAL_RIG);
    const rig = getRig2D('a.rig2d.json');
    expect(rig).not.toBeNull();
    expect(rig!.bones[0].name).toBe('root');
    expect(rig!.sprite).toBe('sp1');
  });

  it('{load:false} returns the seeded rig too — a hit is a hit regardless of peek', () => {
    setRig2D('b.rig2d.json', MINIMAL_RIG);
    expect(getRig2D('b.rig2d.json', { load: false })).not.toBeNull();
  });

  it('invalidate drops the seeded entry (cold again → null)', () => {
    setRig2D('c.rig2d.json', MINIMAL_RIG);
    expect(getRig2D('c.rig2d.json')).not.toBeNull();
    invalidateRig2D('c.rig2d.json');
    expect(getRig2D('c.rig2d.json')).toBeNull();
  });
});
