/** The CLI scripts that write or upload a project's build output — `build-web.mjs`,
 *  `add-native-targets.mjs` and `ota-publish.mjs` (`<project>/dist`), and `build-subgame.mjs`
 *  (`<project>/subgame-dist`, which the editor's OTA publish uploads since #837) — must each take the
 *  cross-process build claim (#650) BEFORE mutating
 *  anything, and give it back on every exit path. `buildLock.ts`'s in-process slot is invisible to
 *  a CLI script (a separate process), so without this a hand-run one of these can race the
 *  editor's own build/publish/scaffold into the SAME `<project>/dist`, producing a torn bundle.
 *
 *  Why a SOURCE assertion rather than a behavioural one — same posture as
 *  `cliNativeBuildHeals.test.ts` (see its own header): actually running any of these three costs a
 *  real vite/tsc build, `npm install`, or a `gcloud storage` upload, far too heavy for `npm test`.
 *  `buildClaimsStore.test.ts` already covers the STORE's own behaviour (grant/refuse/staleness/
 *  release identity) and proves the cross-process property with two real subprocesses; what has no
 *  other guard is the WIRING — that each script actually calls it, and calls it early enough. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { readScannedSource } from '@modoki/engine/testing';
import { boundIdentifier, callsTo, declarationOf, enclosingFunction, findNodes, parseSource, readsOf } from '@modoki/engine/testing/sourceAst';
import { acquireBuildClaim, readBuildClaim, resetBuildClaimsForTests } from '../../scripts/buildClaimsStore.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const buildWeb = path.join(repoRoot, 'engine', 'scripts', 'build-web.mjs');
const addNativeTargets = path.join(repoRoot, 'engine', 'scripts', 'add-native-targets.mjs');
const otaPublish = path.join(repoRoot, 'engine', 'scripts', 'ota-publish.mjs');
const buildSubgame = path.join(repoRoot, 'engine', 'scripts', 'build-subgame.mjs');

/** One `acquireBuildClaim(…)` call, read from ITS OWN node (#1144).
 *
 *  ⚠️ These asserts used to slice a fixed window after the FIRST `acquireBuildClaim(` (`+ 200`) or
 *  after `const claimed = acquireBuildClaim(` (`+ 300`/`+ 400`) and match `kind: 'cli'`,
 *  `!claimed.ok` and `process.exit(1)` inside it. A window is not the call: a second call, or a
 *  neighbouring refusal, inside the reach satisfied it for a call that had neither, and a call whose
 *  arguments ran long failed closed. So each fact is read where it lives, for EVERY call:
 *  - `kind` from this call's own options object;
 *  - the refusal from the `if (!<binding>.ok)` that tests THIS call's result, in the function the call
 *    runs in — ⚠️ not merely somewhere in its block (#1144 close-out: an `if` moved into a nested
 *    function nobody calls still satisfied a block-wide search);
 *  - the release from a `finally` that runs after the call in that same function and releases this
 *    call's claim — its binding, or the variable the binding is handed to (`claim = claimed`).
 *    ⚠️ The first version accepted ANY `finally` in the file releasing a hardcoded name. */
interface ClaimCall {
  target: string | undefined;
  kind: string | undefined;
  /** The then-branch of `if (!<binding>.ok)` in the call's own function, when there is one. */
  refusal: ts.Statement | undefined;
  /** A `finally` after the call, in the same function, releases this claim. */
  releasedInFinally: boolean;
}

