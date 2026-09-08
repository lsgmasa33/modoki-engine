/** The Inspector's `.meta.json` import-settings edits are MANUAL-SAVE (#845).
 *
 *  A texture-compression dropdown, an LOD-ratio slider, and every other control bound to a
 *  `.meta.json` sidecar used to POST `/api/write-meta` the moment the field changed — no save
 *  action, while `get_editor_state` reported `persistenceMode:'manual'`. That is #831's defect
 *  on a fifth surface (`writeMetaOrWarn`, a plain fetch wrapper with no registry behind it).
 *
 *  Three properties are pinned here, mirroring `pendingBaseScene.test.ts`:
 *
 *   1. **A parked edit writes nothing** until the flush, and `hasUnsavedChanges()` counts it —
 *      an unsaved edit the editor cannot see is the silent-loss trap `unsavedChanges` exists
 *      for. The NEGATIVE half matters too: parking a `.meta.json` edit must NOT also flip the
 *      unrelated `sceneDirty` cause — that would misdiagnose every refusal it drives.
 *   2. **The flush takes its entries before it issues anything**, and a failed entry is
 *      RE-PARKED only if nothing newer claimed the path while it was in flight.
 *   3. **`flushPendingMetaFor` never reads the map while a full flush is mid-write** — a
 *      re-import racing a Cmd+S must not issue its own write for the same path before the
 *      flush's write for it has landed.
 *   4. **`readMetaPreferringPark` prefers a parked doc over the network** (#845 close-out — the
 *      race parking itself introduced, closed here rather than in a follow-up): several call
 *      sites read `.meta.json` and either decide something from it or write the whole document
 *      back, and none of them consulted this registry before this helper existed.
 *   5. **`metaWrittenToDisk` drops only the park an immediate full-document write actually
 *      incorporated** — a park made SINCE that write's own read must survive to the next flush,
 *      or an Inspector edit made while a 9-slice/sprite-editor Save was in flight would be
 *      silently discarded by that Save's own "I'm done with this" bookkeeping. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  parkMetaEdit, peekPendingMeta, isMetaDirty, hasPendingMeta, getPendingMetaPaths,
  clearPendingMeta, discardPendingMeta, flushPendingMeta, flushPendingMetaFor,
  readMetaPreferringPark, metaWrittenToDisk, peekMetaBaseline, clearMetaBaselines,
  writeMetaWholesale,
  noteMetaReadResult, metaReadFallback,
  stampMetaReadPath, metaReadPathOf, metaCameFromFailedRead,
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


const TEX = '/assets/textures/rock.png.meta.json';
const OTHER = '/assets/textures/grass.png.meta.json';
/** #871's asset type: the one whose only reader is the exempted raw fetch in `VideoAssetView`. */
const VID = '/assets/video/intro.mp4';

type Reply = { status: number; body: unknown };
let reply: Reply;
let bodies: Array<{ path: string; meta: unknown }>;

beforeEach(() => {
  clearPendingMeta();
  clearMetaBaselines();
  bodies = [];
  reply = { status: 200, body: { ok: true } };
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    return { ok: reply.status < 400, status: reply.status, text: async () => '', json: async () => reply.body } as unknown as Response;
  }));
});
afterEach(() => { clearPendingMeta(); clearMetaBaselines(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('parking a meta edit', () => {
  it('records the edit and writes nothing', () => {
    parkAsPanel(TEX, { texture: { format: 'webp' } });

    expect(isMetaDirty(TEX)).toBe(true);
    expect(hasPendingMeta()).toBe(true);
    expect(getPendingMetaPaths()).toEqual([TEX]);
    expect(globalThis.fetch, 'the Inspector wrote to disk on a field change').not.toHaveBeenCalled();
  });

  it('last edit to a path wins', () => {
    parkAsPanel(TEX, { texture: { format: 'ktx2-uastc' } });
    parkAsPanel(TEX, { texture: { format: 'webp' } });

    expect(getPendingMetaPaths()).toEqual([TEX]);
    expect(peekPendingMeta(TEX)).toEqual(stampMetaReadPath({ texture: { format: 'webp' } }, TEX));
  });

  it('discard drops it without writing, and says what was not pending', () => {
    parkAsPanel(TEX, { texture: { format: 'webp' } });
    expect(discardPendingMeta([TEX, OTHER])).toEqual({ discarded: [TEX], notPending: [OTHER] });
    expect(hasPendingMeta()).toBe(false);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('the editor can SEE a pending meta edit', () => {
  it('hasUnsavedChanges() counts it, sceneDirty stays FALSE, and unsavedChangeCauses() names it', async () => {
    // ⚠️ Both the positive AND negative half matter. Without the first, Cmd+S has no reason to
    // run and a scene swap discards the edit with no refusal. Without the second — a mutant that
    // folds this cause into `sceneDirty` — a refusal driven by a pending import-setting edit
    // alone would misreport itself as LIVE-WORLD scene edits, sending the reader to undo
    // create_entity/duplicate_entity calls that never happened.
    const { hasUnsavedChanges, unsavedChangeCauses } =
      await import('../../packages/modoki/src/editor/scene/serialize');

    expect(unsavedChangeCauses().pendingImportSettings).toEqual([]);
    parkAsPanel(TEX, { texture: { format: 'webp' } });
    expect(hasUnsavedChanges()).toBe(true);
    const causes = unsavedChangeCauses();
    expect(causes.pendingImportSettings).toEqual([TEX]);
    expect(causes.sceneDirty).toBe(false);

    discardPendingMeta([TEX]);
    expect(unsavedChangeCauses().pendingImportSettings).toEqual([]);
  });
});

describe('flushing', () => {
  it('writes each pending path via /api/write-meta, then clears the registry', async () => {
    parkAsPanel(TEX, { texture: { format: 'webp' } });
    parkAsPanel(OTHER, { texture: { format: 'ktx2-uastc' } });

    const r = await flushPendingMeta();

    expect(r.saved.sort()).toEqual([TEX, OTHER].sort());
    expect(r.failed).toEqual([]);
    expect(bodies.map((b) => b.path).sort()).toEqual([TEX, OTHER].sort());
    expect(hasPendingMeta()).toBe(false);
    expect(getPendingMetaPaths()).toEqual([]);
  });

  it('is a no-op that issues nothing when there is nothing parked', async () => {
    expect(await flushPendingMeta()).toEqual({ saved: [], failed: [] });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('a FAILED flush RE-PARKS the entry, reports it in `failed`, and hasUnsavedChanges() stays true', async () => {
    reply = { status: 500, body: { ok: false, error: 'disk full' } };
    parkAsPanel(TEX, { texture: { format: 'webp' } });

    const r = await flushPendingMeta();

    const { hasUnsavedChanges } = await import('../../packages/modoki/src/editor/scene/serialize');
    expect(r.saved).toEqual([]);
    expect(r.failed).toEqual([{ path: TEX, error: expect.any(String) }]);
    expect(isMetaDirty(TEX), 'a failed flush must never look like a save').toBe(true);
    expect(peekPendingMeta(TEX)).toEqual(stampMetaReadPath({ texture: { format: 'webp' } }, TEX));
    expect(hasUnsavedChanges()).toBe(true);
  });

  it('one rejected write does not block the others', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
      n += 1;
      bodies.push(JSON.parse(init.body));
      return n === 1
        ? { ok: false, status: 500, text: async () => '', json: async () => ({ ok: false }) } as unknown as Response
        : { ok: true, status: 200, text: async () => '', json: async () => ({ ok: true }) } as unknown as Response;
    }));
    parkAsPanel(TEX, { texture: { format: 'webp' } });
    parkAsPanel(OTHER, { texture: { format: 'ktx2-uastc' } });

    const r = await flushPendingMeta();

    expect(r.saved).toHaveLength(1);
    expect(r.failed).toHaveLength(1);
    expect(getPendingMetaPaths()).toEqual([r.failed[0].path]);
  });

  it('does NOT re-park over an edit made while the flush was in flight', async () => {
    // Same rule `flushDirtyAssets`/`flushPendingBaseScenes` apply to their own re-parks: an edit
    // made during the save is on screen, is not on disk, and must not be replaced by the OLDER
    // value the flush was carrying.
    reply = { status: 500, body: { ok: false, error: 'boom' } };
    parkAsPanel(TEX, { texture: { format: 'webp' } });
    vi.stubGlobal('fetch', vi.fn(async () => {
      parkAsPanel(TEX, { texture: { format: 'ktx2-uastc' } }); // a newer edit lands mid-flush
      return { ok: false, status: 500, text: async () => '', json: async () => reply.body } as unknown as Response;
    }));

    await flushPendingMeta();

    expect(peekPendingMeta(TEX), 'the newer edit was clobbered by the failed flush\'s re-park')
      .toEqual(stampMetaReadPath({ texture: { format: 'ktx2-uastc' } }, TEX));
  });

  it('flushPendingMetaFor is a no-op when nothing is pending for that path', async () => {
    expect(await flushPendingMetaFor(TEX)).toEqual({ saved: [], failed: [] });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('flushPendingMetaFor AWAITS an in-flight full flush before it reads (or writes) the path', async () => {
    // ⚠️ The property the `inFlight` guard exists for. Without it, a re-import landing while a
    // Cmd+S is mid-write for the SAME path could fire a SECOND, unordered write for it — the
    // write this test proves happens second could actually land on the wire FIRST, and disk
    // would end up holding the OLDER value even though the newer one reports `saved`.
    const order: string[] = [];
    let releaseOld: (() => void) | null = null;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { meta: { v: string } };
      order.push(`start:${body.meta.v}`);
      if (body.meta.v === 'old') {
        await new Promise<void>((resolve) => { releaseOld = resolve; });
      }
      order.push(`end:${body.meta.v}`);
      return { ok: true, status: 200, text: async () => '', json: async () => ({ ok: true }) } as unknown as Response;
    }));

    parkAsPanel(TEX, { v: 'old' });
    const fullFlush = flushPendingMeta();
    // The full flush's write for `TEX` has already started synchronously (it is the first thing
    // reached down the await chain), and it is now blocked on `releaseOld`.
    expect(order).toEqual(['start:old']);

    parkAsPanel(TEX, { v: 'new' }); // a genuinely concurrent edit — unrelated to the batch above
    const forPromise = flushPendingMetaFor(TEX);
    // `flushPendingMetaFor` must be blocked on `inFlight`, not already reading `pending` — no
    // second write has been issued.
    expect(order).toEqual(['start:old']);

    releaseOld!();
    await fullFlush;
    const r = await forPromise;

    expect(order).toEqual(['start:old', 'end:old', 'start:new', 'end:new']);
    expect(r).toEqual({ saved: [TEX], failed: [] });
  });
});

describe('readMetaPreferringPark', () => {
  it('returns the parked doc without hitting the network when one is parked', async () => {
    parkAsPanel(TEX, { texture: { format: 'webp' } });

    const { meta, pendingRef } = await readMetaPreferringPark(TEX);

    expect(meta).toEqual(stampMetaReadPath({ texture: { format: 'webp' } }, TEX));
    expect(globalThis.fetch, 'a parked doc must be used in place of the network response').not.toHaveBeenCalled();
    // The whole mechanism `metaWrittenToDisk` keys on: this is the SAME reference `pending` holds,
    // not a structurally-equal copy — see that function's own doc for why identity is the check.
    expect(pendingRef).toBe(peekPendingMeta(TEX));
  });

  it('falls back to the GET when nothing is parked, and pendingRef is undefined', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      expect(url).toContain('/api/read-meta');
      expect(url).toContain(encodeURIComponent(TEX));
      return { ok: true, status: 200, json: async () => ({ texture: { format: 'ktx2-uastc' } }) } as unknown as Response;
    }));

    const { meta, pendingRef } = await readMetaPreferringPark(TEX);

    // ⚠️ Also the positive control for the READ STAMP (#891): a document off the network carries
    // the path it was read for, which is what makes the panel's next park acceptable at all.
    expect(meta).toEqual(stampMetaReadPath({ texture: { format: 'ktx2-uastc' } }, TEX));
    expect(pendingRef).toBeUndefined();
  });

  /** The body of a non-ok reply is never read — the fallback stands in for it. Since #880 that
   *  fallback is `metaReadFallback()` rather than a bare `{}`: string-key-identical (so every
   *  call site still merges onto an empty document), but tagged, so a park or wholesale write
   *  built on it is refused. Both halves are asserted — the second is the one a `toEqual({})`
   *  would silently stop pinning if the tag were dropped. */
  it('a non-ok GET resolves to the TAGGED empty fallback, not a bare {}', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      ({ ok: false, status: 404, json: async () => ({ should: 'not be read' }) } as unknown as Response)));

    const { meta } = await readMetaPreferringPark(TEX);

    expect(meta).toEqual(metaReadFallback());
    expect(meta, 'the tag is the guard — a bare {} would park an id-less document').not.toEqual({});
    expect(Object.keys(meta), 'and it is still empty to every string-key consumer').toEqual([]);
  });
});

