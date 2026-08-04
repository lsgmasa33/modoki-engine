/** The Assets panel's keyboard decision (#105 Phase 3).
 *
 *  Before the extraction this logic lived inside a 2,111-line React component and
 *  had NO unit cover — the whole file measured 0% line coverage, defended only by
 *  e2e. These tests exist for the parts that are easy to get wrong and produce no
 *  visible symptom: the platform-dependent delete chord, the key that is answered
 *  but deliberately not consumed, and which paths move the range anchor. */

import { describe, it, expect } from 'vitest';
import { resolveAssetKey, TYPE_AHEAD_RESET_MS, type AssetKeyInput } from '../../src/editor/panels/assetKeyCommands';
import type { AssetEntry } from '../../src/editor/utils/assetPaths';

const asset = (path: string, name = path.split('/').pop()!): AssetEntry =>
  ({ path, name, type: 'texture' }) as AssetEntry;

const ASSETS = [asset('/a/apple.png'), asset('/a/banana.png'), asset('/a/cherry.png')];
const ORDER = ASSETS.map((a) => a.path);

function key(over: Partial<AssetKeyInput> = {}): AssetKeyInput {
  return {
    key: 'x', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
    targetTag: 'DIV', isMac: false,
    order: ORDER, selected: null, anchor: null, assets: ASSETS,
    typeAhead: { str: '', t: 0 }, now: 10_000,
    ...over,
  };
}

describe('an inline rename field keeps its own keys', () => {
  // Regression shape: a rename field that loses Delete to the panel deletes the
  // asset the user is renaming.
  for (const tag of ['INPUT', 'TEXTAREA']) {
    it(`returns none while focus is in ${tag}`, () => {
      const r = resolveAssetKey(key({ targetTag: tag, key: 'Delete' }));
      expect(r.command.kind).toBe('none');
      expect(r.preventDefault).toBe(false);
    });
  }
});

describe('the delete chord is platform-dependent', () => {
  it('macOS deletes on Cmd+Backspace', () => {
    expect(resolveAssetKey(key({ isMac: true, key: 'Backspace', metaKey: true })).command.kind).toBe('delete');
  });

  it('macOS does NOT delete on a bare Backspace', () => {
    // Backspace is not length-1, so it is not type-ahead either — nothing claims it.
    expect(resolveAssetKey(key({ isMac: true, key: 'Backspace' })).command.kind).toBe('none');
  });

  it('Windows/Linux delete on Delete', () => {
    expect(resolveAssetKey(key({ isMac: false, key: 'Delete' })).command.kind).toBe('delete');
  });

  it('Windows/Linux do NOT delete on Cmd+Backspace', () => {
    expect(resolveAssetKey(key({ isMac: false, key: 'Backspace', metaKey: true })).command.kind).toBe('none');
  });

  it('macOS does NOT delete on the Windows key', () => {
    expect(resolveAssetKey(key({ isMac: true, key: 'Delete' })).command.kind).toBe('none');
  });
});

describe('the modifier is Cmd on macOS and Ctrl elsewhere', () => {
  it('Cmd+C copies on macOS', () => {
    expect(resolveAssetKey(key({ isMac: true, key: 'c', metaKey: true })).command).toEqual({ kind: 'clipboard', op: 'copy' });
  });

  it('Ctrl+C copies on Windows', () => {
    expect(resolveAssetKey(key({ isMac: false, key: 'c', ctrlKey: true })).command).toEqual({ kind: 'clipboard', op: 'copy' });
  });

  // FIXED (was a real bug, found by these tests during the Phase 3 extraction):
  // the wrong-platform modifier used to leave `mod` false, so the printable key
  // reached type-ahead and Ctrl+C on macOS silently jumped the selection to the
  // first asset starting with "c". A chord that is not this platform's is not
  // ours — it must fall through untouched, not do something else.
  it('the wrong-platform modifier does nothing at all, and does not type-ahead', () => {
    const mac = resolveAssetKey(key({ isMac: true, key: 'c', ctrlKey: true }));
    expect(mac.command.kind).toBe('none');
    expect(mac.preventDefault).toBe(false);
    // Crucially it must not even record a type-ahead buffer — a stray "c" left in
    // it would change what the NEXT genuine keystroke matches.
    expect(mac.typeAhead).toBeUndefined();

    const win = resolveAssetKey(key({ isMac: false, key: 'c', metaKey: true }));
    expect(win.command.kind).toBe('none');
    expect(win.typeAhead).toBeUndefined();
  });

  it('still falls through for a modified key with no chord behind it', () => {
    // Ctrl+B is nobody's shortcut here; it must reach the window keymap rather
    // than jumping to "banana".
    expect(resolveAssetKey(key({ isMac: true, key: 'b', ctrlKey: true })).command.kind).toBe('none');
    expect(resolveAssetKey(key({ isMac: false, key: 'b', metaKey: true })).command.kind).toBe('none');
  });

  it('an UNMODIFIED printable key still type-aheads on both platforms', () => {
    // The fix must not cost the feature it was hiding inside.
    expect(resolveAssetKey(key({ isMac: true, key: 'c' })).command).toMatchObject({ paths: ['/a/cherry.png'] });
    expect(resolveAssetKey(key({ isMac: false, key: 'c' })).command).toMatchObject({ paths: ['/a/cherry.png'] });
  });

  it('claims each chord it owns, in upper case too', () => {
    const chord = (k: string) => resolveAssetKey(key({ key: k, ctrlKey: true })).command;
    expect(chord('x')).toEqual({ kind: 'clipboard', op: 'cut' });
    expect(chord('V')).toEqual({ kind: 'clipboard', op: 'paste' });
    expect(chord('D')).toEqual({ kind: 'duplicate' });
    expect(resolveAssetKey(key({ key: 'N', ctrlKey: true, shiftKey: true })).command).toEqual({ kind: 'new-folder' });
  });

  it('Ctrl+Shift+N is a new folder, Ctrl+N is not ours', () => {
    expect(resolveAssetKey(key({ key: 'n', ctrlKey: true })).command.kind).toBe('none');
  });
});

