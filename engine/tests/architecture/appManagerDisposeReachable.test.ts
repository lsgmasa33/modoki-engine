/**
 * Every app-scoped `ManagerDef` that declares a `dispose` has a real production caller for it (#517).
 *
 * `managerRegistry.deactivate()` — the only thing that runs `def.dispose?.()` — is reached from
 * `unregisterManager(name)` (or `unregisterManagers([...])`, its plural form) or from re-registering
 * the same name. An app-scoped manager (`scope: 'app'`) is activated once at register and, unlike a
 * scene-/game-scoped one, has NO other trigger that tears it down. So a `dispose` on an app-scoped
 * `ManagerDef` is dead code unless something in production actually calls
 * `unregisterManager('<name>')` — otherwise the disposer *looks* wired (it reads like a real
 * teardown) while nothing ever reaches it, exactly the `inputSourcesManager` defect filed in #517.
 *
 * This guard enumerates every `ManagerDef` object literal / class declaration in the runtime with
 * `scope: 'app'` and a `dispose`, directly from source, and requires each one to be either wired to
 * a real `unregisterManager('<name>')` call in production, or named in an explicit allowlist below
 * with a verified reason. Same discipline as this file's sibling, `invalidatorsAreReachable.test.ts`.
 *
 * ⚠️ **This guard has been wrong twice in the same direction** — it enumerated one declaration form,
 * missed another (the object-literal-only scan was blind to `class X implements ManagerDef`), and
 * was widened. A third missed form (a sub-interface `extends ManagerDef`, `implements ManagerDef, Y`,
 * a generic class, `satisfies`/`as ManagerDef`, a factory, a `const arr: ManagerDef[]`, …) would ship
 * the same way — silently, because a scanner that doesn't recognize a form doesn't know it missed
 * anything. Rather than chase every syntactic form the two scanners might miss, the CENSUS test
 * below is a structural backstop: it finds every `ManagerDef` type reference in the scanned tree
 * and requires each one to be accounted for by a scanner hit or a verified, named allowlist entry —
 * so an unrecognized form fails LOUD instead of silently passing.
 *
 * Every reader here takes its unit from the parser (#1241): a declaration's own members, a class's
 * heritage, a call's arguments. The fixtures below call those readers directly.
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';
import {
  accessPath, calleeName, callsTo, enclosingFunction, findNodes, lineOf, parseSource, propertyValue, siteText, stringValueOf,
  unwrapValue, ts,
} from '@modoki/engine/testing/sourceAst';
import { assertExemptionLedger } from '@modoki/engine/testing/exemptionLedger';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

const REPO = path.resolve(__dirname, '../../..');
const RUNTIME_DIR = path.join(REPO, 'engine/packages/modoki/src/runtime');

/** All .ts/.tsx files under RUNTIME_DIR, git-enumerated (#771/#799) rather than a hand-rolled
 *  recursive walk, excluding test files. `.tsx` matters: there are 10+ runtime `.tsx` files (UI
 *  components etc.), and a `ManagerDef` declared in one of them used to be invisible to this scan
 *  entirely. */
function listRuntimeFiles(dir: string): string[] {
  return repoFiles({
    under: dir,
    match: (rel) => /\.tsx?$/.test(rel) && !rel.includes('.test.'),
    floor: 0,
  }).map(({ abs }) => abs);
}

interface AppManagerWithDispose {
  name: string;
  file: string;
  /** Local identifier(s) this manager instance is bound to, e.g. `timeManager` for
   *  `export const timeManager: TimeManager = new TimeManagerImpl()`, or the object-literal's own
   *  binding identifier (`inputSourcesManager`). Used to recognize the `unregisterManager(x.name)`
   *  idiom without matching an unrelated manager's `.name` call — see `hasProductionUnregisterCaller`. */
  idents: string[];
  /** Which scanner found this — gates whether `idents` is trusted for the var-form
   *  `unregisterManager(<ident>.name)` match. See `hasProductionUnregisterCaller`. */
  kind: 'object-literal' | 'class';
}

/** `n` is a reference to the `ManagerDef` TYPE — a type reference (`: ManagerDef`, `ManagerDef[]`,
 *  `Array<ManagerDef>`, `as`/`satisfies ManagerDef`, a generic constraint) or a heritage entry
 *  (`implements ManagerDef`, `extends ManagerDef`). An import or export specifier is not a use. */
