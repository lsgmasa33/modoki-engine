/**
 * Project Settings' `string-list` field (#837 close-out). The textarea used to re-render from the
 * parsed list, which trimmed a trailing newline on every keystroke, so Enter did nothing.
 */
import { describe, it, expect } from 'vitest';
import { parseStringList, stringListText } from '../../src/editor/panels/stringListText';

describe('parseStringList', () => {
  it('reads one trimmed entry per line and drops blank lines', () => {
    expect(parseStringList('  ota-subgame-test \n\n minigame-b\n')).toEqual(['ota-subgame-test', 'minigame-b']);
    expect(parseStringList('')).toEqual([]);
  });
});

describe('stringListText', () => {
  it('KEEPS a trailing newline the user just typed — the Enter that used to vanish', () => {
    const typed = 'ota-subgame-test\n';
    const value = parseStringList(typed);
    expect(stringListText(typed, value)).toBe(typed);
  });

  it('keeps a blank line mid-edit, since it still means the same list', () => {
    expect(stringListText('a\n\nb', ['a', 'b'])).toBe('a\n\nb');
  });

  it('replaces the text when the value changed from OUTSIDE (a reload or reset)', () => {
    expect(stringListText('a\n', ['a', 'b'])).toBe('a\nb');
    expect(stringListText('a', [])).toBe('');
  });
});
