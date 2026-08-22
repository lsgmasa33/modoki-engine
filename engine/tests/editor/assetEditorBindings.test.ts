/** #186 — an asset editor's binding is a PATH, so every operation that moves or removes the
 *  file must update it.
 *
 *  The bug this pins is not "the panel looks stale". All five asset editors autosave on a
 *  400ms debounce, so a stale binding WRITES to the old location. Measured on
 *  `games/timeline-demo`: renaming a bound timeline and then editing it re-created the old
 *  file with the new content (duration 7) while the renamed file kept the old (duration 2)
 *  — the asset forked in two and nothing reported it. The regression to fear is therefore
 *  silent, which is why the pure resolver is tested directly rather than through a panel. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
// Deep path, not the `@modoki/engine/editor` barrel: this is internal editor plumbing with
// one call site, and widening the public surface for a test is a cost with no buyer.
import {
  resolveBindingMoves, applyMove, ASSET_EDITOR_BINDINGS, applyMovesToParkedAssets,
  applyAssetPathMoves,
} from '../../packages/modoki/src/editor/panels/assetEditorBindings';
import {
  markAssetDirty, clearDirtyAssets, getDirtyAssetPaths, peekDirtyAsset,
} from '../../packages/modoki/src/editor/scene/dirtyAssets';

const ANIM = '/assets/anim/walk.anim.json';
const SEQ = '/assets/seq/intro.timeline.json';

const bound = (over: Record<string, string | null> = {}) => [
  { label: 'animation', path: 'animation' in over ? over.animation : ANIM },
  { label: 'timeline', path: 'timeline' in over ? over.timeline : SEQ },
  { label: 'particle', path: 'particle' in over ? over.particle : null },
];

describe('applyMove', () => {
  it('maps an exact path move and ignores everything else', () => {
    expect(applyMove(ANIM, { from: ANIM, to: '/assets/anim/run.anim.json' })).toBe('/assets/anim/run.anim.json');
    expect(applyMove(SEQ, { from: ANIM, to: '/assets/anim/run.anim.json' })).toBeUndefined();
  });

  it('reports a delete as gone', () => {
    expect(applyMove(ANIM, { from: ANIM, to: null })).toBeNull();
  });

  it('rewrites a path under a renamed FOLDER, keeping the tail', () => {
    expect(applyMove(ANIM, { from: '/assets/anim', to: '/assets/clips', prefix: true }))
      .toBe('/assets/clips/walk.anim.json');
  });

  it('matches the folder itself, not just its contents', () => {
    expect(applyMove('/assets/anim', { from: '/assets/anim', to: null, prefix: true })).toBeNull();
  });

  it('only matches on a SEGMENT boundary', () => {
    // The trap a bare startsWith walks into: renaming `/assets/anim` must not capture
    // `/assets/animations/…`, which would repoint an editor to a path that never existed.
    expect(applyMove('/assets/animations/x.anim.json', { from: '/assets/anim', to: '/assets/clips', prefix: true }))
      .toBeUndefined();
  });

  it('is not fooled by a path that merely CONTAINS a bound path', () => {
    expect(applyMove(ANIM + '.bak', { from: ANIM, to: null })).toBeUndefined();
  });
});

describe('resolveBindingMoves', () => {
  it('unbinds the editor whose asset was deleted, and only that one', () => {
    const out = resolveBindingMoves(bound(), [{ from: ANIM, to: null }]);
    expect(out.map((c) => [c.binding.label, c.to])).toEqual([['animation', null]]);
  });

  it('repoints the editor whose asset was renamed', () => {
    const out = resolveBindingMoves(bound(), [{ from: ANIM, to: '/assets/anim/run.anim.json', name: 'run' }]);
    expect(out).toHaveLength(1);
    expect(out[0].to).toBe('/assets/anim/run.anim.json');
    expect(out[0].name).toBe('run');
  });

  it('handles a multi-item move, one move per binding', () => {
    const out = resolveBindingMoves(bound(), [
      { from: ANIM, to: '/moved/walk.anim.json' },
      { from: SEQ, to: '/moved/intro.timeline.json' },
    ]);
    expect(out.map((c) => c.binding.label)).toEqual(['animation', 'timeline']);
  });

  it('repoints every binding under one folder rename', () => {
    const out = resolveBindingMoves(bound({ timeline: '/assets/anim/nested/a.timeline.json' }),
      [{ from: '/assets/anim', to: '/assets/clips', prefix: true }]);
    expect(out.map((c) => c.to)).toEqual(['/assets/clips/walk.anim.json', '/assets/clips/nested/a.timeline.json']);
  });

  it('never touches an UNBOUND editor, including on a FOLDER move', () => {
    // The folder case is the one that matters and the one an exact-path test misses:
    // `applyMove`'s prefix branch calls `path.startsWith`, so an unbound editor would make
    // every folder rename/delete THROW. A closed editor is the normal state, so that is a
    // crash on ordinary use, not an edge case. (Written this way because the first version
    // of this test — an exact-path delete — passed with the guard removed.)
    const allClosed = bound({ animation: null, timeline: null });
    expect(resolveBindingMoves(allClosed, [{ from: ANIM, to: null }])).toEqual([]);
    expect(resolveBindingMoves(allClosed, [{ from: '/assets', to: '/art', prefix: true }])).toEqual([]);
    expect(resolveBindingMoves(allClosed, [{ from: '/assets', to: null, prefix: true }])).toEqual([]);
  });

  it('skips a closed editor while still moving the open ones', () => {
    // The mixed case production actually hits: some panels open, some closed.
    const out = resolveBindingMoves(bound({ timeline: null }), [{ from: '/assets', to: '/art', prefix: true }]);
    expect(out.map((c) => [c.binding.label, c.to])).toEqual([['animation', '/art/anim/walk.anim.json']]);
  });

  it('reports nothing for a move onto the same path', () => {
    // pasteClipboard skips these, but a no-op change would still log a repoint that did not
    // happen — and a "cut into the same folder" is exactly how you would hit it.
    expect(resolveBindingMoves(bound(), [{ from: ANIM, to: ANIM }])).toEqual([]);
  });

  it('applies only the FIRST matching move to a binding', () => {
    const out = resolveBindingMoves(bound(), [
      { from: ANIM, to: '/first.anim.json' },
      { from: ANIM, to: '/second.anim.json' },
    ]);
    expect(out.map((c) => c.to)).toEqual(['/first.anim.json']);
  });

  it('tolerates an empty move set', () => {
    expect(resolveBindingMoves(bound(), [])).toEqual([]);
  });
});

describe('ASSET_EDITOR_BINDINGS', () => {
  it('covers every asset editor that binds to a file', () => {
    // A sixth asset editor added without a row here would fork assets on rename exactly
    // like the first five did, and nothing else would report it.
    expect(ASSET_EDITOR_BINDINGS.map((b) => b.label).sort()).toEqual(
      ['animation', 'particle', 'skin', 'sprite animation', 'timeline'],
    );
  });

  it('pairs each asset field with its own close action', () => {
    // A copy-paste pointing two rows at one close action would leave an editor permanently
    // bound to a deleted file, and the labels above would still look right.
    const closes = ASSET_EDITOR_BINDINGS.map((b) => b.close);
    expect(new Set(closes).size).toBe(closes.length);
    const fields = ASSET_EDITOR_BINDINGS.map((b) => b.assetField);
    expect(new Set(fields).size).toBe(fields.length);
  });
});


/** The half the BINDING cannot cover (#259). A parked write is keyed by path and outlives both
 *  the binding and the panel — so before this, deleting an asset with unsaved edits left a write
 *  that the next Cmd+S turned back into the file you deleted, and renaming one left the OLD path
 *  parked, forking the asset exactly the way #186 measured with the autosave. */
