/** The park gate on the three Node routes that touch a `.meta.json` (#872/#882).
 *
 *  `pendingMeta` lives in the RENDERER. Every sidecar access that runs in the Node backend is
 *  blind to it, and only two routes had ever asked the renderer back — which is why this defect
 *  arrived one route at a time:
 *
 *  - `/api/write-meta` replaces the sidecar wholesale, so it **DESTROYS** a parked Inspector
 *    import-settings edit (and the park then flushes back over the write — both directions lose
 *    work). Hatch: `discardUnsaved`.
 *  - `/api/reimport` reads the sidecar off disk to know what to convert with, so the bake would use
 *    the **PRE-EDIT** values. Hatch: `force` — the human's edit is left alone, merely not used.
 *  - `/api/duplicate-asset` seeds the copy's sidecar from the source's file, same consequence.
 *
 *  ⚠️ **The single most load-bearing case in this file is the TIMEOUT one.** The gate asks the
 *  renderer over a relay that rejects on timeout, and "the renderer did not answer" is not "there
 *  is no park" (`docs/mcp-tool-conventions.md` §5). A gate that read a timeout as `clear` would be
 *  the #872 defect rebuilt inside its own fix, and it would be invisible: every test that stubs a
 *  *working* renderer passes either way. So both halves of the classifier are pinned here — a
 *  definitively-absent renderer PROCEEDS (there is no renderer, so there is no park), a silent one
 *  REFUSES.
 *
 *  Every refusal is asserted together with the disk staying untouched, and every accept case is
 *  asserted too: proving a guard refuses never proves it accepts, and the accept side is what stops
 *  the next author deleting a "spurious" gate.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';
import {
  handleBackendRequest, isRelayTransportFailure, isRelayTimeout,
  type BackendContext, type Manifest,
} from '../../plugins/backend/editorBackendRouter';
import { registerReimportHandler } from '../../plugins/reimport-registry';

let projectRoot = '';

/** What the stub renderer did, so a test can assert the gate asked the right question. */
let asked: Array<{ op: string; params: unknown }> = [];

type RendererStub = (op: string, params: unknown) => unknown;

/** The renderer answers normally, reporting exactly `parked` as held in `pendingMeta`.
 *
 *  ⚠️ Speaks the #889 `resolve-unsaved` shape — per-path/per-registry `holds` rows plus the
 *  MANDATORY `covers`. A stub that omitted `covers` would be treated as a skewed renderer and
 *  answer `unknown`, which is the behaviour that field exists to produce. */
const rendererWithParks = (parked: string[]): RendererStub => (op, params) => {
  if (op !== 'resolve-unsaved') return {};
  const p = (params ?? {}) as { paths?: string[]; registries?: string[]; discard?: string[] };
  const covers = p.registries ?? ['dirtyAsset', 'pendingMeta', 'pendingBaseScene', 'liveScene'];
  // This stub models `pendingMeta` ONLY, which is what these four routes ask about — except
  // duplicate-asset, which asks about all four and gets a truthful "nothing in the other three".
  const hit = covers.includes('pendingMeta') ? (p.paths ?? []).filter((x) => parked.includes(x)) : [];
  const holds = hit.map((path) => ({ path, registry: 'pendingMeta', detail: 'unsaved import settings' }));
  return {
    ok: true,
    holds,
    discarded: p.discard?.includes('pendingMeta') ? holds : [],
    covers,
  };
};

/** A SECOND page is connected that does not have the editor ops — the dev server's runtime route,
 *  a very ordinary thing to have open. `ws.send` broadcasts and the request registry is
 *  first-reply-wins, so this page can answer before the editor tab that actually holds the park.
 *
 *  ⚠️ **That race is CLOSED as of #1030** — the relay counts declines and settles on the first
 *  AUTHORITATIVE reply. These cases are KEPT and their assertions are unchanged: the guard must
 *  fail closed on `unknown agent op` whatever the transport does, and that is what they pin. Read
 *  the premise as "the guard does not depend on the transport", not as a live race. */
const rendererWithoutEditorOps: RendererStub = () => { throw new Error("unknown agent op 'resolve-unsaved'"); };

/** The renderer is definitively GONE — Electron rejects synchronously when the window is closed,
 *  and the Vite host says the socket is not ready. Either way there is no registry to hold a park. */
const rendererAbsent: RendererStub = () => { throw new Error('no editor renderer window'); };

/** The renderer may well be attached and it did not answer in the window — mid-scene-load, a GLB
 *  parse, a shader compile. This is the ambiguous case that must NOT be read as "nothing parked". */
const rendererSilent: RendererStub = () => { throw new Error('timed out waiting for the renderer'); };