function claimCalls(src: string, label: string): ClaimCall[] {
  const sf = parseSource(src, label);
  return callsTo(sf, 'acquireBuildClaim').map((call) => {
    const opts = call.arguments.slice(1).filter(ts.isObjectLiteralExpression).pop();
    const kindProp = opts?.properties.find(
      (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText(sf) === 'kind',
    );
    const fn = enclosingFunction(call);
    const inFn = (n: ts.Node): boolean => enclosingFunction(n) === fn;
    const id = boundIdentifier(call);
    const reads = id ? readsOf(id) : [];
    // By symbol: `reads` are the identifiers resolving to THIS call's binding, so a same-named
    // `claimed` in an inner block is not it — and nothing before the declaration can resolve to it.
    const refusal = findNodes(fn, ts.isIfStatement).find((st) => {
      const cond = st.expression;
      return inFn(st)
        && ts.isPrefixUnaryExpression(cond) && cond.operator === ts.SyntaxKind.ExclamationToken
        && ts.isPropertyAccessExpression(cond.operand) && cond.operand.name.text === 'ok'
        && ts.isIdentifier(cond.operand.expression) && reads.includes(cond.operand.expression);
    })?.thenStatement;
    // The DECLARATIONS this claim is held under: its binding, and any variable the binding is handed
    // to (`claim = claimed`, `let claim = claimed`). Compared by declaration, not by spelling.
    const holders = new Set<ts.Declaration>(id ? [id.parent as ts.Declaration] : []);
    for (const r of reads) {
      const p = r.parent;
      if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.right === r
        && ts.isIdentifier(p.left)) {
        const d = declarationOf(p.left);
        if (d) holders.add(d);
      }
      if (ts.isVariableDeclaration(p) && p.initializer === r) holders.add(p);
    }
    // A `finally` that runs after the call — one that follows it, or one whose `try` encloses it —
    // in the call's own function, releasing a holder DIRECTLY: a `release()` inside a function the
    // `finally` merely defines is not run by it (#1144 close-out re-review).
    const releasedInFinally = findNodes(fn, ts.isTryStatement).some((t) => inFn(t)
      && !!t.finallyBlock && t.finallyBlock.pos > call.end
      && callsTo(t.finallyBlock, 'release').some((c) => {
        const callee = c.expression;
        return enclosingFunction(c) === fn && ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
          && holders.has(declarationOf(callee.expression)!);
      }));
    return {
      target: call.arguments[0]?.getText(sf),
      kind: kindProp && ts.isStringLiteralLike(kindProp.initializer) ? kindProp.initializer.text : undefined,
      refusal,
      releasedInFinally,
    };
  });
}

/** What a refusal branch DOES, from its own statements: the calls it makes by text, whether it
 *  `continue`s, and whether it waits (a timer or a loop). */
function refusalShape(branch: ts.Statement): { calls: string[]; continues: boolean; waits: boolean } {
  const sf = branch.getSourceFile();
  return {
    calls: findNodes(branch, ts.isCallExpression).map((c) => c.getText(sf)),
    continues: findNodes(branch, ts.isContinueStatement).length > 0,
    waits: callsTo(branch, 'setTimeout', 'setInterval').length > 0
      || findNodes(branch, (n): n is ts.IterationStatement => ts.isIterationStatement(n, false)).length > 0,
  };
}

/** Every claim call's refusal, asserted per call — never "some call has one". */
function refusalsOf(calls: ClaimCall[]): Array<{ target: string | undefined; shape: ReturnType<typeof refusalShape> }> {
  expect(calls.length, 'no acquireBuildClaim call found — the scan would pass vacuously').toBeGreaterThan(0);
  return calls.map((c) => {
    expect(c.refusal, `the claim on ${c.target} has no \`if (!<claim>.ok)\` on its own result, in its own function`).toBeDefined();
    return { target: c.target, shape: refusalShape(c.refusal!) };
  });
}

