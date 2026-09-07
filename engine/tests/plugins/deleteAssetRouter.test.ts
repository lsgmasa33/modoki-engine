/** Router-level tests for POST /api/delete-asset's request handling — the
 *  branch logic that decides single-vs-batch, 403/404/400, and the skip-missing
 *  behavior that lets a batch carry maybe-absent `.meta.json` sidecars. The
 *  actual OS-trash batching (a path list → one invocation) is proven in
 *  assetFsOps.integration.test.ts; here we deliberately exercise ONLY the
 *  no-trash branches so the test never shells out to Finder/trash-put. */

import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// The trash itself is proven against disk in assetFsOps.integration.test.ts. Here it
// is stubbed so the REBUILD branch — which only runs when something was actually
// trashed — is reachable without shelling out to Finder/trash-put. Without the stub
// the positive case below could not be written at all, and the rebuild would only
// ever be asserted in its did-not-happen form.
const trashed: string[][] = [];
// Paths this stub should REFUSE, so the partial-failure branch is reachable (#875). The real
// moveToTrash reports a per-path OS refusal in its return value rather than throwing — a stub
// that returns nothing models a function that cannot exist, and an earlier version of this one
// did exactly that, which is how a route change slipped past it.
let refuse: string[] = [];
// Paths this stub should report as failed VERBATIM, whether or not the route asked about them —
// the only way to model `parseTrashFailures` handing back a string that does not match any abs
// path the route resolved (#884 close-out review finding 9).
let refuseRaw: string[] | null = null;
vi.mock('../../plugins/asset-fs-ops', async (orig) => ({
  ...(await orig<typeof import('../../plugins/asset-fs-ops')>()),
  moveToTrash: (paths: string | string[]) => {
    const list = Array.isArray(paths) ? paths : [paths];
    trashed.push(list);
    if (refuseRaw) return { failed: refuseRaw };
    return { failed: list.filter((p) => refuse.some((r) => p.endsWith(r))) };
  },
}));

import { handleBackendRequest, type BackendContext } from '../../plugins/backend/editorBackendRouter';

// Minimal context: /api/delete-asset touches resolveAssetPath and (once anything
// was actually trashed) rebuildManifest. The rest is cast away — if a future change
// makes the handler reach another method, the undefined call will throw loudly
// rather than pass silently.
//
// That is exactly what happened when #867 made this route repair the renderer: the handler
// started reaching `absToAssetUrl` and `requestBrowser`, and these tests went red rather than
// quietly passing over a half-exercised route. Both are stubbed here only enough to let the
// manifest-rebuild branches below run — what the route SENDS the renderer is asserted in
// `moveFileRouter.test.ts`, against the real resolver.
function makeCtx(
  resolve: (p: string) => string | null,
  rebuild: () => unknown = () => ({ version: 2, assets: [], folders: [] }),
): BackendContext {
  return {
    projectRoot: os.tmpdir(),
    resolveAssetPath: resolve,
    rebuildManifest: rebuild,
    absToAssetUrl: () => null,   // → the route falls back to the absolute path; not asserted here
    requestBrowser: async () => ({ ok: true, notes: [] }),
    getSchema: () => undefined,
    firstRootDir: () => null,
    invalidateProjectConfig: () => {},
  } as unknown as BackendContext;
}

const del = (body: unknown, ctx: BackendContext) =>
  handleBackendRequest(ctx, { method: 'POST', urlPath: '/api/delete-asset', query: new URLSearchParams(), body });

// A directory that does not exist — so every resolvable path is "missing on disk"
// and the handler never calls moveToTrash (resolved.length stays 0).
const ABSENT_ROOT = path.join(os.tmpdir(), 'modoki-delete-router-test-nonexistent');
const resolvableButAbsent = makeCtx((p) => path.join(ABSENT_ROOT, p));

