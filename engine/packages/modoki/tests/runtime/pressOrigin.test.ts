/** pressOrigin unit tests (#664) — a click's bindings must fire only when BOTH the press and the
 *  release that produced it began on the same interactive node. Built against real DOM nodes and
 *  dispatched pointer events (see `pressOrigin.ts`'s module doc for the rule and why fail-open is
 *  deliberate). */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { UI_PRESS_ORIGIN_ATTR, UI_TAP_ZONE_ATTR, installPressOriginTracking, pressBelongsTo, clearPressOrigin, resolveTapZoneVeto } from '../../src/runtime/ui/pressOrigin';

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

// ── #977: a tap zone must LOSE to real content underneath it ──
//
// `UIElement.minTapSize` emits a transparent expander that sits at the PARENT's z-order among its
// SIBLINGS, so it takes presses inside any overlap. The rule is that a MINIMUM courtesy area loses
// to anything that would have handled the press itself, and wins everywhere else.
//
// ⚠️ **The decision is tested as a pure function, on purpose.** jsdom has no layout, so
// `document.elementsFromPoint` answers nothing there — a test that drove the real DOM path would be
// feeding the resolver a stack it invented and then asserting the invention. The wiring (that the
// stack really comes from the hit point, and that the replacement click reaches the neighbour's
// binding) needs a real browser and lives in `engine/tests/e2e/press-origin.spec.ts`.
describe('resolveTapZoneVeto (#977)', () => {
  /** `<root data-press-origin><host data-press-origin><zone data-tap-zone/></host><neighbour/></root>`
   *
   *  ⚠️ **The ROOT is interactive on purpose, and an earlier version of this helper left it plain.**
   *  Every one of Court's 16 authored `minTapSize` controls is a `*Close` or pager button inside a
   *  panel carrying `swallowClicks` — which `UINode.tsx` turns into `data-press-origin` — so a bare
   *  root models a shape NO shipping scene has. With it, `closest` on a decorative neighbour
   *  resolves to `null` and the accept-side cases pass under a correct implementation *and* under
   *  the ancestor bug that deleted every pad. This one attribute is the difference. */
  function build(neighbourInteractive: boolean, neighbourChild = false) {
    const root = document.createElement('div');
    root.setAttribute(UI_PRESS_ORIGIN_ATTR, '');
    const host = document.createElement('div');
    host.setAttribute(UI_PRESS_ORIGIN_ATTR, '');
    const zone = document.createElement('div');
    zone.setAttribute(UI_TAP_ZONE_ATTR, '');
    host.appendChild(zone);
    const neighbour = document.createElement('div');
    if (neighbourInteractive) neighbour.setAttribute(UI_PRESS_ORIGIN_ATTR, '');
    const inner = document.createElement('span');
    neighbour.appendChild(inner);
    root.append(host, neighbour);
    document.body.appendChild(root);
    return { root, host, zone, neighbour, hit: neighbourChild ? inner : neighbour };
  }

  it('hands the press to an interactive neighbour under the point', () => {
    const { zone, hit } = build(true);
    expect(resolveTapZoneVeto([zone, hit], zone)).toBe(hit);
  });

  it('dispatches on the element the browser would have hit, not on its interactive ancestor', () => {
    const { zone, hit, neighbour } = build(true, true);
    // `hit` is a plain <span> inside the interactive neighbour. Returning the ANCESTOR would skip
    // any handler bound between them, so the browser's own target is what gets handed back.
    const got = resolveTapZoneVeto([zone, hit], zone);
    expect(got).toBe(hit);
    expect(got).not.toBe(neighbour);
  });

  // ⚠️ THE ACCEPT SIDE. A zone overhanging DECORATION is the normal, intended use of minTapSize —
  // if this starts returning a veto, every enlarged tap target silently stops working, and that is
  // a far worse regression than the one being fixed. Proving a guard rejects never proves it
  // accepts.
  it('keeps the press when the neighbour underneath is decorative', () => {
    const { zone, hit } = build(false);
    expect(resolveTapZoneVeto([zone, hit], zone)).toBeNull();
  });

  it('keeps the press over empty space — nothing under the point at all', () => {
    const { zone } = build(false);
    expect(resolveTapZoneVeto([zone], zone)).toBeNull();
  });

  it("never loses to its OWN host — a zone must not veto the control it belongs to", () => {
    const { zone, host } = build(true);
    // Inside the host's own box the first non-zone entry is the host itself.
    expect(resolveTapZoneVeto([zone, host], zone)).toBeNull();
  });

  it('skips a SECOND overlapping zone rather than handing the press to its host', () => {
    const { zone, hit } = build(true);
    const other = document.createElement('div');
    other.setAttribute(UI_TAP_ZONE_ATTR, '');
    const otherHost = document.createElement('div');
    otherHost.setAttribute(UI_PRESS_ORIGIN_ATTR, '');
    otherHost.appendChild(other);
    document.body.appendChild(otherHost);
    // Two zones stacked over one real control: zones are not handlers, so the real control wins.
    expect(resolveTapZoneVeto([zone, other, hit], zone)).toBe(hit);
  });

  // ⚠️ The regression that matters most: with an interactive ANCESTOR (a dialog root, a
  // swallowClicks panel) the owner resolves UP past the decorative container to that ancestor. It is
  // not "someone else" — it would receive the click by bubbling anyway — so the zone must keep the
  // press. Without this, every pad in the repo vetoed to its own panel root and was swallowed.
  it('keeps the press when the owner underneath is an ANCESTOR of the host', () => {
    const { zone, root } = build(false);
    // `root` is interactive and contains the host; the decorative neighbour resolves to it.
    const decorChild = document.createElement('span');
    root.appendChild(decorChild);
    expect(resolveTapZoneVeto([zone, decorChild], zone)).toBeNull();
  });

  it('stops at the first non-zone entry — it does not look PAST decoration for something interactive', () => {
    const { zone, host } = build(false);
    const decor = document.createElement('div');
    const buried = document.createElement('div');
    buried.setAttribute(UI_PRESS_ORIGIN_ATTR, '');
    document.body.append(decor, buried);
    // The decoration was legitimately covering `buried`; handing the press past it would give the
    // press to a control the user could not see or reach.
    expect(resolveTapZoneVeto([zone, decor, buried], zone)).toBeNull();
    expect(host).toBeTruthy();
  });
});

