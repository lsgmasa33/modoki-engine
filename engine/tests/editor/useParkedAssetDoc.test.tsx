/** `useParkedAssetDoc` — the panel half of manual asset saves (#259), in jsdom.
 *
 *  Replaces the `useDebouncedSave` suite this file grew out of. The contract it locks down is
 *  deliberately different in one place: parking is SYNCHRONOUS. The debounced hook cancelled its
 *  pending timer on unmount, so the last ≤400ms of edits were silently dropped when a panel tab
 *  closed — invisible while an autosave would catch the next edit, and unacceptable now that the
 *  registry is the only path to disk. The unmount test below is that regression, inverted.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import {
  useParkedAssetDoc, saveStatusLabel, clearDirtyAssets, getDirtyAssetPaths, peekDirtyAsset,
} from '@modoki/engine/editor';

const PATH = '/assets/fx/spark.particle.json';

// Unmount explicitly: this repo's vitest setup does not register @testing-library's auto-cleanup,
// so a hook left mounted keeps its registry SUBSCRIPTION live and re-renders during the next
// test's render — which is its own little cross-test channel.
beforeEach(() => clearDirtyAssets());
afterEach(() => { cleanup(); clearDirtyAssets(); });

function setup() {
  return renderHook(
    ({ v }: { v: { n: number } | null }) => useParkedAssetDoc(v, PATH, 'particle'),
    { initialProps: { v: null as { n: number } | null } },
  );
}

describe('useParkedAssetDoc', () => {
  it('parks the document as PANEL origin as soon as the value changes', () => {
    const { rerender, result } = setup();
    expect(getDirtyAssetPaths()).toEqual([]);

    const doc = { n: 1 };
    rerender({ v: doc });

    expect(getDirtyAssetPaths()).toEqual([PATH]);
    expect(peekDirtyAsset(PATH)).toEqual({ type: 'particle', data: doc, origin: 'panel' });
    expect(result.current.dirty).toBe(true);
  });

  it('does NOT park the value seeded by markSaved — opening an asset must not dirty it', () => {
    const { rerender, result } = setup();
    const loaded = { n: 0 };
    result.current.markSaved(loaded);
    rerender({ v: loaded });

    expect(getDirtyAssetPaths()).toEqual([]);
    expect(result.current.dirty).toBe(false);
  });

  it('parks an edit made AFTER the load baseline', () => {
    const { rerender, result } = setup();
    const loaded = { n: 0 };
    result.current.markSaved(loaded);
    rerender({ v: loaded });
    rerender({ v: { n: 1 } }); // a real edit — a new object, as every store update produces

    expect(getDirtyAssetPaths()).toEqual([PATH]);
  });

  it('a value edited and then UNMOUNTED is still parked (the debounce bug this replaces)', () => {
    const { rerender, unmount } = setup();
    rerender({ v: { n: 7 } });
    unmount();

    // The old hook cleared its pending timer here and the edit was gone — with the def still in
    // the editor store, and a re-open marking it as the SAVED baseline, so nothing could ever
    // write it. Parking is a Map.set; there is nothing pending to cancel.
    expect(getDirtyAssetPaths()).toEqual([PATH]);
    expect(peekDirtyAsset(PATH)?.data).toEqual({ n: 7 });
  });

  it('reports clean again once the registry is flushed — not just once it is dirtied', () => {
    // The direction that actually misleads: a save empties the registry without touching any panel
    // state, so a plainly-read indicator would sit on "Unsaved" over a file that is on disk. The
    // hook subscribes for exactly this.
    const { rerender, result } = setup();
    rerender({ v: { n: 1 } });
    expect(result.current.dirty).toBe(true);

    // Inside act(): the registry notifies its subscribers synchronously, but the React re-render
    // that follows is scheduled — without act() the assertion reads the pre-notification render.
    act(() => clearDirtyAssets()); // stands in for a successful flush
    expect(result.current.dirty).toBe(false);
  });

  it('parks nothing when no asset is open (no path)', () => {
    // Rendered inline rather than through setup(): `setup(undefined)` would take the DEFAULT
    // parameter and quietly test the with-path case again — a test that passes for the wrong
    // reason. (It failed loudly instead, which is the only reason this comment exists.)
    const { rerender } = renderHook(
      ({ v }: { v: { n: number } | null }) => useParkedAssetDoc(v, undefined, 'particle'),
      { initialProps: { v: null as { n: number } | null } },
    );
    rerender({ v: { n: 1 } });
    expect(getDirtyAssetPaths()).toEqual([]);
  });
});

describe('saveStatusLabel', () => {
  it('says what is true of the FILE, and names the key that changes it', () => {
    expect(saveStatusLabel(false)).toBe('Saved ✓');
    expect(saveStatusLabel(true)).toContain('Unsaved');
    expect(saveStatusLabel(true)).toContain('⌘S');
  });
});
