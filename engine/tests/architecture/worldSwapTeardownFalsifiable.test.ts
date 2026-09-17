/**
 * Every world-swap teardown that has a falsifiable test KEEPS it, and a newly-swallowed one gets
 * flagged (#838).
 *
 * A production module registers cleanup for the world going away with `onWorldSwap(handler)`. A
 * test that mocks the module supplying `onWorldSwap` with a bare no-op prevents that registration
 * from ever happening, so the handler — and everything it releases — is exercised by nothing. The
 * suite then proves everything about the module EXCEPT that its per-scene state is ever released,
 * and stays green if the registration line is deleted outright.
 *
 * ⚠️ **The trap that makes this invisible.** `onWorldSwap` is only a RE-EXPORT: it is defined in
 * `runtime/core/ecs/worldRegistry.ts` and surfaced through `runtime/core/ecs/world.ts`. A wholesale
 * `vi.mock('.../core/ecs/world', () => ({ ... }))` therefore severs the module under test from the
 * real listener Set, and a later `setCurrentWorld()` in that same suite fires NOTHING. "I drove a
 * real swap" is not on its own evidence that anything ran.
 *
 * ## Two halves, and the first one is why this file was rewritten
 *
 * ⚠️ **A guard whose protected set is computed FROM THE DEFECT switches itself off as the defect is
 * fixed.** The first version of this file seeded its at-risk set from "producers some test mocks to
 * a no-op" — but converting that mock to a capturing shape is precisely the fix, so each producer
 * dropped out of the protected set at the moment it was fixed. Measured on the commit that
 * introduced it: 4 of the 7 tests it existed to protect could be deleted with the guard still
 * green, and a fully-fixed repo would have driven the set to 0 and failed the file's own
 * non-vacuity assertion. The premise has to be independent of the thing being guarded.
 *
 * So:
 *
 * - **BASELINE (the ratchet)** — a hand-maintained map of producer → the ONE test file that covers
 *   its wiring. Independent of any mock's shape, so no edit to a mock can unseed it. Deleting the
 *   test, or renaming its marker, goes red. This is what actually protects the tests.
 * - **SWALLOWED (the tripwire)** — computed: a producer some test wholesale-mocks in a way that
 *   drops `onWorldSwap`. If such a producer is absent from BASELINE it is a NEW arrival and goes
 *   red. This is what stops the class from coming back.
 *
 * ## What "covered" means, and what it does not
 *
 * BASELINE names the exact covering file, and that file must contain a `describe`/`it` titled with
 * the marker phrase **"world-swap wiring"** — the title the two reference fixes
 * (`materialInstanceSystem.test.ts`, `materialInstanceClones.test.ts`) already use.
 *
 * ⚠️ Naming the file is deliberate, and replaces a weaker rule that asked only "does SOME file that
 * imports this producer carry the marker". That version was satisfied by a **type-only** import:
 * `uiNode.test.tsx`'s `import type { UINodeData } from '.../uiTreeStore'` marked `uiTreeStore.ts`
 * covered, so `uiTreeStore.test.ts`'s own wiring test could be deleted with the guard green.
 *
 * The marker remains a DECLARATION, not a proof — the same trust model as
 * `invalidatorsAreReachable.test.ts`'s allowlist. What proves a test is the mutation check (delete
 * the `onWorldSwap(...)` line, the test must go red), and that belongs to review. This guard makes
 * the ABSENCE of the test loud, which is the half that was failing silently.
 *
 * ## Known limits, stated rather than discovered later
 *
 * - **A teardown no test mocks and no test covers is invisible.** SWALLOWED is seeded from what
 *   tests mock. Requiring a wiring test of every producer would flag ~30 sites on day one and ship
 *   as an allowlist, which goes stale rather than guards. BASELINE is the ratchet instead: it only
 *   ever grows.
 * - **SWALLOWED is DIRECT-import only, so a transitively-reached producer is invisible to it.** The
 *   rule is "a producer some test wholesale-mocks *and imports directly*". Measured: 62 test files
 *   mock the world module, 55 of them swallow it, and SWALLOWED attributes exactly 3 producers — so
 *   a green tripwire is partly an artefact of narrow resolution, not proof of a clean repo. A live
 *   instance was found this way and is now in BASELINE: `editor/store/canvas2DDirty.ts`, reached
 *   through `editorStore.ts` by editor suites that mock the world module, with deleting its
 *   registration leaving 71 tests green. BASELINE is the answer for anything found this way —
 *   resolving the full import graph here would cost more than it buys.
 * - **The package-specifier seam.** Import resolution only follows relative specifiers, and
 *   `WORLD_MODULE` does not match `@modoki/engine/runtime`. No producer reaches `onWorldSwap`
 *   through a barrel today, so nothing is missed — but a future one would be invisible here.
 * - **The discriminant half of the family is not covered at all.** "This mock is a no-op" is
 *   greppable; "this cache's key is missing a renderer" (#828) or "missing a World" (#851) is not.
 *
 * Full conventions, the three test shapes and the mutation bar: `docs/falsifiable-tests.md`.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';
import {
  accessPath, calleeName, callsTo, declarationOf, enclosingFunction, findNodes, importsIn, parseSource,
  propertyValue, readsOf, stringValueOf, unwrapValue, variablesNamed, ts,
} from '@modoki/engine/testing/sourceAst';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

const REPO = path.resolve(__dirname, '../../..');

/** Where a swap teardown may be REGISTERED. */
const PRODUCER_ROOTS = ['engine/packages/modoki/src', 'engine/app', 'games', 'demos'];
/** Where a test may mock it away. Games and demos carry their own suites (#29). */
const TEST_ROOTS = ['engine/packages/modoki/tests', 'engine/tests', 'games', 'demos'];

const SOURCE_EXT = new Set(['.ts', '.tsx']);
const IS_TEST = /\.test\.tsx?$/;

