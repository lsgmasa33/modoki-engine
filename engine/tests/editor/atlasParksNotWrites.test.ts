/** The atlas inspector PARKS its edit and performs no write (#831).
 *
 *  `AtlasAssetView` had 12 `update()` call sites and every one of them enqueued a write to the
 *  committed `.atlas.json` — a keystroke in Padding/Extrude/Page Size, an add or remove of a
 *  member — with no save action, while `get_editor_state` reported `persistenceMode: 'manual'`.
 *  #831's own body cleared it by mistake ("writes through its own compare-and-swap queue"): that
 *  ruled it out of the SHARED FIX, not out of the defect.
 *
 *  ⚠️ **This also pins the claim that deleted `createAtlasWriteQueue`.** That queue existed
 *  (#469 review finding 1) to stop two rapid edits racing each other into a self-inflicted 409.
 *  The justification for removing it is that parking is synchronous and last-write-wins, so
 *  there are no concurrent writes left to serialize — "it cannot happen now" is exactly the
 *  reasoning that lets a defect back in, so the property is asserted rather than argued: N edits
 *  in a row leave ONE pending write, carrying the LAST document and the ORIGINAL baseline, and
 *  touch the network zero times.
 *
 *  The panel itself is not mounted (docs/editor.md § Panels: editor `.tsx` carries no tests, its
 *  `.ts` neighbour does). What is driven here is the exact pair `update()` calls —
 *  `buildAtlasDocToPark` then `persistAssetEdit(..., 'atlas', ..., baselineHash)` — plus a source
 *  scan for the write it must no longer contain. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';
import { buildAtlasDocToPark } from '../../packages/modoki/src/editor/panels/assetViews/AtlasAssetView';
import { buildNextAtlasDoc } from '../../packages/modoki/src/editor/panels/assetViews/atlasPersist';
import { persistAssetEdit, invalidateAtlasFile } from '../../packages/modoki/src/editor/panels/assetViews/persist';
import {
  clearDirtyAssets, peekDirtyAsset, getDirtyAssetPaths,
} from '../../packages/modoki/src/editor/scene/dirtyAssets';

const PATH = '/assets/sprites/hero.atlas.json';
const BASELINE = 'a'.repeat(64);
/** What the load effect read — including a key this view does not render (QA-ASSET-0013). */
const RAW = {
  id: 'atlas-guid', version: 1, members: ['s1'],
  texture: { format: 'ktx2-uastc', maxSize: 2048 },
  pageSize: 1024, padding: 2, extrude: 1,
};
const DOC = { id: 'atlas-guid', version: 1, members: ['s1'], pageSize: 1024, padding: 2, extrude: 1 };

