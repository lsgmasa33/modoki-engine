/** #1362 — a move/rename is REFUSED while a texture editor holds unsaved edits (owner, 2026-09-18).
 *
 *  Observed live before the fix (work-qa, games/space-invader): Sprite Editor open, re-sliced 4 → 8
 *  slices, then a move. The modal vanished with no prompt and all 8 slices were gone, while
 *  `unsavedChanges` still read false — these modals park nothing in the registries every other gate
 *  reads, which is why the mount entry is the only thing that knows. */

import { describe, it, expect, beforeEach } from 'vitest';
import { useEditorStore, dirtyAssetEditorHolds } from '../../packages/modoki/src/editor/store/editorStore';
import { assetEditorHoldMessage } from '../../packages/modoki/src/editor/panels/assetOps';
import { spriteSheetDigest } from '../../packages/modoki/src/editor/panels/spriteSheetDigest';

const TEX = '/assets/sprites/catvader.png';

beforeEach(() => {
  useEditorStore.getState().setEditorMount('sprite', null);
  useEditorStore.getState().setEditorMount('nineslice', null);
});

describe('which asset editors are holding unsaved edits (#1362)', () => {
  it('an OPEN but clean editor holds nothing — a move must not be refused over it', () => {
    useEditorStore.getState().setEditorMount('sprite', { path: TEX, slices: ['a'], dirty: false });
    expect(dirtyAssetEditorHolds()).toEqual([]);
    expect(assetEditorHoldMessage([TEX])).toBeNull();
  });

  it('a dirty editor is reported, and names itself in the message', () => {
    useEditorStore.getState().setEditorMount('sprite', { path: TEX, slices: ['a'], dirty: true });
    expect(dirtyAssetEditorHolds()).toEqual([{ kind: 'sprite', path: TEX }]);
    expect(assetEditorHoldMessage([TEX])).toContain('sprite editor');
  });

  // ⚠️ The case the whole mechanism rests on, and the one the first cut got wrong.
  // `setEditorMount` dedups on `{path, slices}`; `dirty` was not in that comparison, so a publish
  // that flipped ONLY `dirty` was dropped. For the 9-slice editor (no `slices` at all, and a path
  // that never changes for a mounted instance) that meant the hold NEVER landed; for the Sprite
  // Editor it degraded the digest to the guid list — the exact substitute `spriteSheetDigest`'s
  // docblock says it is not. The live repro that looked like a pass re-sliced 4 → 8, which is one of
  // the few edits that DOES change the guid list.
  // Mutation: drop `cur.dirty === mount.dirty` from the dedup in editorStore.ts.
  it('going dirty with the SAME slices still registers the hold', () => {
    const st = useEditorStore.getState();
    st.setEditorMount('sprite', { path: TEX, slices: ['a', 'b'], dirty: false });
    st.setEditorMount('sprite', { path: TEX, slices: ['a', 'b'], dirty: true });
    expect(dirtyAssetEditorHolds()).toEqual([{ kind: 'sprite', path: TEX }]);
  });

  it('the 9-slice editor registers a hold even though it publishes no slices at all', () => {
    const st = useEditorStore.getState();
    st.setEditorMount('nineslice', { path: TEX, dirty: false });
    st.setEditorMount('nineslice', { path: TEX, dirty: true });
    expect(dirtyAssetEditorHolds()).toEqual([{ kind: 'nineslice', path: TEX }]);
  });

  it('going clean again withdraws the hold', () => {
    const st = useEditorStore.getState();
    st.setEditorMount('sprite', { path: TEX, slices: ['a'], dirty: true });
    st.setEditorMount('sprite', { path: TEX, slices: ['a'], dirty: false });
    expect(dirtyAssetEditorHolds()).toEqual([]);
  });

  it('a move of an UNRELATED asset is not refused', () => {
    useEditorStore.getState().setEditorMount('sprite', { path: TEX, slices: [], dirty: true });
    expect(assetEditorHoldMessage(['/assets/sprites/other.png'])).toBeNull();
  });

  // The case a path-scoped ask cannot see, and the reason the backend probes globally and prefix-
  // matches: the held texture is not named by the move at all, its FOLDER is.
  it('a FOLDER move catches a texture held underneath it', () => {
    useEditorStore.getState().setEditorMount('sprite', { path: TEX, slices: [], dirty: true });
    expect(assetEditorHoldMessage(['/assets/sprites'])).toContain('sprite editor');
  });

  // ⚠️ The discriminating direction is the HELD path being under a SIBLING folder whose name starts
  // with the moved one. My first attempt at this asserted the reverse (moving `/assets/sprites_old`
  // while holding a file under `/assets/sprites`) and a mutation dropping the `/` from the prefix
  // match sailed through it — `startsWith` is asymmetric and the test was checking the side that
  // cannot fail.
  it('a folder move does not catch a SIBLING folder that shares its name prefix', () => {
    useEditorStore.getState().setEditorMount('sprite', { path: '/assets/sprites_old/other.png', slices: [], dirty: true });
    expect(assetEditorHoldMessage(['/assets/sprites'])).toBeNull();
  });

  // ⚠️ Pins the panel matcher as EXACT, which is the opposite of what a review round asked for and
  // is the point. A review flagged that this matcher and the ROUTER's disagree — the router folds
  // case — and I "fixed" it by folding case here too (7294b1921, reverted). That is the looser
  // match `assetEditorBindings.ts`'s header forbids, and it broke the very case it was meant to
  // protect: on a case-SENSITIVE volume it makes the panel block a move the backend would allow.
  //
  // The two matchers compare different things, so they SHOULD differ: the panel compares two values
  // from one source (a `from` cased differently from the mount path is unreachable), the router
  // compares a filesystem-derived path against a store path. This test exists so the next round
  // does not re-raise it and the next author does not re-loosen it.
  it('compares paths EXACTLY — a differently-cased path is a different asset here', () => {
    useEditorStore.getState().setEditorMount('sprite', { path: '/assets/Sprites/Catvader.png', slices: [], dirty: true });
    expect(assetEditorHoldMessage(['/assets/sprites/catvader.png'])).toBeNull();
    expect(assetEditorHoldMessage(['/assets/sprites'])).toBeNull();
    // …and the real spelling, from the same source the mount got its path from, still matches.
    expect(assetEditorHoldMessage(['/assets/Sprites/Catvader.png'])).toContain('sprite editor');
    expect(assetEditorHoldMessage(['/assets/Sprites'])).toContain('sprite editor');
  });

  it('both editors dirty at once are both named', () => {
    useEditorStore.getState().setEditorMount('sprite', { path: TEX, slices: [], dirty: true });
    useEditorStore.getState().setEditorMount('nineslice', { path: TEX, dirty: true });
    const msg = assetEditorHoldMessage([TEX]) ?? '';
    expect(msg).toContain('sprite editor');
    expect(msg).toContain('nineslice editor');
  });

  it('an unmounted editor holds nothing, so the refusal is never permanent', () => {
    useEditorStore.getState().setEditorMount('sprite', { path: TEX, slices: [], dirty: true });
    expect(assetEditorHoldMessage([TEX])).not.toBeNull();
    useEditorStore.getState().setEditorMount('sprite', null);
    expect(assetEditorHoldMessage([TEX])).toBeNull();
  });
});

