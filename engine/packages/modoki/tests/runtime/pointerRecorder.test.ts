/** Input WATCH producer (#134) — `runtime/input/pointerRecorder.ts`.
 *
 *  The bug this module exists for is a press that resolved to NOTHING, so the tests that matter
 *  most are the ones about absence: that a closed window records nothing and attaches nothing,
 *  that "an authority looked and found nothing" stays distinguishable from "nobody could look",
 *  and that a press swallowed by a block root still leaves a record naming the culprit.
 *
 *  Wall-clock is pinned through `core/clock.ts` so `heldMs` is an exact assertion rather than a
 *  tolerance — the recorder reads `rawNow()` for exactly this reason. */
// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  startInputWatch, stopInputWatch, readInputPresses, clearInputPresses,
  isInputWatchOpen, noteInputResolution, __resetInputRecorder,
} from '../../src/runtime/input/pointerRecorder';
import { registerPointerBlocker, clearPointerBlockers } from '../../src/runtime/core/pointerBlockers';
import { registerPickProvider } from '../../src/runtime/core/screenPick';
import { setManualNow, advanceManual, restoreRealClock } from '../../src/runtime/core/clock';

type Pointerish = MouseEvent & { pointerId: number; pointerType: string; isPrimary: boolean };

function pointerEvent(type: string, x: number, y: number, opts: { pointerId?: number; pointerType?: string; isPrimary?: boolean } = {}): Pointerish {
  const ev = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }) as Pointerish;
  Object.assign(ev, {
    pointerId: opts.pointerId ?? 1,
    pointerType: opts.pointerType ?? 'touch',
    isPrimary: opts.isPrimary ?? true,
  });
  return ev;
}

function press(target: EventTarget, from: [number, number], to: [number, number] = from, opts: { id?: number; moves?: number; holdMs?: number; end?: 'up' | 'cancel' | 'none' } = {}): void {
  const id = opts.id ?? 1;
  target.dispatchEvent(pointerEvent('pointerdown', from[0], from[1], { pointerId: id }));
  const steps = opts.moves ?? 0;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    target.dispatchEvent(pointerEvent('pointermove', from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, { pointerId: id }));
  }
  if (opts.holdMs) advanceManual(opts.holdMs);
  if (opts.end === 'none') return;
  target.dispatchEvent(pointerEvent(opts.end === 'cancel' ? 'pointercancel' : 'pointerup', to[0], to[1], { pointerId: id }));
}

beforeEach(() => {
  setManualNow(1000);
  document.body.innerHTML = '';
});

afterEach(() => {
  __resetInputRecorder();
  clearPointerBlockers();
  restoreRealClock();
  document.body.innerHTML = '';
});

describe('gating — closed is free, not cheap', () => {
  it('records nothing, and has no history, before the window opens', () => {
    press(document.body, [10, 10], [20, 20], { moves: 3 });
    expect(isInputWatchOpen()).toBe(false);
    expect(readInputPresses().presses).toEqual([]);

    // The @contact contract: opening captures from HERE, never retroactively.
    startInputWatch();
    expect(readInputPresses().totalCount).toBe(0);
  });

  it('detaches on stop, and KEEPS what it recorded', () => {
    startInputWatch();
    press(document.body, [5, 5]);
    stopInputWatch();
    press(document.body, [99, 99]);

    const r = readInputPresses();
    expect(r.open).toBe(false);
    expect(r.presses).toHaveLength(1);
    expect(r.presses[0].x).toBe(5);
  });

  it('reports a re-open rather than silently treating it as a fresh start', () => {
    startInputWatch();
    press(document.body, [1, 1]);
    const again = startInputWatch();
    // A caller who assumed a fresh ring would read the earlier press as its own probe's.
    expect(again.alreadyOpen).toBe(true);
    expect(again.recorded).toBe(1);
  });
});

