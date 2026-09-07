/** The Asset Inspector's edits must PARK, not write — and must still apply live (#831).
 *
 *  `persistAssetEdit` is how a material / shader / animset field edit leaves the Inspector. It
 *  used to POST `/api/write-file` on every keystroke, so one numeric field hit the disk with no
 *  save action while `get_editor_state` reported `persistenceMode: 'manual'` and
 *  `unsavedChanges: false` — a committed file rewritten behind the human's back, the hazard
 *  CLAUDE.md's "stage paths EXPLICITLY" rule exists for (#18). #259 made the five asset EDITORS
 *  manual on the premise that manual save was "every other surface"; the premise was false and
 *  these four asset VIEWS are the population it missed.
 *
 *  Two halves are asserted here, and BOTH matter:
 *   - it parks, and does not write. A test that only checked the registry would pass just as well
 *     if the function parked AND still wrote, which is the worst outcome available (two
 *     persistence contracts for one file — exactly what #259 removed for the editors).
 *   - the optimistic live update still happens, synchronously. That is what makes the viewport
 *     reflect an Inspector edit immediately, and a later "fix" must not quietly trade it away.
 *
 *  The trailing-newline half of #831 is no longer asserted here: the bytes are now produced
 *  server-side by `assetJsonBytes`, so it is pinned where it actually happens, in
 *  `tests/plugins/assetJsonBytesAgree.test.ts`, against the file rather than a request body.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { persistAssetEdit, reportWriteFailed } from '../../packages/modoki/src/editor/panels/assetViews/persist';
import { clearDirtyAssets, peekDirtyAsset, isAssetDirty, hasDirtyAssets } from '../../packages/modoki/src/editor/scene/dirtyAssets';
import { useEditorStore } from '@modoki/engine/editor';

const PATH = '/assets/materials/rock.mat.json';
const DOC = { color: 0xff0000 };

type Invalidate = (path: string, updated: unknown) => void;
let invalidate: ReturnType<typeof vi.fn<Invalidate>>;
let err: ReturnType<typeof vi.spyOn>;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clearDirtyAssets();
  invalidate = vi.fn<Invalidate>();
  err = vi.spyOn(console, 'error').mockImplementation(() => {});
  // Any fetch at all is a failure in these tests, so make one loud rather than silently satisfied.
  fetchSpy = vi.fn(async () => { throw new Error('persistAssetEdit must not perform a write'); });
  vi.stubGlobal('fetch', fetchSpy);
  useEditorStore.setState({ toast: null });
});
afterEach(() => { clearDirtyAssets(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const toast = () => useEditorStore.getState().toast;

describe('persistAssetEdit parks the edit instead of writing it (#831)', () => {
  it('parks the doc under its own type, as a PANEL write', () => {
    persistAssetEdit(PATH, 'material', DOC, invalidate);

    expect(isAssetDirty(PATH)).toBe(true);
    const parked = peekDirtyAsset(PATH);
    expect(parked?.data).toEqual(DOC);
    // The type is what lets `pendingAssetDoc` refuse to hand this doc to a different view.
    expect(parked?.type).toBe('material');
    // `panel` (not the `agent` default) is what makes the flush pass `replace:true` — a panel is a
    // full-document editor, so dropping a top-level key is a legitimate edit for it.
    expect(parked?.origin).toBe('panel');
  });

  it('performs NO write — the whole point of the change', () => {
    persistAssetEdit(PATH, 'material', DOC, invalidate);
    expect(fetchSpy, 'persistAssetEdit hit the network; parking AND writing is worse than either')
      .not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
    expect(toast()).toBeNull();
  });

  it('still applies the edit LIVE and synchronously — the viewport must not wait for Cmd+S', () => {
    persistAssetEdit(PATH, 'material', DOC, invalidate);
    // Synchronously: no await anywhere above, deliberately.
    expect(invalidate).toHaveBeenCalledWith(PATH, DOC);
  });

  it('parks each asset type under the type it was given', () => {
    persistAssetEdit('/assets/shaders/holo.shader.json', 'shader', { name: 'Holo' }, invalidate);
    persistAssetEdit('/assets/animsets/a.animset.json', 'animset', { clips: [] }, invalidate);
    expect(peekDirtyAsset('/assets/shaders/holo.shader.json')?.type).toBe('shader');
    expect(peekDirtyAsset('/assets/animsets/a.animset.json')?.type).toBe('animset');
  });

  it('an UNDO parks too — it must not be the one path that writes', () => {
    // The undo/redo closures call straight back into this function, and they may run after the
    // originating panel has unmounted. That is why this is a module function and not a hook.
    const older = { color: 0x00ff00 };
    persistAssetEdit(PATH, 'material', DOC, invalidate);
    persistAssetEdit(PATH, 'material', older, invalidate); // the undo closure's call
    expect(peekDirtyAsset(PATH)?.data).toEqual(older); // last write wins, per the registry
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(hasDirtyAssets()).toBe(true);
  });
});

describe('reportWriteFailed still reports — atlasPersist writes directly and depends on it', () => {
  // `persistAssetEdit` no longer writes, so it can no longer fail; `atlasPersist.ts` DOES write
  // (a compare-and-swap queue against /api/write-file-if-match) and reports through this function.
  // Keeping its cover here rather than deleting it with the write path it used to serve.
  it('names the file and the reason, in the console AND a toast', () => {
    reportWriteFailed(PATH, 'HTTP 403');
    expect(err).toHaveBeenCalled();
    expect(String(err.mock.calls[0]?.[0])).toContain(PATH);
    expect(String(err.mock.calls[0]?.[0])).toContain('HTTP 403');
    expect(toast()?.message).toContain('rock.mat.json');
  });
});
