/** The editor's policy for the running game's input gate.
 *
 *  Two independent reasons to suppress, and one deliberate NON-reason (null focus), each of which has
 *  been a real bug: input reaching the game while you type in the Hierarchy (P5.1), input reaching it
 *  under a modal dialog (#1270), and input NOT reaching it right after Play because nobody had
 *  clicked the GameView yet. */

import { describe, it, expect } from 'vitest';
import { suppressesGameInput } from '../../src/editor/input/gameInputGate';

describe('suppressesGameInput', () => {
  it('lets input through for the Game panel, and for a scope nobody has claimed yet', () => {
    expect(suppressesGameInput('game', false)).toBe(false);
    expect(suppressesGameInput(null, false)).toBe(false);
  });

  it('suppresses for any other panel', () => {
    expect(suppressesGameInput('hierarchy', false)).toBe(true);
    expect(suppressesGameInput('scene', false)).toBe(true);
  });

  it('suppresses under a modal whatever the scope is — including the two cases that otherwise pass', () => {
    expect(suppressesGameInput('game', true)).toBe(true);
    expect(suppressesGameInput(null, true)).toBe(true);
  });
});