describe('the fields that separated the hypotheses', () => {
  it('records travel, move-sample count and hold duration', () => {
    startInputWatch();
    press(document.body, [100, 100], [100, 200], { moves: 8, holdMs: 1216 });

    const [p] = readInputPresses().presses;
    expect(p.moves).toBe(8);
    expect(p.maxD).toBeCloseTo(100, 6);
    expect(p.heldMs).toBe(1216);
    expect(p.ended).toBe('up');
    expect(p.x).toBe(100);
    expect(p.upY).toBe(200);
  });

  it('reports the GREATEST travel, not the final displacement', () => {
    // A drag that goes far and returns is not a tap, however close the release lands to the press.
    startInputWatch();
    document.body.dispatchEvent(pointerEvent('pointerdown', 0, 0));
    document.body.dispatchEvent(pointerEvent('pointermove', 0, 300));
    document.body.dispatchEvent(pointerEvent('pointerup', 1, 1));

    const [p] = readInputPresses().presses;
    expect(p.maxD).toBeCloseTo(300, 6);
    expect(Math.hypot(p.upX - p.x, p.upY - p.y)).toBeCloseTo(Math.SQRT2, 6);
  });

  it('keeps an unreleased press visible as in-flight, with the time held so far', () => {
    startInputWatch();
    press(document.body, [7, 7], [7, 7], { end: 'none' });
    advanceManual(8000);

    const [p] = readInputPresses().presses;
    expect(p.ended).toBe('open');
    expect(p.heldMs).toBe(8000);
  });

  it('records a cancel distinctly from a release', () => {
    startInputWatch();
    press(document.body, [3, 3], [3, 3], { end: 'cancel' });
    expect(readInputPresses().presses[0].ended).toBe('cancel');
  });
});

describe('resolution — "could not look" is not "nothing is there"', () => {
  it('says UNKNOWN, with a reason, when no authority can answer', () => {
    startInputWatch();
    press(document.body, [50, 50]);

    const r = readInputPresses().presses[0].resolved;
    expect(r.by).toBe('unknown');
    if (r.by === 'unknown') expect(r.reason).toMatch(/noteInputResolution/);
  });

  it('says NONE — naming who looked — when a pick provider answers "nothing there"', () => {
    const un = registerPickProvider(() => null, 'game-3d');
    try {
      startInputWatch();
      press(document.body, [50, 50]);
      const r = readInputPresses().presses[0].resolved;
      expect(r.by).toBe('none');
      if (r.by === 'none') expect(r.checked).toContain('pick');
    } finally { un(); }
  });

  it('reports the entity a pick provider hit, and which surface answered', () => {
    const un = registerPickProvider((x) => (x > 40 ? 77 : null), 'game-3d');
    try {
      startInputWatch();
      press(document.body, [50, 50]);
      const r = readInputPresses().presses[0].resolved;
      expect(r).toEqual({ by: 'pick', entityId: 77, surface: 'game-3d' });
    } finally { un(); }
  });

  it('resolves a press on a UI node to its entity id', () => {
    const btn = document.createElement('button');
    btn.setAttribute('data-entity-id', '42');
    document.body.appendChild(btn);

    startInputWatch();
    press(btn, [10, 10]);
    expect(readInputPresses().presses[0].resolved).toEqual({ by: 'ui', entityId: 42 });
  });

  it("lets the game's own hit-test override the engine's fallback", () => {
    const un = registerPickProvider(() => 5, 'game-2d');
    try {
      startInputWatch();
      document.body.dispatchEvent(pointerEvent('pointerdown', 192, 572));
      noteInputResolution({ kind: 'tray-badge', id: 'rook', label: 'Rook' });
      document.body.dispatchEvent(pointerEvent('pointerup', 192, 572));

      expect(readInputPresses().presses[0].resolved).toEqual({ by: 'game', kind: 'tray-badge', id: 'rook', label: 'Rook' });
    } finally { un(); }
  });

  it('accepts a resolution that arrives AFTER the press was already released', () => {
    // The real timing: a game hit-tests from a SYSTEM, on the next frame — so a quick tap is over
    // and finalized before the game ever looks at it. Attaching by "what is in flight" would have
    // filed this under the drop target instead of the press.
    startInputWatch();
    press(document.body, [192, 572]);
    noteInputResolution({ kind: 'tray-badge', id: 'rook' });

    expect(readInputPresses().presses[0].resolved).toEqual({ by: 'game', kind: 'tray-badge', id: 'rook' });
  });

  it('claims presses in order when several are awaiting a frame-late resolution', () => {
    startInputWatch();
    press(document.body, [10, 10], [10, 10], { id: 1 });
    press(document.body, [20, 20], [20, 20], { id: 2 });
    // The game catches up a frame later, in gesture order.
    noteInputResolution({ kind: 'cell', id: 'first' });
    noteInputResolution({ kind: 'cell', id: 'second' });

    const [a, b] = readInputPresses().presses;
    expect(a.x).toBe(10);
    expect(a.resolved).toEqual({ by: 'game', kind: 'cell', id: 'first' });
    expect(b.resolved).toEqual({ by: 'game', kind: 'cell', id: 'second' });
  });

  it('records an explicit game MISS as "none", not as silence', () => {
    startInputWatch();
    document.body.dispatchEvent(pointerEvent('pointerdown', 192, 572));
    noteInputResolution(null);
    document.body.dispatchEvent(pointerEvent('pointerup', 192, 572));

    expect(readInputPresses().presses[0].resolved).toEqual({ by: 'none', checked: ['game'] });
  });

  it('lands a post-release hit-test in dropResolved, leaving the press resolution intact', () => {
    // Court's shape: hitTest at press (the grab) and again at release (the drop target). The
    // release-time call runs in the BUBBLE phase, after this module has already finalized.
    startInputWatch();
    document.body.dispatchEvent(pointerEvent('pointerdown', 100, 100));
    noteInputResolution({ kind: 'tray-badge', id: 'rook' });
    document.body.dispatchEvent(pointerEvent('pointerup', 300, 400));
    noteInputResolution(null, 'drop'); // dropped on nothing

    const [p] = readInputPresses().presses;
    expect(p.resolved).toEqual({ by: 'game', kind: 'tray-badge', id: 'rook' });
    expect(p.dropResolved).toEqual({ by: 'none', checked: ['game'] });
  });

  it('is inert when no window is open, so a game leaves the call in permanently', () => {
    expect(() => noteInputResolution({ kind: 'cell' })).not.toThrow();
  });
});

