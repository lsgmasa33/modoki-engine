/** #1976: Open Project's order and write gate (`engine/electron/projectSwitch.ts`). The race, driven directly: a backend
 *  whose context reads its root LIVE (as main.ts's does), and a save from the old window arriving at each point of a
 *  switch — during the prepare (install, dev server), during the re-root, after a failed switch, and after a superseded
 *  one. */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createSwitchGate, prepareThenReRoot, type SwitchGate } from '../../electron/projectSwitch';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { readScannedSource } from '@modoki/engine/testing';
import { calledNames, callsTo, findNodes, namedFunctions, parseSource } from '@modoki/engine/testing/sourceAst';

/** A stand-in for the backend: a save writes `<root>/<path>`, reading `root` when the request ARRIVES, behind the gate
 *  `hostRoutes` checks first. */
function makeHost(gate: SwitchGate) {
  const host = {
    root: 'A',
    written: [] as string[],
    save(path: string): number {
      const refusal = gate.refusal('POST', '/api/write-file');
      if (refusal) return refusal.status;
      host.written.push(`${host.root}/${path}`);
      return 200;
    },
  };
  return host;
}

afterEach(() => { vi.useRealTimers(); });

describe('prepareThenReRoot (#1976)', () => {
  it('a save during the prepare lands in the OLD project; one during the re-root is refused; the gate closes until opened', async () => {
    const gate = createSwitchGate();
    const host = makeHost(gate);
    const statuses: number[] = [];
    const outcome = await prepareThenReRoot({
      gate, reason: 'opening B', isCurrent: () => true, pairBack: async () => { throw new Error('pairBack on a re-root'); },
      prepare: async () => { statuses.push(host.save('main.scene.json')); return true; },
      reRoot: async () => {
        await Promise.resolve(); // the backend stop/SSR close the real re-root awaits
        statuses.push(host.save('main.scene.json'));
        host.root = 'B';
        statuses.push(host.save('main.scene.json'));
      },
    });
    expect(outcome.kind).toBe('reRooted');
    expect(statuses).toEqual([200, 503, 503]);
    expect(host.written).toEqual(['A/main.scene.json']);
    // Still closed until the reload commits (main.ts opens it on `did-navigate`).
    expect(gate.isClosed()).toBe(true);
    gate.open();
    expect(host.save('main.scene.json')).toBe(200);
    expect(host.written).toEqual(['A/main.scene.json', 'B/main.scene.json']);
  });

  it('a FAILED switch never re-roots: later saves land in the old project, the gate never closed, and the dev server is paired back', async () => {
    const gate = createSwitchGate();
    const host = makeHost(gate);
    const reRoot = vi.fn(async () => { host.root = 'B'; });
    const pairBack = vi.fn(async () => {});
    const outcome = await prepareThenReRoot({
      gate, reason: 'opening B', isCurrent: () => true, pairBack,
      prepare: async () => { throw new Error('vite failed to start'); },
      reRoot,
    });
    expect(outcome.kind).toBe('failed');
    expect(reRoot).not.toHaveBeenCalled();
    expect(pairBack).toHaveBeenCalledTimes(1);
    expect(gate.isClosed()).toBe(false);
    expect(host.save('main.scene.json')).toBe(200);
    expect(host.written).toEqual(['A/main.scene.json']);
  });

  it('superseded during the prepare, or right after it: no re-root, gate open', async () => {
    for (const [prepared, current] of [[false, true], [true, false]] as const) {
      const gate = createSwitchGate();
      const reRoot = vi.fn(async () => {});
      const pairBack = vi.fn(async () => {});
      const outcome = await prepareThenReRoot({ gate, reason: 'x', isCurrent: () => current, prepare: async () => prepared, pairBack, reRoot });
      expect(outcome.kind).toBe('superseded');
      expect(reRoot).not.toHaveBeenCalled();
      expect(pairBack).toHaveBeenCalledTimes(1); // a superseded open may already have moved the dev server too
      expect(gate.isClosed()).toBe(false);
    }
  });

  it('a pairBack that fails is reported in the outcome, not thrown', async () => {
    const outcome = await prepareThenReRoot({
      gate: createSwitchGate(), reason: 'x', isCurrent: () => true, reRoot: async () => {},
      prepare: async () => { throw new Error('vite timed out'); },
      pairBack: async () => { throw new Error('restart failed'); },
    });
    expect(outcome).toMatchObject({ kind: 'failed', pairError: new Error('restart failed') });
  });

  it('a re-root that THROWS half way keeps refusing writes until a relaunch — no timeout reopens it', async () => {
    vi.useFakeTimers();
    const gate = createSwitchGate();
    const host = makeHost(gate);
    const outcome = await prepareThenReRoot({
      gate, reason: 'opening B', isCurrent: () => true, prepare: async () => true, pairBack: async () => {},
      reRoot: async () => { host.root = 'B'; throw new Error('backend failed to start'); },
    });
    expect(outcome).toMatchObject({ kind: 'failed', reRootFailed: true });
    vi.advanceTimersByTime(10 * 60_000);
    expect(host.save('main.scene.json')).toBe(503);
    expect(host.written).toEqual([]);
    expect(gate.refusal('POST', '/api/write-file')?.body.error).toContain('relaunch');
  });
});

