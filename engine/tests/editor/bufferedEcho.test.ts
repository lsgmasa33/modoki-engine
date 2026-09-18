/** `resyncBuffered` — the re-sync decision behind every Inspector field's buffer (#242, #1411).
 *
 *  With the editor window unfocused no focus event fires, so this decision is the ONLY thing
 *  standing between a field's own commits coming back from the store and the text being typed.
 *  Each case replays a sequence the live editor produced; the #1411 one is the measured
 *  `…qr`-over-`…qrs` clobber. */
import { describe, it, expect } from 'vitest';
import { resyncBuffered, ECHO_WINDOW_MS, type PendingCommit } from '../../packages/modoki/src/editor/panels/bufferedEcho';
import { parseNumber, parseString } from '../../packages/modoki/src/editor/panels/fields';

const commits = <T,>(...values: T[]): PendingCommit<T>[] => values.map((value) => ({ value, at: 0 }));

describe('resyncBuffered', () => {
  it('#1411: a LATE echo of an earlier keystroke does not overwrite the text typed since', () => {
    // Typed …qr then …qrs; the store echoes …qr after the s already landed.
    const r = resyncBuffered('abcqrs', 'abcqr', commits('abcq', 'abcqr', 'abcqrs'), parseString, 10);
    expect(r.text).toBeNull();
    // …qr and everything before it is consumed; …qrs is still expected back.
    expect(r.pending.map((p) => p.value)).toEqual(['abcqrs']);
  });

  it('#242: the echo of the latest keystroke keeps the text, even where re-syncing would reformat it', () => {
    // clearFirst commits parseNumber('') = 0; re-syncing would turn '' into '0'.
    expect(resyncBuffered('', 0, commits(0), parseNumber, 10).text).toBeNull();
    expect(resyncBuffered('-', 0, commits(0, 0), parseNumber, 10).text).toBeNull();
  });

  it('a genuine external change re-syncs and forgets the record', () => {
    const r = resyncBuffered('abc', 'Sun', commits('a', 'ab', 'abc'), parseString, 10);
    expect(r.text).toBe('Sun');
    expect(r.pending).toEqual([]);
  });

  it('a value that returns to one this field once typed, AFTER an external change, re-syncs', () => {
    // External change forgets the record, so an undo back to 'ab' is not mistaken for an echo.
    const afterExternal = resyncBuffered('abc', 'Sun', commits('a', 'ab', 'abc'), parseString, 10);
    const r = resyncBuffered('Sun', 'ab', afterExternal.pending, parseString, 20);
    expect(r.text).toBe('ab');
  });

  it('a duplicate value (typed a, ab, then backspace to a) still skips the late ab', () => {
    const first = resyncBuffered('a', 'a', commits('a', 'ab', 'a'), parseString, 10);
    expect(first.text).toBeNull();
    const second = resyncBuffered('a', 'ab', first.pending, parseString, 11);
    expect(second.text).toBeNull();
  });

  it('a commit older than the echo window no longer shadows an external change equal to it', () => {
    const stale = [{ value: 'ab', at: 0 }];
    expect(resyncBuffered('abc', 'ab', stale, parseString, ECHO_WINDOW_MS + 1).text).toBe('ab');
    expect(resyncBuffered('abc', 'ab', stale, parseString, ECHO_WINDOW_MS).text).toBeNull();
  });
});
