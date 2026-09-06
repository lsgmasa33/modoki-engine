/** previewLossPolicy.ts — the ONE loss policy shared by ShaderPreview/previewScene/ModelPreview/
 *  ParticleEditor (#795): log loudly, then tear the surface down exactly once. Pure unit test of
 *  the policy module itself — it does NOT prove any panel actually calls it with a teardown that
 *  clears the state that panel's OTHER effects gate on; see each panel's own zombie-teardown test
 *  for that: `particlePreviewLoss.test.ts` (ParticleEditor), `modelPreviewLoss.test.ts`
 *  (ModelPreview), and `preview3DShellLossGuard.test.ts` + the `assetInspectorPhase2.test.tsx`
 *  `Preview3DShell` suite (Preview3DShell/previewScene) — see that suite's own note on which of
 *  its tests mount the real panel against an injected handle vs. exercise a pure function. */
import { describe, it, expect, vi } from 'vitest';
import { makePreviewLossPolicy } from '../../src/editor/panels/previewLossPolicy';

describe('makePreviewLossPolicy', () => {
  it('describe names the surface and says the preview will stay blank', () => {
    const { describe: d } = makePreviewLossPolicy({ label: 'MyPanel', teardown: () => {} });
    const msg = d!({ api: 'WebGL' });
    expect(msg).toMatch(/MyPanel/);
    expect(msg).toMatch(/reopen/i);
  });

  it('onLost calls teardown exactly once even if invoked twice (loss + a later device-lost resolution)', () => {
    const teardown = vi.fn();
    const { onLost } = makePreviewLossPolicy({ label: 't', teardown });
    onLost({ api: 'WebGL' });
    onLost({ api: 'WebGPU', reason: 'unknown' });
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it('a throwing teardown cannot escape onLost', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { onLost } = makePreviewLossPolicy({ label: 'Boom', teardown: () => { throw new Error('nope'); } });
    expect(() => onLost({ api: 'WebGL' })).not.toThrow();
    expect(err).toHaveBeenCalled();
  });
});