/** The marker title. Both reference fixes already use this exact phrase. */
const WIRING_MARKER = /world[-\s]swap wiring/i;

/** `runtime/core/ecs/world` and `runtime/core/ecs/worldRegistry` — the module a mock intercepts. */
const WORLD_MODULE = /(?:^|\/)(?:ecs\/world|ecs\/worldRegistry|worldRegistry)$/;

/**
 * THE RATCHET. producer → the one test file whose `world-swap wiring` block covers it.
 *
 * ⚠️ **Entries come OUT of here only when the producer's `onWorldSwap` registration is deleted**,
 * never because a test became inconvenient. Adding one means you wrote a real, mutation-checked
 * test — the guard cannot tell a genuine block from a describe with the right title, so this map is
 * a statement of work done, in the same way `invalidatorsAreReachable.test.ts`'s allowlist is.
 */
const BASELINE: Record<string, string> = {
  // The two that established the pattern and the marker phrase (#738).
  'engine/packages/modoki/src/runtime/rendering/materialInstanceSystem.ts':
    'engine/packages/modoki/tests/runtime/materialInstanceSystem.test.ts',
  'engine/packages/modoki/src/runtime/rendering/materialInstanceClones.ts':
    'engine/packages/modoki/tests/runtime/materialInstanceClones.test.ts',
  // #848 — the broker's per-frame dirty map. The registered `entityShaders` maps are cleared by
  // the renderers that OWN them; this map is owned by nobody, so it needs the swap clear and a test
  // that proves the clear is wired.
  'engine/packages/modoki/src/runtime/rendering/sprite2DMaterialBroker.ts':
    'engine/packages/modoki/tests/runtime/sprite2DMaterialBroker.test.ts',
  // #838's seven.
  'engine/packages/modoki/src/runtime/rendering/flameMeshSync.ts':
    'engine/packages/modoki/tests/runtime/flameMeshSync.test.ts',
  'engine/packages/modoki/src/runtime/rendering/blobShadowSync.ts':
    'engine/packages/modoki/tests/runtime/blobShadowSync.test.ts',
  'engine/packages/modoki/src/runtime/rendering/instancedBatching.ts':
    'engine/packages/modoki/tests/runtime/instancedBatching.test.ts',
  'engine/packages/modoki/src/runtime/ui/uiTreeStore.ts':
    'engine/packages/modoki/tests/runtime/uiTreeStore.test.ts',
  'engine/packages/modoki/src/runtime/ui/entriesSystem.ts':
    'engine/packages/modoki/tests/runtime/entriesSystem.test.ts',
  'engine/packages/modoki/src/runtime/ui/focusManager.ts':
    'engine/packages/modoki/tests/runtime/focusManager.test.ts',
  'engine/packages/modoki/src/runtime/ui/UINode.tsx':
    'engine/packages/modoki/tests/runtime/uiNode.test.tsx',
  // Added by the close-out review of the commit above — its own new test file drained the
  // teardown with the test-only reset hook and never drove the wiring.
  'engine/packages/modoki/src/runtime/rendering/derivedMaterials.ts':
    'engine/packages/modoki/tests/runtime/derivedMaterials.test.ts',
  // Found by the SECOND review pass, and the reason the transitive limit below is written down:
  // editor suites wholesale-mock the world module and reach this through `editorStore.ts`, so no
  // file that swallows it imports it directly. Deleting its registration left 71 tests green.
  'engine/packages/modoki/src/editor/store/canvas2DDirty.ts':
    'engine/packages/modoki/tests/editor/canvas2DDirty.test.ts',
  // #868 Group C: the world-swap clear of worldTransforms / deactivatedEntities.
  'engine/packages/modoki/src/runtime/core/ecs/transformPropagationSystem.ts':
    'engine/packages/modoki/tests/runtime/transformPropagationIdReuse.test.ts',
};

/* ⚠️ **No ALLOWLIST (#1140).** "Producers whose teardown a test swallows and which owe NO wiring test"
 *  was an EMPTY `Record` consulted with `in`. Deleted: a producer that genuinely owes no wiring
 *  test is a counted `assertExemptionLedger` row with a reason VERIFIED by reading the site.
 *  BASELINE above is a different kind of list — a coverage REGISTRY whose rows are proven by the
 *  named wiring test, not spent against the swallowed set — so it stays as it is. */

interface Scanned {
  rel: string;
  abs: string;
  code: string;
}

function scannedFiles(roots: string[], want: (rel: string) => boolean, floor: number): Scanned[] {
  return repoFiles({
    under: roots,
    exclude: ['node_modules', 'dist', 'build', 'ios', 'android'],
    match: (rel: string) => SOURCE_EXT.has(path.extname(rel).toLowerCase()) && want(rel),
    floor,
  }).map(({ rel, abs }: { rel: string; abs: string }) => ({
    rel,
    abs,
    code: readScannedSource(abs).code,
  }));
}

/** A module path with its extension dropped, so an import specifier and a file agree. */
function moduleKey(rel: string): string {
  return rel.replace(/\.tsx?$/, '');
}

/** A `vi.<name>(…)` call — not `server.mock(…)`, not a bare `mock(…)`. */
const onVi = (call: ts.CallExpression): boolean =>
  ts.isPropertyAccessExpression(call.expression) && accessPath(call.expression.expression) === 'vi';

/** A function-like node a mock can hand over as a value: an arrow, a function expression, or an
 *  object-literal method (`onWorldSwap(fn) { … }`). */
type HandlerFn = ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration;

function asHandlerFn(n: ts.Node | undefined): HandlerFn | undefined {
  const u = n && ts.isExpression(n) ? unwrapValue(n) : n;
  return u && (ts.isArrowFunction(u) || ts.isFunctionExpression(u) || ts.isMethodDeclaration(u)) ? u : undefined;
}

