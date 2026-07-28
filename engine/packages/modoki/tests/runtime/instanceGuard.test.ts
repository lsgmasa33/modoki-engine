/** Cross-cutting singleton-duplication guard (OTA Phase 4,
 *  docs/ota-subgame-modules.md §5). Simulates "two copies of the runtime running
 *  side by side" via `vi.resetModules()` + a fresh dynamic import — the same mechanism
 *  a real duplication bug would trigger (module re-evaluation), without needing an
 *  actual second bundle. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

beforeEach(() => {
  delete (globalThis as { __MODOKI_RUNTIME_INSTANCES__?: number }).__MODOKI_RUNTIME_INSTANCES__;
});

afterEach(() => {
  delete (globalThis as { __MODOKI_RUNTIME_INSTANCES__?: number }).__MODOKI_RUNTIME_INSTANCES__;
});

describe('instanceGuard', () => {
  it('sets the counter to 1 and logs nothing on first evaluation', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.resetModules();
    await import('../../src/runtime/core/instanceGuard');

    expect(globalThis.__MODOKI_RUNTIME_INSTANCES__).toBe(1);
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('logs a loud console.error (never throws) when re-evaluated a second time', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.resetModules();
    await import('../../src/runtime/core/instanceGuard');
    expect(globalThis.__MODOKI_RUNTIME_INSTANCES__).toBe(1);

    // Simulate a SECOND, independent copy of this module evaluating (exactly what a
    // botched externalization/dedup failure would do) — resetModules + re-import forces
    // a fresh top-level run, sharing the same globalThis the first copy already touched.
    vi.resetModules();
    await expect(import('../../src/runtime/core/instanceGuard')).resolves.toBeDefined();

    expect(globalThis.__MODOKI_RUNTIME_INSTANCES__).toBe(2);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toContain('DUPLICATE RUNTIME INSTANCE DETECTED');
    errorSpy.mockRestore();
  });
});
