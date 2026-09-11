/** `typeText` reports what LANDED, not what was asked for (S3.18).
 *
 *  `typed: text.length` was a restatement of the request. `sendInputEvent` cannot fail, and
 *  Chromium's synthetic `char` path only inserts characters it can express as a `keyCode` — so
 *  non-ASCII input (CJK, emoji, accented letters) was reported as typed under `ok:true` while the
 *  field was provably unchanged. That is the same false-success class `enact.md` records for the
 *  readOnly case, which had only been closed for "nothing typable is focused".
 *
 *  These drive the REAL `typeText` against a fake webContents that scripts the two probes, so the
 *  measurement is asserted where it is computed — the route tests above it can only assert that a
 *  mocked verdict is passed through. */

import { describe, it, expect, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { typeText } from '../../electron/rendererOps';

/** What Chromium actually inserts for a `char` event carrying this keyCode. This is the MEASURED
 *  table from the #1081 probe (Electron 43.2.0, driven against a real `<textarea>`), not an
 *  assumption about what the names ought to do:
 *
 *    'Return' / 'Enter' / '\r' → "\n"   ·   'Tab' → "\t"   ·   '\n' → NOTHING   ·   printable → itself
 *
 *  ⚠️ A fake is only as true as the measurement behind it, and a fake that models behaviour nothing
 *  has proves nothing. That is why the live check against the running editor stays part of this fix
 *  rather than being replaced by these tests — this table only pins that `typeText` sends the
 *  spellings the probe found, and reacts correctly to what they insert. */
function insertedTextFor(keyCode: string): string {
  if (keyCode === 'Return' || keyCode === 'Enter' || keyCode === '\r') return '\n';
  if (keyCode === 'Tab') return '\t';
  if (keyCode === '\n') return '';   // measured: a raw LF inserts nothing, in every event shape
  return keyCode;
}

/** A window whose focused element accepts `accepts` characters of whatever is typed. */
function fakeWindow(opts: {
  typable?: boolean; before?: string; accepts?: number | 'all';
  /** Model a field that refuses to be emptied, to pin the clearFirst failure report. */
  unclearable?: boolean;
} = {}) {
  const { typable = true, before = '', accepts = 'all', unclearable = false } = opts;
  let value = before;
  let selected = false;
  const sent: Array<Record<string, unknown>> = [];
  const executeJavaScript = vi.fn(async (script: string) => {
    // The active-element probe is the one that answers `gameSwallows`.
    if (script.includes('gameSwallows')) return { typable, gameSwallows: false, descriptor: 'input#name' };
    // The select-all probe — a real <input>.select() selects, it does not change the value.
    // `unclearable` models a field that resists BOTH halves — the selection does not stick and
    // the delete is swallowed — which is the only way the caller ends up with old+new.
    if (script.includes('selectNodeContents')) { selected = !unclearable; return value; }
    return value;                                   // the focused-value probe
  });
  const sendInputEvent = vi.fn((e: Record<string, unknown>) => {
    sent.push(e);
    if (e.type === 'keyDown' && e.keyCode === 'Backspace') {
      if (unclearable) return;                      // swallows the delete
      if (selected) { value = ''; selected = false; } else value = value.slice(0, -1);
      return;
    }
    if (e.type !== 'char') return;
    const inserted = sent.filter((x) => x.type === 'char').length;
    if (accepts === 'all' || inserted <= accepts) {
      if (selected) { value = ''; selected = false; }  // Chromium replaces the selection
      value += insertedTextFor(String(e.keyCode));
    }
  });
  return {
    win: { webContents: { executeJavaScript, sendInputEvent } } as unknown as BrowserWindow,
    read: () => value,
    sent,
  };
}

describe('typeText measures the insert', () => {
  it('reports the MEASURED character count and echoes valueAfter', async () => {
    const { win } = fakeWindow({ before: '' });
    const r = await typeText(win, 'abc');
    expect(r).toMatchObject({ typed: 3, editable: true, valueAfter: 'abc' });
    expect(r.error).toBeUndefined();
  });

  it('a field that rejects the input is reported as a SHORT insert, with a cause', async () => {
    // `accepts: 0` stands in for a field that refuses what you type — a numeric input, a max
    // length, an input mask. `sendInputEvent` still cannot fail, so the MEASUREMENT is the only
    // thing that can notice.
    const { win, read } = fakeWindow({ before: '', accepts: 0 });
    const r = await typeText(win, 'abc');
    expect(read()).toBe('');                     // nothing actually landed…
    expect(r.typed).toBe(0);                     // …and that is what is reported
    expect(r.valueAfter).toBe('');
    expect(r.error).toMatch(/0 of 3 character\(s\) appear to have reached it/);
    expect(r.error).toMatch(/reformats, truncates or rejects input as you type/);
    // ⚠️ The message must NOT blame non-ASCII input. It did, and the claim is false: Japanese,
    // accented letters and emoji all insert cleanly through the char path (measured on Electron
    // 43.2.0 — bug `xaewBYMBYXoeuiTllsI8`, QA-INPUT-0003). The old wording sent agents to
    // modoki_eval, a NON-input write that a React controlled input never sees, so the
    // recommended workaround was strictly more fragile than the path that works. The owner
    // writes Japanese, which makes this the common path rather than a corner.
    expect(r.error).not.toMatch(/non-ASCII/);
    expect(r.error).not.toMatch(/modoki_eval/);
  });

  it('a PARTIAL insert is short too — not rounded up to success', async () => {
    const { win } = fakeWindow({ before: '', accepts: 2 });
    const r = await typeText(win, 'abcde');
    expect(r.typed).toBe(2);
    expect(r.error).toMatch(/2 of 5 character\(s\) appear to have reached it/);
  });

  it('measures the DELTA, so appending to an existing value is not double-counted', async () => {
    const { win } = fakeWindow({ before: 'Hero' });
    const r = await typeText(win, 'xy');
    expect(r.typed).toBe(2);
    expect(r.valueAfter).toBe('Heroxy');
    expect(r.error).toBeUndefined();
  });

  it('nothing typable focused is still the pre-existing failure, unchanged', async () => {
    const { win } = fakeWindow({ typable: false });
    const r = await typeText(win, 'abc');
    expect(r).toMatchObject({ typed: 0, editable: false });
  });

  it('an UNREADABLE target falls back to the requested count rather than reporting a false 0', async () => {
    // A contentEditable-less canvas wrapper: the value probe answers null, so there is no
    // measurement to make. Reporting `typed: 0` there would invent a failure.
    const executeJavaScript = vi.fn(async (script: string) =>
      (script.includes('gameSwallows') ? { typable: true, gameSwallows: false, descriptor: 'div#editor' } : null));
    const win = { webContents: { executeJavaScript, sendInputEvent: vi.fn() } } as unknown as BrowserWindow;
    const r = await typeText(win, 'abc');
    expect(r).toMatchObject({ typed: 3, editable: true, valueAfter: null });
    expect(r.error).toBeUndefined();
  });

  it('measures BEFORE the submitKey, which would blur the field away', async () => {
    const { win } = fakeWindow({ before: '' });
    const r = await typeText(win, 'ab', { submitKey: 'Tab' });
    expect(r.typed).toBe(2);
    expect(r.valueAfter).toBe('ab');
  });
});

/** REGRESSION (independent review, 2026-07-30). The measurement was
 *  `typed = max(0, after.length - before.length)` — the insert count ONLY when typing appends.
 *  Chromium replaces the current SELECTION, so the documented `clickCount:2` rename flow (and
 *  anything else that leaves text selected) under-counted, and when the replaced selection was
 *  longer than the new text the delta went negative and clamped to 0. A perfectly correct ASCII
 *  rename therefore came back `ok:false, typed:0` blaming non-ASCII — a cause that was simply
 *  false, sending the reader to work around a limitation they had not hit.
 *
 *  Containment answers the real question for BOTH shapes without knowing what was selected. */
describe('typeText and a replaced selection', () => {
  /** A field whose whole contents are SELECTED: the first char typed replaces them. */
  function fakeReplacingWindow(before: string) {
    let value = before;
    let first = true;
    const executeJavaScript = vi.fn(async (script: string) => {
      if (script.includes('gameSwallows')) return { typable: true, gameSwallows: false, descriptor: 'input#name' };
      return value;
    });
    const sendInputEvent = vi.fn((e: Record<string, unknown>) => {
      if (e.type !== 'char') return;
      if (first) { value = String(e.keyCode); first = false; return; }  // selection replaced
      value += String(e.keyCode);
    });
    return { webContents: { executeJavaScript, sendInputEvent } } as unknown as BrowserWindow;
  }

  it('a SHORTER replacement is a success, not a 0-character failure blaming non-ASCII', async () => {
    // "LongOldName" (11) → "ab" (2): the length delta is -9, clamped to 0.
    const r = await typeText(fakeReplacingWindow('LongOldName'), 'ab');
    expect(r.error, `a correct rename must not report an error: ${r.error}`).toBeUndefined();
    expect(r.typed).toBe(2);
    expect(r.valueAfter).toBe('ab');
  });

  it('an EQUAL-LENGTH replacement is a success too (delta 0 used to read as "nothing typed")', async () => {
    const r = await typeText(fakeReplacingWindow('abc'), 'xyz');
    expect(r.error).toBeUndefined();
    expect(r.typed).toBe(3);
    expect(r.valueAfter).toBe('xyz');
  });

  it('…and a genuinely-dropped character is STILL reported, replacement or not', async () => {
    // The guard must not become permissive: if the text is not in the field, say so.
    let value = 'old';
    const win = {
      webContents: {
        executeJavaScript: vi.fn(async (script: string) =>
          (script.includes('gameSwallows') ? { typable: true, gameSwallows: false, descriptor: 'input#name' } : value)),
        sendInputEvent: vi.fn(() => { value = 'x'; }),   // only one char survives
      },
    } as unknown as BrowserWindow;
    const r = await typeText(win, 'xyz');
    expect(r.error).toMatch(/NOT in the field/);
  });
});

describe('clearFirst REPLACES the field (no native accelerator)', () => {
  it('empties the field before typing, instead of deleting one character', async () => {
    // The bug: clearFirst sent Cmd+A — a native macOS Edit-menu ACCELERATOR that
    // sendInputEvent cannot trigger — then one Backspace, so 'New Entity' + 'Buffalo Fort'
    // became 'New EntitBuffalo Fort' and was reported as {ok:true, typed:12}.
    const { win, read } = fakeWindow({ before: 'New Entity' });
    const r = await typeText(win, 'Buffalo Fort', { clearFirst: true });
    expect(read()).toBe('Buffalo Fort');
    expect(r.valueAfter).toBe('Buffalo Fort');
    expect(r.typed).toBe(12);
    expect(r.error).toBeUndefined();
  });

  it('never relies on a Cmd/Ctrl+A chord — selection happens in the renderer', async () => {
    const { win, sent } = fakeWindow({ before: 'New Entity' });
    await typeText(win, 'x', { clearFirst: true });
    const selectAllChord = sent.filter((e) => e.keyCode === 'a'
      && Array.isArray(e.modifiers) && (e.modifiers as string[]).some((m) => m === 'meta' || m === 'control'));
    expect(selectAllChord).toEqual([]);
  });

  it('a field it could NOT empty is an error naming what is still there, not a silent append', async () => {
    const { win, read } = fakeWindow({ before: 'Sticky', unclearable: true });
    const r = await typeText(win, 'New', { clearFirst: true });
    expect(read()).toBe('StickyNew');
    expect(r.error).toMatch(/clearFirst did NOT empty the field/);
    expect(r.error).toMatch(/"Sticky"/);
  });

  it('clearFirst on an already-empty field is a clean no-op', async () => {
    const { win } = fakeWindow({ before: '' });
    const r = await typeText(win, 'abc', { clearFirst: true });
    expect(r.valueAfter).toBe('abc');
    expect(r.error).toBeUndefined();
  });
});

/** #1081 — a newline could not be typed AT ALL, and the refusal blamed the field for it.
 *
 *  The cause, measured on Electron 43.2.0: `sendInputEvent` takes an ACCELERATOR NAME as `keyCode`,
 *  and a raw LF is not one, so it inserted nothing in every event shape. 'Return' does. A bare
 *  keyDown/keyUp pair inserts nothing for ANY spelling, which is the `submitKey:'Enter'` half. */
describe('typeText and the keys that are not characters (#1081)', () => {
  it('types a newline instead of silently dropping it', async () => {
    const { win, read } = fakeWindow({ before: '' });
    const r = await typeText(win, 'a\nb');
    expect(read()).toBe('a\nb');
    expect(r.valueAfter).toBe('a\nb');
    expect(r.typed).toBe(3);
    expect(r.error).toBeUndefined();
  });

  it('sends the newline as a Return press — never as the raw LF that inserts nothing', async () => {
    const { win, sent } = fakeWindow({ before: '' });
    await typeText(win, 'a\nb');
    const chars = sent.filter((e) => e.type === 'char').map((e) => e.keyCode);
    expect(chars).toContain('Return');
    expect(chars).not.toContain('\n');
    // The bracket still goes out, so an Enter-to-commit handler sees a real press.
    expect(sent.some((e) => e.type === 'keyDown' && e.keyCode === 'Return')).toBe(true);
  });

  it('sends a tab as the char ALONE — its keyDown would move focus and lose the insert', async () => {
    const { win, read, sent } = fakeWindow({ before: '' });
    const r = await typeText(win, 'a\tb');
    expect(read()).toBe('a\tb');
    expect(r.error).toBeUndefined();
    expect(sent.some((e) => e.type === 'char' && e.keyCode === 'Tab')).toBe(true);
    expect(sent.some((e) => e.type === 'keyDown' && e.keyCode === 'Tab')).toBe(false);
  });

  it('CRLF is normalised, so the measurement matches what the field can hold', async () => {
    // A textarea stores LF. Without this, the containment check looks for a CR that can never be
    // there and reports a correct insert as a dropped character.
    const { win, read } = fakeWindow({ before: '' });
    const r = await typeText(win, 'a\r\nb');
    expect(read()).toBe('a\nb');
    expect(r.error).toBeUndefined();
  });

  it("submitKey:'Enter' carries a char, so it can actually insert", async () => {
    const { win, sent } = fakeWindow({ before: '' });
    await typeText(win, 'ab', { submitKey: 'Enter' });
    expect(sent.some((e) => e.type === 'char' && e.keyCode === 'Enter')).toBe(true);
  });

  it("submitKey:'Tab' does NOT — its job is to blur, and a char would insert a literal tab", async () => {
    const { win, sent } = fakeWindow({ before: '' });
    await typeText(win, 'ab', { submitKey: 'Tab' });
    expect(sent.some((e) => e.type === 'char' && e.keyCode === 'Tab')).toBe(false);
    expect(sent.some((e) => e.type === 'keyDown' && e.keyCode === 'Tab')).toBe(true);
  });

  it('a character it cannot send is reported as THIS tool\'s limit, not the field rejecting it', async () => {
    // The reported harm: the old message said the field "reformats, truncates or rejects input as
    // you type", which sent a session hunting a bug in a field that was working fine.
    const { win } = fakeWindow({ before: '' });
    const r = await typeText(win, `a${String.fromCharCode(0)}b`);
    expect(r.error).toMatch(/could not be SENT at all/);
    expect(r.error).toMatch(/THIS TOOL's limit/);
    expect(r.error).not.toMatch(/reformats, truncates or rejects input as you type/);
  });

  it('reports an unsendable character even when the field cannot be MEASURED', async () => {
    // Found by review. The unreadable-target path (a contentEditable canvas wrapper) returns BEFORE
    // the containment check, and the report was only ever built inside that check — so this path
    // answered ok with characters silently missing, which is the very defect #1081 is about,
    // surviving exactly where the tool cannot see what happened.
    const executeJavaScript = vi.fn(async (script: string) =>
      (script.includes('gameSwallows') ? { typable: true, gameSwallows: false, descriptor: 'div#editor' } : null));
    const win = { webContents: { executeJavaScript, sendInputEvent: vi.fn() } } as unknown as BrowserWindow;
    const r = await typeText(win, `a${String.fromCharCode(0)}b`);
    expect(r.error).toMatch(/could not be SENT at all/);
    expect(r.error).toMatch(/THIS TOOL's limit/);
  });

  it('reports BOTH a clearFirst failure and an unsendable character', async () => {
    // Two independent failures on one call: the field would not empty, and a character never went
    // out. Reporting only whichever returns first loses a cause the caller needs.
    const { win } = fakeWindow({ before: 'Sticky', unclearable: true });
    const r = await typeText(win, `a${String.fromCharCode(0)}b`, { clearFirst: true });
    expect(r.error).toMatch(/could not be SENT at all/);
    expect(r.error).toMatch(/clearFirst did NOT empty the field/);
  });

  it('never guesses an Accelerator name for an unknown control character', async () => {
    // Guessing does not fail safely: an unrecognised name inserts a FRAGMENT OF ITSELF
    // ('NumpadEnter' → "Num"), so an unsendable character must not reach the wire at all.
    const { win, sent, read } = fakeWindow({ before: '' });
    await typeText(win, String.fromCharCode(0));
    expect(sent.filter((e) => e.type === 'char')).toEqual([]);
    expect(read()).toBe('');
  });
});