function isManagerDefRef(n: ts.Node): n is ts.TypeReferenceNode | ts.ExpressionWithTypeArguments {
  if (ts.isTypeReferenceNode(n)) return ts.isIdentifier(n.typeName) && n.typeName.text === 'ManagerDef';
  return ts.isExpressionWithTypeArguments(n) && ts.isIdentifier(n.expression) && n.expression.text === 'ManagerDef';
}

/**
 * Every `<ident>: ManagerDef = { … }` object-literal declaration in `sf`, regardless of scope or
 * dispose — used both to build the dispose-reachability list (filtered further by the caller) and
 * by the CENSUS test to know which `ManagerDef` references are legitimately accounted for. `ref` is
 * the one reference the declaration owns: its annotation.
 *
 * ⚠️ **The literal is the initializer NODE (#1241).** The text scan matched `\w+\s*:\s*ManagerDef
 * \s*=\s*\{` and brace-balanced from there with a quote tracker that could not follow a `${…}`
 * back into code, so a template literal in a manager body could move the body's end.
 */
function scanObjectLiteralDecls(sf: ts.SourceFile): Array<{ ident: string; literal: ts.ObjectLiteralExpression; ref: ts.Node }> {
  return findNodes(sf, ts.isVariableDeclaration).flatMap((d) => {
    const init = d.initializer && unwrapValue(d.initializer);
    if (!ts.isIdentifier(d.name) || !d.type || !isManagerDefRef(d.type) || !init || !ts.isObjectLiteralExpression(init)) return [];
    return [{ ident: d.name.text, literal: init, ref: d.type }];
  });
}

/** Every `class <Ident> implements ManagerDef` declaration in `sf` — `implements ManagerDef, Y`
 *  and a generic class included, which the `class\s+(\w+)\s+implements\s+ManagerDef\s*\{`
 *  text could not see — regardless of scope or dispose. `ref` is its heritage entry. */
function scanClassDecls(sf: ts.SourceFile): Array<{ cls: ts.ClassDeclaration & { name: ts.Identifier }; ref: ts.Node }> {
  return findNodes(sf, ts.isClassDeclaration).flatMap((cls) => {
    const ref = cls.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ImplementsKeyword)?.types.find(isManagerDefRef);
    return cls.name && ref ? [{ cls: cls as ts.ClassDeclaration & { name: ts.Identifier }, ref }] : [];
  });
}

/** A class's OWN member called `name` — a field (`dispose = () => …`), a method, an accessor. */
function classMember(cls: ts.ClassDeclaration, name: string): ts.ClassElement | undefined {
  return cls.members.find((m) => m.name !== undefined && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name)) && m.name.text === name);
}

/** The string a class FIELD is initialised to (`scope = 'app' as const`), or `undefined`. */
function classFieldString(cls: ts.ClassDeclaration, name: string): string | undefined {
  const m = classMember(cls, name);
  return m && ts.isPropertyDeclaration(m) ? stringValueOf(m.initializer) : undefined;
}

/** Every `ManagerDef` object literal (`<ident>: ManagerDef = {`) that declares BOTH `scope: 'app'`
 *  and a `dispose`, with the manager's `name`, its binding identifier, and the file it's defined
 *  in. Each is read off the literal's OWN members: the text test found `scope: 'app'` and
 *  `dispose(` anywhere in the braces, a nested literal's included. */
function findObjectLiteralManagers(sf: ts.SourceFile, file: string): AppManagerWithDispose[] {
  const out: AppManagerWithDispose[] = [];
  for (const { ident, literal } of scanObjectLiteralDecls(sf)) {
    if (stringValueOf(propertyValue(literal, 'scope') as ts.Expression | undefined) !== 'app') continue;
    if (!propertyValue(literal, 'dispose')) continue;
    const name = stringValueOf(propertyValue(literal, 'name') as ts.Expression | undefined);
    if (name === undefined) {
      throw new Error(
        `Found an app-scoped ManagerDef with a dispose in ${file} but its \`name\` is not a string ` +
          'literal — the scan needs updating, not the allowlist.',
      );
    }
    // Object-literal bindings are commonly a generic local name (`const manager: ManagerDef = {`,
    // used identically by three separate runtime factories) — trusting it for the var-form
    // `unregisterManager(<ident>.name)` match would let ANY file's unrelated `unregisterManager
    // (manager.name)` "prove" this one is wired. `kind: 'object-literal'` tells
    // `hasProductionUnregisterCaller` to drop the ident form and require the exact string-literal
    // name instead (#517 follow-up — reviewer-verified).
    out.push({ name, file, idents: [ident], kind: 'object-literal' });
  }
  return out;
}

