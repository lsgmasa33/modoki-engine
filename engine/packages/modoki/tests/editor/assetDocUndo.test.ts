/** #1710 — an asset-document undo/redo checks the asset still holds its own side before moving it, and the save
 *  after it is conditional on the file it checked.
 *
 *  Runs against a fake backend that holds each file's REAL BYTES: a GET serves them, and `/api/asset-write` applies
 *  the route's own `ifMatch` rule (sha256 of the current bytes, BOM stripped) before writing and answers with the
 *  sha256 of what it wrote — the same contract `editorBackendRouter.ts` keeps. Every "left as it is" assertion
 *  compares the file's bytes, not a doc a helper re-serialised.
 *
 *  Each asset kind is driven through the entry its panel actually pushes: `assetDocAction` with that kind's real
 *  `apply` (`persistAssetEdit` for the Inspector views, the editor store's `apply*Def` for the editors), and the rig
 *  through `skinDocAction` itself. That every panel site IS built this way is `assetUndoIsFileDirect.test.ts`'s. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { assetDocAction, runAssetDocStep, captureAssetDocBaseline, sameAssetDoc } from '../../src/editor/undo/assetDocUndo';
import { UndoRefusedError } from '../../src/editor/undo/undoFailure';
import {
  clearDirtyAssets, peekDirtyAsset, markAssetDirty, flushDirtyAssets, getDirtyAssetPaths, discardDirtyAssets,
  assetCacheDiverged, remapFlushedAssetRecords,
} from '../../src/editor/scene/dirtyAssets';
import { pushAction, redo, undoStep, clearHistory, canUndo } from '../../src/editor/undo/undoManager';
import { useEditorStore } from '../../src/editor/store/editorStore';
import {
  persistAssetEdit, invalidateMaterialFile, invalidateAnimSetFile, invalidateShaderFile,
} from '../../src/editor/panels/assetViews/persist';
import { skinDocAction } from '../../src/editor/panels/skinDocAction';
import type { AssetSchemaType } from '../../src/runtime/assets/assetSchemas';
import type { UndoAction } from '../../src/editor/undo/undoManager';
import { setRunMode } from '../../src/runtime/core/playState';

// ── The fake backend: path → bytes ──
const disk = new Map<string, Uint8Array>();
const writes: string[] = [];
const sha = (b: Uint8Array) => createHash('sha256').update(b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? b.subarray(3) : b).digest('hex');
const bytesOf = (doc: unknown) => new TextEncoder().encode(JSON.stringify(doc, null, 2) + '\n');
const fileText = (p: string) => (disk.has(p) ? new TextDecoder().decode(disk.get(p)) : null);
/** A write the editor did not make — git, another clone, a hand edit. */
const outsideWrite = (p: string, doc: unknown) => { disk.set(p, bytesOf(doc)); };

function installBackend() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/asset-write')) {
      const { path, data, ifMatch } = JSON.parse(String(init?.body)) as { path: string; data: unknown; ifMatch?: string };
      const held = writeGates.get(path);
      if (held) writeGates.delete(path);
      if (held && !held.landFirst) await held.gate; // in flight: nothing on disk yet
      const cur = disk.get(path);
      if (ifMatch !== undefined && (!cur || sha(cur) !== ifMatch)) {
        return new Response(JSON.stringify({ ok: false, conflict: true, error: `${path} changed on disk (if-match)` }), { status: 409 });
      }
      const out = bytesOf(data);
      disk.set(path, out);
      writes.push(path);
      if (held?.landFirst) await held.gate; // the bytes are on disk; the response is not back yet
      return new Response(JSON.stringify({ ok: true, sha256: sha(out) }), { status: 200 });
    }
    const path = [...disk.keys()].find((p) => url.endsWith(p));
    if (path) readHooks.get(path)?.();
    const early = path ? disk.get(path) : undefined; // what a read sees when it is SERVED at request time
    const gate = path ? gates.get(path) : undefined;
    if (gate) { gates.delete(path!); await gate.wait; } // held: by default it sees the disk as it is when RELEASED
    if (gate?.stale && early) return new Response(early.slice().buffer as ArrayBuffer, { status: 200 });
    return path && disk.has(path)
      ? new Response(disk.get(path)!.slice().buffer as ArrayBuffer, { status: 200 })
      : new Response('not found', { status: 404 });
  }) as typeof fetch;
}

