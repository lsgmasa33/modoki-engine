/** Pure track-item edit helpers used by the Timeline panel's inspector (Phase 4). */

import { describe, it, expect } from 'vitest';
import {
  withAddedItem, withMovedItem, withUpdatedItem, withDeletedItem, itemCount, getItem,
} from '../../src/editor/panels/timeline/itemEdit';
import type {
  AnimationTrackDef, SignalTrackDef, AudioTrackDef, ActivationTrackDef,
} from '../../src/runtime/timeline/types';

const anim = (): AnimationTrackDef => ({ id: 'a', name: 'A', target: 'X', type: 'animation', clips: [{ start: 0, duration: 1, clip: 'idle' }, { start: 2, clip: 'run' }] });
const sig = (): SignalTrackDef => ({ id: 's', name: 'S', target: '', type: 'signal', markers: [{ t: 1, action: 'foo', params: { a: 1 } }] });
const aud = (): AudioTrackDef => ({ id: 'u', name: 'U', target: '', type: 'audio', cues: [{ t: 1.5, clip: 'guid-1', bus: 'sfx' }] });
const act = (): ActivationTrackDef => ({ id: 'v', name: 'V', target: 'P', type: 'activation', spans: [{ start: 1, end: 3 }] });

describe('itemEdit helpers', () => {
  it('itemCount + getItem read by kind', () => {
    expect(itemCount(anim())).toBe(2);
    expect(itemCount(sig())).toBe(1);
    expect(getItem(anim(), 1)).toEqual({ start: 2, clip: 'run' });
    expect(getItem(sig(), 0)).toMatchObject({ action: 'foo' });
    expect(getItem(act(), 5)).toBeUndefined();
  });

  it('withUpdatedItem merges a field patch into the right item only', () => {
    const t = withUpdatedItem(anim(), 0, { clip: 'walk', scrub: false }) as AnimationTrackDef;
    expect(t.clips[0]).toEqual({ start: 0, duration: 1, clip: 'walk', scrub: false });
    expect(t.clips[1]).toEqual({ start: 2, clip: 'run' }); // untouched

    const s = withUpdatedItem(sig(), 0, { action: 'bar', params: { b: 2 } }) as SignalTrackDef;
    expect(s.markers[0]).toEqual({ t: 1, action: 'bar', params: { b: 2 } });

    const u = withUpdatedItem(aud(), 0, { clip: 'guid-2', volume: 0.5 }) as AudioTrackDef;
    expect(u.cues[0]).toEqual({ t: 1.5, clip: 'guid-2', bus: 'sfx', volume: 0.5 });

    const v = withUpdatedItem(act(), 0, { end: 5 }) as ActivationTrackDef;
    expect(v.spans[0]).toEqual({ start: 1, end: 5 });
  });

  it('withUpdatedItem can clear an optional field (params → undefined)', () => {
    const s = withUpdatedItem(sig(), 0, { params: undefined }) as SignalTrackDef;
    expect(s.markers[0].params).toBeUndefined();
  });

  it('withDeletedItem removes exactly one item and is immutable', () => {
    const src = anim();
    const t = withDeletedItem(src, 0) as AnimationTrackDef;
    expect(t.clips).toHaveLength(1);
    expect(t.clips[0].clip).toBe('run');
    expect(src.clips).toHaveLength(2); // original untouched
  });

  it('withAddedItem appends a normalize-surviving default at t', () => {
    expect((withAddedItem(sig(), 4) as SignalTrackDef).markers).toEqual([
      { t: 1, action: 'foo', params: { a: 1 } }, { t: 4, action: 'action' },
    ]);
    expect((withAddedItem(act(), 4) as ActivationTrackDef).spans[1]).toEqual({ start: 4, end: 5 });
  });

  it('withMovedItem retimes by kind; activation shifts the whole span', () => {
    expect((withMovedItem(sig(), 0, 3) as SignalTrackDef).markers[0].t).toBe(3);
    expect((withMovedItem(act(), 0, 10) as ActivationTrackDef).spans[0]).toEqual({ start: 10, end: 12 }); // width 2 preserved
  });
});
