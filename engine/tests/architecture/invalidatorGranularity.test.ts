/**
 * Every function wired into `ASSET_CACHE_INVALIDATORS` (agentBridge.ts) must actually USE the
 * path/guid argument it's handed to evict PER-KEY — not delegate to a wholesale clear (#852).
 *
 * `invalidatorsAreReachable.test.ts` (this file's sibling) proves every invalidator has a real
 * caller; it says nothing about GRANULARITY. `shader` passed that guard for months while
 * `invalidateShader` was `clearSpriteMaterialCache() + invalidatePixiShaderProgram(manifestPath)`
 * — reachable, wired, and still wrong: ANY `.shader.json` edit dropped every OTHER compiled 2D
 * material program in the scene, flashing every material entity's fallback sprite for a frame.
 * This guard encodes the actual invariant so a NEW invalidator (or a regression of `shader`
 * itself) that is only ever wholesale can't pass silently the way `shader` did.
 *
 * ⚠️ **This is a SOURCE-INSPECTION guard, not a behavioural one** — the brief for #852 asked for
 * behavioural-if-achievable, but the 8 wired invalidators span 7 differently-shaped cache modules
 * (GUID-keyed vs path-keyed, some needing an async fetch mock, one — `invalidateMaterial` — with
 * no `resolveRef`-style helper at all), and bespoke per-module setup for a REGRESSION guard is
 * disproportionate to what it buys: the actual behaviour of each cache already has its own unit
 * suite (`spriteMaterialCache.test.ts` §"invalidateShader (#852 per-key)" covers this exact
 * cache's behaviour). What this guard adds is durable, cheap coverage that a FUTURE invalidator —
 * for this cache or a new one — doesn't quietly regress to wholesale-only without any suite
 * noticing, which a per-module behavioural test would only catch for the module it was written
 * against.
 *
 * ⚠️ **A `createTeardownToken` has TWO halves, and checking only one is how this recurred THREE
 * times.** #487 fixed five sites that bumped NEITHER half (undershoot: a stale in-flight load
 * re-caches itself on top of a fresh re-import) and cited two sites that call `invalidateAll()`
 * (overshoot: superseding every OTHER in-flight load) as "the correct precedent" — without
 * noticing overshoot is itself a bug, just a different one. #852 then found `invalidateShader`
 * doing exactly that. #856 swept the rest of the overshoot sites; #863 found five MORE undershoot
 * sites, because the guard #852 asked for (below) only ever checked for per-key evidence, never
 * for a wholesale call sitting right next to it. The second `describe` block below is the fix for
 * that pattern: every teardown-backed invalidator is held to BOTH directions at once — call
 * `.invalidateKey(`, never call `.invalidateAll(` — not just whichever direction a given incident
 * happened to be about.
 *
 * What this CANNOT catch (be honest about the gap, not silent about it):
 *  - Whether the module's LOADER captures with the SAME key the invalidator bumps. A keyless
 *    `capture()` ignores `keyGenerations` entirely (`runtime/core/liveness.ts`), so a module can
 *    satisfy every check below and still have a dead mechanism — this repo's dominant defect
 *    class. Hand-checked 2026-09-07 during #856/#863's close-out: all of audio, fontAtlas, font,
 *    model, material, environment, prefab and rigged capture with a matching key today. Closing
 *    this properly needs the capture site paired to the invalidator, which is a behavioural check,
 *    not a source scan.
 *  - A function whose `.delete(`/`.invalidateKey(` call is genuinely there but keyed on something
 *    OTHER than its own argument (a hardcoded key, or an unrelated map/key it deletes as a red
 *    herring while the REAL eviction still routes through a wholesale clear elsewhere in the body).
 *  - An invalidator wired into the table but defined outside `runtime/loaders/*.ts` — reported as a
 *    violation (fail-SAFE direction: it shows up as "not found", not as a silent pass).
 * A behavioural, table-driven check that actually exercises each cache would close these gaps; if
 * a future change to this guard can add that for a given cache, prefer it over extending the source scan.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';
import { assertExemptionLedger } from '@modoki/engine/testing/exemptionLedger';
import { calleeName, findNodes, parseSource, ts, unwrapValue, variablesNamed } from '@modoki/engine/testing/sourceAst';

const REPO = path.resolve(__dirname, '../../..');
const LOADERS_DIR = path.join(REPO, 'engine/packages/modoki/src/runtime/loaders');
const AGENT_BRIDGE = path.join(REPO, 'engine/app/debug/agentBridge.ts');

// ⚠️ **Read through the parser (#1195).** This file used to cut the table from `const ASSET_CACHE_INVALIDATORS`
// to the first `'};'`, find functions with `/export function (invalidate…)\s*\((…)\)/`, and slice each body
// by counting parens and then braces — so a `{` or `)` inside a string or a destructured parameter moved the
// end, and an `export const invalidateX = (…) =>` was not a function at all.

/** An exported invalidator: its name, and the function node. */
interface Invalidator { name: string; fn: ts.FunctionLikeDeclaration & { body: ts.ConciseBody } }