/** Hold the next GET of `path` until the returned release is called — a read the dev server serves late. */
const gates = new Map<string, { wait: Promise<void>; stale: boolean }>();
/** Run on every GET of a path, before it is served. */
const readHooks = new Map<string, () => void>();
/** Hold the next `/api/asset-write` of `path`: before it writes (in flight), or — `landFirst` — after the bytes land
 *  but before the response returns. */
const writeGates = new Map<string, { gate: Promise<void>; landFirst: boolean }>();
const holdNextWrite = (path: string, landFirst = false) => { let release!: () => void; writeGates.set(path, { gate: new Promise<void>((r) => { release = r; }), landFirst }); return release; };
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
/** `stale`: the read returns the bytes as they were when it was REQUESTED, however late it is delivered. */
const holdNextRead = (path: string, stale = false) => { let release!: () => void; gates.set(path, { wait: new Promise<void>((r) => { release = r; }), stale }); return release; };

const origFetch = globalThis.fetch;
beforeEach(() => { setRunMode('stopped'); gates.clear(); readHooks.clear(); writeGates.clear(); disk.clear(); writes.length = 0; clearDirtyAssets(); clearHistory(); installBackend(); });
afterEach(() => { globalThis.fetch = origFetch; clearDirtyAssets(); clearHistory(); vi.restoreAllMocks(); });

// ── One entry per asset kind, built the way its panel builds it ──
type Kind = { type: AssetSchemaType; path: string; build: (label: string, before: object, after: object) => UndoAction };
const store = () => useEditorStore.getState();
const viaFactory = (type: AssetSchemaType, path: string, apply: (d: never) => void): Kind => ({
  type, path, build: (label, before, after) => assetDocAction<object>({ label, path, type, before, after: () => after, apply: (d) => apply(d as never) }),
});
const KINDS: Kind[] = [
  viaFactory('material', '/assets/m.mat.json', (d) => persistAssetEdit('/assets/m.mat.json', 'material', d, invalidateMaterialFile)),
  viaFactory('animset', '/assets/a.animset.json', (d) => persistAssetEdit('/assets/a.animset.json', 'animset', d, invalidateAnimSetFile)),
  viaFactory('shader', '/assets/s.shader.json', (d) => persistAssetEdit('/assets/s.shader.json', 'shader', d, invalidateShaderFile)),
  viaFactory('particle', '/assets/p.particle.json', (d) => store().applyParticleDef('/assets/p.particle.json', d)),
  viaFactory('animation', '/assets/c.anim.json', (d) => store().applyAnimationClip('/assets/c.anim.json', d)),
  viaFactory('timeline', '/assets/t.timeline.json', (d) => store().applyTimelineDoc('/assets/t.timeline.json', d)),
  viaFactory('spriteanim', '/assets/s.spriteanim.json', (d) => store().applySpriteAnimDef('/assets/s.spriteanim.json', d)),
  { type: 'rig2d', path: '/assets/r.rig2d.json', build: (label, before, after) => skinDocAction(label, '/assets/r.rig2d.json', before as never, after as never) },
];

const D0 = { id: 'g-1', tint: 'white', roughness: 0.5 };
const D1 = { id: 'g-1', tint: 'red', roughness: 0.5 };
const D2 = { id: 'g-1', tint: 'red', roughness: 0.9 };
const X = { id: 'g-1', tint: 'blue', roughness: 0.1 };

