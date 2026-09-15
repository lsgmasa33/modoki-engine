/** Both native-build entry points must heal through the ONE sequence, `healNativeProject`
 *  (`engine/plugins/healNativeProject.ts`, #827): the editor's `/api/build` in-process, and
 *  `build-web.mjs --target native`, which is what `npm run build` runs and what `docs/build.md`
 *  presents as the manual EQUIVALENT of Build → iOS/Android Device.
 *
 *  The history is why this is a census and not a courtesy. Games depend on a content-addressed
 *  tarball committed into the project, not on plugin source, so a plugin edit reaches a device only
 *  once it is re-packed and installed; identity settings and engine-required Capacitor deps likewise
 *  only reach a device once healed in. The editor did all of it. `build-web.mjs` did none (#148),
 *  then one step (#150), then lacked the stale-`node_modules` check (#685) — the documented CLI
 *  recipe could ship an IPA/APK with a stale team, a missing plugin or the PREVIOUS native code
 *  while every signal reported success. Each fix copied one more step into one more file.
 *
 *  The sequence's BEHAVIOUR — order, install gating, the unconditional stale check, the claim gate,
 *  the remedy text — is tested once, directly, in `tests/plugins/healNativeProject.test.ts`. What
 *  this file pins is WIRING: each entry point reaches that function, and neither reaches a step of it
 *  directly, because a step called beside the sequence is exactly the hand-copy #827 removed.
 *
 *  ⚠️ Wiring, not behaviour — a source census proves a call is written, not that it runs on the path
 *  that matters (`cliBuildClaims.test.ts` carries the scar where one stayed green through a
 *  deadlock). Driving `build-web.mjs` end to end costs a full tsc + vite build and mutates a real
 *  project, which is why the behaviour lives in the unit suite instead. */

import { describe, it, expect } from 'vitest';
import { expectInOrder } from '@modoki/engine/testing/inOrder';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readScannedSource } from '@modoki/engine/testing';
import {
  accessPath, boundIdentifier, calledNames, calleeName, callsTo, callsToPath, findNodes, functionBodyOf, functionsNamed, importBindings,
  parseSource, printedText, propertyValue, readsOf, stringValueOf, ts, unwrapValue, variablesNamed,
} from '@modoki/engine/testing/sourceAst';
import { assertExemptionLedger } from '@modoki/engine/testing/exemptionLedger';
import { repoFiles } from '../../scripts/repoCorpus.mjs';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const buildWeb = path.join(repoRoot, 'engine', 'scripts', 'build-web.mjs');
const assetScanner = path.join(repoRoot, 'engine', 'plugins', 'vite-asset-scanner.ts');

/** The steps of the sequence. An entry point calling any of these itself is composing the sequence
 *  by hand again. */
const HEAL_STEPS = ['healNativeConfig', 'ensureCapacitorDeps', 'vendorEnginePlugins', 'writeVendorMarker',
  'verifyInstalledMatchesTarball', 'verifyInstalledMatchesTarballResult'];

// ⚠️ **Every unit below is read through the parser (#1195).** These checks used to cut their subjects
// as text — a function body to its matching `}` by counting braces (so a `{` in a string moved the end),
// an `if (…)` branch the same way, "the error path" as the 400 characters after a call, the install
// port as the text up to the next `'});'`, and a plan's step as the text up to the next `'},'` — then ran
// regexes over the slice, which a reformatted line or a blank line in between also broke.

const buildWebSf = () => parseSource(readScannedSource(buildWeb).code, 'build-web.mjs');
const scannerSf = () => parseSource(readScannedSource(assetScanner).code, 'vite-asset-scanner.ts');

/** The one function named `name` in `sf` — a rename or a second copy fails by name. */
function oneFunction(sf: ts.SourceFile, name: string): ts.FunctionLikeDeclaration & { body: ts.ConciseBody } {
  const fns = functionsNamed(sf, name);
  expect(fns.length, `expected one function named ${name} in ${sf.fileName} — re-anchor, do not delete`).toBe(1);
  return fns[0]!;
}

/** `e` is `<path> === '<value>'` / `!==`, either way round. */
function isComparison(e: ts.Expression, op: ts.SyntaxKind, path: string, value: string): boolean {
  const u = unwrapValue(e);
  if (!ts.isBinaryExpression(u) || u.operatorToken.kind !== op) return false;
  return (accessPath(u.left) === path && stringValueOf(u.right) === value)
    || (accessPath(u.right) === path && stringValueOf(u.left) === value);
}

/** Each `loadEnginePluginModuleResult(<root>, path.join(…))` in `root`, as `<root>::<joined parts>`. */
function loaderEntries(root: ts.Node): string[] {
  return callsTo(root, 'loadEnginePluginModuleResult').map((c) => {
    const [base, entry] = c.arguments;
    const parts = entry && ts.isCallExpression(entry) && accessPath(entry.expression) === 'path.join'
      ? entry.arguments.map((a) => stringValueOf(a) ?? `<${printedText(a)}>`) : [`<${entry ? printedText(entry) : ''}>`];
    return `${base ? printedText(base) : ''}::${parts.join('/')}`;
  });
}

/** What the `if (!<binding>)` branch of `fn` — the degrade path when a module did not load — does. */
function degradeBranch(fn: ts.FunctionLikeDeclaration & { body: ts.ConciseBody }, binding: string): {
  namesNoEsbuild: boolean; warns: number; endsInReturn: boolean; exits: number;
} {
  const ifs = findNodes(fn.body, ts.isIfStatement).filter((s) => {
    const t = unwrapValue(s.expression);
    return ts.isPrefixUnaryExpression(t) && t.operator === ts.SyntaxKind.ExclamationToken && accessPath(t.operand) === binding;
  });
  expect(ifs.length, `expected one \`if (!${binding})\` in ${fn.name?.getText() ?? 'the function'}`).toBe(1);
  const then = ifs[0]!.thenStatement;
  const last = ts.isBlock(then) ? then.statements[then.statements.length - 1] : then;
  return {
    namesNoEsbuild: findNodes(then, (n): n is ts.Expression => ts.isExpression(n)
      && isComparison(n, ts.SyntaxKind.EqualsEqualsEqualsToken, 'reason', 'no-esbuild')).length > 0,
    warns: callsToPath(then, 'console.warn').length,
    endsInReturn: !!last && ts.isReturnStatement(last),
    exits: callsToPath(then, 'process.exit').length,
  };
}

/** The `<subject>.reason` values `root` THROWS on — `if (result.reason === 'k') throw …`, the throw as the
 *  whole branch or the last statement of its block. */
function throwingReasons(root: ts.Node, subject: string): string[] {
  return findNodes(root, ts.isIfStatement).flatMap((s) => {
    const t = unwrapValue(s.expression);
    if (!ts.isBinaryExpression(t) || t.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken
      || accessPath(t.left) !== `${subject}.reason`) return [];
    const then = s.thenStatement;
    const last = ts.isBlock(then) ? then.statements[then.statements.length - 1] : then;
    const reason = stringValueOf(t.right);
    return last && ts.isThrowStatement(last) && reason !== undefined ? [reason] : [];
  });
}

