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
};

/**
 * Producers whose teardown a test swallows and which owe NO wiring test, each with the reason
 * VERIFIED by reading the site — never on assumption. An entry here without one defeats the guard.
 */
const ALLOWLIST: Record<string, string> = {};

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

/**
 * The text between the parenthesis at `open` and its match. Strings are NOT blanked by the scanner
 * (only comments are), so an unmatched paren inside a string literal can truncate the slice —
 * measured as needing TWO or more before it bites, and no world-mock factory in the repo has that.
 * Capped so a pathological file cannot hang the run; the largest real factory is ~1.1 KB.
 */
function balanced(src: string, open: number): string {
  let depth = 0;
  const limit = Math.min(src.length, open + 8000);
  for (let i = open; i < limit; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return src.slice(open + 1, limit);
}

/**
 * Does this `onWorldSwap:` value CAPTURE the handler it is given, so a test can invoke it?
 *
 * ⚠️ **A parameter is not a capture — it must be USED.** `(_fn) => () => {}` declares a parameter
 * and drops it on the floor, which is a no-op wearing a capture's signature. An earlier version
 * asked only whether the parameter list was non-empty and read all four of
 * `(_fn) => () => {}` · `(fn: () => void) => () => {}` · `vi.fn((_fn) => () => {})` ·
 * `(...args) => () => {}` as capturing — and the guard's own failure message hands the reader that
 * exact signature, so writing it and forgetting the body was the cheapest way to silence it.
 *
 * `null` is an unrecognised shape (commonly a shorthand referencing a variable declared above).
 * Read as NOT capturing: a guard that cannot parse its subject must fail loud, not assume the safe
 * answer.
 */
/** Content between the brace at `open` and its match. */
function balancedBraces(src: string, open: number): string {
  let depth = 0;
  const limit = Math.min(src.length, open + 8000);
  for (let i = open; i < limit; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open + 1, i); }
  }
  return src.slice(open + 1, limit);
}

/** Split a parameter list on TOP-LEVEL commas, so `(a: Map<X, Y>, b)` is two params, not three. */
function splitTopLevel(params: string): string[] {
  const out: string[] = [];
  let depth = 0, last = 0;
  for (let i = 0; i < params.length; i++) {
    const c = params[i];
    if (c === '(' || c === '[' || c === '{' || c === '<') depth++;
    else if (c === ')' || c === ']' || c === '}' || c === '>') depth--;
    else if (c === ',' && depth === 0) { out.push(params.slice(last, i)); last = i + 1; }
  }
  out.push(params.slice(last));
  return out;
}

/**
 * A function's OWN body — never the rest of the object literal it sits in.
 *
 * ⚠️ This bound is the whole point. The body used to be `factory.slice(afterTheKey)`, i.e.
 * everything to the end of the mock factory, so a SIBLING key mentioning the parameter's name
 * satisfied the "is the parameter used?" check. Combined with `\b`, the `fn` inside the repo's
 * commonest sibling — `getCurrentWorld: vi.fn()` — made `onWorldSwap: (fn) => () => {}` read as a
 * capture. That is the same trap the parameter check was written to close, one layer down.
 */
function ownBody(rest: string): string {
  const lead = rest.length - rest.replace(/^\s*/, '').length;
  if (rest[lead] === '{') return balancedBraces(rest, lead);
  // Concise body: to the first TOP-LEVEL comma — the next property of the mock factory.
  const s = rest.slice(lead);
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { if (depth === 0) return s.slice(0, i); depth--; }
    else if (c === ',' && depth === 0) return s.slice(0, i);
  }
  return s;
}