describe('claimCalls reads each call from its own node, not a window (#1144)', () => {
  it('a NEIGHBOURING call\'s `kind: \'cli\'`, refusal and release do not vouch for a call that has none', () => {
    const src = [
      "const first = acquireBuildClaim(root, 'a');",
      'doSomething(first);',
      'let claim = null;',
      "const claimed = acquireBuildClaim(other, 'b', { kind: 'cli' });",
      'if (!claimed.ok) {',
      '  process.exit(1);',
      '}',
      'claim = claimed;',
      'try { build(); } finally { claim?.release(); }',
    ].join('\n');
    expect(claimCalls(src, 'synthetic.mjs').map((c) => [c.target, c.kind, !!c.refusal, c.releasedInFinally])).toEqual([
      ['root', undefined, false, false],
      ['other', 'cli', true, true],
    ]);
  });

  it('refusalsOf asserts EVERY call — one call\'s refusal does not cover a second call with none (#1144 close-out)', () => {
    const src = "const claimed = acquireBuildClaim(root, 'a', { kind: 'cli' });\nif (!claimed.ok) process.exit(1);\n"
      + "const second = acquireBuildClaim(sub, 'b', { kind: 'cli' });";
    expect(() => refusalsOf(claimCalls(src, 'synthetic.mjs'))).toThrow(/the claim on sub has no/);
  });

  it('a refusal inside a nested function nobody calls is not this call\'s refusal (#1144 close-out)', () => {
    const src = "const claimed = acquireBuildClaim(root, 'a', { kind: 'cli' });\nfunction never() { if (!claimed.ok) process.exit(1); }";
    expect(claimCalls(src, 'synthetic.mjs')[0]!.refusal).toBeUndefined();
  });

  it('a finally BEFORE the call, or one releasing a different claim, does not release it', () => {
    const before = "try { a(); } finally { claimed?.release(); }\nconst claimed = acquireBuildClaim(root, 'a');";
    const other = "const claimed = acquireBuildClaim(root, 'a');\ntry { a(); } finally { otherClaim?.release(); }";
    expect(claimCalls(before, 'synthetic.mjs')[0]!.releasedInFinally).toBe(false);
    expect(claimCalls(other, 'synthetic.mjs')[0]!.releasedInFinally).toBe(false);
  });

  it('a release in a function the finally only DEFINES, or on a same-named shadow, is not a release (#1144 re-review)', () => {
    const nested = "const claimed = acquireBuildClaim(root, 'a');\ntry { a(); } finally { const later = () => claimed.release(); }";
    const shadow = "const claimed = acquireBuildClaim(root, 'a');\n{ const claimed = other(); try { a(); } finally { claimed.release(); } }";
    expect(claimCalls(nested, 'synthetic.mjs')[0]!.releasedInFinally).toBe(false);
    expect(claimCalls(shadow, 'synthetic.mjs')[0]!.releasedInFinally).toBe(false);
  });

  it('a finally whose try ENCLOSES the call releases it; a holder bound by declaration counts too', () => {
    const enclosing = "let claim;\ntry { const claimed = acquireBuildClaim(root, 'a'); if (!claimed.ok) process.exit(1); claim = claimed; build(); } finally { claim?.release(); }";
    const declared = "const claimed = acquireBuildClaim(root, 'a');\nlet held = claimed;\ntry { a(); } finally { held.release(); }";
    expect(claimCalls(enclosing, 'synthetic.mjs')[0]!.releasedInFinally).toBe(true);
    expect(claimCalls(declared, 'synthetic.mjs')[0]!.releasedInFinally).toBe(true);
  });

  it('the refusal tests THIS binding by symbol — an inner same-named `claimed` is a different claim', () => {
    const src = "const claimed = acquireBuildClaim(root, 'a');\n{ const claimed = other(); if (!claimed.ok) process.exit(1); }";
    expect(claimCalls(src, 'synthetic.mjs')[0]!.refusal).toBeUndefined();
  });

  it('a call whose arguments run long is still read whole (the window failed CLOSED here)', () => {
    const src = `const claimed = acquireBuildClaim(root, \`${'x'.repeat(300)}\`, { kind: 'cli' });\nif (!claimed.ok) process.exit(1);`;
    const [c] = claimCalls(src, 'synthetic.mjs');
    expect([c!.kind, refusalShape(c!.refusal!).calls]).toEqual(['cli', ['process.exit(1)']]);
  });
});

