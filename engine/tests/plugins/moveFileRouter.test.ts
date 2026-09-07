/** Router-level tests for POST /api/move-file's clobber guard — specifically the
 *  case-only rename allowance (Sprites → sprites). On a case-insensitive FS the
 *  destination "exists" because it resolves to the SAME entry as the source; that
 *  must NOT be treated as a collision. We model that here with a hardlink so the
 *  two differently-cased paths share one inode even on a case-sensitive CI FS. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { handleBackendRequest, type BackendContext } from '../../plugins/backend/editorBackendRouter';
// The REAL resolver and canonicalizer, not hand-rolled stand-ins. A simplified
// `resolveAssetPath` here silently modelled a route that does NOT tolerate a missing leading
// slash or a percent-encoded segment — which is precisely the tolerance the canonicalization
// finding is about, so a fake would have made the guard defend the bug.
import { resolveAssetPath, absToAssetUrl, type AssetRoot } from '../../plugins/vite-asset-scanner';

let tmp: string;
let tmp2: string;

/** What the route did to the two seams that are not the filesystem. Both are on `BackendContext`,
 *  and the stub used to omit them — which worked only because the route swallowed the resulting
 *  TypeError in a try/catch, i.e. the stub modelled a context that cannot exist (#867). */
type Recorded = {
  /** Paths fingerprinted as the editor's own write, so the watcher skips their events. */
  marked: Array<{ abs: string; hash: string | null }>;
  /** Renderer callbacks: `[op, params]`. */
  asked: Array<{ op: string; params: unknown }>;
};
let rec: Recorded;
/** Two asset roots — the tmpdir the tests address paths under, plus a second one so a move
 *  BETWEEN roots is expressible. That is not decoration: with a single root every destination is
 *  inside the source root, so the "destination is inside the source" guard fires first and the
 *  un-canonicalizable-path branch is unreachable. A test written against one root could not fail. */
const roots = (): AssetRoot[] => [
  // The SPECIFIC root first: `resolveAssetPath` returns the first match, and a `''` prefix
  // matches every path, so the catch-all has to come last or `/other/...` never reaches tmp2.
  { urlPrefix: '/other', absDir: tmp2 },
  { urlPrefix: '', absDir: tmp },
];
/** When set, `requestBrowser` rejects with it — the no-renderer-attached case. */
let browserFailure: Error | null = null;

function makeCtx(): BackendContext {
  return {
    projectRoot: tmp,
    resolveAssetPath: (p: string) => resolveAssetPath(p, roots()),
    getSchema: () => undefined,
    firstRootDir: () => null,
    invalidateProjectConfig: () => {},
    markEditorWrite: (abs: string, hash?: string | null) => { rec.marked.push({ abs, hash: hash ?? null }); },
    // The canonicalizer. The route must hand the renderer THIS, not the raw request body —
    // `resolveAssetPath` is tolerant and the renderer compares exactly.
    absToAssetUrl: (abs: string) => absToAssetUrl(abs, roots()),
    requestBrowser: async (op: string, params: unknown) => {
      rec.asked.push({ op, params });
      if (browserFailure) throw browserFailure;
      return { ok: true, notes: ['repointed the Inspector selection'] };
    },
  } as unknown as BackendContext;
}
const move = (from: string, to: string) =>
  handleBackendRequest(makeCtx(), { method: 'POST', urlPath: '/api/move-file', query: new URLSearchParams(), body: { from, to } });
/** One marked path as an asset-root-ish suffix, so assertions read independently of the tmpdir.
 *  ⚠️ The ONLY place this file may turn a native `abs` into something comparable (#876). A
 *  second, POSIX-only spelling (`abs.endsWith('/b.json')`) was hand-rolled below this and made
 *  main red on windows-latest: `abs` ends `\b.json` there, so the find returned undefined. */
