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
 * a future change to this guard can add that for a given cache, prefer it over extending the regex.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readScannedSource } from '@modoki/engine/testing';

const REPO = path.resolve(__dirname, '../../..');
const LOADERS_DIR = path.join(REPO, 'engine/packages/modoki/src/runtime/loaders');
const AGENT_BRIDGE = path.join(REPO, 'engine/app/debug/agentBridge.ts');

/** Identifiers used as VALUES in the `ASSET_CACHE_INVALIDATORS` object literal, e.g.
 *  `shader: invalidateShader,` → `invalidateShader`. Same slicing idiom as
 *  invalidatorsAreReachable.test.ts's `invalidatorTableValues` (duplicated rather than imported —
 *  architecture guards in this directory are each self-contained). */
function invalidatorTableValues(src: string): string[] {
  const start = src.indexOf('const ASSET_CACHE_INVALIDATORS');
  if (start === -1) throw new Error('could not find "const ASSET_CACHE_INVALIDATORS" — did it move or get renamed?');
  const table = src.slice(start);
  const body = table.slice(0, table.indexOf('};'));
  return [...body.matchAll(/:\s*(invalidate[A-Za-z0-9]+)\s*[,}]/g)].map((m) => m[1]);
}

/** Every `export function invalidate<Something>(` under `runtime/loaders/*.ts`, mapped to the
 *  defining file's comment-blanked `.code` (so a `.delete(`/`invalidateKey(` mentioned only in a
 *  COMMENT can't satisfy the check below) — all 8 wired invalidators live in this one directory
 *  today; a future one defined elsewhere reports as "not found", which is a violation, not a pass. */