describe('build-web.mjs takes the cross-process build claim (#650)', () => {
  const src = readScannedSource(buildWeb).code;

  it('imports acquireBuildClaim from buildClaimsStore.mjs', () => {
    expect(src).toMatch(/import\s*\{[^}]*acquireBuildClaim[^}]*\}\s*from\s*'\.\/buildClaimsStore\.mjs'/);
  });

  const calls = claimCalls(src, 'build-web.mjs');

  it('calls acquireBuildClaim, marking itself a CLI holder', () => {
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.map((c) => c.kind)).toEqual(calls.map(() => 'cli'));
  });

  it('refuses and exits non-zero on a held claim, without blocking/waiting', () => {
    for (const { shape } of refusalsOf(calls)) {
      expect(shape.calls).toContain('process.exit(1)');
      // No retry/wait loop in the refusal — a scripted build must not hang on an interactive editor.
      expect(shape.waits).toBe(false);
    }
  });

  it('releases the claim in a finally after it is taken', () => {
    expect(calls.map((c) => c.releasedInFinally)).toEqual(calls.map(() => true));
  });

  it('acquires BEFORE validateProjectConfig — the first thing the build pipeline does', () => {
    const acquireIdx = src.indexOf('acquireBuildClaim(');
    const validateIdx = src.indexOf('await validateProjectConfig();');
    expect(acquireIdx).toBeGreaterThan(-1);
    expect(validateIdx).toBeGreaterThan(-1);
    expect(acquireIdx).toBeLessThan(validateIdx);
  });
});

describe('add-native-targets.mjs takes the cross-process build claim (#650)', () => {
  const src = readScannedSource(addNativeTargets).code;

  it('imports acquireBuildClaim from buildClaimsStore.mjs', () => {
    expect(src).toMatch(/import\s*\{[^}]*acquireBuildClaim[^}]*\}\s*from\s*'\.\/buildClaimsStore\.mjs'/);
  });

  const calls = claimCalls(src, 'add-native-targets.mjs');

  it('calls acquireBuildClaim, marking itself a CLI holder', () => {
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.map((c) => c.kind)).toEqual(calls.map(() => 'cli'));
  });

  it('refuses (continues to the next project) rather than blocking, and marks the batch non-zero', () => {
    for (const { shape } of refusalsOf(calls)) {
      expect(shape.continues).toBe(true);
      expect(shape.waits).toBe(false);
    }
    expect(src).toMatch(/REFUSED/);
    expect(src).toMatch(/s\.startsWith\('FAILED'\)\s*\|\|\s*s\.startsWith\('REFUSED'\)/);
  });

  it('releases the claim in a finally, so every SKIP path (continue) still releases it', () => {
    expect(calls.map((c) => c.releasedInFinally)).toEqual(calls.map(() => true));
  });

  it('acquires BEFORE reading project.config.json (any mutation, including scaffoldNativeTarget\'s own heals, follows)', () => {
    const acquireIdx = src.indexOf('acquireBuildClaim(');
    const cfgPathIdx = src.indexOf("const cfgPath = path.join(projectRoot, 'project.config.json');");
    const scaffoldIdx = src.indexOf('scaffoldNativeTarget(');
    expect(acquireIdx).toBeGreaterThan(-1);
    expect(cfgPathIdx).toBeGreaterThan(-1);
    expect(scaffoldIdx).toBeGreaterThan(-1);
    expect(acquireIdx).toBeLessThan(cfgPathIdx);
    expect(acquireIdx).toBeLessThan(scaffoldIdx);
  });

  it('claims once PER PROJECT, not once for the whole batch — each spec gets its own dist', () => {
    // The acquire call sits INSIDE the `for (const spec of specs)` loop, not before it.
    const forIdx = src.indexOf('for (const spec of specs)');
    const acquireIdx = src.indexOf('acquireBuildClaim(');
    expect(forIdx).toBeGreaterThan(-1);
    expect(acquireIdx).toBeGreaterThan(forIdx);
  });
});