/**
 * Does this `onWorldSwap` value CAPTURE the handler it is given, so a test can invoke it?
 *
 * ⚠️ **A parameter is not a capture — it must be USED.** `(_fn) => () => {}` declares a parameter
 * and drops it on the floor, which is a no-op wearing a capture's signature. An earlier version
 * asked only whether the parameter list was non-empty and read all four of
 * `(_fn) => () => {}` · `(fn: () => void) => () => {}` · `vi.fn((_fn) => () => {})` ·
 * `(...args) => () => {}` as capturing — and the guard's own failure message hands the reader that
 * exact signature, so writing it and forgetting the body was the cheapest way to silence it.
 *
 * ⚠️ **Used means a READ OF THAT BINDING inside the function's own body (#1241).** The text version
 * had to bound the body by hand — a brace count, or "to the first top-level comma" for a concise
 * arrow — because the body used to run on to the end of the mock factory, and a SIBLING key
 * mentioning the name (`getCurrentWorld: vi.fn()` beside an ignored `fn`) satisfied the check. The
 * node's body is the body, and `readsOf` resolves by symbol, so neither a sibling's `vi.fn` nor a
 * sibling's own `fn` parameter can vouch.
 *
 * `null` is an unrecognised shape (commonly a shorthand referencing a variable declared above).
 * Read as NOT capturing: a guard that cannot parse its subject must fail loud, not assume the safe
 * answer. A destructured parameter names nothing this can check, so it is not credited either.
 */
function capturesHandler(value: ts.Node): boolean | null {
  let fnNode = asHandlerFn(value);
  const u = ts.isExpression(value) ? unwrapValue(value) : value;
  if (!fnNode && ts.isCallExpression(u) && onVi(u) && calleeName(u) === 'fn') {
    if (u.arguments.length === 0) return false; // `vi.fn()` — no handler at all
    fnNode = asHandlerFn(u.arguments[0]);
  }
  if (!fnNode || !fnNode.body) return null;
  const body = fnNode.body;
  return fnNode.parameters.some((p) => ts.isIdentifier(p.name)
    && readsOf(p.name).some((r) => ts.findAncestor(r, (n) => n === body) !== undefined));
}

/** `capturesHandler` over an `onWorldSwap:` value written as source — the fixtures' way in, through
 *  the real reader. `rest` is the value plus whatever follows it in the factory literal. */
function capturesHandlerText(rest: string): boolean | null {
  const sf = parseSource(`const factoryResult = { onWorldSwap: ${rest} };`, 'fixture.ts');
  const lit = variablesNamed(sf, 'factoryResult')[0]!.initializer;
  const value = propertyValue(lit, 'onWorldSwap');
  if (!value) throw new Error(`capturesHandlerText: no onWorldSwap in the fixture '${rest}'`);
  return capturesHandler(value);
}

/** The object literal(s) a mock factory RETURNS — a concise `() => ({ … })`, or every `return` of a
 *  block body that belongs to the factory itself. A return that is not a literal comes back as
 *  `undefined`, which the caller reads as unreadable. */
function factoryResults(factory: HandlerFn): Array<ts.ObjectLiteralExpression | undefined> {
  const body = factory.body;
  if (!body) return [undefined];
  const returned = ts.isBlock(body)
    ? findNodes(body, ts.isReturnStatement).filter((r) => enclosingFunction(r) === factory).map((r) => r.expression)
    : [body];
  if (returned.length === 0) return [undefined];
  return returned.map((r) => {
    const lit = r && unwrapValue(r);
    return lit && ts.isObjectLiteralExpression(lit) ? lit : undefined;
  });
}

/** Whether a mock factory loads the ORIGINAL module — calls its own first parameter
 *  (`importOriginal`, whatever it is named) or `vi.importActual` in its own body. The same reading
 *  `originalsLoaded` uses to credit a partial mock with reaching the producer. */
function loadsOriginal(factory: HandlerFn): boolean {
  const loader = factory.parameters[0]?.name;
  const own = (n: ts.Node) => enclosingFunction(n) === factory;
  if (loader && ts.isIdentifier(loader) && readsOf(loader).some((r) => ts.isCallExpression(r.parent)
    && r.parent.expression === r && own(r.parent))) return true;
  return !!factory.body && callsTo(factory.body, 'importActual').some((c) => onVi(c) && own(c));
}

/** Module specifiers the file reaches for — static, re-exported and dynamic, plus the ORIGINAL a mock
 *  loads (`vi.mock('…', (importOriginal) => … importOriginal() …)`, `vi.importActual('…')`); erased
 *  imports dropped.
 *
 *  ⚠️ **Read from the parse (#1193).** This was `from '…'` and `import('…')` regexes over the code with
 *  every `import type` LINE blanked first. A side-effect `import '../src/…/registerProviders'` has no
 *  `from`, so a test that loads a producer only for its side effects was never attributed to it (24 such
 *  edges across the test corpus, measured 2026-09-15); and `importOriginal<typeof import('../x')>()`,
 *  `Set<import('../x').T>` and fixture strings each read as reaching a producer (145 edges). A type
 *  position runs nothing. What DOES run a producer without importing it is a partial mock's original —
 *  the text form credited that by accident, through `importOriginal<typeof import('../producer')>()`'s
 *  type argument. It is read from what LOADS instead (review of #1193): the `vi.mock`/`vi.doMock` target
 *  whose factory CALLS its first parameter — resolved by symbol, in the factory's own body (a call inside a
 *  nested function may never run) — whatever it is called and whatever type argument it is given, and
 *  `vi.importActual`'s own string argument.
 *
 *  Not credited, and stated so: `vi.mock('x')` automocking and `{ spy: true }`, a loader handed on
 *  (`helper(importOriginal)`) or cast before the call, `vi.importActual(variable)`, and a factory held in a
 *  variable. None occurs in the repo; each only under-credits, which can fail open for SWALLOWED. A mock
 *  target written as `vi.mock(import('x'), …)` is credited by `importsIn` as a dynamic edge whatever its
 *  factory does. */
