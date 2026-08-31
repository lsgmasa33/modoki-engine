/** rig2dCache — resolves `.rig2d.json` 2D skinning rigs by GUID/path, lazy-fetch on a
 *  cold miss, seedable for editor live-preview. Mirrors the spriteAnimCache tests: fetch
 *  is stubbed so a cold lookup is deterministic. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getRig2D, getRig2DSource, setRig2D, invalidateRig2D, clearRig2DCache, type Rig2DFile,
} from '../../src/runtime/loaders/rig2dCache';
import { clearManifest, newGuid } from '../../src/runtime/loaders/assetManifest';

const MINIMAL_RIG: Rig2DFile = {
  bones: [{ name: 'root', parent: -1, x: 0, y: 0, rot: 0 }],
  sprite: 'sp1',
  mesh: { verts: [[0, 0]], uvs: [[0, 0]], tris: [] },
  skinIndices: [0],
  skinWeights: [1],
};

const flush = () => new Promise((r) => setTimeout(r, 0));
// text() as well as json(): the loaders read the body as TEXT so they can spot Vite's index.html
// SPA fallback and report a MISSING asset instead of a JSON syntax error.
const okResponse = (body: unknown) => {
  const text = JSON.stringify(body);
  return { ok: true, status: 200, statusText: 'OK', text: () => Promise.resolve(text), json: () => Promise.resolve(body) };
};

beforeEach(() => {
  clearRig2DCache();
  clearManifest();
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

  it('invalidateRig2D mid-flight refuses a fetch that resolves with the OLD def (#487 item 8)', async () => {
    let resolveOld: (v: unknown) => void = () => {};
    vi.stubGlobal('fetch', vi.fn(() => new Promise((r) => { resolveOld = r; })));

    expect(getRig2D('race.rig2d.json')).toBeNull();   // kicks off the in-flight load
    invalidateRig2D('race.rig2d.json');                 // re-import lands mid-flight

    resolveOld(okResponse({ ...MINIMAL_RIG, sprite: 'STALE' }));
    await flush();

    // Genuinely EMPTY (peek, no new fetch) — not merely shadowed by a fresher value.
    expect(getRig2D('race.rig2d.json', { load: false })).toBeNull();
  });

  // THE DECISIVE case (#499): `generation` is module-wide, so a per-key `invalidateRig2D` that
  // bumped it would refuse every OTHER key's in-flight load too. Must FAIL against the
  // module-wide-`generation++` version and PASS once invalidation is scoped per path.
  it('invalidating an UNRELATED rig while A is in flight leaves A cacheable', async () => {
    let resolveA: (v: unknown) => void = () => {};
    vi.stubGlobal('fetch', vi.fn(() => new Promise((r) => { resolveA = r; })));

    expect(getRig2D('cross.a.rig2d.json')).toBeNull(); // kicks off A's load
    invalidateRig2D('cross.b.rig2d.json');               // UNRELATED path

    resolveA(okResponse({ ...MINIMAL_RIG, sprite: 'a-sprite' }));
    await flush();

    expect(getRig2D('cross.a.rig2d.json')?.sprite).toBe('a-sprite'); // must be cached
  });
});

describe('getRig2DSource — the AUTHORED doc, not the parsed rig (QA-ASSET-0015)', () => {
  // The parsed rig is a runtime structure: packed Float32Arrays, weights renormalized, v1
  // promoted to v2 parts. Reporting it as "what the asset says" is how a float32-precision
  // read came to be mistaken for the editor corrupting a rig on load.
  const PATH = 'src.rig2d.json';
  const AUTHORED: Rig2DFile = {
    ...MINIMAL_RIG,
    mesh: { verts: [[0, 0]], uvs: [[0, 0]], tris: [] },
    skinIndices: [0, 0, 0, 0],
    skinWeights: [0.7172465286407307, 0, 0, 0],
  };

  it('is null for a rig nothing has loaded, and never starts a fetch', () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    expect(getRig2DSource('cold.rig2d.json')).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it('hands back the seeded doc byte-for-byte, at float64 precision', () => {
    setRig2D(PATH, AUTHORED);
    expect(getRig2DSource(PATH)).toBe(AUTHORED);
    expect(getRig2DSource(PATH)!.skinWeights![0]).toBe(0.7172465286407307);
    // ...while the parsed rig is (correctly) float32 and restructured — the two answers differ,
    // which is exactly why both exist.
    expect(getRig2D(PATH)!.parts[0].skinWeights[0]).not.toBe(0.7172465286407307);
  });

  it('is dropped by invalidate and by a full clear, in lockstep with the parsed rig', () => {
    setRig2D(PATH, AUTHORED);
    invalidateRig2D(PATH);
    expect(getRig2DSource(PATH)).toBeNull();

    setRig2D(PATH, AUTHORED);
    clearRig2DCache();
    expect(getRig2DSource(PATH)).toBeNull();
  });
});

// Close-out sweep of QA-ANIM-0018 (animationClipCache's fix): every sibling `*Cache` module
// shared the same `isGuid(ref) ? resolveRef(ref) : ref` cache-key helper, silently returning
// undefined for a guid absent from the manifest with no warning at all.
describe('rig2dCache — unresolved guid warns once (parity with animationClipCache)', () => {
  it('warns once for a guid absent from the manifest', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const guid = newGuid();
    expect(getRig2D(guid)).toBeNull();
    expect(getRig2D(guid)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(guid);
    warn.mockRestore();
  });
});