describe('ota-publish.mjs takes the cross-process build claim (#650)', () => {
  const src = readScannedSource(otaPublish).code;

  it('imports acquireBuildClaim from buildClaimsStore.mjs', () => {
    expect(src).toMatch(/import\s*\{[^}]*acquireBuildClaim[^}]*\}\s*from\s*'\.\/buildClaimsStore\.mjs'/);
  });

  const calls = claimCalls(src, 'ota-publish.mjs');

  it('calls acquireBuildClaim, marking itself a CLI holder — EVERY call, the sub-game dist\'s included', () => {
    expect(calls.length).toBe(2);
    expect(calls.map((c) => c.kind)).toEqual(['cli', 'cli']);
  });

  it('refuses via fail() (which exits non-zero) rather than blocking/waiting — on EVERY claim', () => {
    for (const { shape } of refusalsOf(calls)) {
      expect(shape.calls.some((t) => t.startsWith('fail('))).toBe(true);
      expect(shape.waits).toBe(false);
    }
  });

  it('releases EVERY claim in a finally after it is taken', () => {
    expect(calls.map((c) => [c.target, c.releasedInFinally])).toEqual(calls.map((c) => [c.target, true]));
  });

  it('acquires BEFORE hashing/reading distDir (buildManifestFiles) and before any upload', () => {
    const acquireIdx = src.indexOf('acquireBuildClaim(');
    const hashIdx = src.indexOf('await buildManifestFiles(distDir)');
    const uploadIdx = src.indexOf("gcloud storage rsync");
    expect(acquireIdx).toBeGreaterThan(-1);
    expect(hashIdx).toBeGreaterThan(-1);
    expect(uploadIdx).toBeGreaterThan(-1);
    expect(acquireIdx).toBeLessThan(hashIdx);
    expect(acquireIdx).toBeLessThan(uploadIdx);
  });

  it('ALSO claims a sub-game dist\'s own project before hashing it, and releases that claim too (#837)', () => {
    // build-subgame.mjs claims the SUB-GAME project; claiming only --project (the shell) left the
    // dist it uploads unguarded against a second build of that sub-game.
    const distClaimIdx = src.indexOf('acquireBuildClaim(distProjectDir,');
    const hashIdx = src.indexOf('await buildManifestFiles(distDir)');
    expect(distClaimIdx).toBeGreaterThan(-1);
    expect(distClaimIdx).toBeLessThan(hashIdx);
    expect(src).toMatch(/\}\s*finally\s*\{\s*buildClaim\.release\(\);\s*distClaim\?\.release\(\);/);
  });

  it('does NOT touch the heal/vendor family, and still parses project.config.json raw (unchanged by #650)', () => {
    // The brief for #650 explicitly calls this out: ota-publish.mjs reaches nothing from the
    // heal/vendor family on purpose (#582) — only the claim was added, not a new dependency on it.
    expect(src).not.toMatch(/healNativeConfig|ensureCapacitorDeps|vendorEnginePlugins|loadEnginePluginModule/);
    // Raw since #827 through the shared `readRawOtaBlock` — never the defaulting TS loader.
    expect(src).toMatch(/readRawOtaBlock\(projectDir\)/);
    expect(src).not.toMatch(/loadProjectConfig/);
  });
});