describe('metaWrittenToDisk — the read-then-write-back race the parking itself opened (#845 close-out)', () => {
  // The shape every immediate full-document writer (NineSliceEditor/SpriteEditor's Save,
  // modelImport.ts's id/generated merge) follows: read preferring the park, merge, write the
  // WHOLE doc back, then report the write so the park it already incorporated can be dropped.

  it('race A: a write built on the park it read drops that park, and a later flush writes nothing stale', async () => {
    parkAsPanel(TEX, { texture: { format: 'webp' } });

    const { meta, pendingRef } = await readMetaPreferringPark(TEX);
    expect(meta).toEqual(stampMetaReadPath({ texture: { format: 'webp' } }, TEX)); // the write below is built on this

    const dropped = metaWrittenToDisk(TEX, pendingRef);

    expect(dropped).toBe(true);
    expect(hasPendingMeta()).toBe(false);
    expect(peekPendingMeta(TEX)).toBeUndefined();
    // Nothing left to overwrite the write that already landed.
    expect(await flushPendingMeta()).toEqual({ saved: [], failed: [] });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('race B: a NEWER park landing before the write completes survives, and the flush writes IT, not the older read', async () => {
    parkAsPanel(TEX, { texture: { format: 'webp' } });
    const { pendingRef } = await readMetaPreferringPark(TEX);

    // The Inspector edits the SAME path again while the writer that just read `pendingRef` is
    // still mid-write (e.g. still inside `writeMetaOrWarn`'s network round trip).
    parkAsPanel(TEX, { texture: { format: 'ktx2-uastc' } });

    const dropped = metaWrittenToDisk(TEX, pendingRef);

    expect(dropped, 'a newer edit must never be dropped by an older write\'s bookkeeping').toBe(false);
    expect(peekPendingMeta(TEX)).toEqual(stampMetaReadPath({ texture: { format: 'ktx2-uastc' } }, TEX));

    const r = await flushPendingMeta();
    expect(r).toEqual({ saved: [TEX], failed: [] });
    expect(bodies.find((b) => b.path === TEX)?.meta).toEqual({ texture: { format: 'ktx2-uastc' } });
  });

  it('is a no-op when nothing was ever parked for the path', () => {
    expect(peekPendingMeta(TEX)).toBeUndefined();
    expect(metaWrittenToDisk(TEX, undefined)).toBe(false);
  });

  it('refuses to drop a park that appeared AFTER a read that saw none', () => {
    // pendingRef undefined = the read fell through to disk; a park then lands strictly after —
    // same rule as race B, at the OTHER boundary (no park at read time, one now).
    parkAsPanel(TEX, { texture: { format: 'webp' } });

    expect(metaWrittenToDisk(TEX, undefined)).toBe(false);
    expect(peekPendingMeta(TEX)).toEqual(stampMetaReadPath({ texture: { format: 'webp' } }, TEX));
  });

  it('does not drop a DIFFERENT path\'s park', async () => {
    parkAsPanel(TEX, { texture: { format: 'webp' } });
    parkAsPanel(OTHER, { texture: { format: 'ktx2-uastc' } });
    const { pendingRef } = await readMetaPreferringPark(TEX);

    expect(metaWrittenToDisk(OTHER, pendingRef)).toBe(false);
    expect(peekPendingMeta(TEX)).toEqual(stampMetaReadPath({ texture: { format: 'webp' } }, TEX));
    expect(peekPendingMeta(OTHER)).toEqual(stampMetaReadPath({ texture: { format: 'ktx2-uastc' } }, OTHER));
  });

  /** ⚠️ The identity stamp must survive a caller that RE-PARKS THE SAME OBJECT it mutated in
   *  place, not only the eighteen call sites that happen to spread a fresh literal today.
   *
   *  This is the nineteenth-call-site case, and it is the one shape that defeats reference
   *  equality: park `doc`, read it, mutate `doc`, park `doc` AGAIN. Both parks are the same
   *  reference, so `pending.get(path) === pendingRef` matches a park that is genuinely NEWER
   *  than the read, `metaWrittenToDisk` drops it, and the second edit is silently lost — the
   *  exact clobber this whole mechanism exists to close, reached through the mechanism closing
   *  it. `parkMetaEdit` copying what it is handed is what makes this impossible to write.
   *
   *  Without that copy this test fails; the prose invariant it replaced could not fail at all.
   *
   *  ⚠️ **It must NOT go through `parkAsPanel`, and that is the whole subtlety.** That helper calls
   *  `stampMetaReadPath`, which returns a COPY — so each park would already receive a fresh object
   *  and the identity stamp would differ whether or not `parkMetaEdit` copies. Migrating this one
   *  test with the other 63 disarmed it: measured, the `pending.set(path, meta)` mutation went from
   *  turning exactly this test red to turning NOTHING red across 2347 tests. So the document is
   *  stamped ONCE, up front, and the same reference is parked twice — which is also what the real
   *  nineteenth call site would look like. */
  it('survives a caller that re-parks the SAME object mutated in place', async () => {
    const doc: Record<string, unknown> = stampMetaReadPath({ texture: { format: 'webp' } }, TEX);
    parkMetaEdit(TEX, doc);
    const { pendingRef } = await readMetaPreferringPark(TEX);

    // The nineteenth call site, written the obvious wrong way.
    doc.texture = { format: 'ktx2-uastc' };
    parkMetaEdit(TEX, doc);

    // The second park is NEWER than the read, so the write that read the first must not drop it.
    expect(metaWrittenToDisk(TEX, pendingRef)).toBe(false);
    expect(peekPendingMeta(TEX)).toEqual(stampMetaReadPath({ texture: { format: 'ktx2-uastc' } }, TEX));
    expect(hasPendingMeta()).toBe(true);
  });
});


/** #845 phase 2 — the `ifMatch` precondition on `/api/write-meta`.
 *
 *  Parking bought the human a manual save; it also bought a window in which the file can change
 *  underneath a pending edit. Before this, the flush overwrote whatever it found. The issue's
 *  fourth "what a fix has to prove" bullet is exactly this, and it is the one the phase-1 commits
 *  deliberately did not meet.
 *
 *  ⚠️ The baseline is the SERVER's hash, never one computed here — `/api/read-meta` returns the
 *  merged view and `writeMetaSidecar` transforms what it writes, so the two ends can only agree by
 *  the server hashing the file. These tests therefore drive the header/reply, not a local digest. */
describe('ifMatch — an external change is refused, not clobbered (#845 phase 2)', () => {
  /** Re-stub with a headers-capable Response; the shared mock above predates the header. */
  function stubWithHeader(sha: string | null, writeReply?: { status: number; body: unknown }) {
    const sent: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
      if (String(url).includes('/api/read-meta')) {
        return {
          ok: true, status: 200,
          headers: { get: (k: string) => (k.toLowerCase() === 'x-meta-sha256' ? sha : null) },
          text: async () => '', json: async () => ({ texture: { format: 'png' } }),
        } as unknown as Response;
      }
      sent.push(JSON.parse(init?.body ?? '{}'));
      const rep = writeReply ?? { status: 200, body: { ok: true, sha256: 'AFTER' } };
      return {
        ok: rep.status < 400, status: rep.status,
        headers: { get: () => null },
        text: async () => '', json: async () => rep.body,
      } as unknown as Response;
    }));
    return sent;
  }

  it('records the baseline the server vouched for, and sends it as the write precondition', async () => {
    const sent = stubWithHeader('BEFORE');
    await readMetaPreferringPark(TEX);
    expect(peekMetaBaseline(TEX)).toBe('BEFORE');

    parkAsPanel(TEX, { texture: { format: 'webp' } });
    await flushPendingMeta();

    expect(sent).toHaveLength(1);
    expect(sent[0].ifMatch).toBe('BEFORE');
  });

  /** The ACCEPT side. A guard proving it refuses a stale write never proves it lets a legitimate
   *  one through — and an absent baseline must stay UNCONDITIONAL, because "we never read this
   *  file" is not the same claim as "this file is unchanged". */
  it('sends NO ifMatch when this editor has never read the file', async () => {
    const sent = stubWithHeader('BEFORE');
    parkAsPanel(TEX, { texture: { format: 'webp' } });   // parked with no prior read
    await flushPendingMeta();

    expect(sent).toHaveLength(1);
    expect('ifMatch' in sent[0]).toBe(false);
  });

  it('a 409 keeps the edit PARKED and names the conflict, rather than losing it', async () => {
    stubWithHeader('BEFORE', { status: 409, body: { ok: false, conflict: true, reason: 'if-match' } });
    await readMetaPreferringPark(TEX);
    parkAsPanel(TEX, { texture: { format: 'webp' } });

    const r = await flushPendingMeta();

    expect(r.saved).toEqual([]);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].path).toBe(TEX);
    expect(r.failed[0].error).toMatch(/changed on disk/);
    // The whole point: the human's edit survives a refusal.
    expect(hasPendingMeta()).toBe(true);
    expect(peekPendingMeta(TEX)).toEqual(stampMetaReadPath({ texture: { format: 'webp' } }, TEX));
  });

  /** ⚠️ The regression this advance exists to stop: WE wrote the file, so a panel still mounted on
   *  it holds a baseline that our own flush invalidated. Without advancing it, the very next save
   *  409s under "the file changed on disk" when nothing external ever touched it — a false alarm
   *  produced entirely by the guard. */
  it('advances the baseline to what the server wrote, so a second save does not conflict with itself', async () => {
    const sent = stubWithHeader('BEFORE');
    await readMetaPreferringPark(TEX);
    parkAsPanel(TEX, { texture: { format: 'webp' } });
    await flushPendingMeta();
    expect(peekMetaBaseline(TEX)).toBe('AFTER');

    parkAsPanel(TEX, { texture: { format: 'ktx2-uastc' } });
    await flushPendingMeta();

    expect(sent).toHaveLength(2);
    expect(sent[1].ifMatch).toBe('AFTER');
  });

  /** ⚠️ `res.ok` means the write LANDED, and nothing about reading the baseline out of the reply
   *  may downgrade that. Caught for real by `writeMetaSequencing.test.ts`, whose mock Response has
   *  no `json` method: the `res.json()` added for `sha256` threw, fell through to the outer catch,
   *  and reported a write that had already reached disk as a FAILURE — which re-parks the entry,
   *  tells the human their save failed, and makes the retry 409 against the file this very call
   *  just advanced. Losing the baseline is the correct and only cost. */
  it('a reply with no readable body still counts as SAVED, just without a new baseline', async () => {
    // No prior read, so no baseline — which is also what makes the assertion below meaningful.
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, headers: { get: () => null },
      text: async () => '',
      // No `json` at all — an older backend, a proxy that strips the body, a non-JSON 200.
    } as unknown as Response)));
    parkAsPanel(TEX, { texture: { format: 'webp' } });

    const r = await flushPendingMeta();

    expect(r.saved, 'a landed write reported as failed').toEqual([TEX]);
    expect(r.failed).toEqual([]);
    expect(hasPendingMeta(), 'a successful write must not stay parked').toBe(false);
    expect(peekMetaBaseline(TEX)).toBeUndefined();
  });

  /** ⚠️ THE WEDGE. `readMetaPreferringPark` returns early whenever a park exists, so it never
   *  re-reads the file and never refreshes the baseline — and `baselines` is written in only two
   *  places, an ok GET and a successful write. So before this, one 409 meant EVERY later save for
   *  that path 409'd too: `hasUnsavedChanges()` stayed true forever, and with it every refusal it
   *  drives (modoki_build, load_scene, the file-direct scene-mutate, the reload countdown). The
   *  toast told the human to reopen the asset, which cannot help — reopening hits the same early
   *  return. Restarting the editor was the only exit, and it discards the edit.
   *
   *  Dropping the baseline on a refusal makes the SECOND save unconditional, which is the intended
   *  semantic: one refusal is a warning naming the path, and an explicit re-save is the human
   *  choosing to overwrite. */
  it('a 409 does not wedge the path — the next save is unconditional and lands', async () => {
    const sent = stubWithHeader('BEFORE', { status: 409, body: { ok: false, conflict: true } });
    await readMetaPreferringPark(TEX);
    parkAsPanel(TEX, { texture: { format: 'webp' } });

    const first = await flushPendingMeta();
    expect(first.failed).toHaveLength(1);
    expect(peekMetaBaseline(TEX), 'a stale baseline with no path back is the wedge').toBeUndefined();

    // The retry: the entry is still parked, and now nothing refuses it.
    const sent2 = stubWithHeader('IGNORED');
    const second = await flushPendingMeta();

    expect(second.saved).toEqual([TEX]);
    expect(second.failed).toEqual([]);
    expect('ifMatch' in sent2[0], 'the retry must not carry the baseline that just failed').toBe(false);
    expect(hasPendingMeta()).toBe(false);
    void sent;
  });

  /** ⚠️ The per-path flush must NOT drop the baseline, precisely because its result goes nowhere.
   *
   *  The batch flush drops it on a 409 because that refusal is REPORTED — `toastForSave` names the
   *  path — so the next explicit Cmd+S is the human choosing to overwrite. All EIGHT callers of
   *  `flushPendingMetaFor` discard its result (bare `await`), so a conflict there reaches no UI at
   *  all. Dropping the baseline would disarm the compare-and-swap silently, and the next save would
   *  overwrite the external change and report success — worse than the wedge, with nobody told.
   *
   *  The wedge stays closed because both read the same map: the path is still parked, and the next
   *  Cmd+S conflicts ONCE through the batch flush, which does tell the human, and drops it there. */
  it('flushPendingMetaFor KEEPS the baseline on a conflict — its result reaches no UI', async () => {
    stubWithHeader('BEFORE', { status: 409, body: { ok: false, conflict: true } });
    await readMetaPreferringPark(TEX);
    parkAsPanel(TEX, { texture: { format: 'webp' } });

    const r = await flushPendingMetaFor(TEX);

    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].conflict, 'the conflict must be structured, not grepped out of the prose').toBe(true);
    expect(peekMetaBaseline(TEX), 'a silent drop here disarms the CAS with nobody told').toBe('BEFORE');
    expect(hasPendingMeta(), 'and the edit must survive').toBe(true);
  });

  /** The batch flush's drop is the one that IS reported, so it keeps its drop — and marks the
   *  failure as a conflict so `toastForSave` can say the retry will overwrite rather than wording
   *  it like a retryable blip. */
  it('flushPendingMeta marks a 409 as a CONFLICT, distinguishably from a plain failure', async () => {
    stubWithHeader('BEFORE', { status: 409, body: { ok: false, conflict: true } });
    await readMetaPreferringPark(TEX);
    parkAsPanel(TEX, { texture: { format: 'webp' } });

    const conflicted = await flushPendingMeta();
    expect(conflicted.failed[0].conflict).toBe(true);

    // A plain 500 must NOT be marked — the two have opposite remedies.
    clearPendingMeta(); clearMetaBaselines();
    stubWithHeader('BEFORE', { status: 500, body: { ok: false } });
    await readMetaPreferringPark(TEX);
    parkAsPanel(TEX, { texture: { format: 'webp' } });

    const failed = await flushPendingMeta();
    expect(failed.failed[0].conflict).toBeUndefined();
  });

  /** ⚠️ The id-loss guard, at the level that actually covers it. `/api/write-meta` replaces the
   *  sidecar wholesale, so a park built while the panel shows defaults from a FAILED read writes an
   *  id-less document — and the scanner then mints a fresh GUID, dangling every reference. The two
   *  modal editors refuse to save; the eight ASSET VIEWS need no modal at all, which makes an
   *  ordinary field change the common route to it. Guarding in the registry covers all of them,
   *  and the ninth view somebody adds tomorrow. */
  /** ⚠️ The park payload SPREADS the read, because that is what the panel does and what
   *  `metaMergeNotClobber.test.ts` requires of every one of the 18 park sites — a bare literal
   *  here would be testing a shape the guard forbids anyway. Since #880 that spread is also what
   *  carries the refusal: the fallback is tagged, the tag rides the spread, and the tagged
   *  document is what `parkMetaEdit` refuses. */
  it('refuses to park after a FAILED read — an id-less wholesale write costs the asset its GUID', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 500, headers: { get: () => null }, text: async () => '', json: async () => ({}),
    } as unknown as Response)));
    const { meta } = await readMetaPreferringPark(TEX);
    expect(meta, 'the fallback the panel would spread').toEqual(metaReadFallback());
    expect(meta, 'and it is NOT a bare {} — the tag is the whole guard (#880)').not.toEqual({});

    parkMetaEdit(TEX, { ...meta, texture: { format: 'webp' } });   // the panel's field change

    expect(hasPendingMeta(), 'parking this is how the GUID gets destroyed').toBe(false);
  });

  it('parks again once a later read SUCCEEDS — a dev-server blip is transient', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 500, headers: { get: () => null }, text: async () => '', json: async () => ({}),
    } as unknown as Response)));
    const failed = await readMetaPreferringPark(TEX);
    parkMetaEdit(TEX, { ...failed.meta, texture: { format: 'webp' } });
    expect(hasPendingMeta()).toBe(false);

    stubWithHeader('AFTER-RECOVERY');
    const ok = await readMetaPreferringPark(TEX);
    parkMetaEdit(TEX, { ...ok.meta, texture: { format: 'webp' } });

    expect(hasPendingMeta(), 'the refusal must not be permanent').toBe(true);
  });

  it('discarding a park forgets its baseline too', async () => {
    stubWithHeader('BEFORE');
    await readMetaPreferringPark(TEX);
    parkAsPanel(TEX, { texture: { format: 'webp' } });

    discardPendingMeta([TEX]);

    expect(peekMetaBaseline(TEX)).toBeUndefined();
  });

  /** A failed read must not ERASE a baseline an earlier successful read established — that would
   *  silently turn the next write unconditional at exactly the moment the editor is least sure
   *  what is on disk. */
  it('a non-ok read leaves an existing baseline intact', async () => {
    stubWithHeader('BEFORE');
    await readMetaPreferringPark(TEX);
    expect(peekMetaBaseline(TEX)).toBe('BEFORE');

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 404, headers: { get: () => null },
      text: async () => '', json: async () => ({}),
    } as unknown as Response)));
    await readMetaPreferringPark(TEX);

    expect(peekMetaBaseline(TEX)).toBe('BEFORE');
  });
});


