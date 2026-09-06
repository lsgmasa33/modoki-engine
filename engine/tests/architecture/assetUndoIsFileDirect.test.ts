/** An undo entry for an ASSET-DOCUMENT edit must carry `_isFileDirect` — a guard, because the
 *  rule has now been broken twice in the same place.
 *
 *  WHAT THE FLAG DOES (undoManager.ts): it opts an action out of bumping the scene's edit-version.
 *  An asset edit changes a `.anim`/`.particle`/`.timeline`/`.spriteanim`/`.rig2d`/`.mat`/`.shader`/
 *  `.animset` file, never a scene entity — its unsaved state is the dirty-asset registry's job, or
 *  (for the Inspector's asset views, which write through `persistAssetEdit`) it is already on disk.
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
import { stripComments, assertScanIsSane } from '@modoki/engine/testing';
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

/** The text of the balanced `(...)` starting at `open`. */
function callArgs(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(open + 1, i);
  }
  return '';
}

/** The text of the balanced `{...}` starting at `open`. */
function braceBlock(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  return '';
}

/** The ACTION LITERAL a `pushAction(...)` call pushes — inline, or resolved back through the
 *  `const a: ClipAction = { … }; pushAction(a)` form the coalescing panels use.
 *
 *  Reading the literal, not a window of nearby lines, is load-bearing: the first version of this
 *  guard scanned ±14 lines, and deleting a real flag left it GREEN because a sibling `pushAction`
 *  a few lines up still had one. A guard that cannot fail on the defect it names is worse than no
 *  guard — it certifies. (Caught by mutating it, which is the only thing that ever catches this.) */
function actionLiteral(src: string, open: number): string {
  const args = callArgs(src, open);
  const asVar = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(args);
  if (!asVar) return args;                       // inline literal (or a builder call)
  const decl = src.lastIndexOf(`const ${asVar[1]}`, open);
  if (decl < 0) return args;                     // built elsewhere — nothing to read
  const brace = src.indexOf('{', decl);
  return brace >= 0 && brace < open ? braceBlock(src, brace) : args;
}

/** Strip comments (shared scanner, @modoki/engine/testing, #419), so a literal cannot be
 *  "flagged" by a line of prose about the flag. */
function code(text: string): string {
  return stripComments(text);
}

/** Every asset-doc undo entry that does not carry the flag, set to TRUE. */
function unflagged(): string[] {
  const mutators = assetDocMutators();
  const hits: string[] = [];
  for (const file of editorSources()) {
    const src = fs.readFileSync(file, 'utf8');
    // A file that imports an asset-doc mutator is in scope even when the literal reaches it
    // INDIRECTLY: MaterialBatchView's undo closures call a local `apply()` helper, so a
    // mutator-name match alone skipped one of the very sites this guard was written for.
    const fileTouchesAssets = mutators.some((mut) => new RegExp(`\\b${mut}\\b`).test(src));
    for (const m of src.matchAll(/\bpushAction\s*\(/g)) {
      const open = m.index! + m[0].length - 1;
      const literal = code(actionLiteral(src, open));
      const direct = mutators.some((mut) => literal.includes(mut));
      if (!direct && !(fileTouchesAssets && /\bundo\s*:/.test(literal))) continue;
      // `: true`, not merely present — `_isFileDirect: false` IS the defect, and undoManager reads
      // the flag truthily. The first version of this guard accepted both that and a comment saying
      // the word, which is the failure its own docstring names.
      if (/_isFileDirect\s*:\s*true/.test(literal)) continue;
      const line = src.slice(0, open).split('\n').length;
      hits.push(`${path.relative(EDITOR, file)}:${line}`);
    }
  }
  return hits;
}

describe('asset-document undo entries do not dirty the scene', () => {
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

  it('every asset-doc undo entry in editor/** carries _isFileDirect', () => {
    expect(unflagged(), `these undo entries mutate an ASSET DOCUMENT but do not set _isFileDirect, so
each one marks the SCENE dirty — blocking the file-direct agent routes, making modoki_build refuse,
and making Cmd+S interrupt a preview to rewrite a scene nothing changed:\n\n${unflagged().join('\n')}\n`)
      .toEqual([]);
  });
});