describe('keys that need a selection are consumed even without one', () => {
  // The key must not fall through to the window dispatcher just because nothing
  // is selected — that would fire some other panel's shortcut.
  it('F2 with no selection is claimed, with a null path', () => {
    const r = resolveAssetKey(key({ key: 'F2' }));
    expect(r.command).toEqual({ kind: 'rename', path: null });
    expect(r.preventDefault).toBe(true);
  });

  it('F2 with a selection carries it', () => {
    expect(resolveAssetKey(key({ key: 'F2', selected: '/a/banana.png' })).command)
      .toEqual({ kind: 'rename', path: '/a/banana.png' });
  });

  it('Enter opens the selected path', () => {
    expect(resolveAssetKey(key({ key: 'Enter', selected: '/a/cherry.png' })).command)
      .toEqual({ kind: 'open', path: '/a/cherry.png' });
  });
});

describe('Select All takes the visible order and leaves the anchor alone', () => {
  it('selects every visible path', () => {
    const r = resolveAssetKey(key({ key: 'a', ctrlKey: true, anchor: '/a/banana.png' }));
    expect(r.command).toEqual({ kind: 'select', paths: ORDER, activate: null, scrollTo: null });
    // `anchor` absent ⇒ unchanged. Asserted explicitly: moving it here would
    // silently change where the next Shift+click ranges from.
    expect('anchor' in r.command).toBe(false);
  });

  it('copies the order rather than aliasing it', () => {
    const r = resolveAssetKey(key({ key: 'a', ctrlKey: true }));
    expect(r.command.kind === 'select' && r.command.paths).not.toBe(ORDER);
  });
});

describe('arrow navigation', () => {
  const arrow = (over: Partial<AssetKeyInput>) => resolveAssetKey(key({ key: 'ArrowDown', ...over })).command;

  it('starts at the first row when nothing is selected', () => {
    expect(arrow({})).toEqual({ kind: 'select', paths: ['/a/apple.png'], activate: '/a/apple.png', scrollTo: '/a/apple.png', anchor: '/a/apple.png' });
    expect(resolveAssetKey(key({ key: 'ArrowUp' })).command).toMatchObject({ paths: ['/a/apple.png'] });
  });

  it('moves down and up by one', () => {
    expect(arrow({ selected: '/a/apple.png' })).toMatchObject({ paths: ['/a/banana.png'] });
    expect(resolveAssetKey(key({ key: 'ArrowUp', selected: '/a/banana.png' })).command).toMatchObject({ paths: ['/a/apple.png'] });
  });

  it('clamps at both ends instead of wrapping', () => {
    expect(arrow({ selected: '/a/cherry.png' })).toMatchObject({ paths: ['/a/cherry.png'] });
    expect(resolveAssetKey(key({ key: 'ArrowUp', selected: '/a/apple.png' })).command).toMatchObject({ paths: ['/a/apple.png'] });
  });

  it('consumes the key but does nothing when the list is empty', () => {
    const r = resolveAssetKey(key({ key: 'ArrowDown', order: [] }));
    expect(r.command).toEqual({ kind: 'handled' });
    expect(r.preventDefault).toBe(true);
  });

  it('consumes the key when the next visible path has no asset behind it', () => {
    // A path in `order` with no matching asset is a stale visible list; navigating
    // onto it must not activate an asset that is not there.
    expect(resolveAssetKey(key({ key: 'ArrowDown', order: ['/a/ghost.png'], assets: ASSETS })).command)
      .toEqual({ kind: 'handled' });
  });

  it('a selected path missing from the order restarts at the top', () => {
    expect(arrow({ selected: '/a/not-visible.png' })).toMatchObject({ paths: ['/a/apple.png'] });
  });
});

