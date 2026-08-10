// @vitest-environment jsdom
/** Pointer input source — the mouse/touch modality of the Input seam.
 *
 *  Proves the DOM plumbing headlessly (jsdom PointerEvents → `sample` into an
 *  InputFrame → central edge derivation), and the load-bearing Android robustness
 *  property: a `pointercancel` mid-gesture ends the gesture as a clean release
 *  (down=false, a `released` edge) rather than stranding `down=true` — so a
 *  drag-to-aim that the browser tries to reclaim doesn't hang.
 *
 *  Runs in the jsdom environment (see engine/vite.config.ts). We dispatch real
 *  PointerEvents on `window`; the source tracks level state, and we derive the
 *  down-edge exactly as `inputSystem` does (`computePointerEdge`). */

import { describe, it, expect, afterEach } from 'vitest';
import { pointerSource } from '../../src/runtime/input/pointerSource';
import { createInputFrame, computePointerEdge, type InputFrame } from '../../src/runtime/core/inputActions';
import { registerPointerBlocker, clearPointerBlockers } from '../../src/runtime/core/pointerBlockers';

/** jsdom lacks a PointerEvent constructor in some versions — synthesize one that
 *  carries pointerId + clientX/clientY, dispatched as the given type. Dispatched on
 *  `target` (default `window`) so the event's `target` reflects a specific DOM node
 *  when a test needs one — e.g. to prove a registered block root swallows it. */
function firePointer(type: string, x: number, y: number, pointerId = 1, target: EventTarget = window): void {
  const ev = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }) as MouseEvent & { pointerId: number };
  (ev as { pointerId: number }).pointerId = pointerId;
  target.dispatchEvent(ev);
}

/** Sample the source into a fresh frame and derive the down-edge (as inputSystem does). */
function sampleFrame(prev: { down: boolean }): InputFrame {
  const frame = createInputFrame();
  pointerSource.sample(frame);
  computePointerEdge(frame, prev);
  return frame;
}

afterEach(() => { pointerSource.detach(); clearPointerBlockers(); });

