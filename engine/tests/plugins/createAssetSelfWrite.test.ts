/** `/api/create-asset` must fingerprint its own write, like every other write route.
 *
 *  WHY THIS EXISTS. The editor's file watcher hot-reloads an asset when the file changes
 *  underneath it. To stop the editor reacting to its OWN saves, each write route calls
 *  `ctx.markEditorWrite(abs, sha1(bytes))` and the watcher skips a change whose bytes match.
 *  `/api/asset-write`, `/api/write-file` and the rename route all did this; `/api/create-asset`
 *  never did.
 *
 *  The consequence was silent data loss, not a stale panel: the creation's own change event came
 *  back a debounce later, was read as an EXTERNAL edit, and `dropParkedWriteFor` (agentBridge)
 *  discarded whatever had been parked for that path — dropping BOTH the live-cache entry and the
 *  `dirtyAssetPaths` entry, so a later `save_all` wrote nothing and reported no error. An edit
 *  made in the second after `create_asset` was simply gone. Measured ~500ms end-to-end
 *  (bug 97Qr1tm8A2Vkej6yrvUL, p0).
 *
 *  The second test is the one that matters most. A guard that fingerprints the WRONG bytes fails
 *  OPEN — the watcher's comparison simply never matches, the event is treated as external again,
 *  and the bug is back with the fix apparently in place. So asserting "markEditorWrite was
 *  called" is not enough; the hash has to be the hash of what actually landed on disk. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { handleBackendRequest, type BackendContext, type Manifest } from '../../plugins/backend/editorBackendRouter';

let projectRoot = '';

function makeCtx(over: Partial<BackendContext> = {}): BackendContext {
  const base = {
    projectRoot,
    editorRoot: projectRoot,
    resolveAssetPath: (p: string) => path.join(projectRoot, p.replace(/^\//, '')),
    absToAssetUrl: (p: string) => p,
    firstRootDir: () => null,
    getManifest: () => ({ version: 2, assets: [] }) as Manifest,
    rebuildManifest: () => ({ version: 2, assets: [] }) as Manifest,
    requestBrowser: async () => ({}),
    getSchema: () => undefined,
    markEditorWrite: () => {},
    ssrLoadModule: async () => ({}),
    invalidateProjectConfig: () => {},
  };
  return { ...base, ...over } as unknown as BackendContext;
}

const post = (urlPath: string, body: unknown, ctx: BackendContext) =>
  handleBackendRequest(ctx, { method: 'POST', urlPath, query: new URLSearchParams(), body });

beforeEach(() => { projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-create-')); });
afterEach(() => { fs.rmSync(projectRoot, { recursive: true, force: true }); });

describe('/api/create-asset — the self-write guard', () => {
  it('marks the new file as the editor\'s own write', async () => {
    const markEditorWrite = vi.fn();
    const ctx = makeCtx({ markEditorWrite });
    const res = (await post('/api/create-asset', { type: 'material', path: '/assets/probe.material.json' }, ctx)) as { body: { ok?: boolean } };

    expect(res.body.ok).toBe(true);
    expect(markEditorWrite).toHaveBeenCalledOnce();
    const [abs] = markEditorWrite.mock.calls[0];
    expect(abs).toBe(path.join(projectRoot, 'assets/probe.material.json'));
  });

  it('fingerprints the bytes that actually landed on disk — a mismatch fails OPEN', async () => {
    const markEditorWrite = vi.fn();
    const ctx = makeCtx({ markEditorWrite });
    await post('/api/create-asset', { type: 'material', path: '/assets/probe.material.json' }, ctx);

    const [abs, hash] = markEditorWrite.mock.calls[0] as [string, string];
    const onDisk = fs.readFileSync(abs);
    expect(hash).toBe(crypto.createHash('sha1').update(onDisk).digest('hex'));
  });

  it('does not mark anything when the write is refused', async () => {
    // A refusal must not leave a fingerprint behind for a file it never wrote: the next genuine
    // external edit to that path would then be skipped as "ours" and the editor would miss it.
    const markEditorWrite = vi.fn();
    const ctx = makeCtx({ markEditorWrite });
    fs.mkdirSync(path.join(projectRoot, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'assets/taken.material.json'), '{}');

    const res = (await post('/api/create-asset', { type: 'material', path: '/assets/taken.material.json' }, ctx)) as { status?: number };
    expect(res.status).toBe(409);
    expect(markEditorWrite).not.toHaveBeenCalled();
  });
});