function importedSpecifiers(testRel: string, code: string): string[] {
  const sf = parseSource(code, testRel);
  return [...importsIn(sf).filter((e) => !e.typeOnly).map((e) => e.spec), ...originalsLoaded(sf)];
}

function originalsLoaded(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  for (const call of callsTo(sf, 'importActual').filter(onVi)) {
    const arg = call.arguments[0];
    if (arg && ts.isStringLiteralLike(arg)) out.push(arg.text);
  }
  for (const call of callsTo(sf, 'mock', 'doMock').filter(onVi)) {
    const [target, factory] = call.arguments;
    if (!target || !ts.isStringLiteralLike(target) || !factory || !(ts.isArrowFunction(factory) || ts.isFunctionExpression(factory))) continue;
    const loader = factory.parameters[0]?.name;
    if (!loader || !ts.isIdentifier(loader)) continue;
    const loads = readsOf(loader).some((r) => ts.isCallExpression(r.parent) && r.parent.expression === r
      && enclosingFunction(r.parent) === factory);
    if (loads) out.push(target.text);
  }
  return out;
}

/** Repo-relative, extension-less module keys for a file's relative VALUE imports. */
function importedModules(testRel: string, code: string): Set<string> {
  const dir = path.posix.dirname(testRel);
  const out = new Set<string>();
  for (const spec of importedSpecifiers(testRel, code)) {
    if (!spec.startsWith('.')) continue; // package specifiers never address a producer file
    out.add(moduleKey(path.posix.normalize(path.posix.join(dir, spec))));
  }
  return out;
}

/**
 * Does this file wholesale-mock the world module in a way that DROPS the swap registration?
 *
 * Three ways it drops, and the third is the most complete swallow of the three — it was classified
 * as harmless by the first version of this guard, which made "delete the `onWorldSwap` key from the
 * mock" a legal way to silence it:
 *   1. `onWorldSwap: vi.fn()` / `() => {}` — a bare no-op.
 *   2. `onWorldSwap,` shorthand referencing a variable declared above (unreadable from here).
 *   3. the factory omits `onWorldSwap` ENTIRELY — the import then resolves to `undefined` and the
 *      registration throws or no-ops depending on the call site.
 *
 * A factory spreading `importOriginal()` is a PARTIAL mock — the real `onWorldSwap` and the real
 * listener Set survive — so it is not a swallow UNLESS a key written after the spread replaces
 * `onWorldSwap` with something that does not capture. This used to say "never", and a fixture below
 * pinned `{ ...(await importOriginal()), onWorldSwap: vi.fn() }` as clean: that override drops the
 * registration exactly like a wholesale no-op (#1241 close-out review).
 */
/** Whether the member holding `value` comes after the literal's last spread — so it, not the spread
 *  original, is what the module exports. */
function overridesSpread(lit: ts.ObjectLiteralExpression, value: ts.Node): boolean {
  const at = lit.properties.findIndex((p) => p === value || p === value.parent);
  const lastSpread = lit.properties.map((p) => ts.isSpreadAssignment(p)).lastIndexOf(true);
  return at > lastSpread;
}

/**
 * Whether `e` IS the module the factory loaded: `await <loader>()` / `await vi.importActual(…)`, or a
 * `const` bound to one, resolved by symbol. An allowlist of the known-safe shapes (#1241 close-out,
 * third review): trusting any spread, or any `x.onWorldSwap`, credited a hoisted spy object
 * (`mocks.onWorldSwap`) and a spread of stubs as "the original survives".
 */
function isLoadedOriginal(e: ts.Expression, factory: HandlerFn): boolean {
  const u = unwrapValue(e);
  if (ts.isCallExpression(u)) {
    if (onVi(u) && calleeName(u) === 'importActual') return true;
    const loader = factory.parameters[0]?.name;
    const callee = unwrapValue(u.expression);
    return !!loader && ts.isIdentifier(loader) && ts.isIdentifier(callee) && declarationOf(callee) === loader.parent;
  }
  if (!ts.isIdentifier(u)) return false;
  const d = declarationOf(u);
  return !!d && ts.isVariableDeclaration(d) && ts.isIdentifier(d.name) && !!d.initializer
    && enclosingFunction(d) === factory && isLoadedOriginal(d.initializer, factory);
}

/** A value that hands the ORIGINAL `onWorldSwap` on: `<original>.onWorldSwap`, or
 *  `vi.fn(<original>.onWorldSwap)` — a spy over the real function still registers. */
function passesOriginal(value: ts.Node, factory: HandlerFn): boolean {
  if (!ts.isExpression(value)) return false;
  const u = unwrapValue(value);
  const inner = ts.isCallExpression(u) && onVi(u) && calleeName(u) === 'fn' && u.arguments[0] ? unwrapValue(u.arguments[0]) : u;
  if (ts.isPropertyAccessExpression(inner) && inner.name.text === 'onWorldSwap') return isLoadedOriginal(inner.expression, factory);
  return ts.isElementAccessExpression(inner) && stringValueOf(inner.argumentExpression) === 'onWorldSwap'
    && isLoadedOriginal(inner.expression, factory);
}

