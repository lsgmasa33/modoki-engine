/** pressOrigin unit tests (#664) — a click's bindings must fire only when BOTH the press and the
 *  release that produced it began on the same interactive node. Built against real DOM nodes and
 *  dispatched pointer events (see `pressOrigin.ts`'s module doc for the rule and why fail-open is
 *  deliberate). */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { UI_PRESS_ORIGIN_ATTR, installPressOriginTracking, pressBelongsTo, clearPressOrigin } from '../../src/runtime/ui/pressOrigin';

/** jsdom's PointerEvent support varies by version — fall back to a plain Event carrying a
 *  `target` when it's unavailable (matches the fallback other tests in this suite use).
 *
 *  Defaults to `isPrimary: true` and `pointerId: 1` — every existing test in this file models a
 *  single real pointer, and the PointerEvent spec defaults `isPrimary` to `false` when
 *  unspecified, which would make ALL of them look like a secondary pointer and be ignored by the
 *  module's `!e.isPrimary` guard. Defect-A tests below override both explicitly to model a SECOND
 *  pointer touching down or lifting elsewhere. */
function firePointer(
  type: 'pointerdown' | 'pointerup' | 'pointercancel',
  el: Element,
  opts: { isPrimary?: boolean; pointerId?: number } = {},
) {
  const { isPrimary = true, pointerId = 1 } = opts;
  let evt: Event;
  if (typeof PointerEvent === 'function') {
    evt = new PointerEvent(type, { bubbles: true, isPrimary, pointerId } as PointerEventInit);
  } else {
    evt = new MouseEvent(type, { bubbles: true });
  }
  el.dispatchEvent(evt);
}

