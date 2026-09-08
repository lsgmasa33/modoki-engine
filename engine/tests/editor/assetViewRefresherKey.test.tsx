/** `useAssetViewRefreshers` re-registers when the SELECTION changes, and the key it uses to decide
 *  that must be injective over path lists (#891 close-out review).
 *
 *  WHY. The hook cannot call `useAssetViewRefresher` in a loop (a variable hook count is an illegal
 *  hook call), so the whole map is ONE effect keyed on the joined path string. That join was
 *  `paths.join(' ')`, and a space is a perfectly ordinary character in an asset name — so two
 *  DIFFERENT selections collapse to one key:
 *
 *      ['/a/b c.png', '/a/d.png']  →  "/a/b c.png /a/d.png"
 *      ['/a/b', 'c.png /a/d.png']  →  "/a/b c.png /a/d.png"    ← the same key, a different selection
 *
 *  ⚠️ The second list is CONSTRUCTED — its members are not paths the Assets panel would hand you.
 *  That is the honest statement of what this pins: the key is not injective, and a non-injective
 *  key is a latent collision whether or not this particular pair is reachable. The realistic
 *  half is the first list: names with spaces are ordinary, and every one of them puts the
 *  separator inside a member where the join can no longer tell it from a boundary.
 *
 *  With a colliding key the effect does not re-run, so every setter stays registered for the
 *  PREVIOUS selection: `persistAssetEdit` then calls a setter belonging to a panel that is no
 *  longer showing that path, and the live edit updates nothing on screen.
 *
 *  ⚠️ This is a `.ts` module, so it gets a real unit test rather than a source scan — `docs/editor.md`
 *  § Panels puts a panel's DECISIONS in a plain module beside it precisely so they can be driven.
 *  The separator is now `\0`, the one byte a path genuinely cannot contain (a newline CAN — measured
 *  on APFS — which is why the first version of this fix used the wrong character and said something
 *  false in a comment while doing it). */

import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import {
  useAssetViewRefreshers, persistAssetEdit,
} from '../../packages/modoki/src/editor/panels/assetViews/persist';
import { clearDirtyAssets } from '../../packages/modoki/src/editor/scene/dirtyAssets';

afterEach(() => { cleanup(); clearDirtyAssets(); });

/** Two selections that a space-joined key cannot tell apart. */
const A = ['/assets/textures/b c.png', '/assets/textures/d.png'];
const B = ['/assets/textures/b', 'c.png /assets/textures/d.png'];

describe('useAssetViewRefreshers re-registers per SELECTION (#891 close-out)', () => {
    it('re-registers for the NEW selection when a space-joined key would have collided', () => {
    expect(A.join(' '), 'the premise: these two selections collide under a space join')
      .toBe(B.join(' '));

    const seen: Array<[string, unknown]> = [];
    const { rerender } = renderHook(
      ({ paths }: { paths: string[] }) => useAssetViewRefreshers(paths, (p, d) => seen.push([p, d])),
      { initialProps: { paths: A } },
    );
    rerender({ paths: B });

    // Drive the registry the way a live edit does — this is the consumer that breaks.
    persistAssetEdit(B[1], 'material', { color: 1 }, () => {});

    expect(seen.map(([p]) => p), `no setter was registered for ${B[1]} — the effect never re-ran`)
      .toEqual([B[1]]);
  });

  /** The other direction: a genuine no-op re-render must NOT churn the registrations, which is the
   *  reason the effect is keyed on a string at all rather than on the array. */
  it('does not re-register when the same selection re-renders', () => {
    const seen: string[] = [];
    const { rerender } = renderHook(
      ({ paths }: { paths: string[] }) => useAssetViewRefreshers(paths, (p) => seen.push(p)),
      { initialProps: { paths: [...A] } },
    );
    rerender({ paths: [...A] });   // a FRESH array with the same contents, as Inspector.tsx builds

    persistAssetEdit(A[0], 'material', { color: 2 }, () => {});
    expect(seen).toEqual([A[0]]);
  });

});