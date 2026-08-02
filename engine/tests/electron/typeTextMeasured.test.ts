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

/** A window whose focused element accepts `accepts` characters of whatever is typed. */
function fakeWindow(opts: { typable?: boolean; before?: string; accepts?: number | 'all' } = {}) {
  const { typable = true, before = '', accepts = 'all' } = opts;
  let value = before;
  const sent: Array<Record<string, unknown>> = [];
  const executeJavaScript = vi.fn(async (script: string) => {
    // The active-element probe is the one that answers `gameSwallows`.
    if (script.includes('gameSwallows')) return { typable, gameSwallows: false, descriptor: 'input#name' };
    return value;                                   // the focused-value probe
  });
  const sendInputEvent = vi.fn((e: Record<string, unknown>) => {
    sent.push(e);
    if (e.type !== 'char') return;
    const inserted = sent.filter((x) => x.type === 'char').length;
    if (accepts === 'all' || inserted <= accepts) value += String(e.keyCode);
  });
  return {
    win: { webContents: { executeJavaScript, sendInputEvent } } as unknown as BrowserWindow,
    read: () => value,
  };
}

describe('typeText measures the insert', () => {
  it('reports the MEASURED character count and echoes valueAfter', async () => {
    const { win } = fakeWindow({ before: '' });
    const r = await typeText(win, 'abc');
    expect(r).toMatchObject({ typed: 3, editable: true, valueAfter: 'abc' });
    expect(r.error).toBeUndefined();
  });

  it('a field the char path cannot write is reported as a SHORT insert, with a cause', async () => {
    // `accepts: 0` stands in for the real failure mode: the keyCode carries no insertable
    // character, so nothing lands and sendInputEvent still cannot fail.
    const { win, read } = fakeWindow({ before: '', accepts: 0 });
    const r = await typeText(win, 'あいう');
    expect(read()).toBe('');                     // nothing actually landed…
    expect(r.typed).toBe(0);                     // …and that is what is reported
    expect(r.valueAfter).toBe('');
    expect(r.error).toMatch(/0 of 3 character\(s\) appear to have reached it/);
    expect(r.error).toMatch(/non-ASCII/);
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