/** Every EXPORTED `invalidate<Something>` function in `sf` — an `export function`, or an `export const` bound to
 *  an arrow or function expression. */
function exportedInvalidators(sf: ts.SourceFile): Invalidator[] {
  const isExported = (n: ts.Node) => ts.canHaveModifiers(n) && !!ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  return sf.statements.flatMap((st): Invalidator[] => {
    if (ts.isFunctionDeclaration(st) && st.name && st.body && isExported(st)) return [{ name: st.name.text, fn: st as Invalidator['fn'] }];
    if (ts.isVariableStatement(st) && isExported(st)) {
      return st.declarationList.declarations.flatMap((d) => {
        const init = d.initializer && unwrapValue(d.initializer);
        return ts.isIdentifier(d.name) && init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
          ? [{ name: d.name.text, fn: init as Invalidator['fn'] }] : [];
      });
    }
    return [];
  }).filter((inv) => /^invalidate[A-Za-z0-9]+$/.test(inv.name));
}

/** The VALUE of each `ASSET_CACHE_INVALIDATORS` entry — a plain name, or `<key: text>` for any other shape, so a
 *  wrapper arrow can neither pass as a wired name nor be skipped. Same reader as invalidatorsAreReachable.test.ts's
 *  (duplicated rather than imported — architecture guards in this directory are each self-contained). */
function invalidatorTableValues(sf: ts.SourceFile): string[] {
  const decls = variablesNamed(sf, 'ASSET_CACHE_INVALIDATORS');
  if (decls.length !== 1 || !decls[0]!.initializer) throw new Error('could not find one "const ASSET_CACHE_INVALIDATORS = …" — did it move or get renamed?');
  const table = unwrapValue(decls[0]!.initializer);
  if (!ts.isObjectLiteralExpression(table)) throw new Error('ASSET_CACHE_INVALIDATORS is no longer an object literal — read its new shape');
  return table.properties.map((p) => {
    if (ts.isShorthandPropertyAssignment(p)) return p.name.text;
    if (ts.isPropertyAssignment(p) && ts.isIdentifier(unwrapValue(p.initializer))) return (unwrapValue(p.initializer) as ts.Identifier).text;
    return `<${p.getText().replace(/\s+/g, ' ')}>`;
  });
}

/** Every exported invalidator under `runtime/loaders/*.ts`, by name, with its file — all 8 wired invalidators live
 *  in this one directory today; a future one defined elsewhere reports as "not found", which is a violation, not a
 *  pass. Parsed from comment-blanked code, so nothing in a comment is a node. */