// ── #977: the redirect must belong to the gesture that vetoed ──
//
// `resolveTapZoneVeto` above is the DECISION; this is the PLUMBING that spends it. jsdom has no
// layout, so `document.elementsFromPoint` is stubbed — that fakes the BROWSER's hit test, not the
// mechanism under test, which is whether the click is matched back to its own press.
describe('tap-zone redirect is gesture-scoped (#977)', () => {
  let dispose: () => void;
  let zone: HTMLElement;
  let neighbour: HTMLElement;
  let elsewhere: HTMLElement;
  let neighbourClicks: number;

  beforeEach(() => {
    const root = document.createElement('div');
    root.setAttribute(UI_PRESS_ORIGIN_ATTR, '');
    const host = document.createElement('div');
    host.setAttribute(UI_PRESS_ORIGIN_ATTR, '');
    zone = document.createElement('div');
    zone.setAttribute(UI_TAP_ZONE_ATTR, '');
    host.appendChild(zone);
    neighbour = document.createElement('div');
    neighbour.setAttribute(UI_PRESS_ORIGIN_ATTR, '');
    elsewhere = document.createElement('div');
    root.append(host, neighbour, elsewhere);
    document.body.appendChild(root);

    neighbourClicks = 0;
    neighbour.addEventListener('click', () => { neighbourClicks++; });
    (document as unknown as { elementsFromPoint: unknown }).elementsFromPoint = () => [zone, neighbour];
    dispose = installPressOriginTracking(document);
  });
  // The stub is on `document` and outlives the test that set it — restore it, or the next suite
  // appended below inherits a hit-test pointing at detached elements.
  const realElementsFromPoint = (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint;
  afterEach(() => {
    dispose();
    document.body.innerHTML = '';
    (document as unknown as { elementsFromPoint: unknown }).elementsFromPoint = realElementsFromPoint;
  });

  const click = (el: Element) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

  it('redirects when press AND release both land in the zone', () => {
    firePointer('pointerdown', zone);
    firePointer('pointerup', zone);
    click(zone);
    expect(neighbourClicks).toBe(1);
  });

  // ⚠️ The hazard this closes. Reading the veto alone hijacked ANY click while one was held: press
  // in the overlap, drag away, release elsewhere — the browser fires click on the common ancestor,
  // the redirect fired the neighbour's binding, and because the redirect nulls the press pair
  // `pressBelongsTo` then failed OPEN. That is the drag #664 exists to reject, with its only gate
  // removed.
  it('does NOT redirect when the release landed outside the zone', () => {
    firePointer('pointerdown', zone);
    firePointer('pointerup', elsewhere);
    click(elsewhere);
    expect(neighbourClicks).toBe(0);
  });

  // ⚠️ **The cancel lands ON THE ZONE, and that is the whole point of this test.** A touch pointer
  // takes implicit pointer capture on its `pointerdown` target, so `pointercancel` is dispatched
  // there — not somewhere else. An earlier version of this test fired it at `elsewhere`, which is
  // the release-mismatch path the test above already covers, so it went green while the real shape
  // left a spendable veto for the next pointer-less click (a screen-reader activation, or any
  // `element.click()`). Measured with a scratch probe before this was fixed: 1 redirect, expected 0.
  it('does NOT let a CANCELLED touch gesture leave a veto for a later click', () => {
    firePointer('pointerdown', zone);
    firePointer('pointercancel', zone);   // implicit capture — the real browser shape
    click(elsewhere);
    expect(neighbourClicks).toBe(0);
  });
});
