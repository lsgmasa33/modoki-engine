/** `resyncBuffered` — the re-sync decision behind every Inspector field's buffer (#242, #1411).
 *
 *  With the editor window unfocused no focus event fires, so this decision is the ONLY thing
 *  standing between a field's own commits coming back from the store and the text being typed.
 *  Each case replays a sequence the live editor produced; the #1411 one is the measured
 *  `…qr`-over-`…qrs` clobber. */
import { describe, it, expect } from 'vitest';
import { resyncBuffered, shownTextIsStale, roundedTo, ECHO_WINDOW_MS, IDLE_EDIT, nextBufferedEdit, holdsBufferedText, type BufferedEditEvent, type PendingCommit } from '../../packages/modoki/src/editor/panels/bufferedEcho';
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

/** #1905: the hold a focused field keeps against the store, and the undo that ends it. Replays the
 *  observed sequence: focus the field, type, Cmd+Z with it still focused. */
describe('nextBufferedEdit / holdsBufferedText', () => {
  const run = (...events: BufferedEditEvent[]) => events.reduce(nextBufferedEdit, IDLE_EDIT);

  it('holds the typed text while focused, so a store change cannot clobber an edit in flight', () => {
    expect(holdsBufferedText(run('focus'))).toBe(true);
    expect(holdsBufferedText(run('focus', 'input', 'input'))).toBe(true);
  });

  // #1914 (#1922): a session's keystrokes are one recording gesture (`fieldGesture.ts`). Mutation: bump `session` on
  // 'input' — every keystroke is its own gesture, and a retype of the base records again.
  it('a keystroke stays in its session; focus, blur, an undo/redo step and a new owner each begin another', () => {
    const typed = run('focus', 'input', 'input', 'input');
    expect(typed.session).toBe(run('focus').session);
    for (const e of ['focus', 'blur', 'undoRedo', 'rescope'] as const) {
      expect(nextBufferedEdit(typed, e).session, e).not.toBe(typed.session);
    }
  });

  it('#1905: an undo or redo while focused ends the hold, and the field stays focused', () => {
    const s = run('focus', 'input', 'undoRedo');
    expect(holdsBufferedText(s)).toBe(false);
    expect(s.focused).toBe(true);
    // A second step (redo after the undo) keeps it ended.
    expect(holdsBufferedText(nextBufferedEdit(s, 'undoRedo'))).toBe(false);
  });

  it('#1905: the next keystroke or wheel step after the undo starts a new edit, which holds again', () => {
    expect(holdsBufferedText(run('focus', 'input', 'undoRedo', 'input'))).toBe(true);
  });

  it('#1905: a focus after the undo starts a new edit too', () => {
    // An undo in an unfocused window (no blur ever fired), then a click into the field: no blur
    // separates the two, so the focus itself must clear the ended edit.
    expect(holdsBufferedText(run('undoRedo', 'focus'))).toBe(true);
  });

  it('blur releases the hold', () => {
    expect(holdsBufferedText(run('focus', 'input', 'blur'))).toBe(false);
  });

  it('#242: with no focus event (unfocused window) typing never arms the hold; the echo checks carry it', () => {
    expect(holdsBufferedText(run('input', 'input'))).toBe(false);
    expect(holdsBufferedText(run('input', 'undoRedo', 'input'))).toBe(false);
  });
});

/** #1907: text on screen that is not the user's, which the echo checks must not keep. Observed live:
 *  select two entities whose `x` differ (the field shows `----`), then one whose `x` is 0. The field
 *  went BLANK with no placeholder. */
describe('shownTextIsStale / resyncBuffered(stale)', () => {
  it('the observed mechanism: without it, the blank MIXED left behind already "means" 0', () => {
    expect(resyncBuffered('', 0, [], parseNumber, 10).text).toBeNull();
  });

  it('leaving MIXED with the blank untouched is stale, and re-syncs to the shared value', () => {
    expect(shownTextIsStale(false, true, /* placeholder */ true)).toBe(true);
    expect(resyncBuffered('', 0, [], parseNumber, 10, {}, true).text).toBe('0');
  });

  it('leaving MIXED with anything the user typed is NOT stale — even a blank: the echo checks still protect it', () => {
    // `5.` broadcast 5 and un-mixed the field; or `5` then backspace, a blank the user made.
    expect(shownTextIsStale(false, true, /* placeholder */ false)).toBe(false);
  });

  it('without a mixed exit or a new owner nothing is stale (#242: a cleared box keeps its own echo)', () => {
    expect(shownTextIsStale(false, false, false)).toBe(false);
    expect(shownTextIsStale(false, false, true)).toBe(false);
  });

  it('a new owner is stale whatever the text is', () => {
    expect(shownTextIsStale(true, false, false)).toBe(true);
    expect(shownTextIsStale(true, true, true)).toBe(true);
  });

  it('a stale re-sync writes through the field\'s format and forgets the pending record', () => {
    const r = resyncBuffered('1.50', 1.5, commits(1.5), parseNumber, 10, roundedTo(2), true);
    expect(r.text).toBe('1.5');
    expect(r.pending).toEqual([]);
  });
});

describe('nextBufferedEdit — a new owner ends the edit (#1907, Unity)', () => {
  const run = (...events: BufferedEditEvent[]) => events.reduce(nextBufferedEdit, IDLE_EDIT);

  it('a selection change while focused ends the hold, and the field stays focused', () => {
    const s = run('focus', 'input', 'rescope');
    expect(holdsBufferedText(s)).toBe(false);
    expect(s.focused).toBe(true);
  });

  it('the next keystroke after it starts a new edit on the new owner, which holds again', () => {
    expect(holdsBufferedText(run('focus', 'input', 'rescope', 'input'))).toBe(true);
  });
});
