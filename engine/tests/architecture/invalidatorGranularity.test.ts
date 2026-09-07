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
 * What this CANNOT catch (be honest about the gap, not silent about it):
 *  - A function whose `.delete(`/`.invalidateKey(` call is genuinely there but keyed on something
 *    OTHER than its own argument (a hardcoded key, or an unrelated map/key it deletes as a red
 *    herring while the REAL eviction still routes through a wholesale clear elsewhere in the body).
 *  - A function that calls a per-key delete AND unconditionally ALSO wholesale-clears — this guard
 *    only checks for the PRESENCE of per-key evidence, not the ABSENCE of a wholesale call next to it.
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
