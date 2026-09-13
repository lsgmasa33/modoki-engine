// @vitest-environment jsdom
/** Unit: `layoutSettleReport` samples REAL chrome, not FlexLayout's rendered copies (#1152).
 *
 *  The sample is keyed by `data-ui-id`. Since dock tabs are tagged, FlexLayout's offscreen tab
 *  STAMPS carry the same ids as the real tabs, so a stamp — static, parked at y≈-9960 — would
 *  overwrite the real tab's entry and hide the real tab's movement from the "is the dock mid-move?"
 *  check. jsdom has no layout, so rects are stubbed per read. */

import { describe, it, expect, beforeEach } from 'vitest';
import { layoutSettleReport } from '../../app/debug/layoutSettle';

function tabSpan(id: string, parent: Element, rectFor: () => { left: number; top: number }) {
  const el = document.createElement('span');
  el.setAttribute('data-ui-id', id);
  parent.appendChild(el);
  el.getBoundingClientRect = () => {
    const { left, top } = rectFor();
    return { left, top, width: 60, height: 14, right: left + 60, bottom: top + 14, x: left, y: top, toJSON: () => ({}) } as DOMRect;
  };
  return el;
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('layoutSettleReport', () => {
  it('a moving REAL tab reads as settling even though its static stamp shares the id', async () => {
    let reads = 0;
    tabSpan('layout.tab.console', document.body, () => ({ left: 300 + (reads++ > 0 ? 40 : 0), top: 540 }));
    const stamps = document.createElement('div');
    stamps.className = 'flexlayout__layout_tab_stamps';
    document.body.appendChild(stamps); // AFTER the real tab, so without the exclusion it wins the Map key
    tabSpan('layout.tab.console', stamps, () => ({ left: 0, top: -9864 }));

    const r = await layoutSettleReport();
    expect(r.sampled).toBe(1);
    expect(r.settling).toBe(true);
    expect(r.moved).toBe(1);
  });
});
