import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  registerEntrySource, unregisterEntrySource, getEntrySource, getEntrySourceNames,
  clearEntrySources, planEntryWrites, type EntryContent,
} from '../../src/runtime/ui/entrySource';

afterEach(() => { clearEntrySources(); vi.restoreAllMocks(); });

const index = new Map<number, { id: number; name: string }[]>([
  [1, [[10, 'Tile0'], [11, 'Tile1']].map(([id, name]) => ({ id: id as number, name: name as string }))],
  [11, [{ id: 20, name: 'Solved' }, { id: 21, name: 'Now' }]],
  [20, [{ id: 30, name: 'Num' }]],
  [21, [{ id: 31, name: 'Num' }]],
]);

describe('the entry source registry', () => {
  it('registers and resolves by name', () => {
    const fn = () => null;
    registerEntrySource('court.levelPages', fn);
    expect(getEntrySource('court.levelPages')).toBe(fn);
    expect(getEntrySourceNames()).toContain('court.levelPages');
  });

  it('refuses an unnamed source instead of registering an unreachable one', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    registerEntrySource('', () => null);
    expect(getEntrySourceNames()).toHaveLength(0);
    expect(err).toHaveBeenCalled();
  });

  it('warns on re-registration rather than silently swapping behaviour', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = () => null, b = () => null;
    registerEntrySource('dup', a);
    registerEntrySource('dup', b);
    expect(warn).toHaveBeenCalled();
    expect(getEntrySource('dup')).toBe(b);   // later wins, but it said so
  });

  it('unregisters', () => {
    registerEntrySource('gone', () => null);
    unregisterEntrySource('gone');
    expect(getEntrySource('gone')).toBeUndefined();
  });
});

describe('planEntryWrites', () => {
  const content = (members: EntryContent['members']): EntryContent => ({ members });

  it('resolves a full path and keys the write by TRAIT', () => {
    const plan = planEntryWrites(index, 1, content({
      'Tile1/Solved/Num': { UIElement: { text: '84' } },
    }));
    expect(plan.problems).toEqual([]);
    expect(plan.writes).toEqual([{ entityId: 30, trait: 'UIElement', fields: { text: '84' }, path: 'Tile1/Solved/Num' }]);
  });

  it('addresses the entry root with the empty path', () => {
    const plan = planEntryWrites(index, 1, content({ '': { UIElement: { isVisible: true } } }));
    expect(plan.writes[0].entityId).toBe(1);
  });

  it('emits one write per trait on the same member', () => {
    const plan = planEntryWrites(index, 1, content({
      'Tile1': { UIElement: { isVisible: true }, UIToggle: { value: true } },
    }));
    expect(plan.writes.map(w => w.trait).sort()).toEqual(['UIElement', 'UIToggle']);
  });

  it('REPORTS an ambiguous path instead of writing every match', () => {
    // The realistic trap: three `Num` entities live under three state faces, so a leaf-name
    // match would write all three and look like it worked. Court's patchUIInInstance does
    // exactly that by design; this must not inherit it.
    const ambiguous = new Map([[1, [{ id: 2, name: 'Num' }, { id: 3, name: 'Num' }]]]);
    const plan = planEntryWrites(ambiguous, 1, content({ 'Num': { UIElement: { text: 'x' } } }));
    expect(plan.writes).toEqual([]);
    expect(plan.problems).toEqual([{ path: 'Num', reason: 'ambiguous', at: 'Num' }]);
  });

  it('REPORTS a path that names nothing, and says where it broke', () => {
    const plan = planEntryWrites(index, 1, content({ 'Tile1/Missing/Num': { UIElement: {} } }));
    expect(plan.problems).toEqual([{ path: 'Tile1/Missing/Num', reason: 'not-found', at: 'Tile1/Missing' }]);
  });

  it('keeps going after a bad path — one typo must not blank the whole entry', () => {
    const plan = planEntryWrites(index, 1, content({
      'nope': { UIElement: { text: 'a' } },
      'Tile1/Now/Num': { UIElement: { text: 'b' } },
    }));
    expect(plan.writes).toHaveLength(1);
    expect(plan.writes[0].entityId).toBe(31);
    expect(plan.problems).toHaveLength(1);
  });

  it('ignores a non-object trait bag rather than writing garbage', () => {
    const plan = planEntryWrites(index, 1, content({ 'Tile1': { UIElement: null as never } }));
    expect(plan.writes).toEqual([]);
    expect(plan.problems).toEqual([]);
  });
});