/** Whether every call to `callee` in `fn` runs only after an early `return` has ruled out `target !== 'native'`. */
function gatedOnNative(fn: ts.FunctionLikeDeclaration & { body: ts.ConciseBody }, callee: ts.CallExpression): boolean {
  const body = fn.body;
  if (!ts.isBlock(body)) return false;
  // An early exit at the top of the function body, BEFORE the statement holding the call.
  const stmt = body.statements.find((s) => s.pos <= callee.pos && callee.end <= s.end);
  const earlier = stmt ? body.statements.slice(0, body.statements.indexOf(stmt)) : [];
  return earlier.some((s) => ts.isIfStatement(s) && !s.elseStatement && ts.isReturnStatement(s.thenStatement)
    && disjuncts(s.expression).some((d) => isComparison(d, ts.SyntaxKind.ExclamationEqualsEqualsToken, 'target', 'native')));
}

/** `a || b || c` → `[a, b, c]` (parentheses peeled); anything else → `[e]`. */
function disjuncts(e: ts.Expression): ts.Expression[] {
  const u = unwrapValue(e);
  return ts.isBinaryExpression(u) && u.operatorToken.kind === ts.SyntaxKind.BarBarToken ? [...disjuncts(u.left), ...disjuncts(u.right)] : [u];
}

/** The calls to a heal step anywhere in `sf`, by name — called directly or as a member. */
function healStepCalls(sf: ts.SourceFile): string[] {
  return calledNames(sf).filter((n) => HEAL_STEPS.includes(n));
}

describe('build-web.mjs heals through the ONE shared sequence (#148, #150, #685, #827)', () => {
  const heal = () => oneFunction(buildWebSf(), 'healNativeProject');

  it('has its heal function (the anchor every assertion below reads)', () => {
    expect(heal().parameters.length).toBe(0);
  });

  it('loads healNativeProject.ts through the reason-reporting loader, and calls it', () => {
    expect(loaderEntries(heal().body)).toEqual(['repoRoot::plugins/healNativeProject.ts']);
    const calls = callsToPath(heal().body, 'healMod.healNativeProject');
    expect(calls.map((c) => c.arguments.slice(0, 3).map(printedText))).toEqual([['projectRoot', 'repoRoot', 'platforms']]);
  });

  it('derives platforms through nativeHealPlatforms, so the editor\'s per-platform step is honoured (#1062)', () => {
    const decls = variablesNamed(heal().body, 'platforms');
    expect(decls.length).toBe(1);
    const init = decls[0]!.initializer && unwrapValue(decls[0]!.initializer);
    expect(init && ts.isCallExpression(init) && accessPath(init.expression) === 'nativeHealPlatforms'
      && accessPath(init.arguments[0]!) === 'process.env').toBe(true);
  });

  it('calls no step of the sequence directly — anywhere in the script', () => {
    expect(healStepCalls(buildWebSf())).toEqual([]);
  });

  it('gates the heal on the NATIVE target', () => {
    const [call] = callsToPath(heal().body, 'healMod.healNativeProject');
    expect(call && gatedOnNative(heal(), call)).toBe(true);
  });

  it('heals BEFORE the typecheck, which resolves plugin types out of the project node_modules', () => {
    expectInOrder(readScannedSource(buildWeb).code, ['await healNativeProject()', 'tsconfig.app.scoped.json`'], 'the native build');
  });

  it('FAILS the build (throws) on a stale node_modules, a failed install and a Firebase auth manifest refusal (#1062) — never merely logs', () => {
    expect(throwingReasons(heal().body, 'result')).toEqual(['stale-node-modules', 'facebook-sdk-manifest', 'install-failed']);
  });

  it('warns with the reason and RETURNS — never process.exit — when the module cannot load (#714, #731)', () => {
    expect(degradeBranch(heal(), 'healMod')).toEqual({ namesNoEsbuild: true, warns: 1, endsInReturn: true, exits: 0 });
  });
});

describe('the editor /api/build heals through the same sequence (#685 parity, #827)', () => {
  /** The ONE call to the imported `healNativeProject`. */
  const healCall = (sf = scannerSf()) => {
    const calls = callsTo(sf, 'healNativeProject').filter((c) => ts.isIdentifier(c.expression));
    expect(calls.length, 'expected one healNativeProject(…) call in vite-asset-scanner.ts').toBe(1);
    return calls[0]!;
  };

  it('imports healNativeProject from the shared module and calls it for the build platform', () => {
    const sf = scannerSf();
    expect(importBindings(sf, './healNativeProject').filter((b) => !b.typeOnly).map((b) => b.imported)).toContain('healNativeProject');
    const call = healCall(sf);
    expect(call.arguments.slice(0, 3).map(printedText)).toEqual(['projectRoot', 'buildCwd', '[platform]']);
    expect(ts.isAwaitExpression(call.parent)).toBe(true);
  });

  it('calls no step of the sequence directly', () => {
    expect(healStepCalls(scannerSf())).toEqual([]);
  });

  it('names the platform on BOTH scaffold runners too — the auto-scaffold shift()s the plan\'s own step away (#1062)', () => {
    expect(scaffoldRunnerEnvs(scannerSf()), '/api/add-native-target runShell and the /api/build runScaffoldShell')
      .toEqual([{ namesPlatform: true }, { namesPlatform: true }]);
  });

  it('names the platform on each per-platform build-web step — or an Android build heals iOS too (#1062)', () => {
    const sf = scannerSf();
    for (const [plan, platform] of [['iosPrefixSteps', 'ios'], ['androidPrefixSteps', 'android']] as const) {
      expect(planBuildWebPlatforms(sf, plan), `${plan}'s build-web step`).toEqual([platform]);
    }
  });

  it('heals BEFORE the #370 release-file writes — the heal is what gitignores keystore.properties', () => {
    // `healNativeConfig` adds `keystore.properties` to a freshly scaffolded `android/.gitignore`;
    // writing the upload key's passwords first leaves them unignored for as long as the heal takes,
    // or for good if it refuses.
    expect(releaseWritesAroundHeal(scannerSf(), healCall())).toEqual({
      renderKeystoreProperties: { before: 0, after: 1 },
      renderExportOptionsPlist: { before: 0, after: 1 },
    });
  });

  it('installs through the abort-aware scaffold shell, not a blocking exec', () => {
    // The port RETURNS the shell's own promise: the heal awaits it for `install-failed`, so a port that starts
    // the install and returns `true` builds on while npm is still running (#1195 close-out review).
    expect(portReturns(healCall().arguments[3], 'install')).toEqual(['runScaffoldShell']);
    const install = functionBodyOf(propertyValue(healCall().arguments[3], 'install'));
    expect(calledNames(install!).filter((n) => ['execSync', 'execFileSync', 'spawnSync'].includes(n))).toEqual([]);
  });

  it('ENDS the build on every refusal — the block cannot fall through to the build steps', () => {
    expect(refusalBlock(scannerSf())).toEqual({
      // Every refusal reports; a template status is named by its fixed head.
      statuses: ['FAILED:npm install (', 'FAILED:stale node_modules', 'FAILED:Firebase auth plugin manifest (Facebook SDK)', 'FAILED:Build claim not held\n'],
      endsWith: ['res.end()', 'return'],
      buildCalls: [],
    });
  });
});

