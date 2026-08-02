/** GUARD — `meta.fields` must never be used as "the set of fields a trait persists".
 *
 *  `meta.fields` is the INSPECTOR-RENDERING list. A field can persist and carry no
 *  entry in it: `Animator.clips`/`clip` (rendered by AnimatorClipsSection),
 *  `EntityAttributes.editorFolder` (no row at all). Treating membership as
 *  persistence lost real data in FOUR places before this guard existed — override
 *  capture, the editor apply, the loader apply, and applyToPrefabSelective — each
 *  found separately, over months, and each of the first three had unit tests that
 *  PASSED because the test mocks encoded the same wrong belief.
 *
 *  So this guard is deliberately syntactic and cheap: flag the membership test
 *  itself (`field in meta.fields`) in the files that decide what reaches a FILE.
 *  The correct predicate is `isPersistentTraitField` in
 *  runtime/core/ecs/traitSchema.ts. Reading `meta.fields[key]?.someHint` is fine
 *  and stays legal — that asks about presentation, which is what the list is for. */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Resolved from __dirname, not a file:// URL — the Windows CI leg runs these too. */
const SRC = join(__dirname, '..', '..', 'packages', 'modoki', 'src');

/** The persistence-deciding surfaces: everything that writes a scene/prefab file
 *  or restores one into the world. */
const GUARDED = [
  join(SRC, 'editor', 'scene', 'prefab.ts'),
  join(SRC, 'editor', 'scene', 'serialize.ts'),
  join(SRC, 'runtime', 'loaders', 'loadSceneFile.ts'),
  join(SRC, 'runtime', 'scene', 'SceneManager.ts'),
];

/** `x in meta.fields` / `!(x in meta.fields)` — the membership test, in any spacing.
 *  Property READS (`meta.fields[x]`) are intentionally not matched. */
const MEMBERSHIP = /\bin\s+meta\.fields\b/;

describe('meta.fields is never used as a persistence predicate', () => {
  for (const file of GUARDED) {
    it(`${file.split('/').slice(-2).join('/')} uses isPersistentTraitField, not \`in meta.fields\``, () => {
      const lines = readFileSync(file, 'utf8').split('\n');
      const offenders = lines
        .map((text, i) => ({ text, line: i + 1 }))
        // Skip comments — these files EXPLAIN the trap at length, and the
        // explanation must not trip the guard that enforces it.
        .filter(({ text }) => !/^\s*(\/\/|\*|\/\*)/.test(text))
        .filter(({ text }) => MEMBERSHIP.test(text));

      expect(
        offenders.map((o) => `${o.line}: ${o.text.trim()}`),
        'Use isPersistentTraitField(meta, field) from runtime/core/ecs/traitSchema.ts — '
        + 'meta.fields is the Inspector list and OMITS persistent fields owned by a custom section.',
      ).toEqual([]);
    });
  }

  it('the guard actually matches the pattern it claims to (self-check)', () => {
    // Without this, a broken regex would make every case above vacuously pass —
    // the "a test can pass on a state the code never produces" failure mode.
    expect(MEMBERSHIP.test('if (!(fieldName in meta.fields)) continue;')).toBe(true);
    expect(MEMBERSHIP.test('const allowed = field in meta.fields;')).toBe(true);
    expect(MEMBERSHIP.test('if (meta.fields[key]?.runtimeOnly) continue;')).toBe(false);
  });

  it('every guarded file exists (a renamed file must not silently drop its guard)', () => {
    for (const file of GUARDED) expect(() => readFileSync(file, 'utf8')).not.toThrow();
  });
});