/** #871 — a reader EXEMPT from `readMetaPreferringPark` still owes the CAS baseline.
 *
 *  `VideoAssetView` is a declared exemption in `metaReadPreferringPark.test.ts`, for a reason that
 *  is true and still correct: it keeps a third piece of state (`applied`) that must reflect DISK,
 *  so it cannot use a helper that skips the network call whenever a park exists. That reason
 *  vouches for WHICH DOCUMENT THE PANEL DISPLAYS and for nothing else — and it was read as
 *  vouching for the file generally. Because its raw fetch dropped the `X-Meta-Sha256` header,
 *  `baselines` never had an entry for any `.mp4`, `flushPendingMetaFor` passed `undefined` as
 *  `ifMatch`, and `ifMatchRefusal` reads an absent `ifMatch` as *proceed*. So #845 phase 2's
 *  precondition was INERT for that entire asset type, while looking present everywhere else — a
 *  guard that silently does not run, which is why the issue carries `family/fail-open-guard`.
 *
 *  These drive `noteMetaReadResult` directly rather than mounting the panel: editor `.tsx`
 *  carries no tests by repo policy (`docs/editor.md` § Panels), and the panel's own wiring —
 *  that it calls this at all — is asserted structurally by `metaReadPreferringPark.test.ts`. */