/** For each #370 release-file writer, how many of its calls in `sf` sit before and after `heal`. */
function releaseWritesAroundHeal(sf: ts.SourceFile, heal: ts.CallExpression): Record<string, { before: number; after: number }> {
  return Object.fromEntries(['renderKeystoreProperties', 'renderExportOptionsPlist'].map((w) => {
    const calls = callsTo(sf, w);
    return [w, { before: calls.filter((c) => c.pos < heal.pos).length, after: calls.filter((c) => c.pos > heal.pos).length }];
  }));
}

/** What the inline function at `key` of object literal `obj` hands back: the callee of a concise arrow's call, or
 *  of each `return <call>` of its own (not a nested function's), awaited or not — `<text>` for anything else. */
function portReturns(obj: ts.Expression | undefined, key: string): string[] {
  const fn = propertyValue(obj, key);
  const f = fn && ts.isExpression(fn) ? unwrapValue(fn) : fn;
  expect(f && (ts.isArrowFunction(f) || ts.isFunctionExpression(f) || ts.isMethodDeclaration(f)), `no inline \`${key}\` port`).toBe(true);
  const port = f as ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration;
  const named = (e: ts.Expression) => { const u = unwrapValue(e); return ts.isCallExpression(u) ? calleeName(u) ?? `<${printedText(u)}>` : `<${printedText(u)}>`; };
  if (port.body && !ts.isBlock(port.body)) return [named(port.body)];
  return findNodes(port.body!, ts.isReturnStatement)
    .filter((r) => { let cur: ts.Node = r.parent; while (!ts.isFunctionLike(cur)) cur = cur.parent; return cur === port; })
    .map((r) => (r.expression ? named(r.expression) : '<undefined>'));
}

/** Every object literal in `sf` that spreads `buildEnv` and sets `MODOKI_ICONS_HANDLED: '1'` — a scaffold
 *  runner's env — and whether it also passes `MODOKI_NATIVE_PLATFORM: platform ?? …`. */
function scaffoldRunnerEnvs(sf: ts.SourceFile): Array<{ namesPlatform: boolean }> {
  return findNodes(sf, ts.isObjectLiteralExpression)
    .filter((o) => o.properties.some((p) => ts.isSpreadAssignment(p) && accessPath(p.expression) === 'buildEnv')
      && stringValueOf(propertyValue(o, 'MODOKI_ICONS_HANDLED') as ts.Expression | undefined) === '1')
    .map((o) => {
      const v = propertyValue(o, 'MODOKI_NATIVE_PLATFORM');
      const u = v && ts.isExpression(v) ? unwrapValue(v) : undefined;
      return { namesPlatform: !!u && ts.isBinaryExpression(u) && u.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken && accessPath(u.left) === 'platform' };
    });
}

/** The `MODOKI_NATIVE_PLATFORM` each `node engine/scripts/build-web.mjs --target native` step of `const <plan>` sets. */
function planBuildWebPlatforms(sf: ts.SourceFile, plan: string): Array<string | undefined> {
  const decls = variablesNamed(sf, plan);
  expect(decls.length, `${plan} is gone — re-anchor`).toBe(1);
  const list = decls[0]!.initializer && unwrapValue(decls[0]!.initializer);
  expect(list && ts.isArrayLiteralExpression(list), `${plan} is no longer an array literal`).toBe(true);
  return (list as ts.ArrayLiteralExpression).elements.filter(ts.isObjectLiteralExpression)
    .filter((step) => stringValueOf(propertyValue(step, 'cmd') as ts.Expression | undefined) === 'node engine/scripts/build-web.mjs --target native')
    .map((step) => {
      const env = propertyValue(step, 'env');
      return stringValueOf(propertyValue(env && ts.isExpression(env) ? env : undefined, 'MODOKI_NATIVE_PLATFORM') as ts.Expression | undefined);
    });
}

/** The `if (!heal.ok)` block of the editor build: the statuses it reports, how it ends, and any build step it calls. */
function refusalBlock(sf: ts.SourceFile): { statuses: string[]; endsWith: string[]; buildCalls: string[] } {
  const ifs = findNodes(sf, ts.isIfStatement).filter((s) => {
    const t = unwrapValue(s.expression);
    return ts.isPrefixUnaryExpression(t) && t.operator === ts.SyntaxKind.ExclamationToken && accessPath(t.operand) === 'heal.ok';
  });
  expect(ifs.length, 'expected one `if (!heal.ok)` in vite-asset-scanner.ts').toBe(1);
  const then = ifs[0]!.thenStatement;
  const stmts = ts.isBlock(then) ? then.statements : [then];
  return {
    statuses: callsTo(then, 'sendStatus').map((c) => {
      const a = c.arguments[0];
      return a && ts.isTemplateExpression(a) ? a.head.text : stringValueOf(a) ?? '';
    }),
    endsWith: stmts.slice(-2).map((s) => ts.isExpressionStatement(s) ? printedText(s.expression) : ts.isReturnStatement(s) && !s.expression ? 'return' : printedText(s)),
    buildCalls: calledNames(then).filter((n) => ['runScaffoldShell', 'spawnBuildCommand', 'execSync'].includes(n)),
  };
}

describe('describeUnreadablePackageJsonWarning (the shared #685/#731 producer)', () => {
  it('names the project root, the #685 check, and why it matters — asserted DIRECTLY, not via a caller', async () => {
    const { describeUnreadablePackageJsonWarning } = await import('../../scripts/staleNodeModulesWarning.mjs');
    const msg = describeUnreadablePackageJsonWarning('/tmp/fixture-project');
    expect(msg).toContain(path.join('/tmp/fixture-project', 'package.json'));
    expect(msg).toMatch(/could not be read or parsed/);
    expect(msg).toContain('#685');
    expect(msg).toMatch(/stale-node_modules check did NOT run/);
    expect(msg).toMatch(/undetected/);
    // No caller-specific prefix baked in here — build-web.mjs adds its own "[build-web] " on top.
    expect(msg.startsWith('[build-web]')).toBe(false);
  });
});

describe('build-web.mjs validates project config before it builds anything (#589 sibling)', () => {
  // `/api/build` runs projectBuildConfigErrors (#827) for EVERY target
  // (web/playable/ios/android alike) before its platform branch — vite-asset-scanner.ts's
  // `/api/build` handler. add-native-targets.mjs (#589) added the identical pair before its
  // scaffold. This is the same check's sibling in the third CLI path that reaches a native
  // project unvalidated: `build-web.mjs`, what `npm run build` actually runs and what
  // `docs/build.md` documents as the manual native-build recipe.
  //
  // The BEHAVIOURAL half — that these validators genuinely reject a bad config (an appId with a
  // space, an orientation typo) and pass a good one — is already covered by
  // `cliNativeTargetValidates.test.ts`'s first describe block (#589); not duplicated here.

  it('reaches the shared projectBuildConfigErrors, and neither half of it directly (#827)', () => {
    const called = calledNames(buildWebSf());
    expect(called).toContain('projectBuildConfigErrors');
    expect(called.filter((n) => n === 'projectConfigUnionErrors' || n === 'validateBuildConfig')).toEqual([]);
  });

  it('runs the check BEFORE the heal', () => {
    // Loose about HOW, strict about the ordering fact that matters — validation must land before
    // ANY native file gets healed from a config nothing has checked yet. Compared at the CALL sites
    // in the main flow: the two function DEFINITIONS' order in the file says nothing about which runs.
    expectInOrder(readScannedSource(buildWeb).code, ['await validateProjectConfig();', 'await healNativeProject();'], 'the native build');
  });

  it('exits non-zero on the error path, without a --force-style bypass', () => {
    // The issue explicitly leaves a bypass as an owner call — this check must not grow one.
    expect(configErrorPath(oneFunction(buildWebSf(), 'validateProjectConfig'))).toEqual({ exitsWith: ['1'], forceFlags: [] });
  });
});

