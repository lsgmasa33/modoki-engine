/** `POST /api/open-project` (#1587) through the real router, with the host's `projectSwitch` faked.
 *
 *  What the route owns, and so what is asserted here: which requests reach the host's open at all
 *  (relative path, non-project folder, the already-open project, unsaved work, an unreadable
 *  renderer), and that every host OUTCOME becomes the reply it means — in particular that only
 *  `opened` is a success. The Electron half (the open returning its outcome, readiness by reload
 *  epoch) is `tests/electron/rendererMountWaiter.test.ts` plus the live check in docs/editor.md. */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';
import { handleBackendRequest, type BackendContext } from '../../plugins/backend/editorBackendRouter';
import type { ProjectOpenOutcome } from '../../plugins/backend/openProjectRoute';

/** A scratch repo: `<repo>/games/{a,b}` are projects, `<repo>/games/empty` is a plain folder. */
function scratchRepo() {
  // canonical: the route compares against paths it resolved itself (macOS /var → /private/var).
  const repo = makeScratchDir('modoki-open-project-', { canonical: true });
  for (const id of ['a', 'b']) {
    fs.mkdirSync(path.join(repo, 'games', id), { recursive: true });
    fs.writeFileSync(path.join(repo, 'games', id, 'project.config.json'), '{}');
  }
  fs.mkdirSync(path.join(repo, 'games', 'empty'), { recursive: true });
  return { repo, a: path.join(repo, 'games', 'a'), b: path.join(repo, 'games', 'b'), empty: path.join(repo, 'games', 'empty') };
}

type Unsaved = 'clear' | 'held' | 'unanswered' | 'absent';

function makeCtx(opts: {
  repo: string; current: string; unsaved?: Unsaved;
  outcome?: ProjectOpenOutcome; noHost?: boolean;
  /** The host's open status; defaults to "nothing in flight, `current` opened". */
  status?: { inFlight: string | null; opened: string | null };
  /** What the host's backend expects now (C6). */
  token?: string | null;
  /** What it expects once `open()` has started — production switches it there. */
  tokenAfterOpen?: string | null;
  openThrows?: string;
}) {
  let token = opts.token ?? null;
  const opened: Array<{ root: string; timeoutMs: number }> = [];
  const asked: string[] = [];
  const ctx = {
    projectRoot: opts.current,
    editorRoot: opts.repo,
    requestBrowser: async (op: string, params: unknown) => {
      asked.push(op);
      if (op !== 'resolve-unsaved') throw new Error(`unexpected op ${op}`);
      const covers = (params as { registries?: string[] }).registries ?? [];
      switch (opts.unsaved ?? 'clear') {
        case 'clear': return { holds: [], discarded: [], covers };
        case 'held': return { holds: [{ path: '/assets/scenes/main.scene.json', registry: 'liveScene' }], discarded: [], covers };
        // A reply this build cannot read — "could not look", never "nothing is there".
        case 'unanswered': return { holds: [] };
        case 'absent': throw new Error('no editor renderer connected');
      }
    },
    ...(opts.noHost ? {} : {
      projectSwitch: {
        status: () => opts.status ?? { inFlight: null, opened: opts.current },
        expectedToken: () => token,
        open: async (root: string, o: { timeoutMs: number }) => {
          opened.push({ root, timeoutMs: o.timeoutMs });
          // Production switches the token when the open STARTS (refreshInstanceToken), so a reply
          // that read it before the open would carry the stale one.
          if (opts.tokenAfterOpen !== undefined) token = opts.tokenAfterOpen;
          if (opts.openThrows) throw new Error(opts.openThrows);
          return opts.outcome ?? { kind: 'opened', previousRoot: opts.current };
        },
      },
    }),
  } as unknown as BackendContext;
  return { ctx, opened, asked };
}

async function post(ctx: BackendContext, body: unknown) {
  const r = await handleBackendRequest(ctx, { method: 'POST', urlPath: '/api/open-project', query: new URLSearchParams(), body });
  if (!r || r.kind !== 'json') throw new Error('expected a json reply');
  return { status: r.status ?? 200, body: r.body as Record<string, unknown> };
}

