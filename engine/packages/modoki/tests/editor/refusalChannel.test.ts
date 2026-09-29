/** #1824, owner ruling FA (b) 2026-09-29 — a direct human gesture the backend refuses puts the route's sentence on
 *  screen; background work states it in the console only. The two functions ARE the rule, so each is pinned on both
 *  channels. (A real background caller is pinned in modelImportRigged.test.ts: the refused derive raises no toast.)
 *
 *  Mutation: have `reportBackgroundRefusal` call `showToast` — the second case goes red. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { reportGestureRefusal, reportBackgroundRefusal, refusedItemsText, fileNameOf } from '../../src/editor/backend/refusalChannel';
import { useEditorStore } from '../../src/editor/store/editorStore';

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => { useEditorStore.setState({ toast: null }); warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { warn.mockRestore(); });

describe('refusalChannel (#1824, ruling FA)', () => {
  it('a gesture refusal toasts the sentence as a warning, and logs it with the full detail', () => {
    reportGestureRefusal('Could not rename a.png: held by an editor', 'a.png: held by an editor\nb.png: exists');
    expect(useEditorStore.getState().toast).toMatchObject({ message: 'Could not rename a.png: held by an editor', kind: 'warn' });
    expect(String(warn.mock.calls[0][0])).toContain('b.png: exists');
  });

  it('a background refusal is the console\'s only', () => {
    reportBackgroundRefusal('[Editor] the layout autosave was not written: EACCES');
    expect(useEditorStore.getState().toast).toBeNull();
    expect(String(warn.mock.calls[0][0])).toContain('EACCES');
  });

  it('a batch names the first two items and counts the rest', () => {
    expect(refusedItemsText(['a: x'])).toBe('a: x');
    expect(refusedItemsText(['a: x', 'b: y', 'c: z', 'd: w'])).toBe('a: x; b: y; +2 more');
    expect(fileNameOf('/assets/tex/a.png')).toBe('a.png');
  });
});