/** What `fn` does with `projectBuildConfigErrors(…)`'s result: the exit codes of each `if` that tests the
 *  bound errors' `.length`, and any string in `fn` naming a `--force` flag. */
function configErrorPath(fn: ts.FunctionLikeDeclaration & { body: ts.ConciseBody }): { exitsWith: string[]; forceFlags: string[] } {
  const calls = callsTo(fn.body, 'projectBuildConfigErrors');
  expect(calls.length, 'expected one projectBuildConfigErrors(…) call').toBe(1);
  const bound = boundIdentifier(calls[0]!);
  expect(bound, 'the projectBuildConfigErrors(…) result is not bound to a name').toBeDefined();
  const lengthTests = readsOf(bound!).filter((r) => {
    const p = r.parent;
    const test = ts.isPropertyAccessExpression(p) && p.name.text === 'length' ? ts.findAncestor(p, ts.isIfStatement) : undefined;
    return !!test && test.expression.pos <= r.pos && r.end <= test.expression.end;
  }).map((r) => ts.findAncestor(r, ts.isIfStatement)!);
  return {
    exitsWith: lengthTests.flatMap((s) => callsToPath(s.thenStatement, 'process.exit').map((c) => (c.arguments[0] ? printedText(c.arguments[0]) : ''))),
    forceFlags: findNodes(fn.body, ts.isStringLiteralLike).map((s) => s.text).filter((t) => t.includes('--force')),
  };
}

describe('both editor routes validate through the shared projectBuildConfigErrors (#589, #827)', () => {
  it('/api/build and /api/add-native-target each call it, and neither calls a half of it', () => {
    // Two calls: one per route. Fewer means a route stopped validating; a half called directly is
    // the hand-assembled expression #827 removed, which the next check added to the function misses.
    const sf = scannerSf();
    expect(callsTo(sf, 'projectBuildConfigErrors').map((c) => c.arguments.map(printedText))).toEqual([['projectRoot'], ['projectRoot']]);
    expect(calledNames(sf).filter((n) => n === 'projectConfigUnionErrors' || n === 'validateBuildConfig')).toEqual([]);
  });
});

// ── #731: validateProjectConfig used to skip in TOTAL SILENCE — `if (!cfgMod) return;` — on a
// source checkout with an incomplete `npm install` exactly as much as on the legitimate
// packaged-editor case, the same null-conflates-absent-with-unknown shape #714 fixed one level up
// in the loader itself (pinned below by the unmodified "loadEnginePluginModule degrades instead of
// throwing" describe block — the reason discriminant itself is not re-tested here). What's new
// here is that build-web.mjs's OWN degrade branch now consumes that reason instead of discarding
// it silently.
describe('build-web.mjs warns (never silently) when the project-config gate cannot load (#731)', () => {
  const validate = () => oneFunction(buildWebSf(), 'validateProjectConfig');

  it('uses loadEnginePluginModuleResult for the load, not the plain null-returning wrapper', () => {
    expect(loaderEntries(validate().body)).toEqual(['repoRoot::plugins/load-project-config.ts']);
    expect(calledNames(validate().body)).not.toContain('loadEnginePluginModule');
  });

  it('warns with the reason and RETURNS — never process.exit — when the module cannot load', () => {
    expect(degradeBranch(validate(), 'cfgMod')).toEqual({ namesNoEsbuild: true, warns: 1, endsInReturn: true, exits: 0 });
  });
});

