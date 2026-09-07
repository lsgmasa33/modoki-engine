/** #843 — `MaterialBatchView`'s live refresher used to re-load ALL selected materials from
 *  `pendingAssetDoc`/disk on every edit (`useAssetViewRefresher(paths[0] ?? '', () => loadAll())`,
 *  which REPLACES the whole `mats` map). `persistAssetEdit` calls the registered setter
 *  SYNCHRONOUSLY while `writeAll`'s `apply` loop is still parking the batch's other paths, so the
 *  reload — fired the moment path A parks — reads the registry for B and C BEFORE they're parked
 *  for this edit, falls back to their pre-edit doc, and stomps the whole panel state with it. A
 *  second batch edit then builds its own `next` from that stale state and re-parks B/C with the
 *  first edit's field silently reverted.
 *
 *  `useAssetViewRefreshers` (persist.ts) is the fix: one refresher PER PATH, registered in a single
 *  effect, whose setter MERGES exactly the one path that changed (`setMats((m) => ({ ...m, [p]:
 *  updated }))`) and never re-reads or replaces the rest of the map. Covered here against
 *  `persistAssetEdit` + the dirty-asset registry directly, using `renderHook` on the persistence
 *  hooks themselves — not by mounting `MaterialBatchView` (docs/editor.md § Panels: editor `.tsx`
 *  isn't mounted in jsdom, because that asserts the mock rather than the panel).
 *
 *  The panel's own `mats` React state is stood in for by a plain mutable variable, updated the same
 *  way `setMats` is at each call site in `MaterialBatchView` — the defect is in WHICH setter gets
 *  registered and WHEN it fires relative to the write loop, not in React's render/commit timing, so
 *  a plain variable keeps the repro deterministic and legible.
 *
 *  The first test reproduces the OLD single-path `useAssetViewRefresher(paths[0] ?? '', () =>
 *  loadAll())` shape inline (that registration is what changed; `persist.ts`'s `persistAssetEdit`
 *  and the dirty registry are unchanged either way) and demonstrates it drops B/C's colour edit —
 *  RED were this file's second assertion applied to it. The second test is the actual regression
 *  guard: the same two-edit sequence through the real, exported `useAssetViewRefreshers`.
 *
 *  Adversarial review (#843 close-out) found the first two tests build `next[p]` from `mats[p]`
 *  and write it back to the harness map BEFORE calling `persistAssetEdit` — so every assertion
 *  reads `peekDirtyAsset` (the dirty registry) and never proves the hook's setter fired at all;
 *  gutting `useAssetViewRefreshers`' effect body to `useEffect(() => {}, [key])` left both green.
 *  The two tests after them close that gap, reading the HARNESS map instead of the registry: one
 *  calls `persistAssetEdit` for a path with no prior local write and shows only a per-path
 *  registration (not just `paths[0]`) can explain the result landing there; the other asserts every
 *  path's setter is gone after unmount. Precisely what each file covers, updated:
 *  `engine/tests/architecture/assetViewReadsParkedDoc.test.ts`'s source scan pins WHICH hook the
 *  panel calls (`useAssetViewRefreshers`, not the single-path `useAssetViewRefresher`); this file
 *  pins what the hook DOES once called — that it registers a live setter PER PATH, and that each
 *  setter merges its one path without clobbering the others. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import {
  persistAssetEdit, invalidateMaterialFile, useAssetViewRefresher, useAssetViewRefreshers,
} from '../../packages/modoki/src/editor/panels/assetViews/persist';
import { clearDirtyAssets, peekDirtyAsset } from '../../packages/modoki/src/editor/scene/dirtyAssets';

const A = '/assets/materials/a.mat.json';
const B = '/assets/materials/b.mat.json';
const C = '/assets/materials/c.mat.json';
const PATHS = [A, B, C];

type MatMap = Record<string, Record<string, unknown>>;

function initialMats(): MatMap {
  return {
    // `metalness` differs per path AND is touched by neither edit below — it's the field that
    // exposes cross-path contamination: a refresher that leaks one path's doc into another's local
    // state can't hide behind the two edited fields ending up the SAME value on every path anyway.
    [A]: { color: 0x111111, roughness: 0.5, metalness: 0.1 },
    [B]: { color: 0x222222, roughness: 0.5, metalness: 0.2 },
    [C]: { color: 0x333333, roughness: 0.5, metalness: 0.3 },
  };
}

beforeEach(() => clearDirtyAssets());
afterEach(() => { cleanup(); clearDirtyAssets(); });

describe('MaterialBatchView refresher does not clobber not-yet-parked siblings (#843)', () => {
  it('demonstrates the OLD single-path re-loading refresher drops a prior batch edit', () => {
    const disk = initialMats(); // frozen — what `fetch(p)` would still return mid-edit
    let mats = initialMats();   // the panel's own state, mutated the way `setMats` would be

    // The OLD shape: one refresher for path A only, and it REPLACES the whole map — same as
    // `loadAll`'s `setMats(Object.fromEntries(entries))`, falling back to disk for anything not
    // (yet) parked.
    const loadAll = () => {
      mats = Object.fromEntries(PATHS.map((p) => [p, (peekDirtyAsset(p)?.data as Record<string, unknown>) ?? disk[p]]));
    };
    renderHook(() => useAssetViewRefresher(A, loadAll));

    // Mirrors `writeAll`: compute `next` for every path from the CURRENT `mats`, apply it
    // optimistically, THEN park each path one at a time.
    const writeAllOld = (field: string, value: unknown) => {
      const next: MatMap = {};
      for (const p of PATHS) next[p] = { ...mats[p], [field]: value };
      mats = { ...mats, ...next };
      for (const p of PATHS) persistAssetEdit(p, 'material', next[p], invalidateMaterialFile);
    };

    writeAllOld('color', 0xff0000);   // edit 1 — parking A synchronously fires loadAll before B/C
                                       // are parked, stomping `mats[B]`/`mats[C]` back to `disk`.
    writeAllOld('roughness', 0.9);    // edit 2 — built from the now-stale `mats`, re-parks B/C
                                       // WITHOUT the colour change.

    // The bug, pinned: B and C's colour reverted to their pre-edit-1 original instead of surviving.
    expect(peekDirtyAsset(B)?.data).toEqual({ color: disk[B].color, roughness: 0.9, metalness: disk[B].metalness });
    expect(peekDirtyAsset(C)?.data).toEqual({ color: disk[C].color, roughness: 0.9, metalness: disk[C].metalness });
  });

  it('the fixed hook: a per-path merge refresher keeps every prior edit through a second batch write', () => {
    let mats = initialMats();

    renderHook(() => useAssetViewRefreshers(PATHS, (p, updated) => { mats = { ...mats, [p]: updated as Record<string, unknown> }; }));

    const writeAllNew = (field: string, value: unknown) => {
      const next: MatMap = {};
      for (const p of PATHS) next[p] = { ...mats[p], [field]: value };
      mats = { ...mats, ...next };
      for (const p of PATHS) persistAssetEdit(p, 'material', next[p], invalidateMaterialFile);
    };

    writeAllNew('color', 0xff0000);
    writeAllNew('roughness', 0.9);

    // Every path's colour edit survives the second, unrelated batch write — the exact sequence the
    // OLD refresher (test above) drops. Each path's own, never-edited `metalness` must also survive
    // untouched — a cross-path leak (one path's doc broadcast onto another's local state) would
    // corrupt this the moment the batch's two edits land on the SAME value everywhere, which is
    // exactly why `metalness` differs per path instead of matching `color`/`roughness`'s shape.
    expect(peekDirtyAsset(A)?.data).toEqual({ color: 0xff0000, roughness: 0.9, metalness: 0.1 });
    expect(peekDirtyAsset(B)?.data).toEqual({ color: 0xff0000, roughness: 0.9, metalness: 0.2 });
    expect(peekDirtyAsset(C)?.data).toEqual({ color: 0xff0000, roughness: 0.9, metalness: 0.3 });
  });

  // The two tests above both build `next[p]` from `mats[p]` BEFORE calling `persistAssetEdit`, and
  // `next[p]` is the very same object reference the refresher's setter would write back — so
  // `mats = { ...mats, ...next }` (line 96/74) already puts every path's post-edit doc into the
  // harness map by itself. Every assertion above reads `peekDirtyAsset`, the dirty REGISTRY, not
  // the harness map, so neither test can tell "the hook registered a setter" from "the hook
  // registered nothing at all" — gutting `useAssetViewRefreshers`' effect body to
  // `useEffect(() => {}, [key])` leaves both green. These two pin registration directly.
  it('registers a live setter for EVERY path, not just paths[0] (#843 review)', () => {
    let mats: MatMap = {};
    renderHook(() => useAssetViewRefreshers(PATHS, (p, updated) => { mats = { ...mats, [p]: updated as Record<string, unknown> }; }));

    // No prior write to `mats` for B — the harness map starts with NOTHING for it. If the hook only
    // registered a setter for `paths[0]` (or none at all), this write would leave `mats[B]`
    // untouched; only a setter registered for B specifically can put it there.
    const bDoc = { color: 0xabcdef, roughness: 0.7, metalness: 0.4 };
    persistAssetEdit(B, 'material', bDoc, invalidateMaterialFile);

    expect(mats[B]).toEqual(bDoc);
    expect(mats[A]).toBeUndefined();
    expect(mats[C]).toBeUndefined();
  });

  it('removes EVERY path\'s setter on unmount, not just one (#843 review)', () => {
    let mats: MatMap = {};
    const { unmount } = renderHook(() => useAssetViewRefreshers(PATHS, (p, updated) => { mats = { ...mats, [p]: updated as Record<string, unknown> }; }));
    unmount();

    for (const p of PATHS) persistAssetEdit(p, 'material', { color: 0, roughness: 0, metalness: 0 }, invalidateMaterialFile);

    // A setter left registered after unmount would still write into `mats`; none should have.
    expect(mats).toEqual({});
  });
});
