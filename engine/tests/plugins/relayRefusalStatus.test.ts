/** #1013 — a relayed route must not report its own op's REFUSAL as an unreachable editor.
 *
 *  `ctx.requestBrowser` rejects identically whether the RELAY died (the renderer is gone, the
 *  websocket is not up, the window closed) or the OP threw (a deliberate, correct "no"). Twenty-six
 *  routes caught that with a hard-coded **504**, which the MCP client maps to `NOT_AVAILABLE_HERE`
 *  — *"could not look: auth/network/route absent"* — for a case that was *"it said no"*. An agent
 *  reading that goes off to relaunch an editor which is answering perfectly well.
 *
 *  ⚠️ **The accept side is the half that needs pinning, not the refuse side.** `relayFailureStatus`
 *  keeps the 504 for a GENUINE transport failure by matching the message, and that list has been
 *  found incomplete by three separate review rounds (see its own banner). A fix that turned every
 *  504 into a 400 would pass every refuse-side test in this file and be a worse bug than the one it
 *  replaced — so each transport signature is exercised by name, with the real strings
 *  `failPendingRenderer` sends rather than a sentinel this test also owns.
 *
 *  ⚠️ **`modoki_eval` is not among the 33 tools `test:mcp:live` sweeps** — it can run arbitrary
 *  code, so it is un-sweepable by construction. That is why #1013's own symptom could be wrong
 *  indefinitely with a green gate, and why the route is covered here instead. */

import { describe, it, expect } from 'vitest';
import os from 'os';
import path from 'path';
import { readScannedSource } from '@modoki/engine/testing';
import { handleBackendRequest, type BackendContext, type Manifest } from '../../plugins/backend/editorBackendRouter';

const PROJECT = path.join(os.tmpdir(), 'relay-refusal-proj');

/** A ctx whose only interesting behaviour is what the relay does. */
function makeCtx(relay: () => Promise<unknown>): BackendContext {
  const root = path.join(PROJECT, 'runtime');
  return {
    projectRoot: PROJECT,
    resolveAssetPath: () => null,
    absToAssetUrl: () => null,
    firstRootDir: () => root,
    getManifest: () => ({ version: 2, assets: [] }) as Manifest,
    rebuildManifest: () => ({ version: 2, assets: [] }) as Manifest,
    requestBrowser: () => relay(),
    getSchema: () => undefined,
    invalidateProjectConfig: () => {},
  } as unknown as BackendContext;
}

const call = async (
  relay: () => Promise<unknown>,
  urlPath: string,
  method: 'GET' | 'POST' = 'POST',
  body?: unknown,
) => await handleBackendRequest(makeCtx(relay), {
  method, urlPath, query: new URLSearchParams(), body,
}) as { status?: number; body: Record<string, unknown> };

const OP_REFUSAL = 'load-scene: the scene edits would be DESTROYED (gone from the world, the file, '
  + 'and the undo stack) — save first, or pass discardUnsaved.';

/** The strings `failPendingRenderer` (engine/electron/main.ts) and the Vite relay actually send.
 *  ⚠️ Taken from the source, not invented here: a test that supplies its own sentinel proves the
 *  test's spelling, not the classifier's. */
const TRANSPORT_FAILURES = [
  'editor window closed',
  'project changed — renderer reloading',
  'timed out waiting for the BROWSER',
  'Object has been destroyed',
];

