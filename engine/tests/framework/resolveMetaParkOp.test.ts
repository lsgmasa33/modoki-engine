/** The `resolve-meta-park` agent op (#872/#882) — the renderer half of the sidecar park gate.
 *
 *  `pendingMeta` is renderer-only module state, and the three Node routes that touch a
 *  `.meta.json` (`/api/write-meta`, `/api/reimport`, `/api/duplicate-asset`) cannot see it. This op
 *  is the one thing they ask. Its route half is covered in `plugins/metaParkGate.test.ts`; what is
 *  asserted HERE is the behaviour that only exists inside the renderer:
 *
 *  - it reports a park **without recording anything** — the `passive` lesson `read-asset-meta`
 *    already carries. A write gate that seeds a CAS baseline as a side effect of looking would
 *    corrupt the state it was consulted about;
 *  - a discard drops the park **and its baseline**, and still lets a document from a GOOD read
 *    park afterwards (the accept side — a gate that refused everything post-discard would pass a
 *    refusal-only test);
 *  ⚠️ This file used to also pin "a discard leaves `readFailed` ARMED". #880 replaced that
 *  path-keyed flag with a tag on the fallback DOCUMENT, which this op shares no state with, so
 *  that property is now structural and untestable FROM HERE — asserting it in this suite would
 *  be a test that cannot fail, pointing at the wrong subsystem. `editor/pendingMeta.test.ts`
 *  owns it;
 *  - probe and discard are ONE call, so nothing can park in between.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runAgentOp } from '../../app/debug/agentBridge';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import {
  parkMetaEdit, peekPendingMeta, clearPendingMeta, clearMetaBaselines, getPendingMetaPaths,
  peekMetaBaseline,
} from '../../packages/modoki/src/editor/scene/pendingMeta';

registerEditorAgentOps();

type Reply = { ok?: boolean; parked?: string[]; discarded?: string[] };
const resolve = (params: unknown) => runAgentOp('resolve-meta-park', params) as Promise<Reply>;
const discardAssetEdits = (params: unknown) => runAgentOp('discard-asset-edits', params) as
  Promise<{ ok?: boolean; discarded?: string[]; remainingImportSettings?: string[]; note?: string }>;

const TEX = '/assets/textures/rock.png';
const MODEL = '/assets/models/hero.glb';

// BOTH resets, and `clearMetaBaselines` is NOT optional despite the read-failed flag it used to
// also clear being gone (#880). `clearPendingMeta` empties `pending` only, so without the second
// call a baseline seeded by an earlier case leaks into the next one — and the "RECORDS NOTHING"
// case below asserts on `peekMetaBaseline` being undefined, so it would fail for a reason that
// has nothing to do with the probe.
const reset = () => { clearPendingMeta(); clearMetaBaselines(); };
beforeEach(reset);
afterEach(reset);

describe('resolve-meta-park — the probe', () => {
  it('reports a parked path, and reports a clean one as clean', async () => {
    parkMetaEdit(TEX, { id: 'tex-guid', texture: { maxSize: 256 } });

    expect(await resolve({ paths: [TEX, MODEL] })).toMatchObject({ ok: true, parked: [TEX], discarded: [] });
    expect(await resolve({ paths: [MODEL] })).toMatchObject({ ok: true, parked: [], discarded: [] });
  });

  it('a bare or malformed call is refused, and the refusal lists what IS parked', async () => {
    // The `set_selection` lesson: a destructive-adjacent op whose bare call means "everything" is
    // one misspelled argument key away from doing it. This one refuses instead, and the refusal is
    // a copy-paste of the paths that matter — §5.
    parkMetaEdit(TEX, { id: 'tex-guid' });
    await expect(resolve({})).rejects.toThrow(/requires \{ paths/);
    await expect(resolve({ paths: [] })).rejects.toThrow(new RegExp(TEX.replace(/\//g, '\\/')));
    await expect(resolve({ paths: [''] })).rejects.toThrow(/requires \{ paths/);
    await expect(resolve({ paths: TEX })).rejects.toThrow(/requires \{ paths/);
  });

  it('RECORDS NOTHING — the probe cannot seed a baseline, nor make a failed-read document parkable', async () => {
    // The defect this pins is the one `read-asset-meta`'s own review caught and fixed with
    // `passive`: an agent-side read that seeds the CAS baseline makes a stale parked edit ACCEPTED
    // where it was correctly refused. A gate has more power to do that than a read, not less.
    // (No `noteMetaReadResult(ok:false)` setup any more — it used to ARM the read-failed flag, and
    // since #880 a non-ok response records nothing at all, so the call was arming nothing while
    // reading like a precondition. `reset()` already leaves the baseline unset.)
    expect(peekMetaBaseline(TEX), 'precondition: no baseline for this path').toBeUndefined();

    await resolve({ paths: [TEX] });

    expect(peekMetaBaseline(TEX)).toBeUndefined();
    // ⚠️ NO tag assertion here, deliberately. The second half used to read "and the read-failed
    // flag is still armed"; #880 moved that guard onto the fallback DOCUMENT, which this op shares
    // no state with. Asserting it here would be green with the `await resolve()` above DELETED —
    // a test that cannot fail for anything its own subject does, and one that reddens in the
    // agent-op suite when `parkMetaEdit` breaks, pointing a reader at the wrong subsystem.
    // `editor/pendingMeta.test.ts` owns the refusal.
  });
});

describe('resolve-meta-park — the discard', () => {
  it('drops the park only when asked, and reports what actually went', async () => {
    parkMetaEdit(TEX, { id: 'tex-guid', texture: { maxSize: 256 } });

    // Probing does not discard. This is the accept side of the discard flag: a gate that dropped
    // the park just by looking would destroy the human's edit on every refusal it issued.
    await resolve({ paths: [TEX] });
    expect(peekPendingMeta(TEX)).toBeDefined();

    const r = await resolve({ paths: [TEX], discard: true });
    expect(r).toMatchObject({ parked: [TEX], discarded: [TEX] });
    expect(peekPendingMeta(TEX)).toBeUndefined();
    expect(getPendingMetaPaths()).toEqual([]);
  });

  it('discards only the paths asked about, never the whole registry', async () => {
    parkMetaEdit(TEX, { id: 'tex-guid' });
    parkMetaEdit(MODEL, { id: 'model-guid' });

    await resolve({ paths: [TEX], discard: true });

    expect(peekPendingMeta(TEX)).toBeUndefined();
    expect(peekPendingMeta(MODEL)).toBeDefined();
  });

  it('a discard of an unparked path is a no-op, not an error', async () => {
    expect(await resolve({ paths: [MODEL], discard: true })).toMatchObject({ parked: [], discarded: [] });
  });

  it('an agent discard does not make a failed-read document parkable', async () => {
    // Written as "leaves readFailed ARMED after a discard" when the guard was a path-keyed flag.
    // #880 moved it onto the fallback DOCUMENT, so the discard cannot reach it by construction —
    // but the test still earns its place as the regression guard for anyone wiring provenance into
    // the discard path. The hazard is unchanged: a component may still be holding the `{}` fallback,
    // and a wholesale write of that document has no `id`, so the scanner's heal pass mints a fresh
    // GUID and every scene ref to the asset dangles.
    parkMetaEdit(TEX, { id: 'tex-guid', texture: { maxSize: 256 } });

    await resolve({ paths: [TEX], discard: true });

    expect(peekPendingMeta(TEX)).toBeUndefined();
    // ⚠️ The ACCEPT side, which is the half this op can actually get wrong: a document from a GOOD
    // read still parks after the discard. (The refusal half is NOT asserted here — see the note in
    // "RECORDS NOTHING" above and the file header: since #880 it cannot fail for anything
    // `resolve-meta-park` does.)
    parkMetaEdit(TEX, { id: 'tex-guid', texture: { maxSize: 128 } });
    expect(peekPendingMeta(TEX)).toEqual({ id: 'tex-guid', texture: { maxSize: 128 } });
  });
});

describe('discard-asset-edits does not silently imply it cleared the sidecar registry too', () => {
  it('reports a parked import-settings edit it did NOT discard', async () => {
    // `all:true` reads as a clean slate and is not one: this op owns the DIRTY-ASSET registry, and
    // a parked `.meta.json` edit survives it untouched. An agent that then re-imports still bakes
    // against the human's unsaved settings (#882) — a false success, which §0 ranks worst.
    parkMetaEdit(TEX, { id: 'tex-guid', texture: { maxSize: 256 } });

    const r = await discardAssetEdits({ all: true });

    expect(r.ok).toBe(true);
    expect(r.remainingImportSettings).toEqual([TEX]);
    expect(String(r.note)).toContain('NOT covered by this call');
    // …and it really did not discard it. Reporting, not widening the blast radius.
    expect(peekPendingMeta(TEX)).toBeDefined();
  });

  it('says nothing extra when the sidecar registry is empty', async () => {
    const r = await discardAssetEdits({ all: true });

    expect(r.remainingImportSettings).toBeUndefined();
    expect(String(r.note)).not.toContain('NOT covered by this call');
  });
});
