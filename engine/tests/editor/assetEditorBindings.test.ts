/** #186 — an asset editor's binding is a PATH, so every operation that moves or removes the
 *  file must update it.
 *
 *  The bug this pins is not "the panel looks stale". All five asset editors autosave on a
 *  400ms debounce, so a stale binding WRITES to the old location. Measured on
 *  `games/timeline-demo`: renaming a bound timeline and then editing it re-created the old
 *  file with the new content (duration 7) while the renamed file kept the old (duration 2)
 *  — the asset forked in two and nothing reported it. The regression to fear is therefore
 *  silent, which is why the pure resolver is tested directly rather than through a panel. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// Deep path, not the `@modoki/engine/editor` barrel: this is internal editor plumbing with
// one call site, and widening the public surface for a test is a cost with no buyer.
import {
  resolveBindingMoves, ASSET_EDITOR_BINDINGS, applyMovesToParkedAssets,
  applyAssetPathMoves,
} from '../../packages/modoki/src/editor/panels/assetEditorBindings';
import { applyMove } from '../../packages/modoki/src/editor/utils/assetPaths';
import {
  markAssetDirty, clearDirtyAssets, getDirtyAssetPaths, peekDirtyAsset,
  flushDirtyAssets, getLastFlushedAssetHash, getLastFlushedAsset,
} from '../../packages/modoki/src/editor/scene/dirtyAssets';
import {
  parkMetaEdit, clearPendingMeta, clearMetaBaselines, getPendingMetaPaths, peekPendingMeta,
  peekMetaBaseline,
} from '../../packages/modoki/src/editor/scene/pendingMeta';

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

  it('preserves the CAS BASELINE (ifMatch) across the move — this is the only cross-path re-park ' +
    'in the tree, so markAssetDirty\'s "an omitted ifMatch preserves the destination\'s own" rule ' +
    'is the wrong default here; a rename does not change bytes, so the source baseline still ' +
    'describes the file at the new path', () => {
    const from = '/assets/fx/atlas-src.atlas.json';
    const to = '/assets/fx/atlas-dst.atlas.json';
    const BASELINE = 'a'.repeat(64);
    markAssetDirty(from, 'atlas', { members: ['s1'] }, 'panel', BASELINE);
    expect(peekDirtyAsset(from)?.ifMatch, 'positive control: the baseline must actually be parked before the move').toBe(BASELINE);

    applyMovesToParkedAssets([{ from, to }]);

    expect(peekDirtyAsset(to)?.ifMatch).toBe(BASELINE);
  });

  it('preserves the CAS BASELINE across a FOLDER move too — pins the fix on both branches of applyMove', () => {
    const from = '/assets/anim/atlas.atlas.json';
    const BASELINE = 'b'.repeat(64);
    markAssetDirty(from, 'atlas', { members: ['s1'] }, 'panel', BASELINE);
    expect(peekDirtyAsset(from)?.ifMatch, 'positive control').toBe(BASELINE);

    applyMovesToParkedAssets([{ from: '/assets/anim', to: '/assets/clips', prefix: true }]);

    expect(peekDirtyAsset('/assets/clips/atlas.atlas.json')?.ifMatch).toBe(BASELINE);
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


/** The SECOND registry has to move with the first (#845 close-out).
 *
 *  ⚠️ This is a regression the parking commit would otherwise have shipped, not a pre-existing
 *  gap: before `f85c6820f` every `.meta.json` edit wrote immediately, so no pending edit could
 *  outlive its path. Now one can, and `pendingMeta` is keyed by ASSET path with nothing migrating
 *  those keys — so a deleted asset's parked edit is a resurrection waiting for the next Cmd+S, and
 *  `/api/write-meta` will happily perform it (`resolveAssetPath` is a roots/traversal guard with
 *  no existence check).
 *
 *  Driven through `applyAssetPathMoves`, the real entry point, for the same reason the block above
 *  is: the pure helper passes whether or not anything calls it. */