describe('POST /api/open-project — what reaches the host open', () => {
  it('opens a different project and answers the post-state', async () => {
    const { repo, a, b } = scratchRepo();
    const { ctx, opened } = makeCtx({ repo, current: a });
    const r = await post(ctx, { path: b });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, opened: true, projectRoot: b, previousRoot: a });
    expect(opened).toEqual([{ root: b, timeoutMs: 120_000 }]);
  });

  it('hands the caller the token the editor expects from now on, and omits it when none was minted', async () => {
    const { repo, a, b } = scratchRepo();
    const withToken = await post(makeCtx({ repo, current: a, token: 'tok-b' }).ctx, { path: b });
    expect(withToken.body).toMatchObject({ ok: true, opened: true, token: 'tok-b' });
    const without = await post(makeCtx({ repo, current: a }).ctx, { path: b });
    expect('token' in without.body).toBe(false);
  });

  // The token switches when an open STARTS, so a caller told only on success is locked out by every
  // other outcome (#1587 close-out review, second pass).
  it('carries the expected token on EVERY outcome and refusal, read AFTER the open switched it', async () => {
    const { repo, a, b } = scratchRepo();
    const outcomes: ProjectOpenOutcome[] = [
      { kind: 'opened', previousRoot: a },
      { kind: 'timeout', stage: 'preparing' }, { kind: 'timeout', stage: 'mounting' },
      { kind: 'failed', detail: 'x' }, { kind: 'superseded', by: '/c' },
    ];
    for (const outcome of outcomes) {
      expect((await post(makeCtx({ repo, current: a, token: 'tok-a', tokenAfterOpen: 'tok-b', outcome }).ctx, { path: b })).body.token).toBe('tok-b');
    }
    // An open that THROWS, after it switched the token, still hands the new one back.
    const threw = await post(makeCtx({ repo, current: a, token: 'tok-a', tokenAfterOpen: 'tok-b', openThrows: 'createAssetBackend exploded' }).ctx, { path: b });
    expect(threw.status).toBe(500);
    expect(threw.body).toMatchObject({ ok: false, code: 'REFUSED_BY_OP', token: 'tok-b' });
    expect(String(threw.body.error)).toContain('createAssetBackend exploded');
    const inFlight = await post(makeCtx({ repo, current: a, token: 'tok-b', status: { inFlight: b, opened: a } }).ctx, { path: b });
    expect(inFlight.body).toMatchObject({ code: 'REFUSED_BY_OP', token: 'tok-b' });
    const unsaved = await post(makeCtx({ repo, current: a, token: 'tok-a', unsaved: 'held' }).ctx, { path: b });
    expect(unsaved.body).toMatchObject({ code: 'REQUIRES_SAVE', token: 'tok-a' });
  });

  it('answers alreadyOpen for the open project, trailing slash included, without opening or probing', async () => {
    const { repo, a } = scratchRepo();
    const { ctx, opened, asked } = makeCtx({ repo, current: a, unsaved: 'held' });
    const r = await post(ctx, { path: `${a}/` });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, opened: false, alreadyOpen: true, projectRoot: a });
    expect(opened).toEqual([]);
    expect(asked).toEqual([]);
  });

  it('refuses a repeat of an open still in flight — a timed-out call retried is not alreadyOpen', async () => {
    const { repo, a, b } = scratchRepo();
    const { ctx, opened, asked } = makeCtx({ repo, current: a, status: { inFlight: b, opened: a } });
    const r = await post(ctx, { path: b });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ ok: false, code: 'REFUSED_BY_OP' });
    expect(r.body.alreadyOpen).toBeUndefined();
    expect(opened).toEqual([]);
    expect(asked).toEqual([]);
  });

  it('re-opens after a FAILED open of the same project instead of calling it already open', async () => {
    const { repo, b } = scratchRepo();
    // The failed open left state.root at b with nothing loaded: `opened` is null.
    const { ctx, opened } = makeCtx({ repo, current: b, status: { inFlight: null, opened: null } });
    const r = await post(ctx, { path: b });
    expect(r.body).toMatchObject({ ok: true, opened: true });
    expect(opened.map((o) => o.root)).toEqual([b]);
  });

  it('opens the previous project while a different one is in flight (it queues behind it)', async () => {
    const { repo, a, b } = scratchRepo();
    const { ctx, opened } = makeCtx({ repo, current: a, status: { inFlight: b, opened: a } });
    expect((await post(ctx, { path: a })).body).toMatchObject({ ok: true, opened: true });
    expect(opened.map((o) => o.root)).toEqual([a]);
  });

  it('refuses a relative path and suggests the absolute project it most likely meant', async () => {
    const { repo, a, b } = scratchRepo();
    const { ctx, opened } = makeCtx({ repo, current: a });
    const r = await post(ctx, { path: 'games/b' });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ ok: false, code: 'REFUSED_BY_OP', options: [b] });
    expect(opened).toEqual([]);
  });

  it('refuses a relative path with no suggestion when nothing of that name is a project', async () => {
    const { repo, a } = scratchRepo();
    const { ctx } = makeCtx({ repo, current: a });
    const r = await post(ctx, { path: 'games/nope' });
    expect(r.status).toBe(400);
    expect(r.body.options).toBeUndefined();
  });

  it('refuses a folder with no project.config.json as NOT_FOUND', async () => {
    const { repo, a, empty } = scratchRepo();
    const { ctx, opened } = makeCtx({ repo, current: a });
    const r = await post(ctx, { path: empty });
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(opened).toEqual([]);
  });

  it('refuses a missing path', async () => {
    const { repo, a } = scratchRepo();
    const { ctx } = makeCtx({ repo, current: a });
    expect((await post(ctx, {})).body).toMatchObject({ ok: false, code: 'REFUSED_BY_OP' });
  });

  it('refuses unsaved work with REQUIRES_SAVE and never opens', async () => {
    const { repo, a, b } = scratchRepo();
    const { ctx, opened } = makeCtx({ repo, current: a, unsaved: 'held' });
    const r = await post(ctx, { path: b });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ ok: false, code: 'REQUIRES_SAVE' });
    expect(opened).toEqual([]);
  });

  it('opens over unsaved work with discardUnsaved, without asking the renderer', async () => {
    const { repo, a, b } = scratchRepo();
    const { ctx, opened, asked } = makeCtx({ repo, current: a, unsaved: 'held' });
    const r = await post(ctx, { path: b, discardUnsaved: true });
    expect(r.body).toMatchObject({ ok: true, opened: true });
    expect(opened.map((o) => o.root)).toEqual([b]);
    expect(asked).toEqual([]);
  });

  it('refuses when the renderer cannot answer the unsaved probe — could not look is not clear', async () => {
    const { repo, a, b } = scratchRepo();
    const { ctx, opened } = makeCtx({ repo, current: a, unsaved: 'unanswered' });
    const r = await post(ctx, { path: b });
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ ok: false, code: 'NO_RENDERER' });
    expect(opened).toEqual([]);
  });

  it('proceeds when no renderer exists at all', async () => {
    const { repo, a, b } = scratchRepo();
    const { ctx, opened } = makeCtx({ repo, current: a, unsaved: 'absent' });
    expect((await post(ctx, { path: b })).body).toMatchObject({ ok: true, opened: true });
    expect(opened).toHaveLength(1);
  });

  it('clamps timeoutMs into its stated range and refuses a non-number', async () => {
    const { repo, a, b } = scratchRepo();
    const low = makeCtx({ repo, current: a });
    await post(low.ctx, { path: b, timeoutMs: 5 });
    expect(low.opened[0].timeoutMs).toBe(1_000);
    const high = makeCtx({ repo, current: a });
    await post(high.ctx, { path: b, timeoutMs: 9e9 });
    expect(high.opened[0].timeoutMs).toBe(600_000);
    const bad = makeCtx({ repo, current: a });
    expect((await post(bad.ctx, { path: b, timeoutMs: 'soon' })).body).toMatchObject({ ok: false, code: 'REFUSED_BY_OP' });
    expect(bad.opened).toEqual([]);
  });

  it('answers NOT_AVAILABLE_HERE on a host with no project switch', async () => {
    const { repo, a, b } = scratchRepo();
    const { ctx } = makeCtx({ repo, current: a, noHost: true });
    const r = await post(ctx, { path: b });
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ ok: false, code: 'NOT_AVAILABLE_HERE' });
  });
});