describe('the build-web.mjs / /api/build readers see the unit, not a slice of text (#1195)', () => {
  const probe = (src: string, label = 'probe.mjs') => parseSource(src, label);

  it('reads a function and its degrade branch whole, however its braces and blank lines fall', () => {
    // A `{` inside a string used to move the brace-counted end; a blank line broke `\)\s*throw`.
    const sf = probe([
      'async function healNativeProject() {',
      "  if (target !== 'native' || !proj) return;",
      "  const { module: healMod, reason } = await loadEnginePluginModuleResult(repoRoot, path.join('plugins', 'healNativeProject.ts'));",
      "  if (!healMod) { const why = reason === 'no-esbuild' ? '{' : 'x'; console.warn(why); return; }",
      '  const platforms = nativeHealPlatforms(process.env, has);',
      '  const result = await healMod.healNativeProject(projectRoot, repoRoot, platforms, {});',
      "  if (result.reason === 'stale-node-modules')\n\n    throw new Error('x');",
      "  if (result.reason === 'install-failed') { log(); throw new Error('y'); }",
      "  if (result.reason === 'facebook-sdk-manifest') console.error('only logs');",
      '}',
    ].join('\n'));
    const fn = oneFunction(sf, 'healNativeProject');
    expect(loaderEntries(fn.body)).toEqual(['repoRoot::plugins/healNativeProject.ts']);
    expect(degradeBranch(fn, 'healMod')).toEqual({ namesNoEsbuild: true, warns: 1, endsInReturn: true, exits: 0 });
    expect(throwingReasons(fn.body, 'result')).toEqual(['stale-node-modules', 'install-failed']);
    expect(gatedOnNative(fn, callsToPath(fn.body, 'healMod.healNativeProject')[0]!)).toBe(true);
  });

  it('refuses a degrade branch that exits, logs nothing, or does not end the function', () => {
    const branch = (then: string) => degradeBranch(oneFunction(probe(`async function f() { const { module: m } = load(); if (!m) ${then} go(); }`), 'f'), 'm');
    expect(branch("{ console.warn('x'); process.exit(1); }")).toEqual({ namesNoEsbuild: false, warns: 1, endsInReturn: false, exits: 1 });
    expect(branch('{ return; console.warn(1); }')).toEqual({ namesNoEsbuild: false, warns: 1, endsInReturn: false, exits: 0 });
    expect(branch('return;')).toEqual({ namesNoEsbuild: false, warns: 0, endsInReturn: true, exits: 0 });
    expect(() => degradeBranch(oneFunction(probe('function f() { if (!other) return; }'), 'f'), 'm')).toThrow(/one `if \(!m\)`/);
  });

  it('gates only on an EARLY exit that rules out a non-native target', () => {
    const gated = (body: string) => {
      const fn = oneFunction(probe(`function f() {\n${body}\n}`), 'f');
      return gatedOnNative(fn, callsTo(fn.body, 'heal')[0]!);
    };
    expect(gated("if (!proj || target !== 'native') return;\nheal();")).toBe(true);
    expect(gated("heal();\nif (target !== 'native') return;")).toBe(false);
    expect(gated("if (target === 'native') log();\nheal();")).toBe(false);
    expect(gated("if (target !== 'web') return;\nheal();")).toBe(false);
    expect(gated("if (target !== 'native') log();\nheal();")).toBe(false);
    expect(gated("if ('native' !== target) return;\nheal();")).toBe(true);
  });

  it('reads the error path by what the bound result reaches, and a --force anywhere in the function', () => {
    const path_ = (body: string) => configErrorPath(oneFunction(probe(`async function v() {\n${body}\n}`), 'v'));
    expect(path_("const errs = cfg.projectBuildConfigErrors(root);\nconsole.log('a long line'.repeat(40));\n\nif (errs.length) {\n  console.error(errs);\n  process.exit(1);\n}"))
      .toEqual({ exitsWith: ['1'], forceFlags: [] });
    expect(path_("const errs = cfg.projectBuildConfigErrors(root);\nif (errs.length && !process.argv.includes('--force')) process.exit(2);"))
      .toEqual({ exitsWith: ['2'], forceFlags: ['--force'] });
    expect(path_('const errs = cfg.projectBuildConfigErrors(root);\nif (other.length) process.exit(1);')).toEqual({ exitsWith: [], forceFlags: [] });
    expect(path_('const errs = cfg.projectBuildConfigErrors(root);\nif (errs) process.exit(3);')).toEqual({ exitsWith: [], forceFlags: [] });
    expect(() => path_('cfg.projectBuildConfigErrors(root);')).toThrow(/not bound/);
  });

  it('reads the editor build\'s refusal block, plan steps and runner envs as units', () => {
    const sf = probe([
      "const iosPrefixSteps = [{ label: '}', cmd: 'node engine/scripts/build-web.mjs --target native',",
      "  env: { MODOKI_NATIVE_PLATFORM: 'ios' }, cwd }, { cmd: 'other', env: { MODOKI_NATIVE_PLATFORM: 'android' } }] as const;",
      "run({ env: { ...buildEnv, MODOKI_ICONS_HANDLED: '1', MODOKI_NATIVE_PLATFORM: platform ?? '' } });",
      "run({ env: {\n  ...buildEnv,\n  MODOKI_ICONS_HANDLED: '1',\n} });",
      "run({ env: { MODOKI_ICONS_HANDLED: '1', MODOKI_NATIVE_PLATFORM: 'ios' } });",
      "run({ env: { ...buildEnv, MODOKI_ICONS_HANDLED: '1', MODOKI_NATIVE_PLATFORM: 'ios' } });",
      "renderKeystoreProperties(k); x.healNativeConfig(); const heal2 = await healNativeProject(r); renderExportOptionsPlist(o); renderKeystoreProperties(k);",
      'async function build() { if (!heal.ok) {',
      "  if (heal.reason === 'x') { sendStatus(`FAILED:npm install (${heal.why})`); } else { sendStatus('FAILED:stale node_modules'); }",
      '  res.end();',
      '',
      '  return;',
      '} }',
    ].join('\n'), 'probe.ts');
    expect(planBuildWebPlatforms(sf, 'iosPrefixSteps')).toEqual(['ios']);
    expect(scaffoldRunnerEnvs(sf)).toEqual([{ namesPlatform: true }, { namesPlatform: false }, { namesPlatform: false }]);
    expect(healStepCalls(sf)).toEqual(['healNativeConfig']);
    expect(releaseWritesAroundHeal(sf, callsTo(sf, 'healNativeProject')[0]!)).toEqual({
      renderKeystoreProperties: { before: 1, after: 1 }, renderExportOptionsPlist: { before: 0, after: 1 },
    });
    expect(refusalBlock(sf)).toEqual({ statuses: ['FAILED:npm install (', 'FAILED:stale node_modules'], endsWith: ['res.end()', 'return'], buildCalls: [] });
    const fallsThrough = probe("if (!heal.ok) { sendStatus('FAILED:x'); res.end(); }\nif (!heal.ok) {}", 'probe.ts');
    expect(() => refusalBlock(fallsThrough)).toThrow(/one `if \(!heal.ok\)`/);
    // An install port must return the shell's result — not call it and return something else.
    const ports = probe([
      "heal(r, { install: (why) => runScaffoldShell(`npm install (${why})`, 'npm install', r) });",
      "heal(r, { install: async (why) => { runScaffoldShell('x'); return true; } });",
      "heal(r, { install: async (why) => { const ok = await runScaffoldShell('x'); log(() => { return f(); }); return await runScaffoldShell('y'); } });",
    ].join('\n'), 'probe.ts');
    expect(callsTo(ports, 'heal').map((c) => portReturns(c.arguments[1], 'install'))).toEqual([['runScaffoldShell'], ['<true>'], ['runScaffoldShell']]);
    expect(refusalBlock(probe("if (!heal.ok) { res.end(); runScaffoldShell('x'); }", 'probe.ts')))
      .toEqual({ statuses: [], endsWith: ['res.end()', "runScaffoldShell('x')"], buildCalls: ['runScaffoldShell'] });
  });
});

/** #827's census: `engine/scripts/**.mjs` reaches TypeScript through the ONE seam, never a
 *  private copy of it.
 *
 *  This is the recurrence half of that issue, and it is the half with actual evidence behind it.
 *  Two scripts each carried their own bundle-to-temp-and-import — `add-native-targets.mjs` and
 *  `print-toolchain-env.mjs` — and the former's own comment said *"Same approach as
 *  print-toolchain-env.mjs"*, citing the other copy in prose instead of importing it. Nothing was
 *  wrong with either copy; the cost is that a fix to the seam (#714's `…Result` discriminant, the
 *  per-clone temp-file naming) reached one of three implementations.
 *
 *  ⚠️ Wiring, not behaviour. A source census proves a script IMPORTS the seam; it cannot prove the
 *  seam is reached on the path that matters, and `cliBuildClaims.test.ts`'s note above its "build-web.mjs inherits an ancestor claim" block records the scar
 *  where exactly that census stayed green through a deadlock. The behavioural cover is the
 *  no-esbuild subprocess case below, plus running the two scripts by hand.
 *
 *  ⚠️ Scoped to `engine/scripts/**` and that scope is a CLAIM, so here is its limit. The #827
 *  close-out sweep found ONE more instance of this exact shape repo-wide —
 *  `games/wordweave/tools/run.mjs` (bundle to temp, `import(pathToFileURL(...))`, run) — and it is
 *  deliberately NOT in scope: `CLAUDE.md` requires a game to be self-contained, so reaching
 *  `engine/scripts/loadVendorPlugins.mjs` from `games/**` is a portability violation
 *  `gamePortability.test.ts` fails on. The seam is unreachable from a game BY DESIGN, so that copy
 *  is a legitimate second implementation rather than a member of this class. No other instance
 *  exists: `git ls-files | xargs grep -l pathToFileURL` cross-checked against files mentioning
 *  esbuild/outfile returns only the seam itself, the two scripts folded here, the tests, that
 *  wordweave runner, and two non-loaders (`native-dynamic-import.ts`, `stage-vite-config.cjs`).
 *
 *  The allowlist is a CLAIM too, so each entry states why it is not a loader rather than just
 *  naming a file. */
