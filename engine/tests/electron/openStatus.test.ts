/** The agent's view of where project opens stand (#1587 close-out review): "already open" must not
 *  be answered for an open that is still running or that failed. */

import { describe, it, expect } from 'vitest';
import { createOpenStatus } from '../../electron/openStatus';

describe('createOpenStatus', () => {
  it('the launch root is opened, with nothing in flight', () => {
    const s = createOpenStatus();
    s.launched('/a');
    expect(s.status()).toEqual({ inFlight: null, opened: '/a' });
  });

  it('an open is in flight until it settles, and only then becomes the opened root', () => {
    const s = createOpenStatus('/a');
    const g = s.begin('/b');
    expect(s.status()).toEqual({ inFlight: '/b', opened: '/a' });
    s.settle(g, '/b', 'opened');
    expect(s.status()).toEqual({ inFlight: null, opened: '/b' });
  });

  it('a failed or throwing open leaves NO project opened', () => {
    for (const result of ['failed', 'threw'] as const) {
      const s = createOpenStatus('/a');
      const g = s.begin('/b');
      s.settle(g, '/b', result);
      expect(s.status()).toEqual({ inFlight: null, opened: null });
    }
  });

  it('an OLDER open settling late (at its mount) does not resurrect `opened` over a newer failure', () => {
    const s = createOpenStatus('/a');
    const b = s.begin('/b');
    const c = s.begin('/c');
    s.settle(c, '/c', 'failed');
    s.settle(b, '/b', 'opened');
    expect(s.status()).toEqual({ inFlight: null, opened: null });
  });

  it('A → B → A: the first A settling superseded does not clear the second A still in flight', () => {
    const s = createOpenStatus('/x');
    const a1 = s.begin('/a');
    const b = s.begin('/b');
    const a2 = s.begin('/a');
    s.settle(a1, '/a', 'superseded');
    s.settle(b, '/b', 'superseded');
    expect(s.status()).toEqual({ inFlight: '/a', opened: '/x' });
    s.settle(a2, '/a', 'opened');
    expect(s.status()).toEqual({ inFlight: null, opened: '/a' });
  });
});