const relOf = (abs: string) => abs.slice(tmp.length).replace(/\\/g, '/');
/** Marked paths as asset-root-ish suffixes, so assertions read independently of the tmpdir. */
const markedRel = () => rec.marked.map((m) => relOf(m.abs));

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-mvrouter-'));
  tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-mvrouter2-'));
  rec = { marked: [], asked: [] };
  browserFailure = null;
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(tmp2, { recursive: true, force: true });
});

describe('/api/move-file clobber guard', () => {
  it('allows a case-only rename (destination resolves to the SAME entry, not a clobber)', async () => {
    fs.writeFileSync(path.join(tmp, 'Foo.txt'), 'x');
    // On a case-SENSITIVE FS (Linux CI) `foo.txt` wouldn't exist, so a hardlink forces
    // the same-inode collision the guard must allow. On a case-INSENSITIVE FS (macOS dev)
    // `foo.txt` already resolves to `Foo.txt`, so the link throws EEXIST — ignore it; the
    // natural collision is exactly the scenario under test.
    try { fs.linkSync(path.join(tmp, 'Foo.txt'), path.join(tmp, 'foo.txt')); } catch { /* case-insensitive FS */ }
    const r = (await move('/Foo.txt', '/foo.txt')) as { status?: number };
    expect(r.status).toBeUndefined(); // json() with no status = 200 (allowed)
  });

  it('409 on a genuine collision (a DIFFERENT file already at the target)', async () => {
    fs.writeFileSync(path.join(tmp, 'a.txt'), '1');
    fs.writeFileSync(path.join(tmp, 'b.txt'), '2');
    const r = (await move('/a.txt', '/b.txt')) as { status?: number };
    expect(r.status).toBe(409);
  });

  it('moves normally when the target does not exist', async () => {
    fs.writeFileSync(path.join(tmp, 'a.txt'), '1');
    const r = (await move('/a.txt', '/b.txt')) as { status?: number };
    expect(r.status).toBeUndefined();
    expect(fs.existsSync(path.join(tmp, 'b.txt'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'a.txt'))).toBe(false);
  });
});

/** #867 member 1: `modoki_move_asset` reaches this route from a DIFFERENT PROCESS, so it cannot
 *  call the client-side repair (`applyAssetPathMoves`) at all — that is not a forgotten line, it
 *  is a process boundary. The route therefore carries the repair itself, by calling the renderer
 *  back through `requestBrowser`, and by fingerprinting what the move makes appear and disappear
 *  so the watcher does not eat the very edit the repair just moved. */
