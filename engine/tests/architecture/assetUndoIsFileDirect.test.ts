/** An undo entry for an ASSET-DOCUMENT edit must carry `_isFileDirect` — a guard, because the
 *  rule has now been broken twice in the same place.
 *
 *  WHAT THE FLAG DOES (undoManager.ts): it opts an action out of bumping the scene's edit-version.
 *  An asset edit changes a `.anim`/`.particle`/`.timeline`/`.spriteanim`/`.rig2d`/`.mat`/`.shader`/
 *  `.animset` file, never a scene entity — its unsaved state is the dirty-asset registry's job.
 *  (It used to add "or, for the Inspector's asset views, it is already on disk". That second
 *  case is gone as of #831: `persistAssetEdit` now PARKS into the same registry as everything
 *  else instead of writing on every keystroke, so there is one answer here, not two.)
 *
 *  WHY A FALSELY-DIRTY SCENE IS NOT COSMETIC: it self-blocks the file-direct agent routes, makes
 *  `modoki_build` refuse over a scene nobody changed, and — since the Cmd+S/preview work — makes a
 *  save interrupt a live preview to rewrite a scene file with nothing in it but serializer churn.
 *
 *  WHY A GUARD AND NOT A CONVENTION: the agent twins have set this since S2.27 and the panels never
 *  did. Fixing "the five panels" flagged their five `commit()` sites and missed TEN more — six rig2d
 *  edits pushed from the Skin panel's sub-components and four in the Inspector's asset views — so
 *  the first fix looked complete and was a third of the job. This is the mechanism that notices the
 *  eleventh.
 *
 *  The mutator list is DERIVED from the editor store's own `apply*Def/Doc/Clip` actions, so an asset
 *  kind added later is covered without editing this file; `persistAssetEdit` is listed explicitly
 *  because it is not a store action. */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { stripComments, assertScanIsSane, readScannedSource } from '@modoki/engine/testing';
import { callsTo, declarationOf, findNodes, lineOf, objectLiteralKeys, parseSource, propertyValue, ts, unwrapValue } from '@modoki/engine/testing/sourceAst';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

const EDITOR = path.resolve(__dirname, '../../packages/modoki/src/editor');

/** Every store action that REPLACES an asset document, read off the store rather than restated. */
function assetDocMutators(): string[] {
  const store = fs.readFileSync(path.join(EDITOR, 'store/editorStore.ts'), 'utf8');
  const found = new Set(store.match(/apply[A-Za-z]+(?:Def|Doc|Clip)\b/g) ?? []);
  // Not a store action: the Inspector's asset views write the file directly through this.
  found.add('persistAssetEdit');
  return [...found];
}

/** Every `.ts`/`.tsx` under editor/**, via the shared corpus producer (#799/#771/#805 Phase 4).
 *  Floored well under the 240 measured today. */
function editorSources(): string[] {
  return repoFiles({ under: EDITOR, match: /\.tsx?$/, floor: 150 }).map(({ abs }) => abs);
}

/** The ACTION a `pushAction(...)` call pushes — its argument, or, for the `const a: ClipAction = { … };
 *  pushAction(a)` form the coalescing panels use, the initializer that name RESOLVES to.
 *
 *  Reading the action, not a window of nearby lines, is load-bearing: the first version of this
 *  guard scanned ±14 lines, and deleting a real flag left it GREEN because a sibling `pushAction`
 *  a few lines up still had one. A guard that cannot fail on the defect it names is worse than no
 *  guard — it certifies. (Caught by mutating it, which is the only thing that ever catches this.)
 *
 *  ⚠️ **The action is a NODE (#1195).** The second version counted parentheses and braces over the text
 *  and resolved a name to the nearest EARLIER `const <name>` spelled alike — so a `(` or `{` inside a
 *  string moved the literal's edge, and a same-named const in a sibling function stood in for the real
 *  one. Now `declarationOf` resolves the name by scope. */
function pushedAction(call: ts.CallExpression): ts.Expression | undefined {
  const arg = call.arguments[0] && unwrapValue(call.arguments[0]);
  if (!arg || !ts.isIdentifier(arg)) return arg;
  const decl = declarationOf(arg);
  return decl && ts.isVariableDeclaration(decl) && decl.initializer ? unwrapValue(decl.initializer) : arg;
}

/** The factories that build a WHOLE asset-doc entry and set the flag themselves (#1710): `assetDocAction`
 *  (undo/assetDocUndo.ts) and `skinDocAction` (panels/skinDocAction.ts), which returns the first. That each really
 *  does is checked below — a name on this list vouches for nothing on its own. */
const FLAGGING_FACTORIES = ['assetDocAction', 'skinDocAction'];