describe('applyMovesToParkedAssets', () => {
  beforeEach(() => clearDirtyAssets());
  afterEach(() => clearDirtyAssets());

  it('DROPS the parked write for a deleted asset — a save must not resurrect the file', () => {
    markAssetDirty(ANIM, 'animation', { duration: 3 }, 'panel');
    const notes = applyMovesToParkedAssets([{ from: ANIM, to: null }]);

    expect(getDirtyAssetPaths()).toEqual([]);
    expect(notes.join(' ')).toContain(ANIM); // never silent: this destroys pending work
  });

  it('MOVES the parked write with a renamed asset, keeping the unsaved edit', () => {
    // The asset survives a rename (its GUID + sidecar move with it), so the human's unsaved edit
    // must survive too — dropping it because they renamed the file would be its own bug.
    const to = '/assets/anim/run.anim.json';
    markAssetDirty(ANIM, 'animation', { duration: 3 }, 'panel');
    applyMovesToParkedAssets([{ from: ANIM, to }]);

    expect(getDirtyAssetPaths()).toEqual([to]);
    expect(peekDirtyAsset(to)).toEqual({ type: 'animation', data: { duration: 3 }, origin: 'panel' });
  });

  it('preserves ORIGIN across the move — an agent park must not become a full-replace write', () => {
    const to = '/assets/fx/moved.particle.json';
    markAssetDirty('/assets/fx/x.particle.json', 'particle', { version: 1 }, 'agent');
    applyMovesToParkedAssets([{ from: '/assets/fx/x.particle.json', to }]);
    expect(peekDirtyAsset(to)?.origin).toBe('agent');
  });

  it('follows a FOLDER move, and leaves a sibling folder alone', () => {
    markAssetDirty(ANIM, 'animation', { duration: 1 }, 'panel');
    markAssetDirty(SEQ, 'timeline', { duration: 2 }, 'panel');
    applyMovesToParkedAssets([{ from: '/assets/anim', to: '/assets/clips', prefix: true }]);

    expect(getDirtyAssetPaths().sort()).toEqual(['/assets/clips/walk.anim.json', SEQ].sort());
  });

  it('a CHAINED move does not carry one doc through two hops', () => {
    // Applying in-loop wrote the moved doc back into the registry, where a later iteration picked
    // it up as that path's own: with [a→b, b→c], A landed at /c and B's edit was gone. Resolving
    // every move against the ORIGINAL registry makes that unreachable. (No caller passes a chain
    // today — this pins the shape, not a live bug.)
    markAssetDirty(ANIM, 'animation', { doc: 'A' }, 'panel');
    markAssetDirty(SEQ, 'timeline', { doc: 'B' }, 'panel');
    applyMovesToParkedAssets([{ from: ANIM, to: SEQ }, { from: SEQ, to: '/assets/seq/third.timeline.json' }]);

    expect(peekDirtyAsset(SEQ)?.data).toEqual({ doc: 'A' });
    expect(peekDirtyAsset('/assets/seq/third.timeline.json')?.data).toEqual({ doc: 'B' });
  });

  it('leaves everything alone when no move touches a parked path', () => {
    markAssetDirty(ANIM, 'animation', { duration: 1 }, 'panel');
    const notes = applyMovesToParkedAssets([{ from: '/assets/other/x.json', to: null }]);
    expect(getDirtyAssetPaths()).toEqual([ANIM]);
    expect(notes).toEqual([]);
  });
});


/** WIRED, not merely written. The pure function above passes whether or not anything CALLS it —
 *  and a mechanism that cannot fire is this repo's most common defect shape. This drives the real
 *  entry point the Assets panel uses, with no editor bound, so the only thing it can be measuring
 *  is the registry repair. (Confirmed by deleting the call: these fail, the ones above do not.) */
describe('applyAssetPathMoves reaches the registry, not just the bindings', () => {
  beforeEach(() => clearDirtyAssets());
  afterEach(() => clearDirtyAssets());

  it('drops a parked write for a deleted asset whose panel is CLOSED', () => {
    markAssetDirty(ANIM, 'animation', { duration: 3 }, 'panel');
    const notes = applyAssetPathMoves([{ from: ANIM, to: null }]);
    expect(getDirtyAssetPaths()).toEqual([]);
    expect(notes.join(' ')).toContain(ANIM);
  });

  it('moves a parked write for a renamed asset whose panel is CLOSED', () => {
    const to = '/assets/anim/run.anim.json';
    markAssetDirty(ANIM, 'animation', { duration: 3 }, 'panel');
    applyAssetPathMoves([{ from: ANIM, to }]);
    expect(getDirtyAssetPaths()).toEqual([to]);
  });
});