function swallowsWorldSwap(code: string, label = 'fixture.test.ts'): boolean {
  const sf = parseSource(code, label);
  for (const call of callsTo(sf, 'mock', 'doMock').filter(onVi)) {
    const [target, factoryArg] = call.arguments;
    if (!target || !ts.isStringLiteralLike(target) || !WORLD_MODULE.test(target.text.replace(/\.tsx?$/, ''))) continue;
    // `vi.mock(world)` with no factory AUTOMOCKS: every export, `onWorldSwap` included, becomes a
    // bare `vi.fn()`. The text version required a `,` after the target and skipped it (#1241).
    if (!factoryArg) return true;
    const factory = asHandlerFn(factoryArg);
    if (!factory) return true; // a factory held in a variable — unreadable, so not credited
    const partial = loadsOriginal(factory);
    for (const result of factoryResults(factory)) {
      const value = result && propertyValue(result, 'onWorldSwap');
      if (partial) {
        // A PARTIAL mock keeps the real `onWorldSwap` only through what it returns (#1241 close-out
        // reviews): a return this cannot read is not credited; every spread must BE the loaded
        // original (a spread of anything else is unreadable); a literal with no such spread drops the
        // key; and a key written AFTER the last spread replaces the original — so that value must
        // capture, or hand the original on (`vi.fn(actual.onWorldSwap)`, `actual.onWorldSwap`).
        if (!result) return true;
        const spreads = result.properties.filter(ts.isSpreadAssignment);
        if (spreads.length === 0 || spreads.some((sp) => !isLoadedOriginal(sp.expression, factory))) return true;
        if (!value) continue;
        if (overridesSpread(result, value) && capturesHandler(value) !== true && !passesOriginal(value, factory)) return true;
        continue;
      }
      // Absent, a shorthand, or a value this cannot read — none of them is a capture.
      if (!value || capturesHandler(value) !== true) return true;
    }
  }
  return false;
}

const PRODUCERS = new Map<string, string>(); // moduleKey -> rel
for (const f of scannedFiles(PRODUCER_ROOTS, (rel) => !IS_TEST.test(rel), 400)) {
  if (!f.code.includes('onWorldSwap')) continue; // a cheap pre-filter; the parse decides
  const sf = parseSource(f.code, f.rel);
  // A CALL, so `worldRegistry.ts`, which DEFINES `onWorldSwap` and never calls it, is not a producer.
  // (The text version needed a second `export function onWorldSwap(` test for that; a declaration
  // is not a call. Mutation-checked: re-adding a definer exclusion changes nothing.)
  if (callsTo(sf, 'onWorldSwap').length === 0) continue;
  PRODUCERS.set(moduleKey(f.rel), f.rel);
}

const TESTS = scannedFiles(TEST_ROOTS, (rel) => IS_TEST.test(rel), 200);
const TEST_BY_REL = new Map(TESTS.map((t) => [t.rel, t]));

const SWALLOWED = new Map<string, string[]>(); // producer rel -> test files that swallow it
for (const t of TESTS) {
  if (!swallowsWorldSwap(t.code, t.rel)) continue;
  for (const k of importedModules(t.rel, t.code)) {
    const p = PRODUCERS.get(k);
    if (!p) continue;
    if (!SWALLOWED.has(p)) SWALLOWED.set(p, []);
    SWALLOWED.get(p)!.push(t.rel);
  }
}


describe('importedSpecifiers — what counts as reaching a producer (#1193)', () => {
  it('value imports of every spelling, and the original a partial mock loads; not erased imports, type positions or a factory-only mock', () => {
    expect(importedSpecifiers('t.test.ts', [
      "import '../side-effect';",
      "import { a } from '../value';",
      "import type { T } from '../erased';",
      "const lazy = () => import('../dynamic');",
      "let s: Set<import('../type-position').T>;",
      "vi.mock('../mocked', async (importOriginal) => ({ ...(await importOriginal<typeof import('../mocked')>()) }));",
      "vi.mock('../renamed', async (orig) => ({ ...(await orig<object>()) }));",
      "vi.mock('../factoryOnly', () => ({ x: 1 }));",
      "vi.mock('../loaderUnused', (importOriginal) => ({ x: 1 }));",
      "vi.mock('../loaderShadowed', (orig) => ({ f: [1].map((orig) => orig()) }));",
      "vi.mock('../loaderLazy', (orig) => ({ lazy: () => orig() }));",
      "vi.doMock('../doMocked', async (orig) => ({ ...(await orig()) }));",
      "server.mock('../notVi', (a) => a());",
      "const actual = await vi.importActual<typeof import('../typeArgIgnored')>('../actual');",
    ].join('\n')).sort()).toEqual(['../actual', '../doMocked', '../dynamic', '../mocked', '../renamed', '../side-effect', '../value']);
  });
});

/**
 * The parser's own regression cover — the same reason `sourceScanner.test.ts` exists for the
 * comment stripper: a guard whose instrument silently misreads its subject is not a guard.
 *
 * Every row here is a REAL misclassification an adversarial review found in this file. Rows 4-7 of
 * NO_OP each returned `true` at review time (rows 1-3 were always correct) — four ways to write a
 * no-op the guard waved through — and the guard's own failure message hands the reader the
 * capturing signature, so declaring the parameter and forgetting the body is the cheapest way to
 * silence it.
 *
 * ⚠️ **Each string carries a trailing sibling key**, because that is the bug that shipped: the text
 * reader was fed `factory.slice(afterTheKey)`, which ran to the end of the mock factory, and
 * `getCurrentWorld: vi.fn()` sitting after an ignored `fn` parameter satisfied the reference check
 * via the `fn` inside `vi.fn(`. The reader takes the value's NODE since #1241
 * (`capturesHandlerText` parses each row inside a factory literal), and the siblings stay so a
 * regression to a text extent is caught by the rows that caught it the first time.
 */