describe('pointerSource', () => {
  it('reports down + position + drag delta across a press→drag→release', () => {
    pointerSource.attach();
    const prev = { down: false };

    // Before any input: up, at origin.
    let f = sampleFrame(prev);
    expect(f.pointer.down).toBe(false);

    // Press at (100,200): down, pressed edge, drag 0, start latched.
    firePointer('pointerdown', 100, 200);
    f = sampleFrame(prev);
    expect(f.pointer.down).toBe(true);
    expect(f.pointer.pressed).toBe(true);
    expect(f.pointer.released).toBe(false);
    expect(f.pointer.x).toBe(100);
    expect(f.pointer.y).toBe(200);
    expect(f.pointer.dragX).toBe(0);
    expect(f.pointer.dragY).toBe(0);
    expect(f.lastDevice).toBe('pointer');

    // Drag to (100,260): still down (no new edge), drag delta from the press start.
    firePointer('pointermove', 100, 260);
    f = sampleFrame(prev);
    expect(f.pointer.down).toBe(true);
    expect(f.pointer.pressed).toBe(false);
    expect(f.pointer.dragX).toBe(0);
    expect(f.pointer.dragY).toBe(60);

    // Release: up, released edge — the drained release transition reports the TRUE
    // final drag magnitude (not zeroed), matching PointerFrame's documented contract.
    firePointer('pointerup', 100, 260);
    f = sampleFrame(prev);
    expect(f.pointer.down).toBe(false);
    expect(f.pointer.released).toBe(true);
    expect(f.pointer.dragX).toBe(0);
    expect(f.pointer.dragY).toBe(60);

    // A frame AFTER the release edge has drained falls back to level state, which
    // correctly zeroes drag while up.
    f = sampleFrame(prev);
    expect(f.pointer.down).toBe(false);
    expect(f.pointer.dragX).toBe(0);
    expect(f.pointer.dragY).toBe(0);
  });

  it('treats pointercancel as a clean release (never strands down=true)', () => {
    pointerSource.attach();
    const prev = { down: false };

    firePointer('pointerdown', 50, 50);
    let f = sampleFrame(prev);
    expect(f.pointer.down).toBe(true);

    // The browser reclaims the touch for a scroll/zoom → pointercancel. Must end the
    // gesture as a release, not hang with down=true.
    firePointer('pointercancel', 50, 50);
    f = sampleFrame(prev);
    expect(f.pointer.down).toBe(false);
    expect(f.pointer.released).toBe(true);
  });

  it('the first pointer owns the gesture — a second finger cannot hijack the drag', () => {
    pointerSource.attach();
    const prev = { down: false };

    firePointer('pointerdown', 10, 10, /*pointerId*/ 1);
    // A second finger presses elsewhere; its id differs → ignored while #1 owns it.
    firePointer('pointerdown', 500, 500, /*pointerId*/ 2);
    let f = sampleFrame(prev);
    expect(f.pointer.x).toBe(10);
    expect(f.pointer.y).toBe(10);

    // Moving the SECOND finger must not move the owned pointer.
    firePointer('pointermove', 600, 600, /*pointerId*/ 2);
    f = sampleFrame(prev);
    expect(f.pointer.x).toBe(10);

    // The owner moves → tracked.
    firePointer('pointermove', 30, 40, /*pointerId*/ 1);
    f = sampleFrame(prev);
    expect(f.pointer.x).toBe(30);
    expect(f.pointer.y).toBe(40);
  });

  it('a press followed by moves BEFORE the next sample reports the press at its true down point, not the latest move', () => {
    // Regression for the bug behind Court's drag/tap-aim misses (the down/up FIFO —
    // see this module's own EDGE LATCHING banner, which docs/input.md defers to): level
    // state alone reports the pressed edge at whatever position the LATEST move left
    // it at, corrupting the down point an aim/drag-origin reads. The FIFO must report
    // the down transition's own coordinates on the frame it drains, THEN fall back to
    // level state (the latest move) on the next sample.
    pointerSource.attach();
    const prev = { down: false };

    firePointer('pointerdown', 10, 10);
    firePointer('pointermove', 200, 200); // arrives before any sample drains the down
    let f = sampleFrame(prev);
    expect(f.pointer.pressed).toBe(true);
    expect(f.pointer.down).toBe(true);
    expect(f.pointer.x).toBe(10);
    expect(f.pointer.y).toBe(10);
    expect(f.pointer.startX).toBe(10);
    expect(f.pointer.startY).toBe(10);

    // Next sample: the queued transition is drained, so this falls back to level
    // state — the latest move position.
    f = sampleFrame(prev);
    expect(f.pointer.pressed).toBe(false);
    expect(f.pointer.down).toBe(true);
    expect(f.pointer.x).toBe(200);
    expect(f.pointer.y).toBe(200);
  });

  it('a press+release that both happen between samples still yields a pressed edge then a released edge, not neither', () => {
    // The unified root cause of both Court aim bugs above (down/up FIFO — pointerSource.ts's
    // EDGE LATCHING banner): an atomic gesture (down→moves→up)
    // whose down and up land between two `inputSystem` ticks previously vanished — down
    // and up cancelled out, so NEITHER edge fired. The FIFO drains one transition per
    // sample, so a same-gap press+release now reports pressed on frame N and released on
    // frame N+1, never silently dropped.
    pointerSource.attach();
    const prev = { down: false };

    firePointer('pointerdown', 40, 60);
    firePointer('pointerup', 45, 65);
    let f = sampleFrame(prev);
    expect(f.pointer.pressed).toBe(true);
    expect(f.pointer.released).toBe(false);
    expect(f.pointer.down).toBe(true);
    expect(f.pointer.x).toBe(40);
    expect(f.pointer.y).toBe(60);

    f = sampleFrame(prev);
    expect(f.pointer.pressed).toBe(false);
    expect(f.pointer.released).toBe(true);
    expect(f.pointer.down).toBe(false);
    expect(f.pointer.x).toBe(45);
    expect(f.pointer.y).toBe(65);
    // The drained RELEASE transition must report the TRUE final drag magnitude, not
    // zero — matching PointerFrame's documented contract ("a tap is a pressed with a
    // small dragX/dragY AT released"). A consumer that computes a fling/throw/launch
    // from pointerReleased()+pointerDrag() together must see the real delta here.
    expect(f.pointer.dragX).toBe(5);
    expect(f.pointer.dragY).toBe(5);
  });

  it('overflow drops the NEWEST queued transition, preserving down/up alternation', () => {
    // MAX_PENDING=16 guards a pathological event storm, not a real gesture. Dropping
    // the OLDEST on overflow could leave an `up` at the head with no matching `down`
    // ahead of it — computePointerEdge would then see now=false/prev.down=false and
    // emit NEITHER edge, silently swallowing a whole gesture (the exact failure class
    // this FIFO exists to kill). Dropping the newest instead preserves alternation
    // for whatever prefix does get drained.
    pointerSource.attach();
    const prev = { down: false };

    // Flood far past the cap with alternating down/up pairs at distinct coordinates.
    for (let i = 0; i < 20; i++) {
      firePointer('pointerdown', i, i);
      firePointer('pointerup', i, i);
    }

    // Drain every frame the queue offers and assert strict down/up alternation with
    // no double-down or double-up in a row (which would signal a broken queue).
    let expectDown = true;
    let drained = 0;
    for (let frame = 0; frame < 40; frame++) {
      const before = prev.down;
      const f = sampleFrame(prev);
      if (f.pointer.pressed || f.pointer.released) {
        expect(f.pointer.down).toBe(expectDown);
        expectDown = !expectDown;
        drained++;
      } else {
        expect(f.pointer.down).toBe(before); // no phantom edge
      }
    }
    expect(drained).toBeGreaterThan(0);
    expect(drained % 2).toBe(0); // never ends mid-gesture (an unmatched down or up)
  });

  it('reset() (the host-gate-closing edge) drops any pending queued transitions too', () => {
    pointerSource.attach();
    const prev = { down: false };

    // Queue up a down+up burst without ever sampling it.
    firePointer('pointerdown', 7, 7);
    firePointer('pointerup', 8, 8);

    pointerSource.reset!(); // e.g. the editor's input gate closing

    // The queued transitions must be gone — the next sample reads current (post-up)
    // level state directly, with no replay of the dropped burst.
    const f = sampleFrame(prev);
    expect(f.pointer.pressed).toBe(false);
    expect(f.pointer.released).toBe(false);
    expect(f.pointer.down).toBe(false);
  });

  it('detach drops listeners and latched state (idempotent)', () => {
    pointerSource.attach();
    const prev = { down: false };
    firePointer('pointerdown', 1, 1);
    pointerSource.detach();
    // After detach a new down must be ignored (no listener) → still up.
    firePointer('pointerdown', 9, 9);
    const f = sampleFrame(prev);
    expect(f.pointer.down).toBe(false);
    pointerSource.detach(); // idempotent
  });

  describe('pointer-block roots', () => {
    it('a pointerdown on a registered block root is invisible to the game', () => {
      const root = document.createElement('div');
      document.body.appendChild(root);
      registerPointerBlocker(root);
      pointerSource.attach();
      const prev = { down: false };

      firePointer('pointerdown', 100, 100, 1, root);
      const f = sampleFrame(prev);
      expect(f.pointer.down).toBe(false);
      expect(f.pointer.pressed).toBe(false);
    });

    it('a blocked press stays invisible for its WHOLE gesture, even once the move target leaves the root', () => {
      // Proves detail #1 from the design without any per-event target re-checking:
      // filtering at ingestion means the gesture never latches `activeId`, so its
      // later move/up already no-op via the existing pointerId!==activeId guard —
      // this is the "drag passes under a DOM HUD mid-gesture" and "board drag that
      // started elsewhere" cases from docs/input.md.
      const root = document.createElement('div');
      const outside = document.createElement('div');
      document.body.append(root, outside);
      registerPointerBlocker(root);
      pointerSource.attach();
      const prev = { down: false };

      firePointer('pointerdown', 10, 10, 1, root);
      firePointer('pointermove', 500, 500, 1, outside); // same pointerId, now off-root
      firePointer('pointerup', 500, 500, 1, outside);
      const f = sampleFrame(prev);
      expect(f.pointer.down).toBe(false);
      expect(f.pointer.pressed).toBe(false);
      expect(f.pointer.released).toBe(false);
    });

    it('the root being unregistered AND detached mid-gesture does not hand the rest of the drag back to the game', () => {
      // The flyout-closes-on-selection-while-finger-is-still-down case: the block
      // decision is only ever consulted at pointerdown, so removing the root later
      // cannot retroactively un-block a gesture that already started blocked.
      const root = document.createElement('div');
      document.body.appendChild(root);
      const unregister = registerPointerBlocker(root);
      pointerSource.attach();
      const prev = { down: false };

      firePointer('pointerdown', 10, 10, 1, root);
      unregister();
      root.remove();
      firePointer('pointermove', 20, 20, 1, window);
      firePointer('pointerup', 20, 20, 1, window);
      const f = sampleFrame(prev);
      expect(f.pointer.down).toBe(false);
      expect(f.pointer.pressed).toBe(false);
      expect(f.pointer.released).toBe(false);
    });

    it('a SECOND pointer landing on the canvas becomes the active gesture once the first is blocked', () => {
      // The one genuine multitouch benefit this design gets "for free": since a
      // blocked pointer never latches `activeId`, it does not stand in the way of
      // a second, unblocked finger owning the gesture.
      const root = document.createElement('div');
      document.body.appendChild(root);
      registerPointerBlocker(root);
      pointerSource.attach();
      const prev = { down: false };

      firePointer('pointerdown', 10, 10, /*pointerId*/ 1, root); // blocked
      firePointer('pointerdown', 300, 300, /*pointerId*/ 2, window); // unblocked
      let f = sampleFrame(prev);
      expect(f.pointer.down).toBe(true);
      expect(f.pointer.pressed).toBe(true);
      expect(f.pointer.x).toBe(300);
      expect(f.pointer.y).toBe(300);

      firePointer('pointermove', 320, 340, 2, window);
      f = sampleFrame(prev);
      expect(f.pointer.x).toBe(320);
      expect(f.pointer.y).toBe(340);

      firePointer('pointerup', 320, 340, 2, window);
      f = sampleFrame(prev);
      expect(f.pointer.released).toBe(true);
    });

    it('a blocked-then-cancelled gesture never leaks a stuck claim into the next, unblocked gesture (same reused pointerId)', () => {
      // The regression the todo's "release on pointerup AND pointercancel" detail
      // was defending against — except with no per-pointer claim state there is
      // nothing to leak in the first place: a fresh pointerdown with the SAME id
      // (mouse always reuses pointerId 1) is re-evaluated from scratch.
      const root = document.createElement('div');
      document.body.appendChild(root);
      registerPointerBlocker(root);
      pointerSource.attach();
      const prev = { down: false };

      firePointer('pointerdown', 5, 5, 1, root);
      firePointer('pointercancel', 5, 5, 1, root);

      // Fresh gesture, same pointerId, NOT on the blocked root — must be fully seen.
      firePointer('pointerdown', 40, 40, 1, window);
      const f = sampleFrame(prev);
      expect(f.pointer.down).toBe(true);
      expect(f.pointer.pressed).toBe(true);
      expect(f.pointer.x).toBe(40);
      expect(f.pointer.y).toBe(40);
    });

    it('wheel over a registered root is swallowed per-event; wheel elsewhere still accumulates', () => {
      const root = document.createElement('div');
      document.body.appendChild(root);
      registerPointerBlocker(root);
      pointerSource.attach();
      const prev = { down: false };

      const blocked = new WheelEvent('wheel', { deltaY: 10, bubbles: true });
      root.dispatchEvent(blocked);
      let f = sampleFrame(prev);
      expect(f.pointer.wheel).toBe(0);

      const unblocked = new WheelEvent('wheel', { deltaY: 10, bubbles: true });
      window.dispatchEvent(unblocked);
      f = sampleFrame(prev);
      expect(f.pointer.wheel).toBe(1);
    });

    it('reset()/detach() leave no block-registry residue (the registry lives independently of the source)', () => {
      const root = document.createElement('div');
      document.body.appendChild(root);
      registerPointerBlocker(root);
      pointerSource.attach();
      pointerSource.reset!();
      pointerSource.detach();

      // The registration itself is untouched by the source's own lifecycle —
      // re-attaching still respects it.
      pointerSource.attach();
      const prev = { down: false };
      firePointer('pointerdown', 1, 1, 1, root);
      const f = sampleFrame(prev);
      expect(f.pointer.down).toBe(false);
    });
  });

  /** Pointer VELOCITY — the input half of touch-to-photon latency compensation.
   *
   *  A touch reaches the screen ~83 ms late on an A23 (five frames), measured against a bare
   *  DOM control ring, so the only remaining lever is to draw where the finger is heading.
   *  `vx/vy` is what makes that possible; `pointerPredictedPos` applies the lead.
   *
   *  ⚠️ `timeStamp` is set explicitly here. jsdom stamps every synthetic event with a coarse
   *  clock, so two dispatched back-to-back can carry the SAME timestamp — the estimator then
   *  sees dt=0, correctly refuses it, and every velocity assertion would read 0 while looking
   *  like the feature is broken. */
  describe('velocity (latency compensation)', () => {
    /** Fire a pointer event at an exact timeStamp — `Event.timeStamp` is readonly, so it is
     *  defined on the instance rather than passed to the constructor. */
    function fireAt(type: string, x: number, y: number, t: number, pointerId = 1): void {
      const ev = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }) as MouseEvent;
      Object.defineProperty(ev, 'pointerId', { value: pointerId });
      Object.defineProperty(ev, 'timeStamp', { value: t });
      window.dispatchEvent(ev);
    }

    it('is zero before any input, and while the pointer is up', () => {
      pointerSource.attach();
      const f = sampleFrame({ down: false });
      expect(f.pointer.vx).toBe(0);
      expect(f.pointer.vy).toBe(0);
    });

    it('is zero on the frame the pointer goes down — a just-landed finger has no heading', () => {
      pointerSource.attach();
      const prev = { down: false };
      fireAt('pointerdown', 100, 100, 1000);
      const f = sampleFrame(prev);
      expect(f.pointer.down).toBe(true);
      expect(f.pointer.vx).toBe(0);
      expect(f.pointer.vy).toBe(0);
    });

    it('estimates px/ms, converging toward the true speed as samples arrive', () => {
      // The velocity comes from the 1€ filter's own low-passed derivative, so it APPROACHES the
      // true speed rather than jumping to it — exact values belong to oneEuroFilter.test.ts.
      // What matters at this seam is the sign, the units, and that it converges.
      pointerSource.attach();
      const prev = { down: false };
      fireAt('pointerdown', 100, 100, 1000);
      sampleFrame(prev);
      let last = 0;
      for (let i = 1; i <= 20; i++) {
        fireAt('pointermove', 100 + i * 32, 100, 1000 + i * 16);   // a true 2 px/ms
        const f = sampleFrame(prev);
        expect(f.pointer.vx).toBeGreaterThanOrEqual(last);          // monotone approach
        expect(f.pointer.vy).toBeCloseTo(0, 6);                     // no cross-axis leakage
        last = f.pointer.vx;
      }
      expect(last).toBeGreaterThan(0.5);
      expect(last).toBeLessThanOrEqual(2.0001);                     // never overshoots the truth
    });

    it('leaves x/y RAW — only the velocity is filtered', () => {
      // The filter's smoothed POSITION is discarded on purpose: extrapolating from it subtracts
      // the filter's lag from the lead, which measured as prediction drawing BEHIND the finger.
      // So `x/y` must remain exactly what the DOM reported, for hit-tests and for the
      // prediction base alike.
      pointerSource.attach();
      const prev = { down: false };
      fireAt('pointerdown', 100, 100, 1000);
      sampleFrame(prev);
      fireAt('pointermove', 140, 100, 1016);
      const f = sampleFrame(prev);
      expect(f.pointer.x).toBe(140);
      expect(f.pointer.y).toBe(100);
      expect(f.pointer.vx).toBeGreaterThan(0);    // ...while the heading is being estimated
    });

    it('ignores a sample gap outside the usable band', () => {
      pointerSource.attach();
      const prev = { down: false };
      fireAt('pointerdown', 100, 100, 1000);
      sampleFrame(prev);
      // dt = 500ms — the samples straddle a stall, so the "velocity" between them is fiction.
      fireAt('pointermove', 600, 100, 1500);
      let f = sampleFrame(prev);
      expect(f.pointer.vx).toBe(0);
      // dt = 0 — a duplicate timestamp would divide by ~zero and explode.
      fireAt('pointermove', 700, 100, 1500);
      f = sampleFrame(prev);
      expect(f.pointer.vx).toBe(0);
    });

    it('drops to zero on release, so the picture cannot coast past the finger', () => {
      pointerSource.attach();
      const prev = { down: false };
      fireAt('pointerdown', 100, 100, 1000);
      sampleFrame(prev);
      fireAt('pointermove', 132, 100, 1016);
      expect(sampleFrame(prev).pointer.vx).toBeGreaterThan(0);
      // A FLICK release: still moving fast at the moment the finger lifts.
      fireAt('pointerup', 164, 100, 1032);
      expect(sampleFrame(prev).pointer.vx).toBe(0);
    });

    it('does not carry velocity from one gesture into the next', () => {
      pointerSource.attach();
      const prev = { down: false };
      fireAt('pointerdown', 100, 100, 1000);
      sampleFrame(prev);
      fireAt('pointermove', 132, 100, 1016);
      expect(sampleFrame(prev).pointer.vx).toBeGreaterThan(0);
      fireAt('pointerup', 132, 100, 1032);
      sampleFrame(prev);
      // A new press elsewhere starts from rest, however fast the previous gesture ended.
      fireAt('pointerdown', 500, 500, 1100);
      const f = sampleFrame(prev);
      expect(f.pointer.vx).toBe(0);
      expect(f.pointer.vy).toBe(0);
    });
  });
});
