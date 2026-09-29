/** Guard: editor code never writes `EntityAttributes.sortOrder` raw (#1709).
 *
 *  A prefab-instance member's field survives the scene save only when it is override-marked. Every `sortOrder`
 *  rewrite (reorder, sibling renumber, reparent, duplicate, paste, scene move) used to call raw `writeTraitField`, so
 *  a reordered or copied instance reloaded at its template's order. They now go through `writeTraitFieldMarked`
 *  (`editor/undo/overrideMarkWrites.ts`), or through a `write*WithUndo` helper, which marks too.
 *
 *  This guard is NARROW on purpose. A general "every unmarked instance-field write fails" tripwire was measured first,
 *  at the capture's mark gate, over 3,503 tests: it tripped 28, of which 17 were the gate doing its job (a template
 *  changed under an unedited instance, a member moved out and back, an Apply's refresh). No write-side rule can tell
 *  those apart, so what is guarded is the one field every hit shared by construction: `sortOrder`.
 *
 *  What it does NOT see: a `sortOrder` written some other way, through an `entity.set(trait, {...})` with a
 *  computed key or a helper that takes the field name as a variable. It matches a literal `'sortOrder'` argument to
 *  a call named `writeTraitField`. False positives at landing: 3, all undo writes that then put a mark snapshot back
 *  (`restoreMarks` in reparentEntity and moveEntityToScene, `putMarkState(…, 'EntityAttributes', …)` in
 *  restorableSortOrderWrite); they are exempted by that call, not by name. */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { calleeName, callsTo, enclosingFunction, lineOf, parseSource, stringValueOf, ts } from '@modoki/engine/testing/sourceAst';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

const ENGINE_ROOT = path.resolve(__dirname, '../..');

/** `file:line` of every raw `writeTraitField(id, meta, 'sortOrder', value)` in `code`, except one whose enclosing
 *  function also calls `restoreMarks` / `putMarkState` itself: an UNDO putting back a mark snapshot.
 *  ⚠️ The exemption trusts that the snapshot was taken BEFORE the edit, which it cannot see: reparentEntity's was
 *  once taken after its own marked write, so its undo restored the new mark (#1709 close-out review). The save+reload
 *  undo tests in instanceWriteMarks.test.ts are what pin the timing. */
function restoresMarks(call: ts.CallExpression): boolean {
  const fn = enclosingFunction(call);
  if (ts.isSourceFile(fn)) return false;
  // Only a call made by THIS function: a nested undo closure calling it says nothing about the write beside it.
  // `restoreMarks` puts back a `captureMarks` (the whole set, unless the capture named one trait, which this cannot see:
  // both callers here capture the whole set); `putMarkState` only the trait it names, so it must name ours.
  return callsTo(fn, 'restoreMarks', 'putMarkState').some((c) => enclosingFunction(c) === fn
    && (calleeName(c) === 'restoreMarks' || stringValueOf(c.arguments[1]) === 'EntityAttributes'));
}
function rawSortOrderWrites(code: string, label: string): string[] {
  return callsTo(parseSource(code, label), 'writeTraitField')
    .filter((call) => stringValueOf(call.arguments[2]) === 'sortOrder')
    .filter((call) => !restoresMarks(call))
    .map((call) => `${label}:${lineOf(call)}`);
}

// Editor code only: the runtime and the device debug ops write live state no save captures.
const files = repoFiles({
  under: [path.join(ENGINE_ROOT, 'packages/modoki/src/editor'), path.join(ENGINE_ROOT, 'app/editor')],
  match: /\.tsx?$/, exclude: ['node_modules', 'dist'], floor: 300,
});

describe('editor sortOrder writes go through the marking writer (#1709)', () => {
  it('no editor file writes sortOrder with raw writeTraitField', () => {
    const hits = files.flatMap(({ abs, rel }) => rawSortOrderWrites(fs.readFileSync(abs, 'utf8'), rel));
    expect(hits).toEqual([]);
  });

  // The accept side, so the detector cannot pass by matching nothing.
  it('the detector flags a raw write and passes the marked one', () => {
    const src = `
      writeTraitField(id, attrMeta, 'sortOrder', 5);
      writeTraitFieldMarked(id, attrMeta, 'sortOrder', 5);
      writeTraitField(id, attrMeta, 'parentId', 5);
      entityUtils.writeTraitField(id, attrMeta, "sortOrder", 5);
      const undo = () => { writeTraitField(id, attrMeta, 'sortOrder', 1); restoreMarks(id, marks); };
      function edit() { writeTraitField(id, attrMeta, 'sortOrder', 2); const u = () => restoreMarks(id, marks); }
      const back = (id) => { writeTraitField(id, attrMeta, 'sortOrder', 3); putMarkState(id, 'EntityAttributes', s); };
      const wrong = (id) => { writeTraitField(id, attrMeta, 'sortOrder', 4); putMarkState(id, 'Transform', s); };`;
    expect(rawSortOrderWrites(src, 'x.ts')).toEqual(['x.ts:2', 'x.ts:5', 'x.ts:7', 'x.ts:9']);
  });
});
