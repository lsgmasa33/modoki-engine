/** Guard: an editor undo relinks detached members through the mark owner (#1794).
 *
 *  `relinkDetachedMembers` (`runtime/core/ecs/memberHome.ts`) puts back the `PrefabInstance` links a frame-ending took
 *  off the members outside the ended tree. It is L0 and cannot read the L3 mark store, so it restores links only. An
 *  editor undo that called it bare relinked a member without its override marks, and after a rebuild in between the next
 *  save dropped the member's overrides (the save keeps only marked fields). The editor calls
 *  `relinkDetachedMembersMarked` (`editor/undo/overrideMarkWrites.ts`) instead, which relinks and restores the marks
 *  `recordDetachedMarks` took with the frame-ending.
 *
 *  NARROW on purpose, like `instanceSortOrderWrites.test.ts`: it matches a call NAMED `relinkDetachedMembers` in editor
 *  code. It does not see the other re-link and re-add undos (Detach's reattach, Remove Component's revert): those are
 *  pinned by the save→reload undo tests in `tests/editor/overrideMarkUndo.test.ts`.
 *
 *  One call is allowed: the in-place rebuild (`prefab.ts`, `rebuildInstance`) relinks the members inside a kept frame
 *  straight after its own delete, in the same world, with nothing in between to lose the marks. */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { callsTo, enclosingFunction, lineOf, parseSource, ts } from '@modoki/engine/testing/sourceAst';
import { assertExemptionLedger } from '@modoki/engine/testing/exemptionLedger';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

const ENGINE_ROOT = path.resolve(__dirname, '../..');
const OWNER = 'packages/modoki/src/editor/undo/overrideMarkWrites.ts';

/** The nearest NAMED function a call sits in (a declaration, a method, or a function bound to a `const`), or
 *  `<module>` at top level. */
function fnName(call: ts.CallExpression): string {
  for (let n: ts.Node = enclosingFunction(call); !ts.isSourceFile(n); n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) return n.name.getText();
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && ts.isVariableDeclaration(n.parent)) return n.parent.name.getText();
  }
  return '<module>';
}
/** The one call pardoned, keyed `file#function`. */
const EXEMPT = [
  {
    item: 'packages/modoki/src/editor/scene/prefabRebuild.ts#rebuildInstance',
    count: 1,
    reason: 'the in-place rebuild relinks the members inside a kept frame straight after its own delete, in the same '
      + 'world and the same call, so nothing between the frame-ending and the relink can drop their marks.',
  },
] as const;

/** Every bare `relinkDetachedMembers(` call in `code`, as `{ item: file#function, site: file:line }`. The owner is
 *  the one file that calls it by design. */
function bareRelinks(code: string, rel: string): Array<{ item: string; site: string }> {
  if (rel === OWNER) return [];
  return callsTo(parseSource(code, rel), 'relinkDetachedMembers')
    .map((call) => ({ item: `${rel}#${fnName(call)}`, site: `${rel}:${lineOf(call)}` }));
}

const files = repoFiles({
  under: [path.join(ENGINE_ROOT, 'packages/modoki/src/editor'), path.join(ENGINE_ROOT, 'app/editor')],
  match: /\.tsx?$/, exclude: ['node_modules', 'dist'], floor: 300,
});

describe('editor code relinks detached members through the mark owner (#1794)', () => {
  it('no editor file calls relinkDetachedMembers bare, outside the owner and the in-place rebuild', () => {
    assertExemptionLedger({
      label: 'EXEMPT in relinkPutsMarksBack',
      population: files.flatMap(({ abs }) => bareRelinks(fs.readFileSync(abs, 'utf8'), path.relative(ENGINE_ROOT, abs).replace(/\\/g, '/'))),
      exempt: EXEMPT,
      floor: 1, // the pardoned rebuild call is always there; zero hits means the detector broke
      fix: 'Relink through relinkDetachedMembersMarked (editor/undo/overrideMarkWrites.ts), with the DetachedMember list\n'
        + 'passed through recordDetachedMarks when the frame ended, so the undo puts the members\' marks back (#1794).',
    });
  });

  // The accept side, so the detector cannot pass by matching nothing, and the allowance names one function only.
  it('the detector finds a bare call wherever it is and names its function, and skips the owner', () => {
    const src = `
      function undoX() { relinkDetachedMembers(orphans); }
      function undoY() { relinkDetachedMembersMarked(orphans); }
      function rebuildInstance() { const d = deleteEntities(ids); relinkDetachedMembers(d); }
      const undoZ = () => memberHome.relinkDetachedMembers(orphans);`;
    const f = 'packages/modoki/src/editor/scene/prefab.ts';
    expect(bareRelinks(src, f)).toEqual([
      { item: `${f}#undoX`, site: `${f}:2` }, { item: `${f}#rebuildInstance`, site: `${f}:4` }, { item: `${f}#undoZ`, site: `${f}:5` },
    ]);
    expect(bareRelinks(src, OWNER)).toEqual([]);
  });
});
