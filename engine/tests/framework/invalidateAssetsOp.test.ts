/** The `invalidate-assets` agent op — the renderer-side half of the reimport
 *  live-refresh. `/api/reimport` calls it via requestBrowser after a bake; it
 *  evicts the path-keyed GPU caches (invalidateModel / invalidateTexture) so the
 *  live viewport rebinds the new variant without an editor restart.
 *
 *  invalidateModel fires onModelInvalidated listeners UNCONDITIONALLY (even with an
 *  empty cache), so we can observe that the op routed each MODEL item to it — no
 *  loaded scene / GPU needed. Texture routing is asserted via the op's return counts
 *  (the `textures` counter only increments on the type === 'texture' branch). */

import { describe, it, expect, beforeEach } from 'vitest';
import { runAgentOp } from '../../app/debug/agentBridge';
import { onModelInvalidated } from '@modoki/engine/runtime';

describe('invalidate-assets op', () => {
  let invalidated: string[];
  let unsub: () => void;
  beforeEach(() => {
    invalidated = [];
    unsub = onModelInvalidated((path) => { invalidated.push(path); });
    return () => unsub();
  });

  it('is registered as a built-in runtime op', async () => {
    // A smoke call proves it is wired into the dispatch table.
    const r = await runAgentOp('invalidate-assets', { items: [] }) as { ok: boolean };
    expect(r.ok).toBe(true);
  });

  it('routes model items to invalidateModel and counts by type', async () => {
    const r = await runAgentOp('invalidate-assets', {
      items: [
        { path: '/assets/models/a.glb', type: 'model' },
        { path: '/assets/models/b.glb', type: 'model' },
        { path: '/assets/textures/t.png', type: 'texture' },
      ],
    }) as { ok: boolean; models: number; textures: number };

    expect(r).toEqual({ ok: true, models: 2, textures: 1, audio: 0, environments: 0 });
    // Only the model paths fire model-invalidation — the texture path must not.
    expect(invalidated).toEqual(['/assets/models/a.glb', '/assets/models/b.glb']);
  });

  it('skips items with no path and ignores unknown types', async () => {
    const r = await runAgentOp('invalidate-assets', {
      items: [
        { type: 'model' },                              // no path → skip
        { path: '/assets/models/c.glb', type: 'model' },
        { path: '/assets/foo.mat.json', type: 'material' }, // not a GPU-path cache → ignore
      ],
    }) as { models: number; textures: number };

    expect(r).toEqual({ ok: true, models: 1, textures: 0, audio: 0, environments: 0 });
    expect(invalidated).toEqual(['/assets/models/c.glb']);
  });

  it('tolerates missing/empty params', async () => {
    const empty = { ok: true, models: 0, textures: 0, audio: 0, environments: 0 };
    expect(await runAgentOp('invalidate-assets', {})).toEqual(empty);
    expect(await runAgentOp('invalidate-assets')).toEqual(empty);
  });

  it('routes audio + environment items too (#304 close-out)', async () => {
    // This op exists so an MCP/curl reimport refreshes IDENTICALLY to the Assets-panel
    // button. Both dropped audio and HDR on the floor, so a re-imported clip kept
    // playing its old decoded buffer and a re-imported .hdr kept lighting the scene.
    const { onAssetInvalidated } = await import('@modoki/engine/runtime');
    const fired: Array<[string, string]> = [];
    const off = onAssetInvalidated((kind, path) => { fired.push([kind, path]); });
    try {
      const r = await runAgentOp('invalidate-assets', {
        items: [
          { path: '/assets/audio/hit.wav', type: 'audio' },
          { path: '/assets/env/studio.hdr', type: 'environment' },
        ],
      }) as { audio: number; environments: number };
      expect(r).toMatchObject({ audio: 1, environments: 1 });
      expect(fired).toEqual([
        ['audio', '/assets/audio/hit.wav'],
        ['environment', '/assets/env/studio.hdr'],
      ]);
    } finally { off(); }
  });
});