function scanLoaderFunctions(): Map<string, { file: string; code: string }> {
  const out = new Map<string, { file: string; code: string }>();
  for (const entry of fs.readdirSync(LOADERS_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    const { code } = readScannedSource(path.join(LOADERS_DIR, entry.name));
    for (const m of code.matchAll(/export function (invalidate[A-Za-z0-9]+)\s*\(/g)) {
      out.set(m[1], { file: entry.name, code });
    }
  }
  return out;
}

/** Slice one function's body (braces balanced) out of a comment-blanked source string. Naive
 *  brace/paren counting — see this file's docblock for what that can't handle. Safe for the 8
 *  functions this guard actually scans: none of them destructure their parameter or embed an
 *  object/template literal in the body, so a plain depth counter never sees an unbalanced brace. */
function extractFunctionBody(code: string, name: string): string {
  const sigIdx = code.indexOf(`export function ${name}(`);
  if (sigIdx === -1) throw new Error(`extractFunctionBody: "export function ${name}(" not found — did it move?`);
  const parenStart = code.indexOf('(', sigIdx);
  let parenDepth = 1;
  let i = parenStart + 1;
  while (parenDepth > 0) {
    if (code[i] === '(') parenDepth++;
    else if (code[i] === ')') parenDepth--;
    i++;
  }
  const braceStart = code.indexOf('{', i);
  let braceDepth = 1;
  let j = braceStart + 1;
  while (braceDepth > 0 && j < code.length) {
    if (code[j] === '{') braceDepth++;
    else if (code[j] === '}') braceDepth--;
    j++;
  }
  return code.slice(braceStart, j);
}

/** Evidence the function's OWN body evicts by key: a `.delete(` (the Map/Set idiom every one of
 *  these caches uses — `programs.delete(guid)`, `materialCache.delete(matPath)`, …) or an
 *  `.invalidateKey(` (the `createTeardownToken<string>()` idiom most of them layer on top). Absence
 *  of BOTH means the body does nothing but delegate elsewhere — in every real case found so far,
 *  a bare wholesale `clear*Cache()` that drops every OTHER entry too. */
const PER_KEY_EVIDENCE = /\.(?:delete|invalidateKey)\(/;

describe('every ASSET_CACHE_INVALIDATORS entry evicts per-key, not wholesale (#852)', () => {
  const wired = invalidatorTableValues(readScannedSource(AGENT_BRIDGE).code);
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
          `${name}: no "export function ${name}(" found under runtime/loaders/ — this guard only ` +
          'scans that directory; if it now lives elsewhere, this check needs updating, not silencing.',
        );
        continue;
      }
      const body = extractFunctionBody(found.code, name);
      if (!PER_KEY_EVIDENCE.test(body)) {
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

/** A module CONSTRUCTS its own `createTeardownToken` — `= createTeardownToken(` — rather than
 *  merely importing the type. That construction is the precondition for either failure direction
 *  existing at all: a module with no token can be neither an overshoot nor an undershoot. Matched
 *  against comment-blanked code so a docblock mentioning the call (several of these modules have
 *  one, explaining the choice) can't satisfy it. */
const CONSTRUCTS_TEARDOWN_TOKEN = /=\s*createTeardownToken\s*(?:<[^>]*>)?\s*\(/;

/** Every `export function invalidate<Something>(<at least one param>)` in a `runtime/loaders/*.ts`
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

function scanTeardownBackedInvalidators(): { name: string; file: string; code: string }[] {
  const out: { name: string; file: string; code: string }[] = [];
  for (const dir of INVALIDATOR_SCAN_DIRS) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      const { code } = readScannedSource(path.join(dir, entry.name));
      if (!CONSTRUCTS_TEARDOWN_TOKEN.test(code)) continue;
      for (const m of code.matchAll(/export function (invalidate[A-Za-z0-9]+)\s*\(([^)]*)\)/g)) {
        if (m[2].trim() === '') continue; // zero-param — see docblock above
        out.push({ name: m[1], file: entry.name, code });
      }
    }
  }
  return out;
}

/** Invalidators sanctioned to skip the `.invalidateKey(` requirement below, because they are
 *  correct by a DIFFERENT mechanism than a teardown-token key bump. ⚠️ **This list is a licence to
 *  rot if it's ever treated as a place to silence a failure** — a new entry needs the same standard
 *  of proof as the one below: a named alternative mechanism, cited at file:line, not "this one is
 *  fine". The test below asserts this set is EXACTLY `['invalidateTexture']`, so adding (or
 *  removing) a member is a visible edit to THIS file, not a quiet change to a regex elsewhere. */
const EXEMPT_FROM_PER_KEY_CHECK: ReadonlySet<string> = new Set([
  // `invalidateTexture` (textureResolver.ts): `loadTexture3D` inserts its cache entry into
  // `texCache` SYNCHRONOUSLY, before any `await` (textureResolver.ts:510,
  // `texCache.set(key, entry)`), and every write that happens AFTER an await identity-checks
  // against the captured entry/texture instead of trusting a re-lookup by key
  // (textureResolver.ts:507, `if (texCache.get(key) === entry) texCache.delete(key);`; :538,
  // `if (entry.texture && entry.texture !== tex) return;`). A load that resolves after
  // `invalidateTexture` has evicted its key therefore has no path back into the map — there is no
  // stale-generation window for a key bump to close, which is exactly what `.invalidateKey(`
  // exists to do. `sharedTextureLiveness` (this module's token) is used here only via `.capture()`
  // for a different sequencing guarantee (racing `disposeAllSharedTextures`), never
  // `.invalidateKey(` or `.invalidateAll(`.
  'invalidateTexture',
]);

describe('every teardown-backed loader invalidator evicts per-key AND never wholesale (#487 -> #852 -> #856/#863)', () => {
  const all = scanTeardownBackedInvalidators();

  it('found a plausible number of teardown-backed invalidators (sanity: a collapsed scan passes vacuously)', () => {
    // Floor, not a pin (see the guard's own docblock) — 16 exist today across 13 modules; a
    // legitimate new cache should only ever raise this, never need it lowered.
    expect(all.length).toBeGreaterThan(10);
  });

  it('the sanctioned exemption set is exactly the expected one, and every exempted name is real', () => {
    expect([...EXEMPT_FROM_PER_KEY_CHECK].sort()).toEqual(['invalidateTexture']);
    const found = new Set(all.map((f) => f.name));
    for (const name of EXEMPT_FROM_PER_KEY_CHECK) {
      expect(found.has(name), `exempted name "${name}" was not found by the scan above — a rename ` +
        'or removal left this exemption pointing at nothing, silently exempting no one').toBe(true);
    }
  });

  it("every non-exempt invalidator's own body calls .invalidateKey( and never .invalidateAll(", () => {
    const violators: string[] = [];
    for (const { name, file, code } of all) {
      if (EXEMPT_FROM_PER_KEY_CHECK.has(name)) continue;
      const body = extractFunctionBody(code, name);
      if (!/\.invalidateKey\(/.test(body)) {
        violators.push(
          `${name} (${file}): body never calls ".invalidateKey(" — UNDERSHOOT (#863): a stale ` +
          'in-flight load for this exact key that resolves after this eviction has nothing ' +
          're-checking its liveness, so it re-caches pre-invalidation bytes on top of whatever ' +
          're-import follows.',
        );
      }
      if (/\.invalidateAll\(/.test(body)) {
        violators.push(
          `${name} (${file}): body calls ".invalidateAll(" — OVERSHOOT (#852/#856): this ` +
          'supersedes every OTHER in-flight load in the module, not just the one keyed by this ' +
          'invalidator\'s own argument.',
        );
      }
    }
    expect(violators, violators.join('\n')).toEqual([]);
  });
});
