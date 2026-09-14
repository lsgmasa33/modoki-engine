/** `claimProjectForOpen` — the skip/wait decision around Electron's heal-on-open (#1160). The owner's
 *  hybrid: heal under the claim when it is free, SKIP when a build holds it and a completed install is
 *  present, WAIT for the CLAIM when an install is genuinely needed, and skip with a warning when the
 *  claim cannot be read at all.
 *
 *  Driven through injected ports (no Electron, no real wait). Two tests use the REAL store in a
 *  private MODOKI_HOME, because the port contract is only worth anything if `acquireBuildClaim`'s
 *  refusal carries `held` the way the decision reads it. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { found } from '@modoki/engine/testing/inOrder';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { claimProjectForOpen, createOpenSequencer, type OpenClaimAcquire, type OpenClaimPorts, type OpenTicket } from '../../electron/openClaim';
import { projectDepsMissing } from '../../electron/projectDeps';
import { acquireBuildClaim, resetBuildClaimsForTests, BUILD_CLAIM_ENV_VAR } from '../../scripts/buildClaimsStore.mjs';
import { readScannedSource } from '@modoki/engine/testing';
import ts from 'typescript';
import { calledNames, callsTo, declarationOf, enclosingFunction, findNodes, namedFunctions, objectLiteralKeys, parseSource } from '@modoki/engine/testing/sourceAst';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

const HELD = { ok: false as const, message: 'a command-line build already holds the build claim', held: { label: 'ios build (CLI)', pid: 4242, kind: 'cli' } };

function ports(acquire: () => OpenClaimAcquire, depsMissing: () => boolean, superseded: () => boolean = () => false) {
  const log: string[] = [];
  const warn: string[] = [];
  const status: string[] = [];
  let sleeps = 0;
  const p: OpenClaimPorts = {
    acquire, depsMissing, superseded,
    // Bounded: a decision that waits when it should skip must FAIL here, not spin forever on a sleep
    // that resolves immediately (which no test timeout can interrupt).
    sleep: async () => { if (++sleeps > 20) throw new Error('waited 20 polls: this should have skipped'); },
    status: (l) => status.push(l),
    log: (l) => log.push(l),
    warn: (l) => warn.push(l),
  };
  return { p, log, warn, status, sleeps: () => sleeps };
}

describe('claimProjectForOpen', () => {
  it('heals under the claim when it is free, handing the release back', async () => {
    let released = 0;
    const t = ports(() => ({ ok: true, release: () => { released++; } }), () => { throw new Error('not asked when free'); });
    const plan = await claimProjectForOpen('court', t.p);
    expect(plan).toMatchObject({ heal: true, waited: false });
    if (plan.heal) plan.release();
    expect(released).toBe(1);
    expect(t.sleeps()).toBe(0);
  });

  it('SKIPS without waiting when a build holds the claim and deps are present, naming the holder', async () => {
    const t = ports(() => HELD, () => false);
    const plan = await claimProjectForOpen('court', t.p);
    expect(plan).toEqual({ heal: false, why: 'held' });
    expect(t.sleeps()).toBe(0);
    expect(t.log.join('\n')).toMatch(/skipped for court.*a command-line build \("ios build \(CLI\)", pid 4242\)/);
    expect(t.status.join('\n')).toMatch(/court: a command-line build/);
  });

  it('WAITS while a build holds the claim and an install is needed, then heals once the claim frees', async () => {
    let calls = 0;
    const t = ports(() => (++calls < 3 ? HELD : { ok: true, release: () => {} }), () => true);
    const plan = await claimProjectForOpen('court', t.p);
    expect(plan).toMatchObject({ heal: true, waited: true });
    expect(t.sleeps()).toBe(2);
    expect(t.status.filter((s) => /Waiting for a command-line build/.test(s))).toHaveLength(2);
    // Announced once, not once per poll.
    expect(t.log.filter((l) => /waiting for court/.test(l))).toHaveLength(1);
    expect(t.log.join('\n')).toMatch(/claim is free, healing now/);
  });

  it('keeps waiting for the CLAIM after deps appear mid-wait, since the holder may still be installing (#1160 review)', async () => {
    // The first version re-asked depsMissing every poll and ended the wait as a skip the moment it
    // read false. npm creates node_modules at +1.1s of a 5s install, so that started Vite on a
    // half-extracted tree. The question is asked once; after that only the claim ends the wait.
    let checks = 0;
    let calls = 0;
    const t = ports(() => (++calls < 4 ? HELD : { ok: true, release: () => {} }), () => ++checks === 1);
    const plan = await claimProjectForOpen('court', t.p);
    expect(plan.heal).toBe(true);
    expect(checks).toBe(1);
    expect(t.sleeps()).toBe(3);
  });

  it('stops waiting, without healing, once another project was opened meanwhile', async () => {
    let polls = 0;
    const t = ports(() => HELD, () => true, () => ++polls > 2);
    expect(await claimProjectForOpen('court', t.p)).toEqual({ heal: false, why: 'superseded' });
    expect(t.sleeps()).toBe(2);
    expect(t.log.join('\n')).toMatch(/stopped for court, since another project was opened/);
  });

  it('asks superseded BEFORE acquiring: a claim that frees in the same poll the user left must not heal (#1160 review)', async () => {
    // The holder finishes and the user opens another project inside one sleep. Acquiring first
    // would return heal:true and run a full install of the abandoned project under its claim.
    let superseded = false;
    let acquires = 0;
    const t = ports(() => (++acquires === 1 ? HELD : { ok: true, release: () => { throw new Error('must not acquire'); } }), () => true, () => superseded);
    t.p.sleep = async () => { superseded = true; };
    expect(await claimProjectForOpen('court', t.p)).toEqual({ heal: false, why: 'superseded' });
    expect(acquires).toBe(1);
  });

  it('skips with a WARNING, never waits, when the claim is UNKNOWN (no holder to name)', async () => {
    const t = ports(() => ({ ok: false, message: 'build-claims.json could not be read' }), () => true);
    const plan = await claimProjectForOpen('court', t.p);
    expect(plan).toEqual({ heal: false, why: 'unknown' });
    expect(t.sleeps()).toBe(0);
    expect(t.warn.join('\n')).toMatch(/SKIPPED for court.*build-claims\.json could not be read/);
    // On the status line too: with deps missing, Vite fails next, and the splash must not hide why.
    expect(t.status.join('\n')).toMatch(/court: open-time repair skipped, since the build claim could not be read/);
  });

  it('treats a THROWING acquire as unknown, not as a crash of the open', async () => {
    const t = ports(() => { throw new Error('Timed out waiting for the build-claims lock'); }, () => true);
    expect(await claimProjectForOpen('court', t.p)).toEqual({ heal: false, why: 'unknown' });
    expect(t.warn.join('\n')).toMatch(/Timed out waiting for the build-claims lock/);
  });
});

describe('claimProjectForOpen against the real claim store', () => {
  let home: string;
  let project: string;
  let prevHome: string | undefined;
  let holder: ChildProcess | null = null;

  beforeEach(() => {
    home = makeScratchDir('modoki-openclaim-home-');
    project = makeScratchDir('modoki-openclaim-proj-');
    prevHome = process.env.MODOKI_HOME;
    process.env.MODOKI_HOME = home;
  });
  afterEach(() => {
    holder?.kill();
    holder = null;
    resetBuildClaimsForTests();
    if (prevHome === undefined) delete process.env.MODOKI_HOME;
    else process.env.MODOKI_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  });

  const realPorts = (depsMissing: () => boolean) => ports(
    () => acquireBuildClaim(project, 'editor open (test)', { kind: 'editor' }),
    depsMissing,
  );

  /** A SEPARATE live process holding the claim, the way a CLI build does. An in-process claim would
   *  not do: `acquireBuildClaim` refuses its own pid regardless, so it could not tell a foreign
   *  holder from a self-refusal. */
  async function holdFromAnotherProcess() {
    const store = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/buildClaimsStore.mjs');
    const env: NodeJS.ProcessEnv = { ...process.env, MODOKI_HOME: home };
    delete env[BUILD_CLAIM_ENV_VAR];
    const code = `const { acquireBuildClaim } = await import(${JSON.stringify(pathToFileURL(store).href)});
      const r = acquireBuildClaim(${JSON.stringify(project)}, 'ios build (CLI)', { kind: 'cli' });
      console.log(r.ok ? 'HELD' : 'REFUSED ' + r.message); setInterval(() => {}, 1000);`;
    holder = spawn(process.execPath, ['--input-type=module', '-e', code], { env, stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((resolve, reject) => {
      holder!.stdout!.once('data', (d) => (String(d).startsWith('HELD') ? resolve() : reject(new Error(String(d)))));
    });
  }

  it('a foreign holder + present deps: the store\'s refusal carries `held`, so the open SKIPS', async () => {
    await holdFromAnotherProcess();
    const t = realPorts(() => false);
    expect(await claimProjectForOpen('proj', t.p)).toEqual({ heal: false, why: 'held' });
    expect(t.log.join('\n')).toMatch(/a command-line build \("ios build \(CLI\)", pid \d+\)/);
  });

  it('no holder: the open takes the real claim, and its release frees it', async () => {
    const t = realPorts(() => true);
    const plan = await claimProjectForOpen('proj', t.p);
    expect(plan.heal).toBe(true);
    const again = acquireBuildClaim(project, 'second', { kind: 'editor' });
    expect(again.ok).toBe(false); // held by the open, even from this same process
    if (plan.heal) plan.release();
    const after = acquireBuildClaim(project, 'third', { kind: 'editor' });
    expect(after.ok).toBe(true);
    if (after.ok) after.release();
  });
});