/** The seam itself — structural, not a pardon: `loadVendorPlugins.mjs` IS the one
 *  bundle-to-temp-and-import in the repo, so its specifier is the thing every other script routes
 *  through. Still staleness-checked, which is also what proves the detector is alive. */
const SEAM_SPECIFIERS: readonly string[] = ['engine/scripts/loadVendorPlugins.mjs::esbuild'];

/** Keyed `file::specifier` and counted (#1128) — one row per esbuild specifier a script may name,
 *  measured at ONE each on 2026-09-13. */
const DIRECT_ESBUILD_ALLOWED: ReadonlyArray<{ item: string; count?: number; reason: string }> = [
  {
    item: 'engine/scripts/build-electron.mjs::esbuild',
    reason: 'Not a loader: it esbuild-BUNDLES Electron main + the MCP entry to shippable `outfile`s. It '
      + 'never imports what it builds, so there is nothing here to route through the seam.',
  },
  {
    item: 'engine/scripts/stage-vite-config.cjs::esbuild',
    reason: 'Not a loader, same category as build-electron.mjs: it esbuild-BUNDLES engine/vite.config.ts to '
      + 'a persistent, shipped engine/vite.config.cjs for the packaged editor (#326). It never '
      + 'imports what it builds.',
  },
  {
    item: 'engine/scripts/migrate-meta-sidecars.mjs::esbuild',
    reason: 'IS a third copy of the mechanism, not merely a third shape — its `execFileSync("npx", '
      + '["esbuild", …])` writes a temp `outFile` which it then `await import(pathToFileURL(outFile))`s: '
      + 'the same bundle-to-temp-and-import, driven through a subprocess. (Cited by SYMBOL, not line '
      + 'number — this branch ruled in a8fb0dfca that a line number rots silently, and docCitations '
      + 'only enforces that under docs/.) Left out of #827 DELIBERATELY (a '
      + 'one-off migration with no preamble and no build claim), which is a scope call, not an '
      + 'absolution: this entry exists so the next sweep reads "deferred", never "not an instance".',
  },
];

