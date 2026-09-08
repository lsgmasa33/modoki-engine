/** Preview3DShell's populate-gate, extracted into `preview3DShellLossGuard.ts` (finding 2,
 *  adversarial review of #795): once a handle's `disposed` getter goes true, the shell must stop
 *  populating it and surface an error instead of silently reporting success on a dead scene. */
import { describe, it, expect } from 'vitest';
import { gatePopulate } from '../../src/editor/panels/preview3DShellLossGuard';

describe('gatePopulate', () => {
  it('proceeds for a live handle', () => {
    expect(gatePopulate({ disposed: false })).toEqual({ proceed: true });
  });

  it('blocks with no error for a missing handle (WebGL unavailable — reported elsewhere)', () => {
    const gate = gatePopulate(null);
    expect(gate.proceed).toBe(false);
    expect((gate as { error: string | null }).error).toBeNull();
  });

  it('blocks WITH an error for a handle a loss teardown already disposed (finding 2)', () => {
    const gate = gatePopulate({ disposed: true });
    expect(gate.proceed).toBe(false);
    expect((gate as { error: string | null }).error).toMatch(/gpu context was lost/i);
  });
});
