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
} from '../../packages/modoki/src/editor/scene/pendingMeta';

const TEX = '/assets/textures/rock.png.meta.json';
const OTHER = '/assets/textures/grass.png.meta.json';

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
    parkMetaEdit(TEX, { texture: { format: 'webp' } });

    expect(isMetaDirty(TEX)).toBe(true);
    expect(hasPendingMeta()).toBe(true);
    expect(getPendingMetaPaths()).toEqual([TEX]);
    expect(globalThis.fetch, 'the Inspector wrote to disk on a field change').not.toHaveBeenCalled();
  });

  it('last edit to a path wins', () => {
    parkMetaEdit(TEX, { texture: { format: 'ktx2-uastc' } });
    parkMetaEdit(TEX, { texture: { format: 'webp' } });

    expect(getPendingMetaPaths()).toEqual([TEX]);
    expect(peekPendingMeta(TEX)).toEqual({ texture: { format: 'webp' } });
  });

  it('discard drops it without writing, and says what was not pending', () => {
    parkMetaEdit(TEX, { texture: { format: 'webp' } });
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
    parkMetaEdit(TEX, { texture: { format: 'webp' } });
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
    parkMetaEdit(TEX, { texture: { format: 'webp' } });
    parkMetaEdit(OTHER, { texture: { format: 'ktx2-uastc' } });

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
    parkMetaEdit(TEX, { texture: { format: 'webp' } });

    const r = await flushPendingMeta();

    const { hasUnsavedChanges } = await import('../../packages/modoki/src/editor/scene/serialize');
    expect(r.saved).toEqual([]);
    expect(r.failed).toEqual([{ path: TEX, error: expect.any(String) }]);
    expect(isMetaDirty(TEX), 'a failed flush must never look like a save').toBe(true);
    expect(peekPendingMeta(TEX)).toEqual({ texture: { format: 'webp' } });
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
    parkMetaEdit(TEX, { texture: { format: 'webp' } });
    parkMetaEdit(OTHER, { texture: { format: 'ktx2-uastc' } });

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
    parkMetaEdit(TEX, { texture: { format: 'webp' } });
    vi.stubGlobal('fetch', vi.fn(async () => {
      parkMetaEdit(TEX, { texture: { format: 'ktx2-uastc' } }); // a newer edit lands mid-flush
      return { ok: false, status: 500, text: async () => '', json: async () => reply.body } as unknown as Response;
    }));

    await flushPendingMeta();

    expect(peekPendingMeta(TEX), 'the newer edit was clobbered by the failed flush\'s re-park')
      .toEqual({ texture: { format: 'ktx2-uastc' } });
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

    parkMetaEdit(TEX, { v: 'old' });
    const fullFlush = flushPendingMeta();
    // The full flush's write for `TEX` has already started synchronously (it is the first thing
    // reached down the await chain), and it is now blocked on `releaseOld`.
    expect(order).toEqual(['start:old']);

    parkMetaEdit(TEX, { v: 'new' }); // a genuinely concurrent edit — unrelated to the batch above
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
    parkMetaEdit(TEX, { texture: { format: 'webp' } });

    const { meta, pendingRef } = await readMetaPreferringPark(TEX);

    expect(meta).toEqual({ texture: { format: 'webp' } });
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

    expect(meta).toEqual({ texture: { format: 'ktx2-uastc' } });
    expect(pendingRef).toBeUndefined();
  });

  it('a non-ok GET resolves to {}, matching every existing call site\'s r.ok ? r.json() : {}', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      ({ ok: false, status: 404, json: async () => ({ should: 'not be read' }) } as unknown as Response)));

    const { meta } = await readMetaPreferringPark(TEX);

    expect(meta).toEqual({});
  });
});

