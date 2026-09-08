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
  applyAssetPathMoves, applyMovesToSelection,
} from '../../packages/modoki/src/editor/panels/assetEditorBindings';
import { applyMove, planFilesDropMoves } from '../../packages/modoki/src/editor/utils/assetPaths';
import { useEditorStore } from '../../packages/modoki/src/editor/store/editorStore';
import { makeFilesDropUndo } from '../../packages/modoki/src/editor/panels/assetUndo';
import * as assetOps from '../../packages/modoki/src/editor/panels/assetOps';
import { canUndo, undoLabel } from '../../packages/modoki/src/editor/undo/undoManager';
import {
  markAssetDirty, clearDirtyAssets, getDirtyAssetPaths, peekDirtyAsset,
  flushDirtyAssets, getLastFlushedAssetHash, getLastFlushedAsset,
} from '../../packages/modoki/src/editor/scene/dirtyAssets';
import {
  parkMetaEdit, clearPendingMeta, clearMetaBaselines, getPendingMetaPaths, peekPendingMeta,
  peekMetaBaseline,
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
 *  ⚠️ Tests that mean to exercise the REFUSAL call `parkMetaEdit` directly, and several below do.
 *  The `MetaParkVerdict` is passed through rather than swallowed (#903) — an accept-side assertion
 *  wants it, and a helper that discarded it would make the accept case unassertable here. */
const parkAsPanel = (p: string, doc: Record<string, unknown>, ifMatch?: string) =>
  parkMetaEdit(p, stampMetaReadPath(doc, p), ifMatch);


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
    parkAsPanel(PNG, { id: 'a-guid', texture: { maxSize: 512 } });

    const notes = applyAssetPathMoves([{ from: PNG, to: null }]);

    expect(getPendingMetaPaths()).toEqual([]);
    expect(notes.join(' ')).toContain(PNG);
    expect(notes.join(' ')).toMatch(/import-settings/);
  });

  it('MOVES a parked meta edit when its asset is renamed — the edit follows, no orphan is written', () => {
    const to = '/assets/textures/stone.png';
    parkAsPanel(PNG, { id: 'a-guid', texture: { maxSize: 512 } });

    applyAssetPathMoves([{ from: PNG, to }]);

    expect(getPendingMetaPaths()).toEqual([to]);
    expect(peekPendingMeta(to)).toEqual(stampMetaReadPath({ id: 'a-guid', texture: { maxSize: 512 } }, to));
    expect(peekPendingMeta(PNG), 'the old path must not still be parked').toBeUndefined();
  });

  /** ⚠️ #891's guard has exactly one legitimate exception, and this is it: a parked document is
   *  stamped with the path it was READ for, `parkMetaEdit` refuses a foreign stamp, and a rename is
   *  the one case where a document genuinely changes which path it belongs to. `applyMovesToParkedMeta`
   *  says so by RE-STAMPING rather than the guard carrying a hole for it.
   *
   *  The test above pins the moved document; this one pins what a missing re-stamp actually costs —
   *  the human's NEXT keystroke on the renamed asset would be refused, and the edit they can see in
   *  the panel would stop reaching the registry with only a console line to say so. */
  it('the moved edit is still EDITABLE under its new path — the re-stamp, not just the move', () => {
    const to = '/assets/textures/stone.png';
    parkAsPanel(PNG, { id: 'a-guid', texture: { maxSize: 512 } });
    applyAssetPathMoves([{ from: PNG, to }]);

    // The panel, now showing the renamed asset, re-spreads what it holds and parks the next edit.
    const held = peekPendingMeta(to) as Record<string, unknown>;
    parkMetaEdit(to, { ...held, texture: { maxSize: 1024 } });

    expect(peekPendingMeta(to)).toEqual(stampMetaReadPath({ id: 'a-guid', texture: { maxSize: 1024 } }, to));
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
    parkAsPanel(PNG, { id: 'a-guid' }, 'BASELINE-SHA');
    expect(peekMetaBaseline(PNG)).toBe('BASELINE-SHA');   // positive control

    applyAssetPathMoves([{ from: PNG, to }]);

    expect(peekMetaBaseline(to)).toBe('BASELINE-SHA');
    expect(peekMetaBaseline(PNG), 'the old key must not keep it either').toBeUndefined();
  });

  it('a DELETE drops the baseline with the park — there is no path left to describe', () => {
    parkAsPanel(PNG, { id: 'a-guid' }, 'BASELINE-SHA');

    applyAssetPathMoves([{ from: PNG, to: null }]);

    expect(peekMetaBaseline(PNG)).toBeUndefined();
  });

  it('moves BOTH registries in one call, so neither can be forgotten', () => {
    const to = '/assets/textures/stone.png';
    markAssetDirty(ANIM, 'animation', { duration: 3 }, 'panel');
    parkAsPanel(PNG, { id: 'a-guid' });

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

/** #867 member 2 — the dragged FOLDER.
 *
 *  `handleFilesDrop` built `{from, to}` with no `prefix`, and `DropMove` had no such field at all,
 *  so the type foreclosed a folder move: `applyMove` took its exact-path branch and returned
 *  `undefined` for every descendant. The drag payload has carried `isFolder: true` since folders
 *  became draggable and nothing has ever read it.
 *
 *  ⚠️ The pre-existing 'preserves the CAS BASELINE across a FOLDER move too' test above passes
 *  `prefix: true` BY HAND. It proves the branch works and says nothing about whether the one
 *  production caller sets it — which is the entire defect. These tests drive the planner that
 *  caller now uses. */
describe('planFilesDropMoves marks a folder drag as a prefix move (#867)', () => {
  const isFolder = (p: string) => p === '/assets/anim' || p === '/assets/archive';

  it('a dragged FOLDER gets prefix, so the repair reaches everything under it', () => {
    const moves = planFilesDropMoves(['/assets/anim'], '/assets/archive', isFolder);
    expect(moves).toEqual([{ from: '/assets/anim', to: '/assets/archive/anim', prefix: true }]);
    // The consequence, spelled out: a CHILD is repaired only because of that flag.
    expect(applyMove('/assets/anim/walk.anim.json', moves[0])).toBe('/assets/archive/anim/walk.anim.json');
  });

  it('a dragged FILE does not get prefix — it must not capture its path-prefix siblings', () => {
    const moves = planFilesDropMoves(['/assets/anim/walk.anim.json'], '/assets/archive', isFolder);
    expect(moves[0].prefix).toBeUndefined();
  });

  it('a mixed multi-selection gets it per PATH, which one drag payload cannot express', () => {
    // The payload carries a single `isFolder` for the whole drag, so reading it would be wrong
    // here even if anything did read it. The tree is asked about each path instead.
    const moves = planFilesDropMoves(
      ['/assets/anim', '/assets/fx/spark.particle.json'], '/assets/archive', isFolder,
    );
    expect(moves.map((m) => m.prefix)).toEqual([true, undefined]);
  });

  it('keeps the pre-existing skips: same folder, onto itself, into its own descendant', () => {
    expect(planFilesDropMoves(['/assets/fx/a.json'], '/assets/fx', isFolder)).toEqual([]);
    expect(planFilesDropMoves(['/assets/anim'], '/assets/anim', isFolder)).toEqual([]);
    expect(planFilesDropMoves(['/assets/anim'], '/assets/anim/sub', isFolder)).toEqual([]);
  });

  it('a FOLDER move repairs a parked write for a file inside it, end to end', () => {
    clearDirtyAssets();
    const child = '/assets/anim/walk.anim.json';
    markAssetDirty(child, 'animation', { duration: 3 }, 'panel', 'baseline-sha');
    const moves = planFilesDropMoves(['/assets/anim'], '/assets/archive', isFolder);
    applyAssetPathMoves(moves);
    expect(getDirtyAssetPaths()).toEqual(['/assets/archive/anim/walk.anim.json']);
    // The CAS baseline has to travel too, or the next Cmd+S 409s at the new path.
    expect(peekDirtyAsset('/assets/archive/anim/walk.anim.json')?.ifMatch).toBe('baseline-sha');
    clearDirtyAssets();
  });
});

/** #867 member 3 — the Inspector selection was repaired at ONE of thirteen move sites. */
describe('applyMovesToSelection repairs the Inspector (#867)', () => {
  const asset = (path: string) => ({ path, type: 'animation', name: path.slice(path.lastIndexOf('/') + 1) });
  const select = (lead: ReturnType<typeof asset> | null, list: ReturnType<typeof asset>[] = lead ? [lead] : []) =>
    useEditorStore.getState().remapSelectedAssets({ selectedAsset: lead, selectedAssets: list });
  afterEach(() => select(null, []));

  it('repoints the lead selection at the new path', () => {
    select(asset(ANIM));
    applyMovesToSelection([{ from: ANIM, to: '/assets/anim/run.anim.json' }]);
    expect(useEditorStore.getState().selectedAsset?.path).toBe('/assets/anim/run.anim.json');
  });

  it('KEEPS the name when the move only relocated the file', () => {
    // The name here is the manifest DISPLAY name, deliberately unlike the basename — a fixture
    // whose name equals its basename cannot tell "kept" from "re-derived", and the first version
    // of this test could not.
    select({ path: '/assets/anim/walk.anim.json', type: 'animation', name: 'Walk.Animation' });
    applyMovesToSelection([{ from: '/assets/anim', to: '/assets/clips', prefix: true, name: 'clips' }]);
    const sel = useEditorStore.getState().selectedAsset;
    expect(sel?.path).toBe('/assets/clips/walk.anim.json');
    // NOT 'clips' (that is the FOLDER's new name — applying it would rename every file in a moved
    // folder to the folder's name) and NOT 'walk.anim.json' (a third format: the display name is a
    // stem on the rename path, the manifest name on the click path, never the basename).
    expect(sel?.name).toBe('Walk.Animation');
  });

  it('takes the move\'s own name on an EXACT rename', () => {
    select({ path: '/assets/anim/walk.anim.json', type: 'animation', name: 'Walk.Animation' });
    applyMovesToSelection([{ from: '/assets/anim/walk.anim.json', to: '/assets/anim/run.anim.json', name: 'run' }]);
    expect(useEditorStore.getState().selectedAsset?.name).toBe('run');
  });

  it('DERIVES the stem when a rename carries no name — the agent path (#867)', () => {
    // `/api/move-file` has no display-name convention to send, so a rename arriving from the MCP
    // process carries `{from, to}` only. Deriving it the way `planRename` builds one (stem, not
    // basename) is what keeps the Inspector from showing the previous filename.
    select({ path: '/assets/anim/walk.anim.json', type: 'animation', name: 'Walk.Animation' });
    applyMovesToSelection([{ from: '/assets/anim/walk.anim.json', to: '/assets/anim/run.anim.json' }]);
    expect(useEditorStore.getState().selectedAsset?.name).toBe('run');
  });

  it('drops a DELETED asset from the multi-selection and clears the lead', () => {
    select(asset(ANIM), [asset(ANIM), asset(SEQ)]);
    applyMovesToSelection([{ from: ANIM, to: null }]);
    const s = useEditorStore.getState();
    expect(s.selectedAsset).toBeNull();
    expect(s.selectedAssets.map((a) => a.path)).toEqual([SEQ]);
  });

  it('leaves an UNRELATED selection alone', () => {
    select(asset(SEQ));
    applyMovesToSelection([{ from: ANIM, to: '/assets/anim/run.anim.json' }]);
    expect(useEditorStore.getState().selectedAsset?.path).toBe(SEQ);
  });

  it('runs from applyAssetPathMoves — the SEAM, not a fourteenth call site', () => {
    // This is the assertion that distinguishes the fix from the bug it replaces: every existing
    // site already calls applyAssetPathMoves, so being inside it IS the repair reaching them all.
    select(asset(ANIM));
    applyAssetPathMoves([{ from: ANIM, to: '/assets/anim/run.anim.json' }]);
    expect(useEditorStore.getState().selectedAsset?.path).toBe('/assets/anim/run.anim.json');
  });

  it('does NOT push an undo entry — a repair must not land in the history (#867)', () => {
    // `selectAsset` pushes an undoable `Select …`. If the repair used it, Cmd+Z after a rename
    // would step through a selection change the user never made.
    select(asset(ANIM));
    const before = useEditorStore.getState().selectedAsset?.path;
    expect(before).toBe(ANIM);
    const historyBefore = { can: canUndo(), label: undoLabel() };
    applyAssetPathMoves([{ from: ANIM, to: '/assets/anim/run.anim.json' }]);
    // The label is the sharp half: a pushed `Select walk.anim.json` would change it even where
    // canUndo() was already true for an unrelated reason.
    expect({ can: canUndo(), label: undoLabel() }).toEqual(historyBefore);
  });
});

/** #867 — `prefix` has to survive UNDO, or a folder drag repairs its children on the way out and
 *  abandons them on the way back. That asymmetry is the same defect pointing the other way, and it
 *  is the shape `bb87c17bc` already shipped once for `currentFolder` (forward path right, undone
 *  path wrong), so it is worth pinning rather than assuming. */
describe('makeFilesDropUndo carries prefix in BOTH directions (#867)', () => {
  const FOLDER = { from: '/assets/anim', to: '/assets/archive/anim', prefix: true };
  const CHILD_AT_DEST = '/assets/archive/anim/walk.anim.json';
  const CHILD_AT_SRC = '/assets/anim/walk.anim.json';

  beforeEach(() => {
    clearDirtyAssets();
    // The undo/redo closures move files through the backend; this suite is about the PathMoves
    // they hand the repair, so the move itself is stubbed as succeeding.
    vi.spyOn(assetOps, 'moveFileToStatus').mockResolvedValue({ ok: true, status: 200 });
  });
  afterEach(() => { vi.restoreAllMocks(); clearDirtyAssets(); });

  it('undo repairs a child of the moved folder, not just the folder', async () => {
    const action = makeFilesDropUndo({ moves: [FOLDER], refresh: () => {} });
    markAssetDirty(CHILD_AT_DEST, 'animation', { duration: 3 }, 'panel');
    await action.undo();
    // Without `prefix` on the reversed move, applyMove returns undefined for this path and the
    // parked write is stranded at a location the file has left.
    expect(getDirtyAssetPaths()).toEqual([CHILD_AT_SRC]);
  });

  it('redo repairs it back', async () => {
    const action = makeFilesDropUndo({ moves: [FOLDER], refresh: () => {} });
    markAssetDirty(CHILD_AT_DEST, 'animation', { duration: 3 }, 'panel');
    await action.undo();
    await action.redo();
    expect(getDirtyAssetPaths()).toEqual([CHILD_AT_DEST]);
  });
});

/** Review finding: renaming a BOUND asset left the panel header stale (#867).
 *
 *  `handleRename` awaits `/api/move-file`, whose repair now runs FIRST and carries no `name`.
 *  `remapEditingAssetPath` does `name: name ?? cur.name`, so the binding took the new PATH and kept
 *  the OLD name; the panel's own name-carrying call one line later then found the binding already
 *  at the destination, `applyMove` returned `undefined`, and the name was never applied. The
 *  SpriteAnim/Animation/Timeline panel headers render `asset?.name`, so they kept showing the
 *  previous filename — and `AnimationEditor`/`TimelineEditor` build their fallback doc from it on a
 *  load failure, which bakes the stale name into what gets saved. */
describe('resolveBindingMoves keeps a bound editor\'s NAME fresh (#867 review)', () => {
  const boundTo = (path: string) => [{ label: 'animation', path }];

  it('derives the new stem for a rename that carries no name — the route\'s repair', () => {
    const [change] = resolveBindingMoves(
      boundTo('/assets/anim/walk.anim.json'),
      [{ from: '/assets/anim/walk.anim.json', to: '/assets/anim/run.anim.json' }],
    );
    expect(change.to).toBe('/assets/anim/run.anim.json');
    expect(change.name).toBe('run');
  });

  it('leaves the name alone for a pure relocation, so the store keeps what it has', () => {
    // `undefined` is the "keep it" signal — `remapEditingAssetPath` falls back to `cur.name`.
    const [change] = resolveBindingMoves(
      boundTo('/assets/anim/walk.anim.json'),
      [{ from: '/assets/anim', to: '/assets/archive/anim', prefix: true }],
    );
    expect(change.to).toBe('/assets/archive/anim/walk.anim.json');
    expect(change.name).toBeUndefined();
  });

  it('never applies a FOLDER rename\'s name to a child', () => {
    const [change] = resolveBindingMoves(
      boundTo('/assets/anim/walk.anim.json'),
      [{ from: '/assets/anim', to: '/assets/clips', prefix: true, name: 'clips' }],
    );
    expect(change.name).toBeUndefined();
  });
});