function scanLoaderFunctions(): Map<string, { file: string; fn: Invalidator['fn'] }> {
  const out = new Map<string, { file: string; fn: Invalidator['fn'] }>();
  for (const entry of fs.readdirSync(LOADERS_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    const sf = parseSource(readScannedSource(path.join(LOADERS_DIR, entry.name)).code, entry.name);
    for (const { name, fn } of exportedInvalidators(sf)) out.set(name, { file: entry.name, fn });
  }
  return out;
}

/** The member calls `fn`'s own body makes by one of `names` — `programs.delete(guid)`, `liveness.invalidateKey(p)`. */
function memberCalls(fn: Invalidator['fn'], ...names: string[]): string[] {
  return findNodes(fn.body, ts.isCallExpression)
    .filter((c) => ts.isPropertyAccessExpression(c.expression) && names.includes(calleeName(c) ?? ''))
    .map((c) => calleeName(c)!);
}

/** Evidence the function's OWN body evicts by key: a `.delete(…)` (the Map/Set idiom every one of these caches
 *  uses — `programs.delete(guid)`, `materialCache.delete(matPath)`, …) or an `.invalidateKey(…)` (the
 *  `createTeardownToken<string>()` idiom most of them layer on top). Absence of BOTH means the body does nothing
 *  but delegate elsewhere — in every real case found so far, a bare wholesale `clear*Cache()` that drops every
 *  OTHER entry too. */
function evictsPerKey(fn: Invalidator['fn']): boolean {
  return memberCalls(fn, 'delete', 'invalidateKey').length > 0;
}

describe('every ASSET_CACHE_INVALIDATORS entry evicts per-key, not wholesale (#852)', () => {
  const wired = invalidatorTableValues(parseSource(readScannedSource(AGENT_BRIDGE).code, 'agentBridge.ts'));
  const loaderFns = scanLoaderFunctions();

  it('found a plausible number of wired invalidators (sanity: the parse works, so a pass means something)', () => {
    expect(wired.length).toBeGreaterThan(5);
  });

  it("every wired invalidator's own body shows per-key eviction evidence", () => {
    const violators: string[] = [];
    for (const name of wired) {
      const found = loaderFns.get(name);
      if (!found) {
        violators.push(
          `${name}: no exported function ${name} found under runtime/loaders/ — this guard only ` +
          'scans that directory; if it now lives elsewhere, this check needs updating, not silencing.',
        );
        continue;
      }
      if (!evictsPerKey(found.fn)) {
        violators.push(
          `${name} (${found.file}): body has no ".delete(" or ".invalidateKey(" call of its own — it ` +
          'can only be delegating to a wholesale clear, which drops every unrelated cache entry for ' +
          'an edit to just one of them (#852: this was invalidateShader\'s exact defect).',
        );
      }
    }
    expect(violators, violators.join('\n')).toEqual([]);
  });
});

/** A module CONSTRUCTS its own `createTeardownToken` — CALLS it, in any position (a declaration, `=`/`??=`, a
 *  class field, a parameter default) — rather than merely importing the name or the type. That construction is
 *  the precondition for either failure direction existing at all: a module with no token can be neither an
 *  overshoot nor an undershoot. From the parser, so a docblock mentioning the call is not one.
 *
 *  ⚠️ Any call, not "a declaration's initializer or a plain `=`" (#1195 close-out review): that first version
 *  dropped a `liveness ??= createTeardownToken()` module out of the population, and with it both checks below —
 *  the text regex (`= createTeardownToken(`) had counted it, and class fields already use the form elsewhere. */
function constructsTeardownToken(sf: ts.SourceFile): boolean {
  return findNodes(sf, ts.isCallExpression).some((c) => calleeName(c) === 'createTeardownToken');
}

/** Every exported `invalidate<Something>(<at least one param>)` (a function or a const-bound arrow) in a `runtime/loaders/*.ts`
 *  module that constructs its own `createTeardownToken` — the FULL population, not just the ~8
 *  wired into `ASSET_CACHE_INVALIDATORS` above. A zero-param `invalidateXxx()` is excluded on
 *  purpose: with no key to bump selectively it can only be (or delegate to) a wholesale clear by
 *  construction, so it isn't the shape this check is about — none exist under this directory
 *  today; a hypothetical future one is a different question than the one this file answers.
 *  Comment-blanked per file, same as `scanLoaderFunctions` above and for the same reason (#419):
 *  a naive scan over raw source reports the OPPOSITE verdict for six of these — their own comments
 *  explain, in the literal string `invalidateAll()`, why the body does NOT call it. (Checked
 *  2026-09-07: `readScannedSource` itself is sound here — it preserves `capture(path)`,
 *  `invalidateKey(path)` and the teardown's `invalidateAll()` in `fontLoader.ts` verbatim. A
 *  close-out sweep reported the opposite; that was ITS OWN hand-rolled blanker, not this one.)
 *
 *  ⚠️ Scans `runtime/loaders/` AND `runtime/rendering/`, matching the SCAN_DIRS of the sibling
 *  guard `invalidatorsAreReachable.test.ts` — which was widened to both by #842 precisely because
 *  the key-taking `invalidatePixiShaderProgram` lives in `rendering/`. Scanning one directory here
 *  while the sibling scans two would be a claim this defect can only exist in `loaders/`, and
 *  nothing makes that true. (`invalidatePixiShaderProgram` is not REPORTED today: its module
 *  constructs no teardown token, because its `programCache` is keyed on shader CONTENT — a stale
 *  re-seat lands under a key nothing will compute again. The widening is about the next
 *  token-backed invalidator someone adds there, not about that one.) */
const INVALIDATOR_SCAN_DIRS = [
  LOADERS_DIR,
  path.join(REPO, 'engine/packages/modoki/src/runtime/rendering'),
];

/** The key-taking exported invalidators of ONE module, when that module constructs its own teardown token. */
function teardownBackedInvalidators(sf: ts.SourceFile): Invalidator[] {
  if (!constructsTeardownToken(sf)) return [];
  return exportedInvalidators(sf).filter(({ fn }) => fn.parameters.length > 0); // zero-param — see docblock above
}

function scanTeardownBackedInvalidators(): { name: string; file: string; fn: Invalidator['fn'] }[] {
  const out: { name: string; file: string; fn: Invalidator['fn'] }[] = [];
  for (const dir of INVALIDATOR_SCAN_DIRS) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      const sf = parseSource(readScannedSource(path.join(dir, entry.name)).code, entry.name);
      for (const { name, fn } of teardownBackedInvalidators(sf)) out.push({ name, file: entry.name, fn });
    }
  }
  return out;
}

