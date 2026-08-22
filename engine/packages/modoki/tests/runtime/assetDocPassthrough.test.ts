/** The three asset normalizers must carry UNKNOWN top-level fields through.
 *
 *  Bug `xukhAP0gWNnD9MFRHb0P`, filed by the close-out sweep for the AtlasAssetView instance
 *  (`EDnpmBkOOLbeqgDCaQC1`) rather than by a case — latent when filed, and the whole point of
 *  pinning it here is that it stays latent. The mechanism: each normalizer rebuilt its document
 *  from an ENUMERATED field list, and the Animation / Timeline / Sprite Anim editors park and
 *  write that rebuilt object (`useParkedAssetDoc`, which sends `replace:true` for panel-origin
 *  writes precisely so a panel can replace the file wholesale). So the server's drop-key guard —
 *  the one thing that would refuse a write deleting top-level fields — is turned off for exactly
 *  the writes that could trigger this. One keyframe edit + Cmd+S deleted the key, with no error,
 *  no guard and nothing in the journal.
 *
 *  This is the trap CLAUDE.md already records for prefabs: "prefer binding the whole thing over
 *  enumerating fields; a hand-maintained list of fields we read will go stale on the first field
 *  somebody adds, and the staleness is invisible." These become real the same way the Atlas one
 *  did — on the next migration, importer, or authoring feature that adds a top-level key. */

import { describe, it, expect } from 'vitest';
import { normalizeAnimationClip } from '../../src/runtime/animation/types';
import { normalizeTimeline } from '../../src/runtime/timeline/types';
import { normalizeSpriteAnim } from '../../src/runtime/loaders/spriteAnimCache';

describe('asset normalizers preserve unknown top-level fields', () => {
  it('normalizeAnimationClip keeps a field it does not model', () => {
    const out = normalizeAnimationClip({ id: 'a', tracks: [], notes: 'wip' } as never);
    expect((out as unknown as Record<string, unknown>).notes).toBe('wip');
    expect(out.id).toBe('a');
  });

  it('normalizeTimeline keeps a field it does not model', () => {
    const out = normalizeTimeline({ id: 't', tracks: [], notes: 'wip' } as never);
    expect((out as unknown as Record<string, unknown>).notes).toBe('wip');
    expect(out.frameRate).toBe(30);
  });

  it('normalizeSpriteAnim keeps a field it does not model', () => {
    const out = normalizeSpriteAnim({ id: 's', clips: {}, notes: 'wip' } as never);
    expect((out as unknown as Record<string, unknown>).notes).toBe('wip');
    expect(out.id).toBe('s');
  });

  /** The known fields must still WIN over the raw ones, or the spread would defeat every
   *  clamp and default the normalizer exists for — the failure mode of fixing this carelessly. */
  it('normalized fields still override the raw document', () => {
    expect(normalizeTimeline({ frameRate: -10 } as never).frameRate).toBe(30);
    expect(normalizeTimeline({ duration: -3 } as never).duration).toBe(0);
    expect(normalizeAnimationClip({ frameRate: 0 } as never).frameRate).toBe(60);
    expect(normalizeAnimationClip({ tracks: 'nope' } as never).tracks).toEqual([]);
    expect(normalizeSpriteAnim({ clips: 'nope' } as never).clips).toEqual({});
  });

  /** Key ORDER is part of the fix, not a bonus: the panel rewrites the whole file, so a
   *  reshuffled document is a large diff over an edit that changed one number. Object spread
   *  takes each key's first-seen position, so the raw order survives. */
  it('preserves the original key order of the document', () => {
    const out = normalizeAnimationClip({ notes: 'wip', id: 'a', tracks: [] } as never);
    expect(Object.keys(out)[0]).toBe('notes');
  });

  /** A round-trip through the normalizer is what the panel writes back, so it must reproduce
   *  every top-level key the file had — this is the assertion that would have caught the Atlas
   *  instance before it corrupted a committed file. */
  it('a parse → serialize round-trip loses no top-level key', () => {
    const raw = { id: 'a', name: 'Clip', duration: 2, frameRate: 30, loop: false, tracks: [], texture: { format: 'ktx2-uastc' } };
    const keys = Object.keys(JSON.parse(JSON.stringify(normalizeAnimationClip(raw as never))));
    for (const k of Object.keys(raw)) expect(keys).toContain(k);
  });
});