describe('metaWrittenToDisk — the read-then-write-back race the parking itself opened (#845 close-out)', () => {
  // The shape every immediate full-document writer (NineSliceEditor/SpriteEditor's Save,
  // modelImport.ts's id/generated merge) follows: read preferring the park, merge, write the
  // WHOLE doc back, then report the write so the park it already incorporated can be dropped.

  it('race A: a write built on the park it read drops that park, and a later flush writes nothing stale', async () => {
    parkMetaEdit(TEX, { texture: { format: 'webp' } });

    const { meta, pendingRef } = await readMetaPreferringPark(TEX);
    expect(meta).toEqual({ texture: { format: 'webp' } }); // the write below is built on this

    const dropped = metaWrittenToDisk(TEX, pendingRef);

    expect(dropped).toBe(true);
    expect(hasPendingMeta()).toBe(false);
    expect(peekPendingMeta(TEX)).toBeUndefined();
    // Nothing left to overwrite the write that already landed.
    expect(await flushPendingMeta()).toEqual({ saved: [], failed: [] });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('race B: a NEWER park landing before the write completes survives, and the flush writes IT, not the older read', async () => {
    parkMetaEdit(TEX, { texture: { format: 'webp' } });
    const { pendingRef } = await readMetaPreferringPark(TEX);

    // The Inspector edits the SAME path again while the writer that just read `pendingRef` is
    // still mid-write (e.g. still inside `writeMetaOrWarn`'s network round trip).
    parkMetaEdit(TEX, { texture: { format: 'ktx2-uastc' } });

    const dropped = metaWrittenToDisk(TEX, pendingRef);

    expect(dropped, 'a newer edit must never be dropped by an older write\'s bookkeeping').toBe(false);
    expect(peekPendingMeta(TEX)).toEqual({ texture: { format: 'ktx2-uastc' } });

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
    parkMetaEdit(TEX, { texture: { format: 'webp' } });

    expect(metaWrittenToDisk(TEX, undefined)).toBe(false);
    expect(peekPendingMeta(TEX)).toEqual({ texture: { format: 'webp' } });
  });

  it('does not drop a DIFFERENT path\'s park', async () => {
    parkMetaEdit(TEX, { texture: { format: 'webp' } });
    parkMetaEdit(OTHER, { texture: { format: 'ktx2-uastc' } });
    const { pendingRef } = await readMetaPreferringPark(TEX);

    expect(metaWrittenToDisk(OTHER, pendingRef)).toBe(false);
    expect(peekPendingMeta(TEX)).toEqual({ texture: { format: 'webp' } });
    expect(peekPendingMeta(OTHER)).toEqual({ texture: { format: 'ktx2-uastc' } });
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
   *  Without that copy this test fails; the prose invariant it replaced could not fail at all. */
  it('survives a caller that re-parks the SAME object mutated in place', async () => {
    const doc: Record<string, unknown> = { texture: { format: 'webp' } };
    parkMetaEdit(TEX, doc);
    const { pendingRef } = await readMetaPreferringPark(TEX);

    // The nineteenth call site, written the obvious wrong way.
    doc.texture = { format: 'ktx2-uastc' };
    parkMetaEdit(TEX, doc);

    // The second park is NEWER than the read, so the write that read the first must not drop it.
    expect(metaWrittenToDisk(TEX, pendingRef)).toBe(false);
    expect(peekPendingMeta(TEX)).toEqual({ texture: { format: 'ktx2-uastc' } });
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

    parkMetaEdit(TEX, { texture: { format: 'webp' } });
    await flushPendingMeta();

    expect(sent).toHaveLength(1);
    expect(sent[0].ifMatch).toBe('BEFORE');
  });

  /** The ACCEPT side. A guard proving it refuses a stale write never proves it lets a legitimate
   *  one through — and an absent baseline must stay UNCONDITIONAL, because "we never read this
   *  file" is not the same claim as "this file is unchanged". */
  it('sends NO ifMatch when this editor has never read the file', async () => {
    const sent = stubWithHeader('BEFORE');
    parkMetaEdit(TEX, { texture: { format: 'webp' } });   // parked with no prior read
    await flushPendingMeta();

    expect(sent).toHaveLength(1);
    expect('ifMatch' in sent[0]).toBe(false);
  });

  it('a 409 keeps the edit PARKED and names the conflict, rather than losing it', async () => {
    stubWithHeader('BEFORE', { status: 409, body: { ok: false, conflict: true, reason: 'if-match' } });
    await readMetaPreferringPark(TEX);
    parkMetaEdit(TEX, { texture: { format: 'webp' } });

    const r = await flushPendingMeta();

    expect(r.saved).toEqual([]);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].path).toBe(TEX);
    expect(r.failed[0].error).toMatch(/changed on disk/);
    // The whole point: the human's edit survives a refusal.
    expect(hasPendingMeta()).toBe(true);
    expect(peekPendingMeta(TEX)).toEqual({ texture: { format: 'webp' } });
  });

  /** ⚠️ The regression this advance exists to stop: WE wrote the file, so a panel still mounted on
   *  it holds a baseline that our own flush invalidated. Without advancing it, the very next save
   *  409s under "the file changed on disk" when nothing external ever touched it — a false alarm
   *  produced entirely by the guard. */
  it('advances the baseline to what the server wrote, so a second save does not conflict with itself', async () => {
    const sent = stubWithHeader('BEFORE');
    await readMetaPreferringPark(TEX);
    parkMetaEdit(TEX, { texture: { format: 'webp' } });
    await flushPendingMeta();
    expect(peekMetaBaseline(TEX)).toBe('AFTER');

    parkMetaEdit(TEX, { texture: { format: 'ktx2-uastc' } });
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
    parkMetaEdit(TEX, { texture: { format: 'webp' } });

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
    parkMetaEdit(TEX, { texture: { format: 'webp' } });

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

  it('discarding a park forgets its baseline too', async () => {
    stubWithHeader('BEFORE');
    await readMetaPreferringPark(TEX);
    parkMetaEdit(TEX, { texture: { format: 'webp' } });

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
