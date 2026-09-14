/** Guard: every function-typed member of the editor store is CALLED by something outside
 *  the store itself.
 *
 *  #181: `skinWeightView` and its setter `setSkinWeightView` had zero callers anywhere.
 *  Nothing was broken in the usual sense — the store field was fine, the setter was fine,
 *  and the SceneView branch it gated (the opaque weight heatmap) was correct and complete.
 *  It was simply unreachable, so the flag stayed `false` forever and the feature did not
 *  exist as far as any user was concerned. Nothing failed, so nothing reported it, and it
 *  sat that way until someone read the file for an unrelated reason.
 *
 *  That is the repo's dominant defect shape (CLAUDE.md's "unreachable mechanism" class):
 *  the mechanism is written correctly and the wiring to a consumer is missing. A store
 *  action is the cheapest place to catch it, because "was this ever called?" is a
 *  question the source can answer statically — unlike, say, whether a rendered branch is
 *  ever visually reached.
 *
 *  The check is deliberately PERMISSIVE: any textual reference to the name outside
 *  `editorStore.ts` counts, including from a test. It is not trying to prove the action is
 *  reachable by a user — only that a consumer exists at all, which is exactly the bar #181
 *  failed. A stricter version would need call-graph analysis and would produce arguments
 *  about legitimate agent-op-only or test-only actions; this version produces none, and it
 *  is total today (all 87 actions pass — the figure said 76 and had not been re-measured since
 *  it was written), so it can only go red on a NEW orphan.
 *
 *  If this fails for an action you just added: wire it to a consumer, or don't add it yet.
 *  Adding the setter first and the UI "in the next commit" is precisely how #181 happened. */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { repoFiles, repoRoot } from '../../scripts/repoCorpus.mjs';
import { readScannedSource } from '@modoki/engine/testing';
import { parseSource, ts } from '@modoki/engine/testing/sourceAst';

const root = path.resolve(__dirname, '../..');
const storeFile = path.join(root, 'packages/modoki/src/editor/store/editorStore.ts');
// Repo-relative POSIX counterparts of storeFile/__filename, derived ONCE (not per corpus file)
// against the SAME root repoFiles()'s own `rel` is relative to — comparing on `rel` rather than
// on two independently-built absolute paths is the point of #849.
const storeRel = path.relative(repoRoot(), storeFile).split(path.sep).join('/');
const selfRel = path.relative(repoRoot(), __filename).split(path.sep).join('/');

/** Directories a consumer may live in. `packages/modoki/tests` is in the list because the
 *  engine package has its OWN vitest project — leaving it out reported `closeSpriteAnimEditor`
 *  as an orphan when `packages/modoki/tests/editor/editorStore.test.ts` calls it. */
const consumerRoots = ['packages/modoki/src', 'packages/modoki/tests', 'app', 'tools', 'tests']
  .map((d) => path.join(root, d));

/** KNOWN ORPHANS, tracked not hidden. EMPTY, and worth keeping that way: the three this
 *  list was created for (`closeAnimationEditor` / `closeTimelineEditor` /
 *  `closeParticleEditor`, all found by this guard on its first run) were resolved in #186
 *  by giving them the consumer they were always missing — an asset DELETE unbinds the
 *  editor holding it, `panels/assetEditorBindings.ts`.
 *
 *  This is an admission of debt with an issue attached, not an escape hatch. Do not add to
 *  it to make a red build green — that inverts the guard into a registry of things it has
 *  agreed to stop checking. Wiring the action to its real consumer is the fix; if it has
 *  no real consumer, delete it. */
const knownOrphans = new Set<string>([]);

/** The function-typed members of an `interface EditorState { … }` in `code` — the store's actions:
 *  a method signature, or a property whose type is a function type (parenthesised, or one arm of a
 *  union such as `((id: number) => void) | null`). Reading the INTERFACE rather than the
 *  implementation object keeps the extraction to one shape instead of chasing arrow bodies across
 *  700 lines.
 *
 *  ⚠️ **The interface's own members (#1179).** This read the block by text — from
 *  `\ninterface EditorState {` to the first `}` at column 0 — and took one member per LINE matching
 *  `  name?: (`: a member the formatter wrapped (`name:\n    (id: number) => void;`), a method
 *  signature (`name(id: number): void;`) and a member indented any other way were not actions, so
 *  their orphans were never looked for. Measured on migrating: 90 either way. */
function actionNamesIn(code: string, label: string): string[] {
  const sf = parseSource(code, label);
  const decls = sf.statements.filter((st): st is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(st) && st.name.text === 'EditorState');
  expect(decls.length, 'interface EditorState not found — did the store get renamed?').toBeGreaterThan(0);
  // ⚠️ Members this reader cannot see must FAIL it, not shrink the population: an `extends Slice`, or a
  // second merged declaration, moves actions out of the one body read here (#1179 P3 review — the
  // text reader failed on both by accident, because neither starts `interface EditorState {`).
  expect(decls.length, 'EditorState is declared more than once — merged declarations are not read').toBe(1);
  const iface = decls[0];
  expect(iface.heritageClauses ?? [], 'EditorState extends another interface whose actions this reader does not follow — read them, or inline them').toEqual([]);
  const isFunctionType = (t: ts.TypeNode | undefined): boolean => !!t && (ts.isFunctionTypeNode(t)
    || (ts.isParenthesizedTypeNode(t) && isFunctionType(t.type)) || (ts.isUnionTypeNode(t) && t.types.some(isFunctionType)));
  return iface!.members
    .filter((m) => ts.isMethodSignature(m) || (ts.isPropertySignature(m) && isFunctionType(m.type)))
    .map((m) => (m.name && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name)) ? m.name.text : '<computed>'));
}