describe('/api/move-file carries the repair (#867)', () => {
  it('asks the RENDERER to apply the move, naming from and to', async () => {
    fs.writeFileSync(path.join(tmp, 'spark.particle.json'), '{}');
    const r = (await move('/spark.particle.json', '/fx/spark.particle.json')) as
      { status?: number; body?: { ok?: boolean; repaired?: string[] } };
    expect(r.status).toBeUndefined();
    expect(rec.asked).toHaveLength(1);
    expect(rec.asked[0].op).toBe('apply-asset-path-moves');
    expect(rec.asked[0].params).toEqual({
      moves: [{ from: '/spark.particle.json', to: '/fx/spark.particle.json' }],
    });
    // The repair's own account comes back to the caller, so an agent can SEE it happened.
    expect(r.body?.repaired).toEqual(['repointed the Inspector selection']);
  });

  it('marks a FOLDER move with prefix, which is the only thing that reaches its children', async () => {
    // Without `prefix` the repair's `applyMove` takes its exact-path branch and returns undefined
    // for every descendant — the whole of member 2, arriving through the agent surface instead of
    // the drag. The route is the only party that can tell a folder from a file here: the client
    // passes two strings and they look identical.
    fs.mkdirSync(path.join(tmp, 'anim'));
    fs.writeFileSync(path.join(tmp, 'anim', 'walk.anim.json'), '{}');
    await move('/anim', '/archive/anim');
    expect(rec.asked[0].params).toEqual({
      moves: [{ from: '/anim', to: '/archive/anim', prefix: true }],
    });
  });

  it('a move with NO renderer attached still succeeds — the file move stands', async () => {
    // A CLI invocation, or a backend with no editor open. There is no in-memory state to repair,
    // so swallowing is correct; turning a successful move into a 5xx would not be.
    browserFailure = new Error('dev server websocket not ready');
    fs.writeFileSync(path.join(tmp, 'a.json'), '{}');
    const r = (await move('/a.json', '/b.json')) as { status?: number; body?: { ok?: boolean; repaired?: string[] } };
    expect(r.status).toBeUndefined();
    expect(fs.existsSync(path.join(tmp, 'b.json'))).toBe(true);
    expect(r.body?.repaired).toBeUndefined(); // nothing was repaired, and it does not claim to be
  });

  it('fingerprints the SOURCE, so its unlink does not discard the parked edit', async () => {
    // The source's `unlink` reaches the watcher as a non-editor write, and `handleSceneChanged`
    // routes that to `dropParkedWriteFor(from)` — discarding the human's unsaved edit with a
    // console.warn, at the exact moment the repair is moving it to the new path.
    fs.writeFileSync(path.join(tmp, 'a.json'), '{}');
    await move('/a.json', '/b.json');
    expect(markedRel()).toContain('/a.json');
  });

  it('fingerprints EVERY file a folder move lands, not zero of them', async () => {
    // This used to be `readFileSync(absFrom)` in a try/catch whose comment claimed a directory
    // move would "fall through; the guard is best-effort". readFileSync THROWS on a directory, so
    // a folder move was fingerprinted not at all — every child arrived as a foreign write.
    fs.mkdirSync(path.join(tmp, 'anim', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'anim', 'walk.anim.json'), '{}');
    fs.writeFileSync(path.join(tmp, 'anim', 'sub', 'run.anim.json'), '{}');
    await move('/anim', '/archive/anim');
    const marked = markedRel();
    expect(marked).toContain('/archive/anim/walk.anim.json');
    expect(marked).toContain('/archive/anim/sub/run.anim.json');
    expect(marked).toContain('/anim'); // the source, whose unlink must also be skipped
  });

  it('a FILE move is still hashed, not merely TTL-marked', async () => {
    // The hash is the timing-independent fallback for a rename event that lands after the 1500ms
    // TTL. It is worth a read for one file; it is not worth reading a whole subtree, which is why
    // folder children above are marked with a null hash instead.
    fs.writeFileSync(path.join(tmp, 'a.json'), 'the bytes');
    await move('/a.json', '/b.json');
    const dest = rec.marked.find((m) => relOf(m.abs) === '/b.json');
    expect(dest?.hash).toMatch(/^[0-9a-f]{40}$/);
  });
});

/** The sibling #867's own close-out sweep found: a DELETE bypassed the repair the same way a move
 *  did. `unbindDeletedAssetEditors` was written for exactly this case — "delete unbinds, move
 *  repoints" — and only the Assets panel ever called it. */
describe('/api/delete-asset carries the repair too (#867 sibling)', () => {
  const del = (body: Record<string, unknown>) =>
    handleBackendRequest(makeCtx(), { method: 'POST', urlPath: '/api/delete-asset', query: new URLSearchParams(), body });

  it('tells the renderer the asset is GONE, so a bound panel unbinds', async () => {
    fs.writeFileSync(path.join(tmp, 'spark.particle.json'), '{}');
    await del({ paths: ['/spark.particle.json'] });
    expect(rec.asked).toHaveLength(1);
    expect(rec.asked[0].op).toBe('apply-asset-path-moves');
    // `to: null` is what distinguishes a delete from a move at the seam.
    expect(rec.asked[0].params).toEqual({ moves: [{ from: '/spark.particle.json', to: null }] });
  });

  it('marks a deleted FOLDER with prefix, or the repair misses everything inside it', async () => {
    fs.mkdirSync(path.join(tmp, 'anim'));
    fs.writeFileSync(path.join(tmp, 'anim', 'walk.anim.json'), '{}');
    await del({ paths: ['/anim'] });
    expect(rec.asked[0].params).toEqual({ moves: [{ from: '/anim', to: null, prefix: true }] });
  });

  it('does NOT report a MISSING path as deleted — nothing was there to unbind', async () => {
    // Missing paths are skipped rather than 404'd here (a batch carries maybe-absent sidecars),
    // so the repair list must be the RESOLVED set, not the input set.
    fs.writeFileSync(path.join(tmp, 'a.json'), '{}');
    await del({ paths: ['/a.json', '/never-existed.json'] });
    expect(rec.asked[0].params).toEqual({ moves: [{ from: '/a.json', to: null }] });
  });

  it('asks nothing when every path was missing', async () => {
    await del({ paths: ['/gone.json'] });
    expect(rec.asked).toHaveLength(0);
  });
});

