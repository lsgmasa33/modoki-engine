/** timeline_set must not silently drop malformed items (MCP re-audit F12).
 *
 *  `normalizeTimeline` drops malformed items WITHIN a track (a span with end<=start, an empty-name
 *  clip/action, a missing audio GUID). The op used to return `{ok:true, tracks:N}` counting surviving
 *  TRACKS — so a set that lost items reported success. The guard compares item counts before/after
 *  normalization; this locks the detection primitive (`countTimelineItems` + `normalizeTimeline`) it
 *  keys on. */

import { describe, it, expect } from 'vitest';
import { normalizeTimeline } from '@modoki/engine/runtime';
import { countTimelineItems } from '../../app/editor/agentEditorOps';

describe('countTimelineItems + normalizeTimeline (F12 drop detection)', () => {
  it('a clean timeline survives normalization with its item count intact', () => {
    const raw = {
      duration: 5,
      tracks: [
        { id: 't1', type: 'activation', target: 'A', spans: [{ start: 0, end: 2 }, { start: 3, end: 4 }] },
      ],
    };
    const before = countTimelineItems(raw as never);
    const after = countTimelineItems(normalizeTimeline(raw as never));
    expect(before).toBe(2);
    expect(after).toBe(2); // nothing dropped → the op reports ok:true
  });

  it('a malformed span (end<=start) is DROPPED — count falls, which the op turns into a failure', () => {
    const raw = {
      duration: 5,
      tracks: [
        { id: 't1', type: 'activation', target: 'A', spans: [
          { start: 0, end: 2 },   // valid
          { start: 3, end: 3 },   // end<=start → dropped by normalizeTimeline
        ] },
      ],
    };
    const before = countTimelineItems(raw as never);
    const after = countTimelineItems(normalizeTimeline(raw as never));
    expect(before).toBe(2);
    expect(after).toBeLessThan(before); // a drop the op MUST surface (it throws when after < before)
  });

  it('counts items across every track kind (clips/markers/cues/spans)', () => {
    const raw = {
      duration: 10,
      tracks: [
        { id: 'a', type: 'animation', target: 'X', clips: [{ clip: 'Walk', start: 0 }] },
        { id: 's', type: 'signal', target: 'X', markers: [{ action: 'fx.spark', time: 1 }] },
        { id: 'p', type: 'activation', target: 'Y', spans: [{ start: 0, end: 5 }] },
      ],
    };
    expect(countTimelineItems(raw as never)).toBe(3);
  });
});
