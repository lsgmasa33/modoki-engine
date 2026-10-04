/** #1914 R8 — **no editor code outside the write-time recorder compares a VALUE to decide a RECORD.**
 *
 *  An instance's overrides are an explicit list (Unity's recorded-list model, docs/prefabs.md § I2, I17): an edit adds
 *  what it made differ, Revert and Apply remove, and nothing re-derives the list from values. Before #1914 the list WAS
 *  re-derived, in a dozen places (a mark gate over a value diff, a fold of the marked fields equal to the base, an undo
 *  that re-marked what an enclosing row stated, an Inspector that recorded on equality), and each was a separate route by
 *  which an override appeared or vanished because two numbers happened to agree. R1–R6 removed them; this guard keeps
 *  them out.
 *
 *  The rule, at module grain: an editor module that SETS a record (the door's `setFields`, `markOverrideIfInstance`,
 *  the recorder) must not call a value comparator (`valuesEqual`, the value diff `getOverrideValues`, the
 *  transform-equality helpers, the document comparators). Names are resolved through each file's imports, so an alias
 *  (`valuesEqual as eq`) is still seen. What it cannot see: a raw `===` between two trait values next to a record-setter.
 *  A name check is what a static guard can afford here; review owns the rest.
 *
 *  Where it allows both, and why:
 *  - `undo/overrideMarkWrites.ts` IS the write-time recorder (`recordOverridesByDiff`: an edit records what it made
 *    differ from the instance's base, owner rulings F2/F3), and holds the undo carriers, which put back exact rows.
 *  (`scene/prefabBase.ts` was the second: its `withLeftBehindRecorded` marked what a layer left behind for Create Prefab's
 *  capture. Since #2001 S8b it adds those keys to the capture's own set, `addCaptureKey`, and sets no record.)
 *
 *  Mutation: plant a `valuesEqual(...)` call in a module that marks (`scene/gizmoUndo.ts`) — red. Drop the sanctioned row
 *  — red (unexcused). Take `setFields` out of the setters — the wrapper detector case red. */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assertExemptionLedger } from '@modoki/engine/testing/exemptionLedger';
import { callsTo, functionsNamed, importBindings, parseSource } from '@modoki/engine/testing/sourceAst';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

const EDITOR = path.resolve(__dirname, '../../packages/modoki/src/editor');

/** What SETS a record: the door's field verb and the recorder's wrappers over it (`setFields` takes the field list, so a
 *  comparison that filters it decides a record as surely as a guarded write — close-out review). Unsetting is
 *  not here: removing a record is what Revert and Apply do, and a value may decide that only through Revert/Apply's own
 *  key sets, which name records, not values. */
const RECORD_SETTERS = [
  'setFields', 'markOverrideIfInstance', 'recordOverridesByDiff', 'writeTraitFieldMarked',
] as const;
/** What compares two values (or two documents) for equality. */
const VALUE_COMPARATORS = [
  'valuesEqual', 'getOverrideValues', 'sameOrientation', 'sameRotationScale', 'sameTrsMatrix', 'rowsMeanTheSame',
  'sameDocumentContent',
] as const;

/** The names in `wanted` this source can CALL: imported under any local name, or declared in the file itself. */
function localNames(sf: ReturnType<typeof parseSource>, wanted: readonly string[]): string[] {
  const set = new Set<string>(wanted);
  const out = new Set<string>();
  for (const b of importBindings(sf, /./)) if (!b.typeOnly && set.has(b.imported)) out.add(b.local);
  for (const name of wanted) if (functionsNamed(sf, name).length) out.add(name);
  return [...out];
}

/** Does this source both set a record and compare values? */
function recordsAndCompares(code: string, label: string): { records: boolean; compares: boolean } {
  const sf = parseSource(code, label);
  const setters = localNames(sf, RECORD_SETTERS);
  const comparators = localNames(sf, VALUE_COMPARATORS);
  return {
    records: setters.length > 0 && callsTo(sf, ...setters).length > 0,
    compares: comparators.length > 0 && callsTo(sf, ...comparators).length > 0,
  };
}

describe('the detector', () => {
  it('flags a module that sets a record and compares values, through an alias too', () => {
    const both = `import { markOverrideIfInstance } from './m'; import { valuesEqual as eq } from './p';
      export function f(id, a, b) { if (!eq(a, b)) markOverrideIfInstance(id, 'T', 'x'); }`;
    expect(recordsAndCompares(both, 'both.ts')).toEqual({ records: true, compares: true });
  });
  it('flags a comparison fed into the door\'s field list (setFields)', () => {
    const wrapped = `import { setFields } from './w'; import { valuesEqual } from './p';
      export function f(id, a, b) { setFields(id, 'T', valuesEqual(a, b) ? [] : ['x']); }`;
    expect(recordsAndCompares(wrapped, 'wrapped.ts')).toEqual({ records: true, compares: true });
  });
  it('ACCEPTS a module that only records, and one that only compares', () => {
    expect(recordsAndCompares(`import { markOverrideIfInstance } from './m'; export const f = (id) => markOverrideIfInstance(id, 'T', 'x');`, 'r.ts'))
      .toEqual({ records: true, compares: false });
    expect(recordsAndCompares(`import { valuesEqual } from './p'; export const f = (a, b) => valuesEqual(a, b);`, 'c.ts'))
      .toEqual({ records: false, compares: true });
  });
  it('ACCEPTS a name only mentioned, never called (a type import, a comment, a re-export)', () => {
    const named = `import type { valuesEqual } from './p'; // valuesEqual(a, b) decides nothing here
      import { markOverrideIfInstance } from './m'; export { getOverrideValues } from './q'; export const f = (id) => markOverrideIfInstance(id, 'T', 'x');`;
    expect(recordsAndCompares(named, 'n.ts')).toEqual({ records: true, compares: false });
  });
});

describe('no editor module outside the recorder decides a record by comparing values (#1914 R8)', () => {
  it('holds over every editor source', () => {
    const files = repoFiles({ under: EDITOR, match: /\.tsx?$/, floor: 150 }).map(({ abs }) => abs);
    const population = files.flatMap((abs) => {
      const rel = path.relative(EDITOR, abs).split(path.sep).join('/');
      const { records, compares } = recordsAndCompares(fs.readFileSync(abs, 'utf8'), rel);
      return records && compares ? [{ item: rel, site: `editor/${rel}` }] : [];
    });
    assertExemptionLedger({
      label: 'override records decided by value (overrideRecordNoValueCompare)',
      population,
      sanctioned: ['undo/overrideMarkWrites.ts'],
      exempt: [],
      floor: 150,
      scanned: files.length,
      fix: 'Record at write time through recordOverridesByDiff / writeTraitFieldMarked, or restore an exact captured set; never decide a record from a value comparison.',
    });
    expect(population.map((p) => p.item).sort()).toEqual(['undo/overrideMarkWrites.ts']);
  });
});
