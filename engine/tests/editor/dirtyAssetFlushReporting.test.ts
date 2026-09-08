/** What the FLUSH carries and what it reports back (#831).
 *
 *  Since #831 the asset views park and `flushDirtyAssets` is the only writer, which moved two
 *  things out of the panels and into the registry:
 *
 *   - the **compare-and-swap baseline** `AtlasAssetView` used to hold itself. It rides on the
 *     entry as `DirtyAsset.ifMatch` and is sent as `/api/asset-write`'s precondition. A baseline
 *     that silently fails to reach the request is a CAS that is off while looking on, which is
 *     why this asserts the request BODY and not just the outcome.
 *   - the **failure report**. `flushDirtyAssets` already left a failed entry parked and returned
 *     it in `FlushResult.failed`, but that result goes to whoever called `saveAll` — and the
 *     person who needs to know is looking at the panel. Nothing reached them.
 *
 *  ⚠️ The baseline ADVANCE is the half that is easy to leave out and fatal to leave out: after a
 *  successful save the file no longer holds the text the panel loaded, so the next park would
 *  carry a baseline the server can never match and every subsequent save would 409 with no way
 *  out. `getLastFlushedAssetHash` exists for exactly that, and it takes the server's own hash
 *  rather than recomputing the bytes here. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  markAssetDirty, flushDirtyAssets, clearDirtyAssets, peekDirtyAsset, isAssetDirty,
  getAssetFlushError, getLastFlushedAssetHash, clearAssetIfMatch, discardDirtyAssets,
  forgetFlushedAssetHash,
} from '../../packages/modoki/src/editor/scene/dirtyAssets';

const PATH = '/assets/sprites/hero.atlas.json';
const DOC = { id: 'a', version: 1, members: ['s1'], pageSize: 1024, padding: 7, extrude: 1 };
const BASELINE = 'a'.repeat(64);

type Reply = { status: number; body: unknown };
let reply: Reply;
let bodies: Array<Record<string, unknown>>;

beforeEach(() => {
  clearDirtyAssets();
  bodies = [];
  reply = { status: 200, body: { ok: true, saved: true, sha256: 'b'.repeat(64) } };
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    return { ok: reply.status < 400, status: reply.status, json: async () => reply.body } as unknown as Response;
  }));
});
afterEach(() => { clearDirtyAssets(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('the flush carries the compare-and-swap baseline', () => {
  it('sends ifMatch when the entry has one', async () => {
    markAssetDirty(PATH, 'atlas', DOC, 'panel', BASELINE);
    await flushDirtyAssets();
    expect(bodies[0].ifMatch).toBe(BASELINE);
  });

  it('OMITS ifMatch entirely when the entry has none — every other caller writes unconditionally', async () => {
    // `ifMatch: undefined` would serialize away, so this would pass either way through the wire;
    // asserted on the parsed body as an absent KEY so a future `ifMatch: null` cannot creep in.
    markAssetDirty('/assets/materials/rock.mat.json', 'material', { color: 1 }, 'panel');
    await flushDirtyAssets();
    expect(Object.keys(bodies[0])).not.toContain('ifMatch');
  });

  it('a re-park that omits the baseline PRESERVES it', async () => {
    // The concrete path is `adoptParkedDoc`, which re-parks a panel's normalized copy of an
    // existing entry and has no baseline of its own to pass. Clearing on its behalf would disarm
    // the CAS silently — the entry looks the same and the precondition is gone.
    markAssetDirty(PATH, 'atlas', DOC, 'panel', BASELINE);
    markAssetDirty(PATH, 'atlas', { ...DOC, padding: 9 }, 'panel');
    expect(peekDirtyAsset(PATH)?.ifMatch).toBe(BASELINE);
    await flushDirtyAssets();
    expect(bodies[0].ifMatch).toBe(BASELINE);
    expect((bodies[0].data as { padding: number }).padding).toBe(9);
  });

  it('clearAssetIfMatch drops it, so the next flush overwrites deliberately', async () => {
    markAssetDirty(PATH, 'atlas', DOC, 'panel', BASELINE);
    expect(clearAssetIfMatch(PATH)).toBe(true);
    await flushDirtyAssets();
    expect(Object.keys(bodies[0])).not.toContain('ifMatch');
  });

  it('clearAssetIfMatch reports false when there was no baseline to clear', () => {
    markAssetDirty(PATH, 'atlas', DOC, 'panel');
    expect(clearAssetIfMatch(PATH)).toBe(false);
    expect(clearAssetIfMatch('/nothing/parked/here.atlas.json')).toBe(false);
  });
});

describe('the flush advances the baseline it wrote', () => {
  it('records the sha256 the server reports', async () => {
    markAssetDirty(PATH, 'atlas', DOC, 'panel', BASELINE);
    await flushDirtyAssets();
    expect(getLastFlushedAssetHash(PATH)).toBe('b'.repeat(64));
  });

  it('keeps the previous baseline when the reply carries no sha256', async () => {
    // An older backend. Keeping the old value means the next save conflicts LOUDLY, which is the
    // right failure: writing against a baseline nobody vouched for is the silent one.
    reply = { status: 200, body: { ok: true, saved: true } };
    markAssetDirty(PATH, 'atlas', DOC, 'panel', BASELINE);
    await flushDirtyAssets();
    expect(getLastFlushedAssetHash(PATH)).toBeNull();
  });

  it('records nothing for a path whose write FAILED', async () => {
    reply = { status: 409, body: { ok: false, conflict: true, error: 'changed on disk' } };
    markAssetDirty(PATH, 'atlas', DOC, 'panel', BASELINE);
    await flushDirtyAssets();
    expect(getLastFlushedAssetHash(PATH)).toBeNull();
  });
});

describe('the flush reports why a write did not land', () => {
  it('records a CONFLICT distinctly from any other failure', async () => {
    reply = { status: 409, body: { ok: false, conflict: true, error: 'REFUSED: changed on disk' } };
    markAssetDirty(PATH, 'atlas', DOC, 'panel', BASELINE);

    const result = await flushDirtyAssets();

    expect(result.failed).toHaveLength(1);
    expect(getAssetFlushError(PATH)).toEqual({ error: 'REFUSED: changed on disk', conflict: true });
    // Still parked: a failed flush must never look like a save.
    expect(isAssetDirty(PATH)).toBe(true);
  });

  it('records an ordinary rejection as NOT a conflict — different story, different remedy', async () => {
    reply = { status: 500, body: { ok: false, error: 'EACCES' } };
    markAssetDirty(PATH, 'atlas', DOC, 'panel');
    await flushDirtyAssets();
    expect(getAssetFlushError(PATH)).toEqual({ error: 'EACCES', conflict: false });
  });

  it('clears the error once the path saves', async () => {
    reply = { status: 500, body: { ok: false, error: 'EACCES' } };
    markAssetDirty(PATH, 'atlas', DOC, 'panel');
    await flushDirtyAssets();
    expect(getAssetFlushError(PATH)).not.toBeNull();

    reply = { status: 200, body: { ok: true, saved: true, sha256: 'c'.repeat(64) } };
    await flushDirtyAssets();
    expect(getAssetFlushError(PATH)).toBeNull();
  });

  it('clears the error when the path is edited again, or discarded', async () => {
    reply = { status: 500, body: { ok: false, error: 'EACCES' } };
    markAssetDirty(PATH, 'atlas', DOC, 'panel');
    await flushDirtyAssets();

    markAssetDirty(PATH, 'atlas', { ...DOC, padding: 3 }, 'panel');
    expect(getAssetFlushError(PATH), 'a fresh edit supersedes the previous save attempt').toBeNull();

    await flushDirtyAssets();
    expect(getAssetFlushError(PATH)).not.toBeNull();
    discardDirtyAssets([PATH]);
    expect(getAssetFlushError(PATH)).toBeNull();
  });

  it('does not attribute one path\'s failure to another', async () => {
    // The loop records per path and swaps the map in wholesale; writing straight into the shared
    // map would clear an error for a path this flush never reached.
    reply = { status: 500, body: { ok: false, error: 'EACCES' } };
    markAssetDirty(PATH, 'atlas', DOC, 'panel');
    await flushDirtyAssets();

    reply = { status: 200, body: { ok: true, saved: true, sha256: 'c'.repeat(64) } };
    markAssetDirty('/assets/materials/rock.mat.json', 'material', { color: 1 }, 'panel');
    // PATH is still parked and will be retried by this same flush, so assert on a path that is
    // NOT retried: discard it first and check its error goes with it, not with the other write.
    discardDirtyAssets([PATH]);
    await flushDirtyAssets();

    expect(getAssetFlushError('/assets/materials/rock.mat.json')).toBeNull();
    expect(getAssetFlushError(PATH)).toBeNull();
  });
});

describe('the baseline survives its own save (#831 review, findings 4 + 5)', () => {
  it('an edit made DURING the flush adopts the hash the flush just wrote', async () => {
    // ⚠️ The superseding entry captured its `ifMatch` from the file as it was BEFORE this flush.
    // The flush then wrote our own bytes over it, so that precondition can never match again: the
    // next Cmd+S 409s under a banner claiming the file "changed on disk" when nothing external
    // touched it. Same "keep dragging after Cmd+S" window the `dirty.get(path) === entry` check
    // beside it was written for, one level down.
    markAssetDirty(PATH, 'atlas', DOC, 'panel', BASELINE);
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      markAssetDirty(PATH, 'atlas', { ...DOC, padding: 9 }, 'panel'); // the human keeps editing
      return { ok: true, status: 200, json: async () => reply.body } as unknown as Response;
    }));

    await flushDirtyAssets();

    expect(isAssetDirty(PATH), 'the newer edit must stay pending').toBe(true);
    expect(peekDirtyAsset(PATH)?.ifMatch, 'and must now be conditioned on what the flush WROTE')
      .toBe('b'.repeat(64));
  });

  it('does NOT give a baseline to a path that never had one', async () => {
    // An entry with no `ifMatch` is an unconditional write on purpose (every non-atlas view, and
    // every agent park on a path no panel has guarded). Handing it one here would arm a
    // compare-and-swap nobody asked for, on a file it was never meant to guard.
    const plain = '/assets/materials/rock.mat.json';
    markAssetDirty(plain, 'material', { color: 1 }, 'panel');
    vi.stubGlobal('fetch', vi.fn(async () => {
      markAssetDirty(plain, 'material', { color: 2 }, 'panel');
      return { ok: true, status: 200, json: async () => reply.body } as unknown as Response;
    }));

    await flushDirtyAssets();

    expect(peekDirtyAsset(plain)?.ifMatch).toBeUndefined();
  });

  it('an AGENT park that inherited the panel\'s baseline is advanced too — inheriting is the point', async () => {
    // `markAssetDirty` PRESERVES an omitted `ifMatch` (see its own note), so an agent re-parking
    // over a panel's guarded entry keeps the guard rather than silently disarming it. Advancing
    // that inherited baseline to what the flush just wrote is the same correction as for the panel:
    // disk now holds OUR bytes, so a precondition still naming the pre-flush file is guaranteed
    // wrong. Asserted rather than left implicit, because the two rules meet here and the
    // interaction is not obvious from either one alone.
    markAssetDirty(PATH, 'atlas', DOC, 'panel', BASELINE);
    vi.stubGlobal('fetch', vi.fn(async () => {
      markAssetDirty(PATH, 'atlas', { ...DOC, padding: 9 }, 'agent'); // inherits BASELINE
      return { ok: true, status: 200, json: async () => reply.body } as unknown as Response;
    }));

    await flushDirtyAssets();

    const parked = peekDirtyAsset(PATH);
    expect(parked?.origin).toBe('agent');
    expect(parked?.ifMatch).toBe('b'.repeat(64));
  });

  it('DISCARDING a path forgets what the last flush wrote for it', async () => {
    // The record is a claim about the CURRENT file. A discard is followed by the panel re-reading
    // the truth from disk, and a stale record then overwrites that fresh read — which is how the
    // atlas conflict banner's "Discard & reload" destroyed the human's edits without resolving the
    // conflict it was offered for.
    markAssetDirty(PATH, 'atlas', DOC, 'panel', BASELINE);
    await flushDirtyAssets();
    expect(getLastFlushedAssetHash(PATH)).toBe('b'.repeat(64));

    markAssetDirty(PATH, 'atlas', DOC, 'panel', BASELINE);
    discardDirtyAssets([PATH]);
    expect(getLastFlushedAssetHash(PATH)).toBeNull();
  });

  it('a bare discard forgets every path, not just the ones it was named', async () => {
    markAssetDirty(PATH, 'atlas', DOC, 'panel', BASELINE);
    await flushDirtyAssets();
    markAssetDirty(PATH, 'atlas', DOC, 'panel', BASELINE);
    discardDirtyAssets();
    expect(getLastFlushedAssetHash(PATH)).toBeNull();
  });
});

describe('the recorded flush hash is forgotten wherever it stops describing the file (#831 re-review)', () => {
  it('a fresh READ of the file forgets it — the panel just computed the truth', async () => {
    // ⚠️ The half the discard fix did not reach, and it fires with NOTHING parked and no discard in
    // sight: save the atlas (record H1) → `git checkout` moves the file to H2 → an atlas emits no
    // watcher broadcast, so nothing invalidates anything → the panel re-reads on Retry and sets its
    // baseline to H2 → the very next render puts the stale H1 back, and the edit the human made on
    // top of the truth they just read is refused. The panel's load effect calls this.
    markAssetDirty(PATH, 'atlas', DOC, 'panel', BASELINE);
    await flushDirtyAssets();
    expect(getLastFlushedAssetHash(PATH)).toBe('b'.repeat(64));

    forgetFlushedAssetHash(PATH);

    expect(getLastFlushedAssetHash(PATH)).toBeNull();
  });

  it('forgetting one path leaves another alone', () => {
    // A shared map with a per-path key: worth one line, because clearing wholesale here would
    // silently re-arm every OTHER open panel's next save with a stale precondition.
    forgetFlushedAssetHash('/assets/sprites/other.atlas.json');
    expect(getLastFlushedAssetHash('/assets/sprites/other.atlas.json')).toBeNull();
  });
});