describe('#1013 — a relayed route classifies the op ANSWERING vs the RELAY failing', () => {
  /** ⚠️ **#1013's headline claim about this route is FALSE, and driving it is what showed that.**
   *  The issue says an op refusing inside an eval body "rejects the eval, rejects the `eval` op, and
   *  lands in that catch". It does not: `handleEval` (`engine/app/debug/bridgeHelpers.ts`) wraps the
   *  whole body — the awaited `withTimeout` included — in one `try`, and returns
   *  `` `Error: ${e.message}` `` as the RESULT. Measured against a live editor on 2026-09-10:
   *
   *      POST /api/eval {"code":"throw new Error('boom')"}            -> 200 {"result":"Error: boom"}
   *      POST /api/eval {"code":"return await modoki.call('…bad…')"}  -> 200 {"result":"Error: …"}
   *
   *  So this route's catch is reachable only by a genuine RELAY failure, where the hard-coded 504
   *  was already correct. The defect is real at the other 25 routes, which relay an op directly and
   *  do see its rejection — that is where the fix earns its keep, and `/api/eval` is swept for
   *  consistency rather than for a bug. The tests below pin the route's CLASSIFIER; they do not
   *  claim the refusal path is production-reachable here. Commented on the issue. */
  describe('/api/eval — swept for consistency; its own premise did not survive being driven', () => {
    it('classifies an unrecognized relay rejection as the op answering (400)', async () => {
      const r = await call(() => Promise.reject(new Error(OP_REFUSAL)), '/api/eval', 'POST', { code: '1' });
      expect(r.status, 'unrecognized => the op spoke; the conservative default').toBe(400);
      expect(String(r.body.error)).toContain('discardUnsaved');
    });

    // ⚠️ THE ACCEPT SIDE, and for THIS route it is the only reachable one — see the banner above.
    // A genuinely dead renderer reached through /api/eval must still be a 504.
    it.each(TRANSPORT_FAILURES)('keeps 504 for a real transport failure: %s', async (msg) => {
      const r = await call(() => Promise.reject(new Error(msg)), '/api/eval', 'POST', { code: '1' });
      expect(r.status, `"${msg}" is the relay failing, not the op answering`).toBe(504);
    });

    /** ⚠️ The one route where an `{ok:false, code}` reply must NOT be read as a §5 refusal: it is
     *  the eval's own RETURN VALUE, so an agent whose body ends `return {ok:false, code:'NOT_FOUND'}`
     *  is returning data. Treating it as a refusal would turn a successful eval into a 400. */
    it('passes an ok:false eval RESULT through as data, not as a refusal', async () => {
      const r = await call(async () => ({ ok: false, code: 'NOT_FOUND', error: 'my own return value' }),
        '/api/eval', 'POST', { code: '1' });
      expect(r.status, 'the eval succeeded; its result merely looks like an envelope').toBeUndefined();
      expect(r.body.result).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    });
  });

  describe('the other relayed routes — same rule, one tool each', () => {
    it('game-tool-call: a refusing game tool is the op answering', async () => {
      const r = await call(() => Promise.reject(new Error('court_load_level: no such level')), '/api/game-tool-call');
      expect(r.status).toBe(400);
    });

    it('game-tool-call: a dead renderer is still the relay failing', async () => {
      const r = await call(() => Promise.reject(new Error('editor window closed')), '/api/game-tool-call');
      expect(r.status).toBe(504);
    });

    /** ⚠️ **No op reachable through `relayJson` emits a §5 envelope TODAY** — an exhaustive grep of
     *  `code: '<ERROR_CODES member>'` finds only `render-scene`, `scene-query`, `player-prefs-*`
     *  and a few editor ops, none of them in this set. So the envelope cases below pin a
     *  forward-looking contract rather than a live path: they are falsifiable against the router
     *  (deleting the relay reddens them) but no production reply drives them yet. Stated rather
     *  than left implied, because a reader counting these as coverage of a live failure would be
     *  wrong twice over. */
    it('relays a returned §5 envelope as itself, on its code\'s status', async () => {
      const r = await call(async () => ({ ok: false, code: 'NO_RENDERER', error: 'no 3D surface is mounted' }),
        '/api/game-tools', 'GET');
      expect(r.status, 'one code, one status — NO_RENDERER is 503 everywhere in this router').toBe(503);
      expect(r.body, 'the envelope travels intact, not reshaped').toMatchObject({ ok: false, code: 'NO_RENDERER' });
    });

    it('a plain reply is untouched — status stays unset', async () => {
      const r = await call(async () => ({ tools: [] }), '/api/game-tools', 'GET');
      expect(r.status).toBeUndefined();
      expect(r.body).toMatchObject({ tools: [] });
    });

    /** ⚠️ **The accept side of the ENVELOPE rule, and the one that would bite hardest.** On several
     *  routes `ok:false` is the ANSWER, not a refusal — `diagnose` reports scene health that way,
     *  and `validate_scene` reports a verdict. Re-statusing those to 400 would turn "your scene is
     *  unhealthy" into "the call failed". What keeps them apart is that `opRefusal` demands a
     *  `code` from the CLOSED set, not merely `ok:false`. Verified against the live editor
     *  (2026-09-10): `/api/diagnose` answers `ok` with no `code` field at all. */
    it('does NOT re-status an ok:false reply that carries no §5 code — ok is the ANSWER there', async () => {
      const r = await call(async () => ({ ok: false, summary: 'two refs are dangling', refs: [] }),
        '/api/diagnose', 'GET');
      expect(r.status, 'a health verdict is not a refusal').toBeUndefined();
      expect(r.body).toMatchObject({ ok: false, summary: 'two refs are dangling' });
    });

    it('does NOT re-status an ok:false reply whose `code` is not in the closed set', async () => {
      const r = await call(async () => ({ ok: false, code: 'SCENE_UNHEALTHY' }), '/api/game-tools', 'GET');
      expect(r.status, 'only a code from ERROR_CODES is a claim to be a §5 refusal').toBeUndefined();
    });

    /** ⚠️ **This case asserts the STATUS and nothing else, deliberately.** It first carried
     *  `not.toHaveProperty('byEditor')` and `not.toHaveProperty('hint')` to pin "the envelope is
     *  not reshaped into a decorated summary" — and review measured both passing with the
     *  `opRefusal` check deleted, because `enact-handles` gates its decoration on
     *  `Array.isArray(res.handles)` and `{ok:false, code}` cannot pass that. The reshaping never
     *  could happen; the bug was the 200. Two assertions that hold under both hypotheses are the
     *  `docs/falsifiable-tests.md` shape, and they were here to support a story rather than a
     *  mechanism, so they are gone. `/api/editor-state` is the route that really does spread
     *  unconditionally — covered below. */
    it('handles: a §5 envelope comes back on its code\'s status, not as a 200', async () => {
      const r = await call(async () => ({ ok: false, code: 'NO_RENDERER', error: 'nothing mounted' }),
        '/api/enact-handles', 'GET');
      expect(r.status).toBe(503);
      expect(r.body, 'and travels intact').toMatchObject({ ok: false, code: 'NO_RENDERER' });
    });

    /** The route that DOES spread unconditionally: `/api/editor-state` merges `scenePathRef`,
     *  `heldPointer` and `persistenceMode` into whatever the renderer returned. Without the check
     *  an envelope came back as a 200 whose body is a refusal wearing `persistenceMode` — a
     *  refusal reshaped into a plausible answer, which §0 ranks above a wrong status. */
    it('editor-state: an envelope is not merged with the main-process facts', async () => {
      const r = await call(async () => ({ ok: false, code: 'NO_RENDERER', error: 'nothing mounted' }),
        '/api/editor-state', 'GET');
      expect(r.status).toBe(503);
      expect(r.body, 'not decorated with a main-process fact').not.toHaveProperty('persistenceMode');
    });

    /** ⚠️ **F5: an op that is ABSENT is "could not look", not "the op declined".** `runAgentOp`
     *  throws `unknown agent op '<name>'` when the bridge is connected from a game page rather than
     *  `#/editor`, or in the window before `registerEditorAgentOps()` runs — a normal launch race.
     *  Adopting the classifier moved those routes to 400 → `REFUSED_BY_OP`, which `ERROR_CODES`
     *  defines as "the operation itself declined": a claim about an operation that does not exist.
     *  The same could-not-look/it-said-no inversion this whole change is about, mirrored. */
    it('an unknown agent op is the route being ABSENT — 504, not 400', async () => {
      const r = await call(() => Promise.reject(new Error("unknown agent op 'editor-journal'")),
        '/api/editor-journal', 'GET');
      expect(r.status).toBe(504);
    });
  });
});

