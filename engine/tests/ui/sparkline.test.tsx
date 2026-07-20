/** Sparkline redraw regression tests (Phase 1).
 *
 *  jsdom returns a null 2D context, so the DebugMenu integration test can't see
 *  whether the charts actually paint. These tests stub the canvas context to record
 *  draw calls and guard the bug the review caught: the Stats tab mutates its history
 *  arrays in place, so unless a FRESH array identity reaches <Sparkline> each tick,
 *  the effect's `[data]` dep never fires and the chart renders dead. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { Sparkline } from '../../packages/modoki/src/runtime/debug/Sparkline';

// Controllable FPS source so we can drive the Stats tab's interval deterministically.
const fpsState = vi.hoisted(() => ({ value: 60 }));
vi.mock('../../packages/modoki/src/runtime/rendering/frameDriver', () => ({
  getCurrentFPS: () => fpsState.value,
}));

/** A recording fake 2D context — counts the draw ops Sparkline issues. */
function installCanvasStub() {
  const rec = { lineToCalls: 0, strokeCalls: 0, draws: 0 };
  const ctx = {
    setTransform: () => {},
    clearRect: () => {
      rec.draws++;
    },
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {
      rec.lineToCalls++;
    },
    closePath: () => {},
    stroke: () => {
      rec.strokeCalls++;
    },
    fill: () => {},
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 0,
    lineJoin: '',
  };
  const spy = vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  return { rec, restore: () => spy.mockRestore() };
}

let stub: ReturnType<typeof installCanvasStub>;
beforeEach(() => {
  stub = installCanvasStub();
});
afterEach(() => {
  cleanup();
  stub.restore();
  vi.useRealTimers();
});

describe('Sparkline drawing', () => {
  it('draws one line vertex per sample', () => {
    render(<Sparkline data={[1, 2, 3]} />);
    expect(stub.rec.strokeCalls).toBeGreaterThan(0);
    expect(stub.rec.lineToCalls).toBeGreaterThanOrEqual(3);
  });

  it('redraws when given a new data array', () => {
    const { rerender } = render(<Sparkline data={[1, 2]} />);
    const drawsAfterFirst = stub.rec.draws;
    rerender(<Sparkline data={[1, 2, 3, 4]} />);
    expect(stub.rec.draws).toBeGreaterThan(drawsAfterFirst); // effect re-ran
  });
});

describe('FPS widget chart stays live across interval ticks', () => {
  it('repaints the FPS sparkline as new samples arrive (regression: in-place ref mutation)', async () => {
    vi.useFakeTimers();
    // Import after the frameDriver mock is registered. The live FPS chart now lives
    // in the floating FpsWidget (the Stats tab is a launcher).
    const { FpsWidget } = await import('../../packages/modoki/src/runtime/debug/widgets/FpsWidget');
    render(<FpsWidget />);
    const drawsAfterMount = stub.rec.draws;

    // Advance a few 500ms sample ticks with a changing FPS value.
    for (let i = 0; i < 3; i++) {
      fpsState.value = 55 + i;
      act(() => {
        vi.advanceTimersByTime(500);
      });
    }
    // If the ref array reached Sparkline with a stable identity, the effect would
    // never re-run and draws would be frozen at mount. A fresh array each tick
    // repaints — so the count must grow.
    expect(stub.rec.draws).toBeGreaterThan(drawsAfterMount);
  });
});
