/** Router-level tests for POST /api/open-file and POST /api/reveal-in-finder —
 *  opening a script/asset in the OS default app, and showing it in the file
 *  manager. Three things matter: the path guard (only files inside the project or
 *  engine-source roots — never an arbitrary absolute path), that the resolved
 *  ABSOLUTE path is what's handed to the opener, and that a path resolving inside
 *  the root but no longer on disk is answered here rather than by the OS (#1515).
 *
 *  We mock the osOpen module so no real app launches during the test. ⚠️ That mock
 *  is exactly what hid #1508 — it always succeeds, so a win32 branch that failed
 *  every time still passed here. What the real launchers do belongs in
 *  `osOpen.test.ts` (shape) and `osOpenWin32.test.ts` (the real explorer.exe). */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const openInOS = vi.hoisted(() => vi.fn(async () => {}));
const revealInOS = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../plugins/backend/osOpen', () => ({ openInOS, revealInOS }));

import { handleBackendRequest, type BackendContext } from '../../plugins/backend/editorBackendRouter';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

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

beforeEach(() => { tmp = makeScratchDir('modoki-openfile-'); openInOS.mockClear(); revealInOS.mockClear(); });
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

  // `resolveSourcePath` is pure path math — it never touches the disk — so a row
  // that outlived its file (deleted between the listing and the click) used to
  // reach the OS launcher. On win32 that is #1515: the shell raises a modal
  // "Windows cannot find…" dialog, and since the launcher is no longer awaited
  // the route would answer 200 for a file that never opened.
  it('returns 404 for a path inside the root whose file is gone, without launching anything', async () => {
    const r = (await openFile('deleted.ts')) as { status?: number };
    expect(r.status).toBe(404);
    expect(openInOS).not.toHaveBeenCalled();
  });
});

describe('/api/reveal-in-finder', () => {
  const reveal = (p: string) =>
    handleBackendRequest(makeCtx(), { method: 'POST', urlPath: '/api/reveal-in-finder', query: new URLSearchParams(), body: { path: p } });

  it('reveals a file inside the project root, passing its absolute path', async () => {
    fs.writeFileSync(path.join(tmp, 'hero.png'), 'x');
    const r = (await reveal('hero.png')) as { status?: number };
    expect(r.status).toBeUndefined();
    expect(revealInOS).toHaveBeenCalledWith(path.join(tmp, 'hero.png'));
  });

  it('returns 404 for a path inside the root whose file is gone, without launching anything', async () => {
    const r = (await reveal('gone.png')) as { status?: number };
    expect(r.status).toBe(404);
    expect(revealInOS).not.toHaveBeenCalled();
  });

  it('refuses (403) a path that escapes the project + engine roots', async () => {
    const r = (await reveal('../../../../etc/passwd')) as { status?: number };
    expect(r.status).toBe(403);
    expect(revealInOS).not.toHaveBeenCalled();
  });
});