/** Is this action a factory's entry — the call itself, or `Object.assign(<the call>, { _after })` (a coalescing
 *  editor's shape)? */
function factoryBuilt(action: ts.Expression): boolean {
  let e: ts.Expression = action;
  if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.getText() === 'Object.assign' && e.arguments[0]) {
    // The extras may add fields (`_after`), never replace the factory's guarded steps.
    // A spread (`'...'`) or computed key (`'[k]'`) could be undo/redo too, so it counts as one.
    const overrides = e.arguments.slice(1).some((x) => (objectLiteralKeys(unwrapValue(x)) ?? ['?'])
      .some((k) => k === 'undo' || k === 'redo' || k === '?' || k === '...' || k.startsWith('[')));
    if (overrides) return false;
    e = unwrapValue(e.arguments[0]);
  }
  return ts.isCallExpression(e) && ts.isIdentifier(e.expression) && FLAGGING_FACTORIES.includes(e.expression.text);
}

/** Is this action an ASSET-DOC undo entry? A factory's entry, a mutator NAMED inside it (called, or handed on), or —
 *  in a file that touches a mutator at all — an own `undo` member. */
function isAssetDocEntry(action: ts.Expression, mutators: readonly string[], fileTouchesAssets: boolean): boolean {
  const direct = factoryBuilt(action) || findNodes(action, ts.isIdentifier).some((id) => mutators.includes(id.text));
  return direct || (fileTouchesAssets && (objectLiteralKeys(action) ?? []).includes('undo'));
}

/** Does the action carry `_isFileDirect: true` as its OWN key? `: true`, not merely present —
 *  `_isFileDirect: false` IS the defect, and undoManager reads the flag truthily. The first version of this
 *  guard accepted both that and a comment saying the word, which is the failure its own docstring names;
 *  a flag inside a nested literal does not flag the action either. */
function isFlagged(action: ts.Expression): boolean {
  return factoryBuilt(action) || propertyValue(action, '_isFileDirect')?.kind === ts.SyntaxKind.TrueKeyword;
}

/** Is this entry's undo/redo GUARDED (#1710) — does each check the asset still holds its side before moving it? A
 *  factory's entry, or a literal whose `undo` AND `redo` each run `runAssetDocStep` — directly, or through a local
 *  const resolved by scope (MaterialBatchView's `undo: step(next, prev)`). One guarded half does not vouch for the
 *  other: a raw `persistAssetEdit(old)` / `apply*Def(before)` step re-parks the whole old doc over whatever the asset
 *  holds now. */
function isGuarded(action: ts.Expression): boolean {
  if (factoryBuilt(action)) return true;
  if (!ts.isObjectLiteralExpression(action)) return false;
  // A spread can replace either step at runtime, whatever the literal names.
  if (action.properties.some(ts.isSpreadAssignment)) return false;
  // CALLED, not merely named — and called by the step ITSELF: `() => { void step; persistAssetEdit(old); }` names the
  // helper, and `() => { const never = () => runAssetDocStep(…); persistAssetEdit(old); }` calls it in a closure
  // nothing runs. Only calls whose nearest enclosing function is the step's own count.
  const ownerFn = (n: ts.Node): ts.Node | undefined => { for (let p = n.parent; p; p = p.parent) if (ts.isFunctionLike(p)) return p; return undefined; };
  const callees = (n: ts.Node) => {
    const own = ts.isArrowFunction(n) || ts.isFunctionExpression(n) ? n : ownerFn(n);
    return findNodes(n, ts.isCallExpression).filter((c) => ownerFn(c) === own).map((c) => c.expression).filter(ts.isIdentifier);
  };
  const runsStep = (n: ts.Node) => callees(n).some((id) => id.text === 'runAssetDocStep');
  // A local step FACTORY (`const step = (a, b) => () => runAssetDocStep(…)`) calls it in the function it RETURNS — that
  // inner function is the step the literal installs, so the factory's body counts at any depth.
  const factoryRunsStep = (n: ts.Node) => findNodes(n, ts.isCallExpression)
    .some((c) => ts.isIdentifier(c.expression) && c.expression.text === 'runAssetDocStep');
  const guardedStep = (value: ts.Node | undefined) => !!value && (runsStep(value) || callees(value).some((id) => {
    const decl = declarationOf(id);
    return !!decl && ts.isVariableDeclaration(decl) && !!decl.initializer && factoryRunsStep(decl.initializer);
  }));
  return guardedStep(propertyValue(action, 'undo')) && guardedStep(propertyValue(action, 'redo'));
}

/** Every asset-doc undo entry that does not carry the flag, set to TRUE — plus how many asset-doc
 *  entries were examined at all, so an empty `hits` can be told apart from a scan that matched none. */