/** Every `class <Ident> implements ManagerDef { ... }` that declares BOTH `scope = 'app'`
 *  (optionally `as const`) and a `dispose` member, with the manager's `name`, the identifier(s)
 *  any `new <Ident>()` instance is bound to, and the file it's defined in. This is the OTHER
 *  declaration form in the repo — `TimeManagerImpl` / `NavigationManagerImpl` use it, and the
 *  object-literal-only scan above is blind to it (#517 follow-up: the guard itself had the same
 *  "looks wired, isn't reached" shape as the bug it polices). */
function findClassManagers(sf: ts.SourceFile, file: string): AppManagerWithDispose[] {
  const out: AppManagerWithDispose[] = [];
  for (const { cls } of scanClassDecls(sf)) {
    // Either quote style is a string literal, so the #534 quote hole cannot recur.
    if (classFieldString(cls, 'scope') !== 'app') continue;
    // ⚠️ A method OR a CLASS-FIELD ARROW (`dispose = () => { ... }`) is a real ManagerDef dispose
    // (#534, recorded during #517's close-out). And the census does NOT backstop this: the census
    // counts `ManagerDef` TYPE references, and such a class still writes `implements ManagerDef`, so
    // `scanClassDecls` finds it, the census counts it as accounted, and only this predicate decides
    // whether it is ever checked for reachability. A member-shape gap is invisible to a
    // declaration-form census.
    if (!classMember(cls, 'dispose')) continue;
    const name = classFieldString(cls, 'name');
    if (name === undefined) {
      throw new Error(
        `Found an app-scoped class ManagerDef (${cls.name.text}) with a dispose in ${file} but its ` +
          '`name` field is not a string literal — the scan needs updating, not the allowlist.',
      );
    }
    // The singleton this class is instantiated as — e.g. `export const timeManager: TimeManager =
    // new TimeManagerImpl();` binds identifier `timeManager` to `class TimeManagerImpl`. Class-bound
    // idents are specific to this manager (derived from a `new <ClassName>()` call), unlike the
    // generic object-literal binding name above, so the var-form match stays trusted here.
    const idents = findNodes(sf, ts.isVariableDeclaration).flatMap((d) => {
      // Anywhere in the initializer — `wrap(new Impl())`, `hot?.data.tm ?? new Impl()` — as the text
      // `[^;]*new Impl(` did; binding only a bare `new` would report a wired manager unreachable.
      // …but not inside a nested function: `const setup = () => new Impl()` binds a factory, not the instance.
      const makes = !!d.initializer && findNodes(d.initializer, ts.isNewExpression)
        .some((n) => ts.isIdentifier(n.expression) && n.expression.text === cls.name.text
          && enclosingFunction(n) === enclosingFunction(d));
      return ts.isIdentifier(d.name) && makes ? [d.name.text] : [];
    });
    out.push({ name, file, idents, kind: 'class' });
  }
  return out;
}

function parsedRuntime(file: string): { rel: string; sf: ts.SourceFile } {
  const rel = path.relative(REPO, file).split(path.sep).join('/');
  return { rel, sf: parseSource(readScannedSource(file).code, rel) };
}

/** Every app-scoped `ManagerDef` with a `dispose`, from EITHER declaration form the repo uses
 *  (`x: ManagerDef = { ... }` object literals, or `class X implements ManagerDef { ... }`), with
 *  the manager's `name` and the file it's defined in. Comments are blanked first, so a `scope:
 *  'app'`/`dispose` mentioned only in prose cannot parse as a member. */
function findAppScopedManagersWithDispose(): AppManagerWithDispose[] {
  const out: AppManagerWithDispose[] = [];
  for (const file of listRuntimeFiles(RUNTIME_DIR)) {
    const { rel, sf } = parsedRuntime(file);
    out.push(...findObjectLiteralManagers(sf, rel));
    out.push(...findClassManagers(sf, rel));
  }
  return out;
}

/** What one `unregisterManager(…)` / `unregisterManagers([…])` call names: each string literal, and
 *  each `<ident>.name` read, as `'<ident>.name'`. Anything else names nothing this can match. */
