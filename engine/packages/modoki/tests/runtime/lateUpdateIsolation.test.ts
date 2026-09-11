/** `runLateUpdates` isolates each LateUpdate system through `notifyListeners` and still names the
 *  one that threw by its registry KEY (#953). The key is the contract question #953 raised:
 *  the shared helper's reporter used to receive no per-entry handle, so the migration needed the
 *  helper to hand back the listener. */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { World } from 'koota';
import {
  registerLateUpdate, unregisterLateUpdate, runLateUpdates, clearLateUpdates,
} from '../../src/runtime/core/lateUpdate';

const W = {} as unknown as World;

describe('runLateUpdates — a system that throws', () => {
  afterEach(() => { clearLateUpdates(); vi.restoreAllMocks(); });

  it('does not starve the systems registered after it, and the report names it by key', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ran: string[] = [];
    registerLateUpdate('first', () => { ran.push('first'); });
    registerLateUpdate('ik-solver', () => { throw new Error('bad bone'); });
    registerLateUpdate('last', () => { ran.push('last'); });

    expect(() => runLateUpdates(W)).not.toThrow();

    expect(ran).toEqual(['first', 'last']);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String(errSpy.mock.calls[0]![0])).toContain('system "ik-solver" threw');
  });

  it('still names a system that UNREGISTERED itself before throwing', () => {
    // The #953 phase-2 review: a report-time lookup in the live registry answered "?" here.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    registerLateUpdate('once', () => { unregisterLateUpdate('once'); throw new Error('bye'); });
    runLateUpdates(W);
    expect(String(errSpy.mock.calls[0]![0])).toContain('system "once" threw');
  });

  it('still names a system that REPLACED itself before throwing', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    registerLateUpdate('swap', () => { registerLateUpdate('swap', () => {}); throw new Error('swapped'); });
    runLateUpdates(W);
    expect(String(errSpy.mock.calls[0]![0])).toContain('system "swap" threw');
  });
});
