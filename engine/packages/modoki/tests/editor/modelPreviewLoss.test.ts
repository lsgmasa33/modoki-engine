/** ModelPreview's GPU-context-loss decisions, extracted into `modelPreviewLoss.ts` (finding 3,
 *  adversarial review of #795) — see that module's header for the two failures this pins:
 *  (a) an in-flight load attaching/collecting onto a scene a loss teardown already disposed, and
 *  (b) the next model selection silently reporting `loading: false, error: null` forever.
 *
 *  A root that must be disposed directly for (a) is handled by `convertToGLB.ts`'s
 *  `disposeSourceModel` (already covered by that module's own tests) — an earlier version of this
 *  file grew a near-copy of that sweep that leaked every texture, and a near-copy's tests would
 *  have kept passing right through that leak (finding 1, second adversarial review of #795), so
 *  there is deliberately no local dispose test here to duplicate. */
import { describe, it, expect } from 'vitest';
import { gateModelLoad, shouldAttachLoadedModel } from '../../src/editor/panels/modelPreviewLoss';

describe('gateModelLoad', () => {
  it('proceeds when the mount state is live', () => {
    expect(gateModelLoad(true)).toEqual({ proceed: true });
  });

  it('blocks WITH a visible error when the mount state is gone (finding 3b) — never silent', () => {
    const gate = gateModelLoad(false);
    expect(gate.proceed).toBe(false);
    expect((gate as { error: string }).error).toMatch(/gpu context was lost/i);
  });
});

describe('shouldAttachLoadedModel', () => {
  it('attaches when not cancelled', () => {
    expect(shouldAttachLoadedModel(false)).toBe(true);
  });
  it('does not attach once cancelled (ordinary supersession — a new sourceUrl)', () => {
    expect(shouldAttachLoadedModel(true)).toBe(false);
  });
  // No longer takes an `aborted` flag (finding 7, third adversarial review of #795): at its one
  // call site `aborted` is always false by the time this runs (an earlier `if (s.aborted)` already
  // returned), so a case pinning that branch asserted on an input production can never produce.
});
