/** Router-level tests for POST /api/open-file — opens a script/asset in the OS
 *  default app. Two things matter: the path guard (only files inside the project
 *  or engine-source roots may be opened — never an arbitrary absolute path), and
 *  that the resolved ABSOLUTE path is what's handed to the opener. We mock the
 *  osOpen module so no real app launches during the test. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const openInOS = vi.hoisted(() => vi.fn(async () => {}));
const revealInOS = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../plugins/backend/osOpen', () => ({ openInOS, revealInOS }));

import { handleBackendRequest, type BackendContext } from '../../plugins/backend/editorBackendRouter';

let tmp: string;
function makeCtx(): BackendContext {
  return {
    projectRoot: tmp,
    // Force resolution through resolveSourcePath (the script path guard) by
    // returning null here — mirrors a source file that isn't an asset-root URL.
    resolveAssetPath: () => null,
    getSchema: () => undefined,
    firstRootDir: () => null,
    invalidateProjectConfig: () => {},
  } as unknown as BackendContext;
}
const openFile = (p: string) =>
  handleBackendRequest(makeCtx(), { method: 'POST', urlPath: '/api/open-file', query: new URLSearchParams(), body: { path: p } });

beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-openfile-')); openInOS.mockClear(); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('/api/open-file', () => {
  it('opens a file inside the project root, passing its absolute path', async () => {
    fs.writeFileSync(path.join(tmp, 'game.ts'), 'export const x = 1;');
    const r = (await openFile('game.ts')) as { status?: number };
    expect(r.status).toBeUndefined(); // json({ ok:true }) with no status = 200
    expect(openInOS).toHaveBeenCalledTimes(1);
    expect(openInOS).toHaveBeenCalledWith(path.join(tmp, 'game.ts'));
  });

  it('refuses (403) a path that escapes the project + engine roots', async () => {
    const r = (await openFile('../../../../etc/passwd')) as { status?: number };
    expect(r.status).toBe(403);
    expect(openInOS).not.toHaveBeenCalled();
  });

  it('refuses (403) an absolute path outside the roots', async () => {
    const r = (await openFile('/etc/hosts')) as { status?: number };
    expect(r.status).toBe(403);
    expect(openInOS).not.toHaveBeenCalled();
  });

  it('refuses (403) an empty path', async () => {
    const r = (await openFile('')) as { status?: number };
    expect(r.status).toBe(403);
    expect(openInOS).not.toHaveBeenCalled();
  });

  it('returns 500 when the OS opener fails', async () => {
    fs.writeFileSync(path.join(tmp, 'game.ts'), 'x');
    openInOS.mockRejectedValueOnce(new Error('no opener'));
    const r = (await openFile('game.ts')) as { status?: number };
    expect(r.status).toBe(500);
  });
});