describe('an exempted raw reader still records the baseline (#871)', () => {
  /** The two fields `noteMetaReadResult` reads, shaped like the raw `backendFetch` reply the
   *  video panel actually holds. */
  const res = (ok: boolean, sha: string | null) => ({
    ok, headers: { get: (k: string) => (k.toLowerCase() === 'x-meta-sha256' ? sha : null) },
  });

  /** Captures what the flush POSTs, with no `/api/read-meta` arm at all — the point of this
   *  describe is the path that never calls the helper. */
  function stubWrite(reply: { status: number; body: unknown } = { status: 200, body: { ok: true, sha256: 'AFTER' } }) {
    const sent: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { body?: string }) => {
      sent.push(JSON.parse(init?.body ?? '{}'));
      return {
        ok: reply.status < 400, status: reply.status,
        headers: { get: () => null }, text: async () => '', json: async () => reply.body,
      } as unknown as Response;
    }));
    return sent;
  }

  it('seeds the baseline from the header, so the deferred flush is CONDITIONAL', async () => {
    noteMetaReadResult(VID, res(true, 'DISK-V1'));
    expect(peekMetaBaseline(VID)).toBe('DISK-V1');

    // The panel parks with two args — it has no baseline of its own to hand over, and does not
    // need one: the flush reads `baselines` directly.
    const sent = stubWrite();
    parkAsPanel(VID, { video: { crf: 23 } });
    await flushPendingMetaFor(VID);

    expect(sent).toHaveLength(1);
    expect(sent[0].ifMatch, 'the #845 precondition is inert for .mp4 without this').toBe('DISK-V1');
  });

  /** ⚠️ The ACCEPT side's twin, and the half a "does it refuse?" test cannot reach: the whole
   *  point of seeding is that a write the server ACCEPTS still advances normally afterwards. */
  it('the reply advances that baseline, so the second save does not conflict with itself', async () => {
    noteMetaReadResult(VID, res(true, 'DISK-V1'));
    const sent = stubWrite();

    parkAsPanel(VID, { video: { crf: 23 } });
    await flushPendingMetaFor(VID);
    parkAsPanel(VID, { video: { crf: 28 } });
    await flushPendingMetaFor(VID);

    expect(sent).toHaveLength(2);
    // ⚠️ BOTH sends are asserted on purpose. Checking only the second passes even with the seeding
    // deleted — the flush's own `baselines.set(path, r.sha256)` supplies 'AFTER' regardless, so
    // that assertion tests #845's advance and says nothing about #871. The FIRST send is the one
    // that can only be 'DISK-V1' because the exempted read recorded it. (Caught by mutation-
    // checking this test: without this line it stayed green with `noteMetaReadResult` a no-op.)
    expect(sent[0].ifMatch).toBe('DISK-V1');
    expect(sent[1].ifMatch).toBe('AFTER');
  });

  /** A missing header means NO BASELINE, never "unchanged" — the route omits it for a `null`
   *  sidecar, and an unconditional write is the correct reading of "we have no idea what is on
   *  disk". Getting this backwards would 409 every first write on a fresh sidecar. */
  it('records nothing when the response carries no header', async () => {
    noteMetaReadResult(VID, res(true, null));
    expect(peekMetaBaseline(VID)).toBeUndefined();

    const sent = stubWrite();
    parkAsPanel(VID, { video: { crf: 23 } });
    await flushPendingMetaFor(VID);

    expect('ifMatch' in sent[0]).toBe(false);
  });

  /** Same rule as the helper's own: a failed read must not ERASE a baseline an earlier successful
   *  one established, or the next write goes unconditional exactly when the editor is least sure. */
  it('a non-ok response leaves an existing baseline intact', () => {
    noteMetaReadResult(VID, res(true, 'DISK-V1'));
    noteMetaReadResult(VID, res(false, 'IGNORED'));
    expect(peekMetaBaseline(VID)).toBe('DISK-V1');
  });

  /** ⚠️ THE HALF THE MERGE WITH `dfe8ce441` REVEALED, and the reason this helper is named for the
   *  RESPONSE rather than for the baseline.
   *
   *  That commit added the `readFailed` guard — a failed GET must block a later park, because the
   *  panel is then showing its own defaults with no `id`, and a wholesale write of that document
   *  makes the scanner mint a fresh GUID and dangles every reference to the asset. It added it
   *  INSIDE the block this helper had already extracted. Taking only the baseline half would have
   *  left the exempted video reader recording a baseline and NOT the failure — #871's exact trap
   *  a second time, one field down, on the one asset type with no other reader.
   *
   *  This is the accept-side pair: a document built on the failed read must be REFUSED, and one
   *  built on a successful read must still park (a dev-server blip is transient).
   *
   *  ⚠️ **#880 moved WHERE that is carried, and the exempted reader is the reason it matters.**
   *  It used to be a path-keyed flag this helper armed; it is now a tag on the fallback DOCUMENT,
   *  which is why the video panel's `metaReadFallback()` — not a bare `{}` — is the thing under
   *  test here. Same trap as the baseline, one field along: an exemption from the read HELPER is
   *  not an exemption from what a failed read MEANS, and the guard is inert for `.mp4` (the one
   *  type with no other reader) the moment this file hands back an untagged `{}`.
   *  `metaReadPreferringPark.test.ts`'s `fallback: 'tags'` rule is the source-level half of this. */
  it('a document built on the raw reader\'s FALLBACK is refused; one built on a real read parks', () => {
    noteMetaReadResult(VID, res(false, null));
    parkMetaEdit(VID, { ...metaReadFallback(), video: { crf: 23 } });
    expect(
      isMetaDirty(VID),
      'a park built on the {} fallback would write an id-less sidecar and orphan the asset',
    ).toBe(false);

    noteMetaReadResult(VID, res(true, 'DISK-V1'));
    parkAsPanel(VID, { id: 'g', video: { crf: 23 } });
    expect(isMetaDirty(VID), 'a transient blip must not refuse this path forever').toBe(true);
  });
});