/** Review finding (#867): the route fed RAW client strings into a path-EXACT comparison.
 *
 *  `resolveAssetPath` is deliberately tolerant — it prepends a missing leading slash,
 *  `decodeURIComponent`s, and resolves `.`/`..` — while the renderer's `applyMove` is
 *  `path !== move.from → undefined`. So a tolerated-but-non-canonical path moved the file and then
 *  repaired nothing, reported as `{ok:true, repaired:[]}`, which is indistinguishable from
 *  "nothing was bound". `modoki_move_asset` takes a bare `z.string()`, so the agent surface — the
 *  exact caller this repair exists for — is where the non-canonical path comes from. */
describe('/api/move-file canonicalizes before repairing (#867 review)', () => {
  it('a path with NO LEADING SLASH still repairs the canonical path', async () => {
    fs.writeFileSync(path.join(tmp, 'spark.particle.json'), '{}');
    await move('spark.particle.json', 'fx/spark.particle.json');
    expect(rec.asked[0].params).toEqual({
      moves: [{ from: '/spark.particle.json', to: '/fx/spark.particle.json' }],
    });
  });

  it('a PERCENT-ENCODED path repairs the decoded one', async () => {
    fs.mkdirSync(path.join(tmp, 'my fx'));
    fs.writeFileSync(path.join(tmp, 'my fx', 'a.json'), '{}');
    await move('/my%20fx/a.json', '/b.json');
    expect(rec.asked[0].params).toEqual({ moves: [{ from: '/my fx/a.json', to: '/b.json' }] });
  });

  it('a path with a .. segment repairs the resolved one', async () => {
    fs.mkdirSync(path.join(tmp, 'fx'));
    fs.writeFileSync(path.join(tmp, 'a.json'), '{}');
    await move('/fx/../a.json', '/b.json');
    expect(rec.asked[0].params).toEqual({ moves: [{ from: '/a.json', to: '/b.json' }] });
  });

  it('/api/delete-asset canonicalizes too', async () => {
    fs.writeFileSync(path.join(tmp, 'a.json'), '{}');
    await handleBackendRequest(makeCtx(), {
      method: 'POST', urlPath: '/api/delete-asset', query: new URLSearchParams(), body: { paths: ['a.json'] },
    });
    expect(rec.asked[0].params).toEqual({ moves: [{ from: '/a.json', to: null }] });
  });

  it('refuses moving a folder INTO ITSELF with a 400, not a 500 from renameSync', async () => {
    fs.mkdirSync(path.join(tmp, 'anim'));
    fs.writeFileSync(path.join(tmp, 'anim', 'a.json'), '{}');
    const r = (await move('/anim', '/anim/sub')) as { status?: number };
    expect(r.status).toBe(400);
  });
});

/** Review finding (#867): a folder move marked the destinations and the directory's own path, but
 *  not the child SOURCES — and chokidar emits a per-CHILD unlink for a directory rename. */