describe('projectDepsMissing — the question the wait is gated on', () => {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const fakeFs = {
    readFileSync: (f: string) => { const v = files.get(f); if (v === undefined) throw new Error('ENOENT'); return v; },
    existsSync: (p: string) => dirs.has(p) || files.has(p),
    readdirSync: () => { throw new Error('ENOENT'); },
  };
  beforeEach(() => { files.clear(); dirs.clear(); });

  it('an installable project with no node_modules is missing deps', () => {
    files.set('/p/package.json', JSON.stringify({ dependencies: { a: '1' } }));
    expect(projectDepsMissing('/p', fakeFs)).toBe(true);
    dirs.add('/p/node_modules');
    expect(projectDepsMissing('/p', fakeFs)).toBe(false);
  });

  it('completedInstall: a node_modules without npm\'s hidden lockfile is an install still running, so missing', () => {
    files.set('/p/package.json', JSON.stringify({ dependencies: { a: '1' } }));
    dirs.add('/p/node_modules');
    expect(projectDepsMissing('/p', fakeFs, { completedInstall: true })).toBe(true);
    expect(projectDepsMissing('/p', fakeFs)).toBe(false); // ensureProjectDeps' own question is unchanged
    files.set('/p/node_modules/.package-lock.json', '{}');
    expect(projectDepsMissing('/p', fakeFs, { completedInstall: true })).toBe(false);
  });

  it('a project with nothing to install, or an unreadable package.json, is never "missing"', () => {
    files.set('/p/package.json', JSON.stringify({ name: 'x' }));
    expect(projectDepsMissing('/p', fakeFs)).toBe(false);
    files.set('/p/package.json', '{ not json');
    expect(projectDepsMissing('/p', fakeFs)).toBe(false);
    files.set('/p/package.json', 'null');
    expect(projectDepsMissing('/p', fakeFs)).toBe(false);
  });
});