describe('no engine/scripts/*.mjs rolls its own esbuild module loader (#827)', () => {
  // Enumerated through git, not a filesystem walk — an untracked stray must not silently widen or
  // narrow the corpus. MEASURED at 89 files today (not the "~30" an earlier version of this comment
  // guessed — it was wrong by ~3x, and a floor set from a guess is not a floor). The corpus spans
  // three directories: `engine/scripts`, `engine/scripts/lib`, `engine/scripts/ota`.
  const scripts = repoFiles({
    under: path.join(repoRoot, 'engine', 'scripts'),
    // `.cjs` too: `engine/scripts/` is not uniformly `.mjs`, and a census that matched only one
    // extension would let a private loader written as `.cjs` evade it entirely. Found by the #827
    // close-out sweep — `stage-vite-config.cjs` sits in this directory and this guard could not see
    // it. `A test file the globs do not match is silent` applies to the SUBJECT corpus too.
    match: /\.(mjs|cjs)$/,
    exclude: ['node_modules'],
    floor: 70,
  });

  it('the corpus is real and includes the two scripts #827 folded', () => {
    // Guards the guard: a filter that silently empties proves nothing about anything.
    const rels = scripts.map((f) => f.rel);
    expect(rels).toContain('engine/scripts/add-native-targets.mjs');
    expect(rels).toContain('engine/scripts/print-toolchain-env.mjs');
    // …and that the corpus reaches BELOW the top level, because the two names above are both at
    // the top: a narrowing that dropped the subdirectories would keep them and clear the floor.
    //
    // ⚠️ MEASURED: that is 8 files (`lib/` 1, `ota/` 7), not the "20-odd" an earlier version of
    // this very comment claimed — which was a guess, in the paragraph whose subject is that a
    // guessed number is not a measurement. 8 is still worth pinning; 20-odd would have had the
    // next reader weighting this check at 2.5x its real cover.
    //
    // Asserted as "some file is nested", not "lib/ exists": `lib/` holds exactly one matching file
    // today, so pinning it by name turns this guard red on an ordinary rename for a reason that
    // has nothing to do with census narrowing. `ota/` is pinned by name because 7 files make it a
    // real cohort rather than a coincidence.
    expect(rels.some((r) => r.split('/').length > 3), 'the corpus no longer reaches below the top level').toBe(true);
    expect(rels.some((r) => r.startsWith('engine/scripts/ota/')), 'ota/ fell out of the corpus').toBe(true);
    // The `.cjs` half of the match is load-bearing (#827 close-out) — pin that it still matches.
    expect(rels.some((r) => r.endsWith('.cjs')), 'the .cjs half of the match stopped matching').toBe(true);
  });

  it('no script names esbuild in code beyond what its allowlist row pays for — counted per specifier (#1128)', () => {
    // ⚠️ Matches the SPECIFIER, not an import STATEMENT, and that is the whole point. The first
    // version of this assertion was
    //     /(?:import|require)\s*\(?\s*\{?[^}\n]*\}?\s*(?:from\s*)?['"]esbuild['"]/
    // whose `[^}\n]*` cannot cross a newline — so `import {\n  build,\n} from 'esbuild';` evaded
    // it completely, and a private loader came back through nothing more exotic than a formatter
    // wrapping one line. Confirmed by planting exactly that: 124 tests passed.
    //
    // A bare specifier match covers far more: the multi-line import, `require`, a dynamic
    // `import('esbuild')`, a backtick specifier, a subpath (`esbuild/lib/main.js`), the
    // `execFileSync('npx', ['esbuild', …])` shell form, and `esbuild-wasm`. It is blunt on purpose
    // — `readScannedSource` returns `.code` with comments STRIPPED, so prose cannot trip it, and a
    // script with a real reason to name esbuild in CODE belongs on the allowlist above, with that
    // reason written down.
    //
    // ⚠️ It is NOT airtight, and an earlier version of this comment claimed it was ("no such
    // seam") — the exact over-claim this repo keeps re-shipping. `import('es' + 'build')` and any
    // variable-held specifier still evade, and no regex closes that. This is a tripwire against
    // the shape that actually recurred twice (a plain import someone reached for because the seam
    // degraded), not a proof of absence.
    //
    // ⚠️ **Counted per SPECIFIER, and the staleness check uses THIS detector (#1128).** The allowlist
    // used to skip a file whole (`.has(rel)`), so a second esbuild specifier added to
    // `build-electron.mjs` — whose reason is "never imports what it builds" — was green; now it is
    // an unexcused occurrence. ⚠️ What the count still CANNOT see: a private loader built on the
    // file's EXISTING `import esbuild from 'esbuild'` (`await esbuild.build({ outfile }); return
    // import(url)`) adds no new specifier, and stays green — confirmed by review. That is the
    // tripwire limit stated above, not something a count closes. And its staleness check matched
    // a bare `/esbuild/`, LOOSER than the ban: a file that lost its real import but kept the word in
    // a string stayed "still uses esbuild". The ledger's over-blessed arm now runs on the same
    // population as the ban, so the two cannot disagree.
    const SPECIFIER = /['"`]esbuild(?:-wasm)?(?:\/[^'"`]*)?['"`]/g;
    const uses: Array<{ item: string; site: string }> = [];
    for (const { rel } of scripts) {
      readScannedSource(path.join(repoRoot, rel)).code.split('\n').forEach((line, i) => {
        for (const m of line.matchAll(SPECIFIER)) {
          const spec = m[0].slice(1, -1);
          uses.push({ item: `${rel}::${spec}`, site: `${rel}:${i + 1} — ${spec}` });
        }
      });
    }
    assertExemptionLedger({
      label: 'DIRECT_ESBUILD_ALLOWED in cliNativeBuildHeals',
      population: uses,
      exempt: DIRECT_ESBUILD_ALLOWED,
      sanctioned: SEAM_SPECIFIERS,
      // Liveness is the seam's own specifier (`sanctioned` is staleness-checked); an exact floor
      // would report every legitimate removal as a dead detector.
      floor: 1,
      fix: 'Load engine TypeScript through loadVendorPlugins.mjs (loadEnginePluginModuleResult, or '
        + 'loadRequiredEngineModules when the caller cannot degrade) — a private copy is #827. A '
        + 'genuine non-loader use goes on the allowlist above, with its reason.',
    });
  });
});

describe('loadRequiredEngineModules THROWS instead of degrading (#827)', () => {
  /** The opposite disposition to the describe below, and it needs its own cover for a specific
   *  reason: the census above is a SOURCE census, so it proves the two CLI scripts *call* this
   *  function and can say nothing about what the function does. Every mutation to the throw
   *  survived the whole suite before these tests existed — deleting the `if (!module) throw` put
   *  the callers straight back to the `Cannot destructure property 'detect' of 'undefined'` deref
   *  the function was written to replace, and the suite stayed green.
   *
   *  `engine/tests` as the repo root is the same `emptyRepo` trick the degrade tests below use: it
   *  contains no `plugins/*.ts`, so the load hits `no-source` without any fixture setup. */
  const emptyRepo = path.join(repoRoot, 'engine', 'tests');
  const rel = path.join('plugins', 'healNativeConfig.ts');

  it('throws rather than returning a null the caller would deref', async () => {
    const { loadRequiredEngineModules } = await import('../../scripts/loadVendorPlugins.mjs');
    await expect(loadRequiredEngineModules(emptyRepo, [rel], 'a-caller.mjs')).rejects.toThrow();
  });

  it('names the caller and the CORRECT reason — the two are not interchangeable', async () => {
    const { loadRequiredEngineModules } = await import('../../scripts/loadVendorPlugins.mjs');
    // ⚠️ The `no-source` and `no-esbuild` branches produce different remedies, and swapping them
    // survives every other assertion in this file while re-shipping exactly #714's confusion (a
    // packaged editor told to check out sources it already has). So this pins WHICH branch fired,
    // not merely that the message is non-empty.
    await expect(loadRequiredEngineModules(emptyRepo, [rel], 'a-caller.mjs'))
      .rejects.toThrow(/a-caller\.mjs cannot run/);
    await expect(loadRequiredEngineModules(emptyRepo, [rel], 'a-caller.mjs'))
      .rejects.toThrow(/is not on disk/);
    // …and specifically NOT the other branch's remedy.
    await expect(loadRequiredEngineModules(emptyRepo, [rel], 'a-caller.mjs'))
      .rejects.not.toThrow(/esbuild could not be imported/);
  });

  it('stops at the FIRST unloadable entry rather than reporting the last', async () => {
    const { loadRequiredEngineModules } = await import('../../scripts/loadVendorPlugins.mjs');
    // Order matters for the message: a caller loading three modules must be told which one is
    // missing. A loop that overwrote the reason, or gathered then reported, would name the wrong
    // file — and `add-native-targets.mjs` loads two.
    await expect(loadRequiredEngineModules(
      emptyRepo,
      [path.join('plugins', 'aaa-first.ts'), path.join('plugins', 'zzz-second.ts')],
      'a-caller.mjs',
    )).rejects.toThrow(/aaa-first\.ts/);
  });

  it('normalises a back-slashed entry path in the message (the win clone)', async () => {
    const { loadRequiredEngineModules } = await import('../../scripts/loadVendorPlugins.mjs');
    // Both callers build the entry with `path.join`, so on Windows it arrives back-slashed and an
    // un-normalised message reads `engine/plugins\addNativeTarget.ts` — half one separator, half
    // the other.
    //
    // ⚠️ This test is the REASON the implementation splits on a separator CLASS rather than
    // `path.sep`. `path.sep` is `/` on POSIX, so the `path.sep` version was an identity here: it
    // could not be exercised or falsified from a Mac, and `docs/windows.md` is explicit that the
    // local gate cannot see Windows — so it would have shipped unverified. Splitting on either
    // separator fixes the same message and makes the back-slashed input drivable from any box.
    await expect(loadRequiredEngineModules(emptyRepo, ['plugins\\nope.ts'], 'a-caller.mjs'))
      .rejects.toThrow(/engine\/plugins\/nope\.ts/);
    await expect(loadRequiredEngineModules(emptyRepo, ['plugins\\nope.ts'], 'a-caller.mjs'))
      .rejects.not.toThrow(/\\/);
  });

  it('returns the namespaces UNMERGED and in the requested order, when they DO load', () => {
    // ⚠️ In a PLAIN `node` subprocess, not inline — the precedent set by the very next describe
    // ('loadEnginePluginModule degrades instead of throwing'), for its reason plus one more. Under vitest, `import('esbuild')`
    // inside the seam FAILS, so an inline version of this test does not exercise the success path
    // at all: it takes the `no-esbuild` branch and throws. (Measured while writing it — the inline
    // form failed with "esbuild could not be imported", which is the branch the tests above
    // already cover.) A subprocess runs the real loader against the real engine sources.
    //
    // The array contract is what `add-native-targets.mjs` destructures POSITIONALLY, so an
    // implementation that merged, or reversed the order, would bind the wrong module to the wrong
    // name at that call site while every source-level assertion stayed green.
    const dir = makeScratchDir('modoki-required-modules-');
    try {
      const seam = path.join(repoRoot, 'engine', 'scripts', 'loadVendorPlugins.mjs');
      const runner = path.join(dir, 'runner.mjs');
      fs.writeFileSync(runner, `
        import { loadRequiredEngineModules } from ${JSON.stringify(pathToFileURL(seam).href)};
        import path from 'node:path';
        const mods = await loadRequiredEngineModules(
          ${JSON.stringify(repoRoot)},
          [path.join('plugins', 'addNativeTarget.ts'), path.join('plugins', 'load-project-config.ts')],
          'a-caller.mjs',
        );
        console.log(JSON.stringify({
          isArray: Array.isArray(mods),
          length: mods.length,
          firstHasScaffold: 'scaffoldNativeTarget' in mods[0],
          secondHasUnionErrors: 'projectConfigUnionErrors' in mods[1],
          firstLeakedSecond: 'projectConfigUnionErrors' in mods[0],
        }));
      `);
      const out = JSON.parse(execFileSync(process.execPath, [runner], { encoding: 'utf8', cwd: repoRoot }));
      expect(out.isArray).toBe(true);
      expect(out.length).toBe(2);
      expect(out.firstHasScaffold).toBe(true);
      expect(out.secondHasUnionErrors).toBe(true);
      // Unmerged: entry 0 must NOT carry entry 1's exports.
      expect(out.firstLeakedSecond).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('loadEnginePluginModule degrades instead of throwing', () => {
  it('returns null when there is no source file to load (the packaged editor)', async () => {
    const { loadEnginePluginModule, loadVendorPlugins } = await import('../../scripts/loadVendorPlugins.mjs');
    // An empty dir has no engine/plugins/*.ts — the packaged editor's situation, where `main.ts`
    // has already healed/vendored on project open and a build must not die for it.
    const emptyRepo = path.join(repoRoot, 'engine', 'tests');
    expect(await loadEnginePluginModule(emptyRepo, path.join('plugins', 'healNativeConfig.ts'))).toBeNull();
    expect(await loadVendorPlugins(emptyRepo)).toBeNull();
  });

  it('loadEnginePluginModuleResult reports WHY (#714) while the old null-returning wrapper is unchanged', async () => {
    const { loadEnginePluginModule, loadEnginePluginModuleResult } = await import('../../scripts/loadVendorPlugins.mjs');
    const emptyRepo = path.join(repoRoot, 'engine', 'tests');
    const rel = path.join('plugins', 'healNativeConfig.ts');

    const result = await loadEnginePluginModuleResult(emptyRepo, rel);
    expect(result).toEqual({ module: null, reason: 'no-source' });

    // Same input through the old contract must still yield a bare null — proving
    // loadEnginePluginModule is a thin wrapper, not a second implementation that could drift.
    expect(await loadEnginePluginModule(emptyRepo, rel)).toBeNull();
  });

  it('returns no-esbuild when the entry .ts exists but esbuild cannot be imported (the packaged-editor case)', () => {
    // The `no-esbuild` branch is only reachable when the entry file DOES exist (the no-source
    // check above returns first otherwise) and `import('esbuild')` genuinely fails — the
    // packaged-editor case (#714): esbuild is a devDependency, pruned by electron-builder, while
    // the plugin source ships. Faking that hermetically without touching this repo's real
    // node_modules: copy loadVendorPlugins.mjs's OWN source into a scratch dir under the OS temp
    // root, then run it in a PLAIN `node` subprocess (not through vitest/vite-node, whose SSR
    // dynamic-import is resolved through Vite's own module graph and refuses a file outside
    // `server.fs.allow` even past `@vite-ignore`). Node resolves a bare `import('esbuild')` by
    // walking up node_modules directories from the IMPORTING module's own location, not from the
    // `repoRoot` argument passed in — so the copy, sitting outside this repo's ancestry, hits no
    // node_modules/esbuild at all and the import genuinely throws, with the real function running
    // unmodified.
    const importerDir = makeScratchDir('modoki-no-esbuild-');
    const fakeRepo = makeScratchDir('modoki-fake-repo-');
    try {
      const importerPath = path.join(importerDir, 'loadVendorPlugins.mjs');
      fs.copyFileSync(path.join(repoRoot, 'engine', 'scripts', 'loadVendorPlugins.mjs'), importerPath);

      const rel = path.join('plugins', 'fakePlugin.ts');
      fs.mkdirSync(path.join(fakeRepo, 'engine', 'plugins'), { recursive: true });
      fs.writeFileSync(path.join(fakeRepo, 'engine', rel), 'export const x = 1;\n');

      const runnerPath = path.join(importerDir, 'runner.mjs');
      fs.writeFileSync(runnerPath, `
        import { loadEnginePluginModule, loadEnginePluginModuleResult } from ${JSON.stringify(pathToFileURL(importerPath).href)};
        const repo = ${JSON.stringify(fakeRepo)};
        const rel = ${JSON.stringify(rel)};
        const result = await loadEnginePluginModuleResult(repo, rel);
        const bare = await loadEnginePluginModule(repo, rel);
        console.log(JSON.stringify({ result, bare }));
      `);

      const output = execFileSync(process.execPath, [runnerPath], { encoding: 'utf8', cwd: importerDir });
      const { result, bare } = JSON.parse(output);

      expect(result).toEqual({ module: null, reason: 'no-esbuild' });
      // Same input through the old contract must still yield a bare null.
      expect(bare).toBeNull();
    } finally {
      fs.rmSync(importerDir, { recursive: true, force: true });
      fs.rmSync(fakeRepo, { recursive: true, force: true });
    }
  });
});

/** The THIRD human-facing #685 remedy — the one `npm test` itself prints when lockfile integrity
 *  drifts — lives in vendoredPluginFreshness.test.ts's own failure message. The other two are
 *  guarded above; without this it is the one place a future author can put the footgun back and
 *  have nothing go red. Same rule, same reason: `npm install --package-lock-only` CREATES the
 *  state (#685, measured 2026-09-05), so its ONLY permitted mention is the warning not to run it. */
describe('the lockfile-integrity guard prints the SAFE remedy too', () => {
  const src = readScannedSource(
    path.join(repoRoot, 'engine', 'tests', 'architecture', 'vendoredPluginFreshness.test.ts'),
  ).code;

  it('never offers --package-lock-only as a remedy step', () => {
    const msgIdx = src.indexOf('Lockfile integrity does not match');
    expect(msgIdx).toBeGreaterThan(-1);
    const chunk = src.slice(msgIdx, src.indexOf('.toEqual([])', msgIdx));
    expect(chunk).toMatch(/package-lock\.json/);
    expect(chunk).toMatch(/npm install/);
    const ploCount = (chunk.match(/--package-lock-only/g) ?? []).length;
    expect(ploCount, 'the only permitted mention of --package-lock-only is the "Do NOT reach for" warning — it must never appear as a remedy STEP (#685: it CAUSES this state)').toBe(1);
    expect(chunk).toMatch(/Do NOT reach for[^\n]*--package-lock-only/);

    // ⚠️ The CONDITIONAL third step must survive. Measured (#685 close-out, npm 11.12.1/node v26):
    // on a PLO-poisoned tree — the state the SUPERSEDED remedy left behind — "delete the entry +
    // plain npm install" returns `up to date` and never re-extracts; only removing the package dir
    // repairs it. Dropping step 3 therefore strands exactly the reader who followed the old advice,
    // and every other assertion here would still pass.
    expect(chunk, 'the remedy must keep its conditional rm -rf third step — the only thing that repairs a PLO-poisoned tree (#685)')
      .toMatch(/rm -rf node_modules/);
    expect(chunk, 'step 3 must stay CONDITIONAL — an unconditional rm -rf is not the documented remedy')
      .toMatch(/ONLY if/);
  });
});
