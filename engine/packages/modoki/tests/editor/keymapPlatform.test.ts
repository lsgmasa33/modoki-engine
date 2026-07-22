/** `mod` resolution on a NON-Mac platform.
 *
 *  `keymap.ts` decides once, at module scope, whether `mod` means Cmd or Ctrl:
 *      const isMac = /Mac|iPhone|iPad/.test(navigator.platform)
 *  Every other keymap test therefore only ever exercises the Mac branch, because the dev
 *  and CI hosts are Macs. The Windows/Linux half of every `mod+…` binding in the editor —
 *  Cmd+S, Cmd+Z, Cmd+D, Cmd+C/V/X — has never actually been executed by a test.
 *
 *  Isolated in its own FILE because the decision is module-level: it must be stubbed
 *  before the module is first imported, and `vi.resetModules()` only helps if nothing else
 *  in the file has already imported it. */

import { describe, it, expect, vi, afterEach } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

/** Import a FRESH copy of keymap.ts with `navigator.platform` stubbed. */
async function importKeymapAs(platform: string) {
  vi.resetModules();
  vi.stubGlobal('navigator', { platform, userAgent: platform });
  return import('../../src/editor/input/keymap');
}

describe('mod → Ctrl on Windows/Linux', () => {
  it('resolves `mod` to control, not meta', async () => {
    const { normalizeChord } = await importKeymapAs('Win32');
    expect(normalizeChord('mod+d')).toBe('control+d');
    expect(normalizeChord('mod+d')).not.toBe('meta+d');
  });

  it('matches a REAL Ctrl event and rejects the Cmd one', async () => {
    // The bug this guards: if `mod` resolved to meta on Windows, every editor chord would
    // be dead there — Ctrl+S would not save, Ctrl+Z would not undo — and no test would say so.
    const { register, resolve, chordFromEvent, clearBindings } = await importKeymapAs('Win32');
    clearBindings();
    register({ id: 'app.save', keys: 'mod+s', scope: 'app-chord', run: () => {} });
    const ctx = { focusedPanel: null, overlay: null, textEditable: false };

    expect(resolve(chordFromEvent({ key: 's', ctrlKey: true }), ctx)?.id).toBe('app.save');
    expect(resolve(chordFromEvent({ key: 's', metaKey: true }), ctx)).toBeNull();
  });

  it('formats mod as ⌃ rather than ⌘', async () => {
    const { formatChord } = await importKeymapAs('Win32');
    expect(formatChord('mod+d')).toBe('⌃D');
  });

  it('leaves an EXPLICIT meta/ctrl chord platform-independent', async () => {
    // Only `mod` is platform-sensitive. A binding that deliberately says 'meta' or
    // 'control' must mean exactly that on every platform.
    const win = await importKeymapAs('Win32');
    expect(win.normalizeChord('meta+d')).toBe('meta+d');
    expect(win.normalizeChord('control+d')).toBe('control+d');
    const mac = await importKeymapAs('MacIntel');
    expect(mac.normalizeChord('meta+d')).toBe('meta+d');
    expect(mac.normalizeChord('control+d')).toBe('control+d');
  });
});

describe('mod → Cmd on Mac (the branch every other test exercises)', () => {
  it('resolves `mod` to meta', async () => {
    const { normalizeChord } = await importKeymapAs('MacIntel');
    expect(normalizeChord('mod+d')).toBe('meta+d');
  });

  it('matches a REAL Cmd event and rejects the Ctrl one', async () => {
    const { register, resolve, chordFromEvent, clearBindings } = await importKeymapAs('MacIntel');
    clearBindings();
    register({ id: 'app.save', keys: 'mod+s', scope: 'app-chord', run: () => {} });
    const ctx = { focusedPanel: null, overlay: null, textEditable: false };

    expect(resolve(chordFromEvent({ key: 's', metaKey: true }), ctx)?.id).toBe('app.save');
    expect(resolve(chordFromEvent({ key: 's', ctrlKey: true }), ctx)).toBeNull();
  });
});

describe('a missing navigator does not break the module', () => {
  it('falls back to the non-Mac branch instead of throwing', async () => {
    // Headless/SSR: `navigator` may be absent entirely. The module must still import.
    vi.resetModules();
    vi.stubGlobal('navigator', undefined);
    const { normalizeChord } = await import('../../src/editor/input/keymap');
    expect(normalizeChord('mod+d')).toBe('control+d');
  });
});