/** ⚠️ **The class, not the instance.** Twenty-six routes shared this defect; without a guard the
 *  twenty-seventh re-adds it and #1013 is whack-a-mole with a fresh coat. Modelled on
 *  `reapScoping.test.ts`, which exists for the same reason.
 *
 *  ⚠️ **Scope, stated so it is not over-read:** this guards `editorBackendRouter.ts` ONLY. The
 *  Electron host relays too (`electron/main.ts` — `capture-viewport`, `capture-gesture`,
 *  `input/*`), but it carries no literal 504 at all: an uncaught throw there reaches
 *  `backendServer.ts`'s catch-all as a **500**, a different shape needing a different guard.
 *  Verified by grep, not assumed.
 *
 *  ⚠️ It matches a bare `504`, not the `}, 504)` spelling it first used — that substring form
 *  cannot see `json(\n  { error: msg },\n  504,\n);`, and this file already uses that multi-line
 *  shape for a 503. The single legitimate 504 (`relayFailureStatus`'s own return) is allowed by
 *  name, so the guard reads as "one place decides this", which is the actual rule.
 *
 *  ⚠️ Source comes through `readScannedSource`, NOT `fs.readFileSync` (#812). The first version
 *  hand-filtered lines starting with `*` or `//`, which `commentStripperIsShared.test.ts` caught —
 *  correctly: that filter cannot see a comment sharing a line with code, so `/* … *​/ return
 *  json({ error }, 504);` would have been INVISIBLE to a guard whose whole job is to find it. The
 *  prose in this file discusses 504 constantly, so the strip is what makes the scan meaningful in
 *  both directions. */
describe('#1013 — no route may hard-code its catch status', () => {
  it('editorBackendRouter names 504 in exactly one place: relayFailureStatus', () => {
    const src = readScannedSource(
      path.join(__dirname, '..', '..', 'plugins', 'backend', 'editorBackendRouter.ts'),
    ).code;
    const hits = src.split('\n')
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter((l) => /\b504\b/.test(l.line))
      // The one site that is allowed to name it — the classifier itself.
      .filter((l) => !l.line.includes('isRelayTransportFailure(msg) ? 504 : 400'));
    expect(hits, 'use relayJson (or relayFailureStatus, for a route that post-processes its reply) '
      + 'instead of naming 504 — see #1013. Offending lines: '
      + hits.map((h) => `${h.n}: ${h.line}`).join(' | ')).toEqual([]);
  });

  it('the Electron host carries no literal 504 either — its relay fails through a 500', () => {
    // Pins the scope note above: if `main.ts` ever grows a hard-coded 504 the claim "a different
    // shape" stops being true and this guard needs widening rather than a footnote.
    const src = readScannedSource(path.join(__dirname, '..', '..', 'electron', 'main.ts')).code;
    const hits = src.split('\n')
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter((l) => /\b504\b/.test(l.line));
    expect(hits.map((h) => `${h.n}: ${h.line}`)).toEqual([]);
  });
});
