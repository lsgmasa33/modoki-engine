/** Host input gate (focus-scope refactor P5.1).
 *
 *  The editor needs the running game to stop receiving input while an editor panel owns
 *  the keyboard — but that policy CANNOT live in a source: keyboardSource ships inside
 *  every game and must never know what a "panel" is. So the runtime provides the
 *  mechanism (this gate) and the host supplies the predicate, mirroring the injectable
 *  clock. A shipped game installs no gate and behaves exactly as before. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  setInputGate, isInputSuppressed, sampleAll, registerSource, unregisterSource,
  type InputSource,
} from '../../src/runtime/input/inputSources';
import { createInputFrame } from '../../src/runtime/core/inputActions';
import type { InputFrame } from '../../src/runtime/core/inputActions';

// Use the REAL frame factory: the built-in keyboard/gamepad/pointer sources are
// globally registered and sample into it too, so a hand-rolled partial frame throws
// inside pointerSource rather than testing anything.
const emptyFrame = (): InputFrame => createInputFrame();

/** A stand-in source that records sampling and resets. */
function fakeSource(name: string) {
  const calls = { sample: 0, reset: 0, attach: 0, detach: 0 };
  const src: InputSource = {
    name,
    attach() { calls.attach++; },
    detach() { calls.detach++; },
    reset() { calls.reset++; },
    sample() { calls.sample++; },
  };
  return { src, calls };
}

let fake: ReturnType<typeof fakeSource>;

beforeEach(() => {
  setInputGate(null);
  fake = fakeSource('test-fake');
  registerSource(fake.src);
});
afterEach(() => {
  unregisterSource('test-fake');
  setInputGate(null);
});

describe('default behaviour — a shipped game installs no gate', () => {
  it('is not suppressed with no gate', () => {
    expect(isInputSuppressed()).toBe(false);
  });

  it('samples sources normally', () => {
    sampleAll(emptyFrame());
    expect(fake.calls.sample).toBe(1);
    expect(fake.calls.reset).toBe(0);
  });
});

describe('gate closed — input stops reaching the game', () => {
  it('skips sampling entirely', () => {
    setInputGate(() => true);
    sampleAll(emptyFrame());
    expect(fake.calls.sample).toBe(0);
  });

  it('resets latched state ONCE, on the closing edge', () => {
    // Load-bearing, not tidiness: hold W, click the Hierarchy, and without the reset
    // `held` still contains 'w' so the character keeps walking until you release.
    setInputGate(() => true);
    sampleAll(emptyFrame());
    sampleAll(emptyFrame());
    sampleAll(emptyFrame());
    expect(fake.calls.reset).toBe(1); // edge-triggered, not every frame
  });

  it('resumes sampling when the gate reopens, and re-arms the edge', () => {
    let blocked = true;
    setInputGate(() => blocked);
    sampleAll(emptyFrame());
    expect(fake.calls.reset).toBe(1);

    blocked = false;
    sampleAll(emptyFrame());
    expect(fake.calls.sample).toBe(1);

    blocked = true;
    sampleAll(emptyFrame());
    expect(fake.calls.reset).toBe(3); // closing edge fires again (see reopening test below for why +2, not +1)
  });

  it('ALSO resets on the REOPENING edge, so a backlog queued while suppressed cannot replay', () => {
    // A source's raw listeners aren't detached by the gate (only `sample()` is
    // skipped) — a discrete-event source (pointerSource's press/release FIFO) keeps
    // enqueuing events made in an editor panel while the game is unfocused. Without
    // a reset on the REOPENING edge too, that backlog would replay into the game one
    // entry per frame once the panel loses focus and the GameView regains it.
    let blocked = true;
    setInputGate(() => blocked);
    sampleAll(emptyFrame());
    expect(fake.calls.reset).toBe(1); // closing edge

    blocked = false;
    sampleAll(emptyFrame());
    expect(fake.calls.reset).toBe(2); // reopening edge, BEFORE this frame's sample
    expect(fake.calls.sample).toBe(1);

    // Staying open must not re-fire reset every frame — edge-triggered, not continuous.
    sampleAll(emptyFrame());
    expect(fake.calls.reset).toBe(2);
    expect(fake.calls.sample).toBe(2);
  });
});

describe('robustness', () => {
  it('fails OPEN when the gate throws', () => {
    // A broken editor predicate must never make a game permanently uncontrollable.
    setInputGate(() => { throw new Error('boom'); });
    expect(isInputSuppressed()).toBe(false);
    sampleAll(emptyFrame());
    expect(fake.calls.sample).toBe(1);
  });

  it('treats a non-true return as open', () => {
    setInputGate(() => undefined as unknown as boolean);
    expect(isInputSuppressed()).toBe(false);
  });

  it('clearing the gate restores sampling', () => {
    setInputGate(() => true);
    sampleAll(emptyFrame());
    setInputGate(null);
    sampleAll(emptyFrame());
    expect(fake.calls.sample).toBe(1);
  });

  it('does not require a source to implement reset()', () => {
    const bare: InputSource = { name: 'bare', attach() {}, detach() {}, sample() {} };
    registerSource(bare);
    setInputGate(() => true);
    expect(() => sampleAll(emptyFrame())).not.toThrow();
    unregisterSource('bare');
  });
});

describe("the editor's actual policy", () => {
  // () => focusedPanel !== null && focusedPanel !== 'game'
  const policy = (focusedPanel: string | null) => () => focusedPanel !== null && focusedPanel !== 'game';

  it('suppresses while an editor panel owns the keyboard', () => {
    setInputGate(policy('hierarchy'));
    expect(isInputSuppressed()).toBe(true);
  });

  it('allows input when the GameView is focused', () => {
    setInputGate(policy('game'));
    expect(isInputSuppressed()).toBe(false);
  });

  it('allows input when NOTHING is focused', () => {
    // Pressing Play and immediately using WASD must work without first clicking the
    // GameView — otherwise the gate turns into a "why is my game dead?" bug.
    setInputGate(policy(null));
    expect(isInputSuppressed()).toBe(false);
  });
});
