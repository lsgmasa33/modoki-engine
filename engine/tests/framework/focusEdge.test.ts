/** #1879: the focus-GAIN edge that applies held outside changes. Owner, 2026-09-30: "Editor must lose the focus and gain
 *  it again to trigger the reload." Driven with a fake `hasFocus` and a manual scheduler, so the settle is explicit.
 *  Mutations, measured: drop the settle re-check of `hasFocus()` in `blur` → "a blur that a focus follows at once" alone;
 *  drop `if (focused) return` in `focus` → every case with a focus and no loss before it (4 of 5); drop the settle
 *  cancel in `focus` → "a blur whose settle runs after the focus" alone; `isFocused` read from the edge's state
 *  (`focused && hasFocus()`) → "isFocused reads the document live" alone. */
import { describe, it, expect } from 'vitest';
import { createFocusEdge, SETTLE_MS } from '../../app/debug/focusEdge';

function rig(initiallyFocused: boolean) {
  let has = initiallyFocused;
  const queued: { fn: () => void; ms: number; live: boolean }[] = [];
  let gains = 0;
  const edge = createFocusEdge({
    hasFocus: () => has,
    schedule: (fn, ms) => { const q = { fn, ms, live: true }; queued.push(q); return () => { q.live = false; }; },
    onGain: () => { gains++; },
  });
  return {
    edge,
    set: (v: boolean) => { has = v; },
    settle: () => { for (const q of queued.splice(0)) if (q.live) q.fn(); },
    gains: () => gains,
    delays: () => queued.map((q) => q.ms),
  };
}

describe('createFocusEdge', () => {
  it('a loss then a gain fires once', () => {
    const r = rig(true);
    r.set(false); r.edge.blur();
    expect(r.delays()).toEqual([SETTLE_MS]);
    r.settle();
    expect(r.edge.isFocused()).toBe(false);
    r.set(true); r.edge.focus();
    expect(r.gains()).toBe(1);
    r.edge.focus();
    expect(r.gains(), 'a second focus with no loss between').toBe(1);
  });

  it('focus while focused fires nothing: working in the editor never refreshes', () => {
    const r = rig(true);
    r.edge.focus();
    r.edge.focus();
    expect(r.gains()).toBe(0);
  });

  it('a blur that a focus follows at once (a move inside the page) is no loss', () => {
    const r = rig(true);
    r.edge.blur(); // hasFocus stays true: focus moved within the document
    r.settle();
    r.edge.focus();
    expect(r.gains()).toBe(0);
  });

  it('a blur whose settle runs after the focus is no loss', () => {
    const r = rig(true);
    r.set(false); r.edge.blur();
    r.set(true); r.edge.focus(); // back before the settle ran
    r.set(false); r.settle(); // a stale settle must not count this as a loss
    r.set(true); r.edge.focus();
    expect(r.gains()).toBe(0);
  });

  it('isFocused reads the document live: a launch with no focus event still counts a window that is in front (review U5)', () => {
    const r = rig(false);
    r.set(true); // the window came to the front with no focus event this edge saw
    expect(r.edge.isFocused()).toBe(true);
  });

  it('an editor that starts unfocused counts its first focus as a gain (a human arriving at an agent-launched editor)', () => {
    const r = rig(false);
    expect(r.edge.isFocused()).toBe(false);
    r.set(true); r.edge.focus();
    expect(r.gains()).toBe(1);
  });
});
