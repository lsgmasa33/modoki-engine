/** inputPromptSources — device prompts wired into the UI read-source registry
 *  (Part B4/Phase 4). Proves a bound {confirmPrompt}/{inputDevice} token resolves
 *  live against the current device, and that the disposer unregisters cleanly. */

import { describe, it, expect, afterEach } from 'vitest';
import { createTestWorld, type TestWorld } from '../../src/runtime/harness/createTestWorld';
import { Input, getInput } from '../../src/runtime/traits/Input';
import type { InputDevice } from '../../src/runtime/input/actions';
import { registerInputPromptSources } from '../../src/runtime/input/inputPromptSources';
import { getReadValue } from '../../src/runtime/ui/readSourceRegistry';

let game: TestWorld | undefined;
let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; game?.dispose(); game = undefined; });

function setDevice(d: InputDevice) {
  const inp = getInput(game!.world);
  if (inp) inp.lastDevice = d;
}

describe('registerInputPromptSources', () => {
  it('resolves {inputDevice} and {confirmPrompt} against the live device', () => {
    game = createTestWorld({}); // makes this world current → peekCurrentWorld() sees it
    game.spawn(Input);
    dispose = registerInputPromptSources();

    setDevice('gamepad');
    expect(getReadValue('inputDevice')).toBe('gamepad');
    expect(getReadValue('confirmPrompt')).toBe('A');
    expect(getReadValue('cancelPrompt')).toBe('B');

    // Switch device → the SAME token now resolves to the keyboard label (live pull).
    setDevice('keyboard');
    expect(getReadValue('inputDevice')).toBe('keyboard');
    expect(getReadValue('confirmPrompt')).toBe('Enter');
    expect(getReadValue('pausePrompt')).toBe('P');
  });

  it('renders "" before any device / Input resource exists (no stray literal)', () => {
    game = createTestWorld({});
    game.spawn(Input);
    dispose = registerInputPromptSources();
    // Default lastDevice is 'none'.
    expect(getReadValue('inputDevice')).toBe('none');
    expect(getReadValue('confirmPrompt')).toBe('');
  });

  it('disposer unregisters exactly the tokens it added', () => {
    game = createTestWorld({});
    game.spawn(Input);
    dispose = registerInputPromptSources();
    setDevice('gamepad');
    expect(getReadValue('confirmPrompt')).toBe('A');

    dispose();
    dispose = undefined;
    expect(getReadValue('confirmPrompt')).toBeUndefined();
    expect(getReadValue('inputDevice')).toBeUndefined();
  });
});
