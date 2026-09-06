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

/** Issue #821: the top-level fix above does not reach a field nested inside an entry these
 *  normalizers rebuild via `.map()` — a clip, a marker, a keyframe. Each of these `.map()`s used
 *  to enumerate its own field list with no `...entry` spread, so a key nobody has invented yet
 *  survives at the top level (proven above) but was silently dropped one level down. Asserted on
 *  the SERIALIZED output, matching `atlasAssetDoc.test.ts`, since that is what the panel writes
 *  to disk via `useParkedAssetDoc` (`replace: true`). */
describe('asset normalizers preserve unknown fields NESTED inside an entry', () => {
  it('normalizeTimeline keeps an unknown field on an animation clip', () => {
    const raw = { id: 't', tracks: [{ id: 'tr1', type: 'animation', clips: [{ clip: 'Run', start: 0, futureField: 'wip' }] }] };
    const out = JSON.parse(JSON.stringify(normalizeTimeline(raw as never)));
    expect(out.tracks[0].clips[0].futureField).toBe('wip');
  });

  it('normalizeTimeline keeps an unknown field on a signal marker', () => {
    const raw = { id: 't', tracks: [{ id: 'tr1', type: 'signal', markers: [{ action: 'Fire', t: 0, futureField: 'wip' }] }] };
    const out = JSON.parse(JSON.stringify(normalizeTimeline(raw as never)));
    expect(out.tracks[0].markers[0].futureField).toBe('wip');
  });

  it('normalizeTimeline keeps an unknown field on an audio cue', () => {
    const raw = { id: 't', tracks: [{ id: 'tr1', type: 'audio', cues: [{ clip: 'boom', t: 0, futureField: 'wip' }] }] };
    const out = JSON.parse(JSON.stringify(normalizeTimeline(raw as never)));
    expect(out.tracks[0].cues[0].futureField).toBe('wip');
  });

  it('normalizeTimeline keeps an unknown field on an activation span', () => {
    const raw = { id: 't', tracks: [{ id: 'tr1', type: 'activation', spans: [{ start: 0, end: 1, futureField: 'wip' }] }] };
    const out = JSON.parse(JSON.stringify(normalizeTimeline(raw as never)));
    expect(out.tracks[0].spans[0].futureField).toBe('wip');
  });

  it('normalizeTimeline keeps an unknown field on a video clip', () => {
    const raw = { id: 't', tracks: [{ id: 'tr1', type: 'video', clips: [{ clip: 'intro', start: 0, futureField: 'wip' }] }] };
    const out = JSON.parse(JSON.stringify(normalizeTimeline(raw as never)));
    expect(out.tracks[0].clips[0].futureField).toBe('wip');
  });

  it('normalizeTimeline keeps an unknown field on a control clip (prefab branch)', () => {
    const raw = { id: 't', tracks: [{ id: 'tr1', type: 'control', clips: [{ prefab: 'guid-1', start: 0, futureField: 'wip' }] }] };
    const out = JSON.parse(JSON.stringify(normalizeTimeline(raw as never)));
    expect(out.tracks[0].clips[0].futureField).toBe('wip');
  });

  it('normalizeTimeline keeps an unknown field on a control clip (particle branch)', () => {
    const raw = { id: 't', tracks: [{ id: 'tr1', type: 'control', clips: [{ particle: true, start: 0, futureField: 'wip' }] }] };
    const out = JSON.parse(JSON.stringify(normalizeTimeline(raw as never)));
    expect(out.tracks[0].clips[0].futureField).toBe('wip');
  });

  it('normalizeTimeline keeps an unknown field on a control clip (subdirector branch)', () => {
    const raw = { id: 't', tracks: [{ id: 'tr1', type: 'control', clips: [{ subdirector: true, start: 0, futureField: 'wip' }] }] };
    const out = JSON.parse(JSON.stringify(normalizeTimeline(raw as never)));
    expect(out.tracks[0].clips[0].futureField).toBe('wip');
  });

  // ── the other half of the passthrough rule: a key the normalizer OWNS must still
  // be dropped. Carrying unknown keys through must not become "carry everything
  // through", or the deliberate normalization above it silently stops happening.
  it('normalizeTimeline still drops the LOSING discriminant on an over-specified control clip', () => {
    // "Precedence when over-specified: prefab > particle > subdirector" — the clip
    // must come out prefab-only. A blanket source spread would keep both.
    const raw = { id: 't', tracks: [{ id: 'tr1', type: 'control', clips: [{ prefab: 'guid-1', particle: true, subdirector: true, start: 0, futureField: 'wip' }] }] };
    const out = JSON.parse(JSON.stringify(normalizeTimeline(raw as never)));
    const clip = out.tracks[0].clips[0];
    expect(clip.prefab).toBe('guid-1');
    expect(clip.particle).toBeUndefined();
    expect(clip.subdirector).toBeUndefined();
    expect(clip.futureField).toBe('wip'); // …while the unknown key still survives
  });

  it('normalizeTimeline still drops a control-clip transform that FAILS normalization', () => {
    // `transform` is omitted precisely when `normalizeControlTransform` rejects it;
    // a blanket source spread would put the raw, un-normalized value back.
    const raw = { id: 't', tracks: [{ id: 'tr1', type: 'control', clips: [{ prefab: 'guid-1', start: 0, transform: 'not-an-object', futureField: 'wip' }] }] };
    const out = JSON.parse(JSON.stringify(normalizeTimeline(raw as never)));
    expect(out.tracks[0].clips[0].transform).toBeUndefined();
    expect(out.tracks[0].clips[0].futureField).toBe('wip');
  });

  it('normalizeTimeline keeps an unknown field on the track itself (not just its entries)', () => {
    const raw = { id: 't', tracks: [{ id: 'tr1', type: 'signal', markers: [], futureField: 'wip' }] };
    const out = JSON.parse(JSON.stringify(normalizeTimeline(raw as never)));
    expect(out.tracks[0].futureField).toBe('wip');
  });

  it('normalizeAnimationClip keeps an unknown field on a track', () => {
    const raw = { id: 'a', tracks: [{ path: '', trait: 'Transform', field: 'x', type: 'number', keys: [], futureField: 'wip' }] };
    const out = JSON.parse(JSON.stringify(normalizeAnimationClip(raw as never)));
    expect(out.tracks[0].futureField).toBe('wip');
  });

  it('normalizeAnimationClip keeps an unknown field on a deform track', () => {
    const raw = { id: 'a', deformTracks: [{ path: '', part: 'body', keys: [], futureField: 'wip' }] };
    const out = JSON.parse(JSON.stringify(normalizeAnimationClip(raw as never)));
    expect(out.deformTracks[0].futureField).toBe('wip');
  });

  it('normalizeAnimationClip keeps an unknown field on a deform keyframe', () => {
    const raw = { id: 'a', deformTracks: [{ path: '', part: 'body', keys: [{ t: 0, offsets: [], futureField: 'wip' }] }] };
    const out = JSON.parse(JSON.stringify(normalizeAnimationClip(raw as never)));
    expect(out.deformTracks[0].keys[0].futureField).toBe('wip');
  });

  it('normalizeSpriteAnim keeps an unknown field nested on a clip', () => {
    const raw = { id: 's', clips: { run: { frames: ['a', 'b'], fps: 12, futureField: 'wip' } } };
    const out = JSON.parse(JSON.stringify(normalizeSpriteAnim(raw as never)));
    expect(out.clips.run.futureField).toBe('wip');
  });
});