describe('/api/delete-asset routing (batch + back-compat)', () => {
  it('400 when neither path nor paths is provided', async () => {
    const r = (await del({}, resolvableButAbsent)) as { status?: number };
    expect(r.status).toBe(400);
  });

  it('403 when a single path escapes the allowed roots', async () => {
    const r = (await del({ path: '/etc/passwd' }, makeCtx(() => null))) as { status?: number };
    expect(r.status).toBe(403);
  });

  it('single missing path → 404 (back-compat for Hierarchy / import-prune callers)', async () => {
    const r = (await del({ path: '/games/x/gone.png' }, resolvableButAbsent)) as { status?: number };
    expect(r.status).toBe(404);
  });

  it('a paths LIST of all-missing files → 200 ok, trashed:0, reports missing (NOT a wholesale 404)', async () => {
    const paths = ['/games/x/a.png', '/games/x/a.png.meta.json'];
    const r = (await del({ paths }, resolvableButAbsent)) as { status?: number; body: { ok: boolean; trashed: number; missing: string[] } };
    expect(r.status).toBeUndefined(); // json() without an explicit status = 200
    expect(r.body.ok).toBe(true);
    expect(r.body.trashed).toBe(0);
    expect(r.body.missing).toEqual(paths);
  });

  it('403 short-circuits the WHOLE batch if any path escapes the roots', async () => {
    const ctx = makeCtx((p) => (p.includes('bad') ? null : path.join(ABSENT_ROOT, p)));
    const r = (await del({ paths: ['/games/x/ok.png', '/games/x/bad.png'] }, ctx)) as { status?: number };
    expect(r.status).toBe(403);
  });
});

/** The manifest rebuild (#288 gap 3). Both backends DO watch `unlink` and rebuild,
 *  but on a 150ms debounce — so the reply used to be AHEAD of the state a caller
 *  verifies with, and a `list_assets` issued straight after (or in the same
 *  `modoki_batch`, where there is no wall-clock gap at all) could still see the
 *  asset it had just been told was trashed. The sibling mutating routes rebuild
 *  inline; this one did not. */