/** The two lines `AtlasAssetView.update()` runs after its load guard passes. */
function update(patch: Parameters<typeof buildNextAtlasDoc>[1], baseline: string | null = BASELINE) {
  const next = buildNextAtlasDoc(DOC, patch);
  persistAssetEdit(PATH, 'atlas', buildAtlasDocToPark(RAW, next), invalidateAtlasFile, baseline ?? undefined);
}

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  clearDirtyAssets();
  fetchSpy = vi.fn(async () => { throw new Error('an atlas edit must not perform a write'); });
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => { clearDirtyAssets(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('an atlas edit parks instead of writing (#831)', () => {
  it('parks under type `atlas`, as a PANEL write, and hits the network zero times', () => {
    update({ padding: 7 });

    const parked = peekDirtyAsset(PATH);
    expect(parked?.type).toBe('atlas');
    expect(parked?.origin).toBe('panel');
    expect((parked?.data as { padding: number }).padding).toBe(7);
    expect(fetchSpy, 'the atlas view wrote to disk; parking AND writing is worse than either')
      .not.toHaveBeenCalled();
  });

  it('parks the compare-and-swap baseline with it', () => {
    // Without this the write at Cmd+S is unconditional and #439's data loss is back — a `git
    // checkout` under a live editor is silently reverted by the save.
    update({ padding: 7 });
    expect(peekDirtyAsset(PATH)?.ifMatch).toBe(BASELINE);
  });

  it('carries forward the keys this view does not render', () => {
    update({ members: ['s1', 's2'] });
    const parked = peekDirtyAsset(PATH)!.data as { texture: unknown; members: string[] };
    expect(parked.texture, 'the texture block decides how the packed page is ENCODED; losing it is QA-ASSET-0013').toEqual(RAW.texture);
    expect(parked.members, 'and the edit itself still applies').toEqual(['s1', 's2']);
  });

  it('N rapid edits collapse to ONE pending write — the race the deleted queue existed for', () => {
    // Three stepper clicks at auto-repeat rate. Under the old code these were three in-flight
    // conditional writes sharing one baseline, and the 2nd and 3rd 409'd against the 1st.
    update({ padding: 3 });
    update({ padding: 4 });
    update({ padding: 5 });

    expect(getDirtyAssetPaths()).toEqual([PATH]);
    const parked = peekDirtyAsset(PATH)!;
    expect((parked.data as { padding: number }).padding, 'last write wins').toBe(5);
    // The baseline must NOT have advanced: nothing was written, so disk still holds what the
    // panel loaded. Advancing it here is how a CAS ends up vouching for content nobody read.
    expect(parked.ifMatch).toBe(BASELINE);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('parks with NO precondition when the panel has no baseline', () => {
    // Not a hypothetical: `baselineHash` is null before the load lands. The panel gates edits on
    // `loadState === 'ok'` so this should be unreachable — but if it is ever reached, an absent
    // baseline must mean "unconditional", never "some stale hash".
    update({ padding: 7 }, null);
    expect(peekDirtyAsset(PATH)?.ifMatch).toBeUndefined();
  });
});

describe('AtlasAssetView no longer contains a write path', () => {
  // A source scan, because the panel is not mounted and the property is an ABSENCE — the kind a
  // behavioural test cannot see. Its limit, stated: it proves the panel does not name a writer,
  // not that no writer is reachable through something it does call.
  const abs = path.resolve(
    __dirname, '../../packages/modoki/src/editor/panels/assetViews/AtlasAssetView.tsx',
  );

  it('hands its OWN baseline to persistAssetEdit', () => {
    // ⚠️ The behavioural tests above drive `persistAssetEdit` the way `update()` does, which means
    // they cannot see the panel dropping the argument — a mutation removing `baselineHash` from
    // the real call site left every one of them green. This is the assertion that fails for it.
    const code = readScannedSource(abs).code;
    const call = /persistAssetEdit\([^;]*?\);/s.exec(code);
    expect(call, 'AtlasAssetView no longer calls persistAssetEdit at all').not.toBeNull();
    expect(call![0], 'the compare-and-swap baseline is not being passed — the write at Cmd+S would be unconditional and #439 is back')
      .toContain('baselineHash.current');
  });

  it('forgets the recorded flush hash when it re-reads the file', () => {
    // The record is a claim about the CURRENT file; a fresh read supersedes it, and the panel's own
    // render-time re-seed would otherwise put the stale value straight back over the hash it just
    // computed from the bytes. Reachable with nothing parked and no discard — see
    // `forgetFlushedAssetHash`. Static, because the load effect needs a mount to run.
    const code = readScannedSource(abs).code;
    expect(code, 'the load effect no longer forgets the recorded flush hash — a `git checkout` under '
      + 'a live editor then costs the human one round of edits on every re-read')
      .toContain('forgetFlushedAssetHash(path)');
  });

  it('does NOT gate the baseline re-seed on "nothing is parked"', () => {
    // That gate looked safe and was a bug: an edit made WHILE a flush is in flight re-parks, so the
    // gate held the panel's ref at the PRE-flush hash and the next keystroke parked that stale
    // value again — undoing the advance `flushDirtyAssets` had just made to the entry itself. The
    // record is now cleared wherever it stops describing the file, so the gate is not needed and
    // is actively wrong.
    const code = readScannedSource(abs).code;
    const reseed = /if \(flushedHash[^\n]*\)/.exec(code);
    expect(reseed, 'the baseline re-seed is gone — the second save of an atlas will 409 forever')
      .not.toBeNull();
    expect(reseed![0]).not.toContain('parkedHere');
  });

  it('imports no write helper and calls no write route', () => {
    const code = readScannedSource(abs).code;
    // Non-vacuity: the file must actually have been read.
    expect(code).toContain('persistAssetEdit');
    for (const forbidden of ['writeAssetFile', 'writeAssetFileIfMatch', 'persistAtlasDoc', 'createAtlasWriteQueue', '/api/write-file', '/api/asset-write']) {
      expect(code, `AtlasAssetView still references \`${forbidden}\` — the edit must reach disk only through the dirty-asset registry, or #831 is back with a second persistence contract`)
        .not.toContain(forbidden);
    }
  });
});