function makeCtx(renderer: RendererStub, manifest: Manifest = { version: 2, assets: [] }): BackendContext {
  return {
    projectRoot,
    editorRoot: projectRoot,
    resolveAssetPath: (p: string) => path.join(projectRoot, p.replace(/^\//, '')),
    absToAssetUrl: (p: string) => p,
    firstRootDir: () => null,
    getManifest: () => manifest,
    rebuildManifest: () => manifest,
    requestBrowser: async (op: string, params: unknown) => { asked.push({ op, params }); return renderer(op, params); },
    getSchema: () => undefined,
    markEditorWrite: () => {},
    ssrLoadModule: async () => ({}),
    invalidateProjectConfig: () => {},
  } as unknown as BackendContext;
}

const post = (urlPath: string, body: unknown, ctx: BackendContext) =>
  handleBackendRequest(ctx, { method: 'POST', urlPath, query: new URLSearchParams(), body }) as
    Promise<{ status?: number; body: Record<string, unknown> }>;

const ASSET = '/rock.png';
const assetAbs = () => path.join(projectRoot, 'rock.png');
const metaAbs = () => `${assetAbs()}.meta.json`;
const readMeta = () => JSON.parse(fs.readFileSync(metaAbs(), 'utf-8')) as Record<string, unknown>;

function seed(meta: Record<string, unknown> = { id: 'rock-guid', version: 1, texture: { maxSize: 2048 } }) {
  fs.writeFileSync(assetAbs(), 'not-really-a-png');
  fs.writeFileSync(metaAbs(), `${JSON.stringify(meta, null, 2)}\n`);
}

beforeEach(() => { asked = []; projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-meta-park-gate-')); });
afterEach(() => { fs.rmSync(projectRoot, { recursive: true, force: true }); });

describe('/api/write-meta — a park DESTROYED is a refusal (#872)', () => {
  it('REFUSES with REQUIRES_SAVE, names the path, and writes NOTHING', async () => {
    seed();

    const res = await post('/api/write-meta', { path: ASSET, meta: { id: 'rock-guid', texture: { maxSize: 512 } } },
      makeCtx(rendererWithParks([ASSET])));

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('REQUIRES_SAVE');
    expect(res.body.parked).toEqual([ASSET]);
    expect(String(res.body.error)).toContain(ASSET);
    // The refusal must carry its exits, or it is a dead end (§5).
    const options = (res.body.options as string[]).join(' ');
    expect(options).toContain('modoki_save_all');
    expect(options).toContain('discardUnsaved:true');
    // …and the file is untouched. A refusal that half-wrote would be worse than no gate.
    expect(readMeta().texture).toEqual({ maxSize: 2048 });
  });

  it('discardUnsaved:true drops the park and WRITES — and says both', async () => {
    seed();

    const res = await post('/api/write-meta', {
      path: ASSET, meta: { id: 'rock-guid', texture: { maxSize: 512 } }, discardUnsaved: true,
    }, makeCtx(rendererWithParks([ASSET])));

    expect(res.body.ok).toBe(true);
    expect(res.body.discardedParked).toEqual([ASSET]);
    expect(readMeta().texture).toEqual({ maxSize: 512 });
    // ⚠️ **This assertion changed, and the OLD expectation was wrong.** It required probe and
    // discard to be ONE call, on the reasoning that two round trips leave a window for a park to
    // land between the check and the write. True, but it bought that by destroying the human's
    // edit BEFORE the write could still fail — so a `writeMetaSidecar` that threw left the edit
    // gone and nothing written (see the F5 cases below). The residual window the split reopens is
    // the opposite way round and strictly smaller: a park created between a SUCCESSFUL write and
    // the discard, and only when the caller explicitly asked to discard.
    // ⚠️ The discard is now SCOPED to a registry list rather than a boolean (#889): a shared probe
    // that took `discard: true` would let this route drop a dirty particle document it never asked
    // about. `undefined` on the probe call, `['pendingMeta']` on the discard call.
    expect(asked.map((a) => [a.op, (a.params as { discard?: string[] }).discard]))
      .toEqual([['resolve-unsaved', undefined], ['resolve-unsaved', ['pendingMeta']]]);
  });

  it('ACCEPTS when nothing is parked, and does not ask to discard', async () => {
    seed();

    const res = await post('/api/write-meta', { path: ASSET, meta: { id: 'rock-guid', texture: { maxSize: 512 } } },
      makeCtx(rendererWithParks([])));

    expect(res.body.ok).toBe(true);
    expect(res.body.discardedParked).toBeUndefined();
    expect(res.body.editorConnected).toBeUndefined();
    expect(readMeta().texture).toEqual({ maxSize: 512 });
    // ⚠️ SCOPED to the one registry this route can destroy (#889). Unscoped, a shared probe
    // would refuse a sidecar write because an unrelated particle document is dirty.
    expect(asked[0].params).toEqual({ paths: [ASSET], registries: ['pendingMeta'] });
  });
});

describe('the classifier — "could not look" is not "nothing is there" (§5)', () => {
  it('a definitively ABSENT renderer proceeds, and says editorConnected:false', async () => {
    // A park is renderer-only state. With no renderer there is none to be in the way, so refusing
    // here would break every headless write for nothing — `requires:['project']`, not ['editor'].
    seed();

    const res = await post('/api/write-meta', { path: ASSET, meta: { id: 'rock-guid', texture: { maxSize: 512 } } },
      makeCtx(rendererAbsent));

    expect(res.body.ok).toBe(true);
    expect(res.body.editorConnected).toBe(false);
    expect(String(res.body.note)).toContain('no parked import-settings edit could be in the way');
    expect(readMeta().texture).toEqual({ maxSize: 512 });
  });

  it('a SILENT renderer REFUSES with NO_RENDERER and writes nothing', async () => {
    // The fail-open this whole gate exists to close. A timeout on Electron can only mean an
    // attached-but-busy renderer; on Vite it is genuinely ambiguous. Neither is "nothing parked".
    seed();

    const res = await post('/api/write-meta', { path: ASSET, meta: { id: 'rock-guid', texture: { maxSize: 512 } } },
      makeCtx(rendererSilent));

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('NO_RENDERER');
    expect(String(res.body.error)).toContain('could NOT rule out');
    expect(readMeta().texture, 'a write must not proceed on an unanswered probe').toEqual({ maxSize: 2048 });
  });

  it('…and the silent case is overridable, so it is a refusal and not a wedge', async () => {
    seed();

    const res = await post('/api/write-meta', {
      path: ASSET, meta: { id: 'rock-guid', texture: { maxSize: 512 } }, discardUnsaved: true,
    }, makeCtx(rendererSilent));

    expect(res.body.ok).toBe(true);
    expect(readMeta().texture).toEqual({ maxSize: 512 });
    // …and it must NOT claim the park was dealt with. Nothing was checked, so nothing was
    // discarded, and `discardUnsaved`'s own promise ("nothing stale survives") does not hold here.
    expect(res.body.discardedParked).toBeUndefined();
    expect(String(res.body.note)).toContain('NOTHING was discarded');
  });
});

describe('/api/reimport — a park merely UN-INCLUDED takes `force` (#882)', () => {
  /** The real handlers are registered by the vite plugin's `configureServer`, which does not run
   *  here — and an unregistered type short-circuits to the 422 "nothing to re-import" branch before
   *  the reply these cases assert on. So a stub stands in, which also buys the sharper assertion:
   *  a refusal must not merely answer 409, it must not have BAKED. */
  let baked: string[] = [];
  beforeEach(() => {
    baked = [];
    registerReimportHandler('texture', async (assetPath: string) => { baked.push(assetPath); });
  });
  const manifest = (assets: Array<{ path: string }> = [{ path: ASSET }]): Manifest =>
    ({ version: 2, assets: assets.map((a, i) => ({ ...a, type: 'texture', guid: `g${i}` })) } as unknown as Manifest);

  it('REFUSES with REQUIRES_SAVE, names `force` not `discardUnsaved`, and does not bake', async () => {
    seed();

    const res = await post('/api/reimport', { path: ASSET }, makeCtx(rendererWithParks([ASSET]), manifest()));

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('REQUIRES_SAVE');
    const options = (res.body.options as string[]).join(' ');
    expect(options).toContain('force:true');
    expect(options, 'a re-import destroys nothing, so it must NOT offer the destructive hatch')
      .not.toContain('discardUnsaved');
    expect(String(res.body.error)).toContain('PRE-EDIT');
    expect(baked, 'the gate runs BEFORE the bake loop, not after it').toEqual([]);
  });

  it('force:true bakes anyway and REPORTS that it read the file, rather than passing silently', async () => {
    seed();

    const res = await post('/api/reimport', { path: ASSET, force: true }, makeCtx(rendererWithParks([ASSET]), manifest()));

    expect(res.body.ok).toBe(true);
    expect(baked).toEqual([ASSET]);
    expect(res.body.bakedFromDisk).toEqual([ASSET]);
    expect(String(res.body.note)).toContain('PRE-EDIT');
    // Forcing must never DISCARD — the human's edit is untouched, merely not used.
    expect((asked[0].params as { discard?: string[] }).discard).toBeUndefined();
  });

  it('ACCEPTS with no note when nothing is parked', async () => {
    seed();

    const res = await post('/api/reimport', { path: ASSET }, makeCtx(rendererWithParks([]), manifest()));

    expect(res.body.ok).toBe(true);
    expect(baked).toEqual([ASSET]);
    expect(res.body.bakedFromDisk).toBeUndefined();
  });

  it('probes EVERY target of a recursive re-import, not just the first', async () => {
    // The recursive path is where a per-call probe silently becomes a per-first-path one, and the
    // symptom would be a clean bake that quietly used stale settings for asset N.
    seed();
    fs.writeFileSync(path.join(projectRoot, 'b.png'), 'not-really-a-png');

    const res = await post('/api/reimport', { path: '/', recursive: true },
      makeCtx(rendererWithParks(['/b.png']), manifest([{ path: '/a.png' }, { path: '/b.png' }])));

    expect(asked[0].params).toEqual({ paths: ['/a.png', '/b.png'], registries: ['pendingMeta'] });
    expect(res.body.code).toBe('REQUIRES_SAVE');
    expect(res.body.parked).toEqual(['/b.png']);
    expect(baked).toEqual([]);
  });
});

describe('/api/duplicate-asset — the copy is seeded from the SOURCE file (#882)', () => {
  it('REFUSES while the source is parked, and copies nothing', async () => {
    seed();

    const res = await post('/api/duplicate-asset', { from: ASSET, to: '/copy.png' }, makeCtx(rendererWithParks([ASSET])));

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('REQUIRES_SAVE');
    expect(fs.existsSync(path.join(projectRoot, 'copy.png'))).toBe(false);
  });

  it('probes the SOURCE only — the destination cannot be parked, it does not exist yet', async () => {
    seed();

    await post('/api/duplicate-asset', { from: ASSET, to: '/copy.png' }, makeCtx(rendererWithParks([])));

    // ⚠️ ALL FOUR registries here, unlike the two sidecar routes: `duplicateAssetFile`'s
    // `.json` branch copies the DOCUMENT, and `ext === '.json'` catches .scene.json too, so
    // liveScene is load-bearing (#889 member 4).
    expect(asked[0].params).toEqual({
      paths: [ASSET],
      registries: ['dirtyAsset', 'pendingMeta', 'pendingBaseScene', 'liveScene'],
    });
  });

  it('force:true copies, and says the copy carries the pre-edit settings', async () => {
    seed();

    const res = await post('/api/duplicate-asset', { from: ASSET, to: '/copy.png', force: true },
      makeCtx(rendererWithParks([ASSET])));

    expect(res.body.ok).toBe(true);
    expect(res.body.copiedFromDisk).toEqual([ASSET]);
    expect(fs.existsSync(path.join(projectRoot, 'copy.png'))).toBe(true);
  });

  it('ACCEPTS when nothing is parked', async () => {
    seed();

    const res = await post('/api/duplicate-asset', { from: ASSET, to: '/copy.png' }, makeCtx(rendererWithParks([])));

    expect(res.body.ok).toBe(true);
    expect(res.body.copiedFromDisk).toBeUndefined();
    expect(fs.existsSync(path.join(projectRoot, 'copy.png'))).toBe(true);
  });
});

describe("the dev server's no-client rejection stays DEFINITIVE, not ambiguous", () => {
  // The coupling this pins spans two files and is invisible from either. `requestBrowser` rejects
  // immediately when the dev server has no page open, instead of waiting out its budget and
  // rejecting with a TIMEOUT — and a timeout is ambiguous by design (on Electron it can only mean
  // an attached-but-busy renderer), so the gate refuses on one. Reword that message into something
  // `isRelayTransportFailure` does not match, or into something `isRelayTimeout` DOES, and every
  // headless `/api/reimport` starts refusing NO_RENDERER with nothing to explain it.
  //
  // The string is read out of the source rather than copied here, so a reword is CHECKED rather
  // than silently duplicated — a hand-copy of a matcher input is the #867 hazard one layer out.
  it('the message it emits classifies as a definitively absent renderer', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../plugins/vite-asset-scanner.ts'), 'utf-8',
    );
    const m = /Promise\.reject\(new Error\(`(no renderer connected[^`]*)`\)\)/.exec(src);
    expect(m, 'the no-client fast reject is gone from requestBrowser — headless callers now wait '
      + 'out a timeout, which every classifier must treat as AMBIGUOUS').not.toBeNull();
    const message = m![1].replace(/\$\{[^}]*\}/g, 'x');

    expect(isRelayTransportFailure(message), 'must read as a relay/transport failure').toBe(true);
    expect(isRelayTimeout(message), 'must NOT read as a timeout — a timeout is the ambiguous case').toBe(false);
  });
});

describe('the review findings, each pinned (#872/#882 review)', () => {
  it('F3 — an "unknown agent op" reply is COULD-NOT-LOOK, never "no renderer"', async () => {
    // The fail-open the gate produced against itself. `ws.send` broadcasts to every HMR client and
    // the request registry WAS first-reply-wins (closed by #1030; this case pins that the guard does
    // not depend on that fix); `initAgentBridge()` runs on any editor-flagged page
    // but `registerEditorAgentOps()` only from `editor/setup.ts`. So a plain `/` tab answers
    // "unknown agent op" INSTANTLY and beats the editor tab holding the park. Classifying that as
    // `absent` let the write through AND told the caller "there is no renderer" — the §0 rank-1
    // false success, produced by the guard against it. One client's "I don't have that op" says
    // nothing about whether another client does.
    seed();

    const res = await post('/api/write-meta', { path: ASSET, meta: { id: 'rock-guid', texture: { maxSize: 512 } } },
      makeCtx(rendererWithoutEditorOps));

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('NO_RENDERER');
    expect(res.body.editorConnected, 'must NOT claim no renderer was there').toBeUndefined();
    expect(readMeta().texture).toEqual({ maxSize: 2048 });
  });

  it('F1 — a rendererWrite is exempt: the editor\'s own save is not refused by the agent gate', async () => {
    // §8's REQUIRES_SAVE rule is an AGENT-surface rule and this route is shared. Every caller of
    // `writeMetaConditional` loads through `readMetaPreferringPark`, so its document ALREADY
    // contains the parked edit and the write is what legitimately retires it. Without this the
    // Sprite Editor could not save at all while an Inspector Max Size edit was parked, and the 409
    // was reported to the human as "the file changed on disk" — a wrong diagnosis of an unchanged file.
    seed();

    const res = await post('/api/write-meta', {
      path: ASSET, meta: { id: 'rock-guid', texture: { maxSize: 512 } }, rendererWrite: true,
    }, makeCtx(rendererWithParks([ASSET])));

    expect(res.body.ok).toBe(true);
    expect(readMeta().texture).toEqual({ maxSize: 512 });
    // …and it does not even ask: the renderer owns the registry, so the round trip is pointless.
    expect(asked).toEqual([]);
  });

  it('F5 — a write that THROWS leaves the park intact; the discard follows the write', async () => {
    // The discard used to ride along with the probe, so a failed `writeMetaSidecar` (read-only
    // sidecar, ENOSPC) destroyed the human's edit and wrote nothing in its place, reported as a
    // bare 500 that never mentioned the discard. A failed write must cost nothing.
    seed();
    // Make the sidecar unwritable so `writeMetaSidecar` throws after the gate has run.
    fs.chmodSync(metaAbs(), 0o444);
    fs.chmodSync(projectRoot, 0o555);
    try {
      const res = await post('/api/write-meta', {
        path: ASSET, meta: { id: 'rock-guid', texture: { maxSize: 512 } }, discardUnsaved: true,
      }, makeCtx(rendererWithParks([ASSET])));

      expect(res.status).toBe(500);
      // The ONE probe that ran must not have discarded anything.
      expect(asked).toHaveLength(1);
      expect((asked[0].params as { discard?: string[] }).discard,
        'the probe must not discard — the discard call comes after a SUCCESSFUL write').toBeUndefined();
    } finally {
      fs.chmodSync(projectRoot, 0o755);
      fs.chmodSync(metaAbs(), 0o644);
    }
  });

  it('F5 (accept side) — a write that SUCCEEDS still discards, in a second call after it', async () => {
    seed();

    const res = await post('/api/write-meta', {
      path: ASSET, meta: { id: 'rock-guid', texture: { maxSize: 512 } }, discardUnsaved: true,
    }, makeCtx(rendererWithParks([ASSET])));

    expect(res.body.ok).toBe(true);
    expect(res.body.discardedParked).toEqual([ASSET]);
    expect(readMeta().texture).toEqual({ maxSize: 512 });
    expect(asked.map((a) => (a.params as { discard?: string[] }).discard))
      .toEqual([undefined, ['pendingMeta']]);
  });

  it('a write whose DISCARD then fails does NOT report a clean success', async () => {
    // ⚠️ Found by review, and it is #872's exact defect wearing a success reply. The three
    // disclosures on this route all branch on the FIRST gate, and the second (discard) call
    // collapsed every non-`held` outcome — including a rejection — to `[]`. So: first probe says
    // held, caller passes discardUnsaved:true, the write lands, the second probe times out or
    // lost the first-reply-wins race to a second HMR client (closed by #1030) → `{ok:true, sha256}` with no
    // `discardedParked` and no note. The human's park SURVIVED, and their next Cmd+S flushes the
    // older document back over this write, reported as clean.
    //
    // `unknown` on the second call is the LIKELY branch, not the exotic one: the budget is 1500ms
    // and a GLB parse or a shader compile eats it.
    seed();
    let call = 0;
    const parkThenGoSilent: RendererStub = (op, params) => {
      if (op !== 'resolve-unsaved') return {};
      call += 1;
      if (call === 1) return rendererWithParks([ASSET])(op, params);   // the probe: a park is here
      throw new Error('timed out waiting for the renderer');            // the discard: unanswered
    };

    const res = await post('/api/write-meta', {
      path: ASSET, meta: { id: 'rock-guid', texture: { maxSize: 512 } }, discardUnsaved: true,
    }, makeCtx(parkThenGoSilent));

    expect(res.body.ok, 'the write DID land — this is a disclosure, not a refusal').toBe(true);
    expect(readMeta().texture, 'and it really wrote').toEqual({ maxSize: 512 });
    expect(res.body.discardedParked, 'nothing was confirmed discarded').toBeUndefined();
    expect(res.body.discardUnconfirmed, 'the caller must be able to tell this apart from a clean run').toBe(true);
    expect(String(res.body.note), 'and be told what it costs them')
      .toMatch(/could NOT be discarded|may still be there|flush it back/i);
  });

  it('ACCEPT SIDE: a confirmed discard reports discardedParked and NOT discardUnconfirmed', async () => {
    // ⚠️ Without this, the assertion above is satisfied by a route that flags every discard as
    // unconfirmed — which would make the flag noise, and noise is read as absent.
    seed();
    const res = await post('/api/write-meta', {
      path: ASSET, meta: { id: 'rock-guid', texture: { maxSize: 512 } }, discardUnsaved: true,
    }, makeCtx(rendererWithParks([ASSET])));

    expect(res.body.discardedParked).toEqual([ASSET]);
    expect('discardUnconfirmed' in res.body, 'absent, not false').toBe(false);
  });

  it('a discard whose second probe says CLEAR is not described as an unanswered renderer', async () => {
    // ⚠️ Close-out review 2. One shared sentence covered every non-`held` outcome and said "the
    // renderer did not confirm it (the renderer went away)" — for a probe that ANSWERED and a
    // renderer that is still there. The real case: the human hits Cmd+S between the two probes, so
    // the park is legitimately gone by the time the discard runs. Nothing is wrong, and the reply
    // must not describe it as a failure.
    seed();
    let call = 0;
    const parkThenClean: RendererStub = (op, params) => {
      if (op !== 'resolve-unsaved') return {};
      call += 1;
      return call === 1 ? rendererWithParks([ASSET])(op, params) : rendererWithParks([])(op, params);
    };

    const res = await post('/api/write-meta', {
      path: ASSET, meta: { id: 'rock-guid', texture: { maxSize: 512 } }, discardUnsaved: true,
    }, makeCtx(parkThenClean));

    expect(res.body.ok).toBe(true);
    expect(res.body.discardUnconfirmed, 'nothing was discarded, so the caller is told').toBe(true);
    expect(String(res.body.note), 'but NOT told the renderer went away — it answered')
      .not.toMatch(/did not answer|went away/i);
    expect(String(res.body.note)).toMatch(/already gone|saved, or discarded it themselves/i);
  });

  it('a discard whose renderer went ABSENT is not told its park may survive', async () => {
    // ⚠️ The sharper half of the same finding: the shared sentence said "the human's older parked
    // document may still be there" on `absent` — which THIS ROUTE'S OWN `editorConnected` branch,
    // five lines further down the same response, says is impossible ("a park is renderer-only
    // state and there is no renderer"). A disclosure that contradicts its sibling branch teaches
    // the reader the field is noise.
    seed();
    let call = 0;
    const parkThenGone: RendererStub = (op, params) => {
      if (op !== 'resolve-unsaved') return {};
      call += 1;
      if (call === 1) return rendererWithParks([ASSET])(op, params);
      throw new Error('no editor renderer window');
    };

    const res = await post('/api/write-meta', {
      path: ASSET, meta: { id: 'rock-guid', texture: { maxSize: 512 } }, discardUnsaved: true,
    }, makeCtx(parkThenGone));

    expect(res.body.ok).toBe(true);
    expect(String(res.body.note), 'the park went WITH the renderer — nothing stale survives')
      .not.toMatch(/may still be there/i);
    expect(String(res.body.note)).toMatch(/went with the renderer|nothing stale survives/i);
  });

  it('a `held` second probe that discarded NOTHING is not a confirmed discard', async () => {
    // ⚠️ Latent today — the renderer computes `holds` before the discard and keys off that same
    // list, so the two cannot disagree — but it is one `&&` from being the exact shape this flag
    // exists to close: "the park is still there and I dropped none of it" reading as success.
    seed();
    let call = 0;
    const parkThenDiscardNothing: RendererStub = (op, params) => {
      if (op !== 'resolve-unsaved') return {};
      call += 1;
      const p = (params ?? {}) as { paths?: string[]; registries?: string[] };
      const covers = p.registries ?? ['dirtyAsset', 'pendingMeta', 'pendingBaseScene', 'liveScene'];
      const holds = [{ path: ASSET, registry: 'pendingMeta', detail: 'unsaved import settings' }];
      // Second call: still holding, and discarded NOTHING.
      return { ok: true, holds, discarded: call === 1 ? [] : [], covers };
    };

    const res = await post('/api/write-meta', {
      path: ASSET, meta: { id: 'rock-guid', texture: { maxSize: 512 } }, discardUnsaved: true,
    }, makeCtx(parkThenDiscardNothing));

    expect(res.body.discardedParked, 'nothing came back discarded').toBeUndefined();
    expect(res.body.discardUnconfirmed, 'so it must NOT read as a confirmed discard').toBe(true);
  });

  it('ACCEPT SIDE: nothing parked → no discard call, and no unconfirmed flag', async () => {
    // The third path: `discardUnsaved:true` over a CLEAN editor must not invent a second probe or
    // a warning about a discard that was never needed.
    seed();
    const res = await post('/api/write-meta', {
      path: ASSET, meta: { id: 'rock-guid', texture: { maxSize: 512 } }, discardUnsaved: true,
    }, makeCtx(rendererWithParks([])));

    expect(res.body.ok).toBe(true);
    expect('discardUnconfirmed' in res.body).toBe(false);
    expect(asked, 'one probe, no discard call').toHaveLength(1);
  });

  it('F7 — the gate is keyed on the CANONICAL asset URL, not the raw request string', async () => {
    // `resolveAssetPath` prepends a missing slash and percent-decodes, so these reach a real file —
    // while the park is filed under the canonical URL. Gating on the raw string missed it and the
    // write destroyed the very park it had just checked for.
    seed();

    const noSlash = await post('/api/write-meta', { path: 'rock.png', meta: { id: 'rock-guid' } },
      makeCtx(rendererWithParks([ASSET])));
    expect(noSlash.status, 'a leading-slash-less path must still find the park').toBe(409);
    expect(readMeta().texture).toEqual({ maxSize: 2048 });

    asked = [];
    const encoded = await post('/api/write-meta', { path: '/rock%2Epng', meta: { id: 'rock-guid' } },
      makeCtx(rendererWithParks([ASSET])));
    expect(encoded.status, 'a percent-encoded path must still find the park').toBe(409);
    expect(readMeta().texture).toEqual({ maxSize: 2048 });
  });

  it('F4 — duplicate-asset forced past an unanswered probe SAYS so', async () => {
    // The one route where `force:true` used to return a bare success. The other two disclosed it;
    // the asymmetry was the author's own §0 argument applied unevenly.
    seed();

    const res = await post('/api/duplicate-asset', { from: ASSET, to: '/copy.png', force: true },
      makeCtx(rendererSilent));

    expect(res.body.ok).toBe(true);
    expect(String(res.body.note)).toContain('FORCED past');
    expect(String(res.body.note)).toContain('not "there was none"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// #889 B + C — the stale-READ half: a read never refuses, and never answers as if it had looked.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** A renderer holding one dirty asset document — the state neither read route could ever see. */
const rendererHoldingDirtyAsset: RendererStub = (op, params) => {
  if (op !== 'resolve-unsaved') return {};
  const p = (params ?? {}) as { registries?: string[] };
  const covers = p.registries ?? ['dirtyAsset', 'pendingMeta', 'pendingBaseScene', 'liveScene'];
  return {
    ok: true,
    holds: covers.includes('dirtyAsset')
      ? [{ path: '/a.mat.json', registry: 'dirtyAsset', detail: 'an unsaved asset document' }]
      : [],
    discarded: [],
    covers,
  };
};

const get = (urlPath: string, ctx: BackendContext, query = new URLSearchParams()) =>
  handleBackendRequest(ctx, { method: 'GET', urlPath, query, body: undefined }) as
    Promise<{ status?: number; body: Record<string, unknown> }>;

/** `computeUnused`/`computeRefEdges` are the route's inputs; the shaker itself is not under test
 *  here, so they are stubbed to the smallest shape the routes read. */
const withShaker = (renderer: RendererStub): BackendContext => ({
  ...makeCtx(renderer),
  computeUnused: () => ({ orphanDetails: [], stats: { scenes: 0 }, warnings: [] }),
  // The minimum `buildRefGraph` reads. The shaker is not under test here — only whether the
  // route discloses what it could not see.
  computeRefEdges: () => ({
    edges: [], entities: [], guidIndex: new Map(), guidOrigin: new Map(),
    allFiles: [], seeds: [], warnings: [],
  }),
  isUnderOrSame: undefined,
} as unknown as BackendContext);

/** A renderer running an OLDER build: it answers, but implements fewer registries than the backend
 *  asked about. It reports NOTHING held — truthfully, for the registries it knows. */
const rendererSkewed: RendererStub = (op) => {
  if (op !== 'resolve-unsaved') return {};
  return { ok: true, holds: [], discarded: [], covers: ['pendingMeta'] };
};

/** A renderer that answers with no `covers` at all — the shape a hand-written or half-migrated
 *  reply has. */
const rendererNoCovers: RendererStub = (op) => {
  if (op !== 'resolve-unsaved') return {};
  return { ok: true, holds: [], discarded: [] };
};

describe('a SKEWED renderer is `unknown`, never "all clear" (#889)', () => {
  // ⚠️ **This suite exists because a mutation check found the hole.** Deleting the `covers`
  // comparison entirely left every other test in this file green: nothing exercised a renderer
  // that answers WITHOUT covering what was asked, so the field I had called the skew guard was
  // pinned by nothing. A version-skew reply reporting `holds: []` for the two registries it knows
  // is indistinguishable from a clean editor unless somebody checks the list.
  //
  // The realistic path: a backend that asks about `liveScene` talking to a tab loaded before the
  // op learned it. `unknown agent op` covers the OLD-op case; this covers the half-old one.
  it('a renderer covering FEWER registries than asked refuses with NO_RENDERER', async () => {
    seed();
    // duplicate-asset asks for all four; this renderer implements only pendingMeta.
    const res = await post('/api/duplicate-asset', { from: ASSET, to: '/copy.png' },
      makeCtx(rendererSkewed));

    expect(res.status, 'it could not look at three of the four — that is not "nothing is there"').toBe(503);
    expect(res.body.code).toBe('NO_RENDERER');
    expect(String(res.body.error), 'the reason has to name the skew, or the reader retries forever')
      .toMatch(/did not cover|older build/i);
    expect(fs.existsSync(path.join(projectRoot, 'copy.png')), 'and it copied nothing').toBe(false);
  });

  it('a reply with NO `covers` at all is `unknown` too', async () => {
    seed();
    const res = await post('/api/duplicate-asset', { from: ASSET, to: '/copy.png' },
      makeCtx(rendererNoCovers));

    expect(res.status).toBe(503);
    expect(String(res.body.error)).toMatch(/covers/i);
  });

  it('ACCEPT SIDE: a renderer covering EXACTLY what was asked proceeds', async () => {
    // ⚠️ Without this the two above are satisfied by a gate that refuses every reply, which would
    // break every headless call in the repo. The scoped routes ask for one registry, and a
    // renderer answering for that one must be enough.
    seed();
    const res = await post('/api/write-meta',
      { path: ASSET, meta: { id: 'rock-guid', texture: { maxSize: 512 } } },
      makeCtx(rendererSkewed));

    expect(res.status ?? 200, 'write-meta asks only for pendingMeta, which this renderer covers')
      .toBe(200);
  });

  it('a stale-READ route discloses the skew rather than refusing', async () => {
    // The read half of the same fact: unused-assets asks for all four, so a skewed renderer means
    // its answer could not be checked — disclosed, not refused, per the consequence class.
    const res = await get('/api/unused-assets', withShaker(rendererSkewed));

    expect(res.status ?? 200).toBe(200);
    expect(res.body.staleInputsUnknown).toBeDefined();
    expect(String(res.body.staleInputsNote)).toMatch(/could NOT be checked|stale/i);
  });
});

describe('/api/unused-assets DISCLOSES unsaved work rather than refusing (#889 B)', () => {
  // ⚠️ THE HIGHEST-CONSEQUENCE MEMBER, and not the one #889 was filed about. This answer feeds
  // CleanupAssetsDialog, which posts the selection to /api/delete-asset — so an asset referenced
  // ONLY by an unsaved edit reads as an orphan and can be trashed.
  //
  // ⚠️ Disclose, do NOT refuse (owner, 2026-09-08). A read that refuses is worse than one that
  // caveats: this route backs a human dialog, and refusing it is #872's Sprite-Editor regression
  // one route over. §8's "lost or OMITTED" is what licenses the softer half — a read omits nothing
  // if it says what it could not see.
  it('still ANSWERS, and names what the answer was computed without', async () => {
    const res = await get('/api/unused-assets', withShaker(rendererHoldingDirtyAsset));

    expect(res.status ?? 200, 'a read must not refuse').toBe(200);
    expect(res.body.orphans, 'the answer is still delivered').toBeDefined();
    expect(res.body.staleInputs).toEqual([
      { path: '/a.mat.json', registry: 'dirtyAsset', detail: 'an unsaved asset document' },
    ]);
    expect(String(res.body.staleInputsNote)).toMatch(/on DISK|does not reflect/);
    expect(String(res.body.staleInputsNote), 'and the remedy').toMatch(/save/i);
  });

  it('ACCEPT SIDE: a clean editor gets NO disclosure field at all — not an empty one', async () => {
    // ⚠️ The half that decides whether the disclosure means anything. `staleInputs: []` on every
    // clean call is a field readers learn to skip, and then the call that matters is skipped too.
    // Asserting ABSENCE rather than emptiness is the only way to catch an always-emitted field.
    const res = await get('/api/unused-assets', withShaker(rendererWithParks([])));

    expect(res.status ?? 200).toBe(200);
    expect(res.body.orphans).toBeDefined();
    expect('staleInputs' in res.body, 'absent, not []').toBe(false);
    expect('staleInputsNote' in res.body).toBe(false);
    expect('staleInputsUnknown' in res.body).toBe(false);
  });

  it('an UNANSWERABLE probe is disclosed too — "could not look" is not "nothing is there"', async () => {
    // The §5 rule, on the read side. Collapsing this into the clean case would make a busy renderer
    // indistinguishable from a clean one, which is the fail-open the whole gate exists to close.
    const res = await get('/api/unused-assets', withShaker(rendererSilent));

    expect(res.status ?? 200, 'still not a refusal').toBe(200);
    expect(res.body.staleInputsUnknown).toBeDefined();
    expect('staleInputs' in res.body, 'it could not look, so it names nothing specific').toBe(false);
    expect(String(res.body.staleInputsNote)).toMatch(/could NOT be checked|may be computed from stale/);
  });

  it('a renderer that is definitively ABSENT gets no disclosure — there is nothing to hold', async () => {
    // The other side of `unknown`: with no renderer, every registry is empty by construction, so a
    // caveat here would be noise on every headless call.
    const res = await get('/api/unused-assets', withShaker(rendererAbsent));
    expect('staleInputs' in res.body).toBe(false);
    expect('staleInputsUnknown' in res.body).toBe(false);
  });
});

/** The 200 exit — the branch the whole disclosure exists for, and the one nothing covered.
 *
 *  ⚠️ **Found by mutation in #972's close-out review: deleting the disclosure from the SUCCESS
 *  exit left 4157 tests green.** Every find-references test above targets `'no-such-guid'` or omits
 *  the target, so all of them land on 404/400. The success path is where a "0 references" verdict
 *  gets computed past a human's unsaved edit — and that verdict is the input to a DELETE — so it is
 *  precisely the branch that must not go quiet.
 *
 *  This is also the seam #972 P4 depends on: `FindReferencesDialog` now renders
 *  `staleInputsNote` and derives nothing itself, so if the route stops sending it on a successful
 *  scan the banner silently stops appearing and the dialog has no fallback. The architecture guard
 *  greps the `.tsx`; only this can see the route. */
describe('/api/find-references DISCLOSES on the SUCCESS path too (#972 P4)', () => {
  /** A shaker whose enumeration contains one real file, so a `/`-shaped target RESOLVES and the
   *  route reaches its 200 exit instead of the 404 every other test here lands on. */
  const withResolvableTarget = (renderer: RendererStub): BackendContext => ({
    ...withShaker(renderer),
    computeRefEdges: () => ({
      edges: [], entities: [], guidIndex: new Map(), guidOrigin: new Map(),
      allFiles: ['/known.mat.json'], seeds: [], warnings: [],
    }),
  });

  it('a 200 answer carries the disclosure when the editor holds unsaved work', async () => {
    const res = await get('/api/find-references', withResolvableTarget(rendererHoldingDirtyAsset),
      new URLSearchParams({ target: '/known.mat.json' }));
    expect(res.status ?? 200, 'the target must RESOLVE — otherwise this is the 404 test again').toBe(200);
    expect(res.body.staleInputs, 'a successful scan past unsaved work must say so').toEqual([
      { path: '/a.mat.json', registry: 'dirtyAsset', detail: 'an unsaved asset document' },
    ]);
    expect(String(res.body.staleInputsNote)).toMatch(/on DISK|does not reflect/);
    expect(String(res.body.staleInputsNote), 'and the remedy').toMatch(/save/i);
  });

  it('ACCEPT SIDE: a 200 answer on a CLEAN editor carries none', async () => {
    // Without this the test above passes for a route that attaches the disclosure unconditionally,
    // which would put a permanent "this may be stale" banner on every clean scan and train the
    // reader to ignore it.
    const res = await get('/api/find-references', withResolvableTarget(rendererWithParks([])),
      new URLSearchParams({ target: '/known.mat.json' }));
    expect(res.status ?? 200).toBe(200);
    expect('staleInputs' in res.body).toBe(false);
    expect('staleInputsNote' in res.body).toBe(false);
  });

  it('a 200 answer says so when the renderer could NOT be asked', async () => {
    // "Could not look" is not "nothing is there" — the same rule the 404 branch already carries.
    const res = await get('/api/find-references', withResolvableTarget(rendererSilent),
      new URLSearchParams({ target: '/known.mat.json' }));
    expect(res.status ?? 200).toBe(200);
    expect(res.body.staleInputsUnknown, 'an unreachable probe must not read as clean').toBeDefined();
    expect(String(res.body.staleInputsNote)).toMatch(/could NOT be checked|stale/i);
  });
});

describe('the disclosure survives the branches that DROP an answer (#889 close-out review)', () => {
  it('find-references 404 carries the disclosure — the branch where it is most load-bearing', () => {
    // ⚠️ Found by review: `staleness` was awaited and then dropped on exactly this branch. An
    // unresolvable target is very often unresolvable BECAUSE the thing exists only in unsaved
    // state — an agent runs mutate_scene to create an entity, then asks what references that
    // entity's guid, and the graph (built from disk) has never heard of it. Without the
    // disclosure the reply is a bare 404 saying the guid is not an asset or entity guid, so the
    // agent re-derives the guid or concludes its own mutation did not land.
    //
    // The branch's own comment two lines up says it refuses "precisely so that 'could not look'
    // is never reported as 'nothing is there'" — and it was doing that for the target while
    // staying silent about the unsaved state that explains it.
    return get('/api/find-references', withShaker(rendererHoldingDirtyAsset),
      new URLSearchParams({ target: 'no-such-guid' })).then((res) => {
      expect(res.status, 'still a refusal — the disclosure does not soften it').toBe(404);
      expect(res.body.error, 'and still says why the target did not resolve').toBeDefined();
      expect(res.body.staleInputs, 'and now says what it could not see').toEqual([
        { path: '/a.mat.json', registry: 'dirtyAsset', detail: 'an unsaved asset document' },
      ]);
    });
  });

  it('ACCEPT SIDE: a 404 on a CLEAN editor carries no disclosure', async () => {
    const res = await get('/api/find-references', withShaker(rendererWithParks([])),
      new URLSearchParams({ target: 'no-such-guid' }));
    expect(res.status).toBe(404);
    expect('staleInputs' in res.body).toBe(false);
    expect('staleInputsNote' in res.body).toBe(false);
  });

  it('a 400 for a MISSING target carries none — that is a caller error, not a lookup', async () => {
    // The deliberate asymmetry. Unsaved work cannot have affected a lookup that never happened,
    // and a caveat here would train readers to skip the one on the 404.
    const res = await get('/api/find-references', withShaker(rendererHoldingDirtyAsset),
      new URLSearchParams());
    expect(res.status).toBe(400);
    expect('staleInputs' in res.body).toBe(false);
  });
});

describe('/api/find-references DISCLOSES unsaved work (#889 C)', () => {
  // Its own unresolvable-target branch already insists "'Could not look' is never reported as
  // 'nothing is there'" — while a "0 references" verdict computed past a human's unsaved edit did
  // exactly that, six lines below.
  it('a 404 for an unresolvable target still refuses, unchanged', async () => {
    const res = await get('/api/find-references', withShaker(rendererWithParks([])),
      new URLSearchParams({ target: 'no-such-guid' }));
    expect(res.status).toBe(404);
  });

  it('ACCEPT SIDE: a clean editor gets no disclosure', async () => {
    const res = await get('/api/find-references', withShaker(rendererWithParks([])),
      new URLSearchParams({ target: 'no-such-guid' }));
    expect('staleInputs' in res.body).toBe(false);
  });
});
