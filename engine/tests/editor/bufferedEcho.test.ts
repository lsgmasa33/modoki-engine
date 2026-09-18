/** `resyncBuffered` — the re-sync decision behind every Inspector field's buffer (#242, #1411).
 *
 *  With the editor window unfocused no focus event fires, so this decision is the ONLY thing
 *  standing between a field's own commits coming back from the store and the text being typed.
 *  Each case replays a sequence the live editor produced; the #1411 one is the measured
 *  `…qr`-over-`…qrs` clobber. */
import { describe, it, expect } from 'vitest';
import { resyncBuffered, roundedTo, ECHO_WINDOW_MS, type PendingCommit } from '../../packages/modoki/src/editor/panels/bufferedEcho';
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

  // #1407: a field DISPLAYED at a precision. Measured live: a two-entity Transform.y, `4.1256` typed,
  // the store handed back the 2dp-rounded 4.13, and the field rewrote itself to "4.13" mid-edit.
  describe('at a display precision (#1407)', () => {
    const at2 = roundedTo(2);

    it('⭐ a ROUNDED echo of this field\'s own commit keeps the text', () => {
      const pending = commits(4, 4.1, 4.12, 4.125, 4.1256);
      expect(resyncBuffered('4.1256', 4.13, pending, parseNumber, 10, at2).text).toBeNull();
      // Exact matching, the pre-#1407 behaviour, is what overwrote it:
      expect(resyncBuffered('4.1256', 4.13, pending, parseNumber, 10).text).toBe('4.13');
    });

    it('a unit round trip\'s float noise (30° → rad → 29.999999999999996°) is this field\'s echo', () => {
      const echo = 30 * Math.PI / 180 * 180 / Math.PI;
      expect(echo).not.toBe(30); // the premise: the round trip really is noisy
      expect(resyncBuffered('30', echo, commits(3, 30), parseNumber, 10, at2).text).toBeNull();
      // …and so is a LATE one (#1411's route, through the same comparator).
      expect(resyncBuffered('30.5', echo, commits(3, 30, 30.5), parseNumber, 10, at2).text).toBeNull();
    });

    it('a genuine external change still re-syncs, and is WRITTEN at the precision', () => {
      const r = resyncBuffered('4.1256', 7.891234, commits(4.1256), parseNumber, 10, at2);
      expect(r.text).toBe('7.89');
      expect(r.pending).toEqual([]);
      // Noise from a round trip is not shown either — this is what the caller's toFixed used to do.
      expect(resyncBuffered('', 30 * Math.PI / 180 * 180 / Math.PI, [], parseNumber, 10, at2).text).toBe('30');
    });

    it('a genuine external change INSIDE the precision re-syncs once nothing is pending — `means` is tight', () => {
      // Review finding: with the #242 check at display precision, an undo from 4.1256 to 4.13 left
      // "4.1256" on screen indefinitely, because that check has no expiry.
      expect(resyncBuffered('4.1256', 4.13, [], parseNumber, 10, at2).text).toBe('4.13');
      expect(resyncBuffered('4.1256', 4.1301, [], parseNumber, 10, at2).text).toBe('4.13');
    });

    it('…while a commit IS pending, a change equal to it at the precision is taken for its echo, for at most the window', () => {
      const pending = [{ value: 4.1256, at: 0 }];
      expect(resyncBuffered('4.1256', 4.13, pending, parseNumber, 10, at2).text).toBeNull();
      expect(resyncBuffered('4.1256', 4.13, pending, parseNumber, ECHO_WINDOW_MS + 1, at2).text).toBe('4.13');
    });

    it('`means` still absorbs representation noise with nothing pending (30 vs 29.999999999999996)', () => {
      expect(resyncBuffered('30', 30 * Math.PI / 180 * 180 / Math.PI, [], parseNumber, 10, at2).text).toBeNull();
    });

    it('a value that rounds to -0 matches, and shows as, 0', () => {
      expect(at2.same(-0.001, 0)).toBe(true);
      expect(at2.format(-0.001)).toBe('0');
    });
  });
});