function unregisterTargets(call: ts.CallExpression): string[] {
  const first = call.arguments[0] && unwrapValue(call.arguments[0]);
  if (!first) return [];
  const args = calleeName(call) === 'unregisterManagers' && ts.isArrayLiteralExpression(first) ? [...first.elements] : [first];
  return args.flatMap((a) => {
    const str = stringValueOf(a);
    if (str !== undefined) return [`'${str}'`];
    const p = ts.isExpression(a) ? accessPath(a) : undefined;
    return p && /^[\w$]+\.name$/.test(p) ? [p] : [];
  });
}

let productionUnregisterTargets: Set<string> | undefined;

/**
 * Every target any production (non-test) source unregisters, read once: `'<name>'` for a string
 * literal, `<ident>.name` for the variable idiom. Same scope as the issue's own audit: engine
 * app/game code, excluding tests. `floor: 0` deliberately — a checkout shipping no games/demos (the
 * public OSS snapshot) must still scan `engine/` alone rather than fail COLLECTION; the guard's
 * OTHER sanity test (`found a plausible number of app-scoped managers with dispose`) backstops it.
 *
 * ⚠️ **Read as CALLS (#1241).** The text version was one regex per manager over every file, with a
 * `[^\]]{0,500}` window standing in for "an element of the plural call's array" — any `'name'`
 * within 500 characters after `unregisterManagers([` counted, including a string in the NEXT
 * statement when the array was short.
 */
function unregisteredInProduction(): Set<string> {
  if (productionUnregisterTargets) return productionUnregisterTargets;
  const out = new Set<string>();
  const files = repoFiles({
    under: ['engine', 'games', 'demos'],
    match: (rel) => /\.tsx?$/.test(rel) && !rel.includes('.test.') && !rel.includes('/tests/'),
    floor: 0,
  });
  for (const { abs, rel } of files) {
    const { code } = readScannedSource(abs);
    if (!code.includes('unregisterManager')) continue; // a cheap pre-filter; the parse decides
    for (const call of callsTo(parseSource(code, rel), 'unregisterManager', 'unregisterManagers')) {
      for (const t of unregisterTargets(call)) out.add(t);
    }
  }
  productionUnregisterTargets = out;
  return out;
}

/** Whether ANY production source calls `unregisterManager('<name>')` (or its plural form
 *  `unregisterManagers([...])`) — or `unregisterManager(<ident>.name)` for one of this manager's
 *  own CLASS-bound binding identifiers. */
function hasProductionUnregisterCaller(name: string, idents: string[], kind: 'object-literal' | 'class'): boolean {
  // Two idioms cover every real call site: a string literal (`unregisterManager('foo')`), and the
  // variable idiom every current production caller actually uses (`unregisterManager(someManager.name)`).
  // The variable form is tied to THIS manager's own binding identifier(s) (not just any `x.name`) — a
  // bare identifier match would collide across unrelated managers, e.g.
  // `unregisterManager(chessManager.name)` would otherwise "prove" engine.time is wired too. It is
  // FURTHER restricted to `kind: 'class'` — an object-literal's binding is commonly a generic local
  // name (`manager`, shared verbatim by three separate runtime factories: zoneEventBus.ts,
  // physicsEventBus.ts, timelineEventBus.ts), so trusting it here would let any unrelated file's
  // `unregisterManager(manager.name)` "prove" every one of them wired (#517 follow-up,
  // reviewer-verified). A false NEGATIVE is the safe direction if an identifier is renamed.
  const targets = unregisteredInProduction();
  return targets.has(`'${name}'`) || (kind === 'class' && idents.some((i) => targets.has(`${i}.name`)));
}