/** #874 — an EXPLICIT-ACTION wholesale write must not leave the baseline it invalidated.
 *
 *  The other half of #871's original one-sentence mechanism (*"stale where a write must not trust
 *  it"*). That half was filed against a project switch and refuted — the renderer hard-reloads, so
 *  nothing survives one. This is its real trigger: a SIBLING WRITE inside a single session.
 *
 *  Make-2D, a 9-slice/Sprite Save, a model import and the collision-mesh write all replace the
 *  sidecar wholesale while a panel is mounted on the same path holding a baseline from its own
 *  load. Leaving that baseline makes the human's very next Cmd+S 409 under "the .meta.json changed
 *  on disk since this edit was based on it" — true of the file and a lie about the cause, because
 *  THIS EDITOR changed it. #844's class exactly, and the refusal's advice ("reopen the asset")
 *  is not something the human knows to do.
 *
 *  These drive the registry against a server stub that actually enforces `ifMatch`, so the
 *  assertion is the observable outcome (refused vs saved) rather than the argument value. */
/** Who is allowed to MOVE the baseline (#871/#872 review).
 *
 *  A baseline is a claim about the bytes the PANEL'S DISPLAYED DOCUMENT came from, and the flush
 *  conditions the human's next save on it. So only a read that actually feeds a panel may move it.
 *  Two readers looked like they qualified and did not, and both were introduced by the very fixes
 *  meant to close #871/#872 — an observer disarming the guard it observes.
 *
 *  ⚠️ Both cases are stated as the OBSERVABLE OUTCOME — was the flush refused? — rather than as a
 *  baseline value, because that is what the human experiences and it cannot be satisfied by the
 *  map merely holding some string. */
describe('only a read that feeds a panel may move the baseline', () => {
  /** Disk starts at V1 and can be rewritten out from under the editor; a PRESENT `ifMatch` that
   *  misses is refused, exactly as `ifMatchRefusal` does. */
  function stubDisk() {
    const disk = { sha: 'V1', doc: { id: 'g', texture: { maxSize: 256 } } as Record<string, unknown> };
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
      if (String(url).includes('/api/read-meta')) {
        return {
          ok: true, status: 200,
          headers: { get: (k: string) => (k.toLowerCase() === 'x-meta-sha256' ? disk.sha : null) },
          text: async () => '', json: async () => disk.doc,
        } as unknown as Response;
      }
      const body = JSON.parse(init?.body ?? '{}');
      if (body.ifMatch !== undefined && body.ifMatch !== disk.sha) {
        return {
          ok: false, status: 409, headers: { get: () => null },
          text: async () => '', json: async () => ({ ok: false, conflict: true }),
        } as unknown as Response;
      }
      disk.sha = 'W';
      return {
        ok: true, status: 200, headers: { get: () => null },
        text: async () => '', json: async () => ({ ok: true, sha256: disk.sha }),
      } as unknown as Response;
    }));
    return disk;
  }

  /** #871 review — the EXEMPTED reader must not re-seed while a park is live.
   *
   *  `readMetaPreferringPark` gets this free: it early-returns on a park and never reaches the
   *  network. An exempted reader DOES reach it — that is what the exemption is for — so an
   *  unconditional `noteMetaReadResult` re-seeds on every remount. The parked document was built
   *  from the OLD bytes, so advancing the baseline to what disk holds now makes `ifMatch` a claim
   *  that document cannot support, and the flush overwrites the external change instead of
   *  refusing it. `.mp4` would have stayed the one type where the guard can be talked out of
   *  firing — the same asset type #871 was about. */
  it('an exempted re-read while a park is live does NOT advance it — the flush still refuses', async () => {
    const disk = stubDisk();
    // The video panel's mount read.
    noteMetaReadResult(VID, { ok: true, headers: { get: () => disk.sha } });
    parkAsPanel(VID, { id: 'g', video: { crf: 23 } });

    disk.sha = 'EXTERNAL';                       // something rewrites the sidecar
    // The panel remounts (asset reselected) and reads raw again — the exemption's whole point.
    noteMetaReadResult(VID, { ok: true, headers: { get: () => disk.sha } });

    const r = await flushPendingMeta();

    expect(r.saved, 'the external change was CLOBBERED by a park built on older bytes').toEqual([]);
    expect(r.failed).toHaveLength(1);
    expect(peekPendingMeta(VID), 'and the human keeps their edit').toBeDefined();
  });

  /** #872 review — an AGENT read is passive and must move nothing.
   *
   *  Before #872 `modoki_get_asset_meta` ran in the Node process and could not touch this map at
   *  all; routing it through the renderer to see parked edits gave it that power as a side effect.
   *  It feeds no panel, so a baseline it advances describes a document nobody is holding. */
  it('a PASSIVE read moves nothing, so an agent cannot disarm the panel guard', async () => {
    const disk = stubDisk();
    await readMetaPreferringPark(TEX);           // the panel's own read → baseline V1
    disk.sha = 'EXTERNAL';                       // something rewrites the sidecar

    const agent = await readMetaPreferringPark(TEX, { passive: true });
    expect(agent.ok, 'the agent still gets a real answer').toBe(true);

    // The human's edit, built on the doc the panel is still showing.
    parkAsPanel(TEX, { id: 'g', texture: { maxSize: 1024 } });
    const r = await flushPendingMeta();

    expect(r.saved, 'the agent read let the human overwrite an external change').toEqual([]);
    expect(r.failed).toHaveLength(1);
  });

  /** The ACCEPT side of the same rule: a NON-passive read by the panel still seeds normally, or
   *  the fix above would have disarmed #871 in the other direction. */
  it('a normal (non-passive) read still records the baseline', async () => {
    stubDisk();
    await readMetaPreferringPark(TEX);
    expect(peekMetaBaseline(TEX)).toBe('V1');
  });
});

