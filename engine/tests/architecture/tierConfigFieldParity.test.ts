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
import path from 'node:path';
import { REPO_ROOT } from '../helpers/repoLayout';
import { readScannedSource } from '@modoki/engine/testing';
import { parseSource, typeMembers, typesNamed } from '@modoki/engine/testing/sourceAst';

/** Field names declared directly on `interface <name>` — its OWN members, from the parser (#1195), so a
 *  nested literal's keys (the `postFX` block declares its own inner keys, which are not tier fields) are
 *  not counted, and a brace or a `key:` inside a string cannot move the edge. It used to brace-count the
 *  body, flatten `{…}` one level deep with a regex and match `^\s*(\w+)\s*[?:]` per line. */
function interfaceFields(file: string, name: string): string[] {
  const sf = parseSource(readScannedSource(file).code, file);
  const decls = typesNamed(sf, name);
  expect(decls.length, `${name} in ${file}: expected one declaration — did it get renamed, or split in two?`).toBe(1);
  const members = typeMembers(decls[0]);
  expect(members, `${name} in ${file} is no longer a plain interface or type literal (an alias, or one that extends another) — read its new shape`).toBeDefined();
  return members!.map((m) => m.name).sort();
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