/** main.ts cannot be unit-mounted (it boots Electron), so its WIRING of the decision is checked on its
 *  AST (`sourceAst`, #1144): each assertion is about a named node, never a text window. Each is a #1160
 *  review finding that the decision module alone cannot enforce. `parseSource` throws on an unparseable
 *  main.ts, which a text match once let through green (bf2fbaf9a). */
describe('main.ts wires claimProjectForOpen the way its header requires', () => {
  const mainPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../electron/main.ts');
  const sf = parseSource(readScannedSource(mainPath).code, 'engine/electron/main.ts');
  const fns = namedFunctions(sf);
  const body = (name: string) => {
    const f = fns.find((x) => x.name === name);
    if (!f) throw new Error(`main.ts no longer defines ${name}`);
    return f.body;
  };
  /** The initialiser of the `name:` property in the ports object passed to claimProjectForOpen. */
  const port = (name: string) => {
    const call = callsTo(body('healAndInstallOnOpen'), 'claimProjectForOpen')[0];
    expect(call, 'healAndInstallOnOpen no longer calls claimProjectForOpen').toBeDefined();
    const obj = call.arguments[1];
    if (!obj || !ts.isObjectLiteralExpression(obj)) throw new Error('claimProjectForOpen ports are not an object literal');
    const prop = obj.properties.find((p) => p.name && ts.isIdentifier(p.name) && p.name.text === name);
    if (!prop || !ts.isPropertyAssignment(prop)) throw new Error(`port ${name} is not a plain property`);
    return prop.initializer;
  };
  const completedInstallArg = (c: ts.CallExpression) => objectLiteralKeys(c.arguments[2]) ?? [];

  it('asks for a COMPLETED install, not a bare node_modules, and forces the install a dead holder left', () => {
    const depsCalls = callsTo(port('depsMissing'), 'projectDepsMissing');
    expect(depsCalls).toHaveLength(1);
    expect(completedInstallArg(depsCalls[0])).toContain('completedInstall');
    const heal = body('healAndInstallOnOpen');
    const force = findNodes(heal, ts.isVariableDeclaration).find((d) => ts.isIdentifier(d.name) && d.name.text === 'forceInstall');
    expect(force, 'forceInstall is gone').toBeDefined();
    expect(calledNames(force!.initializer!)).toEqual(['projectDepsMissing']);
    expect(force!.initializer!.getText(sf)).toMatch(/^plan\.waited && /);
    expect(completedInstallArg(callsTo(force!.initializer!, 'projectDepsMissing')[0])).toContain('completedInstall');
    const install = callsTo(heal, 'ensureProjectDeps');
    expect(install).toHaveLength(1);
    expect(objectLiteralKeys(install[0].arguments[1])).toEqual(['forceInstall']);
  });

  it('supersedes by the open\'s TICKET (the sequence), not by root, and setProject queues synchronously', () => {
    const superseded = port('superseded');
    expect(superseded.getText(sf)).toBe('() => !ticket.isCurrent()');
    const set = body('setProject');
    if (!ts.isBlock(set)) throw new Error('setProject has no block body');
    expect(set.statements).toHaveLength(2);
    // The requested root is recorded BEFORE queueing, so a re-pick is compared with the newest request.
    expect(set.statements[0].getText(sf)).toBe('requestedRoot = newRoot;');
    const ret = set.statements[1];
    if (!ts.isReturnStatement(ret) || !ret.expression) throw new Error('setProject no longer returns the queued open');
    expect(ret.expression.getText(sf)).toMatch(/^opens\.open\(/);
    expect(calledNames(ret.expression)).toEqual(['open', 'openProject']);
  });

  it('healAndInstallOnOpen answers with the TICKET on every return, so a superseded heal never reads as current', () => {
    const heal = body('healAndInstallOnOpen');
    const returns = findNodes(heal, ts.isReturnStatement).filter((r) => enclosingFunction(r) === heal.parent);
    expect(returns.length).toBeGreaterThanOrEqual(3); // own-tree, not healed, healed
    for (const r of returns) expect(r.expression?.getText(sf)).toBe('ticket.isCurrent()');
  });

  it('Open Project and Open Recent dedupe against the newest REQUESTED root, not state.root (#1160 review)', () => {
    const moduleDecl = findNodes(sf, ts.isVariableDeclaration).filter((d) => ts.isIdentifier(d.name) && d.name.text === 'requestedRoot');
    expect(moduleDecl, 'expected exactly one requestedRoot declaration').toHaveLength(1);
    expect(ts.isSourceFile(moduleDecl[0].parent.parent.parent), 'requestedRoot must be module-level').toBe(true);
    const dedupes = callsTo(sf, 'samePath').filter((c) => ['chosen', 'root'].includes(c.arguments[0]?.getText(sf) ?? ''));
    expect(dedupes).toHaveLength(2);
    // The exact guard: a PICK DIFFERENT from the newest request queues. An inverted check, or a local
    // `requestedRoot` shadowing the module binding, is a different program with the same spelling.
    const guards = dedupes.map((c) => {
      let n: ts.Node = c;
      while (n.parent && !ts.isIfStatement(n.parent)) n = n.parent;
      return (n.parent as ts.IfStatement).expression.getText(sf);
    }).sort();
    expect(guards).toEqual(['!samePath(root, requestedRoot)', 'chosen && !samePath(chosen, requestedRoot)']);
    for (const c of dedupes) {
      const id = c.arguments[1];
      expect(ts.isIdentifier(id) && declarationOf(id)).toBe(moduleDecl[0]);
    }
    // Seeded by the launch BEFORE the menu makes Open Project reachable.
    const seeded = findNodes(sf, ts.isBinaryExpression).filter((b) => b.getText(sf) === 'requestedRoot = initialRoot');
    expect(seeded, 'the launch no longer seeds requestedRoot').toHaveLength(1);
    const launchFn = enclosingFunction(seeded[0]);
    const firstMenu = callsTo(launchFn, 'rebuildMenu').filter((c) => enclosingFunction(c) === launchFn)[0];
    expect(firstMenu).toBeDefined();
    expect(seeded[0].getEnd()).toBeLessThan(firstMenu.getStart(sf));
  });

  it('a queued open reports progress on the splash when no window exists yet', () => {
    const decl = findNodes(body('openProject'), ts.isVariableDeclaration).find((d) => ts.isIdentifier(d.name) && d.name.text === 'openStatus');
    expect(decl, 'openProject lost its status sink').toBeDefined();
    expect(calledNames(decl!.initializer!).sort()).toEqual(['setSplashStatus', 'setTitle']);
    expect(callsTo(body('openProject'), 'healAndInstallOnOpen')[0].arguments[2].getText(sf)).toBe('openStatus');
  });

  it('releases the claim in a finally that covers the heal and the install', () => {
    const tries = findNodes(body('healAndInstallOnOpen'), ts.isTryStatement);
    expect(tries).toHaveLength(1);
    expect(calledNames(tries[0].tryBlock)).toEqual(expect.arrayContaining(['healProjectOnOpen', 'ensureProjectDeps']));
    expect(tries[0].finallyBlock && calledNames(tries[0].finallyBlock)).toEqual(['release']);
  });

  /** The `if` whose condition awaits healAndInstallOnOpen, inside `root`. */
  const healGate = (root: ts.Node) => {
    const ifs = findNodes(root, ts.isIfStatement).filter((n) => callsTo(n.expression, 'healAndInstallOnOpen').length === 1);
    expect(ifs, 'expected exactly one if gated on healAndInstallOnOpen').toHaveLength(1);
    return ifs[0];
  };

  it('Open Project checks its ticket FIRST, RETURNS before Vite when superseded, and never shows a superseded failure', () => {
    const open = body('openProject');
    if (!ts.isBlock(open)) throw new Error('openProject has no block body');
    const first = open.statements[0];
    expect(first && ts.isIfStatement(first) && first.expression.getText(sf)).toBe('!ticket.isCurrent()');
    expect(findNodes((first as ts.IfStatement).thenStatement, ts.isReturnStatement)).toHaveLength(1);
    const gate = healGate(open);
    expect(gate.expression.getText(sf)).toMatch(/^!\(await healAndInstallOnOpen\(newRoot, ticket,/);
    expect(findNodes(gate.thenStatement, ts.isReturnStatement)).toHaveLength(1);
    const vite = callsTo(open, 'startDevServer');
    expect(vite).toHaveLength(1);
    expect(gate.getEnd()).toBeLessThanOrEqual(vite[0].getStart(sf));
    const catches = findNodes(open, ts.isCatchClause).filter((c) => callsTo(c.block, 'showMessageBox').length > 0);
    expect(catches).toHaveLength(1);
    const guard = catches[0].block.statements.find((st) => ts.isIfStatement(st) && st.expression.getText(sf) === '!ticket.isCurrent()') as ts.IfStatement | undefined;
    expect(guard, 'the failure dialog is no longer gated on the ticket').toBeDefined();
    expect(findNodes(guard!.thenStatement, ts.isReturnStatement)).toHaveLength(1);
    expect(guard!.getEnd()).toBeLessThanOrEqual(callsTo(catches[0].block, 'showMessageBox')[0].getStart(sf));
  });

  it('the launch reserves its turn before the menu is live, starts Vite only while current, and waits out a superseding open', () => {
    const reserve = findNodes(sf, ts.isVariableDeclaration).filter((d) => ts.isIdentifier(d.name) && d.name.text === 'launchOpen');
    expect(reserve).toHaveLength(1);
    expect(reserve[0].initializer!.getText(sf)).toMatch(/^opens\.reserve</);
    const whenReadyBody = enclosingFunction(reserve[0]);
    const firstMenu = callsTo(whenReadyBody, 'rebuildMenu').filter((c) => enclosingFunction(c) === whenReadyBody)[0];
    expect(firstMenu, 'the launch no longer installs the menu itself').toBeDefined();
    expect(reserve[0].getEnd()).toBeLessThan(firstMenu.getStart(sf));

    const runs = callsTo(sf, 'run').filter((c) => ts.isPropertyAccessExpression(c.expression) && c.expression.expression.getText(sf) === 'launchOpen');
    expect(runs, 'the dev-server launch AND the no-dev-server path must both end the reserved turn').toHaveLength(2);
    const launchBody = runs.map((r) => r.arguments[0]).find((a) => a && callsTo(a, 'startDevServer').length > 0);
    expect(launchBody, 'no launchOpen.run starts the dev server').toBeDefined();
    const gate = healGate(launchBody!);
    expect(gate.expression.getText(sf)).toMatch(/^!\(await healAndInstallOnOpen\(launchRoot, ticket,/);
    expect(gate.thenStatement.getText(sf)).toBe('return false;');
    const vite = callsTo(launchBody!, 'startDevServer');
    expect(vite).toHaveLength(1);
    expect(gate.getEnd()).toBeLessThanOrEqual(vite[0].getStart(sf));
    const launchCatch = findNodes(launchBody!, ts.isCatchClause);
    expect(launchCatch).toHaveLength(1);
    const stmts = launchCatch[0].block.statements;
    const guardAt = found(stmts.findIndex((st) => ts.isIfStatement(st) && st.expression.getText(sf) === '!ticket.isCurrent()'),
      'the superseded guard in the launch catch');
    const rethrowAt = stmts.findIndex((st) => ts.isThrowStatement(st));
    expect(findNodes((stmts[guardAt] as ts.IfStatement).thenStatement, ts.isReturnStatement)[0]?.getText(sf)).toBe('return false;');
    // BEFORE the rethrow: a superseded launch whose install failed must not reach the fatal path.
    expect(rethrowAt).toBeGreaterThan(guardAt);

    const after = findNodes(sf, ts.isIfStatement).filter((n) => n.expression.getText(sf) === '!launched || !launchOpen.ticket.isCurrent()');
    expect(after, 'the launch no longer waits when superseded AFTER starting Vite too').toHaveLength(1);
    const idle = callsTo(after[0].thenStatement, 'idle');
    expect(idle).toHaveLength(1);
    expect(ts.isAwaitExpression(idle[0].parent), 'idle() must be AWAITED, or the root check runs before the queued open').toBe(true);
    const rootCheck = findNodes(after[0].thenStatement, ts.isIfStatement).find((n) => findNodes(n.thenStatement, ts.isThrowStatement).length === 1);
    expect(rootCheck?.expression.getText(sf)).toBe('!viteRoot || !samePath(viteRoot, state.root)');
    // …and viteRoot is the RUNNING server's root: bound to devServerRoot(), not to anything that
    // would make the comparison trivially true.
    const viteRootDecl = findNodes(after[0].thenStatement, ts.isVariableDeclaration).filter((d) => ts.isIdentifier(d.name) && d.name.text === 'viteRoot');
    expect(viteRootDecl).toHaveLength(1);
    expect(viteRootDecl[0].initializer?.getText(sf)).toBe('devServerRoot()');
    for (const id of findNodes(rootCheck!.expression, ts.isIdentifier).filter((i) => i.text === 'viteRoot')) {
      expect(declarationOf(id)).toBe(viteRootDecl[0]);
    }
    expect(idle[0].getEnd()).toBeLessThan(rootCheck!.getStart(sf));

    const noDevServer = findNodes(sf, ts.isIfStatement).filter((n) => n.expression.getText(sf) === "process.env.MODOKI_NO_DEV_SERVER !== '1'" && !!n.elseStatement
      && callsTo(n.thenStatement, 'run').length > 0);
    expect(noDevServer, 'the launch dev-server block lost its else').toHaveLength(1);
    const elseBlock = noDevServer[0].elseStatement!;
    expect(ts.isBlock(elseBlock) && elseBlock.statements.some((st) => ts.isExpressionStatement(st) && callsTo(st, 'run').length === 1),
      'the no-dev-server branch must end the reserved turn unconditionally, as a statement of its own').toBe(true);

    // Every startDevServer in main.ts is one of the two gated ones.
    expect(callsTo(sf, 'startDevServer')).toHaveLength(callsTo(body('openProject'), 'startDevServer').length + vite.length);
  });
});

describe('createOpenSequencer — opens never overlap, and a newer one supersedes at once', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((res) => { resolve = res; }); return { promise, resolve }; };

  it('runs a second open only after the first has fully settled', async () => {
    const seq = createOpenSequencer();
    const log: string[] = [];
    const gateA = deferred();
    const a = seq.open(async () => { log.push('A start'); await gateA.promise; log.push('A end'); });
    const b = seq.open(async () => { log.push('B start'); });
    await flush();
    expect(log).toEqual(['A start']); // B has not started while A is mid-flight
    gateA.resolve();
    await Promise.all([a, b]);
    expect(log).toEqual(['A start', 'A end', 'B start']);
  });

  it('supersedes an in-flight open the moment a newer one is requested, not when it starts', async () => {
    const seq = createOpenSequencer();
    const gate = deferred();
    let ticketA: OpenTicket | undefined;
    const a = seq.open(async (t) => { ticketA = t; await gate.promise; return t.isCurrent(); });
    await flush();
    expect(ticketA?.isCurrent()).toBe(true);
    const b = seq.open(async (t) => t.isCurrent());
    expect(ticketA?.isCurrent()).toBe(false);
    gate.resolve();
    expect(await a).toBe(false);
    expect(await b).toBe(true);
  });

  it('A → B → C: B runs its turn already superseded, so nothing ever roots at B', async () => {
    const seq = createOpenSequencer();
    const gate = deferred();
    const seen: Array<[string, boolean]> = [];
    const a = seq.open(async (t) => { await gate.promise; seen.push(['A', t.isCurrent()]); });
    const b = seq.open(async (t) => { seen.push(['B', t.isCurrent()]); });
    const c = seq.open(async (t) => { seen.push(['C', t.isCurrent()]); });
    gate.resolve();
    await Promise.all([a, b, c]);
    expect(seen).toEqual([['A', false], ['B', false], ['C', true]]);
  });

  it('a failed open neither blocks the next nor swallows its own rejection', async () => {
    const seq = createOpenSequencer();
    const a = seq.open(async () => { throw new Error('install failed'); });
    const b = seq.open(async () => 'opened');
    await expect(a).rejects.toThrow('install failed');
    expect(await b).toBe('opened');
  });

  it('reserve(): a later open queues behind a reservation whose body is supplied later, and the reservation stays current until then', async () => {
    const seq = createOpenSequencer();
    const launch = seq.reserve<string>();
    const log: string[] = [];
    const b = seq.open(async (t) => { log.push(`B current=${t.isCurrent()}`); });
    await flush();
    expect(log).toEqual([]); // B waits for the launch's turn, not for the launch's body to exist
    expect(launch.ticket.isCurrent()).toBe(false); // requesting B superseded it
    const r = launch.run(async (t) => { log.push(`launch current=${t.isCurrent()}`); return 'launched'; });
    expect(await r).toBe('launched');
    await b;
    expect(log).toEqual(['launch current=false', 'B current=true']);
  });

  it('idle() RESOLVES after a rejected open: one failed open must not fail whoever waits for the queue', async () => {
    const seq = createOpenSequencer();
    const a = seq.open(async () => { throw new Error('install failed'); });
    await expect(a).rejects.toThrow();
    await expect(seq.idle()).resolves.toBeUndefined();
  });

  it('idle() waits for opens requested while it was already waiting', async () => {
    const seq = createOpenSequencer();
    const gateA = deferred();
    const gateB = deferred();
    const done: string[] = [];
    void seq.open(async () => { await gateA.promise; done.push('A'); });
    const idle = seq.idle().then(() => done.push('idle'));
    void seq.open(async () => { await gateB.promise; done.push('B'); });
    gateA.resolve();
    await flush();
    expect(done).toEqual(['A']);
    gateB.resolve();
    await idle;
    expect(done).toEqual(['A', 'B', 'idle']);
  });
});
