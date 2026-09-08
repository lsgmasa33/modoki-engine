/** The `resolve-unsaved` agent op (#889) — the renderer half of the shared unsaved-work probe.
 *
 *  Every registry it reports is renderer-only module state, and every Node backend route that
 *  reads or writes a project file is blind to all of it. This op is the one thing they ask.
 *  Its route half is covered in `plugins/metaParkGate.test.ts`; what is asserted HERE is the
 *  behaviour that only exists inside the renderer.
 *
 *  ## ⚠️ The property that matters most, and why it is asserted at all
 *
 *  The op must cover **five** sources of unsaved state, not the four registry modules under
 *  `editor/scene/`. `sceneDirty.ts` tracks BASE scenes only; the PRIMARY scene's live-world edits
 *  are a pathless boolean in `serialize.ts`. A probe assembled by enumerating registry modules is
 *  vacuous for the open scene and NOTHING goes red. So the op derives its list from
 *  `unsavedChangeCauses()` and `satisfies` a record over its keys — a sixth cause is a compile
 *  error until mapped. That is a TYPE-level guarantee; what this file adds is the runtime half:
 *  every cause the renderer can actually hold is reported, under the registry name Node expects.
 *
 *  Carried forward from `resolve-meta-park`, unchanged in force:
 *  - it reports without RECORDING anything — the `passive` lesson `read-asset-meta` carries. A
 *    write gate that seeds a CAS baseline as a side effect of looking corrupts the state it was
 *    consulted about;
 *  - a discard drops the state AND its baseline, and a document from a GOOD read still parks
 *    afterwards (the accept side — a gate that refused everything post-discard would pass a
 *    refusal-only test);
 *  - probe and discard are ONE call, so nothing can land in between.
 *
 *  ⚠️ **`liveScene` is covered for the BASE half only.** `markSceneDirty(guid)` is drivable from
 *  here; the primary scene's term needs a live world and an edit-version bump, which this suite has
 *  no honest way to produce. That gap is stated rather than faked — a stub that pretended to be a
 *  dirty primary scene would be a fake modelling behaviour nothing has, and the assertion built on
 *  it would defend the fake. The primary half is pinned by the type-level exhaustiveness check and
 *  by `editor/pendingMeta.test.ts`'s own coverage of `unsavedChangeCauses`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runAgentOp } from '../../app/debug/agentBridge';
import { registerEditorAgentOps } from '../../app/editor/agentEditorOps';
import {
  parkMetaEdit, peekPendingMeta, clearPendingMeta, clearMetaBaselines, getPendingMetaPaths,
  peekMetaBaseline,
  stampMetaReadPath,
} from '../../packages/modoki/src/editor/scene/pendingMeta';
import {
  markAssetDirty, peekDirtyAsset, clearDirtyAssets,
} from '../../packages/modoki/src/editor/scene/dirtyAssets';
import {
  markBaseSceneEdit, peekBaseSceneEdit, clearPendingBaseScenes,
} from '../../packages/modoki/src/editor/scene/pendingBaseScene';
import {
  markSceneDirty, clearAllSceneDirty,
} from '../../packages/modoki/src/editor/scene/sceneDirty';

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


registerEditorAgentOps();

type Hold = { path: string; registry: string; detail?: string };
type Reply = { ok?: boolean; holds?: Hold[]; discarded?: Hold[]; covers?: string[] };
const resolve = (params: unknown) => runAgentOp('resolve-unsaved', params) as Promise<Reply>;
/** The paths held under one registry, which is what most assertions below actually care about. */
const pathsIn = (r: Reply, registry: string) =>
  (r.holds ?? []).filter((h) => h.registry === registry).map((h) => h.path);
const discardAssetEdits = (params: unknown) => runAgentOp('discard-asset-edits', params) as
  Promise<{ ok?: boolean; discarded?: string[]; remainingImportSettings?: string[]; note?: string }>;

