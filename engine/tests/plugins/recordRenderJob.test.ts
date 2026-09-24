/** The editor's render job (#1488): the progress it keeps, how it ends, and — the part that matters
 *  most — that Cancel stops what the CLI started.
 *
 *  The runner is driven through its REAL spawn (`defaultSpawnRender`) against a fake CLI written
 *  here. The fake starts a DETACHED grandchild, in a process group of its own, which is exactly how
 *  Playwright starts Chromium: a cancel that killed the CLI's group instead of closing its stdin
 *  would leave that grandchild running, and this suite would see it. */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';

// The reveal route opens Finder on the human's desktop — the test asserts what it would open instead.
const revealed = vi.hoisted(() => [] as string[]);
vi.mock('../../plugins/backend/osOpen', async (orig) => ({
  ...(await orig<typeof import('../../plugins/backend/osOpen')>()),
  revealInOS: async (p: string) => { revealed.push(p); },
}));
import fs from 'fs';
import path from 'path';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';
import {
  RenderJobRunner, applyProgressLine, applyExit, renderAvailability, defaultSpawnRender, renderJobs, type RenderJobView,
} from '../../plugins/backend/recordRenderJob';
import { handleBackendRequest, type BackendContext } from '../../plugins/backend/editorBackendRouter';

const OPTIONS = { fps: 30, scale: 1, format: 'mp4' as const, outDir: null, keepFrames: false };

/** The fake CLI. Its behaviour is chosen by the take's file name; it writes the grandchild's pid
 *  beside the take so the test can check it is gone. */
const FAKE_CLI = `
const { spawn } = require('child_process');
const fs = require('fs');
const take = process.argv[2];
const mode = require('path').basename(take).replace('.take.json', '');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
out({ stage: 'start', total: 3, size: { width: 2, height: 2 }, video: take + '.mp4' });
if (mode === 'ok') {
  out({ stage: 'server' }); out({ stage: 'boot' });
  for (let f = 1; f <= 3; f++) out({ stage: 'frames', frame: f, total: 3 });
  process.stdout.write('not json\\n');
  out({ stage: 'done', video: take + '.mp4', reportFile: 'r.json', size: { width: 2, height: 2 }, frames: 3, fps: 30,
    renderSeconds: 1, undispatchedEvents: 0, unsettled: [], pageErrors: 0, pageErrorSample: [], replay: { status: 'matched', events: 0 } });
  process.exit(0);
}
if (mode === 'crash') { console.error('boom: something broke'); process.exit(3); }
const gc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
fs.writeFileSync(take + '.pid', String(gc.pid));
out({ stage: 'frames', frame: 1, total: 3 });
if (mode === 'deaf') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else {
  process.stdin.on('end', () => { try { process.kill(gc.pid, 'SIGKILL'); } catch {} out({ stage: 'cancelled' }); process.exit(143); });
  process.stdin.resume();
}
`;

let dir: string;
let script: string;
const take = (mode: string) => { const p = path.join(dir, `${mode}.take.json`); fs.writeFileSync(p, '{}'); return p; };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (cond: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); }
};
const leftovers: number[] = [];

beforeAll(() => {
  dir = makeScratchDir('modoki-render-job-');
  script = path.join(dir, 'fake-cli.cjs');
  fs.writeFileSync(script, FAKE_CLI);
});
afterEach(() => { for (const pid of leftovers.splice(0)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } });
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const start = (runner: RenderJobRunner, mode: string) => runner.start({ repoRoot: dir, scriptPath: script, take: take(mode), options: OPTIONS });

