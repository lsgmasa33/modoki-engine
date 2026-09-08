/** `useScrollAnchoring`'s gesture guard (#579) — the deferred `restore()` must not fight a live
 *  touch/drag, and must not be silently defeated by `scheduleResync` re-baselining the anchor onto
 *  the CURRENT (already-drifted) position while the restore is deferred.
 *
 *  Adapted from an `opus-reviewer` close-out probe that found both defects live in this exact
 *  harness (jsdom + `@testing-library/react`, a fake `ResizeObserver`, and hand-stubbed geometry —
 *  the file's own header argues the HOOK is untestable; the DECISIONS underneath it, driven this
 *  way, are not). Two things this file exists to pin, found in review, NOT by construction:
 *
 *  1. Tracking a gesture via `pointerdown`/`pointerup`/`pointercancel` alone is wrong for TOUCH:
 *     once this box lets the browser scroll it natively, the browser reclaims the touch as a pan
 *     within the first few px and fires `pointercancel` — ending the tracked "gesture" while the
 *     player's finger is still down and the mutation that actually races `restore()` is still to
 *     come. `pointerSource.ts`'s own doc already states this fact for the game canvas, which avoids
 *     it entirely via `touch-action:'none'` — a scroll box cannot do that and still scroll.
 *  2. Even with the gesture correctly tracked, the FIRST cut of the deferral left `state.contentSize`
 *     stale while a restore was pending, so the next native `scroll` event (a completely normal part
 *     of an ongoing drag) failed `isIntentfulScroll` and called `scheduleResync`, which rebaselined
 *     the anchor onto the box's CURRENT (wrong) position — so the eventual deferred `restore()` found
 *     nothing to correct. A deferred correction that gets silently cancelled is worse than no
 *     deferral at all: it reads as "fixed" until the exact gesture shape that triggers it.
 */
// @vitest-environment jsdom

import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, act } from '@testing-library/react';
import { useScrollAnchoring } from '../../src/runtime/ui/scrollAnchor';

const ROW = 60;
const VIEWPORT = 200;

class FakeResizeObserver {
  observe(): void {}
  disconnect(): void {}
}

/** Stamps jsdom's layout getters onto a fake list-box: `ROW`-tall rows, `VIEWPORT`-tall viewport,
 *  `scrollTop` clamped like a real browser. Re-run after the child count changes. */
function stubGeometry(box: HTMLDivElement): () => void {
  Object.defineProperty(box, 'clientHeight', { configurable: true, get: () => VIEWPORT });
  Object.defineProperty(box, 'clientWidth', { configurable: true, get: () => 0 });
  Object.defineProperty(box, 'scrollWidth', { configurable: true, get: () => 0 });
  Object.defineProperty(box, 'scrollHeight', { configurable: true, get: () => box.children.length * ROW });
  let top = 0;
  Object.defineProperty(box, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => { top = Math.max(0, Math.min(v, box.children.length * ROW - VIEWPORT)); },
  });
  const stamp = () => {
    Array.from(box.children).forEach((c, i) => {
      Object.defineProperty(c, 'offsetTop', { configurable: true, get: () => i * ROW });
      Object.defineProperty(c, 'offsetHeight', { configurable: true, get: () => ROW });
      Object.defineProperty(c, 'offsetLeft', { configurable: true, get: () => 0 });
      Object.defineProperty(c, 'offsetWidth', { configurable: true, get: () => 0 });
    });
  };
  return stamp;
}

function Harness({ onReady }: { onReady: (el: HTMLDivElement) => void }) {
  const [el, setEl] = React.useState<HTMLDivElement | null>(null);
  useScrollAnchoring(true, el);
  React.useEffect(() => { if (el) onReady(el); }, [el, onReady]);
  return (
    <div ref={setEl}>
      {Array.from({ length: 10 }, (_, i) => <div key={i}>row {i}</div>)}
    </div>
  );
}