/**
 * App-scoped managers with a `dispose` that nothing in production calls `unregisterManager` for,
 * each with the VERIFIED reason it's fine — a list of managers confirmed app-lifetime by design,
 * NOT a list of exemptions. Adding a name here without verifying (by reading the register/
 * unregister call sites, same as this file's own scan) defeats the guard: it makes the test green
 * while the underlying defect — a disposer nothing ever reaches — still exists.
 *
 * ⚠️ THESE THREE ARE PERMANENT, and #534 is the reason to stop re-litigating them. That issue
 * built the missing inverse — a `teardownAll()` unregistering all three by name and re-arming the
 * latch — wired it to `App`'s unmount cleanup, and then REMOVED it, because the measurement showed
 * the trigger could never fire with anything registered and, more fundamentally, that this
 * architecture has no surviving-realm shutdown for such a path to serve:
 *
 *   Every end-of-lifetime here is a REALM DEATH. The OS kills the process on mobile; the tab
 *   closes on web; restart and OTA go through `location.reload()` (`engine.reload`,
 *   runtime/actions/engineActions.ts); even the editor's project switch is a `webContents.reload()`
 *   (`setProject`, engine/electron/main.ts). None of them leave a realm behind, so none of them
 *   want a teardown. There is one `createRoot` (main.tsx) and no `.unmount()` anywhere in the repo.
 *
 * So `dispose` on these three is unreachable in production BY DESIGN, not by omission, and this
 * list is the honest record of that rather than a backlog. Do NOT empty it by wiring a new
 * teardown path; that was tried, measured and reverted. It would only become emptiable if a SOFT
 * restart is ever built (tear down and re-register in place, instead of reloading) — and then the
 * bar is to assert the teardown observes `registered === true`, not merely that it was called.
 * Reasoning: docs/managers-and-systems.md.
 */
/* ⚠️ **Keyed by DECLARATION — file and manager name — and SPENT (#1123/#1128).** This was a
 * `Record<name, reason>` checked with `name in`, which had two holes: a SECOND manager declared
 * under one of these names in any other file was pardoned by a reason about the first, and a row
 * whose manager became reachable (or vanished) stayed forever — there was no staleness check at
 * all. The file used to live only in the prose value; it is now the key. */
const APP_LIFETIME_BY_DESIGN: ReadonlyArray<{ item: string; count?: number; reason: string }> = [
  // Window-level input listeners (keyboard/gamepad/pointer/touch-control/gesture) are one fixed
  // set for the whole process. `dispose` exists for the `ManagerDef` contract and for
  // `__resetManagersForTesting`. Nothing in production unregisters it, and nothing should — see
  // the block above (#517, re-measured and settled in #534).
  {
    item: 'engine/packages/modoki/src/runtime/input/inputSources.ts::Input',
    reason: 'verified app-lifetime, #517/#534',
  },
  // dispose() unsubscribes the onPlayStateChange/onWorldSwap listeners init() installed and drops
  // its three read sources (deltaTime, timeSinceGameStart, timeSinceSceneLoad) — process-global
  // state, same shape as 'Input'.
  {
    item: 'engine/packages/modoki/src/runtime/managers/TimeManager.ts::engine.time',
    reason: 'verified app-lifetime, #517/#534',
  },
  // dispose() drops the 'canGoBack' read source and clears the history stack — again process-global.
  {
    item: 'engine/packages/modoki/src/runtime/managers/NavigationManager.ts::engine.navigation',
    reason: 'verified app-lifetime, #517/#534',
  },
];

// ── CENSUS: every textual `ManagerDef` reference must be accounted for (#517 follow-up 2) ────────
//
// The two scanners above only recognize two specific declaration SHAPES. Any OTHER shape — a
// sub-interface (`interface FooManager extends ManagerDef`) with `class X implements FooManager`,
// `implements ManagerDef, Y`, a generic class, `satisfies ManagerDef`, `as ManagerDef`, a factory
// function returning a `ManagerDef`, a `const arr: ManagerDef[] = [...]` — is invisible to them,
// and a scanner blind to a form has no way to know it missed something. The census below is the
// structural backstop: it finds every `ManagerDef` type reference in the scanned tree (comments
// blanked) and requires each one to be either a hit from a scanner above, or named in
// `NOT_A_MANAGER_DECLARATION` with a verified reason (a type-only re-export, a function signature
// that merely ACCEPTS/RETURNS a `ManagerDef`, not one that declares an instance). An unaccounted
// reference fails LOUD — see the assertion message below — rather than silently doing nothing,
// which is exactly the failure mode that let this guard go wrong twice already.

/** Every `ManagerDef` type reference in `sf` that no scanner above accounts for — see
 *  `isManagerDefRef` for what counts. Deliberately broad — the point of the census is to see
 *  EVERYTHING, then explain each one, not to pre-filter.
 *
 *  ⚠️ **By node since #1241.** The text census (`implements|satisfies|as|extends ManagerDef` or
 *  `: ManagerDef`) could not see `Array<ManagerDef>`, `readonly ManagerDef[]` or a union member, and
 *  subtracted a COUNT of scanner hits from a count of matches, so one unrecognized form could cancel
 *  a scanner hit that matched nothing. Each recognized declaration now accounts for the one
 *  reference node it owns. */