function capturesHandler(expr: string): boolean | null {
  let e = expr.trim().replace(/^async\s+/, '');

  const viFn = /^vi\.fn\s*\(/.exec(e);
  if (viFn) {
    const inner = balanced(e, viFn[0].length - 1).trim();
    if (inner === '') return false; // `vi.fn()` — no handler at all
    e = inner.replace(/^async\s+/, '');
  }

  const usesParam = (params: string, body: string): boolean => {
    // `(?:\.\.\.)?` — an OPTIONAL rest prefix. Written `\.{3}?` once, which is exactly-three-dots
    // (lazily), so every plain `(fn)` failed to match, names came back empty, and every capturing
    // mock in the repo was read as a no-op. The guard flagged selectionRestore.test.ts, which is
    // the file it points people at as the reference for capturing correctly.
    const names = splitTopLevel(params)
      .map((p) => /^\s*(?:\.\.\.)?\s*([A-Za-z_$][\w$]*)/.exec(p)?.[1])
      .filter((n): n is string => Boolean(n));
    if (names.length === 0) return false; // destructured or empty — nothing nameable to credit
    // ⚠️ `(?<![.\w$])` excludes a PROPERTY ACCESS, so `vi.fn(` no longer satisfies a parameter
    // named `fn`. See ownBody above for the other half of that same defect.
    return names.some((n) => new RegExp(`(?<![.\\w$])${n}(?![\\w$])`).test(body));
  };

  // Arrow with a parenthesised parameter list. `balanced` rather than `[^)]*`, so a parameter
  // carrying its own parens — `(fn: (a: A, b: B) => void)` — is read instead of falling through.
  if (e.startsWith('(')) {
    const params = balanced(e, 0);
    const after = e.slice(params.length + 2);
    const arrow = /^\s*(?::[^=]*?)?=>/.exec(after);
    if (arrow) return usesParam(params, ownBody(after.slice(arrow[0].length)));
  }
  let m = /^([A-Za-z_$][\w$]*)\s*=>/.exec(e);
  if (m) return usesParam(m[1], ownBody(e.slice(m[0].length)));
  m = /^function\b[^(]*\(/.exec(e);
  if (m) {
    const params = balanced(e, m[0].length - 1);
    return usesParam(params, ownBody(e.slice(m[0].length + params.length + 1)));
  }

  return null;
}

/** Module specifiers the file reaches for — STATIC and DYNAMIC, `import type` statements dropped. */
function importedSpecifiers(code: string): string[] {
  // A type-only import does not exercise the module, so it must not count as reaching a producer.
  // ⚠️ LINE-anchored, not `[^;]*;`. The semicolon form ran to the next `;` ANYWHERE in the file, so
  // a semicolon-less `import type { A } from './types'` (the repo writes those) swallowed the real
  // value imports on the lines below it — silently un-attributing every producer in the file.
  const valueCode = code.replace(/^[^\S\n]*import\s+type\b[^\n]*$/gm, ' ');
  const out: string[] = [];
  for (const m of valueCode.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) out.push(m[1]);
  for (const m of valueCode.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]);
  return out;
}

/** Repo-relative, extension-less module keys for a file's relative VALUE imports. */
function importedModules(testRel: string, code: string): Set<string> {
  const dir = path.posix.dirname(testRel);
  const out = new Set<string>();
  for (const spec of importedSpecifiers(code)) {
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
 * listener Set survive — so it is never a swallow.
 */
function swallowsWorldSwap(code: string): boolean {
  const calls = [...code.matchAll(/\bvi\.(?:do)?[Mm]ock\s*\(\s*['"]([^'"]+)['"]\s*,/g)];
  for (const call of calls) {
    if (!WORLD_MODULE.test(call[1].replace(/\.tsx?$/, ''))) continue;

    const openParen = code.indexOf('(', call.index!);
    const factory = balanced(code, openParen);
    if (/importOriginal/.test(factory)) continue;

    const withValue = /\bonWorldSwap\s*:/.exec(factory);
    if (withValue) {
      if (capturesHandler(factory.slice(withValue.index + withValue[0].length)) !== true) return true;
      continue;
    }
    return true; // shorthand, or the key is absent entirely
  }
  return false;
}

const PRODUCERS = new Map<string, string>(); // moduleKey -> rel
for (const f of scannedFiles(PRODUCER_ROOTS, (rel) => !IS_TEST.test(rel), 400)) {
  // `worldRegistry.ts` DEFINES `onWorldSwap`; it does not register a teardown with it.
  if (!/\bonWorldSwap\s*\(/.test(f.code)) continue;
  if (/\bexport function onWorldSwap\s*\(/.test(f.code)) continue;
  PRODUCERS.set(moduleKey(f.rel), f.rel);
}

const TESTS = scannedFiles(TEST_ROOTS, (rel) => IS_TEST.test(rel), 200);
const TEST_BY_REL = new Map(TESTS.map((t) => [t.rel, t]));

const SWALLOWED = new Map<string, string[]>(); // producer rel -> test files that swallow it
for (const t of TESTS) {
  if (!swallowsWorldSwap(t.code)) continue;
  for (const k of importedModules(t.rel, t.code)) {
    const p = PRODUCERS.get(k);
    if (!p) continue;
    if (!SWALLOWED.has(p)) SWALLOWED.set(p, []);
    SWALLOWED.get(p)!.push(t.rel);
  }
}

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
 * ⚠️ **Each string carries a trailing sibling key, because that is what the parser is really fed.**
 * Production passes `factory.slice(afterTheKey)`, which runs to the end of the mock factory, not to
 * the end of the arrow. A table of bare expressions is green over exactly the bug that shipped:
 * `getCurrentWorld: vi.fn()` sitting after an ignored `fn` parameter satisfied the reference check
 * via the `fn` inside `vi.fn(`.
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
  ];

  it.each(NO_OP)('reads %s as NOT capturing — the handler is dropped', (_label, expr) => {
    expect(capturesHandler(expr)).not.toBe(true);
  });

  it.each(CAPTURES)('reads %s as capturing — a test can invoke the real handler', (_label, expr) => {
    expect(capturesHandler(expr)).toBe(true);
  });

  it('an unrecognised shape is NOT read as capturing (fail loud, never assume the safe answer)', () => {
    // A property shorthand referencing a variable declared above the mock — focusManager.test.ts's
    // shape. The value cannot be read from the factory, so it must not be credited.
    expect(capturesHandler('someHandlerDeclaredAbove,')).not.toBe(true);
  });

  it('a destructured parameter is not credited (it names nothing this can check)', () => {
    expect(capturesHandler(`({ fn }) => () => {},${SIB}`)).not.toBe(true);
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

  it('does NOT fire on an importOriginal partial mock', () => {
    expect(swallowsWorldSwap(
      "vi.mock('../../src/runtime/core/ecs/world', async (importOriginal) => ({ ...(await importOriginal()), onWorldSwap: vi.fn() }));",
    )).toBe(false);
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

  it('a producer whose teardown a test swallows is in BASELINE (or an explained allowlist)', () => {
    const unprotected = [...SWALLOWED.entries()]
      .filter(([p]) => !(p in BASELINE) && !(p in ALLOWLIST))
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
        + 'conventions: docs/falsifiable-tests.md.\n\n'
        + 'If a producer genuinely owes no wiring test, add it to ALLOWLIST with a reason you '
        + 'verified by reading the site.',
    ).toEqual([]);
  });

  it('BASELINE and ALLOWLIST have no stale entries', () => {
    const stale: string[] = [];
    for (const producer of Object.keys(BASELINE)) {
      if (!fs.existsSync(path.join(REPO, producer))) {
        stale.push(`${producer} (BASELINE) — file is gone`);
      } else if (!PRODUCERS.has(moduleKey(producer))) {
        stale.push(`${producer} (BASELINE) — no longer registers an onWorldSwap teardown`);
      }
    }
    for (const producer of Object.keys(ALLOWLIST)) {
      if (!SWALLOWED.has(producer)) stale.push(`${producer} (ALLOWLIST) — nothing swallows it now`);
    }
    expect(stale, 'These entries no longer describe reality — the producer was deleted, its '
      + 'teardown was removed, or the mock that swallowed it is gone. A stale entry hides the next '
      + 'real hit behind a name that matches. Delete them.').toEqual([]);
  });
});
