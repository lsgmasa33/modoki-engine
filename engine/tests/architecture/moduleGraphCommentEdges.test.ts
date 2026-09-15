/**
 * ⚠️ **A doc comment must not put an edge in the module graph (#812).**
 *
 * `parseFromStatements` WAS a regex over text, so a comment SHOWING an import example was
 * indistinguishable from a real statement. That is harmless for a bare specifier —
 * `buildRuntimeGraph` drops anything not starting with `.` — and it was a live defect for a
 * RELATIVE one, which is the natural thing to write in a file explaining its own layering.
 * Since #1193 it reads the parse, so a comment or a string is not an import by construction; the
 * cases below now pin THAT, and keep pinning that the graph's own read goes through the scanner.
 *
 * ⚠️ **Why this one is worth its own file rather than a line in `noNewCycles`.** The graph feeds
 * `noNewCycles`, a frozen baseline. So the failure does not present
 * as a red build somebody investigates; it presents as a new cycle, whose cheapest fix is adding it
 * to `cycles-baseline.json` — permanently enshrining a cycle that does not exist, in the file whose
 * whole job is to be trustworthy. A guard that pushes the fix the wrong way needs the reason
 * recorded next to it.
 *
 * Two runtime files hold an import inside prose (the module docblocks of `ui/storeHooks.ts`,
 * `storage/playerPrefs.ts`). Both use the bare `@modoki/engine/runtime`, so the graph was correct by
 * luck before #812, and by the stripper until #1193.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readScannedSource } from '@modoki/engine/testing';
import { parseFromStatements, REPO_ROOT } from './moduleGraph';
import { makeScratchDir } from '@modoki/engine/testing/scratchDir';

/** A file whose PROSE shows a relative import — the shape that injects a phantom cross-folder edge. */
const SRC = [
  '/**',
  ' * Layering note: a consumer reaches this through',
  " *      import { addStoreHook } from '../../editor/panels/SceneView';",
  ' */',
  "import { real } from './real';",
  "const example = `import { shown } from '../../editor/panels/SceneView'`;",
  '',
].join('\n');

const PHANTOM = '../../editor/panels/SceneView';

describe('the module graph is built from code, not from prose (#812, #1193)', () => {
  it('RAW text with the example in a comment AND in a template string yields only the REAL import', () => {
    // Positive control first: a reader that found no edges at all would pass the `not.toContain` below.
    const specifiers = parseFromStatements(SRC, 'storeHooks.ts').map((e) => e.specifier);
    expect(specifiers, 'the reader stopped finding a real import').toEqual(['./real']);
    expect(specifiers, 'prose injected a cross-folder edge into a graph that feeds a frozen baseline')
      .not.toContain(PHANTOM);
  });

  // ⚠️ Since #1193 this passes whether or not comments are stripped — the parse ignores them. It pins the
  // composition still reads; what guards the STRIPPER at the graph's call site is the last case below.
  it('the same source read through readScannedSource yields only the REAL import', () => {
    const dir = makeScratchDir('modgraph-');
    try {
      const file = path.join(dir, 'storeHooks.ts');
      fs.writeFileSync(file, SRC, 'utf8');
      const specifiers = parseFromStatements(readScannedSource(file).code, 'storeHooks.ts').map((e) => e.specifier);
      expect(specifiers).toEqual(['./real']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads the spellings the old regexes split on, with the erasure verbatimModuleSyntax applies', () => {
    const code = [
      "import type { A } from './erased';",
      "import { type B } from './still-runs';",
      "import './side-effect';",
      "import legacy = require('./required');",
      'setup(); export * from "./mid-line";',
      "export type { C } from './erased-too';",
      'import {',
      '  d,',
      "} from './wrapped';",
      "const lazy = () => import('./dynamic');",
    ].join('\n');
    expect(parseFromStatements(code, 'x.ts')).toEqual([
      { specifier: './erased', valueOnly: false },
      { specifier: './still-runs', valueOnly: true },
      { specifier: './side-effect', valueOnly: true },
      { specifier: './required', valueOnly: true },
      { specifier: './mid-line', valueOnly: true },
      { specifier: './erased-too', valueOnly: false },
      { specifier: './wrapped', valueOnly: true },
    ]);
  });

  it("buildRuntimeGraph's own read goes through the stripper", () => {
    // The two assertions above test the COMPOSITION; this pins the call site that must use it, so
    // reverting the read to `fs.readFileSync` fails here and not only in the repo-wide guard.
    const self = readScannedSource(path.join(REPO_ROOT, 'engine/tests/architecture/moduleGraph.ts')).code;
    expect(self, 'buildRuntimeGraph went back to reading raw text').toContain('readScannedSource(file).code');
  });
});