function unaccountedRefs(sf: ts.SourceFile): ts.Node[] {
  const owned = new Set<ts.Node>([
    ...scanObjectLiteralDecls(sf).map((d) => d.ref),
    ...scanClassDecls(sf).map((d) => d.ref),
  ]);
  return findNodes(sf, isManagerDefRef).filter((r) => !owned.has(r));
}

/** References that are legitimately NOT a manager declaration, keyed by file (relative to REPO)
 *  with the exact count of such references in that file and a verified reason. A file's total
 *  census references minus its scanner-accounted references must equal EXACTLY this count — a
 *  mismatch (fewer OR more) fails loud: fewer means this allowlist entry is stale (someone removed
 *  a reference — tighten the count), more means an unrecognized declaration form appeared (teach
 *  the scanner that form, don't just bump the count).
 *
 *  Verified by reading each file at the time this census was added (#517 follow-up 2) — every entry
 *  below is a plain type-signature usage (a function accepting/returning `ManagerDef`, or an
 *  `interface X extends ManagerDef` that is a type-only re-export whose actual class declares
 *  `implements ManagerDef` directly and IS caught by the class scanner).
 *
 *  ⚠️ **Spent through `assertExemptionLedger` since #1140, and that closed a real staleness hole.**
 *  The hand-rolled comparison `continue`d past any file with ZERO census references, so a row whose
 *  file lost every reference — deleted, renamed, or refactored — was never checked and stayed
 *  pardoning `count` references for whatever reappeared at that path. The detector counts rather
 *  than names references, so the item is the bare file (the documented fallback). */
const NOT_A_MANAGER_DECLARATION: ReadonlyArray<{ item: string; count: number; reason: string }> = [
  {
    item: 'engine/packages/modoki/src/runtime/managers/managerRegistry.ts',
    count: 5,
    reason:
      "the registry's own type signatures — `Entry.def`, `sceneMatches`/`gameMatches`/" +
      '`registerManager` params, and `registerManagers(defs: ManagerDef[])` — accept/hold a ' +
      '`ManagerDef`, they do not declare one. ' +
      // ⚠️ 6 → 5 when #518 met this guard in a merge, and NOT by tuning a number to green:
      // `addActions` used to be the sixth, taking `(def: ManagerDef)`. #518 changed it to
      // `(entry: Entry)` so it can read `entry.pendingInit`, which removed the reference. This
      // guard was written on `main` against the OLD signature while #518 changed it on a worker
      // branch — each side green alone, red only once merged. That is this allowlist's structural
      // hazard, not a one-off: it freezes a MEASUREMENT of code another branch is free to change.
      'ADDING to this count needs the same scrutiny as adding a file — say which reference and why.',
  },
  {
    item: 'engine/packages/modoki/src/runtime/zones/zoneEventBus.ts',
    count: 1,
    reason:
      "`createZoneEventBus`'s return-type annotation (`{ events: ZoneEventBus; manager: ManagerDef }`) " +
      "— the actual declaration is the `const manager: ManagerDef = {` a few lines below, which the " +
      'object-literal scanner already accounts for.',
  },
  {
    item: 'engine/packages/modoki/src/runtime/physics/physicsEventBus.ts',
    count: 1,
    reason: "`createPhysicsEventBus`'s return-type annotation — same shape as zoneEventBus.ts.",
  },
  {
    item: 'engine/packages/modoki/src/runtime/timeline/timelineEventBus.ts',
    count: 1,
    reason: "`createTimelineEventBus`'s return-type annotation — same shape as zoneEventBus.ts.",
  },
  {
    item: 'engine/packages/modoki/src/runtime/managers/TimeManager.ts',
    count: 1,
    reason:
      "`export interface TimeManager extends ManagerDef` is a type-only re-export for callers that " +
      'want the richer public type; the actual manager instance is `class TimeManagerImpl implements ' +
      "ManagerDef`, which the class scanner already accounts for. This is exactly the sub-interface " +
      'shape the reviewer flagged as the likely next miss (#517 follow-up) — verified NOT a second, ' +
      'independent manager declaration.',
  },
  {
    item: 'engine/packages/modoki/src/runtime/managers/NavigationManager.ts',
    count: 1,
    reason: '`export interface NavigationManager extends ManagerDef` — same shape as TimeManager.ts.',
  },
];