describe('capturesHandler — the shapes a review caught it misreading', () => {
  const SIB = ' getCurrentWorld: vi.fn(), findEntityById: vi.fn(),';

  const NO_OP: Array<[string, string]> = [
    ['vi.fn()', `vi.fn(),${SIB}`],
    ['bare arrow', `() => {},${SIB}`],
    ['arrow returning an unsubscribe', `() => () => {},${SIB}`],
    ['IGNORED parameter', `(_fn) => () => {},${SIB}`],
    ['ignored TYPED parameter beside a vi.fn sibling', `(fn: () => void) => () => {},${SIB}`],
    ['vi.fn wrapping an ignored parameter', `vi.fn((_fn) => () => {}),${SIB}`],
    ['ignored rest parameter', `(...args) => () => {},${SIB}`],
    ['ignored parameter, block body, sibling mentions the name', `(fn) => { return () => {}; }, wake: (fn: X) => fn(),`],
    ['function keyword, parameter ignored', `function (fn) { return () => {}; },${SIB}`],
    ['ignored parameter with a parenthesised type', `(fn: (a: A, b: B) => void) => () => {},${SIB}`],
    // #1241: a string holding a paren or a brace moved every text edge; a shadowing inner `fn` is
    // not the handler.
    ['ignored parameter, string paren in the body', `(fn) => { log(')'); return () => {}; },${SIB}`],
    ['inner function shadows the parameter', `(fn) => { const off = (fn) => fn; return off; },${SIB}`],
  ];

  const CAPTURES: Array<[string, string]> = [
    ['assigns the handler', `(fn) => { listener = fn; return () => {}; },${SIB}`],
    ['pushes the handler (the selectionRestore shape)', `(fn: any) => { registered.push(fn); return () => {}; },${SIB}`],
    ['vi.fn wrapping a real capture', `vi.fn((fn) => { listener = fn; }),${SIB}`],
    ['rest parameter actually used', `(...args) => { seen.push(args); },${SIB}`],
    ['async arrow that captures', `async (fn) => { listener = fn; },${SIB}`],
    ['function keyword that captures', `function (fn) { listener = fn; return () => {}; },${SIB}`],
    ['parenthesised type, parameter used', `(fn: (a: A, b: B) => void) => { listener = fn; },${SIB}`],
    ['default parameter, used', `(fn = noop) => { listener = fn; },${SIB}`],
    // #1241: the text body ended at the `}` inside the string, before the capture.
    ['captures after a string brace', `(fn) => { log('}'); listener = fn; },${SIB}`],
    ['concise body that stores it', `(fn) => void registered.push(fn),${SIB}`],
  ];

  it.each(NO_OP)('reads %s as NOT capturing — the handler is dropped', (_label, expr) => {
    expect(capturesHandlerText(expr)).not.toBe(true);
  });

  it.each(CAPTURES)('reads %s as capturing — a test can invoke the real handler', (_label, expr) => {
    expect(capturesHandlerText(expr)).toBe(true);
  });

  it('an unrecognised shape is NOT read as capturing (fail loud, never assume the safe answer)', () => {
    // A property shorthand referencing a variable declared above the mock — focusManager.test.ts's
    // shape. The value cannot be read from the factory, so it must not be credited.
    expect(capturesHandlerText('someHandlerDeclaredAbove,')).not.toBe(true);
  });

  it('a destructured parameter is not credited (it names nothing this can check)', () => {
    expect(capturesHandlerText(`({ fn }) => () => {},${SIB}`)).not.toBe(true);
  });
});

/**
 * The tripwire's own instrument check — `assertScanIsSane` for this half.
 *
 * ⚠️ Without it, `SWALLOWED` fails SILENT and GREEN. Replacing `WORLD_MODULE` with a regex that
 * matches nothing — or renaming `runtime/core/ecs/world.ts`, or a mock written
 * `vi.mock(worldPath, …)` with a variable — empties the set, and every assertion built on it passes
 * vacuously while the "stops the class coming back" half of this guard is simply gone. The BASELINE
 * half has intrinsic non-vacuity (an empty corpus throws on `repoFiles`' floor); this half has none
 * except these pins. **Deliberately NOT asserting `SWALLOWED.size > 0`** — that number legitimately
 * falls to zero as the repo is fixed, and pinning non-vacuity to the defect surviving is the exact
 * mistake this file was rewritten to undo.
 */
