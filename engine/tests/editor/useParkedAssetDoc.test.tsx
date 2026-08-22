/** `useParkedAssetDoc` — the panel half of manual asset saves (#259), in jsdom.
 *
 *  Replaces the `useDebouncedSave` suite this file grew out of. The contract it locks down is
 *  deliberately different in one place: parking is SYNCHRONOUS. The debounced hook cancelled its
 *  pending timer on unmount, so the last ≤400ms of edits were silently dropped when a panel tab
 *  closed — invisible while an autosave would catch the next edit, and unacceptable now that the
 *  registry is the only path to disk. The unmount test below is that regression, inverted.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import {
  useParkedAssetDoc, saveStatusLabel, clearDirtyAssets, getDirtyAssetPaths, peekDirtyAsset,
  flushDirtyAssets, markAssetDirty, getLastFlushedAsset,
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

/** The saved-baseline has to ADVANCE when a save writes the parked doc. Reported by the owner:
 *  move a keyframe, Cmd+S, Cmd+Z — the panel showed the reverted clip, the file kept the saved one,
 *  the editor reported clean, and no save could ever write the revert. */
describe('undo after a save', () => {
  const okFetch = () => vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) } as unknown as Response));

  it('parks the UNDO back to the doc the panel opened with', async () => {
    vi.stubGlobal('fetch', okFetch());
    const { rerender, result } = setup();
    const loaded = { n: 0 };
    result.current.markSaved(loaded);
    rerender({ v: loaded });                 // open: not dirty
    rerender({ v: { n: 1 } });               // edit
    expect(getDirtyAssetPaths()).toEqual([PATH]);

    await act(async () => { await flushDirtyAssets(); });  // Cmd+S
    expect(getDirtyAssetPaths()).toEqual([]);

    rerender({ v: loaded });                 // Cmd+Z — back to the doc we opened with

    // Before the fix this parked NOTHING: `loaded` was still the panel's saved-baseline, so the
    // revert compared equal to "already on disk" and the editor called itself clean.
    expect(getDirtyAssetPaths()).toEqual([PATH]);
    expect(peekDirtyAsset(PATH)?.data).toBe(loaded);
    expect(result.current.dirty).toBe(true);
  });

  it('keeps an edit made WHILE the save is in flight parked, and does not adopt it as saved', async () => {
    // The flush awaits per path, so an edit landing in that window replaces the entry. The write
    // that completes wrote the OLDER doc, so the newer one is still unsaved — it must survive the
    // flush's cleanup AND must not be taken as the new baseline.
    let release: (() => void) | undefined;
    vi.stubGlobal('fetch', vi.fn(async () => {
      await new Promise<void>((r) => { release = r; });
      return { ok: true, json: async () => ({ ok: true }) } as unknown as Response;
    }));
    const { rerender, result } = setup();
    const loaded = { n: 0 };
    result.current.markSaved(loaded);
    rerender({ v: loaded });
    rerender({ v: { n: 1 } });               // edit A — parked

    const flushing = flushDirtyAssets();     // Cmd+S, blocked on the stubbed write
    await act(async () => { rerender({ v: { n: 2 } }); }); // edit B, mid-flight
    await act(async () => { release!(); await flushing; });

    expect(peekDirtyAsset(PATH)?.data).toEqual({ n: 2 }); // B survived the cleanup
    expect(result.current.dirty).toBe(true);
  });

  it('does not adopt a doc THIS panel did not park (the identity match)', async () => {
    // Replacing the identity check with a bare `if (flushed != null)` used to pass every test in
    // this file. Distinguishing case: someone ELSE flushes this path while our value is untouched —
    // the baseline must not move, or a later revert to our loaded doc parks nothing.
    vi.stubGlobal('fetch', okFetch());
    const { rerender, result } = setup();
    const loaded = { n: 0 };
    result.current.markSaved(loaded);
    rerender({ v: loaded });

    markAssetDirty(PATH, 'particle', { n: 42 }, 'agent');   // not ours
    await act(async () => { await flushDirtyAssets(); });    // …and it is what got written

    expect(getLastFlushedAsset(PATH)).toEqual({ n: 42 });
    rerender({ v: { n: 1 } });                               // our first real edit
    expect(getDirtyAssetPaths()).toEqual([PATH]);
    rerender({ v: loaded });                                 // undo back to what WE loaded
    // If the baseline had wrongly adopted the agent's doc, `loaded` would differ from it and this
    // would re-park instead of clearing.
    expect(getDirtyAssetPaths()).toEqual([]);
  });

  it('opening an asset already flushed this session still does not dirty it', async () => {
    // The baseline advances only for the doc THIS panel parked — otherwise a fresh panel would
    // adopt a stale doc, differ from what it just loaded, and park on open.
    vi.stubGlobal('fetch', okFetch());
    const first = setup();
    first.result.current.markSaved({ n: 0 });
    first.rerender({ v: { n: 5 } });
    await act(async () => { await flushDirtyAssets(); });
    first.unmount();

    const second = setup();
    const reloaded = { n: 5 };               // same content, fresh object, as a real fetch gives
    second.result.current.markSaved(reloaded);
    second.rerender({ v: reloaded });

    expect(getDirtyAssetPaths()).toEqual([]);
    expect(second.result.current.dirty).toBe(false);
  });
});

/** Returning to the doc that is on disk must DROP the park, not leave the un-done edit queued.
 *  Found by an independent review: the mirror of the bug that started all this. */