function unflagged(): { hits: string[]; examined: number } {
  const mutators = assetDocMutators();
  const hits: string[] = [];
  let examined = 0;
  for (const file of editorSources()) {
    const code = readScannedSource(file).code;
    // A file that imports an asset-doc mutator is in scope even when the literal reaches it
    // INDIRECTLY: MaterialBatchView's undo closures call a local `apply()` helper, so a
    // mutator-name match alone skipped one of the very sites this guard was written for.
    const fileTouchesAssets = mutators.some((mut) => new RegExp(`\\b${mut}\\b`).test(code));
    const sf = parseSource(code, file);
    for (const call of callsTo(sf, 'pushAction')) {
      const action = pushedAction(call);
      if (!action) continue;
      if (!isAssetDocEntry(action, mutators, fileTouchesAssets)) continue;
      examined++;
      if (isFlagged(action)) continue;
      hits.push(`${path.relative(EDITOR, file)}:${lineOf(call)}`);
    }
  }
  return { hits, examined };
}

/** Every asset-doc undo entry whose steps are NOT guarded (#1710), and how many were examined. */
function unguarded(): { hits: string[]; examined: number } {
  const mutators = assetDocMutators();
  const hits: string[] = [];
  let examined = 0;
  for (const file of editorSources()) {
    const code = readScannedSource(file).code;
    const fileTouchesAssets = mutators.some((mut) => new RegExp(`\\b${mut}\\b`).test(code));
    const sf = parseSource(code, file);
    for (const call of callsTo(sf, 'pushAction')) {
      const action = pushedAction(call);
      if (!action || !isAssetDocEntry(action, mutators, fileTouchesAssets)) continue;
      examined++;
      if (!isGuarded(action)) hits.push(`${path.relative(EDITOR, file)}:${lineOf(call)}`);
    }
  }
  return { hits, examined };
}