/** Every `.ts`/`.tsx` under the consumer roots, via the shared corpus producer
 *  (#799/#771/#805 Phase 4). Floored well under the 2144 measured today.
 *
 *  THIS FILE is excluded as well as the store: `knownOrphans` names the orphans as string
 *  literals, so counting itself as a corpus would make every entry look like it had acquired a
 *  consumer the moment it was listed — the allowlist would launder the very thing it documents. */
function sourceFiles(): Array<{ rel: string; abs: string }> {
  return repoFiles({
    under: consumerRoots, match: /\.tsx?$/, exclude: ['node_modules', 'dist'], floor: 1500,
  })
    .filter(({ rel }) => rel !== storeRel && rel !== selfRel);
}

describe('the action reader reads the interface\'s own members (#1179)', () => {
  it('reads a wrapped member, a method signature and a nullable callback; not state, not another interface', () => {
    const src = [
      'interface Other {\n  notMine: () => void;\n}',
      'interface EditorState {',
      '  selected: number | null;',
      '  setSelected: (id: number) => void;',
      '  revealLeadEntityInHierarchyWithAVeryLongName:\n    (id: number, opts?: { scroll: boolean }) => void;',
      '    oddlyIndented?: () => void;',
      '  openPanel(id: string): void;',
      '  onPick: ((id: number) => void) | null;',
      '}',
    ].join('\n');
    expect(actionNamesIn(src, 's.ts')).toEqual(['setSelected', 'revealLeadEntityInHierarchyWithAVeryLongName', 'oddlyIndented', 'openPanel', 'onPick']);
  });

  it('refuses a shape whose members it cannot see: an `extends`, and a merged second declaration', () => {
    expect(() => actionNamesIn('interface Slice { a: () => void; }\ninterface EditorState extends Slice {\n  b: () => void;\n}', 's.ts')).toThrow(/extends another interface/);
    expect(() => actionNamesIn('interface EditorState {\n  a: () => void;\n}\ninterface EditorState {\n  b: () => void;\n}', 's.ts')).toThrow(/more than once/);
  });
});

describe('editor store actions are reachable', () => {
  /** NON-VACUITY (#849). Both exclusions are load-bearing and BOTH fail silently: if `storeRel` or
   *  `selfRel` stops matching, that file re-enters the corpus, its own text satisfies every
   *  `\bname\b` probe, and the orphan scan reports zero forever. Mutation-checked 2026-09-07: with
   *  both pointed at paths that match nothing, the suite below was GREEN. Assert the filter removes
   *  exactly the two files it names, rather than trusting that it did. */
  it('the store file and this file are genuinely excluded from the corpus', () => {
    const all = repoFiles({
      under: consumerRoots, match: /\.tsx?$/, exclude: ['node_modules', 'dist'], floor: 1500,
    });
    for (const rel of [storeRel, selfRel]) {
      expect(
        all.some((f) => f.rel === rel),
        `${rel} is not in the corpus, so excluding it is a no-op — the derivation behind it has `
        + "drifted from repoFiles()'s own `rel`",
      ).toBe(true);
    }
    // No `all.length - sourceFiles().length === 2` assertion here, though the first draft had one.
    // `rel` is unique in the corpus, so that subtraction is exactly |{storeRel, selfRel} ∩ rels|,
    // which the loop above has already pinned at 2 — no edit can redden it without reddening the
    // loop first. It read as independent coverage and was not (close-out review, #849).
  });

  it('every function-typed EditorState member has a consumer outside editorStore.ts', () => {
    const actions = actionNamesIn(readScannedSource(storeFile).code, 'editorStore.ts');
    // Sanity: the extraction found a plausible surface. A regex that silently matched
    // nothing would make this test pass vacuously — the failure mode the guard exists to
    // catch, reproduced in the guard itself.
    expect(actions.length).toBeGreaterThan(50);

    const corpus = sourceFiles().map(({ abs }) => fs.readFileSync(abs, 'utf8')).join('\n');
    const orphans = actions.filter((name) => !new RegExp(`\\b${name}\\b`).test(corpus));

    const unexpected = orphans.filter((n) => !knownOrphans.has(n));
    expect(unexpected, `orphaned editor-store actions (declared but never called — see #181): ${unexpected.join(', ')}`).toEqual([]);

    // Keep the debt list HONEST in the other direction: an entry that has since been wired
    // up (or deleted) must leave, or the list slowly becomes a place where a real orphan
    // could hide behind a name that is no longer one.
    const stale = [...knownOrphans].filter((n) => !orphans.includes(n));
    expect(stale, `knownOrphans entries that are no longer orphaned — delete them (#186): ${stale.join(', ')}`).toEqual([]);
  });
});