const TEX = '/assets/textures/rock.png';
const MODEL = '/assets/models/hero.glb';

// BOTH resets, and `clearMetaBaselines` is NOT optional despite the read-failed flag it used to
// also clear being gone (#880). `clearPendingMeta` empties `pending` only, so without the second
// call a baseline seeded by an earlier case leaks into the next one — and the "RECORDS NOTHING"
// case below asserts on `peekMetaBaseline` being undefined, so it would fail for a reason that
// has nothing to do with the probe.
const reset = () => {
  // ⚠️ ALL FIVE, because the op now reads all of them: a leak from one suite into the next would
  // show up as a `holds` row nobody parked, in a registry the failing test never mentions.
  clearPendingMeta(); clearMetaBaselines();
  clearDirtyAssets(); clearPendingBaseScenes(); clearAllSceneDirty();
};
beforeEach(reset);
afterEach(reset);

describe('resolve-unsaved — the probe', () => {
  it('reports a held path, and reports a clean one as clean', async () => {
    parkAsPanel(TEX, { id: 'tex-guid', texture: { maxSize: 256 } });

    const r = await resolve({ paths: [TEX, MODEL] });
    expect(r.ok).toBe(true);
    expect(pathsIn(r, 'pendingMeta')).toEqual([TEX]);
    expect(r.discarded).toEqual([]);

    expect(pathsIn(await resolve({ paths: [MODEL] }), 'pendingMeta')).toEqual([]);
  });

  it('covers ALL FIVE causes, each under the registry name Node expects', async () => {
    // ⚠️ The runtime half of the derivation. The type-level `satisfies` makes a NEW cause a
    // compile error; this makes an EXISTING cause silently going unreported a red test. Four of
    // the five are drivable from here — see the file header for why the primary-scene term is not.
    parkAsPanel(TEX, { id: 'tex-guid' });                                    // pendingMeta
    markAssetDirty('/a.mat.json', 'material', { id: 'm' });                  // dirtyAsset
    markBaseSceneEdit('/lvl.scene.json', '/base.scene.json');                // pendingBaseScene
    markSceneDirty('scene-guid-1');                                          // liveScene (a BASE)

    const r = await resolve({});   // global mode — no `paths`

    expect(pathsIn(r, 'pendingMeta')).toEqual([TEX]);
    expect(pathsIn(r, 'dirtyAsset')).toEqual(['/a.mat.json']);
    expect(pathsIn(r, 'pendingBaseScene')).toEqual(['/lvl.scene.json']);
    // The guid resolves to no manifest entry in this suite, so it is reported UNDER THE GUID
    // rather than dropped — "could not look" must not be reported as "nothing is there", least of
    // all inside the probe written to stop that.
    expect(pathsIn(r, 'liveScene')).toEqual(['scene-guid-1']);
  });

  it('GLOBAL MODE (`paths` omitted) is not the same as an empty list', async () => {
    // ⚠️ This distinction is load-bearing on the Node side and was briefly collapsed: an empty
    // array short-circuited to "clear", so both stale-read routes would have reported clean
    // unconditionally — a disclosure that could never fire, which is worse than no disclosure
    // because it reads as a guarantee.
    parkAsPanel(TEX, { id: 'tex-guid' });

    expect(pathsIn(await resolve({}), 'pendingMeta'), 'omitted paths = everything held').toEqual([TEX]);
    await expect(resolve({ paths: [] }), 'an empty list is a caller that computed nothing').rejects.toThrow();
  });

  it('SCOPES to the registries asked for, and says so in `covers`', async () => {
    // Without the scope, a sidecar route would be refused because an unrelated particle document
    // is dirty — which the old single-registry gate avoided only by not knowing about it.
    parkAsPanel(TEX, { id: 'tex-guid' });
    markAssetDirty('/a.mat.json', 'material', { id: 'm' });

    const r = await resolve({ paths: [TEX, '/a.mat.json'], registries: ['pendingMeta'] });

    expect(pathsIn(r, 'pendingMeta')).toEqual([TEX]);
    expect(pathsIn(r, 'dirtyAsset'), 'not asked about, so not reported').toEqual([]);
    expect(r.covers, 'the caller checks this BEFORE reading holds as an answer').toEqual(['pendingMeta']);
  });

  it('`covers` is ALWAYS present, including on a clean answer', async () => {
    // ⚠️ The skew guard. Node treats a reply whose `covers` omits an asked-for registry as
    // `unknown` and refuses, because a renderer that answers without implementing a registry is
    // otherwise indistinguishable from one reporting "all clear". An op that sent `covers` only
    // when something was held would make every clean call look like a skewed renderer.
    const r = await resolve({ paths: [MODEL] });
    expect(r.holds).toEqual([]);
    expect(r.covers).toEqual(['dirtyAsset', 'pendingMeta', 'pendingBaseScene', 'liveScene']);
  });

  it('one path dirty two ways gets one row per REGISTRY, never a duplicate', async () => {
    // Two causes map to `liveScene`. A path that is both the primary scene and a dirty base must
    // not produce two rows, or every count and every disclosure downstream is doubled.
    markSceneDirty('scene-guid-1');
    const r = await resolve({});
    expect((r.holds ?? []).filter((h) => h.registry === 'liveScene')).toHaveLength(1);
  });

  it('a malformed call is refused, and the refusal lists what IS held', async () => {
    // The `set_selection` lesson: a destructive-adjacent op whose bare call means "everything" is
    // one misspelled argument key away from doing it. `{}` is now a legitimate global probe, so
    // the shapes that stay refused are the ones that MEANT to name paths and got it wrong — §5.
    parkAsPanel(TEX, { id: 'tex-guid' });
    await expect(resolve({ paths: [] })).rejects.toThrow(new RegExp(TEX.replace(/\//g, '\\/')));
    await expect(resolve({ paths: [''] })).rejects.toThrow(/requires \{ paths/);
    await expect(resolve({ paths: TEX })).rejects.toThrow(/requires \{ paths/);
  });

  it('RECORDS NOTHING — the probe cannot seed a baseline, nor make a failed-read document parkable', async () => {
    // The defect this pins is the one `read-asset-meta`'s own review caught and fixed with
    // `passive`: an agent-side read that seeds the CAS baseline makes a stale parked edit ACCEPTED
    // where it was correctly refused. A gate has more power to do that than a read, not less.
    expect(peekMetaBaseline(TEX), 'precondition: no baseline for this path').toBeUndefined();
    markAssetDirty('/a.mat.json', 'material', { id: 'm' });

    await resolve({ paths: [TEX, '/a.mat.json'] });

    expect(peekMetaBaseline(TEX)).toBeUndefined();
    // …and nothing was consumed from the other registries either. `unsavedChangeCauses()` reads
    // every one of them, so the passive property now has four subjects rather than one.
    expect(peekDirtyAsset('/a.mat.json'), 'looking must not consume').not.toBeNull();
  });
});

describe('resolve-unsaved — the discard', () => {
  it('drops state only when asked, and reports what actually went', async () => {
    parkAsPanel(TEX, { id: 'tex-guid', texture: { maxSize: 256 } });

    // Probing does not discard. This is the accept side of the discard flag: a gate that dropped
    // the park just by looking would destroy the human's edit on every refusal it issued.
    await resolve({ paths: [TEX] });
    expect(peekPendingMeta(TEX)).toBeDefined();

    const r = await resolve({ paths: [TEX], discard: ['pendingMeta'] });
    expect(pathsIn(r, 'pendingMeta')).toEqual([TEX]);
    expect((r.discarded ?? []).map((h) => h.path)).toEqual([TEX]);
    expect(peekPendingMeta(TEX)).toBeUndefined();
    expect(getPendingMetaPaths()).toEqual([]);
  });

  it('the discard is SCOPED — it cannot reach a registry the caller did not name', async () => {
    // ⚠️ The over-reach a shared probe makes possible and the old one could not: `discardUnsaved`
    // on a sidecar route must not throw away a dirty material document it never asked about.
    parkAsPanel(TEX, { id: 'tex-guid' });
    markAssetDirty('/a.mat.json', 'material', { id: 'm' });

    await resolve({ paths: [TEX, '/a.mat.json'], discard: ['pendingMeta'] });

    expect(peekPendingMeta(TEX)).toBeUndefined();
    expect(peekDirtyAsset('/a.mat.json'), 'a different registry, never asked for').not.toBeNull();
  });

  it('discards only the paths asked about, never the whole registry', async () => {
    parkAsPanel(TEX, { id: 'tex-guid' });
    parkAsPanel(MODEL, { id: 'model-guid' });

    await resolve({ paths: [TEX], discard: ['pendingMeta'] });

    expect(peekPendingMeta(TEX)).toBeUndefined();
    expect(peekPendingMeta(MODEL)).toBeDefined();
  });

  it('REFUSES to discard liveScene, and names the real exit', async () => {
    // ⚠️ Dropping live-world edits means RELOADING the scene — `load_scene {discardUnsaved}`'s job.
    // A second way to do it does not belong in a probe, and the refusal has to name the first way
    // or it is a wedge (§5).
    markSceneDirty('scene-guid-1');
    await expect(resolve({ discard: ['liveScene'] })).rejects.toThrow(/load_scene|reloading the scene/i);
  });

  it('a discard of an unheld path is a no-op, not an error', async () => {
    const r = await resolve({ paths: [MODEL], discard: ['pendingMeta'] });
    expect(r.holds).toEqual([]);
    expect(r.discarded).toEqual([]);
  });

  it('every discardable registry really discards — pendingBaseScene included', async () => {
    // The one most likely to be wired up wrong, because it is the registry `applyAssetPathMoves`
    // still does not remap and the one no earlier gate ever touched.
    markBaseSceneEdit('/lvl.scene.json', '/base.scene.json');
    await resolve({ discard: ['pendingBaseScene'] });
    expect(peekBaseSceneEdit('/lvl.scene.json')).toBeUndefined();
  });

  it('an agent discard does not make a failed-read document parkable', async () => {
    // Written as "leaves readFailed ARMED after a discard" when the guard was a path-keyed flag.
    // #880 moved it onto the fallback DOCUMENT, so the discard cannot reach it by construction —
    // but the test still earns its place as the regression guard for anyone wiring provenance into
    // the discard path.
    parkAsPanel(TEX, { id: 'tex-guid', texture: { maxSize: 256 } });

    await resolve({ paths: [TEX], discard: ['pendingMeta'] });

    expect(peekPendingMeta(TEX)).toBeUndefined();
    // ⚠️ The ACCEPT side, which is the half this op can actually get wrong: a document from a GOOD
    // read still parks after the discard.
    parkAsPanel(TEX, { id: 'tex-guid', texture: { maxSize: 128 } });
    expect(peekPendingMeta(TEX)).toEqual(stampMetaReadPath({ id: 'tex-guid', texture: { maxSize: 128 } }, TEX));
  });
});

describe('discard-asset-edits does not silently imply it cleared the sidecar registry too', () => {
  it('reports a parked import-settings edit it did NOT discard', async () => {
    // `all:true` reads as a clean slate and is not one: this op owns the DIRTY-ASSET registry, and
    // a parked `.meta.json` edit survives it untouched. An agent that then re-imports still bakes
    // against the human's unsaved settings (#882) — a false success, which §0 ranks worst.
    parkAsPanel(TEX, { id: 'tex-guid', texture: { maxSize: 256 } });

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
