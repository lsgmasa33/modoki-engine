/** Video lifecycle events. The load-bearing case is SKIP: a game that waits for
 *  "the cutscene is over" must fire exactly once whether the player watched it or
 *  dismissed it, or a skippable cutscene softlocks. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  videoEvents, emitVideoStart, emitVideoEnd, emitVideoSkip, clearVideoEventHandlers,
} from '../../src/runtime/video/VideoEvents';

beforeEach(() => { clearVideoEventHandlers(); });

const p = { entity: 'e-guid', clip: 'clip-guid' };

describe('subscription', () => {
  it('delivers start / end / skip to their own subscribers', () => {
    const start = vi.fn(); const end = vi.fn(); const skip = vi.fn();
    videoEvents.onStart(start); videoEvents.onEnd(end); videoEvents.onSkip(skip);

    emitVideoStart(p);
    expect(start).toHaveBeenCalledWith(p);
    expect(end).not.toHaveBeenCalled();

    emitVideoEnd(p);
    expect(end).toHaveBeenCalledTimes(1);
    expect(skip).not.toHaveBeenCalled();
  });

  it('unsubscribes', () => {
    const fn = vi.fn();
    const off = videoEvents.onEnd(fn);
    off();
    emitVideoEnd(p);
    expect(fn).not.toHaveBeenCalled();
  });

  it('survives a handler that unsubscribes ITSELF mid-dispatch', () => {
    // The "play once then detach" shape. Without copying the set before iterating,
    // this mutates it during iteration and can skip the next handler.
    const second = vi.fn();
    const off = videoEvents.onEnd(() => off());
    videoEvents.onEnd(second);
    expect(() => emitVideoEnd(p)).not.toThrow();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('does not let one throwing handler stop the others', () => {
    const good = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    videoEvents.onEnd(() => { throw new Error('boom'); });
    videoEvents.onEnd(good);
    emitVideoEnd(p);
    expect(good).toHaveBeenCalledTimes(1);
  });
});

describe('skip', () => {
  it('ALSO fires onEnd — otherwise a game waiting on the end softlocks on skip', () => {
    const end = vi.fn(); const skip = vi.fn();
    videoEvents.onEnd(end); videoEvents.onSkip(skip);
    emitVideoSkip(p);
    expect(skip).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('fires end exactly ONCE on skip, not once per listener kind', () => {
    const end = vi.fn();
    videoEvents.onEnd(end);
    emitVideoSkip(p);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('reports skip and watched-to-end as DISTINGUISHABLE', () => {
    // A game may legitimately care which happened (award the cutscene achievement
    // only if they actually watched), so onSkip must not fire on a natural end.
    const skip = vi.fn();
    videoEvents.onSkip(skip);
    emitVideoEnd(p);
    expect(skip).not.toHaveBeenCalled();
  });
});

describe('clearVideoEventHandlers', () => {
  it('drops every subscriber', () => {
    const fn = vi.fn();
    videoEvents.onStart(fn); videoEvents.onEnd(fn); videoEvents.onSkip(fn);
    clearVideoEventHandlers();
    emitVideoStart(p); emitVideoEnd(p); emitVideoSkip(p);
    expect(fn).not.toHaveBeenCalled();
  });
});
