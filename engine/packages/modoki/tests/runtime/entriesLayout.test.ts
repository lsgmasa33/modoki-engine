import { describe, it, expect } from 'vitest';
import {
  computeAxisWindow, contentExtent, effectiveOverscan, resolveEntrySize,
  slotForIndex, indexForSlot, planSlots, type AxisInput,
} from '../../src/runtime/ui/entriesLayout';
import { parseEntryPrefabs } from '../../src/runtime/traits/UIEntries';

describe('parseEntryPrefabs — authored JSON is not trusted input', () => {
  it('reads a well-formed bank', () => {
    expect(parseEntryPrefabs('[{"name":"tile","prefab":"g1"}]')).toEqual([{ name: 'tile', prefab: 'g1' }]);
  });
  it('returns empty for malformed JSON rather than throwing mid scene-load', () => {
    expect(parseEntryPrefabs('[{oops')).toEqual([]);
    expect(parseEntryPrefabs('')).toEqual([]);
    expect(parseEntryPrefabs('{"not":"an array"}')).toEqual([]);
  });
  it('DROPS incomplete kinds instead of guessing at them', () => {
    // A kind with no guid would resolve to nothing at spawn time; silently keeping it would
    // produce an entry that renders empty with no diagnostic.
    expect(parseEntryPrefabs('[{"name":"a"},{"prefab":"g"},null,{"name":"ok","prefab":"g2"}]'))
      .toEqual([{ name: 'ok', prefab: 'g2' }]);
  });
});

const axis = (over: Partial<AxisInput> = {}): AxisInput => ({
  scroll: 0, viewport: 600, entrySize: 120, gap: 0, count: 5000, overscan: 0, ...over,
});

describe('resolveEntrySize', () => {
  it('0 means "read it from the prefab" — not "zero-sized" — prefab px is taken literally', () => {
    // The single-source-of-truth rule: a fixed-size entry must not be a second copy of a
    // number the prefab root already states.
    expect(resolveEntrySize(0, 'px', 600, 96, 'px')).toBe(96);
  });
  it('the prefab fallback resolves ITS OWN % against the same viewport axis (#765)', () => {
    // A prefab root authored `width: 50, widthUnit: '%'` must resolve to half the viewport,
    // exactly like a view-authored `entryWidth: 50%` does — not get pinned to a raw 50px.
    expect(resolveEntrySize(0, 'px', 600, 50, '%')).toBe(300);
    expect(resolveEntrySize(0, '%', 600, 100, '%')).toBe(600);
  });
  it('% resolves against the viewport — how a one-at-a-time pager is expressed', () => {
    expect(resolveEntrySize(100, '%', 621, 0, 'px')).toBe(621);
    expect(resolveEntrySize(50, '%', 600, 0, 'px')).toBe(300);
  });
  it('px is taken literally', () => {
    expect(resolveEntrySize(120, 'px', 600, 999, 'px')).toBe(120);
  });
  it('the view\'s own non-zero authored value wins over the prefab fallback', () => {
    // authored !== 0, so fromPrefab/fromPrefabUnit must be ignored entirely regardless of what
    // they say — even a huge conflicting prefab % must not leak through.
    expect(resolveEntrySize(120, 'px', 600, 500, '%')).toBe(120);
    expect(resolveEntrySize(50, '%', 600, 999, 'px')).toBe(300);
  });
  it('clamps a negative prefab px fallback to 0', () => {
    expect(resolveEntrySize(0, 'px', 600, -40, 'px')).toBe(0);
  });
  it('clamps a negative resolved prefab % fallback to 0', () => {
    expect(resolveEntrySize(0, 'px', 600, -10, '%')).toBe(0);
  });
});

describe('effectiveOverscan — the A23 measurement, encoded', () => {
  it('never drops below the authored floor', () => {
    expect(effectiveOverscan(2, 0)).toBe(2);
    expect(effectiveOverscan(2, 1.2)).toBe(2);
  });
  it('covers the measured 4.56-entry traversal that made overscan 3 blank', () => {
    // Measured on a Galaxy A23: overscan 3 blanked 74/605 frames against this traversal.
    expect(effectiveOverscan(2, 4.56)).toBe(5);
    expect(effectiveOverscan(3, 3.89)).toBe(4);
  });
  it('CAPS the raise — a jump must not pool the whole data set', () => {
    // Found live, not by reasoning: jumping scrollTop across a 5,000-entry list reported ~4,991
    // entries of travel, and the uncapped raise grew the pool from 9 entities to 5,000 (10,001
    // DOM nodes) — the exact cost this feature exists to avoid. A teleport also NEEDS no
    // overscan: the window relocates wholesale rather than continuing in a direction.
    expect(effectiveOverscan(2, 4991, 5)).toBe(5);
    expect(effectiveOverscan(2, 250, 6)).toBe(6);
    // The measured fling case still passes through untouched.
    expect(effectiveOverscan(2, 4.56, 6)).toBe(5);
  });

  it('never caps BELOW the authored floor — an author asking for 8 gets 8', () => {
    expect(effectiveOverscan(8, 3, 2)).toBe(8);
  });

  it('ignores nonsense travel rather than producing an infinite pool', () => {
    expect(effectiveOverscan(2, NaN)).toBe(2);
    expect(effectiveOverscan(2, -8)).toBe(2);
  });
});