const fixture = (code: string) => parseSource(code, 'fixture.ts');

describe('the declaration readers read members and heritage, not text (#1241)', () => {
  it('reads an object literal\'s OWN name, scope and dispose', () => {
    // The text took the FIRST `name: '…'` in the braces — here the nested one — and found `scope`
    // and `dispose` at any depth.
    const sf = fixture([
      "const inputManager: ManagerDef = { meta: { name: 'other' }, name: 'Real', scope: 'app', dispose() {} };",
      "const nestedOnly: ManagerDef = { name: 'N', cfg: { scope: 'app', dispose: () => {} } };",
      "const nestedDispose: ManagerDef = { name: 'D', scope: 'app', cfg: { dispose: () => {} } };",
      "const notApp: ManagerDef = { name: 'S', scope: 'scene', dispose() {} };",
      "const typed: ManagerDef = { name: \"Dq\", scope: 'app' as const, dispose: () => undefined } satisfies ManagerDef;",
    ].join('\n'));
    expect(findObjectLiteralManagers(sf, 'f.ts')).toEqual([
      { name: 'Real', file: 'f.ts', idents: ['inputManager'], kind: 'object-literal' },
      { name: 'Dq', file: 'f.ts', idents: ['typed'], kind: 'object-literal' },
    ]);
    expect(() => findObjectLiteralManagers(fixture("const m: ManagerDef = { name: NAME, scope: 'app', dispose() {} };"), 'f.ts'))
      .toThrow(/not a string literal/);
  });

  it('reads a class by its heritage and its own fields, and binds its `new` instances', () => {
    // `nickname = 'Other'` satisfied the text's un-anchored `name\s*=` before the real field, and
    // `implements Disposable, ManagerDef` did not match `implements\s+ManagerDef\s*\{` at all.
    const sf = fixture([
      'class TimeImpl implements Disposable, ManagerDef {',
      "  nickname = 'Other';",
      "  name = 'engine.time';",
      "  scope = 'app' as const;",
      '  dispose = () => {};',
      '}',
      'export const timeManager: TimeManager = new TimeImpl();',
      'const hotManager = import.meta.hot?.data.tm ?? wrap(new TimeImpl());',
      'const makeTime = () => new TimeImpl();',
      "class SceneOnly implements ManagerDef { name = 'S'; scope = 'scene'; dispose() {} }",
      "class NoDispose implements ManagerDef { name = 'N'; scope = 'app'; helper = { dispose() {} }; }",
      "class NotAManager { name = 'X'; scope = 'app'; dispose() {} }",
    ].join('\n'));
    expect(findClassManagers(sf, 'f.ts')).toEqual([{ name: 'engine.time', file: 'f.ts', idents: ['timeManager', 'hotManager'], kind: 'class' }]);
  });

  it('the census sees every type-position reference, and credits only the one a declaration owns', () => {
    const refs = (code: string) => unaccountedRefs(fixture(code)).map(siteText);
    // Recognized declarations own their reference; an import is not a use.
    expect(refs("import type { ManagerDef } from './m';\nconst m: ManagerDef = { name: 'a' };\nclass C implements ManagerDef {}")).toEqual([]);
    // Forms the text census could not see at all — an array element type, a generic argument, a
    // union member — each an unrecognized declaration that would have passed silently.
    expect(refs("const all: Array<ManagerDef> = [{ name: 'a', scope: 'app', dispose() {} }];")).toHaveLength(1);
    expect(refs('const all: readonly ManagerDef[] = [];')).toHaveLength(1);
    expect(refs('let m: ManagerDef | undefined;')).toHaveLength(1);
    // The forms it could see, still seen.
    expect(refs('function f(d: ManagerDef): void {}\nconst x = y as ManagerDef;\ninterface T extends ManagerDef {}')).toHaveLength(3);
  });
});

