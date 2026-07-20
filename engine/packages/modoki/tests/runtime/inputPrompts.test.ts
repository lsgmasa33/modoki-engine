/** inputPrompts — device-appropriate prompt labels (Part B4/Phase 4).
 *
 *  Pure table + fallback behavior. No world, no DOM. */

import { describe, it, expect } from 'vitest';
import { promptFor, PROMPT_ACTIONS } from '../../src/runtime/input/inputPrompts';

describe('promptFor (device → action label)', () => {
  it('swaps the confirm label per device', () => {
    expect(promptFor('gamepad', 'confirm')).toBe('A');
    expect(promptFor('keyboard', 'confirm')).toBe('Enter');
    expect(promptFor('pointer', 'confirm')).toBe('Click');
    expect(promptFor('native', 'confirm')).toBe('Tap');
  });

  it('swaps cancel/menu/pause/jump per device', () => {
    expect(promptFor('gamepad', 'cancel')).toBe('B');
    expect(promptFor('keyboard', 'cancel')).toBe('Esc');
    expect(promptFor('gamepad', 'pause')).toBe('Start');
    expect(promptFor('keyboard', 'jump')).toBe('Space');
    expect(promptFor('gamepad', 'jump')).toBe('A');
    expect(promptFor('native', 'jump')).toBe('Tap');
  });

  it('returns "" for the none device (no input seen yet) so bound tokens render empty', () => {
    for (const a of PROMPT_ACTIONS) expect(promptFor('none', a)).toBe('');
  });

  it('falls back to the keyboard label, then the Capitalized action name, for unmapped actions', () => {
    // nav* has no device-specific label → keyboard has none either → Capitalized name.
    expect(promptFor('gamepad', 'navUp')).toBe('NavUp');
    expect(promptFor('keyboard', 'navLeft')).toBe('NavLeft');
  });

  it('every promptable action yields a non-empty label for a real device', () => {
    for (const a of PROMPT_ACTIONS) {
      expect(promptFor('gamepad', a).length).toBeGreaterThan(0);
      expect(promptFor('keyboard', a).length).toBeGreaterThan(0);
    }
  });
});