describe('computeAxisWindow', () => {
  it('carries the visible+1 floor — the straddling entry, even at overscan 0', () => {
    // 600 / 120 = exactly 5 entries fit, but any partial offset shows part of a 6th.
    expect(computeAxisWindow(axis()).visible).toBe(6);
  });

  it('adds overscan on BOTH edges on top of that floor', () => {
    expect(computeAxisWindow(axis({ overscan: 2 })).pooled).toBe(10); // 6 + 2*2
  });

  it('keeps entry i at i*stride regardless of first — the no-shift property', () => {
    // padLeading is exactly first*stride, so the pooled block starts where entry `first`
    // belongs. This is what stops recycling shifting content under a moving finger.
    const w = computeAxisWindow(axis({ scroll: 12000, overscan: 2 }));
    expect(w.padLeading).toBe(w.first * 120);
  });

  it('sums to the true content extent, so scrollHeight and snap points land right', () => {
    const w = computeAxisWindow(axis({ scroll: 9000, gap: 8, overscan: 3 }));
    const stride = 120 + 8;
    const renderedExtent = w.rendered * 120 + (w.rendered - 1) * 8; // flex `gap` draws these
    expect(w.padLeading + renderedExtent + w.padTrailing).toBe(contentExtent(5000, 120, 8));
    expect(w.padLeading).toBe(w.first * stride);
  });

  it('clamps at the start — no negative first from overscan at scroll 0', () => {
    const w = computeAxisWindow(axis({ scroll: 0, overscan: 4 }));
    expect(w.first).toBe(0);
    expect(w.padLeading).toBe(0);
  });

  it('clamps at the end — the pool never hangs past the last entry', () => {
    const w = computeAxisWindow(axis({ count: 20, scroll: 99999, overscan: 2 }));
    expect(w.first + w.pooled).toBeLessThanOrEqual(20);
    expect(w.padTrailing).toBe(0);
  });

  it('handles a data set smaller than the viewport without over-pooling', () => {
    const w = computeAxisWindow(axis({ count: 3 }));
    expect(w.pooled).toBe(3);
    expect(w.rendered).toBe(3);
    expect(w.padLeading).toBe(0);
    expect(w.padTrailing).toBe(0);
  });

  it('is empty for no data — a view over nothing renders nothing', () => {
    expect(computeAxisWindow(axis({ count: 0 })).pooled).toBe(0);
  });

  it('refuses a zero-size entry instead of dividing by zero into an infinite pool', () => {
    expect(computeAxisWindow(axis({ entrySize: 0, gap: 0 })).pooled).toBe(0);
  });

  it('the pager case: a viewport-sized entry shows 2 and needs no big pool', () => {
    // Measured on the A23: traversal never exceeded 1.00 entries per update here, and every
    // run recorded zero blank frames at overscan 1.
    const w = computeAxisWindow(axis({ entrySize: 621, viewport: 621, overscan: 1 }));
    expect(w.visible).toBe(2);
    expect(w.pooled).toBe(4);
  });
});

describe('cross-validation against the measured A23 spike', () => {
  // The step-0 spike harness (docs/plans/ui-scroll-view-plan.md) ran on a real Galaxy A23 and
  // its HUD reported pool/visible for each configuration. This engine implementation must
  // reproduce those exact numbers, or the on-device measurements do not describe what shipped.
  it('reproduces the strip run: h=120 on a 720x1560 device -> visible 7, pool 9 at overscan 1', () => {
    // Chrome viewport was 360 CSS px wide; the scroll box measured 621 CSS px tall (the HUD
    // printed h=621 for the viewport-sized case, which is the same box).
    const w = computeAxisWindow(axis({ viewport: 621, entrySize: 120, overscan: 1 }));
    expect(w.visible).toBe(7);
    expect(w.pooled).toBe(9);
  });

  it('reproduces the pager run: a viewport-sized entry -> visible 2, pool 4 at overscan 1', () => {
    const w = computeAxisWindow(axis({ viewport: 621, entrySize: 621, overscan: 1 }));
    expect(w.visible).toBe(2);
    expect(w.pooled).toBe(4);
  });

  it('reproduces the run that came back CLEAN: overscan 6 covered a 4.56-entry traversal', () => {
    // 0 blank frames in 651 — the only strip configuration measured clean.
    const w = computeAxisWindow(axis({ viewport: 621, entrySize: 120, overscan: 6 }));
    expect(w.pooled).toBe(19);           // HUD: pool=19 visible=7
    expect(effectiveOverscan(6, 4.56)).toBe(6);  // travel already covered, no raise needed
  });

  it('would have RAISED the overscan that blanked — 1 and 3 both fail their measured travel', () => {
    expect(effectiveOverscan(1, 2.41)).toBe(3);  // measured: overscan 1 blanked 12/1787
    expect(effectiveOverscan(3, 3.89)).toBe(4);  // measured: overscan 3 blanked 74/605
  });
});

