/** Guard (#1579): editor code swaps the world through `sceneManager` directly only from a reviewed list.
 *
 *  An undo step awaits across a prefab file write and a world reload, so a user world switch must wait for it before
 *  it swaps — `prepareWorldSwitch` (serialize.ts) / `beginWorldSwitch` (undoManager.ts) do that, and #1575's close-out
 *  showed what happens without it: four rounds of guards at the step, each finding the next window. The wait lives in
 *  the editor's entry points (`loadScene`, `newScene`, `openPrefabForEditing`, `enterPlay`), not in `SceneManager`,
 *  because undo closures themselves reload through `sceneManager` and would wait for their own chain forever.
 *
 *  So a NEW editor caller of `sceneManager.loadScene`/`replaceWorldContent` is a world switch that skips the wait —
 *  unless it runs inside an undo closure or a restore that already waits. The ledger makes each one a reviewed call:
 *  add a row, or raise a row's count, only with the reason it cannot race an undo.
 *
 *  Scope: the editor package and the editor app shell. `engine/app/App.tsx`/`ecs/init.ts` (runtime boot) and
 *  `agentBridge.ts` (the runtime agent and the disk hot reload, which defers itself while authoring is unsettled) are
 *  outside it — docs/editor.md § "A step that awaits across a scene switch" names them as not covered. */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { findNodes, parseSource, lineOf, ts } from '@modoki/engine/testing/sourceAst';
import { assertExemptionLedger } from '@modoki/engine/testing/exemptionLedger';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

const ENGINE = path.resolve(__dirname, '../..');
const DIRS = ['packages/modoki/src/editor', 'app/editor'].map((d) => path.join(ENGINE, d));
const SWAPS = new Set(['loadScene', 'replaceWorldContent']);

/** Each file allowed to swap directly, the NUMBER of direct swaps it holds, and why none of them can race an undo. */
const EXEMPT = [
  { item: 'packages/modoki/src/editor/undo/applyPrefabUndo.ts', count: 3, reason: 'IS the undo step: its three reloads (untitled, prefab-edit, titled) run inside its own closure' },
  { item: 'packages/modoki/src/editor/scene/authoredSnapshot.ts', count: 1, reason: "Stop's and a preview Exit's restore; the preview awaits whenUndoIdle, and undo is refused during Play" },
  { item: 'packages/modoki/src/editor/scene/prefabEdit.ts', count: 1, reason: "loadPrefabEditWorld, reached from openPrefabForEditing after prepareWorldSwitch's wait" },
  { item: 'packages/modoki/src/editor/scene/serialize.ts', count: 2, reason: 'loadScene and newScene, each after prepareWorldSwitch' },
] as const;

/** `sceneManager.loadScene(…)` / `sceneManager.replaceWorldContent(…)` calls — a CALL, so a comment or a reference
 *  naming the method is not one. */
export function directSwaps(code: string, label: string): number[] {
  const sf = parseSource(code, label);
  return findNodes(sf, ts.isCallExpression)
    .filter((c) => ts.isPropertyAccessExpression(c.expression)
      && SWAPS.has(c.expression.name.text)
      && c.expression.expression.getText(sf) === 'sceneManager')
    .map(lineOf);
}

/** Editor source files, via the shared corpus producer. Floored well under the ~600 there today, so only a broken
 *  enumeration can turn it red. */
const files = (repoFiles({ under: DIRS, match: /\.tsx?$/, floor: 300 }) as Array<{ abs: string }>)
  .map((f) => f.abs)
  .filter((abs) => !/\.(test|spec)\.tsx?$/.test(abs) && !abs.endsWith('.d.ts'));

const population = files.flatMap((abs) => {
  const rel = path.relative(ENGINE, abs).split(path.sep).join('/');
  return directSwaps(fs.readFileSync(abs, 'utf8'), abs).map((line) => ({ item: rel, site: `${rel}:${line}` }));
});

describe('editor world switches go through the undo wait (#1579)', () => {
  it('no editor code swaps the world through sceneManager directly outside the reviewed ledger', () => {
    assertExemptionLedger({
      label: 'EXEMPT in editorWorldSwitchWaitsForUndo',
      population,
      exempt: EXEMPT,
      // 7 measured 2026-09-25 on work-ai2, all pardoned. The floor sits under that so removing a call reaches the
      // over-blessed arm ("blesses 3, found 2"); the detector-broke check is `files`' own floor.
      floor: 6,
      fix: 'A new world switch must wait for the undo in flight: go through prepareWorldSwitch (serialize.ts), or\n'
        + 'beginWorldSwitch (undoManager.ts), and swap after its wait. If this call runs inside an undo closure or a\n'
        + 'restore that already waits, add it to EXEMPT with the reason it cannot race an undo step.',
    });
  });

  it('the scanner sees a call and ignores a comment or a bare reference', () => {
    expect(directSwaps('async function f() { await sceneManager.loadScene("x"); }', 'a.ts')).toEqual([1]);
    expect(directSwaps('const f = () =>\n  sceneManager.replaceWorldContent(() => {});', 'b.ts')).toEqual([2]);
    expect(directSwaps('// sceneManager.loadScene(x)\nconst g = sceneManager.loadScene;', 'c.ts')).toEqual([]);
    expect(directSwaps('other.loadScene("x");', 'd.ts')).toEqual([]);
  });
});
