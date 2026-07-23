// @vitest-environment node
/** Headless inertness — with no `window` (the determinism/verification harness), the presentation
 *  scale MUST be 1 so pointerDrag flows raw deltas and stays deterministic. Runs in the node
 *  environment (no jsdom) so `typeof window === 'undefined'` genuinely holds. */
import { describe, it, expect } from 'vitest';
import { getPresentationScale, calibratePresentationScale } from '../../src/runtime/input/presentationScale';

describe('presentationScale headless (no window)', () => {
  it('is inert (scale 1) and calibrate is a safe no-op', () => {
    expect(typeof (globalThis as { window?: unknown }).window).toBe('undefined');
    expect(getPresentationScale()).toBe(1);
    expect(() => calibratePresentationScale(1.5)).not.toThrow();
    expect(getPresentationScale()).toBe(1); // calibrate did nothing without a window
  });
});
