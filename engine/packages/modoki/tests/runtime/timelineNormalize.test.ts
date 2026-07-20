import { describe, it, expect } from 'vitest';
import {
  normalizeTimeline, defaultTimeline, collectTimelineAudioRefs, collectTimelineControlRefs,
  type TimelineDef, type AnimationTrackDef, type SignalTrackDef, type AudioTrackDef, type ActivationTrackDef,
} from '../../src/runtime/timeline/types';

describe('normalizeTimeline — defaults + clamps', () => {
  it('fills defaults for an empty doc', () => {
    const t = normalizeTimeline({});
    expect(t).toEqual({ id: '', name: 'Timeline', duration: 5, frameRate: 30, tracks: [] });
  });

  it('clamps a negative duration to 0 and a non-positive frameRate to 30', () => {
    expect(normalizeTimeline({ duration: -3 }).duration).toBe(0);
    expect(normalizeTimeline({ frameRate: 0 }).frameRate).toBe(30);
    expect(normalizeTimeline({ frameRate: -10 }).frameRate).toBe(30);
    expect(normalizeTimeline({ frameRate: 24 }).frameRate).toBe(24);
  });

  it('defaultTimeline is a valid normalized doc', () => {
    const d = defaultTimeline('guid-1', 'Cutscene');
    expect(normalizeTimeline(d)).toEqual(d);
    expect(d.id).toBe('guid-1');
  });
});

describe('normalizeTimeline — per-track normalization', () => {
  it('sorts animation clips by start and drops nameless clips; scrub defaults to true', () => {
    const doc: Partial<TimelineDef> = {
      tracks: [{
        id: 't1', name: 'Anim', target: 'Alien', type: 'animation',
        clips: [
          { start: 3, clip: 'B' },
          { start: 0, clip: 'A', scrub: false },
          { start: 1, clip: '' as unknown as string }, // dropped (no name)
        ],
      } as AnimationTrackDef],
    };
    const track = normalizeTimeline(doc).tracks[0] as AnimationTrackDef;
    expect(track.clips.map((c) => c.clip)).toEqual(['A', 'B']);
    expect(track.clips[0].scrub).toBe(false); // explicit false preserved
    expect(track.clips[1].scrub).toBe(true);  // default
  });

  it('sorts signal markers by t and drops actionless markers', () => {
    const doc: Partial<TimelineDef> = {
      tracks: [{
        id: 't', name: 'Sig', target: '', type: 'signal',
        markers: [{ t: 2, action: 'b' }, { t: 0.5, action: 'a' }, { t: 1, action: '' }],
      } as SignalTrackDef],
    };
    const track = normalizeTimeline(doc).tracks[0] as SignalTrackDef;
    expect(track.markers.map((m) => m.action)).toEqual(['a', 'b']);
  });

  it('drops activation spans with end <= start and sorts by start', () => {
    const doc: Partial<TimelineDef> = {
      tracks: [{
        id: 't', name: 'Act', target: 'Prop', type: 'activation',
        spans: [{ start: 4, end: 6 }, { start: 1, end: 3 }, { start: 5, end: 5 }, { start: 8, end: 2 }],
      } as ActivationTrackDef],
    };
    const track = normalizeTimeline(doc).tracks[0] as ActivationTrackDef;
    expect(track.spans).toEqual([{ start: 1, end: 3 }, { start: 4, end: 6 }]);
  });

  it('drops tracks with an unknown type', () => {
    const doc = { tracks: [{ id: 'x', type: 'bogus' }, { id: 'y', type: 'signal', markers: [] }] } as unknown as Partial<TimelineDef>;
    const tracks = normalizeTimeline(doc).tracks;
    expect(tracks).toHaveLength(1);
    expect(tracks[0].type).toBe('signal');
  });
});

describe('collectTimelineAudioRefs', () => {
  it('returns only audio-cue clip refs (the transitively-owned assets)', () => {
    const doc: Partial<TimelineDef> = {
      tracks: [
        { id: 'a', name: 'Audio', target: 'Sfx', type: 'audio', cues: [{ t: 1, clip: 'guid-sfx-1' }, { t: 2, clip: 'guid-sfx-2' }] } as AudioTrackDef,
        { id: 'n', name: 'Anim', target: 'Alien', type: 'animation', clips: [{ start: 0, clip: 'Walk' }] } as AnimationTrackDef,
      ],
    };
    expect(collectTimelineAudioRefs(normalizeTimeline(doc))).toEqual(['guid-sfx-1', 'guid-sfx-2']);
  });
});

describe('collectTimelineControlRefs', () => {
  it('returns only control-clip prefab GUIDs (the transitively-owned prefabs SceneManager must acquire)', () => {
    const doc: Partial<TimelineDef> = {
      tracks: [
        { id: 'c', name: 'FX', target: '', type: 'control', clips: [{ start: 1, prefab: 'guid-prefab-1' }, { start: 2, prefab: 'guid-prefab-2' }] } as never,
        { id: 'a', name: 'Audio', target: 'Sfx', type: 'audio', cues: [{ t: 1, clip: 'guid-sfx-1' }] } as AudioTrackDef,
      ],
    };
    expect(collectTimelineControlRefs(normalizeTimeline(doc))).toEqual(['guid-prefab-1', 'guid-prefab-2']);
  });

  it('is empty when there is no control track', () => {
    const doc: Partial<TimelineDef> = {
      tracks: [{ id: 'n', name: 'Anim', target: 'Alien', type: 'animation', clips: [{ start: 0, clip: 'Walk' }] } as AnimationTrackDef],
    };
    expect(collectTimelineControlRefs(normalizeTimeline(doc))).toEqual([]);
  });
});