/** The guard against an id-less wholesale write, keyed on the DOCUMENT (#845, #871, #880).
 *
 *  Split out of the baseline describe: this is about the read-failed refusal, not about
 *  `baselines`. Every half is pinned separately, because reverting any one of them alone left
 *  every other test in this file green.
 *
 *  ⚠️ **#880 rewrote what the guard is keyed on, and these tests are the reason it had to be.**
 *  It was a `Set<string>` of paths whose last read failed, and a path cannot answer the question
 *  the guard asks — *"is the document about to be written the `{}` fallback?"* belongs to one
 *  COMPONENT. Two components do read one path on mount (`Inspector`'s postprocessor row and
 *  `ModelAssetView`, both on the model's path), and the path-keyed version failed in both
 *  directions at once: either one's ok read CLEARED the flag the other still needed, and while a
 *  park was live nothing could clear it at all. So the fallback document is tagged instead, the
 *  tag rides the spread every park site already makes, and the tagged document is what is
 *  refused.
 *
 *  ⚠️ Every park payload below SPREADS its own read, because that is what all 18 park sites do —
 *  and that spread is what carries the tag. ⚠️ It is what they DO, not what anything enforces:
 *  `metaMergeNotClobber.test.ts`'s rule accepts a `...` anywhere (a nested one passes with a fresh
 *  top-level object) and accepts a literal `id:` with no spread at all, so it narrows the space a
 *  19th site can occupy without closing it. The residual is stated on `FROM_FAILED_READ`.
 *  ⚠️ Since #891 that residual is closed on the PARK route — a site that does not spread carries no
 *  READ_FOR_PATH stamp either, and `parkMetaEdit` refuses it (see the `#890/#891/#897` block at the
 *  bottom of this file). It remains open on the wholesale-write route, on purpose. */
describe('the read-failed refusal is keyed on the DOCUMENT (#845/#871/#880)', () => {
  /** What `/api/read-meta` answers next. Mutated per test rather than re-stubbed, because the
   *  scenario that matters is TWO reads of one path with different outcomes. */
  let readReply: { ok: boolean; body: unknown; sha: string | null };
  /** Every `/api/write-meta` POST body — `[]` is how a test proves a refusal never left. */
  let writes: Array<{ path: string; meta: unknown }>;

  beforeEach(() => {
    readReply = { ok: true, body: {}, sha: null };
    writes = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
      if (String(url).includes('/api/read-meta')) {
        return {
          ok: readReply.ok, status: readReply.ok ? 200 : 500,
          headers: { get: (k: string) => (k.toLowerCase() === 'x-meta-sha256' ? readReply.sha : null) },
          text: async () => '', json: async () => readReply.body,
        } as unknown as Response;
      }
      writes.push(JSON.parse(init?.body ?? '{}'));
      return {
        ok: true, status: 200, headers: { get: () => null },
        text: async () => '', json: async () => ({ ok: true, sha256: 'AFTER' }),
      } as unknown as Response;
    }));
  });

  const failRead = () => { readReply = { ok: false, body: {}, sha: null }; };
  const okRead = () => { readReply = { ok: true, body: { id: 'GUID-1' }, sha: 'DISK-V1' }; };

  /** Two components, one path, the 500 FIRST. This is the interleaving the path-keyed flag did
   *  close — it armed on A's failure, and B's success then cleared it, so A's next field change
   *  parked a document with no `id`. */
  it("A's failed read still refuses A, after B reads the same path successfully", async () => {
    failRead();
    const a = await readMetaPreferringPark(TEX);          // component A: 500 -> the {} fallback
    expect(a.meta, 'the fallback, tagged').toEqual(metaReadFallback());

    okRead();
    const b = await readMetaPreferringPark(TEX);          // component B: 200 -> the real document
    expect(b.meta, 'positive control: B really did read the file')
      .toEqual(stampMetaReadPath({ id: 'GUID-1' }, TEX));

    parkMetaEdit(TEX, { ...a.meta, model: { lodCount: 2 } });   // A's next field change

    expect(
      peekPendingMeta(TEX),
      "B's successful read must not vouch for the document A is holding",
    ).toBeUndefined();
  });

  /** The SAME scenario with the responses reversed — the half still open after #871, and the one
   *  that makes this a keying bug rather than an ordering bug. The path-keyed flag accepted this
   *  order exactly as it accepted the other; it was never about order. */
  it("...and in the reverse order — B reads successfully first, then A's read fails", async () => {
    okRead();
    const b = await readMetaPreferringPark(TEX);          // component B: 200, first

    failRead();
    const a = await readMetaPreferringPark(TEX);          // component A: 500, second

    parkMetaEdit(TEX, { ...a.meta, model: { lodCount: 2 } });
    expect(peekPendingMeta(TEX), 'the order was never what made this safe').toBeUndefined();

    parkMetaEdit(TEX, { ...b.meta, model: { lodCount: 3 } });
    expect(peekPendingMeta(TEX), "and B's own document is untouched by A's failure")
      .toEqual(stampMetaReadPath({ id: 'GUID-1', model: { lodCount: 3 } }, TEX));
  });

  /** ⚠️ THE ACCEPT SIDE, and the face of #880 that made the old guard actively harmful: the panel
   *  it punished was the one whose read had SUCCEEDED.
   *
   *  Under the path-keyed flag A's failure armed the PATH — and `readMetaPreferringPark` returns
   *  early on a park and never reaches the network, so nothing could clear it. B's next
   *  postprocessor change was then refused with `Inspector.tsx:1487` having already moved the
   *  dropdown and advanced `metaRef.current`: the control moved, no dirty badge appeared, and the
   *  edit was dropped with only a `console.error`. Recovery was Cmd+S, then reselect.
   *
   *  There is no armed path state left to wedge, so B simply keeps working — TWICE, which is the
   *  part one park cannot show: the second edit is the one the wedge ate, because by then a park
   *  is live for the path and no read can reach the network to clear anything. */
  it("the component whose read SUCCEEDED keeps parking while another's read has failed", async () => {
    okRead();
    const b = await readMetaPreferringPark(TEX);

    failRead();
    const a = await readMetaPreferringPark(TEX);
    parkMetaEdit(TEX, { ...a.meta, model: { lodCount: 2 } });
    expect(peekPendingMeta(TEX), 'positive control: A is still refused').toBeUndefined();

    parkMetaEdit(TEX, { ...b.meta, postprocessor: 'outline' });
    expect(peekPendingMeta(TEX)).toEqual(stampMetaReadPath({ id: 'GUID-1', postprocessor: 'outline' }, TEX));

    parkMetaEdit(TEX, { ...b.meta, postprocessor: 'none' });
    expect(peekPendingMeta(TEX), 'a live park must not wedge the path')
      .toEqual(stampMetaReadPath({ id: 'GUID-1', postprocessor: 'none' }, TEX));
  });

  /** The legitimate empty case, which is NOT a failed read: an asset whose sidecar does not exist
   *  yet answers 200 with `{}` (only a missing ASSET 404s). Its first park carries no `id` and
   *  must land — there is no GUID for a heal pass to orphan.
   *
   *  ⚠️ Without this, a mutant refusing every id-less document passes everything above. */
  it('a first-ever park on an asset with no sidecar yet still lands', async () => {
    readReply = { ok: true, body: {}, sha: null };
    const { meta, ok } = await readMetaPreferringPark(TEX);
    expect(ok, 'a missing SIDECAR is a 200 — only a missing asset 404s').toBe(true);

    parkMetaEdit(TEX, { ...meta, texture: { maxSize: 512 } });

    expect(peekPendingMeta(TEX)).toEqual(stampMetaReadPath({ texture: { maxSize: 512 } }, TEX));
  });

  /** THE SECOND DOOR (#880). `writeMetaWholesale` reaches disk without parking anything, so the
   *  park refusal above never saw it — and `EnvironmentAssetView.apply()`'s UltraHDR branch builds
   *  `{...(meta ?? {}), environment, environmentCache}` and writes it, with `loadMeta` dropping the
   *  read's `ok` and Apply disabled only while `importing`, never on a failed load. A 500, a switch
   *  to UltraHDR, one click, and an id-less document went to `/api/write-meta`.
   *
   *  The path-keyed flag could not have covered this at all: it was only ever consulted on a park. */
  it('a wholesale write built on a failed read is refused, and never reaches the route', async () => {
    failRead();
    const { meta } = await readMetaPreferringPark(TEX);

    const wrote = await writeMetaWholesale(TEX, { ...meta, environment: { format: 'ultrahdr' } });

    expect(wrote, 'this write would have minted the asset a fresh GUID').toBe(false);
    expect(
      writes,
      'refused BEFORE the POST — a write that reaches the route has already replaced the file',
    ).toEqual([]);
  });

  /** The accept side of that door, and the half a "does it refuse?" test cannot reach. */
  it('...and a wholesale write built on a SUCCESSFUL read still goes through', async () => {
    okRead();
    const { meta } = await readMetaPreferringPark(TEX);

    const wrote = await writeMetaWholesale(TEX, { ...meta, environment: { format: 'ultrahdr' } });

    expect(wrote).toBe(true);
    expect(writes.at(-1)?.meta).toEqual({ id: 'GUID-1', environment: { format: 'ultrahdr' } });
  });

  /** THE FOURTH DOOR (#880 close-out review, finding 1) — and the one that was still open after
   *  the first three were guarded.
   *
   *  `writeMetaConditional` (`assetViews/widgets.tsx`) is the ONLY `/api/write-meta` POST
   *  implementation in the package, and `SpriteEditor.save` / `NineSliceEditor.save` reach it
   *  directly through `writeMetaOrWarn`, passing through neither `parkMetaEdit` nor
   *  `writeMetaWholesale`. They are safe today only because each hand-rolls its own
   *  `metaLoadedRef` boolean — so a third modal editor copying their shape and omitting that one
   *  line would have replaced a sidecar with an id-less document, with every guard silent.
   *
   *  ⚠️ The tag was being consumed in three places while ONE endpoint existed. That is what this
   *  test pins: the refusal is at the endpoint now, so it holds for a caller that knows nothing
   *  about the pending registry. */
  it('the direct write path (writeMetaOrWarn) refuses a document built on a failed read', async () => {
    const { writeMetaOrWarn } = await import('../../packages/modoki/src/editor/panels/assetViews/widgets');
    failRead();
    const { meta } = await readMetaPreferringPark(TEX);

    const wrote = await writeMetaOrWarn(TEX, { ...meta, border: { top: 4 } });

    expect(wrote, 'a modal editor saving on a failed read must not replace the sidecar').toBe(false);
    expect(writes, 'and the POST must not have been issued').toEqual([]);
  });

  /** The accept side of the fourth door — without it, a mutant refusing EVERY write passes above. */
  it('...and lets an ordinary document through', async () => {
    const { writeMetaOrWarn } = await import('../../packages/modoki/src/editor/panels/assetViews/widgets');
    okRead();
    const { meta } = await readMetaPreferringPark(TEX);

    const wrote = await writeMetaOrWarn(TEX, { ...meta, border: { top: 4 } });

    expect(wrote).toBe(true);
    expect(writes.at(-1)?.meta).toEqual({ id: 'GUID-1', border: { top: 4 } });
  });

  /** ⚠️ The property the whole design rests on, and the one a reader cannot check by looking: the
   *  tag survives the spreads a panel makes, however many. Every test above exercises ONE spread;
   *  `ModelAssetView` and its siblings re-spread their own state on each keystroke, so a tag that
   *  survived only the first hop would fail open on the second edit and nowhere else. */
  it('the tag survives repeated spreads — a panel re-merging its own state stays refused', () => {
    const first = { ...metaReadFallback(), model: { lodCount: 2 } };
    const second = { ...first, texture: { maxSize: 512 } };
    const third = { ...second, model: { lodCount: 3 } };

    parkMetaEdit(TEX, third);

    expect(peekPendingMeta(TEX), "three spreads deep, still the fallback's document").toBeUndefined();
  });

  /** ⚠️ The tag must never leave the renderer, and `/api/write-meta` takes `JSON.stringify`'d
   *  bodies, which drop symbol keys.
   *
   *  ⚠️ **Scope, stated honestly: this pins the SYMBOL, not the serializer.** It builds its own
   *  object and never goes through `writeMetaWholesale` or `flushPendingMeta`, so the only mutant
   *  it catches is `FROM_FAILED_READ` ceasing to be a symbol (a string key would land in the
   *  sidecar). It cannot detect a swapped serializer — and it cannot be widened to, because a
   *  tagged document is REFUSED at both doors and so can never reach a real write to observe. An
   *  earlier version of this docblock claimed the wider guarantee. */
  it('the tag cannot reach the wire — JSON does not carry it', () => {
    const doc = { ...metaReadFallback(), texture: { maxSize: 512 } };
    expect(JSON.parse(JSON.stringify(doc))).toEqual({ texture: { maxSize: 512 } });
    expect(Object.keys(metaReadFallback()), 'and no string-keyed consumer can see it').toEqual([]);
  });
});


