import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  beginBootSpan, endBootSpan, bootSpan, bootSpanAsync, getBootTimeline, getBootOrigin, recordBootSpan,
  bootSpansOverlapping, resetBootTimeline, MAX_BOOT_SPANS,
} from '../../src/runtime/core/bootTimeline';
import { setManualNow, advanceManual, restoreRealClock } from '../../src/runtime/core/clock';

/** Boot-timeline tests (#238). Driven off the MANUAL clock throughout: the whole point of this
 *  instrument is that its numbers are trusted enough to attribute a 1.8 s freeze, and a test
 *  that asserted on wall-clock durations would be measuring the machine it ran on. */
describe('bootTimeline', () => {
  beforeEach(() => {
    resetBootTimeline();
    // `origin` is captured at module init, so the manual clock must be anchored relative to it
    // rather than to zero — offsets below are all deltas from wherever the origin landed.
    setManualNow(getBootOrigin());
  });
  afterEach(() => {
    restoreRealClock();
    resetBootTimeline();
  });

  it('records a span with start and end relative to the boot origin', () => {
    advanceManual(100);
    const h = beginBootSpan('scene-load', 'main.scene.json');
    advanceManual(250);
    endBootSpan(h);

    const { spans } = getBootTimeline();
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ name: 'scene-load', detail: 'main.scene.json' });
    // `closeTo`, not `toBe`: every timestamp is a subtraction from the module-init origin, so it
    // carries float drift far below the millisecond this instrument reasons in.
    expect(spans[0].startMs).toBeCloseTo(100, 6);
    expect(spans[0].endMs).toBeCloseTo(350, 6);
  });

  it('leaves an unclosed span at endMs -1 rather than guessing a duration', () => {
    const h = beginBootSpan('shader-compile');
    advanceManual(1800);
    expect(getBootTimeline().spans[0]).toMatchObject({ name: 'shader-compile', endMs: -1 });
    // The handle still closes correctly afterwards.
    endBootSpan(h);
    expect(getBootTimeline().spans[0].endMs).toBeCloseTo(1800, 6);
  });

  it('represents CONCURRENT spans honestly — overlap is not nesting', () => {
    // The case `profilerMarkers`'s stack cannot express, and the reason this module exists:
    // `Promise.all` over resources means two spans are open at once and neither is the other's
    // parent.
    const a = beginBootSpan('acquire:model', 'a.glb');
    advanceManual(10);
    const b = beginBootSpan('acquire:model', 'b.glb');
    advanceManual(10);
    endBootSpan(a);
    advanceManual(10);
    endBootSpan(b);

    const { spans } = getBootTimeline();
    expect(spans.map((s) => [Math.round(s.startMs), Math.round(s.endMs)])).toEqual([[0, 20], [10, 30]]);
  });

  it('closing twice, or closing a refused handle, is a no-op', () => {
    const h = beginBootSpan('scene-fetch-json');
    advanceManual(5);
    endBootSpan(h);
    advanceManual(100);
    endBootSpan(h);          // second close must not move the end
    endBootSpan(-1);         // a refused span's handle
    endBootSpan(999);        // out of range
    expect(getBootTimeline().spans[0].endMs).toBeCloseTo(5, 6);
  });

  it('bootSpan closes on a throw', () => {
    expect(() => bootSpan('boom', () => { advanceManual(7); throw new Error('x'); })).toThrow('x');
    const { spans } = getBootTimeline();
    expect(spans[0].name).toBe('boom');
    expect(spans[0].endMs).toBeCloseTo(7, 6);
  });

  it('bootSpanAsync closes on a rejection', async () => {
    await expect(bootSpanAsync('boom-async', async () => { advanceManual(9); throw new Error('y'); })).rejects.toThrow('y');
    expect(getBootTimeline().spans[0].name).toBe('boom-async');
    expect(getBootTimeline().spans[0].endMs).toBeCloseTo(9, 6);
  });

  it('records a span retroactively from raw timestamps', () => {
    // The frame loop cannot know a frame was a 1.8 s stall until it is over, so the stall row can
    // only be written after the fact — the case a begin/end pair cannot express.
    const origin = getBootOrigin();
    recordBootSpan('frame-interval', origin + 6995.3, origin + 8801.6, 'before frame 181');
    const [sp] = getBootTimeline().spans;
    expect(sp).toMatchObject({ name: 'frame-interval', detail: 'before frame 181' });
    expect(sp.startMs).toBeCloseTo(6995.3, 6);
    expect(sp.endMs).toBeCloseTo(8801.6, 6);
    // And it participates in the attribution query like any other span.
    expect(bootSpansOverlapping(7000, 7100).map((h) => h.name)).toEqual(['frame-interval']);
  });

  it('a retroactive span obeys the same cap, and counts as dropped', () => {
    for (let i = 0; i < MAX_BOOT_SPANS; i++) endBootSpan(beginBootSpan(`s${i}`));
    recordBootSpan('too-late', getBootOrigin(), getBootOrigin() + 1);
    const tl = getBootTimeline();
    expect(tl.spans).toHaveLength(MAX_BOOT_SPANS);
    expect(tl.dropped).toBe(1);
  });

  it('stops recording at the cap and says so, keeping the EARLIEST spans', () => {
    for (let i = 0; i < MAX_BOOT_SPANS; i++) endBootSpan(beginBootSpan(`s${i}`));
    const overflow = beginBootSpan('too-late');
    expect(overflow).toBe(-1);

    const tl = getBootTimeline();
    expect(tl.spans).toHaveLength(MAX_BOOT_SPANS);
    // Boot-only behaviour without a clock deciding when boot ended: the cap preserves the front.
    expect(tl.spans[0].name).toBe('s0');
    expect(tl.spans.some((s) => s.name === 'too-late')).toBe(false);
    expect(tl.dropped).toBe(1);
    expect(tl.full).toBe(true);
  });

  describe('bootSpansOverlapping — the attribution query', () => {
    it('returns only spans intersecting the window, longest overlap first', () => {
      // before | straddling-start | fully inside | straddling-end | after
      endBootSpan(beginBootSpan('before'));            // [0, 0]
      advanceManual(100);
      const straddleStart = beginBootSpan('straddle-start');  // [100, 250]
      advanceManual(100);                                     // t=200: window opens
      const inside = beginBootSpan('inside');                 // [200, 260]
      advanceManual(50);
      endBootSpan(straddleStart);                             // t=250
      advanceManual(10);
      endBootSpan(inside);                                    // t=260
      const straddleEnd = beginBootSpan('straddle-end');      // [260, 500]
      advanceManual(240);
      endBootSpan(straddleEnd);
      const after = beginBootSpan('after');                   // [500, 510]
      advanceManual(10);
      endBootSpan(after);

      const hits = bootSpansOverlapping(200, 400);
      expect(hits.map((h) => h.name)).toEqual(['straddle-end', 'inside', 'straddle-start']);
      expect(hits.map((h) => Math.round(h.overlapMs))).toEqual([140, 60, 50]);
    });

    it('counts an OPEN span as running to the end of the window', () => {
      // The row that matters most: a span that never closed may BE the stall, and reporting it
      // as zero-length would hide exactly the case the instrument was built for.
      advanceManual(50);
      beginBootSpan('never-closed');
      const hits = bootSpansOverlapping(100, 300);
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({ name: 'never-closed', endMs: -1 });
      expect(hits[0].overlapMs).toBeCloseTo(200, 6);
    });

    it('excludes spans that merely touch the window boundary', () => {
      endBootSpan(beginBootSpan('zero-at-start')); // [0, 0]
      advanceManual(100);
      const h = beginBootSpan('ends-at-window-start');
      endBootSpan(h);                              // [100, 100]
      expect(bootSpansOverlapping(100, 200)).toHaveLength(0);
    });
  });
});