describe('unregisterTargets — what one teardown call names (#1241)', () => {
  const targets = (code: string) => callsTo(fixture(code), 'unregisterManager', 'unregisterManagers').flatMap(unregisterTargets);

  it('reads a literal, a template, `<ident>.name`, and every element of the plural array', () => {
    expect(targets("unregisterManager('Input');")).toEqual(["'Input'"]);
    expect(targets('unregisterManager(`engine.time`);')).toEqual(["'engine.time'"]);
    expect(targets('unregisterManager(timeManager.name);')).toEqual(['timeManager.name']);
    expect(targets("unregisterManagers(['a', cameraManager.name, other()]);")).toEqual(["'a'", 'cameraManager.name']);
  });

  it('names nothing for a call that is not one of those shapes', () => {
    expect(targets("unregisterManager(pick('Input'));\nunregisterManager(a.b.name);\nunregisterManagers(names);")).toEqual([]);
    // A name in a LATER statement is not an element of the array.
    expect(targets("unregisterManagers(['a']); log('Input');")).toEqual(["'a'"]);
  });

  it('an object-literal manager is not proven wired by an `<ident>.name` call — its binding is a generic name', () => {
    productionUnregisterTargets = new Set(['manager.name', 'timeManager.name']);
    try {
      expect(hasProductionUnregisterCaller('zones', ['manager'], 'object-literal')).toBe(false);
      expect(hasProductionUnregisterCaller('engine.time', ['timeManager'], 'class')).toBe(true);
      expect(hasProductionUnregisterCaller('engine.time', ['otherManager'], 'class')).toBe(false);
    } finally {
      productionUnregisterTargets = undefined;
    }
  });
});

describe('every ManagerDef textual reference is accounted for (#517 follow-up 2 — census backstop)', () => {
  it('every ManagerDef reference in runtime/** is either a recognized declaration or a verified non-declaration', () => {
    const population: Array<{ item: string; site: string }> = [];
    for (const file of listRuntimeFiles(RUNTIME_DIR)) {
      const { rel, sf } = parsedRuntime(file);
      for (const ref of unaccountedRefs(sf)) {
        population.push({ item: rel, site: `${rel}:${lineOf(ref)}: ${siteText(ref)}` });
      }
    }
    assertExemptionLedger({
      label: 'NOT_A_MANAGER_DECLARATION in appManagerDisposeReachable',
      population,
      exempt: NOT_A_MANAGER_DECLARATION,
      floor: 1,
      fix: 'A `ManagerDef` was declared/referenced in a form the scanners above do not recognize — this ' +
        'is this guard\'s known weak point (it has been wrong in this exact direction twice before, ' +
        '#517). The fix is to teach the relevant scanner (findObjectLiteralManagers / ' +
        'findClassManagers / scanObjectLiteralDecls / scanClassDecls) that declaration form, NOT to ' +
        'raise a NOT_A_MANAGER_DECLARATION count unless the reference is verified to genuinely not ' +
        'be a manager declaration (read the file, same discipline as this guard\'s own scan).',
    });
  });
});

describe('every app-scoped ManagerDef.dispose is reachable from production (#517)', () => {
  const found = findAppScopedManagersWithDispose();

  it('found a plausible number of app-scoped managers with dispose (sanity: the parse works)', () => {
    expect(found.length).toBeGreaterThan(0);
  });

  it('every app-scoped manager.dispose is wired to unregisterManager or verified in the allowlist', () => {
    assertExemptionLedger({
      label: 'APP_LIFETIME_BY_DESIGN in appManagerDisposeReachable',
      population: found
        .filter((mgr) => !hasProductionUnregisterCaller(mgr.name, mgr.idents, mgr.kind))
        .map((mgr) => {
          // POSIX, because the rows are: `findAppScopedManagersWithDispose` keeps `path.relative`'s
          // native separator, which on Windows would stale every row and pardon nothing.
          const rel = mgr.file.split(path.sep).join('/');
          return { item: `${rel}::${mgr.name}`, site: `${rel} — ${mgr.name}` };
        }),
      exempt: APP_LIFETIME_BY_DESIGN,
      // The three rows are permanent by design (#534, above), so the population never reaches 0.
      floor: 1,
      fix: 'This app-scoped ManagerDef declares a `dispose` that nothing in production reaches: '
        + 'managerRegistry.deactivate() only runs dispose via unregisterManager(name) or a re-register '
        + 'of the same name, and an app-scoped manager has no other teardown trigger. Fix it one of two '
        + "ways: (1) wire a real `unregisterManager('<name>')` call into the appropriate app-teardown "
        + 'path, or (2) if the manager is genuinely app-lifetime by design, add it to '
        + 'APP_LIFETIME_BY_DESIGN above with a one-line verified reason — never add a name on assumption.',
    });
  });
});
