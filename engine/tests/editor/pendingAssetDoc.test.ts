/** `pendingAssetDoc` — what an asset panel must open with when a write is already parked
 *  (QA-CTX-0008).
 *
 *  Persistence is manual: the agent asset ops apply their change live and PARK the write in the
 *  dirty-asset registry, so between the edit and Save All the file on disk still holds the
 *  PRE-edit doc. Every asset panel opened by fetching that file, which re-seeded the live cache
 *  with the stale doc — measured: a `timeline-add-clip` that read back as one track became
 *  `tracks: []` the moment the Timeline Editor was opened on it, while the parked write and
 *  `unsaved:true` both stayed. The panel then displayed a document that disagreed with what Save
 *  All would write. */

import { describe, it, expect, beforeEach } from 'vitest';
import { markAssetDirty, clearDirtyAssets, assetWrittenToDisk, getDirtyAssetPaths, peekDirtyAsset } from '../../packages/modoki/src/editor/scene/dirtyAssets';
import { pendingAssetDoc } from '../../packages/modoki/src/editor/panels/pendingAssetDoc';

const PATH = '/assets/timelines/probe.timeline.json';

beforeEach(() => { clearDirtyAssets(); });

describe('pendingAssetDoc', () => {
  it('returns the parked doc, so the panel opens the edit rather than the stale file', () => {
    const doc = { id: 'g1', tracks: [{ id: 'track-0', type: 'signal', markers: [{ t: 0.5, action: 'a' }] }] };
    markAssetDirty(PATH, 'timeline', doc);
    expect(pendingAssetDoc(PATH, 'timeline')).toBe(doc);
  });

  it('returns null when nothing is parked — the file fetch stays the normal path', () => {
    expect(pendingAssetDoc(PATH, 'timeline')).toBeNull();
  });

  it('refuses a TYPE mismatch instead of handing the wrong def to a normalizer', () => {
    // The registry is keyed by path alone. A particle def pushed through normalizeTimeline would
    // not throw — it would produce a confident, empty timeline, which is the failure this whole
    // helper exists to prevent.
    markAssetDirty(PATH, 'particle', { id: 'g1', emission: {} });
    expect(pendingAssetDoc(PATH, 'timeline')).toBeNull();
  });

  it('is null-safe on an unopened panel (no asset path)', () => {
    markAssetDirty(PATH, 'timeline', { id: 'g1' });
    expect(pendingAssetDoc(undefined, 'timeline')).toBeNull();
  });

  it('treats a parked null/undefined payload as nothing pending', () => {
    markAssetDirty(PATH, 'timeline', null);
    expect(pendingAssetDoc(PATH, 'timeline')).toBeNull();
  });
});

/** `assetWrittenToDisk` — the other half of the parked-write contract.
 *
 *  MEASURED on games/3d-test 2026-08-18: `particle_set` parked v1; a panel-shaped
 *  `/api/write-file` POST put v2 on disk; `dirtyAssetPaths` still listed the path; `save_all` then
 *  rewrote the file back to **v1**, with no warning — the human's panel edits were gone. The file
 *  watcher cannot save this: `/api/write-file` fingerprints its own bytes (`markEditorWrite`) so
 *  the editor does not react to itself, and the Timeline panel's un-suppressed `/api/asset-write`
 *  is still only debounced. The writer has to say so. */
describe('assetWrittenToDisk', () => {
  it('drops the older parked write, so save_all cannot flush it over the file just written', () => {
    markAssetDirty(PATH, 'timeline', { id: 'g1', name: 'PARKED_V1' });
    expect(assetWrittenToDisk(PATH)).toBe(true);
    expect(getDirtyAssetPaths()).not.toContain(PATH);
    expect(peekDirtyAsset(PATH)).toBeNull();
  });

  it('reports false when nothing was parked — a panel save is not obliged to have had a park', () => {
    expect(assetWrittenToDisk(PATH)).toBe(false);
  });

  it('touches only the written path', () => {
    const other = '/assets/particles/other.particle.json';
    markAssetDirty(PATH, 'timeline', { id: 'g1' });
    markAssetDirty(other, 'particle', { id: 'g2' });
    assetWrittenToDisk(PATH);
    expect(getDirtyAssetPaths()).toEqual([other]);
  });
});