describe('build-subgame.mjs takes the cross-process build claim (#650, #837)', () => {
  // It had none: nothing ran it but a human until #837 wired it into the editor's OTA publish, which
  // uploads the `subgame-dist` it writes. A hand-run copy racing that publish would ship a torn module.
  const src = readScannedSource(buildSubgame).code;

  it('imports acquireBuildClaim from buildClaimsStore.mjs', () => {
    expect(src).toMatch(/import\s*\{[^}]*acquireBuildClaim[^}]*\}\s*from\s*'\.\/buildClaimsStore\.mjs'/);
  });

  const calls = claimCalls(src, 'build-subgame.mjs');

  it('claims the RESOLVED sub-game project, marking itself a CLI holder', () => {
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.map((c) => [c.target, c.kind])).toEqual(calls.map(() => ['abs', 'cli']));
  });

  it('refuses and exits non-zero on a held claim, without blocking/waiting', () => {
    for (const { shape } of refusalsOf(calls)) {
      expect(shape.calls).toContain('process.exit(1)');
      expect(shape.waits).toBe(false);
    }
  });

  it('releases the claim on the failure exit AND after a successful build', () => {
    // `process.exit()` skips `finally`, so both paths release explicitly.
    expect(src.match(/buildClaim\?\.\s*release\(\)/g) ?? []).toHaveLength(2);
    const failIdx = src.indexOf('buildClaim?.release();\n  process.exit(1);');
    expect(failIdx).toBeGreaterThan(-1);
  });

  it('acquires BEFORE its first write (the scoped tsconfig) and before the vite build', () => {
    const acquireIdx = src.indexOf('acquireBuildClaim(');
    const writeIdx = src.indexOf('writeFileSync(scopedPath');
    const viteIdx = src.indexOf('build --config');
    expect(writeIdx).toBeGreaterThan(-1);
    expect(viteIdx).toBeGreaterThan(-1);
    expect(acquireIdx).toBeLessThan(writeIdx);
    expect(acquireIdx).toBeLessThan(viteIdx);
  });
});

