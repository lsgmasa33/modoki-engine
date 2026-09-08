/** The Scene inspector's `baseScene` edit is MANUAL-SAVE (#831).
 *
 *  `SceneAssetView` used to POST `/api/scene-mutate` the moment the field changed — no save
 *  action, while `get_editor_state` reported `persistenceMode:'manual'`. That is the same defect
 *  the four `persistAssetEdit` views had, reached down a different route; #831's own body cleared
 *  this view on the grounds that avoiding `persistAssetEdit` was deliberate, which was about the
 *  MECHANISM and said nothing about WHEN the bytes land.
 *
 *  Two properties are pinned here, and the second is the one that is easy to get wrong:
 *
 *   1. **A parked edit writes nothing** until the flush, and `hasUnsavedChanges()` counts it —
 *      an unsaved edit the editor cannot see is the silent-loss trap `unsavedChanges` exists for.
 *   2. **The flush TAKES its entries before it issues anything.** `/api/scene-mutate` refuses
 *      while the editor reports unsaved work, and these entries are part of that report — a flush
 *      that left them parked while calling would 409 against itself. Anything that fails is
 *      re-parked, so a failed flush is still pending. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  markBaseSceneEdit, applyBaseSceneEdit, peekBaseSceneEdit, isBaseSceneDirty, hasPendingBaseScenes,
  getPendingBaseScenePaths, clearPendingBaseScenes, discardPendingBaseScenes,
  flushPendingBaseScenes,
} from '../../packages/modoki/src/editor/scene/pendingBaseScene';

const LEVEL = '/assets/scenes/level-2.scene.json';
const OTHER = '/assets/scenes/level-3.scene.json';
const BASE = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';

type Reply = { status: number; body: unknown };
let reply: Reply;
let bodies: Array<Record<string, unknown>>;
/** What `hasPendingBaseScenes()` reported at the moment each request went out — the only way to
 *  see the take-first property from outside. */
let pendingDuringCall: boolean[];