describe('RenderJobRunner', () => {
  it('follows the CLI\'s progress to done, keeping a stray non-JSON line in the log', async () => {
    const runner = new RenderJobRunner();
    const r = start(runner, 'ok');
    expect(r.ok).toBe(true);
    await until(() => runner.current()!.status !== 'running');
    const v = runner.current()!;
    expect(v).toMatchObject({ status: 'done', stage: 'done', frame: 3, total: 3, video: expect.stringMatching(/ok\.take\.json\.mp4$/) });
    expect(v.result).toMatchObject({ frames: 3, replay: { status: 'matched' } });
    expect(v.log).toContain('not json');
  });

  it('refuses a second render while one runs, and bad options before spawning anything', async () => {
    const runner = new RenderJobRunner();
    expect(start(runner, 'waits').ok).toBe(true);
    await until(() => runner.current()!.stage === 'frames');
    leftovers.push(Number(fs.readFileSync(path.join(dir, 'waits.take.json.pid'), 'utf8')));
    expect(start(runner, 'ok')).toEqual({ ok: false, status: 409, error: expect.stringMatching(/already running/) });
    runner.cancel();
    await until(() => runner.current()!.status !== 'running');
    const bad = runner.start({ repoRoot: dir, scriptPath: script, take: take('ok'), options: { ...OPTIONS, fps: 24 } });
    expect(bad).toEqual({ ok: false, status: 400, error: expect.stringMatching(/FPS must be between 30/) });
  });

  it('Cancel closes the CLI\'s stdin, and the CLI\'s own teardown reaches its DETACHED grandchild', async () => {
    const runner = new RenderJobRunner();
    start(runner, 'waits');
    await until(() => runner.current()!.stage === 'frames');
    const gc = Number(fs.readFileSync(path.join(dir, 'waits.take.json.pid'), 'utf8'));
    leftovers.push(gc);
    expect(alive(gc)).toBe(true);
    expect(runner.cancel()).toMatchObject({ cancelRequested: true, status: 'running' });
    await until(() => runner.current()!.status !== 'running');
    expect(runner.current()).toMatchObject({ status: 'cancelled', stage: 'cancelled' });
    await until(() => !alive(gc), 3000);
  });

  it('kills a CLI that ignores the cancel once the grace runs out, and still ends the job cancelled', async () => {
    const runner = new RenderJobRunner(defaultSpawnRender, Date.now, 300);
    start(runner, 'deaf');
    await until(() => runner.current()!.stage === 'frames');
    leftovers.push(Number(fs.readFileSync(path.join(dir, 'deaf.take.json.pid'), 'utf8')));
    runner.cancel();
    // The grace, then `killBuildProcess`'s own SIGTERM-to-SIGKILL escalation (5 s) for a CLI that ignores SIGTERM too.
    await until(() => runner.current()!.status !== 'running', 8000);
    expect(runner.current()).toMatchObject({ status: 'cancelled' });
  }, 12_000);

  it('ends a CLI that died without a closing line as an error, with its last words', async () => {
    const runner = new RenderJobRunner();
    start(runner, 'crash');
    await until(() => runner.current()!.status !== 'running');
    expect(runner.current()).toMatchObject({ status: 'error', error: 'the render exited with code 3 before it finished' });
    expect(runner.current()!.log).toContain('boom: something broke');
  });

  it('has nothing to cancel when nothing runs', () => {
    expect(new RenderJobRunner().cancel()).toBeNull();
  });
});

describe('applyProgressLine / applyExit', () => {
  const base = (): RenderJobView => ({
    id: 1, take: 't', options: OPTIONS, status: 'running', stage: 'starting', frame: 0, total: null, size: null, video: null,
    startedAt: 0, stageStartedAt: 0, finishedAt: null, cancelRequested: false, result: null, error: null, log: [],
  });

  it('restarts the stage clock only when the stage changes — the card\'s ETA is per stage', () => {
    let v = applyProgressLine(base(), { stage: 'frames', frame: 1, total: 10 }, 100);
    v = applyProgressLine(v, { stage: 'frames', frame: 2, total: 10 }, 200);
    expect(v.stageStartedAt).toBe(100);
    v = applyProgressLine(v, { stage: 'encode', frame: 0, total: 10 }, 300);
    expect(v).toMatchObject({ stage: 'encode', stageStartedAt: 300, frame: 0 });
  });

  it('ignores a stage it does not know, so a newer CLI does not break an older editor', () => {
    expect(applyProgressLine(base(), { stage: 'mixing-audio' }, 5)).toEqual(base());
  });

  it('leaves a job the CLI already closed alone at exit', () => {
    const done = applyProgressLine(base(), { stage: 'error', message: 'no scene' }, 5);
    expect(applyExit(done, 1, null, 9)).toBe(done);
    expect(applyExit(base(), null, 'SIGKILL', 9)).toMatchObject({ status: 'error', error: 'the render was killed (SIGKILL) before it finished' });
  });
});