describe('swallowsWorldSwap — the instrument still detects a swallow', () => {
  const mock = (body: string) =>
    `vi.mock('../../src/runtime/core/ecs/world', () => ({${body}}));`;

  it('detects a bare no-op', () => {
    expect(swallowsWorldSwap(mock(' onWorldSwap: vi.fn(), getCurrentWorld: vi.fn(),'))).toBe(true);
  });

  it('detects an ignored parameter beside a vi.fn sibling', () => {
    expect(swallowsWorldSwap(mock(' onWorldSwap: (fn: () => void) => () => {}, getCurrentWorld: vi.fn(),'))).toBe(true);
  });

  it('detects an OMITTED key — the most complete swallow of the three', () => {
    expect(swallowsWorldSwap(mock(' getCurrentWorld: vi.fn(), findEntityById: vi.fn(),'))).toBe(true);
  });

  it('detects a property shorthand', () => {
    expect(swallowsWorldSwap(mock(' onWorldSwap, getCurrentWorld: vi.fn(),'))).toBe(true);
  });

  it('does NOT fire on a capturing mock', () => {
    expect(swallowsWorldSwap(mock(' onWorldSwap: (fn) => { listener = fn; return () => {}; },'))).toBe(false);
  });

  it('does NOT fire on an importOriginal partial mock — but does on one that overrides onWorldSwap with a no-op', () => {
    expect(swallowsWorldSwap(
      "vi.mock('../../src/runtime/core/ecs/world', async (importOriginal) => ({ ...(await importOriginal()), getCurrentWorld: vi.fn() }));",
    )).toBe(false);
    // This expectation was `false` until #1241's close-out review: the key after the spread IS the export.
    expect(swallowsWorldSwap(
      "vi.mock('../../src/runtime/core/ecs/world', async (importOriginal) => ({ ...(await importOriginal()), onWorldSwap: vi.fn() }));",
    )).toBe(true);
  });

  it('reads the factory as a node, not as text (#1241)', () => {
    const W = "'../../src/runtime/core/ecs/world'";
    // Swallows the text reader passed: the loader NAMED in a string, a loader declared and never
    // called, a loader called only inside a lazy member, and an automock with no factory at all.
    expect(swallowsWorldSwap(`vi.mock(${W}, () => ({ hint: 'importOriginal', onWorldSwap: vi.fn() }));`)).toBe(true);
    expect(swallowsWorldSwap(`vi.mock(${W}, (importOriginal) => ({ onWorldSwap: vi.fn() }));`)).toBe(true);
    expect(swallowsWorldSwap(`vi.mock(${W}, (orig) => ({ lazy: () => orig(), onWorldSwap: vi.fn() }));`)).toBe(true);
    expect(swallowsWorldSwap(`vi.mock(${W});`)).toBe(true);
    // A block-bodied factory: every return is the module, and one that drops the key swallows.
    expect(swallowsWorldSwap(`vi.mock(${W}, () => { if (x) return { onWorldSwap: (fn) => { l = fn; } }; return { getCurrentWorld: vi.fn() }; });`)).toBe(true);
    expect(swallowsWorldSwap(`vi.doMock(${W}, () => { const cap = 1; return { onWorldSwap: (fn) => { l = fn; } }; });`)).toBe(false);
    // Not swallows the text reader flagged: a partial mock through `vi.importActual`, and a capturing
    // METHOD (`onWorldSwap(fn) {…}` has no `onWorldSwap:` to find).
    expect(swallowsWorldSwap(`vi.mock(${W}, async () => ({ ...(await vi.importActual(${W})), getCurrentWorld: vi.fn() }));`)).toBe(false);
    // …unless a key AFTER the spread overrides `onWorldSwap` with a no-op — every loader spelling.
    expect(swallowsWorldSwap(`vi.mock(${W}, async () => ({ ...(await vi.importActual(${W})), onWorldSwap: vi.fn() }));`)).toBe(true);
    expect(swallowsWorldSwap(`vi.mock(${W}, async () => { const a = await vi.importActual(${W}); return { ...a, onWorldSwap: vi.fn() }; });`)).toBe(true);
    expect(swallowsWorldSwap(`vi.mock(${W}, async (orig) => ({ ...(await orig()), onWorldSwap: vi.fn() }));`)).toBe(true);
    expect(swallowsWorldSwap(`vi.mock(${W}, async (importOriginal) => ({ ...(await importOriginal()), onWorldSwap: () => {} }));`)).toBe(true);
    // An override that captures (hierarchyReveal's shape) is fine, and a key BEFORE the spread is overwritten by it.
    expect(swallowsWorldSwap(`vi.mock(${W}, async (orig) => ({ ...(await orig()), onWorldSwap: (fn) => { hooks.push(fn); } }));`)).toBe(false);
    expect(swallowsWorldSwap(`vi.mock(${W}, async (orig) => ({ onWorldSwap: vi.fn(), ...(await orig()) }));`)).toBe(false);
    // A method override is an override too.
    expect(swallowsWorldSwap(`vi.mock(${W}, async (orig) => ({ ...(await orig()), onWorldSwap() {} }));`)).toBe(true);
    // Handing the original on is not a swallow — the repo's `{ ...actual, X: vi.fn(actual.X) }` spy idiom.
    expect(swallowsWorldSwap(`vi.mock(${W}, async (orig) => { const a = await orig(); return { ...a, onWorldSwap: vi.fn(a.onWorldSwap) }; });`)).toBe(false);
    expect(swallowsWorldSwap(`vi.mock(${W}, async (orig) => { const a = await orig(); return { ...a, onWorldSwap: a.onWorldSwap }; });`)).toBe(false);
    // …but only when the receiver IS the loaded original: a hoisted spy object or a fake is not.
    expect(swallowsWorldSwap(`const mocks = vi.hoisted(() => ({ onWorldSwap: vi.fn() }));\nvi.mock(${W}, async (orig) => ({ ...(await orig()), onWorldSwap: mocks.onWorldSwap }));`)).toBe(true);
    expect(swallowsWorldSwap(`vi.mock(${W}, async (orig) => ({ ...(await orig()), onWorldSwap: vi.fn(mocks.onWorldSwap) }));`)).toBe(true);
    expect(swallowsWorldSwap(`vi.mock(${W}, async () => { const a = await vi.importActual(${W}); return { ...a, onWorldSwap: vi.fn(a['onWorldSwap']) }; });`)).toBe(false);
    // A spread of anything but the original is not "the original survives".
    expect(swallowsWorldSwap(`vi.mock(${W}, async (orig) => { const a = await orig(); return { ...stubs, findEntityById: a.findEntityById }; });`)).toBe(true);
    expect(swallowsWorldSwap(`vi.mock(${W}, async (orig) => { const a = await orig(); return { ...a, ...stubs }; });`)).toBe(true);
    // A partial factory whose module this cannot read, or that spreads nothing, is not credited.
    expect(swallowsWorldSwap(`vi.mock(${W}, async (orig) => { const mod = { ...(await orig()), onWorldSwap: vi.fn() }; return mod; });`)).toBe(true);
    expect(swallowsWorldSwap(`vi.mock(${W}, async (orig) => Object.assign({}, await orig(), { onWorldSwap: vi.fn() }));`)).toBe(true);
    expect(swallowsWorldSwap(`vi.mock(${W}, async (orig) => { const a = await orig(); return { getCurrentWorld: a.getCurrentWorld }; });`)).toBe(true);
    expect(swallowsWorldSwap(`vi.mock(${W}, () => ({ onWorldSwap(fn) { listener = fn; } }));`)).toBe(false);
    expect(swallowsWorldSwap(`vi.mock(${W}, () => ({ onWorldSwap(fn) { return () => {}; } }));`)).toBe(true);
    // A factory it cannot read is not credited.
    expect(swallowsWorldSwap(`vi.mock(${W}, factory);`)).toBe(true);
    expect(swallowsWorldSwap(`vi.mock(${W}, () => makeWorldMock());`)).toBe(true);
    // A mock written in a STRING is not a mock — this very file's fixtures read as swallows to the text.
    expect(swallowsWorldSwap(`const s = "vi.mock(${W}, () => ({}))";`)).toBe(false);
  });

  it('pins WORLD_MODULE itself — an unrelated module mocked the same way is not a swallow', () => {
    // If WORLD_MODULE stopped matching the real world module, the four positive pins above go red
    // rather than this file going quietly green.
    expect(swallowsWorldSwap(
      "vi.mock('../../src/runtime/ui/uiValues', () => ({ onWorldSwap: vi.fn() }));",
    )).toBe(false);
  });
});