describe('applyAssetPathMoves carries PARKED IMPORT SETTINGS too (#845)', () => {
  const PNG = '/assets/textures/rock.png';
  beforeEach(() => { clearDirtyAssets(); clearPendingMeta(); clearMetaBaselines(); });
  afterEach(() => { clearDirtyAssets(); clearPendingMeta(); clearMetaBaselines(); });

  it('DROPS a parked meta edit when its asset is deleted — no orphan sidecar is resurrected', () => {
    parkMetaEdit(PNG, { id: 'a-guid', texture: { maxSize: 512 } });

    const notes = applyAssetPathMoves([{ from: PNG, to: null }]);

    expect(getPendingMetaPaths()).toEqual([]);
    expect(notes.join(' ')).toContain(PNG);
    expect(notes.join(' ')).toMatch(/import-settings/);
  });

  it('MOVES a parked meta edit when its asset is renamed — the edit follows, no orphan is written', () => {
    const to = '/assets/textures/stone.png';
    parkMetaEdit(PNG, { id: 'a-guid', texture: { maxSize: 512 } });

    applyAssetPathMoves([{ from: PNG, to }]);

    expect(getPendingMetaPaths()).toEqual([to]);
    expect(peekPendingMeta(to)).toEqual({ id: 'a-guid', texture: { maxSize: 512 } });
    expect(peekPendingMeta(PNG), 'the old path must not still be parked').toBeUndefined();
  });

  /** ⚠️ The CAS baseline must FOLLOW the rename, not be dropped with the old key.
   *
   *  Main's #854 settled this for the sibling registry on the same day, and the reasoning transfers
   *  exactly: dropping it turns the compare-and-swap off for the rest of the session, on a file the
   *  human just renamed and is therefore actively working on — precisely the git-checkout hazard it
   *  exists for. A rename moves the sidecar's bytes unchanged, so the old baseline is still a true
   *  statement about the file under its new name.
   *
   *  My first version of this helper dropped it and argued in a comment that this was correct
   *  ("unconditional-but-informed"). That is why the assertion is here and not just the comment. */
  it('CARRIES the CAS baseline across a rename — dropping it would silently disarm the guard', () => {
    const to = '/assets/textures/stone.png';
    parkMetaEdit(PNG, { id: 'a-guid' }, 'BASELINE-SHA');
    expect(peekMetaBaseline(PNG)).toBe('BASELINE-SHA');   // positive control

    applyAssetPathMoves([{ from: PNG, to }]);

    expect(peekMetaBaseline(to)).toBe('BASELINE-SHA');
    expect(peekMetaBaseline(PNG), 'the old key must not keep it either').toBeUndefined();
  });

  it('a DELETE drops the baseline with the park — there is no path left to describe', () => {
    parkMetaEdit(PNG, { id: 'a-guid' }, 'BASELINE-SHA');

    applyAssetPathMoves([{ from: PNG, to: null }]);

    expect(peekMetaBaseline(PNG)).toBeUndefined();
  });

  it('moves BOTH registries in one call, so neither can be forgotten', () => {
    const to = '/assets/textures/stone.png';
    markAssetDirty(ANIM, 'animation', { duration: 3 }, 'panel');
    parkMetaEdit(PNG, { id: 'a-guid' });

    applyAssetPathMoves([{ from: ANIM, to: null }, { from: PNG, to }]);

    expect(getDirtyAssetPaths()).toEqual([]);
    expect(getPendingMetaPaths()).toEqual([to]);
  });
});

/** The FLUSHED-record maps (`lastFlushed`/`lastFlushedHash`) are keyed by path too, and nothing
 *  carried them across a move before this — `applyMovesToParkedAssets` walks `getDirtyAssetPaths()`,
 *  so a path with no PARKED write is never visited and its flushed record is stranded forever
 *  under a filename that no longer exists. This is exactly that case: the path below is flushed
 *  (which clears its dirty entry) BEFORE the move, so nothing is parked for it when the move runs —
 *  a test that parked a doc first would pass even if the remap were wired only inside the
 *  dirty-paths loop. */