describe('/api/delete-asset rebuilds the asset manifest inline', () => {
  /** A tmpdir with one real file, so `fs.existsSync` puts the path in `resolved`
   *  and the handler reaches the trash+rebuild branch. */
  function withRealFile(): { ctx: (rebuild: () => unknown) => BackendContext; url: string; dir: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-delete-router-'));
    fs.writeFileSync(path.join(dir, 'probe.particle.json'), '{}');
    return {
      dir,
      url: '/probe.particle.json',
      ctx: (rebuild) => makeCtx((p) => path.join(dir, p), rebuild),
    };
  }

  it('rebuilds ONCE when a file was trashed, and says so in the reply', async () => {
    const { ctx, url, dir } = withRealFile();
    trashed.length = 0;
    let rebuilds = 0;
    const r = (await del({ paths: [url] }, ctx(() => { rebuilds++; return {}; }))) as
      { status?: number; body: { ok: boolean; trashed: number; manifestRebuilt: boolean } };
    fs.rmSync(dir, { recursive: true, force: true });
    expect(r.status).toBeUndefined();
    expect(r.body.trashed).toBe(1);
    expect(trashed.length).toBe(1); // ONE OS call for the whole list — one trash sound.
    // The claim the tool's description rests on: a modoki_list_assets issued straight
    // after this reply — including in the same modoki_batch, where there is no
    // wall-clock gap for the watcher's 150ms debounce to land in — sees the deletion.
    expect(rebuilds).toBe(1);
    expect(r.body.manifestRebuilt).toBe(true);
  });

  it('a rebuild that THROWS is not a failed delete — it downgrades to manifestRebuilt:false', async () => {
    const { ctx, url, dir } = withRealFile();
    const r = (await del({ paths: [url] }, ctx(() => { throw new Error('manifest exploded'); }))) as
      { status?: number; body: { ok: boolean; trashed: number; manifestRebuilt: boolean } };
    fs.rmSync(dir, { recursive: true, force: true });
    // The trash ALREADY happened. A 500 here would read as "nothing was deleted" and
    // invite a retry against files that are already gone — a wrong answer stated
    // authoritatively, which outranks the inconvenience of a stale manifest.
    expect(r.status).toBeUndefined();
    expect(r.body.ok).toBe(true);
    expect(r.body.trashed).toBe(1);
    expect(r.body.manifestRebuilt).toBe(false);
  });

  it('does NOT rebuild when nothing was trashed (all paths missing)', async () => {
    let rebuilds = 0;
    const ctx = makeCtx((p) => path.join(ABSENT_ROOT, p), () => { rebuilds++; return {}; });
    const r = (await del({ paths: ['/games/x/gone.png'] }, ctx)) as { body: { manifestRebuilt: boolean } };
    // Nothing left the disk, so there is nothing for the manifest to catch up ON.
    // Reporting `manifestRebuilt:true` here would be a claim about work that never
    // happened — the shape §0 ranks worst.
    expect(rebuilds).toBe(0);
    expect(r.body.manifestRebuilt).toBe(false);
  });

  /** A per-path OS refusal is a PARTIAL success (#875 close-out review). An earlier draft made
   *  moveToTrash THROW on one, which aborted reconciliation for the paths that DID go: the route
   *  500'd, the manifest was not rebuilt, the renderer was never told, and the caller read
   *  "nothing was deleted" about files already in the Recycle Bin. Same shape the rebuild case
   *  above forbids, and worse, because it also loses the renderer repair and the undo.
   *
   *  ⚠️ #884 split the verdict. This used to answer `ok:true` for BOTH outcomes, and the test
   *  above pinned that — it even noted "nothing actually went" in the same breath as asserting
   *  success. One `ok` for two outcomes is what defeated every caller at once: `deleteAssetFile`
   *  returned true, the panel dropped the row, and `isFailureBody` short-circuits on `ok === true`
   *  by design, so the MCP tool reported a refused delete as a successful call. The pair below is
   *  the DISTINGUISHING one: a test that only built the total case could not tell this split from
   *  a blanket `ok:false`. */
  it('a TOTAL refusal is ok:false — nothing went, so "it succeeded" is simply false', async () => {
    const { ctx, url, dir } = withRealFile();
    refuse = [path.basename(url)];
    let rebuilds = 0;
    const r = (await del({ paths: [url] }, ctx(() => { rebuilds++; return {}; }))) as
      { status?: number; body: { ok: boolean; trashed: number; failed?: string[]; error?: string; manifestRebuilt: boolean } };
    refuse = [];
    fs.rmSync(dir, { recursive: true, force: true });

    expect(r.status, 'a refusal is reported in the body, not as a 5xx that discards it').toBeUndefined();
    expect(r.body.ok).toBe(false);
    expect(r.body.trashed).toBe(0);
    // Named, and named in the CALLER'S OWN string. The route used to map through
    // `absToAssetUrl(abs) ?? abs`, and this ctx stubs that resolver to null on purpose — so the
    // old code shipped an ABSOLUTE path here, into a field the renderer can only match against
    // asset urls. Echoing the request removes the round-trip instead of surviving it.
    expect(r.body.failed).toEqual([url]);
    expect(r.body.error).toContain(url);
    // No rebuild either: the manifest has nothing to catch up on.
    expect(rebuilds).toBe(0);
    expect(r.body.manifestRebuilt).toBe(false);
  });

  it('a PARTIAL refusal stays ok:true — the rest of the batch really is in the trash', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-delete-router-partial-'));
    fs.writeFileSync(path.join(dir, 'went.json'), '{}');
    fs.writeFileSync(path.join(dir, 'locked.json'), '{}');
    refuse = ['locked.json'];
    let rebuilds = 0;
    const ctx = makeCtx((p) => path.join(dir, p), () => { rebuilds++; return {}; });
    const r = (await del({ paths: ['/went.json', '/locked.json'] }, ctx)) as
      { status?: number; body: { ok: boolean; trashed: number; failed?: string[] } };
    refuse = [];
    fs.rmSync(dir, { recursive: true, force: true });

    // #875's whole point: one bad path must not abort reconciliation for the good ones.
    expect(r.body.ok).toBe(true);
    expect(r.body.trashed).toBe(1);
    expect(r.body.failed).toEqual(['/locked.json']);
    // The manifest DOES catch up here — something left the disk.
    expect(rebuilds).toBe(1);
  });

  it('matches a refusal that differs only in CASE — the family/path-identity shape (#881)', async () => {
    // Both sides make a round trip through the win32 script (we write stdin, we read stderr), and
    // Windows paths are case-insensitive, so a raw `includes` puts the path on the WRONG side of
    // the partition: counted as trashed, its move sent to the renderer, and the editor unbound
    // from a file still on disk. `samePath` folds case on win32/darwin.
    const { ctx, url, dir } = withRealFile();
    refuseRaw = [path.join(dir, 'PROBE.PARTICLE.JSON')];
    const r = (await del({ paths: [url] }, ctx(() => ({})))) as
      { body: { ok: boolean; trashed: number; failed?: string[] } };
    refuseRaw = null;
    fs.rmSync(dir, { recursive: true, force: true });

    // ⚠️ Asserted PER PLATFORM rather than skipped, because case-folding is the contract only
    // where the filesystem is case-insensitive — `samePath` folds on win32/darwin and not on
    // Linux, by design. Written as a single expectation each way so this test says something
    // true on the public Linux runner too, instead of passing on a Mac and going red there.
    if (process.platform === 'win32' || process.platform === 'darwin') {
      // Recognised as the SAME file: nothing went, so it is a total refusal, named by input.
      expect(r.body.ok).toBe(false);
      expect(r.body.trashed).toBe(0);
      expect(r.body.failed).toEqual([url]);
    } else {
      // A genuinely different file on a case-SENSITIVE fs: the probe really was trashed, and the
      // unmatched refusal still gets reported rather than vanishing (the guard below).
      expect(r.body.ok).toBe(true);
      expect(r.body.trashed).toBe(1);
      expect(r.body.failed).toEqual([path.join(dir, 'PROBE.PARTICLE.JSON')]);
    }
  });

  it('an UNMATCHED failure path is still reported, rather than vanishing from both sides', async () => {
    // ⚠️ `failedInputs` and `wentToTrash` partition `resolved` by the same predicate, so an entry
    // that matches neither would drop out of BOTH — `{ok:true, trashed:1}` with no `failed`,
    // which is the silent false success this whole change removes, reintroduced by its own fix.
    // Not reachable today; the guard keeps the old code's floor (degrade the KEY, never lose the
    // REPORT) if `parseTrashFailures` ever normalises differently.
    const { ctx, url, dir } = withRealFile();
    refuseRaw = ['/some/path/the/route/never/resolved.json'];
    const r = (await del({ paths: [url] }, ctx(() => ({})))) as
      { body: { ok: boolean; trashed: number; failed?: string[] } };
    refuseRaw = null;
    fs.rmSync(dir, { recursive: true, force: true });
    expect(r.body.failed).toEqual(['/some/path/the/route/never/resolved.json']);
    // And the real file is still correctly counted as gone — the guard adds a report, it does
    // not reclassify what went.
    expect(r.body.trashed).toBe(1);
    expect(r.body.ok).toBe(true);
  });

  it('ACCEPT SIDE: with nothing refused the reply carries no `failed` at all', async () => {
    const { ctx, url, dir } = withRealFile();
    const r = (await del({ paths: [url] }, ctx(() => ({})))) as
      { body: { ok: boolean; trashed: number; failed?: string[] } };
    fs.rmSync(dir, { recursive: true, force: true });
    expect(r.body.ok).toBe(true);
    expect(r.body.trashed).toBe(1);
    expect(r.body.failed).toBeUndefined();
  });
});