describe('world-swap teardowns keep a test that can fail, and a new swallow is flagged (#838)', () => {
  it('the scan found the producers and the suites (sanity: a pass means something)', () => {
    // Deliberately NOT asserting anything about SWALLOWED — that set legitimately shrinks to zero
    // as the repo is fixed, and pinning non-vacuity to it is what made the first version of this
    // guard go red exactly when the codebase became clean.
    expect(PRODUCERS.size, 'no `onWorldSwap(` producers found — the scan or the roots are wrong').toBeGreaterThan(20);
    expect(TESTS.length, 'no test files found — the roots or the .test glob are wrong').toBeGreaterThan(200);
    expect(Object.keys(BASELINE).length, 'BASELINE is empty — the ratchet protects nothing').toBeGreaterThan(5);
  });

  it('the marker is the one the reference fixes already use', () => {
    // If someone renames those describe blocks, this guard silently stops recognising the very
    // tests it points people at. Pin the phrase to the files that established it.
    for (const rel of [
      'engine/packages/modoki/tests/runtime/materialInstanceSystem.test.ts',
      'engine/packages/modoki/tests/runtime/materialInstanceClones.test.ts',
    ]) {
      const { code } = readScannedSource(path.join(REPO, rel));
      expect(WIRING_MARKER.test(code), `${rel}: the '#738 world-swap wiring' describe block is gone `
        + 'or renamed — this guard keys on that phrase, so it would stop recognising covered '
        + 'producers. Restore the phrase, or update WIRING_MARKER and every block using it.').toBe(true);
    }
  });

  it('every BASELINE producer still has its wiring test, in the named file', () => {
    const broken: string[] = [];
    for (const [producer, coverRel] of Object.entries(BASELINE)) {
      if (!fs.existsSync(path.join(REPO, producer))) continue; // handled by the stale-entry test
      const cover = TEST_BY_REL.get(coverRel);
      if (!cover) { broken.push(`${producer}  <- covering test MISSING: ${coverRel}`); continue; }
      if (!WIRING_MARKER.test(cover.code)) {
        broken.push(`${producer}  <- ${coverRel} no longer has a 'world-swap wiring' block`);
        continue;
      }
      if (!importedModules(cover.rel, cover.code).has(moduleKey(producer))) {
        broken.push(`${producer}  <- ${coverRel} no longer VALUE-imports it (a type-only import `
          + 'does not exercise the module)');
      }
    }
    expect(
      broken,
      'A world-swap wiring test named in BASELINE is gone, renamed, or no longer reaches its '
        + 'producer. These tests are the only thing proving each teardown actually runs on a swap — '
        + 'deleting one silently restores the defect the registration exists to prevent, and the '
        + 'suite goes green either way.\n\n'
        + 'Restore the test. Remove the BASELINE entry ONLY if the producer no longer registers an '
        + '`onWorldSwap(...)` teardown at all.',
    ).toEqual([]);
  });

  it('a producer whose teardown a test swallows is in BASELINE', () => {
    const unprotected = [...SWALLOWED.entries()]
      .filter(([p]) => !(p in BASELINE))
      .map(([p, tests]) => `${p}  <- swallowed by: ${tests.join(', ')}`);

    expect(
      unprotected,
      'These modules register an `onWorldSwap(...)` teardown, and a test mocks the world module in '
        + 'a way that drops that registration (a no-op, a shorthand, or omitting the key), and no '
        + 'test covers the wiring. The silent symptom: the teardown is exercised by nothing, so '
        + 'deleting the registration line leaves the suite green while the per-scene state it '
        + 'releases leaks across a scene swap in production.\n\n'
        + 'Fix it by adding ONE falsifiable test for the PRODUCER — not one per suite that mocks it '
        + '— inside a `describe` titled with "world-swap wiring", then add the producer and that '
        + 'file to BASELINE. Two shapes work:\n'
        + '  (A) REAL SWAP — `setCurrentWorld(createWorld())`. Only if the suite can drop its mock '
        + 'of `core/ecs/world` entirely; a wholesale mock severs the real listener Set and a swap '
        + 'fires nothing. See materialInstanceClones.test.ts.\n'
        + '  (B) CAPTURE-AND-INVOKE — the mock must STORE the handler and the test must CALL it '
        + '(`expect(listener).not.toBeNull()` first). ⚠️ Declaring a parameter and ignoring it is '
        + 'still a no-op and is still flagged. See editor/store/selectionRestore.test.ts.\n\n'
        + 'Then MUTATION-CHECK it: delete the `onWorldSwap(...)` line in the source, confirm the '
        + 'test goes red, restore. A test that cannot fail is the defect being fixed here. Full '
        + 'conventions: docs/falsifiable-tests.md.',
    ).toEqual([]);
  });

  it('BASELINE has no stale entries', () => {
    const stale: string[] = [];
    for (const producer of Object.keys(BASELINE)) {
      if (!fs.existsSync(path.join(REPO, producer))) {
        stale.push(`${producer} (BASELINE) — file is gone`);
      } else if (!PRODUCERS.has(moduleKey(producer))) {
        stale.push(`${producer} (BASELINE) — no longer registers an onWorldSwap teardown`);
      }
    }
    expect(stale, 'These entries no longer describe reality — the producer was deleted, its '
      + 'teardown was removed, or the mock that swallowed it is gone. A stale entry hides the next '
      + 'real hit behind a name that matches. Delete them.').toEqual([]);
  });
});