describe('pressOrigin', () => {
  let scrim: HTMLDivElement;
  let panel: HTMLDivElement;
  let panelChild: HTMLDivElement;
  let dispose: (() => void) | null = null;

  beforeEach(() => {
    scrim = document.createElement('div');
    scrim.setAttribute(UI_PRESS_ORIGIN_ATTR, '');
    panel = document.createElement('div');
    panel.setAttribute(UI_PRESS_ORIGIN_ATTR, '');
    panelChild = document.createElement('div');
    panel.appendChild(panelChild);
    scrim.appendChild(panel);
    document.body.appendChild(scrim);
    dispose = installPressOriginTracking(document);
  });

  afterEach(() => {
    dispose?.();
    dispose = null;
    scrim.remove();
  });

  it('press and release both on the scrim: belongs to the scrim', () => {
    firePointer('pointerdown', scrim);
    firePointer('pointerup', scrim);
    expect(pressBelongsTo(scrim)).toBe(true);
  });

  it('#664 regression: press on a descendant of the panel, release on the scrim — does not belong to the scrim', () => {
    firePointer('pointerdown', panelChild);
    firePointer('pointerup', scrim);
    expect(pressBelongsTo(scrim)).toBe(false);
  });

  it('symmetric case: press on the scrim, release inside the panel — does not belong to the scrim', () => {
    firePointer('pointerdown', scrim);
    firePointer('pointerup', panelChild);
    expect(pressBelongsTo(scrim)).toBe(false);
  });

  it('fails open when no pointer events were recorded at all', () => {
    expect(pressBelongsTo(scrim)).toBe(true);
  });

  it('pointercancel counts as the release: press then cancel inside the panel — does not belong to the scrim', () => {
    firePointer('pointerdown', panelChild);
    firePointer('pointercancel', panelChild);
    expect(pressBelongsTo(scrim)).toBe(false);
  });

  it('consumes the pair on read: a second call with no new pointer events fails open', () => {
    firePointer('pointerdown', panelChild);
    firePointer('pointerup', scrim);
    expect(pressBelongsTo(scrim)).toBe(false);
    expect(pressBelongsTo(scrim)).toBe(true);
  });

  it('refcounts installs: disposing one of two installs leaves tracking live; disposing both removes it', () => {
    const disposeSecond = installPressOriginTracking(document);

    // First disposer (from beforeEach) still leaves one install active.
    dispose?.();
    dispose = null;

    firePointer('pointerdown', panelChild);
    firePointer('pointerup', scrim);
    expect(pressBelongsTo(scrim)).toBe(false); // still tracked

    // Now remove the last install — no more listeners, so nothing is recorded and the
    // gate fails open regardless of what actually happened.
    disposeSecond();
    firePointer('pointerdown', panelChild);
    firePointer('pointerup', scrim);
    expect(pressBelongsTo(scrim)).toBe(true);
  });

  // Defect A (most serious): a second, non-primary pointer overwrote the primary pointer's
  // recorded pair, so a real tap on a button could FAIL CLOSED — the button's own click binding
  // never firing because `pressBelongsTo` reported it didn't belong to itself.
  it('#defect-A: a real press is not disrupted by a second pointer landing elsewhere between down and up', () => {
    firePointer('pointerdown', scrim, { pointerId: 1 });
    firePointer('pointerdown', panelChild, { isPrimary: false, pointerId: 2 });
    firePointer('pointerup', scrim, { pointerId: 1 });
    expect(pressBelongsTo(scrim)).toBe(true);
  });

  it('#defect-A: a real press is not disrupted by a second pointer landing elsewhere before down, interleaved release', () => {
    firePointer('pointerdown', panelChild, { isPrimary: false, pointerId: 2 });
    firePointer('pointerdown', scrim, { pointerId: 1 });
    firePointer('pointerup', scrim, { pointerId: 1 });
    firePointer('pointerup', panelChild, { isPrimary: false, pointerId: 2 });
    expect(pressBelongsTo(scrim)).toBe(true);
  });

  // Defect B: a swallowing control's click (text input / range / toggle in UINode.tsx) stops
  // propagation WITHOUT consulting `pressBelongsTo`, so `onClickSweep` (which relies on the
  // native event still bubbling to the document) never runs either. `clearPressOrigin()` is what
  // those handlers must call instead — this proves it actually clears the pair, so a later click
  // with no pointer events of its own still fails open as promised.
  it('#defect-B: clearPressOrigin() lets a later click on an unrelated node fail open', () => {
    // Simulate a swallowing control: press+release on the panel, but nothing ever calls
    // pressBelongsTo (the control's onClick stops propagation and consults nothing).
    firePointer('pointerdown', panelChild);
    firePointer('pointerup', panelChild);
    clearPressOrigin();

    // No new pointer events for this "click" — must fail open per the module's contract.
    expect(pressBelongsTo(scrim)).toBe(true);
  });

  // Defect C: the refcount used to be one module-global counter shared across every `Document`,
  // so a second document's install silently registered nothing (while claiming to be armed), and
  // disposing one document's install could leave another document's listeners registered forever.
  it('#defect-C: two documents install and dispose independently', () => {
    // A MISMATCHED pair (down on one node, up on an unrelated one) is the discriminating probe:
    // if the document's listeners are live, `pressBelongsTo` sees a genuine mismatch and returns
    // `false`; if they're NOT live (never armed, or already disposed), nothing gets recorded and
    // the gate fails open (`true`) regardless of what was dispatched. A matched pair can't tell
    // these apart — both "armed and correct" and "not armed at all" report `true`.
    const doc1 = document.implementation.createHTMLDocument('doc1');
    const doc2 = document.implementation.createHTMLDocument('doc2');
    const el1 = doc1.createElement('div');
    el1.setAttribute(UI_PRESS_ORIGIN_ATTR, '');
    const other1 = doc1.createElement('div');
    other1.setAttribute(UI_PRESS_ORIGIN_ATTR, '');
    doc1.body.appendChild(el1);
    doc1.body.appendChild(other1);
    const el2 = doc2.createElement('div');
    el2.setAttribute(UI_PRESS_ORIGIN_ATTR, '');
    const other2 = doc2.createElement('div');
    other2.setAttribute(UI_PRESS_ORIGIN_ATTR, '');
    doc2.body.appendChild(el2);
    doc2.body.appendChild(other2);

    const disposeDoc1 = installPressOriginTracking(doc1);
    const disposeDoc2 = installPressOriginTracking(doc2);

    // Both documents must be independently armed — install on doc2 must not have been skipped
    // because doc1's install already bumped a shared counter.
    firePointer('pointerdown', el1);
    firePointer('pointerup', other1);
    expect(pressBelongsTo(el1)).toBe(false); // doc1 armed: mismatch correctly detected

    firePointer('pointerdown', el2);
    firePointer('pointerup', other2);
    expect(pressBelongsTo(el2)).toBe(false); // doc2 armed independently of doc1

    // Disposing doc1's install must not touch doc2's listeners.
    disposeDoc1();

    firePointer('pointerdown', el2);
    firePointer('pointerup', other2);
    expect(pressBelongsTo(el2)).toBe(false); // doc2 still armed after doc1 disposed

    // doc1's own tracking is gone: the same mismatched dispatch now records nothing, so the gate
    // fails open instead of correctly reporting the mismatch.
    firePointer('pointerdown', el1);
    firePointer('pointerup', other1);
    expect(pressBelongsTo(el1)).toBe(true);

    disposeDoc2();
  });
});
