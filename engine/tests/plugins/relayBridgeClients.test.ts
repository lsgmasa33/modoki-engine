/**
 * The SEAM between #1030's decline counting and Vite — the one the first two rounds of this fix
 * left uncovered.
 *
 * ⚠️ **Why this file exists.** #1030's logic lives in pure functions (`createBrowserRequestRegistry`,
 * `settleRelayReply`, `countLiveBridgeClients`, `relayResponseFor`) and every one of them is tested
 * directly. The lines that hand those functions their inputs in production are three callbacks
 * inside `configureServer`, and reverting them to their pre-fix single-argument shape —
 *
 *     ws.on('modoki:response', (data) => { settleRelayReply(browserRequests, data); });
 *
 * — **typechecks** (the `ws` cast takes `(data: any) => void`, so a 1-arg callback is assignable)
 * and left 3618 tests green while reinstating #1030 IN FULL: `bridgeClients` stays empty,
 * `liveBridgeClientCount()` returns 0, `Math.max(1, 0)` makes `expected` 1 for every relayed op,
 * and the first decline from any tab settles the request again. The duplicate-decline dedupe dies
 * with it, because `client` is `undefined` everywhere.
 *
 * So this drives the REAL plugin: real `configureServer`, real `requestBrowser`, real registry,
 * real `ws.on` callbacks — and asserts the property the pure tests cannot see, that a decline from
 * one announced client does not answer for another.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assetScannerPlugin } from '../../plugins/vite-asset-scanner';

type WsMessage = { type: string; event?: string; data?: unknown };
type WsHandler = (data: unknown, client?: unknown) => void;

let projectRoot: string;
let savedProject: string | undefined;

/** A stub dev server that records what the plugin sends and hands back the callbacks it
 *  registers, so a test can play the part of two browser tabs. */
function armPlugin(clients: Set<unknown>) {
  const sent: WsMessage[] = [];
  const on = new Map<string, WsHandler[]>();
  let middleware: ((req: unknown, res: unknown, next: () => void) => unknown) | null = null;

  const p = assetScannerPlugin() as unknown as {
    configResolved: (c: { root: string }) => void;
    configureServer: (s: unknown) => void;
  };
  p.configResolved({ root: path.join(projectRoot, 'engine') });
  p.configureServer({
    ws: {
      send: (m: WsMessage) => { sent.push(m); },
      on: (event: string, cb: WsHandler) => { on.set(event, [...(on.get(event) ?? []), cb]); },
      clients,
    },
    watcher: { add: () => {}, on: () => {} },
    middlewares: {
      use: (fn: typeof middleware) => {
        // Loud rather than last-wins: the plugin registers exactly one middleware today, and a
        // second one added later would silently change what these tests drive.
        if (middleware) throw new Error('the plugin registered a SECOND middleware — this harness drives only one');
        middleware = fn;
      },
    },
    httpServer: null,
  });

  const fire = (event: string, data: unknown, client?: unknown) => {
    for (const cb of on.get(event) ?? []) cb(data, client);
  };
  return { sent, fire, get middleware() { return middleware; } };
}

/** Let the middleware's own awaits run. It is `async` and reaches the relay only after
 *  `serveProjectAsset`, so a synchronous read of `sent` sees nothing. */
const tick = () => new Promise((r) => setTimeout(r, 0));

/** A minimal IncomingMessage for a relayed GET. `on` exists because the router attaches body
 *  listeners unconditionally; a GET never emits, so no data is ever pushed. */
function fakeReq(url = '/api/editor-state') {
  // ⚠️ The router dispatches inside `req.on('end', …)`, so a no-op `on` makes the whole route
  // silently never run — the first draft of this harness did exactly that and looked like the
  // relay was broken. 'data' never fires for a GET; 'end' must.
  return {
    url, method: 'GET', headers: {}, setEncoding: () => {},
    on: (event: string, cb: (c?: unknown) => void) => { if (event === 'end') setTimeout(() => cb(), 0); },
  } as unknown;
}

/** A minimal ServerResponse that records whether — and with what — it finished. */
function fakeRes() {
  const state = { ended: false, status: 200, body: '' };
  const res = {
    statusCode: 200,
    setHeader: () => {},
    end: (b?: string) => { state.ended = true; state.status = res.statusCode; state.body = b ?? ''; },
    get writableEnded() { return state.ended; },
  };
  return { res: res as unknown, state };
}

