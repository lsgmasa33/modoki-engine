/** Guard: editor code never writes `EntityAttributes.sortOrder` raw (#1709).
 *
 *  A prefab-instance member's field survives the scene save only when the instance's record lists it. Every `sortOrder`
 *  rewrite (reorder, sibling renumber, reparent, duplicate, paste, scene move) used to call raw `writeTraitField`, so
 *  a reordered or copied instance reloaded at its template's order. They now go through `writeTraitFieldMarked`
 *  (`editor/undo/overrideMarkWrites.ts`), or through a `write*WithUndo` helper, which record too.
 *
 *  This guard is NARROW on purpose. A general "every unrecorded instance-field write fails" tripwire was measured first,
 *  over 3,503 tests: it tripped 28, of which 17 were the save doing its job (a template changed under an unedited
 *  instance, a member moved out and back, an Apply's refresh). No write-side rule can tell those apart, so what is
 *  guarded is the one field every hit shared by construction: `sortOrder`.
 *
 *  What it does NOT see: a `sortOrder` written some other way, through an `entity.set(trait, {...})` with a
 *  computed key or a helper that takes the field name as a variable. It matches a literal `'sortOrder'` argument to
 *  a call named `writeTraitField`.
 *
 *  The raw writes it pardons are named in a ledger, by the top-level function they sit in, with a count (#2001 S8b).
 *  Each is an UNDO that writes the old order raw and then puts back the rows the step found (`seatAround` /
 *  `putFieldRows`): recording the old value there would add a record the step never had. Before S8b they were exempted
 *  by a call to `restoreMarks` / `putMarkState` beside them; the mark store is gone. ⚠️ The ledger cannot see that the
 *  rows were taken BEFORE the edit (reparentEntity's were once taken after its own write, #1709 close-out review): the
 *  save+reload undo tests in instanceWriteMarks.test.ts pin the timing. One more is exempted by a call, not by name:
 *  the door's `place` (#2046 S7, #1947) writes a new instance root's order live and seats it in the record's placement
 *  (`setInstanceRecord`), that field's one home (§ 10.4). */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { callsTo, enclosingFunction, lineOf, parseSource, stringValueOf, ts } from '@modoki/engine/testing/sourceAst';
import { assertExemptionLedger } from '@modoki/engine/testing/exemptionLedger';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

const ENGINE_ROOT = path.resolve(__dirname, '../..');

/** The top-level function a call sits in (a declaration, or a function bound to a top-level `const`), or `<module>`. */
function topFn(call: ts.CallExpression): string {
  let n: ts.Node = call;
  while (!ts.isSourceFile(n.parent)) n = n.parent;
  if (ts.isFunctionDeclaration(n) && n.name) return n.name.getText();
  if (ts.isVariableStatement(n)) return n.declarationList.declarations[0].name.getText();
  return '<module>';
}
/** Whether `call`'s own function seats an instance record (`setInstanceRecord`): the order lives in its placement. */
function seatsRecord(call: ts.CallExpression): boolean {
  const fn = enclosingFunction(call);
  return !ts.isSourceFile(fn) && callsTo(fn, 'setInstanceRecord').some((c) => enclosingFunction(c) === fn);
}
/** Every raw `writeTraitField(id, meta, 'sortOrder', value)` in `code`, as `{ item: file#topFunction, site }`. */
function rawSortOrderWrites(code: string, rel: string): Array<{ item: string; site: string }> {
  return callsTo(parseSource(code, rel), 'writeTraitField')
    .filter((call) => stringValueOf(call.arguments[2]) === 'sortOrder')
    .filter((call) => !seatsRecord(call))
    .map((call) => ({ item: `${rel}#${topFn(call)}`, site: `${rel}:${lineOf(call)}` }));
}

const UNDO = 'packages/modoki/src/editor/undo';
/** The undo writes pardoned: each writes the old order raw, then puts back the rows the step found. */
const EXEMPT = [
  { item: `${UNDO}/entityActions.ts#reparentEntity`, reason: 'the undo writes the old order, then seatAround / seatSide put back the records the reparent found, and takeUnmarkedFromBase gives an unlisted field the base.' },
  { item: `${UNDO}/entityActions.ts#moveEntityToScene`, reason: 'undoStamps writes the old order inside seatAround(changed, \'before\'), which puts back the records the move found.' },
  { item: `${UNDO}/overrideMarkWrites.ts#makeSortOrderRenumberAction`, reason: 'the renumber\'s undo writes each old order, then putFieldRows puts back the sortOrder rows taken before the renumber ran.' },
] as const;

// Editor code only: the runtime and the device debug ops write live state no save captures.
const files = repoFiles({
  under: [path.join(ENGINE_ROOT, 'packages/modoki/src/editor'), path.join(ENGINE_ROOT, 'app/editor')],
  match: /\.tsx?$/, exclude: ['node_modules', 'dist'], floor: 300,
});

describe('editor sortOrder writes go through the recording writer (#1709)', () => {
  it('no editor file writes sortOrder with raw writeTraitField, outside the undos that put back their rows', () => {
    assertExemptionLedger({
      label: 'EXEMPT in instanceSortOrderWrites',
      population: files.flatMap(({ abs }) => rawSortOrderWrites(fs.readFileSync(abs, 'utf8'), path.relative(ENGINE_ROOT, abs).replace(/\\/g, '/'))),
      exempt: EXEMPT,
      floor: 1, // the pardoned undo writes are always there; zero hits means the detector broke
      fix: 'Write sortOrder through writeTraitFieldMarked (editor/undo/overrideMarkWrites.ts) so the record lists it (#1709);\n'
        + 'an undo that writes the old order raw must put back the rows it took before the edit, and be named here.',
    });
  });

  // The accept side, so the detector cannot pass by matching nothing, and each pardon names one top-level function.
  it('the detector flags a raw write, names its top-level function, and passes the recorded one and a seat', () => {
    const src = `
      writeTraitField(id, attrMeta, 'sortOrder', 5);
      writeTraitFieldMarked(id, attrMeta, 'sortOrder', 5);
      writeTraitField(id, attrMeta, 'parentId', 5);
      function reparentEntity(id) { const undo = () => { const live = () => entityUtils.writeTraitField(id, attrMeta, "sortOrder", 1); }; }
      const undoStamps = (id) => { writeTraitField(id, attrMeta, 'sortOrder', 4); };
      function place(id) { writeTraitField(id, attrMeta, 'sortOrder', 6); setInstanceRecord(world, rec); }
      function placeLater(id) { writeTraitField(id, attrMeta, 'sortOrder', 7); const later = () => setInstanceRecord(world, rec); }`;
    const f = 'x.ts';
    expect(rawSortOrderWrites(src, f)).toEqual([
      { item: `${f}#<module>`, site: `${f}:2` }, { item: `${f}#reparentEntity`, site: `${f}:5` },
      { item: `${f}#undoStamps`, site: `${f}:6` }, { item: `${f}#placeLater`, site: `${f}:8` },
    ]);
  });
});