describe('a press the game never sees must not claim a later resolution', () => {
  /** REGRESSION, found by the LIVE gate and by nothing else (#134). Four taps swallowed by
   *  Court's tutorial catcher left the resolution queue stuck at the first of them, so the fifth
   *  press's genuine `cell b1` resolution was reported against a press an overlay had eaten. Every
   *  unit test here had the game claim every press, so the FIFO never had an unclaimed entry to
   *  get stuck on — and the mis-attributed record is precisely the one an investigator chasing a
   *  missed gesture would have believed. */
  it('does not hand a blocked press the resolution of a LATER, unblocked one', () => {
    const overlay = document.createElement('div');
    overlay.id = 'catcher';
    document.body.appendChild(overlay);
    const un = registerPointerBlocker(overlay);

    try {
      startInputWatch();
      press(overlay, [256, 318], [256, 318], { id: 1 });   // swallowed — the game never sees it
      press(document.body, [100, 200], [100, 200], { id: 2 }); // reaches the game
      noteInputResolution({ kind: 'cell', id: 'b1' });

      const [swallowed, real] = readInputPresses().presses;
      expect(swallowed.blocked).toEqual({ by: 'div#catcher' });
      // The claim that cost the live run: a swallowed press reported as having hit a board cell.
      expect(swallowed.resolved).not.toMatchObject({ by: 'game' });
      expect(real.resolved).toEqual({ by: 'game', kind: 'cell', id: 'b1' });
    } finally { un(); }
  });

  it('does not hand a non-primary press a later resolution either', () => {
    // Same shape, different reason it never arrives: `pointerSource`'s primary-touch rule drops it.
    startInputWatch();
    document.body.dispatchEvent(pointerEvent('pointerdown', 5, 5, { pointerId: 9, isPrimary: false }));
    document.body.dispatchEvent(pointerEvent('pointerup', 5, 5, { pointerId: 9, isPrimary: false }));
    press(document.body, [60, 60], [60, 60], { id: 1 });
    noteInputResolution({ kind: 'tray', id: 'K#0' });

    const [ignored, real] = readInputPresses().presses;
    expect(ignored.primary).toBe(false);
    expect(ignored.resolved).not.toMatchObject({ by: 'game' });
    expect(real.resolved).toEqual({ by: 'game', kind: 'tray', id: 'K#0' });
  });

  it('expires an unclaimed press rather than letting it wait forever', () => {
    // Not blocked, but never delivered — the sim was stopped, or a host input gate was closed.
    // A game that DOES hit-test reads the press on the next frame, so a second-old entry is not
    // late, it is never coming.
    startInputWatch();
    press(document.body, [1, 1], [1, 1], { id: 1 });
    advanceManual(5000);
    press(document.body, [2, 2], [2, 2], { id: 2 });
    noteInputResolution({ kind: 'cell', id: 'a1' });

    const [stale, fresh] = readInputPresses().presses;
    expect(stale.resolved).not.toMatchObject({ by: 'game' });
    expect(fresh.resolved).toEqual({ by: 'game', kind: 'cell', id: 'a1' });
  });
});