beforeEach(() => {
  clearPendingBaseScenes();
  bodies = [];
  pendingDuringCall = [];
  reply = { status: 200, body: { ok: true, changed: 1 } };
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    pendingDuringCall.push(hasPendingBaseScenes());
    return { ok: reply.status < 400, status: reply.status, json: async () => reply.body } as unknown as Response;
  }));
});
afterEach(() => { clearPendingBaseScenes(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('parking a base-scene edit', () => {
  it('records the edit and writes nothing', async () => {
    markBaseSceneEdit(LEVEL, BASE);

    expect(isBaseSceneDirty(LEVEL)).toBe(true);
    expect(hasPendingBaseScenes()).toBe(true);
    expect(getPendingBaseScenePaths()).toEqual([LEVEL]);
    expect(globalThis.fetch, 'the Scene inspector wrote to disk on a field change').not.toHaveBeenCalled();
  });

  it('tells "no edit" apart from "an edit that CLEARS the base"', () => {
    // `undefined` = nothing pending, `null` = pending a clear. Flattening the two sends the panel
    // to the file's value when it should be showing empty — the edit reads as if it never happened.
    expect(peekBaseSceneEdit(LEVEL)).toBeUndefined();
    markBaseSceneEdit(LEVEL, null);
    expect(peekBaseSceneEdit(LEVEL)).toBeNull();
    expect(isBaseSceneDirty(LEVEL)).toBe(true);
  });

  it('last edit to a path wins', () => {
    markBaseSceneEdit(LEVEL, BASE);
    markBaseSceneEdit(LEVEL, null);
    expect(getPendingBaseScenePaths()).toEqual([LEVEL]);
    expect(peekBaseSceneEdit(LEVEL)).toBeNull();
  });

  it('discard drops it without writing, and says what was not pending', () => {
    markBaseSceneEdit(LEVEL, BASE);
    expect(discardPendingBaseScenes([LEVEL, OTHER])).toEqual({ discarded: [LEVEL], notPending: [OTHER] });
    expect(hasPendingBaseScenes()).toBe(false);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('flushing', () => {
  it('sends one setBaseScene op per path', async () => {
    markBaseSceneEdit(LEVEL, BASE);
    markBaseSceneEdit(OTHER, null);

    const r = await flushPendingBaseScenes();

    expect(r.saved.sort()).toEqual([LEVEL, OTHER].sort());
    expect(bodies).toHaveLength(2);
    expect(bodies.map((b) => (b.ops as Array<{ op: string; baseScene: unknown }>)[0]))
      .toEqual(expect.arrayContaining([
        { op: 'setBaseScene', baseScene: BASE },
        { op: 'setBaseScene', baseScene: null },
      ]));
    expect(hasPendingBaseScenes()).toBe(false);
  });

  it('is a no-op that issues nothing when there is nothing parked', async () => {
    expect(await flushPendingBaseScenes()).toEqual({ saved: [], failed: [] });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('TAKES the entries before issuing — nothing is still parked while the route is called', async () => {
    // ⚠️ The property the whole ordering rests on. `/api/scene-mutate` 409s while the editor
    // reports unsaved work, and `hasUnsavedChanges()` counts these entries — so a flush that left
    // them parked while calling would refuse its own write, every time, with no way out.
    markBaseSceneEdit(LEVEL, BASE);
    markBaseSceneEdit(OTHER, BASE);

    await flushPendingBaseScenes();

    expect(pendingDuringCall, 'an entry was still parked while its own mutation was in flight')
      .toEqual([false, false]);
  });

  it('a FAILED entry does not re-park until the whole batch is done — one failure must not poison the rest', async () => {
    // ⚠️ The half the test above could not see, because it only ever exercised the all-success
    // case. Re-parking inside the loop makes `hasUnsavedChanges()` true again the moment the first
    // entry fails, and the route refuses every later one with "the editor has unsaved live
    // changes" — false, the only unsaved thing is the entry that just failed. With `{A, B}` and A
    // failing for its own reason (a 404 on a renamed scene), B could then never be written while A
    // kept failing, and `hasUnsavedChanges()` stayed true for the session.
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      n += 1;
      pendingDuringCall.push(hasPendingBaseScenes());
      return n === 1
        ? { ok: false, status: 404, json: async () => ({ ok: false, error: 'scene not found' }) } as unknown as Response
        : { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
    }));
    markBaseSceneEdit(LEVEL, BASE);
    markBaseSceneEdit(OTHER, BASE);

    const r = await flushPendingBaseScenes();

    expect(pendingDuringCall, 'the failed entry was re-parked before the next request went out')
      .toEqual([false, false]);
    expect(r.saved, 'the second entry must still be written').toEqual([OTHER]);
    expect(getPendingBaseScenePaths(), 'and only the failed one stays pending').toEqual([LEVEL]);
  });

  it('RE-PARKS a refused mutation, so it stays unsaved and is retried later', async () => {
    reply = { status: 409, body: { ok: false, error: 'the editor has unsaved live changes' } };
    markBaseSceneEdit(LEVEL, BASE);

    const r = await flushPendingBaseScenes();

    expect(r.saved).toEqual([]);
    expect(r.failed).toEqual([{ path: LEVEL, error: 'the editor has unsaved live changes' }]);
    expect(isBaseSceneDirty(LEVEL), 'a failed flush must never look like a save').toBe(true);
    expect(peekBaseSceneEdit(LEVEL)).toBe(BASE);
  });

  it('does NOT re-park over an edit made while the flush was in flight', async () => {
    // Same rule `flushDirtyAssets` applies to its own deletes: an edit made during the save is on
    // screen, is not on disk, and must not be replaced by the older value the flush was carrying.
    reply = { status: 500, body: { ok: false, error: 'boom' } };
    markBaseSceneEdit(LEVEL, BASE);
    vi.stubGlobal('fetch', vi.fn(async () => {
      markBaseSceneEdit(LEVEL, null); // the human clears the field mid-save
      return { ok: false, status: 500, json: async () => reply.body } as unknown as Response;
    }));

    await flushPendingBaseScenes();

    expect(peekBaseSceneEdit(LEVEL), 'the newer edit was clobbered by the failed flush').toBeNull();
  });

  it('one refused scene does not block the others', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      n += 1;
      return n === 1
        ? { ok: false, status: 409, json: async () => ({ ok: false, error: 'nope' }) } as unknown as Response
        : { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
    }));
    markBaseSceneEdit(LEVEL, BASE);
    markBaseSceneEdit(OTHER, BASE);

    const r = await flushPendingBaseScenes();

    expect(r.saved).toEqual([OTHER]);
    expect(r.failed.map((f) => f.path)).toEqual([LEVEL]);
    expect(getPendingBaseScenePaths()).toEqual([LEVEL]);
  });

  it('reports a THROWN request as a failure rather than letting it escape', async () => {
    // The flush runs inside `saveAll`; an escaping rejection there takes the whole save with it.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    markBaseSceneEdit(LEVEL, BASE);

    const r = await flushPendingBaseScenes();

    expect(r.failed).toEqual([{ path: LEVEL, error: 'network down' }]);
    expect(isBaseSceneDirty(LEVEL)).toBe(true);
  });
});

describe('which route an edit takes (#831)', () => {
  it('the OPEN scene goes to LIVE editor state and parks NOTHING', () => {
    // `serializeScene` emits `baseScene` from this module state, so setting it there IS the edit
    // and Cmd+S writes it with the rest of the scene. Parking it as well would produce a second
    // writer for the same field, racing the scene save.
    const live: Array<string | undefined> = [];
    expect(applyBaseSceneEdit(LEVEL, BASE, LEVEL, (v) => live.push(v))).toBe('live');
    expect(live).toEqual([BASE]);
    expect(hasPendingBaseScenes()).toBe(false);
  });

  it('clearing the OPEN scene\'s base applies `undefined`, never an empty string', () => {
    // `serializeScene` only emits the field when it is truthy, so `''` would be written as
    // `baseScene: ""` — a ref that resolves to nothing and reads as a broken link, not as "no
    // base" (A3). This is the assertion that catches a `v` passed straight through.
    const live: Array<string | undefined> = [];
    applyBaseSceneEdit(LEVEL, '', LEVEL, (v) => live.push(v));
    expect(live).toEqual([undefined]);
  });

  it('any OTHER scene parks, and does not touch live editor state', () => {
    const live: Array<string | undefined> = [];
    expect(applyBaseSceneEdit(OTHER, BASE, LEVEL, (v) => live.push(v))).toBe('parked');
    expect(live, 'a scene the editor has not loaded has no live base ref to set').toEqual([]);
    expect(peekBaseSceneEdit(OTHER)).toBe(BASE);
  });

  it('parks a CLEAR as null on a non-open scene — not as an empty string', () => {
    // The registry's own distinction: `null` is "pending a clear", `undefined` is "nothing
    // pending". An empty string would be neither, and would reach scene-mutate as a falsy value
    // it treats as a clear only by accident.
    applyBaseSceneEdit(OTHER, '', LEVEL, () => { throw new Error('must not touch live state'); });
    expect(peekBaseSceneEdit(OTHER)).toBeNull();
  });

  it('routes by the CURRENT scene, not by whichever was open when the panel rendered', () => {
    // An undo replayed after a scene swap must go where the ref actually lives now.
    const live: Array<string | undefined> = [];
    applyBaseSceneEdit(LEVEL, BASE, OTHER, (v) => live.push(v));
    expect(live).toEqual([]);
    expect(peekBaseSceneEdit(LEVEL)).toBe(BASE);
  });
});

describe('the editor can SEE a pending base-scene edit', () => {
  it('hasUnsavedChanges() counts it, and unsavedChangeCauses() names it', async () => {
    // ⚠️ Both halves, because they fail differently. Without the first, Cmd+S has no reason to run
    // and a scene swap discards the edit with no refusal — the silent-loss trap `unsavedChanges`
    // exists to close. Without the second, a refusal driven by this alone names NO cause and sends
    // the reader hunting for live entities they never created (S3.11, one population later).
    const { hasUnsavedChanges, unsavedChangeCauses } =
      await import('../../packages/modoki/src/editor/scene/serialize');

    expect(unsavedChangeCauses().pendingBaseScenes).toEqual([]);
    markBaseSceneEdit(LEVEL, BASE);
    expect(hasUnsavedChanges()).toBe(true);
    expect(unsavedChangeCauses().pendingBaseScenes).toEqual([LEVEL]);

    discardPendingBaseScenes([LEVEL]);
    expect(unsavedChangeCauses().pendingBaseScenes).toEqual([]);
  });
});

describe('opening the scene supersedes a park for it (#831 review, finding 1)', () => {
  it('the LIVE branch discards a park already held for that path', () => {
    // Reachable in the ordinary way, and silent: set a base on scene B in the Assets panel (parks),
    // then OPEN B and change it again (live). The scene write puts the NEW ref in the file, and
    // `flushPendingBaseScenes` — which runs AFTER it — mutates the file back to the OLD one. Same
    // revert #831 fixed, reached from the other side.
    markBaseSceneEdit(LEVEL, BASE);
    expect(isBaseSceneDirty(LEVEL)).toBe(true);

    const live: Array<string | undefined> = [];
    expect(applyBaseSceneEdit(LEVEL, 'newer-guid', LEVEL, (v) => live.push(v))).toBe('live');

    expect(live).toEqual(['newer-guid']);
    expect(isBaseSceneDirty(LEVEL), 'the stale park would have overwritten the live value at save')
      .toBe(false);
  });

  it('and does not touch a park for a DIFFERENT path', () => {
    markBaseSceneEdit(OTHER, BASE);
    applyBaseSceneEdit(LEVEL, 'newer-guid', LEVEL, () => {});
    expect(peekBaseSceneEdit(OTHER)).toBe(BASE);
  });
});

describe('a supersession DURING a flush survives the re-park (#831 re-review, finding 1)', () => {
  it('a failed entry is NOT re-parked when the scene was opened and edited mid-flight', async () => {
    // ⚠️ The failure branch undid the fix above. The re-park's `!pending.has(path)` guard can only
    // see a newer PARKED claim, and the live branch's own `pending.delete` is a no-op during a
    // flush — the map is already empty — so it left no trace. Sequence: park OLD on B → Cmd+S →
    // B's mutation fails (a renamed scene 404s) → the human OPENS B and sets NEW while the request
    // is in flight → the flush re-parks OLD → the next Cmd+S writes NEW from the live state and
    // then this park mutates the file back to OLD.
    const live: Array<string | undefined> = [];
    vi.stubGlobal('fetch', vi.fn(async () => {
      applyBaseSceneEdit(LEVEL, 'newer-guid', LEVEL, (v) => live.push(v)); // B is now open + edited
      return { ok: false, status: 404, json: async () => ({ ok: false, error: 'scene not found' }) } as unknown as Response;
    }));
    markBaseSceneEdit(LEVEL, BASE);

    const r = await flushPendingBaseScenes();

    expect(r.failed.map((f) => f.path)).toEqual([LEVEL]);
    expect(live).toEqual(['newer-guid']);
    expect(isBaseSceneDirty(LEVEL), 'the stale ref was resurrected and would overwrite the live one')
      .toBe(false);
  });

  it('still re-parks a failure nothing superseded', async () => {
    // The other direction, or "never re-park" would pass the test above. A refused ref with no
    // competing edit is pending work that stayed pending and must survive to be retried.
    reply = { status: 409, body: { ok: false, error: 'nope' } };
    markBaseSceneEdit(LEVEL, BASE);
    await flushPendingBaseScenes();
    expect(peekBaseSceneEdit(LEVEL)).toBe(BASE);
  });

  it('a supersession from a PREVIOUS flush does not suppress this one\'s re-park', () => {
    // The marker is cleared when a flush takes its batch, so it can only ever describe THIS flush.
    // Without that it would latch: one live edit and the path could never be re-parked again.
    applyBaseSceneEdit(LEVEL, 'x', LEVEL, () => {});
    reply = { status: 409, body: { ok: false, error: 'nope' } };
    markBaseSceneEdit(LEVEL, BASE);
    return flushPendingBaseScenes().then(() => {
      expect(peekBaseSceneEdit(LEVEL)).toBe(BASE);
    });
  });
});

describe('two flushes can overlap, and must not erase each other\'s markers (#831 re-review 2)', () => {
  it('a CONCURRENT flush does not reopen the supersession hole', async () => {
    // ⚠️ Two flushes really can overlap: a human Cmd+S goes through `runSaveAll`'s `_inFlight`
    // coalescing, but the `save-all` AGENT op calls `saveAll()` directly — so a `modoki_save_all`
    // landing during a human save gives two. With ONE module-level marker set, the second flush's
    // clear erases the first's in-flight markers and its re-park falls back to `!pending.has(path)`
    // alone: the hole the markers exist to close, reopened by the mechanism closing it.
    //
    // ⚠️ THE ORDER BELOW IS THE TEST. The live edit must be marked BEFORE the second flush starts,
    // because it is that flush's take-batch that does the clearing. An earlier draft of this test
    // started the second flush first and passed against a deliberately-shared set — proving
    // nothing, which is exactly what a test you have not watched fail is worth.
    let started = false;
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (!started) {
        started = true;
        applyBaseSceneEdit(LEVEL, 'newer-guid', LEVEL, () => {}); // 1. LEVEL is opened + edited live
        markBaseSceneEdit(OTHER, BASE);                            // 2. …so flush #2 has a batch
        await flushPendingBaseScenes();                            // 3. …and would clear the marker
      }
      return { ok: false, status: 404, json: async () => ({ ok: false, error: 'scene not found' }) } as unknown as Response;
    }));
    markBaseSceneEdit(LEVEL, BASE);

    await flushPendingBaseScenes();

    expect(isBaseSceneDirty(LEVEL), 'the second flush erased the first\'s marker, so the stale ref '
      + 'was resurrected and would overwrite the live one at the next save').toBe(false);
  });
});