beforeEach(() => {
  projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-relay-')));
  fs.mkdirSync(path.join(projectRoot, 'engine'), { recursive: true });
  savedProject = process.env.MODOKI_PROJECT;
  delete process.env.MODOKI_PROJECT;
});
afterEach(() => {
  if (savedProject === undefined) delete process.env.MODOKI_PROJECT;
  else process.env.MODOKI_PROJECT = savedProject;
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

describe('the relay counts ANNOUNCED clients, through the real plugin wiring (#1030)', () => {
  it('a decline from one announced client does not answer for the other', async () => {
    const tabA = { id: 'runtime-tab' };      // no editor ops — declines instantly
    const tabB = { id: 'editor-tab' };       // does the work
    const clients = new Set<unknown>([tabA, tabB]);
    const h = armPlugin(clients);

    // Both tabs announce the bridge the instant they can answer (agentBridge's `announce`).
    h.fire('modoki:bridge-hello', {}, tabA);
    h.fire('modoki:bridge-hello', {}, tabB);

    const { res, state } = fakeRes();
    expect(h.middleware, 'the plugin registered no middleware — fix the harness').toBeTruthy();
    void h.middleware!(fakeReq(), res, () => {});
    await tick(); await tick();

    // The relay broadcast really went out.
    const req = h.sent.find((m) => m.event === 'modoki:request');
    expect(req, 'no modoki:request was broadcast — the route did not relay').toBeTruthy();
    const id = (req!.data as { id: number }).id;

    // The runtime tab loses the race it used to win.
    h.fire('modoki:response', { id, error: `unknown agent op 'editor-state'` }, tabA);
    await tick();
    expect(state.ended, 'a single decline must NOT settle a request two clients could answer')
      .toBe(false);

    // The editor answers, and that is the reply that counts.
    h.fire('modoki:response', { id, result: { scenePath: '/assets/scenes/main.scene.json' } }, tabB);
    await tick(); await tick();
    expect(state.ended).toBe(true);
    expect(state.body).toContain('main.scene.json');
  });

  it('settles once EVERY announced client has declined — nothing out there has the op', async () => {
    const tabA = { id: 'a' }, tabB = { id: 'b' };
    const h = armPlugin(new Set<unknown>([tabA, tabB]));
    h.fire('modoki:bridge-hello', {}, tabA);
    h.fire('modoki:bridge-hello', {}, tabB);

    const { res, state } = fakeRes();
    void h.middleware!(fakeReq(), res, () => {});
    await tick(); await tick();
    const id = (h.sent.find((m) => m.event === 'modoki:request')!.data as { id: number }).id;

    h.fire('modoki:response', { id, declined: true }, tabA);
    await tick();
    expect(state.ended).toBe(false);
    h.fire('modoki:response', { id, declined: true }, tabB);
    await tick(); await tick();
    // ⚠️ Not just `ended` — that is also true if the route threw and ended the response. The
    // all-declined path must surface as the relay's own refusal, not as a 200 or a crash.
    expect(state.ended).toBe(true);
    expect(state.status, 'an all-declined relay must not report success').not.toBe(200);
  });

  it('a client that DISCONNECTED is not counted — its decline can never arrive', async () => {
    // The prune. Without it the set holds every client ever seen, the denominator never
    // completes, and every relayed op rides the caller's full budget.
    const tabA = { id: 'a' }, gone = { id: 'gone' };
    const clients = new Set<unknown>([tabA, gone]);
    const h = armPlugin(clients);
    h.fire('modoki:bridge-hello', {}, tabA);
    h.fire('modoki:bridge-hello', {}, gone);
    // ⚠️ `gone` STAYS in the stub's `ws.clients`, deliberately. Removing it there too — which the
    // first version of this case did — makes the live intersection exclude it whether or not the
    // prune handler exists, so the case passed with the entire `vite:client:disconnect` listener
    // deleted. Leaving it in means ONLY the prune can bring the denominator down to one.
    h.fire('vite:client:disconnect', {}, gone);

    const { res, state } = fakeRes();
    void h.middleware!(fakeReq(), res, () => {});
    await tick(); await tick();
    const id = (h.sent.find((m) => m.event === 'modoki:request')!.data as { id: number }).id;

    h.fire('modoki:response', { id, declined: true }, tabA);
    await tick(); await tick();
    expect(state.ended, 'the only client that could reply declined — settle, do not wait').toBe(true);
    expect(state.status, 'and settle as a refusal, not as a success').not.toBe(200);
  });
});