describe('Shift+Arrow extends the range WITHOUT moving the anchor', () => {
  // Getting this backwards makes each Shift+Arrow collapse the range to two rows.
  it('extends from the anchor, downward', () => {
    const r = resolveAssetKey(key({ key: 'ArrowDown', selected: '/a/banana.png', anchor: '/a/apple.png', shiftKey: true }));
    expect(r.command).toEqual({
      kind: 'select', paths: ['/a/apple.png', '/a/banana.png', '/a/cherry.png'],
      activate: '/a/cherry.png', scrollTo: '/a/cherry.png',
    });
    expect('anchor' in r.command).toBe(false);
  });

  it('extends upward, with the range still in visible order', () => {
    const r = resolveAssetKey(key({ key: 'ArrowUp', selected: '/a/cherry.png', anchor: '/a/cherry.png', shiftKey: true }));
    expect(r.command).toMatchObject({ paths: ['/a/banana.png', '/a/cherry.png'] });
  });

  it('plain Arrow DOES move the anchor', () => {
    const r = resolveAssetKey(key({ key: 'ArrowDown', selected: '/a/apple.png', anchor: '/a/apple.png' }));
    expect(r.command).toMatchObject({ anchor: '/a/banana.png' });
  });

  it('a stale anchor still activates and scrolls, but does not re-select', () => {
    // Preserved from the pre-extraction handler: activate/scroll ran on EVERY arrow
    // path. Collapsing the selection here would discard the user's range instead.
    const r = resolveAssetKey(key({ key: 'ArrowDown', selected: '/a/apple.png', anchor: '/a/gone.png', shiftKey: true }));
    expect(r.command).toEqual({ kind: 'select', activate: '/a/banana.png', scrollTo: '/a/banana.png' });
    expect(r.command.kind === 'select' && r.command.paths).toBeUndefined();
  });
});

describe('type-ahead', () => {
  it('jumps to the first visible match and moves the anchor', () => {
    const r = resolveAssetKey(key({ key: 'b' }));
    expect(r.command).toEqual({
      kind: 'select', paths: ['/a/banana.png'], activate: '/a/banana.png',
      scrollTo: '/a/banana.png', anchor: '/a/banana.png',
    });
  });

  it('does NOT consume the key, even on a match', () => {
    // The one handled case that must still reach the window keymap dispatcher.
    expect(resolveAssetKey(key({ key: 'b' })).preventDefault).toBe(false);
    expect(resolveAssetKey(key({ key: 'z' })).preventDefault).toBe(false);
  });

  it('accumulates within the window, so "ba" still finds banana', () => {
    const first = resolveAssetKey(key({ key: 'b', now: 1000 }));
    expect(first.typeAhead).toEqual({ str: 'b', t: 1000 });
    const second = resolveAssetKey(key({ key: 'a', now: 1200, typeAhead: first.typeAhead! }));
    expect(second.typeAhead).toEqual({ str: 'ba', t: 1200 });
    expect(second.command).toMatchObject({ paths: ['/a/banana.png'] });
  });

  it('resets after the idle window, so a late "a" means apple not banana', () => {
    const stale = { str: 'b', t: 1000 };
    const late = resolveAssetKey(key({ key: 'a', now: 1000 + TYPE_AHEAD_RESET_MS + 1, typeAhead: stale }));
    expect(late.typeAhead!.str).toBe('a');
    expect(late.command).toMatchObject({ paths: ['/a/apple.png'] });
  });

  it('keeps accumulating exactly AT the window boundary', () => {
    // `>` not `>=` — pinning the boundary so a refactor cannot quietly flip it.
    const r = resolveAssetKey(key({ key: 'a', now: 1000 + TYPE_AHEAD_RESET_MS, typeAhead: { str: 'b', t: 1000 } }));
    expect(r.typeAhead!.str).toBe('ba');
  });

  it('records the buffer even when nothing matches, so the next key can complete it', () => {
    const r = resolveAssetKey(key({ key: 'z' }));
    expect(r.command.kind).toBe('none');
    expect(r.typeAhead).toEqual({ str: 'z', t: 10_000 });
  });

  it('is case-insensitive', () => {
    expect(resolveAssetKey(key({ key: 'B' })).command).toMatchObject({ paths: ['/a/banana.png'] });
  });

  it('ignores modified and multi-character keys', () => {
    expect(resolveAssetKey(key({ key: 'b', altKey: true })).typeAhead).toBeUndefined();
    expect(resolveAssetKey(key({ key: 'Tab' })).command.kind).toBe('none');
    expect(resolveAssetKey(key({ key: 'Tab' })).typeAhead).toBeUndefined();
  });

  it('searches visible order, not asset order', () => {
    const reversed = [...ORDER].reverse();
    // Two assets start with the same letter; the FIRST visible one wins.
    const assets = [...ASSETS, asset('/a/blueberry.png')];
    const r = resolveAssetKey(key({ key: 'b', order: ['/a/blueberry.png', ...reversed], assets }));
    expect(r.command).toMatchObject({ paths: ['/a/blueberry.png'] });
  });

  it('matches on the path base as well as the display name', () => {
    const odd = [{ path: '/a/zebra.png', name: 'Renamed', type: 'texture' } as AssetEntry];
    const r = resolveAssetKey(key({ key: 'z', order: ['/a/zebra.png'], assets: odd }));
    expect(r.command).toMatchObject({ paths: ['/a/zebra.png'] });
  });
});
