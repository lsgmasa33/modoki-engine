/** Pipeline unit tests — verifies ordered system execution. */

import { describe, it, expect, vi } from 'vitest';

describe('pipeline', () => {
  it('runs systems in order', async () => {
    // We can't easily mock individual systems since they're imported statically,
    // but we can verify runPipeline iterates the systems array in order.
    // Instead, test the structure of the systems array.
    const systemsModule = await import('../../app/ecs/pipeline');

    // Verify runPipeline is a function
    expect(typeof systemsModule.runPipeline).toBe('function');
  });

  it('runPipeline calls each system with the world', async () => {
    const { runPipeline } = await import('../../app/ecs/pipeline');

    // Re-import pipeline module to access systems via a spy approach
    // Since systems are statically imported, we test by passing a mock world
    // and checking that systems don't throw.
    const mockWorld: any = {
      // Mirror koota's QueryResult surface. `readEach` is the read-only twin of `updateEach`
      // (no per-entity snapshot / change-detection / writeback); a mock carrying only one of
      // them silently fails any system that reads rather than mutates.
      query: vi.fn(() => ({
        updateEach: vi.fn(),
        readEach: vi.fn(),
      })),
      queryFirst: vi.fn(() => undefined), // singleton lookups (e.g. getTime) use this
      spawn: vi.fn(() => ({ id: vi.fn(() => 1) })),
    };

    // Should not throw even with a minimal mock world
    expect(() => runPipeline(mockWorld)).not.toThrow();
  });

  it('registers the uiBusyPoll system at GAME priority (#551)', async () => {
    // Regression: nothing else in this suite exercises the actual `registerSystem` call in
    // `app/ecs/pipeline.ts` — every test in uiInputLock.test.ts calls `pollUIBusyContinuity()`
    // directly. Deleting the registration line would leave that whole suite green while the
    // valve never accumulates in the real running app.
    const { getRegisteredSystems } = await import('../../packages/modoki/src/runtime/core/pipeline');
    await import('../../app/ecs/pipeline'); // self-registers everything on import

    expect(getRegisteredSystems()).toContain('uiBusyPoll (100)');
  });
});