/** Review findings on #821's own fix, one level below the 11 sites it landed. */
describe('#821 review findings — the fix stopped short of these', () => {
  it('normalizeControlTransform keeps an unknown field inside a control clip transform', () => {
    const raw = { id: 't', tracks: [{ id: 'tr1', type: 'control', clips: [{ prefab: 'guid-1', start: 0, transform: { x: 1, ease: 'inOut' } }] }] };
    const out = JSON.parse(JSON.stringify(normalizeTimeline(raw as never)));
    expect(out.tracks[0].clips[0].transform.x).toBe(1);
    expect(out.tracks[0].clips[0].transform.ease).toBe('inOut');
  });

  it('normalizeControlTransform still drops a non-numeric TRS field', () => {
    const raw = { id: 't', tracks: [{ id: 'tr1', type: 'control', clips: [{ prefab: 'guid-1', start: 0, transform: { x: 'nope', y: 2 } }] }] };
    const out = JSON.parse(JSON.stringify(normalizeTimeline(raw as never)));
    expect(out.tracks[0].clips[0].transform.x).toBeUndefined();
    expect(out.tracks[0].clips[0].transform.y).toBe(2);
  });

  it('normalizeTrack does not carry a foreign kind\'s payload across a re-typed track, but keeps an unknown track-level key', () => {
    const raw = { id: 't', tracks: [{ id: 'tr1', type: 'animation', clips: [{ clip: 'Run', start: 0 }], markers: [{ action: 'Fire', t: 0 }], futureField: 'wip' }] };
    const out = JSON.parse(JSON.stringify(normalizeTimeline(raw as never)));
    const track = out.tracks[0];
    expect(track.markers).toBeUndefined();
    expect(track.clips[0].clip).toBe('Run');
    expect(track.futureField).toBe('wip');
  });

  it('normalizeSpriteAnim rejects an array where a clip is expected instead of spreading numeric indices', () => {
    const raw = { id: 's', clips: { run: ['a', 'b'] } };
    const out = JSON.parse(JSON.stringify(normalizeSpriteAnim(raw as never)));
    expect(out.clips.run['0']).toBeUndefined();
    expect(out.clips.run['1']).toBeUndefined();
    expect(Array.isArray(out.clips.run.frames)).toBe(true);
  });

  it('normalizeControlTransform keeps an unknown key when NO TRS field is present', () => {
    const raw = { id: 't', tracks: [{ id: 'tr1', type: 'control', clips: [{ prefab: 'guid-1', start: 0, transform: { ease: 'inOut' } }] }] };
    const out = JSON.parse(JSON.stringify(normalizeTimeline(raw as never)));
    expect(out.tracks[0].clips[0].transform.ease).toBe('inOut');
    expect(out.tracks[0].clips[0].transform.x).toBeUndefined();
  });

  it('normalizeControlTransform keeps an unknown key when the only TRS field is INVALID', () => {
    const raw = { id: 't', tracks: [{ id: 'tr1', type: 'control', clips: [{ prefab: 'guid-1', start: 0, transform: { x: 'bad', ease: 'inOut' } }] }] };
    const out = JSON.parse(JSON.stringify(normalizeTimeline(raw as never)));
    expect(out.tracks[0].clips[0].transform.ease).toBe('inOut');
    expect(out.tracks[0].clips[0].transform.x).toBeUndefined();
  });

  it('normalizeSpriteAnim rejects an array passed as the whole `clips` map instead of spreading numeric indices', () => {
    const raw = { id: 's', clips: ['idle', 'run'] };
    const out = JSON.parse(JSON.stringify(normalizeSpriteAnim(raw as never)));
    expect(out.clips['0']).toBeUndefined();
    expect(out.clips['1']).toBeUndefined();
    expect(out.clips).toEqual({});
  });
});