describe('a wholesale editor write does not leave a stale baseline (#874)', () => {
  /** A stub that behaves like `ifMatchRefusal`: 409 when a PRESENT `ifMatch` misses, and every
   *  successful write advances what disk holds. */
  function stubServer() {
    const state = { sha: 'V1' };
    const sent: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
      if (String(url).includes('/api/read-meta')) {
        return {
          ok: true, status: 200,
          headers: { get: (k: string) => (k.toLowerCase() === 'x-meta-sha256' ? state.sha : null) },
          text: async () => '', json: async () => ({ id: 'g' }),
        } as unknown as Response;
      }
      const body = JSON.parse(init?.body ?? '{}');
      sent.push(body);
      if (body.ifMatch !== undefined && body.ifMatch !== state.sha) {
        return {
          ok: false, status: 409, headers: { get: () => null },
          text: async () => '', json: async () => ({ ok: false, conflict: true }),
        } as unknown as Response;
      }
      state.sha += '+';
      return {
        ok: true, status: 200, headers: { get: () => null },
        text: async () => '', json: async () => ({ ok: true, sha256: state.sha }),
      } as unknown as Response;
    }));
    return { state, sent };
  }

  it('metaWrittenToDisk forgets it, so the next parked edit is not refused', async () => {
    const { state } = stubServer();
    await readMetaPreferringPark(TEX);                       // panel mounts → baseline V1
    expect(peekMetaBaseline(TEX)).toBe('V1');

    // A 9-slice/Sprite Save: it wrote the full document itself and reports that in.
    //
    // ⚠️ `state.sha` MUST advance here, and the first version of this test forgot to — which made
    // both assertions below vacuous. Those editors POST the document themselves rather than
    // through this stub, so without this line disk stays at 'V1', a stale `ifMatch:'V1'` still
    // MATCHES, and the flush is accepted whether the baseline was forgotten or not. The test
    // narrated a 409 that its own fixture made impossible: deleting the mechanism turned it red
    // only at the `peekMetaBaseline` line, and deleting THAT line left it green with the
    // mechanism gone. This is the write actually reaching disk.
    parkAsPanel(TEX, { id: 'g', border: [1, 1, 1, 1] });
    state.sha = 'V2';
    metaWrittenToDisk(TEX, peekPendingMeta(TEX));
    expect(peekMetaBaseline(TEX), 'the hash it just invalidated').toBeUndefined();

    // The human's next Inspector edit + Cmd+S. With the baseline kept, this sends `ifMatch:'V1'`
    // against a disk holding 'V2' → the 409 that names no true cause.
    parkAsPanel(TEX, { id: 'g', texture: { maxSize: 1024 } });
    const r = await flushPendingMeta();

    expect(r.failed, 'a 409 naming no true cause — this editor changed the file').toEqual([]);
    expect(r.saved).toEqual([TEX]);
  });

  /** #874 review — the pairing itself, which had NO test and is how the fail-open got in.
   *
   *  Three explicit-action writers each carried their own copy of "write, then forget the baseline
   *  it invalidated", and the copies had drifted into two shapes: `makeTexture2D` guarded on the
   *  write's boolean, `EnvironmentAssetView` did not. So a FAILED write there dropped a baseline
   *  that was still accurate — disk had not changed — and the #845 precondition for that path went
   *  UNCONDITIONAL, turning the next external change from a 409 into a silent clobber. The guard
   *  meant to keep the CAS honest was what disarmed it.
   *
   *  Two of the three sites had no test at all, which is why nothing went red for the one that got
   *  it wrong. They are one function now (`writeMetaWholesale`), and this is its test — BOTH
   *  directions, because the accept side is the half that was broken. */
  describe('writeMetaWholesale — forget on success, KEEP on failure', () => {
    it('forgets the baseline when the write lands', async () => {
      stubServer();
      await readMetaPreferringPark(TEX);
      expect(peekMetaBaseline(TEX), 'positive control').toBe('V1');

      expect(await writeMetaWholesale(TEX, { id: 'g', type: '2d' })).toBe(true);

      expect(peekMetaBaseline(TEX), 'we replaced those bytes ourselves').toBeUndefined();
    });

    /** ⚠️ THE FAIL-OPEN. A write that did not land changed nothing on disk, so the baseline is
     *  still accurate and must survive — dropping it makes every later flush for this path
     *  unconditional, and an external change is then overwritten instead of refused. */
    it('KEEPS the baseline when the write fails — disk did not change', async () => {
      stubServer();
      await readMetaPreferringPark(TEX);
      expect(peekMetaBaseline(TEX)).toBe('V1');

      // The dev-server blip the modal editors keep their dialogs open for.
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: false, status: 500, headers: { get: () => null },
        text: async () => '', json: async () => ({ ok: false }),
      } as unknown as Response)));

      expect(await writeMetaWholesale(TEX, { id: 'g', type: '2d' })).toBe(false);

      expect(peekMetaBaseline(TEX), 'a failed write must not disarm the precondition').toBe('V1');
    });
  });

  /** ⚠️ The SUPERSEDED case forgets too. `metaWrittenToDisk` returns false when a newer park
   *  arrived during the write — correct for the PARK — but the baseline question has a different
   *  answer: disk changed either way, so a newer park writing against the old hash is the same
   *  409 one edit later. Two maps, two questions; only one of them takes that early return. */
  it('forgets the baseline even when the park was superseded and NOT dropped', async () => {
    const { state } = stubServer();
    await readMetaPreferringPark(TEX);
    parkAsPanel(TEX, { id: 'g', v: 1 });
    const refAtRead = peekPendingMeta(TEX);
    state.sha = 'V2';                                         // the wholesale write reached disk
    parkAsPanel(TEX, { id: 'g', v: 2 });                     // a newer edit lands mid-write

    expect(metaWrittenToDisk(TEX, refAtRead), 'the newer park must survive').toBe(false);

    expect(peekPendingMeta(TEX)).toEqual(stampMetaReadPath({ id: 'g', v: 2 }, TEX));
    expect(peekMetaBaseline(TEX)).toBeUndefined();
    const r = await flushPendingMeta();
    expect(r.failed).toEqual([]);
  });
});