describe('blocked presses', () => {
  it('names the block root that swallowed the press', () => {
    const overlay = document.createElement('div');
    overlay.id = 'rules-dialog';
    const inner = document.createElement('span');
    overlay.appendChild(inner);
    document.body.appendChild(overlay);
    const un = registerPointerBlocker(overlay);

    try {
      startInputWatch();
      press(inner, [12, 34]);
      const [p] = readInputPresses().presses;
      // The point alone is what `input.pointer.blocked` already gave; the culprit is the new part.
      expect(p.blocked).toEqual({ by: 'div#rules-dialog' });
      expect(p.x).toBe(12);
    } finally { un(); }
  });

  it('names the INNERMOST root when blockers nest', () => {
    const outer = document.createElement('div');
    outer.id = 'outer';
    const inner = document.createElement('div');
    inner.id = 'inner';
    const leaf = document.createElement('span');
    inner.appendChild(leaf);
    outer.appendChild(inner);
    document.body.appendChild(outer);
    const a = registerPointerBlocker(outer);
    const b = registerPointerBlocker(inner);

    try {
      startInputWatch();
      press(leaf, [1, 1]);
      expect(readInputPresses().presses[0].blocked).toEqual({ by: 'div#inner' });
    } finally { a(); b(); }
  });

  it('names an engine UI blocker by its ENTITY id, not just its tag', () => {
    // "div" is not an answer a reader can act on; `[entity=23]` can be looked up in the scene.
    const overlay = document.createElement('div');
    overlay.setAttribute('data-entity-id', '23');
    document.body.appendChild(overlay);
    const un = registerPointerBlocker(overlay);

    try {
      startInputWatch();
      press(overlay, [1, 1]);
      expect(readInputPresses().presses[0].blocked).toEqual({ by: 'div[entity=23]' });
    } finally { un(); }
  });

  it('leaves `blocked` null for a press nothing swallowed', () => {
    startInputWatch();
    press(document.body, [1, 1]);
    expect(readInputPresses().presses[0].blocked).toBeNull();
  });
});