describe('createSwitchGate (#1976)', () => {
  it('while closed refuses writes with a reason, passes reads and a newer open', () => {
    const gate = createSwitchGate();
    expect(gate.refusal('POST', '/api/write-file')).toBeNull();
    gate.close('opening B');
    const r = gate.refusal('POST', '/api/write-file');
    expect(r?.status).toBe(503);
    expect(r?.body).toMatchObject({ ok: false, switching: true, reason: 'project-switching' });
    expect(r?.body.error).toContain('opening B');
    expect(gate.refusal('GET', '/api/scene-state')).toBeNull();
    expect(gate.refusal('HEAD', '/api/scene-state')).toBeNull();
    expect(gate.refusal('POST', '/api/open-project')).toBeNull(); // a newer open must still supersede (#1160)
    gate.open();
    expect(gate.refusal('POST', '/api/write-file')).toBeNull();
  });

  it('a close with NO timeout is not lifted by open() — a stray reload commit is not a relaunch — but a later close is', () => {
    vi.useFakeTimers();
    const gate = createSwitchGate();
    gate.close('a project switch failed part way', null);
    gate.open();
    vi.advanceTimersByTime(10 * 60_000);
    expect(gate.isClosed()).toBe(true);
    // A later open closes it with a timeout, and re-roots consistently: from then on the normal rules apply.
    gate.close('opening C', 1000);
    vi.advanceTimersByTime(1000);
    expect(gate.isClosed()).toBe(false);
  });

  it('opens by itself after its timeout, so a switch that never reaches its reload cannot wedge the editor', () => {
    vi.useFakeTimers();
    const gate = createSwitchGate();
    gate.close('opening B', 1000);
    vi.advanceTimersByTime(999);
    expect(gate.isClosed()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(gate.isClosed()).toBe(false);
  });
});

/** The wiring in main.ts the module above cannot see: the order lives in `prepareThenReRoot`, but only main.ts can put
 *  the gate in front of the routes, open it on the reload's commit, and keep the re-root out of the prepare. Pinned the
 *  way openClaim.test.ts pins the open flow, so deleting any of the three turns this red. */
describe('main.ts wires the switch the way projectSwitch.ts requires (#1976)', () => {
  const mainPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../electron/main.ts');
  const sf = parseSource(readScannedSource(mainPath).code, 'engine/electron/main.ts');
  const body = (name: string) => {
    const f = namedFunctions(sf).find((x) => x.name === name);
    if (!f) throw new Error(`main.ts no longer defines ${name}`);
    return f.body;
  };
  const prop = (call: ts.CallExpression, name: string) => {
    const obj = call.arguments[0];
    if (!obj || !ts.isObjectLiteralExpression(obj)) throw new Error('prepareThenReRoot is no longer passed an object literal');
    const p = obj.properties.find((x) => x.name && ts.isIdentifier(x.name) && x.name.text === name);
    if (!p) throw new Error(`prepareThenReRoot lost its ${name}`);
    return p;
  };
  const reRootCall = () => {
    const calls = callsTo(body('openProject'), 'prepareThenReRoot');
    expect(calls).toHaveLength(1);
    return calls[0];
  };

  it('hostRoutes asks the gate FIRST, before any route', () => {
    const decl = findNodes(sf, ts.isVariableDeclaration).find((d) => ts.isIdentifier(d.name) && d.name.text === 'hostRoutes');
    const fn = decl?.initializer;
    if (!fn || !ts.isArrowFunction(fn) || !ts.isBlock(fn.body)) throw new Error('hostRoutes is no longer an arrow with a block');
    const [first, second] = fn.body.statements;
    expect(first.getText(sf)).toBe('const switching = switchGate.refusal(method, urlPath);');
    expect(second && ts.isIfStatement(second) && second.expression.getText(sf)).toBe('switching');
    expect(findNodes((second as ts.IfStatement).thenStatement, ts.isReturnStatement)).toHaveLength(1);
  });

  it('the gate opens on the reload\'s COMMIT, listened for before the reload is issued', () => {
    const open = body('openProject');
    const listen = callsTo(open, 'openSwitchGateOnCommit');
    const reload = callsTo(open, 'reloadIgnoringCache');
    expect(listen).toHaveLength(1);
    expect(reload).toHaveLength(1);
    expect(listen[0].getEnd()).toBeLessThan(reload[0].getStart(sf));
    const once = callsTo(body('openSwitchGateOnCommit'), 'once');
    expect(once).toHaveLength(1);
    expect(once[0].arguments[0].getText(sf)).toBe("'did-navigate'");
    const listener = once[0].arguments[1];
    const fnDecl = ts.isIdentifier(listener)
      ? findNodes(body('openSwitchGateOnCommit'), ts.isVariableDeclaration).find((d) => d.name.getText(sf) === listener.text)?.initializer
      : listener;
    expect(fnDecl && calledNames(fnDecl)).toContain('open');
  });

  it('the backend is re-rooted ONLY in the reRoot step, never during the prepare', () => {
    const assigns = (root: ts.Node) => findNodes(root, ts.isBinaryExpression)
      .filter((b) => b.operatorToken.kind === ts.SyntaxKind.EqualsToken && /^state\.(root|backend)$/.test(b.left.getText(sf)));
    expect(assigns(body('prepareProject'))).toEqual([]);
    const reRoot = prop(reRootCall(), 'reRoot');
    const inOpen = assigns(body('openProject'));
    expect(inOpen.map((a) => a.left.getText(sf)).sort()).toEqual(['state.backend', 'state.root']);
    for (const a of inOpen) expect(a.getStart(sf) >= reRoot.getStart(sf) && a.getEnd() <= reRoot.getEnd()).toBe(true);
  });

  it('pairBack restarts the dev server at the BACKEND\'s root when it serves another', () => {
    const pair = prop(reRootCall(), 'pairBack');
    const start = callsTo(pair, 'startDevServer');
    expect(start).toHaveLength(1);
    expect(start[0].arguments[0].getText(sf)).toContain('projectRoot: state.root');
    expect(callsTo(pair, 'devServerRoot')).toHaveLength(1);
    // …and ONLY then: never a server that was not running before this open (its install and claim never ran), and
    // never one already on the backend's root (a needless restart reloads the old window).
    const returns = findNodes(pair, ts.isIfStatement).filter((i) => ts.isReturnStatement(i.thenStatement)).map((i) => i.expression.getText(sf));
    expect(returns.some((t) => /!viteBefore\b/.test(t))).toBe(true);
    expect(returns).toContain('viteRoot && samePath(viteRoot, state.root)');
    const before = findNodes(body('openProject'), ts.isVariableDeclaration).find((d) => d.name.getText(sf) === 'viteBefore');
    expect(before?.initializer?.getText(sf)).toBe('devServerRoot()');
    expect(before!.getEnd()).toBeLessThan(reRootCall().getStart(sf));
  });

  it('a commit listener left by an earlier open is removed before a new one is added', () => {
    const fn = body('openSwitchGateOnCommit');
    const remove = callsTo(fn, 'removeListener');
    const once = callsTo(fn, 'once');
    expect(remove).toHaveLength(1);
    expect(remove[0].getEnd()).toBeLessThan(once[0].getStart(sf));
  });

  it('a failed re-root is reported even when a newer open superseded it', () => {
    const open = body('openProject');
    const guard = findNodes(open, ts.isIfStatement).find((i) => i.expression.getText(sf).startsWith('!ticket.isCurrent() &&'));
    expect(guard?.expression.getText(sf)).toBe('!ticket.isCurrent() && !outcome.reRootFailed');
  });
});
