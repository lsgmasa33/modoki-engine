/**
 * ⚠️ **A doc comment must not put an edge in the module graph (#812).**
 *
 * `parseFromStatements` is a regex over text, so a comment SHOWING an import example is
 * indistinguishable from a real statement. That is harmless for a bare specifier —
 * `buildRuntimeGraph` drops anything not starting with `.` — and it is a live defect for a
 * RELATIVE one, which is the natural thing to write in a file explaining its own layering.
 *
 * ⚠️ **Why this one is worth its own file rather than a line in `noNewCycles`.** The graph feeds
 * `noNewCycles` and `barrelSurface`, and BOTH are frozen baselines. So the failure does not present
 * as a red build somebody investigates; it presents as a new cycle, whose cheapest fix is adding it
 * to `cycles-baseline.json` — permanently enshrining a cycle that does not exist, in the file whose
 * whole job is to be trustworthy. A guard that pushes the fix the wrong way needs the reason
 * recorded next to it.
 *
 * Two runtime files already hold an import inside prose (`ui/storeHooks.ts:11`,
 * `storage/playerPrefs.ts:25`). Both happen to use the bare `@modoki/engine/runtime`, so today's
 * graph is correct by luck rather than by construction. This is what replaces the luck.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readScannedSource } from '@modoki/engine/testing';
import { parseFromStatements, REPO_ROOT } from './moduleGraph';

/** A file whose PROSE shows a relative import — the shape that injects a phantom cross-folder edge. */
const SRC = [
  '/**',
  ' * Layering note: a consumer reaches this through',
  " *      import { addStoreHook } from '../../editor/panels/SceneView';",
  ' */',
  "import { real } from './real';",
  '',
].join('\n');

const PHANTOM = '../../editor/panels/SceneView';

describe('the module graph is built from code, not from prose (#812)', () => {
  it('THE PREMISE: raw text really does yield the phantom edge', () => {
    // ⚠️ Without this the test below proves nothing — a parser that found no edges for an unrelated
    // reason would pass it just as happily. This is the positive control.
    const specifiers = parseFromStatements(SRC).map((e) => e.specifier);
    expect(specifiers, 'the premise moved: prose no longer parses as an import, and the assertion '
      + 'below has stopped testing anything').toContain(PHANTOM);
  });

  it('the same source read through readScannedSource yields only the REAL import', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modgraph-'));
    try {
      const file = path.join(dir, 'storeHooks.ts');
      fs.writeFileSync(file, SRC, 'utf8');
      const specifiers = parseFromStatements(readScannedSource(file).code).map((e) => e.specifier);
      expect(specifiers).toEqual(['./real']);
      expect(specifiers, 'a comment injected a cross-folder edge into a graph that feeds two '
        + 'frozen baselines').not.toContain(PHANTOM);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("buildRuntimeGraph's own read goes through the stripper", () => {
    // The two assertions above test the COMPOSITION; this pins the call site that must use it, so
    // reverting the read to `fs.readFileSync` fails here and not only in the repo-wide guard.
    const self = readScannedSource(path.join(REPO_ROOT, 'engine/tests/architecture/moduleGraph.ts')).code;
    expect(self, 'buildRuntimeGraph went back to reading raw text').toContain('readScannedSource(file).code');
  });
});