describe('capture phase and multi-touch — seeing what the engine refuses', () => {
  it('sees a press a downstream listener stops from propagating', () => {
    const box = document.createElement('div');
    document.body.appendChild(box);
    box.addEventListener('pointerdown', (e) => e.stopPropagation());

    startInputWatch();
    press(box, [8, 9]);
    expect(readInputPresses().presses[0].x).toBe(8);
  });

  it('records a non-primary pointer the engine deliberately ignores', () => {
    startInputWatch();
    document.body.dispatchEvent(pointerEvent('pointerdown', 1, 1, { pointerId: 1 }));
    document.body.dispatchEvent(pointerEvent('pointerdown', 2, 2, { pointerId: 2, isPrimary: false }));
    document.body.dispatchEvent(pointerEvent('pointerup', 2, 2, { pointerId: 2, isPrimary: false }));
    document.body.dispatchEvent(pointerEvent('pointerup', 1, 1, { pointerId: 1 }));

    const { presses } = readInputPresses();
    expect(presses).toHaveLength(2);
    // pointerSource's primary-touch rule drops this one; without the record, "my second finger did
    // nothing" would leave no evidence at all.
    expect(presses.find((p) => p.x === 2)?.primary).toBe(false);
  });

  it('tracks concurrent pointers independently', () => {
    startInputWatch();
    document.body.dispatchEvent(pointerEvent('pointerdown', 0, 0, { pointerId: 1 }));
    document.body.dispatchEvent(pointerEvent('pointerdown', 500, 500, { pointerId: 2 }));
    document.body.dispatchEvent(pointerEvent('pointermove', 0, 60, { pointerId: 1 }));
    document.body.dispatchEvent(pointerEvent('pointerup', 0, 60, { pointerId: 1 }));
    document.body.dispatchEvent(pointerEvent('pointerup', 500, 500, { pointerId: 2 }));

    const byStart = Object.fromEntries(readInputPresses().presses.map((p) => [p.x, p]));
    expect(byStart[0].maxD).toBeCloseTo(60, 6);
    expect(byStart[500].maxD).toBe(0);
  });
});

describe('the ring is bounded', () => {
  it('drops the oldest past `max`, and says how many', () => {
    startInputWatch({ max: 3 });
    for (let i = 0; i < 5; i++) press(document.body, [i, i]);

    const r = readInputPresses();
    expect(r.returnedCount).toBe(3);
    expect(r.totalCount).toBe(5);   // everything seen…
    expect(r.dropped).toBe(2);      // …minus what the ring could not keep
    expect(r.presses.map((p) => p.x)).toEqual([2, 3, 4]);
    // Gaps in `seq` are how a reader knows it is looking at a tail, not at everything.
    expect(r.presses.map((p) => p.seq)).toEqual([3, 4, 5]);
  });

  it('clears records without closing the window, and says how many went', () => {
    startInputWatch();
    press(document.body, [1, 1]);
    press(document.body, [2, 2]);
    expect(clearInputPresses()).toBe(2);
    expect(isInputWatchOpen()).toBe(true);
    const r = readInputPresses();
    expect(r.presses).toEqual([]);
    // Cleared records are still records that HAPPENED: `totalCount` keeps counting them and they
    // move into `dropped`, so a reader can still reconcile "2 seen, 0 available".
    expect(r.totalCount).toBe(2);
    expect(r.dropped).toBe(2);
  });

  it('keeps `seq` unique across a clear, and does not drop a press still being held', () => {
    // `seq` is an identity. Rewinding it on clear let an in-flight press finalize as seq 2 while
    // the next new press also started at 1 — two records with colliding seq in one ring, which
    // breaks ordering AND "a gap means something was dropped".
    startInputWatch();
    press(document.body, [1, 1], [1, 1], { id: 1 });               // seq 1 → the ring
    press(document.body, [2, 2], [2, 2], { id: 2, end: 'none' });   // seq 2 → still held
    expect(clearInputPresses()).toBe(1); // only the RING is cleared; the held press is still live

    // Enough new presses to walk a rewound counter back ONTO the held press's seq. One is not
    // enough — the first draft of this test made a single press, reached seq 1 against a held
    // seq 2, and passed with the bug reinstated. Mutation-checked: it now fails without the fix.
    press(document.body, [3, 3], [3, 3], { id: 3 });
    press(document.body, [4, 4], [4, 4], { id: 4 });
    document.body.dispatchEvent(pointerEvent('pointerup', 2, 2, { pointerId: 2 })); // release the held one

    const seqs = readInputPresses().presses.map((p) => p.seq);
    expect(new Set(seqs).size, `seq collision: ${seqs.join(',')}`).toBe(seqs.length);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });
});
