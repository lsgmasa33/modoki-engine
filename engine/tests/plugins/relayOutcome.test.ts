/** #1957 — the ONE classifier for a relayed op's rejection, and the transport's typed timeout.
 *
 *  The route-level cases (scene-mutate, editor-action, asset-meta, render-sequence) live beside each route's own suite;
 *  this pins the table they all read from, and that the Vite transport really throws the typed error — a classifier that
 *  reads a class nothing throws would only ever be exercised through its message fallback. */
import { describe, it, expect } from 'vitest';
import { classifyRelayFailure, relayFailureReply, relayFailureStatus, relayOp, relayProvesNoRenderer, RelayTimeoutError } from '../../plugins/backend/relayOutcome';
import { createBrowserRequestRegistry } from '../../plugins/vite-asset-scanner';
import { join } from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';
import { enclosingNamedFunction, findNodes, parseSource, ts } from '@modoki/engine/testing/sourceAst';

describe('classifyRelayFailure — one table, read by the status and the guard alike', () => {
  const cases: Array<[label: string, e: unknown, kind: ReturnType<typeof classifyRelayFailure>, status: number, provesNoRenderer: boolean]> = [
    ['typed timeout, any wording', new RelayTimeoutError('renderer did not reply'), 'timeout', 504, false],
    ['Electron timeout wording', new Error('timed out waiting for the renderer — is the editor window open?'), 'timeout', 504, false],
    ['Vite timeout wording', new Error('timed out waiting for the browser — is the app open at the dev URL?'), 'timeout', 504, false],
    ['unregistered op', new Error("unknown agent op 'eval'"), 'unregistered', 504, false],
    ['no window', new Error('no editor renderer window'), 'unreachable', 504, true],
    ['teardown', new Error('project changed — renderer reloading'), 'unreachable', 504, true],
    ['op threw', new Error('the scene edits would be DESTROYED — save first'), 'op-threw', 400, false],
    ['a bare string', 'boom', 'op-threw', 400, false],
  ];
  for (const [label, e, kind, status, proves] of cases) {
    it(`${label} → ${kind}`, () => {
      expect(classifyRelayFailure(e)).toBe(kind);
      expect(relayFailureStatus(e)).toBe(status);
      expect(relayProvesNoRenderer(e)).toBe(proves);
    });
  }

  it('only a timeout carries TIMEOUT + delivered in its reply', () => {
    expect(relayFailureReply(new RelayTimeoutError('x')).body).toMatchObject({ code: 'TIMEOUT', delivered: true });
    expect(relayFailureReply(new Error('no editor renderer window')).body).toEqual({ error: 'no editor renderer window' });
    expect(relayFailureReply(new Error('nope'), 'op failed: ')).toEqual({ status: 400, body: { error: 'op failed: nope' } });
  });
});

describe('relayOp — the envelope is read before anything else, and nothing throws', () => {
  const ctxFor = (f: () => Promise<unknown>) => ({ requestBrowser: () => f() });

  it('a §5 envelope is `refused`, with its code', async () => {
    const env = { ok: false, code: 'REFUSED_BY_OP', error: 'Nothing was changed.' };
    expect(await relayOp(ctxFor(async () => env), 'op', {})).toEqual({ kind: 'refused', body: env, code: 'REFUSED_BY_OP' });
  });

  it('an uncoded ok:false and a code outside the closed set are answers, not refusals (accept side)', async () => {
    for (const v of [{ ok: false, reason: 'bad param' }, { ok: false, code: 'MADE_UP' }]) {
      expect(await relayOp(ctxFor(async () => v), 'op', {})).toEqual({ kind: 'answered', value: v });
    }
  });

  it('a rejection is `failed` with its classification, never a throw', async () => {
    const err = new RelayTimeoutError('t');
    expect(await relayOp(ctxFor(async () => { throw err; }), 'op', {})).toEqual({ kind: 'failed', failure: 'timeout', error: err });
  });
});

describe('the Vite transport throws the TYPED timeout (#1957)', () => {
  it('a request nobody answers rejects with a RelayTimeoutError that says it was delivered', async () => {
    let fire: (() => void) | undefined;
    const reg = createBrowserRequestRegistry({ set: (fn) => { fire = fn; return 1; }, clear: () => {} });
    const p = reg.request(() => {}, 10, 'apply-scene-ops', 1);
    fire!();
    const e = await p.then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(RelayTimeoutError);
    expect((e as RelayTimeoutError).delivered).toBe(true);
    expect(classifyRelayFailure(e)).toBe('timeout');
  });
});

describe('the Electron transport throws the TYPED timeout (#1957)', () => {
  // `requestRenderer` lives in the Electron main bundle and cannot be imported here, so its timeout is read from the parse.
  it('requestRenderer rejects its timeout with a RelayTimeoutError', () => {
    const sf = parseSource(readScannedSource(join(__dirname, '../../electron/main.ts')).code, 'main.ts');
    const typed = findNodes(sf, (n): n is ts.NewExpression => ts.isNewExpression(n) && n.expression.getText(sf) === 'RelayTimeoutError');
    expect(typed.map((n) => enclosingNamedFunction(n)?.name)).toEqual(['requestRenderer']);
  });
});
