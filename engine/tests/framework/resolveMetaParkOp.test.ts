/** The `resolve-meta-park` agent op (#872/#882) — the renderer half of the sidecar park gate.
 *
 *  `pendingMeta` is renderer-only module state, and the three Node routes that touch a
 *  `.meta.json` (`/api/write-meta`, `/api/reimport`, `/api/duplicate-asset`) cannot see it. This op
 *  is the one thing they ask. Its route half is covered in `plugins/metaParkGate.test.ts`; what is
 *  asserted HERE is the behaviour that only exists inside the renderer:
 *
 *  - it reports a park **without recording anything** — the `passive` lesson `read-asset-meta`
 *    already carries. A write gate that seeds a CAS baseline or clears the read-failed flag as a
 *    side effect of looking would corrupt the state it was consulted about;
 *  - a discard drops the park **and its baseline**, and deliberately leaves `readFailed` ARMED,
 *    because clearing it would let a component still holding the `{}` fallback park an id-less
 *    document — the GUID destruction that flag exists to prevent (#880's second face);
 *  - probe and discard are ONE call, so nothing can park in between.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runAgentOp } from '../../app/debug/agentBridge';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import {
  parkMetaEdit, peekPendingMeta, clearPendingMeta, clearMetaBaselines, getPendingMetaPaths,
  noteMetaReadResult, peekMetaBaseline,
} from '../../packages/modoki/src/editor/scene/pendingMeta';

registerEditorAgentOps();

type Reply = { ok?: boolean; parked?: string[]; discarded?: string[] };
const resolve = (params: unknown) => runAgentOp('resolve-meta-park', params) as Promise<Reply>;
const discardAssetEdits = (params: unknown) => runAgentOp('discard-asset-edits', params) as
  Promise<{ ok?: boolean; discarded?: string[]; remainingImportSettings?: string[]; note?: string }>;

const TEX = '/assets/textures/rock.png';
const MODEL = '/assets/models/hero.glb';

// BOTH resets. `clearPendingMeta` empties `pending` only; the read-failed flag lives with the
// baselines and is cleared by `clearMetaBaselines`. Leaving it armed across cases makes a later
// `parkMetaEdit` silently refuse, which reads as the op having discarded something it did not.
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

  it('RECORDS NOTHING — the probe cannot seed a baseline or clear the read-failed flag', async () => {
    // The defect this pins is the one `read-asset-meta`'s own review caught and fixed with
    // `passive`: an agent-side read that seeds the CAS baseline makes a stale parked edit ACCEPTED
    // where it was correctly refused. A gate has more power to do that than a read, not less.
    noteMetaReadResult(TEX, { ok: false, headers: { get: () => null } } as unknown as Response);
    expect(peekMetaBaseline(TEX)).toBeUndefined();

    await resolve({ paths: [TEX] });

    expect(peekMetaBaseline(TEX)).toBeUndefined();
    // …and the read-failed flag is still armed, so the id-less park it guards is still refused.
    parkMetaEdit(TEX, { texture: { maxSize: 256 } });
    expect(peekPendingMeta(TEX)).toBeUndefined();
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

  it('leaves readFailed ARMED after a discard — clearing it would reopen the id-less park', async () => {
    // #880's second face, reachable by one more route now. It is NOT papered over: an armed path
    // stays refused after an agent discard, because a component may still be holding the `{}`
    // fallback, and a wholesale write of that document has no `id` — the scanner's heal pass then
    // mints a fresh GUID and every scene ref to the asset dangles.
    parkMetaEdit(TEX, { id: 'tex-guid', texture: { maxSize: 256 } });
    noteMetaReadResult(TEX, { ok: false, headers: { get: () => null } } as unknown as Response);

    await resolve({ paths: [TEX], discard: true });

    expect(peekPendingMeta(TEX)).toBeUndefined();
    parkMetaEdit(TEX, { texture: { maxSize: 512 } });
    expect(peekPendingMeta(TEX), 'an id-less park must still be refused after an agent discard').toBeUndefined();
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