/** #890 / #891 / #897 — the park carries the path it was READ FOR.
 *
 *  `FROM_FAILED_READ` (the block above) asks *"was this built on a failed read?"* and is blind to
 *  two documents that destroy an asset just as thoroughly: one built on NO read (a thrown fetch
 *  produces no response to tag — #890, driven, GUID replaced on disk) and one built on a
 *  SUCCESSFUL read of another path (#891/#897, a panel still holding the previous asset's
 *  document). `READ_FOR_PATH` answers both with one comparison.
 *
 *  ⚠️ Both directions, deliberately, and they are mutation-checked separately: deleting the check
 *  turns the two refusals red and leaves the accept side green; inverting its comparison turns the
 *  accept side red and leaves the refusals green. A suite that goes red for BOTH mutations is not
 *  telling the halves apart, which is the shape that has hidden two defects in this module. */
describe('a park must be built on a read OF THAT PATH (#890/#891/#897)', () => {
  const A = '/assets/models/a.glb.meta.json';
  const B = '/assets/models/b.glb.meta.json';

  /** `/api/read-meta` answering 200 with `doc`, per path. */
  function stubReads(docs: Record<string, unknown>): void {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const path = decodeURIComponent(String(url).split('path=')[1] ?? '');
      return {
        ok: true, status: 200, headers: { get: () => null },
        text: async () => '', json: async () => docs[path] ?? {},
      } as unknown as Response;
    }));
  }

  /** #890, and the one branch neither read-failed guard ever covered. A THROWN fetch does not
   *  reach `metaReadFallback()` — `readMetaPreferringPark` deliberately does not swallow it — so
   *  the panel's `.catch(() => {})` leaves `meta === null` and its next field change spreads
   *  `{ ...(meta ?? {}) }`: no `id`, and nothing marking it as unread. */
  it('refuses a document nobody read — the thrown-read park that destroyed a GUID', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const panelMeta = await readMetaPreferringPark(A).then((r) => r.meta).catch(() => null);
    expect(panelMeta, 'the read really did throw rather than resolve to a fallback').toBeNull();

    parkMetaEdit(A, { ...(panelMeta ?? {}), model: { lodCount: 2 } });   // the panel's field change

    expect(peekPendingMeta(A), 'an id-less document must never be parked').toBeUndefined();
  });

  /** The same refusal reached without a throw — a fresh panel whose read has not landed yet. The
   *  measured window is 1.1-1.4 ms locally (#891), which no human wins and an agent driving
   *  `set_selection` + a field write in one `modoki_batch` does. */
  it('refuses an edit made BEFORE the read lands, not only after one fails', () => {
    parkMetaEdit(A, { model: { lodCount: 2 } });   // nothing has been read for A at all

    expect(peekPendingMeta(A)).toBeUndefined();
  });

  /** #891 — the worse half. A's document is genuinely read and correctly untagged, so the
   *  failed-read guard cannot see it; parking it under B writes A's GUID into B's sidecar and two
   *  assets claim one id. */
  it("refuses asset A's document parked under asset B's path", async () => {
    stubReads({ [A]: { id: 'GUID-A', rig: { bones: 3 } } });
    const a = await readMetaPreferringPark(A);
    expect(metaCameFromFailedRead(a.meta), 'A was read successfully — no tag to catch this').toBe(false);

    // The panel switched to B and its read has not landed; `meta` still holds A's document.
    parkMetaEdit(B, { ...a.meta, model: { lodCount: 2 } });

    expect(peekPendingMeta(B), "B's sidecar must not receive A's GUID").toBeUndefined();
    expect(peekPendingMeta(A), 'and nothing was parked for A either').toBeUndefined();
  });

  /** ⚠️ THE ACCEPT SIDE — the half a "does it refuse?" test cannot reach, and the half that has
   *  hidden two defects in this module already. If this went red the guard would be refusing every
   *  ordinary field change, which no refusal test can tell apart from working correctly. */
  it('ACCEPTS the ordinary field change: read this path, spread it, park it', async () => {
    stubReads({ [A]: { id: 'GUID-A' } });
    const { meta } = await readMetaPreferringPark(A);

    parkMetaEdit(A, { ...meta, model: { lodCount: 2 } });

    expect(peekPendingMeta(A)).toEqual(stampMetaReadPath({ id: 'GUID-A', model: { lodCount: 2 } }, A));
  });

  /** The second keystroke, which is where a naive stamp breaks: the panel re-spreads its OWN state
   *  (never re-reading), and after a flush-less re-read `readMetaPreferringPark` returns the PARKED
   *  document. Both must stay parkable, or the guard turns the first edit into the last one. */
  it('ACCEPTS a second edit spread from panel state, and a third from the parked document', async () => {
    stubReads({ [A]: { id: 'GUID-A' } });
    const { meta } = await readMetaPreferringPark(A);

    const afterFirst = { ...meta, model: { lodCount: 2 } };
    parkMetaEdit(A, afterFirst);
    parkMetaEdit(A, { ...afterFirst, model: { lodCount: 3 } });          // no re-read between edits

    const reread = await readMetaPreferringPark(A);                      // returns the PARKED doc
    parkMetaEdit(A, { ...reread.meta, postprocessor: 'outline' });

    expect(peekPendingMeta(A))
      .toEqual(stampMetaReadPath({ id: 'GUID-A', model: { lodCount: 3 }, postprocessor: 'outline' }, A));
  });

  /** The registry invariant the stored copy establishes: every document in `pending` is stamped
   *  for the key it is under, so the parked branch of `readMetaPreferringPark` can hand it back
   *  untouched — which it must, because that object reference IS `metaWrittenToDisk`'s stamp. */
  it('stamps what it STORES, and the parked read hands back that same object', async () => {
    stubReads({ [A]: { id: 'GUID-A' } });
    const { meta } = await readMetaPreferringPark(A);
    parkMetaEdit(A, { ...meta, model: { lodCount: 2 } });

    const parked = await readMetaPreferringPark(A);

    expect(metaReadPathOf(parked.meta), 'the parked document knows its own path').toBe(A);
    expect(parked.meta, 'and it is the registry\'s own object, not a copy').toBe(parked.pendingRef);
  });

  /** ⚠️ The property the whole design rests on and a reader cannot check by looking — the same one
   *  `FROM_FAILED_READ` needs, for the same reason: panels re-spread their own state on every
   *  keystroke, so a stamp surviving only the first hop would fail OPEN on the second edit. */
  it('the stamp rides spreads and Object.assign, and JSON cannot see it', () => {
    const read = stampMetaReadPath({ id: 'GUID-A' }, A);
    const third = { ...{ ...{ ...read, a: 1 }, b: 2 }, c: 3 };

    expect(metaReadPathOf(third), 'three spreads deep').toBe(A);
    expect(metaReadPathOf(Object.assign({}, read)), 'and through Object.assign').toBe(A);
    expect(JSON.parse(JSON.stringify(third)), 'and it can never reach the sidecar')
      .toEqual({ id: 'GUID-A', a: 1, b: 2, c: 3 });
  });

  /** A stamp is not something a FILE can carry: `JSON.parse` cannot produce a symbol-keyed
   *  property, so no sidecar — corrupt, hand-edited or hostile — can forge one. The string-keyed
   *  near-miss is what a hostile file would actually contain. */
  it('a string key of the same name is not a stamp', () => {
    const forged = JSON.parse('{"id":"GUID-A","modoki.pendingMeta.readForPath":"' + A + '"}');

    expect(metaReadPathOf(forged)).toBeUndefined();
    parkMetaEdit(A, { ...forged, model: { lodCount: 2 } });
    expect(peekPendingMeta(A)).toBeUndefined();
  });

  /** The failed-read refusal still owns its own case, and its message is the more specific one —
   *  a tagged fallback has no stamp either, so the ORDER of the two checks is what decides which
   *  recovery the human is told about. */
  it('a failed read is still refused as a failed read, not as an unstamped one', () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((m: unknown) => { errors.push(String(m)); });
    try {
      parkMetaEdit(A, { ...metaReadFallback(), model: { lodCount: 2 } });
    } finally { spy.mockRestore(); }

    expect(peekPendingMeta(A)).toBeUndefined();
    expect(errors.join('\n'), 'the failed-read message, not the never-read one').toContain('read failed');
  });
});
