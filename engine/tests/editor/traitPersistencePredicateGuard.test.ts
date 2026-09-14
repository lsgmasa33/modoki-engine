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
import { readScannedSource } from '@modoki/engine/testing';
import { accessPath, findNodes, lineOf, parseSource, ts } from '@modoki/engine/testing/sourceAst';

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

/** Every `x in <…>meta.fields` membership test in one file's comment-stripped code, from the parse —
 *  `!(x in meta.fields)`, `key in\n  meta.fields`, `k in this.meta.fields` alike. Property READS
 *  (`meta.fields[x]`) are intentionally not matched: they are not an `in`.
 *
 *  ⚠️ **#1179:** the per-line regex missed a wrapped `key in\n  meta.fields`, and its comment filter
 *  dropped any CODE line that begins with `*` (a continued multiplication, a generator). Comments are
 *  now blanked by the shared scanner, so these files may still EXPLAIN the trap at length. Measured on
 *  migrating: 0 in each of the four files, before and after. */
function membershipTests(code: string, label: string): string[] {
  const sf = parseSource(code, label);
  return findNodes(sf, (n): n is ts.BinaryExpression => ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.InKeyword
    && /(^|\.)meta\.fields$/.test(accessPath(n.right) ?? ''))
    .map((b) => `${lineOf(b)}: ${b.getText(sf).replace(/\s+/g, ' ')}`);
}

describe('meta.fields is never used as a persistence predicate', () => {
  for (const file of GUARDED) {
    it(`${file.split('/').slice(-2).join('/')} uses isPersistentTraitField, not \`in meta.fields\``, () => {
      const offenders = membershipTests(readScannedSource(file).code, file);

      expect(
        offenders,
        'Use isPersistentTraitField(meta, field) from runtime/core/ecs/traitSchema.ts — '
        + 'meta.fields is the Inspector list and OMITS persistent fields owned by a custom section.',
      ).toEqual([]);
    });
  }

  it('the guard actually matches the pattern it claims to (self-check)', () => {
    // Without this, a broken regex would make every case above vacuously pass —
    // the "a test can pass on a state the code never produces" failure mode.
    const count = (src: string) => membershipTests(src, 'row.ts').length;
    expect(count('for (;;) { if (!(fieldName in meta.fields)) continue; }')).toBe(1);
    expect(count('const allowed = field in meta.fields;')).toBe(1);
    expect(count('for (;;) { if (meta.fields[key]?.runtimeOnly) continue; }')).toBe(0);
    // #1179: wrapped, on a receiver, two on one line, and a code line that starts with `*`.
    expect(count('const a = key in\n  meta.fields;')).toBe(1);
    expect(count('const b = k in this.meta.fields || j in trait.meta.fields;')).toBe(2);
    expect(count('const c = 2\n  * (k in meta.fields ? 1 : 0);')).toBe(1);
    expect(count("const d = 'fields' in meta; const e = k in metaFields;")).toBe(0);
  });

  it('every guarded file exists (a renamed file must not silently drop its guard)', () => {
    for (const file of GUARDED) expect(() => readFileSync(file, 'utf8')).not.toThrow();
  });
});
