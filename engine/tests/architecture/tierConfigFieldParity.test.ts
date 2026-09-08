/** The two hand-written descriptions of a quality tier must carry the SAME fields.
 *
 *  `TierRenderOverrides` (`runtime/rendering/qualityTier.ts`) is what the engine reads at render
 *  time. `TierOverridesConfig` (`engine/project-config.ts`) is the JSON-facing twin that describes
 *  the same block inside `project.config.json` for build-time consumers. **Nothing links them** —
 *  `TierOverridesConfig` is referenced by no cast and no assignment, so TypeScript cannot notice
 *  when one grows a field the other lacks, and no test compared them until this one.
 *
 *  That gap is not theoretical: every tier field ever added (`maxDirectional`, `textureMaxSize`,
 *  `maxShadowCasters`, …) had to be typed into both by hand, and the failure is silent in the
 *  direction that matters — a field present in the engine and missing from the config type is a
 *  knob a project can author, that the build's own view of the config does not know exists.
 *
 *  ⚠️ **This is a TYPE-level check written as a runtime test, so read what it does and does not
 *  prove.** It parses the two interface declarations out of source rather than reflecting on
 *  types, because interfaces do not survive to runtime. It therefore compares FIELD NAMES only —
 *  not their types, and not their meanings. A name in both with different types still passes; the
 *  seed guard (`qualityTierSeed.test.ts`) is what pins values. */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../helpers/repoLayout';
import { stripComments, assertScanIsSane } from '@modoki/engine/testing';

/** Field names declared directly in `interface <name> { … }`, ignoring nested object literals
 *  (the `postFX` block declares its own inner keys, which are not tier fields). */
function interfaceFields(file: string, name: string): string[] {
  const raw = fs.readFileSync(file, 'utf8');
  // Comments stripped first (shared scanner, @modoki/engine/testing, #419) — only then is it
  // safe to flatten nested `{...}` blocks down to top-level members.
  const src = stripComments(raw);
  assertScanIsSane(raw, src, file);
  const start = src.indexOf(`interface ${name} {`);
  expect(start, `${name} not found in ${file} — did it get renamed?`).toBeGreaterThan(-1);
  let depth = 0, i = src.indexOf('{', start), end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  expect(end, `unbalanced braces reading ${name}`).toBeGreaterThan(-1);
  const body = src.slice(src.indexOf('{', start) + 1, end);
  // Strip nested blocks so only top-level members remain.
  const flat = body.replace(/\{[^{}]*\}/g, '{}');
  return [...flat.matchAll(/^\s*(\w+)\s*[?:]/gm)].map((m) => m[1]).sort();
}

describe('the engine tier type and its project-config twin describe the same fields', () => {
  it('neither carries a field the other is missing', () => {
    const engine = interfaceFields(
      path.join(REPO_ROOT, 'engine/packages/modoki/src/runtime/rendering/qualityTier.ts'),
      'TierRenderOverrides',
    );
    const config = interfaceFields(path.join(REPO_ROOT, 'engine/project-config.ts'), 'TierOverridesConfig');

    // Non-vacuity floor: a parser that silently matched nothing would pass [] === [].
    expect(engine.length).toBeGreaterThan(10);
    expect({
      inEngineOnly: engine.filter((f) => !config.includes(f)),
      inConfigOnly: config.filter((f) => !engine.includes(f)),
    }).toEqual({ inEngineOnly: [], inConfigOnly: [] });
  });
});
