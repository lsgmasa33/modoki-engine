/** `useMetaDirty` — the panel-visible half of parked `.meta.json` import-settings edits (#870).
 *
 *  Since #845 an Inspector import-settings change PARKS instead of writing, so there is unsaved
 *  work in the one place the human is looking with nothing on screen to say so. `pendingMeta.ts`
 *  exported the whole observability surface for it — `subscribePendingMeta`,
 *  `getPendingMetaVersion`, `isMetaDirty` (whose docblock literally says *"A panel's dirty
 *  indicator"*) — and **nothing consumed any of it**. The exports existing is what made the gap
 *  quiet: the module reads as complete.
 *
 *  ⚠️ **THE ASSERTION THAT MATTERS IS THE CLEAR DIRECTION.** *"A store subscription nothing
 *  re-renders on is this repo's most common defect shape"* (#870). A bare `isMetaDirty(path)` read
 *  in a panel body passes the "marker appears on a park" case perfectly well — the park happens
 *  during a render the panel is already doing. It fails only when the registry empties WITHOUT the
 *  panel being involved: a Cmd+S flush, or an agent's `discard_asset_edits`. Neither touches any
 *  panel state, so with no subscription nothing re-renders and the marker sits on "Unsaved" over a
 *  file that is already on disk — stale in the one direction that misleads. Every test below that
 *  drives a change from OUTSIDE the hook is testing the subscription, not the boolean.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useMetaDirty } from '../../packages/modoki/src/editor/panels/useMetaDirty';
import {
  parkMetaEdit, clearPendingMeta, clearMetaBaselines, discardPendingMeta, flushPendingMeta,
  stampMetaReadPath,
} from '../../packages/modoki/src/editor/scene/pendingMeta';

/** Park the way a PANEL does — on a document THIS path's own read handed back (#890/#891).
 *
 *  `parkMetaEdit` refuses a document whose read-path stamp is absent or names another path, so a
 *  hand-built literal is refused by design: it is precisely a document nobody read. Stamping it
 *  here is not ceremony to get past the guard — it is what makes these fixtures documents
 *  production can actually produce. A test that parks an impossible input proves nothing about
 *  the code path it claims to cover.
 *
 *  ⚠️ Tests that mean to exercise the REFUSAL call `parkMetaEdit` directly, and several below do. */
const parkAsPanel = (p: string, doc: Record<string, unknown>, ifMatch?: string): void =>
  parkMetaEdit(p, stampMetaReadPath(doc, p), ifMatch);


const A = '/assets/textures/rock.png';
const B = '/assets/textures/grass.png';

// Unmount explicitly — this repo's vitest setup registers no auto-cleanup, so a hook left mounted
// keeps its registry subscription live into the next test (same note as useParkedAssetDoc's).
beforeEach(() => {
  clearPendingMeta(); clearMetaBaselines();
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, status: 200, headers: { get: () => null },
    text: async () => '', json: async () => ({ ok: true, sha256: 'AFTER' }),
  } as unknown as Response)));
});
afterEach(() => { cleanup(); clearPendingMeta(); clearMetaBaselines(); vi.unstubAllGlobals(); });

describe('useMetaDirty — a single path', () => {
  it('is false with nothing parked, and true once this path is', () => {
    const { result } = renderHook(() => useMetaDirty(A));
    expect(result.current).toBe(false);

    act(() => { parkAsPanel(A, { texture: { maxSize: 1024 } }); });

    expect(result.current).toBe(true);
  });

  /** ⚠️ The subscription test. Cmd+S empties the registry from outside this component — no prop
   *  changes, no state setter runs. Without the `useSyncExternalStore` the hook never re-renders
   *  and keeps reporting "Unsaved" for a file that is on disk. */
  it('clears when a FLUSH empties the registry — nothing else re-renders the panel', async () => {
    const { result } = renderHook(() => useMetaDirty(A));
    act(() => { parkAsPanel(A, { texture: { maxSize: 1024 } }); });
    expect(result.current).toBe(true);

    await act(async () => { await flushPendingMeta(); });

    expect(result.current, 'the marker outlived the save').toBe(false);
  });

  /** The other outside-the-panel emptier: an agent's `discard_asset_edits`. Same mechanism, and
   *  worth its own case because it is the one a human never triggers and so never notices. */
  it('clears when an agent DISCARDS the park', () => {
    const { result } = renderHook(() => useMetaDirty(A));
    act(() => { parkAsPanel(A, { texture: { maxSize: 1024 } }); });

    act(() => { discardPendingMeta([A]); });

    expect(result.current).toBe(false);
  });

  it('ignores a park for a DIFFERENT path', () => {
    const { result } = renderHook(() => useMetaDirty(A));
    act(() => { parkAsPanel(B, { texture: { maxSize: 1024 } }); });
    expect(result.current).toBe(false);
  });

  it('is false for an undefined path rather than throwing', () => {
    const { result } = renderHook(() => useMetaDirty(undefined));
    expect(result.current).toBe(false);
  });
});

describe('useMetaDirty — a batch view watching N paths', () => {
  /** ⚠️ `isMetaDirty` is single-path, so a batch view that reached for it directly would report
   *  only its FIRST selection. TextureBatchView and ModelBatchView park every selected sidecar. */
  it('is true when ANY selected path is parked, not just the first', () => {
    const { result } = renderHook(() => useMetaDirty([A, B]));
    expect(result.current).toBe(false);

    act(() => { parkAsPanel(B, { texture: { maxSize: 512 } }); });

    expect(result.current, 'only the SECOND of the selection is dirty').toBe(true);
  });

  it('stays true while any one remains, and clears only when the last does', () => {
    const { result } = renderHook(() => useMetaDirty([A, B]));
    act(() => { parkAsPanel(A, { n: 1 }); parkAsPanel(B, { n: 2 }); });

    act(() => { discardPendingMeta([A]); });
    expect(result.current).toBe(true);

    act(() => { discardPendingMeta([B]); });
    expect(result.current).toBe(false);
  });

  it('is false for an empty selection', () => {
    const { result } = renderHook(() => useMetaDirty([]));
    expect(result.current).toBe(false);
  });
});