describe('applyMovesToParkedAssets carries the flushed-hash record across a move (no parked write)', () => {
  const HASH = 'c'.repeat(64);
  let bodies: Array<Record<string, unknown>>;

  beforeEach(() => {
    clearDirtyAssets();
    bodies = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ ok: true, saved: true, sha256: HASH }) } as unknown as Response;
    }));
  });
  afterEach(() => { clearDirtyAssets(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('follows a rename, and is DROPPED when the path is later deleted', async () => {
    const path = '/assets/fx/flushed.particle.json';
    const renamed = '/assets/fx/renamed.particle.json';
    markAssetDirty(path, 'particle', { version: 1 }, 'panel');
    await flushDirtyAssets();
    // Positive control: the flush must actually have cleared the parked write AND recorded the
    // hash, so the move below is exercised on a path with NOTHING pending — the case the dirty-
    // paths loop cannot reach.
    expect(getDirtyAssetPaths()).toEqual([]);
    expect(getLastFlushedAssetHash(path)).toBe(HASH);
    // Positive control for the DOC record (`lastFlushed`) too, before the move touches it.
    expect(getLastFlushedAsset(path)).toEqual({ version: 1 });

    applyMovesToParkedAssets([{ from: path, to: renamed }]);

    expect(getLastFlushedAssetHash(path)).toBeNull();
    expect(getLastFlushedAssetHash(renamed)).toBe(HASH);
    expect(getLastFlushedAsset(path)).toBeNull();
    expect(getLastFlushedAsset(renamed)).toEqual({ version: 1 });

    applyMovesToParkedAssets([{ from: renamed, to: null }]);

    expect(getLastFlushedAssetHash(renamed)).toBeNull();
    expect(getLastFlushedAsset(renamed)).toBeNull();
  });

  it('survives the move even when the SAME path also has a fresh parked write (order matters: ' +
    'the discard loop\'s forgetFlushedHash(from) must run AFTER the remap, not before, or it wipes ' +
    'the record before it can follow the move)', async () => {
    const path = '/assets/fx/edited-again.particle.json';
    const to = '/assets/fx/edited-again-renamed.particle.json';
    markAssetDirty(path, 'particle', { version: 1 }, 'panel');
    await flushDirtyAssets(); // records lastFlushedHash[path], clears the dirty entry
    expect(getLastFlushedAssetHash(path)).toBe(HASH);
    markAssetDirty(path, 'particle', { version: 2 }, 'panel'); // edited again — re-parked at the same path
    expect(getDirtyAssetPaths()).toEqual([path]); // positive control: this path IS in the discard loop now

    applyMovesToParkedAssets([{ from: path, to }]);

    expect(getLastFlushedAssetHash(to)).toBe(HASH);
  });
});

/** `remapFlushedAssetRecords` (the two loops `applyMovesToParkedAssets` above delegates its
 *  flushed-record repair to) used to snapshot each map's KEYS before walking but read each VALUE
 *  live inside the loop — so a CHAINED move `[A→B, B→C]` re-keyed A→B first, and the B→C step then
 *  read B's slot with a live `.get(path)`, which by then held A's freshly-written value, not B's.
 *  Net effect: B's record was silently DESTROYED and C ended up holding A's record under the wrong
 *  name. (No caller passes a chained move today — this pins the shape, not a live bug, mirroring
 *  the `applyMovesToParkedAssets` chained-move test above.)
 *
 *  The constant-`HASH` stub above cannot tell this apart — both records would read the same value
 *  either way — so this uses a hash DERIVED from the written path, giving A and B distinguishable
 *  hashes. */
describe('applyMovesToParkedAssets carries the flushed-hash record across a CHAINED move', () => {
  const hashFor = (path: string): string => {
    let code = 0;
    for (let i = 0; i < path.length; i++) code = (code * 31 + path.charCodeAt(i)) >>> 0;
    return code.toString(16).padStart(8, '0').repeat(8).slice(0, 64);
  };

  beforeEach(() => {
    clearDirtyAssets();
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { path: string };
      return { ok: true, status: 200, json: async () => ({ ok: true, saved: true, sha256: hashFor(body.path) }) } as unknown as Response;
    }));
  });
  afterEach(() => { clearDirtyAssets(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('resolves each hop against the ORIGINAL records, not one already re-keyed by an earlier hop', async () => {
    const A = '/assets/fx/a.particle.json';
    const B = '/assets/fx/b.particle.json';
    const C = '/assets/fx/c.particle.json';
    markAssetDirty(A, 'particle', { doc: 'A' }, 'panel');
    markAssetDirty(B, 'particle', { doc: 'B' }, 'panel');
    await flushDirtyAssets();
    // Positive control: both records are present, each under its OWN distinct hash, before the
    // move — a test that could pass without looking would not be a test.
    expect(getDirtyAssetPaths()).toEqual([]);
    expect(getLastFlushedAssetHash(A)).toBe(hashFor(A));
    expect(getLastFlushedAssetHash(B)).toBe(hashFor(B));
    expect(hashFor(A)).not.toBe(hashFor(B));
    // Positive control for the DOC record too — A and B's parked docs are distinguishable
    // (`{ doc: 'A' }` vs `{ doc: 'B' }`), the same way the path-derived hash tells them apart.
    expect(getLastFlushedAsset(A)).toEqual({ doc: 'A' });
    expect(getLastFlushedAsset(B)).toEqual({ doc: 'B' });

    applyMovesToParkedAssets([{ from: A, to: B }, { from: B, to: C }]);

    // B's slot must hold A's (moved-in) record, and C must hold B's — never B destroyed and C
    // holding A's, which is what the live-read bug produced.
    expect(getLastFlushedAssetHash(B)).toBe(hashFor(A));
    expect(getLastFlushedAssetHash(C)).toBe(hashFor(B));
    expect(getLastFlushedAsset(B)).toEqual({ doc: 'A' });
    expect(getLastFlushedAsset(C)).toEqual({ doc: 'B' });
  });
});