describe('useScrollAnchoring — the gesture guard (#579)', () => {
  let box!: HTMLDivElement;
  let stamp!: () => void;

  const settle = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

  /** React does not own this removal; it stands in for a store row unmounting
   *  (`syncStoreChrome` toggling `UIElement.isVisible` on a purchase/price-fetch event). */
  const removeTopRow = async () => {
    box.removeChild(box.children[0]);
    stamp();
    await settle();
  };

  beforeEach(async () => {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
    // Deterministic stand-in, not a timing claim: maps to the same 0ms macrotask `settle()` already
    // waits on, so every existing scroll-then-settle in this file also flushes the deferred snapshot
    // without needing to guess jsdom's own rAF cadence.
    (globalThis as unknown as { requestAnimationFrame: (cb: FrameRequestCallback) => number })
      .requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0) as unknown as number;
    (globalThis as unknown as { cancelAnimationFrame: (id: number) => void })
      .cancelAnimationFrame = (id) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
    vi.useRealTimers();
    let captured: HTMLDivElement | null = null;
    const onReady = (el: HTMLDivElement) => { captured = el; };
    await act(async () => { render(<Harness onReady={onReady} />); });
    box = captured!;
    stamp = stubGeometry(box);
    stamp();
    // The hook's seed ran against jsdom's 0x0 box; one scroll + one macrotask re-baselines
    // `contentSize` through `scheduleResync` first, and only THEN does the scroll that must be
    // remembered as the anchor happen — matching `syncFlow`'s own seed-before-remember ordering.
    await act(async () => { box.dispatchEvent(new Event('scroll')); });
    await settle();
    await act(async () => { box.scrollTop = 300; box.dispatchEvent(new Event('scroll')); });
    await settle();
    expect(box.scrollTop).toBe(300);
  });

  it('CONTROL — no gesture: the #531 correction lands (300 -> 240)', async () => {
    await removeTopRow();
    expect(box.scrollTop).toBe(240);
  });

  it('restore() flushes a still-pending deferred snapshot rather than reading stale candidates (found in review of #579 follow-up — MutationObserver is a microtask and beats requestAnimationFrame)', async () => {
    // A FRESH scroll whose snapshot flush is still pending (no settle yet) — then a content
    // mutation lands before that rAF has any chance to fire. Without a flush at the top of
    // `restore()`, it would read `state.candidates` from the OLD scroll position (300, from
    // `beforeEach`) against the NEW `rawOffset` (120) it was just given — restoring to the wrong
    // place. Row index 3 sits BELOW the new anchor (row 2, which starts exactly at 120), so
    // removing it must not move the box at all.
    await act(async () => {
      box.scrollTop = 120;
      box.dispatchEvent(new Event('scroll'));
      box.removeChild(box.children[3]);
      stamp();
    });
    await settle();
    expect(box.scrollTop, 'removing a row below the anchor must not move the box').toBe(120);
  });

  it('a mouse drag defers the correction, and it STILL LANDS at release even with a scroll event in between (finding: scheduleResync must not clobber a pending restore)', async () => {
    await act(async () => { box.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' })); });
    await removeTopRow();
    expect(box.scrollTop, 'deferred — must not fight the live drag').toBe(300);
    // The player keeps dragging: a genuine scroll event lands before the finger lifts. This is
    // the exact event that used to make `scheduleResync` overwrite the pending anchor.
    await act(async () => { box.scrollTop = 305; box.dispatchEvent(new Event('scroll')); });
    await settle();
    await act(async () => { window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse' })); });
    await settle();
    expect(box.scrollTop, 'the deferred correction must still apply at release, not silently vanish').toBe(240);
  });

  it('a touch drag survives the browser reclaiming the pan (touch pointercancel must NOT disarm a touch-tracked gesture)', async () => {
    await act(async () => { box.dispatchEvent(new Event('touchstart', { bubbles: true })); });
    // The browser takes over the pan almost immediately on a real scroll box and fires this —
    // for a TOUCH pointer specifically, it must be ignored by the gesture guard.
    await act(async () => { window.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerType: 'touch' })); });
    await removeTopRow();
    expect(box.scrollTop, 'still deferred — the touch pointercancel must not have ended the gesture').toBe(300);
    await act(async () => { window.dispatchEvent(new Event('touchend', { bubbles: true })); });
    await settle();
    expect(box.scrollTop, 'correction applies once the finger genuinely lifts').toBe(240);
  });

  it('a tap on a ROW arms the guard too (the start listener bubbles)', async () => {
    await act(async () => { box.children[3].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' })); });
    await removeTopRow();
    expect(box.scrollTop, 'deferred, not applied').toBe(300);
  });

  it('does not read child layout geometry synchronously inside the scroll callback (WebKit compositor-stall fix)', async () => {
    let reads = 0;
    let readsAtDispatchReturn = -1;
    Array.from(box.children).forEach((c, i) => {
      Object.defineProperty(c, 'offsetTop', { configurable: true, get: () => { reads += 1; return i * ROW; } });
    });
    await act(async () => {
      box.scrollTop = 250;
      box.dispatchEvent(new Event('scroll'));
      // Read the counter INSIDE the same act callback, before any microtask/macrotask runs — this
      // is the synchronous continuation of the scroll dispatch, exactly the window that must stay
      // read-free.
      readsAtDispatchReturn = reads;
    });
    expect(readsAtDispatchReturn, 'no child geometry read synchronously inside the scroll callback').toBe(0);
    await settle();
    expect(reads, 'the deferred flush eventually reads the child geometry it needs').toBeGreaterThan(0);
  });

  it('a genuine mouse pointercancel still ends the gesture immediately — this is deliberate, not the touch bug', async () => {
    await act(async () => { box.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' })); });
    await act(async () => { window.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerType: 'mouse' })); });
    await settle();
    await removeTopRow();
    expect(box.scrollTop, 'a real (non-touch) cancel is a real end of gesture').toBe(240);
  });
});