describe('renderAvailability', () => {
  it('is off in the packaged editor, which ships no Playwright Chromium', () => {
    expect(renderAvailability(path.join(__dirname, '../../..'), { MODOKI_PACKAGED: '1' })).toMatchObject({ available: false, reason: expect.stringMatching(/packaged editor/) });
  });
  it('is on in this repo', () => {
    expect(renderAvailability(path.join(__dirname, '../../..'), {})).toEqual({ available: true, reason: null });
  });
  it('is off without the script', () => {
    expect(renderAvailability(dir, {}).available).toBe(false);
  });
});

describe('/api/record/render', () => {
  const repo = path.join(__dirname, '../../..');
  const ctx = (): BackendContext => ({ projectRoot: dir, editorRoot: repo } as unknown as BackendContext);
  const post = (body: unknown) => handleBackendRequest(ctx(), { method: 'POST', urlPath: '/api/record/render', query: new URLSearchParams(), body }) as Promise<{ status?: number; body: { error?: string } }>;

  it('refuses a take that is not an absolute .take.json', async () => {
    expect((await post({ take: 'rel.take.json', options: OPTIONS })).status).toBe(400);
    expect((await post({ take: path.join(dir, 'x.json'), options: OPTIONS })).status).toBe(400);
  });
  it('refuses a take outside the open project — the CLI reads it and writes beside it', async () => {
    expect((await post({ take: path.join(repo, 'elsewhere.take.json'), options: OPTIONS })).status).toBe(403);
  });
  it('refuses a take that is not there', async () => {
    expect((await post({ take: path.join(dir, 'missing.take.json'), options: OPTIONS })).status).toBe(404);
  });
  it('refuses bad options before starting anything', async () => {
    const r = await post({ take: take('opts'), options: { ...OPTIONS, scale: 9 } });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Scale must be/);
  });
  it('reveals only the video of the job it names — never a path the caller sends', async () => {
    const reveal = (body: unknown) => handleBackendRequest(ctx(), { method: 'POST', urlPath: '/api/record/render/reveal', query: new URLSearchParams(), body }) as Promise<{ status?: number }>;
    // A finished job on the backend's own runner, whose video exists.
    const t = take('ok');
    fs.writeFileSync(`${t}.mp4`, '');
    expect(renderJobs.start({ repoRoot: dir, scriptPath: script, take: t, options: OPTIONS }).ok).toBe(true);
    await until(() => renderJobs.current()!.status === 'done');
    const id = renderJobs.current()!.id;
    revealed.length = 0;
    expect((await reveal({ id: id + 1 })).status).toBe(404);
    expect((await reveal({ path: '/etc' })).status).toBe(404);
    expect(revealed).toEqual([]);
    expect((await reveal({ id })).status).toBeUndefined();
    expect(revealed).toEqual([`${t}.mp4`]);
  });

  it('reports availability and the current job on GET', async () => {
    const r = await handleBackendRequest(ctx(), { method: 'GET', urlPath: '/api/record/render', query: new URLSearchParams(), body: undefined }) as { body: Record<string, unknown> };
    expect(r.body).toMatchObject({ available: true, reason: null });
    expect(r.body).toHaveProperty('job');
  });
});
