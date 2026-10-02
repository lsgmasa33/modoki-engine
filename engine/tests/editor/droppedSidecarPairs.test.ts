/** #2048 — the Assets panel's OS drop sends a file and its own `.meta.json` as ONE create-only `/api/write-file`, so the
 *  scan's heal can never mint the file an identity in a gap between two requests (png first), and the route replaces an
 *  orphan at the sidecar's path instead of refusing it (meta first). The route half is `routerMultiStepWrites.test.ts`;
 *  this pins the client half: which dropped files pair, where a paired sidecar lands, and what the request carries. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { planImports, pairDroppedSidecars, writeDroppedImport } from '../../packages/modoki/src/editor/panels/assetOps';

afterEach(() => { vi.restoreAllMocks(); });

describe('pairDroppedSidecars (#2048)', () => {
  it('pairs a .meta.json and a .meta.local.json with their file, in either drop order, ignoring case', () => {
    expect(pairDroppedSidecars(['hero.png.meta.json', 'Hero.PNG', 'hero.png.meta.local.json', 'other.txt'])).toEqual([
      { index: 1, suffix: '.meta.json' }, null, { index: 1, suffix: '.meta.local.json' }, null,
    ]);
  });

  it('a name dropped twice pairs with nothing: which sidecar is whose cannot be told, so the sidecars are ambiguous', () => {
    expect(pairDroppedSidecars(['hero.png', 'hero.png.meta.json', 'hero.png', 'hero.png.meta.json', 'a.png', 'a.png.meta.json'])).toEqual([
      null, 'ambiguous', null, 'ambiguous', null, { index: 4, suffix: '.meta.json' },
    ]);
  });

  it('each half separately: the FILE named twice, or the SIDECAR named twice, is enough to pair nothing', () => {
    expect(pairDroppedSidecars(['hero.png', 'hero.png', 'hero.png.meta.json'])).toEqual([null, null, 'ambiguous']);
    expect(pairDroppedSidecars(['hero.png', 'hero.png.meta.json', 'hero.png.meta.json'])).toEqual([null, 'ambiguous', 'ambiguous']);
  });

  it('a sidecar whose file is not in the drop stays a lone file; a sidecar of a sidecar is not a pair', () => {
    expect(pairDroppedSidecars(['hero.png.meta.json'])).toEqual([null]);
    expect(pairDroppedSidecars(['a.meta.json', 'a.meta.json.meta.json'])).toEqual([null, null]);
    // …even when its base is doubled: a sidecar of a sidecar is a lone file, not an ambiguous pair (close-out review 3).
    expect(pairDroppedSidecars(['a.png', 'a.png.meta.json', 'a.png.meta.json', 'a.png.meta.json.meta.json'])[3]).toBeNull();
  });
});

describe('planImports pairs a sidecar with its file\'s dest (#2048)', () => {
  it('the sidecar follows its file\'s " copy" name, and takes no name of its own', () => {
    const taken = new Set(['/assets/hero.png']);
    const plan = planImports(['hero.png.meta.json', 'hero.png'], '/assets', taken);
    expect(plan[1].dest).not.toBe('/assets/hero.png');
    expect(plan[0]).toEqual({ name: 'hero.png.meta.json', dest: plan[1].dest + '.meta.json', convert: false, sidecarOf: { index: 1, suffix: '.meta.json' } });
    expect(taken.has(plan[0].dest)).toBe(false);
  });

  it('an AMBIGUOUS sidecar is planned nowhere: never beside whichever png took the plain name (close-out review)', () => {
    const plan = planImports(['hero.png', 'hero.png', 'hero.png.meta.json', 'hero.png.meta.json'], '/assets', new Set());
    expect(plan.map((p) => p.dest)).toEqual(['/assets/hero.png', '/assets/hero copy.png', '', '']);
    expect(plan[2].ambiguous).toBe(true);
    expect(plan[3].ambiguous).toBe(true);
  });

  it('ACCEPT SIDE: a drop with no pair plans exactly as before', () => {
    expect(planImports(['a.png', 'b.txt'], '/assets', new Set())).toEqual([
      { name: 'a.png', dest: '/assets/a.png', convert: true },
      { name: 'b.txt', dest: '/assets/b.txt', convert: false },
    ]);
  });
});

describe('writeDroppedImport sends the pair in one request (#2048)', () => {
  it('the sidecars ride on the file\'s create-only write', async () => {
    const fetchStub = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    expect(await writeDroppedImport('/assets/hero.png', 'cG5n', [{ suffix: '.meta.json', content: '{"id":"g"}' }])).toEqual({ result: 'ok' });
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchStub.mock.calls[0][1]?.body))).toEqual({
      path: '/assets/hero.png', content: 'cG5n', encoding: 'base64', ifNoneMatch: '*', sidecars: [{ suffix: '.meta.json', content: '{"id":"g"}' }],
    });
  });

  it('a lone file sends no sidecars field', async () => {
    const fetchStub = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await writeDroppedImport('/assets/a.png', 'cG5n');
    expect(JSON.parse(String(fetchStub.mock.calls[0][1]?.body))).not.toHaveProperty('sidecars');
  });
});
