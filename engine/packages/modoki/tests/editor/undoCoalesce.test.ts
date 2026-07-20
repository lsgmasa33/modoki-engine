/** The commit → global-undo coalescing decision (four independent guards). */

import { describe, it, expect } from 'vitest';
import { shouldCoalesce } from '../../src/editor/animation/undoCoalesce';

const base = {
  hasLastAction: true,
  group: 'movekeys',
  lastGroup: 'movekeys',
  now: 1000,
  lastTime: 900,
  coalesceMs: 500,
  isTopOfUndoStack: true,
  isExecutingUndoRedo: false,
};

describe('shouldCoalesce', () => {
  it('coalesces when all four guards hold', () => {
    expect(shouldCoalesce(base)).toBe(true);
  });

  it('does NOT coalesce a different group (distinct edits stay separate undo steps)', () => {
    expect(shouldCoalesce({ ...base, group: 'delkeys' })).toBe(false);
  });

  it('does NOT coalesce past the coalesce window', () => {
    expect(shouldCoalesce({ ...base, now: 1500 })).toBe(false); // 600ms > 500ms
    expect(shouldCoalesce({ ...base, now: 1399 })).toBe(true); // 499ms < 500ms
  });

  it('does NOT coalesce when a different action is now on top of the undo stack', () => {
    expect(shouldCoalesce({ ...base, isTopOfUndoStack: false })).toBe(false);
  });

  it('does NOT coalesce while executing an undo/redo', () => {
    expect(shouldCoalesce({ ...base, isExecutingUndoRedo: true })).toBe(false);
  });

  it('does NOT coalesce with no previous action', () => {
    expect(shouldCoalesce({ ...base, hasLastAction: false })).toBe(false);
  });
});