describe('asset-document undo entries do not dirty the scene', () => {
  it('every asset-doc undo entry is GUARDED — it checks the asset still holds its side (#1710)', () => {
    const { hits, examined } = unguarded();
    // Material, animset, shader, the batch, particle, animation, timeline, spriteanim and 7 rig sites — a scan that
    // finds far fewer has stopped seeing them, and would pass vacuously.
    expect(examined, 'the scan found almost no asset-doc entries — it has gone blind').toBeGreaterThanOrEqual(15);
    expect(hits, `these asset-doc undo entries re-park a whole old document with no check that the asset still holds
this step's side, so an edit made to that asset elsewhere since is reverted (#1710). Build them with
assetDocAction (undo/assetDocUndo.ts), or run the step through runAssetDocStep:\n\n${hits.join('\n')}\n`).toEqual([]);
  });

  it('the flagging factories really set it: assetDocAction returns `_isFileDirect: true`, skinDocAction returns assetDocAction(...)', () => {
    const src = (rel: string) => parseSource(readScannedSource(path.join(EDITOR, rel)).code, rel);
    const returned = (sf: ts.SourceFile, fn: string) => {
      const decl = findNodes(sf, ts.isFunctionDeclaration).find((d) => d.name?.text === fn);
      expect(decl, `${fn} not found — FLAGGING_FACTORIES names a function that no longer exists`).toBeDefined();
      return findNodes(decl!, ts.isReturnStatement).map((r) => r.expression && unwrapValue(r.expression)).filter((e): e is ts.Expression => !!e);
    };
    const own = returned(src('undo/assetDocUndo.ts'), 'assetDocAction');
    expect(own.length).toBeGreaterThan(0);
    for (const e of own) expect(propertyValue(e, '_isFileDirect')?.kind).toBe(ts.SyntaxKind.TrueKeyword);
    const skin = returned(src('panels/skinDocAction.ts'), 'skinDocAction');
    expect(skin.length).toBe(1);
    expect(skin.every((e) => ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'assetDocAction')).toBe(true);
  });

  it('derives the mutator list from the store rather than restating it', () => {
    const m = assetDocMutators();
    // If this shrinks, the derivation broke and the guard below would pass vacuously.
    expect(m).toEqual(expect.arrayContaining([
      'applyAnimationClip', 'applyParticleDef', 'applyTimelineDoc', 'applySkinDef',
      'applySpriteAnimDef', 'persistAssetEdit',
    ]));
  });

  it('the comment scan is sane over every editor source file this guard reads', () => {
    const files = editorSources();
    expect(files.length, 'no editor sources found — the guard below would scan nothing').toBeGreaterThan(0);
    for (const file of files) {
      const raw = fs.readFileSync(file, 'utf8');
      assertScanIsSane(raw, stripComments(raw), path.relative(EDITOR, file));
    }
  });

  it('a guarded HALF does not vouch for the other, and an Object.assign cannot replace the factory\'s steps (#1710)', () => {
    const sf = parseSource([
      "function f() {",
      "  const step = () => () => runAssetDocStep([], () => {}, 'panel');",
      "  pushAction({ _isFileDirect: true, label: 'a', undo: step(), redo: step() });",
      "  pushAction({ _isFileDirect: true, label: 'b', undo: () => persistAssetEdit(p, 'material', old, inv), redo: step() });",
      "  pushAction(Object.assign(assetDocAction({}), { _after: next }));",
      "  pushAction(Object.assign(assetDocAction({}), { undo: () => persistAssetEdit(p, 'material', old, inv) }));",
      "  pushAction(Object.assign(assetDocAction({}), { ...raw }));",
      "  pushAction(Object.assign(assetDocAction({}), { [k]: rawUndo }));",
      "  pushAction({ _isFileDirect: true, undo: step(), redo: step(), ...raw });",
      "  pushAction({ _isFileDirect: true, undo: () => { void step; persistAssetEdit(p, 'material', old, inv); }, redo: step() });",
      "  pushAction({ _isFileDirect: true, undo: () => { const never = () => runAssetDocStep([], f, 'panel'); persistAssetEdit(p, 'material', old, inv); }, redo: step() });",
      "  pushAction({ _isFileDirect: true, undo: () => runAssetDocStep([], f, 'panel'), redo: async () => { await runAssetDocStep([], f, 'panel'); } });",
      "}",
    ].join('\n'), 'probe.ts');
    expect(callsTo(sf, 'pushAction').map((c) => isGuarded(pushedAction(c)!))).toEqual([true, false, true, false, false, false, false, false, false, true]);
  });

  it('reads the pushed action as a node — a string\'s bracket, a nested flag and a same-named const elsewhere do not vouch (#1195)', () => {
    const sf = parseSource([
      "function other() { const a = { _isFileDirect: true }; }",
      "function f() {",
      "  const a = { undo: () => applyAnimationClip(')'), meta: { _isFileDirect: true } };",
      "  pushAction(a);",
      "  pushAction({ undo: () => applyAnimationClip('{'), _isFileDirect: true });",
      "}",
    ].join('\n'), 'probe.ts');
    const [byName, inline] = callsTo(sf, 'pushAction').map((c) => pushedAction(c)!);
    // f's own `a`, resolved by scope — not other()'s flagged one — and its flag is only in `meta`.
    expect(objectLiteralKeys(byName)).toEqual(['undo', 'meta']);
    expect([isAssetDocEntry(byName!, ['applyAnimationClip'], false), isFlagged(byName!)]).toEqual([true, false]);
    expect([isAssetDocEntry(inline!, ['applyAnimationClip'], false), isFlagged(inline!)]).toEqual([true, true]);
    // The guard's own classifier on the flag's VALUE: false and a truthy non-literal are not `true`.
    const flagOf = (lit: string) => isFlagged(callsTo(parseSource(`pushAction(${lit});`, 'f.ts'), 'pushAction')[0]!.arguments[0]!);
    expect(['{ _isFileDirect: false }', '{ _isFileDirect: 1 }', '{ _isFileDirect: yes }', '{ _isFileDirect: true }'].map(flagOf))
      .toEqual([false, false, false, true]);
    // An own `undo` member counts only in a file that touches a mutator.
    const undoOnly = callsTo(parseSource('pushAction({ undo: () => apply() });', 'u.ts'), 'pushAction')[0]!.arguments[0]!;
    expect([isAssetDocEntry(undoOnly, ['applyAnimationClip'], true), isAssetDocEntry(undoOnly, ['applyAnimationClip'], false)]).toEqual([true, false]);
  });

  it('every asset-doc undo entry in editor/** carries _isFileDirect', () => {
    const { hits, examined } = unflagged();
    expect(hits, `these undo entries mutate an ASSET DOCUMENT but do not set _isFileDirect, so
each one marks the SCENE dirty — blocking the file-direct agent routes, making modoki_build refuse,
and making Cmd+S interrupt a preview to rewrite a scene nothing changed:\n\n${hits.join('\n')}\n`)
      .toEqual([]);
    // Non-vacuity floor (#1105): the mutator list and the file count are pinned above, but neither
    // proves the `pushAction(` scan reached a single asset-doc undo entry.
    expect(examined, 'no asset-doc undo entries examined — the pushAction scan or its scope gate is broken; fix it, do not delete this assertion')
      .toBeGreaterThan(5);
  });
});
