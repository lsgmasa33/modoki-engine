/** #1440 — `/api/save-dialog` and `/api/pick-path` ask the host's `nativeChooser`, and the
 *  osascript fallback tells a real Cancel from a failure.
 *
 *  The routes themselves were untestable while they blocked on a live osascript panel
 *  (routeCoverage.test.ts). With the chooser injected, the whole answer is: what each outcome maps
 *  to, and that the fallback's classification does not collapse a failure into `{cancelled}` —
 *  the defect that made a broken dialog look exactly like the user pressing Cancel. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { handleBackendRequest, type BackendContext } from '../../plugins/backend/editorBackendRouter';
import { osascriptChooser, isOsascriptUserCancel, type ChooserOutcome, type NativeChooser, type OsascriptRunner } from '../../plugins/backend/nativeChooser';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

let tmp: string;
let assets: string;

function makeCtx(chooser: NativeChooser): BackendContext {
  return {
    projectRoot: tmp,
    resolveAssetPath: (u: string) => (u.startsWith('/assets') ? path.join(tmp, u) : null),
    absToAssetUrl: (abs: string) => (abs.startsWith(assets) ? '/assets' + abs.slice(assets.length).split(path.sep).join('/') : null),
    firstRootDir: () => assets,
    getSchema: () => undefined,
    invalidateProjectConfig: () => {},
    nativeChooser: chooser,
  } as unknown as BackendContext;
}

const chooserReturning = (outcome: ChooserOutcome) => {
  const saveFile = vi.fn(async () => outcome);
  const pickPath = vi.fn(async () => outcome);
  return { saveFile, pickPath };
};

const post = (ctx: BackendContext, urlPath: string, body: unknown) =>
  handleBackendRequest(ctx, { method: 'POST', urlPath, query: new URLSearchParams(), body }) as Promise<{ status?: number; body: Record<string, unknown> }>;

beforeEach(() => {
  tmp = makeScratchDir('modoki-chooser-');
  assets = path.join(tmp, 'assets');
  fs.mkdirSync(path.join(assets, 'scenes'), { recursive: true });
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('/api/save-dialog through ctx.nativeChooser', () => {
  it('starts the panel in the requested folder with the default name and prompt', async () => {
    const c = chooserReturning({ canceled: true });
    await post(makeCtx(c), '/api/save-dialog', { defaultName: 'New Scene.scene.json', defaultFolder: '/assets/scenes', prompt: 'Create Scene' });
    expect(c.saveFile).toHaveBeenCalledWith({ prompt: 'Create Scene', defaultName: 'New Scene.scene.json', startDir: path.join(assets, 'scenes') });
  });

  it('a chosen file inside the roots answers its asset-root URL', async () => {
    const r = await post(makeCtx(chooserReturning({ path: path.join(assets, 'scenes', 'probe.scene.json') })), '/api/save-dialog', {});
    expect(r.status).toBeUndefined();
    expect(r.body).toEqual({ path: '/assets/scenes/probe.scene.json' });
  });

  it('a Cancel is {cancelled}', async () => {
    const r = await post(makeCtx(chooserReturning({ canceled: true })), '/api/save-dialog', {});
    expect(r.body).toEqual({ cancelled: true });
  });

  it('a FAILED panel is a 500 with the reason — never {cancelled}', async () => {
    const r = await post(makeCtx(chooserReturning({ error: 'boom' })), '/api/save-dialog', {});
    expect(r.status).toBe(500);
    expect(r.body.cancelled).toBeUndefined();
    expect(String(r.body.error)).toMatch(/boom/);
  });

  it('a host without a panel is {unsupported} (the renderer then prompts in-app)', async () => {
    const r = await post(makeCtx(chooserReturning({ unsupported: true })), '/api/save-dialog', {});
    expect(r.body).toEqual({ unsupported: true });
  });
});

describe('/api/pick-path through ctx.nativeChooser', () => {
  it('passes the mode and prompt, and answers a path inside the project project-relative', async () => {
    fs.mkdirSync(path.join(tmp, 'resources'));
    const c = chooserReturning({ path: path.join(tmp, 'resources') + path.sep });
    const r = await post(makeCtx(c), '/api/pick-path', { mode: 'folder', prompt: 'Choose a folder' });
    expect(c.pickPath).toHaveBeenCalledWith({ mode: 'folder', prompt: 'Choose a folder' });
    expect(r.body.path).toBe('resources');
    expect(r.body.abs).toBe(path.join(tmp, 'resources')); // trailing separator dropped
  });

  it('a bare filesystem root keeps its separator', async () => {
    const root = path.parse(tmp).root;
    const r = await post(makeCtx(chooserReturning({ path: root })), '/api/pick-path', { mode: 'folder' });
    expect(r.body.abs).toBe(root);
  });

  it('a Cancel is {cancelled}; a failure is a 500, not a Cancel', async () => {
    expect((await post(makeCtx(chooserReturning({ canceled: true })), '/api/pick-path', {})).body).toEqual({ cancelled: true });
    const failed = await post(makeCtx(chooserReturning({ error: 'boom' })), '/api/pick-path', {});
    expect(failed.status).toBe(500);
    expect(failed.body.cancelled).toBeUndefined();
  });
});

describe('osascriptChooser — the fallback for a host with no Electron', () => {
  const cancelErr = () => Object.assign(new Error('Command failed: osascript'), { stderr: '0:180: execution error: User canceled. (-128)\n' });
  const otherErr = () => Object.assign(new Error('Command failed: osascript'), { stderr: '0:12: execution error: Can’t make file. (-1700)\n' });

  it('only -128 is a user cancel', () => {
    expect(isOsascriptUserCancel(cancelErr())).toBe(true);
    expect(isOsascriptUserCancel(otherErr())).toBe(false);
    expect(isOsascriptUserCancel(new Error('spawn osascript ENOENT'))).toBe(false);
  });

  it('a -128 exit is {canceled}; any other failure is {error} carrying stderr', async () => {
    const cancel: OsascriptRunner = async () => { throw cancelErr(); };
    const fail: OsascriptRunner = async () => { throw otherErr(); };
    expect(await osascriptChooser(cancel, 'darwin').saveFile({ prompt: 'p', defaultName: 'n', startDir: '/d' })).toEqual({ canceled: true });
    const out = await osascriptChooser(fail, 'darwin').pickPath({ mode: 'file', prompt: 'p' });
    expect(out).toEqual({ error: expect.stringMatching(/-1700/) });
  });

  it('passes the user strings as argv, never spliced into the script', async () => {
    const run = vi.fn<OsascriptRunner>(async () => ({ stdout: '/d/x.json\n' }));
    const out = await osascriptChooser(run, 'darwin').saveFile({ prompt: 'Save "it"', defaultName: 'a"b', startDir: '/d' });
    expect(out).toEqual({ path: '/d/x.json' });
    const args = run.mock.calls[0][0];
    expect(args.slice(-3)).toEqual(['Save "it"', 'a"b', '/d']);
    expect(args.slice(0, -3).join(' ')).not.toContain('a"b');
  });

  it('is {unsupported} off macOS, without spawning anything', async () => {
    const run = vi.fn<OsascriptRunner>();
    expect(await osascriptChooser(run, 'win32').saveFile({ prompt: 'p', defaultName: 'n', startDir: '/d' })).toEqual({ unsupported: true });
    expect(await osascriptChooser(run, 'linux').pickPath({ mode: 'folder', prompt: 'p' })).toEqual({ unsupported: true });
    expect(run).not.toHaveBeenCalled();
  });
});
