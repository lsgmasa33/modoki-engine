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

/** The renderer answers normally, reporting exactly `parked` as parked. */
const rendererWithParks = (parked: string[]): RendererStub => (op, params) => {
  if (op !== 'resolve-meta-park') return {};
  const p = (params ?? {}) as { paths?: string[]; discard?: boolean };
  const hit = (p.paths ?? []).filter((x) => parked.includes(x));
  return { ok: true, parked: hit, discarded: p.discard ? hit : [] };
};

/** A SECOND page is connected that does not have the editor ops — the dev server's runtime route,
 *  a very ordinary thing to have open. `ws.send` broadcasts and the request registry is
 *  first-reply-wins, so this page can answer before the editor tab that actually holds the park. */
const rendererWithoutEditorOps: RendererStub = () => { throw new Error("unknown agent op 'resolve-meta-park'"); };

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
    expect(asked.map((a) => [a.op, (a.params as { discard?: boolean }).discard]))
      .toEqual([['resolve-meta-park', undefined], ['resolve-meta-park', true]]);
  });

  it('ACCEPTS when nothing is parked, and does not ask to discard', async () => {
    seed();

    const res = await post('/api/write-meta', { path: ASSET, meta: { id: 'rock-guid', texture: { maxSize: 512 } } },
      makeCtx(rendererWithParks([])));

    expect(res.body.ok).toBe(true);
    expect(res.body.discardedParked).toBeUndefined();
    expect(res.body.editorConnected).toBeUndefined();
    expect(readMeta().texture).toEqual({ maxSize: 512 });
    expect(asked[0].params).toEqual({ paths: [ASSET] });
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
    expect((asked[0].params as { discard?: boolean }).discard).toBeUndefined();
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

    expect(asked[0].params).toEqual({ paths: ['/a.png', '/b.png'] });
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

    expect(asked[0].params).toEqual({ paths: [ASSET] });
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
    // the request registry is first-reply-wins; `initAgentBridge()` runs on any editor-flagged page
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
      expect((asked[0].params as { discard?: boolean }).discard,
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
    expect(asked.map((a) => (a.params as { discard?: boolean }).discard)).toEqual([undefined, true]);
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