/** Invalidators sanctioned to skip the `.invalidateKey(` requirement below, because they are
 *  correct by a DIFFERENT mechanism than a teardown-token key bump. ⚠️ **This list is a licence to
 *  rot if it's ever treated as a place to silence a failure** — a new entry needs the same standard
 *  of proof as the one below: a named alternative mechanism, cited at file:line, not "this one is
 *  fine".
 *
 *  ⚠️ **It excuses the UNDERSHOOT rule only, and is keyed `file::name` (#1140).** It used to be a
 *  `Set` of names that `continue`d past BOTH checks — so an `invalidateTexture` that grew an
 *  `.invalidateAll(` (the #852/#856 overshoot) was pardoned by a reason that argues only about why no
 *  per-key bump is needed, and a same-named invalidator in another module inherited it too. One
 *  ledger per ban: the overshoot rule has no pardons at all. Its old self-pin (`toEqual(['invalidate
 *  Texture'])` plus "still found") is the ledger's over-blessed arm. */
const EXEMPT_FROM_PER_KEY_CHECK: ReadonlyArray<{ item: string; reason: string }> = [
  // `invalidateTexture` (textureResolver.ts): `loadTexture3D` inserts its cache entry into
  // `texCache` SYNCHRONOUSLY, before any `await` (`loadTexture3D`,
  // `texCache.set(key, entry)`), and every write that happens AFTER an await identity-checks
  // against the captured entry/texture instead of trusting a re-lookup by key
  // (`loadTexture3D`'s `.catch`: `if (texCache.get(key) === entry) texCache.delete(key);`; `releaseTexture3D`:
  // `if (entry.texture && entry.texture !== tex) return;`). A load that resolves after
  // `invalidateTexture` has evicted its key therefore has no path back into the map — there is no
  // stale-generation window for a key bump to close, which is exactly what `.invalidateKey(`
  // exists to do. `sharedTextureLiveness` (this module's token) is used here only via `.capture()`
  // for a different sequencing guarantee (racing `disposeAllSharedTextures`), never
  // `.invalidateKey(` or `.invalidateAll(`.
  { item: 'textureResolver.ts::invalidateTexture',
    reason: 'no stale-generation window: the cache entry is inserted synchronously and every post-await write identity-checks (see above)' },
];

describe('every teardown-backed loader invalidator evicts per-key AND never wholesale (#487 -> #852 -> #856/#863)', () => {
  const all = scanTeardownBackedInvalidators();

  it('found a plausible number of teardown-backed invalidators (sanity: a collapsed scan passes vacuously)', () => {
    // Floor, not a pin (see the guard's own docblock) — 16 exist today across 13 modules; a
    // legitimate new cache should only ever raise this, never need it lowered.
    expect(all.length).toBeGreaterThan(10);
  });

  it("every invalidator's own body calls .invalidateKey( — UNDERSHOOT (#863), pardoned only through EXEMPT_FROM_PER_KEY_CHECK", () => {
    assertExemptionLedger({
      label: 'EXEMPT_FROM_PER_KEY_CHECK in invalidatorGranularity',
      population: all
        .filter(({ fn }) => memberCalls(fn, 'invalidateKey').length === 0)
        .map(({ name, file }) => ({ item: `${file}::${name}`, site: `${name} (${file})` })),
      exempt: EXEMPT_FROM_PER_KEY_CHECK,
      floor: 1,
      fix: 'body never calls ".invalidateKey(" — UNDERSHOOT (#863): a stale in-flight load for this '
        + 'exact key that resolves after this eviction has nothing re-checking its liveness, so it '
        + 're-caches pre-invalidation bytes on top of whatever re-import follows.',
    });
  });

  it('no invalidator body calls .invalidateAll( — OVERSHOOT (#852/#856), with no pardons', () => {
    const violators = all
      .filter(({ fn }) => memberCalls(fn, 'invalidateAll').length > 0)
      .map(({ name, file }) => `${name} (${file}): body calls ".invalidateAll(" — OVERSHOOT (#852/#856): this `
        + 'supersedes every OTHER in-flight load in the module, not just the one keyed by this '
        + 'invalidator\'s own argument.');
    expect(violators, violators.join('\n')).toEqual([]);
  });
});