/** The panel's forward edit: the entry is built (baseline taken), THEN the edit parks — the order every site keeps. */
async function edit(k: Kind, before: object, after: object): Promise<UndoAction> {
  const action = k.build('tint', before, after);
  markAssetDirty(k.path, k.type, after, 'panel');
  await Promise.resolve();
  return action;
}
const save = async () => flushDirtyAssets();
const refusal = async (step: () => void | Promise<void>) => {
  try { await step(); } catch (e) { return e; }
  return null;
};

describe.each(KINDS)('#1710 asset-doc undo/redo — $type', (k) => {
  it('undo REFUSES after the asset was saved from elsewhere since — the later edit survives on disk', async () => {
    disk.set(k.path, bytesOf(D0));
    const tint = await edit(k, D0, D1);
    await save(); // Save All: disk = D1
    markAssetDirty(k.path, k.type, D2, 'panel'); // S2 changes roughness…
    await save(); // …and saves it: disk = D2
    const onDisk = fileText(k.path);
    const e = await refusal(() => tint.undo());
    expect(e).toBeInstanceOf(UndoRefusedError);
    expect(fileText(k.path)).toBe(onDisk);
    expect(peekDirtyAsset(k.path)).toBeNull(); // nothing parked for the next save to write
  });

  it('undo REFUSES when the parked doc was replaced by an edit from another history — the park is left as it is', async () => {
    disk.set(k.path, bytesOf(D0));
    const tint = await edit(k, D0, D1);
    markAssetDirty(k.path, k.type, D2, 'panel'); // another scene's entry edits the same asset, unsaved
    expect(await refusal(() => tint.undo())).toBeInstanceOf(UndoRefusedError);
    expect(peekDirtyAsset(k.path)?.data).toEqual(D2);
  });

  it('undo REFUSES after an outside write to the saved file (agent write_asset, git checkout)', async () => {
    disk.set(k.path, bytesOf(D0));
    const tint = await edit(k, D0, D1);
    await save();
    outsideWrite(k.path, X);
    expect(await refusal(() => tint.undo())).toBeInstanceOf(UndoRefusedError);
    expect(fileText(k.path)).toBe(new TextDecoder().decode(bytesOf(X)));
    expect(peekDirtyAsset(k.path)).toBeNull();
  });

  it('redo REFUSES after an outside write to the file the undo left clean', async () => {
    disk.set(k.path, bytesOf(D0));
    const tint = await edit(k, D0, D1);
    await tint.undo(); // back to the file's own doc → the park is discarded, nothing to save
    expect(peekDirtyAsset(k.path)).toBeNull();
    outsideWrite(k.path, X);
    expect(await refusal(() => tint.redo())).toBeInstanceOf(UndoRefusedError);
    expect(peekDirtyAsset(k.path)).toBeNull();
  });

  it('redo REFUSES when another edit replaced the doc the undo parked', async () => {
    disk.set(k.path, bytesOf(D0));
    const tint = await edit(k, D0, D1);
    await save();
    await tint.undo(); // parks D0 over the saved D1
    markAssetDirty(k.path, k.type, X, 'panel');
    expect(await refusal(() => tint.redo())).toBeInstanceOf(UndoRefusedError);
    expect(peekDirtyAsset(k.path)?.data).toEqual(X);
  });

  it('ACCEPTS the ordinary round trip — edit, save, undo, save, redo, save — and the file follows each step', async () => {
    disk.set(k.path, bytesOf(D0));
    const tint = await edit(k, D0, D1);
    await save();
    expect(fileText(k.path)).toBe(new TextDecoder().decode(bytesOf(D1)));
    await tint.undo();
    expect(sameAssetDoc(peekDirtyAsset(k.path)?.data, D0)).toBe(true);
    await save();
    expect(fileText(k.path)).toBe(new TextDecoder().decode(bytesOf(D0)));
    await tint.redo();
    await save();
    expect(fileText(k.path)).toBe(new TextDecoder().decode(bytesOf(D1)));
  });

  it('an undo back to the file\'s own doc reads CLEAN (the park is discarded), and its redo re-parks', async () => {
    disk.set(k.path, bytesOf(D0));
    const tint = await edit(k, D0, D1);
    await tint.undo();
    expect(getDirtyAssetPaths()).not.toContain(k.path);
    await tint.redo();
    expect(peekDirtyAsset(k.path)?.data).toEqual(D1);
  });

  it('two unsaved edits, undo the second — the first stays PARKED (the file never held it)', async () => {
    disk.set(k.path, bytesOf(D0));
    await edit(k, D0, D1); // parked, not saved
    const rough = await edit(k, D1, D2); // recorded while D1 was parked: the file holds D0, not this entry's `before`
    await rough.undo();
    // A baseline taken now would name the D0 bytes as "the file holds D1", and the undo would DISCARD D1 as saved.
    expect(peekDirtyAsset(k.path)?.data).toEqual(D1);
  });

  it('save, edit, undo, undo — the second undo still knows the saved bytes after the first discarded its park', async () => {
    disk.set(k.path, bytesOf(D0));
    const tint = await edit(k, D0, D1);
    await save(); // disk = D1
    const rough = await edit(k, D1, D2);
    await rough.undo(); // back to the saved D1 → the park is DISCARDED
    expect(peekDirtyAsset(k.path)).toBeNull();
    await tint.undo(); // expects D1: the flushed-write record must have survived that discard
    expect(sameAssetDoc(peekDirtyAsset(k.path)?.data, D0)).toBe(true);
  });

  it('undo → outside write → save: the save is REFUSED, the outside bytes survive, and the failure names the file', async () => {
    disk.set(k.path, bytesOf(D0));
    const tint = await edit(k, D0, D1);
    await save();
    await tint.undo(); // accepted: parks D0, conditional on the D1 bytes it checked
    outsideWrite(k.path, X);
    const r = await save();
    expect(r.failed.map((f) => f.path)).toEqual([k.path]);
    expect(fileText(k.path)).toBe(new TextDecoder().decode(bytesOf(X)));
    expect(peekDirtyAsset(k.path)?.data).toEqual(D0); // kept parked — reported, not dropped
  });
});