describe('/api/move-file marks both ends of every moved child (#867 review)', () => {
  it('marks each child\'s OLD path as well as its new one', async () => {
    fs.mkdirSync(path.join(tmp, 'anim', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'anim', 'walk.anim.json'), '{}');
    fs.writeFileSync(path.join(tmp, 'anim', 'sub', 'run.anim.json'), '{}');
    await move('/anim', '/archive/anim');
    const marked = markedRel();
    expect(marked).toContain('/anim/walk.anim.json');       // the source, whose unlink fires
    expect(marked).toContain('/anim/sub/run.anim.json');
    expect(marked).toContain('/archive/anim/walk.anim.json');
    expect(marked).toContain('/archive/anim/sub/run.anim.json');
  });
});

/** Review finding (#867): the "is there a renderer?" split and the repair timeout were the two
 *  most-argued mechanisms in the change and NEITHER had a test — both could be mutated away with
 *  the suite green. The distinction is load-bearing: a definitively-absent renderer means nothing
 *  was lost, while a renderer that did not answer means the file moved and the editor's path-keyed
 *  state did not follow it, which is #186. */
describe('/api/move-file distinguishes NO renderer from an UNREPAIRED one (#867 review)', () => {
  const moveWith = async (failure: Error) => {
    browserFailure = failure;
    fs.writeFileSync(path.join(tmp, 'a.json'), '{}');
    return (await move('/a.json', '/b.json')) as
      { status?: number; body?: { ok?: boolean; repaired?: string[]; repairFailed?: string } };
  };

  // Every string the two transports actually send when the surface is definitively gone. The
  // first version of this split used a second hand-copied regex and missed all four Electron
  // ones — i.e. the whole default editor surface — so a closed window printed a scary and false
  // "the renderer FAILED … your state may be corrupt" on every agent move.
  it.each([
    ['dev server websocket not ready', 'vite, no dev server'],
    ['no editor renderer window', 'electron, window gone'],
    ['editor window closed', 'electron, closed'],
    ['project changed — renderer reloading', 'electron, deliberate teardown'],
    ['Object has been destroyed', 'electron, webContents died'],
    ["unknown agent op 'apply-asset-path-moves'", 'a runtime build with no editor ops'],
  ])('is SILENT and claims no repair for %j (%s)', async (msg) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await moveWith(new Error(msg));
    expect(r.status).toBeUndefined();                 // the move still succeeded
    expect(r.body?.repairFailed).toBeUndefined();     // nothing was lost, so nothing is claimed
    expect(warn).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
    warn.mockRestore(); err.mockRestore();
  });

  it('REPORTS a timeout — an attached renderer that did not answer is not "no renderer"', async () => {
    // Electron rejects synchronously when the window is gone, so a timeout there can only mean
    // the renderer is attached and busy (mid-scene-load, a GLB parse, a TSL compile). Folding it
    // into the silent set is how the agent path fails invisibly: it has no local backstop, unlike
    // the panel, which calls applyAssetPathMoves itself.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await moveWith(new Error('timed out waiting for the renderer'));
    expect(r.status).toBeUndefined();
    expect(r.body?.repairFailed).toMatch(/timed out/);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('REPORTS a genuine throw from inside the repair', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await moveWith(new TypeError("Cannot read properties of undefined (reading 'path')"));
    expect(r.body?.repairFailed).toMatch(/Cannot read properties/);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('refuses to repair an un-canonicalizable path rather than sending an unmatchable one', async () => {
    // `absToAssetUrl` returns null for exactly one input `resolveAssetPath` accepts: the asset
    // ROOT itself, which `modoki_move_asset`'s bare z.string() does accept. Falling back to the
    // raw string would ship the very defect the canonicalization fixes — a path the renderer
    // cannot match — and report it as a successful repair.
    //
    // Moved to the SECOND root, because a destination inside the first is refused by the
    // dest-inside-source guard before this branch is reached. An earlier version of this test
    // did exactly that and was vacuous: it wrapped its assertions in `if (r.status === undefined)`
    // and the 400 made the body never run.
    const r = (await move('/', '/other/root')) as { status?: number; body?: { repairFailed?: string } };
    expect(r.status).toBeUndefined();
    expect(r.body?.repairFailed).toMatch(/not an asset-root path/);
    expect(rec.asked).toHaveLength(0);   // nothing unmatchable was sent
  });
});
