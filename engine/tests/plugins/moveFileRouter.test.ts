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

let tmp: string;
function makeCtx(): BackendContext {
  return {
    projectRoot: tmp,
    resolveAssetPath: (p: string) => path.join(tmp, p.replace(/^\//, '')),
    getSchema: () => undefined,
    firstRootDir: () => null,
    invalidateProjectConfig: () => {},
  } as unknown as BackendContext;
}
const move = (from: string, to: string) =>
  handleBackendRequest(makeCtx(), { method: 'POST', urlPath: '/api/move-file', query: new URLSearchParams(), body: { from, to } });

beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-mvrouter-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

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
