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
 *  is total today (all 76 actions pass), so it can only go red on a NEW orphan.
 *
 *  If this fails for an action you just added: wire it to a consumer, or don't add it yet.
 *  Adding the setter first and the UI "in the next commit" is precisely how #181 happened. */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { repoFiles } from '../../scripts/repoCorpus.mjs';

const root = path.resolve(__dirname, '../..');
const storeFile = path.join(root, 'packages/modoki/src/editor/store/editorStore.ts');

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

/** The `interface EditorState { … }` block — the store's declared surface. Reading the
 *  INTERFACE rather than the implementation object keeps the extraction to one shape
 *  (`  name: (args) => ret;`) instead of chasing arrow bodies across 700 lines. */
function editorStateBlock(src: string): string {
  const start = src.indexOf('\ninterface EditorState {');
  expect(start, 'interface EditorState not found — did the store get renamed?').toBeGreaterThan(-1);
  // First line that closes at column 0 ends the block.
  const rest = src.slice(start + 1);
  const end = rest.search(/\n\}/);
  expect(end).toBeGreaterThan(-1);
  return rest.slice(0, end);
}

/** Members whose declared type is a function — the store's actions. */
function actionNames(block: string): string[] {
  const out: string[] = [];
  for (const line of block.split('\n')) {
    const m = /^ {2}([A-Za-z_][A-Za-z0-9_]*)\??: \(/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

/** Every `.ts`/`.tsx` under the consumer roots, via the shared corpus producer
 *  (#799/#771/#805 Phase 4). Floored well under the 2144 measured today.
 *
 *  THIS FILE is excluded as well as the store: `knownOrphans` names the orphans as string
 *  literals, so counting itself as a corpus would make every entry look like it had acquired a
 *  consumer the moment it was listed — the allowlist would launder the very thing it documents. */
function sourceFiles(): string[] {
  return repoFiles({
    under: consumerRoots, match: /\.tsx?$/, exclude: ['node_modules', 'dist'], floor: 1500,
  })
    .map(({ abs }) => abs)
    .filter((p) => p !== storeFile && p !== __filename);
}

describe('editor store actions are reachable', () => {
  it('every function-typed EditorState member has a consumer outside editorStore.ts', () => {
    const src = fs.readFileSync(storeFile, 'utf8');
    const actions = actionNames(editorStateBlock(src));
    // Sanity: the extraction found a plausible surface. A regex that silently matched
    // nothing would make this test pass vacuously — the failure mode the guard exists to
    // catch, reproduced in the guard itself.
    expect(actions.length).toBeGreaterThan(50);

    const corpus = sourceFiles().map((f) => fs.readFileSync(f, 'utf8')).join('\n');
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