describe('undo with no save in between', () => {
  it('drops the park when the value returns to the saved baseline', () => {
    const { rerender, result } = setup();
    const loaded = { n: 0 };
    result.current.markSaved(loaded);
    rerender({ v: loaded });
    rerender({ v: { n: 1 } });                    // edit → parked
    expect(getDirtyAssetPaths()).toEqual([PATH]);

    rerender({ v: loaded });                      // Cmd+Z, nothing saved in between

    // Before the fix the registry still held { n: 1 }, so Cmd+S wrote the edit just undone while
    // the panel showed the reverted doc — and then reported success.
    expect(getDirtyAssetPaths()).toEqual([]);
    expect(result.current.dirty).toBe(false);
  });

  it('leaves an AGENT park for the same path alone', () => {
    // We only drop what WE parked: an agent's pending write is not ours to judge.
    const { rerender, result } = setup();
    const loaded = { n: 0 };
    result.current.markSaved(loaded);
    rerender({ v: loaded });
    markAssetDirty(PATH, 'particle', { fromAgent: true }, 'agent');
    rerender({ v: loaded });                      // still the baseline — must not touch the registry

    expect(peekDirtyAsset(PATH)?.origin).toBe('agent');
  });

  it('does not relabel an AGENT-parked doc as a panel write', () => {
    // particle_set applies its def through the same store action the panel reads, so the panel's
    // value BECOMES the agent's object. Re-parking it would send replace:true at flush and delete
    // top-level fields the drop-key guard exists to refuse.
    const { rerender, result } = setup();
    const loaded = { n: 0 };
    result.current.markSaved(loaded);
    rerender({ v: loaded });
    const agentDoc = { n: 9 };
    markAssetDirty(PATH, 'particle', agentDoc, 'agent');
    rerender({ v: agentDoc });                    // the store handed us the agent's object

    expect(peekDirtyAsset(PATH)?.origin).toBe('agent');
  });
});

describe('saveStatusLabel', () => {
  it('says what is true of the FILE, and names the key that changes it', () => {
    expect(saveStatusLabel(false)).toBe('Saved ✓');
    expect(saveStatusLabel(true)).toContain('Unsaved');
    expect(saveStatusLabel(true)).toContain('⌘S');
  });
});

/**
 * Bug `EhE6JQkHRYttDGeGmtPK` (p0) — re-opening a panel already bound to the asset DISCARDED an
 * agent's parked write. The end state was the worst kind: the panel showed the edited doc, disk
 * held the old one, the registry was empty and the badge read `Saved ✓`, so Cmd+S wrote nothing
 * and the edit died at the next reload with no error.
 *
 * The hook's own comment states the invariant that was violated — "an agent's park for the same
 * path — which we did not make and cannot judge — survives" — so this is the code disagreeing
 * with its own documented contract, not an undocumented edge.
 *
 * Mechanism: an agent op applies its def through the same store action the panel reads, so the
 * panel's `value` BECOMES the agent's object. The "already parked" branch then adopted it into
 * `parkedRef` regardless of who parked it, and the later reconciliation branch — which discards
 * "our" park by identity — matched and dropped somebody else's write.
 */
describe('an agent park is not ours to discard (EhE6JQkHRYttDGeGmtPK)', () => {
  it('survives the panel re-opening on the doc the agent parked', () => {
    const { rerender, result } = setup();

    // The agent parks its own document for this path.
    const agentDoc = { n: 42 };
    act(() => { markAssetDirty(PATH, 'particle', agentDoc, 'agent'); });

    // The panel's value becomes that very object — the agent op wrote through the store the
    // panel reads. This must NOT re-park (it would relabel an agent write as 'panel').
    rerender({ v: agentDoc });
    expect(peekDirtyAsset(PATH)).toEqual({ type: 'particle', data: agentDoc, origin: 'agent' });

    // THE GESTURE: re-opening the already-bound panel takes the pendingAssetDoc branch, which
    // NORMALIZES the parked doc into a fresh object and seeds it as the load baseline. The new
    // identity is what makes the effect re-run — re-rendering with the same object would not,
    // which is why an obvious-looking repro of this bug passes.
    const normalized = { ...agentDoc };
    act(() => { result.current.markSaved(normalized); });
    rerender({ v: normalized });

    // The agent's write must still be pending. Before the fix the registry was empty here.
    expect(getDirtyAssetPaths()).toEqual([PATH]);
    expect(peekDirtyAsset(PATH)).toEqual({ type: 'particle', data: agentDoc, origin: 'agent' });
    expect(result.current.dirty).toBe(true);
    expect(saveStatusLabel(result.current.dirty)).toContain('Unsaved');
  });

  it('still discards the panel’s OWN park when the panel returns to the saved doc', () => {
    // The reverse control. The discard branch exists for a real bug (undo back to the baseline
    // leaving a stale park that Cmd+S would then write), so narrowing it must not disable it.
    const { rerender, result } = setup();
    const loaded = { n: 1 };
    act(() => { result.current.markSaved(loaded); });
    rerender({ v: loaded });
    expect(getDirtyAssetPaths()).toEqual([]);

    const edited = { n: 2 };
    rerender({ v: edited });
    expect(peekDirtyAsset(PATH)?.origin).toBe('panel');

    // Undo back to the loaded doc: our own park must go.
    rerender({ v: loaded });
    expect(getDirtyAssetPaths()).toEqual([]);
    expect(result.current.dirty).toBe(false);
  });
});