describe('the granularity readers see the unit, not a slice of text (#1195)', () => {
  it('reads each invalidator whole — a destructured parameter, a brace in a string, the const-arrow form', () => {
    const sf = parseSource([
      "const liveness = createTeardownToken<string>();",
      "export function invalidateA({ path }: { path: string }) { const t = '}'; cache.delete(path); liveness.invalidateKey(path); }",
      'export const invalidateB = (p: string): void => { clearAll(); invalidateKey(p); liveness.invalidateAll(); };',
      'export function invalidateC() { liveness.invalidateAll(); }',
      'export function invalidateD(p: string) { const inner = () => cache.delete(p); delete (cache as any)[p]; }',
      'function invalidateE(p: string) { liveness.invalidateAll(); }',
    ].join('\n'), 'probe.ts');
    const byName = new Map(exportedInvalidators(sf).map((i) => [i.name, i.fn]));
    expect([...byName.keys()]).toEqual(['invalidateA', 'invalidateB', 'invalidateC', 'invalidateD']);
    expect(evictsPerKey(byName.get('invalidateA')!)).toBe(true);
    expect(evictsPerKey(byName.get('invalidateB')!)).toBe(false);
    expect(memberCalls(byName.get('invalidateB')!, 'invalidateAll')).toEqual(['invalidateAll']);
    expect(memberCalls(byName.get('invalidateA')!, 'invalidateAll')).toEqual([]);
    // A `delete x[k]` OPERATOR is not a `.delete(` call; one in a nested closure still sits in the body.
    expect(memberCalls(byName.get('invalidateD')!, 'delete')).toEqual(['delete']);
    expect(evictsPerKey(byName.get('invalidateD')!)).toBe(true);
    // The zero-param one is not held to the key rules; the module's token is what makes the rest eligible.
    expect(teardownBackedInvalidators(sf).map((i) => i.name)).toEqual(['invalidateA', 'invalidateB', 'invalidateD']);
    expect(teardownBackedInvalidators(parseSource('export function invalidateX(p: string) { m.delete(p); }', 'nt.ts'))).toEqual([]);
  });

  it('counts a token only when the module CONSTRUCTS one', () => {
    expect(constructsTeardownToken(parseSource('let t: TeardownToken;\nt = createTeardownToken();', 'a.ts'))).toBe(true);
    expect(constructsTeardownToken(parseSource("import { createTeardownToken } from './l';\nconst doc = 'createTeardownToken()';", 'b.ts'))).toBe(false);
    expect(constructsTeardownToken(parseSource('const t = (createTeardownToken<string>() as Token);', 'c.ts'))).toBe(true);
    expect(constructsTeardownToken(parseSource('let t!: Token;\nt ??= createTeardownToken<string>();', 'd.ts'))).toBe(true);
    expect(constructsTeardownToken(parseSource('class C { private readonly liveness = createTeardownToken(); }', 'e.ts'))).toBe(true);
    expect(constructsTeardownToken(parseSource("import type { TeardownToken } from './l';\nlet t: TeardownToken;", 'f.ts'))).toBe(false);
  });

  it('never drops a table entry it cannot name', () => {
    expect(invalidatorTableValues(parseSource('const ASSET_CACHE_INVALIDATORS = { a: invalidateA, invalidateB, c: (p) => invalidateC(p) };', 'x.ts')))
      .toEqual(['invalidateA', 'invalidateB', '<c: (p) => invalidateC(p)>']);
  });
});