describe('slot mapping', () => {
  it('assigns slots in DATA order from first, not modulo the pool', () => {
    expect(slotForIndex(103, 100, 8)).toBe(3);
    expect(indexForSlot(3, 100)).toBe(103);
  });
  it('reports -1 for an index outside the pooled window', () => {
    expect(slotForIndex(99, 100, 8)).toBe(-1);
    expect(slotForIndex(108, 100, 8)).toBe(-1);
  });
});

describe('UIEntries.prefabs is visible to the BUILD (#53 class)', () => {
  it('collectResourceRefsFromEntities emits a prefab ref per entry kind', async () => {
    const { collectResourceRefsFromEntities } = await import('../../src/runtime/loaders/loadSceneFile');
    // A GUID nested inside an ARRAY of objects — REF_FIELDS_BY_TRAIT is scalar-only, so this
    // is reachable only via the explicit handler. Without it the entry prefab reaches the
    // manifest through nothing and the view renders empty in production while dev, which
    // serves every file off disk, looks perfect.
    const refs = collectResourceRefsFromEntities([{
      traits: {
        UIEntries: {
          prefabs: JSON.stringify([
            { name: 'tile', prefab: '11111111-1111-4111-8111-111111111111' },
            { name: 'header', prefab: '22222222-2222-4222-8222-222222222222' },
          ]),
        },
      },
    }]);
    const prefabRefs = refs.filter(r => r.type === 'prefab').map(r => r.path).sort();
    expect(prefabRefs).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ]);
  });

  it('tolerates a malformed kinds list rather than throwing during scene load', () => {
    // Authored JSON is not trusted input: a half-written entry must not break the whole scene.
    expect(async () => {
      const { collectResourceRefsFromEntities } = await import('../../src/runtime/loaders/loadSceneFile');
      collectResourceRefsFromEntities([{ traits: { UIEntries: { prefabs: '[null, {}, {"name":"x"}, not json' } } } as never]);
    }).not.toThrow();
  });
});

describe('planSlots', () => {
  const strip = (over: Partial<AxisInput> = {}) => computeAxisWindow(axis(over));
  const single = computeAxisWindow({ scroll: 0, viewport: 1, entrySize: 1, gap: 0, count: 1, overscan: 0 });

  it('assigns a vertical strip in reading order, slot 0 at the window top', () => {
    const yw = strip({ count: 100, viewport: 240, entrySize: 120, overscan: 1 });
    const plan = planSlots(single, yw, 1, 100);
    expect(plan).toHaveLength(yw.pooled);
    expect(plan[0]).toMatchObject({ slot: 0, y: yw.first, live: true });
    expect(plan[1].y).toBe(yw.first + 1);
  });

  it('rises across then down for a grid, matching DOM child order', () => {
    const xw = computeAxisWindow({ scroll: 0, viewport: 300, entrySize: 100, gap: 0, count: 10, overscan: 0 });
    const yw = computeAxisWindow({ scroll: 0, viewport: 200, entrySize: 100, gap: 0, count: 10, overscan: 0 });
    const plan = planSlots(xw, yw, 10, 10);
    // First row is (0,0),(1,0),… then the second row starts.
    expect(plan.slice(0, xw.pooled).map(p => p.x)).toEqual([...Array(xw.pooled).keys()]);
    expect(plan[xw.pooled].y).toBe(1);
    expect(plan[xw.pooled].x).toBe(0);
  });

  it('computes index as y*countX + x', () => {
    const xw = computeAxisWindow({ scroll: 0, viewport: 300, entrySize: 100, gap: 0, count: 5, overscan: 0 });
    const yw = computeAxisWindow({ scroll: 0, viewport: 200, entrySize: 100, gap: 0, count: 5, overscan: 0 });
    const plan = planSlots(xw, yw, 5, 5);
    const at = plan.find(p => p.x === 2 && p.y === 1)!;
    expect(at.index).toBe(7);
  });

  it('RETURNS the over-covering slots as parked rather than omitting them', () => {
    // A pool over-covers the end of the data routinely. Omitting those slots is how a stale
    // entry stays on screen showing the previous page's content.
    const yw = computeAxisWindow({ scroll: 0, viewport: 600, entrySize: 120, gap: 0, count: 3, overscan: 2 });
    const plan = planSlots(single, yw, 1, 3);
    expect(plan).toHaveLength(yw.pooled);
    expect(plan.filter(p => !p.live).length).toBe(yw.pooled - 3);
    expect(plan.filter(p => !p.live).every(p => p.index === -1)).toBe(true);
  });
});