describe('POST /api/open-project — only `opened` is a success', () => {
  const cases: Array<[string, ProjectOpenOutcome, number, string]> = [
    ['failed', { kind: 'failed', detail: 'npm install exited 1' }, 400, 'REFUSED_BY_OP'],
    ['superseded', { kind: 'superseded', by: '/elsewhere' }, 409, 'REFUSED_BY_OP'],
    ['timeout while preparing', { kind: 'timeout', stage: 'preparing' }, 504, 'TIMEOUT'],
    ['timeout while mounting', { kind: 'timeout', stage: 'mounting' }, 504, 'TIMEOUT'],
  ];
  for (const [name, outcome, status, code] of cases) {
    it(`${name} → ${code}`, async () => {
      const { repo, a, b } = scratchRepo();
      const { ctx } = makeCtx({ repo, current: a, outcome });
      const r = await post(ctx, { path: b });
      expect(r.status).toBe(status);
      expect(r.body).toMatchObject({ ok: false, code });
      expect(r.body.opened).toBeUndefined();
    });
  }

  it('a failure carries the host detail, and a timeout says the open is still running', async () => {
    const { repo, a, b } = scratchRepo();
    const failed = await post(makeCtx({ repo, current: a, outcome: { kind: 'failed', detail: 'npm install exited 1' } }).ctx, { path: b });
    expect(String(failed.body.error)).toContain('npm install exited 1');
    const timedOut = await post(makeCtx({ repo, current: a, outcome: { kind: 'timeout', stage: 'mounting' } }).ctx, { path: b });
    expect(String(timedOut.body.error)).toMatch(/NOT cancelled/);
  });
});