// ── Everything above is source-text matching: it proves each script CALLS acquireBuildClaim, not
// that the claim actually behaves correctly across a real process boundary. That gap is exactly
// what broke (reproduced): `/api/build`/`/api/ota/publish`/`/api/add-native-target` hold the claim
// for their WHOLE pipeline and then spawn `build-web.mjs` as a CHILD process with the identical
// MODOKI_PROJECT — which resolves the SAME root and, before the re-entrancy fix
// (buildClaimsStore.mjs's own "Re-entrancy through a CHILD PROCESS" section), refused itself
// unconditionally. This spawns the REAL build-web.mjs (not a synthetic runner — precedent:
// `cliNativeBuildHeals.test.ts`'s "no-esbuild" case runs the real loader in a plain node
// subprocess) while THIS test process holds an ancestor claim, proving the child recognizes it and
// proceeds instead of deadlocking — and that an unrelated invocation with no matching token is
// still refused exactly as before. `buildClaimsStore.test.ts` unit-tests the token comparison
// itself, in-process; this is the end-to-end property those units add up to.
describe('build-web.mjs inherits an ancestor claim on the SAME project instead of deadlocking (#650 re-entrancy, reproduced)', () => {
  let home: string;
  let prevHome: string | undefined;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-home-'));
    prevHome = process.env.MODOKI_HOME;
    process.env.MODOKI_HOME = home;
  });
  afterEach(() => {
    resetBuildClaimsForTests();
    if (prevHome === undefined) delete process.env.MODOKI_HOME;
    else process.env.MODOKI_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  /** Run the REAL build-web.mjs from a throwaway SCRATCH cwd — same technique
   *  `buildWebTargetFlag.test.ts` already established for keeping a genuine invocation fast in a
   *  unit test. With no `engine/plugins/load-project-config.ts` under it, `validateProjectConfig`
   *  degrades to a harmless "no-source" warning (nothing here to validate) and the script presses
   *  on toward `vite build`, which fails FAST with "Cannot find module" — there is no
   *  `node_modules/vite` in scratch either. That failure is this test's "proceeded past the claim
   *  gate" signal; a claim REFUSAL exits well before either check is ever reached. */
  function runBuildWeb(env: NodeJS.ProcessEnv): { status: number; stderr: string } {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'modoki-claim-inherit-'));
    try {
      execFileSync(process.execPath, [buildWeb, '--target', 'web'], { cwd: scratch, env, encoding: 'utf8' });
      return { status: 0, stderr: '' };
    } catch (e) {
      const err = e as { status?: number; stderr?: string };
      return { status: err.status ?? 1, stderr: err.stderr ?? '' };
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }

  it('a CHILD process inheriting the ancestor token proceeds instead of deadlocking', () => {
    // Never created on disk — the claim (and MODOKI_PROJECT) only ever compares this path STRING;
    // build-web.mjs's own project-config read degrades harmlessly (see runBuildWeb's comment)
    // long before anything would need the directory to exist.
    const projectRoot = path.join(home, 'inherit-project');
    const ancestor = acquireBuildClaim(projectRoot, 'editor build', { kind: 'editor' });
    expect(ancestor.ok).toBe(true);
    try {
      // The env a real spawned build step gets is `{ ...process.env, MODOKI_PROJECT }`
      // (`buildStepEnv`/the CLI scripts' own `runShell`) — and `process.env` in THIS process now
      // carries the token `acquireBuildClaim` just published, exactly as it would for a genuine
      // child of an editor route or of `add-native-targets.mjs`'s own scaffold.
      const { status, stderr } = runBuildWeb({ ...process.env, MODOKI_PROJECT: projectRoot });
      expect(stderr).not.toMatch(/already holds the build claim/);
      // Proceeded PAST the claim gate — failed downstream instead, for the unrelated (scratch-cwd)
      // reason runBuildWeb's own comment explains, not a self-deadlock.
      expect(status).not.toBe(0);
      expect(stderr).toMatch(/Cannot find module/);
    } finally {
      if (ancestor.ok) ancestor.release();
    }
  });

  it('an UNRELATED process (no matching token) is still refused, naming the ancestor claim', () => {
    const projectRoot = path.join(home, 'refuse-project');
    const ancestor = acquireBuildClaim(projectRoot, 'editor build', { kind: 'editor' });
    expect(ancestor.ok).toBe(true);
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, MODOKI_PROJECT: projectRoot };
      // A plain second invocation with no ancestor relationship — e.g. a human running
      // `npm run build` by hand from an ordinary shell while the editor's own build is in flight.
      delete env.MODOKI_BUILD_CLAIM_TOKEN;
      const { status, stderr } = runBuildWeb(env);
      expect(status).not.toBe(0);
      expect(stderr).toMatch(/already holds the build claim/);
      expect(stderr).toContain('editor build');
      // Refused BEFORE ever reaching the "proceeded" failure mode the previous test exercises.
      expect(stderr).not.toMatch(/Cannot find module/);
    } finally {
      if (ancestor.ok) ancestor.release();
    }
  });

  it("a FOREIGN token (a different project's still-live claim) does not grant a pass-through — refused, not bypassed", () => {
    const otherRoot = path.join(home, 'other-project');
    const other = acquireBuildClaim(otherRoot, 'other build', { kind: 'editor' });
    expect(other.ok).toBe(true);
    const projectRoot = path.join(home, 'foreign-token-project');
    const ancestor = acquireBuildClaim(projectRoot, 'editor build', { kind: 'editor' });
    expect(ancestor.ok).toBe(true);
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, MODOKI_PROJECT: projectRoot };
      // Simulate a child that inherited a DIFFERENT project's token — a stale value left over from
      // an earlier build in the same long-lived shell/process, say — rather than this one's own.
      env.MODOKI_BUILD_CLAIM_TOKEN = readBuildClaim(otherRoot)?.token;
      const { status, stderr } = runBuildWeb(env);
      expect(status).not.toBe(0);
      expect(stderr).toMatch(/already holds the build claim/);
      expect(stderr).not.toMatch(/Cannot find module/);
    } finally {
      if (ancestor.ok) ancestor.release();
      if (other.ok) other.release();
    }
  });
});