describe('#1710 — a batch step (MaterialBatchView) is all-or-nothing', () => {
  it('refuses the WHOLE step when one member changed since, and moves none of them', async () => {
    const [a, b] = ['/assets/a.mat.json', '/assets/b.mat.json'];
    disk.set(a, bytesOf(D0)); disk.set(b, bytesOf(D0));
    const baselines = { [a]: captureAssetDocBaseline(a, D0), [b]: captureAssetDocBaseline(b, D0) };
    markAssetDirty(a, 'material', D1, 'panel'); markAssetDirty(b, 'material', D1, 'panel');
    const applied: string[] = [];
    const undoBatch = () => runAssetDocStep([a, b].map((p) => ({
      path: p, type: 'material' as const, baseline: baselines[p], expected: () => D1, target: () => D0,
    })), (p) => { applied.push(p); }, 'panel');
    markAssetDirty(b, 'material', D2, 'panel'); // b edited elsewhere
    expect(await refusal(undoBatch)).toBeInstanceOf(UndoRefusedError);
    expect(applied).toEqual([]);
    expect(peekDirtyAsset(a)?.data).toEqual(D1);
    expect(peekDirtyAsset(b)?.data).toEqual(D2);
  });
});

describe('#1710 — through the undo manager', () => {
  it('a refused asset-doc undo is dropped from the history, toasted as a refusal, and changes nothing', async () => {
    const k = KINDS[0];
    disk.set(k.path, bytesOf(D0));
    const tint = await edit(k, D0, D1);
    pushAction(tint);
    await save();
    outsideWrite(k.path, X);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await undoStep('undo')).failed).toMatchObject({ refused: true });
    expect(errors.mock.calls.some((c) => String(c[0]).includes('REFUSED'))).toBe(true);
    expect(useEditorStore.getState().toast?.message ?? '').toMatch(/refused: m\.mat\.json changed since/);
    expect(canUndo()).toBe(false);
    await redo(); // and it is not on the redo stack either
    expect(fileText(k.path)).toBe(new TextDecoder().decode(bytesOf(X)));
    expect(peekDirtyAsset(k.path)).toBeNull();
  });

  it('undo of a DISCARDED edit is accepted — the file already holds its target, so it moves only the cache back', async () => {
    // `discardDirtyAssets` drops the pending write but leaves the live cache on the edit. Refusing here (the first
    // version did) stranded the cache on a doc no save writes and no undo reaches (#1710 close-out review).
    const p = '/assets/d.particle.json';
    disk.set(p, bytesOf(D0));
    const cache: unknown[] = [];
    const tint = assetDocAction({ label: 'tint', path: p, type: 'particle', before: D0, after: () => D1, apply: (d) => { cache.push(d); } });
    markAssetDirty(p, 'particle', D1, 'panel');
    await Promise.resolve();
    discardDirtyAssets([p], { cacheKeepsEdit: true }); // the agent op's discard: the cache stays on D1
    await tint.undo();
    expect(cache).toEqual([D0]); // the cache MOVED back to the file — the point of accepting
    expect(peekDirtyAsset(p)).toBeNull();
    expect(fileText(p)).toBe(new TextDecoder().decode(bytesOf(D0)));
  });

  it('a discard that keeps the cache on the edit gives the NEXT edit no baseline — the file does not hold its `before`', async () => {
    // File D0; E1 D0→D1; discard (cache D1, file D0); E2 D1→D2. A baseline for E2 would name D0's bytes "D1", and
    // undoing E2 would discard its park as saved: cache D1, file D0, clean (#1710 close-out review).
    const k = KINDS[3];
    disk.set(k.path, bytesOf(D0));
    await edit(k, D0, D1);
    discardDirtyAssets([k.path], { cacheKeepsEdit: true });
    const e2 = await edit(k, D1, D2);
    await e2.undo();
    expect(peekDirtyAsset(k.path)?.data).toEqual(D1); // parked, for the next save to write
  });

  it('a save ends the divergence — the next edit gets its baseline back, so its undo reads clean again', async () => {
    const k = KINDS[3];
    disk.set(k.path, bytesOf(D0));
    await edit(k, D0, D1);
    discardDirtyAssets([k.path], { cacheKeepsEdit: true }); // cache D1, file D0
    await edit(k, D1, D2);
    await save(); // file D2: the editor wrote it from its own state
    outsideWrite(k.path, X); // the watcher reloads the cache to the file — cache and file agree again
    const e3 = await edit(k, X, D1);
    await e3.undo(); // back to X, which only e3's baseline knows the file holds
    expect(peekDirtyAsset(k.path)).toBeNull();
  });

  it('an undo while a SAVE of the asset is in flight waits for it, then reads the saved file (#1710 close-out review)', async () => {
    // Read mid-flight, the step saw D0, discarded its D1 park as "the file holds the target", and the flush then
    // landed D1: editor D0, disk D1, reported clean.
    const p = '/assets/f.particle.json';
    disk.set(p, bytesOf(D0));
    // The baseline has SETTLED (it names D0's bytes) before the save starts — so the only thing that can stop the step
    // discarding its park is the wait itself, not a voided baseline.
    const baseline = captureAssetDocBaseline(p, D0);
    expect(await baseline.diskHash).not.toBeNull();
    const cache: unknown[] = [];
    const tint = assetDocAction({ label: 'tint', path: p, type: 'particle', before: D0, after: () => D1, apply: (d) => { cache.push(d); }, baseline });
    markAssetDirty(p, 'particle', D1, 'panel');
    const release = holdNextWrite(p);
    const saving = save();
    await tick();
    const undoing = tint.undo();
    await tick();
    release();
    await saving;
    await undoing;
    expect(fileText(p)).toBe(new TextDecoder().decode(bytesOf(D1)));
    expect(sameAssetDoc(peekDirtyAsset(p)?.data, D0)).toBe(true); // the undo is parked, for the next save to write
    expect(cache).toEqual([D0]);
  });

  it('two OVERLAPPING saves: the undo waits for the second too (#1710 review 3)', async () => {
    // One slot per path let the first flush's settle clear it while the second was still writing: the step read D1
    // mid-flight, matched the first flush's record, discarded its park — disk D2, cache D1, clean.
    const p = '/assets/o.particle.json';
    disk.set(p, bytesOf(D0));
    markAssetDirty(p, 'particle', D1, 'panel');
    const release1 = holdNextWrite(p);
    const f1 = flushDirtyAssets();
    await tick();
    const cache: unknown[] = [];
    const e2 = assetDocAction({ label: 'rough', path: p, type: 'particle', before: D1, after: () => D2, apply: (d) => { cache.push(d); } });
    markAssetDirty(p, 'particle', D2, 'panel');
    const release2 = holdNextWrite(p);
    const f2 = flushDirtyAssets(); // an agent save_all during the human's Cmd+S — no shared latch
    await tick();
    release1();
    await f1;
    const undoing = e2.undo();
    await tick();
    release2();
    await f2;
    await undoing;
    expect(fileText(p)).toBe(new TextDecoder().decode(bytesOf(D2)));
    expect(sameAssetDoc(peekDirtyAsset(p)?.data, D1)).toBe(true);
    expect(cache).toEqual([D1]);
  });

  it('a save that STARTS while the step is reading makes it read again — the stale bytes do not decide (#1710 review 3)', async () => {
    const p = '/assets/r.particle.json';
    disk.set(p, bytesOf(D0));
    const baseline = captureAssetDocBaseline(p, D0);
    await baseline.diskHash;
    const tint = assetDocAction({ label: 'tint', path: p, type: 'particle', before: D0, after: () => D1, apply: () => {}, baseline });
    markAssetDirty(p, 'particle', D1, 'panel');
    const release = holdNextRead(p, true); // the step's read is served D0's bytes…
    const undoing = tint.undo();
    await tick();
    await save(); // …while a save lands D1 and drops the park
    release();
    await undoing; // one read alone would see D0's bytes with nothing parked: "not D1" → refused
    expect(sameAssetDoc(peekDirtyAsset(p)?.data, D0)).toBe(true);
  });

  it('a step whose asset keeps being saved under every read REFUSES after three tries', async () => {
    const p = '/assets/s.particle.json';
    disk.set(p, bytesOf(D0));
    const tint = assetDocAction({ label: 'tint', path: p, type: 'particle', before: D0, after: () => D1, apply: () => {} });
    markAssetDirty(p, 'particle', D1, 'panel');
    await tick();
    readHooks.set(p, () => { markAssetDirty(p, 'particle', D1, 'panel'); void flushDirtyAssets(); });
    const e = await refusal(() => tint.undo());
    expect(e).toBeInstanceOf(UndoRefusedError);
    expect((e as UndoRefusedError).message).toMatch(/kept being saved/);
  });

  it('undoing a DISCARDED edit ends the divergence — the next edit\'s undo reads clean (#1710 review 3)', async () => {
    const p = '/assets/v.particle.json';
    disk.set(p, bytesOf(D0));
    const e1 = assetDocAction({ label: 'e1', path: p, type: 'particle', before: D0, after: () => D1, apply: () => {} });
    markAssetDirty(p, 'particle', D1, 'panel');
    await tick();
    discardDirtyAssets([p], { cacheKeepsEdit: true });
    expect(assetCacheDiverged(p)).toBe(true);
    await e1.undo(); // the cache moves back to the file's D0
    expect(assetCacheDiverged(p)).toBe(false);
    const e2 = assetDocAction({ label: 'e2', path: p, type: 'particle', before: D0, after: () => D2, apply: () => {} });
    markAssetDirty(p, 'particle', D2, 'panel');
    await tick();
    await e2.undo();
    expect(peekDirtyAsset(p)).toBeNull();
  });

  it('a MOVE carries the divergence to the new path, and leaves none behind at the old one', () => {
    const [a, b] = ['/assets/a1.particle.json', '/assets/b1.particle.json'];
    markAssetDirty(a, 'particle', D1, 'panel');
    discardDirtyAssets([a], { cacheKeepsEdit: true });
    remapFlushedAssetRecords((p) => (p === a ? b : undefined));
    expect([assetCacheDiverged(a), assetCacheDiverged(b)]).toEqual([false, true]);
  });

  it('the write epoch moves BEFORE the request — a baseline read served after the bytes land, before the reply, is dropped', async () => {
    const k = KINDS[3];
    disk.set(k.path, bytesOf(D0));
    const releaseRead = holdNextRead(k.path);
    const tint = k.build('tint', D0, D1); // baseline read goes out, held
    markAssetDirty(k.path, k.type, D1, 'panel');
    const releaseReply = holdNextWrite(k.path, true);
    const saving = save();
    await tick(); // D1's bytes are on disk; the reply is held
    releaseRead(); // the baseline read is served now: it sees D1
    await tick();
    releaseReply();
    await saving;
    await tint.undo();
    expect(sameAssetDoc(peekDirtyAsset(k.path)?.data, D0)).toBe(true);
  });

  it('a save that lands before the baseline READ does not pass off the saved bytes as `before` (#1710 close-out review)', async () => {
    // Record (the read goes out, served late) → park → Save All writes D1 → the read returns D1's bytes. Kept as "the
    // file holds D0", it made the undo DISCARD its D0 park as already saved: cache D0, file D1, reported clean.
    const k = KINDS[3];
    disk.set(k.path, bytesOf(D0));
    const release = holdNextRead(k.path);
    const tint = k.build('tint', D0, D1);
    markAssetDirty(k.path, k.type, D1, 'panel');
    await save(); // disk = D1
    release();
    await Promise.resolve();
    await tint.undo();
    expect(sameAssetDoc(peekDirtyAsset(k.path)?.data, D0)).toBe(true); // parked, for the next save to write
  });
});