describe('the sprite sheet digest decides what counts as an edit (#1362)', () => {
  const slice = (guid: string, x: number) => ({ guid, name: guid, rect: { x, y: 0, w: 8, h: 8 }, pivot: { x: 0.5, y: 0.5 } });

  it('a RECT change with the same guid is an edit — the guid list alone would miss it', () => {
    const before = [slice('a', 0), slice('b', 8)];
    const after = [slice('a', 0), { ...slice('b', 8), rect: { x: 9, y: 0, w: 8, h: 8 } }];
    // The trap this exists for: identical guid lists.
    expect(before.map((s) => s.guid)).toEqual(after.map((s) => s.guid));
    expect(spriteSheetDigest(after)).not.toBe(spriteSheetDigest(before));
  });

  it('re-ordering the same slices is NOT an edit', () => {
    const a = [slice('a', 0), slice('b', 8)];
    expect(spriteSheetDigest([...a].reverse())).toBe(spriteSheetDigest(a));
  });

  it('the live preview rect is not part of the saved document', () => {
    const a = [slice('a', 0)];
    expect(spriteSheetDigest([...a, slice('__preview__', 99)])).toBe(spriteSheetDigest(a));
  });

  // #1362 close-out review, F4: the save writes `spriteGrid` and `spriteAlphaThreshold` too, and
  // both are editable without ever pressing Slice. Left out of the digest, setting Cell W 64 → 32
  // read as CLEAN and the move gate let the edit die with the modal.
  it('a slicing-control change with identical slices is an edit', () => {
    const a = [slice('a', 0)];
    const base = spriteSheetDigest(a, { grid: { cols: 4, rows: 1 }, alphaThreshold: 8 });
    expect(spriteSheetDigest(a, { grid: { cols: 2, rows: 1 }, alphaThreshold: 8 })).not.toBe(base);
    expect(spriteSheetDigest(a, { grid: { cols: 4, rows: 1 }, alphaThreshold: 40 })).not.toBe(base);
    // …and unchanged controls are not an edit.
    expect(spriteSheetDigest(a, { grid: { cols: 4, rows: 1 }, alphaThreshold: 8 })).toBe(base);
  });

  it('adding or removing a slice is an edit', () => {
    const a = [slice('a', 0)];
    expect(spriteSheetDigest([...a, slice('b', 8)])).not.toBe(spriteSheetDigest(a));
    expect(spriteSheetDigest([])).not.toBe(spriteSheetDigest(a));
  });
});