describe('#1710 — a rig canvas GESTURE takes its baseline at pointer-down', () => {
  it('the live rig is parked mid-drag, so only the pointer-down baseline can vouch for the file on redo', async () => {
    const p = '/assets/r.rig2d.json';
    disk.set(p, bytesOf(D0));
    const early = captureAssetDocBaseline(p, D0); // pointer-down: nothing parked yet
    markAssetDirty(p, 'rig2d', D1, 'panel'); // pointer-move: the panel parks the live rig
    const drag = skinDocAction('rig2d move part', p, D0 as never, D1 as never, early); // pointer-up
    await drag.undo();
    discardDirtyAssets([p]); // the open panel drops the park: the doc is back to its saved baseline
    await drag.redo(); // expects D0, which only the early baseline knows the file holds
    expect(peekDirtyAsset(p)?.data).toEqual(D1);
  });
});

describe('sameAssetDoc — what "holds" compares', () => {
  it('ignores key order and undefined members (JSON\'s own rules), and nothing else', () => {
    expect(sameAssetDoc({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 })).toBe(true);
    expect(sameAssetDoc({ a: 1, u: undefined }, { a: 1 })).toBe(true);
    expect(sameAssetDoc({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(sameAssetDoc({ a: 1 }, { a: '1' })).toBe(false);
  });
});
